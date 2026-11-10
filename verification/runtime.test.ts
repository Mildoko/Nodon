import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyOperations, assertDocument, parseDocument, validatePlayability,
  type Document, type Operation,
} from '../src/domain/index.js';

import {
  createRun, stepRun, relativeSegmentContact, snapshotRun,
  type ContactWitness, type EventKind, type GameplayEvent, type Point,
  type RunContext, type RunOptions, type RunResult, type RunState,
} from '../src/runtime/index.js';

// Independent T00 expectations: docs/r0-motion-evidence-adr.md §5 and
// verification/case-manifest.json R0-RT-01..07/13. No production geometry or
// Runtime state is used to calculate expected results. Numerical report tolerance
// is absolute=1e-9, relative=1e-12; all branch/tick/event assertions stay exact.
// Context fingerprints below are visibly synthetic machine-test identifiers.
// These tests do not establish a true CLI build/evidence package, AI, human, UI,
// candidate authorization, or complete R0-RT-13/14 case pass.
const ABSOLUTE_TOLERANCE = 1e-9;
const RELATIVE_TOLERANCE = 1e-12;
interface Direction { x: -1 | 0 | 1; y: -1 | 0 | 1 }
interface InputCatalog { segments: Array<Direction & { ticks: number }>; maxTicks: number }
function read(path: string): string { return readFileSync(resolve(process.cwd(), path), 'utf8'); }
function fixture(name: string): Document { return parseDocument(read(`verification/fixtures/${name}.json`)); }
function inputCatalog(name: string): InputCatalog {
  return JSON.parse(read(`verification/inputs/${name}.json`)) as InputCatalog;
}
function close(actual: number, expected: number, label = ''): void {
  assert.ok(Number.isFinite(actual), `${label}: finite actual`);
  const allowance = Math.max(ABSOLUTE_TOLERANCE, RELATIVE_TOLERANCE * Math.abs(expected));
  assert.ok(Math.abs(actual - expected) <= allowance,
    `${label}: actual=${actual}, independent expected=${expected}, allowance=${allowance}`);
}
function playable(doc: Document): Document {
  const result = assertDocument(doc);
  assert.equal(validatePlayability(result).playable, true);
  return result;
}




type ObservedRun = Omit<RunState, 'collectedIds'> & {
  readonly core: RunState;
  readonly collectedIds: readonly string[];
  readonly events: readonly GameplayEvent[];
  readonly diagnostics: RunResult['diagnostics'];
  readonly blocked: boolean;
};
function context(runId: string): RunContext {
  return {
    runId: `synthetic-unit-${runId}`, generation: 0,
    buildHash: 'sha256:' + '0'.repeat(64),
    runtimeArtifactHash: 'sha256:' + '1'.repeat(64),
    environmentId: 'synthetic-runtime-unit-context', evidenceSource: 'machine_test',
    inputSource: 'catalog_machine', executionClass: 'automation_test',
  };
}
function observe(result: RunResult, prior?: ObservedRun): ObservedRun {
  return {
    ...result.state, core: result.state, collectedIds: [...result.state.collectedIds],
    events: [...(prior?.events ?? []), ...result.events],
    diagnostics: [...(prior?.diagnostics ?? []), ...result.diagnostics], blocked: result.blocked,
  };
}
function start(doc: Document, runId: string, options?: RunOptions): ObservedRun {
  playable(doc); // Validate independently without replacing the actual caller object.
  return observe(createRun(doc, context(runId), options));
}
function advance(run: ObservedRun, direction: Direction): ObservedRun {
  return observe(stepRun(run.core, direction), run);
}
function point(run: ObservedRun, id: string): Point {
  const value = run.positions.get(id);
  assert.ok(value, `position ${id} exists`);
  return value;
}
function ofKind<K extends EventKind>(run: ObservedRun, kind: K): Array<Extract<GameplayEvent, { kind: K }>> {
  return run.events.filter((event): event is Extract<GameplayEvent, { kind: K }> => event.kind === kind);
}
function terminal(run: ObservedRun): Extract<GameplayEvent, { kind: 'round_ended' }> {
  const events = ofKind(run, 'round_ended');
  assert.equal(events.length, 1);
  assert.equal(run.status, 'ended');
  return events[0]!;
}
function executeCatalog(doc: Document, inputName: string, runId: string): ObservedRun[] {
  const catalog = inputCatalog(inputName);
  let run = start(doc, runId);
  const states: ObservedRun[] = [run];
  let attempted = 0;
  for (const segment of catalog.segments) {
    for (let index = 0; index < segment.ticks && run.status === 'running'; index++) {
      attempted++;
      assert.ok(attempted <= catalog.maxTicks);
      run = advance(run, { x: segment.x, y: segment.y });
      assert.equal(run.tick, attempted, 'one and only one committed tick per consumed input');
      states.push(run);
    }
    if (run.status !== 'running') break;
  }
  return states;
}
function observedSnapshot(run: ObservedRun): unknown {
  return structuredClone({ state: snapshotRun(run.core), events: run.events, diagnostics: run.diagnostics, blocked: run.blocked });
}
function assertWitnessShape(witness: ContactWitness): void {
  assert.deepEqual(Object.keys(witness).sort(), [
    'closestTickFraction', 'contactThreshold', 'contacted', 'endPositions',
    'endpointCenterDistance', 'entityIds', 'minCenterDistance', 'startPositions',
  ]);
  assert.equal(witness.entityIds.length, 2);
  const ids = [...witness.entityIds].sort();
  assert.deepEqual(Object.keys(witness.startPositions).sort(), ids);
  assert.deepEqual(Object.keys(witness.endPositions).sort(), ids);
  assert.ok(witness.closestTickFraction >= 0 && witness.closestTickFraction <= 1);
  for (const value of [witness.closestTickFraction, witness.minCenterDistance, witness.endpointCenterDistance, witness.contactThreshold]) {
    assert.ok(Number.isFinite(value));
    assert.ok(value >= 0);
  }
}

