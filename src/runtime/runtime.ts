import { assertDocument, DomainError, ENTITY_RADII, validatePlayability } from '../domain/index.js';
import type { Entity } from '../domain/types.js';
import { asciiCompare, deepFreeze, FrozenMap, FrozenSet } from './immutable.js';
import { finite, relativeSegmentContact, RuntimeFault } from './geometry.js';
import type {
  ContactWitness, Direction, EventKind, EventValues, GameplayEvent, Point, ResolvedRunOptions,
  RunContext, RunOptions, RunResult, RunState, RuntimeDiagnostic, Terminal,
} from './types.js';

export const FIXED_DT = 1 / 60;
export const PLAYER_SPEED = 160;
export const PRODUCTION_EVENT_BUDGET = 256;
export const PRODUCTION_MAX_TICKS = 7200;
export const RUNTIME_VERSIONS = deepFreeze({
  evidenceVersion: 'collect-chase-evidence@3', runtimeVersion: 'collect-chase@1',
  ruleRegistryVersion: 'collect-chase-rules@1', entityBudgetPolicyVersion: 'entity-budget@1',
  trialPolicyVersion: 'collect-chase-candidate-trial@2', contractVersion: 'nodon-r0-runtime-contract@1',
} as const);

function reject(code: string, message: string): never {
  throw new DomainError(code, [{ code, path: '', message }]);
}
function resolveContext(input: RunContext): RunContext {
  const fields = ['runId', 'generation', 'buildHash', 'runtimeArtifactHash', 'environmentId', 'evidenceSource', 'inputSource', 'executionClass'];
  if (input === null || typeof input !== 'object' || Object.keys(input).length !== fields.length || fields.some(key => !Object.hasOwn(input, key))) reject('E_RUN_CONTEXT', 'Exact runtime context required');
  if (typeof input.runId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,95}(?![\s\S])/.test(input.runId)) reject('E_RUN_CONTEXT', 'Invalid runId');
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) reject('E_RUN_CONTEXT', 'Invalid generation');
  for (const hash of [input.buildHash, input.runtimeArtifactHash]) if (typeof hash !== 'string' || !/^sha256:[a-f0-9]{64}(?![\s\S])/.test(hash)) reject('E_RUN_CONTEXT', 'Invalid build or runtime artifact hash');
  if (typeof input.environmentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}(?![\s\S])/.test(input.environmentId)) reject('E_RUN_CONTEXT', 'Invalid environmentId');
  if (!['actual_author_run', 'machine_test', 'replay'].includes(input.evidenceSource) ||
      !['human_keyboard', 'machine_browser_input', 'catalog_machine'].includes(input.inputSource) ||
      !['automation_test', 'human_operation'].includes(input.executionClass)) reject('E_RUN_CONTEXT', 'Invalid provenance');
  return deepFreeze({ ...input });
}
function resolveOptions(input: RunOptions = {}): ResolvedRunOptions {
  if (input === null || typeof input !== 'object' || Object.keys(input).some(key => !['eventBudget', 'maxTicks', 'faultInjection', 'failAfterEvents'].includes(key))) reject('E_RUN_OPTIONS', 'Invalid runtime options');
  const eventBudget = input.eventBudget ?? PRODUCTION_EVENT_BUDGET;
  const maxTicks = input.maxTicks ?? PRODUCTION_MAX_TICKS;
  const faultInjection = input.faultInjection ?? false;
  const failAfterEvents = input.failAfterEvents ?? null;
  if (typeof faultInjection !== 'boolean' || !Number.isSafeInteger(eventBudget) || eventBudget < 1 || eventBudget > PRODUCTION_EVENT_BUDGET ||
      !Number.isSafeInteger(maxTicks) || maxTicks < 1 || maxTicks > PRODUCTION_MAX_TICKS ||
      (failAfterEvents !== null && (!Number.isSafeInteger(failAfterEvents) || failAfterEvents < 1 || failAfterEvents > PRODUCTION_EVENT_BUDGET))) reject('E_RUN_OPTIONS', 'Runtime budgets must be within production ceilings');
  if ((eventBudget !== PRODUCTION_EVENT_BUDGET || maxTicks !== PRODUCTION_MAX_TICKS || failAfterEvents !== null) && !faultInjection) reject('E_FAULT_INJECTION_REQUIRED', 'Non-default budgets or assertion faults require explicit faultInjection=true');
  return deepFreeze({ eventBudget, maxTicks, faultInjection, failAfterEvents });
}
function positionsRecord(positions: ReadonlyMap<string, Point>, ids: readonly string[] = [...positions.keys()].sort(asciiCompare)): Readonly<Record<string, Point>> {
  const output: Record<string, Point> = {};
  for (const id of ids) {
    const point = positions.get(id);
    if (!point) throw new RuntimeFault('E_RUNTIME_STATE', 'Missing entity position');
    Object.defineProperty(output, id, { value: { x: point.x, y: point.y }, enumerable: true, writable: true, configurable: true });
  }
  return deepFreeze(output);
}
function freezeState(state: RunState): RunState {
  return Object.freeze({ ...state,
    positions: new FrozenMap([...state.positions].map(([id, point]) => [id, deepFreeze({ x: point.x, y: point.y })] as const)),
    collectedIds: new FrozenSet([...state.collectedIds].sort(asciiCompare)),
    chasingGuardIds: new FrozenSet([...state.chasingGuardIds].sort(asciiCompare)),
    terminal: state.terminal === null ? null : deepFreeze({ ...state.terminal, caughtByEntityIds: [...state.terminal.caughtByEntityIds] }),
  });
}
function result(state: RunState, events: GameplayEvent[] = [], diagnostics: RuntimeDiagnostic[] = []): RunResult {
  return Object.freeze({ state, events: Object.freeze(events), diagnostics: Object.freeze(diagnostics), blocked: state.budgetExhausted });
}
function makeEvent<K extends EventKind>(state: RunState, sequence: number, tick: number, kind: K, values: EventValues[K], ids: readonly string[],
  positions: ReadonlyMap<string, Point>, phase: 'before_move' | 'after_move', ruleId: string | null, causeId: string | null): GameplayEvent {
  const entityIds = [...new Set(ids)].sort(asciiCompare);
  const project = state.document.project;
  return deepFreeze({ eventId: `${state.context.runId}:e${sequence}`, runId: state.context.runId,
    projectId: project.projectId, revision: project.revision, semanticHash: project.semanticHash,
    tick, kind, entityIds, causeId, actualValues: values, ruleId,
    positions: positionsRecord(positions, entityIds), observationPhase: phase,
  }) as GameplayEvent;
}
function diagnosticBase(state: RunState, attemptedTick: number) {
  return { diagnosticId: `${state.context.runId}:d${state.lastDiagnosticSequence + 1}`, runId: state.context.runId,
    projectId: state.document.project.projectId, revision: state.document.project.revision,
    semanticHash: state.document.project.semanticHash, buildHash: state.context.buildHash,
    runtimeArtifactHash: state.context.runtimeArtifactHash, attemptedTick, lastCommittedTick: state.tick,
    ruleId: null, observationPhase: 'last_committed', positions: positionsRecord(state.positions),
  } as const;
}

