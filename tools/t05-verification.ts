import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AiAuthority } from '../src/ai/authority.js';
import { canonicalJson, parseDocument, type CommandResult, type ManualCommand, type Operation } from '../src/domain/index.js';
import { assertAuthorizedRoot, readRun } from '../src/evidence/run-evidence.js';
import { CommandQueue } from '../src/host/command-queue.js';
import { R0Host } from '../src/host/r0-host.js';
import { CandidateManager, type CandidateManagerOptions, type CandidateSnapshot } from '../src/trial/index.js';
import { createBuildIdentity, digest, persistBuildIdentity, type BuildIdentity } from './build-manifest.js';

// Execute only after strict compilation in the unique authorized tree. This is
// controlled machine evidence, independent of frozen AI/model case IDs.
const GOAL: Operation = { op: 'set_goal', expectedValue: 10, value: 6 };
const TIMER: Operation = { op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true, limit: 30 } };
const MOVE: Operation = { op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 } };
const THEME: Operation = { op: 'set_theme', expectedValue: { themeId: 'theme_snack', playerSkinId: 'snack_player_01' }, value: { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' } };
interface CatalogEntry { fixtureRef: string; setup: ManualCommand[]; operations: Operation[] }
const catalog: Record<string, CatalogEntry> = {
  'T05-REAL-GOAL6': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [], operations: [GOAL] },
  'T05-REAL-THEME': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [{ type: 'set_goal', value: 15 }], operations: [THEME] },
  'T05-REAL-SWAP': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [], operations: [
    { op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 780, y: 350 } },
    { op: 'move_entity', entityId: 'h2', expectedValue: { x: 780, y: 350 }, value: { x: 660, y: 190 } },
  ] },
  'T05-REAL-BAD-BATCH': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [], operations: [GOAL, { ...MOVE, value: { x: 540, y: 100 } }] },
  'T05-REAL-MISSING-H1': { fixtureRef: 'verification/fixtures/scene-b.json', setup: [], operations: [MOVE] },
  'T05-REAL-NO-REWARD': { fixtureRef: 'verification/fixtures/scene-b.json', setup: ['n1', 'n2', 'n3', 'n4', 'n5'].map(entityId => ({ type: 'remove_entity', entityId })),
    operations: [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }] },
  'T05-REAL-GOAL-REPAIR': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [{ type: 'set_goal', value: 15 }], operations: [{ op: 'set_goal', expectedValue: 15, value: 6 }, TIMER] },
  'T05-REAL-CANCEL-LATE': { fixtureRef: 'verification/fixtures/smoke-caught.json', setup: [], operations: [{ op: 'set_goal', expectedValue: 2, value: 1 }] },
  'T05-REAL-REVISION-LATE': { fixtureRef: 'verification/fixtures/smoke-caught.json', setup: [], operations: [{ op: 'set_goal', expectedValue: 2, value: 1 }] },
  'T05-REAL-AUTH-LATE': { fixtureRef: 'verification/fixtures/smoke-caught.json', setup: [], operations: [{ op: 'set_goal', expectedValue: 2, value: 1 }] },
  'T05-REAL-IDEMPOTENCY-UNDO': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [], operations: [GOAL, TIMER] },
  'T05-REAL-INJECT-INCOMPLETE': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [], operations: [GOAL] },
  'T05-REAL-INJECT-WRONG-TARGET': { fixtureRef: 'verification/fixtures/scene-a.json', setup: [], operations: [GOAL] },
  'T05-REAL-INJECT-RUNTIME-FAULT': { fixtureRef: 'verification/fixtures/smoke-caught.json', setup: [], operations: [{ op: 'set_goal', expectedValue: 2, value: 1 }] },
};

