import type { Document, Operation, ValidationError } from '../domain/index.js';
import type { ProviderEvidence } from '../ai/types.js';
import type { RunSnapshot } from '../host/run-session.js';
export type TrialStatus = 'not_run' | 'running' | 'passed' | 'failed' | 'blocked' | 'runtime_not_applicable';
export type CandidateState = 'validation_pending' | 'validation_blocked' | 'proposed' | 'applied' | 'rejected' | 'stale' | 'canceled';
export type CandidateSource = 'controlled_fixture' | 'provider_gateway';
export interface TrialRecord {
  source: CandidateSource; providerEvidence: ProviderEvidence | null;
  trialId: string | null; candidateHash: string; candidateSemanticHash: string; scriptId: 'CC-SMOKE-01';
  scriptHash: string; trialPolicyVersion: 'collect-chase-candidate-trial@2'; buildHash: string; runtimeArtifactHash: string;
  contractHash: unknown; environmentId: string; status: TrialStatus; run: RunSnapshot | null;
  assertions: { candidateLoaded: boolean; runStarted: boolean; committedTick: boolean; eventIdentity: boolean; noFault: boolean };
  coverage: { rewardCollected: boolean; chaseObserved: boolean; terminalReason: string | null; uncovered: string[] };
}
/** Safe for browser serialization: no request writer/session tokens or authorization capability. */
export interface CandidateSnapshot {
  source: CandidateSource; providerEvidence: ProviderEvidence | null; candidateId: string; requestId: string; baseRevision: number; baseSemanticHash: string;
  candidateHash: string | null; candidateSemanticHash: string | null; operations: Operation[];
  /** Node-retained display history only. Never used for trial or commit eligibility. */
  historicalOperations?: Operation[];
  candidateState: { scene: Document['project']['scene']; rules: Document['project']['rules']; presentation: Document['project']['presentation'] } | null;
  canConfirm: boolean; canTrial: boolean; eligibilityError: string | null;
  state: CandidateState; validation: 'static_valid' | 'invalid'; trialRequirement: 'runtime' | 'static'; trialStatus: TrialStatus;
  trialRef: string | null; trial: TrialRecord | null; errors: ValidationError[];
  predictedImpact: string; actualCoverage: string[]; missingCoverage: string[];
}
export interface ControlledCandidateInput { requestId: string; operations: Operation[] }