/** Creates tick zero and one genuine run_started. Document validation is owned by domain. */
export function createRun(input: unknown, inputContext: RunContext, inputOptions?: RunOptions): RunResult {
  const document = deepFreeze(assertDocument(input));
  const playable = validatePlayability(document);
  if (!playable.playable) throw new DomainError(playable.errors[0]?.code ?? 'E_NOT_PLAYABLE', playable.errors);
  const context = resolveContext(inputContext), options = resolveOptions(inputOptions);
  const entities = document.project.scene.entities;
  const state = freezeState({ document, context, options, tick: 0, status: 'running',
    positions: new Map(entities.map(entity => [entity.id, { x: entity.x, y: entity.y }])),
    collectedIds: new Set(), chasingGuardIds: new Set(), score: 0, terminal: null,
    lastEventSequence: 1, lastDiagnosticSequence: 0, budgetExhausted: false,
  });
  const event = makeEvent(state, 1, 0, 'run_started', { score: 0, targetScore: document.project.rules.goal.targetScore,
    timer: { ...document.project.rules.timer }, guardCount: entities.filter(entity => entity.kind === 'guard').length,
    rewardCount: playable.rewardCount }, entities.map(entity => entity.id), state.positions, 'before_move', null, null);
  return result(state, [event]);
}