function accepted(result: CommandResult): Extract<CommandResult, { ok: true }> {
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}
function denied(result: CommandResult, code?: string): Extract<CommandResult, { ok: false }> {
  assert.equal(result.ok, false, JSON.stringify(result));
  if (result.ok) throw new Error('Unexpected write');
  if (code !== undefined) assert.equal(result.code, code);
  return result;
}
function runtimePassed(candidate: CandidateSnapshot, build: BuildIdentity, ticks?: number): void {
  assert.equal(candidate.state, 'proposed'); assert.equal(candidate.canConfirm, true);
  assert.equal(candidate.trialStatus, 'passed'); assert.equal(candidate.trialRequirement, 'runtime');
  assert.ok(candidate.trial?.run); const trial = candidate.trial; const run = trial.run!;
  assert.equal(trial.status, 'passed'); assert.equal(trial.buildHash, build.buildHash);
  assert.equal(trial.runtimeArtifactHash, build.runtimeArtifactHash); assert.equal(trial.environmentId, build.environmentId);
  assert.equal(trial.candidateHash, candidate.candidateHash); assert.equal(run.document.project.semanticHash, candidate.candidateSemanticHash);
  assert.equal(run.context.evidenceSource, 'machine_test'); assert.equal(run.context.inputSource, 'catalog_machine');
  assert.equal(run.context.executionClass, 'automation_test'); assert.equal(run.context.buildHash, build.buildHash);
  assert.equal(run.inputs.length, run.tick); assert.ok(run.tick > 0 && run.tick <= 180);
  assert.ok(run.inputs.every(input => input.committed && input.lastCommittedTick === input.tick));
  assert.equal(run.events.filter(event => event.kind === 'run_started').length, 1);
  assert.equal(run.diagnostics.length, 0); assert.equal(run.budgetExhausted, false);
  assert.ok(Object.values(trial.assertions).every(Boolean));
  if (ticks !== undefined) assert.equal(run.tick, ticks);
}
function barrier() {
  let release!: () => void; let reach!: () => void; let calls = 0;
  const released = new Promise<void>(resolvePromise => { release = resolvePromise; });
  const reached = new Promise<void>(resolvePromise => { reach = resolvePromise; });
  return { reached, release, yieldSlice: async (): Promise<void> => { if (++calls === 2) { reach(); await released; } } };
}
function localPath(root: string, path: string): string { return relative(root, path).split(sep).join('/'); }
function brief(candidate: CandidateSnapshot) {
  const { trial, ...rest } = candidate;
  return { ...rest, trial: trial === null ? null : { ...trial, run: trial.run === null ? null : {
    context: trial.run.context, tick: trial.run.tick, status: trial.run.status, score: trial.run.score,
    terminal: trial.run.terminal, diagnosticCount: trial.run.diagnostics.length, consumedInputs: trial.run.inputs.length,
    semanticHash: trial.run.document.project.semanticHash,
  } } };
}

