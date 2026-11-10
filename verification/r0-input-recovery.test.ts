import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebServer } from '../src/host/web-server.js';
import type { RuntimeClock } from '../src/host/runtime-clock.js';
import type { RunSnapshot } from '../src/host/run-session.js';
import type { Direction } from '../src/runtime/index.js';
import type { BuildIdentity } from '../tools/build-manifest.js';

// Actual loopback HTTP + actual Node Runtime, with injected monotonic time.
// These synthetic-build machine regressions export no run evidence and make no
// claim about a browser, human keyboard operation, or historical failure cause.
const build: BuildIdentity = { buildId: 'synthetic-r0-input-recovery', buildHash: 'sha256:' + 'a'.repeat(64),
  runtimeArtifactHash: 'sha256:' + 'b'.repeat(64), environmentId: 'synthetic-r0-http-input-recovery', manifest: {},
  runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] }, productionPackagePaths: [] };
type ClockSnapshot = ReturnType<RuntimeClock['snapshot']>;
interface Snapshot {
  run: RunSnapshot | null;
  clock: ClockSnapshot;
  connection: { connectionId: string; focused: boolean; connected: boolean; streamConnected: boolean } | null;
}
interface Session { connectionId: string; csrfToken: string; snapshot: Snapshot }
interface Reply { ok: boolean; error?: string; snapshot?: Snapshot }

async function setup() {
  let now = 0;
  const app = createWebServer({ root: process.cwd(), buildIdentity: build, port: 0,
    initialFixtureId: 'zero-guard-route', now: () => now });
  const { url } = await app.listen();
  const aborts: AbortController[] = [];
  const session = async () => (await (await fetch(url + '/api/session')).json()) as Session;
  const first = await session();
  const snapshot = () => app.snapshot() as Snapshot;
  const post = async (lease: Session, path: string, body: unknown): Promise<Reply> => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      Origin: url, 'X-Nodon-Connection': lease.connectionId, 'X-Nodon-CSRF': lease.csrfToken }, body: JSON.stringify(body) });
    return await response.json() as Reply;
  };
  const ok = async (lease: Session, path: string, body: unknown): Promise<Snapshot> => {
    const reply = await post(lease, path, body);
    assert.equal(reply.ok, true, path + ': ' + reply.error); assert.ok(reply.snapshot);
    return reply.snapshot;
  };
  const stream = async (lease: Session) => {
    const abort = new AbortController(); aborts.push(abort);
    const response = await fetch(url + '/api/events', { headers: { 'X-Nodon-Connection': lease.connectionId }, signal: abort.signal });
    assert.equal(response.status, 200); return abort;
  };
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2000;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'Node HTTP/Runtime condition timed out'); await delay(4); }
  };
  const run = () => { const value = snapshot().run; assert.ok(value); return value; };
  const advanceTick = async () => {
    const expected = run().tick + 1; now += 17;
    await waitFor(() => run().tick >= expected);
    assert.equal(run().tick, expected); return run();
  };
  const input = (lease: Session, identity: RunSnapshot['context'], sequence: number, direction: Direction) =>
    post(lease, '/api/input', { sequence, runId: identity.runId, generation: identity.generation, direction, clientSentAt: now });
  const start = async (lease = first) => {
    await stream(lease); await ok(lease, '/api/focus', { focused: true });
    await ok(lease, '/api/run', { action: 'start' }); return run();
  };
  return { app, first, session, snapshot, post, ok, stream, waitFor, run, advanceTick, input, start,
    advance: (ms: number) => { now += ms; },
    close: async () => { for (const abort of aborts) abort.abort(); await app.close(); } };
}
function player(run: RunSnapshot) { const position = run.positions['p']; assert.ok(position); return position; }
function assertApplied(snapshot: Snapshot, sequence: number, connectionId: string, direction: Direction) {
  const receipt = snapshot.clock.inputReceipts.find(item => item.sequence === sequence && item.connectionId === connectionId);
  assert.ok(receipt); assert.equal(receipt.committed, true); assert.ok(receipt.effectiveTick !== null);
  assert.deepEqual(snapshot.run?.inputs[receipt.effectiveTick - 1]?.direction, direction);
}