// These full runs begin with a validated immutable tick0 document. Every motion
// checkpoint is reached through actual calls to step; no tick/state jumps.
test('R0-RT-01: zero-guard full route wins exactly at tick3 and cannot advance afterward', (): void => {
  let state = start(fixture('zero-guard-route'), 'rt01');
  assert.equal(state.tick, 0);
  assert.equal(state.score, 0);
  assert.equal(state.status, 'running');
  const initial = state.events;
  assert.equal(initial.length, 1);
  assert.equal(initial[0]?.kind, 'run_started');
  for (const [tick, expectedX] of [[1, 68 / 3], [2, 76 / 3], [3, 28]] as const) {
    state = advance(state, { x: 1, y: 0 });
    assert.equal(state.tick, tick);
    close(point(state, 'p').x, expectedX, `player tick${tick}`);
    if (tick < 3) {
      assert.equal(state.score, 0);
      assert.deepEqual(state.collectedIds, []);
      assert.equal(state.status, 'running');
    }
  }
  assert.equal(state.status, 'ended');
  assert.equal(state.score, 1);
  assert.deepEqual(state.collectedIds, ['n1']);
  assert.equal(ofKind(state, 'reward_collected').length, 1);
  assert.equal(ofKind(state, 'score_changed').length, 1);
  assert.equal(ofKind(state, 'goal_checked').length, 1);
  assert.deepEqual(ofKind(state, 'chase_started'), []);
  assert.deepEqual(ofKind(state, 'chase_stopped'), []);
  const end = terminal(state);
  assert.equal(end.tick, 3);
  assert.equal(end.actualValues.reason, 'win');
  assert.equal(end.actualValues.caught, false);
  assert.equal(end.actualValues.timeout, false);
  assert.deepEqual(end.actualValues.caughtByEntityIds, []);
  assert.equal(end.actualValues.primaryGuardId, null);
  const reward = ofKind(state, 'reward_collected')[0]!;
  const contact = reward.actualValues.contactWitnesses[0]!;
  close(contact.minCenterDistance, 22);
  close(contact.endpointCenterDistance, 22);
  assert.equal(contact.contacted, true);
  const ended = observedSnapshot(state);
  for (let index = 0; index < 1000; index++) state = advance(state, { x: 0, y: 0 });
  assert.deepEqual(observedSnapshot(state), ended);
});

test('R0-RT-02: enabled limits terminate at actual tick900/1800; disabled keeps 1800 complete ticks', (): void => {
  for (const [enabled, limit, ticks] of [[true, 15, 900], [true, 30, 1800], [false, 30, 1800]] as const) {
    const doc = fixture('scene-b');
    doc.project.rules.timer = { enabled, limit };
    let state = start(playable(doc), `rt02-${enabled}-${limit}`);
    for (let tick = 1; tick <= ticks; tick++) {
      state = advance(state, { x: 0, y: 0 });
      assert.equal(state.tick, tick);
      if (tick < ticks) assert.equal(state.status, 'running');
    }
    assert.equal(state.score, 0);
    assert.deepEqual(ofKind(state, 'reward_collected'), []);
    assert.deepEqual(ofKind(state, 'chase_started'), []);
    if (enabled) {
      const end = terminal(state);
      assert.equal(end.tick, ticks);
      assert.equal(end.actualValues.reason, 'timeout');
      assert.equal(end.actualValues.timeout, true);
      assert.equal(end.actualValues.caught, false);
      assert.equal(end.actualValues.goalReached, false);
      assert.equal(end.actualValues.goalCheckedEventId, null);
      assert.deepEqual(end.actualValues.contributionEventIds, []);
      assert.equal(end.causeId, null);
    } else {
      assert.equal(state.status, 'running');
      assert.deepEqual(ofKind(state, 'round_ended'), []);
    }
  }
});

