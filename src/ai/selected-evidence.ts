import { canonicalJson, canonicalSHA256 } from '../domain/index.js';
import { R0Host } from '../host/r0-host.js';
import { observeEvents } from '../host/run-session.js';
import type { ContactWitness, GameplayEvent, Point } from '../runtime/index.js';
import type { AiAuthority } from './authority.js';
import { AiError, type SubmitRequest } from './types.js';

export const SELECTED_EVIDENCE_VERSION = 'nodon-r0-selected-evidence@1' as const;
export const SELECTED_EVIDENCE_CONTRACT = Object.freeze({ version: SELECTED_EVIDENCE_VERSION, maxEvents: 12, maxUtf8Bytes: 8000,
  evidenceVersion: 'collect-chase-evidence@3', fields: ['shared original run/project/revision/hash/context/build identity', 'per-event eventId/tick/kind/phase', 'actualValues whitelist', 'positions', 'cause availability', 'original run rules', 'truncation counts'],
  forbidden: ['frames', 'inputs', 'controls', 'diagnostics', 'paths', 'author text', 'session', 'writer', 'credentials'] });
export const SELECTED_EVIDENCE_CONTRACT_HASH = canonicalSHA256(SELECTED_EVIDENCE_CONTRACT);
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function positions(input: Readonly<Record<string, Point>>): Record<string, Point> {
  return Object.fromEntries(Object.entries(input).map(([id, point]) => [id, { x: point.x, y: point.y }]));
}
function witness(w: ContactWitness) { return { entityIds: [...w.entityIds], startPositions: positions(w.startPositions), endPositions: positions(w.endPositions),
  closestTickFraction: w.closestTickFraction, minCenterDistance: w.minCenterDistance, contactThreshold: w.contactThreshold,
  endpointCenterDistance: w.endpointCenterDistance, contacted: w.contacted }; }
