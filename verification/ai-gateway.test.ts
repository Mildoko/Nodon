import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import {
  AiAuthority, AiError, AiGateway, AiLedger, ATTEMPT_AMOUNT_CAP_NANO_CNY,
  ENDPOINT, INPUT_TOKEN_CAP, MODEL, OUTPUT_TOKEN_CAP, RESERVATION_NANO_CNY,
  TOTAL_AMOUNT_CAP_NANO_CNY, TOTAL_TOKEN_CAP, buildBody, parseModelResponse,
  type DeepSeekAccess, type FrozenRequestManifest, type SubmitRequest,
} from '../src/ai/index.js';
import { assertDocument, canonicalJson, type Document } from '../src/domain/index.js';
import { CommandQueue } from '../src/host/command-queue.js';
import { ProjectStore } from '../src/host/project-store.js';

// Independent GPT6.1SolHigh verification. source=automation_test/fault_injection.
// Every fetch is a Node mock using a fake credential; no env/key file is read.
// These synthetic responses are never provider/semantic/human evidence and consume
// zero of the 38 real logical slots. Only private per-test SQLite files are opened.
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'verification/model-request-manifest.json'), 'utf8')) as FrozenRequestManifest;
const configured = JSON.parse(readFileSync(join(process.cwd(), 'config/deepseek-access.json'), 'utf8')) as DeepSeekAccess;
const FAKE_CREDENTIAL = 'offline-fixture-credential-NOT-A-REAL-KEY';
const SESSION = 'offline-test-session';
const WRITER = 'offline-test-writer';
const GOOD = { kind: 'propose', summary: '建议降低目标', operations: [{ op: 'set_goal', expectedValue: 10, value: 6 }] };
const USAGE = { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 25 };
let requestSequence = 0;

