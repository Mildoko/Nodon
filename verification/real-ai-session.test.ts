import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import { AiAuthority } from '../src/ai/authority.js';
import { AiGateway } from '../src/ai/gateway.js';
import { AiLedger } from '../src/ai/ledger.js';
import { AiError, MODEL, type DeepSeekAccess, type GatewayResult, type SubmitRequest } from '../src/ai/types.js';
import { canonicalJson, parseDocument } from '../src/domain/index.js';
import { CommandQueue } from '../src/host/command-queue.js';
import { R0Host } from '../src/host/r0-host.js';
import { RealAiR0Session, materializeChildIntent, readHumanWitness, type HumanWitness } from '../src/host/real-ai-session.js';
import { CandidateManager } from '../src/trial/candidate-manager.js';
import type { BuildIdentity } from '../tools/build-manifest.js';

// OFFLINE ONLY: temporary root, controlled_transport, fake credentials, and isolated SQLite.
// Prior rows are synthetic ordered setup, not provider/human evidence and not real slot consumption.
const SOURCE_ROOT = process.cwd();
const frozenManifest = JSON.parse(readFileSync(resolve('verification/model-request-manifest.json'), 'utf8')) as { manifestVersion: 'r0-model-requests@1'; budget: { logicalRequests: number; maxProviderAttemptsPerLogicalRequest: number; maxProviderAttemptsTotal: number; concurrency: number; implicitSDKRetries: number }; slots: Array<{ requestSlotID: string; parentSlotID: string | null; maxProviderAttempts: number; reservedAttemptIDs: string[]; inputFixturePath: string; intent?: string; intentTemplate?: string }>; executionOrder: string[] };
const configured = JSON.parse(readFileSync(resolve('config/deepseek-access.json'), 'utf8')) as DeepSeekAccess;
const SESSION = 'offline-coordinator-session'; const WRITER = 'offline-coordinator-writer';
const DIRECTIONS = { kind: 'directions', summary: '两种方向', options: [{ id: 'layout_a', label: 'layout', rationale: 'observe' }, { id: 'other', label: 'speed', rationale: 'change' }] };
const PROPOSE = { kind: 'propose', summary: '降低目标', operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }] };
function syntheticBuild(): BuildIdentity { return { buildHash: 'sha256:' + 'd'.repeat(64), runtimeArtifactHash: 'sha256:' + 'e'.repeat(64), buildId: 'offline-coordinator', environmentId: 'offline-coordinator', manifest: {}, runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] }, productionPackagePaths: [] }; }
function response(output: unknown): Response { return new Response(JSON.stringify({ id: 'offline-coordinator-response', model: MODEL, choices: [{ message: { content: JSON.stringify(output) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } }), { headers: { 'Content-Type': 'application/json' } }); }
function setup(t: TestContext, slotId: string, credential: () => Promise<string | null> = async () => 'OFFLINE-NOT-A-KEY') {
  const root = mkdtempSync(join(tmpdir(), 'nodon-session-offline-')); const manifest = structuredClone(frozenManifest);
  const target = manifest.slots.find(s => s.requestSlotID === slotId)!;
  for (const path of ['verification/model-request-manifest.json', 'verification/fixtures/terminal-conflict.json', 'verification/inputs/terminal-conflict.json', target.inputFixturePath]) {
    mkdirSync(dirname(resolve(root, path)), { recursive: true }); copyFileSync(resolve(SOURCE_ROOT, path), resolve(root, path));
  }
  const document = parseDocument(readFileSync(resolve(root, target.inputFixturePath), 'utf8')); const queue = new CommandQueue(); const build = syntheticBuild();
  const host = new R0Host(document, { queue, sessionId: SESSION, writerToken: WRITER, buildIdentity: build });
  const authority = new AiAuthority(queue, { authEpoch: 0, adultEnabled: true, scopeEnabled: true, sessionId: SESSION, writerToken: WRITER, projectId: document.project.projectId });
  const ledger = new AiLedger(queue, join(root, 'only-this-test.sqlite'), manifest);
  const gateway = new AiGateway(authority, ledger, { ...configured, modelApproved: true, availabilityApproved: true, budgetApproved: true, outboundScopeApproved: true, credentialsConfigured: true }, credential, 60000, host, 'controlled_transport');
  const candidates = new CandidateManager(host, authority, { currentBuild: () => structuredClone(build), yieldSlice: async () => {} });
  const session = new RealAiR0Session(root, slotId, host, authority, candidates, build, 'HUMAN-01', { isolatedRoot: true, ledger, gateway });
  const fetchMock = t.mock.method(globalThis, 'fetch', (async () => { throw new Error('REAL_NETWORK_FORBIDDEN_OFFLINE_SESSION'); }) as typeof fetch);
  fetchMock.mock.mockImplementation(async () => response(PROPOSE));
  t.after(async () => { await session.close(); rmSync(root, { recursive: true, force: true }); });
  async function seedPrior(parentResponse: unknown = DIRECTIONS) {
    const parentSlot = target.parentSlotID;
    await queue.enqueue(sequence => {
      for (const prior of manifest.executionOrder.slice(0, manifest.executionOrder.indexOf(slotId))) {
        const requestId = randomUUID(); ledger.register(prior, requestId, randomUUID(), 'offline-synthetic-not-a-request-hash');
        const attempt = ledger.reserve(requestId, 0, sequence); ledger.markDispatch(attempt.attemptId);
        const output = prior === parentSlot ? parentResponse : { kind: 'clarify', question: 'offline setup only' };
        const complete = ledger.complete(attempt.attemptId, { promptTokens: 100, completionTokens: 10, cachedTokens: 0 }, 'offline-seed', 'parsed', JSON.stringify(output), MODEL, 'stop');
        ledger.saveResult(requestId, attempt.attemptId, { status: 'answered', requestId, attempt: complete, response: output } as GatewayResult);
      }
    });
  }
  function witness(overrides: Partial<HumanWitness> = {}) {
    const parent = ledger.attempts().find(a => a.requestSlotID === target.parentSlotID);
    const value: HumanWitness = { version: 'nodon-r0-human-witness@1', source: 'external_human_witness', participantId: 'HUMAN-01', participantRole: 'developer_self_test',
      slotId: target.parentSlotID ?? slotId, requestId: parent?.requestId ?? session.view().requestId!, recordedAt: new Date().toISOString(), sourceMessageRef: 'offline-synthetic-witness-NOT-REAL-HUMAN', limitation: 'Controlled record only; no real user trial.',
      decision: 'accept', semantic: 'correct', rationale: 'offline fixture', optionId: 'layout_a', directionClass: 'layout', ...overrides };
    const witnessRef = `evidence/r0/${build.buildId}/10_decisions/human-witness/${randomUUID()}.json`;
    mkdirSync(dirname(resolve(root, witnessRef)), { recursive: true }); writeFileSync(resolve(root, witnessRef), JSON.stringify(value)); return witnessRef;
  }
  return { root, manifest, target, host, queue, authority, ledger, gateway, candidates, session, fetchMock, seedPrior, witness };
}
async function code(work: Promise<unknown>, expected: string): Promise<void> { await assert.rejects(work, (error: unknown) => error instanceof AiError && error.code === expected); }

test('offline coordinator: child template uses actual option text and requires parent-bound external semantic witness', async t => {
  const h = setup(t, 'R0-AI-09-R1-F'); await h.seedPrior();
  assert.deepEqual(h.session.view().parentOptions, DIRECTIONS.options);
  await code(h.session.submit([], { optionId: 'layout_a', rationale: 'choose', directionClass: 'layout' }), 'E_HUMAN_CHOICE_REQUIRED');
  await code(h.session.submit([], { optionId: 'layout_a', rationale: 'choose', directionClass: 'layout', witnessRef: '../fake.json' }), 'E_HUMAN_WITNESS_PATH');
  const fake = h.witness({ requestId: randomUUID() });
  await code(h.session.submit([], { optionId: 'layout_a', rationale: 'choose', directionClass: 'layout', witnessRef: fake }), 'E_HUMAN_WITNESS_BINDING');
  assert.equal(h.ledger.attempts().filter(a => a.requestSlotID === h.target.requestSlotID).length, 0);
  const witnessRef = h.witness(); let actualIntent = '';
  h.fetchMock.mock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }; const outbound = JSON.parse(body.messages[1]!.content) as { intent: string };
    actualIntent = outbound.intent; assert.equal(outbound.intent.includes(witnessRef), false);
    return response({ kind: 'clarify', question: 'offline-only response' });
  });
  await h.session.submit([], { optionId: 'layout_a', rationale: 'offline fixture', directionClass: 'layout', witnessRef });
  assert.equal(actualIntent, materializeChildIntent(h.target.intentTemplate!, DIRECTIONS.options[0]!));
  assert.equal(actualIntent.includes('undefined'), false); assert.equal(actualIntent.includes('{{'), false);
  const dir = resolve(h.root, 'evidence/r0/offline-coordinator/07_ai/frozen', h.target.requestSlotID);
  assert.equal(h.fetchMock.mock.callCount(), 1); assert.ok(dir);
});

