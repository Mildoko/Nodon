import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { lstatSync, readFileSync, realpathSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { assertDocument, parseStrictJson, ENTITY_RADII, type Document, type Operation } from '../domain/index.js';
import { AiAuthority } from '../ai/authority.js';
import { CandidateManager } from '../trial/index.js';
import { createBuildIdentity, type BuildIdentity } from '../../tools/build-manifest.js';
import { assertAuthorizedRoot } from '../evidence/run-evidence.js';
import { R0Host } from './r0-host.js';
import { RuntimeClock } from './runtime-clock.js';
import { readFrozenSlot, RealAiR0Session } from './real-ai-session.js';

const MAX_BYTES = 1024 * 1024;
const LEASE_DURATION_MS = 10 * 60_000;
const FROZEN_REFERENCES = ['scene-a','scene-a-mirror','scene-a-goal6','scene-a-goal6-mirror','scene-b','scene-b-mirror','terminal-conflict','terminal-conflict-mirror','zero-guard-route'] as const;
const CATALOGS = ['scene-a', 'scene-b', 'zero-guard-route'] as const;
type CatalogId = typeof CATALOGS[number];
interface Lease {
  connectionId: string; csrfToken: string; expiresAt: number; lastHeartbeat: number;
  focused: boolean; connected: boolean; stream: ServerResponse | null;
  revocation: Promise<void> | null; revocationReason: string | null;
}
export interface WebServerOptions {
  root: string; buildIdentity: BuildIdentity; port?: number; verificationMode?: boolean;
  realAiSlotID?: string; humanParticipant?: 'HUMAN-01'; initialFixtureId?: typeof FROZEN_REFERENCES[number];
  /** Only deterministic clock tests inject time; production uses Node's monotonic clock. */
  now?: () => number;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('E_BODY');
  return value as Record<string, unknown>;
}
function fields(body: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(body, key)) || Object.keys(body).some(key => ![...required, ...optional].includes(key))) throw new Error('E_FIELDS');
}
function string(value: unknown): string { if (typeof value !== 'string' || !value || value.length > 200) throw new Error('E_FIELD_STRING'); return value; }
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}
function errorCode(error: unknown): string {
  const structured = error !== null && typeof error === 'object' && 'code' in error ? error.code : null;
  const value = typeof structured === 'string' ? structured : error instanceof Error ? error.message : '';
  return /^E_[A-Z0-9_]+(?![\s\S])/.test(value) ? value : 'E_REQUEST';
}
function safePublic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(safePublic);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !['writerToken', 'csrfToken', 'authorization', 'apiKey', 'secret'].includes(key)).map(([key, child]) => [key, safePublic(child)]));
  return value;
}
async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new Error('E_JSON_ONLY');
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error('E_JSON_SIZE');
  const chunks: Buffer[] = []; let size = 0;
  for await (const part of request) {
    const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part as string); size += bytes.length;
    if (size > MAX_BYTES) throw new Error('E_JSON_SIZE'); chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return record(parseStrictJson(text));
}

