import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AiAuthority } from '../src/ai/authority.js';
import { AiGateway } from '../src/ai/gateway.js';
import { AiLedger } from '../src/ai/ledger.js';
import { AiError, MODEL, type AttemptRecord, type DeepSeekAccess, type GatewayResult } from '../src/ai/types.js';
import { applyOperations, assertDocument, canonicalJson, canonicalSHA256, parseDocument } from '../src/domain/index.js';
import { R0Host } from '../src/host/r0-host.js';
import { RealAiR0Session } from '../src/host/real-ai-session.js';
import { CandidateManager } from '../src/trial/candidate-manager.js';
import type { BuildIdentity } from '../tools/build-manifest.js';
import { BATCH_ORDER, DIVISION_HASH, PROTOCOL_HASH, assertCandidateOracle, assertConfirmReceipt, assertExactOperations, assertFormalRuntime, assertLedgerReady, assertSideRecord, assertStaticTheme, assertWholeDocument, closePending, executeFormalInput, expectedDocument, expectedOperations, fixtureReference, formalInput, getPendingContext, guardPendingDelivery, ledgerSummary, manualCommands, makeConfirmReceipt, preflight, readLedgerOnly, retainPending, type MechanicalCase, type Side, type SideRecord } from '../tools/r0-mechanical-validation.js';

// OFFLINE ONLY: synthetic identities, temporary SQLite, controlled transport. No real key/provider/ledger writes.
const root = process.cwd();
const build: BuildIdentity = { buildId: 'offline-mechanical', buildHash: 'sha256:' + 'a'.repeat(64), runtimeArtifactHash: 'sha256:' + 'b'.repeat(64), environmentId: 'offline-mechanical', manifest: {}, runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] }, productionPackagePaths: [] };
const base = (id: MechanicalCase, side: Side = 'A') => parseDocument(readFileSync(resolve(root, fixtureReference(id, side)), 'utf8'));
function owner(id: MechanicalCase, side: Side = 'A') {
  const document = base(id, side), binding = { sessionId: randomUUID(), writerToken: randomUUID() }, host = new R0Host(document, { ...binding, buildIdentity: build });
  const authority = new AiAuthority(host.queue, { ...binding, projectId: document.project.projectId, authEpoch: 0, adultEnabled: true, scopeEnabled: true });
  const candidates = new CandidateManager(host, authority, { currentBuild: () => build, yieldSlice: async () => {} });
  return { document, binding, host, authority, candidates };
}
function error(code: string): (e: unknown) => boolean { return e => e instanceof AiError && e.code === code; }

test('frozen exact operations reject extra/noop/duplicate/unknown/wrong expected and permit only two independent 08 orders', () => {
  for (const id of ['04', '05', '06', '07', '08'] as const) {
    const ops = expectedOperations(id); assert.doesNotThrow(() => assertExactOperations(id, ops));
    assert.throws(() => assertExactOperations(id, [...ops, ops[0]]), error('E_FROZEN_OPERATIONS'));
    assert.throws(() => assertExactOperations(id, [{ ...ops[0], extra: 'not allowed' }, ...ops.slice(1)]), error('E_FROZEN_OPERATIONS'));
    assert.throws(() => assertExactOperations(id, [{ ...ops[0], expectedValue: 0 }, ...ops.slice(1)]), error('E_FROZEN_OPERATIONS'));
    assert.throws(() => assertExactOperations(id, []), error('E_FROZEN_OPERATIONS'));
  }
  assert.doesNotThrow(() => assertExactOperations('08', expectedOperations('08').reverse()));
  assert.throws(() => assertExactOperations('08', [expectedOperations('08')[0]]), error('E_FROZEN_OPERATIONS'));
});

test('whole document oracle catches unrelated instructions, stable ID, geometry, metadata and revision changes', () => {
  const original = base('04'), expected = expectedDocument(original, '04', 'A', true);
  for (const mutate of [
    (d: typeof expected) => { d.project.instructions = 'secretly synchronized instructions'; },
    (d: typeof expected) => { d.project.authorNote = 'extra'; },
    (d: typeof expected) => { d.project.scene.entities[2]!.id = 'rebound'; },
    (d: typeof expected) => { d.project.scene.entities[2]!.x++; },
    (d: typeof expected) => { d.project.revision++; },
    (d: typeof expected) => { d.project.rules.timer.limit = 30; },
  ]) { const changed = structuredClone(expected); mutate(changed); assert.throws(() => assertWholeDocument(changed, expected), error('E_FULL_DOCUMENT_ORACLE')); }
  assert.equal(expected.project.instructions, original.project.instructions);
  assert.equal(original.project.revision, 0);
});

