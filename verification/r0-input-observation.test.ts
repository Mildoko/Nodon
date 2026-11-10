import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

// Synthetic browser/transport harness. This verifies app ordering and observation
// privacy only; it is not actual Canvas, Node Runtime, browser or human evidence.
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
  runInNewContext(source(), { document, window: { addEventListener: (type: string, callback: (event: any) => unknown) => windowListeners.set(type, [...(windowListeners.get(type) ?? []), callback]) }, performance: { now: () => ++localTime },
    crypto: { randomUUID: () => 'synthetic-command' }, AbortController, TextDecoder,
    setInterval: () => 1, clearInterval() {},
    fetch: async (path: string, options?: { body?: string }) => {
      if (path === '/api/session') return { ok: true, json: async () => ({ ok: true, connectionId: 'PRIVATE-LEASE', csrfToken: 'PRIVATE-CSRF', snapshot: state() }) };
      if (path === '/api/events') return { ok: true, body: { getReader: () => ({ read: () => streamRead.promise }) } };
      const body = JSON.parse(options?.body ?? '{}') as Record<string, unknown>;
      calls.push({ path, body });
      const reply = transport ? await transport(path, body) : { ok: true, snapshot: state() };
      return { ok: reply.ok, json: async () => reply };
    } });
  await settle();
  return { trace, calls, element,
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

test('R0 observation: mutation stays pending until response; applied projection and draw precede completion feedback', async () => {
  const runReply = pending<Reply>();
  const h = await harness(async path => path === '/api/run' ? runReply.promise : { ok: true, snapshot: state() });
  const action = h.click('run-pause'); await settle();
  assert.equal(h.observation().lastMutation.status, 'pending');
  assert.equal(h.observation().lastAppliedProjection.runTick, 10);
  assert.equal(h.trace.some(item => item.id === 'feedback' && item.text.includes('请求 pause')), false);
  const start = h.trace.length;
  runReply.resolve({ ok: true, snapshot: state(11, 'paused') }); await action;
  const o = h.observation();
  assert.equal(o.lastMutation.status, 'completed');
  assert.equal(o.lastAppliedProjection.source, 'response:/api/run');
  assert.equal(o.lastAppliedProjection.runTick, 11);
  assert.equal(o.lastAppliedProjection.runStatus, 'paused');
  assert.equal(o.lastMutation.projectionSequence, o.lastAppliedProjection.sequence);
  const relevant = h.trace.slice(start);
  const drawn = relevant.findIndex(item => item.id === 'canvas-draw');
  const completed = relevant.findIndex(item => item.id === 'r0-observation' && item.text.includes('"status": "completed"'));
  const success = relevant.findIndex(item => item.id === 'feedback' && item.text.includes('请求 pause'));
  assert.ok(drawn >= 0 && completed > drawn && success > completed);
});

test('R0 observation: focus confirmation, first received input and actual effective input remain distinct and private', async () => {
  const focusReply = pending<Reply>();
  let receipt: Record<string, unknown> | null = null;
  const h = await harness(async (path, body) => {
    if (path === '/api/focus') return focusReply.promise;
    if (path === '/api/input') {
      receipt = { ...body, connectionId: 'PRIVATE-LEASE', receivedTick: 10, effectiveTick: null, committed: null, superseded: false };
      return { ok: true, snapshot: state(10, 'running', [receipt]) };
    }
    return { ok: true, snapshot: state() };
  });
  h.focusCanvas(); await settle();
  assert.equal(h.observation().focus.status, 'pending');
  focusReply.resolve({ ok: true, snapshot: state() }); await settle();
  assert.equal(h.observation().focus.confirmed, true);
  h.key('ArrowUp'); await settle();
  assert.equal(h.observation().lastInputAttempt.status, 'node_received');
  assert.deepEqual(h.observation().firstRetainedNonzeroReceipt.direction, { x: 0, y: -1 });
  assert.equal(h.observation().firstRetainedEffectiveNonzeroReceipt, null);
  await h.push(state(11, 'running', [{ ...(receipt ?? {}), effectiveTick: 11, committed: true }]));
  assert.equal(h.observation().firstRetainedEffectiveNonzeroReceipt.effectiveTick, 11);
  assert.equal(h.observation().lastAppliedProjection.source, 'stream');
  assert.doesNotMatch(h.element('r0-observation').textContent, /PRIVATE-LEASE|PRIVATE-CSRF|csrfToken|connectionId|writerToken/);
  assert.equal(h.calls.filter(call => call.path === '/api/input').length, 1);
  h.key('ArrowUp', 'keyup'); await settle();
  assert.deepEqual(h.observation().firstNonzeroInputAttempt.direction, { x: 0, y: -1 });
  assert.deepEqual(h.observation().lastInputAttempt.direction, { x: 0, y: 0 });
});

test('R0 observation: key before running is labeled not sent, never a Node receipt', async () => {
  const h = await harness(async () => ({ ok: true, snapshot: state(10, 'paused') }));
  await h.push(state(10, 'paused'));
  h.focusCanvas(); await settle();
  h.key('ArrowUp'); await settle();
  assert.equal(h.observation().lastInputAttempt.status, 'not_sent_not_connected_or_running');
  assert.equal(h.observation().lastInputAttempt.sequence, null);
  assert.equal(h.observation().firstRetainedNonzeroReceipt, null);
  assert.equal(h.calls.some(call => call.path === '/api/input'), false);
});


test('R0 real-AI pending: adult and scope revocation stay available while the model waits', async () => {
 const reply=pending<Reply>();
 const live=(status:string)=>Object.assign(state(),{authority:{adultEnabled:true,scopeEnabled:true,authEpoch:1},realAI:{slotId:'R0-AI-01-R1-I',intent:'synthetic',status,error:null,parentOptions:[],budget:{attempts:0},response:null}});
 const h=await harness(async path=>path==='/api/real-ai/request'?reply.promise:{ok:true,snapshot:live('canceled')});
 await h.push(live('ready')); await h.click('real-ai-send'); await settle(); await h.push(live('pending'));
 assert.equal(h.element('adult-off').disabled,false);assert.equal(h.element('scope-off').disabled,false);
 await h.click('adult-off');await settle();assert.ok(h.calls.some(c=>c.path==='/api/adult'&&c.body.enabled===false));
 reply.resolve({ok:true,snapshot:live('canceled')});await settle();
 assert.match(h.element('real-ai-response').textContent,/尚无当前可用结果/);
});


test('R0 budget stop: label an exhausted running snapshot as stopped sampling without fabricating a terminal',async()=>{
 const h=await harness(); const base=state(7200,'running');
 await h.push({...base,run:{...base.run,budgetExhausted:true}} as ReturnType<typeof state>);
 assert.match(h.element('run-state').textContent,/采样预算耗尽，已停止推进/);
 assert.equal(h.element('run-pause').disabled,true);assert.equal(h.element('run-resume').disabled,true);
 assert.doesNotMatch(h.element('run-score').textContent,/终局/);
 assert.equal(h.observation().lastAppliedProjection.runStatus,'running');assert.equal(h.observation().lastAppliedProjection.budgetExhausted,true);
});


test('R0 input recovery: clicking the still-active canvas after window blur re-confirms focus without resuming', async () => {
  let nodeFocused = false;
  let paused = false;
  const h = await harness(async (path, body) => {
    if (path === '/api/focus') { nodeFocused = body.focused === true; if (!nodeFocused) paused = true; }
    if (path === '/api/input' && !nodeFocused) return { ok: false, error: 'E_FOCUS', snapshot: state(10, paused ? 'paused' : 'running') };
    return { ok: true, snapshot: state(10, paused ? 'paused' : 'running') };
  });
  h.focusCanvas(); await settle();
  h.key('ArrowRight'); await settle();
  h.windowEvent('blur'); await settle();
  assert.equal(h.observation().focus.canvasFocused, true);
  assert.equal(h.observation().focus.confirmed, false);
  const boundary = h.calls.length;
  h.pointerCanvas(); await settle();
  assert.equal(h.observation().focus.confirmed, true);
  assert.equal(h.observation().lastAppliedProjection.runStatus, 'paused');
  assert.deepEqual(h.calls.slice(boundary).map(c => c.path), ['/api/focus']);
  assert.equal(h.calls.some(c => c.path === '/api/run'), false);
});

test('R0 input recovery: a held direction waits for focus confirmation and is sent once', async () => {
  const reply = pending<Reply>();
  const h = await harness(async path => path === '/api/focus' ? reply.promise : { ok: true, snapshot: state() });
  h.focusCanvas(); h.key('ArrowRight'); await settle();
  assert.equal(h.observation().lastInputAttempt.status, 'awaiting_focus_confirmation');
  assert.equal(h.calls.some(c => c.path === '/api/input'), false);
  reply.resolve({ ok: true, snapshot: state() }); await settle();
  const inputs = h.calls.filter(c => c.path === '/api/input');
  assert.equal(inputs.length, 1); assert.deepEqual(inputs[0]!.body.direction, { x: 1, y: 0 });
});

test('R0 input recovery: key release or blur while focus is pending never replays the old direction', async () => {
  for (const cancel of ['keyup', 'blur']) {
    const reply = pending<Reply>();
    const h = await harness(async (path, body) => path === '/api/focus' && body.focused ? reply.promise : { ok: true, snapshot: state(10, cancel === 'blur' ? 'paused' : 'running') });
    h.focusCanvas(); h.key('ArrowRight'); await settle();
    if (cancel === 'keyup') h.key('ArrowRight', 'keyup'); else h.windowEvent('blur');
    reply.resolve({ ok: true, snapshot: state() }); await settle();
    assert.equal(h.calls.filter(c => c.path === '/api/input').some(c => (c.body.direction as { x: number }).x !== 0), false, cancel);
  }
});

test('R0 input recovery: a pending direction is canceled by run replacement and cannot enter the new run', async () => {
  const reply = pending<Reply>();
  const h = await harness(async path => path === '/api/focus' ? reply.promise : { ok: true, snapshot: state() });
  h.focusCanvas(); h.key('ArrowRight'); await settle();
  const replacement = state(); replacement.run.context.runId = 'synthetic-replacement';
  reply.resolve({ ok: true, snapshot: replacement }); await settle();
  assert.equal(h.calls.some(c => c.path === '/api/input'), false);
  assert.equal(h.observation().lastInputAttempt.status, 'not_sent_input_context_changed');
});

test('R0 input recovery: rejected input is visible and can be retried with a fresh key press after canvas click', async () => {
  let rejectInput = true;
  const h = await harness(async path => path === '/api/input' && rejectInput ? { ok: false, error: 'E_FOCUS', snapshot: state() } : { ok: true, snapshot: state() });
  h.focusCanvas(); await settle(); h.key('ArrowRight'); await settle();
  assert.equal(h.observation().lastInputAttempt.error, 'E_FOCUS');
  assert.match(h.element('feedback').textContent, /E_FOCUS/);
  rejectInput = false;
  h.pointerCanvas(); await settle(); h.key('ArrowRight'); await settle();
  assert.equal(h.observation().lastInputAttempt.status, 'node_received');
  assert.equal(h.calls.filter(c => c.path === '/api/input').length, 2);
});

test('R0 direction routing: composition keydown is blocked; physical keyup releases an accepted direction without retaining private text', async () => {
  const h = await harness(); h.focusCanvas(); await settle();
  h.key('PRIVATE-COMPOSITION-TEXT', 'keydown', { code: 'KeyW', isComposing: true }); await settle();
  assert.equal(h.calls.some(c => c.path === '/api/input'), false);
  assert.equal(h.observation().lastDirectionEvent.route, 'composition_blocked');
  assert.match(h.element('feedback').textContent, /结束输入法组合/);
  h.key('PRIVATE-LAYOUT-TEXT', 'keydown', { code: 'KeyW', isComposing: false }); await settle();
  assert.deepEqual(h.observation().lastInputAttempt.direction, { x: 0, y: -1 });
  assert.equal(Object.hasOwn(h.observation().lastDirectionEvent, 'directionKey'), false);
  h.key('PRIVATE-COMPOSITION-TEXT', 'keyup', { code: 'KeyW', isComposing: true, ctrlKey: true }); await settle();
  assert.deepEqual(h.observation().lastInputAttempt.direction, { x: 0, y: 0 });
  const boundary = h.element('r0-observation').textContent;
  h.key('PRIVATE-UNRELATED-TEXT', 'keydown', { code: 'KeyQ' });
  assert.equal(h.element('r0-observation').textContent, boundary);
  assert.doesNotMatch(h.element('r0-observation').textContent, /PRIVATE-COMPOSITION-TEXT|PRIVATE-LAYOUT-TEXT|PRIVATE-UNRELATED-TEXT|KeyQ|KeyW/);
});

test('R0 input recovery: reconnect does not wait for an obsolete focus response or replay a held direction', async () => {
  const oldReply = pending<Reply>(); let focusCount = 0;
  const h = await harness(async path => {
    if (path === '/api/focus' && ++focusCount === 1) return oldReply.promise;
    return { ok: true, snapshot: state(10, 'paused') };
  });
  h.focusCanvas(); h.key('ArrowRight'); await settle();
  h.windowEvent('offline'); await h.click('reconnect');
  await h.push(state(10, 'paused'));
  const boundary = h.calls.length;
  h.pointerCanvas(); await settle();
  assert.equal(h.observation().focus.confirmed, true);
  assert.equal(h.observation().lastAppliedProjection.runStatus, 'paused');
  assert.equal(h.calls.slice(boundary).filter(c => c.path === '/api/focus').length, 1);
  oldReply.resolve({ ok: true, snapshot: state() }); await settle();
  assert.equal(h.calls.some(c => c.path === '/api/input'), false);
  assert.equal(h.calls.some(c => c.path === '/api/run'), false);
});


test('R0 direction routing: whitelisted events distinguish canvas, form, view, modifier and paused routes', async () => {
  const h = await harness();
  h.key('ArrowLeft'); assert.equal(h.observation().lastDirectionEvent.route, 'canvas_not_focused');
  const field = h.element('edit-text') as any;
  field.tagName = 'TEXTAREA'; field.focus();
  h.key('ArrowLeft'); assert.equal(h.observation().lastDirectionEvent.route, 'form_focused');
  h.focusCanvas(); await settle(); h.element('view-source').value = 'candidate';
  h.key('ArrowLeft'); assert.equal(h.observation().lastDirectionEvent.route, 'non_run_view');
  h.element('view-source').value = 'run';
  h.key('ArrowLeft', 'keydown', { metaKey: true }); assert.equal(h.observation().lastDirectionEvent.route, 'modified');
  await h.push(state(10, 'paused')); h.key('ArrowLeft'); await settle();
  assert.equal(h.observation().lastDirectionEvent.route, 'not_running');
  assert.equal(h.calls.some(c => c.path === '/api/input'), false);
  assert.match(h.element('input-readiness').textContent, /尚未收到方向/);
});


test('R0 input recovery: a repeated key held across blur and explicit resume cannot resurrect movement', async () => {
  let status = 'running';
  const h = await harness(async (path, body) => {
    if (path === '/api/focus' && body.focused === false) status = 'paused';
    if (path === '/api/run' && body.action === 'resume') status = 'running';
    return { ok: true, snapshot: state(10, status) };
  });
  h.focusCanvas(); await settle(); h.key('ArrowRight'); await settle();
  h.windowEvent('blur'); await settle(); await h.click('run-resume'); await settle();
  const boundary = h.calls.filter(c => c.path === '/api/input').length;
  h.key('ArrowRight', 'keydown', { repeat: true }); await settle();
  assert.equal(h.observation().lastDirectionEvent.route, 'repeat_without_press');
  assert.equal(h.calls.filter(c => c.path === '/api/input').length, boundary);
  h.key('ArrowRight', 'keyup'); await settle();
  h.key('ArrowRight', 'keydown', { repeat: false }); await settle();
  assert.equal(h.calls.filter(c => c.path === '/api/input').length, boundary + 1);
  assert.deepEqual(h.observation().lastInputAttempt.direction, { x: 1, y: 0 });
});

test('R0 direction privacy: form and unfocused direction-shaped text retains routes without any key value', async () => {
  const h = await harness();
  h.key('w');
  assert.equal(h.observation().lastDirectionEvent.route, 'canvas_not_focused');
  assert.equal(Object.hasOwn(h.observation().lastDirectionEvent, 'directionKey'), false);
  const field = h.element('edit-text') as any; field.tagName = 'TEXTAREA'; field.focus();
  h.key('a');
  const event = h.observation().lastDirectionEvent;
  assert.equal(event.route, 'form_focused');
  assert.equal(Object.hasOwn(event, 'directionKey'), false);
  assert.equal(Object.hasOwn(event, 'key'), false); assert.equal(Object.hasOwn(event, 'code'), false);
  assert.equal(h.calls.some(c => c.path === '/api/input'), false);
});
