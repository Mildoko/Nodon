import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// Synthetic browser/transport harness: Node-shaped snapshots exercise presentation
// and capability gates. This is not actual Canvas, Runtime, browser or human evidence.
const source = () => readFileSync(resolve(process.cwd(), 'src/adapters/app.js'), 'utf8');
const pending = <T>() => {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>(resolveValue => { resolvePromise = resolveValue; });
  return { promise, resolve: resolvePromise };
};
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }

function state(tick = 10, status = 'running', receipts: unknown[] = []) {
  const document = { runtimeVersion: 'synthetic@1', project: {
    projectId: 'synthetic-project', revision: 1, semanticHash: 'synthetic-hash', title: 'Synthetic',
    rules: { goal: { targetScore: 6 }, rewards: { normalValue: 1, highValue: 3 }, guards: { speed: 100, detectRadius: 180 }, timer: { enabled: false, limit: 45 } },
    presentation: { themeId: 'theme_snack' }, scene: { entities: [{ id: 'p', kind: 'player', x: 80, y: 270 }] }
  } };
  return { serverInstanceId: 'synthetic-instance', buildId: 'synthetic-observation', buildStatus: 'ready', document,
    run: { context: { runId: 'synthetic-run', generation: 1, inputSource: 'machine_browser_input', executionClass: 'automation_test', evidenceSource: 'machine_test' },
      document, tick, status, score: 0, positions: { p: { x: 80, y: 270 } }, collectedIds: [], events: [] },
    clock: { inputReceipts: receipts, droppedInputReceipts: 0 }, preview: null, candidate: null };
}
type Reply = { ok: boolean; snapshot?: ReturnType<typeof state>; error?: string; result?: unknown };
type Transport = (path: string, body: Record<string, unknown>) => Promise<Reply>;
type Trace = { id: string; text: string };

