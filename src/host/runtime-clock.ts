import { performance } from 'node:perf_hooks';
import type { Direction } from '../runtime/index.js';
import type { RunInput, RunSnapshot } from './run-session.js';

export interface ClockHost {
  currentRun(): RunSnapshot | null;
  input(input: RunInput): Promise<RunSnapshot>;
  stepClock(readHeld: () => RunInput | null, allowed: () => boolean): Promise<RunSnapshot | null>;
  pause(): Promise<RunSnapshot>;
}
export interface BrowserInput {
  connectionId: string; sequence: number; runId: string; generation: number; direction: Direction; clientSentAt: number;
}
export interface InputReceipt extends BrowserInput {
  receivedTick: number; effectiveTick: number | null; receivedAtMonotonicMs: number;
  receivedAt: number; appliedAtMonotonicMs: number | null; attemptedTick: number | null; committed: boolean | null; superseded: boolean;
}
/** The browser only changes held input. This is the sole wall-clock-to-Runtime driver. */
export class RuntimeClock {
  readonly stepMs = 1000 / 60;
  readonly maxCatchUp = 5;
  readonly #host: ClockHost;
  readonly #now: () => number;
  readonly #allowed: () => boolean;
  #last: number;
  #blocked = true;
  #reason = 'not_started';
  #connectionId: string | null = null;
  #sequence = 0;
  #direction: Direction = { x: 0, y: 0 };
  #pending: InputReceipt | null = null;
  readonly #receipts: InputReceipt[] = [];
  #totalInputs = 0;
  #droppedWallTicks = 0;
  #pumping = false;
  #timer: ReturnType<typeof setInterval> | null = null;
  constructor(host: ClockHost, now: () => number = () => performance.now(), allowed: () => boolean = () => true, readonly inputSource: 'machine_browser_input' | 'human_keyboard' = 'machine_browser_input') {
    this.#host = host; this.#now = now; this.#allowed = allowed; this.#last = now();
  }
  setConnection(connectionId: string): void {
    this.block('connection_replaced'); this.#connectionId = connectionId; this.#sequence = 0;
  }
  /** Synchronous barrier: even a pending pump cannot enqueue another logical step. */
  block(reason: string): void {
    this.#blocked = true; this.#reason = reason; this.#direction = { x: 0, y: 0 };
    if (this.#pending) this.#pending.superseded = true;
    this.#pending = null; this.#last = this.#now();
  }
  async pause(reason: string): Promise<void> {
    this.block(reason);
    if (this.#host.currentRun()?.status === 'running') await this.#host.pause();
  }
  activate(): void {
    const run = this.#host.currentRun();
    if (!run || run.status !== 'running' || run.budgetExhausted) throw new Error('E_RUN_NOT_RUNNING');
    this.#blocked = false; this.#reason = 'running'; this.#last = this.#now();
  }
  receive(input: BrowserInput): InputReceipt {
    const run = this.#host.currentRun();
    if (!run || input.runId !== run.context.runId || input.generation !== run.context.generation) throw new Error('E_STALE_RUN');
    if (input.connectionId !== this.#connectionId) throw new Error('E_CONNECTION');
    if (!Number.isSafeInteger(input.sequence) || input.sequence <= this.#sequence) throw new Error('E_INPUT_SEQUENCE');
    if (!Number.isFinite(input.clientSentAt) || input.clientSentAt < 0) throw new Error('E_INPUT_TIME');
    if (this.#blocked || run.status !== 'running' || run.budgetExhausted) throw new Error('E_RUN_NOT_RUNNING');
    if (!input.direction || Object.keys(input.direction).length !== 2 || ![-1, 0, 1].includes(input.direction.x) || ![-1, 0, 1].includes(input.direction.y)) throw new Error('E_INPUT_DIRECTION');
    if (this.#pending) this.#pending.superseded = true;
    const receipt: InputReceipt = { ...input, direction: { ...input.direction }, receivedTick: run.tick,
      effectiveTick: null, receivedAt: Date.now(), receivedAtMonotonicMs: this.#now(), appliedAtMonotonicMs: null,
      attemptedTick: null, committed: null, superseded: false };
    this.#sequence = input.sequence; this.#direction = { ...input.direction }; this.#pending = receipt;
    this.#receipts.push(receipt); this.#totalInputs++;
    if (this.#receipts.length > 1000) this.#receipts.shift();
    return structuredClone(receipt);
  }
  async pump(): Promise<void> {
    if (this.#pumping) return;
    this.#pumping = true;
    try {
      const now = this.#now();
      if (this.#blocked) { this.#last = now; return; }
      if (!this.#allowed()) { await this.pause('lease_lost'); return; }
      const owed = Math.floor(Math.max(0, now - this.#last) / this.stepMs);
      if (owed === 0) return;
      this.#last += owed * this.stepMs;
      const steps = Math.min(owed, this.maxCatchUp); this.#droppedWallTicks += owed - steps;
      for (let index = 0; index < steps; index++) {
        if (this.#blocked) break;
        const run = this.#host.currentRun();
        if (!run || run.status !== 'running' || run.budgetExhausted) { this.block('runtime_stopped'); break; }
        const selection: { receipt: InputReceipt | null } = { receipt: null };
        try {
          const after = await this.#host.stepClock(() => {
            selection.receipt = this.#pending; this.#pending = null;
            return { runId: run.context.runId, generation: run.context.generation, direction: { ...this.#direction } };
          }, () => !this.#blocked && this.#allowed());
          if (!after) break;
          if (selection.receipt) {
            selection.receipt.attemptedTick = run.tick + 1; selection.receipt.committed = after.tick === run.tick + 1;
            selection.receipt.effectiveTick = selection.receipt.committed ? after.tick : null;
            selection.receipt.appliedAtMonotonicMs = this.#now();
          }
          if (after.status !== 'running' || after.budgetExhausted) this.block('runtime_stopped');
        } catch { this.block('runtime_rejected'); break; }
      }
    } finally { this.#pumping = false; }
  }
  start(): void {
    if (this.#timer) return;
    this.#timer = setInterval(() => { void this.pump(); }, 4); this.#timer.unref();
  }
  stop(): void { if (this.#timer) clearInterval(this.#timer); this.#timer = null; this.block('server_stopped'); }
  snapshot() {
    return { fixedStepSeconds: 1 / 60, maxCatchUp: this.maxCatchUp, paused: this.#blocked, reason: this.#reason,
      direction: { ...this.#direction }, connectionId: this.#connectionId, lastSequence: this.#sequence,
      totalInputs: this.#totalInputs, droppedInputReceipts: this.#totalInputs - this.#receipts.length,
      droppedWallTicks: this.#droppedWallTicks, inputSource: this.inputSource, executionClass: this.inputSource === 'human_keyboard' ? 'human_operation' : 'automation_test',
      inputReceipts: structuredClone(this.#receipts), initialState: this.#host.currentRun()?.frames[0] ?? null };
  }
}