/** R0 controlled in-memory host; real frozen-slot provider adapter is explicit opt-in, never R1 product storage/auth. */
export function createWebServer(options: WebServerOptions) {
  if (options.initialFixtureId !== undefined && !FROZEN_REFERENCES.includes(options.initialFixtureId)) throw new Error('E_FROZEN_FIXTURE');
  if (options.realAiSlotID && options.initialFixtureId) throw new Error('E_FROZEN_FIXTURE');
  if (options.humanParticipant !== undefined && options.humanParticipant !== 'HUMAN-01') throw new Error('E_HUMAN_PARTICIPANT');
  const root = assertAuthorizedRoot(options.root), now = options.now ?? (() => performance.now());
  const serverInstanceId = randomUUID();
  let latestBuild = options.buildIdentity, buildDirty = false, buildFault = false, watcherFault = false;
  function refreshBuild(force = false): BuildIdentity {
    if (force || buildDirty) {
      buildDirty = false;
      try { latestBuild = createBuildIdentity(root); buildFault = false; }
      catch { buildFault = true; }
    }
    return buildFault || watcherFault ? { ...latestBuild, buildHash: 'sha256:' + '0'.repeat(64) } : latestBuild;
  }
  const watcher = watch(root, { recursive: true }, (_event, name) => {
    if (name === null || /^(?:(?:src|dist|tools|verification|config|node_modules|docs)(?:\/|$)|package(?:-lock)?\.json$)/.test(String(name))) buildDirty = true;
  });
  watcher.unref(); watcher.on('error', () => { watcherFault = true; });
  let catalogId: CatalogId = 'scene-a';
  const archived: unknown[] = [];
  function loadCatalog(id: string): Document {
    const path = resolve(root, 'verification/fixtures', id + '.json');
    if (lstatSync(path).isSymbolicLink() || realpathSync(path) !== path) throw new Error('E_CATALOG_SYMLINK');
    return assertDocument(parseStrictJson(readFileSync(path, 'utf8')));
  }
  function owners(id: CatalogId, frozenDocument?: Document) {
    const sessionId = randomUUID(), writerToken = randomBytes(32).toString('hex');
    const host = new R0Host(frozenDocument ?? loadCatalog(id), { sessionId, writerToken, buildIdentity: options.buildIdentity });
    const authority = new AiAuthority(host.queue, { authEpoch: 0, adultEnabled: false, scopeEnabled: true,
      sessionId, writerToken, projectId: host.document().project.projectId });
    const candidates = new CandidateManager(host, authority, { currentBuild: () => refreshBuild(),
      yieldSlice: () => new Promise<void>(accept => { setTimeout(accept, 250); }) });
    return { host, authority, candidates, sessionId, writerToken };
  }
  const realSlot = options.realAiSlotID ? readFrozenSlot(root, options.realAiSlotID) : null;
  let current = owners(catalogId, realSlot?.document ?? (options.initialFixtureId ? loadCatalog(options.initialFixtureId) : undefined));
  const realAI = realSlot ? new RealAiR0Session(root, realSlot.slot.requestSlotID, current.host, current.authority, current.candidates, options.buildIdentity, options.humanParticipant ?? null) : null;
  let lease: Lease | null = null;
  let lastRevocationReason: string | null = null;
  const clockAllowed = () => lease !== null && lease.connected && lease.focused && lease.stream !== null &&
    !lease.stream.destroyed && !lease.stream.writableEnded && now() - lease.lastHeartbeat < 1000 && now() < lease.expiresAt;
  let clock = new RuntimeClock(current.host, now, clockAllowed, options.humanParticipant ? 'human_keyboard' : 'machine_browser_input');
  const initialClock = clock;
  current.host.onRevision(() => initialClock.block('document_revision'));
  let preview: { previewId: string; envelope: Record<string, unknown>; connectionId: string; result: unknown } | null = null;
  // Immutable completed receipts belong to this Host, not its replaceable browser lease.
  // A reconnect may recover an accepted command's result, but cannot execute an old pending preview.
  const completedPreviews = new Map<string, Promise<unknown>>();
  let origin = '';
  let stopped = false;
  let incident: string | null = null;
  let observations: unknown = null;
  let sessionTransition: Promise<void> = Promise.resolve();
  const formalExports = new Map<string, { runPath: string; exportedTick: number }>();
  function snapshot() {
    try {
    const build = refreshBuild();
    const buildStatus = buildFault || watcherFault ? 'build_unavailable' : build.buildHash !== options.buildIdentity.buildHash ? 'restart_required' : 'ready';
    if (buildStatus !== 'ready') { clock.block(buildStatus); void clock.pause(buildStatus).catch(() => { /* Store remains available for recovery. */ }); }
    const state = current.authority.snapshot();
    const document = current.host.document();
    return safePublic({ buildId: options.buildIdentity.buildId, serverInstanceId, buildStatus, catalogId: options.initialFixtureId ?? (realSlot ? realSlot.slot.inputFixturePath : catalogId), frozenReference: options.initialFixtureId ?? null, availableCatalogs: CATALOGS,
      storage: 'controlled_in_memory_initial_state_only', modelStatus: realAI ? 'explicit_frozen_real_provider_R0' : 'disabled_no_model_requests', realAI: realAI?.view() ?? null,
      connection: lease ? { connectionId: lease.connectionId, focused: lease.focused, connected: lease.connected,
        streamConnected: lease.stream !== null, lastHeartbeatAt: lease.lastHeartbeat, expiresAtMonotonicMs: lease.expiresAt,
        leaseDurationMs: LEASE_DURATION_MS, leaseRemainingMs: lease.connected ? Math.max(0, lease.expiresAt - now()) : 0,
        revocationReason: lease.revocationReason, lastRevocationReason } : null,
      document, derived: current.host.inspect(), entityRadii: ENTITY_RADII,
      run: current.host.currentRun(), history: current.host.history(), observations,
      clock: clock.snapshot(), authority: { authEpoch: state.authEpoch, adultEnabled: state.adultEnabled, scopeEnabled: state.scopeEnabled },
      candidate: current.candidates.snapshot(), preview: preview ? { previewId: preview.previewId, command: preview.envelope['command'],
        expectedRevision: preview.envelope['expectedRevision'], result: preview.result } : null,
      archived, verification: { enabled: options.verificationMode === true, injectedIncident: incident },
      evidenceSource: options.humanParticipant ? 'actual_author_run' : 'machine_test', inputSource: options.humanParticipant ? 'human_keyboard' : 'machine_browser_input', executionClass: options.humanParticipant ? 'human_operation' : 'automation_test' });
    } catch {
      clock.block('snapshot_unavailable'); void clock.pause('snapshot_unavailable').catch(() => { /* Keep the in-memory document. */ });
      return { buildId: options.buildIdentity.buildId, serverInstanceId, buildStatus: 'build_unavailable',
        error: 'E_SNAPSHOT_UNAVAILABLE', storage: 'controlled_in_memory_initial_state_only', restartRequired: true,
        document: current.host.document(), run: null, candidate: null, preview: null };
    }
  }
  function send(response: ServerResponse, status: number, value: unknown): void {
    if (response.destroyed) return;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value));
  }
  function publish(): void {
    const found = lease, stream = found?.stream;
    if (!found || !stream || stream.destroyed || stream.writableNeedDrain) return;
    try { stream.write('event: snapshot\ndata: ' + JSON.stringify(snapshot()) + '\n\n'); }
    catch { void revoke('stream_write_failed', found).catch(() => { /* Never crash the authority owner on transport failure. */ }); }
  }
  function revoke(reason: string, target: Lease | null = lease): Promise<void> {
    if (!target || lease !== target) return Promise.resolve();
    if (!target.connected) return target.revocation ?? Promise.resolve();
    const owner = current, targetClock = clock;
    target.connected = false; target.focused = false; target.revocationReason = reason; lastRevocationReason = reason; preview = null;
    targetClock.block(reason); const stream = target.stream; target.stream = null;
    target.revocation = (async () => {
      try {
        await targetClock.pause(reason); await owner.authority.setAdult(false); await owner.candidates.revoke(reason);
        // Deliver the revoked state before a writable stream ends. A lost stream
        // cannot guarantee delivery; the next lease still exposes the last reason.
        if (lease === target && stream && !stream.destroyed && !stream.writableEnded) {
          stream.write('event: snapshot\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
        }
      } finally { stream?.end(); }
      publish();
    })();
    return target.revocation;
  }
  function checkHeaders(request: IncomingMessage): void {
    if (request.headers.host !== new URL(origin).host) throw new Error('E_HOST');
    const incomingOrigin = request.headers.origin;
    if (incomingOrigin !== undefined && incomingOrigin !== origin) throw new Error('E_ORIGIN');
    const site = request.headers['sec-fetch-site'];
    if (site !== undefined && site !== 'same-origin' && site !== 'none') throw new Error('E_ORIGIN');
    const referer = request.headers.referer;
    if (referer !== undefined) { try { if (new URL(referer).origin !== origin) throw new Error(); } catch { throw new Error('E_ORIGIN'); } }
  }
  function requireLease(request: IncomingMessage, csrf: boolean): Lease {
    const found = lease;
    const id = request.headers['x-nodon-connection'];
    if (!found || !found.connected || typeof id !== 'string' || id !== found.connectionId) throw new Error('E_CONNECTION');
    if (now() >= found.expiresAt || now() - found.lastHeartbeat >= 1000) {
      void revoke(now() >= found.expiresAt ? 'session_expired' : 'heartbeat_timeout', found); throw new Error('E_LEASE_EXPIRED');
    }
    if (csrf && (request.headers.origin !== origin || typeof request.headers['x-nodon-csrf'] !== 'string' ||
      !equal(request.headers['x-nodon-csrf'], found.csrfToken))) throw new Error('E_CSRF');
    return found;
  }
  function stillActive(found: Lease): void { if (lease !== found || !found.connected) throw new Error('E_CONNECTION'); }
  function canRun(found: Lease): void {
    stillActive(found); if (!found.focused || !found.stream) throw new Error('E_FOCUS_REQUIRED');
    if (now() - found.lastHeartbeat >= 1000 || now() >= found.expiresAt) throw new Error('E_LEASE_EXPIRED');
    const build = refreshBuild();
    if (buildFault || watcherFault || build.buildHash !== options.buildIdentity.buildHash) throw new Error('E_BUILD_CHANGED');
  }
  async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    checkHeaders(request);
    const url = new URL(request.url ?? '/', origin);
    if (url.origin !== origin) throw new Error('E_PATH');
    const path = url.pathname;
    if (request.url !== path) throw new Error('E_PATH');
    if (request.method === 'GET' && path === '/api/session') {
      if (url.search) throw new Error('E_FIELDS');
      let created: Lease | null = null;
      const transition = sessionTransition.then(async () => {
        const previous = lease; if (previous) await revoke('connection_replaced', previous);
        const found: Lease = { connectionId: randomUUID(), csrfToken: randomBytes(32).toString('hex'),
          expiresAt: now() + LEASE_DURATION_MS, lastHeartbeat: now(), focused: false, connected: true, stream: null, revocation: null, revocationReason: null };
        lease = found; created = found; preview = null; clock.setConnection(found.connectionId);
      });
      sessionTransition = transition.then(() => undefined, () => undefined); await transition;
      const found = created as Lease | null; if (!found) throw new Error('E_CONNECTION'); stillActive(found);
      send(response, 200, { ok: true, serverInstanceId, connectionId: found.connectionId, csrfToken: found.csrfToken,
        sessionExpiresAt: Date.now() + LEASE_DURATION_MS, heartbeatIntervalMs: 250, heartbeatTimeoutMs: 1000, snapshot: snapshot() }); return;
    }
    if (request.method === 'GET' && path === '/api/snapshot') {
      if (url.search) throw new Error('E_FIELDS'); requireLease(request, false); send(response, 200, { ok: true, snapshot: snapshot() }); return;
    }
    if (request.method === 'GET' && path === '/api/events') {
      if (url.search) throw new Error('E_FIELDS');
      const found = requireLease(request, false);
      const previous = found.stream; found.stream = response; previous?.end();
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', 'Connection': 'keep-alive', 'X-Content-Type-Options': 'nosniff' });
      response.write('event: snapshot\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
      response.on('close', () => { if (lease === found && found.stream === response) void revoke('connection_lost', found); }); return;
    }
    if (request.method === 'POST' && path.startsWith('/api/')) {
      if (url.search) throw new Error('E_FIELDS');
      const found = requireLease(request, true); const body = await jsonBody(request); stillActive(found); requireLease(request, true);
      const owner = current, requestClock = clock;
      const assertRequest = () => { stillActive(found); if (current !== owner || clock !== requestClock) throw new Error('E_PROJECT'); };
      const activate = async () => {
        try { assertRequest(); canRun(found); requestClock.activate(); }
        catch (error) { await requestClock.pause('focus_or_connection_lost'); throw error; }
      };
      let result: unknown = null;
      if (path === '/api/real-ai/request') {
        if (!realAI) throw new Error('E_REAL_AI_DISABLED');
        fields(body, ['eventIds'], ['choice']); if (!Array.isArray(body['eventIds']) || body['eventIds'].length > 12 || body['eventIds'].some(id => typeof id !== 'string')) throw new Error('E_FIELDS');
        await requestClock.pause('real_ai_request'); assertRequest(); refreshBuild(true);
        if (refreshBuild().buildHash !== options.buildIdentity.buildHash) throw new Error('E_BUILD_CHANGED');
        let choice: {optionId:string;rationale:string;directionClass?:'layout'|'time'|'minimal_change';witnessRef?:string} | undefined;
        if (body['choice'] !== undefined) { const c = record(body['choice']); fields(c,['optionId','rationale'],['directionClass','witnessRef']);
          if (typeof c['rationale'] !== 'string' || c['rationale'].length > 120 || c['directionClass'] !== undefined && !['layout','time','minimal_change'].includes(String(c['directionClass']))) throw new Error('E_FIELDS');
          choice = {optionId:string(c['optionId']),rationale:c['rationale'], ...(c['directionClass'] ? {directionClass:c['directionClass'] as 'layout'|'time'|'minimal_change'} : {}), ...(c['witnessRef'] ? {witnessRef:string(c['witnessRef'])} : {})}; }
        result = await realAI.submit(body['eventIds'] as string[], choice);
      } else if (path === '/api/real-ai/frozen-run') {
        fields(body, []); if (!realAI) throw new Error('E_REAL_AI_DISABLED'); await requestClock.pause('frozen_evidence_run'); assertRequest();
        const proof = await realAI.prepareFrozenExplanationRun(); assertRequest();
        const run = owner.host.currentRun(); if (!run || run.context.runId !== proof.runId) throw new Error('E_FROZEN_EVIDENCE_RUN');
        const existing = formalExports.get(proof.runId);
        const runPath = existing?.runPath ?? await owner.host.exportCurrentRun({root,fixtureRef:'verification/fixtures/terminal-conflict.json',inputRef:'verification/inputs/terminal-conflict.json',assertions:{caseId:'R0-RT-07-caught',purpose:'genuine_frozen_evidence_before_T08',validationHash:proof.validationHash,fixtureHash:proof.fixtureHash,inputHash:proof.inputHash}});
        formalExports.set(proof.runId,{runPath,exportedTick:run.tick}); result = {...proof,runPath,exportedTick:run.tick};
      } else if (path === '/api/real-ai/recheck') {
        fields(body, []); if (!realAI) throw new Error('E_REAL_AI_DISABLED'); await requestClock.pause('frozen_recheck'); assertRequest();
        const checked = await realAI.recheckFrozenInput(); if (checked.runPath) formalExports.set(checked.runId,{runPath:checked.runPath,exportedTick:checked.tick}); result = checked;
      } else if (path === '/api/real-ai/advance-child') {
        fields(body, []); if (!realAI) throw new Error('E_REAL_AI_DISABLED'); result = await realAI.advanceToChild();
      } else if (path === '/api/real-ai/retry') {
        fields(body, []); if (!realAI) throw new Error('E_REAL_AI_DISABLED'); result = await realAI.retry();
      } else if (path === '/api/real-ai/dispose-child') {
        fields(body,['reason'],['witnessRef']); if (!realAI) throw new Error('E_REAL_AI_DISABLED');
        result = await realAI.disposeBlockedChild({reason:string(body['reason']), ...(body['witnessRef'] ? {witnessRef:string(body['witnessRef'])} : {})});
      } else if (path === '/api/real-ai/cancel') {
        fields(body, []); if (!realAI) throw new Error('E_REAL_AI_DISABLED'); result = await realAI.cancel();
      } else if (path === '/api/real-ai/decision') {
        fields(body, ['decision','semantic','rationale'], ['witnessRef']); if (!realAI) throw new Error('E_REAL_AI_DISABLED');
        if (typeof body['rationale'] !== 'string' || body['rationale'].length > 300) throw new Error('E_FIELDS');
        const decision = string(body['decision']), semantic = string(body['semantic']);
        if (!['accept','reject','retain'].includes(decision) || !['correct','incorrect','unknown'].includes(semantic)) throw new Error('E_FIELDS');
        result = await realAI.decision({decision:decision as 'accept'|'reject'|'retain',semantic:semantic as 'correct'|'incorrect'|'unknown',rationale:body['rationale'], ...(body['witnessRef'] ? {witnessRef:string(body['witnessRef'])} : {})});
      } else if (path === '/api/heartbeat') { fields(body, []); found.lastHeartbeat = now(); result = { alive: true }; }
      else if (path === '/api/focus') {
        fields(body, ['focused']); if (typeof body['focused'] !== 'boolean') throw new Error('E_FIELD_BOOLEAN');
        found.focused = body['focused']; if (!found.focused) await requestClock.pause('blur'); result = { focused: found.focused };
      } else if (path === '/api/run') {
        fields(body, ['action']); const action = body['action'];
        if (action === 'start') { canRun(found); await requestClock.pause('run_replaced'); assertRequest();
          result = await owner.host.startRun({ evidenceSource: options.humanParticipant ? 'actual_author_run' : 'machine_test', inputSource: options.humanParticipant ? 'human_keyboard' : 'machine_browser_input', executionClass: options.humanParticipant ? 'human_operation' : 'automation_test' }); await activate(); observations = null; }
        else if (action === 'pause') { await requestClock.pause('manual_pause'); result = owner.host.currentRun(); }
        else if (action === 'resume') { canRun(found); result = await owner.host.resume(); await activate(); }
        else throw new Error('E_ACTION');
      } else if (path === '/api/input') {
        fields(body, ['sequence', 'runId', 'generation', 'direction', 'clientSentAt']); canRun(found);
        result = requestClock.receive({ connectionId: found.connectionId, sequence: body['sequence'] as number,
          runId: string(body['runId']), generation: body['generation'] as number, clientSentAt: body['clientSentAt'] as number,
          direction: record(body['direction']) as unknown as { x: -1 | 0 | 1; y: -1 | 0 | 1 } });
      } else if (path === '/api/adult') {
        fields(body, ['enabled']); if (typeof body['enabled'] !== 'boolean') throw new Error('E_FIELD_BOOLEAN');
        await owner.authority.setAdult(body['enabled']); result = { enabled: body['enabled'] };
      } else if (path === '/api/scope') {
        fields(body, ['enabled']); if (typeof body['enabled'] !== 'boolean') throw new Error('E_FIELD_BOOLEAN');
        await owner.authority.setScope(body['enabled']); result = { enabled: body['enabled'] };
      } else if (path === '/api/event-selection') {
        fields(body, ['eventIds']);
        if (!Array.isArray(body['eventIds']) || body['eventIds'].length > 1000 || body['eventIds'].some(id => typeof id !== 'string')) throw new Error('E_FIELDS');
        await requestClock.pause('event_selection'); assertRequest(); observations = owner.host.observe(body['eventIds'] as string[]); result = observations;
      } else if (path === '/api/command') {
        if (body['action'] === 'preview') {
          fields(body, ['action', 'commandId', 'expectedRevision', 'command']);
          await requestClock.pause('editing'); assertRequest();
          const document = owner.host.document();
          const envelope = { commandId: string(body['commandId']), expectedRevision: body['expectedRevision'], command: body['command'],
            sessionId: owner.sessionId, writerToken: owner.writerToken, projectId: document.project.projectId };
          result = await owner.host.preview(envelope); assertRequest();
          if (record(result)['ok'] === true) { preview = { previewId: randomUUID(), envelope, connectionId: found.connectionId, result }; result = { previewId: preview.previewId, result }; }
          else preview = null;
        } else if (body['action'] === 'confirm') {
          fields(body, ['action', 'previewId']);
          const previewId = string(body['previewId']);
          const recovered = completedPreviews.get(previewId);
          if (recovered) result = await recovered;
          else {
            if (!preview || preview.previewId !== previewId || preview.connectionId !== found.connectionId) throw new Error('E_PREVIEW');
            const accepted = preview;
            const completion = (async () => {
              await requestClock.pause('editing'); assertRequest();
              const receipt = await owner.host.execute(accepted.envelope);
              if (preview === accepted) preview = null;
              return receipt;
            })();
            completedPreviews.set(previewId, completion);
            result = await completion;
          }
        } else if (body['action'] === 'cancel') { fields(body, ['action']); preview = null; result = { canceled: true }; }
        else throw new Error('E_ACTION');
      } else if (path === '/api/candidate/prepare') {
        if (realAI) throw new Error('E_CONTROLLED_CANDIDATE_DISABLED_IN_REAL_MODE');
        fields(body, ['requestId', 'operations']); await requestClock.pause('candidate_prepare'); assertRequest();
        if (!Array.isArray(body['operations'])) throw new Error('E_FIELDS');
        refreshBuild(true);
        result = await owner.candidates.prepareControlled({ requestId: string(body['requestId']), operations: body['operations'] as Operation[] });
      } else if (path === '/api/candidate/trial') {
        fields(body, ['candidateId']); refreshBuild(true); result = await owner.candidates.trial(string(body['candidateId']));
      } else if (path === '/api/candidate/confirm') {
        fields(body, ['candidateId'], ['commandId']); assertRequest();
        refreshBuild(true); result = await owner.candidates.confirm(string(body['candidateId']), body['commandId'] === undefined ? undefined : string(body['commandId']));
      } else if (path === '/api/candidate/reject') {
        fields(body, ['candidateId']); result = await owner.candidates.cancel(string(body['candidateId']));
      } else if (path === '/api/evidence') {
        fields(body, ['target'], ['candidateId']); await requestClock.pause('evidence_export'); assertRequest();
        if (body['target'] === 'formal') {
          if (body['candidateId'] !== undefined) throw new Error('E_FIELDS');
          const run = owner.host.currentRun(); if (!run) throw new Error('E_NO_RUN');
          const existing = formalExports.get(run.context.runId);
          if (existing) result = { ...existing, runId: run.context.runId, currentTick: run.tick, existing: true };
          else {
            const trace = requestClock.snapshot();
            const runPath = await owner.host.exportCurrentRun({ root, fixtureRef: realSlot?.slot.inputFixturePath ?? (options.initialFixtureId ? 'verification/fixtures/'+options.initialFixtureId+'.json' : catalogId), inputRef: run.context.inputSource === 'catalog_machine' && realAI && /^R0-AI-11-/.test(realAI.slotId) ? 'verification/inputs/terminal-conflict.json' : run.context.inputSource === 'human_keyboard' ? 'human-browser-held-input' : 'machine-browser-held-input',
              assertions: { version: 'nodon-r0-browser-transport-trace@1', serverInstanceId,
                evidenceSource: run.context.evidenceSource, inputSource: run.context.inputSource, executionClass: run.context.executionClass,
                humanWitness: options.humanParticipant ? {participantId:options.humanParticipant,role:'developer_self_test',provenance:'host_configured_requires_external_witness_not_browser_claim'} : null,
                browserEnvironment: { reportedUserAgent: request.headers['user-agent'] ?? null, source: 'http_header_unverified' },
                nodeEnvironment: { node: process.versions.node, platform: process.platform, architecture: process.arch },
                clock: { ...trace, relevance: run.context.inputSource === 'catalog_machine' ? 'not_browser_driven_for_this_run' : 'browser_input_transport', inputReceipts: trace.inputReceipts.filter(receipt => receipt.runId === run.context.runId) } } });
            const saved = { runPath, exportedTick: run.tick }; formalExports.set(run.context.runId, saved);
            result = { ...saved, runId: run.context.runId, currentTick: run.tick, existing: false };
          }
        } else if (body['target'] === 'candidate') {
          result = await owner.candidates.exportTrial(string(body['candidateId']), { root });
        } else throw new Error('E_ACTION');
      } else if (path === '/api/catalog') {
        if (realAI || options.initialFixtureId) throw new Error('E_FROZEN_SLOT_CATALOG_LOCKED');
        fields(body, ['catalogId', 'confirmReset']);
        if (body['confirmReset'] !== true || !CATALOGS.includes(body['catalogId'] as CatalogId)) throw new Error('E_CATALOG_RESET_CONFIRM');
        await requestClock.pause('catalog_reset'); assertRequest(); await owner.authority.setScope(false); await owner.candidates.revoke('catalog_reset'); assertRequest();
        archived.push({ catalogId, document: owner.host.document(), run: owner.host.currentRun(), history: owner.host.history(), candidate: owner.candidates.snapshot() });
        requestClock.stop(); catalogId = body['catalogId'] as CatalogId; current = owners(catalogId); clock = new RuntimeClock(current.host, now, clockAllowed, options.humanParticipant ? 'human_keyboard' : 'machine_browser_input');
        const catalogClock = clock;
        current.host.onRevision(() => catalogClock.block('document_revision'));
        clock.setConnection(found.connectionId); clock.start(); preview = null; completedPreviews.clear(); observations = null; result = { catalogId, reset: 'explicit_controlled_catalog' };
      } else if (path === '/api/verification') {
        if (!options.verificationMode) throw new Error('E_VERIFICATION_DISABLED');
        fields(body, ['incident']);
        if (body['incident'] !== 'simulated_connection_loss') throw new Error('E_INCIDENT');
        incident = 'verification_only_simulated_connection_loss'; await revoke('verification_simulated_connection_loss', found); result = { injectedIncident: incident };
      } else throw new Error('E_NOT_FOUND');
      if (path !== '/api/catalog' && path !== '/api/verification') assertRequest();
      if (realAI && (path.startsWith('/api/candidate/') || path === '/api/evidence')) realAI.checkpoint();
      publish(); send(response, 200, { ok: true, result: safePublic(result), snapshot: snapshot() }); return;
    }
    const assets: Record<string, { file: string; type: string }> = {
      '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
      '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
      '/styles.css': { file: 'styles.css', type: 'text/css; charset=utf-8' },
    };
    const asset = assets[path];
    if (request.method !== 'GET' || !asset || url.search || request.url !== path) throw new Error('E_NOT_FOUND');
    const assetPath = resolve(root, 'src/adapters', asset.file);
    if (lstatSync(assetPath).isSymbolicLink() || realpathSync(assetPath) !== assetPath) throw new Error('E_ASSET');
    response.writeHead(200, { 'Content-Type': asset.type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'" });
    response.end(readFileSync(assetPath));
  }
  const server = createServer((request, response) => { void route(request, response).catch(async error => {
    const code = errorCode(error);
    // A valid client's heartbeat may detect expiry before the timer's final
    // SSE snapshot. Return the revoked projection before the browser closes
    // its stream, without giving an invalid/old lease any recovery read.
    const expired = lease;
    let recoverySnapshot: ReturnType<typeof snapshot> | undefined;
    if (code === 'E_LEASE_EXPIRED' && request.method === 'POST' && expired &&
      request.headers.origin === origin && request.headers['x-nodon-connection'] === expired.connectionId &&
      typeof request.headers['x-nodon-csrf'] === 'string' && equal(request.headers['x-nodon-csrf'], expired.csrfToken)) {
      await expired.revocation;
      if (lease === expired && !expired.connected) recoverySnapshot = snapshot();
    }
    send(response, code === 'E_NOT_FOUND' ? 404 : code === 'E_JSON_SIZE' ? 413 : code === 'E_HOST' || code === 'E_ORIGIN' || code === 'E_CSRF' ? 403 : 400,
      { ok: false, error: code, ...(recoverySnapshot ? { snapshot: recoverySnapshot } : {}) });
  }); });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.keepAliveTimeout = 1000;
  const timer = setInterval(() => {
    if (lease?.connected && (now() - lease.lastHeartbeat >= 1000 || now() >= lease.expiresAt)) void revoke(now() >= lease.expiresAt ? 'session_expired' : 'heartbeat_timeout', lease);
    publish();
  }, 50); timer.unref();
  return {
    server, snapshot,
    async listen(): Promise<{ url: string; buildId: string }> {
      if (stopped) throw new Error('E_SERVER_STOPPED');
      await new Promise<void>((accept, reject) => { server.once('error', reject); server.listen(options.port ?? 4180, '127.0.0.1', () => { server.off('error', reject); accept(); }); });
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('E_ADDRESS');
      origin = `http://127.0.0.1:${address.port}`; clock.start(); return { url: origin, buildId: options.buildIdentity.buildId };
    },
    async close(): Promise<void> {
      stopped = true; clearInterval(timer); watcher.close(); await revoke('server_stopped'); clock.stop(); if (realAI) await realAI.close();
      await new Promise<void>((accept, reject) => { server.close(error => error ? reject(error) : accept()); server.closeAllConnections(); });
    },
  };
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  let port = 4180, verificationMode = false; let realAiSlotID: string | undefined; let humanParticipant: 'HUMAN-01' | undefined; let initialFixtureId: typeof FROZEN_REFERENCES[number] | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--port') { const value = args[++index]; if (value === undefined || !/^\d+$/.test(value) || Number(value) > 65535) throw new Error('E_CLI_ARGUMENT'); port = Number(value); }
    else if (arg === '--verification-mode') verificationMode = true;
    else if (arg === '--real-ai-slot') { const value = args[++index]; if (!value || !/^R0-AI-[0-9]{2}-R[12]-[IF]$/.test(value)) throw new Error('E_CLI_ARGUMENT'); realAiSlotID = value; }
    else if (arg === '--frozen-fixture') { const value = args[++index]; if (!value || !(FROZEN_REFERENCES as readonly string[]).includes(value)) throw new Error('E_CLI_ARGUMENT'); initialFixtureId=value as typeof FROZEN_REFERENCES[number]; }
    else if (arg === '--human-participant') { if (args[++index] !== 'HUMAN-01') throw new Error('E_CLI_ARGUMENT'); humanParticipant = 'HUMAN-01'; }
    else throw new Error('E_CLI_ARGUMENT');
  }
  const root = assertAuthorizedRoot(), identity = createBuildIdentity(root);
  const app = createWebServer({ root, buildIdentity: identity, port, verificationMode, ...(realAiSlotID ? {realAiSlotID} : {}), ...(humanParticipant ? {humanParticipant} : {}), ...(initialFixtureId ? {initialFixtureId} : {}) });
  const manifest = await app.listen(); console.log(JSON.stringify({ ...manifest, storage: 'controlled_in_memory_initial_state_only', verificationMode }));
  const stop = () => { void app.close().then(() => { process.exitCode = 0; }); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(error => { console.error(JSON.stringify({ ok: false, error: errorCode(error) })); process.exitCode = 1; });
}