test('offline coordinator: no semantic direction inference from option labels; browser self-report cannot dispose child', async t => {
  const h = setup(t, 'R0-AI-09-R1-F'); await h.seedPrior();
  await code(h.session.disposeBlockedChild({ reason: 'parent_no_eligible_options' }), 'E_PROGRAM_CANNOT_JUDGE_DIRECTION_SEMANTICS');
  await code(h.session.disposeBlockedChild({ reason: 'human_reject' }), 'E_HUMAN_WITNESS');
  const witnessRef = h.witness({ decision: 'retain', semantic: 'unknown' });
  await h.session.disposeBlockedChild({ reason: 'human_retain', witnessRef });
  assert.equal(h.session.view().status, 'blocked_disposed'); assert.equal(h.session.view().nextFrozenSlot, 'R0-AI-10-R1-I');
  assert.equal(h.ledger.attempts().filter(a => a.requestSlotID === h.target.requestSlotID).length, 0); assert.equal(h.fetchMock.mock.callCount(), 0);
});

test('offline coordinator: append-only program disposition retains denominator and advances only child order', async t => {
  const h = setup(t, 'R0-AI-09-R1-F'); await h.seedPrior({ kind: 'clarify', question: 'no supported option' });
  await h.session.disposeBlockedChild({ reason: 'parent_no_eligible_options' });
  const records = h.session.view().dispositions; assert.equal(records.length, 1); assert.equal(records[0]!.slotId, h.target.requestSlotID);
  assert.equal(records[0]!.programCode, 'E_PARENT_NO_ELIGIBLE_OPTIONS'); assert.equal(h.session.view().nextFrozenSlot, 'R0-AI-10-R1-I');
  await code(h.session.disposeBlockedChild({ reason: 'parent_no_eligible_options' }), 'E_SLOT_DISPOSED');
  const initial = setup(t, 'R0-AI-01-R1-I'); await initial.seedPrior();
  await code(initial.session.disposeBlockedChild({ reason: 'parent_no_eligible_options' }), 'E_DISPOSITION_NOT_CHILD');
  assert.equal(initial.session.view().dispositions.length, 0);
});