test('exact operations plus complete candidate state are required before trial/commit; wrong candidate writes nothing', async () => {
  const h = owner('04'), c = await h.candidates.prepareControlled({ requestId: randomUUID(), operations: expectedOperations('04') });
  assertCandidateOracle('04', h.document, c);
  const altered = structuredClone(c); altered.candidateState!.rules.timer.limit = 30;
  assert.throws(() => assertCandidateOracle('04', h.document, altered), error('E_FULL_CANDIDATE_ORACLE'));
  const extra = await h.candidates.prepareControlled({ requestId: randomUUID(), operations: [...expectedOperations('04'), { op: 'set_goal', expectedValue: 10, value: 6 }] });
  assert.throws(() => assertCandidateOracle('04', h.document, extra), error('E_FROZEN_OPERATIONS'));
  assert.equal(extra.trialStatus, 'not_run'); assert.deepEqual(h.host.document(), h.document);
});

test('08 genuine existing Gate rejects a bad second operation without partial write; accepted permutation retains actual array/hash', async () => {
  const h = owner('08');
  const bad = await h.candidates.prepareControlled({ requestId: randomUUID(), operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }, { op: 'set_detect_radius', expectedValue: 999, value: 140 }] });
  assert.equal(bad.validation, 'invalid'); assert.equal((await h.candidates.confirm(bad.candidateId)).ok, false); assert.deepEqual(h.host.document(), h.document);
  const actual = expectedOperations('08').reverse(), good = await h.candidates.prepareControlled({ requestId: randomUUID(), operations: actual });
  assertCandidateOracle('08', h.document, good); const hash = good.candidateHash;
  const trial = await h.candidates.trial(good.candidateId); assert.equal(trial.trialStatus, 'passed'); assert.deepEqual(trial.operations, actual); assert.equal(trial.candidateHash, hash);
  assert.equal((await h.candidates.confirm(good.candidateId)).ok, true); assertWholeDocument(h.host.document(), expectedDocument(h.document, '08', 'A', true));
});

for (const id of ['04', '05', '06', '08'] as const) for (const side of ['A', 'B'] as const) test(`fixed actual Runtime ${id}${side} observes frozen mechanism on whole scene`, async () => {
  const document = expectedDocument(base(id, side), id, side, true), host = new R0Host(document, { sessionId: randomUUID(), writerToken: randomUUID(), buildIdentity: build });
  const result = await executeFormalInput(host, id, side, document);
  assert.equal(result.tick, id === '05' ? 1800 : id === '06' ? 192 : 320);
  assert.equal(result.terminalReason, id === '05' ? 'timeout' : null);
  const run = host.currentRun()!; assertFormalRuntime(id, side, run, document);
  const forged = { ...structuredClone(run), inputs: run.inputs.map(item => structuredClone(item)) }; forged.inputs[1] = { ...forged.inputs[1]!, direction: { x: 1, y: 1 } };
  assert.throws(() => assertFormalRuntime(id, side, forged, document), error('E_FORMAL_INPUT_DIRECTION'));
  assert.equal(run.document.project.scene.entities.length, id === '05' ? 6 : 12);
});

test('B direct controls preserve mirror identity and 08 two actual revisions rather than AI atomic candidate', async () => {
  const h = owner('08', 'B'); let commands = 0;
  for (const command of manualCommands('08')) {
    const envelope = { ...h.binding, commandId: randomUUID(), projectId: h.document.project.projectId, expectedRevision: h.host.document().project.revision, command };
    const before = h.host.document(); assert.equal((await h.host.preview(envelope)).ok, true); assert.deepEqual(h.host.document(), before);
    assert.equal((await h.host.execute(envelope)).ok, true); commands++;
  }
  assert.equal(commands, 2); assert.equal(h.host.document().project.revision, 2); assertWholeDocument(h.host.document(), expectedDocument(h.document, '08', 'B', true));
  assert.deepEqual(formalInput('06', 'B'), [{ ticks: 19, x: 0, y: -1 }, { ticks: 173, x: -1, y: 0 }]);
});

