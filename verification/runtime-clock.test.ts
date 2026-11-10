import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseDocument } from '../src/domain/index.js';
import { R0Host } from '../src/host/r0-host.js';
import { RuntimeClock } from '../src/host/runtime-clock.js';
import type { BuildIdentity } from '../tools/build-manifest.js';

// Synthetic identity + injected time are clock unit probes, never browser or build evidence.
const build: BuildIdentity = { buildId: 'synthetic-t04-clock', buildHash: 'sha256:' + 'a'.repeat(64),
  runtimeArtifactHash: 'sha256:' + 'b'.repeat(64), environmentId: 'synthetic-t04-clock-unit', manifest: {},
  runtimeArtifactManifest: { coreModuleFiles: [], runtimeDependencyPackages: [], runtimeDependencyFiles: [] }, productionPackagePaths: [] };
async function setup() {
  let time = 0, allowed = true;
  const host = new R0Host(parseDocument(readFileSync(resolve(process.cwd(), 'verification/fixtures/zero-guard-route.json'), 'utf8')),
    { sessionId: 'unit-session', writerToken: 'unit-private-writer', buildIdentity: build });
  const run = await host.startRun({ inputSource: 'machine_browser_input', executionClass: 'automation_test' });
  const clock = new RuntimeClock(host, () => time, () => allowed);
  clock.setConnection('unit-connection'); clock.activate();
  return { host, run, clock, advance: (ms: number) => { time += ms; }, disallow: () => { allowed = false; },
    input: (sequence: number, x: -1 | 0 | 1 = 1, y: -1 | 0 | 1 = 0) => clock.receive({ connectionId: 'unit-connection', sequence,
      runId: run.context.runId, generation: run.context.generation, direction: { x, y }, clientSentAt: 1000 + time }) };
}

test('T04 clock: browser receipt alone never steps; Node applies latest held direction at an actual tick', async () => {
  const s = await setup();
  s.input(1, 1, 0); s.input(2, 0, 1);
  assert.equal(s.host.currentRun()?.tick, 0);
  s.advance(17); await s.clock.pump();
  assert.equal(s.host.currentRun()?.tick, 1);
  assert.deepEqual(s.host.currentRun()?.inputs[0]?.direction, { x: 0, y: 1 });
  const [first, second] = s.clock.snapshot().inputReceipts;
  assert.equal(first?.receivedTick, 0); assert.equal(first?.effectiveTick, null); assert.equal(first?.superseded, true);
  assert.equal(first?.clientSentAt, 1000); assert.ok(Number.isFinite(first?.receivedAt));
  assert.equal(second?.receivedTick, 0); assert.equal(second?.effectiveTick, 1); assert.equal(second?.appliedAtMonotonicMs, 17);
  assert.equal(s.clock.snapshot().initialState?.tick, 0);
});

test('T04 clock: fixed 1/60 steps cap catch-up at five and discard excess wall backlog', async () => {
  const s = await setup(); s.advance(1001); await s.clock.pump();
  assert.equal(s.host.currentRun()?.tick, 5); assert.equal(s.clock.snapshot().droppedWallTicks, 55);
  await s.clock.pump(); assert.equal(s.host.currentRun()?.tick, 5);
  s.advance(17); await s.clock.pump(); assert.equal(s.host.currentRun()?.tick, 6);
});

test('T04 clock: blur barrier blocks a queued logical step and resume starts with neutral held keys', async () => {
  const s = await setup(); s.input(1); s.advance(17);
  const pending = s.clock.pump(); s.clock.block('blur'); await pending; await s.clock.pause('blur');
  assert.equal(s.host.currentRun()?.tick, 0); assert.equal(s.host.currentRun()?.status, 'paused');
  assert.deepEqual(s.clock.snapshot().direction, { x: 0, y: 0 });
  s.advance(1000); await s.clock.pump(); assert.equal(s.host.currentRun()?.tick, 0);
  await s.host.resume(); s.clock.activate(); s.advance(17); await s.clock.pump();
  assert.equal(s.host.currentRun()?.tick, 1); assert.deepEqual(s.host.currentRun()?.inputs[0]?.direction, { x: 0, y: 0 });
});

test('T04 clock: expired heartbeat loss gate pauses before the next logical step', async () => {
  const s = await setup(); s.input(1); s.disallow(); s.advance(1001); await s.clock.pump();
  assert.equal(s.host.currentRun()?.tick, 0); assert.equal(s.host.currentRun()?.status, 'paused');
  assert.equal(s.clock.snapshot().reason, 'lease_lost');
});

test('T04 clock: rejects stale sequence, run, generation, connection and malformed directions without advancing', async () => {
  const s = await setup(); s.input(2);
  assert.throws(() => s.input(2), /E_INPUT_SEQUENCE/); assert.throws(() => s.input(1), /E_INPUT_SEQUENCE/);
  const base = { connectionId: 'unit-connection', sequence: 3, runId: s.run.context.runId, generation: s.run.context.generation, direction: { x: 0, y: 0 } as const, clientSentAt: 1000 };
  for (const extra of [{ runId: 'old-run' }, { generation: 0 }, { connectionId: 'old-connection' }]) assert.throws(() => s.clock.receive({ ...base, ...extra }));
  assert.throws(() => s.clock.receive({ ...base, direction: { x: 2, y: 0 } as never }), /E_INPUT_DIRECTION/);
  assert.throws(() => s.clock.receive({ ...base, clientSentAt: Number.NaN }), /E_INPUT_TIME/);
  assert.equal(s.host.currentRun()?.tick, 0); assert.equal(s.clock.snapshot().totalInputs, 1);
});
