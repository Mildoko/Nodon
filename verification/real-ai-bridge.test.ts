import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AiAuthority } from '../src/ai/authority.js';
import { AiGateway } from '../src/ai/gateway.js';
import { AiLedger, type FrozenRequestManifest } from '../src/ai/ledger.js';
import { buildBody, parseModelResponse, promptSchemaDescriptor, requestFingerprint, validateRequest } from '../src/ai/protocol.js';
import { bindSelectedEvidence, selectedEvidenceDigest, selectedEvidenceProjection, SELECTED_EVIDENCE_VERSION } from '../src/ai/selected-evidence.js';
import { AiError, MODEL, type DeepSeekAccess, type GatewayResult, type SubmitRequest } from '../src/ai/types.js';
import { canonicalJson, parseDocument, type Document } from '../src/domain/index.js';
import { CommandQueue } from '../src/host/command-queue.js';
import { R0Host } from '../src/host/r0-host.js';
import { CandidateManager } from '../src/trial/candidate-manager.js';
import type { BuildIdentity } from '../tools/build-manifest.js';

// All provider replies below are controlled_transport, fake credentials, private test SQLite.
// They test the real Node bridge/Runtime, never consume real slots or establish human/provider evidence.
const manifest = JSON.parse(readFileSync(resolve('verification/model-request-manifest.json'), 'utf8')) as FrozenRequestManifest;
const configured = JSON.parse(readFileSync(resolve('config/deepseek-access.json'), 'utf8')) as DeepSeekAccess;
const SESSION = 'bridge-offline-session'; const WRITER = 'bridge-offline-writer';
const GOOD = { kind: 'propose', summary: '降低目标', operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }] };
let serial = 0;
function uuid(): string { return `db000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`; }
function fixture(name = 'scene-a'): Document { return parseDocument(readFileSync(resolve(`verification/fixtures/${name}.json`), 'utf8')); }
function build(): BuildIdentity { return { buildHash: 'sha256:' + 'a'.repeat(64), runtimeArtifactHash: 'sha256:' + 'b'.repeat(64), buildId: 'bridge-synthetic', environmentId: 'bridge-synthetic', manifest: { contractHash: 'synthetic-contract' }, runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] }, productionPackagePaths: [] }; }
function request(host: R0Host, slot = 'R0-AI-01-R1-I'): SubmitRequest {
  const document = host.document(); const requestId = uuid();
  return { requestId, requestSlotID: slot, idempotencyKey: `bridge-${requestId}`, document,
    snapshot: { requestId, projectId: document.project.projectId, baseRevision: document.project.revision, baseSemanticHash: document.project.semanticHash,
      runtimeVersion: document.runtimeVersion, catalogVersion: document.catalogVersion, ruleRegistryVersion: 'collect-chase-rules@1', trialPolicyVersion: 'collect-chase-candidate-trial@2', capabilityVersion: 'nodon-r0-capabilities@1',
      authEpoch: 0, sessionId: SESSION, writerToken: WRITER, requestText: '把目标10改6，其余不动。', selectedEvidenceRefs: [] } };
}
function reply(value: unknown = GOOD, usage: unknown = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 }, returnedModel: string = MODEL): Response {
  return new Response(JSON.stringify({ id: 'offline-bridge-provider-id', model: returnedModel, choices: [{ message: { content: JSON.stringify(value) }, finish_reason: 'stop' }], usage }), { headers: { 'Content-Type': 'application/json' } });
}
function setup(t: TestContext, source = fixture()) {
  const fetchMock = t.mock.method(globalThis, 'fetch', (async () => { throw new Error('REAL_NETWORK_FORBIDDEN'); }) as typeof fetch);
  fetchMock.mock.mockImplementation(async () => reply());
  const folder = mkdtempSync(join(tmpdir(), 'nodon-bridge-offline-')); const queue = new CommandQueue(); let currentBuild = build();
  const host = new R0Host(source, { queue, sessionId: SESSION, writerToken: WRITER, buildIdentity: currentBuild });
  const authority = new AiAuthority(queue, { authEpoch: 0, adultEnabled: true, scopeEnabled: true, sessionId: SESSION, writerToken: WRITER, projectId: source.project.projectId });
  const ledger = new AiLedger(queue, join(folder, 'private.sqlite'), manifest);
  const gateway = new AiGateway(authority, ledger, { ...configured, modelApproved: true, availabilityApproved: true, budgetApproved: true, outboundScopeApproved: true, credentialsConfigured: true }, async () => 'offline-fixture-NOT-A-KEY', 60000, host, 'controlled_transport');
  const manager = new CandidateManager(host, authority, { currentBuild: () => structuredClone(currentBuild), yieldSlice: async () => {} });
  t.after(async () => { await gateway.shutdown(); ledger.close(); rmSync(folder, { recursive: true, force: true }); });
  return { queue, host, authority, ledger, gateway, manager, fetchMock, changeBuild: () => { currentBuild = { ...currentBuild, buildHash: 'sha256:' + 'c'.repeat(64) }; } };
}
async function denied(work: Promise<unknown>, code: string): Promise<void> { await assert.rejects(work, (e: unknown) => e instanceof AiError && e.code === code); }
function command(host: R0Host) { const doc = host.document(); return { commandId: uuid(), sessionId: SESSION, writerToken: WRITER, projectId: doc.project.projectId, expectedRevision: doc.project.revision, command: { type: 'set_goal', value: 7 } }; }

