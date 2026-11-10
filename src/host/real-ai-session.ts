import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname, relative, resolve, sep } from 'node:path';
import { canonicalJson, canonicalSHA256, assertDocument, parseStrictJson, type Document } from '../domain/index.js';
import { AiAuthority, AiGateway, AiLedger, AiError, type SubmitRequest, type GatewayResult, type DirectionOption } from '../ai/index.js';
import type { FrozenRequestManifest } from '../ai/ledger.js';
import { buildBody, promptSchemaDescriptor, validateAccess } from '../ai/protocol.js';
import { bindSelectedEvidence, selectedEvidenceProjection, selectedEvidenceDigest } from '../ai/selected-evidence.js';
import { loadDeepSeekCredentialProvider } from './credential-provider.js';
import { R0Host } from './r0-host.js';
import type { RunSnapshot } from './run-session.js';
import { CandidateManager } from '../trial/index.js';
import { digest, persistBuildIdentity, type BuildIdentity } from '../../tools/build-manifest.js';

interface Slot {
  requestSlotID: string; parentSlotID: string | null; phase: string; intent?: string; intentTemplate?: string;
  inputFixturePath: string; expectedOutput: string[];
}
interface Manifest extends FrozenRequestManifest { slots: (FrozenRequestManifest['slots'][number] & Slot)[]; executionOrder: string[] }
export type DirectionClass = 'layout' | 'time' | 'minimal_change';
export interface HumanChoice { optionId: string; rationale: string; directionClass?: DirectionClass; witnessRef?: string }
export interface HumanDecision {
  decision: 'accept' | 'reject' | 'retain'; semantic: 'correct' | 'incorrect' | 'unknown'; rationale: string;
  witnessRef?: string; optionId?: string; directionClass?: DirectionClass;
}
export interface HumanWitness extends HumanDecision {
  version: 'nodon-r0-human-witness@1'; source: 'external_human_witness'; participantId: string;
  participantRole: 'developer_self_test'; slotId: string; requestId: string; recordedAt: string;
  sourceMessageRef: string; limitation: string;
}
export interface ExplanationRunProof {
  runId: string; eventIds: string[]; recommendedEventIds: string[]; fixtureHash: string; inputHash: string; validationHash: string;
}
export interface FrozenRecheckResult {
  runId: string; tick: number; status: RunSnapshot['status']; terminal: RunSnapshot['terminal']; score: number;
  revision: number; semanticHash: string; buildHash: string; runtimeArtifactHash: string;
  source: 'machine_test'; inputSource: 'catalog_machine'; executionClass: 'automation_test';
  parentRequestId: string; parentRunId: string; parentActualOutputHash: string | null; parentSelectedEvidenceHash: string | null;
  originalValidationHash: string | null; candidateId: string; candidateHash: string; candidateSemanticHash: string;
  trialRef: string | null; providerAttemptId: string; fixtureHash: string; inputHash: string;
  coverage: { rewardCollected: boolean; chaseObserved: boolean; terminalReason: string | null; committedInputs: number; diagnostics: number; budgetExhausted: boolean; uncovered: string[] };
  comparison: { originalTerminalReason: 'caught'; observedTerminalReason: string | null; observation: string; improvementJudgment: null; limitation: string };
  runPath: string | null; exportNature: 'genuine_run_package' | 'controlled_test_not_exported';
  completedAt: string; reusedExistingResult: boolean;
}
interface ParentState { attemptId: string; requestId: string; response: Extract<GatewayResult, { status: 'answered' }>['response'] | null; outputHash: string | null; rawOutputHash: string | null; result: GatewayResult }
interface ParentLiveContext { request: SubmitRequest; runId: string; selectedIds: string[]; selectedEvidenceHash: string | null }
const parentLiveContexts = new WeakMap<R0Host, Map<string, ParentLiveContext>>();
interface Disposition {
  version: 'nodon-r0-slot-disposition@1'; sequence: number; dispositionId: string; recordedAt: string;
  slotId: string; parentSlotId: string; parentRequestId: string; parentOutputHash: string | null;
  reason: 'parent_no_eligible_options' | 'human_reject' | 'human_retain' | 'program_precondition_unavailable';
  witnessRef: string | null; programCode: string | null; previousHash: string | null; recordHash: string;
}
export interface SessionVerificationAssembly {
  /** Node-only offline tests. Never bind this object or its instances from HTTP. */
  isolatedRoot: true; ledger: AiLedger; gateway: AiGateway;
}
const RT07_FIXTURE = 'verification/fixtures/terminal-conflict.json';
const RT07_INPUT = 'verification/inputs/terminal-conflict.json';
const RT07_FIXTURE_HASH = 'sha256:eb854e21c099c0d5345510e36005956c675632c5f97ab25a18dd1003c52478df';
const RT07_INPUT_HASH = 'sha256:dad08327a7c637c2c7ec706cf874a9d6d6453ff56210154588a25a637e6f2702';
function errorCode(error: unknown): string { return error instanceof AiError ? error.code : 'E_REAL_AI_SESSION'; }
function freeze<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function expectedDirection(slotId: string): DirectionClass | null {
  return /^R0-AI-09-R[12]-F$/.test(slotId) ? 'layout' : /^R0-AI-10-R[12]-F$/.test(slotId) ? 'time' : /^R0-AI-11-R[12]-F$/.test(slotId) ? 'minimal_change' : null;
}
function isExplanationInitial(slotId: string): boolean { return /^R0-AI-11-R[12]-I$/.test(slotId); }
function isExplanationChild(slotId: string): boolean { return /^R0-AI-11-R[12]-F$/.test(slotId); }
function checkedFrozenBytes(root: string, path: string, expectedHash: string): Buffer {
  const bytes = readFileSync(resolve(root, path)); if (digest(bytes) !== expectedHash) throw new AiError('E_FROZEN_INPUT_HASH'); return bytes;
}
export function readFrozenSlot(root: string, slotId: string): { slot: Slot; document: Document; manifest: Manifest } {
  const manifest = parseStrictJson(readFileSync(resolve(root, 'verification/model-request-manifest.json'), 'utf8')) as Manifest;
  const slot = manifest.slots.find(s => s.requestSlotID === slotId);
  if (!slot || !/^R0-AI-(?:0[1-9]|1[0-4])-R[12]-[IF]$/.test(slotId) || !/^verification\/fixtures\/[a-z0-9-]+\.json$/.test(slot.inputFixturePath)) throw new AiError('E_FROZEN_SLOT');
  if (slot.parentSlotID === null ? typeof slot.intent !== 'string' : typeof slot.intentTemplate !== 'string') throw new AiError('E_FROZEN_INTENT');
  return { slot, manifest, document: assertDocument(parseStrictJson(readFileSync(resolve(root, slot.inputFixturePath), 'utf8'))) };
}
/** The only witness authority is a root-written local record; a browser field alone is a self-report. */
export function readHumanWitness(root: string, witnessRef: string): HumanWitness {
  if (typeof witnessRef !== 'string' || !/^evidence\/r0\/[A-Za-z0-9-]+\/10_decisions\/human-witness\/[A-Za-z0-9-]+\.json$/.test(witnessRef)) throw new AiError('E_HUMAN_WITNESS_PATH');
  try {
  const canonicalRoot = realpathSync(root); const path = resolve(root, witnessRef);
  if (lstatSync(root).isSymbolicLink()) throw new AiError('E_HUMAN_WITNESS_PATH');
  let cursor = root;
  for (const segment of witnessRef.split('/')) { cursor = resolve(cursor, segment); if (lstatSync(cursor).isSymbolicLink()) throw new AiError('E_HUMAN_WITNESS_PATH'); }
  const canonical = realpathSync(path); const rel = relative(canonicalRoot, canonical);
  if (rel.startsWith('..') || rel.startsWith(sep) || canonical !== resolve(canonicalRoot, witnessRef) || !lstatSync(canonical).isFile() || lstatSync(canonical).size > 65536) throw new AiError('E_HUMAN_WITNESS_PATH');
  const value = parseStrictJson(readFileSync(canonical, 'utf8')) as HumanWitness;
  if (value.version !== 'nodon-r0-human-witness@1' || value.source !== 'external_human_witness' || value.participantRole !== 'developer_self_test' ||
    typeof value.participantId !== 'string' || !value.participantId || typeof value.slotId !== 'string' || typeof value.requestId !== 'string' ||
    !['accept','reject','retain'].includes(value.decision) || !['correct','incorrect','unknown'].includes(value.semantic) ||
    typeof value.rationale !== 'string' || value.rationale.length < 1 || value.rationale.length > 300 || typeof value.recordedAt !== 'string' || !Number.isFinite(Date.parse(value.recordedAt)) ||
    typeof value.sourceMessageRef !== 'string' || !value.sourceMessageRef || typeof value.limitation !== 'string' || !value.limitation) throw new AiError('E_HUMAN_WITNESS');
  return freeze(value);
  } catch (error) { if (error instanceof AiError) throw error; throw new AiError('E_HUMAN_WITNESS_PATH'); }
}
/** Pure exact substitution. Human semantics and provenance are checked separately before this is called. */
export function materializeChildIntent(template: string, actual: DirectionOption): string {
  if (typeof template !== 'string' || !template.includes('{{humanChoice.optionId}}') || !template.includes('{{humanChoice.exactOptionText}}')) throw new AiError('E_FROZEN_INTENT');
  const text = template.replaceAll('{{humanChoice.optionId}}', actual.id).replaceAll('{{humanChoice.exactOptionText}}', canonicalJson(actual));
  if (/\{\{[^}]+\}\}/.test(text)) throw new AiError('E_FROZEN_INTENT');
  if (text.length > 300) throw new AiError('E_TEXT_LENGTH'); return text;
}

