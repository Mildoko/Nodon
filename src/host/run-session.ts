import { canonicalJson, type Document } from '../domain/index.js';
import { createRun, stepRun, pauseRun, resumeRun, invalidateRun, snapshotRun,
  type Direction, type GameplayEvent, type RunContext, type RunOptions, type RunState, type RuntimeDiagnostic } from '../runtime/index.js';

function copy<T>(value: T): T { return structuredClone(value); }
function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
export interface Truncation {
  capacity: number; totalCommittedEvents: number; droppedCount: number;
  firstRetainedSequence: number | null; lastRetainedSequence: number | null; droppedThroughTick: number | null;
}
interface RingEvent { readonly eventId: string; readonly tick: number }
export function eventSequence(id: string): number {
  const match = /:e([1-9][0-9]*)$/.exec(id);
  const sequence = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(sequence)) throw new Error('E_EVENT_SEQUENCE');
  return sequence;
}
/** Pure buffer; synthetic unit probes must never be exported as actual Runtime runs. */
export class EventRing<T extends RingEvent = GameplayEvent> {
  readonly capacity: number;
  #events: T[] = [];
  #total = 0;
  #droppedThroughTick: number | null = null;
  #runPrefix: string | null = null;
  constructor(capacity = 1000) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1000) throw new Error('E_RING_CAPACITY');
    this.capacity = capacity;
  }
  append(events: readonly T[]): void {
    let sequence = this.#total;
    let prefix = this.#runPrefix;
    for (const event of events) {
      const candidatePrefix = event.eventId.slice(0, event.eventId.lastIndexOf(':e'));
      if (eventSequence(event.eventId) !== ++sequence || !Number.isSafeInteger(event.tick) || event.tick < 0 ||
        (prefix !== null && prefix !== candidatePrefix)) throw new Error('E_EVENT_SEQUENCE');
      prefix = candidatePrefix;
    }
    this.#runPrefix = prefix;
    for (const event of events) {
      this.#events.push(freeze(copy(event))); this.#total++;
      if (this.#events.length > this.capacity) this.#droppedThroughTick = this.#events.shift()!.tick;
    }
  }
  snapshot(): { events: readonly T[]; truncation: Truncation } {
    return Object.freeze({ events: Object.freeze([...this.#events]), truncation: Object.freeze({
      capacity: this.capacity, totalCommittedEvents: this.#total, droppedCount: this.#total - this.#events.length,
      firstRetainedSequence: this.#events.length ? eventSequence(this.#events[0]!.eventId) : null,
      lastRetainedSequence: this.#events.length ? eventSequence(this.#events[this.#events.length - 1]!.eventId) : null,
      droppedThroughTick: this.#droppedThroughTick,
    }) });
  }
}
export interface ConsumedInput { tick: number; direction: Direction; committed: boolean; lastCommittedTick: number }
export interface RunInput { runId: string; generation: number; direction: Direction }
export type RuntimeSnapshot = ReturnType<typeof snapshotRun>;
export type TickFrame = Omit<RuntimeSnapshot, 'document' | 'context' | 'options'>;
export interface RunControl { afterInput: number; action: 'pause' | 'resume' | 'invalidate' }
export type RunSnapshot = RuntimeSnapshot & {
  events: readonly GameplayEvent[]; diagnostics: readonly RuntimeDiagnostic[]; inputs: readonly ConsumedInput[];
  frames: readonly TickFrame[]; controls: readonly RunControl[]; truncation: Truncation;
};
function frame(state: RunState): TickFrame {
  const { document: _document, context: _context, options: _options, ...dynamic } = snapshotRun(state);
  return Object.freeze(dynamic);
}
/** Read-only event view. Missing causes remain missing; no inferred gameplay event is created. */
export function observeEvents(events: readonly GameplayEvent[], truncation: Truncation, selectedIds?: readonly string[]) {
  const retained = new Set(events.map(event => event.eventId));
  if (selectedIds && selectedIds.some(id => !retained.has(id))) throw new Error('E_EVENT_NOT_RETAINED');
  const selected = selectedIds ? new Set(selectedIds) : null;
  return freeze(copy(events.filter(event => selected === null || selected.has(event.eventId)).map(event => {
    const references: string[] = event.causeId === null ? [] : [event.causeId];
    if ('contributionEventIds' in event.actualValues) references.push(...event.actualValues.contributionEventIds);
    if ('goalCheckedEventId' in event.actualValues && event.actualValues.goalCheckedEventId !== null) references.push(event.actualValues.goalCheckedEventId);
    const missingCause = [...new Set(references.filter(id => !retained.has(id)))];
    const truncated = missingCause.length > 0 && missingCause.every(id => {
      const sequence = eventSequence(id);
      return id.slice(0, id.lastIndexOf(':e')) === event.runId && sequence <= truncation.droppedCount;
    });
    return { event, missingCause, causeStatus: missingCause.length === 0 ? 'complete' as const : truncated ? 'truncated' as const : 'unknown' as const };
  })));
}
/** Owns one immutable launch document and its Runtime state, never the writable project. */
export class RunSession {
  #state: RunState;
  readonly #ring = new EventRing();
  readonly #diagnostics: RuntimeDiagnostic[] = [];
  readonly #inputs: ConsumedInput[] = [];
  readonly #frames: TickFrame[] = [];
  readonly #controls: RunControl[] = [];
  constructor(document: Document, context: RunContext, options?: RunOptions) {
    const result = createRun(document, context, options);
    this.#state = result.state; this.#ring.append(result.events); this.#frames.push(frame(this.#state));
  }
  snapshot(): RunSnapshot {
    return Object.freeze({ ...snapshotRun(this.#state), ...this.#ring.snapshot(), diagnostics: Object.freeze([...this.#diagnostics]),
      inputs: Object.freeze([...this.#inputs]), frames: Object.freeze([...this.#frames]), controls: Object.freeze([...this.#controls]) });
  }
  step(input: RunInput): RunSnapshot {
    if (input === null || typeof input !== 'object' || Object.keys(input).length !== 3 ||
      input.runId !== this.#state.context.runId || input.generation !== this.#state.context.generation) throw new Error('E_STALE_RUN');
    if (this.#state.status !== 'running' || this.#state.budgetExhausted) throw new Error('E_RUN_NOT_RUNNING');
    const tick = this.#state.tick + 1;
    const result = stepRun(this.#state, input.direction);
    this.#state = result.state; this.#ring.append(result.events); this.#diagnostics.push(...result.diagnostics);
    this.#inputs.push(freeze(copy({ tick, direction: input.direction, committed: result.state.tick === tick, lastCommittedTick: result.state.tick })));
    this.#frames.push(frame(this.#state));
    return this.snapshot();
  }
  pause(): RunSnapshot { this.#control('pause'); return this.snapshot(); }
  resume(): RunSnapshot {
    if (this.#state.status !== 'paused' || this.#state.budgetExhausted) throw new Error('E_RUN_NOT_RUNNING');
    this.#control('resume'); return this.snapshot();
  }
  invalidate(): RunSnapshot { this.#control('invalidate'); return this.snapshot(); }
  #control(action: RunControl['action']): void {
    const before = this.#state;
    if (action === 'invalidate') {
      this.#state = invalidateRun(before);
    } else if (action === 'pause') this.#state = pauseRun(before);
    else this.#state = resumeRun(before);
    if (this.#state !== before) this.#controls.push(Object.freeze({ afterInput: this.#inputs.length, action }));
  }
  observe(eventIds?: readonly string[]) {
    const snapshot = this.snapshot();
    return freeze({ events: observeEvents(snapshot.events, snapshot.truncation, eventIds), rules: copy(snapshot.document.project.rules),
      runId: snapshot.context.runId, revision: snapshot.document.project.revision, semanticHash: snapshot.document.project.semanticHash,
      truncation: snapshot.truncation });
  }
  /** Launch identity remains unchanged when editor metadata or theme changes. */
  matchesGameplay(document: Document): boolean { return this.#state.document.project.semanticHash === document.project.semanticHash; }
}

export function snapshotsEqual(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
