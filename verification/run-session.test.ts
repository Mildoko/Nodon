import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument, type Document, type ManualCommand } from '../src/domain/index.js';
import { type Direction, type GameplayEvent, type RunContext, type RunOptions } from '../src/runtime/index.js';
import { CommandQueue } from '../src/host/command-queue.js';
import { RunSession, EventRing, observeEvents } from '../src/host/run-session.js';
import { R0Host } from '../src/host/r0-host.js';
import { compareRuns, normalizeEvents } from '../src/evidence/compare.js';
import type { BuildIdentity } from '../tools/build-manifest.js';

// Independent T03 expectations are frozen in verification/case-manifest.json
// RT08–10, RT13 and EVID01/02, and docs/r0-motion-evidence-adr.md §4.
// Every integrated session below executes the actual shared Runtime. Context
// hashes are visibly SYNTHETIC unit identifiers and never actual build evidence.
// Actual export/read/replay package identity is checked separately by the root
// CLI from the unique product root. No network/browser/provider starts here.
// T04 transport/focus/keyboard/visual history and T05 candidate qualification,
// AI stale/confirmation and trial lifecycle remain outside these unit claims.
const SESSION = 'd3000000-0000-4000-8000-000000000001';
const WRITER = 'd3000000-0000-4000-8000-000000000002';
const ZERO: Direction = { x: 0, y: 0 };
const RIGHT: Direction = { x: 1, y: 0 };
type Snapshot = ReturnType<RunSession['snapshot']>;
let serial = 0;
function fixture(name = 'scene-a'): Document {
  return parseDocument(readFileSync(resolve(process.cwd(), 'verification', 'fixtures', `${name}.json`), 'utf8'));
}
function context(name: string, generation = 1): RunContext {
  return { runId: `synthetic-t03-${name}`, generation,
    buildHash: 'sha256:' + '3'.repeat(64), runtimeArtifactHash: 'sha256:' + '4'.repeat(64),
    environmentId: 'synthetic-t03-unit-context', evidenceSource: 'machine_test',
    inputSource: 'catalog_machine', executionClass: 'automation_test' };
}
function syntheticBuild(): BuildIdentity {
  const ctx = context('build');
  return { buildHash: ctx.buildHash, runtimeArtifactHash: ctx.runtimeArtifactHash,
    environmentId: ctx.environmentId, buildId: 'synthetic-t03-unit-build', manifest: {},
    runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] },
    productionPackagePaths: [] };
}
function session(name: string, source = fixture(), options?: RunOptions): RunSession {
  return new RunSession(source, context(name), options);
}
function host(source = fixture()): R0Host {
  return new R0Host(source, { sessionId: SESSION, writerToken: WRITER, buildIdentity: syntheticBuild() });
}
function advance(subject: RunSession, direction: Direction): Snapshot {
  const { runId, generation } = subject.snapshot().context;
  return subject.step({ runId, generation, direction });
}
function advanceMany(subject: RunSession, count: number, direction = ZERO): Snapshot {
  let snapshot = subject.snapshot();
  for (let index = 0; index < count; index++) snapshot = advance(subject, direction);
  return snapshot;
}
function command(subject: R0Host, value: ManualCommand): unknown {
  serial++;
  const project = subject.document().project;
  return { commandId: `d4000000-0000-4000-8000-${serial.toString(16).padStart(12, '0')}`,
    sessionId: SESSION, writerToken: WRITER, projectId: project.projectId,
    expectedRevision: project.revision, command: value };
}
async function commit(subject: R0Host, value: ManualCommand): Promise<void> {
  const before = subject.document().project.revision;
  const result = await subject.execute(command(subject, value));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(subject.document().project.revision, before + 1);
}
function assertCode(action: () => unknown, expected: string): void {
  assert.throws(action, (error: unknown) => error !== null && typeof error === 'object' &&
    (('code' in error && error.code === expected) || (error instanceof Error && error.message === expected)));
}
function catalogDirections(name: string): Direction[] {
  const input = JSON.parse(readFileSync(resolve(process.cwd(), 'verification', 'inputs', `${name}.json`), 'utf8')) as {
    segments: Array<Direction & { ticks: number }>; maxTicks: number;
  };
  const directions = input.segments.flatMap(segment => Array.from({ length: segment.ticks }, () => ({ x: segment.x, y: segment.y })));
  assert.ok(directions.length <= input.maxTicks);
  return directions;
}
function executeDirections(subject: RunSession, directions: readonly Direction[]): Snapshot {
  for (const direction of directions) {
    if (subject.snapshot().status !== 'running') break;
    advance(subject, direction);
  }
  return subject.snapshot();
}
function stateProjection(snapshot: Snapshot): unknown {
  return { tick: snapshot.tick, positions: snapshot.positions, score: snapshot.score,
    collectedIds: snapshot.collectedIds, chasingGuardIds: snapshot.chasingGuardIds,
    terminal: snapshot.terminal, status: snapshot.status, lastEventSequence: snapshot.lastEventSequence };
}
function independentlyNormalize(events: readonly GameplayEvent[]): unknown[] {
  const sequence = (id: string): number => {
    const match = /:e([1-9][0-9]*)$/u.exec(id);
    assert.ok(match, `event reference has a real monotonic sequence: ${id}`);
    return Number(match[1]);
  };
  return events.map(event => {
    const actualValues: Record<string, unknown> = structuredClone(event.actualValues);
    if ('contributionEventIds' in actualValues) {
      assert.ok(Array.isArray(actualValues['contributionEventIds']));
      actualValues['contributionEventIds'] = (actualValues['contributionEventIds'] as string[]).map(sequence);
    }
    if ('goalCheckedEventId' in actualValues) {
      const ref = actualValues['goalCheckedEventId'];
      actualValues['goalCheckedEventId'] = ref === null ? null : sequence(ref as string);
    }
    const { runId: _runId, ...rest } = event;
    return { ...rest, eventId: sequence(event.eventId),
      causeId: event.causeId === null ? null : sequence(event.causeId), actualValues };
  });
}

