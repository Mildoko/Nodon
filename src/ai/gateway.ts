import { canonicalJson } from '../domain/index.js';
import { R0Host } from '../host/r0-host.js';
import type { BuildIdentity } from '../../tools/build-manifest.js';
import { assertSelectedEvidence } from './selected-evidence.js';
import { AiAuthority } from './authority.js';
import { AiLedger } from './ledger.js';
import { dispatchDeepSeek, type TransportReply } from './deepseek-client.js';
import { assertAccess, buildBody, parseModelResponse, requestFingerprint, validateAccess, validateRequest } from './protocol.js';
import { AiError, type DeepSeekAccess, type GatewayResult, type SubmitRequest, type AttemptRecord, type TransportEvidence } from './types.js';
/** Credential callback is host-only. Never give a browser a key, env-file path or generic endpoint. */
export type CredentialProvider = () => Promise<string | null>;
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function approvedReturnedModel(model: string | null): boolean { return typeof model === 'string' && /^(?:deepseek-flash|deepseek-v4\.1-flash-1017)$/i.test(model); }
export interface GatewayAnswerProof { request: Readonly<SubmitRequest>; build: Readonly<BuildIdentity>; transportEvidence: TransportEvidence }
interface Active { controller: AbortController; attemptId: string; timeout: boolean; request: SubmitRequest; build: BuildIdentity | null; lastAttempt: AttemptRecord; timer?: ReturnType<typeof setTimeout> }
export class AiGateway {
  readonly access: DeepSeekAccess;
  #active = new Map<string, Active>();
  #closed = false;
  readonly #answers = new WeakMap<object, GatewayAnswerProof>();
  #unlisten: () => void;
  constructor(readonly authority: AiAuthority, readonly ledger: AiLedger, access: DeepSeekAccess, readonly credentialProvider: CredentialProvider, readonly deadlineMs = 60000, readonly host?: R0Host, readonly transportEvidence: TransportEvidence = 'real_provider_transport') {
    if (transportEvidence !== 'real_provider_transport' && transportEvidence !== 'controlled_transport') throw new AiError('E_TRANSPORT_EVIDENCE');
    if (host !== undefined && (!(host instanceof R0Host) || host.queue !== authority.queue || !host.authorizes(authority.snapshot()))) throw new AiError('E_AUTHORITY_OWNER');
    if (ledger.queue !== authority.queue) throw new AiError('E_QUEUE_IDENTITY');
    if (!Number.isSafeInteger(deadlineMs) || deadlineMs < 1 || deadlineMs > 60000) throw new AiError('E_DEADLINE');
    this.access = validateAccess(access);
    this.#unlisten = authority.onRevoke(() => {
      ledger.invalidateAll();
      for (const active of this.#active.values()) { active.lastAttempt = ledger.unknown(active.attemptId, 'canceled'); active.controller.abort(); }
    });
  }
  async submit(input: unknown): Promise<GatewayResult> {
    const request = freeze(validateRequest(input)); const body = buildBody(request);
    const queue = this.authority.queue;
    const prior = await queue.enqueue(() => {
      if (this.#closed) throw new AiError('E_GATEWAY_CLOSED');
      this.authority.check(request.snapshot); this.#checkHost(request); assertSelectedEvidence(request, this.authority, this.host); assertAccess(this.access, request.requestSlotID);
      const fresh = this.ledger.register(request.requestSlotID, request.requestId, request.idempotencyKey, requestFingerprint(request));
      if (this.ledger.canceled(request.requestId)) throw new AiError('E_REQUEST_CANCELED');
      if (fresh || request.repairOfAttemptId !== undefined || this.ledger.attempts(request.requestId).length === 0) return null;
      return this.ledger.result(request.requestId) ?? { status: 'duplicate' as const, requestId: request.requestId, attempts: this.ledger.attempts(request.requestId) };
    });
    if (prior !== null) return prior;
    // Preparation is deliberately outside the queue. This grant never authorizes dispatch.
    let credential: string | null;
    try { credential = await this.credentialProvider(); }
    catch { throw new AiError('E_CREDENTIAL_UNAVAILABLE'); }
    if (!credential) throw new AiError('E_CREDENTIAL_UNAVAILABLE');
    let dispatch: { active: Active; response: Promise<TransportReply> } | { prior: GatewayResult };
    try {
      dispatch = await queue.enqueue(sequence => {
        if (this.#closed) throw new AiError('E_GATEWAY_CLOSED');
        this.authority.check(request.snapshot); this.#checkHost(request); assertSelectedEvidence(request, this.authority, this.host); assertAccess(this.access, request.requestSlotID);
        if (this.ledger.canceled(request.requestId)) throw new AiError('E_REQUEST_CANCELED');
        const previous = this.ledger.attempts(request.requestId);
        if ((request.repairOfAttemptId === undefined && previous.length > 0) || previous.length >= 2) return { prior: this.ledger.result(request.requestId) ?? { status: 'duplicate' as const, requestId: request.requestId, attempts: previous } };
        const attempt = this.ledger.reserve(request.requestId, request.snapshot.authEpoch, sequence, request.repairOfAttemptId);
        const active: Active = { controller: new AbortController(), attemptId: attempt.attemptId, timeout: false, request, build: this.host ? freeze(this.host.buildIdentity()) : null, lastAttempt: attempt };
        this.#active.set(request.requestId, active);
        active.lastAttempt = this.ledger.markDispatch(attempt.attemptId);
        // There is no await between final check, durable reservation, dispatch marker and fetch invocation.
        let response: Promise<TransportReply>;
        try { response = dispatchDeepSeek(body, credential as string, active.controller.signal); }
        catch { active.lastAttempt = this.ledger.unknown(attempt.attemptId, 'transport_unknown'); this.#active.delete(request.requestId); throw new AiError('E_DISPATCH_UNKNOWN'); }
        return { active, response };
      });
    } finally { credential = null; }
    if ('prior' in dispatch) return dispatch.prior;
    const { active, response } = dispatch;
    const timer = setTimeout(() => {
      void queue.enqueue(() => {
        if (this.#closed || this.#active.get(request.requestId) !== active) return;
        active.timeout = true; this.ledger.cancel(request.requestId);
        active.lastAttempt = this.ledger.unknown(active.attemptId, 'timeout'); active.controller.abort();
      });
    }, this.deadlineMs);
    active.timer = timer;
    timer.unref();
    try {
      const reply = await response;
      return await queue.enqueue(() => {
        if (this.#closed) return { status: 'canceled' as const, requestId: request.requestId, code: 'E_GATEWAY_CLOSED', attempt: active.lastAttempt };
        // First account for received usage, even after cancellation. Delivery eligibility is a separate check.
        let parsed: ReturnType<typeof parseModelResponse> | null = null;
        try { if (reply.content !== null) parsed = parseModelResponse(reply.content, request); } catch { /* Invalid output is retained as a failed attempt, never partially applied. */ }
        const attempt = this.ledger.complete(active.attemptId, reply.usage, reply.providerRequestId, parsed === null ? 'invalid_response' : 'parsed', reply.rawOutput, reply.returnedModel, reply.finishReason);
        this.#active.delete(request.requestId);
        let result: GatewayResult;
        try { this.authority.check(request.snapshot); this.#checkHost(request, active.build); assertSelectedEvidence(request, this.authority, this.host); if (this.ledger.canceled(request.requestId)) throw new AiError('E_REQUEST_CANCELED'); }
        catch { result = { status: 'canceled', requestId: request.requestId, code: active.timeout ? 'E_TIMEOUT' : 'E_REQUEST_CANCELED', attempt }; this.ledger.saveResult(request.requestId, active.attemptId, result); return result; }
        if (attempt.state !== 'accounted') result = { status: 'unknown', requestId: request.requestId, code: 'E_USAGE_UNKNOWN', attempt };
        else if (!approvedReturnedModel(attempt.returnedModel)) result = { status: 'failed', requestId: request.requestId, code: 'E_MODEL_VERSION', attempt };
        else if (parsed === null) result = { status: 'failed', requestId: request.requestId, code: 'E_MODEL_RESPONSE', attempt };
        else result = { status: 'answered', requestId: request.requestId, attempt, response: parsed };
        this.ledger.saveResult(request.requestId, active.attemptId, result);
        if (result.status === 'answered' && active.build !== null) {
          freeze(result); this.#answers.set(result, freeze({ request, build: active.build, transportEvidence: this.transportEvidence }));
        }
        return result;
      });
    } catch {
      return await queue.enqueue(() => {
        if (this.#closed) return { status: 'canceled' as const, requestId: request.requestId, code: 'E_GATEWAY_CLOSED', attempt: active.lastAttempt };
        this.#active.delete(request.requestId);
        const canceled = this.ledger.canceled(request.requestId);
        const attempt = this.ledger.unknown(active.attemptId, active.timeout ? 'timeout' : canceled ? 'canceled' : 'transport_unknown');
        const result: GatewayResult = { status: canceled ? 'canceled' : 'unknown', requestId: request.requestId, code: active.timeout ? 'E_TIMEOUT' : canceled ? 'E_REQUEST_CANCELED' : 'E_TRANSPORT_UNKNOWN', attempt };
        this.ledger.saveResult(request.requestId, active.attemptId, result); return result;
      });
    } finally { clearTimeout(timer); }
  }
  #checkHost(request: SubmitRequest, expectedBuild: BuildIdentity | null = null): void {
    if (!this.host) return;
    if (expectedBuild !== null && canonicalJson(this.host.buildIdentity()) !== canonicalJson(expectedBuild)) throw new AiError('E_BUILD_CHANGED');
    if (!this.host.authorizes(request.snapshot)) throw new AiError('E_WRITER');
    if (canonicalJson(this.host.document()) !== canonicalJson(request.document)) throw new AiError('E_REQUEST_BASE');
  }
  /** Only the original answered object from this live dispatch is a capability. Persisted/JSON duplicates are history. */
  assertAnswered(result: GatewayResult, host: R0Host): GatewayAnswerProof {
    this.authority.queue.assertActive();
    if (this.#closed) throw new AiError('E_GATEWAY_CLOSED');
    if (this.host !== host || host.queue !== this.authority.queue || !host.authorizes(this.authority.snapshot())) throw new AiError('E_AUTHORITY_OWNER');
    const proof = result !== null && typeof result === 'object' ? this.#answers.get(result) : undefined;
    if (!proof || result.status !== 'answered') throw new AiError('E_GATEWAY_RESULT_SOURCE');
    if (!approvedReturnedModel(result.attempt.returnedModel)) throw new AiError('E_MODEL_VERSION');
    const request = proof.request;
    this.authority.check(request.snapshot); assertSelectedEvidence(request as SubmitRequest, this.authority, host);
    if (!host.authorizes(request.snapshot)) throw new AiError('E_WRITER');
    const current = host.document();
    if (current.project.projectId !== request.snapshot.projectId || current.project.revision !== request.snapshot.baseRevision || current.project.semanticHash !== request.snapshot.baseSemanticHash) throw new AiError('E_REVISION_CONFLICT');
    if (canonicalJson(host.buildIdentity()) !== canonicalJson(proof.build)) throw new AiError('E_BUILD_CHANGED');
    if (this.ledger.canceled(request.requestId)) throw new AiError('E_REQUEST_CANCELED');
    const attempt = this.ledger.attempts(request.requestId).find(item => item.attemptId === result.attempt.attemptId);
    if (!attempt || attempt.state !== 'accounted' || attempt.outcome !== 'parsed' || attempt.usage === null || attempt.usageCalculatedNanoCNY === null ||
      canonicalJson(attempt) !== canonicalJson(result.attempt) || request.requestId !== result.requestId || attempt.requestSlotID !== request.requestSlotID) throw new AiError('E_GATEWAY_USAGE');
    return proof;
  }
  cancel(requestId: string): Promise<void> {
    return this.authority.queue.enqueue(() => {
      if (this.#closed) throw new AiError('E_GATEWAY_CLOSED');
      this.ledger.cancel(requestId); const active = this.#active.get(requestId);
      if (active) { active.lastAttempt = this.ledger.unknown(active.attemptId, 'canceled'); active.controller.abort(); }
    });
  }
  /** Call on orderly host shutdown; it preserves durable unknown reservations. */
  async shutdown(): Promise<void> {
    await this.authority.queue.enqueue(() => {
      if (this.#closed) return;
      this.#closed = true;
      this.ledger.invalidateAll();
      for (const active of this.#active.values()) {
        if (active.timer !== undefined) clearTimeout(active.timer);
        active.lastAttempt = this.ledger.unknown(active.attemptId, 'canceled');
        active.controller.abort();
      }
      this.#active.clear();
      this.#unlisten();
    });
  }
}
