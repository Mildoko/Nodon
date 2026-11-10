import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { assertAuthorizedRoot, type ExportRunOptions } from '../evidence/run-evidence.js';
import { createBuildIdentity, digest, persistBuildIdentity } from '../../tools/build-manifest.js';
import { randomUUID } from 'node:crypto';
import { setImmediate } from 'node:timers/promises';
import { applyOperations, candidateHash, canonicalJson, canonicalSHA256, DomainError,
  type CandidateHashInput, type CommandResult, type Document, type Operation, type ValidationError } from '../domain/index.js';
import { AiGateway } from '../ai/gateway.js';
import { selectedEvidenceDigest } from '../ai/selected-evidence.js';
import { AiAuthority } from '../ai/authority.js';
import { AiError, type RequestSnapshot, type GatewayResult, type ProviderEvidence, type SubmitRequest } from '../ai/types.js';
import { R0Host } from '../host/r0-host.js';
import { RunSession, type RunSnapshot } from '../host/run-session.js';
import type { Direction, GameplayEvent, RunOptions } from '../runtime/index.js';
import type { BuildIdentity } from '../../tools/build-manifest.js';
import { exportGenuineRun } from './export-run.js';
import { issueCommitPermit } from './commit-permit.js';
import type { CandidateSnapshot, ControlledCandidateInput, TrialRecord } from './types.js';

export interface CandidateManagerOptions {
  currentBuild: () => BuildIdentity;
  /** Test scheduler controls release without injecting a fake Runtime result. */
  yieldSlice?: () => Promise<void>;
  /** Node-only adverse verification probes; HTTP must never accept these settings. */
  verification?: { executorAvailable?: boolean; tickCap?: number; expectedTargetScore?: number; runtimeOptions?: RunOptions };
}
interface InternalCandidate { public: CandidateSnapshot; binding: RequestSnapshot; base: Document; draft: Document | null; build: BuildIdentity; run: RunSession | null; gateway: AiGateway | null; gatewayResult: GatewayResult | null }
// Exact frozen CC-SMOKE-01 catalog input. Compiled bytes are in the build manifest.
const smoke = { scriptId: 'CC-SMOKE-01', segments: [{ ticks: 30, x: 0, y: 0 }, { ticks: 60, x: 1, y: 0 }, { ticks: 60, x: 0, y: 1 }, { ticks: 30, x: -1, y: 0 }],
  maxTicks: 180, stopOnLegalTerminal: true, inputSource: 'catalog_machine', inputId: 'smoke' } as const;