test('offline bridge: actual gateway object enters shared candidate path; trial required and provenance remains controlled', async t => {
  const h = setup(t); const input = request(h.host); const base = h.host.document(); const result = await h.gateway.submit(input);
  assert.equal(result.status, 'answered'); assert.deepEqual(h.host.document(), base);
  const candidate = await h.manager.prepareFromGateway(h.gateway, result);
  assert.equal(candidate.source, 'provider_gateway'); assert.equal(candidate.providerEvidence?.transport, 'controlled_transport');
  assert.equal(candidate.providerEvidence?.requestSlotID, input.requestSlotID); assert.equal(candidate.trialStatus, 'not_run'); assert.equal(candidate.canConfirm, false);
  assert.equal((await h.manager.confirm(candidate.candidateId)).ok, false); assert.deepEqual(h.host.document(), base);
  const tried = await h.manager.trial(candidate.candidateId);
  assert.equal(tried.trialStatus, 'passed'); assert.equal(tried.trial?.source, 'provider_gateway'); assert.equal(tried.trial?.providerEvidence?.transport, 'controlled_transport');
  assert.equal((await h.manager.confirm(candidate.candidateId)).ok, true); assert.equal(h.host.document().project.rules.goal.targetScore, 6);
  assert.equal(h.host.document().project.revision, base.project.revision + 1);
});

test('offline bridge: cloned, fabricated and persisted duplicate answers have no gateway capability', async t => {
  const h = setup(t); const input = request(h.host); const result = await h.gateway.submit(input);
  await denied(h.manager.prepareFromGateway(h.gateway, structuredClone(result)), 'E_GATEWAY_RESULT_SOURCE');
  await denied(h.manager.prepareFromGateway(h.gateway, { ...structuredClone(result), requestId: uuid() } as GatewayResult), 'E_GATEWAY_RESULT_SOURCE');
  const duplicate = await h.gateway.submit(input);
  assert.equal(duplicate.status, 'answered'); assert.equal(h.fetchMock.mock.callCount(), 1);
  await denied(h.manager.prepareFromGateway(h.gateway, duplicate), 'E_GATEWAY_RESULT_SOURCE');
  if (result.status !== 'answered') assert.fail('expected answered');
  assert.ok(Object.isFrozen(result)); assert.ok(Object.isFrozen(result.response)); assert.ok(Object.isFrozen(result.attempt));
  await h.queue.enqueue(() => { const proof = h.gateway.assertAnswered(result, h.host); assert.ok(Object.isFrozen(proof.request.document.project.rules)); });
});

test('offline bridge: stale revision, changed build, revoked writer and cancel cannot become candidates', async t => {
  for (const mode of ['revision', 'build', 'writer', 'cancel', 'shutdown'] as const) await t.test(mode, async t => {
    const h = setup(t); const input = request(h.host); const result = await h.gateway.submit(input);
    if (mode === 'revision') assert.equal((await h.host.execute(command(h.host))).ok, true);
    if (mode === 'build') h.changeBuild();
    if (mode === 'writer') await h.authority.replaceWriter('changed-session', 'changed-writer', h.host.document().project.projectId);
    if (mode === 'cancel') await h.gateway.cancel(input.requestId);
    if (mode === 'shutdown') await h.gateway.shutdown();
    await assert.rejects(h.manager.prepareFromGateway(h.gateway, result));
    assert.equal(h.manager.snapshot(), null);
  });
});