async function harness(transport?: Transport) {
  const trace: Trace[] = [];
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const elements = new Map<string, FakeElement>();
  const windowListeners = new Map<string, Array<(event: any) => unknown>>();
  const documentListeners = new Map<string, Array<(event: any) => unknown>>();
  const classList = { contains: () => false, toggle: () => {} };
  let document: any;
  class FakeElement {
    value = ''; checked = false; disabled = false; hidden = false; children: unknown[] = [];
    className = ''; type = ''; id: string;
    classList = classList;
    private content = '';
    listeners = new Map<string, Array<(event: any) => unknown>>();
    constructor(id: string) { this.id = id; }
    set textContent(value: string) { this.content = value; trace.push({ id: this.id, text: value }); }
    get textContent() { return this.content; }
    append(...nodes: unknown[]) { this.children.push(...nodes); }
    replaceChildren(...nodes: unknown[]) { this.children = nodes; }
    setAttribute(_name: string, _value: string) {}
    removeAttribute(_name: string) {}
    addEventListener(type: string, callback: (event: any) => unknown) {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
    }
    focus() {
      if (document.activeElement === this) return;
      const previous = document.activeElement;
      document.activeElement = this;
      for (const callback of previous?.listeners.get('blur') ?? []) void callback({});
      for (const callback of this.listeners.get('focus') ?? []) void callback({});
    }
    scrollIntoView() {}
    getContext() { return new Proxy({}, { get: (_target, name) => (..._args: unknown[]) => { if (name === 'clearRect') trace.push({ id: 'canvas-draw', text: 'submitted' }); }, set: () => true }); }
  }
  const element = (id: string) => { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id)!; };
  document = { activeElement: null, hidden: false, body: { classList }, documentElement: { classList },
    getElementById: element, createElement: (tag: string) => new FakeElement(tag), createTextNode: (text: string) => text,
    addEventListener: (type: string, callback: (event: any) => unknown) => documentListeners.set(type, [...(documentListeners.get(type) ?? []), callback]) };
  element('view-source').value = 'run'; element('edit-action').value = 'set_goal'; element('candidate-goal-on').checked = true;
  let streamRead = pending<{ done: boolean; value: Uint8Array }>();
  let localTime = 0;
  let sessionState = state();
  runInNewContext(source(), { document, window: { addEventListener: (type: string, callback: (event: any) => unknown) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), callback]) }, performance: { now: () => ++localTime },
    crypto: { randomUUID: () => 'synthetic-command' }, AbortController, TextDecoder,
    setInterval: () => 1, clearInterval() {},
    fetch: async (path: string, options?: { body?: string }) => {
      if (path === '/api/session') return { ok: true, json: async () => ({ ok: true, connectionId: 'PRIVATE-LEASE', csrfToken: 'PRIVATE-CSRF', snapshot: sessionState }) };
      if (path === '/api/events') return { ok: true, body: { getReader: () => ({ read: () => streamRead.promise }) } };
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      calls.push({ path, body });
      const reply = transport ? await transport(path, body) : { ok: true, snapshot: state() };
      return { ok: reply.ok, json: async () => reply };
    } });
  await settle();
  return { trace, calls, element, setSession: (snapshot: ReturnType<typeof state>) => { sessionState = snapshot; },
    observation: () => JSON.parse(element('r0-observation').textContent),
    click: async (id: string) => { for (const callback of element(id).listeners.get('click') ?? []) await callback({}); },
    key: (key: string, type = 'keydown', detail: Record<string, unknown> = {}) => { for (const callback of documentListeners.get(type) ?? []) callback({ key, ...detail, preventDefault() {} }); },
    pointerCanvas: () => { for (const callback of element('play-canvas').listeners.get('pointerdown') ?? []) callback({}); },
    windowEvent: (type: string) => { for (const callback of windowListeners.get(type) ?? []) callback({}); },
    focusCanvas: () => element('play-canvas').focus(),
    push: async (snapshot: ReturnType<typeof state>) => {
      const previous = streamRead; streamRead = pending();
      previous.resolve({ done: false, value: new TextEncoder().encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`) });
      await settle();
    }
  };
}


const proposal = (status = 'proposed') => ({
  candidateId: 'synthetic-proposal', requestId: 'synthetic-request', state: status,
  source: 'provider_gateway', baseRevision: 1, trialStatus: 'passed',
  canConfirm: status === 'proposed', canTrial: false,
  operations: [{ op: 'set_reward_values', expectedValue: { normalValue: 1, highValue: 3 }, value: { normalValue: 2, highValue: 4 } }],
  trial: { run: state().run, coverage: [] }
});
function presentation(candidate: unknown = proposal(), remaining = 600000, reason: string | null = null) {
  return Object.assign(state(), { authority: { adultEnabled: true, scopeEnabled: true, authEpoch: 1 }, candidate,
    connection: { connected: reason === null, leaseRemainingMs: remaining, leaseDurationMs: 600000, revocationReason: reason, lastRevocationReason: reason },
    realAI: { slotId: 'R0-AI-02-R1-I', status: candidate && (candidate as any).state === 'canceled' ? 'canceled' : 'answered',
      parentOptions: [], budget: {}, response: null } });
}
function visibleTree(node: any): string { return [node.textContent ?? '', ...(node.children ?? []).map((item: any) => typeof item === 'string' ? item : visibleTree(item))].join(' '); }

test('R0 presentation: current rewards and unapplied proposal values remain clearly separate', async () => {
  const h = await harness(); await h.push(presentation());
  assert.match(h.element('candidate-application').textContent, /尚未应用/);
  const shown = visibleTree(h.element('candidate-comparison'));
  assert.match(shown, /当前作品.*普通 1.*高分 3/);
  assert.match(shown, /候选提案.*普通 2.*高分 4/);
  assert.equal(h.element('candidate-confirm').disabled, false);
  assert.equal(h.calls.length, 0);
});

test('R0 presentation: canceled Node history stays readable with no renewed capability or resend guidance', async () => {
  const h = await harness(); await h.push(presentation());
  const canceled = proposal('canceled');
  await h.push(presentation({ ...canceled, operations: [], historicalOperations: canceled.operations }));
  assert.match(h.element('candidate-application').textContent, /已取消.*未应用/);
  assert.match(visibleTree(h.element('candidate-comparison')), /普通 2.*高分 4/);
  assert.equal(h.element('candidate-confirm').disabled, true);
  assert.equal(h.element('candidate-trial').disabled, true);
  assert.equal(h.element('export-candidate').disabled, false);
  assert.doesNotMatch(h.element('candidate-recovery').textContent, /重新构造|修改表单|重发/);
  assert.match(h.element('candidate-recovery').textContent, /冻结槽.*不会自动/);
  assert.equal(h.element('candidate-form').hidden, true);
  assert.equal(h.calls.length, 0);
});

test('R0 presentation: a new Node snapshot never revives cached differences or candidate ability', async () => {
  const h = await harness(); await h.push(presentation());
  await h.push(presentation({ ...proposal('canceled'), operations: [] }));
  assert.doesNotMatch(visibleTree(h.element('candidate-comparison')), /普通 2.*高分 4/);
  assert.match(visibleTree(h.element('candidate-comparison')), /未提供/);
  assert.equal(h.element('candidate-confirm').disabled, true);
});

test('R0 presentation: applied proposal is labeled applied and current values come from Node document', async () => {
  const h = await harness(); const applied = presentation(proposal('applied'));
  applied.document.project.revision = 2; applied.document.project.rules.rewards = { normalValue: 2, highValue: 4 };
  await h.push(applied);
  assert.match(h.element('candidate-application').textContent, /已应用.*revision 2/);
  assert.match(visibleTree(h.element('candidate-comparison')), /当前作品.*普通 2.*高分 4/);
  assert.equal(h.element('candidate-confirm').disabled, true);
});

test('R0 presentation: lease countdown warns at one minute and reason survives a new lease', async () => {
  const h = await harness(); await h.push(presentation(null, 59999));
  assert.match(h.element('session-detail').textContent, /1:00/);
  assert.match(h.element('session-detail').textContent, /即将到期.*撤权/);
  await h.push(presentation(null, 0, 'session_expired'));
  assert.match(h.element('session-detail').textContent, /10 分钟.*到期/);
  assert.equal(h.element('adult-on').disabled, true);
  assert.equal(h.element('reconnect').hidden, false);
  const replacement = presentation(null); replacement.connection.lastRevocationReason = 'session_expired';
  h.setSession(replacement); await h.click('reconnect'); await settle();
  assert.match(h.element('session-detail').textContent, /上次.*10 分钟.*到期/);
  assert.equal(h.calls.length, 0);
});

test('R0 presentation: all supported revocation reasons have safe distinct labels and unknown text is not reflected', async () => {
  for (const [reason, expected] of [['heartbeat_timeout', /心跳.*1 秒/], ['connection_lost', /快照通道.*关闭/], ['connection_replaced', /其他.*会话.*替换/], ['stream_write_failed', /通道写入失败/], ['server_stopped', /服务已停止/], ['verification_simulated_connection_loss', /验证模式/], ['__proto__', /原因未识别/], ['PRIVATE-INJECTED-REASON', /原因未识别/]] as const) {
    const h = await harness(); await h.push(presentation(null, 0, reason));
    assert.match(h.element('session-detail').textContent, expected);
    assert.doesNotMatch(h.element('session-detail').textContent, /PRIVATE-INJECTED/);
  }
});

test('R0 presentation: authority is open and confirmation precedes the long technical detail', () => {
  const html = readFileSync(resolve(process.cwd(), 'src/adapters/index.html'), 'utf8');
  assert.match(html, /<details[^>]*class="adult-panel"[^>]*open/);
  assert.ok(html.indexOf('id="candidate-confirm"') < html.indexOf('id="candidate-detail"'));
  assert.ok(html.indexOf('id="confirm-edit"') < html.indexOf('id="preview-detail"'));
});