function moved(start: Point, dx: number, dy: number): Point {
  const x = start.x + dx, y = start.y + dy;
  finite(dx, dy, x, y);
  return { x: Math.min(940, Math.max(20, x)), y: Math.min(520, Math.max(20, y)) };
}
function at(positions: ReadonlyMap<string, Point>, id: string): Point {
  const point = positions.get(id);
  if (!point) throw new RuntimeFault('E_RUNTIME_STATE', 'Missing entity position');
  finite(point.x, point.y); return point;
}
function assertNext(state: RunState, positions: ReadonlyMap<string, Point>, collected: ReadonlySet<string>, score: number, chasing: ReadonlySet<string>): void {
  if (positions.size !== state.document.project.scene.entities.length || !Number.isSafeInteger(score) || score < 0) throw new RuntimeFault('E_RUNTIME_ASSERTION', 'Invalid dynamic state');
  let expectedScore = 0;
  const validRewards = new Set<string>(), validGuards = new Set<string>();
  for (const entity of state.document.project.scene.entities) {
    const point = at(positions, entity.id);
    if (point.x < 20 || point.x > 940 || point.y < 20 || point.y > 520) throw new RuntimeFault('E_RUNTIME_ASSERTION', 'Position outside world');
    if (entity.kind === 'normal' || entity.kind === 'high') {
      validRewards.add(entity.id);
      if (point.x !== entity.x || point.y !== entity.y) throw new RuntimeFault('E_RUNTIME_ASSERTION', 'Reward moved');
      if (collected.has(entity.id)) expectedScore += entity.kind === 'normal' ? state.document.project.rules.rewards.normalValue : state.document.project.rules.rewards.highValue;
    } else if (entity.kind === 'guard') validGuards.add(entity.id);
  }
  if ([...collected].some(id => !validRewards.has(id)) || [...chasing].some(id => !validGuards.has(id)) || score !== expectedScore) throw new RuntimeFault('E_RUNTIME_ASSERTION', 'Score or entity membership mismatch');
}