test('R0-RT-03: exact before-move discovery equality and outside case', (): void => {
  const equal = advance(start(fixture('detect-equal'), 'rt03-equal'), { x: 0, y: 0 });
  const chase = ofKind(equal, 'chase_started');
  assert.equal(chase.length, 1);
  const event = chase[0]!;
  assert.equal(event.tick, 1);
  assert.equal(event.observationPhase, 'before_move');
  assert.deepEqual(event.positions, { p: { x: 100, y: 270 }, g1: { x: 160, y: 270 } });
  assert.equal(event.actualValues.centerDistance, 60);
  assert.equal(event.actualValues.detectRadius, 60);
  assert.equal(event.actualValues.speed, 20);
  assert.equal(event.actualValues.chasing, true);
  close(point(equal, 'g1').x, 479 / 3);
  const outside = advance(start(fixture('detect-outside'), 'rt03-outside'), { x: 0, y: 0 });
  assert.equal(point(outside, 'g1').x, 170);
  assert.deepEqual(ofKind(outside, 'chase_started'), []);
});

test('R0-RT-03: entering discovery circle is visible only next before-move tick', (): void => {
  let state = start(fixture('detect-enter'), 'rt03-enter');
  for (let tick = 1; tick <= 4; tick++) {
    state = advance(state, { x: 1, y: 0 });
    assert.equal(state.tick, tick);
    assert.equal(point(state, 'g1').x, 170);
    assert.deepEqual(ofKind(state, 'chase_started'), []);
  }
  close(point(state, 'p').x, 332 / 3);
  state = advance(state, { x: 0, y: 0 });
  const chase = ofKind(state, 'chase_started');
  assert.equal(chase.length, 1);
  assert.equal(chase[0]!.tick, 5);
  close(chase[0]!.actualValues.centerDistance, 178 / 3);
  close(point(state, 'g1').x, 509 / 3);
});

test('R0-RT-03: leaving discovery emits one stop and never moves guard toward home', (): void => {
  let state = start(fixture('detect-equal'), 'rt03-exit');
  state = advance(state, { x: -1, y: 0 });
  close(point(state, 'p').x, 292 / 3);
  close(point(state, 'g1').x, 479 / 3);
  assert.equal(ofKind(state, 'chase_started').length, 1);
  state = advance(state, { x: 0, y: 0 });
  const stop = ofKind(state, 'chase_stopped');
  assert.equal(stop.length, 1);
  assert.equal(stop[0]!.tick, 2);
  assert.equal(stop[0]!.observationPhase, 'before_move');
  assert.equal(stop[0]!.actualValues.chasing, false);
  close(stop[0]!.actualValues.centerDistance, 187 / 3);
  close(point(state, 'g1').x, 479 / 3);
  for (let index = 0; index < 3; index++) state = advance(state, { x: 0, y: 0 });
  assert.equal(ofKind(state, 'chase_stopped').length, 1);
  close(point(state, 'g1').x, 479 / 3);
});

test('movement normalizes diagonals while guards target the before-move player', (): void => {
  const state = advance(start(fixture('detect-equal'), 'rt03-before-target'), { x: 1, y: 1 });
  const diagonalStep = 160 / (60 * Math.sqrt(2));
  close(point(state, 'p').x, 100 + diagonalStep);
  close(point(state, 'p').y, 270 + diagonalStep);
  close(point(state, 'g1').x, 479 / 3);
  assert.equal(point(state, 'g1').y, 270);
});

test('R0-RT-04: symmetric complete route includes both contacting guards in one caught terminal', (): void => {
  const doc = fixture('two-guard-contact');
  doc.project.scene.entities.reverse(); // Deliberately oppose storage order to ASCII event order.
  let state = start(playable(doc), 'rt04');
  for (let tick = 1; tick <= 100 && state.status === 'running'; tick++) {
    state = advance(state, { x: 1, y: 0 });
    assert.equal(state.tick, tick);
    close(point(state, 'g1').x, point(state, 'g2').x);
    close(point(state, 'g1').y + point(state, 'g2').y, 540);
  }
  assert.equal(state.status, 'ended');
  assert.equal(state.score, 0);
  const chase = ofKind(state, 'chase_started');
  assert.equal(chase.length, 2);
  assert.deepEqual(chase.map(event => event.actualValues.guardId), ['g1', 'g2']);
  assert.equal(chase[0]!.tick, chase[1]!.tick);
  const end = terminal(state);
  assert.equal(end.actualValues.reason, 'caught');
  assert.deepEqual(end.actualValues.caughtByEntityIds, ['g1', 'g2']);
  assert.equal(end.actualValues.primaryGuardId, 'g1');
  assert.deepEqual(end.entityIds, ['g1', 'g2', 'p']);
  assert.deepEqual(Object.keys(end.positions).sort(), ['g1', 'g2', 'p']);
  assert.deepEqual(end.actualValues.contactWitnesses.map(witness => witness.entityIds), [['p', 'g1'], ['p', 'g2']]);
  for (const witness of end.actualValues.contactWitnesses) {
    assert.equal(witness.contacted, true);
    assert.equal(witness.contactThreshold, 26);
    assertWitnessShape(witness);
  }
  assert.equal(end.causeId, null);
});

