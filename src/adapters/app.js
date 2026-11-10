// The browser owns transport, unfinished form values, and visual selection only.
// Documents, commands, gameplay, permissions, and candidate eligibility belong to Node.
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const canvas = byId('play-canvas');
  const ctx = canvas.getContext('2d');
  let connection = null; // Private lease + CSRF token: never DOM, URL, storage, or logs.
  let snapshot = null;
  let connected = false;
  let busy = 0;
  let interruptibleTrial = false;
  let streamAbort = null;
  let heartbeat = null;
  let focusRequests = Promise.resolve();
  let retryRequest = null;
  let evidenceView = null; // A returned package reference, bound to its request identity.
  let sequence = 0;
  let serverInstanceId = null;
  let restartDetected = false;
  let selectedEvent = null;
  let previewId = null;
  let previewResponse = null;
  let selectedEntity = null;
  let lastEntityOptions = '';
  let lastEventsKey = '';
  // Local observation only: none of these fields drives Node state or qualification.
  let projectionSequence = 0;
  let lastAppliedProjection = null;
  let mutationSequence = 0;
  let lastMutation = null;
  let focusSequence = 0;
  let focusObservation = { requested: false, confirmed: null, status: 'not_requested' };
  let lastInputAttempt = null;
  let firstNonzeroInputAttempt = null;
  let inputRevision = 0;
  let directionEventSequence = 0;
  let lastDirectionEvent = null;
  const keys = new Set();
  const text = (id, value) => { byId(id).textContent = String(value ?? '—'); };
  const json = value => JSON.stringify(value, null, 2);
  const project = () => snapshot?.document?.project;
  const candidate = () => snapshot?.candidate ?? null;
  const message = value => { text('feedback', value); };
  const actionButtons = ['preview-edit', 'run-start', 'run-pause', 'run-resume', 'adult-on', 'adult-off', 'scope-on', 'scope-off', 'candidate-prepare', 'candidate-trial', 'candidate-confirm', 'candidate-reject', 'confirm-edit'];
  const sourceRun = () => byId('view-source').value === 'candidate' ? candidate()?.trial?.run ?? null : snapshot?.run;
  const stateError = data => data?.error ?? data?.code ?? data?.result?.code ?? 'E_REQUEST';
  const localNow = () => performance.now();
  function publicReceipt(receipt) {
    if (!receipt) return null;
    return { sequence: receipt.sequence, runId: receipt.runId, generation: receipt.generation,
      direction: receipt.direction, receivedTick: receipt.receivedTick, effectiveTick: receipt.effectiveTick,
      committed: receipt.committed, superseded: receipt.superseded };
  }
  function renderObservation() {
    const runId = snapshot?.run?.context?.runId;
    const receipts = (snapshot?.clock?.inputReceipts ?? []).filter(r => r.runId === runId);
    const nonzero = r => r.direction?.x !== 0 || r.direction?.y !== 0;
    const receivedDirection = receipts.find(nonzero);
    const effectiveDirection = receipts.find(r => nonzero(r) && r.committed === true && r.effectiveTick !== null);
    const directionReadiness = effectiveDirection ? `方向已生效 · tick ${effectiveDirection.effectiveTick}` : receivedDirection ? 'Node 已收到方向 · 等待生效 tick' : 'Node 尚未收到方向 · 请点击画布，明确开始或继续，再按方向键';
    text('input-readiness', `${directionReadiness}。画布焦点：${document.activeElement === canvas ? '在画布' : '不在画布'} · Node焦点确认：${focusObservation.status === 'confirmed' ? String(focusObservation.confirmed) : focusObservation.status} · 正式run：${snapshot?.run?.status ?? '未开始'}。按键是否生效以 Node 收据和 actual tick 为准。`);
    text('r0-observation', json({
      lastAppliedProjection,
      lastMutation,
      focus: { canvasFocused: document.activeElement === canvas, ...focusObservation },
      lastInputAttempt,
      lastDirectionEvent,
      firstNonzeroInputAttempt: firstNonzeroInputAttempt?.runId === runId ? firstNonzeroInputAttempt : null,
      firstRetainedNonzeroReceipt: publicReceipt(receipts.find(nonzero)),
      firstRetainedEffectiveNonzeroReceipt: publicReceipt(receipts.find(r => nonzero(r) && r.committed === true && r.effectiveTick !== null)),
      receiptScope: 'current run, retained receipts only; not a complete browser key-event log',
      droppedInputReceipts: snapshot?.clock?.droppedInputReceipts ?? null,
      timeScope: 'browser performance.now; drawSubmittedAt is Canvas command submission, not physical paint'
    }));
  }
  function displayedClock() {
    const c = snapshot?.clock;
    if (!c) return null;
    return { fixedStepSeconds: c.fixedStepSeconds, maxCatchUp: c.maxCatchUp, paused: c.paused, reason: c.reason,
      direction: c.direction, lastSequence: c.lastSequence, totalInputs: c.totalInputs,
      droppedInputReceipts: c.droppedInputReceipts, droppedWallTicks: c.droppedWallTicks,
      inputSource: c.inputSource, executionClass: c.executionClass,
      recentInputReceipts: c.inputReceipts?.slice(-20).map(r => ({ sequence: r.sequence, runId: r.runId,
        generation: r.generation, direction: r.direction, receivedTick: r.receivedTick, effectiveTick: r.effectiveTick,
        clientSentAt: r.clientSentAt, receivedAt: r.receivedAt, receivedAtMonotonicMs: r.receivedAtMonotonicMs,
        appliedAtMonotonicMs: r.appliedAtMonotonicMs, attemptedTick: r.attemptedTick, committed: r.committed, superseded: r.superseded })) };
  }
  function setRetry(value) {
    retryRequest = value ? { ...value, serverInstanceId, runId: snapshot?.run?.context?.runId ?? null } : null;
    byId('retry-action').hidden = !value;
    byId('cancel-retry').hidden = !value;
    byId('retry-action').disabled = !connected || busy;
  }
  function disconnect(reason) {
    if (!connected && !connection) return;
    connected = false;
    keys.clear();
    inputRevision++;
    focusSequence++;
    focusRequests = Promise.resolve();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    streamAbort?.abort();
    streamAbort = null;
    text('connection-state', '连接已中断 · 已停止输入');
    renderConnection();
    text('network-banner', `${reason}。服务端通道守护会暂停并清除输入。表单保留；请手动重连，再明确继续。`);
    byId('network-banner').hidden = false;
    byId('reconnect').hidden = false;
    focusObservation = { requested: false, confirmed: null, status: 'disconnected' };
    renderObservation();
    renderControls();
  }
  async function request(path, body, { silent = false, retryable = false } = {}) {
    if (!connected || !connection) throw new Error('E_DISCONNECTED');
    const lease = connection;
    let response;
    try {
      response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Nodon-Connection': lease.connectionId, 'X-Nodon-CSRF': lease.csrfToken }, body: json(body) });
    } catch {
      if (connection === lease) disconnect('网络不可用');
      if (retryable) setRetry({ path, body });
      throw new Error('E_NETWORK');
    }
    const data = await response.json().catch(() => ({ ok: false, error: 'E_RESPONSE' }));
    if (connection !== lease) throw new Error('E_STALE_CONNECTION');
    if (data.snapshot) acceptSnapshot(data.snapshot, `response:${path}`);
    if (!response.ok || data.ok === false || data.result?.ok === false) {
      const error = stateError(data);
      if (/CONNECTION|SESSION_EXPIRED|LEASE_EXPIRED|HEARTBEAT|CSRF/.test(error)) disconnect(error);
      if (!silent) message(`请求被 Node 拒绝：${error}。作品未由页面改写。${data.errors || data.result?.errors ? ` ${json(data.errors ?? data.result.errors)}` : ''}`);
      throw new Error(error);
    }
    return data;
  }
  async function perform(path, body, success, retryable = false, interrupt = false) {
    if ((busy && !interrupt) || !connected) return null;
    busy++;
    const mutation = { sequence: ++mutationSequence, path, action: body.action ?? null,
      status: 'pending', requestedAt: localNow(), completedAt: null, projectionSequence: null };
    lastMutation = mutation;
    renderObservation();
    renderControls();
    try {
      const result = await request(path, body, { retryable });
      // request() applies and draws its snapshot synchronously before returning.
      mutation.status = 'completed';
      mutation.completedAt = localNow();
      mutation.projectionSequence = lastAppliedProjection?.sequence ?? null;
      renderObservation();
      if (success) message(success);
      if (retryRequest?.path === path && json(retryRequest.body) === json(body)) setRetry(null);
      return result;
    } catch (error) {
      mutation.status = error.message === 'E_NETWORK' ? 'unknown' : 'failed';
      mutation.completedAt = localNow();
      renderObservation();
      if (error.message === 'E_NETWORK') message('请求结果暂时未知。表单保留；重连后使用原请求安全重试，或取消待重试请求。');
      return null;
    } finally {
      busy--;
      renderControls();
    }
  }
  async function stream(lease) {
    const controller = new AbortController();
    streamAbort = controller;
    try {
      const response = await fetch('/api/events', { headers: { 'X-Nodon-Connection': lease.connectionId }, signal: controller.signal });
      if (!response.ok || !response.body) throw new Error('E_STREAM');
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      while (connected && connection === lease) {
        const { done, value } = await reader.read();
        if (done) throw new Error('E_STREAM_CLOSED');
        pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const packet = pending.slice(0, end);
          pending = pending.slice(end + 2);
          const data = packet.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
          if (data && connection === lease) {
            const payload = JSON.parse(data);
            acceptSnapshot(payload.snapshot ?? payload, 'stream');
          }
        }
      }
    } catch (error) {
      if (connection === lease && !controller.signal.aborted) disconnect('快照通道已断开');
    }
  }
  async function connect() {
    const previousInstanceId = serverInstanceId;
    streamAbort?.abort();
    if (heartbeat) clearInterval(heartbeat);
    connection = null;
    connected = false;
    sequence = 0;
    keys.clear();
    inputRevision++;
    focusSequence++;
    focusRequests = Promise.resolve();
    focusObservation = { requested: false, confirmed: null, status: 'not_requested' };
    text('connection-state', '正在连接 Node');
    renderControls();
    try {
      const response = await fetch('/api/session', { cache: 'no-store' });
      const data = await response.json();
      if (!response.ok || data.ok === false || !data.connectionId || !data.csrfToken) throw new Error('E_SESSION');
      connection = { connectionId: data.connectionId, csrfToken: data.csrfToken };
      const lease = connection;
      connected = true;
      byId('network-banner').hidden = true;
      byId('reconnect').hidden = true;
      text('connection-state', 'Node 已连接 · 内存作品');
      if (data.snapshot) acceptSnapshot(data.snapshot, 'session');
      void stream(lease);
      let heartbeatPending = false;
      heartbeat = setInterval(async () => {
        if (heartbeatPending || !connected || connection !== lease) return;
        heartbeatPending = true;
        try { await request('/api/heartbeat', {}, { silent: true }); } catch {} finally { heartbeatPending = false; }
      }, data.heartbeatIntervalMs ?? 250);
      message(previousInstanceId && previousInstanceId !== serverInstanceId ? '检测到服务已重启，内存作品回受控初态。未提交表单保留；请重新授权，明确开始或重试。' : previousInstanceId ? '已重连同一个 Node 实例，保留服务器当前内存作品。试玩保持暂停，需明确开始或继续。' : '已连接 Node 当前内存作品。刷新会保留当前服务实例的作品并暂停；试玩需明确开始或继续。');
      renderControls();
    } catch {
      text('connection-state', 'Node 未连接');
      text('network-banner', '无法连接当前 Node 服务。请确认真实服务正在运行，再手动重连；未提交表单保留。');
      byId('network-banner').hidden = false;
      byId('reconnect').hidden = false;
    }
  }
  function acceptSnapshot(value, source = 'snapshot') {
    if (!value?.document?.project) return;
    const receivedAt = localNow();
    const oldBuild = snapshot?.buildId;
    const previousRun = snapshot?.run;
    if (previousRun && (previousRun.context?.runId !== value.run?.context?.runId || previousRun.context?.generation !== value.run?.context?.generation || (previousRun.status === 'running' && value.run?.status !== 'running') || snapshot?.serverInstanceId !== value.serverInstanceId)) {
      keys.clear(); inputRevision++;
    }
    if (serverInstanceId && value.serverInstanceId && serverInstanceId !== value.serverInstanceId) {
      restartDetected = true;
      previewId = null;
      previewResponse = null;
      selectedEvent = null;
      text('restart-banner', '检测到服务已重启：内存作品已回受控初态，没有恢复已保存作品。未提交表单仍保留；旧证据/候选资格不可由页面恢复，请重新检查并明确操作。');
      byId('restart-banner').hidden = false;
    }
    if (value.serverInstanceId) serverInstanceId = value.serverInstanceId;
    snapshot = value;
    if (connected && value.connection?.connected === false) disconnect('Node 已撤销当前会话');
    if (oldBuild && oldBuild !== value.buildId) message('服务器构建已变化。作品与候选资格以新快照为准；服务重启只恢复初态，不代表保存。');
    render();
    const run = value.run;
    lastAppliedProjection = { sequence: ++projectionSequence, source,
      serverInstanceId: value.serverInstanceId ?? null, buildId: value.buildId ?? null,
      projectId: value.document.project.projectId, revision: value.document.project.revision,
      semanticHash: value.document.project.semanticHash,
      runId: run?.context?.runId ?? null, generation: run?.context?.generation ?? null,
      runTick: run?.tick ?? null, runStatus: run?.status ?? null, budgetExhausted: run?.budgetExhausted === true, score: run?.score ?? null,
      viewSource: byId('view-source').value, receivedAt, appliedAt: localNow(), drawSubmittedAt: localNow() };
    renderObservation();
  }
  function fact(label, value) {
    const line = document.createElement('div');
    line.className = 'fact';
    const name = document.createElement('strong');
    name.textContent = `${label} `;
    line.append(name, document.createTextNode(String(value)));
    return line;
  }
  function render() {
    const p = project();
    if (!p) return;
    renderConnection();
    text('project-title', p.title);
    text('revision', `revision ${p.revision}`);
    const d = snapshot.derived;
    byId('rules-summary').replaceChildren(
      fact('目标', `${p.rules.goal.targetScore} 分`),
      fact('奖励', `普通 ${p.rules.rewards.normalValue} / 高分 ${p.rules.rewards.highValue}`),
      fact('守卫', `速度 ${p.rules.guards.speed} / 发现半径 ${p.rules.guards.detectRadius}`),
      fact('计时', `${p.rules.timer.enabled ? '启用' : '停用'} / ${p.rules.timer.limit} 秒`),
      fact('主题', p.presentation.themeId === 'theme_r0_contrast' ? 'R0 高对比 · 验证配色' : '零食主题'),
      fact('Node 派生', d ? `${d.entityCount} 个物件 / ${d.rewardCount} 个奖励 / 总分 ${d.totalScore} / ${d.playable ? '可试玩' : '草稿，不可启动'}` : '等待服务端派生数据'),
      fact('数量', d ? `玩家 ${d.counts.player} · 守卫 ${d.counts.guard} · 普通 ${d.counts.normal} · 高分 ${d.counts.high}` : '—'),
      fact('预算', d?.budget ? `总上限 ${d.budget.maxTotal} / 余量 ${d.budget.remainingTotal}；各类余量 ${json(d.budget.remaining)}` : '等待 Node 预算')
    );
    text('document-meta', `project ${p.projectId}\n${p.semanticHash}\n${snapshot.document.runtimeVersion}\n${d?.errors?.length ? json(d.errors) : ''}`);
    text('build-info', `build ${snapshot.buildId ?? '未提供'}\n仅内存 · 不含账户余额或密钥\n${json(displayedClock())}`);
    const buildBlocked = snapshot.buildStatus !== 'ready';
    byId('build-banner').hidden = !buildBlocked;
    if (buildBlocked) text('build-banner', snapshot.buildStatus === 'restart_required' ? '构建已变化，需重启 Node 服务后才能继续试玩或验证候选。当前画面仅为保留的内存快照；未提交表单保持原样。' : '当前构建或快照不可用。试玩与候选操作已禁用；请检查服务并重启。未提交表单保留，不代表作品已保存。');
    byId('verification-disconnect').hidden = snapshot.verification?.enabled !== true;
    updateEntityOptions();
    renderPreview();
    renderCandidate();
    renderEvidence();
    renderRun();
    renderEvents();
    draw();
    renderControls();
    renderObservation();
  }
  // Only Node's public lease facts are displayed. The page never extends a lease.
  function revocationLabel(reason) {
    const labels = { session_expired: '10 分钟会话已到期', heartbeat_timeout: '心跳已超过 1 秒未到达 Node',
      connection_lost: '快照通道已关闭', connection_replaced: '已被其他新会话替换',
      verification_simulated_connection_loss: '验证模式模拟连接中断', stream_write_failed: '快照通道写入失败', server_stopped: 'Node 服务已停止' };
    return Object.hasOwn(labels, reason) ? labels[reason] : '撤权原因未识别';
  }
  function renderConnection() {
    const lease = snapshot?.connection;
    const remaining = lease?.leaseRemainingMs;
    const hasTime = typeof remaining === 'number' && Number.isFinite(remaining) && remaining >= 0;
    const seconds = hasTime ? Math.ceil(remaining / 1000) : null;
    const timer = seconds === null ? '等待 Node 剩余时间' : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    const active = connected && lease?.connected !== false;
    const reason = lease?.revocationReason;
    const previous = lease?.lastRevocationReason;
    text('session-detail', active
      ? `当前会话剩余 ${timer}（Node 快照，固定 10 分钟，心跳不会续期）。${hasTime && remaining <= 60000 ? '即将到期并撤权；请结束当前步骤。新会话需本人重新授权，旧候选不能延续。' : '到期将暂停并撤权；新会话需本人重新授权。'}${previous ? ` 上次撤权：${revocationLabel(previous)}。` : ''}`
      : `会话已断开。${reason ? revocationLabel(reason) : 'Node 具体撤权原因待重连后核对'}。输入已停止；手动重连后需本人重新授权，旧候选不能恢复资格。${previous && previous !== reason ? ` 上次撤权：${revocationLabel(previous)}。` : ''}`);
    byId('session-detail').className = active && hasTime && remaining <= 60000 ? 'session-detail session-warning' : 'session-detail';
    if (active) text('connection-state', `Node 已连接 · 剩余 ${timer}`);
  }
  function renderControls() {
    for (const name of ['goal', 'speed', 'theme']) byId(`candidate-${name}`).disabled = !byId(`candidate-${name}-on`).checked;
    const editable = connected && !busy;
    const buildReady = snapshot?.buildStatus === 'ready';
    for (const id of actionButtons) byId(id).disabled = !editable;
    const run = snapshot?.run;
    byId('preview-edit').disabled = !editable || !buildReady;
    byId('run-start').disabled = !editable || !buildReady || snapshot?.derived?.playable === false;
    byId('run-pause').disabled = !editable || run?.status !== 'running' || run?.budgetExhausted === true;
    byId('run-resume').disabled = !editable || !buildReady || run?.status !== 'paused' || run?.budgetExhausted === true;
    byId('confirm-edit').disabled = !editable || !buildReady || !previewId;
    byId('cancel-edit').disabled = busy;
    const a = snapshot?.authority;
    byId('adult-on').disabled = !editable || a?.adultEnabled === true;
    byId('adult-off').disabled = !connected || (!!busy && !interruptibleTrial && snapshot?.realAI?.status !== 'pending') || a?.adultEnabled !== true;
    byId('scope-on').disabled = !editable || a?.adultEnabled !== true || a?.scopeEnabled === true;
    byId('scope-off').disabled = !connected || (!!busy && !interruptibleTrial && snapshot?.realAI?.status !== 'pending') || a?.scopeEnabled !== true;
    byId('candidate-prepare').disabled = !editable || !buildReady || !a?.adultEnabled || !a?.scopeEnabled;
    const c = candidate();
    byId('candidate-trial').disabled = !editable || !buildReady || c?.canTrial !== true;
    byId('candidate-confirm').disabled = !editable || !buildReady || c?.canConfirm !== true;
    byId('candidate-reject').disabled = !connected || (!!busy && !interruptibleTrial && snapshot?.realAI?.status !== 'pending') || !c || ['applied', 'rejected', 'stale', 'canceled'].includes(c.state);
    byId('candidate-view').disabled = !c?.trial?.run;
    byId('retry-action').disabled = !editable;
    byId('catalog-reset').disabled = !editable || !byId('catalog-confirm').checked || !!snapshot?.frozenReference;
    byId('verification-disconnect').disabled = !editable;
    byId('export-formal').disabled = !editable || !snapshot?.run;
    byId('export-candidate').disabled = !editable || !c?.trial || c.trialStatus === 'running';
    renderRealAI();
  }
  function renderPreview() {
    const publicPreview = snapshot?.preview;
    if (publicPreview && publicPreview.previewId) {
      previewId = publicPreview.previewId;
      previewResponse = publicPreview.result ? publicPreview : previewResponse?.previewId === publicPreview.previewId ? previewResponse : publicPreview;
    } else if (publicPreview === null) {
      previewId = null;
      previewResponse = null;
    }
    byId('preview-panel').hidden = !previewResponse;
    if (previewResponse) text('preview-detail', json(previewResponse));
  }
  function renderCandidate() {
    const c = candidate();
    const provider = snapshot?.realAI != null;
    text('candidate-kind-label', provider ? 'R0 · 真实AI候选确认门' : 'T05 · 受控候选流程');
    text('candidate-disclosure', provider ? 'source: provider_gateway。仅接受当前网关真实返回对象；原始模型输出不是确认、验证或权限。程序检查与实际试跑后，作者另行明确确认。' : 'source: controlled_fixture。手工构造的白名单操作，不是模型输出；使用真实Runtime验证，不代表真人通关。');
    text('candidate-model-notice', provider ? '上方真实请求可产生候选；本确认门不重发请求、不泄露密钥，模型与20元总帽保持。' : '本面板不调用模型；受控候选与真实模型结果分别记录。');
    const a = snapshot?.authority;
    text('authority-state', `实验权限：${a?.adultEnabled ? '开' : '关'} · 候选能力：${a?.scopeEnabled ? '开' : '关'} · authEpoch ${a?.authEpoch ?? '—'}`);
    byId('candidate-form').hidden = provider;
    byId('candidate-detail-panel').hidden = !c;
    if (!c) return;
    const ended = ['canceled', 'rejected', 'stale'].includes(c.state);
    text('candidate-application', c.state === 'applied' ? `此候选已应用；当前作品为 revision ${project()?.revision}，数值见左侧。` : ended ? `此候选已${c.state === 'stale' ? '过期' : '取消'}，未应用；下方只读历史提案不提供确认资格。` : '候选尚未应用。验证只运行候选；本人明确确认后，Node 才会修改当前作品。');
    renderCandidateComparison(c);
    text('candidate-status', `${c.state} · 真实验证 ${c.trialStatus} · ${c.source}${c.eligibilityError ? ` · 当前资格被拒绝 ${c.eligibilityError}` : ''}`);
    if (c.trialStatus === 'running') byId('trial-progress').removeAttribute('value');
    else byId('trial-progress').value = ['passed', 'failed', 'blocked', 'runtime_not_applicable'].includes(c.trialStatus) ? 1 : 0;
    text('candidate-detail', json({ source: c.source, candidateId: c.candidateId, requestId: c.requestId, baseRevision: c.baseRevision, baseSemanticHash: c.baseSemanticHash, candidateHash: c.candidateHash, candidateSemanticHash: c.candidateSemanticHash, differences: c.operations, historicalDifferences: c.historicalOperations ?? null, validation: c.validation, errors: c.errors, trialRef: c.trialRef, canConfirm: c.canConfirm, canTrial: c.canTrial, eligibilityError: c.eligibilityError, predictedImpact: c.predictedImpact, actualCoverage: c.actualCoverage, missingCoverage: c.missingCoverage, trialSummary: c.trial ? { status: c.trial.status, scriptId: c.trial.scriptId, buildHash: c.trial.buildHash, runtimeArtifactHash: c.trial.runtimeArtifactHash, assertions: c.trial.assertions, coverage: c.trial.coverage } : null }));
    const notes = {
      validation_pending: '候选尚未通过真实验证。可运行验证或取消；当前作品保持不变。',
      validation_blocked: '候选验证失败或被阻止。查看错误，取消后修改表单再提出候选。',
      proposed: c.trialStatus === 'runtime_not_applicable' ? '仅主题变化：静态验证通过，不伪称运行通关。确认后才改当前作品。' : '真实程序验证已结束；这不是人工通关结论。只有 Node 当前资格允许时才能确认。',
      applied: '此候选已确认，重复确认已禁用。可在当前作品查看新 revision，或用一次撤销。',
      stale: '候选已过期（版本、构建或权限变化）。请重新构造，不能沿用旧资格。',
      canceled: '候选已取消。当前作品保持不变，可以重新构造。',
      rejected: '候选已取消。当前作品保持不变，可以重新构造。'
    };
    const providerNote = ended ? '历史提案与已完成验证可查看或导出；冻结槽不会自动再次发送，也不能延续旧候选资格。后续按实验顺序准备新会话及本人权限。' : c.state === 'validation_blocked' ? '验证被阻止；请查看原因或取消本次结果。冻结槽不会自动再次发送。' : null;
    text('candidate-recovery', `${provider && providerNote ? providerNote : notes[c.state] ?? '候选资格与状态由 Node 决定。'}${c.eligibilityError ? ` 当前不可确认：${c.eligibilityError}；历史验证 passed 不能恢复当前资格。` : ''}`);
  }
  function renderCandidateComparison(c) {
    const p = project();
    const format = (op, value) => {
      if (value === undefined || value === null) return 'Node 未提供';
      if (op === 'set_reward_values') return `普通 ${value.normalValue} / 高分 ${value.highValue}`;
      if (op === 'set_timer') return `${value.enabled ? '启用' : '停用'} / ${value.limit} 秒`;
      if (op === 'move_entity') return `(${value.x}, ${value.y})`;
      if (op === 'set_theme') return value.themeId === 'theme_r0_contrast' ? 'R0 高对比 · 验证配色' : value.themeId === 'theme_snack' ? '零食主题' : 'Node 未提供可识别主题';
      return String(value);
    };
    const labels = { set_goal: '目标分数', set_reward_values: '奖励分值', set_guard_speed: '守卫速度', set_detect_radius: '发现半径', set_timer: '计时', set_theme: '主题', move_entity: '物件位置' };
    const current = op => ({ set_goal: p?.rules.goal.targetScore, set_reward_values: p?.rules.rewards,
      set_guard_speed: p?.rules.guards.speed, set_detect_radius: p?.rules.guards.detectRadius,
      set_timer: p?.rules.timer, set_theme: p?.presentation,
      move_entity: p?.scene.entities.find(entity => entity.id === op.entityId) })[op.op];
    const history = ['canceled', 'rejected', 'stale'].includes(c.state);
    const operations = history && Array.isArray(c.historicalOperations) ? c.historicalOperations : Array.isArray(c.operations) ? c.operations : [];
    byId('candidate-comparison').replaceChildren(...(operations.length ? operations.map(op => {
      const row = document.createElement('div'); row.className = 'proposal-row';
      row.append(fact(`${labels[op.op] ?? '操作'}${op.op === 'move_entity' ? ` ${op.entityId}` : ''}`, ''),
        fact(`当前作品 · revision ${p?.revision}`, format(op.op, current(op))),
        fact('候选提案 · 原值 → 拟值', `${format(op.op, op.expectedValue)} → ${format(op.op, op.value)}`));
      return row;
    }) : [fact('候选提案', 'Node 未提供可读差异；不从页面旧快照补造。')]));
  }
  function renderRun() {
    const view = byId('view-source').value;
    const run = view === 'candidate' ? sourceRun() : snapshot?.run;
    const name = view === 'candidate' ? '候选试跑' : '正式试玩';
    text('canvas-caption', view === 'document' ? `当前作品 · revision ${project()?.revision} · Node 静态快照` : run ? `${name} · 启动 revision ${run.document?.project?.revision ?? '—'} · ${run.context?.runId ?? '—'}` : `${name}还没有运行快照；画布不替代为当前作品。`);
    text('run-state', run ? `${name} · ${run.budgetExhausted ? '采样预算耗尽，已停止推进' : run.status} · tick ${run.tick}` : '尚未开始正式试玩');
    text('run-score', run ? `Node 分数 ${run.score} / ${run.document?.project?.rules?.goal?.targetScore ?? '—'}${run.terminal ? ` · 终局 ${run.terminal.reason}` : ''}` : '由 Node 计算分数、碰撞与胜负');
    text('source-label', run?.context ? `实验输入：${run.context.inputSource} / ${run.context.executionClass} · ${run.context.evidenceSource}` : '当前尚无run，来源以实际run记录为准');
    text('run-meta', json(run ? { context: run.context, revision: run.document?.project?.revision, semanticHash: run.document?.project?.semanticHash, tick: run.tick, status: run.status, truncation: run.truncation, diagnostics: run.diagnostics, clock: displayedClock() } : { clock: displayedClock(), observations: snapshot?.observations }));
  }
  function renderEvents() {
    const run = snapshot?.run;
    const events = run?.events ?? [];
    text('event-count', events.length);
    const eventKey = `${run?.context?.runId ?? ''}:${events.length}:${events.at(-1)?.eventId ?? ''}:${selectedEvent ?? ''}`;
    if (eventKey !== lastEventsKey) {
      lastEventsKey = eventKey;
      byId('event-list').replaceChildren(...events.map(event => {
        const button = document.createElement('button');
        button.className = 'event-item';
        button.type = 'button';
        button.textContent = `t${event.tick} · ${event.kind}`;
        button.setAttribute('aria-pressed', String(selectedEvent === event.eventId));
        button.addEventListener('click', () => selectEvent(event.eventId));
        return button;
      }));
    }
    const observation = snapshot?.observations?.events?.find(item => item.event?.eventId === selectedEvent);
    const event = events.find(item => item.eventId === selectedEvent);
    byId('event-empty').hidden = !!event;
    byId('event-detail').hidden = !event;
    if (event) text('event-detail', json(observation ?? { event, observation: '等待 Node 只读观察结果；未推断缺失前因。' }));
  }
  async function selectEvent(eventId) {
    if (!connected || busy) return;
    clearInput();
    const result = await perform('/api/event-selection', { eventIds: [eventId] }, '已暂停正式试玩，显示 Node 的真实事件与前因状态。');
    if (result) { selectedEvent = eventId; renderEvents(); }
  }
  function draw() {
    const view = byId('view-source').value;
    const run = view === 'document' ? null : sourceRun();
    const doc = view === 'document' ? snapshot?.document : run?.document;
    ctx.clearRect(0, 0, 960, 540);
    ctx.fillStyle = doc?.project?.presentation?.themeId === 'theme_r0_contrast' ? '#eff0fb' : '#edf4e5';
    ctx.fillRect(0, 0, 960, 540);
    ctx.strokeStyle = doc?.project?.presentation?.themeId === 'theme_r0_contrast' ? '#dcdff0' : '#dce8d1';
    ctx.lineWidth = 1;
    for (let x = 20; x < 960; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, 540); ctx.stroke(); }
    for (let y = 20; y < 540; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(960, y); ctx.stroke(); }
    if (!doc) { ctx.fillStyle = '#6d8170'; ctx.font = '20px system-ui'; ctx.textAlign = 'center'; ctx.fillText('暂无该来源的 Node 快照', 480, 270); return; }
    const p = doc.project;
    for (const entity of p.scene.entities) {
      if (run?.collectedIds?.includes(entity.id)) continue;
      const point = run?.positions?.[entity.id] ?? (view === 'document' ? entity : null);
      if (!point) continue;
      const radius = snapshot?.entityRadii?.[entity.kind] ?? 12;
      if (entity.kind === 'guard') {
        ctx.save(); ctx.strokeStyle = '#cc828357'; ctx.setLineDash([7, 7]); ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(point.x, point.y, p.rules.guards.detectRadius, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      ctx.fillStyle = ({ player: '#3a9e77', guard: '#d7767b', normal: '#d7aa42', high: '#ab81d1' })[entity.kind];
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3;
      ctx.beginPath();
      if (entity.kind === 'high') { ctx.moveTo(point.x, point.y - radius); ctx.lineTo(point.x + radius, point.y); ctx.lineTo(point.x, point.y + radius); ctx.lineTo(point.x - radius, point.y); ctx.closePath(); }
      else ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill(); ctx.stroke();
      if (entity.kind === 'player') { ctx.fillStyle = 'white'; ctx.beginPath(); ctx.arc(point.x - 4, point.y - 2, 2, 0, Math.PI * 2); ctx.arc(point.x + 4, point.y - 2, 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.fillStyle = '#4c6653'; ctx.font = '11px system-ui'; ctx.textAlign = 'center'; ctx.fillText(entity.id, point.x, point.y + radius + 14);
    }
  }
  function field(label, id, type, value, attributes = {}) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
    input.id = id;
    if (type !== 'textarea') input.type = type;
    input.value = value;
    for (const [name, val] of Object.entries(attributes)) input.setAttribute(name, String(val));
    wrapper.append(input);
    return wrapper;
  }
  function selectField(label, id, entries) {
    const wrapper = document.createElement('label');
    wrapper.textContent = label;
    const select = document.createElement('select'); select.id = id;
    for (const [value, title] of entries) { const option = document.createElement('option'); option.value = value; option.textContent = title; select.append(option); }
    wrapper.append(select); return wrapper;
  }
  function buildFields() {
    const p = project();
    const action = byId('edit-action').value;
    const nodes = [];
    if (['move_entity', 'copy_entity', 'remove_entity'].includes(action)) nodes.push(selectField('物件 ID', 'entity-id', []));
    if (action === 'add_entity') nodes.push(selectField('物件类别', 'entity-kind', [['normal', '普通奖励'], ['high', '高分奖励'], ['guard', '守卫']]));
    if (['move_entity', 'copy_entity', 'add_entity'].includes(action)) {
      const pair = document.createElement('div'); pair.className = 'field-pair';
      pair.append(field('X · 20–940，步长 10', 'edit-x', 'number', 300, { min: 20, max: 940, step: 10 }), field('Y · 20–520，步长 10', 'edit-y', 'number', 300, { min: 20, max: 520, step: 10 })); nodes.push(pair);
    }
    if (action === 'set_goal') nodes.push(field('目标分数 · 1–99', 'edit-value', 'number', p?.rules.goal.targetScore ?? 10, { min: 1, max: 99, step: 1 }));
    if (action === 'set_guard_speed') nodes.push(field('速度 · 20–180，步长 10', 'edit-value', 'number', p?.rules.guards.speed ?? 60, { min: 20, max: 180, step: 10 }));
    if (action === 'set_detect_radius') nodes.push(field('半径 · 60–300，步长 10', 'edit-value', 'number', p?.rules.guards.detectRadius ?? 120, { min: 60, max: 300, step: 10 }));
    if (action === 'set_reward_values') nodes.push(field('普通分值 · 1–3', 'edit-normal', 'number', p?.rules.rewards.normalValue ?? 1, { min: 1, max: 3, step: 1 }), field('高分分值 · 2–9，必须大于普通', 'edit-high', 'number', p?.rules.rewards.highValue ?? 3, { min: 2, max: 9, step: 1 }));
    if (action === 'set_timer') {
      nodes.push(selectField('计时状态', 'edit-enabled', [['true', '启用'], ['false', '停用（保留合法时限）']]), field('秒数 · 15–120，步长 5', 'edit-limit', 'number', p?.rules.timer.limit ?? 60, { min: 15, max: 120, step: 5 }));
    }
    if (action === 'set_theme') nodes.push(selectField('配色', 'edit-theme', [['theme_snack', '零食主题'], ['theme_r0_contrast', 'R0 高对比 · 验证配色']]));
    if (action === 'set_title' || action === 'set_instructions') nodes.push(field(action === 'set_title' ? '标题' : '玩法说明', 'edit-text', 'textarea', action === 'set_title' ? p?.title ?? '' : p?.instructions ?? ''));
    byId('edit-fields').replaceChildren(...nodes);
    lastEntityOptions = '';
    updateEntityOptions();
    if (action === 'set_theme' && p) byId('edit-theme').value = p.presentation.themeId;
    if (action === 'set_timer' && p) byId('edit-enabled').value = String(p.rules.timer.enabled);
  }
  function updateEntityOptions() {
    const select = byId('entity-id');
    if (!select || !project()) return;
    const nonPlayer = byId('edit-action').value !== 'move_entity';
    const entries = project().scene.entities.filter(entity => !nonPlayer || entity.kind !== 'player');
    const key = `${project().revision}:${byId('edit-action').value}:${entries.map(entity => entity.id).join('|')}`;
    if (key === lastEntityOptions) return;
    const previous = select.value || selectedEntity;
    select.replaceChildren(...entries.map(entity => { const option = document.createElement('option'); option.value = entity.id; option.textContent = `${entity.id} · ${entity.kind} · (${entity.x}, ${entity.y})`; return option; }));
    if (entries.some(entity => entity.id === previous)) select.value = previous;
    lastEntityOptions = key;
    select.onchange = () => {
      selectedEntity = select.value;
      const entity = project()?.scene.entities.find(item => item.id === selectedEntity);
      if (entity && byId('edit-action').value === 'move_entity') { byId('edit-x').value = entity.x; byId('edit-y').value = entity.y; }
    };
  }
  function editCommand() {
    const action = byId('edit-action').value;
    const number = id => byId(id).value === '' ? null : Number(byId(id).value);
    if (['set_goal', 'set_guard_speed', 'set_detect_radius'].includes(action)) return { type: action, value: number('edit-value') };
    if (action === 'set_reward_values') return { type: action, value: { normalValue: number('edit-normal'), highValue: number('edit-high') } };
    if (action === 'set_timer') return { type: action, value: { enabled: byId('edit-enabled').value === 'true', limit: number('edit-limit') } };
    if (action === 'set_theme') return { type: action, value: { themeId: byId('edit-theme').value, playerSkinId: 'snack_player_01' } };
    if (action === 'set_title' || action === 'set_instructions') return { type: 'set_text', field: action === 'set_title' ? 'title' : 'instructions', value: byId('edit-text').value };
    if (action === 'undo') return { type: 'undo' };
    if (action === 'remove_entity') return { type: action, entityId: byId('entity-id').value };
    const point = { x: number('edit-x'), y: number('edit-y') };
    if (action === 'add_entity') return { type: action, kind: byId('entity-kind').value, ...point };
    return { type: action, entityId: byId('entity-id').value, ...point };
  }
  async function sendDirection() {
    const run = snapshot?.run;
    const lease = connection;
    const revision = ++inputRevision;
    const x = Number(keys.has('ArrowRight') || keys.has('d')) - Number(keys.has('ArrowLeft') || keys.has('a'));
    const y = Number(keys.has('ArrowDown') || keys.has('s')) - Number(keys.has('ArrowUp') || keys.has('w'));
    const canSend = connected && run?.status === 'running';
    const attempt = { sequence: null, runId: run?.context?.runId ?? null, generation: run?.context?.generation ?? null,
      direction: { x, y }, requestedAt: localNow(), completedAt: null,
      status: canSend ? 'awaiting_focus_confirmation' : 'not_sent_not_connected_or_running', error: null };
    lastInputAttempt = attempt;
    if ((x !== 0 || y !== 0) && (!firstNonzeroInputAttempt || firstNonzeroInputAttempt.runId !== attempt.runId)) firstNonzeroInputAttempt = attempt;
    renderObservation();
    if (!canSend) return;
    try {
      if (focusObservation.status === 'pending') await focusRequests;
      const currentRun = snapshot?.run;
      if (revision !== inputRevision || connection !== lease || !connected || currentRun?.context?.runId !== attempt.runId || currentRun?.context?.generation !== attempt.generation || currentRun?.status !== 'running') {
        attempt.status = 'not_sent_input_context_changed';
        if (revision === inputRevision) { keys.clear(); inputRevision++; }
      } else if (document.activeElement !== canvas || document.hidden || byId('view-source').value !== 'run' || focusObservation.status !== 'confirmed' || focusObservation.confirmed !== true) {
        attempt.status = 'not_sent_focus_unconfirmed';
        message('方向键尚未发送：请先点击画布完成 Node 焦点确认；若已暂停，请明确继续。');
      } else {
        attempt.sequence = ++sequence;
        attempt.status = 'requested';
        renderObservation();
        await request('/api/input', { sequence: attempt.sequence, runId: attempt.runId, generation: attempt.generation, clientSentAt: Date.now(), direction: { x, y } }, { silent: true });
        attempt.status = 'node_received';
      }
      attempt.completedAt = localNow();
    } catch (error) {
      attempt.status = 'failed_or_unknown'; attempt.error = error.message; attempt.completedAt = localNow();
      if (connection === lease && connected && revision === inputRevision) {
        keys.clear(); inputRevision++;
        focusObservation = { requested: false, confirmed: null, status: 'input_failed' };
        message(`方向输入未获 Node 确认：${error.message}。请重新点击画布；若已暂停，请明确继续。`);
      }
    }
    renderObservation();
  }
  function clearInput() { keys.clear(); void sendDirection(); }
  function focus(focused) {
    if (!focused) clearInput();
    const lease = connection;
    const attempt = ++focusSequence;
    focusObservation = { requested: focused, confirmed: focusObservation.confirmed, status: 'pending' };
    renderObservation();
    focusRequests = focusRequests.catch(() => {}).then(() => {
      if (connected && connection === lease) return request('/api/focus', { focused }, { silent: true }).then(result => {
        if (connection === lease && focusSequence === attempt) focusObservation = { requested: focused, confirmed: focused, status: 'confirmed' };
        renderObservation();
        return result;
      }).catch(error => {
        if (connection === lease && focusSequence === attempt) {
          keys.clear(); inputRevision++;
          focusObservation = { requested: focused, confirmed: null, status: 'failed_or_unknown' };
          message(`Node 焦点请求失败：${error.message}。请重新点击画布；若已暂停，请明确继续。`);
        }
        renderObservation();
        throw error;
      });
      return undefined;
    });
    return focusRequests;
  }
  function ensureCanvasFocus() {
    if (document.activeElement !== canvas || document.hidden || byId('view-source').value !== 'run') return Promise.resolve();
    if (focusObservation.requested && (focusObservation.status === 'pending' || (focusObservation.status === 'confirmed' && focusObservation.confirmed))) return focusRequests;
    return focus(true);
  }
  const physicalMovementKeys = { ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd' };
  const movementKey = event => {
    // Keydown blocks composition; keyup still uses accepted physical directions.
    // Neither arbitrary event.key nor arbitrary event.code is retained in observation.
    if (Object.hasOwn(physicalMovementKeys, event.code)) return physicalMovementKeys[event.code];
    const key = typeof event.key === 'string' ? event.key : '';
    const normalized = key.startsWith('Arrow') ? key : key.toLowerCase();
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'w', 'a', 's', 'd'].includes(normalized) ? normalized : null;
  };
  function observeDirectionEvent(type, route) {
    lastDirectionEvent = { sequence: ++directionEventSequence, type, route,
      canvasFocused: document.activeElement === canvas, view: byId('view-source').value === 'run' ? 'run' : 'other', observedAt: localNow() };
    renderObservation();
  }
  document.addEventListener('keydown', event => {
    const key = movementKey(event);
    if (!key) return;
    const formFocused = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    const route = formFocused ? 'form_focused' : document.activeElement !== canvas ? 'canvas_not_focused' : byId('view-source').value !== 'run' ? 'non_run_view' : event.altKey || event.ctrlKey || event.metaKey ? 'modified' : event.isComposing ? 'composition_blocked' : event.repeat && !keys.has(key) ? 'repeat_without_press' : snapshot?.run?.status !== 'running' ? 'not_running' : 'accepted';
    observeDirectionEvent('keydown', route);
    if (route === 'composition_blocked') message('方向键未发送：请先结束输入法组合，再点击画布按方向键。');
    if (route !== 'accepted' && route !== 'not_running') return;
    event.preventDefault();
    if (!keys.has(key)) { keys.add(key); void sendDirection(); }
  });
  document.addEventListener('keyup', event => {
    const key = movementKey(event);
    if (!key) return;
    const held = keys.delete(key);
    observeDirectionEvent('keyup', held ? 'released' : 'not_held');
    if (held) { event.preventDefault(); void sendDirection(); }
  });
  canvas.addEventListener('focus', () => { void ensureCanvasFocus().catch(() => {}); });
  canvas.addEventListener('pointerdown', () => { canvas.focus(); void ensureCanvasFocus().catch(() => {}); });
  canvas.addEventListener('blur', () => { void focus(false).catch(() => {}); });
  window.addEventListener('blur', () => { void focus(false).catch(() => {}); });
  window.addEventListener('offline', () => disconnect('浏览器报告离线'));
  document.addEventListener('visibilitychange', () => { if (document.hidden) void focus(false).catch(() => {}); });
  window.addEventListener('pagehide', () => { keys.clear(); inputRevision++; streamAbort?.abort(); });
  byId('reconnect').addEventListener('click', connect);
  byId('text-size').addEventListener('click', () => {
    const enabled = !document.body.classList.contains('text-200');
    document.documentElement.classList.toggle('text-200', enabled);
    document.body.classList.toggle('text-200', enabled);
    byId('text-size').setAttribute('aria-pressed', String(enabled));
    text('text-size', enabled ? '文字 100%' : '文字 200%');
  });
  byId('view-source').addEventListener('change', () => { void focus(false).catch(() => {}); selectedEvent = null; render(); });
  byId('edit-action').addEventListener('change', buildFields);
  byId('edit-form').addEventListener('submit', async event => {
    event.preventDefault();
    clearInput();
    const result = await perform('/api/command', { action: 'preview', commandId: crypto.randomUUID(), expectedRevision: project()?.revision, command: editCommand() }, 'Node 已预览。请查看返回结果，再确认一次命令。', true);
    const preview = result?.result;
    if (preview?.previewId) { previewId = preview.previewId; previewResponse = preview; renderPreview(); renderControls(); }
  });
  byId('confirm-edit').addEventListener('click', async () => {
    if (!previewId) return;
    const result = await perform('/api/command', { action: 'confirm', previewId }, 'Node 已确认该命令。作品 revision 与运行状态以快照为准。', true);
    if (result) { previewId = null; previewResponse = null; renderPreview(); renderControls(); }
  });
  byId('cancel-edit').addEventListener('click', async () => {
    if (connected) await perform('/api/command', { action: 'cancel' }, '已取消 Node 预览。未提交表单保留。');
    previewId = null; previewResponse = null; byId('preview-panel').hidden = true; renderControls();
  });
  for (const action of ['start', 'pause', 'resume']) byId(`run-${action}`).addEventListener('click', async () => {
    clearInput();
    if (action !== 'pause') {
      byId('view-source').value = 'run';
      canvas.focus();
      try { await focus(true); } catch { return; }
    }
    const result = await perform('/api/run', { action }, `已向 Node 请求 ${action}。正式试玩状态由快照显示。`);
    if (result) { byId('view-source').value = 'run'; selectedEvent = null; render(); if (action !== 'pause') canvas.focus(); }
  });
  for (const [id, enabled] of [['adult-on', true], ['adult-off', false]]) byId(id).addEventListener('click', () => perform('/api/adult', { enabled }, enabled ? '本机成人实验权限已启用，不代表身份认证。' : '已撤销成人实验权限；候选资格由 Node 同步失效。', false, !enabled && (interruptibleTrial || snapshot?.realAI?.status === 'pending')));
  for (const [id, enabled] of [['scope-on', true], ['scope-off', false]]) byId(id).addEventListener('click', () => perform('/api/scope', { enabled }, enabled ? '已启用受控候选能力。' : '已关闭受控候选能力；Node 会撤销未应用候选。', false, !enabled && (interruptibleTrial || snapshot?.realAI?.status === 'pending')));
  byId('candidate-form').addEventListener('submit', event => {
    event.preventDefault();
    const p = project(); if (!p) return;
    const operations = [];
    if (byId('candidate-goal-on').checked) operations.push({ op: 'set_goal', expectedValue: p.rules.goal.targetScore, value: Number(byId('candidate-goal').value) });
    if (byId('candidate-speed-on').checked) operations.push({ op: 'set_guard_speed', expectedValue: p.rules.guards.speed, value: Number(byId('candidate-speed').value) });
    if (byId('candidate-theme-on').checked) operations.push({ op: 'set_theme', expectedValue: p.presentation, value: { themeId: byId('candidate-theme').value, playerSkinId: 'snack_player_01' } });
    if (operations.length === 0) { message('请选择 1–3 项受控操作。'); return; }
    clearInput();
    void perform('/api/candidate/prepare', { requestId: crypto.randomUUID(), operations }, '已提交手工构造的 controlled_fixture 候选；不是模型输出。', true);
  });
  for (const action of ['trial', 'confirm', 'reject']) byId(`candidate-${action}`).addEventListener('click', async () => {
    const c = candidate(); if (!c) return;
    clearInput();
    const body = { candidateId: c.candidateId };
    if (action === 'confirm') body.commandId = crypto.randomUUID();
    if (action === 'trial') interruptibleTrial = true;
    try {
      await perform(`/api/candidate/${action}`, body, action === 'trial' ? '真实 Runtime 验证请求已结束；查看 Node 返回的进度与结果。程序结果不代表真人通关。' : action === 'confirm' ? '候选确认请求已处理，应用与否以 Node 最新状态为准。' : '候选已取消。', action === 'confirm', action === 'reject' && interruptibleTrial);
    } finally {
      if (action === 'trial') interruptibleTrial = false;
      renderControls();
    }
  });
  byId('candidate-view').addEventListener('click', () => { void focus(false).catch(() => {}); byId('view-source').value = 'candidate'; selectedEvent = null; render(); canvas.scrollIntoView({ block: 'center', behavior: 'smooth' }); });
  function renderEvidence() {
    if (!evidenceView) return;
    const currentIdentity = evidenceView.serverInstanceId === serverInstanceId && (evidenceView.target === 'formal'
      ? evidenceView.targetRunId === snapshot?.run?.context?.runId
      : evidenceView.targetCandidateId === candidate()?.candidateId);
    text('evidence-identity', currentIdentity
      ? `当前${evidenceView.target === 'formal' ? '正式 run' : '候选'}身份的程序采集记录${connected ? '' : '（最近快照；当前离线）'}。以下 tick 与路径均为原导出返回值。`
      : '历史程序采集记录：服务实例或运行/候选身份已变化；以下路径与原 tick 不代表当前一轮。');
    byId('evidence-identity').hidden = false;
    text('evidence-result', json({ exportIdentity: { serverInstanceId: evidenceView.serverInstanceId, target: evidenceView.target,
      targetRunId: evidenceView.targetRunId, targetCandidateId: evidenceView.targetCandidateId }, nodeExportResult: evidenceView.result }));
    byId('evidence-result').hidden = false;
  }
  async function exportEvidence(body) {
    const runId = body.target === 'formal' ? snapshot?.run?.context?.runId ?? null : null;
    const targetCandidateId = body.target === 'candidate' ? body.candidateId : null;
    const instanceId = serverInstanceId;
    text('evidence-state', '正在请求 Node 导出真实运行记录；当前作品与表单保留。');
    const response = await perform('/api/evidence', body, null, true);
    if (!response) {
      setRetry({ path: '/api/evidence', body });
      if (retryRequest) { retryRequest.runId = runId; retryRequest.serverInstanceId = instanceId; }
      text('evidence-state', '证据导出失败或结果未知。当前作品和未提交表单保留；可重试该导出，或取消待重试请求。');
      return;
    }
    const r = response.result ?? {};
    evidenceView = { serverInstanceId: instanceId, target: body.target, targetRunId: runId, targetCandidateId,
      result: { runPath: r.runPath, proofPath: r.proofPath, runId: r.runId,
        exportedTick: r.exportedTick, currentTick: r.currentTick, existing: r.existing } };
    renderEvidence();
    text('evidence-state', r.existing ? `Node 返回原有证据包，原导出 tick ${r.exportedTick}；请求返回时 tick ${r.currentTick}。旧包未被覆盖；新证据需开始新 run。` : 'Node 已返回该请求身份的真实运行记录引用。当前或历史身份见下方标记；不代表作品已保存、浏览器环境已认证或真人通关。');
    message('程序采集记录导出请求已完成；路径仅展示 Node 固定目录返回值，页面不读取或回调路径。');
  }
  byId('export-formal').addEventListener('click', () => exportEvidence({ target: 'formal' }));
  byId('export-candidate').addEventListener('click', () => { const c = candidate(); if (c) void exportEvidence({ target: 'candidate', candidateId: c.candidateId }); });
  byId('retry-action').addEventListener('click', async () => {
    const retry = retryRequest;
    if (!retry) return;
    if (retry.path === '/api/evidence') {
      const differentRun = retry.body.target === 'formal' && retry.runId !== snapshot?.run?.context?.runId;
      if (retry.serverInstanceId !== serverInstanceId || differentRun) {
        text('evidence-state', '该待重试导出对应的服务实例或正式 run 已改变。为避免导出另一轮，请取消旧重试，再明确选择当前证据导出。');
        message('旧证据请求未重放。请取消待重试请求，再明确选择当前一轮。');
        return;
      }
      await exportEvidence(retry.body);
    } else await perform(retry.path, retry.body, '原请求已安全重试；结果以 Node 快照为准。', true);
  });
  byId('cancel-retry').addEventListener('click', () => {
    if (retryRequest?.path === '/api/evidence') text('evidence-state', '已取消证据导出的重试意图；当前作品和表单保留。已生成的证据不会被删除。');
    setRetry(null); message('已取消待重试请求。服务器若已接收请求，其真实结果仍以快照为准。');
  });
  byId('catalog-confirm').addEventListener('change', renderControls);
  byId('catalog-reset').addEventListener('click', async () => {
    if (!byId('catalog-confirm').checked) return;
    clearInput();
    const result = await perform('/api/catalog', { catalogId: byId('catalog-select').value, confirmReset: true }, '已明确重置为受控验证场景。作品仅驻留 Node 内存；未执行保存。');
    if (result) { byId('catalog-confirm').checked = false; byId('view-source').value = 'document'; selectedEvent = null; previewId = null; previewResponse = null; buildFields(); render(); }
  });
  byId('verification-disconnect').addEventListener('click', () => perform('/api/verification', { incident: 'simulated_connection_loss' }, '验证模式已请求模拟连接中断；恢复需手动重连。'));
  for (const name of ['goal', 'speed', 'theme']) byId(`candidate-${name}-on`).addEventListener('change', renderControls);
  let parentOptionsKey = '';
  function renderRealAI() {
    const r = snapshot?.realAI;
    byId('real-ai-panel').hidden = !r;
    if (!r) return;
    text('real-ai-state', json({slotId:r.slotId,intent:r.intent,status:r.status,error:r.error,participantId:r.participantId,participantRole:r.participantRole,budget:r.budget,startedAt:r.startedAt,responseCompletedAt:r.responseCompletedAt,humanDecision:r.humanDecision}));
    text('real-ai-response', r.response ? json(r.response) : '尚无当前可用结果；等待、失败、过期或取消均不算通过。');
    byId('real-ai-send').disabled = !connected || busy > 0 || r.status !== 'ready' || !snapshot?.authority?.adultEnabled;
    byId('real-ai-cancel').disabled = !connected || !['pending','answered','validation_pending','proposed','validation_blocked'].includes(r.status);
    byId('real-ai-record').disabled = !connected || busy > 0 || !r.response || !r.participantId;
    const choices = r.parentOptions ?? [];
    byId('real-ai-child-fields').hidden = !choices.length;
    if (json(choices) !== parentOptionsKey) { parentOptionsKey = json(choices); byId('real-ai-parent-option').replaceChildren(...choices.map(o => {const e=document.createElement('option'); e.value=o.id; e.textContent=o.label+'：'+o.rationale; return e;})); byId('real-ai-direction-class').value = /^R0-AI-11-/.test(r.slotId) ? 'minimal_change' : /^R0-AI-10-/.test(r.slotId) ? 'time' : 'layout'; }
    byId('real-ai-frozen-run').hidden = !/^R0-AI-11-.*-I$/.test(r.slotId);
    byId('real-ai-frozen-run').disabled = !connected || busy > 0 || r.status !== 'ready';
    byId('real-ai-retry').hidden = r.status !== 'retryable_zero_attempt';
    byId('real-ai-advance-child').hidden = !/^R0-AI-(09|10|11)-R[12]-I$/.test(r.slotId) || !r.response || !['directions','explain'].includes(r.response.kind);
    byId('real-ai-advance-child').disabled = !connected || busy > 0;
    byId('real-ai-recheck').hidden = !/^R0-AI-11-R[12]-F$/.test(r.slotId);
    byId('real-ai-recheck').disabled = !connected || busy > 0 || candidate()?.state !== 'applied';
    const canDispose = r.slotId.endsWith('-F') || /^R0-AI-(09|10|11)-R[12]-I$/.test(r.slotId) && !!r.response;
    byId('real-ai-dispose').hidden = !canDispose;
    byId('real-ai-dispose-reason').hidden = !canDispose;
    byId('candidate-form').hidden = true;
    byId('catalog-reset').disabled = true;
  }
  byId('real-ai-send').addEventListener('click', () => {
    const r = snapshot?.realAI; if (!r) return;
    const needsEvents = /^R0-AI-11-/.test(r.slotId) && /-I$/.test(r.slotId);
    if (needsEvents && !selectedEvent) { message('先主动选择本次真实run的一条必要事件。没有实际事件不能发送解释。'); return; }
    const opts = r.parentOptions ?? [];
    const choice = opts.length ? {optionId:byId('real-ai-parent-option').value,rationale:byId('real-ai-rationale').value,directionClass:byId('real-ai-direction-class').value,witnessRef:byId('real-ai-witness').value} : undefined;
    void perform('/api/real-ai/request', {eventIds:needsEvents ? [selectedEvent] : [], ...(choice ? {choice} : {})}, '真实请求已返回；请先核对内容，候选仍需真实试跑和你的确认。');
  });
  byId('real-ai-frozen-run').addEventListener('click', () => void perform('/api/real-ai/frozen-run', {}, '已运行冻结输入生成真实证据；请主动选中必要事件，尚未调用模型。'));
  byId('real-ai-recheck').addEventListener('click', async () => {const r=await perform('/api/real-ai/recheck', {}, '冻结输入已在确认后的新版本真实执行；不自动评价改善。'); if(r){byId('view-source').value='run';selectedEvent=null;render();}});
  byId('real-ai-advance-child').addEventListener('click', () => void perform('/api/real-ai/advance-child', {}, '已进入同一Host的后续准备；尚未发送新请求，请提供真实选择与见证。'));
  byId('real-ai-retry').addEventListener('click', () => void perform('/api/real-ai/retry', {}, '显式重提已返回；只允许原身份且未发生发送的失败。'));
  byId('real-ai-dispose').addEventListener('click', () => void perform('/api/real-ai/dispose-child', {reason:byId('real-ai-dispose-reason').value,...(byId('real-ai-witness').value ? {witnessRef:byId('real-ai-witness').value} : {})}, '子步骤阻塞记录已返回，未因此减少原分母。'));
  byId('real-ai-cancel').addEventListener('click', () => void perform('/api/real-ai/cancel', {}, '已请求取消；未知费用仍保留预留，旧结果不能复活。', false, true));
  byId('real-ai-record').addEventListener('click', () => {
    const rationale = byId('real-ai-rationale').value;
    if (!rationale.trim()) { message('请写下判断依据；不代填人的判断。'); return; }
    void perform('/api/real-ai/decision', {decision:byId('real-ai-author-choice').value,semantic:byId('real-ai-semantic').value,rationale,...(byId('real-ai-witness').value ? {witnessRef:byId('real-ai-witness').value} : {})}, '已记录内部开发者的自述判断；不自动应用候选或生成独立使用证据。');
  });
  buildFields();
  draw();
  void connect();
})();