test('theme uses genuine static Gate with no Runtime trial and unchanged semantic hash on A and B', async () => {
  const h = owner('07'), c = await h.candidates.prepareControlled({ requestId: randomUUID(), operations: expectedOperations('07') });
  assert.equal(c.trialStatus, 'runtime_not_applicable'); assert.equal(c.trial?.run, null); assert.equal(c.trial?.trialId, null); assert.equal(c.trialRef, null);
  await assert.rejects(h.candidates.trial(c.candidateId), error('E_TRIAL_STATE')); assert.equal((await h.candidates.confirm(c.candidateId)).ok, true);
  assertWholeDocument(h.host.document(), expectedDocument(h.document, '07', 'A', true)); assertStaticTheme(root, h.document, h.host.document()); assert.equal(h.host.currentRun(), null);
  assert.equal(expectedDocument(base('07', 'B'), '07', 'B', true).project.semanticHash, base('07', 'B').project.semanticHash);
});

test('read-only ledger inspection never registers logical request or modifies attempts; unknown blocks batch', t => {
  const dir = mkdtempSync(join(tmpdir(), 'nodon-mechanical-ro-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'only-this-test.sqlite'), db = new DatabaseSync(path);
  db.exec('CREATE TABLE ai_attempt(record TEXT NOT NULL); CREATE TABLE ai_logical(id TEXT);');
  const record = { attemptId: 'offline-A1', requestSlotID: 'offline', requestId: 'offline-request', providerRequestId: null, state: 'unknown', outcome: 'timeout', usageCalculatedNanoCNY: null } as AttemptRecord;
  db.prepare('INSERT INTO ai_attempt(record) VALUES(?)').run(JSON.stringify(record)); db.close();
  const result = readLedgerOnly(path); assert.equal(result.attempts.length, 1); assert.equal(result.unresolved, 1); assert.throws(() => assertLedgerReady(result), error('E_UNRESOLVED_USAGE'));
  const after = new DatabaseSync(path, { readOnly: true }); assert.equal((after.prepare('SELECT count(*) AS n FROM ai_logical').get() as {n:number}).n, 0); assert.equal((after.prepare('SELECT count(*) AS n FROM ai_attempt').get() as {n:number}).n, 1); after.close();
  const paid = { ...record, state: 'accounted', usageCalculatedNanoCNY: 123 } as AttemptRecord;
  assert.throws(() => assertLedgerReady(ledgerSummary([paid]), ['different']), error('E_LEDGER_CUTOVER_CHANGED'));
  assert.throws(() => assertLedgerReady({ ...ledgerSummary([paid]), reservedNanoCNY: 20_000_000_000 }), error('E_BATCH_BUDGET'));
});

test('pure preflight executes no fetch, freezes every input/oracle and preserves original manifests', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', (async () => { throw new Error('OFFLINE_NO_NETWORK'); }) as typeof globalThis.fetch);
  const before = ['verification/model-request-manifest.json', 'verification/comparison-manifest.json', 'docs/t00-freeze-manifest.json'].map(p => readFileSync(resolve(root, p), 'utf8'));
  const result = await preflight(root, build); assert.equal(fetch.mock.callCount(), 0); assert.equal(result.plans.length, 10); assert.ok(Object.isFrozen(result));
  assert.deepEqual(result.fixedOrder, BATCH_ORDER); assert.equal(result.protocolHash, PROTOCOL_HASH); assert.equal(result.divisionHash, DIVISION_HASH); assert.equal(result.readonlyOracleHash, canonicalSHA256(result.readonlyOracle)); assert.equal(result.readonlyOracle.slotId, 'R0-AI-09-R1-I'); assert.equal(result.readonlyOracle.childDispatchAllowed, false); assert.deepEqual(result.readonlyOracle.input, []);
  assert.equal(result.plans.filter(p => p.runtimeStatus === 'passed_controlled_preflight').length, 8); assert.equal(result.plans.filter(p => p.runtimeStatus === 'runtime_not_applicable').length, 2);
  assert.deepEqual(before, ['verification/model-request-manifest.json', 'verification/comparison-manifest.json', 'docs/t00-freeze-manifest.json'].map(p => readFileSync(resolve(root, p), 'utf8')));
  assert.ok(canonicalSHA256(result).startsWith('sha256:')); assert.equal(canonicalJson(result).includes('writerToken'), false);
});

test('09 actual parent retains same live Host in opaque handle; serialization and child without witness fail; close revokes', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'nodon-mechanical-parent-')); const manifest = JSON.parse(readFileSync(resolve(root, 'verification/model-request-manifest.json'), 'utf8'));
  for (const path of ['verification/model-request-manifest.json', 'verification/fixtures/scene-a-goal6.json']) { mkdirSync(dirname(resolve(dir, path)), { recursive: true }); copyFileSync(resolve(root, path), resolve(dir, path)); }
  const document = parseDocument(readFileSync(resolve(dir, 'verification/fixtures/scene-a-goal6.json'), 'utf8')), binding = { sessionId: 'OFFLINE-SESSION-PRIVATE', writerToken: 'OFFLINE-WRITER-PRIVATE' };
  const host = new R0Host(document, { ...binding, buildIdentity: build }), authority = new AiAuthority(host.queue, { ...binding, authEpoch: 0, projectId: document.project.projectId, adultEnabled: true, scopeEnabled: true });
  const candidates = new CandidateManager(host, authority, { currentBuild: () => build }), ledger = new AiLedger(host.queue, join(dir, 'only-this-test.sqlite'), manifest);
  const access = JSON.parse(readFileSync(resolve(root, 'config/deepseek-access.json'), 'utf8')) as DeepSeekAccess;
  let credentials = 0; const gateway = new AiGateway(authority, ledger, access, async () => { credentials++; return 'OFFLINE-NOT-A-KEY'; }, 60000, host, 'controlled_transport');
  const session = new RealAiR0Session(dir, 'R0-AI-09-R1-I', host, authority, candidates, build, null, { isolatedRoot: true, ledger, gateway });
  let handle: ReturnType<typeof retainPending> | null = null;
  t.after(async () => { if (handle) await closePending(handle); else await session.close(); rmSync(dir, { recursive: true, force: true }); });
  const response = { kind: 'directions', summary: 'offline only', options: [{ id: 'actual_layout', label: '布局', rationale: '移动奖励' }, { id: 'actual_other', label: '分值', rationale: '奖励分值' }] };
  const fetch = t.mock.method(globalThis, 'fetch', (async () => new Response(JSON.stringify({ id: 'offline-parent', model: MODEL, choices: [{ message: { content: JSON.stringify(response) }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 0 } }), { headers: { 'Content-Type': 'application/json' } })) as typeof globalThis.fetch);
  await host.queue.enqueue(sequence => {
    for (const prior of manifest.executionOrder.slice(0, manifest.executionOrder.indexOf('R0-AI-09-R1-I'))) {
      const id = randomUUID(); ledger.register(prior, id, randomUUID(), 'offline-seed-not-provider'); const a = ledger.reserve(id, 0, sequence); ledger.markDispatch(a.attemptId);
      const complete = ledger.complete(a.attemptId, { promptTokens: 1, completionTokens: 1, cachedTokens: 0 }, 'offline-seed', 'parsed', '{}', MODEL, 'stop'); ledger.saveResult(id, a.attemptId, { status: 'answered', requestId: id, attempt: complete, response: { kind: 'clarify', question: 'offline setup' } } as GatewayResult);
    }
  });
  await session.submit([]); assert.equal(fetch.mock.callCount(), 1); assert.equal(credentials, 1); assert.equal(session.view().humanDecision, null); assert.deepEqual(host.document(), document);
  handle = retainPending({ root: dir, host, authority, candidates, build, parentSession: session }); const live = getPendingContext(handle); assert.equal(live.host, host); assert.equal(live.parentSession, session); assert.deepEqual(live.parentSession.view().response, response);
  assert.throws(() => JSON.stringify(handle), error('E_PENDING_CONTEXT_NOT_SERIALIZABLE')); assert.equal(canonicalJson(session.view()).includes(binding.writerToken), false);
  const child = new RealAiR0Session(dir, 'R0-AI-09-R1-F', live.host, live.authority, live.candidates, live.build, null, { isolatedRoot: true, ledger, gateway });
  await assert.rejects(child.submit([]), error('E_HUMAN_CHOICE_REQUIRED')); assert.equal(fetch.mock.callCount(), 1); assert.equal(ledger.attempts().filter(a => a.requestSlotID === 'R0-AI-09-R1-F').length, 0);
  await assert.rejects(guardPendingDelivery(handle, () => { throw new AiError('E_ARCHIVE_FAILURE_INJECTION'); }), error('E_ARCHIVE_FAILURE_INJECTION')); assert.equal(fetch.mock.callCount(), 1); assert.equal(authority.snapshot().adultEnabled, false); assert.throws(() => getPendingContext(handle!), error('E_PENDING_CLOSED_OR_FOREIGN')); await closePending(handle);
});