test('R0-RT-05: repeated contact and reentry cannot collect the same reward twice', (): void => {
  const states = executeCatalog(fixture('single-reward-repeat'), 'repeat', 'rt05-repeat');
  const state = states.at(-1)!;
  assert.equal(states.length, 124);
  assert.equal(state.tick, 123);
  assert.equal(state.status, 'running');
  assert.equal(state.score, 1);
  assert.deepEqual(state.collectedIds, ['n1']);
  assert.equal(ofKind(state, 'reward_collected').length, 1);
  assert.equal(ofKind(state, 'score_changed').length, 1);
  assert.equal(ofKind(state, 'goal_checked').length, 1);
  assert.equal(ofKind(state, 'reward_collected')[0]!.tick, 3);
  assert.deepEqual(ofKind(state, 'round_ended'), []);
  for (const committed of states.slice(3)) {
    assert.equal(committed.score, 1);
    assert.deepEqual(committed.collectedIds, ['n1']);
  }
});

test('R0-RT-05: same-tick ASCII collection pairs precede one final-score goal check', (): void => {
  const states = executeCatalog(fixture('double-reward'), 'double-reward', 'rt05-double');
  const before = states[15]!;
  close(point(before, 'p').x, 60);
  assert.equal(before.score, 0);
  const state = states[16]!;
  close(point(state, 'p').x, 188 / 3);
  assert.equal(state.score, 2);
  assert.deepEqual(state.collectedIds, ['n10', 'n2']);
  assert.deepEqual(state.events.filter(event => event.tick === 16).map(event => event.kind), [
    'reward_collected', 'score_changed', 'reward_collected', 'score_changed', 'goal_checked', 'round_ended',
  ]);
  const collections = ofKind(state, 'reward_collected');
  assert.deepEqual(collections.map(event => event.actualValues.rewardId), ['n10', 'n2']);
  const scores = ofKind(state, 'score_changed');
  assert.deepEqual(scores.map(event => [event.actualValues.scoreBefore, event.actualValues.scoreAfter, event.actualValues.delta]), [[0, 1, 1], [1, 2, 1]]);
  assert.deepEqual(scores.map(event => event.causeId), collections.map(event => event.eventId));
  const goals = ofKind(state, 'goal_checked');
  assert.equal(goals.length, 1);
  const goal = goals[0]!;
  assert.deepEqual(goal.actualValues, { score: 2, targetScore: 2, passed: true, contributionEventIds: scores.map(event => event.eventId) });
  assert.equal(goal.causeId, scores[1]!.eventId);
  assert.deepEqual(goal.entityIds, ['n10', 'n2', 'p']);
  const end = terminal(state);
  assert.equal(end.actualValues.reason, 'win');
  assert.equal(end.actualValues.goalCheckedEventId, goal.eventId);
  assert.deepEqual(end.actualValues.contributionEventIds, scores.map(event => event.eventId));
  assert.equal(end.causeId, goal.eventId);
  for (const collection of collections) {
    const witness = collection.actualValues.contactWitnesses[0]!;
    close(witness.minCenterDistance, Math.sqrt(400 + 484 / 9));
    assert.equal(witness.contacted, true);
    assert.equal(collection.observationPhase, 'after_move');
  }
});

test('mixed normal/high lawful route uses category values and checks only final total', (): void => {
  const doc = fixture('double-reward');
  const high = doc.project.scene.entities.find(entity => entity.id === 'n10');
  assert.ok(high);
  high.kind = 'high';
  doc.project.rules.goal.targetScore = 4;
  const states = executeCatalog(playable(doc), 'double-reward', 'rt05-mixed');
  const state = states.at(-1)!;
  const collections = ofKind(state, 'reward_collected');
  assert.deepEqual(collections.map(event => [event.actualValues.rewardId, event.actualValues.rewardKind, event.actualValues.value]), [['n10', 'high', 3], ['n2', 'normal', 1]]);
  assert.deepEqual(ofKind(state, 'score_changed').map(event => event.actualValues.scoreAfter), [3, 4]);
  assert.equal(state.score, 4);
  assert.equal(ofKind(state, 'goal_checked').length, 1);
  assert.equal(ofKind(state, 'goal_checked')[0]!.actualValues.score, 4);
  assert.equal(terminal(state).actualValues.reason, 'win');
});

