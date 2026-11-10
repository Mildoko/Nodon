import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import { AiAuthority, AiError } from '../src/ai/index.js';
import { assertDocument, canonicalJson, DomainError, parseDocument,
  type CandidateHashInput, type CommandResult, type Document, type ManualCommand, type Operation } from '../src/domain/index.js';
import { CommandQueue } from '../src/host/command-queue.js';
import { R0Host } from '../src/host/r0-host.js';
import { CandidateManager, type CandidateManagerOptions, type CandidateSnapshot } from '../src/trial/index.js';
import type { BuildIdentity } from '../tools/build-manifest.js';

// Independent GPT6.1SolHigh T05 verification against the frozen RT14–16,
// HASH02, CMD01 and CAND01 expectations. Every trial below executes the real
// RunSession/createRun/stepRun. Only build identity is SYNTHETIC unit context;
// these records must never be exported or claimed as actual build evidence.
// No provider, key, model, server or browser is read or started by this file.
interface Golden { hashInput: CandidateHashInput; canonicalUtf8: string; expectedCandidateHash: string;
  expectedBaseSemanticHash: string; expectedCandidateSemanticHash: string }
const golden = (JSON.parse(readFileSync(resolve(process.cwd(), 'verification/case-manifest.json'), 'utf8')) as { goldenCandidateVector: Golden }).goldenCandidateVector;
const SESSION = 'synthetic-t05-private-session';
const WRITER = 'synthetic-t05-private-writer';
const CONTRAST = { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' } as const;
const GOAL: Operation = { op: 'set_goal', expectedValue: 10, value: 6 };
const TIMER: Operation = { op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true, limit: 30 } };
const MOVE: Operation = { op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 } };
const THEME: Operation = { op: 'set_theme', expectedValue: { themeId: 'theme_snack', playerSkinId: 'snack_player_01' }, value: CONTRAST };
let serial = 0;
function id(): string { return `d5000000-0000-4000-8000-${(++serial).toString(16).padStart(12, '0')}`; }
function fixture(name = 'scene-a'): Document { return parseDocument(readFileSync(resolve(process.cwd(), `verification/fixtures/${name}.json`), 'utf8')); }
function syntheticBuild(): BuildIdentity {
  return { buildHash: 'sha256:' + '5'.repeat(64), runtimeArtifactHash: 'sha256:' + '6'.repeat(64),
    environmentId: 'synthetic-t05-unit-environment', buildId: 'synthetic-t05-unit-build',
    manifest: { contractHash: 'synthetic-t05-contract@2', trustedConfigHashes: { rules: 'synthetic-t05-rules@1' } },
    runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] }, productionPackagePaths: [] };
}
function setup(source = fixture(), options: Omit<CandidateManagerOptions, 'currentBuild'> = {}) {
  const queue = new CommandQueue(); let build = syntheticBuild();
  const host = new R0Host(source, { sessionId: SESSION, writerToken: WRITER, queue, buildIdentity: build });
  const authority = new AiAuthority(queue, { authEpoch: 0, adultEnabled: true, scopeEnabled: true,
    sessionId: SESSION, writerToken: WRITER, projectId: source.project.projectId });
  const manager = new CandidateManager(host, authority, { ...options, currentBuild: () => structuredClone(build) });
  return { queue, host, authority, manager, changeBuild(update: (value: BuildIdentity) => void): void { const next = structuredClone(build); update(next); build = next; } };
}
function command(host: R0Host, value: ManualCommand, commandId = id()) {
  const project = host.document().project;
  return { commandId, sessionId: SESSION, writerToken: WRITER, projectId: project.projectId, expectedRevision: project.revision, command: value };
}
function accepted(result: CommandResult): Extract<CommandResult, { ok: true }> { assert.equal(result.ok, true, JSON.stringify(result)); return result; }
function denied(result: CommandResult, expected?: string): void { assert.equal(result.ok, false, JSON.stringify(result)); if (result.ok) assert.fail('unexpected write'); if (expected) assert.equal(result.code, expected); }
async function commit(host: R0Host, value: ManualCommand): Promise<void> { accepted(await host.execute(command(host, value))); }
function pending(candidate: CandidateSnapshot): void {
  assert.equal(candidate.state, 'validation_pending'); assert.equal(candidate.validation, 'static_valid');
  assert.equal(candidate.trialStatus, 'not_run'); assert.equal(candidate.canTrial, true); assert.equal(candidate.canConfirm, false);
  assert.equal(candidate.trial, null); assert.equal(candidate.trialRef, null);
}
function blocked(candidate: CandidateSnapshot, expected?: string): void {
  assert.equal(candidate.state, 'validation_blocked'); assert.equal(candidate.canConfirm, false);
  assert.ok(candidate.errors.length > 0); if (expected) assert.ok(candidate.errors.some(error => error.code === expected), JSON.stringify(candidate.errors));
}
function passed(candidate: CandidateSnapshot): NonNullable<NonNullable<CandidateSnapshot['trial']>['run']> {
  assert.equal(candidate.state, 'proposed'); assert.equal(candidate.trialStatus, 'passed'); assert.equal(candidate.canConfirm, true);
  assert.equal(candidate.trialRequirement, 'runtime'); assert.ok(candidate.trial); assert.ok(candidate.trial.run); const trial = candidate.trial; const run = trial.run!;
  assert.equal(trial.status, 'passed'); assert.equal(trial.trialId, run.context.runId); assert.equal(candidate.trialRef, run.context.runId);
  assert.equal(trial.candidateHash, candidate.candidateHash); assert.equal(trial.candidateSemanticHash, candidate.candidateSemanticHash);
  assert.equal(run.document.project.revision, candidate.baseRevision); assert.equal(run.document.project.semanticHash, candidate.candidateSemanticHash);
  assert.deepEqual({ scene: run.document.project.scene, rules: run.document.project.rules, presentation: run.document.project.presentation }, candidate.candidateState);
  assert.deepEqual(trial.assertions, { candidateLoaded: true, runStarted: true, committedTick: true, eventIdentity: true, noFault: true });
  assert.equal(run.context.executionClass, 'automation_test'); assert.equal(run.context.inputSource, 'catalog_machine');
  assert.ok(run.tick >= 1 && run.tick <= 180); assert.equal(run.diagnostics.length, 0); assert.equal(run.budgetExhausted, false);
  assert.equal(run.events.filter(event => event.kind === 'run_started').length, 1);
  assert.equal(run.inputs.length, run.tick); assert.equal(run.inputs.every(input => input.committed), true);
  for (const input of run.inputs) {
    const expected = input.tick <= 30 ? { x: 0, y: 0 } : input.tick <= 90 ? { x: 1, y: 0 } : input.tick <= 150 ? { x: 0, y: 1 } : { x: -1, y: 0 };
    assert.deepEqual(input.direction, expected); assert.equal(input.lastCommittedTick, input.tick);
  }
  for (const event of run.events) {
    assert.equal(event.runId, run.context.runId); assert.equal(event.projectId, run.document.project.projectId);
    assert.equal(event.revision, candidate.baseRevision); assert.equal(event.semanticHash, candidate.candidateSemanticHash);
    assert.equal(event.observationPhase, ['run_started', 'chase_started', 'chase_stopped'].includes(event.kind) ? 'before_move' : 'after_move');
    if (event.kind === 'chase_started' || event.kind === 'chase_stopped') assert.equal(event.ruleId, 'rule.guard.chase@1');
    if (event.kind === 'reward_collected' || event.kind === 'score_changed') assert.equal(event.ruleId, 'rule.reward.collect@1');
    if (event.kind === 'goal_checked') assert.equal(event.ruleId, 'rule.goal.score@1');
  }
  assert.ok(trial.coverage.uncovered.includes('No route or difficulty conclusion'));
  assert.ok(trial.coverage.uncovered.includes('180 ticks cannot establish 15 second timeout'));
  return run;
}
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
function barrier(at: number) {
  const reached = deferred(); const released = deferred(); let calls = 0;
  return { reached: reached.promise, release: released.release, yieldSlice: async (): Promise<void> => { if (++calls === at) { reached.release(); await released.promise; } }, calls: () => calls };
}