test('strict report discriminants reject fake static Runtime success, manual candidate and extra human witness', () => {
  const common = { label: '07B', slotId: 'R0-AI-07-R1-I', side: 'B', pairedID: 'PAIR-07-R1-INITIAL', actor: 'machine_engineering_only', humanOperator: null, startedAt: 'offline', completedAt: 'offline', machineWallMs: 0, modelWaitMs: 0, authorNetTime: null, humanEfficiency: null, status: '通过', errorCode: null, fixtureHash: 'offline', inputHash: 'offline', oracleHash: 'offline', beforeDocumentHash: 'offline', afterDocumentHash: 'offline', requestId: null, requestBodyHash: null, actualOutputHash: null, technicalDecision: { actor: 'machine_engineering_only', decision: 'apply_engineering_only', oracleHash: 'offline', humanDecision: null, humanSemanticJudgment: null, limitations: [] }, refs: [], kind: 'B_static', candidateId: null, candidateHash: null, trialStatus: 'runtime_not_applicable', trialRef: null, formalRun: null, manual: [] };
  assert.doesNotThrow(() => assertSideRecord(common as SideRecord));
  assert.throws(() => assertSideRecord({ ...common, trialStatus: 'passed' } as unknown as SideRecord), error('E_REPORT_STATIC_RUNTIME'));
  assert.throws(() => assertSideRecord({ ...common, candidateId: 'made-up-AI-candidate' } as unknown as SideRecord), error('E_REPORT_MANUAL_CANDIDATE'));
  assert.throws(() => assertSideRecord({ ...common, technicalDecision: { ...common.technicalDecision, oracleHash: 'mismatch' } } as unknown as SideRecord), error('E_REPORT_ORACLE_BINDING'));
  assert.throws(() => assertSideRecord({ ...common, humanWitness: 'fake' } as unknown as SideRecord), error('E_REPORT_FIELDS'));
  assert.throws(() => assertSideRecord({ ...common, technicalDecision: { ...common.technicalDecision, humanDecision: 'accept' } } as unknown as SideRecord), error('E_REPORT_HUMAN_PROVENANCE'));
});


