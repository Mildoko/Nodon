import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { createWebServer } from '../src/host/web-server.js';
import { createBuildIdentity, type BuildIdentity } from '../tools/build-manifest.js';

// Actual loopback HTTP probes normally use visibly synthetic build identity.
// The candidate receipt regression uses the current actual build for its strict
// build gate; it exports no evidence. None of these assertions establish human
// operation, browser environment, visual UI QA, or a saved actual-run package.
const build: BuildIdentity = { buildId: 'synthetic-t04-http', buildHash: 'sha256:' + 'c'.repeat(64),
  runtimeArtifactHash: 'sha256:' + 'd'.repeat(64), environmentId: 'synthetic-t04-http-unit', manifest: {},
  runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] }, productionPackagePaths: [] };
interface Session { connectionId: string; csrfToken: string; snapshot: { document: { project: { revision: number } } } }
async function setup(verificationMode = false, options: { identity?: BuildIdentity; now?: () => number } = {}) {
  const app = createWebServer({ root: process.cwd(), buildIdentity: options.identity ?? build, port: 0, verificationMode,
    ...(options.now ? { now: options.now } : {}) });
  const { url } = await app.listen();
  const session = await (await fetch(url + '/api/session')).json() as Session;
  const headers = { 'Content-Type': 'application/json', Origin: url, 'X-Nodon-Connection': session.connectionId, 'X-Nodon-CSRF': session.csrfToken };
  const post = (path: string, body: unknown) => fetch(url + path, { method: 'POST', headers, body: JSON.stringify(body) });
  return { app, url, session, headers, post };
}

test('T04 HTTP: exact host/origin, JSON-only, duplicate keys, size and CSRF fail closed', async () => {
  const s = await setup();
  try {
    const cases: Array<{ headers: Record<string, string>; body: string; expected: string }> = [
      { headers: { ...s.headers, Origin: 'http://attacker.invalid' }, body: '{}', expected: 'E_ORIGIN' },
      { headers: { ...s.headers, 'X-Nodon-CSRF': 'wrong' }, body: '{}', expected: 'E_CSRF' },
      { headers: { ...s.headers, 'Content-Type': 'text/plain' }, body: '{}', expected: 'E_JSON_ONLY' },
      { headers: s.headers, body: '{"focused":true,"focused":false}', expected: 'E_DUPLICATE_KEY' },
      { headers: s.headers, body: JSON.stringify({ large: 'x'.repeat(1024 * 1024) }), expected: 'E_JSON_SIZE' },
    ];
    for (const item of cases) {
      const response = await fetch(s.url + '/api/focus', { method: 'POST', headers: item.headers, body: item.body });
      const value = await response.json() as { error: string }; assert.equal(value.error, item.expected);
    }
    // Node's fetch/Undici derives Host from the URL; use the raw HTTP client so
    // this probe actually sends the hostile authority rather than testing a
    // normalized same-origin request. Keep the exact 403 / E_HOST contract.
    const hostResponse = await new Promise<{ status: number; body: { error: string } }>((accept, reject) => {
      const request = httpRequest(new URL('/api/session', s.url), { method: 'GET', headers: { Host: 'localhost:' + new URL(s.url).port } }, response => {
        response.setEncoding('utf8'); let body = '';
        response.on('data', (chunk: string) => { body += chunk; });
        response.on('error', reject);
        response.on('end', () => {
          try { accept({ status: response.statusCode ?? 0, body: JSON.parse(body) as { error: string } }); }
          catch (error) { reject(error); }
        });
      });
      request.on('error', reject); request.end();
    });
    assert.equal(hostResponse.status, 403); assert.equal(hostResponse.body.error, 'E_HOST');
  } finally { await s.app.close(); }
});

test('T04 HTTP: serves only the new fixed asset allowlist, never source, secrets or evidence', async () => {
  const s = await setup();
  try {
    for (const path of ['/.env', '/.local', '/src/host/web-server.ts', '/evidence/r0', '/06_prototype.html', '/favicon.ico']) {
      const response = await fetch(s.url + path); assert.equal(response.status, 404, path);
    }
    const response = await fetch(s.url + '/'); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
    assert.doesNotMatch(JSON.stringify(s.app.snapshot()), /writerToken|csrfToken|apiKey/);
  } finally { await s.app.close(); }
});