export class RealAiR0Session {
  readonly gateway: AiGateway; readonly ledger: AiLedger; readonly manifest: Manifest; readonly initialDocument: Document;
  #slotId: string; #slot: Slot;
  get slotId(): string { return this.#slotId; }
  get slot(): Slot { return this.#slot; }
  #pending: Promise<unknown> | null = null; #preparing: Promise<ExplanationRunProof> | null = null;
  #rechecking: Promise<FrozenRecheckResult> | null = null; #recheckResult: FrozenRecheckResult | null = null;
  #result: GatewayResult | null = null; #request: SubmitRequest | null = null;
  #status = 'ready'; #error: string | null = null; #humanDecision: unknown = null; #humanChoice: unknown = null;
  #startedAt: string | null = null; #completedAt: string | null = null; #preparedEvidence: ExplanationRunProof | null = null;
  #explicitRetries: { recordedAt: string; requestId: string; attemptCountBefore: 0 }[] = [];
  #phaseTransitions: { fromSlot: string; toSlot: string; parentRequestId: string; parentOutputHash: string; recordedAt: string }[] = [];
  readonly #dispositionPath: string;
  constructor(readonly root: string, slotId: string, readonly host: R0Host, readonly authority: AiAuthority,
    readonly candidates: CandidateManager, readonly build: BuildIdentity, readonly participantId: string | null = null, verification?: SessionVerificationAssembly) {
    const frozen = readFrozenSlot(root, slotId); this.#slotId = slotId; this.#slot = freeze(frozen.slot); this.manifest = freeze(frozen.manifest); this.initialDocument = freeze(frozen.document);
    if (canonicalJson(host.document()) !== canonicalJson(this.initialDocument) || host.queue !== authority.queue || candidates.host !== host || candidates.authority !== authority || canonicalJson(host.buildIdentity()) !== canonicalJson(build)) throw new AiError('E_AI_SESSION_OWNER');
    if (verification !== undefined) {
      if (verification.isolatedRoot !== true || verification.gateway.transportEvidence !== 'controlled_transport' || verification.gateway.host !== host || verification.gateway.authority !== authority || verification.gateway.ledger !== verification.ledger || verification.ledger.queue !== host.queue ||
        realpathSync(root) === realpathSync('/Users/dmy/Projects/Nodon-R0')) throw new AiError('E_TEST_ASSEMBLY');
      this.ledger = verification.ledger; this.gateway = verification.gateway;
    } else {
      const access = validateAccess(parseStrictJson(readFileSync(resolve(root, 'config/deepseek-access.json'), 'utf8')));
      if (!access.availabilityApproved) throw new AiError('E_AI_NOT_APPROVED');
      mkdirSync(resolve(root, '.local/ai'), { recursive: true });
      this.ledger = new AiLedger(host.queue, resolve(root, '.local/ai/r0-ledger.sqlite'), this.manifest);
      this.gateway = new AiGateway(authority, this.ledger, access, loadDeepSeekCredentialProvider(root), 60000, host);
    }
    this.#dispositionPath = resolve(root, '.local/ai/r0-dispositions.jsonl');
    if (this.ledger.attempts().some(a => a.requestSlotID === this.slotId)) this.#status = 'stopped_restart_history';
    authority.onRevoke(() => { if (this.#request && this.#status !== 'applied') this.#status = 'canceled'; });
    host.onRevision(() => { if (this.#request && host.document().project.revision !== this.#request.snapshot.baseRevision) this.#status = candidates.snapshot()?.state === 'applied' ? 'applied' : 'stale'; });
  }
  #parent(slot: Slot = this.slot): ParentState | null {
    if (!slot.parentSlotID) return null;
    const attempts = this.ledger.attempts().filter(a => a.requestSlotID === slot.parentSlotID); const attempt = attempts[attempts.length - 1];
    if (!attempt || attempt.state !== 'accounted') return null;
    const result = this.ledger.result(attempt.requestId); if (!result) return null;
    const response = result.status === 'answered' ? result.response : null;
    return { attemptId: attempt.attemptId, requestId: attempt.requestId, response, outputHash: response ? canonicalSHA256(response) : null,
      rawOutputHash: attempt.rawOutput === null ? null : digest(attempt.rawOutput), result };
  }
  #parentOptions(parent = this.#parent()): DirectionOption[] { return parent?.response && 'options' in parent.response ? structuredClone(parent.response.options) : []; }
  #dispositions(): Disposition[] {
    if (!existsSync(this.#dispositionPath)) return [];
    let pathCursor = this.root;
    for (const part of ['.local','ai','r0-dispositions.jsonl']) { pathCursor = resolve(pathCursor, part); if (existsSync(pathCursor) && lstatSync(pathCursor).isSymbolicLink()) throw new AiError('E_DISPOSITION_PATH'); }
    if (lstatSync(this.#dispositionPath).size > 1024 * 1024) throw new AiError('E_DISPOSITION_LOG');
    const text = readFileSync(this.#dispositionPath, 'utf8'); if (text.length > 0 && !text.endsWith('\n')) throw new AiError('E_DISPOSITION_LOG');
    const records: Disposition[] = []; const slots = new Set<string>();
    for (const line of text.split('\n').filter(Boolean)) {
      const item = parseStrictJson(line) as Disposition; const { recordHash, ...base } = item;
      const slot = this.manifest.slots.find(s => s.requestSlotID === item.slotId);
      if (item.version !== 'nodon-r0-slot-disposition@1' || item.sequence !== records.length + 1 || item.previousHash !== (records[records.length - 1]?.recordHash ?? null) || canonicalSHA256(base) !== recordHash || slots.has(item.slotId) || !slot?.parentSlotID || slot.parentSlotID !== item.parentSlotId || !item.slotId.endsWith('-F')) throw new AiError('E_DISPOSITION_LOG');
      if (!['parent_no_eligible_options','human_reject','human_retain','program_precondition_unavailable'].includes(item.reason)) throw new AiError('E_DISPOSITION_LOG');
      const parent = this.#parent(slot);
      if (!parent || parent.requestId !== item.parentRequestId || parent.outputHash !== item.parentOutputHash) throw new AiError('E_DISPOSITION_LOG');
      if (item.reason === 'human_reject' || item.reason === 'human_retain') {
        if (!item.witnessRef) throw new AiError('E_DISPOSITION_LOG');
        const witness = readHumanWitness(this.root, item.witnessRef);
        if (witness.slotId !== item.parentSlotId || witness.requestId !== item.parentRequestId || witness.decision !== (item.reason === 'human_reject' ? 'reject' : 'retain')) throw new AiError('E_DISPOSITION_LOG');
      } else {
        if (item.witnessRef !== null) throw new AiError('E_DISPOSITION_LOG');
        if (item.reason === 'parent_no_eligible_options' && (item.programCode !== 'E_PARENT_NO_ELIGIBLE_OPTIONS' || parent.response?.kind === (isExplanationChild(item.slotId) ? 'explain' : 'directions') && this.#parentOptions(parent).length > 0)) throw new AiError('E_DISPOSITION_LOG');
        if (item.reason === 'program_precondition_unavailable' && (!isExplanationChild(item.slotId) || item.programCode !== 'E_PARENT_EVIDENCE_NOT_LIVE')) throw new AiError('E_DISPOSITION_LOG');
      }
      records.push(item); slots.add(item.slotId);
    }
    return records;
  }
  #nextSlot(): string | null {
    const disposed = new Set(this.#dispositions().map(d => d.slotId)); const used = new Set(this.ledger.attempts().map(a => a.requestSlotID));
    return this.manifest.executionOrder.find(id => !used.has(id) && !disposed.has(id)) ?? null;
  }
  #assertOrder(): void {
    if (this.#dispositions().some(d => d.slotId === this.slotId)) throw new AiError('E_SLOT_DISPOSED');
    if (this.#nextSlot() !== this.slotId) throw new AiError('E_FROZEN_EXECUTION_ORDER');
  }
  view() {
    const c = this.candidates.snapshot(); const parent = this.#parent();
    const status = !['canceled','stale','failed','retryable_zero_attempt','blocked_disposed','stopped_restart_history'].includes(this.#status) && c && c.requestId === this.#request?.requestId ? c.state : this.#status;
    const inputNeeded: string[] = [];
    if (this.ledger.budget().inFlight > 0) inputNeeded.push('resolve_unknown_or_in_flight_usage_before_next_slot');
    if (this.#rechecking) inputNeeded.push('wait_for_existing_frozen_recheck');
    else if (this.#preparing) inputNeeded.push('wait_for_frozen_runtime');
    else if (this.#pending) inputNeeded.push('wait_for_existing_request');
    else if (status === 'stopped_restart_history') inputNeeded.push('stop_no_live_request_or_authorization_restored');
    else if (status === 'retryable_zero_attempt') inputNeeded.push('explicit_retry_same_request_only');
    else if (status === 'ready') {
      if (this.slot.parentSlotID) inputNeeded.push('actual_parent_option','human_semantic_direction_review','external_human_witness_reference');
      if (isExplanationInitial(this.slotId)) inputNeeded.push(this.#preparedEvidence ? 'select_actual_terminal_event' : 'prepare_frozen_explanation_run');
      if (isExplanationChild(this.slotId) && parent && !parentLiveContexts.get(this.host)?.has(parent.requestId)) inputNeeded.push('stop_parent_evidence_not_live_after_restart');
      inputNeeded.push('explicit_submit');
    } else if (this.#result?.status === 'answered') inputNeeded.push('human_semantic_decision_with_external_witness');
    return { mode: 'frozen_real_provider_R0_only', slotId: this.slotId, intent: this.#request?.snapshot.requestText ?? this.slot.intent ?? this.slot.intentTemplate ?? '', expectedOutput: this.slot.expectedOutput,
      status, error: this.#error, response: !['canceled','stale','failed','stopped_restart_history'].includes(status) && this.#result?.status === 'answered' ? this.#result.response : null,
      requestId: this.#request?.requestId ?? null, candidateId: c?.source === 'provider_gateway' ? c.candidateId : null,
      budget: this.ledger.budget(), startedAt: this.#startedAt, responseCompletedAt: this.#completedAt,
      participantId: this.participantId, participantRole: this.participantId ? 'developer_self_test' : 'machine_engineering_only', humanDecision: this.#humanDecision,
      parentRequestId: parent?.requestId ?? null, parentActualOutputHash: parent?.outputHash ?? null, parentOptions: this.#parentOptions(parent), inputNeeded,
      selectedRun: this.#preparedEvidence, recheckResult: this.#recheckResult, nextFrozenSlot: this.#nextSlot(), dispositions: this.#dispositions(), billing: 'usage_estimate_pending_supplier_bill', actualIndependentNonDeveloperEvidence: false };
  }
  prepareFrozenExplanationRun(): Promise<ExplanationRunProof> {
    if (this.#preparing) return this.#preparing;
    if (!isExplanationInitial(this.slotId) || this.#request || this.#pending) return Promise.reject(new AiError('E_FROZEN_EXPLANATION_STATE'));
    const work = this.#prepareRun(); this.#preparing = work;
    void work.finally(() => { if (this.#preparing === work) this.#preparing = null; }).catch(() => undefined); return work;
  }
  async #prepareRun(): Promise<ExplanationRunProof> {
    this.#checkRt07Files();
    if (canonicalJson(this.host.document()) !== canonicalJson(this.initialDocument)) throw new AiError('E_FROZEN_BASE_CHANGED');
    const run = await this.host.startRun({ evidenceSource: 'machine_test', inputSource: 'catalog_machine', executionClass: 'automation_test' });
    for (let tick = 1; tick <= 900; tick++) await this.host.input({ runId: run.context.runId, generation: run.context.generation, direction: tick <= 884 ? { x: 0, y: 0 } : { x: 1, y: 0 } });
    return this.host.queue.enqueue(() => { const proof = this.#validateRt07(); this.#preparedEvidence = proof; return structuredClone(proof); });
  }
  #checkRt07Files(): Document {
    const bytes = checkedFrozenBytes(this.root, RT07_FIXTURE, RT07_FIXTURE_HASH); const input = checkedFrozenBytes(this.root, RT07_INPUT, RT07_INPUT_HASH);
    const fixture = assertDocument(parseStrictJson(bytes.toString('utf8')));
    const expected = { segments: [{ ticks: 884, x: 0, y: 0 }, { ticks: 16, x: 1, y: 0 }], maxTicks: 900, inputSource: 'catalog_machine', inputId: 'terminal-conflict' };
    if (canonicalJson(parseStrictJson(input.toString('utf8'))) !== canonicalJson(expected) || fixture.runtimeVersion !== 'collect-chase@1' || fixture.catalogVersion !== 'workshop-core@1') throw new AiError('E_FROZEN_RT07_INPUT');
    return fixture;
  }
  #validateRt07(): ExplanationRunProof {
    this.host.queue.assertActive(); const fixture = this.#checkRt07Files(); const run = this.host.currentRun();
    if (!run || canonicalJson(run.document) !== canonicalJson(fixture) || canonicalJson(this.host.document()) !== canonicalJson(fixture) || run.tick !== 900 || run.status !== 'ended' || run.score !== 1 || run.budgetExhausted || run.diagnostics.length !== 0 ||
      run.context.buildHash !== this.build.buildHash || run.context.runtimeArtifactHash !== this.build.runtimeArtifactHash || run.context.environmentId !== this.build.environmentId || canonicalJson(this.host.buildIdentity()) !== canonicalJson(this.build) ||
      run.context.evidenceSource !== 'machine_test' || run.context.inputSource !== 'catalog_machine' || run.context.executionClass !== 'automation_test' || run.inputs.length !== 900 ||
      run.inputs.some((input, i) => input.tick !== i + 1 || !input.committed || input.lastCommittedTick !== i + 1 || input.direction.x !== (i < 884 ? 0 : 1) || input.direction.y !== 0) ||
      run.terminal?.reason !== 'caught' || run.terminal.goalReached !== true || run.terminal.timeout !== true || run.terminal.caught !== true || run.terminal.primaryGuardId !== 'g1' || canonicalJson(run.terminal.caughtByEntityIds) !== '["g1"]') throw new AiError('E_FROZEN_RT07_REQUIRED');
    const ended = run.events.filter(e => e.kind === 'round_ended');
    if (ended.length !== 1 || ended[0]!.tick !== 900 || run.events.some(e => e.runId !== run.context.runId || e.projectId !== fixture.project.projectId || e.revision !== fixture.project.revision || e.semanticHash !== fixture.project.semanticHash)) throw new AiError('E_FROZEN_RT07_REQUIRED');
    const recommended = run.events.filter(e => e.kind === 'reward_collected' || e.kind === 'round_ended').map(e => e.eventId);
    return { runId: run.context.runId, eventIds: run.events.map(e => e.eventId), recommendedEventIds: recommended, fixtureHash: RT07_FIXTURE_HASH, inputHash: RT07_INPUT_HASH,
      validationHash: canonicalSHA256({ evidenceVersion: 'collect-chase-evidence@3', fixtureHash: RT07_FIXTURE_HASH, inputHash: RT07_INPUT_HASH, runId: run.context.runId, buildHash: run.context.buildHash, runtimeArtifactHash: run.context.runtimeArtifactHash, revision: fixture.project.revision, semanticHash: fixture.project.semanticHash, tick: run.tick, score: run.score, terminal: run.terminal, inputs: run.inputs, events: run.events }) };
  }
  /** Advance only this live answered initial into its one frozen child. It performs no dispatch or credential lookup. */
  advanceToChild(): Promise<ReturnType<RealAiR0Session['view']>> {
    return this.host.queue.enqueue(() => {
      if (this.#pending || this.#preparing || !this.#request || !this.#result || this.#result.status !== 'answered' || this.slot.phase !== 'initial' || this.slot.parentSlotID !== null) throw new AiError('E_ADVANCE_STATE');
      const children = this.manifest.slots.filter(slot => slot.parentSlotID === this.slotId);
      if (children.length !== 1) throw new AiError('E_ADVANCE_NO_UNIQUE_CHILD');
      const child = children[0]!; const direction = expectedDirection(child.requestSlotID);
      if (!direction || (direction === 'minimal_change' ? this.#result.response.kind !== 'explain' : this.#result.response.kind !== 'directions') || !('options' in this.#result.response) || this.#result.response.options.length === 0) throw new AiError('E_ADVANCE_NO_ELIGIBLE_OPTIONS');
      this.gateway.assertAnswered(this.#result, this.host);
      if (this.#nextSlot() !== child.requestSlotID || this.#dispositions().some(d => d.slotId === child.requestSlotID)) throw new AiError('E_FROZEN_EXECUTION_ORDER');
      const frozenChild = readFrozenSlot(this.root, child.requestSlotID);
      if (canonicalJson(frozenChild.manifest) !== canonicalJson(this.manifest) || canonicalJson(frozenChild.document) !== canonicalJson(this.initialDocument) || canonicalJson(this.host.document()) !== canonicalJson(this.initialDocument)) throw new AiError('E_CHILD_BASE_MISMATCH');
      if (isExplanationChild(child.requestSlotID)) {
        const live = parentLiveContexts.get(this.host)?.get(this.#request.requestId);
        if (!live || this.host.currentRun()?.context.runId !== live.runId) throw new AiError('E_PARENT_EVIDENCE_NOT_LIVE');
        this.#validateRt07();
      }
      this.#persist();
      this.#phaseTransitions.push({ fromSlot: this.slotId, toSlot: child.requestSlotID, parentRequestId: this.#request.requestId, parentOutputHash: canonicalSHA256(this.#result.response), recordedAt: new Date().toISOString() });
      this.#slotId = child.requestSlotID; this.#slot = freeze(frozenChild.slot);
      this.#request = null; this.#result = null; this.#humanDecision = null; this.#humanChoice = null; this.#startedAt = null; this.#completedAt = null; this.#explicitRetries = []; this.#error = null; this.#status = 'ready';
      this.#persist(); return this.view();
    });
  }
  /** Local formal re-run only after the matching provider candidate was actually committed. Never applies a candidate or sends AI. */
  recheckFrozenInput(): Promise<FrozenRecheckResult> {
    if (this.#rechecking) return this.#rechecking;
    if (this.#pending || this.#preparing) return Promise.reject(new AiError('E_RECHECK_BUSY'));
    const work = this.#recheckCurrent(); this.#rechecking = work;
    void work.finally(() => { if (this.#rechecking === work) this.#rechecking = null; }).catch(() => undefined); return work;
  }
  #recheckBinding() {
    this.host.queue.assertActive();
    const request = this.#request; const result = this.#result; const candidate = this.candidates.snapshot(); const current = this.host.document();
    if (!isExplanationChild(this.slotId) || !request || !result || result.status !== 'answered' || result.response.kind !== 'propose' ||
      !candidate || candidate.source !== 'provider_gateway' || candidate.state !== 'applied' || candidate.requestId !== request.requestId || !candidate.candidateHash || !candidate.candidateSemanticHash ||
      !candidate.providerEvidence || candidate.providerEvidence.attemptId !== result.attempt.attemptId || candidate.providerEvidence.requestSlotID !== this.slotId || candidate.baseRevision !== request.snapshot.baseRevision || candidate.baseSemanticHash !== request.snapshot.baseSemanticHash ||
      current.project.projectId !== request.snapshot.projectId || current.project.revision !== candidate.baseRevision + 1 || current.project.semanticHash !== candidate.candidateSemanticHash ||
      canonicalJson({ scene: current.project.scene, rules: current.project.rules, presentation: current.project.presentation }) !== canonicalJson(candidate.candidateState)) throw new AiError('E_RECHECK_REQUIRES_APPLIED_CANDIDATE');
    if (!this.host.authorizes(this.authority.snapshot())) throw new AiError('E_WRITER');
    if (canonicalJson(this.host.buildIdentity()) !== canonicalJson(this.build)) throw new AiError('E_BUILD_CHANGED');
    const parent = this.#parent(); const live = parent ? parentLiveContexts.get(this.host)?.get(parent.requestId) : null;
    if (!parent || !live || live.runId !== this.#preparedEvidence?.runId || live.selectedEvidenceHash !== selectedEvidenceDigest(request)) throw new AiError('E_RECHECK_PARENT_BINDING');
    this.#checkRt07Files();
    return { request, candidate, current, parent, live };
  }
  async #recheckCurrent(): Promise<FrozenRecheckResult> {
    const binding = await this.host.queue.enqueue(() => {
      const binding = this.#recheckBinding();
      if (this.#recheckResult && this.#recheckResult.candidateId === binding.candidate.candidateId && this.#recheckResult.revision === binding.current.project.revision && this.#recheckResult.semanticHash === binding.current.project.semanticHash) return { ...binding, cached: this.#recheckResult };
      return { ...binding, cached: null };
    });
    if (binding.cached) return { ...structuredClone(binding.cached), reusedExistingResult: true };
    const started = await this.host.startRun({ evidenceSource: 'machine_test', inputSource: 'catalog_machine', executionClass: 'automation_test' });
    let run = started;
    for (let tick = 1; tick <= 900; tick++) {
      if (run.status !== 'running' || run.budgetExhausted) break;
      run = await this.host.input({ runId: started.context.runId, generation: started.context.generation, direction: tick <= 884 ? { x: 0, y: 0 } : { x: 1, y: 0 } });
    }
    if (run.status === 'running') run = await this.host.pause();
    const summary = await this.host.queue.enqueue(() => {
      const now = this.#recheckBinding(); const actual = this.host.currentRun();
      if (!actual || actual.context.runId !== started.context.runId || actual.context.runId === binding.live.runId || actual.context.buildHash !== this.build.buildHash || actual.context.runtimeArtifactHash !== this.build.runtimeArtifactHash ||
        canonicalJson(actual.document) !== canonicalJson(now.current) || actual.inputs.length > 900 || actual.inputs.some((input, i) => input.tick !== i + 1 || input.direction.x !== (i < 884 ? 0 : 1) || input.direction.y !== 0) || actual.status === 'running') throw new AiError('E_RECHECK_RUN_BINDING');
      const reward = actual.events.some(e => e.kind === 'reward_collected'); const chase = actual.events.some(e => e.kind === 'chase_started'); const terminalReason = actual.terminal?.reason ?? null;
      const result: FrozenRecheckResult = { runId: actual.context.runId, tick: actual.tick, status: actual.status, terminal: structuredClone(actual.terminal), score: actual.score,
        revision: actual.document.project.revision, semanticHash: actual.document.project.semanticHash, buildHash: actual.context.buildHash, runtimeArtifactHash: actual.context.runtimeArtifactHash,
        source: 'machine_test', inputSource: 'catalog_machine', executionClass: 'automation_test', parentRequestId: binding.parent.requestId, parentRunId: binding.live.runId,
        parentActualOutputHash: binding.parent.outputHash, parentSelectedEvidenceHash: binding.live.selectedEvidenceHash, originalValidationHash: this.#preparedEvidence?.validationHash ?? null,
        candidateId: binding.candidate.candidateId, candidateHash: binding.candidate.candidateHash!, candidateSemanticHash: binding.candidate.candidateSemanticHash!, trialRef: binding.candidate.trialRef,
        providerAttemptId: binding.candidate.providerEvidence!.attemptId, fixtureHash: RT07_FIXTURE_HASH, inputHash: RT07_INPUT_HASH,
        coverage: { rewardCollected: reward, chaseObserved: chase, terminalReason, committedInputs: actual.inputs.filter(i => i.committed).length, diagnostics: actual.diagnostics.length, budgetExhausted: actual.budgetExhausted,
          uncovered: [...(!reward ? ['reward collection not observed'] : []), ...(!chase ? ['guard chase not observed'] : []), ...(terminalReason === null ? ['no terminal observed within the frozen input'] : []), 'No difficulty, fairness, playability or learning benefit conclusion'] },
        comparison: { originalTerminalReason: 'caught', observedTerminalReason: terminalReason,
          observation: actual.status === 'fault' || actual.budgetExhausted ? 'runtime_failure_or_budget_limit' : terminalReason === null ? 'no_terminal_observed' : terminalReason === 'caught' ? 'same_terminal_reason_observed' : 'different_terminal_reason_observed',
          improvementJudgment: null, limitation: 'Same frozen input on the committed revision; a changed or unchanged terminal is an observation, not an automatic improvement judgment. No human trial is implied.' },
        runPath: null, exportNature: this.gateway.transportEvidence === 'controlled_transport' ? 'controlled_test_not_exported' : 'genuine_run_package', completedAt: new Date().toISOString(), reusedExistingResult: false };
      return result;
    });
    if (this.gateway.transportEvidence !== 'controlled_transport') {
      const runPath = await this.host.exportCurrentRun({ root: this.root, inputRef: RT07_INPUT, assertions: { purpose: 'frozen_T08_recheck_after_actual_commit', expectedRunId: summary.runId,
        parentRunId: summary.parentRunId, parentRequestId: summary.parentRequestId, parentSelectedEvidenceHash: summary.parentSelectedEvidenceHash, candidateId: summary.candidateId, candidateHash: summary.candidateHash,
        trialRef: summary.trialRef, revision: summary.revision, semanticHash: summary.semanticHash, coverage: summary.coverage, comparison: summary.comparison, inputHash: summary.inputHash } });
      if (basename(runPath) !== summary.runId) throw new AiError('E_RECHECK_EXPORT_BINDING');
      summary.runPath = runPath;
    }
    return this.host.queue.enqueue(() => {
      this.#recheckBinding(); const actual = this.host.currentRun();
      if (!actual || actual.context.runId !== summary.runId || actual.tick !== summary.tick || actual.document.project.revision !== summary.revision || actual.document.project.semanticHash !== summary.semanticHash) throw new AiError('E_RECHECK_RUN_BINDING');
      this.#recheckResult = structuredClone(summary); this.#persist(); return structuredClone(summary);
    });
  }
  submit(eventIds: readonly string[], choice?: HumanChoice): Promise<unknown> {
    if (this.#pending) return this.#pending;
    if (this.#preparing) return Promise.reject(new AiError('E_FROZEN_EXPLANATION_BUSY'));
    if (this.#request) return Promise.resolve(this.view());
    const work = this.#beginSubmit(eventIds, choice); this.#pending = work;
    void work.finally(() => { if (this.#pending === work) this.#pending = null; }).catch(() => undefined); return work;
  }
  async #beginSubmit(eventIds: readonly string[], choice?: HumanChoice): Promise<unknown> {
    const request = await this.host.queue.enqueue(() => {
      if (this.#request || this.#status === 'stopped_restart_history') throw new AiError('E_AI_REQUEST_ALREADY_STARTED');
      if (!Array.isArray(eventIds)) throw new AiError('E_SELECTED_EVIDENCE_IDS');
      if (canonicalJson(this.host.document()) !== canonicalJson(this.initialDocument)) throw new AiError('E_FROZEN_BASE_CHANGED'); this.#assertOrder();
      let requestText = this.slot.intent ?? ''; const parent = this.#parent();
      if (this.slot.parentSlotID !== null) {
        const expected = expectedDirection(this.slotId);
        if (!choice || !this.participantId || !parent || !parent.response || !('options' in parent.response) || !expected || choice.directionClass !== expected || typeof choice.rationale !== 'string' || choice.rationale.length < 1 || choice.rationale.length > 120 || !choice.witnessRef) throw new AiError('E_HUMAN_CHOICE_REQUIRED');
        if (expected === 'minimal_change' ? parent.response.kind !== 'explain' : parent.response.kind !== 'directions') throw new AiError('E_PARENT_RESPONSE_KIND');
        const actual = parent.response.options.find(option => option.id === choice.optionId); if (!actual) throw new AiError('E_HUMAN_CHOICE_REQUIRED');
        const witness = readHumanWitness(this.root, choice.witnessRef);
        if (witness.participantId !== this.participantId || witness.slotId !== this.slot.parentSlotID || witness.requestId !== parent.requestId || witness.decision !== 'accept' || witness.semantic !== 'correct' || witness.optionId !== actual.id || witness.directionClass !== expected || witness.rationale !== choice.rationale) throw new AiError('E_HUMAN_WITNESS_BINDING');
        requestText = materializeChildIntent(this.slot.intentTemplate!, actual);
        this.#humanChoice = { participantId: this.participantId, participantRole: 'developer_self_test', optionId: actual.id, exactOptionText: canonicalJson(actual), rationale: choice.rationale, directionClass: expected, witnessRef: choice.witnessRef,
          parent: { requestId: parent.requestId, actualOutputHash: parent.outputHash, rawOutputHash: parent.rawOutputHash, attemptId: parent.attemptId }, currentProjectIdentity: { projectId: this.host.document().project.projectId, revision: this.host.document().project.revision, semanticHash: this.host.document().project.semanticHash, buildHash: this.build.buildHash, runtimeArtifactHash: this.build.runtimeArtifactHash } };
      } else if (choice !== undefined) throw new AiError('E_UNEXPECTED_CHOICE');
      if (!requestText || requestText.length > 300) throw new AiError('E_TEXT_LENGTH');
      const requestId = randomUUID(), base = this.host.document(); const auth = this.authority.snapshot();
      const r: SubmitRequest = { requestSlotID: this.slotId, requestId, idempotencyKey: randomUUID(), document: base,
        snapshot: { sessionId: auth.sessionId, writerToken: auth.writerToken, authEpoch: auth.authEpoch, projectId: base.project.projectId, requestId, baseRevision: base.project.revision, baseSemanticHash: base.project.semanticHash,
          runtimeVersion: base.runtimeVersion, catalogVersion: base.catalogVersion, ruleRegistryVersion: 'collect-chase-rules@1', trialPolicyVersion: 'collect-chase-candidate-trial@2', capabilityVersion: 'nodon-r0-capabilities@1', requestText, selectedEvidenceRefs: [] } };
      this.authority.check(r.snapshot);
      if (isExplanationInitial(this.slotId)) {
        const proof = this.#validateRt07(); const run = this.host.currentRun()!; const terminalId = run.events.find(e => e.kind === 'round_ended')!.eventId;
        if (eventIds.length === 0 || !eventIds.includes(terminalId)) throw new AiError('E_SELECTED_TERMINAL_REQUIRED');
        bindSelectedEvidence(r, this.host, eventIds); this.#preparedEvidence = proof;
        let contexts = parentLiveContexts.get(this.host); if (!contexts) { contexts = new Map(); parentLiveContexts.set(this.host, contexts); }
        contexts.set(r.requestId, { request: r, runId: proof.runId, selectedIds: [...eventIds], selectedEvidenceHash: selectedEvidenceDigest(r) });
      } else if (isExplanationChild(this.slotId)) {
        const live = parent ? parentLiveContexts.get(this.host)?.get(parent.requestId) : null;
        if (!live || this.host.currentRun()?.context.runId !== live.runId) throw new AiError('E_PARENT_EVIDENCE_NOT_LIVE');
        if (eventIds.length && canonicalJson(eventIds) !== canonicalJson(live.selectedIds)) throw new AiError('E_PARENT_EVIDENCE_CHANGED');
        bindSelectedEvidence(r, this.host, live.selectedIds);
        if (selectedEvidenceDigest(r) !== live.selectedEvidenceHash) throw new AiError('E_PARENT_EVIDENCE_CHANGED');
      } else if (eventIds.length !== 0) throw new AiError('E_UNEXPECTED_EVIDENCE');
      this.#request = r; this.#status = 'pending'; this.#error = null; this.#startedAt = new Date().toISOString(); return r;
    });
    return this.#send(request);
  }
  retry(): Promise<unknown> {
    if (this.#pending) return this.#pending;
    const request = this.#request;
    if (!request || this.#status !== 'retryable_zero_attempt' || this.ledger.attempts(request.requestId).length !== 0) return Promise.reject(new AiError('E_EXPLICIT_RETRY_NOT_ELIGIBLE'));
    const work = this.host.queue.enqueue(() => {
      this.authority.check(request.snapshot); this.#assertOrder();
      if (canonicalJson(this.host.document()) !== canonicalJson(request.document) || canonicalJson(this.host.buildIdentity()) !== canonicalJson(this.build)) throw new AiError('E_FROZEN_BASE_CHANGED');
      this.#explicitRetries.push({ recordedAt: new Date().toISOString(), requestId: request.requestId, attemptCountBefore: 0 }); this.#status = 'pending'; this.#error = null; return request;
    }).then(r => this.#send(r));
    this.#pending = work; void work.finally(() => { if (this.#pending === work) this.#pending = null; }).catch(() => undefined); return work;
  }
  async #send(request: SubmitRequest): Promise<unknown> {
    try {
      const result = await this.gateway.submit(request); this.#result = result; this.#completedAt = new Date().toISOString(); this.#status = result.status;
      if (result.status === 'answered' && result.response.kind === 'propose') { const c = await this.candidates.prepareFromGateway(this.gateway, result); this.#status = c.state; }
      this.#persist(); return this.view();
    } catch (error) {
      this.#error = errorCode(error); this.#status = this.ledger.attempts(request.requestId).length === 0 ? 'retryable_zero_attempt' : 'failed'; this.#completedAt = new Date().toISOString(); this.#persist(); throw error;
    }
  }
  async cancel(): Promise<unknown> {
    const request = this.#request; if (!request) throw new AiError('E_AI_NO_REQUEST');
    await this.gateway.cancel(request.requestId); await this.candidates.revoke('E_REQUEST_CANCELED'); this.#status = 'canceled'; this.#persist(); return this.view();
  }
  decision(input: HumanDecision): Promise<unknown> {
    return this.host.queue.enqueue(() => {
      if (!input || typeof input !== 'object' || !this.participantId || !this.#result || !this.#request || !['accept','reject','retain'].includes(input.decision) || !['correct','incorrect','unknown'].includes(input.semantic) || typeof input.rationale !== 'string' || input.rationale.length < 1 || input.rationale.length > 300) throw new AiError('E_HUMAN_DECISION');
      let witness: HumanWitness | null = null;
      if (input.witnessRef) {
        witness = readHumanWitness(this.root, input.witnessRef);
        if (witness.participantId !== this.participantId || witness.slotId !== this.slotId || witness.requestId !== this.#request.requestId || witness.decision !== input.decision || witness.semantic !== input.semantic || witness.rationale !== input.rationale ||
          (input.optionId !== undefined && witness.optionId !== input.optionId) || (input.directionClass !== undefined && witness.directionClass !== input.directionClass)) throw new AiError('E_HUMAN_WITNESS_BINDING');
      }
      this.#humanDecision = { ...input, participantId: this.participantId, participantRole: 'developer_self_test', recordedAt: new Date().toISOString(),
        evidenceNature: witness ? 'external_human_witness_bound_internal_self_test' : 'browser_submitted_self_report_requires_external_human_witness', witnessed: witness !== null,
        requestId: this.#request.requestId, candidateId: this.candidates.snapshot()?.candidateId ?? null };
      this.#persist(); return this.view();
    });
  }
  disposeBlockedChild(input: { reason: string; witnessRef?: string }): Promise<unknown> {
    return this.host.queue.enqueue(() => {
      if (!input || typeof input !== 'object') throw new AiError('E_DISPOSITION_NOT_CHILD');
      const children = this.slot.parentSlotID === null ? this.manifest.slots.filter(s => s.parentSlotID === this.slotId) : [];
      const target = this.slot.parentSlotID !== null ? this.slot : children.length === 1 ? children[0]! : null;
      if (!target?.parentSlotID || !target.requestSlotID.endsWith('-F') || (target === this.slot && this.#request !== null) || this.ledger.attempts().some(a => a.requestSlotID === target.requestSlotID)) throw new AiError('E_DISPOSITION_NOT_CHILD');
      if (this.#dispositions().some(d => d.slotId === target.requestSlotID)) throw new AiError('E_SLOT_DISPOSED');
      if (this.#nextSlot() !== target.requestSlotID) throw new AiError('E_FROZEN_EXECUTION_ORDER');
      const parent = this.#parent(target); if (!parent) throw new AiError('E_PARENT_NOT_FINAL');
      let reason: Disposition['reason']; let witnessRef: string | null = null; let programCode: string | null = null;
      if (input.reason === 'human_reject' || input.reason === 'human_retain') {
        if (!input.witnessRef || !this.participantId) throw new AiError('E_HUMAN_WITNESS');
        const witness = readHumanWitness(this.root, input.witnessRef); const expected = input.reason === 'human_reject' ? 'reject' : 'retain';
        if (witness.participantId !== this.participantId || witness.slotId !== target.parentSlotID || witness.requestId !== parent.requestId || witness.decision !== expected) throw new AiError('E_HUMAN_WITNESS_BINDING');
        reason = input.reason; witnessRef = input.witnessRef;
      } else if (input.reason === 'parent_no_eligible_options') {
        const expectedKind = isExplanationChild(target.requestSlotID) ? 'explain' : 'directions';
        if (parent.response?.kind === expectedKind && this.#parentOptions(parent).length > 0) throw new AiError('E_PROGRAM_CANNOT_JUDGE_DIRECTION_SEMANTICS');
        reason = input.reason; programCode = 'E_PARENT_NO_ELIGIBLE_OPTIONS';
      } else if (input.reason === 'program_precondition_unavailable' && isExplanationChild(target.requestSlotID) && !parentLiveContexts.get(this.host)?.has(parent.requestId)) {
        reason = input.reason; programCode = 'E_PARENT_EVIDENCE_NOT_LIVE';
      } else throw new AiError('E_DISPOSITION_REASON');
      const previous = this.#dispositions(); const record = { version: 'nodon-r0-slot-disposition@1' as const, sequence: previous.length + 1, dispositionId: randomUUID(), recordedAt: new Date().toISOString(), slotId: target.requestSlotID,
        parentSlotId: target.parentSlotID, parentRequestId: parent.requestId, parentOutputHash: parent.outputHash, reason, witnessRef, programCode, previousHash: previous[previous.length - 1]?.recordHash ?? null };
      mkdirSync(dirname(this.#dispositionPath), { recursive: true });
      appendFileSync(this.#dispositionPath, canonicalJson({ ...record, recordHash: canonicalSHA256(record) }) + '\n', { encoding: 'utf8', flag: 'a' });
      this.#status = 'blocked_disposed'; this.#error = programCode ?? reason; this.#persist(); return this.view();
    });
  }
  checkpoint(): void { if (this.#request || this.#status === 'blocked_disposed') this.#persist(); }
  #persist(): void {
    persistBuildIdentity(this.build, this.root);
    const dir = resolve(this.root, 'evidence/r0', this.build.buildId, '07_ai/frozen', this.slotId); mkdirSync(dir, { recursive: true });
    const contract = this.#request ? promptSchemaDescriptor(this.#request) : null; let bodyHash: string | null = null; let bodyUtf8Bytes: number | null = null; let bodyBuildError: string | null = null;
    if (this.#request) { try { const body = buildBody(this.#request); bodyHash = digest(body); bodyUtf8Bytes = Buffer.byteLength(body); } catch (error) { bodyBuildError = errorCode(error); } }
    const record = { source: this.gateway.transportEvidence, buildId: this.build.buildId, buildHash: this.build.buildHash, runtimeArtifactHash: this.build.runtimeArtifactHash,
      slotId: this.slotId, participantId: this.participantId, participantRole: this.participantId ? 'developer_self_test' : 'machine_engineering_only',
      request: this.#request ? { requestId: this.#request.requestId, baseRevision: this.#request.snapshot.baseRevision, baseSemanticHash: this.#request.snapshot.baseSemanticHash,
        intent: this.#request.snapshot.requestText, selectedEvidence: selectedEvidenceProjection(this.#request), selectedEvidenceHash: selectedEvidenceDigest(this.#request),
        promptPhase: contract?.phase, promptSchemaHash: contract?.schemaHash, requestBodyHash: bodyHash, bodyUtf8Bytes, framingAllowanceBytes: 1024, bodyBuildError } : null,
      state: this.view(), result: this.#result, candidate: this.candidates.snapshot(), humanDecision: this.#humanDecision, humanChoice: this.#humanChoice, explanationRun: this.#preparedEvidence, explicitZeroAttemptRetries: this.#explicitRetries, phaseTransitions: this.#phaseTransitions, recheckResult: this.#recheckResult,
      limitation: 'Transport/program evidence do not prove human semantic correctness or independent usability; browser self-report requires external witness; supplier bill pending; restart never restores an old send/apply capability' };
    writeFileSync(resolve(dir, randomUUID() + '.json'), JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
  }
  async close(): Promise<void> { await this.gateway.shutdown(); if (this.#pending) await this.#pending.catch(() => undefined); this.ledger.close(); }
}