test('T05 / RT14: six gameplay ops and mixed batch freeze full candidates, execute real 180 tick smoke, leave formal run untouched', async t => {
  const cases: Array<{ name: string; ops: Operation[]; edit: (doc: Document) => void }> = [
    { name: 'goal', ops: [GOAL], edit: doc => { doc.project.rules.goal.targetScore = 6; } },
    { name: 'rewards', ops: [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }], edit: doc => { doc.project.rules.rewards = { normalValue: 2, highValue: 4 }; } },
    { name: 'speed', ops: [{ op: 'set_guard_speed', expectedValue: 100, value: 80 }], edit: doc => { doc.project.rules.guards.speed = 80; } },
    { name: 'detect', ops: [{ op: 'set_detect_radius', expectedValue: 180, value: 140 }], edit: doc => { doc.project.rules.guards.detectRadius = 140; } },
    { name: 'timer', ops: [TIMER], edit: doc => { doc.project.rules.timer = { enabled: true, limit: 30 }; } },
    { name: 'move', ops: [MOVE], edit: doc => { const h1 = doc.project.scene.entities.find(entity => entity.id === 'h1'); assert.ok(h1); h1.x = 540; h1.y = 220; } },
    { name: 'mixed', ops: [GOAL, { op: 'set_detect_radius', expectedValue: 180, value: 140 }], edit: doc => { doc.project.rules.goal.targetScore = 6; doc.project.rules.guards.detectRadius = 140; } },
  ];
  const runIds = new Set<string>();
  for (const entry of cases) await t.test(entry.name, async () => {
    const h = setup(); const before = h.host.document(); const formal = await h.host.startRun();
    const initial = await h.manager.prepareControlled({ requestId: id(), operations: entry.ops }); pending(initial);
    const candidate = await h.manager.trial(initial.candidateId); const run = passed(candidate);
    const expected = fixture(); entry.edit(expected); const normalized = assertDocument(expected);
    assert.deepEqual(run.document, normalized); assert.equal(run.tick, 180); assert.equal(runIds.has(run.context.runId), false); runIds.add(run.context.runId);
    assert.notEqual(run.context.runId, formal.context.runId); assert.deepEqual(h.host.currentRun(), formal); assert.deepEqual(h.host.history(), []); assert.deepEqual(h.host.document(), before);
    assert.deepEqual(candidate.operations, entry.ops); assert.equal(candidate.source, 'controlled_fixture');
    const started = run.events[0]; assert.ok(started && started.kind === 'run_started');
    assert.equal(started.actualValues.targetScore, normalized.project.rules.goal.targetScore);
  });
});