test('T04 HTTP: preview consumes no revision; confirmation commits once; refresh preserves the committed document', async () => {
  const s = await setup();
  try {
    const before = s.session.snapshot.document.project.revision;
    const previewResponse = await s.post('/api/command', { action: 'preview', commandId: randomUUID(), expectedRevision: before, command: { type: 'set_goal', value: 6 } });
    const prepared = await previewResponse.json() as { result: { previewId: string }; snapshot: { document: { project: { revision: number } } } };
    assert.equal(prepared.snapshot.document.project.revision, before); assert.ok(prepared.result.previewId);
    const committed = await (await s.post('/api/command', { action: 'confirm', previewId: prepared.result.previewId })).json() as { snapshot: { document: { project: { revision: number; rules: { goal: { targetScore: number } } } } } };
    assert.equal(committed.snapshot.document.project.revision, before + 1); assert.equal(committed.snapshot.document.project.rules.goal.targetScore, 6);
    const refreshed = await (await fetch(s.url + '/api/session')).json() as Session;
    assert.notEqual(refreshed.connectionId, s.session.connectionId); assert.equal(refreshed.snapshot.document.project.revision, before + 1);
    const stale = await s.post('/api/heartbeat', {}); assert.equal((await stale.json() as { error: string }).error, 'E_CONNECTION');
  } finally { await s.app.close(); }
});

test('T04 HTTP: start requires focused stream, old stream close cannot revoke a replacement stream', async () => {
  const s = await setup(); const firstAbort = new AbortController(), secondAbort = new AbortController();
  try {
    assert.equal((await (await s.post('/api/run', { action: 'start' })).json() as { error: string }).error, 'E_FOCUS_REQUIRED');
    const first = await fetch(s.url + '/api/events', { headers: { 'X-Nodon-Connection': s.session.connectionId }, signal: firstAbort.signal });
    assert.equal(first.status, 200);
    const second = await fetch(s.url + '/api/events', { headers: { 'X-Nodon-Connection': s.session.connectionId }, signal: secondAbort.signal });
    assert.equal(second.status, 200); firstAbort.abort();
    await s.post('/api/focus', { focused: true });
    const started = await (await s.post('/api/run', { action: 'start' })).json() as { ok: boolean; snapshot: { run: { status: string; context: { inputSource: string } } } };
    assert.equal(started.ok, true); assert.equal(started.snapshot.run.status, 'running'); assert.equal(started.snapshot.run.context.inputSource, 'machine_browser_input');
    const paused = await (await s.post('/api/focus', { focused: false })).json() as { snapshot: { run: { status: string }; clock: { direction: unknown } } };
    assert.equal(paused.snapshot.run.status, 'paused'); assert.deepEqual(paused.snapshot.clock.direction, { x: 0, y: 0 });
    const focused = await (await s.post('/api/focus', { focused: true })).json() as { snapshot: { run: { status: string } } };
    assert.equal(focused.snapshot.run.status, 'paused');
  } finally { firstAbort.abort(); secondAbort.abort(); await s.app.close(); }
});

test('T04 HTTP: controlled catalog reset and incident injection require explicit supported values', async () => {
  const s = await setup();
  try {
    const reset = await s.post('/api/catalog', { catalogId: 'scene-b', confirmReset: false });
    assert.equal((await reset.json() as { error: string }).error, 'E_CATALOG_RESET_CONFIRM');
    const injection = await s.post('/api/verification', { incident: 'simulated_connection_loss' });
    assert.equal((await injection.json() as { error: string }).error, 'E_VERIFICATION_DISABLED');
    const arbitrary = await s.post('/api/catalog', { catalogId: '/tmp/arbitrary.json', confirmReset: true });
    assert.equal((await arbitrary.json() as { error: string }).error, 'E_CATALOG_RESET_CONFIRM');
  } finally { await s.app.close(); }
});

test('T04 recovery: committed manual preview returns its original receipt after a new lease without applying twice', async () => {
  const s = await setup(false, { now: () => 0 });
  try {
    const revision = s.session.snapshot.document.project.revision;
    const prepared = await (await s.post('/api/command', { action: 'preview', commandId: randomUUID(), expectedRevision: revision,
      command: { type: 'set_goal', value: 6 } })).json() as { ok: boolean; result: { previewId: string } };
    assert.equal(prepared.ok, true); assert.ok(prepared.result.previewId);
    const committed = await (await s.post('/api/command', { action: 'confirm', previewId: prepared.result.previewId })).json() as {
      ok: boolean; result: { ok: boolean; revision: number }; snapshot: Session['snapshot'];
    };
    assert.equal(committed.ok, true); assert.equal(committed.result.ok, true); assert.equal(committed.result.revision, revision + 1);
    const refreshed = await (await fetch(s.url + '/api/session')).json() as Session;
    assert.notEqual(refreshed.connectionId, s.session.connectionId);
    const headers = { ...s.headers, 'X-Nodon-Connection': refreshed.connectionId, 'X-Nodon-CSRF': refreshed.csrfToken };
    const retried = await (await fetch(s.url + '/api/command', { method: 'POST', headers,
      body: JSON.stringify({ action: 'confirm', previewId: prepared.result.previewId }) })).json() as {
      ok: boolean; result: unknown; snapshot: Session['snapshot'];
    };
    assert.equal(retried.ok, true); assert.deepEqual(retried.result, committed.result);
    assert.equal(retried.snapshot.document.project.revision, revision + 1, 'receipt recovery cannot commit a second revision');
    const staleLease = await s.post('/api/heartbeat', {});
    assert.equal((await staleLease.json() as { error: string }).error, 'E_CONNECTION', 'receipt recovery does not revive the old lease');
  } finally { await s.app.close(); }
});