test('offline coordinator: AI11 refuses a run_started decoy; prepares exact real 900tick RT07 before sending', async t => {
  const h = setup(t, 'R0-AI-11-R1-I'); await h.seedPrior(); const decoy = await h.host.startRun();
  await code(h.session.submit([decoy.events[0]!.eventId]), 'E_FROZEN_RT07_REQUIRED');
  assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.attempts().filter(a => a.requestSlotID === h.target.requestSlotID).length, 0);
  const prepared = await h.session.prepareFrozenExplanationRun(); const run = h.host.currentRun()!;
  assert.equal(run.tick, 900); assert.equal(run.inputs.length, 900); assert.equal(run.terminal?.reason, 'caught'); assert.equal(run.terminal?.goalReached, true); assert.equal(run.terminal?.timeout, true);
  assert.equal(prepared.recommendedEventIds.length, 2); assert.equal(prepared.fixtureHash, 'sha256:eb854e21c099c0d5345510e36005956c675632c5f97ab25a18dd1003c52478df');
  h.fetchMock.mock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] }; const outbound = JSON.parse(body.messages[1]!.content) as { selectedEvidence: { events: { eventId: string; kind: string }[] } };
    const ended = outbound.selectedEvidence.events.find(e => e.kind === 'round_ended')!;
    return response({ kind: 'explain', summary: 'actual selected event', facts: [{ text: 'caught priority', eventIds: [ended.eventId] }], rules: [], hypotheses: [], options: [] });
  });
  await h.session.submit(prepared.recommendedEventIds); assert.equal(h.fetchMock.mock.callCount(), 1); assert.equal(h.session.view().status, 'answered');
});