test('offline bridge: different Host/authority/queue is refused; usage-unknown never yields a candidate', async t => {
  const h = setup(t); const input = request(h.host); const result = await h.gateway.submit(input);
  const otherQueue = new CommandQueue(); const otherHost = new R0Host(fixture(), { queue: otherQueue, sessionId: SESSION, writerToken: WRITER, buildIdentity: build() });
  const otherAuthority = new AiAuthority(otherQueue, { ...h.authority.snapshot() });
  const manager = new CandidateManager(otherHost, otherAuthority, { currentBuild: build });
  await denied(manager.prepareFromGateway(h.gateway, result), 'E_AUTHORITY_OWNER');
  const anotherHost = new R0Host(fixture(), { queue: h.queue, sessionId: SESSION, writerToken: WRITER, buildIdentity: build() });
  const sameQueueManager = new CandidateManager(anotherHost, h.authority, { currentBuild: build });
  await denied(sameQueueManager.prepareFromGateway(h.gateway, result), 'E_AUTHORITY_OWNER');
  h.fetchMock.mock.mockImplementation(async () => reply(GOOD, null));
  const unknown = await h.gateway.submit(request(h.host, 'R0-AI-02-R1-I')); assert.equal(unknown.status, 'unknown');
  await denied(h.manager.prepareFromGateway(h.gateway, unknown), 'E_GATEWAY_RESULT_SOURCE');
});

test('offline bridge: cancel after successful trial blocks confirmation and preserves original document', async t => {
  const h = setup(t); const input = request(h.host); const result = await h.gateway.submit(input);
  const candidate = await h.manager.prepareFromGateway(h.gateway, result); await h.manager.trial(candidate.candidateId);
  await h.gateway.cancel(input.requestId); assert.equal(h.manager.candidate(candidate.candidateId).canConfirm, false);
  assert.equal((await h.manager.confirm(candidate.candidateId)).ok, false); assert.equal(h.host.document().project.revision, 0);
});