test('T04 recovery: applied candidate receipt replay and already-applied rejection cannot pause or clear a new formal run', async () => {
  // Freeze only the transport clock. The candidate still executes the actual
  // Runtime with the actual current build and Web's asynchronous 250 ms slices.
  const s = await setup(false, { identity: createBuildIdentity(process.cwd()), now: () => 0 });
  const streamAbort = new AbortController();
  type Formal = { context: { runId: string; generation: number }; status: string; controls: unknown[] };
  type State = { document: { project: { revision: number } }; run: Formal; clock: { paused: boolean; direction: { x: number; y: number } } };
  try {
    assert.equal((await (await s.post('/api/adult', { enabled: true })).json() as { ok: boolean }).ok, true);
    const prepared = await (await s.post('/api/candidate/prepare', { requestId: randomUUID(),
      operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }] })).json() as { ok: boolean; result: { candidateId: string; trialStatus: string } };
    assert.equal(prepared.ok, true); assert.equal(prepared.result.trialStatus, 'not_run');
    const candidateId = prepared.result.candidateId;
    const trial = await (await s.post('/api/candidate/trial', { candidateId })).json() as { ok: boolean; result: { trialStatus: string; trial: { run: { tick: number } } } };
    assert.equal(trial.ok, true); assert.equal(trial.result.trialStatus, 'passed'); assert.ok(trial.result.trial.run.tick > 0);
    const commandId = randomUUID();
    const applied = await (await s.post('/api/candidate/confirm', { candidateId, commandId })).json() as {
      ok: boolean; result: { ok: boolean; revision: number }; snapshot: State;
    };
    assert.equal(applied.ok, true); assert.equal(applied.result.ok, true);
    const stream = await fetch(s.url + '/api/events', { headers: { 'X-Nodon-Connection': s.session.connectionId }, signal: streamAbort.signal });
    assert.equal(stream.status, 200);
    await s.post('/api/focus', { focused: true });
    const started = await (await s.post('/api/run', { action: 'start' })).json() as { ok: boolean; snapshot: State };
    assert.equal(started.ok, true); assert.equal(started.snapshot.run.status, 'running'); assert.equal(started.snapshot.clock.paused, false);
    const run = started.snapshot.run;
    const held = await (await s.post('/api/input', { sequence: 1, runId: run.context.runId, generation: run.context.generation,
      clientSentAt: 123, direction: { x: 1, y: 0 } })).json() as { ok: boolean; snapshot: State };
    assert.equal(held.ok, true); assert.deepEqual(held.snapshot.clock.direction, { x: 1, y: 0 });
    const replay = await (await s.post('/api/candidate/confirm', { candidateId, commandId })).json() as { ok: boolean; result: unknown; snapshot: State };
    assert.equal(replay.ok, true); assert.deepEqual(replay.result, applied.result);
    const denied = await (await s.post('/api/candidate/confirm', { candidateId, commandId: randomUUID() })).json() as {
      ok: boolean; result: { ok: boolean; code: string }; snapshot: State;
    };
    assert.equal(denied.ok, true); assert.equal(denied.result.ok, false); assert.equal(denied.result.code, 'E_ALREADY_APPLIED');
    for (const response of [replay, denied]) {
      assert.equal(response.snapshot.document.project.revision, applied.result.revision);
      assert.equal(response.snapshot.run.context.runId, run.context.runId); assert.equal(response.snapshot.run.context.generation, run.context.generation);
      assert.equal(response.snapshot.run.status, 'running'); assert.equal(response.snapshot.clock.paused, false);
      assert.deepEqual(response.snapshot.clock.direction, { x: 1, y: 0 }); assert.deepEqual(response.snapshot.run.controls, run.controls);
    }
  } finally { streamAbort.abort(); await s.app.close(); }
});