test('offline coordinator: no automatic retry, zero-attempt explicit retry keeps request identity and busy submit is idempotent', async t => {
  let credentials = 0; const h = setup(t, 'R0-AI-01-R1-I', async () => ++credentials === 1 ? null : 'OFFLINE-NOT-A-KEY'); await h.seedPrior();
  await code(h.session.submit([]), 'E_CREDENTIAL_UNAVAILABLE');
  const requestId = h.session.view().requestId; assert.ok(requestId); assert.equal(h.session.view().status, 'retryable_zero_attempt');
  assert.equal(credentials, 1); assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.attempts(requestId!).length, 0);
  await h.session.submit([]); assert.equal(credentials, 1);
  let release!: (value: Response) => void; let start!: () => void;
  const waiting = new Promise<Response>(resolve => { release = resolve; }); const started = new Promise<void>(resolve => { start = resolve; });
  h.fetchMock.mock.mockImplementation(() => { start(); return waiting; });
  const retry = h.session.retry(); await started; const duplicate = h.session.submit([]); assert.strictEqual(retry, duplicate);
  release(response(PROPOSE)); await retry;
  assert.equal(h.session.view().requestId, requestId); assert.equal(credentials, 2); assert.equal(h.fetchMock.mock.callCount(), 1); assert.equal(h.ledger.attempts(requestId!).length, 1);
  await code(h.session.retry(), 'E_EXPLICIT_RETRY_NOT_ELIGIBLE');
});

test('offline coordinator witness reader: rejects absolute/traversal/symlink references', async t => {
  const h = setup(t, 'R0-AI-09-R1-F'); await h.seedPrior(); const witnessRef = h.witness();
  assert.equal(readHumanWitness(h.root, witnessRef).participantId, 'HUMAN-01');
  assert.throws(() => readHumanWitness(h.root, resolve(h.root, witnessRef)), /E_HUMAN_WITNESS_PATH/u);
  assert.throws(() => readHumanWitness(h.root, witnessRef.replace('/human-witness/', '/human-witness/../human-witness/')), /E_HUMAN_WITNESS_PATH/u);
  const linked = witnessRef.replace(/[^/]+$/, 'linked.json'); symlinkSync(resolve(h.root, witnessRef), resolve(h.root, linked));
  assert.throws(() => readHumanWitness(h.root, linked), /E_HUMAN_WITNESS_PATH/u);
});