function fixture(): Document {
  return assertDocument(JSON.parse(readFileSync(join(process.cwd(), 'verification/fixtures/scene-a.json'), 'utf8')) as unknown);
}
function request(slot = 'PROBE-ACCESS', document = fixture()): SubmitRequest {
  const requestId = `d6000000-0000-4000-8000-${(++requestSequence).toString(16).padStart(12, '0')}`;
  return { requestSlotID: slot, requestId, idempotencyKey: `offline-${requestId}`, document,
    snapshot: { projectId: document.project.projectId, requestId, baseRevision: document.project.revision,
      baseSemanticHash: document.project.semanticHash, runtimeVersion: document.runtimeVersion,
      catalogVersion: document.catalogVersion, ruleRegistryVersion: 'collect-chase-rules@1',
      trialPolicyVersion: 'collect-chase-candidate-trial@2', capabilityVersion: 'nodon-r0-capabilities@1',
      authEpoch: 0, sessionId: SESSION, writerToken: WRITER, requestText: '把目标10改为6，其他不动。', selectedEvidenceRefs: [] } };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function reply(content = JSON.stringify(GOOD), usage: unknown = USAGE, finishReason = 'stop'): Response {
  return new Response(JSON.stringify({ id: 'offline-provider-receipt', model: MODEL,
    choices: [{ message: { content }, finish_reason: finishReason }], ...(usage === undefined ? {} : { usage }) }),
  { headers: { 'Content-Type': 'application/json' } });
}
function access(overrides: Partial<DeepSeekAccess> = {}): DeepSeekAccess {
  return { ...configured, modelApproved: true, budgetApproved: true, availabilityApproved: true,
    outboundScopeApproved: true, credentialsConfigured: true, ...overrides };
}
function rejectsCode(promise: Promise<unknown>, code: string): Promise<void> {
  return assert.rejects(promise, (error: unknown): boolean => { assert.ok(error instanceof AiError); assert.equal(error.code, code); return true; });
}
function setup(t: TestContext, options: { access?: Partial<DeepSeekAccess>; credential?: () => Promise<string | null>; deadline?: number } = {}) {
  // A forgotten fixture is a hard failure, never a fallback to native fetch.
  const fetchMock = t.mock.method(globalThis, 'fetch', (() => { throw new Error('REAL_NETWORK_FORBIDDEN_BY_OFFLINE_TEST'); }) as typeof fetch);
  const directory = mkdtempSync(join(tmpdir(), 'nodon-ai-offline-'));
  const path = join(directory, 'isolated.sqlite');
  const queue = new CommandQueue();
  const authority = new AiAuthority(queue, { authEpoch: 0, adultEnabled: true, sessionId: SESSION,
    writerToken: WRITER, projectId: fixture().project.projectId, scopeEnabled: true });
  const ledger = new AiLedger(queue, path, manifest);
  const gateway = new AiGateway(authority, ledger, access(options.access), options.credential ?? (async () => FAKE_CREDENTIAL), options.deadline ?? 1000);
  t.after(async () => { await gateway.shutdown(); ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  return { queue, authority, ledger, gateway, fetchMock, path };
}

test('automation_test: approved single dispatch uses exact transport and returns suggestion without Store mutation', async t => {
  const h = setup(t); const store = new ProjectStore(fixture(), { sessionId: SESSION, writerToken: WRITER });
  const before = store.snapshot(); const input = request('PROBE-ACCESS', store.snapshot()); const inputBefore = structuredClone(input);
  h.fetchMock.mock.mockImplementation(async (url, init) => {
    assert.equal(url, ENDPOINT); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${FAKE_CREDENTIAL}`);
    assert.ok(init?.signal instanceof AbortSignal);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body['model'], MODEL); assert.equal(body['stream'], false); assert.equal(body['max_tokens'], OUTPUT_TOKEN_CAP);
    assert.deepEqual(body['response_format'], { type: 'json_object' }); assert.deepEqual(body['thinking'], { type: 'disabled' });
    for (const privateValue of [SESSION, WRITER, FAKE_CREDENTIAL, before.project.title, before.project.instructions]) {
      if (privateValue) assert.equal(String(init?.body).includes(privateValue), false);
    }
    return reply();
  });
  const result = await h.gateway.submit(input); assert.equal(result.status, 'answered');
  if (result.status !== 'answered') assert.fail('expected validated suggestion');
  assert.deepEqual(result.response, GOOD); assert.equal(result.attempt.state, 'accounted');
  assert.equal(result.attempt.costStatus, 'usage_calculated_pending_bill');
  assert.equal(result.attempt.usageCalculatedNanoCNY, 75 * 2000 + 25 * 40 + 20 * 8000);
  assert.equal(result.attempt.reservationNanoCNY, RESERVATION_NANO_CNY);
  assert.deepEqual(store.snapshot(), before); assert.deepEqual(input, inputBefore); assert.equal(h.fetchMock.mock.callCount(), 1);
});

test('fault_injection: FIFO revoke before dispatch sends zero; dispatch before revoke keeps unknown reservation', async t => {
  {
    const h = setup(t); const input = request();
    const revoked = h.authority.setAdult(false); const submitted = h.gateway.submit(input);
    await revoked; await rejectsCode(submitted, 'E_ADULT_DISABLED');
    assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.budget().attempts, 0);
  }
  // Separate fixture/mocked fetch so ordering is observable at actual invocation.
  {
    const h = setup(t); const started = deferred<void>(); const pending = deferred<Response>();
    h.fetchMock.mock.mockImplementation((_url, init) => { started.resolve(); init?.signal?.addEventListener('abort', () => pending.reject(new Error('offline abort')), { once: true }); return pending.promise; });
    const submitted = h.gateway.submit(request()); await started.promise; await h.authority.setAdult(false);
    const result = await submitted; assert.equal(result.status, 'canceled');
    assert.equal(h.fetchMock.mock.callCount(), 1); assert.equal(h.ledger.attempts()[0]?.state, 'unknown');
    assert.equal(h.ledger.budget().reservedNanoCNY, RESERVATION_NANO_CNY); assert.equal(h.ledger.budget().inFlight, 1);
  }
});

test('fault_injection: asynchronous credential completion rechecks adult, epoch, writer and scope', async t => {
  for (const change of ['adult', 'epoch', 'writer', 'scope'] as const) {
    await t.test(change, async t => {
      const credential = deferred<string | null>(); const preparing = deferred<void>();
      const h = setup(t, { credential: () => { preparing.resolve(); return credential.promise; } });
      const submitted = h.gateway.submit(request()); await preparing.promise;
      if (change === 'adult') await h.authority.setAdult(false);
      if (change === 'epoch') await h.authority.setAdult(true);
      if (change === 'writer') await h.authority.replaceWriter('different-session', 'different-writer', fixture().project.projectId);
      if (change === 'scope') await h.authority.setScope(false);
      credential.resolve(FAKE_CREDENTIAL);
      await rejectsCode(submitted, change === 'adult' ? 'E_ADULT_DISABLED' : change === 'scope' ? 'E_SCOPE' : 'E_AUTH_EPOCH');
      assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.budget().attempts, 0);
    });
  }
});

test('automation_test: only ACCESS bootstraps availability; every other approval still gates ACCESS', async t => {
  const h = setup(t, { access: { availabilityApproved: false } }); h.fetchMock.mock.mockImplementation(async () => reply());
  await rejectsCode(h.gateway.submit(request('R0-AI-01-R1-I')), 'E_AI_NOT_APPROVED');
  assert.equal((await h.gateway.submit(request())).status, 'answered'); assert.equal(h.fetchMock.mock.callCount(), 1);
  for (const flag of ['modelApproved', 'budgetApproved', 'credentialsConfigured', 'outboundScopeApproved'] as const) {
    await t.test(flag, async t => {
      const blocked = setup(t, { access: { [flag]: false, availabilityApproved: false } });
      await rejectsCode(blocked.gateway.submit(request()), 'E_AI_NOT_APPROVED');
      assert.equal(blocked.fetchMock.mock.callCount(), 0); assert.equal(blocked.ledger.budget().attempts, 0);
    });
  }
});

test('fault_injection: simultaneous and completed identical submissions do not send twice; payload/key/slot conflicts reject', async t => {
  const h = setup(t); const started = deferred<void>(); const pending = deferred<Response>();
  h.fetchMock.mock.mockImplementation(() => { started.resolve(); return pending.promise; });
  const input = request(); const submitted = h.gateway.submit(input); await started.promise;
  const duplicate = await h.gateway.submit(structuredClone(input)); assert.equal(duplicate.status, 'duplicate');
  const changed = structuredClone(input); changed.snapshot.requestText = '改为8分';
  await rejectsCode(h.gateway.submit(changed), 'E_IDEMPOTENCY_CONFLICT');
  const keyConflict = request('R0-AI-01-R1-I'); keyConflict.idempotencyKey = input.idempotencyKey;
  await rejectsCode(h.gateway.submit(keyConflict), 'E_IDEMPOTENCY_CONFLICT');
  await rejectsCode(h.gateway.submit(request()), 'E_IDEMPOTENCY_CONFLICT');
  pending.resolve(reply()); const original = await submitted;
  assert.deepEqual(await h.gateway.submit(structuredClone(input)), original);
  assert.equal(h.fetchMock.mock.callCount(), 1); assert.equal(h.ledger.budget().attempts, 1);
});

test('fault_injection: global concurrency is one and unknown transport blocks later slots without implicit retry', async t => {
  const h = setup(t); const started = deferred<void>(); const pending = deferred<Response>();
  h.fetchMock.mock.mockImplementation(() => { started.resolve(); return pending.promise; });
  const submitted = h.gateway.submit(request()); await started.promise;
  await rejectsCode(h.gateway.submit(request('R0-AI-01-R1-I')), 'E_IN_FLIGHT_UNKNOWN');
  assert.equal(h.fetchMock.mock.callCount(), 1); pending.reject(new Error('offline network uncertainty'));
  assert.equal((await submitted).status, 'unknown');
  await rejectsCode(h.gateway.submit(request('R0-AI-02-R1-I')), 'E_IN_FLIGHT_UNKNOWN');
  assert.equal(h.fetchMock.mock.callCount(), 1); assert.equal(h.ledger.budget().inFlight, 1);
});

test('automation_test: exact frozen 38 logical / 76 attempt caps with one explicit repair per slot and integer peak money', async t => {
  const h = setup(t); h.fetchMock.mock.mockImplementation(async () => reply('{'));
  assert.equal(manifest.slots.length, 38); assert.equal(RESERVATION_NANO_CNY, INPUT_TOKEN_CAP * 2000 + OUTPUT_TOKEN_CAP * 8000);
  assert.ok(RESERVATION_NANO_CNY <= ATTEMPT_AMOUNT_CAP_NANO_CNY);
  for (const slot of manifest.slots) {
    const input = request(slot.requestSlotID); const first = await h.gateway.submit(input); assert.equal(first.status, 'failed');
    const firstAttempt = h.ledger.attempts(input.requestId)[0]; assert.ok(firstAttempt);
    assert.equal(firstAttempt.outcome, 'invalid_response'); assert.equal(firstAttempt.ordinal, 1);
    assert.equal(firstAttempt.attemptId, `${slot.requestSlotID}-A1`);
    const second = await h.gateway.submit({ ...input, repairOfAttemptId: firstAttempt.attemptId }); assert.equal(second.status, 'failed');
    const attempts = h.ledger.attempts(input.requestId); assert.equal(attempts.length, 2); assert.equal(attempts[1]?.attemptId, `${slot.requestSlotID}-A2`);
    await h.gateway.submit({ ...input, repairOfAttemptId: attempts[1]!.attemptId }); assert.equal(h.ledger.attempts(input.requestId).length, 2);
  }
  assert.equal(h.fetchMock.mock.callCount(), 76);
  assert.deepEqual(h.ledger.budget(), { attempts: 76, reservedNanoCNY: 4_314_368_000, reservedTokens: TOTAL_TOKEN_CAP, inFlight: 0, billingStatus: 'pending_bill_verification' });
  assert.ok(Number.isSafeInteger(h.ledger.budget().reservedNanoCNY)); assert.ok(h.ledger.budget().reservedNanoCNY <= TOTAL_AMOUNT_CAP_NANO_CNY);
  await rejectsCode(h.gateway.submit(request('UNFROZEN-39TH-SLOT')), 'E_REQUEST_SLOT');
  const db = new DatabaseSync(h.path, { readOnly: true });
  try { assert.equal((db.prepare('SELECT COUNT(*) AS count FROM ai_logical').get() as { count: number }).count, 38); } finally { db.close(); }
  assert.equal(h.fetchMock.mock.callCount(), 76);
});

test('fault_injection: a successful first response and an unknown first response cannot be repaired', async t => {
  const h = setup(t); h.fetchMock.mock.mockImplementation(async () => reply()); const input = request();
  await h.gateway.submit(input);
  await rejectsCode(h.gateway.submit({ ...input, repairOfAttemptId: 'PROBE-ACCESS-A1' }), 'E_REPAIR_NOT_ELIGIBLE');
  assert.equal(h.fetchMock.mock.callCount(), 1);
  const next = request('R0-AI-01-R1-I'); h.fetchMock.mock.mockImplementation(async () => reply(JSON.stringify(GOOD), null));
  assert.equal((await h.gateway.submit(next)).status, 'unknown');
  await rejectsCode(h.gateway.submit({ ...next, repairOfAttemptId: 'R0-AI-01-R1-I-A1' }), 'E_IN_FLIGHT_UNKNOWN');
  assert.equal(h.fetchMock.mock.callCount(), 2);
});

test('fault_injection: SQLite reopen retains logical conflicts, unknown dispatch, count and full reservation', async t => {
  t.mock.method(globalThis, 'fetch', (() => { throw new Error('REAL_NETWORK_FORBIDDEN_BY_OFFLINE_TEST'); }) as typeof fetch);
  const directory = mkdtempSync(join(tmpdir(), 'nodon-ai-reopen-')); const path = join(directory, 'isolated.sqlite');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const queue = new CommandQueue(); let ledger = new AiLedger(queue, path, manifest);
  await queue.enqueue(sequence => { ledger.register('PROBE-ACCESS', 'offline-logical', 'offline-key', 'offline-hash');
    ledger.reserve('offline-logical', 0, sequence); ledger.markDispatch('PROBE-ACCESS-A1'); ledger.unknown('PROBE-ACCESS-A1', 'transport_unknown'); });
  const before = ledger.budget(); ledger.close(); ledger = new AiLedger(queue, path, manifest);
  try {
    assert.deepEqual(ledger.budget(), before); assert.equal(ledger.attempts()[0]?.state, 'unknown');
    assert.equal(ledger.budget().reservedNanoCNY, RESERVATION_NANO_CNY); assert.equal(ledger.budget().reservedTokens, INPUT_TOKEN_CAP + OUTPUT_TOKEN_CAP);
    assert.equal(await queue.enqueue(() => ledger.register('PROBE-ACCESS', 'offline-logical', 'offline-key', 'offline-hash')), false);
    await rejectsCode(queue.enqueue(() => ledger.register('PROBE-ACCESS', 'offline-logical', 'offline-key', 'changed-hash')), 'E_IDEMPOTENCY_CONFLICT');
    await rejectsCode(queue.enqueue(sequence => { ledger.register('R0-AI-01-R1-I', 'offline-next', 'offline-next-key', 'next-hash'); return ledger.reserve('offline-next', 0, sequence); }), 'E_IN_FLIGHT_UNKNOWN');
    assert.equal(ledger.budget().attempts, 1);
  } finally { ledger.close(); }
});

test('fault_injection: cancel and timeout retain reservation; a late valid response accounts usage without reviving eligibility', async t => {
  for (const reason of ['cancel', 'timeout'] as const) {
    await t.test(reason, async t => {
      const h = setup(t, { deadline: reason === 'timeout' ? 10 : 1000 });
      const started = deferred<void>(); const aborted = deferred<void>(); const late = deferred<Response>();
      h.fetchMock.mock.mockImplementation((_url, init) => {
        started.resolve(); init?.signal?.addEventListener('abort', () => aborted.resolve(), { once: true }); return late.promise;
      });
      const input = request(); const submitted = h.gateway.submit(input); await started.promise;
      // Keep the event loop alive while the product's intentionally unref'ed deadline fires.
      const watchdog = setTimeout(() => aborted.reject(new Error('timeout did not abort')), 1000);
      try { if (reason === 'cancel') await h.gateway.cancel(input.requestId); await aborted.promise; } finally { clearTimeout(watchdog); }
      assert.equal(h.ledger.attempts()[0]?.state, 'unknown'); assert.equal(h.ledger.budget().inFlight, 1);
      assert.equal(h.ledger.budget().reservedNanoCNY, RESERVATION_NANO_CNY);
      late.resolve(reply()); const result = await submitted; assert.equal(result.status, 'canceled');
      if (result.status !== 'canceled') assert.fail('late output cannot become a suggestion');
      assert.equal(result.code, reason === 'timeout' ? 'E_TIMEOUT' : 'E_REQUEST_CANCELED'); assert.equal(result.attempt?.state, 'accounted');
      assert.equal(h.ledger.budget().reservedNanoCNY, RESERVATION_NANO_CNY);
      await rejectsCode(h.gateway.submit(input), 'E_REQUEST_CANCELED'); assert.equal(h.fetchMock.mock.callCount(), 1);
    });
  }
});

test('fault_injection: bounded usage must be safe integers; missing/over-cap usage never refunds unknown', async t => {
  for (const usage of [null, {}, { ...USAGE, prompt_tokens: 12001 }, { ...USAGE, completion_tokens: 4097 },
    { ...USAGE, prompt_tokens: 1.5 }, { ...USAGE, prompt_cache_hit_tokens: 101 }, { ...USAGE, completion_tokens: -1 }]) {
    await t.test(JSON.stringify(usage), async t => {
      const h = setup(t); h.fetchMock.mock.mockImplementation(async () => reply(JSON.stringify(GOOD), usage));
      const result = await h.gateway.submit(request()); assert.equal(result.status, 'unknown');
      assert.equal(h.ledger.attempts()[0]?.state, 'unknown'); assert.equal(h.ledger.attempts()[0]?.usageCalculatedNanoCNY, null);
      assert.equal(h.ledger.budget().reservedNanoCNY, RESERVATION_NANO_CNY); assert.equal(h.fetchMock.mock.callCount(), 1);
    });
  }
});

test('automation_test: exact input/output token maxima account at peak rate and retain the full reservation', async t => {
  const h = setup(t); h.fetchMock.mock.mockImplementation(async () => reply(JSON.stringify(GOOD), {
    prompt_tokens: INPUT_TOKEN_CAP, completion_tokens: OUTPUT_TOKEN_CAP, prompt_cache_hit_tokens: 0,
  }));
  const result = await h.gateway.submit(request()); assert.equal(result.status, 'answered');
  const attempt = h.ledger.attempts()[0]; assert.ok(attempt);
  assert.equal(attempt.usageCalculatedNanoCNY, RESERVATION_NANO_CNY);
  assert.equal(h.ledger.budget().reservedNanoCNY, RESERVATION_NANO_CNY);
  assert.equal(h.ledger.budget().billingStatus, 'pending_bill_verification');
});

test('fault_injection: failed HTTP, malformed envelope and synchronous invocation failure stay unknown without retry', async t => {
  for (const mode of ['http', 'envelope', 'synchronous'] as const) {
    await t.test(mode, async t => {
      const h = setup(t);
      h.fetchMock.mock.mockImplementation(() => {
        if (mode === 'synchronous') throw new Error('offline synchronous invocation failure');
        return Promise.resolve(mode === 'http' ? new Response('offline error', { status: 503 }) : new Response('{'));
      });
      if (mode === 'synchronous') await rejectsCode(h.gateway.submit(request()), 'E_DISPATCH_UNKNOWN');
      else assert.equal((await h.gateway.submit(request())).status, 'unknown');
      assert.equal(h.fetchMock.mock.callCount(), 1); assert.equal(h.ledger.budget().attempts, 1);
      assert.equal(h.ledger.budget().inFlight, 1); assert.equal(h.ledger.budget().reservedNanoCNY, RESERVATION_NANO_CNY);
      assert.equal(h.ledger.attempts()[0]?.state, 'unknown');
    });
  }
});

test('fault_injection: missing or throwing credential preparation consumes no attempt and permits stable resubmission', async t => {
  let prepared = 0;
  const h = setup(t, { credential: async () => { prepared++; if (prepared === 1) return null; if (prepared === 2) throw new Error('offline credential error'); return FAKE_CREDENTIAL; } });
  const input = request();
  await rejectsCode(h.gateway.submit(input), 'E_CREDENTIAL_UNAVAILABLE');
  await rejectsCode(h.gateway.submit(input), 'E_CREDENTIAL_UNAVAILABLE');
  assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.budget().attempts, 0);
  h.fetchMock.mock.mockImplementation(async () => reply());
  assert.equal((await h.gateway.submit(input)).status, 'answered'); assert.equal(h.fetchMock.mock.callCount(), 1);
});

test('fault_injection: strict output rejects extra fields, illegal ops, read-only writes, empty, truncated and invented references', async t => {
  const outputs: Array<[string, string]> = [
    [JSON.stringify({ ...GOOD, extra: true }), 'stop'],
    [JSON.stringify({ kind: 'propose', summary: '非法', operations: [{ op: 'delete_entity', entityId: 'p' }] }), 'stop'],
    [JSON.stringify({ kind: 'locate', summary: '位置', reasonCode: 'manual_quantity', entityIds: [], ruleIds: [], operations: GOOD.operations }), 'stop'],
    [JSON.stringify({ kind: 'locate', summary: '位置', reasonCode: 'entity', entityIds: ['nonexistent'], ruleIds: [] }), 'stop'],
    [JSON.stringify({ kind: 'explain', summary: '解释', facts: [{ text: '虚构', eventIds: ['invented'] }], rules: [], hypotheses: [], options: [] }), 'stop'],
    ['', 'stop'], ['{"kind":', 'stop'], [JSON.stringify(GOOD), 'length'],
    ['{"kind":"clarify","question":"one","question":"two"}', 'stop'],
    [JSON.stringify({ kind: 'clarify', question: '<script>bad</script>' }), 'stop'],
  ];
  for (const [raw, finish] of outputs) {
    await t.test(`${finish}:${raw.slice(0, 55)}`, async t => {
      const h = setup(t); const input = request(); const before = canonicalJson(input.document);
      h.fetchMock.mock.mockImplementation(async () => reply(raw, USAGE, finish));
      const result = await h.gateway.submit(input); assert.equal(result.status, 'failed');
      assert.equal(h.ledger.attempts()[0]?.outcome, 'invalid_response'); assert.equal(h.ledger.attempts()[0]?.rawOutput, raw);
      assert.equal(canonicalJson(input.document), before); assert.equal(h.fetchMock.mock.callCount(), 1);
    });
  }
});

test('automation_test: all response kinds are suggestions, strict schema input/privacy caps reject before dispatch', async t => {
  const h = setup(t); const input = request();
  const responses = [GOOD, { kind: 'directions', summary: '比较', options: [{ id: 'a', label: '路线', rationale: '布局' }, { id: 'b', label: '节奏', rationale: '速度' }] },
    { kind: 'locate', summary: '手动改数量', reasonCode: 'manual_quantity', entityIds: ['p'], ruleIds: [] },
    { kind: 'explain', summary: '当前规则', facts: [], rules: [{ text: '接触失败', ruleIds: ['rule.contact.fail@1'] }], hypotheses: [], options: [] },
    { kind: 'clarify', question: '希望更快还是更慢？' }, { kind: 'unsupported', reason: '机制不支持' }];
  const before = structuredClone(input.document);
  for (const output of responses) assert.deepEqual(parseModelResponse(JSON.stringify(output), input), output);
  assert.deepEqual(input.document, before);
  const long = structuredClone(input); long.snapshot.requestText = 'x'.repeat(301);
  await rejectsCode(h.gateway.submit(long), 'E_TEXT_LENGTH');
  const stale = structuredClone(input); stale.snapshot.baseRevision++;
  await rejectsCode(h.gateway.submit(stale), 'E_REQUEST_BASE');
  await assert.rejects(h.gateway.submit({ ...input, unexpected: true }));
  const evidence = structuredClone(input); evidence.snapshot.selectedEvidenceRefs = ['not-approved'];
  await assert.rejects(h.gateway.submit(evidence));
  // Explicit builder byte-limit test, independent of current legal document maximum.
  const oversized = structuredClone(input); oversized.snapshot.requestText = 'x'.repeat(INPUT_TOKEN_CAP);
  assert.throws(() => buildBody(oversized), (error: unknown) => error instanceof AiError && error.code === 'E_INPUT_TOKEN_CAP');
  assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.budget().attempts, 0);
});

test('fault_injection: shared queue identity and synchronous jobs are mandatory', async t => {
  const h = setup(t); const otherQueue = new CommandQueue();
  const directory = mkdtempSync(join(tmpdir(), 'nodon-ai-other-')); const otherLedger = new AiLedger(otherQueue, join(directory, 'isolated.sqlite'), manifest);
  try { assert.throws(() => new AiGateway(h.authority, otherLedger, access(), async () => FAKE_CREDENTIAL), (error: unknown) => error instanceof AiError && error.code === 'E_QUEUE_IDENTITY'); }
  finally { otherLedger.close(); rmSync(directory, { recursive: true, force: true }); }
  assert.throws(() => h.ledger.reserve('not-registered', 0, 0), /E_QUEUE_REQUIRED/u);
  await assert.rejects(h.queue.enqueue(() => Promise.resolve('not allowed')), /E_ASYNC_QUEUE_JOB/u);
});

test('fault_injection: shutdown is terminal; a new slot cannot dispatch or reserve through the retired gateway', async t => {
  const h = setup(t); await h.gateway.shutdown(); await h.gateway.shutdown();
  await rejectsCode(h.gateway.submit(request('R0-AI-01-R1-I')), 'E_GATEWAY_CLOSED');
  assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.budget().attempts, 0);
  assert.equal(h.ledger.budget().reservedNanoCNY, 0);
});

test('fault_injection: shutdown during asynchronous credential preparation prevents later dispatch', async t => {
  const preparing = deferred<void>(); const credential = deferred<string | null>();
  const h = setup(t, { credential: () => { preparing.resolve(); return credential.promise; } });
  const submitted = h.gateway.submit(request()); await preparing.promise; await h.gateway.shutdown();
  credential.resolve(FAKE_CREDENTIAL); await rejectsCode(submitted, 'E_GATEWAY_CLOSED');
  assert.equal(h.fetchMock.mock.callCount(), 0); assert.equal(h.ledger.budget().attempts, 0);
});

test('fault_injection: shutdown persists unknown before SQLite close; late success/failure cannot access closed DB or revive', async t => {
  for (const lateKind of ['success', 'failure'] as const) {
    await t.test(lateKind, async t => {
      const fetchMock = t.mock.method(globalThis, 'fetch', (() => { throw new Error('REAL_NETWORK_FORBIDDEN_BY_OFFLINE_TEST'); }) as typeof fetch);
      const directory = mkdtempSync(join(tmpdir(), 'nodon-ai-shutdown-')); const path = join(directory, 'isolated.sqlite');
      t.after(() => rmSync(directory, { recursive: true, force: true }));
      const queue = new CommandQueue(); const document = fixture();
      const authority = new AiAuthority(queue, { authEpoch: 0, adultEnabled: true, sessionId: SESSION,
        writerToken: WRITER, projectId: document.project.projectId, scopeEnabled: true });
      const ledger = new AiLedger(queue, path, manifest);
      const gateway = new AiGateway(authority, ledger, access(), async () => FAKE_CREDENTIAL, 20);
      const started = deferred<void>(); const late = deferred<Response>();
      // Ignore abort deliberately: a provider completion may already be queued.
      fetchMock.mock.mockImplementation(() => { started.resolve(); return late.promise; });
      const submitted = gateway.submit(request('PROBE-ACCESS', document)); await started.promise;
      await gateway.shutdown(); ledger.close();
      // Reopen only this test's ledger. The shutdown reservation must already be durable.
      const reopened = new AiLedger(queue, path, manifest);
      try {
        assert.equal(reopened.attempts()[0]?.state, 'unknown'); assert.equal(reopened.attempts()[0]?.outcome, 'canceled');
        assert.equal(reopened.budget().attempts, 1); assert.equal(reopened.budget().inFlight, 1);
        assert.equal(reopened.budget().reservedNanoCNY, RESERVATION_NANO_CNY);
        assert.equal(reopened.budget().reservedTokens, INPUT_TOKEN_CAP + OUTPUT_TOKEN_CAP);
        const before = canonicalJson(reopened.attempts());
        if (lateKind === 'success') late.resolve(reply()); else late.reject(new Error('offline completion after close'));
        const result = await submitted; assert.equal(result.status, 'canceled');
        if (result.status !== 'canceled') assert.fail('shutdown completion must remain canceled');
        assert.equal(result.code, 'E_GATEWAY_CLOSED'); assert.equal(result.attempt?.state, 'unknown');
        assert.equal(canonicalJson(reopened.attempts()), before, 'Retired callbacks must not mutate or reconcile the persistent ledger');
        await gateway.shutdown(); // Repeated shutdown after DB close must also be harmless.
        await new Promise<void>(resolve => setTimeout(resolve, 40)); // The old deadline must not touch the closed DB.
        assert.equal(canonicalJson(reopened.attempts()), before); assert.equal(fetchMock.mock.callCount(), 1);
      } finally { reopened.close(); }
    });
  }
});