test('R0 HTTP input recovery: blur clears held input; focus needs explicit resume and fresh direction is consumed', async () => {
  const s = await setup();
  try {
    const started = await s.start(); const initial = player(started);
    assert.equal((await s.input(s.first, started.context, 1, { x: 0, y: -1 })).ok, true);
    const moved = await s.advanceTick(); assert.ok(player(moved).y < initial.y);
    assertApplied(s.snapshot(), 1, s.first.connectionId, { x: 0, y: -1 });
    assert.equal((await s.input(s.first, started.context, 2, { x: 0, y: -1 })).ok, true);
    const blurred = await s.ok(s.first, '/api/focus', { focused: false });
    assert.equal(blurred.run?.status, 'paused'); assert.equal(blurred.clock.paused, true);
    assert.deepEqual(blurred.clock.direction, { x: 0, y: 0 });
    assert.equal(blurred.clock.inputReceipts.at(-1)?.superseded, true);
    assert.equal(blurred.clock.inputReceipts.at(-1)?.effectiveTick, null);
    assert.equal((await s.input(s.first, started.context, 3, { x: 0, y: 1 })).error, 'E_FOCUS_REQUIRED');
    await s.ok(s.first, '/api/focus', { focused: true });
    assert.equal(s.run().status, 'paused');
    assert.equal((await s.input(s.first, started.context, 3, { x: 0, y: 1 })).error, 'E_RUN_NOT_RUNNING');
    s.advance(100); await delay(20); assert.equal(s.run().tick, moved.tick);
    await s.ok(s.first, '/api/run', { action: 'resume' });
    const neutral = await s.advanceTick(); assert.deepEqual(player(neutral), player(moved));
    assert.deepEqual(neutral.inputs.at(-1)?.direction, { x: 0, y: 0 });
    assert.equal((await s.input(s.first, started.context, 3, { x: 0, y: 1 })).ok, true);
    const recovered = await s.advanceTick(); assert.ok(player(recovered).y > player(neutral).y);
    assertApplied(s.snapshot(), 3, s.first.connectionId, { x: 0, y: 1 });
  } finally { await s.close(); }
});

test('R0 HTTP input recovery: replacing a lease rejects old input and resets sequence without resuming held input', async () => {
  const s = await setup();
  try {
    const started = await s.start();
    assert.equal((await s.input(s.first, started.context, 7, { x: 0, y: -1 })).ok, true);
    const replacement = await s.session();
    assert.notEqual(replacement.connectionId, s.first.connectionId);
    assert.equal(s.run().status, 'paused'); assert.deepEqual(s.snapshot().clock.direction, { x: 0, y: 0 });
    assert.equal(s.snapshot().clock.lastSequence, 0);
    assert.equal((await s.input(s.first, started.context, 8, { x: 0, y: -1 })).error, 'E_CONNECTION');
    assert.equal((await s.post(s.first, '/api/heartbeat', {})).error, 'E_CONNECTION');
    assert.equal((await s.post(replacement, '/api/run', { action: 'resume' })).error, 'E_FOCUS_REQUIRED');
    await s.ok(replacement, '/api/focus', { focused: true });
    assert.equal((await s.post(replacement, '/api/run', { action: 'resume' })).error, 'E_FOCUS_REQUIRED');
    await s.stream(replacement);
    assert.equal(s.run().status, 'paused');
    assert.equal((await s.input(replacement, started.context, 1, { x: 0, y: 1 })).error, 'E_RUN_NOT_RUNNING');
    await s.ok(replacement, '/api/run', { action: 'resume' });
    const neutral = await s.advanceTick(); assert.deepEqual(player(neutral), player(started));
    assert.deepEqual(neutral.inputs.at(-1)?.direction, { x: 0, y: 0 });
    assert.equal((await s.input(replacement, started.context, 1, { x: 0, y: 1 })).ok, true);
    const recovered = await s.advanceTick(); assert.ok(player(recovered).y > player(neutral).y);
    assertApplied(s.snapshot(), 1, replacement.connectionId, { x: 0, y: 1 });
    assert.equal(s.snapshot().clock.inputReceipts.find(item => item.sequence === 7)?.effectiveTick, null);
  } finally { await s.close(); }
});