test('offline coordinator: same Host advances actual RT07 explanation into frozen child with witnessed choice and real candidate trial', async t => {
  const h = setup(t, 'R0-AI-11-R1-I'); await h.seedPrior(); const proof = await h.session.prepareFrozenExplanationRun();
  const runId = h.host.currentRun()!.context.runId; const hostIdentity = h.host; const gatewayIdentity = h.session.gateway; const ledgerIdentity = h.session.ledger;
  let phaseReply = 0;
  h.fetchMock.mock.mockImplementation(async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { content: string }[] };
    const outbound = JSON.parse(body.messages[1]!.content) as { selectedEvidence: { runId: string; events: { eventId: string; kind: string }[] }; intent: string };
    assert.equal(outbound.selectedEvidence.runId, runId);
    if (++phaseReply === 1) {
      const event = outbound.selectedEvidence.events.find(e => e.kind === 'round_ended')!;
      return response({ kind: 'explain', summary: 'caught priority', facts: [{ text: 'actual terminal', eventIds: [event.eventId] }], rules: [], hypotheses: [], options: [{ id: 'move_n1', label: 'move n1', rationale: 'minimal test' }] });
    }
    assert.equal(outbound.intent.includes('undefined'), false); assert.equal(outbound.intent.includes('{{'), false);
    return response({ kind: 'propose', summary: 'move selected reward', operations: [{ op: 'move_entity', entityId: 'n1', expectedValue: { x: 70, y: 290 }, value: { x: 40, y: 290 } }] });
  });
  await h.session.submit(proof.recommendedEventIds); const parentRequestId = h.session.view().requestId!; const attemptsBefore = h.ledger.attempts().length;
  const next = await h.session.advanceToChild();
  assert.equal(h.session.slotId, 'R0-AI-11-R1-F'); assert.equal(next.status, 'ready'); assert.equal(next.requestId, null);
  assert.equal(next.parentRequestId, parentRequestId); assert.equal(next.parentOptions[0]?.id, 'move_n1');
  assert.strictEqual(h.session.host, hostIdentity); assert.strictEqual(h.session.gateway, gatewayIdentity); assert.strictEqual(h.session.ledger, ledgerIdentity);
  assert.equal(h.host.currentRun()!.context.runId, runId); assert.equal(h.ledger.attempts().length, attemptsBefore); assert.equal(h.fetchMock.mock.callCount(), 1);
  const witnessRef = h.witness({ slotId: 'R0-AI-11-R1-I', requestId: parentRequestId, optionId: 'move_n1', directionClass: 'minimal_change', rationale: 'selected minimal change' });
  await code(h.session.submit([], { optionId: 'move_n1', directionClass: 'minimal_change', rationale: 'borrowed different reason', witnessRef }), 'E_HUMAN_WITNESS_BINDING');
  assert.equal(h.fetchMock.mock.callCount(), 1);
  await h.session.submit([], { optionId: 'move_n1', directionClass: 'minimal_change', rationale: 'selected minimal change', witnessRef });
  assert.equal(h.fetchMock.mock.callCount(), 2); const candidate = h.candidates.snapshot()!;
  assert.equal(candidate.source, 'provider_gateway'); assert.equal(candidate.providerEvidence?.transport, 'controlled_transport'); assert.equal(candidate.trialStatus, 'not_run');
  assert.equal(h.host.document().project.revision, 0); assert.equal((await h.candidates.trial(candidate.candidateId)).trialStatus, 'passed');
  assert.equal(h.host.currentRun()!.context.runId, runId);
  await code(h.session.recheckFrozenInput(), 'E_RECHECK_REQUIRES_APPLIED_CANDIDATE');
  await t.test('controlled machine confirmation starts a new formal revision/run recheck without provider calls or formal export', async () => {
    // This is an automated confirmation in an isolated controlled test, not a human decision or real provider claim.
    assert.equal(candidate.providerEvidence?.transport, 'controlled_transport');
    const committed = await h.candidates.confirm(candidate.candidateId); assert.equal(committed.ok, true);
    const providerCalls = h.fetchMock.mock.callCount(); const attemptCount = h.ledger.attempts().length;
    const result = await h.session.recheckFrozenInput();
    assert.notEqual(result.runId, runId); assert.notEqual(result.runId, h.candidates.snapshot()!.trialRef);
    assert.equal(result.parentRunId, runId); assert.equal(result.parentRequestId, parentRequestId);
    assert.equal(result.candidateId, candidate.candidateId); assert.equal(result.candidateHash, candidate.candidateHash);
    assert.equal(result.revision, 1); assert.equal(result.semanticHash, candidate.candidateSemanticHash);
    assert.equal(result.source, 'machine_test'); assert.equal(result.inputSource, 'catalog_machine'); assert.equal(result.executionClass, 'automation_test');
    assert.equal(result.tick, 889); assert.equal(result.terminal?.reason, 'win'); assert.equal(result.comparison.improvementJudgment, null);
    assert.equal(result.coverage.rewardCollected, true); assert.equal(result.coverage.committedInputs, 889);
    assert.equal(result.runPath, null); assert.equal(result.exportNature, 'controlled_test_not_exported');
    assert.equal(existsSync(resolve(h.root, 'evidence/r0/offline-coordinator/04_runs')), false);
    const actual = h.host.currentRun()!; assert.equal(actual.context.runId, result.runId); assert.equal(actual.document.project.revision, 1);
    assert.ok(actual.inputs.every((input, i) => input.committed && input.direction.x === (i < 884 ? 0 : 1) && input.direction.y === 0));
    const duplicate = await h.session.recheckFrozenInput(); assert.equal(duplicate.runId, result.runId); assert.equal(duplicate.reusedExistingResult, true);
    assert.equal(h.fetchMock.mock.callCount(), providerCalls); assert.equal(h.ledger.attempts().length, attemptCount);
  });
  await code(h.session.advanceToChild(), 'E_ADVANCE_STATE');
});


test('offline coordinator: an initial with no eligible direction can dispose only its unique frozen child without restarting', async t => {
  const h = setup(t, 'R0-AI-09-R1-I'); await h.seedPrior();
  h.fetchMock.mock.mockImplementation(async () => response({ kind: 'clarify', question: 'no direction supplied' }));
  await h.session.submit([]); assert.equal(h.session.view().nextFrozenSlot, 'R0-AI-09-R1-F');
  await code(h.session.advanceToChild(), 'E_ADVANCE_NO_ELIGIBLE_OPTIONS');
  await h.session.disposeBlockedChild({ reason: 'parent_no_eligible_options' });
  assert.equal(h.session.slotId, 'R0-AI-09-R1-I');
  assert.equal(h.session.view().dispositions[0]!.slotId, 'R0-AI-09-R1-F');
  assert.equal(h.session.view().nextFrozenSlot, 'R0-AI-10-R1-I');
  assert.equal(h.ledger.attempts().filter(a => a.requestSlotID === 'R0-AI-09-R1-F').length, 0);
  assert.equal(h.fetchMock.mock.callCount(), 1);
});