test('T05 / RT14 CAND01: pure theme can apply to an unplayable draft with no invented run and unchanged gameplay hash', async () => {
  const draft = fixture(); draft.project.rules.goal.targetScore = 15; const h = setup(draft); const before = h.host.document();
  assert.equal(h.host.inspect().playable, false);
  const candidate = await h.manager.submitControlled({ requestId: id(), operations: [THEME] });
  assert.equal(candidate.state, 'proposed'); assert.equal(candidate.canConfirm, true); assert.equal(candidate.trialRequirement, 'static');
  assert.equal(candidate.trialStatus, 'runtime_not_applicable'); assert.equal(candidate.trialRef, null); assert.ok(candidate.trial);
  assert.equal(candidate.trial.trialId, null); assert.equal(candidate.trial.run, null); assert.equal(candidate.trial.status, 'runtime_not_applicable');
  assert.equal(candidate.candidateSemanticHash, before.project.semanticHash); assert.equal(h.host.currentRun(), null);
  accepted(await h.manager.confirm(candidate.candidateId)); assert.equal(h.host.document().project.revision, 1);
  assert.deepEqual(h.host.document().project.presentation, CONTRAST); assert.equal(h.host.document().project.semanticHash, before.project.semanticHash);
  assert.equal(h.host.inspect().playable, false); assert.equal(h.host.currentRun(), null);
  await commit(h.host, { type: 'undo' }); assert.deepEqual(h.host.document(), { ...before, project: { ...before.project, revision: 2 } });
});

test('T05 / HASH02: real gate reproduces the independent frozen bytes and literal digest', async () => {
  assert.equal('sha256:' + createHash('sha256').update(golden.canonicalUtf8, 'utf8').digest('hex'), 'sha256:560da260f37a0fa316b6884b5676146a8d4e2890e9fb0f24e755b99ffb5f8b5e');
  assert.equal(golden.expectedCandidateHash, 'sha256:560da260f37a0fa316b6884b5676146a8d4e2890e9fb0f24e755b99ffb5f8b5e');
  const h = setup(); const c = await h.manager.prepareControlled({ requestId: golden.hashInput.requestId, operations: golden.hashInput.operations });
  pending(c); assert.equal(c.baseSemanticHash, golden.expectedBaseSemanticHash); assert.equal(c.candidateHash, golden.expectedCandidateHash);
  assert.equal(c.candidateSemanticHash, golden.expectedCandidateSemanticHash);
  const actualInput: CandidateHashInput = { projectId: h.host.document().project.projectId, requestId: c.requestId, baseRevision: c.baseRevision,
    baseSemanticHash: c.baseSemanticHash, runtimeVersion: h.host.document().runtimeVersion, catalogVersion: h.host.document().catalogVersion,
    ruleRegistryVersion: 'collect-chase-rules@1', trialPolicyVersion: 'collect-chase-candidate-trial@2', operations: c.operations, candidateState: c.candidateState! };
  actualInput.candidateState.scene.entities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  assert.equal(canonicalJson(actualInput), golden.canonicalUtf8);
  const reversed = await setup().manager.prepareControlled({ requestId: golden.hashInput.requestId, operations: [...golden.hashInput.operations].reverse() });
  assert.notEqual(reversed.candidateHash, c.candidateHash); assert.equal(reversed.candidateSemanticHash, c.candidateSemanticHash);
  const reverseEntities = fixture(); reverseEntities.project.scene.entities.reverse();
  const reordered = await setup(reverseEntities).manager.prepareControlled({ requestId: golden.hashInput.requestId, operations: golden.hashInput.operations });
  assert.equal(reordered.candidateHash, c.candidateHash);
  const changedRequest = await setup().manager.prepareControlled({ requestId: id(), operations: golden.hashInput.operations }); assert.notEqual(changedRequest.candidateHash, c.candidateHash);
  const laterRevision = setup(); await commit(laterRevision.host, { type: 'set_text', field: 'title', value: 'same semantics, revision one' });
  const later = await laterRevision.manager.prepareControlled({ requestId: golden.hashInput.requestId, operations: golden.hashInput.operations });
  assert.equal(later.baseRevision, 1); assert.equal(later.baseSemanticHash, c.baseSemanticHash);
  assert.notEqual(later.candidateHash, c.candidateHash); assert.equal(later.candidateSemanticHash, c.candidateSemanticHash);
  const themeBase = fixture(); themeBase.project.presentation = CONTRAST;
  const theme = await setup(themeBase).manager.prepareControlled({ requestId: golden.hashInput.requestId, operations: golden.hashInput.operations });
  assert.notEqual(theme.candidateHash, c.candidateHash); assert.equal(theme.candidateSemanticHash, c.candidateSemanticHash);
});