test('R0-RT-06 full legal tangent route collects at tick22 despite separated endpoints', (): void => {
  const states = executeCatalog(fixture('sweep-tangent'), 'tangent', 'rt06-tangent');
  assert.equal(states.length, 23);
  const before = states[21]!;
  close(point(before, 'p').x, 68);
  close(point(before, 'p').y, 28);
  assert.equal(before.score, 0);
  const state = states[22]!;
  assert.equal(state.score, 1);
  assert.equal(state.status, 'running');
  const events = ofKind(state, 'reward_collected');
  assert.equal(events.length, 1);
  assert.equal(events[0]!.tick, 22);
  const witness = events[0]!.actualValues.contactWitnesses[0]!;
  assertWitnessShape(witness);
  assert.deepEqual(witness.entityIds, ['p', 'n1']);
  close(witness.startPositions.p!.x, 68);
  close(witness.startPositions.p!.y, 28);
  close(witness.endPositions.p!.x, 212 / 3);
  close(witness.endPositions.p!.y, 28);
  assert.deepEqual(witness.startPositions.n1, { x: 70, y: 50 });
  assert.deepEqual(witness.endPositions.n1, { x: 70, y: 50 });
  close(witness.closestTickFraction, 3 / 4);
  close(witness.minCenterDistance, 22);
  close(witness.endpointCenterDistance, Math.sqrt(484 + 4 / 9));
  assert.ok(witness.endpointCenterDistance > witness.contactThreshold);
  assert.equal(witness.contacted, true);
  assert.deepEqual(events[0]!.positions, witness.endPositions);
});

test('R0-RT-06: clamp follows normalized motion and stores the actual clamped endpoint', (): void => {
  const states = executeCatalog(fixture('clamp'), 'clamp', 'rt06-clamp');
  const increment = 160 / (60 * Math.sqrt(2));
  for (let tick = 1; tick <= 5; tick++) {
    close(point(states[tick]!, 'p').x, 930 + tick * increment);
    close(point(states[tick]!, 'p').y, 510 + tick * increment);
  }
  for (let tick = 6; tick <= 10; tick++) assert.deepEqual(point(states[tick]!, 'p'), { x: 940, y: 520 });
  assert.equal(states.at(-1)!.status, 'running');
  assert.equal(states.at(-1)!.score, 0);
});

test('R0-RT-06 low-level geometry only: tangent, near-miss, relative motion and zero denominator', (): void => {
  // These deliberately non-editor vectors are isolated geometry tests, never
  // reported as full lawful runs or used as a substitute for rt06-tangent.
  const tangent = relativeSegmentContact('p', 'q', { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 22 }, { x: 2, y: 22 }, 22);
  assertWitnessShape(tangent);
  assert.equal(tangent.closestTickFraction, 1 / 2);
  assert.equal(tangent.minCenterDistance, 22);
  close(tangent.endpointCenterDistance, Math.sqrt(488));
  assert.equal(tangent.contacted, true);
  const nearMiss = relativeSegmentContact('p', 'q', { x: 68, y: 27.999 }, { x: 212 / 3, y: 27.999 }, { x: 70, y: 50 }, { x: 70, y: 50 }, 22);
  close(nearMiss.minCenterDistance, 22.001);
  assert.equal(nearMiss.contacted, false);
  // Difference is much smaller than report tolerance; branch must still be false.
  const strictMiss = relativeSegmentContact('p', 'q', { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 2, y: 22 + 1e-11 }, { x: 2, y: 22 + 1e-11 }, 22);
  assert.equal(strictMiss.contacted, false);
  const crossing = relativeSegmentContact('p', 'q', { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 0 }, 1);
  assert.equal(crossing.closestTickFraction, 1 / 2);
  assert.equal(crossing.minCenterDistance, 0);
  assert.equal(crossing.endpointCenterDistance, 4);
  assert.equal(crossing.contacted, true);
  for (const [distance, contacted] of [[22, true], [22.001, false]] as const) {
    const stationary = relativeSegmentContact('p', 'q', { x: 0, y: 0 }, { x: 0, y: 0 }, { x: distance, y: 0 }, { x: distance, y: 0 }, 22);
    assert.equal(stationary.closestTickFraction, 0);
    assert.equal(stationary.minCenterDistance, distance);
    assert.equal(stationary.contacted, contacted);
    assertWitnessShape(stationary);
  }
  const sameVelocity = relativeSegmentContact('p', 'q', { x: 0, y: 0 }, { x: 4, y: 0 }, { x: 0, y: 22 }, { x: 4, y: 22 }, 22);
  assert.equal(sameVelocity.closestTickFraction, 0);
  assert.equal(sameVelocity.contacted, true);
  assert.equal(sameVelocity.minCenterDistance, 22);
});

