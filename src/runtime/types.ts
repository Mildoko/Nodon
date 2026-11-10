import type { Document } from '../domain/types.js';

export interface Point { readonly x: number; readonly y: number }
export interface Direction { readonly x: -1 | 0 | 1; readonly y: -1 | 0 | 1 }
export interface RunContext {
  readonly runId: string;
  readonly generation: number;
  readonly buildHash: string;
  readonly runtimeArtifactHash: string;
  readonly environmentId: string;
  readonly evidenceSource: 'actual_author_run' | 'machine_test' | 'replay';
  readonly inputSource: 'human_keyboard' | 'machine_browser_input' | 'catalog_machine';
  readonly executionClass: 'automation_test' | 'human_operation';
}
export interface RunOptions {
  readonly eventBudget?: number;
  readonly maxTicks?: number;
  readonly faultInjection?: boolean;
  /** Deliberate verification fault after this many temporary tick events. */
  readonly failAfterEvents?: number;
}
export interface ResolvedRunOptions {
  readonly eventBudget: number; readonly maxTicks: number; readonly faultInjection: boolean;
  readonly failAfterEvents: number | null;
}
export interface ContactWitness {
  readonly entityIds: readonly [string, string];
  readonly startPositions: Readonly<Record<string, Point>>;
  readonly endPositions: Readonly<Record<string, Point>>;
  readonly closestTickFraction: number;
  readonly minCenterDistance: number;
  readonly contactThreshold: number;
  readonly endpointCenterDistance: number;
  readonly contacted: boolean;
}
export interface Terminal {
  readonly reason: 'caught' | 'timeout' | 'win';
  readonly caught: boolean; readonly timeout: boolean; readonly goalReached: boolean;
  readonly caughtByEntityIds: readonly string[]; readonly primaryGuardId: string | null;
}
export type EventValues = {
  run_started: { score: 0; targetScore: number; timer: { enabled: boolean; limit: number }; guardCount: number; rewardCount: number };
  chase_started: { guardId: string; centerDistance: number; detectRadius: number; speed: number; chasing: true };
  chase_stopped: { guardId: string; centerDistance: number; detectRadius: number; speed: number; chasing: false };
  reward_collected: { rewardId: string; rewardKind: 'normal' | 'high'; value: number; firstCollection: true; contactWitnesses: readonly [ContactWitness] };
  score_changed: { rewardId: string; rewardKind: 'normal' | 'high'; value: number; scoreBefore: number; scoreAfter: number; delta: number };
  goal_checked: { score: number; targetScore: number; passed: boolean; contributionEventIds: readonly string[] };
  round_ended: {
    reason: Terminal['reason']; result: 'fail' | 'win'; score: number; targetScore: number;
    goalReached: boolean; caught: boolean; timeout: boolean; caughtByEntityIds: readonly string[];
    primaryGuardId: string | null; contactWitnesses: readonly ContactWitness[];
    contributionEventIds: readonly string[]; goalCheckedEventId: string | null;
  };
};
export type EventKind = keyof EventValues;
interface EventCommon {
  readonly eventId: string; readonly runId: string; readonly projectId: string;
  readonly revision: number; readonly semanticHash: string; readonly tick: number;
  readonly entityIds: readonly string[]; readonly causeId: string | null;
  readonly ruleId: string | null; readonly positions: Readonly<Record<string, Point>>;
  readonly observationPhase: 'before_move' | 'after_move';
}
export type GameplayEvent = { [K in EventKind]: EventCommon & { readonly kind: K; readonly actualValues: Readonly<EventValues[K]> } }[EventKind];
interface DiagnosticCommon {
  readonly diagnosticId: string; readonly runId: string; readonly projectId: string;
  readonly revision: number; readonly semanticHash: string; readonly buildHash: string;
  readonly runtimeArtifactHash: string; readonly attemptedTick: number; readonly lastCommittedTick: number;
  readonly ruleId: null; readonly observationPhase: 'last_committed';
  readonly positions: Readonly<Record<string, Point>>;
}
export type RuntimeDiagnostic = DiagnosticCommon & (
  | { readonly kind: 'run_fault'; readonly actualValues: { readonly code: string; readonly message: string; readonly faultInjection: boolean } }
  | { readonly kind: 'runner_budget'; readonly actualValues: { readonly code: 'E_RUNNER_BUDGET'; readonly maxTicks: number; readonly faultInjection: boolean } }
);
export interface RunState {
  readonly document: Document;
  readonly context: RunContext;
  readonly options: ResolvedRunOptions;
  readonly tick: number;
  readonly status: 'running' | 'paused' | 'ended' | 'fault' | 'invalidated';
  readonly positions: ReadonlyMap<string, Point>;
  readonly collectedIds: ReadonlySet<string>;
  readonly chasingGuardIds: ReadonlySet<string>;
  readonly score: number;
  readonly terminal: Terminal | null;
  readonly lastEventSequence: number;
  readonly lastDiagnosticSequence: number;
  readonly budgetExhausted: boolean;
}
export interface RunResult {
  readonly state: RunState; readonly events: readonly GameplayEvent[];
  readonly diagnostics: readonly RuntimeDiagnostic[]; readonly blocked: boolean;
}