test('T05 / CMD01: bad second op is atomic; occupied destination never retargets; final two-object swap is legal', async () => {
  const h = setup(); const before = h.host.document();
  const bad = await h.manager.prepareControlled({ requestId: id(), operations: [GOAL, { ...MOVE, value: { x: 540, y: 100 } }] });
  blocked(bad); assert.equal(bad.candidateHash, null); assert.equal(bad.candidateState, null); assert.deepEqual(bad.operations, []);
  denied(await h.manager.confirm(bad.candidateId)); assert.deepEqual(h.host.document(), before);
  await commit(h.host, { type: 'add_entity', kind: 'normal', x: 540, y: 220 }); const occupied = h.host.document();
  const badOccupied = await h.manager.prepareControlled({ requestId: id(), operations: [MOVE] }); blocked(badOccupied);
  assert.deepEqual(h.host.document(), occupied); assert.equal(occupied.project.scene.entities.find(entity => entity.id === 'e1')?.x, 540);
  const s = setup(); const swaps: Operation[] = [
    { op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 780, y: 350 } },
    { op: 'move_entity', entityId: 'h2', expectedValue: { x: 780, y: 350 }, value: { x: 660, y: 190 } },
  ];
  const swapped = await s.manager.submitControlled({ requestId: id(), operations: swaps }); const run = passed(swapped);
  assert.deepEqual(run.document.project.scene.entities.find(entity => entity.id === 'h1'), { id: 'h1', kind: 'high', x: 780, y: 350 });
  assert.deepEqual(run.document.project.scene.entities.find(entity => entity.id === 'h2'), { id: 'h2', kind: 'high', x: 660, y: 190 });
  accepted(await s.manager.confirm(swapped.candidateId)); assert.equal(s.host.document().project.revision, 1); await commit(s.host, { type: 'undo' });
  assert.deepEqual(s.host.document().project.scene, fixture().project.scene); denied(await s.host.execute(command(s.host, { type: 'undo' })), 'E_NO_UNDO');
});

test('T05 / CMD01: sequential expected values, whole-batch no-change and 1–3 strict DTO limits', async () => {
  const h = setup();
  const valid = await h.manager.submitControlled({ requestId: id(), operations: [{ op: 'set_goal', expectedValue: 10, value: 8 }, { op: 'set_goal', expectedValue: 8, value: 6 }] });
  assert.equal(passed(valid).document.project.rules.goal.targetScore, 6);
  const cases: unknown[] = [[], [GOAL, { op: 'set_goal', expectedValue: 10, value: 8 }], [GOAL, { op: 'set_goal', expectedValue: 6, value: 10 }],
    [GOAL, GOAL, GOAL, GOAL], [{ ...GOAL, passed: true }], [{ op: 'add_entity', kind: 'normal', x: 20, y: 20 }],
    [{ op: 'copy_entity', entityId: 'n1', x: 20, y: 20 }], [{ op: 'remove_entity', entityId: 'n1' }]];
  for (const operations of cases) {
    const base = h.host.document(); const c = await h.manager.prepareControlled({ requestId: id(), operations: operations as Operation[] });
    blocked(c); denied(await h.manager.confirm(c.candidateId)); assert.deepEqual(h.host.document(), base);
  }
  await assert.rejects(h.manager.prepareControlled({ requestId: id() + '\n', operations: [GOAL] }), AiError);
  await assert.rejects(h.manager.prepareControlled({ requestId: id(), operations: [GOAL], passed: true } as unknown as Parameters<CandidateManager['prepareControlled']>[0]), AiError);
  const requestId = id(); await h.manager.prepareControlled({ requestId, operations: [GOAL] });
  await assert.rejects(h.manager.prepareControlled({ requestId, operations: [GOAL] }), error => error instanceof AiError && error.code === 'E_REQUEST_DUPLICATE');
});

test('T05 / CAND01: missing categories and untouched unplayability block; full goal plus timer repair trials once', async t => {
  const noRewards = fixture(); noRewards.project.scene.entities = noRewards.project.scene.entities.filter(entity => entity.kind === 'player' || entity.kind === 'guard');
  const cases: Array<[Document, Operation[], string | undefined]> = [
    [fixture('scene-b'), [{ op: 'set_guard_speed', expectedValue: 100, value: 80 }], 'E_NO_GUARD'],
    [fixture('scene-b'), [{ op: 'set_detect_radius', expectedValue: 180, value: 140 }], 'E_NO_GUARD'],
    [fixture('scene-b'), [MOVE], 'E_ENTITY_NOT_FOUND'],
    [noRewards, [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }], 'E_NO_REWARD'],
  ];
  const impossible = fixture(); impossible.project.rules.goal.targetScore = 15;
  cases.push([impossible, [TIMER], undefined], [impossible, [MOVE], undefined], [impossible, [THEME, TIMER], undefined]);
  const empty = structuredClone(noRewards); empty.project.rules.goal.targetScore = 1; cases.push([empty, [{ op: 'set_goal', expectedValue: 1, value: 1 }], undefined]);
  for (const [source, operations, code] of cases) await t.test(code ?? operations.map(op => op.op).join('+'), async () => {
    const h = setup(source); const before = h.host.document(); const candidate = await h.manager.submitControlled({ requestId: id(), operations });
    blocked(candidate, code); assert.equal(candidate.trial, null); denied(await h.manager.confirm(candidate.candidateId)); assert.deepEqual(h.host.document(), before);
  });
  const h = setup(impossible); const repaired = await h.manager.submitControlled({ requestId: id(), operations: [{ op: 'set_goal', expectedValue: 15, value: 6 }, TIMER] });
  const run = passed(repaired); assert.equal(run.document.project.rules.goal.targetScore, 6); assert.deepEqual(run.document.project.rules.timer, { enabled: true, limit: 30 });
  accepted(await h.manager.confirm(repaired.candidateId)); assert.equal(h.host.document().project.revision, 1); assert.equal(h.host.inspect().playable, true);
});