test('R0-RT-07: three distinct lawful 900-tick runs prove caught > timeout > win', (): void => {
  for (const expectedReason of ['caught', 'timeout', 'win'] as const) {
    const doc = fixture('terminal-conflict');
    if (expectedReason !== 'caught') doc.project.scene.entities = doc.project.scene.entities.filter(entity => entity.id !== 'g1');
    if (expectedReason === 'win') doc.project.rules.timer.enabled = false;
    const states = executeCatalog(playable(doc), 'terminal-conflict', `rt07-${expectedReason}`);
    assert.equal(states.length, 901);
    assert.equal(states[884]!.tick, 884);
    assert.deepEqual(point(states[884]!, 'p'), { x: 20, y: 270 });
    assert.equal(states[899]!.status, 'running');
    assert.equal(states[899]!.score, 0);
    close(point(states[899]!, 'p').x, 60);
    assert.deepEqual(states[899]!.collectedIds, []);
    const state = states[900]!;
    assert.equal(state.tick, 900);
    close(point(state, 'p').x, 188 / 3);
    assert.equal(state.score, 1);
    const end = terminal(state);
    assert.equal(end.tick, 900);
    assert.equal(end.actualValues.reason, expectedReason);
    assert.equal(end.actualValues.result, expectedReason === 'win' ? 'win' : 'fail');
    assert.equal(end.actualValues.goalReached, true);
    assert.equal(end.actualValues.timeout, expectedReason !== 'win');
    assert.equal(end.actualValues.caught, expectedReason === 'caught');
    const collection = ofKind(state, 'reward_collected');
    const scores = ofKind(state, 'score_changed');
    const goals = ofKind(state, 'goal_checked');
    assert.equal(collection.length, 1);
    assert.equal(scores.length, 1);
    assert.equal(goals.length, 1);
    assert.equal(collection[0]!.tick, 900);
    assert.equal(scores[0]!.tick, 900);
    assert.equal(goals[0]!.tick, 900);
    assert.equal(goals[0]!.actualValues.passed, true);
    assert.equal(end.actualValues.goalCheckedEventId, goals[0]!.eventId);
    assert.deepEqual(end.actualValues.contributionEventIds, [scores[0]!.eventId]);
    assert.equal(end.causeId, expectedReason === 'win' ? goals[0]!.eventId : null);
    assert.deepEqual(state.events.filter(event => event.tick === 900).map(event => event.kind), [
      'reward_collected', 'score_changed', 'goal_checked', 'round_ended',
    ]);
    if (expectedReason === 'caught') {
      assert.deepEqual(ofKind(state, 'chase_started').map(event => event.tick), [889]);
      close(point(states[899]!, 'g1').x, 259 / 3);
      close(point(state, 'g1').x, 86);
      assert.deepEqual(end.actualValues.caughtByEntityIds, ['g1']);
      assert.equal(end.actualValues.primaryGuardId, 'g1');
      const witness = end.actualValues.contactWitnesses[0]!;
      assertWitnessShape(witness);
      close(witness.endpointCenterDistance, 70 / 3);
      assert.equal(witness.contacted, true);
      assert.equal(witness.contactThreshold, 26);
    } else {
      assert.deepEqual(ofKind(state, 'chase_started'), []);
      assert.deepEqual(end.actualValues.caughtByEntityIds, []);
      assert.equal(end.actualValues.primaryGuardId, null);
      assert.deepEqual(end.actualValues.contactWitnesses, []);
    }
  }
});

test('R0-RT-13 partial: injected event-budget fault rolls back tick3 after provisional reward work', (): void => {
  let run = start(fixture('single-reward-repeat'), 'rt13-budget-fault', { eventBudget: 1, faultInjection: true });
  run = advance(run, { x: 1, y: 0 });
  run = advance(run, { x: 1, y: 0 });
  const before = run;
  const beforeSnapshot = observedSnapshot(before);
  const failed = advance(run, { x: 1, y: 0 });
  assert.equal(failed.status, 'fault');
  assert.equal(failed.tick, 2);
  assert.equal(failed.score, 0);
  assert.deepEqual(failed.collectedIds, []);
  close(point(failed, 'p').x, 76 / 3);
  assert.deepEqual([...failed.positions], [...before.positions]);
  assert.deepEqual(failed.events, before.events);
  assert.equal(failed.lastEventSequence, before.lastEventSequence);
  assert.deepEqual(ofKind(failed, 'round_ended'), []);
  assert.deepEqual(ofKind(failed, 'reward_collected'), []);
  assert.deepEqual(ofKind(failed, 'score_changed'), []);
  assert.deepEqual(observedSnapshot(before), beforeSnapshot);
  assert.equal(failed.diagnostics.length, 1);
  const diagnostic = failed.diagnostics[0]!;
  assert.equal(diagnostic.kind, 'run_fault');
  assert.equal(diagnostic.attemptedTick, 3);
  assert.equal(diagnostic.lastCommittedTick, 2);
  assert.equal(diagnostic.observationPhase, 'last_committed');
  assert.equal(diagnostic.ruleId, null);
  assert.equal(diagnostic.buildHash, failed.context.buildHash);
  assert.equal(diagnostic.runtimeArtifactHash, failed.context.runtimeArtifactHash);
  close(diagnostic.positions.p!.x, 76 / 3);
  assert.equal(diagnostic.actualValues.faultInjection, true);
  const repeated = advance(failed, { x: 1, y: 0 });
  assert.deepEqual(observedSnapshot(repeated), observedSnapshot(failed));
});