function smokeDirection(tick: number): Direction {
  let end = 0;
  for (const segment of smoke.segments) { end += segment.ticks; if (tick <= end) return { x: segment.x, y: segment.y }; }
  throw new AiError('E_SMOKE_TICK');
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![\s\S])/i;
function code(error: unknown): string { return error instanceof DomainError || error instanceof AiError ? error.code : error instanceof Error ? error.message : 'E_CANDIDATE'; }
function errors(error: unknown): ValidationError[] { return error instanceof DomainError ? structuredClone(error.errors) : [{ code: code(error), path: '', message: code(error) }]; }
function projection(doc: Document) { return { scene: doc.project.scene, rules: doc.project.rules, presentation: doc.project.presentation }; }
function identity(build: BuildIdentity): string {
  return canonicalJson({ buildHash: build.buildHash, runtimeArtifactHash: build.runtimeArtifactHash,
    environmentId: build.environmentId, contractHash: build.manifest['contractHash'] ?? null,
    trustedConfigHashes: build.manifest['trustedConfigHashes'] ?? null });
}
function hashInput(binding: RequestSnapshot, operations: Operation[], draft: Document): CandidateHashInput {
  return { projectId: binding.projectId, requestId: binding.requestId, baseRevision: binding.baseRevision,
    baseSemanticHash: binding.baseSemanticHash, runtimeVersion: binding.runtimeVersion, catalogVersion: binding.catalogVersion,
    ruleRegistryVersion: binding.ruleRegistryVersion, trialPolicyVersion: binding.trialPolicyVersion, operations, candidateState: projection(draft) };
}
function eventValid(event: GameplayEvent, run: RunSnapshot): boolean {
  const { rules, scene } = run.document.project;
  let expectedRule: string | null; let valuesValid = true;
  switch (event.kind) {
    case 'run_started': expectedRule = null;
      valuesValid = event.tick === 0 && event.actualValues.score === 0 && event.actualValues.targetScore === rules.goal.targetScore &&
        canonicalJson(event.actualValues.timer) === canonicalJson(rules.timer) && event.actualValues.guardCount === scene.entities.filter(entity => entity.kind === 'guard').length &&
        event.actualValues.rewardCount === scene.entities.filter(entity => entity.kind === 'normal' || entity.kind === 'high').length; break;
    case 'chase_started': case 'chase_stopped': expectedRule = 'rule.guard.chase@1';
      valuesValid = event.actualValues.speed === rules.guards.speed && event.actualValues.detectRadius === rules.guards.detectRadius; break;
    case 'reward_collected': case 'score_changed': expectedRule = 'rule.reward.collect@1';
      valuesValid = event.actualValues.value === (event.actualValues.rewardKind === 'normal' ? rules.rewards.normalValue : rules.rewards.highValue); break;
    case 'goal_checked': expectedRule = 'rule.goal.score@1'; valuesValid = event.actualValues.targetScore === rules.goal.targetScore; break;
    case 'round_ended': expectedRule = event.actualValues.reason === 'caught' ? 'rule.contact.fail@1' : event.actualValues.reason === 'timeout' ? 'rule.timer.limit@1' : 'rule.goal.score@1';
      valuesValid = event.actualValues.targetScore === rules.goal.targetScore; break;
  }
  return valuesValid && event.runId === run.context.runId && event.projectId === run.document.project.projectId && event.revision === run.document.project.revision &&
    event.semanticHash === run.document.project.semanticHash && event.ruleId === expectedRule &&
    event.observationPhase === (event.kind === 'run_started' || event.kind === 'chase_started' || event.kind === 'chase_stopped' ? 'before_move' : 'after_move');
}
/** All mutable candidate state lives in Node and shares Host/AiAuthority's exact FIFO queue. */
export class CandidateManager {
  #active: InternalCandidate | null = null;
  readonly #candidates = new Map<string, InternalCandidate>();
  readonly #receipts = new Map<string, { candidateId: string; result: CommandResult }>();
  readonly #yield: () => Promise<void>;
  constructor(readonly host: R0Host, readonly authority: AiAuthority, readonly options: CandidateManagerOptions) {
    if (host.queue !== authority.queue || !host.authorizes(authority.snapshot())) throw new AiError('E_AUTHORITY_OWNER');
    this.#yield = options.yieldSlice ?? (() => setImmediate());
    const cap = options.verification?.tickCap;
    if (cap !== undefined && (!Number.isSafeInteger(cap) || cap < 0 || cap > 180)) throw new AiError('E_TRIAL_CAP');
    authority.onRevoke(() => { for (const item of this.#candidates.values()) this.#terminate(item, 'canceled', 'E_AUTH_REVOKED'); });
    host.onRevision(() => { for (const item of this.#candidates.values()) this.#terminate(item, 'stale', 'E_REVISION_CONFLICT'); });
  }
  snapshot(): CandidateSnapshot | null { return this.#active ? this.#view(this.#active) : null; }
  candidate(candidateId: string): CandidateSnapshot { return this.#view(this.#get(candidateId)); }
  prepareControlled(input: ControlledCandidateInput): Promise<CandidateSnapshot> {
    return this.host.queue.enqueue(() => {
      if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',') !== 'operations,requestId' || typeof input.requestId !== 'string' || !uuid.test(input.requestId)) throw new AiError('E_SCHEMA');
      const base = this.host.document(); const auth = this.authority.snapshot();
      const binding: RequestSnapshot = { ...auth, requestId: input.requestId, baseRevision: base.project.revision, baseSemanticHash: base.project.semanticHash,
        runtimeVersion: base.runtimeVersion, catalogVersion: base.catalogVersion, ruleRegistryVersion: 'collect-chase-rules@1',
        trialPolicyVersion: 'collect-chase-candidate-trial@2', capabilityVersion: 'nodon-r0-capabilities@1', requestText: '', selectedEvidenceRefs: [] };
      return this.#prepare(binding, base, input.operations, 'controlled_fixture', null, null, null);
    });
  }
  /** Shares the exact candidate/trial/commit path; a browser or ledger JSON cannot manufacture provider provenance. */
  prepareFromGateway(gateway: AiGateway, result: GatewayResult): Promise<CandidateSnapshot> {
    return this.host.queue.enqueue(() => {
      if (!(gateway instanceof AiGateway) || gateway.authority !== this.authority || gateway.host !== this.host || gateway.authority.queue !== this.host.queue) throw new AiError('E_AUTHORITY_OWNER');
      const proof = gateway.assertAnswered(result, this.host);
      if (result.status !== 'answered' || result.response.kind !== 'propose') throw new AiError('E_RESPONSE_NOT_CANDIDATE');
      if (identity(proof.build as BuildIdentity) !== identity(this.options.currentBuild()) || identity(proof.build as BuildIdentity) !== identity(this.host.buildIdentity())) throw new AiError('E_BUILD_CHANGED');
      const providerEvidence: ProviderEvidence = { transport: proof.transportEvidence, requestSlotID: proof.request.requestSlotID, attemptId: result.attempt.attemptId,
        providerRequestId: result.attempt.providerRequestId, usageCostStatus: 'usage_calculated_pending_bill', selectedEvidenceHash: selectedEvidenceDigest(proof.request as SubmitRequest) };
      return this.#prepare(structuredClone(proof.request.snapshot), structuredClone(proof.request.document), result.response.operations, 'provider_gateway', providerEvidence, gateway, result);
    });
  }
  #prepare(binding: RequestSnapshot, base: Document, operations: Operation[], source: CandidateSnapshot['source'], providerEvidence: ProviderEvidence | null, gateway: AiGateway | null, gatewayResult: GatewayResult | null): CandidateSnapshot {
    this.host.queue.assertActive(); this.authority.check(binding); if (!this.host.authorizes(binding)) throw new AiError('E_WRITER');
    const current = this.host.document();
    if (current.project.projectId !== binding.projectId || current.project.revision !== binding.baseRevision || current.project.semanticHash !== binding.baseSemanticHash || canonicalJson(current) !== canonicalJson(base)) throw new AiError('E_REVISION_CONFLICT');
    if ([...this.#candidates.values()].some(item => item.public.requestId === binding.requestId)) throw new AiError('E_REQUEST_DUPLICATE');
    if (identity(this.options.currentBuild()) !== identity(this.host.buildIdentity())) throw new AiError('E_BUILD_CHANGED');
      if (this.#active) this.#terminate(this.#active, 'canceled', 'E_SUPERSEDED');
      const item: InternalCandidate = { binding, base, draft: null, build: structuredClone(this.options.currentBuild()), run: null, gateway, gatewayResult,
        public: { source, providerEvidence, candidateId: randomUUID(), requestId: binding.requestId, baseRevision: binding.baseRevision,
          baseSemanticHash: binding.baseSemanticHash, candidateHash: null, candidateSemanticHash: null, operations: [], candidateState: null,
          canConfirm: false, canTrial: false, eligibilityError: null, state: 'validation_blocked', validation: 'invalid', trialRequirement: 'runtime', trialStatus: 'blocked', trialRef: null,
          trial: null, errors: [], predictedImpact: source === 'controlled_fixture' ? '受控操作的参数变更；行为结果需实际证据。' : '真实网关提案；意图忠实度、行为及帮助仍需实际证据与作者判断。', actualCoverage: [], missingCoverage: [] } };
      try {
        item.draft = applyOperations(base, operations); item.public.operations = structuredClone(operations);
        item.public.candidateState = projection(structuredClone(item.draft)); item.public.candidateSemanticHash = item.draft.project.semanticHash;
        item.public.candidateHash = candidateHash(hashInput(binding, item.public.operations, item.draft)); item.public.validation = 'static_valid';
        const themeOnly = item.public.operations.every(op => op.op === 'set_theme');
        item.public.trialRequirement = themeOnly ? 'static' : 'runtime'; item.public.trialStatus = themeOnly ? 'runtime_not_applicable' : 'not_run';
        item.public.state = themeOnly ? 'proposed' : 'validation_pending';
        if (themeOnly) item.public.trial = this.#record(item, 'runtime_not_applicable');
      } catch (error) { item.public.errors = errors(error); }
      this.#active = item; this.#candidates.set(item.public.candidateId, item); return this.#view(item);
  }
  async submitControlled(input: ControlledCandidateInput): Promise<CandidateSnapshot> {
    const candidate = await this.prepareControlled(input);
    return candidate.trialStatus === 'not_run' ? this.trial(candidate.candidateId) : candidate;
  }
  async trial(candidateId: string): Promise<CandidateSnapshot> {
    const item = await this.host.queue.enqueue(() => {
      const item = this.#get(candidateId); this.#check(item);
      if (item.public.state !== 'validation_pending' || item.public.trialStatus !== 'not_run' || !item.draft) throw new AiError('E_TRIAL_STATE');
      if (this.options.verification?.executorAvailable === false) return item;
      if (this.options.verification?.tickCap === 0) {
        item.public.state = 'validation_blocked'; item.public.trialStatus = 'blocked';
        item.public.errors = [{ code: 'E_TRIAL_BUDGET', path: '/trial', message: 'Verification executor has no tick budget' }]; return item;
      }
      try { item.run = new RunSession(item.draft, { runId: randomUUID(), generation: 1, buildHash: item.build.buildHash,
        runtimeArtifactHash: item.build.runtimeArtifactHash, environmentId: item.build.environmentId,
        evidenceSource: 'machine_test', inputSource: 'catalog_machine', executionClass: 'automation_test' }, this.options.verification?.runtimeOptions); }
      catch (error) { item.public.state = 'validation_blocked'; item.public.trialStatus = 'blocked'; item.public.errors = errors(error); return item; }
      item.public.trialStatus = 'running'; item.public.trial = this.#record(item, 'running'); item.public.trialRef = item.run.snapshot().context.runId;
      return item;
    });
    if (!item.run) return this.#view(item);
    try {
      for (let offset = 0; offset < 180; offset += 15) {
        await this.#yield();
        const done = await this.host.queue.enqueue(() => {
          this.#check(item); const run = item.run; if (!run) throw new AiError('E_TRIAL_STATE');
          for (let count = 0; count < 15; count++) {
            const state = run.snapshot();
            if (state.status !== 'running' || state.budgetExhausted || state.tick >= (this.options.verification?.tickCap ?? 180)) break;
            const tick = state.tick + 1;
            const direction = smokeDirection(tick);
            run.step({ runId: state.context.runId, generation: state.context.generation, direction });
          }
          item.public.trial = this.#record(item, 'running');
          const last = run.snapshot(); return last.tick >= (this.options.verification?.tickCap ?? 180) || last.status !== 'running' || last.budgetExhausted;
        });
        if (done) break;
      }
      // Result delivery is its own queued gate: a revocation during the last slice wins.
      await this.#yield();
      return await this.host.queue.enqueue(() => {
        this.#check(item); const record = this.#record(item, 'running'); const run = record.run!;
        record.status = run.budgetExhausted || run.status === 'running' && run.tick < 180 ? 'blocked' : Object.values(record.assertions).every(Boolean) ? 'passed' : 'failed';
        item.public.trial = record; item.public.trialStatus = record.status;
        item.public.state = record.status === 'passed' ? 'proposed' : 'validation_blocked';
        item.public.actualCoverage = Object.entries(record.coverage).filter(([, value]) => value === true).map(([key]) => key);
        item.public.missingCoverage = record.coverage.uncovered;
        if (record.status !== 'passed') item.public.errors = [{ code: record.status === 'blocked' ? 'E_TRIAL_BLOCKED' : 'E_TRIAL_FAILED', path: '/trial', message: 'Actual Runtime trial did not pass' }];
        return this.#view(item);
      });
    } catch (error) {
      return this.host.queue.enqueue(() => {
        if (item.public.state !== 'stale' && item.public.state !== 'canceled' && item.public.state !== 'rejected') {
          item.public.state = 'validation_blocked'; item.public.trialStatus = 'blocked'; item.public.errors = errors(error);
        }
        if (item.run) item.public.trial = this.#record(item, item.public.trialStatus);
        return this.#view(item);
      });
    }
  }
  confirm(candidateId: string, commandId: string = randomUUID()): Promise<CommandResult> {
    return this.host.queue.enqueue(() => {
      const failed = (error: unknown): CommandResult => ({ ok: false, code: code(error), errors: errors(error), currentRevision: this.host.document().project.revision });
      if (!uuid.test(commandId)) return failed(new AiError('E_SCHEMA'));
      try { this.host.claimCandidateCommandId(commandId); } catch (error) { return failed(error); }
      const prior = this.#receipts.get(commandId);
      if (prior) return prior.candidateId === candidateId ? structuredClone(prior.result) : failed(new AiError('E_IDEMPOTENCY_CONFLICT'));
      let result: CommandResult;
      try {
        const item = this.#get(candidateId); if (item.public.state === 'applied') throw new AiError('E_ALREADY_APPLIED');
        this.#check(item); if (item.public.state !== 'proposed' || !item.draft || !item.public.candidateHash) throw new AiError('E_CANDIDATE_NOT_READY');
        const draft = applyOperations(this.host.document(), item.public.operations);
        if (candidateHash(hashInput(item.binding, item.public.operations, draft)) !== item.public.candidateHash) throw new AiError('E_CANDIDATE_HASH');
        const record = item.public.trial;
        if (!record || record.candidateHash !== item.public.candidateHash || record.candidateSemanticHash !== draft.project.semanticHash ||
          record.trialPolicyVersion !== item.binding.trialPolicyVersion || record.buildHash !== item.build.buildHash || record.runtimeArtifactHash !== item.build.runtimeArtifactHash ||
          record.environmentId !== item.build.environmentId || canonicalJson(record.contractHash) !== canonicalJson(item.build.manifest['contractHash'] ?? null)) throw new AiError('E_TRIAL_BINDING');
        if (item.public.trialRequirement === 'runtime' ? record.status !== 'passed' || !record.trialId || !record.run || !Object.values(record.assertions).every(Boolean) :
          record.status !== 'runtime_not_applicable' || record.trialId !== null || record.run !== null) throw new AiError('E_TRIAL_NOT_PASSED');
        // Mark applied in the same critical section, after Store commit. Revision listeners skip this candidate.
        const previous = item.public.state; item.public.state = 'applied';
        try { result = this.host.commitCandidate(issueCommitPermit(this.host, draft, item.binding.baseRevision)); }
        catch (error) { item.public.state = previous; throw error; }
      } catch (error) { result = failed(error); }
      this.#receipts.set(commandId, { candidateId, result: structuredClone(result) }); return structuredClone(result);
    });
  }
  cancel(candidateId: string): Promise<CandidateSnapshot> {
    return this.host.queue.enqueue(() => { const item = this.#get(candidateId); this.#terminate(item, 'rejected', 'E_CANDIDATE_REJECTED'); return this.#view(item); });
  }
  revoke(reason: string): Promise<void> {
    return this.host.queue.enqueue(() => { for (const item of this.#candidates.values()) this.#terminate(item, 'canceled', reason); });
  }
  /** Exports native history, including failed/canceled trials, without granting application rights. */
  exportTrial(candidateId: string, options: ExportRunOptions = {}): Promise<{ runPath: string | null; proofPath: string }> {
    return this.host.queue.enqueue(() => {
      const item = this.#get(candidateId); const root = assertAuthorizedRoot(options.root);
      if (identity(this.options.currentBuild()) !== identity(item.build) || identity(this.host.buildIdentity()) !== identity(item.build)) throw new AiError('E_BUILD_CHANGED');
      if (!item.public.trial) throw new AiError('E_TRIAL_NO_RECORD');
      if (item.public.trialStatus === 'running') throw new AiError('E_TRIAL_RUNNING');
      const record = this.#record(item, item.public.trialStatus);
      const runPath = item.run ? exportGenuineRun(item.run, item.build, { ...options,
        inputRef: 'verification/inputs/smoke.json', assertions: { source: item.public.source, providerEvidence: item.public.providerEvidence, candidateId, candidateHash: item.public.candidateHash,
          trialPolicyVersion: record.trialPolicyVersion, trialStatus: record.status, assertions: record.assertions, coverage: record.coverage,
          ...(options.assertions === undefined ? {} : { callerAssertions: options.assertions }) } }) : null;
      if (runPath === null && item.public.trialRequirement !== 'static') throw new AiError('E_TRIAL_NO_RUN');
      if (runPath === null) {
        const actual = createBuildIdentity(root); if (identity(actual) !== identity(item.build)) throw new AiError('E_BUILD_CHANGED');
        persistBuildIdentity(actual, root);
      }
      const folder = resolve(root, 'evidence/r0', item.build.buildId, '06_candidates', item.public.candidateId);
      for (let cursor = folder; cursor !== root; cursor = dirname(cursor)) {
        if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) throw new AiError('E_EVIDENCE_SYMLINK');
        if (dirname(cursor) === cursor) throw new AiError('E_EVIDENCE_PATH');
      }
      mkdirSync(folder, { recursive: true });
      const proofPath = resolve(folder, `trial-${record.trialId ?? 'static'}.json`);
      const proof = { proofVersion: 'nodon-r0-candidate-proof@1', source: item.public.source, providerEvidence: item.public.providerEvidence, candidate: this.#view(item),
        trial: record, runPath, runPackageManifestHash: runPath === null ? null : digest(readFileSync(resolve(runPath, 'manifest.json'))),
        claim: record.status === 'passed' ? 'Technical smoke only; no route or difficulty conclusion' : record.status === 'runtime_not_applicable' ? 'Static theme validation only; no Runtime execution' : 'Historical incomplete or unsuccessful trial; cannot apply' };
      const proofBytes = JSON.stringify(proof, null, 2) + '\n';
      if (existsSync(proofPath)) {
        if (lstatSync(proofPath).isSymbolicLink() || readFileSync(proofPath, 'utf8') !== proofBytes) throw new AiError('E_EVIDENCE_EXPORT_CONFLICT');
      } else writeFileSync(proofPath, proofBytes, { flag: 'wx' });
      return { runPath, proofPath };
    });
  }
  #view(item: InternalCandidate): CandidateSnapshot {
    const result = structuredClone(item.public); const auth = this.authority.snapshot(); const current = this.host.document();
    let eligibilityError: string | null = null;
    if (!auth.adultEnabled) eligibilityError = 'E_ADULT_DISABLED';
    else if (!auth.scopeEnabled) eligibilityError = 'E_SCOPE';
    else if (auth.authEpoch !== item.binding.authEpoch) eligibilityError = 'E_AUTH_EPOCH';
    else if (!this.host.authorizes(auth) || auth.sessionId !== item.binding.sessionId || auth.writerToken !== item.binding.writerToken || auth.projectId !== item.binding.projectId) eligibilityError = 'E_WRITER';
    else if (item.gateway && item.gateway.ledger.canceled(item.binding.requestId)) eligibilityError = 'E_REQUEST_CANCELED';
    else if (current.project.revision !== item.binding.baseRevision || current.project.semanticHash !== item.binding.baseSemanticHash) eligibilityError = 'E_REVISION_CONFLICT';
    else {
      try { if (identity(this.options.currentBuild()) !== identity(item.build) || identity(this.host.buildIdentity()) !== identity(item.build)) eligibilityError = 'E_BUILD_CHANGED'; }
      catch { eligibilityError = 'E_BUILD_CHANGED'; }
    }
    const eligible = eligibilityError === null; result.eligibilityError = eligibilityError;
    result.canConfirm = eligible && result.state === 'proposed';
    result.canTrial = eligible && result.state === 'validation_pending' && result.trialStatus === 'not_run';
    return result;
  }
  #get(id: string): InternalCandidate { const item = this.#candidates.get(id); if (!item) throw new AiError('E_CANDIDATE_NOT_FOUND'); return item; }
  #check(item: InternalCandidate): void {
    if (item.gateway && item.gatewayResult) item.gateway.assertAnswered(item.gatewayResult, this.host);
    this.authority.check(item.binding); if (!this.host.authorizes(item.binding)) throw new AiError('E_WRITER');
    const current = this.host.document();
    if (current.project.projectId !== item.binding.projectId) throw new AiError('E_PROJECT');
    if (current.project.revision !== item.binding.baseRevision || current.project.semanticHash !== item.binding.baseSemanticHash) throw new AiError('E_REVISION_CONFLICT');
    let buildMatches = false;
    try { buildMatches = identity(this.options.currentBuild()) === identity(item.build) && identity(this.host.buildIdentity()) === identity(item.build); } catch { /* Invalid/unreadable build also expires the candidate. */ }
    if (!buildMatches) { this.#terminate(item, 'stale', 'E_BUILD_CHANGED'); throw new AiError('E_BUILD_CHANGED'); }
    if (['canceled', 'rejected', 'stale', 'applied'].includes(item.public.state)) throw new AiError('E_CANDIDATE_TERMINATED');
  }
  #terminate(item: InternalCandidate, state: 'canceled' | 'stale' | 'rejected', reason: string): void {
    if (['applied', 'canceled', 'stale', 'rejected'].includes(item.public.state)) return;
    item.public.historicalOperations = structuredClone(item.public.operations);
    item.public.state = state; item.public.operations = []; item.public.candidateState = null; item.draft = null;
    item.public.errors = [{ code: reason, path: '', message: reason }];
    if (item.public.trialStatus === 'running') { item.public.trialStatus = 'blocked'; if (item.public.trial) item.public.trial.status = 'blocked'; }
  }
  #record(item: InternalCandidate, status: TrialRecord['status']): TrialRecord {
    const run = item.run?.snapshot() ?? null; const events = run?.events ?? [];
    const reward = events.some(event => event.kind === 'reward_collected'); const chase = events.some(event => event.kind === 'chase_started');
    return { source: item.public.source, providerEvidence: structuredClone(item.public.providerEvidence), trialId: run?.context.runId ?? null, candidateHash: item.public.candidateHash!, candidateSemanticHash: item.public.candidateSemanticHash!,
      scriptId: 'CC-SMOKE-01', scriptHash: canonicalSHA256(smoke), trialPolicyVersion: 'collect-chase-candidate-trial@2',
      buildHash: item.build.buildHash, runtimeArtifactHash: item.build.runtimeArtifactHash, contractHash: structuredClone(item.build.manifest['contractHash'] ?? null), environmentId: item.build.environmentId,
      status, run, assertions: { candidateLoaded: run !== null && (this.options.verification?.expectedTargetScore === undefined || run.document.project.rules.goal.targetScore === this.options.verification.expectedTargetScore) && (item.draft !== null ? canonicalJson(run.document) === canonicalJson(item.draft) : item.public.trial?.assertions.candidateLoaded === true),
        runStarted: events.filter(event => event.kind === 'run_started').length === 1, committedTick: run !== null && run.tick >= 1,
        eventIdentity: run !== null && events.every(event => eventValid(event, run)), noFault: run !== null && run.status !== 'fault' && !run.budgetExhausted && run.diagnostics.length === 0 },
      coverage: { rewardCollected: reward, chaseObserved: chase, terminalReason: run?.terminal?.reason ?? null,
        uncovered: [...(!reward ? ['reward collection not observed'] : []), ...(!chase ? ['guard chase not observed'] : []), 'No route or difficulty conclusion', '180 ticks cannot establish 15 second timeout'] } };
  }
}
