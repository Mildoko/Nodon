import { exportGenuineRun } from '../trial/export-run.js';
import { type ExportRunOptions } from '../evidence/run-evidence.js';
import { randomUUID } from 'node:crypto';
import { DomainError, validatePlayability, type EntityKind } from '../domain/index.js';
import type { Document, CommandResult } from '../domain/index.js';
import type { BuildIdentity } from '../../tools/build-manifest.js';
import type { RunContext, RunOptions } from '../runtime/index.js';
import { ProjectStore, type ProjectStoreOptions } from './project-store.js';
import { CommandQueue } from './command-queue.js';
import { RunSession, type RunInput, type RunSnapshot } from './run-session.js';

// Frozen domain maxima; compiled Host source participates in buildHash.
const entityBudget = { maxTotal: 18, kinds: { player: { max: 1 }, guard: { max: 2 }, normal: { max: 12 }, high: { max: 3 } } } as const;

export interface R0HostOptions extends ProjectStoreOptions { buildIdentity: BuildIdentity; queue?: CommandQueue }
export interface StartRunOptions {
  evidenceSource?: RunContext['evidenceSource']; inputSource?: RunContext['inputSource'];
  executionClass?: RunContext['executionClass']; runtimeOptions?: RunOptions;
}
/** One Node owner and one authority queue. Network/AI adapters share this exact queue. */
export class R0Host {
  readonly queue: CommandQueue;
  readonly #store: ProjectStore;
  readonly #build: BuildIdentity;
  #active: RunSession | null = null;
  readonly #history: RunSession[] = [];
  #generation = 0;
  readonly #commandKinds = new Map<string, 'manual' | 'candidate'>();
  readonly #revisionListeners = new Set<() => void>();
  constructor(document: Document, options: R0HostOptions) {
    this.queue = options.queue ?? new CommandQueue();
    this.#store = new ProjectStore(document, options);
    this.#build = structuredClone(options.buildIdentity);
  }
  authorizes(binding: { sessionId: string; writerToken: string; projectId: string }): boolean { return this.#store.authorizes(binding); }
  /** Node-only exporter requires the actual authorized root and original genuine session. */
  exportCurrentRun(options: ExportRunOptions = {}): Promise<string> {
    return this.queue.enqueue(() => exportGenuineRun(this.#requireRun(), this.#build, options));
  }
  buildIdentity(): BuildIdentity { return structuredClone(this.#build); }
  onRevision(listener: () => void): () => void {
    this.#revisionListeners.add(listener); return () => { this.#revisionListeners.delete(listener); };
  }
  preview(input: unknown): Promise<CommandResult> {
    return this.queue.enqueue<CommandResult>(() => {
      const commandId = this.#store.acceptedCommandId(input);
      if (commandId !== null && this.#commandKinds.get(commandId) === 'candidate') {
        const error = new DomainError('E_IDEMPOTENCY_CONFLICT');
        return { ok: false, code: error.code, errors: error.errors, currentRevision: this.#store.snapshot().project.revision };
      }
      return this.#store.preview(input);
    });
  }
  /** Clock callbacks read live held input and the loss gate inside the authority queue. */
  stepClock(readHeld: () => RunInput | null, allowed: () => boolean): Promise<RunSnapshot | null> {
    return this.queue.enqueue(() => {
      if (!allowed()) return this.currentRun();
      const current = this.currentRun();
      if (!current || current.status !== 'running' || current.budgetExhausted) return current;
      const input = readHeld(); if (!input) return current;
      return this.#requireRun().step(input);
    });
  }
  /** Node-only shared CommandBus namespace; caller has already accepted its UUID DTO. */
  claimCandidateCommandId(commandId: string): void {
    this.queue.assertActive();
    if (this.#commandKinds.get(commandId) === 'manual') throw new DomainError('E_IDEMPOTENCY_CONFLICT');
    this.#commandKinds.set(commandId, 'candidate');
  }
  /** Internal Node capability endpoint. A plain object from an HTTP body always fails. */
  commitCandidate(permit: object): CommandResult {
    this.queue.assertActive(); const before = this.#store.snapshot();
    const result = this.#store.commitCandidate(permit, this);
    this.#afterCommit(before); return result;
  }
  inspect() {
    const document = this.#store.snapshot(); const playability = validatePlayability(document);
    const counts: Record<EntityKind, number> = { player: 0, guard: 0, normal: 0, high: 0 };
    for (const entity of document.project.scene.entities) counts[entity.kind]++;
    const entityCount = document.project.scene.entities.length;
    return { counts, entityCount, rewardCount: playability.rewardCount, totalScore: playability.totalScore,
      targetScore: document.project.rules.goal.targetScore, playable: playability.playable, errors: playability.errors,
      budget: { maxTotal: entityBudget.maxTotal, remainingTotal: entityBudget.maxTotal - entityCount,
        remaining: { player: entityBudget.kinds.player.max - counts.player, guard: entityBudget.kinds.guard.max - counts.guard,
          normal: entityBudget.kinds.normal.max - counts.normal, high: entityBudget.kinds.high.max - counts.high } } };
  }
  document(): Document { return this.#store.snapshot(); }
  currentRun(): RunSnapshot | null { return this.#active?.snapshot() ?? null; }
  history(): RunSnapshot[] { return this.#history.map(run => run.snapshot()); }
  startRun(options: StartRunOptions = {}): Promise<RunSnapshot> {
    return this.queue.enqueue(() => {
      if (this.#generation === Number.MAX_SAFE_INTEGER) throw new Error('E_GENERATION_LIMIT');
      const context: RunContext = { runId: randomUUID(), generation: this.#generation + 1,
        buildHash: this.#build.buildHash, runtimeArtifactHash: this.#build.runtimeArtifactHash, environmentId: this.#build.environmentId,
        evidenceSource: options.evidenceSource ?? 'machine_test', inputSource: options.inputSource ?? 'catalog_machine',
        executionClass: options.executionClass ?? 'automation_test' };
      // Validate a new run before touching the previous one.
      const next = new RunSession(this.#store.snapshot(), context, options.runtimeOptions);
      if (this.#active) {
        const status = this.#active.snapshot().status;
        if (status === 'running' || status === 'paused') this.#active.invalidate();
        this.#history.push(this.#active);
      }
      this.#active = next; this.#generation++;
      return next.snapshot();
    });
  }
  input(input: RunInput): Promise<RunSnapshot> { return this.queue.enqueue(() => this.#requireRun().step(input)); }
  pause(): Promise<RunSnapshot> { return this.queue.enqueue(() => this.#requireRun().pause()); }
  resume(): Promise<RunSnapshot> {
    return this.queue.enqueue(() => {
      const run = this.#requireRun();
      if (!run.matchesGameplay(this.#store.snapshot())) throw new Error('E_STALE_RUN');
      return run.resume();
    });
  }
  execute(input: unknown): Promise<CommandResult> {
    return this.queue.enqueue<CommandResult>(() => {
      const before = this.#store.snapshot(); const commandId = this.#store.acceptedCommandId(input);
      if (commandId !== null && this.#commandKinds.get(commandId) === 'candidate') {
        const error = new DomainError('E_IDEMPOTENCY_CONFLICT');
        return { ok: false, code: error.code, errors: error.errors, currentRevision: before.project.revision };
      }
      const result = this.#store.execute(input);
      if (commandId !== null && this.#store.hasCachedCommand(commandId)) this.#commandKinds.set(commandId, 'manual');
      if (result.ok) this.#afterCommit(before);
      return result;
    });
  }
  #afterCommit(before: Document): void {
    const after = this.#store.snapshot();
    if (after.project.revision === before.project.revision) return;
    if (this.#active) {
      if (before.project.semanticHash !== after.project.semanticHash) this.#active.invalidate();
      else this.#active.pause();
    }
    for (const listener of this.#revisionListeners) { try { listener(); } catch { /* A committed document remains authoritative. */ } }
  }
  observe(eventIds?: readonly string[]) { return this.#requireRun().observe(eventIds); }
  #requireRun(): RunSession { if (!this.#active) throw new Error('E_NO_RUN'); return this.#active; }
}