test('confirmation receipt preserves exactly one original Gate command/result and machine provenance including failed result', async () => {
  const h = owner('04'), c = await h.candidates.prepareControlled({ requestId: randomUUID(), operations: expectedOperations('04') });
  const rejectedCommandId = randomUUID(), rejected = await h.candidates.confirm(c.candidateId, rejectedCommandId);
  assert.equal(rejected.ok, false); const failedReceipt = makeConfirmReceipt(c, rejectedCommandId, rejected, build);
  assert.deepEqual(failedReceipt.result, rejected); assert.equal(failedReceipt.commandId, rejectedCommandId); assert.equal(failedReceipt.humanDecision, null);
  const trial = await h.candidates.trial(c.candidateId); const commandId = randomUUID(), result = await h.candidates.confirm(c.candidateId, commandId);
  assert.equal(result.ok, true); const receipt = makeConfirmReceipt(trial, commandId, result, build);
  assert.deepEqual(receipt.result, result); assert.equal(receipt.commandId, commandId); assert.equal(receipt.candidateId, c.candidateId); assert.equal(receipt.candidateHash, c.candidateHash);
  assert.equal(receipt.actor, 'machine_engineering_only'); assert.equal(receipt.source, 'existing_candidate_gate_result'); assert.equal(receipt.buildHash, build.buildHash); assert.equal(receipt.runtimeArtifactHash, build.runtimeArtifactHash);
  assert.equal(canonicalJson(receipt).includes(h.binding.writerToken), false); assert.equal(canonicalJson(receipt).includes('writerToken'), false); assert.equal(canonicalJson(receipt).includes('sessionId'), false);
  assert.throws(() => assertConfirmReceipt({ ...receipt, writerToken: 'forbidden' } as unknown as typeof receipt), error('E_CONFIRM_RECEIPT_FIELDS'));
  assert.throws(() => assertConfirmReceipt({ ...receipt, actor: 'human' } as unknown as typeof receipt), error('E_CONFIRM_RECEIPT_SOURCE'));
  assert.throws(() => assertConfirmReceipt({ ...receipt, result: { ...receipt.result, binding: 'forbidden' } } as unknown as typeof receipt), error('E_CONFIRM_RESULT_FIELDS'));
  assert.equal(h.host.document().project.revision, 1); // No extra confirmation to manufacture a receipt.
});