test('R0-RT-13 partial: explicit fault after temporary collect/score cannot leak provisional facts', (): void => {
  let run = start(fixture('single-reward-repeat'), 'rt13-after-score-fault', { failAfterEvents: 2, faultInjection: true });
  run = advance(advance(run, { x: 1, y: 0 }), { x: 1, y: 0 });
  const before = observedSnapshot(run);
  const failed = advance(run, { x: 1, y: 0 });
  assert.equal(failed.status, 'fault');
  assert.equal(failed.tick, 2);
  assert.equal(failed.score, 0);
  assert.deepEqual(failed.collectedIds, []);
  assert.equal(failed.events.length, 1);
  assert.equal(failed.events[0]!.kind, 'run_started');
  assert.equal(failed.lastEventSequence, 1);
  assert.deepEqual([...failed.positions], [...run.positions]);
  assert.deepEqual(observedSnapshot(run), before);
  assert.equal(failed.diagnostics.length, 1);
  assert.equal(failed.diagnostics[0]!.attemptedTick, 3);
});

test('R0-RT-13 Runtime boundary: default 7200 complete ticks then blocked, never fake timeout', (): void => {
  let run = start(fixture('scene-b'), 'rt13-runtime-budget');
  assert.equal(run.options.eventBudget, 256);
  assert.equal(run.options.maxTicks, 7200);
  assert.equal(run.options.faultInjection, false);
  for (let tick = 1; tick <= 7200; tick++) {
    run = advance(run, { x: 0, y: 0 });
    assert.equal(run.tick, tick);
    assert.equal(run.status, 'running');
    assert.equal(run.blocked, tick === 7200);
  }
  const positions = [...run.positions];
  const events = run.events;
  run = advance(run, { x: 1, y: 0 });
  assert.equal(run.tick, 7200);
  assert.equal(run.blocked, true);
  assert.equal(run.budgetExhausted, true);
  assert.equal(run.score, 0);
  assert.deepEqual([...run.positions], positions);
  assert.deepEqual(run.events, events);
  assert.deepEqual(ofKind(run, 'round_ended'), []);
  assert.equal(run.diagnostics.length, 1);
  assert.equal(run.diagnostics[0]!.kind, 'runner_budget');
  assert.equal(run.diagnostics[0]!.lastCommittedTick, 7200);
});

test('R0-RT-13 Runtime boundary: legal timeout at tick7200 has priority over runner cap', (): void => {
  const doc = fixture('scene-b');
  doc.project.rules.timer = { enabled: true, limit: 120 };
  let run = start(playable(doc), 'rt13-legal-budget-terminal');
  for (let tick = 1; tick <= 7200; tick++) {
    run = advance(run, { x: 0, y: 0 });
    assert.equal(run.tick, tick);
  }
  assert.equal(terminal(run).actualValues.reason, 'timeout');
  assert.equal(run.blocked, false);
  assert.equal(run.budgetExhausted, false);
  assert.deepEqual(run.diagnostics, []);
});

test('create requires a complete legal playable document and labels test-only option overrides', (): void => {
  const empty = fixture('scene-b');
  empty.project.scene.entities = empty.project.scene.entities.filter(entity => entity.kind === 'player');
  assert.equal(validatePlayability(empty).playable, false);
  assert.throws(() => createRun(empty, context('reject-empty')));
  const impossible = fixture('scene-b');
  impossible.project.rules.goal.targetScore = 99;
  assert.throws(() => createRun(impossible, context('reject-impossible')));
  assert.throws(() => createRun(null, context('reject-null')));
  assert.throws(() => createRun(fixture('scene-b'), context('reject-unlabelled-budget'), { eventBudget: 1 }));
  assert.throws(() => createRun(fixture('scene-b'), context('reject-unlabelled-failure'), { failAfterEvents: 2 }));
});

test('run creation, step and frozen event positions stay isolated from caller document and prior states', (): void => {
  const original = fixture('single-reward-repeat');
  const originalBefore = structuredClone(original);
  const run = start(original, 'isolation');
  const initialSnapshot = observedSnapshot(run);
  assert.notStrictEqual(run.document, original);
  assert.notStrictEqual(run.document.project.scene.entities, original.project.scene.entities);
  assert.notStrictEqual(run.document.project.rules, original.project.rules);
  original.project.rules.goal.targetScore = 99;
  const originalPlayer = original.project.scene.entities.find(entity => entity.id === 'p');
  assert.ok(originalPlayer);
  originalPlayer.x = 900;
  assert.deepEqual(run.document, originalBefore);
  let advanced = run;
  for (let tick = 1; tick <= 3; tick++) advanced = advance(advanced, { x: 1, y: 0 });
  assert.deepEqual(observedSnapshot(run), initialSnapshot);
  assert.equal(point(run, 'p').x, 20);
  close(point(advanced, 'p').x, 28);
  assert.equal(run.score, 0);
  assert.deepEqual(run.collectedIds, []);
  assert.equal(advanced.score, 1);
  assert.deepEqual(advanced.collectedIds, ['n1']);
  assert.equal(run.events[0]!.positions.p!.x, 20);
  assert.equal(advanced.events[0]!.positions.p!.x, 20);
  const historical = observedSnapshot(advanced);
  assert.throws(() => { advanced.document.project.rules.goal.targetScore = 1; }, TypeError);
  assert.throws(() => { (point(advanced, 'p') as { x: number; y: number }).x = 500; }, TypeError);
  assert.deepEqual(observedSnapshot(advanced), historical);
});

