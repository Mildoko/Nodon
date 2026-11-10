import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebServer } from '../src/host/web-server.js';
import { createBuildIdentity } from '../tools/build-manifest.js';
import type { Document, Operation } from '../src/domain/index.js';
import type { CandidateSnapshot } from '../src/trial/types.js';

// Loopback HTTP + actual Node authority/Runtime. The monotonic transport clock
// is injected; no browser, person, provider, key, ledger, or real slot is used.
interface Connection {
  connectionId: string; connected: boolean; focused: boolean; streamConnected: boolean;
  leaseRemainingMs: number; revocationReason: string | null; lastRevocationReason: string | null;
}
interface Snapshot {
  modelStatus: string; realAI: unknown; document: Document; candidate: CandidateSnapshot | null;
  authority: { adultEnabled: boolean; authEpoch: number };
  connection: Connection | null; clock: { paused: boolean; reason: string; direction: unknown };
}
interface Session { connectionId: string; csrfToken: string; snapshot: Snapshot; heartbeatTimeoutMs: number }
interface Reply { ok: boolean; error?: string; result?: unknown; snapshot?: Snapshot }

async function setup() {
  let now = 0;
  const app = createWebServer({ root: process.cwd(), buildIdentity: createBuildIdentity(process.cwd()), port: 0, now: () => now });
  const { url } = await app.listen();
  const aborts: AbortController[] = [];
  const session = async () => await (await fetch(url + '/api/session')).json() as Session;
  const first = await session();
  const post = async (lease: Session, path: string, body: unknown): Promise<Reply> => {
    const response = await fetch(url + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: url,
      'X-Nodon-Connection': lease.connectionId, 'X-Nodon-CSRF': lease.csrfToken }, body: JSON.stringify(body) });
    return await response.json() as Reply;
  };
  const ok = async (lease: Session, path: string, body: unknown) => {
    const reply = await post(lease, path, body); assert.equal(reply.ok, true, path + ': ' + reply.error); return reply;
  };
  const snapshot = () => app.snapshot() as Snapshot;
  const waitFor = async (predicate: () => boolean) => {
    const deadline = Date.now() + 2500;
    while (!predicate()) { assert.ok(Date.now() < deadline, 'HTTP session condition timed out'); await delay(4); }
  };
  const stream = async (lease: Session) => {
    const abort = new AbortController(); aborts.push(abort);
    const response = await fetch(url + '/api/events', { headers: { 'X-Nodon-Connection': lease.connectionId }, signal: abort.signal });
    assert.equal(response.status, 200); assert.ok(response.body);
    const reader = response.body.getReader();
    const received: Snapshot[] = []; let ended = false; let pending = '';
    const drained = (async () => {
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { ended = true; return; }
          pending += new TextDecoder().decode(chunk.value);
          let boundary: number;
          while ((boundary = pending.indexOf('\n\n')) !== -1) {
            const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
            const data = frame.split('\n').find(line => line.startsWith('data: '));
            if (data) received.push(JSON.parse(data.slice(6)) as Snapshot);
          }
        }
      } catch (error) { if (!abort.signal.aborted) throw error; }
    })();
    return { abort, received, drained, ended: () => ended };
  };
  return { app, url, first, session, post, ok, snapshot, waitFor, stream,
    advance: (ms: number) => { now += ms; },
    close: async () => { for (const abort of aborts) abort.abort(); await app.close(); } };
}
function connection(snapshot: Snapshot): Connection { assert.ok(snapshot.connection); return snapshot.connection; }
function candidate(snapshot: Snapshot): CandidateSnapshot & { historicalOperations?: Operation[] } { assert.ok(snapshot.candidate); return snapshot.candidate; }
function privateFree(snapshot: Snapshot) { assert.doesNotMatch(JSON.stringify(snapshot), /writerToken|csrfToken|apiKey|authorization|secret/); }

// Timer expiry must be tested without a request triggering requireLease first.
test('R0 session HTTP: healthy heartbeats do not renew the 600000 ms lease; expiry is delivered before SSE end', async () => {
  const s = await setup();
  try {
    const events = await s.stream(s.first);
    assert.equal(s.first.heartbeatTimeoutMs, 1000);
    // Remain strictly inside each 1000 ms heartbeat window until the deadline.
    for (let i = 0; i < 600; i++) { s.advance(999); await s.ok(s.first, '/api/heartbeat', {}); }
    s.advance(599); await s.ok(s.first, '/api/heartbeat', {}); // t=599999, heartbeat healthy
    s.advance(1);
    await s.waitFor(() => connection(s.snapshot()).connected === false);
    assert.equal(s.snapshot().clock.reason, 'session_expired');
    assert.equal(connection(s.snapshot()).revocationReason, 'session_expired');
    assert.equal(connection(s.snapshot()).leaseRemainingMs, 0);
    await s.waitFor(() => events.ended()); await events.drained;
    const final = events.received.at(-1); assert.ok(final);
    assert.equal(connection(final).connected, false); assert.equal(connection(final).revocationReason, 'session_expired');
    assert.equal(final.authority.adultEnabled, false); privateFree(final);
    assert.equal((await s.post(s.first, '/api/heartbeat', {})).error, 'E_CONNECTION');
    const fresh = await s.session();
    assert.equal(connection(fresh.snapshot).leaseRemainingMs, 600000);
    assert.equal(connection(fresh.snapshot).revocationReason, null);
    assert.equal(connection(fresh.snapshot).lastRevocationReason, 'session_expired');
  } finally { await s.close(); }
});

