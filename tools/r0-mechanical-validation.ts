import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate } from 'node:timers/promises';
import { assertDocument, canonicalJson, canonicalSHA256, parseDocument, parseStrictJson, type Document, type Operation, type ManualCommand, type CommandResult } from '../src/domain/index.js';
import { AiAuthority } from '../src/ai/authority.js';
import { AiError, RESERVATION_NANO_CNY, TOTAL_AMOUNT_CAP_NANO_CNY, type AttemptRecord, type DirectionOption } from '../src/ai/types.js';
import { R0Host } from '../src/host/r0-host.js';
import type { RunSnapshot } from '../src/host/run-session.js';
import { RealAiR0Session, readFrozenSlot } from '../src/host/real-ai-session.js';
import { CandidateManager } from '../src/trial/candidate-manager.js';
import type { CandidateSnapshot } from '../src/trial/types.js';
import { assertAuthorizedRoot, readRun } from '../src/evidence/run-evidence.js';
import { createBuildIdentity, digest, verifyFrozenInputs, type BuildIdentity, type FileDigest } from './build-manifest.js';

export const PROTOCOL_HASH = 'sha256:8a45d7cda53b350e11210e02df85830cf48962931888fe6adafb61b25321d0a8';
export const DIVISION_HASH = 'sha256:9a49510e31cdaf9f41ee049edc3ff81fcf55c832e2583338e0a399906d55c59c';
export const BATCH_ORDER = ['04A', '05A', '05B', '06B', '06A', '07A', '07B', '08B', '08A', '09A'] as const;
export type MechanicalCase = '04' | '05' | '06' | '07' | '08';
export type Side = 'A' | 'B';
export interface Segment { ticks: number; x: -1 | 0 | 1; y: -1 | 0 | 1 }
const SLOT = (id: string): string => `R0-AI-${id}-R1-I`;
const INITIAL_ATTEMPTS = ['PROBE-ACCESS-A1', 'R0-AI-01-R1-I-A1', 'R0-AI-02-R1-I-A1', 'R0-AI-03-R1-I-A1'];
const LIMIT_MS = 900_000;
const EPS = 1e-8;
function fail(code: string): never { throw new AiError(code); }
function must(value: unknown, code: string): asserts value { if (!value) fail(code); }
function equal(a: unknown, b: unknown, code: string): void { must(canonicalJson(a) === canonicalJson(b), code); }
function near(a: number, b: number, code: string): void { must(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= EPS, code); }
function safeCode(error: unknown): string {
  const value = error instanceof AiError ? error.code : error instanceof Error ? error.message : '';
  return /^E_[A-Z0-9_]{1,90}$/.test(value) ? value : 'E_MECHANICAL_VALIDATION';
}
function frozen<T>(value: T): T { if (value !== null && typeof value === 'object') { for (const item of Object.values(value)) frozen(item); Object.freeze(value); } return value; }
function json(root: string, path: string): unknown { return parseStrictJson(readFileSync(resolve(root, path), 'utf8')); }
function projection(doc: Document) { return { scene: doc.project.scene, rules: doc.project.rules, presentation: doc.project.presentation }; }
export function fixtureReference(id: MechanicalCase | '09', side: Side): string {
  return `verification/fixtures/${id === '05' ? 'scene-b' : id === '09' ? 'scene-a-goal6' : 'scene-a'}${side === 'B' ? '-mirror' : ''}.json`;
}
/** Independent frozen expectation; never accepts provider operations as its source. */
export function expectedOperations(id: MechanicalCase, side: Side = 'A'): Operation[] {
  switch (id) {
    case '04': return [{ op: 'set_detect_radius', expectedValue: 180, value: 140 }];
    case '05': return [{ op: 'set_timer', expectedValue: { enabled: false, limit: 30 }, value: { enabled: true, limit: 30 } }];
    case '06': return [{ op: 'move_entity', entityId: 'h1', expectedValue: { x: side === 'A' ? 660 : 300, y: 190 }, value: { x: side === 'A' ? 540 : 420, y: 220 } }];
    case '07': return [{ op: 'set_theme', expectedValue: { themeId: 'theme_snack', playerSkinId: 'snack_player_01' }, value: { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' } }];
    case '08': return [{ op: 'set_goal', expectedValue: 10, value: 6 }, { op: 'set_detect_radius', expectedValue: 180, value: 140 }];
  }
}
export function assertExactOperations(id: MechanicalCase, value: unknown): void {
  const ops = expectedOperations(id);
  const allowed = canonicalJson(value) === canonicalJson(ops) || id === '08' && canonicalJson(value) === canonicalJson([...ops].reverse());
  must(allowed, 'E_FROZEN_OPERATIONS'); // Do not reorder actual candidate operations/hash.
}
export function expectedDocument(base: Document, id: MechanicalCase, side: Side, committed = false): Document {
  const draft = structuredClone(base);
  switch (id) {
    case '04': draft.project.rules.guards.detectRadius = 140; break;
    case '05': draft.project.rules.timer = { enabled: true, limit: 30 }; break;
    case '06': { const h1 = draft.project.scene.entities.find(e => e.id === 'h1'); must(h1?.kind === 'high', 'E_FROZEN_H1'); h1.x = side === 'A' ? 540 : 420; h1.y = 220; break; }
    case '07': draft.project.presentation = { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' }; break;
    case '08': draft.project.rules.goal.targetScore = 6; draft.project.rules.guards.detectRadius = 140; break;
  }
  if (committed) draft.project.revision += id === '08' && side === 'B' ? 2 : 1;
  return assertDocument(draft);
}
export function assertWholeDocument(actual: unknown, expected: Document): void { equal(actual, expected, 'E_FULL_DOCUMENT_ORACLE'); }
export function assertCandidateOracle(id: MechanicalCase, base: Document, candidate: CandidateSnapshot): void {
  assertExactOperations(id, candidate.operations);
  must(candidate.validation === 'static_valid' && candidate.candidateHash !== null && candidate.candidateState !== null, 'E_CANDIDATE_INVALID');
  equal(candidate.candidateState, projection(expectedDocument(base, id, 'A')), 'E_FULL_CANDIDATE_ORACLE');
  must(candidate.baseRevision === base.project.revision && candidate.baseSemanticHash === base.project.semanticHash && candidate.candidateSemanticHash === expectedDocument(base, id, 'A').project.semanticHash, 'E_CANDIDATE_ORACLE_BINDING');
}
export function formalInput(id: MechanicalCase, side: Side): Segment[] {
  const segments: Segment[] = id === '07' ? [] : id === '05' ? [{ ticks: 1800, x: 0, y: 0 }] : id === '06' ? [{ ticks: 19, x: 0, y: -1 }, { ticks: 173, x: 1, y: 0 }] : [{ ticks: 200, x: 1, y: 0 }, { ticks: 120, x: -1, y: 0 }];
  return segments.map(s => ({ ...s, x: side === 'B' ? (s.x === 0 ? 0 : -s.x) as Segment['x'] : s.x }));
}
export function manualCommands(id: MechanicalCase): ManualCommand[] {
  switch (id) {
    case '04': return [{ type: 'set_detect_radius', value: 140 }];
    case '05': return [{ type: 'set_timer', value: { enabled: true, limit: 30 } }];
    case '06': return [{ type: 'move_entity', entityId: 'h1', x: 420, y: 220 }];
    case '07': return [{ type: 'set_theme', value: { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' } }];
    case '08': return [{ type: 'set_goal', value: 6 }, { type: 'set_detect_radius', value: 140 }];
  }
}
export interface RuntimeResult { inputHash: string; runId: string; tick: number; score: number; terminalReason: string | null; eventKinds: string[]; inputCount: number; status: RunSnapshot['status']; validationHash: string }
export function assertFormalRuntime(id: Exclude<MechanicalCase, '07'>, side: Side, run: RunSnapshot, expected: Document): void {
  assertWholeDocument(run.document, expected);
  const segments = formalInput(id, side), ticks = segments.reduce((sum, s) => sum + s.ticks, 0);
  must(run.tick === ticks && run.inputs.length === ticks && run.frames.length === ticks + 1, 'E_FORMAL_INPUT_COUNT');
  must(run.diagnostics.length === 0 && !run.budgetExhausted && run.truncation.droppedCount === 0, 'E_FORMAL_RUNTIME_DIAGNOSTIC');
  let offset = 0;
  for (const segment of segments) for (let n = 0; n < segment.ticks; n++) {
    const input = run.inputs[offset++]; must(input?.committed && input.tick === offset && input.lastCommittedTick === offset, 'E_FORMAL_INPUT_SEQUENCE');
    equal(input.direction, { x: segment.x, y: segment.y }, 'E_FORMAL_INPUT_DIRECTION');
  }
  must(run.context.evidenceSource === 'machine_test' && run.context.inputSource === 'catalog_machine' && run.context.executionClass === 'automation_test', 'E_FORMAL_RUNTIME_SOURCE');
  const start = run.events.filter(e => e.kind === 'run_started'); must(start.length === 1, 'E_FORMAL_RUN_STARTED');
  const first = start[0]!; must(first.kind === 'run_started' && first.actualValues.targetScore === expected.project.rules.goal.targetScore, 'E_FORMAL_LOADED_GOAL');
  equal(first.actualValues.timer, expected.project.rules.timer, 'E_FORMAL_LOADED_TIMER');
  for (const e of run.events) must(e.runId === run.context.runId && e.projectId === expected.project.projectId && e.revision === expected.project.revision && e.semanticHash === expected.project.semanticHash, 'E_FORMAL_EVENT_IDENTITY');
  if (id === '05') {
    must(run.status === 'ended' && run.terminal?.reason === 'timeout' && run.terminal.timeout && !run.terminal.caught && !run.terminal.goalReached && run.score === 0, 'E_TIMER_TIMEOUT');
    must(run.frames.slice(0, -1).every(f => f.terminal === null), 'E_EARLY_TERMINAL');
    const ends = run.events.filter(e => e.kind === 'round_ended'); must(ends.length === 1 && ends[0]?.tick === 1800, 'E_TIMEOUT_EVENT');
    must(run.events.every(e => !['reward_collected', 'score_changed', 'chase_started', 'chase_stopped'].includes(e.kind)), 'E_TIMER_UNEXPECTED_EVENT');
    for (const f of run.frames) equal(f.positions, run.frames[0]!.positions, 'E_TIMER_UNEXPECTED_MOVEMENT');
  } else if (id === '06') {
    must(run.terminal === null && run.score === 3 && run.status === 'paused', 'E_H1_RESULT');
    const collected = run.events.filter(e => e.kind === 'reward_collected');
    must(collected.length === 1 && collected[0]?.kind === 'reward_collected' && collected[0].actualValues.rewardId === 'h1' && collected[0].actualValues.rewardKind === 'high' && collected[0].actualValues.value === 3 && collected[0].actualValues.contactWitnesses[0].contacted, 'E_H1_COLLECTION');
    const changes = run.events.filter(e => e.kind === 'score_changed'); must(changes.length === 1 && changes[0]?.kind === 'score_changed' && changes[0].actualValues.scoreBefore === 0 && changes[0].actualValues.scoreAfter === 3, 'E_H1_SCORE');
    near(run.positions['p']!.x, side === 'A' ? 80 + 173 * 160 / 60 : 880 - 173 * 160 / 60, 'E_H1_PLAYER_X');
    near(run.positions['p']!.y, 270 - 19 * 160 / 60, 'E_H1_PLAYER_Y');
  } else {
    must(run.terminal === null && run.score === 0 && run.status === 'paused', 'E_DETECT_RESULT');
    const starts = run.events.filter(e => e.kind === 'chase_started'), stops = run.events.filter(e => e.kind === 'chase_stopped');
    must(starts.length === 1 && stops.length === 1 && starts[0]!.tick < stops[0]!.tick, 'E_DETECT_COVERAGE');
    for (const e of [...starts, ...stops]) {
      must((e.kind === 'chase_started' || e.kind === 'chase_stopped') && e.actualValues.guardId === 'g1' && e.actualValues.detectRadius === 140 && e.actualValues.speed === 100 && e.observationPhase === 'before_move', 'E_DETECT_EVENT');
      const p = e.positions['p']!, g = e.positions['g1']!, d = Math.hypot(p.x - g.x, p.y - g.y);
      near(e.actualValues.centerDistance, d, 'E_DETECT_DISTANCE');
      must(e.kind === 'chase_started' ? d <= 140 : d > 140, 'E_DETECT_BOUNDARY');
    }
    for (let i = 1; i < run.frames.length; i++) {
      const prev = run.frames[i - 1]!, next = run.frames[i]!, p = prev.positions['p']!, g = prev.positions['g1']!, moved = next.positions['g1']!;
      const chasing = Math.hypot(p.x - g.x, p.y - g.y) <= 140;
      near(Math.hypot(moved.x - g.x, moved.y - g.y), chasing ? 100 / 60 : 0, 'E_GUARD_ACTUAL_SPEED');
      near(Math.hypot(next.positions['p']!.x - p.x, next.positions['p']!.y - p.y), 160 / 60, 'E_PLAYER_ACTUAL_MOVEMENT');
    }
  }
}
export async function executeFormalInput(host: R0Host, id: Exclude<MechanicalCase, '07'>, side: Side, expected: Document): Promise<RuntimeResult> {
  const started = await host.startRun(), segments = formalInput(id, side);
  outer: for (const segment of segments) for (let n = 0; n < segment.ticks; n++) {
    const current = host.currentRun()!; if (current.status !== 'running' || current.budgetExhausted) break outer;
    await host.input({ runId: started.context.runId, generation: started.context.generation, direction: { x: segment.x, y: segment.y } });
    if (host.currentRun()!.tick % 60 === 0) await setImmediate();
  }
  if (host.currentRun()!.status === 'running') await host.pause();
  const actual = host.currentRun()!; assertFormalRuntime(id, side, actual, expected);
  return { inputHash: canonicalSHA256(segments), runId: actual.context.runId, tick: actual.tick, score: actual.score, terminalReason: actual.terminal?.reason ?? null,
    eventKinds: actual.events.map(e => e.kind), inputCount: actual.inputs.length, status: actual.status, validationHash: canonicalSHA256({ document: actual.document, inputHash: canonicalSHA256(segments), inputs: actual.inputs, frames: actual.frames, events: actual.events }) };
}
export function assertStaticTheme(root: string, base: Document, actual: Document): void {
  must(actual.project.semanticHash === base.project.semanticHash, 'E_THEME_GAMEPLAY_CHANGED');
  const catalog = json(root, 'config/catalog.json') as { themes: { themeId: string; allowedPlayerSkinIds: string[]; colors: Record<string, string> }[] };
  equal(catalog.themes.map(t => t.themeId), ['theme_snack', 'theme_r0_contrast'], 'E_THEME_CATALOG_ORDER');
  must(catalog.themes[1]?.allowedPlayerSkinIds.includes('snack_player_01') && Object.keys(catalog.themes[1].colors).length === 5, 'E_THEME_CATALOG_MAPPING');
  equal(actual.project.presentation, { themeId: 'theme_r0_contrast', playerSkinId: 'snack_player_01' }, 'E_THEME_PRESENTATION');
}
export interface LedgerSummary { attempts: { attemptId: string; requestSlotID: string; requestId: string; providerRequestId: string | null; state: AttemptRecord['state']; outcome: AttemptRecord['outcome']; usageCalculatedNanoCNY: number | null }[]; reservedNanoCNY: number; usageCalculatedNanoCNY: number; unresolved: number; supplierBillVerified: false }
export function ledgerSummary(attempts: readonly AttemptRecord[]): LedgerSummary {
  return { attempts: attempts.map(a => ({ attemptId: a.attemptId, requestSlotID: a.requestSlotID, requestId: a.requestId, providerRequestId: a.providerRequestId, state: a.state, outcome: a.outcome, usageCalculatedNanoCNY: a.usageCalculatedNanoCNY })),
    reservedNanoCNY: attempts.length * RESERVATION_NANO_CNY, usageCalculatedNanoCNY: attempts.reduce((s, a) => s + (a.usageCalculatedNanoCNY ?? 0), 0), unresolved: attempts.filter(a => a.state !== 'accounted').length, supplierBillVerified: false };
}
/** Read-only connection. Never constructs AiLedger or executes DDL/register. */
export function readLedgerOnly(path: string): LedgerSummary {
  must(existsSync(path) && !lstatSync(path).isSymbolicLink(), 'E_LEDGER_MISSING_OR_SYMLINK');
  const db = new DatabaseSync(path, { readOnly: true });
  try { const rows = db.prepare('SELECT record FROM ai_attempt ORDER BY rowid').all() as { record: string }[]; return ledgerSummary(rows.map(row => parseStrictJson(row.record) as AttemptRecord)); }
  finally { db.close(); }
}
export function assertLedgerReady(summary: LedgerSummary, expectedAttemptIDs?: readonly string[]): void {
  must(summary.unresolved === 0 && summary.attempts.every(a => a.state === 'accounted'), 'E_UNRESOLVED_USAGE');
  must(summary.reservedNanoCNY + RESERVATION_NANO_CNY <= TOTAL_AMOUNT_CAP_NANO_CNY && summary.attempts.length < 76, 'E_BATCH_BUDGET');
  if (expectedAttemptIDs) equal(summary.attempts.map(a => a.attemptId), expectedAttemptIDs, 'E_LEDGER_CUTOVER_CHANGED');
}
export interface Preflight {
  version: 'nodon-r0-mechanical-preflight@1'; source: 'controlled_expected_document_runtime_not_paid_result'; protocolHash: string; divisionHash: string;
  buildHash: string; runtimeArtifactHash: string; references: FileDigest[]; fixedOrder: readonly string[];
  readonlyOracle: { slotId: 'R0-AI-09-R1-I'; intent: string; expectedOutput: string[]; expectedDocument: Document; input: never[]; responseKind: 'directions'; minimumOptions: 2; maximumOptions: 3; zeroWrites: true; childDispatchAllowed: false; expertSemanticReview: 'pending'; actualHumanLayoutChoiceRequired: true };
  readonlyOracleHash: string;
  plans: { caseId: MechanicalCase; side: Side; fixtureRef: string; fixtureHash: string; operations: Operation[]; manualCommands: ManualCommand[] | null; expectedDocumentHash: string; oracleHash: string; input: Segment[]; inputHash: string; runtimeStatus: 'runtime_not_applicable' | 'passed_controlled_preflight'; observed: RuntimeResult | null }[];
}
function reference(root: string, path: string): FileDigest { const bytes = readFileSync(resolve(root, path)); return { path, byteLength: bytes.length, sha256: digest(bytes) }; }
function ensureOverlay(root: string): void {
  must(digest(readFileSync(resolve(root, 'docs/r0-validation-protocol-v2.md'))) === PROTOCOL_HASH && digest(readFileSync(resolve(root, 'verification/r0-validation-division-v2.json'))) === DIVISION_HASH, 'E_PROTOCOL_V2_HASH');
  const overlay = json(root, 'verification/r0-validation-division-v2.json') as { status: string; executionOrder: string[] };
  must(overlay.status === 'active_reviewed', 'E_PROTOCOL_V2_NOT_ACTIVE');
  const original = json(root, 'verification/model-request-manifest.json') as { executionOrder: string[] }; equal(overlay.executionOrder, original.executionOrder, 'E_PROTOCOL_ORDER');
  const freeze = json(root, 'docs/t00-freeze-manifest.json') as { files: unknown[] }; must(freeze.files.length === 53, 'E_T00_ENTRY_COUNT'); verifyFrozenInputs(root);
}
/** Pure with respect to disk/ledger/credentials: real Runtime only, no export and no provider assembly. */
export async function preflight(root: string, build: BuildIdentity): Promise<Preflight> {
  ensureOverlay(root);
  const refs = ['docs/r0-validation-protocol-v2.md', 'verification/r0-validation-division-v2.json', 'docs/t00-freeze-manifest.json', 'verification/model-request-manifest.json', 'verification/comparison-manifest.json', 'config/catalog.json', 'config/candidate_trial_policy.json', 'config/rule_registry.json', 'verification/inputs/smoke.json', 'tools/r0-mechanical-validation.ts', 'dist/tools/r0-mechanical-validation.js'];
  const plans: Preflight['plans'] = [];
  for (const id of ['04', '05', '06', '07', '08'] as const) for (const side of ['A', 'B'] as const) {
    const fixtureRef = fixtureReference(id, side), base = parseDocument(readFileSync(resolve(root, fixtureRef), 'utf8')), expected = expectedDocument(base, id, side, true);
    const binding = { sessionId: randomUUID(), writerToken: randomUUID() }, host = new R0Host(expected, { ...binding, buildIdentity: build });
    const observed = id === '07' ? (assertStaticTheme(root, base, expected), null) : await executeFormalInput(host, id, side, expected);
    const oracle = { operations: expectedOperations(id, side), expectedDocument: expected, input: formalInput(id, side), floatAbsoluteTolerance: EPS };
    plans.push({ caseId: id, side, fixtureRef, fixtureHash: digest(readFileSync(resolve(root, fixtureRef))), operations: expectedOperations(id, side), manualCommands: side === 'B' ? manualCommands(id) : null,
      expectedDocumentHash: canonicalSHA256(expected), oracleHash: canonicalSHA256(oracle), input: formalInput(id, side), inputHash: canonicalSHA256(formalInput(id, side)), runtimeStatus: id === '07' ? 'runtime_not_applicable' : 'passed_controlled_preflight', observed });
    refs.push(fixtureRef);
  }
  refs.push(fixtureReference('09', 'A'));
  const parent = readFrozenSlot(root, SLOT('09'));
  const readonlyOracle: Preflight['readonlyOracle'] = { slotId: 'R0-AI-09-R1-I', intent: parent.slot.intent!, expectedOutput: structuredClone(parent.slot.expectedOutput), expectedDocument: parent.document, input: [], responseKind: 'directions', minimumOptions: 2, maximumOptions: 3, zeroWrites: true, childDispatchAllowed: false, expertSemanticReview: 'pending', actualHumanLayoutChoiceRequired: true };
  return frozen({ version: 'nodon-r0-mechanical-preflight@1', source: 'controlled_expected_document_runtime_not_paid_result', protocolHash: PROTOCOL_HASH, divisionHash: DIVISION_HASH, buildHash: build.buildHash,
    runtimeArtifactHash: build.runtimeArtifactHash, references: [...new Set(refs)].map(path => reference(root, path)), fixedOrder: BATCH_ORDER, readonlyOracle, readonlyOracleHash: canonicalSHA256(readonlyOracle), plans });
}

export interface PendingNodeContext { root: string; host: R0Host; authority: AiAuthority; candidates: CandidateManager; build: BuildIdentity; parentSession: RealAiR0Session }
export interface PendingHandle { readonly kind: 'node_only_pending_09'; toJSON(): never }
const pendingContexts = new WeakMap<PendingHandle, PendingNodeContext>();
/** Capability container only; no new state owner, no rehydration, no child request method. */
export function retainPending(context: PendingNodeContext): PendingHandle {
  const { host, authority, candidates, parentSession } = context;
  must(parentSession.slotId === SLOT('09') && parentSession.host === host && parentSession.authority === authority && parentSession.candidates === candidates && host.queue === authority.queue, 'E_PENDING_OWNER');
  const view = parentSession.view(); must(view.requestId !== null && view.response?.kind === 'directions' && canonicalJson(host.document()) === canonicalJson(parentSession.initialDocument), 'E_PENDING_PARENT');
  const handle = Object.create(null) as PendingHandle;
  Object.defineProperties(handle, { kind: { value: 'node_only_pending_09', enumerable: true }, toJSON: { value: () => fail('E_PENDING_CONTEXT_NOT_SERIALIZABLE') },
    [inspect.custom]: { value: () => '[Node-only pending 09 context; print report only]' } });
  Object.freeze(handle); pendingContexts.set(handle, context); return handle;
}
/** Node-only: callers must retain the actual handle; JSON cannot recreate a live Host. Never log this return value. */
export function getPendingContext(handle: PendingHandle): PendingNodeContext {
  const context = pendingContexts.get(handle); must(context, 'E_PENDING_CLOSED_OR_FOREIGN'); return context;
}
export async function closePending(handle: PendingHandle): Promise<void> {
  const context = pendingContexts.get(handle); if (!context) return;
  pendingContexts.delete(handle);
  try { await context.authority.setAdult(false); context.parentSession.checkpoint(); }
  finally { await context.parentSession.close(); }
}
/** If persistence/delivery fails, a caller must never lose the only live capability without cleanup. */
export async function guardPendingDelivery<T>(handle: PendingHandle | null, deliver: () => Promise<T> | T): Promise<T> {
  try { return await deliver(); }
  catch (error) { if (handle) { try { await closePending(handle); } catch { /* Handle is already invalidated; preserve the original delivery failure. */ } } throw error; }
}
export interface ConfirmReceipt {
  version: 'nodon-r0-engineering-confirm-receipt@1'; source: 'existing_candidate_gate_result'; actor: 'machine_engineering_only'; humanDecision: null;
  commandId: string; candidateId: string; candidateHash: string; candidateSource: CandidateSnapshot['source'];
  buildHash: string; runtimeArtifactHash: string; environmentId: string; result: CommandResult;
}
export function assertConfirmReceipt(receipt: ConfirmReceipt): void {
  equal(Object.keys(receipt).sort(), ['version', 'source', 'actor', 'humanDecision', 'commandId', 'candidateId', 'candidateHash', 'candidateSource', 'buildHash', 'runtimeArtifactHash', 'environmentId', 'result'].sort(), 'E_CONFIRM_RECEIPT_FIELDS');
  must(receipt.version === 'nodon-r0-engineering-confirm-receipt@1' && receipt.source === 'existing_candidate_gate_result' && receipt.actor === 'machine_engineering_only' && receipt.humanDecision === null && ['provider_gateway', 'controlled_fixture'].includes(receipt.candidateSource), 'E_CONFIRM_RECEIPT_SOURCE');
  must(/^[0-9a-f-]{36}$/i.test(receipt.commandId) && /^[0-9a-f-]{36}$/i.test(receipt.candidateId) && /^sha256:[0-9a-f]{64}$/.test(receipt.candidateHash), 'E_CONFIRM_RECEIPT_BINDING');
  const result = receipt.result;
  equal(Object.keys(result).sort(), result.ok ? ['ok', 'changed', 'revision', 'semanticHash'].sort() : ['ok', 'code', 'errors', 'currentRevision'].sort(), 'E_CONFIRM_RESULT_FIELDS');
  if (result.ok) must(result.changed === true && Number.isSafeInteger(result.revision) && result.revision >= 0 && /^sha256:[0-9a-f]{64}$/.test(result.semanticHash), 'E_CONFIRM_RESULT');
  else {
    must(typeof result.code === 'string' && Number.isSafeInteger(result.currentRevision) && result.currentRevision >= 0 && Array.isArray(result.errors), 'E_CONFIRM_RESULT');
    for (const item of result.errors) { equal(Object.keys(item).sort(), ['code', 'path', 'message'].sort(), 'E_CONFIRM_ERROR_FIELDS'); must(typeof item.code === 'string' && typeof item.path === 'string' && typeof item.message === 'string', 'E_CONFIRM_ERROR'); }
  }
}
/** Explicit safe projection of the one original Gate return. Never accepts or stores authority/session binding. */
export function makeConfirmReceipt(candidate: CandidateSnapshot, commandId: string, result: CommandResult, build: BuildIdentity): ConfirmReceipt {
  must(candidate.candidateHash !== null, 'E_CONFIRM_CANDIDATE_HASH');
  const receipt: ConfirmReceipt = { version: 'nodon-r0-engineering-confirm-receipt@1', source: 'existing_candidate_gate_result', actor: 'machine_engineering_only', humanDecision: null,
    commandId, candidateId: candidate.candidateId, candidateHash: candidate.candidateHash, candidateSource: candidate.source, buildHash: build.buildHash, runtimeArtifactHash: build.runtimeArtifactHash, environmentId: build.environmentId, result: structuredClone(result) };
  assertConfirmReceipt(receipt); return receipt;
}
export interface TechnicalDecision { actor: 'machine_engineering_only'; decision: 'apply_engineering_only' | 'do_not_apply' | 'await_human_choice'; oracleHash: string; humanDecision: null; humanSemanticJudgment: null; limitations: string[] }
interface SideBase {
  label: string; slotId: string; side: Side; pairedID: string; actor: 'machine_engineering_only'; humanOperator: null; startedAt: string; completedAt: string;
  machineWallMs: number; modelWaitMs: number; authorNetTime: null; humanEfficiency: null; status: '通过' | '失败' | '阻塞'; errorCode: string | null;
  fixtureHash: string; inputHash: string; oracleHash: string; beforeDocumentHash: string; afterDocumentHash: string;
  requestId: string | null; requestBodyHash: string | null; actualOutputHash: string | null; technicalDecision: TechnicalDecision; refs: FileDigest[];
}
export type SideRecord = SideBase & (
  | { kind: 'A_gameplay'; candidateId: string | null; candidateHash: string | null; trialStatus: string | null; trialRef: string | null; formalRun: RuntimeResult | null; manual: null }
  | { kind: 'A_static'; candidateId: string | null; candidateHash: string | null; trialStatus: 'runtime_not_applicable' | null; trialRef: null; formalRun: null; manual: null }
  | { kind: 'B_gameplay'; candidateId: null; candidateHash: null; trialStatus: null; trialRef: null; formalRun: RuntimeResult | null; manual: { command: ManualCommand; commandId: string; previewOK: boolean; resultOK: boolean; revision: number }[] }
  | { kind: 'B_static'; candidateId: null; candidateHash: null; trialStatus: 'runtime_not_applicable'; trialRef: null; formalRun: null; manual: { command: ManualCommand; commandId: string; previewOK: boolean; resultOK: boolean; revision: number }[] }
  | { kind: 'A_readonly'; candidateId: null; candidateHash: null; trialStatus: null; trialRef: null; formalRun: null; manual: null; actualOptions: DirectionOption[]; expertSemanticReview: 'pending'; awaitingHumanChoice: boolean; nextSlot: string | null }
);
export interface BatchReport {
  version: 'nodon-r0-mechanical-validation@1'; mode: 'dry_run' | 'execute'; status: 'dry_run' | 'pending_human' | 'blocked' | 'stopped_after_09'; errorCode: string | null;
  batchId: string; buildId: string; buildHash: string; runtimeArtifactHash: string; protocolHash: string; divisionHash: string; preflightHash: string; preflightRef: FileDigest | null;
  actor: 'machine_engineering_only'; humanOperator: null; startedAt: string; completedAt: string; authorNetTime: null; supplierBillVerified: false;
  providerAttemptDelta: number; providerDispatchDelta: number | null; ledgerBefore: LedgerSummary; ledgerAfter: LedgerSummary; records: SideRecord[];
  legacyB04: { source: 'legacy_human'; repeated: false; scope: string }; pending: { liveInThisProcess: boolean; nextSlot: string; jsonRestoresContinuity: false } | null;
  refs: FileDigest[]; reportPath: string | null; limitations: string[];
}
/** Strict report discriminants prohibit static/manual rows from acquiring Runtime-trial success semantics. */
export function assertSideRecord(record: SideRecord): void {
  must(['A_gameplay', 'A_static', 'B_gameplay', 'B_static', 'A_readonly'].includes(record.kind), 'E_REPORT_KIND');
  must(record.side === (record.kind.startsWith('A_') ? 'A' : 'B'), 'E_REPORT_SIDE');
  const shared = ['label', 'slotId', 'side', 'pairedID', 'actor', 'humanOperator', 'startedAt', 'completedAt', 'machineWallMs', 'modelWaitMs', 'authorNetTime', 'humanEfficiency', 'status', 'errorCode', 'fixtureHash', 'inputHash', 'oracleHash', 'beforeDocumentHash', 'afterDocumentHash', 'requestId', 'requestBodyHash', 'actualOutputHash', 'technicalDecision', 'refs', 'kind', 'candidateId', 'candidateHash', 'trialStatus', 'trialRef', 'formalRun', 'manual'];
  const extras = record.kind === 'A_readonly' ? ['actualOptions', 'expertSemanticReview', 'awaitingHumanChoice', 'nextSlot'] : [];
  equal(Object.keys(record).sort(), [...shared, ...extras].sort(), 'E_REPORT_FIELDS');
  equal(Object.keys(record.technicalDecision).sort(), ['actor', 'decision', 'oracleHash', 'humanDecision', 'humanSemanticJudgment', 'limitations'].sort(), 'E_REPORT_DECISION_FIELDS');
  must(record.actor === 'machine_engineering_only' && record.humanOperator === null && record.authorNetTime === null && record.humanEfficiency === null && record.technicalDecision.humanDecision === null && record.technicalDecision.humanSemanticJudgment === null, 'E_REPORT_HUMAN_PROVENANCE');
  must(record.technicalDecision.oracleHash === record.oracleHash, 'E_REPORT_ORACLE_BINDING');
  if (record.kind === 'A_static' || record.kind === 'B_static') must(record.formalRun === null && record.trialRef === null && (record.trialStatus === null || record.trialStatus === 'runtime_not_applicable'), 'E_REPORT_STATIC_RUNTIME');
  if (record.kind.startsWith('B_')) must(record.candidateId === null && record.candidateHash === null && record.trialRef === null && Array.isArray(record.manual), 'E_REPORT_MANUAL_CANDIDATE');
  if (record.kind === 'A_readonly') must(record.candidateId === null && record.trialRef === null && record.formalRun === null && record.manual === null && record.technicalDecision.decision === 'await_human_choice', 'E_REPORT_READONLY');
}
function safeRelative(root: string, path: string): string {
  const absolute = resolve(path), rel = relative(root, absolute); must(rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep), 'E_REPORT_PATH');
  let cursor = root; for (const part of rel.split(sep)) { cursor = resolve(cursor, part); must(!existsSync(cursor) || !lstatSync(cursor).isSymbolicLink(), 'E_REPORT_SYMLINK'); }
  return rel.split(sep).join('/');
}
function packageRefs(root: string, path: string): FileDigest[] {
  const parsed = readRun(path, root);
  for (const item of [...parsed.manifest.files, parsed.manifest.buildIdentityReference]) {
    const file = resolve(path, item.path); must(digest(readFileSync(file)) === item.sha256, 'E_PACKAGE_REFERENCE_HASH');
  }
  return [...parsed.manifest.files, parsed.manifest.buildIdentityReference, { path: 'manifest.json' }].map(item => reference(root, safeRelative(root, resolve(path, item.path))));
}
function writeRecord(root: string, path: string, value: unknown): FileDigest {
  const rel = safeRelative(root, path);
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' }); return reference(root, rel); }
  catch { return fail('E_EVIDENCE_WRITE'); }
}
function checkpointRefs(root: string, session: RealAiR0Session, record: SideRecord): void {
  session.checkpoint();
  const dir = resolve(root, 'evidence/r0', session.build.buildId, '07_ai/frozen', session.slotId);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const path = resolve(dir, name), rel = safeRelative(root, path), saved = json(root, rel) as { request?: { requestId: string; requestBodyHash: string | null } | null };
    if (saved.request?.requestId === record.requestId) { record.requestBodyHash = saved.request.requestBodyHash; record.refs.push(reference(root, rel)); }
  }
}
function checkTime(start: number): void { must(performance.now() - start < LIMIT_MS, 'E_SIDE_TIME_LIMIT'); }
function assertLiveBuild(root: string, build: BuildIdentity): void { must(createBuildIdentity(root).buildHash === build.buildHash, 'E_BUILD_CHANGED'); ensureOverlay(root); }
function newOwner(document: Document, build: BuildIdentity) {
  const sessionId = randomUUID(), writerToken = randomUUID(), host = new R0Host(document, { sessionId, writerToken, buildIdentity: build });
  const authority = new AiAuthority(host.queue, { sessionId, writerToken, projectId: document.project.projectId, authEpoch: 0, adultEnabled: false, scopeEnabled: true });
  const candidates = new CandidateManager(host, authority, { currentBuild: () => createBuildIdentity('/Users/dmy/Projects/Nodon-R0') });
  return { host, authority, candidates, binding: { sessionId, writerToken } };
}
async function exportFormal(root: string, host: R0Host, id: MechanicalCase, side: Side, inputRef: string, record: SideRecord): Promise<void> {
  if (!host.currentRun()) return;
  const path = await host.exportCurrentRun({ root, fixtureRef: fixtureReference(id, side), inputRef, assertions: { protocolVersion: 'r0-validation-division-v2', source: 'machine_engineering_only', label: record.label, oracleHash: record.oracleHash, status: record.status, errorCode: record.errorCode, inputHash: record.inputHash } });
  record.refs.push(...packageRefs(root, path));
}
export interface RunBatchOptions { execute?: boolean; root?: string; expectedBuildHash?: string; exclusiveGatewayConfirmed?: boolean }
export interface BatchResult { report: BatchReport; pending: PendingHandle | null }
/** Default is offline/read-only. Real execution must be called from a persistent Node owner to retain 09. */
export async function runBatch(options: RunBatchOptions = {}): Promise<BatchResult> {
  const root = assertAuthorizedRoot(options.root), build = createBuildIdentity(root), startedAt = new Date().toISOString();
  const flight = await preflight(root, build), preflightHash = canonicalSHA256(flight), ledgerPath = resolve(root, '.local/ai/r0-ledger.sqlite');
  const ledgerBefore = readLedgerOnly(ledgerPath);
  const report: BatchReport = { version: 'nodon-r0-mechanical-validation@1', mode: options.execute ? 'execute' : 'dry_run', status: 'dry_run', errorCode: null,
    batchId: randomUUID(), buildId: build.buildId, buildHash: build.buildHash, runtimeArtifactHash: build.runtimeArtifactHash, protocolHash: PROTOCOL_HASH, divisionHash: DIVISION_HASH,
    preflightHash, preflightRef: null, actor: 'machine_engineering_only', humanOperator: null, startedAt, completedAt: startedAt, authorNetTime: null, supplierBillVerified: false,
    providerAttemptDelta: 0, providerDispatchDelta: 0, ledgerBefore, ledgerAfter: ledgerBefore, records: [], legacyB04: { source: 'legacy_human', repeated: false, scope: 'Original limited pass; generation2, delayed export and 52seconds scope unknown retained; no human/machine efficiency comparison' },
    pending: null, refs: [], reportPath: null, limitations: ['Engineering evidence only; author acceptance/experience and G-E/R1/overall R0 remain separate.', 'All usage is estimated; supplier bill not verified.', '09 expert semantic review and actual eligible human layout choice are pending; no child request implemented.'] };
  let pending: PendingHandle | null = null;
  if (!options.execute) { report.completedAt = new Date().toISOString(); return { report, pending }; }
  must(options.expectedBuildHash === build.buildHash && options.exclusiveGatewayConfirmed === true, 'E_EXECUTE_REVIEW_AND_EXCLUSIVITY_REQUIRED');
  const dir = resolve(root, 'evidence/r0', build.buildId, '09_comparison/mechanical-v2', report.batchId);
  assertLedgerReady(ledgerBefore, INITIAL_ATTEMPTS); assertLiveBuild(root, build);
  report.preflightRef = writeRecord(root, resolve(dir, 'preflight.json'), flight); report.refs.push(report.preflightRef);
  // Live session is retained ONLY at the genuine 09 parent stop. Never close it in a batch-wide finally.
  const consumed = [...INITIAL_ATTEMPTS];
  try {
    for (const label of BATCH_ORDER) {
      assertLiveBuild(root, build); assertLedgerReady(readLedgerOnly(ledgerPath), consumed);
      const id = label.slice(0, 2) as MechanicalCase | '09', side = label.slice(2) as Side, readonly = id === '09';
      const base = readonly ? readFrozenSlot(root, SLOT(id)).document : parseDocument(readFileSync(resolve(root, fixtureReference(id, side)), 'utf8'));
      const plan = readonly ? null : flight.plans.find(p => p.caseId === id && p.side === side)!;
      const input = readonly ? [] : formalInput(id, side), inputRef = writeRecord(root, resolve(dir, `${label}-input.json`), { segments: input, maxTicks: input.reduce((s, t) => s + t.ticks, 0), inputSource: 'catalog_machine', stopOnLegalTerminal: true });
      const owner = newOwner(base, build), { host, authority, candidates } = owner, start = performance.now();
      const common: SideBase = { label, slotId: SLOT(id), side, pairedID: `PAIR-${id}-R1-INITIAL`, actor: 'machine_engineering_only', humanOperator: null, startedAt: new Date().toISOString(), completedAt: '', machineWallMs: 0, modelWaitMs: 0,
        authorNetTime: null, humanEfficiency: null, status: '失败', errorCode: null, fixtureHash: digest(readFileSync(resolve(root, fixtureReference(id, side)))), inputHash: canonicalSHA256(input), oracleHash: plan?.oracleHash ?? flight.readonlyOracleHash,
        beforeDocumentHash: canonicalSHA256(base), afterDocumentHash: canonicalSHA256(base), requestId: null, requestBodyHash: null, actualOutputHash: null,
        technicalDecision: { actor: 'machine_engineering_only', decision: readonly ? 'await_human_choice' : 'do_not_apply', oracleHash: plan?.oracleHash ?? flight.readonlyOracleHash, humanDecision: null, humanSemanticJudgment: null, limitations: ['No author acceptance, independent human usability or efficiency inference.'] }, refs: [inputRef] };
      let record: SideRecord;
      if (readonly) record = { ...common, kind: 'A_readonly', candidateId: null, candidateHash: null, trialStatus: null, trialRef: null, formalRun: null, manual: null, actualOptions: [], expertSemanticReview: 'pending', awaitingHumanChoice: false, nextSlot: null };
      else if (side === 'A') record = id === '07' ? { ...common, kind: 'A_static', candidateId: null, candidateHash: null, trialStatus: null, trialRef: null, formalRun: null, manual: null } : { ...common, kind: 'A_gameplay', candidateId: null, candidateHash: null, trialStatus: null, trialRef: null, formalRun: null, manual: null };
      else record = id === '07' ? { ...common, kind: 'B_static', candidateId: null, candidateHash: null, trialStatus: 'runtime_not_applicable', trialRef: null, formalRun: null, manual: [] } : { ...common, kind: 'B_gameplay', candidateId: null, candidateHash: null, trialStatus: null, trialRef: null, formalRun: null, manual: [] };
      let session: RealAiR0Session | null = null, hardStop = false;
      try {
        record.refs.push(writeRecord(root, resolve(dir, `${label}-before.json`), base));
        if (side === 'A') {
          await authority.setAdult(true); checkTime(start);
          session = new RealAiR0Session(root, SLOT(id), host, authority, candidates, build, null);
          const wait = performance.now();
          try { await session.submit([]); } finally { record.modelWaitMs = performance.now() - wait; }
          const view = session.view(); record.requestId = view.requestId;
          const actualAttempts = session.ledger.attempts().filter(a => a.requestSlotID === SLOT(id));
          must(actualAttempts.length === 1 && actualAttempts[0]?.attemptId === `${SLOT(id)}-A1`, 'E_EXPECTED_SINGLE_A1');
          const attempt = actualAttempts[0]!; must(attempt.state === 'accounted', 'E_UNRESOLVED_USAGE');
          consumed.push(attempt.attemptId); checkTime(start);
          record.actualOutputHash = view.response === null ? null : canonicalSHA256(view.response);
          if (readonly && record.kind === 'A_readonly') {
            assertWholeDocument(base, flight.readonlyOracle.expectedDocument); assertWholeDocument(host.document(), flight.readonlyOracle.expectedDocument); record.nextSlot = view.nextFrozenSlot;
            must(view.nextFrozenSlot === 'R0-AI-09-R1-F', 'E_READONLY_NEXT_SLOT');
            must(view.response?.kind === 'directions' && view.response.options.length >= 2 && view.response.options.length <= 3 && candidates.snapshot() === null, 'E_DIRECTION_INITIAL_STRUCTURE');
            record.actualOptions = structuredClone(view.response.options); record.awaitingHumanChoice = true;
            record.status = '通过'; // Read-only structure only; semantic/choice are explicitly pending.
            pending = retainPending({ root, host, authority, candidates, build, parentSession: session });
            report.pending = { liveInThisProcess: true, nextSlot: 'R0-AI-09-R1-F', jsonRestoresContinuity: false };
            report.status = 'pending_human';
          } else if (!readonly && (record.kind === 'A_gameplay' || record.kind === 'A_static')) {
            must(view.response?.kind === 'propose', 'E_EXPECTED_PROPOSE'); assertExactOperations(id, view.response.operations);
            let candidate = candidates.snapshot(); must(candidate !== null && candidate.source === 'provider_gateway' && candidate.providerEvidence?.transport === 'real_provider_transport', 'E_REAL_PROVIDER_CANDIDATE');
            assertCandidateOracle(id, base, candidate); assertWholeDocument(host.document(), base);
            record.candidateId = candidate.candidateId; record.candidateHash = candidate.candidateHash;
            if (id !== '07') candidate = await candidates.trial(candidate.candidateId);
            checkTime(start); assertCandidateOracle(id, base, candidate);
            if (record.kind === 'A_static') {
              must(candidate.trialStatus === 'runtime_not_applicable' && candidate.trial?.run === null && candidate.trial.trialId === null && candidate.trialRef === null, 'E_STATIC_TRIAL'); record.trialStatus = 'runtime_not_applicable';
            } else {
              must(candidate.trialStatus === 'passed' && candidate.trial !== null && candidate.trial.run !== null && candidate.trial.candidateHash === record.candidateHash && candidate.trial.run.context.buildHash === build.buildHash && candidate.trial.run.context.runtimeArtifactHash === build.runtimeArtifactHash, 'E_RUNTIME_TRIAL');
              record.trialStatus = candidate.trialStatus; record.trialRef = candidate.trialRef;
            }
            const trialExport = await candidates.exportTrial(candidate.candidateId, { root });
            record.refs.push(reference(root, safeRelative(root, trialExport.proofPath))); if (trialExport.runPath) record.refs.push(...packageRefs(root, trialExport.runPath));
            assertWholeDocument(host.document(), base); assertLiveBuild(root, build); checkTime(start);
            record.technicalDecision.decision = 'apply_engineering_only';
            record.refs.push(writeRecord(root, resolve(dir, `${label}-technical-decision.json`), record.technicalDecision));
            const confirmCommandId = randomUUID();
            const result = await candidates.confirm(candidate.candidateId, confirmCommandId);
            const receipt = makeConfirmReceipt(candidate, confirmCommandId, result, build);
            record.refs.push(writeRecord(root, resolve(dir, `${label}-confirm-receipt.json`), receipt));
            must(result.ok, 'E_CANDIDATE_CONFIRM');
            const expected = expectedDocument(base, id, side, true); assertWholeDocument(host.document(), expected);
            if (id === '07') assertStaticTheme(root, base, host.document());
            else if (record.kind === 'A_gameplay') record.formalRun = await executeFormalInput(host, id, side, expected);
            record.status = '通过';
          }
        } else if (!readonly && (record.kind === 'B_gameplay' || record.kind === 'B_static')) {
          for (const command of manualCommands(id)) {
            checkTime(start); const commandId = randomUUID(), envelope = { ...owner.binding, projectId: host.document().project.projectId, expectedRevision: host.document().project.revision, commandId, command };
            const before = host.document(), preview = await host.preview(envelope); assertWholeDocument(host.document(), before);
            record.manual.push({ command, commandId, previewOK: preview.ok, resultOK: false, revision: before.project.revision }); must(preview.ok, 'E_MANUAL_PREVIEW');
            const result = await host.execute(envelope), receipt = record.manual[record.manual.length - 1]!; receipt.resultOK = result.ok; receipt.revision = host.document().project.revision; must(result.ok, 'E_MANUAL_COMMAND');
          }
          const expected = expectedDocument(base, id, side, true); assertWholeDocument(host.document(), expected); record.technicalDecision.decision = 'apply_engineering_only';
          if (id === '07') assertStaticTheme(root, base, host.document()); else if (record.kind === 'B_gameplay') record.formalRun = await executeFormalInput(host, id, side, expected);
          record.status = '通过';
        }
        checkTime(start);
      } catch (error) {
        record.errorCode = safeCode(error); record.status = '失败';
        if (session) {
          const actual = session.view(); record.requestId = actual.requestId;
          const attempts = session.ledger.attempts().filter(a => a.requestSlotID === SLOT(id));
          if (attempts.length === 1 && attempts[0]!.state === 'accounted' && attempts[0]!.attemptId === `${SLOT(id)}-A1` && !consumed.includes(attempts[0]!.attemptId)) consumed.push(attempts[0]!.attemptId);
          const budget = session.ledger.budget(); hardStop = attempts.length !== 1 || budget.inFlight !== 0 || !authority.snapshot().adultEnabled || !authority.snapshot().scopeEnabled || !host.authorizes(authority.snapshot()) || record.errorCode === 'E_SIDE_TIME_LIMIT' || /BUDGET|BUILD|PROTOCOL|FROZEN|OWNER|EVIDENCE/.test(record.errorCode) && record.errorCode !== 'E_FROZEN_OPERATIONS';
        } else hardStop = true;
        if (hardStop) record.status = '阻塞';
      } finally {
        record.afterDocumentHash = canonicalSHA256(host.document()); record.completedAt = new Date().toISOString(); record.machineWallMs = performance.now() - start;
        try {
          record.refs.push(writeRecord(root, resolve(dir, `${label}-after.json`), host.document()));
          if (!readonly && id !== '07') await exportFormal(root, host, id, side, inputRef.path, record);
          if (session) {
            // Export a failed/canceled native trial too, if it exists, without restoring eligibility.
            const c = candidates.snapshot(); if (c?.trial && !record.refs.some(r => r.path.includes('/06_candidates/'))) {
              try { const exported = await candidates.exportTrial(c.candidateId, { root }); const ref = reference(root, safeRelative(root, exported.proofPath)); if (!record.refs.some(r => r.path === ref.path)) record.refs.push(ref); if (exported.runPath) record.refs.push(...packageRefs(root, exported.runPath)); }
              catch (error) { if (record.errorCode === null) record.errorCode = safeCode(error); }
            }
            checkpointRefs(root, session, record);
          }
        } catch (error) { record.status = '阻塞'; record.errorCode = safeCode(error); hardStop = true; }
        if (session && (pending === null || getPendingContext(pending).parentSession !== session)) await session.close();
      }
      assertSideRecord(record); report.records.push(record);
      report.refs.push(writeRecord(root, resolve(dir, `${label}-result.json`), record));
      report.ledgerAfter = readLedgerOnly(ledgerPath);
      if (hardStop) { if (pending) { await closePending(pending); pending = null; report.pending = null; } report.status = 'blocked'; report.errorCode = record.errorCode; break; }
      if (readonly) { if (!pending) report.status = 'stopped_after_09'; break; }
    }
  } catch (error) {
    if (pending) { try { await closePending(pending); } finally { pending = null; report.pending = null; } }
    report.status = 'blocked'; report.errorCode = safeCode(error);
  }
  let dispatchCountVerified = false;
  try { return await guardPendingDelivery(pending, () => {
  report.ledgerAfter = readLedgerOnly(ledgerPath); report.providerAttemptDelta = report.ledgerAfter.attempts.length - ledgerBefore.attempts.length;
  // Every created attempt normally dispatches; compute actual dispatch count from read-only rows, not from calls to submit().
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try { const attempts = (db.prepare('SELECT record FROM ai_attempt ORDER BY rowid').all() as { record: string }[]).map(r => parseStrictJson(r.record) as AttemptRecord); const old = new Set(ledgerBefore.attempts.map(a => a.attemptId)); report.providerDispatchDelta = attempts.filter(a => !old.has(a.attemptId) && a.dispatchAt !== null).length; dispatchCountVerified = true; } finally { db.close(); }
  report.completedAt = new Date().toISOString(); report.reportPath = safeRelative(root, resolve(dir, 'summary.json'));
  writeRecord(root, resolve(dir, 'summary.json'), report);
  return { report, pending };
  }); } catch (error) {
    pending = null; report.pending = null; report.status = 'blocked'; report.errorCode = safeCode(error); report.reportPath = null;
    report.providerAttemptDelta = report.ledgerAfter.attempts.length - ledgerBefore.attempts.length;
    if (!dispatchCountVerified) report.providerDispatchDelta = null;
    report.completedAt = new Date().toISOString(); return { report, pending: null };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  // A CLI cannot keep an inspectable live Host for later human choice. Paid execution is intentionally module-only.
  if (process.argv.includes('--execute')) { process.stderr.write('E_PERSISTENT_NODE_OWNER_REQUIRED: import runBatch in the frozen Node24 persistent REPL; CLI paid execution is disabled.\n'); process.exitCode = 2; }
  else runBatch().then(result => process.stdout.write(JSON.stringify(result.report, null, 2) + '\n')).catch(error => { process.stderr.write(safeCode(error) + '\n'); process.exitCode = 1; });
}