/** Pure single fixed tick. The caller owns scheduling, logs, transport, pause diagnostics and IO. */
export function stepRun(state: RunState, input: Direction): RunResult {
  if (state.status !== 'running' || state.budgetExhausted) return result(state);
  const tick = state.tick + 1;
  try {
    if (input === null || typeof input !== 'object' || Object.keys(input).length !== 2 || !Object.hasOwn(input, 'x') || !Object.hasOwn(input, 'y') ||
        ![-1, 0, 1].includes(input.x) || ![-1, 0, 1].includes(input.y)) throw new RuntimeFault('E_RUNTIME_INPUT', 'Direction requires x/y in -1,0,1');
    if (!Number.isSafeInteger(tick) || tick > state.options.maxTicks) throw new RuntimeFault('E_RUNTIME_ASSERTION', 'Unreachable tick budget state');
    const entities = [...state.document.project.scene.entities].sort((a, b) => asciiCompare(a.id, b.id));
    const player = entities.find(entity => entity.kind === 'player');
    if (!player) throw new RuntimeFault('E_RUNTIME_STATE', 'Missing player');
    const guards = entities.filter(entity => entity.kind === 'guard');
    const before = state.positions, positions = new Map(before), chasing = new Set<string>(), collected = new Set(state.collectedIds);
    let score = state.score;
    const events: GameplayEvent[] = [];
    const emit = <K extends EventKind>(kind: K, values: EventValues[K], ids: readonly string[], phase: 'before_move' | 'after_move', ruleId: string | null, causeId: string | null): string => {
      const event = makeEvent(state, state.lastEventSequence + events.length + 1, tick, kind, values, ids, phase === 'before_move' ? before : positions, phase, ruleId, causeId);
      events.push(event);
      if (events.length > state.options.eventBudget) throw new RuntimeFault('E_TICK_EVENT_BUDGET', 'Per-tick event budget exceeded');
      if (state.options.failAfterEvents !== null && events.length >= state.options.failAfterEvents) throw new RuntimeFault('E_INJECTED_ASSERTION', 'Explicit injected tick assertion fault');
      return event.eventId;
    };
    const playerStart = at(before, player.id), norm = Math.sqrt(input.x * input.x + input.y * input.y);
    positions.set(player.id, moved(playerStart, norm === 0 ? 0 : input.x / norm * PLAYER_SPEED / 60, norm === 0 ? 0 : input.y / norm * PLAYER_SPEED / 60));
    const rules = state.document.project.rules;
    for (const guard of guards) {
      const guardStart = at(before, guard.id), dx = playerStart.x - guardStart.x, dy = playerStart.y - guardStart.y;
      const distanceSquared = dx * dx + dy * dy, detectSquared = rules.guards.detectRadius ** 2;
      finite(dx, dy, distanceSquared, detectSquared);
      const isChasing = distanceSquared <= detectSquared, distance = Math.sqrt(distanceSquared);
      if (isChasing) chasing.add(guard.id);
      if (isChasing !== state.chasingGuardIds.has(guard.id)) {
        const values = { guardId: guard.id, centerDistance: distance, detectRadius: rules.guards.detectRadius, speed: rules.guards.speed };
        if (isChasing) emit('chase_started', { ...values, chasing: true }, [player.id, guard.id], 'before_move', 'rule.guard.chase@1', null);
        else emit('chase_stopped', { ...values, chasing: false }, [player.id, guard.id], 'before_move', 'rule.guard.chase@1', null);
      }
      positions.set(guard.id, isChasing && distance !== 0 ? moved(guardStart, dx / distance * rules.guards.speed / 60, dy / distance * rules.guards.speed / 60) : { ...guardStart });
    }
    const witness = (target: Entity): ContactWitness => relativeSegmentContact(player.id, target.id, playerStart, at(positions, player.id),
      at(before, target.id), at(positions, target.id), ENTITY_RADII.player + ENTITY_RADII[target.kind]);
    const contributions: string[] = [], contributingRewards: string[] = [];
    for (const reward of entities) {
      if ((reward.kind !== 'normal' && reward.kind !== 'high') || collected.has(reward.id)) continue;
      const contact = witness(reward); if (!contact.contacted) continue;
      collected.add(reward.id);
      const value = reward.kind === 'normal' ? rules.rewards.normalValue : rules.rewards.highValue;
      const collectId = emit('reward_collected', { rewardId: reward.id, rewardKind: reward.kind, value, firstCollection: true, contactWitnesses: [contact] },
        [player.id, reward.id], 'after_move', 'rule.reward.collect@1', null);
      const scoreBefore = score; score += value;
      contributions.push(emit('score_changed', { rewardId: reward.id, rewardKind: reward.kind, value, scoreBefore, scoreAfter: score, delta: value },
        [player.id, reward.id], 'after_move', 'rule.reward.collect@1', collectId));
      contributingRewards.push(reward.id);
    }
    const goalReached = score >= rules.goal.targetScore;
    const goalId = contributions.length === 0 ? null : emit('goal_checked', { score, targetScore: rules.goal.targetScore, passed: goalReached, contributionEventIds: [...contributions] },
      [player.id, ...contributingRewards], 'after_move', 'rule.goal.score@1', contributions[contributions.length - 1] ?? null);
    const contacts = guards.map(witness).filter(contact => contact.contacted);
    const caughtByEntityIds = contacts.map(contact => contact.entityIds[1]);
    const caught = caughtByEntityIds.length > 0, timeout = rules.timer.enabled && tick >= rules.timer.limit * 60;
    let terminal: Terminal | null = null;
    if (caught || timeout || goalReached) {
      const reason = caught ? 'caught' : timeout ? 'timeout' : 'win';
      terminal = { reason, caught, timeout, goalReached, caughtByEntityIds, primaryGuardId: caughtByEntityIds[0] ?? null };
      emit('round_ended', { ...terminal, score, targetScore: rules.goal.targetScore, result: reason === 'win' ? 'win' : 'fail',
        contactWitnesses: contacts, contributionEventIds: [...contributions], goalCheckedEventId: goalId },
        [player.id, ...caughtByEntityIds], 'after_move', reason === 'caught' ? 'rule.contact.fail@1' : reason === 'timeout' ? 'rule.timer.limit@1' : 'rule.goal.score@1', reason === 'win' ? goalId : null);
    }
    assertNext(state, positions, collected, score, chasing);
    const budgetExhausted = terminal === null && tick === state.options.maxTicks;
    const next = freezeState({ ...state, tick, status: terminal === null ? 'running' : 'ended', positions, collectedIds: collected,
      chasingGuardIds: chasing, score, terminal, lastEventSequence: state.lastEventSequence + events.length,
      budgetExhausted, lastDiagnosticSequence: state.lastDiagnosticSequence + (budgetExhausted ? 1 : 0) });
    if (budgetExhausted) {
      // A runner limit is separate from the gameplay terminal. This tick is fully committed first.
      const diagnostic = deepFreeze({ ...diagnosticBase({ ...next, lastDiagnosticSequence: state.lastDiagnosticSequence }, tick + 1),
        kind: 'runner_budget' as const, actualValues: { code: 'E_RUNNER_BUDGET' as const, maxTicks: state.options.maxTicks, faultInjection: state.options.faultInjection } });
      return result(next, events, [diagnostic]);
    }
    return result(next, events);
  } catch (error) {
    const code = error instanceof RuntimeFault ? error.code : 'E_RUNTIME_ASSERTION';
    // Never propagate arbitrary caught error text into evidence (could contain host internals).
    const message = error instanceof RuntimeFault ? error.message : 'Runtime tick assertion failed';
    const diagnostic = deepFreeze({ ...diagnosticBase(state, tick), kind: 'run_fault' as const,
      actualValues: { code, message, faultInjection: state.options.faultInjection } });
    const failed = freezeState({ ...state, status: 'fault', lastDiagnosticSequence: state.lastDiagnosticSequence + 1 });
    return result(failed, [], [diagnostic]);
  }
}

export function pauseRun(state: RunState): RunState {
  return state.status === 'running' && !state.budgetExhausted ? freezeState({ ...state, status: 'paused' }) : state;
}
export function resumeRun(state: RunState): RunState {
  return state.status === 'paused' && !state.budgetExhausted ? freezeState({ ...state, status: 'running' }) : state;
}
export function invalidateRun(state: RunState): RunState {
  return state.status === 'invalidated' ? state : freezeState({ ...state, status: 'invalidated' });
}

/** Explicit JSON projection for host snapshots and T03 export. No dynamic Map/Set is lost. */
export function snapshotRun(state: RunState) {
  return deepFreeze({ document: state.document, context: state.context, options: state.options,
    tick: state.tick, status: state.status, positions: positionsRecord(state.positions),
    collectedIds: [...state.collectedIds].sort(asciiCompare), chasingGuardIds: [...state.chasingGuardIds].sort(asciiCompare),
    score: state.score, terminal: state.terminal, lastEventSequence: state.lastEventSequence,
    lastDiagnosticSequence: state.lastDiagnosticSequence, budgetExhausted: state.budgetExhausted,
  });
}