test('T03 queue foundation: FIFO rejection isolation and one synchronous authority section', async () => {
  const queue = new CommandQueue();
  const trace: number[] = [];
  assert.throws(() => queue.assertActive(), /E_QUEUE_REQUIRED/u);
  const first = queue.enqueue(sequence => { assert.equal(queue.assertActive(), sequence); trace.push(sequence); return 'first'; });
  const bad = queue.enqueue(sequence => { trace.push(sequence); throw new Error('controlled failure'); });
  const third = queue.enqueue(sequence => { trace.push(sequence); return 'third'; });
  assert.deepEqual(await Promise.allSettled([first, bad, third]), [
    { status: 'fulfilled', value: 'first' },
    { status: 'rejected', reason: new Error('controlled failure') },
    { status: 'fulfilled', value: 'third' },
  ]);
  assert.deepEqual(trace, [1, 2, 3]);
  await assert.rejects(queue.enqueue(() => Promise.resolve('cannot await inside authority')), /E_ASYNC_QUEUE_JOB/u);
  assert.equal(await queue.enqueue(sequence => sequence), 5);
  assert.throws(() => queue.assertActive(), /E_QUEUE_REQUIRED/u);
});

test('R0-RT-08: pause is explicit, rejected paused input cannot tick, resume preserves the same run', () => {
  const subject = session('pause');
  advance(subject, RIGHT);
  const paused = subject.pause();
  assert.equal(paused.status, 'paused');
  assert.equal(paused.tick, 1);
  assertCode(() => advance(subject, RIGHT), 'E_RUN_NOT_RUNNING');
  assert.deepEqual(subject.snapshot(), paused);
  const resumed = subject.resume();
  assert.equal(resumed.status, 'running');
  assert.equal(resumed.context.runId, paused.context.runId);
  assert.equal(resumed.tick, 1);
  const after = advance(subject, ZERO);
  assert.equal(after.tick, 2);
  assert.deepEqual(after.positions, resumed.positions);
});

test('R0-RT-08: real ended/fault/invalidated sessions never resume or consume late inputs', () => {
  const ended = session('ended', fixture('zero-guard-route'));
  advanceMany(ended, 3, RIGHT);
  const fault = session('fault', fixture('single-reward-repeat'), { eventBudget: 1, faultInjection: true });
  advanceMany(fault, 3, RIGHT);
  const invalidated = session('invalidated');
  advance(invalidated, RIGHT);
  invalidated.invalidate();
  for (const [subject, status] of [[ended, 'ended'], [fault, 'fault'], [invalidated, 'invalidated']] as const) {
    const before = subject.snapshot();
    assert.equal(before.status, status);
    assertCode(() => subject.resume(), 'E_RUN_NOT_RUNNING');
    assertCode(() => advance(subject, RIGHT), 'E_RUN_NOT_RUNNING');
    subject.pause();
    subject.observe();
    assert.deepEqual(subject.snapshot(), before, `${status} remains a complete historical state`);
  }
  assert.equal(fault.snapshot().tick, 2);
  assert.equal(fault.snapshot().score, 0);
  assert.deepEqual(fault.snapshot().collectedIds, []);
  assert.deepEqual(fault.snapshot().events.map(event => event.kind), ['run_started']);
  assert.equal(fault.snapshot().diagnostics[0]?.attemptedTick, 3);
});