test('R0 HTTP input recovery: stale run or generation cannot alter a replacement run', async () => {
  const s = await setup();
  try {
    const previous = await s.start();
    assert.equal((await s.input(s.first, previous.context, 1, { x: 0, y: -1 })).ok, true);
    await s.ok(s.first, '/api/run', { action: 'start' }); const current = s.run();
    assert.notEqual(current.context.runId, previous.context.runId); assert.ok(current.context.generation > previous.context.generation);
    for (const identity of [previous.context, { ...current.context, generation: previous.context.generation },
      { ...current.context, runId: previous.context.runId }]) {
      assert.equal((await s.input(s.first, identity, 2, { x: 0, y: -1 })).error, 'E_STALE_RUN');
    }
    assert.equal(s.snapshot().clock.totalInputs, 1); assert.deepEqual(s.snapshot().clock.direction, { x: 0, y: 0 });
    const neutral = await s.advanceTick(); assert.deepEqual(player(neutral), player(current));
    assert.deepEqual(neutral.inputs.at(-1)?.direction, { x: 0, y: 0 });
    assert.equal((await s.input(s.first, current.context, 2, { x: 0, y: 1 })).ok, true);
    const recovered = await s.advanceTick(); assert.ok(player(recovered).y > player(neutral).y);
    assertApplied(s.snapshot(), 2, s.first.connectionId, { x: 0, y: 1 });
    assert.equal(s.run().context.runId, current.context.runId);
  } finally { await s.close(); }
});

test('R0 HTTP input recovery: expired heartbeat pauses and revokes the lease before stale input can step', async () => {
  const s = await setup();
  try {
    const started = await s.start();
    assert.equal((await s.input(s.first, started.context, 1, { x: 0, y: -1 })).ok, true);
    s.advance(1000);
    const rejected = await s.input(s.first, started.context, 2, { x: 0, y: -1 });
    assert.equal(rejected.ok, false); assert.ok(['E_LEASE_EXPIRED', 'E_CONNECTION'].includes(rejected.error ?? ''));
    await s.waitFor(() => s.snapshot().connection?.connected === false && s.run().status === 'paused');
    assert.equal(s.run().tick, 0); assert.deepEqual(player(s.run()), player(started));
    assert.deepEqual(s.snapshot().clock.direction, { x: 0, y: 0 });
    s.advance(1000); await delay(20); assert.equal(s.run().tick, 0);
  } finally { await s.close(); }
});

test('R0 HTTP input recovery: stream loss and server shutdown leave Runtime paused with neutral held input', async () => {
  const s = await setup(); let closed = false;
  try {
    const stream = await s.stream(s.first); await s.ok(s.first, '/api/focus', { focused: true });
    await s.ok(s.first, '/api/run', { action: 'start' }); const started = s.run();
    assert.equal((await s.input(s.first, started.context, 1, { x: 0, y: -1 })).ok, true);
    stream.abort();
    await s.waitFor(() => s.snapshot().connection?.connected === false && s.run().status === 'paused');
    assert.equal((await s.input(s.first, started.context, 2, { x: 0, y: -1 })).error, 'E_CONNECTION');
    assert.deepEqual(s.snapshot().clock.direction, { x: 0, y: 0 });
    s.advance(100); await delay(20); assert.equal(s.run().tick, 0);
    const replacement = await s.session(); await s.start(replacement);
    assert.equal((await s.input(replacement, s.run().context, 1, { x: 0, y: 1 })).ok, true);
    await s.app.close(); closed = true;
    const stopped = s.snapshot(); assert.equal(stopped.run?.status, 'paused'); assert.equal(stopped.clock.paused, true);
    assert.deepEqual(stopped.clock.direction, { x: 0, y: 0 });
    s.advance(100); await delay(20); assert.equal(s.run().tick, stopped.run?.tick);
    await assert.rejects(s.app.listen(), /E_SERVER_STOPPED/);
  } finally { if (!closed) await s.close(); }
});