test('R0 session HTTP: heartbeat timeout has its own reason and final SSE snapshot', async () => {
  const s = await setup();
  try {
    const events = await s.stream(s.first); await s.ok(s.first, '/api/adult', { enabled: true });
    s.advance(1000);
    await s.waitFor(() => connection(s.snapshot()).connected === false);
    assert.equal(s.snapshot().clock.reason, 'heartbeat_timeout');
    assert.equal(connection(s.snapshot()).revocationReason, 'heartbeat_timeout');
    await s.waitFor(() => events.ended()); await events.drained;
    const final = events.received.at(-1); assert.ok(final);
    assert.equal(connection(final).revocationReason, 'heartbeat_timeout'); assert.equal(final.authority.adultEnabled, false);
    const fresh = await s.session(); assert.equal(connection(fresh.snapshot).lastRevocationReason, 'heartbeat_timeout');
    assert.equal(connection(fresh.snapshot).leaseRemainingMs, 600000); privateFree(fresh.snapshot);
  } finally { await s.close(); }
});

test('R0 session HTTP: stream close is connection_lost; reconnect preserves the cause', async () => {
  const s = await setup();
  try {
    const events = await s.stream(s.first); await s.ok(s.first, '/api/adult', { enabled: true });
    events.abort.abort(); await events.drained;
    await s.waitFor(() => connection(s.snapshot()).connected === false && !s.snapshot().authority.adultEnabled);
    assert.equal(connection(s.snapshot()).revocationReason, 'connection_lost');
    const fresh = await s.session(); assert.equal(connection(fresh.snapshot).lastRevocationReason, 'connection_lost');
    assert.equal(connection(fresh.snapshot).revocationReason, null); assert.equal(connection(fresh.snapshot).leaseRemainingMs, 600000);
    assert.equal((await s.post(s.first, '/api/heartbeat', {})).error, 'E_CONNECTION');
  } finally { await s.close(); }
});

test('R0 session HTTP: lease replacement without a stream has Node remaining time and records connection_replaced', async () => {
  const s = await setup();
  try {
    assert.equal(connection(s.first.snapshot).leaseRemainingMs, 600000);
    s.advance(250);
    const heartbeat = await s.ok(s.first, '/api/heartbeat', {}); assert.ok(heartbeat.snapshot);
    assert.equal(connection(heartbeat.snapshot).leaseRemainingMs, 599750);
    const fresh = await s.session(); assert.notEqual(fresh.connectionId, s.first.connectionId);
    assert.equal(connection(fresh.snapshot).leaseRemainingMs, 600000);
    assert.equal(connection(fresh.snapshot).lastRevocationReason, 'connection_replaced');
    assert.equal(fresh.snapshot.modelStatus, 'disabled_no_model_requests'); assert.equal(fresh.snapshot.realAI, null);
    privateFree(fresh.snapshot);
  } finally { await s.close(); }
});