test('run_started and generated events carry exact @3 identity, phase, rule and stable sequence', (): void => {
  const run = executeCatalog(fixture('zero-guard-route'), 'right-3', 'event-contract').at(-1)!;
  const expectedCommon = [
    'actualValues', 'causeId', 'entityIds', 'eventId', 'kind', 'observationPhase',
    'positions', 'projectId', 'revision', 'ruleId', 'runId', 'semanticHash', 'tick',
  ];
  for (const [index, event] of run.events.entries()) {
    assert.deepEqual(Object.keys(event).sort(), expectedCommon);
    assert.equal(event.eventId, `${run.context.runId}:e${index + 1}`);
    assert.equal(event.runId, run.context.runId);
    assert.equal(event.projectId, run.document.project.projectId);
    assert.equal(event.revision, run.document.project.revision);
    assert.equal(event.semanticHash, run.document.project.semanticHash);
    assert.deepEqual(Object.keys(event.positions).sort(), [...event.entityIds].sort());
    assert.deepEqual(event.entityIds, [...new Set(event.entityIds)].sort());
    if (event.causeId !== null) assert.ok(run.events.slice(0, index).some(prior => prior.eventId === event.causeId));
  }
  const initial = ofKind(run, 'run_started')[0]!;
  assert.equal(initial.tick, 0);
  assert.equal(initial.ruleId, null);
  assert.equal(initial.causeId, null);
  assert.equal(initial.observationPhase, 'before_move');
  assert.deepEqual(initial.actualValues, { score: 0, targetScore: 1, timer: { enabled: false, limit: 15 }, guardCount: 0, rewardCount: 1 });
  assert.deepEqual(initial.positions, { p: { x: 20, y: 270 }, n1: { x: 50, y: 270 } });
  const reward = ofKind(run, 'reward_collected')[0]!;
  const score = ofKind(run, 'score_changed')[0]!;
  const goal = ofKind(run, 'goal_checked')[0]!;
  const end = terminal(run);
  for (const event of [reward, score, goal, end]) assert.equal(event.observationPhase, 'after_move');
  assert.equal(reward.ruleId, 'rule.reward.collect@1');
  assert.equal(score.ruleId, 'rule.reward.collect@1');
  assert.equal(goal.ruleId, 'rule.goal.score@1');
  assert.equal(end.ruleId, 'rule.goal.score@1');
  assert.equal(reward.causeId, null);
  assert.equal(score.causeId, reward.eventId);
  assert.equal(goal.causeId, score.eventId);
  assert.equal(end.causeId, goal.eventId);
});

test('R0-RT-14 Runtime loading foundation only: six gameplay candidates and mixed batch run full smoke', (): void => {
  const cases: Array<{ name: string; operations: Operation[] }> = [
    { name: 'goal', operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }] },
    { name: 'rewards', operations: [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }] },
    { name: 'speed', operations: [{ op: 'set_guard_speed', expectedValue: 100, value: 80 }] },
    { name: 'detect', operations: [{ op: 'set_detect_radius', expectedValue: 180, value: 140 }] },
    { name: 'timer', operations: [{ op: 'set_timer', expectedValue: { enabled: false, limit: 45 }, value: { enabled: true, limit: 30 } }] },
    { name: 'position', operations: [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: 660, y: 190 }, value: { x: 540, y: 220 } }] },
    { name: 'mixed', operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }, { op: 'set_detect_radius', expectedValue: 180, value: 140 }] },
  ];
  for (const item of cases) {
    const base = fixture('scene-a');
    const candidate = applyOperations(base, item.operations);
    const states = executeCatalog(candidate, 'smoke', `rt14-foundation-${item.name}`);
    assert.equal(states.length, 181);
    const initial = states[0]!;
    const run = states.at(-1)!;
    assert.deepEqual(initial.document, candidate);
    assert.deepEqual(run.document, candidate);
    assert.equal(run.tick, 180);
    assert.equal(run.status, 'running');
    assert.equal(run.blocked, false);
    assert.deepEqual(run.diagnostics, []);
    assert.equal(ofKind(run, 'run_started').length, 1);
    assert.equal(initial.context.runId, `synthetic-unit-rt14-foundation-${item.name}`);
    for (const entity of candidate.project.scene.entities) assert.deepEqual(point(initial, entity.id), { x: entity.x, y: entity.y });
    const started = ofKind(run, 'run_started')[0]!;
    assert.equal(started.actualValues.targetScore, candidate.project.rules.goal.targetScore);
    assert.deepEqual(started.actualValues.timer, candidate.project.rules.timer);
    for (const event of run.events) assert.equal(event.semanticHash, candidate.project.semanticHash);
  }
  // No pure-theme fictitious run is constructed here; T05 owns the static-only
  // runtime_not_applicable/trial/candidateHash/confirmation qualification path.
});