/** Explicit field copies: future internal metadata is not silently sent to a provider. */
function values(event: GameplayEvent): unknown {
  switch (event.kind) {
    case 'run_started': { const a = event.actualValues; return { score: a.score, targetScore: a.targetScore, timer: { enabled: a.timer.enabled, limit: a.timer.limit }, guardCount: a.guardCount, rewardCount: a.rewardCount }; }
    case 'chase_started': case 'chase_stopped': { const a = event.actualValues; return { guardId: a.guardId, centerDistance: a.centerDistance, detectRadius: a.detectRadius, speed: a.speed, chasing: a.chasing }; }
    case 'reward_collected': { const a = event.actualValues; return { rewardId: a.rewardId, rewardKind: a.rewardKind, value: a.value, firstCollection: a.firstCollection, contactWitnesses: a.contactWitnesses.map(witness) }; }
    case 'score_changed': { const a = event.actualValues; return { rewardId: a.rewardId, rewardKind: a.rewardKind, value: a.value, scoreBefore: a.scoreBefore, scoreAfter: a.scoreAfter, delta: a.delta }; }
    case 'goal_checked': { const a = event.actualValues; return { score: a.score, targetScore: a.targetScore, passed: a.passed, contributionEventIds: [...a.contributionEventIds] }; }
    case 'round_ended': { const a = event.actualValues; return { reason: a.reason, result: a.result, score: a.score, targetScore: a.targetScore, goalReached: a.goalReached, caught: a.caught, timeout: a.timeout,
      caughtByEntityIds: [...a.caughtByEntityIds], primaryGuardId: a.primaryGuardId, contactWitnesses: a.contactWitnesses.map(witness), contributionEventIds: [...a.contributionEventIds], goalCheckedEventId: a.goalCheckedEventId }; }
  }
}
interface EvidenceBinding { host: R0Host; requestBinding: string; runId: string; generation: number; originalDocument: string; digest: string; projection: Readonly<Record<string, unknown>>; ids: readonly string[] }
const bindings = new WeakMap<object, EvidenceBinding>();
function requestBinding(request: SubmitRequest): string { return canonicalJson({ requestId: request.requestId, snapshot: request.snapshot, document: request.document }); }
function requireBinding(request: SubmitRequest): EvidenceBinding | null {
  if (request.snapshot.selectedEvidenceRefs.length === 0) { if (bindings.has(request)) throw new AiError('E_SELECTED_EVIDENCE_CHANGED'); return null; }
  const binding = bindings.get(request);
  if (!binding || binding.requestBinding !== requestBinding(request)) throw new AiError('E_SELECTED_EVIDENCE_TRUST');
  return binding;
}
/** Node coordinator only. Takes the owning Host, never a caller-supplied RunSnapshot or JSON projection. */
export function bindSelectedEvidence(request: SubmitRequest, host: R0Host, eventIds: readonly string[]): SubmitRequest {
  if (!(host instanceof R0Host)) throw new AiError('E_SELECTED_EVIDENCE_HOST');
  host.queue.assertActive();
  if (!Array.isArray(eventIds) || eventIds.length < 1 || eventIds.length > 12 || eventIds.some(id => typeof id !== 'string') || new Set(eventIds).size !== eventIds.length) throw new AiError('E_SELECTED_EVIDENCE_IDS');
  if (bindings.has(request) || request.snapshot.selectedEvidenceRefs.length !== 0) throw new AiError('E_SELECTED_EVIDENCE_CHANGED');
  const run = host.currentRun();
  if (!run || run.status === 'invalidated' || run.status === 'fault' || run.budgetExhausted || run.diagnostics.length !== 0) throw new AiError('E_SELECTED_EVIDENCE_RUN');
  const build = host.buildIdentity();
  if (run.context.buildHash !== build.buildHash || run.context.runtimeArtifactHash !== build.runtimeArtifactHash || run.context.environmentId !== build.environmentId) throw new AiError('E_SELECTED_EVIDENCE_BUILD');
  const originalDocument = canonicalJson(run.document);
  if (originalDocument !== canonicalJson(request.document) || originalDocument !== canonicalJson(host.document()) || request.snapshot.projectId !== run.document.project.projectId ||
    request.snapshot.baseRevision !== run.document.project.revision || request.snapshot.baseSemanticHash !== run.document.project.semanticHash) throw new AiError('E_SELECTED_EVIDENCE_BASE');
  const available = new Map(run.events.map(e => [e.eventId, e])); const selected = new Set(eventIds);
  const events = eventIds.map(id => {
    const event = available.get(id);
    if (!event || event.runId !== run.context.runId || event.projectId !== run.document.project.projectId || event.revision !== run.document.project.revision || event.semanticHash !== run.document.project.semanticHash || event.tick > run.tick) throw new AiError('E_SELECTED_EVIDENCE_IDS');
    const observed = observeEvents(run.events, run.truncation, [id])[0]!;
    const references = [event.causeId, ...('contributionEventIds' in event.actualValues ? event.actualValues.contributionEventIds : []), ...('goalCheckedEventId' in event.actualValues ? [event.actualValues.goalCheckedEventId] : [])].filter((v): v is string => v !== null);
    return { eventId: event.eventId, tick: event.tick, kind: event.kind,
      entityIds: [...event.entityIds], causeId: event.causeId, ruleId: event.ruleId, observationPhase: event.observationPhase, positions: positions(event.positions), actualValues: values(event),
      causeStatus: observed.causeStatus, missingCause: [...observed.missingCause], unselectedCause: [...new Set(references.filter(ref => !selected.has(ref)))] };
  });
  const rules = run.document.project.rules; const trunc = run.truncation;
  const projection = freeze({ version: SELECTED_EVIDENCE_VERSION, evidenceVersion: 'collect-chase-evidence@3',
    runContext: { buildHash: run.context.buildHash, runtimeArtifactHash: run.context.runtimeArtifactHash, environmentId: run.context.environmentId, evidenceSource: run.context.evidenceSource, inputSource: run.context.inputSource, executionClass: run.context.executionClass }, contractHash: SELECTED_EVIDENCE_CONTRACT_HASH, coverage: 'selected_actual_events',
    projectId: run.document.project.projectId, runId: run.context.runId, revision: run.document.project.revision, semanticHash: run.document.project.semanticHash,
    runtimeVersion: run.document.runtimeVersion, rules: { goal: { targetScore: rules.goal.targetScore }, rewards: { normalValue: rules.rewards.normalValue, highValue: rules.rewards.highValue }, guards: { speed: rules.guards.speed, detectRadius: rules.guards.detectRadius }, timer: { enabled: rules.timer.enabled, limit: rules.timer.limit } },
    truncation: { capacity: trunc.capacity, totalCommittedEvents: trunc.totalCommittedEvents, droppedCount: trunc.droppedCount, firstRetainedSequence: trunc.firstRetainedSequence, lastRetainedSequence: trunc.lastRetainedSequence, droppedThroughTick: trunc.droppedThroughTick }, events });
  if (Buffer.byteLength(canonicalJson(projection), 'utf8') > 8000) throw new AiError('E_SELECTED_EVIDENCE_BUDGET');
  request.snapshot.selectedEvidenceRefs = [...eventIds];
  bindings.set(request, { host, requestBinding: requestBinding(request), runId: run.context.runId, generation: run.context.generation, originalDocument, digest: canonicalSHA256(projection), projection, ids: freeze([...eventIds]) });
  return request;
}
/** Called only after strict request validation clones the JSON fields. A JSON clone alone has no capability. */
export function carrySelectedEvidence(input: object, clone: SubmitRequest): void {
  const original = input as SubmitRequest; const binding = requireBinding(original);
  if (binding) { if (binding.requestBinding !== requestBinding(clone)) throw new AiError('E_SELECTED_EVIDENCE_CHANGED'); bindings.set(clone, binding); }
}
export function assertSelectedEvidence(request: SubmitRequest, authority: AiAuthority, host?: R0Host): void {
  const binding = requireBinding(request); if (!binding) return;
  authority.queue.assertActive();
  if (binding.host !== host || binding.host.queue !== authority.queue || !binding.host.authorizes(request.snapshot)) throw new AiError('E_SELECTED_EVIDENCE_HOST');
  const run = binding.host.currentRun();
  if (!run || run.context.runId !== binding.runId || run.context.generation !== binding.generation || run.status === 'invalidated' || run.status === 'fault' || run.budgetExhausted || run.diagnostics.length !== 0 ||
    canonicalJson(run.document) !== binding.originalDocument || canonicalJson(binding.host.document()) !== binding.originalDocument || binding.ids.some(id => !run.events.some(e => e.eventId === id))) throw new AiError('E_SELECTED_EVIDENCE_STALE');
}
export function selectedEvidenceProjection(request: SubmitRequest): Readonly<Record<string, unknown>> { return requireBinding(request)?.projection ?? { coverage: 'none', events: [] }; }
export function selectedEvidenceDigest(request: SubmitRequest): string | null { return requireBinding(request)?.digest ?? null; }
export function selectedEvidenceIds(request: SubmitRequest): readonly string[] { return requireBinding(request)?.ids ?? []; }