test('T05 / RT16: legal caught terminal at tick3 is technical pass, with real events and explicit missing coverage', async () => {
  const h = setup(fixture('smoke-caught')); const c = await h.manager.submitControlled({ requestId: id(), operations: [{ op: 'set_goal', expectedValue: 2, value: 1 }] }); const run = passed(c);
  assert.equal(run.tick, 3); assert.equal(run.score, 0); assert.equal(run.terminal?.reason, 'caught');
  assert.equal(run.events.filter(event => event.kind === 'round_ended').length, 1);
  assert.equal(run.events.find(event => event.kind === 'round_ended')?.tick, 3);
  assert.equal(run.events.some(event => event.kind === 'reward_collected'), false); assert.equal(c.trial?.coverage.rewardCollected, false);
  assert.equal(c.trial?.coverage.chaseObserved, true); assert.ok(c.missingCoverage.includes('reward collection not observed'));
  assert.equal(run.events.some(event => event.kind === 'round_ended' && event.actualValues.reason === 'timeout'), false);
  assert.ok(Math.abs(run.positions['g1']!.x - 45) < 1e-10); accepted(await h.manager.confirm(c.candidateId));
});

test('T05 / RT16: not_run, blocked, wrong-loaded assertion and genuine Runtime fault cannot grant confirmation', async t => {
  const cases: Array<{ name: string; verification: NonNullable<CandidateManagerOptions['verification']>; status: CandidateSnapshot['trialStatus'] }> = [
    { name: 'no-executor', verification: { executorAvailable: false }, status: 'not_run' },
    { name: 'cap-zero', verification: { tickCap: 0 }, status: 'blocked' },
    { name: 'cap-incomplete', verification: { tickCap: 15 }, status: 'blocked' },
    { name: 'wrong-loaded-target', verification: { expectedTargetScore: 99 }, status: 'failed' },
    { name: 'runtime-fault', verification: { runtimeOptions: { failAfterEvents: 1, faultInjection: true } }, status: 'failed' },
  ];
  for (const probe of cases) await t.test(probe.name, async () => {
    const source = probe.name === 'runtime-fault' ? fixture('smoke-caught') : fixture(); const h = setup(source, { verification: probe.verification }); const before = h.host.document();
    const c = await h.manager.submitControlled({ requestId: id(), operations: [{ op: 'set_goal', expectedValue: source.project.rules.goal.targetScore, value: 1 }] });
    assert.equal(c.trialStatus, probe.status); assert.equal(c.canConfirm, false); assert.notEqual(c.state, 'proposed'); denied(await h.manager.confirm(c.candidateId)); assert.deepEqual(h.host.document(), before);
    if (probe.name === 'no-executor' || probe.name === 'cap-zero') assert.equal(c.trial, null);
    if (probe.name === 'wrong-loaded-target') { assert.ok(c.trial!.run!.tick >= 1 && c.trial!.run!.tick <= 180); assert.equal(c.trial?.assertions.candidateLoaded, false); assert.equal(c.trial?.assertions.noFault, true); }
    if (probe.name === 'runtime-fault') { assert.equal(c.trial?.run?.status, 'fault'); assert.ok(c.trial!.run!.diagnostics.length > 0); assert.equal(c.trial?.assertions.noFault, false); }
  });
});

test('T05 / RT15: running and late-result candidates lose writes on cancel, edit, project/writer/AI/scope revocation', async t => {
  // smoke-caught reaches its final result-release barrier on yield2, after real tick3.
  for (const change of ['cancel', 'revision', 'project', 'writer', 'adult', 'scope', 'revoke'] as const) await t.test(change, async () => {
    const gate = barrier(2); const h = setup(fixture('smoke-caught'), { yieldSlice: gate.yieldSlice }); const before = h.host.document();
    const prepared = await h.manager.prepareControlled({ requestId: id(), operations: [{ op: 'set_goal', expectedValue: 2, value: 1 }] });
    const trial = h.manager.trial(prepared.candidateId); await gate.reached;
    const running = h.manager.candidate(prepared.candidateId); assert.equal(running.trialStatus, 'running'); assert.equal(running.trial?.run?.tick, 3); assert.equal(running.canConfirm, false);
    denied(await h.manager.confirm(prepared.candidateId), 'E_CANDIDATE_NOT_READY');
    if (change === 'cancel') await h.manager.cancel(prepared.candidateId);
    if (change === 'revision') await commit(h.host, { type: 'set_text', field: 'title', value: 'manual title during trial' });
    if (change === 'project') await h.authority.replaceWriter(SESSION, WRITER, 'different-project');
    if (change === 'writer') await h.authority.replaceWriter('different-session', 'different-writer', before.project.projectId);
    if (change === 'adult') { await h.authority.setAdult(false); await h.authority.setAdult(true); }
    if (change === 'scope') { await h.authority.setScope(false); await h.authority.setScope(true); }
    if (change === 'revoke') await h.manager.revoke('synthetic-test-revoke');
    gate.release(); const late = await trial;
    assert.equal(late.state, change === 'cancel' ? 'rejected' : change === 'revision' ? 'stale' : 'canceled');
    assert.equal(late.trialStatus, 'blocked'); assert.equal(late.trial?.status, 'blocked'); assert.equal(late.trial?.run?.tick, 3);
    assert.deepEqual(late.operations, []); assert.equal(late.candidateState, null); assert.equal(late.canConfirm, false);
    denied(await h.manager.confirm(prepared.candidateId)); assert.equal(h.host.document().project.rules.goal.targetScore, 2);
    assert.equal(h.host.document().project.revision, change === 'revision' ? 1 : 0);
  });
});