test('offline selected evidence: real Host projection binds original event/version and strips private run history', async t => {
  const h = setup(t, fixture('terminal-conflict')); const run = await h.host.startRun();
  // This is real Runtime, but its input source stays catalog_machine/automation_test.
  let snapshot = run;
  for (let tick = 1; tick <= 900; tick++) snapshot = await h.host.input({ runId: run.context.runId, generation: run.context.generation, direction: tick <= 884 ? { x: 0, y: 0 } : { x: 1, y: 0 } });
  assert.equal(snapshot.terminal?.reason, 'caught');
  const input = request(h.host, 'R0-AI-11-R1-I'); input.snapshot.requestText = '解释所选真实事件。';
  const selected = snapshot.events.filter(e => ['reward_collected', 'round_ended'].includes(e.kind)).map(e => e.eventId);
  await h.queue.enqueue(() => bindSelectedEvidence(input, h.host, selected));
  const full = request(h.host, 'R0-AI-11-R1-I');
  await h.queue.enqueue(() => bindSelectedEvidence(full, h.host, snapshot.events.map(e => e.eventId)));
  assert.ok(Buffer.byteLength(buildBody(full), 'utf8') + 1024 <= 12000, 'The actual six-event RT07 chain now fits; never truncate or assert a false overflow');
  assert.equal(h.ledger.budget().attempts, 0);
  const fullFollowup = request(h.host, 'R0-AI-11-R1-F');
  fullFollowup.snapshot.requestText = '将所选n1从(70,290)移到(40,290)，其余不动。';
  await h.queue.enqueue(() => bindSelectedEvidence(fullFollowup, h.host, snapshot.events.map(e => e.eventId)));
  await denied(h.gateway.submit(fullFollowup), 'E_INPUT_TOKEN_CAP');
  assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.budget().attempts, 0, 'Full six-event followup exceeds the same 12k envelope; reject before reservation, never truncate');
  const validated = validateRequest(input); const projected = selectedEvidenceProjection(validated);
  assert.equal(projected['evidenceVersion'], 'collect-chase-evidence@3');
  assert.equal((projected['runContext'] as { buildHash: string }).buildHash, snapshot.context.buildHash);
  assert.equal((projected['runContext'] as { runtimeArtifactHash: string }).runtimeArtifactHash, snapshot.context.runtimeArtifactHash);
  assert.equal(projected['version'], SELECTED_EVIDENCE_VERSION); assert.deepEqual((projected['events'] as { eventId: string }[]).map(e => e.eventId), selected);
  assert.ok(selectedEvidenceDigest(validated));
  const plain = structuredClone(input); await assert.rejects(h.gateway.submit(plain)); assert.equal(h.fetchMock.mock.callCount(), 0);
  const expected = { kind: 'explain', summary: '实际接触优先', facts: [{ text: '原run同时达标、到时和接触', eventIds: [selected[selected.length - 1]] }], rules: [], hypotheses: [], options: [] };
  h.fetchMock.mock.mockImplementation(async (_url, init) => {
    const bodyText = String(init?.body); const body = JSON.parse(bodyText) as { messages: Array<{ content: string }> };
    const outbound = JSON.parse(body.messages[1]!.content) as { selectedEvidence: Record<string, unknown> };
    assert.equal(outbound.selectedEvidence['version'], SELECTED_EVIDENCE_VERSION);
    const outboundText = canonicalJson(outbound);
    for (const key of ['frames', 'inputs', 'controls', 'diagnostics', 'productionPackagePaths', 'authorNote', 'instructions', 'writerToken', 'sessionId']) assert.equal(outboundText.includes(`"${key}"`), false, key);
    for (const secret of [SESSION, WRITER, '/Users/', 'offline-fixture-NOT-A-KEY']) assert.equal(bodyText.includes(secret), false, secret);
    return reply(expected);
  });
  assert.deepEqual(parseModelResponse(JSON.stringify(expected), validated), expected);
  assert.equal(promptSchemaDescriptor(validated).phase, 'r0-ai11-initial-readonly@1');
  assert.throws(() => parseModelResponse(JSON.stringify(GOOD), validated), /E_RESPONSE_PHASE/u);
  const followupPhase = { ...validated, requestSlotID: 'R0-AI-11-R1-F' };
  assert.equal(promptSchemaDescriptor(followupPhase).phase, 'r0-ai11-followup-candidate@1');
  assert.throws(() => parseModelResponse(JSON.stringify(expected), followupPhase), /E_RESPONSE_PHASE/u);
  const omitted = snapshot.events.find(e => !selected.includes(e.eventId))!;
  assert.throws(() => parseModelResponse(JSON.stringify({ ...expected, facts: [{ text: '未选事件', eventIds: [omitted.eventId] }] }), validated), /E_RESPONSE_REFERENCE/u);
  assert.equal((await h.gateway.submit(input)).status, 'answered');
});

test('offline selected evidence: unknown/cross-run/duplicate/diagnostic/over-count IDs and forged Host rejected', async t => {
  const h = setup(t); const run = await h.host.startRun(); const id = run.events[0]!.eventId;
  for (const ids of [['unknown'], [id, id], ['other-run:e1'], ['fake:d1'], Array.from({ length: 13 }, (_, i) => `run:e${i + 1}`)]) {
    await assert.rejects(h.queue.enqueue(() => bindSelectedEvidence(request(h.host, 'R0-AI-11-R1-I'), h.host, ids)));
  }
  await assert.rejects(h.queue.enqueue(() => bindSelectedEvidence(request(h.host, 'R0-AI-11-R1-I'), { currentRun: () => run } as unknown as R0Host, [id])));
  const oldRequest = request(h.host, 'R0-AI-11-R1-I'); await h.queue.enqueue(() => bindSelectedEvidence(oldRequest, h.host, [id]));
  await h.host.startRun();
  await denied(h.gateway.submit(oldRequest), 'E_SELECTED_EVIDENCE_STALE'); assert.equal(h.fetchMock.mock.callCount(), 0);
  await assert.rejects(h.queue.enqueue(() => bindSelectedEvidence(request(h.host, 'R0-AI-11-R1-I'), h.host, [id])));
});