test('R0-RT-08: both stale runId and stale generation reject without recording input or mutation', () => {
  const subject = session('identity');
  const before = subject.snapshot();
  for (const envelope of [
    { runId: 'synthetic-prior-run', generation: before.context.generation, direction: RIGHT },
    { runId: before.context.runId, generation: before.context.generation - 1, direction: RIGHT },
  ]) {
    assertCode(() => subject.step(envelope), 'E_STALE_RUN');
    assert.deepEqual(subject.snapshot(), before);
  }
});

test('R0-RT-08: explicit restart of real ended/fault state creates tick0 and preserves old terminal history', async () => {
  for (const mode of ['ended', 'fault'] as const) {
    const subject = host(fixture(mode === 'ended' ? 'zero-guard-route' : 'single-reward-repeat'));
    const run = await subject.startRun(mode === 'fault' ? { runtimeOptions: { eventBudget: 1, faultInjection: true } } : {});
    for (let tick = 0; tick < 3; tick++) await subject.input({ runId: run.context.runId, generation: run.context.generation, direction: RIGHT });
    const old = subject.currentRun();
    assert.ok(old);
    assert.equal(old.status, mode);
    const next = await subject.startRun();
    assert.notEqual(next.context.runId, old.context.runId);
    assert.notEqual(next.context.generation, old.context.generation);
    assert.equal(next.status, 'running');
    assert.equal(next.tick, 0);
    assert.equal(next.score, 0);
    assert.deepEqual(next.collectedIds, []);
    assert.deepEqual(next.events.map(event => event.kind), ['run_started']);
    assert.deepEqual(subject.history().find(item => item.context.runId === old.context.runId), old);
    await assert.rejects(subject.input({ runId: old.context.runId, generation: old.context.generation, direction: RIGHT }));
    assert.deepEqual(subject.currentRun(), next);
  }
});

test('T03 host uses the injected sole queue: semantic edit and input obey enqueue order', async () => {
  for (const editFirst of [true, false]) {
    const queue = new CommandQueue();
    const subject = new R0Host(fixture('scene-b'), { sessionId: SESSION, writerToken: WRITER, buildIdentity: syntheticBuild(), queue });
    assert.strictEqual(subject.queue, queue);
    const run = await subject.startRun();
    const envelope = command(subject, { type: 'set_goal', value: 3 });
    const input = { runId: run.context.runId, generation: run.context.generation, direction: RIGHT };
    const work = editFirst ? [subject.execute(envelope), subject.input(input)] : [subject.input(input), subject.execute(envelope)];
    const results = await Promise.allSettled(work);
    assert.equal(results[0]?.status, 'fulfilled');
    assert.equal(results[1]?.status, editFirst ? 'rejected' : 'fulfilled');
    assert.equal(subject.currentRun()?.status, 'invalidated');
    assert.equal(subject.currentRun()?.tick, editFirst ? 0 : 1);
    assert.equal(subject.currentRun()?.inputs.length, editFirst ? 0 : 1);
    assert.equal(subject.document().project.rules.goal.targetScore, 3);
  }
});

test('T03 failed command/start: rejected writes do not pause and an unplayable draft creates no run evidence', async () => {
  const subject = host(fixture('scene-b'));
  const started = await subject.startRun();
  const rejected = { ...(command(subject, { type: 'set_goal', value: 3 }) as Record<string, unknown>), expectedRevision: 99 };
  const outcome = await subject.execute(rejected);
  assert.equal(outcome.ok, false);
  assert.deepEqual(subject.currentRun(), started, 'rejected command cannot pause or invalidate a running session');
  assert.equal(subject.document().project.rules.goal.targetScore, 4);
  await commit(subject, { type: 'set_goal', value: 99 });
  const prior = subject.currentRun();
  await assert.rejects(subject.startRun());
  assert.deepEqual(subject.currentRun(), prior, 'failed restart preserves the existing historical state');
  assert.deepEqual(subject.history(), []);
  const fresh = host(fixture('scene-b'));
  await commit(fresh, { type: 'set_goal', value: 99 });
  await assert.rejects(fresh.startRun());
  assert.equal(fresh.currentRun(), null);
  assert.deepEqual(fresh.history(), [], 'no synthetic run_started is created by failed validation');
});