test('T05 / RT15: first-slice cancellation does not execute more ticks; newer candidate never revives older results', async () => {
  const gate = barrier(2); const h = setup(fixture(), { yieldSlice: gate.yieldSlice });
  const c = await h.manager.prepareControlled({ requestId: id(), operations: [GOAL] }); const task = h.manager.trial(c.candidateId); await gate.reached;
  assert.equal(h.manager.candidate(c.candidateId).trial?.run?.tick, 15);
  const next = await h.manager.prepareControlled({ requestId: id(), operations: [THEME] }); assert.equal(next.canConfirm, true);
  gate.release(); const canceled = await task; assert.equal(canceled.state, 'canceled'); assert.equal(canceled.trialStatus, 'blocked'); assert.equal(canceled.trial?.run?.tick, 15);
  assert.equal(h.manager.snapshot()?.candidateId, next.candidateId); denied(await h.manager.confirm(c.candidateId));
  accepted(await h.manager.confirm(next.candidateId)); assert.equal(h.host.document().project.rules.goal.targetScore, 10);
});

test('T05 / RT15: every revision stales passed candidate, including title/theme/undo returning identical semantic hash', async t => {
  for (const change of ['title', 'theme', 'goal-and-undo'] as const) await t.test(change, async () => {
    const h = setup(); const c = await h.manager.submitControlled({ requestId: id(), operations: [GOAL] }); passed(c); const baseHash = c.baseSemanticHash;
    if (change === 'title') await commit(h.host, { type: 'set_text', field: 'title', value: 'new title' });
    if (change === 'theme') await commit(h.host, { type: 'set_theme', value: CONTRAST });
    if (change === 'goal-and-undo') { await commit(h.host, { type: 'set_goal', value: 8 }); await commit(h.host, { type: 'undo' }); }
    assert.equal(h.host.document().project.semanticHash, baseHash); const stale = h.manager.candidate(c.candidateId);
    assert.equal(stale.state, 'stale'); assert.equal(stale.canConfirm, false); assert.deepEqual(stale.operations, []); assert.equal(stale.candidateState, null);
    const before = h.host.document(); denied(await h.manager.confirm(c.candidateId), 'E_REVISION_CONFLICT'); assert.deepEqual(h.host.document(), before);
  });
});

test('T05 / HASH02 RT15: same candidate hash cannot reuse passed evidence after build/artifact/contract/config/environment changes', async t => {
  const variants: Array<[string, (build: BuildIdentity) => void]> = [
    ['build', b => { b.buildHash = 'sha256:' + '7'.repeat(64); }], ['artifact', b => { b.runtimeArtifactHash = 'sha256:' + '8'.repeat(64); }],
    ['contract', b => { b.manifest['contractHash'] = 'synthetic-other-contract@1'; }], ['config', b => { b.manifest['trustedConfigHashes'] = { rules: 'synthetic-other-rules' }; }],
    ['environment', b => { b.environmentId = 'synthetic-other-environment'; }],
  ];
  for (const [name, update] of variants) await t.test(name, async () => {
    const h = setup(); const c = await h.manager.submitControlled({ requestId: golden.hashInput.requestId, operations: golden.hashInput.operations }); passed(c); assert.equal(c.candidateHash, golden.expectedCandidateHash);
    h.changeBuild(update); const view = h.manager.candidate(c.candidateId); assert.equal(view.candidateHash, c.candidateHash);
    assert.equal(view.canConfirm, false); assert.equal(view.eligibilityError, 'E_BUILD_CHANGED'); assert.equal(view.state, 'proposed');
    denied(await h.manager.confirm(c.candidateId), 'E_BUILD_CHANGED'); assert.equal(h.host.document().project.revision, 0);
    const stale = h.manager.candidate(c.candidateId); assert.equal(stale.state, 'stale'); assert.deepEqual(stale.operations, []); assert.equal(stale.candidateState, null);
    h.changeBuild(b => Object.assign(b, syntheticBuild())); denied(await h.manager.confirm(c.candidateId), 'E_CANDIDATE_TERMINATED');
  });
  const h = setup(); h.changeBuild(b => { b.runtimeArtifactHash = 'sha256:' + '8'.repeat(64); });
  await assert.rejects(h.manager.prepareControlled({ requestId: id(), operations: [GOAL] }), error => error instanceof AiError && error.code === 'E_BUILD_CHANGED');
  assert.equal(h.host.document().project.revision, 0);
});