async function main(): Promise<void> {
  const root = assertAuthorizedRoot();
  assert.equal(realpathSync(fileURLToPath(import.meta.url)), realpathSync(resolve(root, 'dist/tools/t05-verification.js')), 'E_UNAUTHORIZED_RUNNER_ROOT');
  const build = createBuildIdentity(root); persistBuildIdentity(build, root);
  const startedAt = new Date().toISOString();
  const privateValues: string[] = [];
  const results: Record<string, unknown>[] = [];
  const proofPaths: string[] = []; const runPaths: string[] = [];
  const noPrivate = (value: unknown): void => {
    const wire = JSON.stringify(value);
    for (const secret of privateValues) assert.equal(wire.includes(secret), false, 'Private host authority leaked');
    assert.equal(/"(?:writerToken|sessionId|authEpoch)"/.test(wire), false, 'Authority field leaked');
  };
  async function setup(caseId: string, options: Omit<CandidateManagerOptions, 'currentBuild'> = {}) {
    const entry = catalog[caseId]; assert.ok(entry);
    const source = parseDocument(readFileSync(resolve(root, entry.fixtureRef), 'utf8'));
    const sessionId = randomUUID(); const writerToken = randomUUID(); privateValues.push(sessionId, writerToken);
    const queue = new CommandQueue();
    const host = new R0Host(source, { sessionId, writerToken, queue, buildIdentity: build });
    const authority = new AiAuthority(queue, { authEpoch: 0, adultEnabled: true, scopeEnabled: true, sessionId, writerToken, projectId: source.project.projectId });
    const manager = new CandidateManager(host, authority, { ...options, currentBuild: () => structuredClone(build) });
    const execute = (command: ManualCommand): Promise<CommandResult> => host.execute({ commandId: randomUUID(), sessionId, writerToken,
      projectId: host.document().project.projectId, expectedRevision: host.document().project.revision, command });
    const setupReceipts: CommandResult[] = [];
    for (const command of entry.setup) setupReceipts.push(accepted(await execute(command)));
    return { host, authority, manager, execute, setupReceipts, entry,
      prepare: () => manager.prepareControlled({ requestId: randomUUID(), operations: structuredClone(entry.operations) }),
      submit: () => manager.submitControlled({ requestId: randomUUID(), operations: structuredClone(entry.operations) }) };
  }
  type Harness = Awaited<ReturnType<typeof setup>>;
  async function exportCandidate(h: Harness, candidate: CandidateSnapshot, caseId: string) {
    assert.ok(candidate.trial, 'No invented proof for a candidate without native trial record');
    const exported = await h.manager.exportTrial(candidate.candidateId, { root, fixtureRef: h.entry.fixtureRef,
      assertions: { caseId, operationRef: `tools/t05-verification.ts#catalog.${caseId}`, classification: 'controlled_fixture', modelUsed: false, humanInput: false } });
    const proof = JSON.parse(readFileSync(exported.proofPath, 'utf8')) as unknown; noPrivate(proof);
    proofPaths.push(localPath(root, exported.proofPath));
    if (exported.runPath !== null) {
      const pkg = readRun(exported.runPath, root);
      assert.equal(pkg.auditLevel, 'same_artifact_reconstruction');
      assert.equal(pkg.envelope.buildHash, build.buildHash); assert.equal(pkg.envelope.fixtureRef, h.entry.fixtureRef);
      assert.equal(pkg.envelope.evidenceSource, 'machine_test'); assert.equal(pkg.envelope.inputSource, 'catalog_machine');
      assert.equal(pkg.envelope.inputRef, 'verification/inputs/smoke.json');
      assert.deepEqual(pkg.snapshot, candidate.trial!.run); runPaths.push(localPath(root, exported.runPath));
    } else assert.equal(candidate.trialRequirement, 'static');
    return { proofRef: localPath(root, exported.proofPath), runRef: exported.runPath === null ? null : localPath(root, exported.runPath) };
  }
  async function check(caseId: string, body: () => Promise<Record<string, unknown>>, controls: unknown = null): Promise<void> {
    const entry = catalog[caseId]; assert.ok(entry);
    try {
      const observation = await body(); noPrivate(observation);
      results.push({ caseId, verificationOutcome: 'verified', fixtureRef: entry.fixtureRef,
        operationRef: `tools/t05-verification.ts#catalog.${caseId}`, controls, observation });
    } catch (error) {
      results.push({ caseId, verificationOutcome: 'failed', fixtureRef: entry.fixtureRef,
        operationRef: `tools/t05-verification.ts#catalog.${caseId}`, controls,
        error: error instanceof Error ? { name: error.name, message: error.message } : String(error) });
    }
  }

  await check('T05-REAL-GOAL6', async () => {
    const h = await setup('T05-REAL-GOAL6'); const before = h.host.document();
    const formal = await h.host.startRun(); const prepared = await h.prepare();
    assert.equal(prepared.canConfirm, false); assert.equal(prepared.trial, null);
    const candidate = await h.manager.trial(prepared.candidateId); runtimePassed(candidate, build, 180);
    assert.equal(candidate.trial!.run!.document.project.rules.goal.targetScore, 6);
    assert.deepEqual(h.host.currentRun(), formal); assert.deepEqual(h.host.document(), before);
    const exports = await exportCandidate(h, candidate, 'T05-REAL-GOAL6');
    const receipt = accepted(await h.manager.confirm(candidate.candidateId));
    assert.equal(h.host.document().project.revision, 1); assert.equal(h.host.document().project.rules.goal.targetScore, 6);
    return { candidate: brief(candidate), formalRunUnchanged: true, receipt, ...exports };
  });
  await check('T05-REAL-THEME', async () => {
    const h = await setup('T05-REAL-THEME'); const before = h.host.document(); assert.equal(h.host.inspect().playable, false);
    const candidate = await h.submit(); assert.equal(candidate.trialStatus, 'runtime_not_applicable');
    assert.equal(candidate.canConfirm, true); assert.equal(candidate.trial?.run, null); assert.equal(candidate.trialRef, null);
    const exports = await exportCandidate(h, candidate, 'T05-REAL-THEME');
    accepted(await h.manager.confirm(candidate.candidateId));
    assert.equal(h.host.document().project.semanticHash, before.project.semanticHash); assert.equal(h.host.currentRun(), null);
    assert.equal(h.host.inspect().playable, false);
    return { candidate: brief(candidate), setupReceipts: h.setupReceipts, after: h.host.document(), ...exports };
  });
  await check('T05-REAL-SWAP', async () => {
    const h = await setup('T05-REAL-SWAP'); const before = h.host.document(); const candidate = await h.submit(); runtimePassed(candidate, build);
    const scene = candidate.trial!.run!.document.project.scene;
    assert.deepEqual(scene.entities.find(entity => entity.id === 'h1'), { id: 'h1', kind: 'high', x: 780, y: 350 });
    assert.deepEqual(scene.entities.find(entity => entity.id === 'h2'), { id: 'h2', kind: 'high', x: 660, y: 190 });
    const exports = await exportCandidate(h, candidate, 'T05-REAL-SWAP'); accepted(await h.manager.confirm(candidate.candidateId));
    accepted(await h.execute({ type: 'undo' })); assert.deepEqual(h.host.document().project.scene, before.project.scene);
    return { candidate: brief(candidate), revisionAfterUndo: h.host.document().project.revision, ...exports };
  });
  for (const caseId of ['T05-REAL-BAD-BATCH', 'T05-REAL-MISSING-H1', 'T05-REAL-NO-REWARD']) await check(caseId, async () => {
    const h = await setup(caseId); const before = h.host.document(); const candidate = await h.submit();
    assert.equal(candidate.validation, 'invalid'); assert.equal(candidate.state, 'validation_blocked');
    assert.equal(candidate.canConfirm, false); assert.equal(candidate.trial, null); assert.equal(candidate.candidateHash, null);
    assert.equal(candidate.candidateState, null); assert.deepEqual(candidate.operations, []);
    if (caseId === 'T05-REAL-MISSING-H1') assert.ok(candidate.errors.some(error => error.code === 'E_ENTITY_NOT_FOUND'));
    if (caseId === 'T05-REAL-NO-REWARD') assert.ok(candidate.errors.some(error => error.code === 'E_NO_REWARD'));
    const receipt = denied(await h.manager.confirm(candidate.candidateId)); assert.deepEqual(h.host.document(), before);
    assert.equal(h.host.currentRun(), null);
    return { candidate, setupReceipts: h.setupReceipts, receipt, zeroCandidateWrites: true, before, after: h.host.document(), proofRef: null, runRef: null };
  });
  await check('T05-REAL-GOAL-REPAIR', async () => {
    const h = await setup('T05-REAL-GOAL-REPAIR'); assert.equal(h.host.inspect().playable, false);
    const candidate = await h.submit(); runtimePassed(candidate, build, 180);
    const exports = await exportCandidate(h, candidate, 'T05-REAL-GOAL-REPAIR'); accepted(await h.manager.confirm(candidate.candidateId));
    assert.equal(h.host.inspect().playable, true); assert.equal(h.host.document().project.rules.goal.targetScore, 6);
    assert.deepEqual(h.host.document().project.rules.timer, { enabled: true, limit: 30 });
    return { candidate: brief(candidate), setupReceipts: h.setupReceipts, after: h.host.document(), ...exports };
  });
  for (const change of ['CANCEL', 'REVISION', 'AUTH'] as const) {
    const caseId = `T05-REAL-${change}-LATE`;
    await check(caseId, async () => {
      const gate = barrier(); const h = await setup(caseId, { yieldSlice: gate.yieldSlice }); const before = h.host.document();
      const prepared = await h.prepare(); const task = h.manager.trial(prepared.candidateId);
      await gate.reached;
      const running = h.manager.candidate(prepared.candidateId);
      let late: CandidateSnapshot | undefined;
      try {
        assert.equal(running.trialStatus, 'running'); assert.equal(running.trial?.run?.tick, 3);
        denied(await h.manager.confirm(prepared.candidateId), 'E_CANDIDATE_NOT_READY');
        if (change === 'CANCEL') await h.manager.cancel(prepared.candidateId);
        if (change === 'REVISION') accepted(await h.execute({ type: 'set_text', field: 'title', value: 'T05 actual queued revision' }));
        if (change === 'AUTH') { await h.authority.setAdult(false); await h.authority.setAdult(true); }
      } finally { gate.release(); late = await task; }
      assert.ok(late);
      assert.equal(late.state, change === 'CANCEL' ? 'rejected' : change === 'REVISION' ? 'stale' : 'canceled');
      assert.equal(late.trialStatus, 'blocked'); assert.equal(late.canConfirm, false); assert.equal(late.trial?.run?.tick, 3);
      assert.equal(late.candidateState, null); assert.deepEqual(late.operations, []);
      const receipt = denied(await h.manager.confirm(prepared.candidateId));
      assert.equal(h.host.document().project.rules.goal.targetScore, before.project.rules.goal.targetScore);
      assert.equal(h.host.document().project.revision, change === 'REVISION' ? before.project.revision + 1 : before.project.revision);
      const exports = await exportCandidate(h, late, caseId);
      return { running: brief(running), late: brief(late), receipt, after: h.host.document(), ...exports };
    }, { classification: 'scheduler_control', releaseBarrier: 'after actual tick3, before result delivery', verificationHooks: null });
  }
  await check('T05-REAL-IDEMPOTENCY-UNDO', async () => {
    const h = await setup('T05-REAL-IDEMPOTENCY-UNDO'); const before = h.host.document(); const candidate = await h.submit(); runtimePassed(candidate, build, 180);
    const exports = await exportCandidate(h, candidate, 'T05-REAL-IDEMPOTENCY-UNDO'); const commandId = randomUUID();
    const first = h.manager.confirm(candidate.candidateId, commandId); const second = h.manager.confirm(candidate.candidateId, commandId);
    const receipt = accepted(await first); assert.deepEqual(await second, receipt); assert.equal(h.host.document().project.revision, 1);
    denied(await h.manager.confirm(candidate.candidateId), 'E_ALREADY_APPLIED');
    accepted(await h.execute({ type: 'undo' })); assert.deepEqual(h.host.document(), { ...before, project: { ...before.project, revision: 2 } });
    denied(await h.execute({ type: 'undo' }), 'E_NO_UNDO');
    assert.deepEqual(await h.manager.confirm(candidate.candidateId, commandId), receipt); assert.equal(h.host.document().project.revision, 2);
    return { candidate: brief(candidate), receipt, oneApplyRevision: 1, oneUndoRevision: 2, after: h.host.document(), ...exports };
  });
  const injections: Array<{ caseId: string; verification: NonNullable<CandidateManagerOptions['verification']>; expected: CandidateSnapshot['trialStatus'] }> = [
    { caseId: 'T05-REAL-INJECT-INCOMPLETE', verification: { tickCap: 15 }, expected: 'blocked' },
    { caseId: 'T05-REAL-INJECT-WRONG-TARGET', verification: { expectedTargetScore: 99 }, expected: 'failed' },
    { caseId: 'T05-REAL-INJECT-RUNTIME-FAULT', verification: { runtimeOptions: { failAfterEvents: 1, faultInjection: true } }, expected: 'failed' },
  ];
  for (const injection of injections) await check(injection.caseId, async () => {
    const h = await setup(injection.caseId, { verification: injection.verification }); const before = h.host.document(); const candidate = await h.submit();
    assert.equal(candidate.trialStatus, injection.expected); assert.equal(candidate.canConfirm, false);
    const receipt = denied(await h.manager.confirm(candidate.candidateId)); assert.deepEqual(h.host.document(), before);
    if (injection.caseId.endsWith('INCOMPLETE')) assert.equal(candidate.trial?.run?.tick, 15);
    if (injection.caseId.endsWith('WRONG-TARGET')) assert.equal(candidate.trial?.assertions.candidateLoaded, false);
    if (injection.caseId.endsWith('RUNTIME-FAULT')) { assert.equal(candidate.trial?.run?.status, 'fault'); assert.equal(candidate.trial?.assertions.noFault, false); }
    const exports = await exportCandidate(h, candidate, injection.caseId);
    return { candidate: brief(candidate), receipt, zeroCandidateWrites: true, ...exports };
  }, { classification: 'fault_injection', verificationHooks: injection.verification });

  const actual = createBuildIdentity(root);
  assert.equal(canonicalJson(actual), canonicalJson(build), 'Actual build changed during evidence execution');
  const summary = {
    suiteVersion: 'nodon-r0-t05-machine-suite@1', startedAt, completedAt: new Date().toISOString(),
    buildId: build.buildId, buildHash: build.buildHash, runtimeArtifactHash: build.runtimeArtifactHash, environmentId: build.environmentId,
    source: 'machine_test', candidateSource: 'controlled_fixture', inputSource: 'catalog_machine', executionClass: 'automation_test',
    modelUsed: false, humanInput: false, frozenAiCaseClaim: false,
    limits: ['Technical bounded candidate gate verification only', 'No route, difficulty, model-quality, or human-usability conclusion', '180 ticks cannot establish 15 second timeout'],
    runnerRef: { path: 'tools/t05-verification.ts', sha256: digest(readFileSync(resolve(root, 'tools/t05-verification.ts'))) },
    catalog: Object.fromEntries(Object.entries(catalog).map(([caseId, entry]) => [caseId, { ...entry, fixtureSha256: digest(readFileSync(resolve(root, entry.fixtureRef))) }])),
    proofRefs: proofPaths, runRefs: runPaths, results,
    verified: results.filter(result => result['verificationOutcome'] === 'verified').length,
    failed: results.filter(result => result['verificationOutcome'] === 'failed').length,
  };
  noPrivate(summary);
  const folder = resolve(root, 'evidence/r0', build.buildId, '06_candidates');
  for (let cursor = folder; cursor !== root; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new Error('E_EVIDENCE_SYMLINK');
    if (dirname(cursor) === cursor) throw new Error('E_EVIDENCE_PATH');
  }
  mkdirSync(folder, { recursive: true });
  const summaryPath = resolve(folder, 't05-machine-suite.json'); writeFileSync(summaryPath, JSON.stringify(summary, null, 2) + '\n');
  console.log(JSON.stringify({ buildId: build.buildId, summaryPath, verified: summary.verified, failed: summary.failed, nativeProofs: proofPaths.length, genuineRuns: runPaths.length }));
  if (summary.failed > 0) process.exitCode = 1;
}

await main();