test('R0 session HTTP: a replacement lease cannot revive a canceled proposal or change the original; trial history remains readable', async () => {
  const s = await setup();
  try {
    const original = structuredClone(s.first.snapshot.document);
    const operations: Operation[] = [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }];
    await s.ok(s.first, '/api/adult', { enabled: true });
    const prepared = await s.ok(s.first, '/api/candidate/prepare', { requestId: randomUUID(), operations }); assert.ok(prepared.snapshot);
    const proposal = candidate(prepared.snapshot); assert.equal(proposal.source, 'controlled_fixture'); assert.equal(proposal.providerEvidence, null);
    const trialReply = await s.ok(s.first, '/api/candidate/trial', { candidateId: proposal.candidateId }); assert.ok(trialReply.snapshot);
    const tried = candidate(trialReply.snapshot); assert.equal(tried.trialStatus, 'passed'); assert.equal(tried.canConfirm, true);
    assert.ok(tried.trial?.run); assert.ok(tried.trial.run.tick > 0);
    const fresh = await s.session();
    const canceled = candidate(fresh.snapshot); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.canConfirm, false); assert.equal(canceled.canTrial, false);
    assert.deepEqual(canceled.operations, []); assert.deepEqual(canceled.historicalOperations, operations); assert.deepEqual(canceled.trial, tried.trial);
    assert.deepEqual(fresh.snapshot.document, original);
    await s.ok(fresh, '/api/adult', { enabled: true });
    const denied = await s.ok(fresh, '/api/candidate/confirm', { candidateId: proposal.candidateId, commandId: randomUUID() });
    const receipt = denied.result as { ok: boolean; code: string }; assert.equal(receipt.ok, false); assert.equal(receipt.code, 'E_AUTH_EPOCH');
    assert.ok(denied.snapshot); assert.deepEqual(denied.snapshot.document, original); assert.equal(candidate(denied.snapshot).canConfirm, false);
    assert.equal((await s.post(fresh, '/api/candidate/trial', { candidateId: proposal.candidateId })).error, 'E_AUTH_EPOCH');
    assert.deepEqual(candidate(s.snapshot()).operations, []); assert.deepEqual(candidate(s.snapshot()).historicalOperations, operations); assert.deepEqual(candidate(s.snapshot()).trial, tried.trial);
    privateFree(s.snapshot());
  } finally { await s.close(); }
});


// Advance inside the actual HTTP request event, immediately before the router.
// This pins request-triggered expiry ahead of the independent 50 ms timer.
test('R0 session HTTP: an authenticated heartbeat that first detects expiry returns the completed revocation snapshot', async () => {
  const s = await setup();
  try {
    const original = structuredClone(s.first.snapshot.document);
    const operations: Operation[] = [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }];
    const events = await s.stream(s.first);
    await s.ok(s.first, '/api/adult', { enabled: true });
    const prepared = await s.ok(s.first, '/api/candidate/prepare', { requestId: randomUUID(), operations }); assert.ok(prepared.snapshot);
    const candidateId = candidate(prepared.snapshot).candidateId;
    const trial = await s.ok(s.first, '/api/candidate/trial', { candidateId }); assert.ok(trial.snapshot);
    const proposed = candidate(trial.snapshot); assert.equal(proposed.state, 'proposed'); assert.equal(proposed.trialStatus, 'passed'); assert.equal(proposed.canConfirm, true);
    s.app.server.prependOnceListener('request', () => { s.advance(600000); });
    const response = await fetch(s.url + '/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: s.url,
      'X-Nodon-Connection': s.first.connectionId, 'X-Nodon-CSRF': s.first.csrfToken }, body: '{}' });
    const rejected = await response.json() as Reply;
    assert.equal(response.status, 400); assert.equal(rejected.ok, false); assert.equal(rejected.error, 'E_LEASE_EXPIRED');
    // The error response must independently carry the terminal state: the UI
    // may abort its event stream as soon as it receives this HTTP failure.
    assert.ok(rejected.snapshot, 'expiry error needs a completed revocation snapshot');
    assert.equal(connection(rejected.snapshot).connected, false); assert.equal(connection(rejected.snapshot).revocationReason, 'session_expired');
    assert.equal(connection(rejected.snapshot).leaseRemainingMs, 0); assert.equal(rejected.snapshot.authority.adultEnabled, false);
    const canceled = candidate(rejected.snapshot); assert.equal(canceled.state, 'canceled'); assert.equal(canceled.canConfirm, false); assert.equal(canceled.canTrial, false);
    assert.deepEqual(canceled.operations, []); assert.deepEqual(canceled.historicalOperations, operations); assert.deepEqual(canceled.trial, proposed.trial);
    assert.deepEqual(rejected.snapshot.document, original); privateFree(rejected.snapshot);
    await s.waitFor(() => events.ended()); await events.drained;
  } finally { await s.close(); }
});

test('R0 session HTTP: expired requests with invalid CSRF, origin or connection cannot receive a recovery snapshot', async () => {
  for (const invalid of ['csrf', 'origin', 'connection'] as const) {
    const s = await setup();
    try {
      s.app.server.prependOnceListener('request', () => { s.advance(600000); });
      const response = await fetch(s.url + '/api/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json',
        Origin: invalid === 'origin' ? 'http://attacker.invalid' : s.url,
        'X-Nodon-Connection': invalid === 'connection' ? randomUUID() : s.first.connectionId,
        'X-Nodon-CSRF': invalid === 'csrf' ? 'wrong-csrf' : s.first.csrfToken }, body: '{}' });
      const denied = await response.json() as Reply; assert.equal(denied.ok, false, invalid);
      assert.ok(denied.error, invalid); assert.equal(Object.hasOwn(denied, 'snapshot'), false, invalid + ' must not expose snapshot');
    } finally { await s.close(); }
  }
});