test('offline selected evidence: mutation, cross-owner tokens and idempotency evidence changes rejected; empty legacy fingerprint preserved', async t => {
  const h = setup(t); const run = await h.host.startRun(); const input = request(h.host, 'R0-AI-11-R1-I');
  const expectedLegacy = createHash('sha256').update(canonicalJson(input)).digest('hex');
  assert.equal(requestFingerprint(input), expectedLegacy); assert.deepEqual(selectedEvidenceProjection(input), { coverage: 'none', events: [] });
  await h.queue.enqueue(() => bindSelectedEvidence(input, h.host, [run.events[0]!.eventId]));
  const hash = requestFingerprint(input); assert.notEqual(hash, expectedLegacy);
  const otherHost = new R0Host(fixture(), { queue: h.queue, sessionId: SESSION, writerToken: WRITER, buildIdentity: build() });
  const other = request(otherHost, 'R0-AI-11-R1-I'); Object.assign(other, { requestId: input.requestId, idempotencyKey: input.idempotencyKey, snapshot: { ...other.snapshot, requestId: input.requestId } });
  const otherRun = await otherHost.startRun(); await h.queue.enqueue(() => bindSelectedEvidence(other, otherHost, [otherRun.events[0]!.eventId]));
  await denied(h.gateway.submit(other), 'E_SELECTED_EVIDENCE_HOST');
  input.snapshot.requestText = 'changed after evidence binding';
  await assert.rejects(h.gateway.submit(input)); assert.equal(h.fetchMock.mock.callCount(), 0);
  const valid = request(h.host, 'R0-AI-11-R1-I'); await h.queue.enqueue(() => bindSelectedEvidence(valid, h.host, [run.events[0]!.eventId]));
  h.fetchMock.mock.mockImplementation(async () => reply({ kind: 'clarify', question: '还有什么想观察？' }));
  await h.gateway.submit(valid);
  const noEvidence = structuredClone(valid); noEvidence.snapshot.selectedEvidenceRefs = [];
  await denied(h.gateway.submit(noEvidence), 'E_IDEMPOTENCY_CONFLICT');
});


test('offline bridge: late empty-evidence response after revision remains accounted history, never eligible answered', async t => {
  const h = setup(t); const input = request(h.host);
  let release!: (value: Response) => void; let started!: () => void;
  const waiting = new Promise<Response>(resolve => { release = resolve; }); const dispatched = new Promise<void>(resolve => { started = resolve; });
  h.fetchMock.mock.mockImplementation(() => { started(); return waiting; });
  const pending = h.gateway.submit(input); await dispatched;
  assert.equal((await h.host.execute(command(h.host))).ok, true);
  release(reply()); const result = await pending;
  assert.equal(result.status, 'canceled');
  assert.equal(h.ledger.attempts().length, 1); assert.equal(h.ledger.attempts()[0]?.state, 'accounted');
  assert.equal(h.ledger.attempts()[0]?.outcome, 'parsed'); assert.equal(h.ledger.attempts()[0]?.usage?.promptTokens, 100);
  assert.equal(h.ledger.budget().attempts, 1); assert.equal(h.ledger.budget().inFlight, 0);
  assert.equal(h.ledger.budget().reservedNanoCNY, 56_768_000);
  await denied(h.manager.prepareFromGateway(h.gateway, result), 'E_GATEWAY_RESULT_SOURCE');
  assert.equal(h.host.document().project.revision, 1); assert.equal(h.host.document().project.rules.goal.targetScore, 7);
});


test('offline bridge: wrong returned model is billed history, never a suggestion or candidate capability', async t => {
  const h = setup(t); const input = request(h.host);
  h.fetchMock.mock.mockImplementation(async () => reply(GOOD, { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 }, 'deepseek-reasoner'));
  const result = await h.gateway.submit(input);
  assert.equal(result.status, 'failed'); if (result.status !== 'failed') assert.fail('wrong model cannot be answered');
  assert.equal(result.code, 'E_MODEL_VERSION'); assert.equal(result.attempt?.state, 'accounted'); assert.equal(result.attempt?.outcome, 'parsed');
  assert.equal(result.attempt?.returnedModel, 'deepseek-reasoner'); assert.equal(result.attempt?.usageCalculatedNanoCNY, 360_000);
  assert.equal(h.ledger.budget().attempts, 1); assert.equal(h.ledger.budget().inFlight, 0); assert.equal(h.ledger.budget().reservedNanoCNY, 56_768_000);
  await denied(h.manager.prepareFromGateway(h.gateway, result), 'E_GATEWAY_RESULT_SOURCE');
  const duplicate = await h.gateway.submit(input); assert.equal(duplicate.status, 'failed'); assert.equal(h.fetchMock.mock.callCount(), 1, 'No implicit model-version repair or resend');
  assert.equal(h.manager.snapshot(), null); assert.equal(h.host.document().project.revision, 0);
});