test('T05 / D09 RT15: confirm/close FIFO linearizes once; idempotency gives one revision and one complete undo', async () => {
  {
    const h = setup(); const c = await h.manager.submitControlled({ requestId: id(), operations: [GOAL] }); passed(c);
    const close = h.authority.setAdult(false); const confirm = h.manager.confirm(c.candidateId); await close;
    denied(await confirm, 'E_ADULT_DISABLED'); assert.equal(h.host.document().project.revision, 0);
    await h.authority.setAdult(true); denied(await h.manager.confirm(c.candidateId)); assert.equal(h.manager.candidate(c.candidateId).state, 'canceled');
  }
  {
    const h = setup(); const before = h.host.document(); const c = await h.manager.submitControlled({ requestId: id(), operations: [GOAL, TIMER] }); passed(c);
    const commandId = id(); const first = h.manager.confirm(c.candidateId, commandId); const duplicate = h.manager.confirm(c.candidateId, commandId); const close = h.authority.setAdult(false);
    const receipt = accepted(await first); assert.deepEqual(await duplicate, receipt); await close;
    assert.equal(h.host.document().project.revision, 1); assert.equal(h.manager.candidate(c.candidateId).state, 'applied');
    assert.equal(h.host.document().project.rules.goal.targetScore, 6); assert.deepEqual(h.host.document().project.rules.timer, { enabled: true, limit: 30 });
    denied(await h.manager.confirm(c.candidateId, id()), 'E_ALREADY_APPLIED'); assert.deepEqual(await h.manager.confirm(c.candidateId, commandId), receipt);
    await commit(h.host, { type: 'undo' }); assert.deepEqual(h.host.document(), { ...before, project: { ...before.project, revision: 2 } });
    denied(await h.host.execute(command(h.host, { type: 'undo' })), 'E_NO_UNDO'); assert.equal(h.host.document().project.revision, 2);
    assert.deepEqual(await h.manager.confirm(c.candidateId, commandId), receipt); assert.equal(h.host.document().project.revision, 2);
  }
});

test('T05 / D04 D09: one session commandId cannot cross manual and candidate command kinds', async t => {
  await t.test('successful manual command owns its ID before candidate confirmation', async () => {
    const h = setup(); const sharedId = id();
    accepted(await h.host.execute(command(h.host, { type: 'set_text', field: 'title', value: 'manual owns shared ID' }, sharedId)));
    const candidate = await h.manager.submitControlled({ requestId: id(), operations: [GOAL] }); passed(candidate);
    const before = h.host.document(); denied(await h.manager.confirm(candidate.candidateId, sharedId), 'E_IDEMPOTENCY_CONFLICT');
    assert.deepEqual(h.host.document(), before); assert.equal(before.project.revision, 1);
    accepted(await h.manager.confirm(candidate.candidateId, id())); assert.equal(h.host.document().project.revision, 2);
  });
  await t.test('successful candidate confirmation owns its ID before manual command', async () => {
    const h = setup(); const sharedId = id(); const original = h.host.document();
    const candidate = await h.manager.submitControlled({ requestId: id(), operations: [GOAL, TIMER] }); passed(candidate);
    const receipt = accepted(await h.manager.confirm(candidate.candidateId, sharedId)); const before = h.host.document();
    denied(await h.host.execute(command(h.host, { type: 'set_text', field: 'title', value: 'must not apply' }, sharedId)), 'E_IDEMPOTENCY_CONFLICT');
    assert.deepEqual(h.host.document(), before); assert.deepEqual(await h.manager.confirm(candidate.candidateId, sharedId), receipt);
    assert.equal(h.host.document().project.revision, 1); await commit(h.host, { type: 'undo' });
    assert.deepEqual(h.host.document(), { ...original, project: { ...original.project, revision: 2 } });
    denied(await h.host.execute(command(h.host, { type: 'undo' })), 'E_NO_UNDO');
  });
  await t.test('Store-cached unsuccessful manual command still owns its accepted ID', async () => {
    const h = setup(); const sharedId = id(); const noChange = command(h.host, { type: 'set_goal', value: 10 }, sharedId);
    const failed = await h.host.execute(noChange); denied(failed, 'E_NO_CHANGE'); assert.deepEqual(await h.host.execute(noChange), failed);
    const candidate = await h.manager.submitControlled({ requestId: id(), operations: [GOAL] }); passed(candidate);
    const before = h.host.document(); denied(await h.manager.confirm(candidate.candidateId, sharedId), 'E_IDEMPOTENCY_CONFLICT'); assert.deepEqual(h.host.document(), before);
    accepted(await h.manager.confirm(candidate.candidateId, id())); assert.equal(h.host.document().project.revision, 1);
  });
  await t.test('malformed unaccepted manual envelope does not reserve an ID', async () => {
    const h = setup(); const sharedId = id(); const before = h.host.document();
    denied(await h.host.execute({ ...command(h.host, { type: 'set_goal', value: 6 }, sharedId), arbitraryClientField: true }), 'E_SCHEMA');
    assert.deepEqual(h.host.document(), before);
    const candidate = await h.manager.submitControlled({ requestId: id(), operations: [GOAL] }); passed(candidate);
    accepted(await h.manager.confirm(candidate.candidateId, sharedId)); assert.equal(h.host.document().project.revision, 1);
  });
  await t.test('unauthorized manual envelope cannot reserve an ID against the real writer', async () => {
    for (const field of ['sessionId', 'writerToken'] as const) {
      const h = setup(); const sharedId = id(); const before = h.host.document();
      const unauthorized = { ...command(h.host, { type: 'set_goal', value: 6 }, sharedId), [field]: 'synthetic-unauthorized-owner' };
      denied(await h.host.execute(unauthorized), field === 'sessionId' ? 'E_SESSION' : 'E_WRITER'); assert.deepEqual(h.host.document(), before);
      const candidate = await h.manager.submitControlled({ requestId: id(), operations: [GOAL] }); passed(candidate);
      accepted(await h.manager.confirm(candidate.candidateId, sharedId)); assert.equal(h.host.document().project.revision, 1);
    }
  });
});