test('R0-RT-09: each frozen semantic branch invalidates; undo cannot revive; old spawn/history are preserved', async () => {
  const edits: ManualCommand[] = [
    { type: 'remove_entity', entityId: 'g1' },
    { type: 'set_reward_values', value: { normalValue: 1, highValue: 4 } },
    { type: 'move_entity', entityId: 'h1', x: 540, y: 220 },
  ];
  for (const edit of edits) {
    const subject = host();
    const original = subject.document();
    const started = await subject.startRun();
    await subject.input({ runId: started.context.runId, generation: started.context.generation, direction: RIGHT });
    await subject.pause();
    const old = subject.currentRun();
    assert.ok(old);
    const historical = structuredClone(old);
    await commit(subject, edit);
    assert.notEqual(subject.document().project.semanticHash, original.project.semanticHash);
    assert.equal(subject.currentRun()?.status, 'invalidated');
    await commit(subject, { type: 'undo' });
    assert.equal(subject.document().project.semanticHash, original.project.semanticHash);
    assert.equal(subject.document().project.revision, original.project.revision + 2);
    assert.equal(subject.currentRun()?.status, 'invalidated');
    await assert.rejects(subject.resume());
    assert.deepEqual(old, historical, 'previously returned startup data/events never change');
    assert.deepEqual(subject.currentRun()?.document, original);
    assert.deepEqual(subject.document().project.scene, original.project.scene, 'runtime motion never writes spawn positions');
    const prior = subject.currentRun();
    assert.ok(prior);
    const next = await subject.startRun();
    assert.notEqual(next.context.runId, prior.context.runId);
    assert.notEqual(next.context.generation, prior.context.generation);
    assert.equal(next.tick, 0);
    assert.equal(next.status, 'running');
    assert.equal(next.score, 0);
    assert.deepEqual(next.collectedIds, []);
    await assert.rejects(subject.input({ runId: prior.context.runId, generation: prior.context.generation, direction: RIGHT }));
    assert.deepEqual(subject.currentRun(), next);
    assert.deepEqual(subject.history().find(run => run.context.runId === prior.context.runId), prior);
  }
});

test('R0-RT-09: semantic edit invalidates even a real ended or faulted old run', async () => {
  for (const mode of ['ended', 'fault'] as const) {
    const source = fixture(mode === 'ended' ? 'zero-guard-route' : 'single-reward-repeat');
    const subject = host(source);
    const run = await subject.startRun(mode === 'fault' ? { runtimeOptions: { eventBudget: 1, faultInjection: true } } : {});
    for (let tick = 0; tick < 3; tick++) await subject.input({ runId: run.context.runId, generation: run.context.generation, direction: RIGHT });
    assert.equal(subject.currentRun()?.status, mode);
    const before = subject.currentRun();
    assert.ok(before);
    await commit(subject, { type: 'set_reward_values', value: { normalValue: 2, highValue: 3 } });
    const invalid = subject.currentRun();
    assert.ok(invalid);
    assert.equal(invalid.status, 'invalidated');
    assert.deepEqual(stateProjection(invalid), { ...(stateProjection(before) as object), status: 'invalidated' });
    assert.deepEqual(invalid.events, before.events);
    assert.deepEqual(invalid.diagnostics, before.diagnostics);
    await commit(subject, { type: 'undo' });
    await assert.rejects(subject.resume());
    assert.equal(subject.currentRun()?.status, 'invalidated');
  }
});

