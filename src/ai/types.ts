import type { Document, Operation } from '../domain/types.js';
export const ENDPOINT = 'https://api.deepseek.com/chat/completions' as const;
export const MODEL = 'deepseek-flash' as const;
export const INPUT_TOKEN_CAP = 12000;
export const OUTPUT_TOKEN_CAP = 4096;
export const RESERVATION_NANO_CNY = 56_768_000;
export const ATTEMPT_AMOUNT_CAP_NANO_CNY = 60_000_000;
export const TOTAL_AMOUNT_CAP_NANO_CNY = 20_000_000_000;
export const TOTAL_TOKEN_CAP = (INPUT_TOKEN_CAP + OUTPUT_TOKEN_CAP) * 76;
export class AiError extends Error { constructor(readonly code: string) { super(code); this.name = 'AiError'; } }
export interface DeepSeekAccess {
  version: 'nodon-r0-deepseek-access@1'; provider: 'deepseek'; endpoint: typeof ENDPOINT; model: typeof MODEL;
  productModel: 'DeepSeek-V4.1-Flash-1017'; modelApproved: boolean; availabilityApproved: boolean;
  outboundScopeApproved: boolean; credentialsConfigured: boolean; budgetApproved: boolean;
  inputTokenCap: 12000; outputTokenCap: 4096; totalTokenCap: 1223296;
  attemptAmountCapNanoCNY: 60000000; totalAmountCapNanoCNY: 20000000000;
  maxLogicalRequests: 38; maxAttempts: 76; concurrency: 1; implicitRetries: 0;
}
export interface AiAuthorityState {
  authEpoch: number; adultEnabled: boolean; sessionId: string; writerToken: string; projectId: string; scopeEnabled: boolean;
}
export interface RequestSnapshot {
  projectId: string; requestId: string; baseRevision: number; baseSemanticHash: string;
  runtimeVersion: 'collect-chase@1'; catalogVersion: 'workshop-core@1';
  ruleRegistryVersion: 'collect-chase-rules@1'; trialPolicyVersion: 'collect-chase-candidate-trial@2';
  capabilityVersion: 'nodon-r0-capabilities@1'; authEpoch: number; sessionId: string; writerToken: string;
  requestText: string; selectedEvidenceRefs: string[];
}
export interface DirectionOption { id: string; label: string; rationale: string }
export type ModelResponse =
  | { kind: 'directions'; summary: string; options: DirectionOption[] }
  | { kind: 'locate'; summary: string; reasonCode: 'manual_quantity' | 'rule' | 'entity'; entityIds: string[]; ruleIds: string[] }
  | { kind: 'explain'; summary: string; facts: { text: string; eventIds: string[] }[]; rules: { text: string; ruleIds: string[] }[]; hypotheses: { text: string; test: string }[]; options: DirectionOption[] }
  | { kind: 'propose'; summary: string; operations: Operation[] }
  | { kind: 'clarify'; question: string }
  | { kind: 'unsupported'; reason: string };
export interface SubmitRequest {
  requestSlotID: string; requestId: string; idempotencyKey: string;
  snapshot: RequestSnapshot; document: Document;
  /** Explicit second attempt only; the first must actually fail parsing. No automatic repair. */
  repairOfAttemptId?: string;
}
export interface Usage { promptTokens: number; completionTokens: number; cachedTokens: number }
export interface AttemptRecord {
  attemptId: string; requestId: string; requestSlotID: string; ordinal: number;
  state: 'reserved' | 'in_flight' | 'unknown' | 'accounted'; reservationNanoCNY: number;
  queueSequence: number; authEpoch: number; authorizationCheckedAt: string;
  returnedModel: string | null; finishReason: string | null; rawOutput: string | null; dispatchAt: string | null; providerRequestId: string | null; usage: Usage | null;
  usageCalculatedNanoCNY: number | null; costStatus: 'reserved_unknown' | 'usage_calculated_pending_bill';
  outcome: 'pending' | 'parsed' | 'invalid_response' | 'transport_unknown' | 'canceled' | 'timeout';
}
export type GatewayResult =
  | { status: 'answered'; requestId: string; attempt: AttemptRecord; response: ModelResponse }
  | { status: 'failed' | 'canceled' | 'unknown'; requestId: string; code: string; attempt: AttemptRecord | null }
  | { status: 'duplicate'; requestId: string; attempts: AttemptRecord[] };

/** Provenance of the Node transport path; controlled test transports are never real provider evidence. */
export type TransportEvidence = 'real_provider_transport' | 'controlled_transport';
export interface ProviderEvidence {
  transport: TransportEvidence; requestSlotID: string; attemptId: string; providerRequestId: string | null;
  usageCostStatus: 'usage_calculated_pending_bill'; selectedEvidenceHash: string | null;
}