test('T05 / D09: public JSON cannot forge Node opaque commit or mutate internal candidate/trial/binding', async () => {
  const h = setup(); const before = h.host.document(); const c = await h.manager.submitControlled({ requestId: id(), operations: [GOAL] }); passed(c);
  const wire = JSON.stringify(c); assert.equal(wire.includes(SESSION), false); assert.equal(wire.includes(WRITER), false);
  assert.equal(wire.includes('writerToken'), false); assert.equal(wire.includes('sessionId'), false); assert.equal(wire.includes('authEpoch'), false);
  const altered = structuredClone(c); altered.operations = [THEME]; altered.candidateState = null; altered.trialStatus = 'passed'; altered.trial!.trialPolicyVersion = 'collect-chase-candidate-trial@1' as 'collect-chase-candidate-trial@2';
  altered.trial!.assertions.candidateLoaded = false; altered.canConfirm = true;
  assert.deepEqual(h.manager.candidate(c.candidateId), c);
  for (const permit of [{}, JSON.parse(wire) as object, { candidateHash: c.candidateHash, passed: true, draft: before, baseRevision: 0 }]) {
    await assert.rejects(h.queue.enqueue(() => h.host.commitCandidate(permit)), error => error instanceof DomainError && error.code === 'E_CANDIDATE_PERMIT');
    assert.deepEqual(h.host.document(), before);
  }
  denied(await h.manager.confirm(c.candidateId, id() + '\n'), 'E_SCHEMA'); accepted(await h.manager.confirm(c.candidateId)); assert.equal(h.host.document().project.rules.goal.targetScore, 6);
});

test('T05 / D04: preview/failure/canceled candidates consume neither entity IDs, receipts nor prior undo', async () => {
  const h = setup(); await commit(h.host, { type: 'set_text', field: 'authorNote', value: 'preserve this undo' }); const before = h.host.document();
  const add = command(h.host, { type: 'add_entity', kind: 'normal', x: 20, y: 20 });
  const preview = accepted(await h.host.preview(add)); assert.equal(preview.allocatedEntityId, 'e1'); assert.equal(preview.revision, 2); assert.deepEqual(h.host.document(), before);
  const bad = await h.manager.prepareControlled({ requestId: id(), operations: [GOAL, { ...MOVE, value: { x: 540, y: 100 } }] }); blocked(bad);
  const pendingCandidate = await h.manager.prepareControlled({ requestId: id(), operations: [GOAL] }); await h.manager.cancel(pendingCandidate.candidateId);
  assert.deepEqual(h.host.document(), before); await commit(h.host, { type: 'undo' }); assert.equal(h.host.document().project.authorNote, '');
  assert.equal(accepted(await h.host.execute(command(h.host, { type: 'add_entity', kind: 'normal', x: 20, y: 20 }))).allocatedEntityId, 'e1');
  const fresh = setup(); const replayable = command(fresh.host, { type: 'add_entity', kind: 'normal', x: 20, y: 20 });
  accepted(await fresh.host.preview(replayable)); const receipt = accepted(await fresh.host.execute(replayable)); assert.equal(receipt.allocatedEntityId, 'e1'); assert.equal(fresh.host.document().project.revision, 1);
  assert.deepEqual(await fresh.host.execute(replayable), receipt); assert.equal(fresh.host.document().project.revision, 1);
});

test('T05 / D07: manager requires the identical authority queue and Store writer owner', () => {
  const h = setup(); const state = h.authority.snapshot();
  assert.throws(() => new CandidateManager(h.host, new AiAuthority(new CommandQueue(), state), { currentBuild: syntheticBuild }), error => error instanceof AiError && error.code === 'E_AUTHORITY_OWNER');
  assert.throws(() => new CandidateManager(h.host, new AiAuthority(h.queue, { ...state, writerToken: 'other-writer' }), { currentBuild: syntheticBuild }), error => error instanceof AiError && error.code === 'E_AUTHORITY_OWNER');
});