test('R0-RT-10 T03 portion: title/theme revision pauses running state and resumes with startup revision and presentation', async () => {
  for (const edit of [
    { type: 'set_text', field: 'title', value: 'R0标题核验' },
    { type: 'set_theme', value: { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' } },
  ] satisfies ManualCommand[]) {
    const subject = host();
    const initial = subject.document();
    const run = await subject.startRun();
    await subject.input({ runId: run.context.runId, generation: run.context.generation, direction: RIGHT });
    const before = subject.currentRun();
    assert.ok(before);
    await commit(subject, edit);
    assert.equal(subject.document().project.semanticHash, initial.project.semanticHash);
    assert.equal(subject.document().project.revision, initial.project.revision + 1);
    const paused = subject.currentRun();
    assert.ok(paused);
    assert.equal(paused.status, 'paused');
    assert.deepEqual(paused.document, initial);
    assert.deepEqual(paused.events, before.events);
    await subject.resume();
    const resumed = subject.currentRun();
    assert.ok(resumed);
    assert.equal(resumed.status, 'running');
    assert.equal(resumed.context.runId, run.context.runId);
    assert.equal(resumed.document.project.revision, initial.project.revision);
    assert.deepEqual(resumed.document.project.presentation, initial.project.presentation);
    assert.deepEqual(resumed.positions, before.positions);
    assert.equal(resumed.tick, before.tick);
  }
});

test('T03 isolation foundation: separate candidate-like real Runtime session never mutates formal host run', async () => {
  const formal = host(fixture('scene-b'));
  const run = await formal.startRun();
  await formal.pause();
  const before = formal.currentRun();
  assert.ok(before);
  const candidateDocument = fixture('scene-b');
  candidateDocument.project.rules.goal.targetScore = 3;
  const candidate = session('candidate-isolation', candidateDocument);
  advanceMany(candidate, 180);
  candidate.invalidate();
  assert.equal(candidate.snapshot().tick, 180);
  assert.deepEqual(formal.currentRun(), before);
  assert.equal(formal.document().project.rules.goal.targetScore, 4);
  assert.equal(formal.currentRun()?.context.runId, run.context.runId);
  // This only proves separate RunSession ownership. T05 must additionally
  // prove TrialRunner/request/candidate eligibility and stale result handling.
});

test('R0-RT-13 ring-only synthetic probe: newest 1000, exact global sequence and dropped range', () => {
  // Deliberately synthetic buffer inputs, never Runtime-generated gameplay.
  const ring = new EventRing<{ eventId: string; tick: number; causeId: string | null; source: 'synthetic_ring_probe' }>();
  for (let sequence = 1; sequence <= 1001; sequence++) ring.append([
    { eventId: `synthetic-ring:e${sequence}`, tick: sequence - 1,
      causeId: sequence === 1001 ? 'synthetic-ring:e1' : null, source: 'synthetic_ring_probe' },
  ]);
  const snapshot = ring.snapshot();
  assert.equal(snapshot.events.length, 1000);
  assert.equal(snapshot.events[0]?.eventId, 'synthetic-ring:e2');
  assert.equal(snapshot.events.at(-1)?.eventId, 'synthetic-ring:e1001');
  assert.deepEqual(snapshot.truncation, { capacity: 1000, totalCommittedEvents: 1001,
    droppedCount: 1, firstRetainedSequence: 2, lastRetainedSequence: 1001, droppedThroughTick: 0 });
  assert.deepEqual(snapshot.events.map(event => event.eventId), Array.from({ length: 1000 }, (_, index) => `synthetic-ring:e${index + 2}`));
  assert.equal(snapshot.events.at(-1)?.causeId, 'synthetic-ring:e1');
  assert.equal(snapshot.events.some(event => event.eventId === 'synthetic-ring:e1'), false, 'no invented replacement cause');
  assert.deepEqual([1, snapshot.truncation.firstRetainedSequence! - 1], [1, 1], 'discarded interval is exactly sequence1..1');
  const old = structuredClone(snapshot);
  ring.append([{ eventId: 'synthetic-ring:e1002', tick: 1001, causeId: null, source: 'synthetic_ring_probe' }]);
  assert.deepEqual(snapshot, old, 'ring reader cannot be retroactively changed by append');
  assert.deepEqual(ring.snapshot().truncation, { capacity: 1000, totalCommittedEvents: 1002,
    droppedCount: 2, firstRetainedSequence: 3, lastRetainedSequence: 1002, droppedThroughTick: 1 });
});

test('R0-RT-13 ring-only synthetic probe: bad sequence/prefix batch is atomic and does not consume ordinals', () => {
  const ring = new EventRing();
  assert.deepEqual(ring.snapshot().truncation, { capacity: 1000, totalCommittedEvents: 0,
    droppedCount: 0, firstRetainedSequence: null, lastRetainedSequence: null, droppedThroughTick: null });
  const template = session('synthetic-ring-atomic', fixture('scene-b')).snapshot().events[0]!;
  ring.append([template]);
  const before = structuredClone(ring.snapshot());
  for (const invalidBatch of [
    [{ ...template, eventId: `${template.runId}:e2` }, { ...template, eventId: `${template.runId}:e4` }],
    [{ ...template, eventId: `${template.runId}:e2` }, { ...template, eventId: 'synthetic-foreign-run:e3' }],
  ]) {
    assert.throws(() => ring.append(invalidBatch), /E_EVENT_SEQUENCE/u);
    assert.deepEqual(ring.snapshot(), before);
  }
  ring.append([{ ...template, eventId: `${template.runId}:e2` }]);
  assert.equal(ring.snapshot().truncation.lastRetainedSequence, 2);
});

test('R0-RT-13 / EVID01 synthetic observer unit: missing truncated and unknown references stay explicit', () => {
  // Shape templates originate in a real short run, but repeated generated
  // records below are deliberately SYNTHETIC buffer/reader unit data, never
  // a RunSession, actual Runtime history, or exportable evidence package.
  const actual = session('synthetic-reader-template', fixture('zero-guard-route'));
  const snapshot = advanceMany(actual, 3, RIGHT);
  const template = snapshot.events.find(event => event.kind === 'score_changed');
  assert.ok(template && template.kind === 'score_changed');
  const ring = new EventRing();
  const runId = 'synthetic-reader-probe';
  for (let sequence = 1; sequence <= 1001; sequence++) ring.append([
    { ...template, runId, eventId: `${runId}:e${sequence}`, tick: sequence - 1,
      causeId: sequence === 1001 ? `${runId}:e1` : null },
  ]);
  const retained = ring.snapshot();
  const observed = observeEvents(retained.events, retained.truncation, [`${runId}:e1001`]);
  assert.equal(observed.length, 1);
  assert.equal(observed[0]?.event.eventId, `${runId}:e1001`);
  assert.equal(observed[0]?.causeStatus, 'truncated');
  assert.deepEqual(observed[0]?.missingCause, [`${runId}:e1`]);
  assert.equal(retained.events.some(event => event.eventId === `${runId}:e1`), false);
  const last = retained.events.at(-1)!;
  const unknown = observeEvents([{ ...last, causeId: `${runId}:e1002` }], retained.truncation);
  assert.equal(unknown[0]?.causeStatus, 'unknown');
  assert.deepEqual(unknown[0]?.missingCause, [`${runId}:e1002`]);
  assert.throws(() => observeEvents(retained.events, retained.truncation, [`${runId}:e1`]), /E_EVENT_NOT_RETAINED/u);
});

test('T03 consumed inputs: every actual committed tick including unchanged direction is recorded once', () => {
  const subject = session('input-ledger', fixture('scene-b'));
  const directions: Direction[] = [ZERO, RIGHT, RIGHT, { x: 1, y: 1 }, ZERO, { x: -1, y: 0 }];
  for (const [index, direction] of directions.entries()) {
    const snapshot = advance(subject, direction);
    assert.equal(snapshot.tick, index + 1);
    assert.deepEqual(snapshot.inputs, directions.slice(0, index + 1).map((value, tickIndex) => ({
      tick: tickIndex + 1, direction: value, committed: true, lastCommittedTick: tickIndex + 1,
    })));
    assert.equal(snapshot.frames.length, snapshot.tick + 1, 'tick0 and each committed tick have an immutable frame');
    assert.deepEqual(snapshot.frames.map(frame => frame.tick), Array.from({ length: index + 2 }, (_, tick) => tick));
  }
  const before = subject.snapshot();
  subject.pause();
  assertCode(() => advance(subject, RIGHT), 'E_RUN_NOT_RUNNING');
  assert.deepEqual(subject.snapshot().inputs, before.inputs, 'a rejected tick is never replayable consumed input');
  assert.deepEqual(subject.snapshot().frames, before.frames);
});

test('R0-RT-13 input ledger includes fault attempt but cannot replay provisional facts as committed', () => {
  const subject = session('fault-ledger', fixture('single-reward-repeat'), { eventBudget: 1, faultInjection: true });
  advanceMany(subject, 3, RIGHT);
  const snapshot = subject.snapshot();
  assert.deepEqual(snapshot.inputs, [
    { tick: 1, direction: RIGHT, committed: true, lastCommittedTick: 1 },
    { tick: 2, direction: RIGHT, committed: true, lastCommittedTick: 2 },
    { tick: 3, direction: RIGHT, committed: false, lastCommittedTick: 2 },
  ]);
  assert.ok(snapshot.frames.every(frame => frame.tick <= 2), 'no uncommitted tick3 frame');
  assert.ok(snapshot.frames.every(frame => frame.score === 0 && frame.collectedIds.length === 0), 'no provisional score or collection in frames');
  assert.equal(snapshot.score, 0);
  assert.deepEqual(snapshot.collectedIds, []);
  assert.deepEqual(snapshot.events.map(event => event.kind), ['run_started']);
});

test('R0-EVID-01 T03 portion: real event identity, phase, cause chain and observation stay historical', () => {
  const subject = session('evidence-chain', fixture('double-reward'));
  executeDirections(subject, catalogDirections('double-reward'));
  const snapshot = subject.snapshot();
  const eventKeys = ['actualValues', 'causeId', 'entityIds', 'eventId', 'kind', 'observationPhase', 'positions', 'projectId', 'revision', 'ruleId', 'runId', 'semanticHash', 'tick'];
  for (const [index, event] of snapshot.events.entries()) {
    assert.deepEqual(Object.keys(event).sort(), eventKeys);
    assert.equal(event.eventId, `${snapshot.context.runId}:e${index + 1}`);
    assert.equal(event.runId, snapshot.context.runId);
    assert.equal(event.projectId, snapshot.document.project.projectId);
    assert.equal(event.revision, snapshot.document.project.revision);
    assert.equal(event.semanticHash, snapshot.document.project.semanticHash);
    assert.equal(event.observationPhase, event.kind === 'run_started' || event.kind.startsWith('chase_') ? 'before_move' : 'after_move');
    if (event.causeId !== null) assert.ok(snapshot.events.slice(0, index).some(prior => prior.eventId === event.causeId));
  }
  const scores = snapshot.events.filter(event => event.kind === 'score_changed');
  const goal = snapshot.events.find(event => event.kind === 'goal_checked');
  const end = snapshot.events.find(event => event.kind === 'round_ended');
  assert.ok(goal && goal.kind === 'goal_checked');
  assert.ok(end && end.kind === 'round_ended');
  assert.equal(scores.length, 2);
  assert.deepEqual(goal.actualValues.contributionEventIds, scores.map(event => event.eventId));
  assert.deepEqual(end.actualValues.contributionEventIds, scores.map(event => event.eventId));
  assert.equal(end.actualValues.goalCheckedEventId, goal.eventId);
  const selected = subject.observe([end.eventId]);
  assert.ok(selected.events.length >= 1);
  for (const item of selected.events) {
    assert.deepEqual(item.missingCause, []);
    assert.equal(item.causeStatus, 'complete');
  }
  const frozen = structuredClone(selected);
  subject.invalidate();
  assert.deepEqual(selected, frozen);
  assert.deepEqual(subject.snapshot().events, snapshot.events);
});

test('R0-EVID-02: actual 900-tick replay has new identity and exact per-tick/event correspondence', () => {
  const directions = catalogDirections('terminal-conflict');
  const original = session('replay-original', fixture('terminal-conflict'));
  const first = executeDirections(original, directions);
  assert.equal(first.tick, 900);
  assert.equal(first.status, 'ended');
  const originalBytes = JSON.stringify(first);
  const replay = new RunSession(first.document, { ...context('replay-new', 2), evidenceSource: 'replay' });
  const second = executeDirections(replay, first.inputs.map(input => input.direction));
  assert.notEqual(second.context.runId, first.context.runId);
  assert.notEqual(second.events[0]?.eventId, first.events[0]?.eventId);
  assert.deepEqual(second.frames, first.frames);
  assert.deepEqual(stateProjection(second), stateProjection(first));
  assert.deepEqual(independentlyNormalize(second.events), independentlyNormalize(first.events));
  assert.deepEqual(normalizeEvents(first.events), independentlyNormalize(first.events), 'production normalization preserves the independently mapped fields and references');
  assert.deepEqual(normalizeEvents(second.events), normalizeEvents(first.events));
  const comparison = compareRuns(first, second);
  assert.equal(comparison.equal, true);
  assert.equal(comparison.sameBuild, true);
  assert.equal(comparison.firstDivergenceTick, null);
  assert.deepEqual(comparison.differences, []);
  assert.equal(JSON.stringify(first), originalBytes, 'raw historical event IDs and package are never rewritten');
});

test('R0-EVID-02: one changed actually consumed direction reports first state divergence899', () => {
  const directions = catalogDirections('terminal-conflict');
  const original = executeDirections(session('diverge-original', fixture('terminal-conflict')), directions);
  const changed = directions.map(direction => ({ ...direction }));
  changed[898] = { x: 0, y: 1 };
  const altered = executeDirections(session('diverge-altered', fixture('terminal-conflict')), changed);
  assert.deepEqual(altered.frames.slice(0, 899), original.frames.slice(0, 899));
  assert.notDeepEqual(altered.frames[899], original.frames[899]);
  assert.deepEqual(original.inputs[898]?.direction, RIGHT);
  assert.deepEqual(altered.inputs[898]?.direction, { x: 0, y: 1 });
  const comparison = compareRuns(original, altered);
  assert.equal(comparison.equal, false);
  assert.equal(comparison.sameBuild, true);
  assert.equal(comparison.firstDivergenceTick, 899);
  assert.ok(comparison.differences.length > 0);
});

test('R0-EVID-02: build/artifact/environment and input tampering are never identical reproduction', () => {
  const source = fixture('zero-guard-route');
  const original = executeDirections(session('compare-base', source), [RIGHT, RIGHT, RIGHT]);
  for (const change of [
    { buildHash: 'sha256:' + '5'.repeat(64) },
    { runtimeArtifactHash: 'sha256:' + '6'.repeat(64) },
    { environmentId: 'synthetic-different-environment' },
  ]) {
    const changed = new RunSession(source, { ...context(`compare-identity-${serial++}`), ...change });
    const compared = compareRuns(original, executeDirections(changed, [RIGHT, RIGHT, RIGHT]));
    assert.equal(compared.equal, false);
    assert.equal(compared.sameBuild, false);
  }
  const altered = structuredClone(original) as Snapshot & { inputs: Array<{ tick: number; direction: Direction; committed: boolean; lastCommittedTick: number }> };
  altered.inputs[0]!.direction = { x: 0, y: 1 };
  assert.equal(compareRuns(original, altered).equal, false, 'rewritten input ledger cannot claim an identical reproduction');
  const missing = structuredClone(original) as Snapshot & { inputs: Array<{ tick: number; direction: Direction; committed: boolean; lastCommittedTick: number }> };
  missing.inputs.splice(1, 1);
  assert.equal(compareRuns(original, missing).equal, false, 'a missing consumed tick cannot claim an identical reproduction');
  const topology = { ...original, events: original.events.map(event => event.kind === 'score_changed'
    ? { ...event, causeId: original.events[0]!.eventId } : event) };
  assert.equal(compareRuns(original, topology).equal, false, 'same values with different real causal topology are not identical');
  const revision = structuredClone(original);
  revision.document.project.revision++;
  const revisionComparison = compareRuns(original, revision);
  assert.equal(revisionComparison.equal, false);
  assert.equal(revisionComparison.firstDivergenceTick, 0, 'startup revision is preserved rather than normalized away');
});

test('T03 JSON projection preserves Map/Set contents and snapshots/returned history are immutable', async () => {
  const source = fixture('single-reward-repeat');
  const subject = session('json-projection', source);
  const before = subject.snapshot();
  source.project.title = 'caller edited original';
  advanceMany(subject, 3, RIGHT);
  const after = subject.snapshot();
  const decoded = JSON.parse(JSON.stringify(after)) as Snapshot;
  assert.deepEqual(decoded, after);
  assert.deepEqual(decoded.collectedIds, ['n1']);
  const decodedPlayer = decoded.positions['p'];
  assert.ok(decodedPlayer);
  assert.ok(Math.abs(decodedPlayer.x - 28) <= 1e-9, 'ideal rational coordinate uses frozen numeric-report tolerance only');
  assert.equal(decodedPlayer.y, 270);
  assert.equal(Object.keys(decoded.positions).length, after.document.project.scene.entities.length);
  assert.deepEqual(before.collectedIds, []);
  assert.deepEqual(before.positions['p'], { x: 20, y: 270 });
  assert.equal(before.tick, 0);
  assert.notEqual(after.document.project.title, source.project.title);
  const historical = JSON.stringify(after);
  assert.throws(() => { (after.positions['p'] as { x: number; y: number }).x = 500; }, TypeError);
  assert.throws(() => { (after.collectedIds as string[]).push('fabricated'); }, TypeError);
  assert.throws(() => { after.document.project.rules.goal.targetScore = 99; }, TypeError);
  assert.equal(JSON.stringify(subject.snapshot()), historical);
  const current = host(fixture('scene-b'));
  const one = await current.startRun();
  await current.startRun();
  const history = current.history();
  assert.equal(history[0]?.context.runId, one.context.runId);
  const historyBefore = JSON.stringify(history);
  await current.startRun();
  assert.equal(JSON.stringify(history), historyBefore);
});

test('R0-REC-01 T03 volatile core portion: new authority reloads fixture and cannot inherit an old live run', async () => {
  const first = host(fixture('scene-b'));
  await commit(first, { type: 'set_goal', value: 3 });
  const run = await first.startRun();
  await first.pause();
  const old = first.currentRun();
  assert.ok(old);
  assert.equal(old.status, 'paused');
  assert.equal(first.document().project.rules.goal.targetScore, 3);
  const second = new R0Host(fixture('scene-b'), { sessionId: 'synthetic-new-session', writerToken: WRITER, buildIdentity: syntheticBuild() });
  assert.equal(second.document().project.rules.goal.targetScore, 4);
  assert.equal(second.currentRun(), null);
  assert.deepEqual(second.history(), []);
  const next = await second.startRun();
  assert.notEqual(next.context.runId, run.context.runId);
  await assert.rejects(second.input({ runId: run.context.runId, generation: run.context.generation, direction: RIGHT }));
  assert.deepEqual(second.currentRun(), next);
  assert.equal(first.currentRun()?.status, 'paused');
  assert.deepEqual(first.currentRun(), old);
  // Same-live transport reconnect, clear-keys, process exit/export audit and UI
  // wording are separate T04/T11 evidence; constructing a host is no browser test.
});
