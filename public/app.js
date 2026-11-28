const $ = (selector) => document.querySelector(selector);
const els = {
  main: $("#main"), welcome: $("#welcome"), conversation: $("#conversation"), messageList: $("#messageList"),
  working: $("#workingIndicator"), composer: $("#composer"), prompt: $("#promptInput"), send: $("#sendButton"), stop: $("#stopButton"),
  title: $("#threadTitle"), statusText: $("#statusText"), statusDot: $("#statusDot"), drawerDot: $("#drawerStatusDot"),
  drawer: $("#sessionDrawer"), scrim: $("#scrim"), threadList: $("#threadList"), homeThreadList: $("#homeThreadList"),
  hostCwd: $("#hostCwd"), homeCwd: $("#homeCwd"), homeStatus: $("#homeStatus"), sessionCount: $("#sessionCount"), hostName: $("#hostName"),
  providerStatusList: $("#providerStatusList"), homeAgentTabs: $("#homeAgentTabs"), drawerAgentTabs: $("#drawerAgentTabs"),
  agentPickerSection: $("#agentPickerSection"), newThreadAgentTabs: $("#newThreadAgentTabs"), selectedAgentHint: $("#selectedAgentHint"),
  newSheet: $("#newThreadSheet"), approvalSheet: $("#approvalSheet"), approvalContent: $("#approvalContent"),
  pairing: $("#pairingSheet"), tokenInput: $("#tokenInput"), pairingError: $("#pairingError"), pairButton: $("#pairButton"),
  cwd: $("#cwdInput"), model: $("#modelSelect"), effort: $("#effortSelect"), approval: $("#approvalSelect"), sandbox: $("#sandboxSelect"),
  unsafeWarning: $("#unsafeWarning"), createThread: $("#createThreadButton"), toast: $("#toast"),
};

const state = {
  token: "", connected: false, codexReady: false, transportSecure: true, cwd: "",
  providers: {
    codex: { enabled: true, ready: false, error: null, label: "Codex" },
    antigravity: { enabled: false, ready: false, error: null, label: "Antigravity" },
  },
  filterProvider: "all",
  newThreadProvider: "codex",
  threadsByProvider: { codex: [], antigravity: [] },
  nextCursorByProvider: { codex: null, antigravity: null },
  errorsByProvider: { codex: "", antigravity: "" },
  listRequestByProvider: { codex: 0, antigravity: 0 },
  models: [], current: null, writerLocked: false, subscribedCodexThreadId: null,
  items: new Map(), itemOrder: [], pending: new Map(), activeTurnId: null, busy: false,
  questionDrafts: new Map(),
  selectedEffort: "", eventAbort: null, reconnectTimer: null,
  eventTransport: "sse", eventCursor: 0, eventSession: null,
  finishedTurnId: null, sending: false, opening: false, pendingRevision: 0,
};

bindUi();
syncViewportHeight();
boot();

async function boot() {
  const fragmentToken = new URLSearchParams(location.hash.slice(1)).get("token");
  if (fragmentToken) {
    localStorage.setItem("remoteCodexToken", fragmentToken);
    history.replaceState(null, "", `${location.pathname}${location.search}`);
  }
  state.token = fragmentToken || localStorage.getItem("remoteCodexToken") || "";
  if (!state.token) return showPairing();
  await connect();
}

function bindUi() {
  $("#sessionsButton").addEventListener("click", handlePrimaryNavButton);
  $("#threadHeading").addEventListener("click", openDrawer);
  $("#viewAllThreadsButton").addEventListener("click", openDrawer);
  $("#closeDrawerButton").addEventListener("click", closeOverlays);
  window.addEventListener("popstate", handlePopState);
  $("#newThreadButton").addEventListener("click", openNewThread);
  $("#drawerNewButton").addEventListener("click", openNewThread);
  $("#welcomeStartButton").addEventListener("click", openNewThread);
  $("#disconnectButton").addEventListener("click", disconnect);
  els.scrim.addEventListener("click", closeOverlays);
  document.querySelectorAll(".sheet-close").forEach((button) => button.addEventListener("click", closeOverlays));
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.addEventListener("click", () => setFilterProvider(button.dataset.filter));
  });
  document.querySelectorAll("[data-agent]").forEach((button) => {
    button.addEventListener("click", () => setNewThreadProvider(button.dataset.agent));
  });
  els.pairButton.addEventListener("click", pair);
  els.tokenInput.addEventListener("keydown", (event) => { if (event.key === "Enter") pair(); });
  els.createThread.addEventListener("click", createThread);
  els.sandbox.addEventListener("change", () => els.unsafeWarning.classList.toggle("hidden", els.sandbox.value !== "danger-full-access"));
  els.send.addEventListener("click", sendPrompt);
  els.stop.addEventListener("click", stopTurn);
  els.prompt.addEventListener("input", resizePrompt);
  els.prompt.addEventListener("focus", () => requestAnimationFrame(scrollToLatest));
  els.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      sendPrompt();
    }
  });
  window.addEventListener("online", () => state.token && connectEvents());
  window.addEventListener("resize", syncViewportHeight, { passive: true });
  window.addEventListener("orientationchange", syncViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("resize", syncViewportHeight, { passive: true });
  window.visualViewport?.addEventListener("scroll", syncViewportHeight, { passive: true });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.token) refreshAll(false); });
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
}

async function pair() {
  const value = els.tokenInput.value.trim();
  if (!value) return setPairingError("请输入配对令牌");
  state.token = value;
  els.pairButton.disabled = true;
  setPairingError("");
  const ok = await connect();
  els.pairButton.disabled = false;
  if (ok) localStorage.setItem("remoteCodexToken", value);
}

async function connect() {
  try {
    const status = await api("/api/status");
    state.connected = true;
    state.codexReady = status.codexReady;
    syncProviders(status);
    state.transportSecure = status.transportSecure;
    state.eventTransport = status.eventTransport || "sse";
    if (state.eventSession !== status.eventSession) {
      state.eventSession = status.eventSession;
      state.eventCursor = status.eventCursor || 0;
    }
    state.cwd = status.cwd || "";
    els.cwd.value ||= state.cwd;
    els.hostCwd.textContent = state.cwd || "未设置工作目录";
    els.homeCwd.textContent = state.cwd || "未设置工作目录";
    els.pairing.classList.add("hidden");
    updateConnectionUi();
    if (!state.transportSecure && !sessionStorage.getItem("remoteCodexHttpWarning")) {
      sessionStorage.setItem("remoteCodexHttpWarning", "1");
      toast("当前为明文局域网连接，请勿在公共 Wi-Fi 使用");
    }
    await refreshAll(true);
    connectEvents();
    return true;
  } catch (error) {
    state.connected = false;
    updateConnectionUi();
    showPairing();
    setPairingError(error.message === "配对令牌无效" ? error.message : `连接失败：${error.message}`);
    return false;
  }
}

function enabledProviders() {
  return ["codex", "antigravity"].filter((name) => state.providers[name]?.enabled);
}

function isDualMode() {
  return enabledProviders().length > 1;
}

function providerLabel(provider) {
  return provider === "antigravity" ? "Antigravity" : "Codex";
}

function currentProvider() {
  return state.current?.provider || state.newThreadProvider || enabledProviders()[0] || "codex";
}

function isCurrentAntigravity() {
  return currentProvider() === "antigravity";
}

function syncProviders(status) {
  if (status.providers) {
    state.providers = status.providers;
  } else {
    const single = status.provider === "antigravity" ? "antigravity" : "codex";
    state.providers = {
      codex: { enabled: single === "codex", ready: single === "codex" && Boolean(status.codexReady), error: status.error || null, label: "Codex" },
      antigravity: { enabled: single === "antigravity", ready: single === "antigravity" && Boolean(status.codexReady), error: status.error || null, label: "Antigravity" },
    };
  }
  const enabled = enabledProviders();
  if (state.current && !state.providers[state.current.provider]?.enabled) {
    state.current = null;
    state.writerLocked = false;
    state.activeTurnId = null;
    els.title.textContent = "Remote Codex";
    els.welcome.classList.remove("hidden");
    els.conversation.classList.add("hidden");
    els.composer.classList.add("hidden");
    setBusy(false);
  }
  if (state.filterProvider !== "all" && !state.providers[state.filterProvider]?.enabled) {
    state.filterProvider = enabled.length > 1 ? "all" : (enabled[0] || "codex");
  }
  if (!state.providers[state.newThreadProvider]?.enabled) {
    state.newThreadProvider = enabled.find((name) => state.providers[name]?.ready) || enabled[0] || "codex";
  } else if (!state.providers[state.newThreadProvider]?.ready) {
    const readyAlt = enabled.find((name) => state.providers[name]?.ready);
    if (readyAlt && !state.current) state.newThreadProvider = readyAlt;
  }

  const dual = isDualMode();
  els.homeAgentTabs.classList.toggle("hidden", !dual);
  els.drawerAgentTabs.classList.toggle("hidden", !dual);
  els.agentPickerSection.classList.toggle("hidden", !dual);
  els.providerStatusList.classList.toggle("hidden", !dual);

  const hostTitle = dual ? "本机 Codex + Antigravity" : `本机 ${providerLabel(enabled[0] || "codex")}`;
  els.hostName.textContent = $("#homeHostName").textContent = hostTitle;

  renderProviderStatusBadges();
  syncFilterTabsUi();
  syncNewThreadFormUi();
  syncConversationAgentUi();
}

function renderProviderStatusBadges() {
  els.providerStatusList.replaceChildren();
  for (const name of enabledProviders()) {
    const info = state.providers[name];
    const badge = node("span", `provider-badge${info.ready ? " ready" : ""}`);
    badge.append(node("i"), document.createTextNode(`${info.label} ${info.ready ? "已就绪" : "未就绪"}`));
    if (info.error) badge.title = info.error;
    els.providerStatusList.append(badge);
  }
}

function setFilterProvider(filter) {
  state.filterProvider = filter;
  syncFilterTabsUi();
  if (filter !== "all" && !state.threadsByProvider[filter].length) {
    loadProviderThreads(filter, null, true).catch(() => {});
  }
  renderThreads();
}

function syncFilterTabsUi() {
  document.querySelectorAll("[data-filter]").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === state.filterProvider);
  });
}

function setNewThreadProvider(provider) {
  if (!state.providers[provider]?.enabled) return;
  state.newThreadProvider = provider;
  syncNewThreadFormUi();
  if (provider === "codex" && !state.models.length && state.providers.codex?.ready) {
    loadModels().catch(() => {});
  }
}

function syncNewThreadFormUi() {
  const antigravity = state.newThreadProvider === "antigravity";
  document.querySelectorAll("[data-agent]").forEach((button) => {
    button.classList.toggle("active", button.dataset.agent === state.newThreadProvider);
  });
  $("#codexModelFields").classList.toggle("hidden", antigravity);
  $("#codexPermissionFields").classList.toggle("hidden", antigravity);
  $("#antigravitySettingsHint").classList.toggle("hidden", !antigravity);
  const info = state.providers[state.newThreadProvider];
  const hint = !info?.ready && info?.error ? `${info.label} 当前未就绪：${info.error}（点击创建将尝试重新连接）` : "";
  els.selectedAgentHint.textContent = hint;
  els.selectedAgentHint.classList.toggle("hidden", !hint);
}

function syncConversationAgentUi() {
  const label = providerLabel(currentProvider());
  $("#workingLabel").textContent = `${label} 正在工作`;
  els.prompt.placeholder = `给 ${label} 一个任务…`;
  updateComposerHint();
}

async function refreshAll(initial = false) {
  if (!state.token) return;
  const tasks = [refreshThreads(), loadPending()];
  if (state.current) tasks.push(refreshCurrentThread());
  if (state.providers.codex?.enabled && state.providers.codex?.ready && (initial || !state.models.length)) {
    tasks.push(loadModels());
  }
  await Promise.allSettled(tasks);
}

async function loadModels() {
  const result = await rpc("model/list", { limit: 100, includeHidden: false }, "codex");
  state.models = (result?.data || []).filter((model) => !model.hidden);
  const selected = els.model.value;
  els.model.replaceChildren(option("", "跟随 Codex 默认"));
  for (const model of state.models) els.model.append(option(model.model || model.id, model.displayName || model.model));
  if ([...els.model.options].some((item) => item.value === selected)) els.model.value = selected;
}

async function loadProviderThreads(provider, cursor = null, forceTry = false) {
  const info = state.providers[provider];
  if (!info?.enabled) return;
  if (!info.ready && !forceTry) {
    state.errorsByProvider[provider] = info.error || `${info.label} 未就绪`;
    renderThreads();
    return;
  }
  const request = ++state.listRequestByProvider[provider];
  try {
    const result = await rpc("thread/list", {
      limit: 100, sortKey: "updated_at", sortDirection: "desc", ...(cursor ? { cursor } : {}),
    }, provider);
    if (request !== state.listRequestByProvider[provider]) return;
    const existing = cursor ? state.threadsByProvider[provider] : [];
    const merged = new Map(existing.map((thread) => [thread.id, thread]));
    for (const thread of result?.data || []) {
      merged.set(thread.id, { ...thread, provider });
    }
    state.threadsByProvider[provider] = [...merged.values()];
    state.nextCursorByProvider[provider] = result?.nextCursor || null;
    state.errorsByProvider[provider] = "";
    if (state.providers[provider]) {
      state.providers[provider].ready = true;
      state.providers[provider].error = null;
      renderProviderStatusBadges();
      updateConnectionUi();
    }
    renderThreads();
  } catch (error) {
    if (request !== state.listRequestByProvider[provider]) return;
    state.errorsByProvider[provider] = error.message;
    renderThreads();
  }
}

async function refreshThreads() {
  await Promise.allSettled(enabledProviders().map((provider) => loadProviderThreads(provider)));
}

function visibleThreads() {
  if (state.filterProvider !== "all") {
    return state.threadsByProvider[state.filterProvider] || [];
  }
  const combined = enabledProviders().flatMap((provider) => state.threadsByProvider[provider] || []);
  return combined.sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
}

async function loadPending() {
  const revision = state.pendingRevision;
  const result = await api("/api/pending");
  if (revision !== state.pendingRevision) return;
  state.pending.clear();
  for (const request of result.data || []) state.pending.set(String(request.id), request);
  renderApproval();
}

function connectEvents() {
  clearTimeout(state.reconnectTimer);
  state.eventAbort?.abort();
  state.eventAbort = new AbortController();
  const receive = state.eventTransport === "poll" ? pollEvents : streamEvents;
  receive(state.eventAbort.signal).catch((error) => {
    if (error.name === "AbortError" || !state.token) return;
    state.connected = false;
    updateConnectionUi();
    state.reconnectTimer = setTimeout(() => connect().catch(() => {}), 1600);
  });
}

async function streamEvents(signal) {
  const response = await fetch("/api/events", { headers: authHeaders(), cache: "no-store", signal });
  if (!response.ok) throw await apiError(response);
  state.connected = true;
  updateConnectionUi();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) throw new Error("事件连接已关闭");
    buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
      if (data) handleBridgeEvent(JSON.parse(data));
    }
  }
}

async function pollEvents(signal) {
  while (!signal.aborted) {
    const response = await fetch(`/api/events/poll?after=${state.eventCursor}`, {
      headers: authHeaders(),
      cache: "no-store",
      signal,
    });
    if (!response.ok) throw await apiError(response);
    const payload = await response.json();
    state.connected = true;
    updateConnectionUi();
    const wasTruncated = Boolean(payload.truncated);
    for (const event of payload.data || []) {
      state.eventCursor = Math.max(state.eventCursor, event.seq || 0);
      handleBridgeEvent(event);
    }
    state.eventCursor = Math.max(state.eventCursor, payload.cursor || 0);
    if (wasTruncated) refreshAll(false);
  }
}

function handleBridgeEvent(event) {
  if (event.kind === "connected") {
    if (event.message?.providers) syncProviders({ providers: event.message.providers });
    state.codexReady = Boolean(event.message?.codexReady);
    return updateConnectionUi();
  }
  if (event.kind === "bridge") {
    if (event.message?.providers) {
      syncProviders({ providers: event.message.providers });
      state.codexReady = enabledProviders().some((name) => state.providers[name]?.ready);
    } else {
      state.codexReady = event.message.status === "ready";
    }
    if (event.message.status === "ready" && event.message.provider) {
      loadProviderThreads(event.message.provider).catch(() => {});
    }
    if (event.message.error) toast(`${providerLabel(event.message.provider)}: ${event.message.error}`);
    return updateConnectionUi();
  }
  if (event.kind === "serverRequest") {
    state.pendingRevision++;
    state.pending.set(String(event.message.id), event.message);
    return renderApproval();
  }
  if (event.kind === "requestResolved") {
    state.pendingRevision++;
    state.pending.delete(String(event.message.id));
    return renderApproval();
  }
  if (event.kind === "notification") handleNotification(event.message);
}

function handleNotification({ provider = "codex", method, params = {} }) {
  if (method === "turn/started" && isCurrent(params.threadId, provider)) {
    state.activeTurnId = params.turn?.id || state.activeTurnId;
    setBusy(true);
  } else if (method === "turn/completed" && isCurrent(params.threadId, provider)) {
    state.finishedTurnId = params.turn?.id;
    setBusy(false);
    state.activeTurnId = null;
    if (params.turn?.status === "failed" || (params.turn?.status === "declined" && params.turn?.error?.message)) {
      toast(params.turn.error?.message || "任务执行失败");
    }
    loadProviderThreads(provider).catch(() => {});
  } else if (method === "item/started" && isCurrent(params.threadId, provider)) {
    upsertItem(params.item);
  } else if (method === "item/completed" && isCurrent(params.threadId, provider)) {
    upsertItem(params.item);
  } else if (method === "item/agentMessage/delta" && isCurrent(params.threadId, provider)) {
    const item = state.items.get(params.itemId) || { id: params.itemId, type: "agentMessage", text: "", provider };
    item.text = `${item.text || ""}${params.delta || ""}`;
    upsertItem(item);
  } else if (method === "item/commandExecution/outputDelta" && isCurrent(params.threadId, provider)) {
    const item = state.items.get(params.itemId);
    if (item) { item.aggregatedOutput = `${item.aggregatedOutput || ""}${params.delta || ""}`; upsertItem(item); }
  } else if (method === "thread/name/updated") {
    loadProviderThreads(provider).catch(() => {});
    if (isCurrent(params.threadId, provider) && params.name) { state.current.name = params.name; els.title.textContent = params.name; }
  } else if (method === "error" && (!params.threadId || isCurrent(params.threadId, provider))) {
    toast(params.error?.message || params.message || `${providerLabel(provider)} 返回了错误`);
  }
}

function isCurrent(threadId, provider) {
  if (!state.current || state.current.id !== threadId) return false;
  return !provider || state.current.provider === provider;
}

function isActiveWriterError(error) {
  return /already has an active writer/i.test(error?.message || "");
}

async function releaseCodexWriter(exceptThreadId = null) {
  const held = state.subscribedCodexThreadId;
  if (!held || held === exceptThreadId) return;
  if (isCurrent(held, "codex") && state.busy) return;
  state.subscribedCodexThreadId = null;
  await rpc("thread/unsubscribe", { threadId: held }, "codex").catch(() => {});
}

async function fetchThread(thread) {
  const provider = thread.provider || "codex";
  if (provider === "antigravity") {
    await releaseCodexWriter(null);
    const result = await rpc("thread/resume", {
      threadId: thread.id,
      ...(thread.cwd ? { cwd: thread.cwd } : {}),
    }, "antigravity");
    return { result, writerLocked: false, provider };
  }

  await releaseCodexWriter(thread.id);
  try {
    const result = await rpc("thread/resume", { threadId: thread.id }, "codex");
    state.subscribedCodexThreadId = thread.id;
    return { result, writerLocked: false, provider };
  } catch (error) {
    if (!isActiveWriterError(error)) throw error;
    const result = await rpc("thread/read", { threadId: thread.id, includeTurns: true }, "codex");
    return { result, writerLocked: true, provider };
  }
}

function upsertItem(item, shouldRender = true) {
  if (!item?.id) return;
  if (!state.items.has(item.id)) state.itemOrder.push(item.id);
  state.items.set(item.id, item);
  if (shouldRender) renderMessages();
}

function applyThreadResult(result, provider, { resetScroll = false, writerLocked = false } = {}) {
  state.current = { ...result.thread, provider };
  state.writerLocked = writerLocked;
  state.activeTurnId = null;
  if (result.reasoningEffort !== undefined) state.selectedEffort = result.reasoningEffort || "";
  state.items.clear();
  state.itemOrder = [];
  for (const turn of result.thread?.turns || []) {
    for (const item of turn.items || []) upsertItem({ ...item, provider }, false);
    if (turn.status === "inProgress" && !writerLocked) state.activeTurnId = turn.id;
  }
  els.title.textContent = result.thread?.name || result.thread?.preview || "未命名会话";
  syncConversationAgentUi();
  setBusy(!writerLocked && (result.thread?.status?.type === "active" || Boolean(state.activeTurnId)));
  renderMessages(resetScroll);
}

async function refreshCurrentThread() {
  if (!state.current || state.opening) return;
  const snapshotThread = { ...state.current };
  const { result, writerLocked, provider } = await fetchThread(snapshotThread);
  if (!isCurrent(snapshotThread.id, provider)) return;
  applyThreadResult(result, provider, { resetScroll: false, writerLocked });
  renderThreads();
}

async function openThread(thread) {
  if (state.opening) return;
  state.opening = true;
  closeOverlays();
  updateSendButton();
  try {
    const { result, writerLocked, provider } = await fetchThread(thread);
    applyThreadResult(result, provider, { resetScroll: true, writerLocked });
    showConversation();
    renderThreads();
  } catch (error) {
    toast(error.message);
  } finally {
    state.opening = false;
    updateSendButton();
  }
}

function openNewThread() {
  closeOverlays();
  els.cwd.value ||= state.cwd;
  if (state.filterProvider !== "all" && state.providers[state.filterProvider]?.enabled) {
    state.newThreadProvider = state.filterProvider;
  } else if (state.current?.provider && state.providers[state.current.provider]?.enabled) {
    state.newThreadProvider = state.current.provider;
  }
  syncNewThreadFormUi();
  els.newSheet.classList.remove("hidden");
}

async function createThread() {
  const cwd = els.cwd.value.trim();
  if (!cwd) return toast("请输入电脑上的工作目录");
  const provider = state.newThreadProvider;
  const antigravity = provider === "antigravity";
  els.createThread.disabled = true;
  els.createThread.textContent = "正在创建…";
  try {
    await releaseCodexWriter(null);
    const params = {
      cwd,
      ...(!antigravity && {
        approvalPolicy: els.approval.value,
        sandbox: els.sandbox.value,
        ...(els.model.value ? { model: els.model.value } : {}),
      }),
    };
    const result = await rpc("thread/start", params, provider);
    state.current = { ...result.thread, provider };
    state.writerLocked = false;
    state.subscribedCodexThreadId = provider === "codex" ? result.thread?.id || null : null;
    state.selectedEffort = antigravity ? "" : els.effort.value;
    state.items.clear();
    state.itemOrder = [];
    state.activeTurnId = null;
    syncConversationAgentUi();
    setBusy(false);
    els.title.textContent = "新会话";
    showConversation();
    closeOverlays();
    await loadProviderThreads(provider, null, true);
    if (window.matchMedia("(min-width: 760px)").matches) els.prompt.focus();
  } catch (error) {
    toast(error.message);
  } finally {
    els.createThread.disabled = false;
    els.createThread.textContent = "创建会话";
  }
}

async function ensureWritableCodexThread(threadId) {
  if (state.writerLocked) {
    try {
      await rpc("thread/resume", { threadId }, "codex");
      state.writerLocked = false;
      state.subscribedCodexThreadId = threadId;
      updateComposerHint();
      return threadId;
    } catch (error) {
      if (!isActiveWriterError(error)) throw error;
      return forkLockedCodexThread(threadId);
    }
  }
  return threadId;
}

async function forkLockedCodexThread(threadId) {
  const forked = await rpc("thread/fork", { threadId }, "codex");
  const newId = forked.thread.id;
  state.current = { ...state.current, ...forked.thread, id: newId, provider: "codex" };
  state.writerLocked = false;
  state.subscribedCodexThreadId = newId;
  els.title.textContent = forked.thread?.name || state.current.name || state.current.preview || "分叉会话";
  updateComposerHint();
  loadProviderThreads("codex").catch(() => {});
  toast("电脑端正占用原会话，已自动分叉继续");
  return newId;
}

async function sendPrompt() {
  const text = els.prompt.value.trim();
  if (!text || els.send.disabled) return;
  const sent = await submitPromptText(text);
  if (sent) {
    els.prompt.value = "";
    resizePrompt();
  }
}

async function submitPromptText(text) {
  const value = String(text || "").trim();
  if (!value || els.send.disabled) return false;
  if (!state.current) {
    openNewThread();
    return false;
  }
  state.sending = true;
  updateSendButton();
  const provider = state.current.provider || "codex";
  let threadId = state.current.id;
  try {
    const input = [{ type: "text", text: value }];
    if (provider === "codex" && state.busy && state.activeTurnId) {
      await rpc("turn/steer", { threadId, input, expectedTurnId: state.activeTurnId }, "codex");
      toast("已插入当前任务");
    } else {
      if (provider === "codex") {
        threadId = await ensureWritableCodexThread(threadId);
      }
      const startParams = {
        threadId,
        input,
        ...(provider === "codex" && state.selectedEffort ? { effort: state.selectedEffort } : {}),
      };
      let result;
      try {
        result = await rpc("turn/start", startParams, provider);
      } catch (error) {
        if (provider === "codex" && isActiveWriterError(error)) {
          threadId = await forkLockedCodexThread(threadId);
          result = await rpc("turn/start", { ...startParams, threadId }, "codex");
        } else {
          throw error;
        }
      }
      if (isCurrent(threadId, provider) && result.turn?.id !== state.finishedTurnId) {
        state.activeTurnId = result.turn?.id || null;
        setBusy(true);
      }
    }
    return true;
  } catch (error) {
    toast(error.message);
    return false;
  } finally {
    state.sending = false;
    updateSendButton();
  }
}

async function stopTurn() {
  if (!state.current || !state.activeTurnId) return;
  els.stop.disabled = true;
  try {
    await rpc("turn/interrupt", { threadId: state.current.id, turnId: state.activeTurnId }, state.current.provider);
  } catch (error) {
    toast(error.message);
  } finally {
    els.stop.disabled = false;
  }
}

function activeFilterErrors() {
  const targets = state.filterProvider === "all" ? enabledProviders() : [state.filterProvider];
  return targets
    .filter((provider) => state.errorsByProvider[provider] && !state.threadsByProvider[provider]?.length)
    .map((provider) => `${providerLabel(provider)}: ${state.errorsByProvider[provider]}`);
}

function renderThreads() {
  els.threadList.replaceChildren();
  els.homeThreadList.replaceChildren();
  const threads = visibleThreads();
  els.sessionCount.textContent = `${threads.length} 个会话`;

  const errors = activeFilterErrors();
  if (errors.length && !threads.length) {
    const message = errors.join("；");
    for (const list of [els.threadList, els.homeThreadList]) list.append(node("div", "thread-empty", message));
    return;
  }
  if (!threads.length) {
    els.threadList.append(node("div", "thread-empty", "还没有会话，先创建一个吧"));
    els.homeThreadList.append(node("div", "thread-empty", "还没有会话"));
    return;
  }
  for (const thread of threads) els.threadList.append(threadButton(thread));
  for (const thread of threads.slice(0, 20)) els.homeThreadList.append(threadButton(thread));

  const cursors = (state.filterProvider === "all" ? enabledProviders() : [state.filterProvider])
    .filter((provider) => state.nextCursorByProvider[provider]);
  if (cursors.length) {
    const more = node("button", "text-button", "加载更多会话");
    more.type = "button";
    more.addEventListener("click", async () => {
      more.disabled = true;
      await Promise.allSettled(cursors.map((provider) => loadProviderThreads(provider, state.nextCursorByProvider[provider], true)));
      more.disabled = false;
    });
    els.threadList.append(more);
  }
}

function renderMessages(forceScroll = false) {
  const shouldStick = forceScroll || isNearBottom();
  const openIds = new Set(
    [...els.messageList.querySelectorAll("details[data-item-id]")].filter((el) => el.open).map((el) => el.dataset.itemId),
  );
  els.messageList.replaceChildren();
  for (const id of state.itemOrder) {
    const item = state.items.get(id);
    const element = itemElement(item);
    if (!element) continue;
    element.dataset.itemId = id;
    if (openIds.has(id) && "open" in element) element.open = true;
    els.messageList.append(element);
  }
  if (!els.messageList.childElementCount) {
    els.messageList.append(node("div", "thread-empty", "还没有消息，在下方输入任务开始对话"));
  }
  if (shouldStick) requestAnimationFrame(scrollToLatest);
}

function threadButton(thread) {
  const active = isCurrent(thread.id, thread.provider);
  const button = node("button", `thread-item${active ? " active" : ""}`);
  button.type = "button";
  const main = node("span", "thread-row-main");
  main.append(node("strong", "thread-row-title", thread.name || thread.preview || "未命名会话"));
  const meta = node("span", "thread-row-meta");
  if (isDualMode()) {
    meta.append(node("span", `thread-agent-pill${thread.provider === "antigravity" ? " antigravity" : ""}`, providerLabel(thread.provider)));
  }
  meta.append(document.createTextNode(`${shortPath(thread.cwd)} · ${relativeTime(thread.updatedAt)}`));
  main.append(meta);
  const side = node("span", "thread-row-side");
  if (thread.status?.type === "active") side.append(node("span", "thread-status", "运行中"));
  side.append(node("span", "thread-chevron", "›"));
  button.append(main, side);
  button.addEventListener("click", () => openThread(thread));
  return button;
}

function isNearBottom() {
  return els.main.scrollHeight - els.main.scrollTop - els.main.clientHeight < 150;
}

function scrollToLatest() {
  els.main.scrollTop = els.main.scrollHeight;
}

function itemElement(item) {
  if (!item) return null;
  if (item.type === "userMessage") {
    const text = (item.content || []).map((part) => part.text || (part.type === "image" ? "[图片]" : "")).filter(Boolean).join("\n");
    return node("div", "message user", text);
  }
  if (item.type === "agentMessage") {
    const root = node("article", "message agent");
    const label = providerLabel(item.provider || currentProvider()).toUpperCase();
    root.append(node("div", "message-label", label));
    const content = node("div", "message-text");
    renderRichText(content, item.text || "");
    root.append(content);
    return root;
  }
  if (item.type === "reasoning") return activity("思考过程", [...(item.summary || []), ...(item.content || [])].join("\n"));
  if (item.type === "plan") return activity("执行计划", item.text || "");
  if (item.type === "commandExecution") return activity(`命令 · ${statusLabel(item.status)}`, `${item.command || ""}${item.aggregatedOutput ? `\n\n${item.aggregatedOutput}` : ""}`, item.status === "failed");
  if (item.type === "fileChange") {
    const changes = (item.changes || []).map((change) => `${change.kind?.type || change.type || "修改"}  ${change.path || ""}`).join("\n");
    return activity(`文件修改 · ${statusLabel(item.status)}`, changes);
  }
  if (item.type === "mcpToolCall") return activity(`工具 · ${item.server || "MCP"}/${item.tool || ""}`, pretty(item.result || item.error || item.arguments || ""), item.status === "failed");
  if (item.type === "antigravityTool") {
    const questions = extractAskQuestions(item);
    if (questions.length) return askQuestionCard(item, questions);
    return activity(
      `工具 · ${item.details.title || item.details.kind || "Antigravity"} · ${statusLabel(item.status)}`,
      pretty(item.details), item.status === "failed",
    );
  }
  if (item.type === "collabAgentToolCall" || item.type === "subAgentActivity") return activity("子任务", pretty(item));
  if (item.type === "webSearch") return activity("网络搜索", item.query || pretty(item));
  return null;
}

function activity(label, body, failed = false) {
  const details = node("details", `activity-card${failed ? " failed" : ""}`);
  details.append(node("summary", "", label));
  details.append(node("div", "activity-body", body || "进行中…"));
  return details;
}

function extractAskQuestions(item) {
  const details = item?.details || {};
  const isAsk = details.name === "ask_question" || details.title === "Run ask_question" || details.title === "ask_question";
  const raw = details.rawInput?.questions;
  if (!isAsk && !raw) return [];
  let list = raw;
  if (typeof list === "string") {
    try { list = JSON.parse(list); } catch { return []; }
  }
  return Array.isArray(list) ? list.filter((q) => q && typeof q.question === "string") : [];
}

function isAwaitingQuestionAnswer(itemId) {
  const index = state.itemOrder.indexOf(itemId);
  if (index < 0) return false;
  for (let i = index + 1; i < state.itemOrder.length; i += 1) {
    if (state.items.get(state.itemOrder[i])?.type === "userMessage") return false;
  }
  return true;
}

function askQuestionCard(item, questions) {
  if (!isAwaitingQuestionAnswer(item.id)) {
    const summary = questions.map((q, idx) => `${idx + 1}. ${q.question}`).join("\n");
    return activity(`问题 · 已回答（${questions.length} 题）`, summary);
  }

  const card = node("section", "question-card");
  card.append(node("p", "eyebrow", "ANTIGRAVITY QUESTION"));
  card.append(node("h3", "question-card-title", questions.length > 1 ? `请回答以下 ${questions.length} 个问题` : "需要你的确认"));

  const form = document.createElement("form");
  const draft = state.questionDrafts.get(item.id) || { selected: {}, custom: {} };
  state.questionDrafts.set(item.id, draft);

  questions.forEach((q, qIdx) => {
    const group = node("div", "question");
    const title = questions.length > 1 ? `${qIdx + 1}. ${q.question}` : q.question;
    group.append(node("strong", "", `${title}${q.is_multi_select ? "（可多选）" : ""}`));
    const chosen = new Set(draft.selected[qIdx] || []);
    const inputType = q.is_multi_select ? "checkbox" : "radio";
    for (const optText of q.options || []) {
      const label = node("label", "option");
      const input = document.createElement("input");
      input.type = inputType;
      input.name = `aq-${item.id}-${qIdx}`;
      input.value = optText;
      input.checked = chosen.has(optText);
      input.addEventListener("change", () => {
        if (q.is_multi_select) {
          if (input.checked) chosen.add(optText);
          else chosen.delete(optText);
          draft.selected[qIdx] = [...chosen];
        } else {
          draft.selected[qIdx] = [optText];
        }
      });
      label.append(input, document.createTextNode(optText));
      group.append(label);
    }
    const customInput = node("input", "field question-other");
    customInput.type = "text";
    customInput.placeholder = "其他补充（可选）";
    customInput.value = draft.custom[qIdx] || "";
    customInput.addEventListener("input", () => {
      draft.custom[qIdx] = customInput.value;
    });
    group.append(customInput);
    form.append(group);
  });

  const submitBtn = node("button", "primary-button full", "提交回答");
  submitBtn.type = "submit";
  submitBtn.disabled = state.sending || state.busy;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const lines = [];
    for (let qIdx = 0; qIdx < questions.length; qIdx += 1) {
      const q = questions[qIdx];
      const picks = [...(draft.selected[qIdx] || [])];
      const extra = (draft.custom[qIdx] || "").trim();
      if (extra) picks.push(extra);
      if (!picks.length) return toast(`请先选择或填写：${q.question}`);
      if (questions.length === 1) lines.push(picks.join("；"));
      else lines.push(`${qIdx + 1}. ${q.question}\n答：${picks.join("；")}`);
    }
    submitBtn.disabled = true;
    submitBtn.textContent = "正在提交…";
    const ok = await submitPromptText(lines.join("\n\n"));
    if (ok) {
      state.questionDrafts.delete(item.id);
    } else {
      submitBtn.disabled = state.sending || state.busy;
      submitBtn.textContent = "提交回答";
    }
  });
  form.append(submitBtn);
  card.append(form);
  return card;
}

function renderRichText(container, text) {
  const lines = String(text || "").replaceAll("\r\n", "\n").split("\n");
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i += 1;
      continue;
    }

    const fence = line.match(/^```([^\s`]*)/);
    if (fence) {
      const lang = fence[1] || "";
      const codeLines = [];
      i += 1;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i += 1;
      }
      if (i < lines.length && lines[i].startsWith("```")) i += 1;
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (lang) code.dataset.lang = lang;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      container.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const h = document.createElement(`h${heading[1].length}`);
      appendInlineMarkdown(h, heading[2].trim());
      container.append(h);
      i += 1;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      container.append(document.createElement("hr"));
      i += 1;
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      const wrap = node("div", "table-wrap");
      const table = document.createElement("table");
      const thead = document.createElement("thead");
      const headerRow = document.createElement("tr");
      for (const cell of splitTableRow(line)) {
        const th = document.createElement("th");
        appendInlineMarkdown(th, cell);
        headerRow.append(th);
      }
      thead.append(headerRow);
      table.append(thead);
      i += 2;
      const tbody = document.createElement("tbody");
      while (i < lines.length && lines[i].trim() && lines[i].includes("|") && !lines[i].startsWith("```")) {
        const tr = document.createElement("tr");
        for (const cell of splitTableRow(lines[i])) {
          const td = document.createElement("td");
          appendInlineMarkdown(td, cell);
          tr.append(td);
        }
        tbody.append(tr);
        i += 1;
      }
      table.append(tbody);
      wrap.append(table);
      container.append(wrap);
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ""));
        i += 1;
      }
      renderRichText(quote, quoteLines.join("\n"));
      container.append(quote);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const ul = document.createElement("ul");
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInlineMarkdown(li, lines[i].replace(/^\s*[-*+]\s+/, ""));
        ul.append(li);
        i += 1;
      }
      container.append(ul);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const ol = document.createElement("ol");
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        const li = document.createElement("li");
        appendInlineMarkdown(li, lines[i].replace(/^\s*\d+\.\s+/, ""));
        ol.append(li);
        i += 1;
      }
      container.append(ol);
      continue;
    }

    const paraLines = [];
    while (
      i < lines.length
      && lines[i].trim()
      && !lines[i].startsWith("```")
      && !/^(#{1,4})\s+/.test(lines[i])
      && !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
      && !/^\s*[-*+]\s+/.test(lines[i])
      && !/^\s*\d+\.\s+/.test(lines[i])
      && !(lines[i].includes("|") && i + 1 < lines.length && isTableSeparator(lines[i + 1]))
    ) {
      paraLines.push(lines[i]);
      i += 1;
    }
    const p = document.createElement("p");
    paraLines.forEach((paraLine, idx) => {
      if (idx > 0) p.append(document.createElement("br"));
      appendInlineMarkdown(p, paraLine);
    });
    container.append(p);
  }
}

function isTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function splitTableRow(line) {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
}

function appendInlineMarkdown(parent, text) {
  const pattern = /`([^`\n]+)`|\[([^\]]+)\]\(((?:https?:\/\/|mailto:)[^\s)]+)\)|\*\*([^*\n]+)\*\*|~~([^~\n]+)~~|\*([^*\n]+)\*/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)));
    if (match[1] !== undefined) {
      parent.append(node("code", "", match[1]));
    } else if (match[2] !== undefined && match[3] !== undefined) {
      const a = document.createElement("a");
      a.href = match[3];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = match[2];
      parent.append(a);
    } else if (match[4] !== undefined) {
      const strong = document.createElement("strong");
      appendInlineMarkdown(strong, match[4]);
      parent.append(strong);
    } else if (match[5] !== undefined) {
      const del = document.createElement("del");
      appendInlineMarkdown(del, match[5]);
      parent.append(del);
    } else if (match[6] !== undefined) {
      const em = document.createElement("em");
      appendInlineMarkdown(em, match[6]);
      parent.append(em);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)));
}

function renderApproval() {
  const request = [...state.pending.values()][0];
  if (!request) {
    els.approvalSheet.classList.add("hidden");
    if (els.newSheet.classList.contains("hidden") && !els.drawer.classList.contains("open")) els.scrim.classList.add("hidden");
    return;
  }
  closeOverlays(false);
  els.scrim.classList.remove("hidden");
  els.approvalSheet.classList.remove("hidden");
  els.approvalContent.replaceChildren();
  const params = request.params || {};
  const reqProvider = request.provider || (request.method === "session/request_permission" ? "antigravity" : "codex");
  els.approvalContent.append(node("div", "approval-icon", "!"));

  if (request.method === "session/request_permission") {
    els.approvalContent.append(node("p", "eyebrow", "ANTIGRAVITY PERMISSION"), node("h2", "", "Antigravity 请求权限"));
    const contextParts = [
      params.sessionName && !isCurrent(params.sessionId, "antigravity") ? `会话：${params.sessionName}` : "",
      params.cwd ? `工作目录：${params.cwd}` : "",
    ].filter(Boolean);
    if (contextParts.length) els.approvalContent.append(node("p", "approval-copy", contextParts.join(" · ")));
    els.approvalContent.append(node("pre", "approval-code", pretty(params.toolCall)));
    const options = params.options || [];
    const hasRejectOnce = options.some((opt) => opt.kind === "reject_once");
    const actions = node("div", `approval-actions${options.length + 1 > 2 ? " three" : ""}`);
    if (!hasRejectOnce) {
      actions.append(approvalButton("取消审批", "deny", () => answerRequest(request, {})));
    }
    for (const opt of options) {
      const allow = opt.kind === "allow_once";
      actions.append(approvalButton(allow ? "本次允许" : "本次拒绝", allow ? "allow" : "deny", () => answerRequest(request, { optionId: opt.optionId })));
    }
    if (hasRejectOnce) {
      actions.append(approvalButton("取消本轮", "", () => answerRequest(request, {})));
    }
    els.approvalContent.append(actions);
  } else if (request.method === "item/commandExecution/requestApproval") {
    els.approvalContent.append(node("p", "eyebrow", "CODEX APPROVAL"), node("h2", "", "允许执行命令？"));
    if (params.reason) els.approvalContent.append(node("p", "approval-copy", params.reason));
    els.approvalContent.append(node("pre", "approval-code", `${params.command || "未知命令"}${params.cwd ? `\n\n工作目录：${params.cwd}` : ""}`));
    const actions = node("div", "approval-actions three");
    actions.append(approvalButton("拒绝", "deny", () => answerRequest(request, { decision: "decline" })));
    actions.append(approvalButton("本次允许", "allow", () => answerRequest(request, { decision: "accept" })));
    actions.append(approvalButton("本会话允许", "", () => answerRequest(request, { decision: "acceptForSession" })));
    els.approvalContent.append(actions);
  } else if (request.method === "item/fileChange/requestApproval") {
    els.approvalContent.append(node("p", "eyebrow", "CODEX FILE CHANGE"), node("h2", "", "允许修改文件？"));
    els.approvalContent.append(node("p", "approval-copy", params.reason || "Codex 请求写入当前沙箱范围之外的文件。"));
    const fileItem = state.items.get(params.itemId);
    const changes = (fileItem?.changes || []).map((change) => `${change.kind?.type || change.type || "修改"}  ${change.path || ""}`).join("\n");
    els.approvalContent.append(node("pre", "approval-code", changes || (params.grantRoot ? `请求写入：${params.grantRoot}` : `变更编号：${params.itemId}`)));
    const actions = node("div", "approval-actions three");
    actions.append(approvalButton("拒绝", "deny", () => answerRequest(request, { decision: "decline" })));
    actions.append(approvalButton("本次允许", "allow", () => answerRequest(request, { decision: "accept" })));
    actions.append(approvalButton("本会话允许", "", () => answerRequest(request, { decision: "acceptForSession" })));
    els.approvalContent.append(actions);
  } else if (request.method === "item/tool/requestUserInput") {
    els.approvalContent.append(node("p", "eyebrow", "CODEX HAS A QUESTION"), node("h2", "", "需要你的选择"));
    const form = document.createElement("form");
    for (const question of params.questions || []) form.append(questionElement(question));
    const button = approvalButton("提交回答", "allow", (event) => {
      event.preventDefault();
      const answers = {};
      for (const question of params.questions || []) {
        const data = new FormData(form);
        const values = data.getAll(question.id).map(String).filter(Boolean);
        if (!values.length) return toast(`请回答：${question.header || question.question}`);
        answers[question.id] = { answers: values };
      }
      answerRequest(request, { answers });
    });
    button.type = "submit";
    form.append(button);
    els.approvalContent.append(form);
  } else if (request.method === "mcpServer/elicitation/request") {
    els.approvalContent.append(node("p", "eyebrow", "MCP INPUT"), node("h2", "", "工具需要额外输入"), node("pre", "approval-code", pretty(params)));
    const actions = node("div", "approval-actions");
    actions.append(approvalButton("取消", "deny", () => answerRequest(request, { action: "cancel" })));
    els.approvalContent.append(actions);
  } else {
    els.approvalContent.append(node("p", "eyebrow", "UNSUPPORTED REQUEST"), node("h2", "", "需要在电脑端处理"));
    els.approvalContent.append(node("p", "approval-copy", `当前版本还不能处理 ${request.method}，请在电脑上的 ${providerLabel(reqProvider)} 客户端完成。`));
  }
}

function questionElement(question) {
  const root = node("div", "question");
  root.append(node("strong", "", question.question || question.header));
  const type = question.options?.length ? "radio" : "text";
  if (question.options?.length) {
    for (const optionValue of question.options) {
      const label = node("label", "option");
      const input = document.createElement("input");
      input.type = type;
      input.name = question.id;
      input.value = optionValue.label;
      label.append(input, document.createTextNode(optionValue.label));
      if (optionValue.description) label.append(node("small", "", optionValue.description));
      root.append(label);
    }
    if (question.isOther) {
      const input = node("input", "field");
      input.name = question.id;
      input.placeholder = "其他回答";
      root.append(input);
    }
  } else {
    const input = node("input", "field");
    input.type = question.isSecret ? "password" : "text";
    input.name = question.id;
    root.append(input);
  }
  return root;
}

async function answerRequest(request, result) {
  try {
    await api("/api/respond", { method: "POST", body: { id: request.id, result } });
    state.pendingRevision++;
    state.pending.delete(String(request.id));
    renderApproval();
  } catch (error) {
    toast(error.message);
  }
}

function approvalButton(text, className, handler) {
  const button = node("button", `approval-button ${className}`.trim(), text);
  button.type = "button";
  button.addEventListener("click", handler);
  return button;
}

function updateComposerHint() {
  if (state.busy) {
    $("#composerHint").textContent = isCurrentAntigravity() ? "正在工作" : "正在工作，可以继续插话";
  } else if (state.writerLocked) {
    $("#composerHint").textContent = "电脑端正占用此会话，发送将自动分叉继续";
  } else {
    $("#composerHint").textContent = "发送消息";
  }
}

function setBusy(value) {
  state.busy = value;
  els.working.classList.toggle("hidden", !value);
  els.stop.classList.toggle("hidden", !value);
  els.statusDot.classList.toggle("busy", value);
  updateComposerHint();
  updateSendButton();
  updateConnectionUi();
}

function updateSendButton() {
  const disabled = state.sending || state.opening || (isCurrentAntigravity() && state.busy);
  els.send.disabled = disabled;
  els.messageList.querySelectorAll(".question-card button[type='submit']").forEach((button) => {
    button.disabled = disabled;
  });
}

function updateConnectionUi() {
  const activeProv = state.current?.provider;
  const currentReady = activeProv ? Boolean(state.providers[activeProv]?.ready) : state.codexReady;
  const online = state.connected && currentReady;
  els.statusDot.classList.toggle("online", online && !state.busy);
  els.statusDot.classList.toggle("busy", online && state.busy);
  els.drawerDot.classList.toggle("online", state.connected && state.codexReady);

  let label;
  if (!state.connected) {
    label = "已断线";
  } else if (activeProv && !state.providers[activeProv]?.ready) {
    label = `${providerLabel(activeProv)} 未就绪`;
  } else if (!state.codexReady) {
    label = "后端未就绪";
  } else if (state.busy) {
    label = `${providerLabel(currentProvider())} 工作中`;
  } else if (activeProv) {
    label = `${providerLabel(activeProv)} 已连接`;
  } else {
    label = "已连接";
  }

  els.statusText.textContent = label;
  els.homeStatus.textContent = !state.connected ? "已断线" : state.codexReady ? "已连接" : "未就绪";
  els.homeStatus.classList.toggle("online", state.connected && state.codexReady && !state.busy);
  els.homeStatus.classList.toggle("busy", state.connected && state.busy);
}

function syncTopNavButton() {
  const inConversation = Boolean(state.current && !els.conversation.classList.contains("hidden"));
  $("#menuIcon").classList.toggle("hidden", inConversation);
  $("#backIcon").classList.toggle("hidden", !inConversation);
  $("#sessionsButton").setAttribute("aria-label", inConversation ? "返回会话列表" : "打开会话列表");
}

function handlePrimaryNavButton() {
  if (state.current && !els.conversation.classList.contains("hidden")) {
    if (history.state?.view === "conversation") history.back();
    else showHome();
    return;
  }
  openDrawer();
}

function handlePopState() {
  if (!els.newSheet.classList.contains("hidden") || els.drawer.classList.contains("open")) {
    closeOverlays();
    return;
  }
  if (state.current && !els.conversation.classList.contains("hidden")) {
    showHome({ fromPopstate: true });
  }
}

function showHome({ fromPopstate = false } = {}) {
  releaseCodexWriter(null).catch(() => {});
  state.current = null;
  state.writerLocked = false;
  state.activeTurnId = null;
  state.items.clear();
  state.itemOrder = [];
  els.title.textContent = "Remote Codex";
  els.welcome.classList.remove("hidden");
  els.conversation.classList.add("hidden");
  els.composer.classList.add("hidden");
  closeOverlays();
  setBusy(false);
  syncTopNavButton();
  renderThreads();
  if (!fromPopstate && history.state?.view === "conversation") {
    history.replaceState({ view: "home" }, "");
  }
}

function showConversation() {
  const wasHome = els.conversation.classList.contains("hidden");
  els.welcome.classList.add("hidden");
  els.conversation.classList.remove("hidden");
  els.composer.classList.remove("hidden");
  syncTopNavButton();
  if (wasHome && history.state?.view !== "conversation") {
    history.pushState({ view: "conversation", id: state.current?.id || "" }, "");
  }
}

function showPairing() { els.pairing.classList.remove("hidden"); }
function setPairingError(message) { els.pairingError.textContent = message; els.pairingError.classList.toggle("hidden", !message); }
function openDrawer() {
  closeOverlays();
  els.drawer.inert = false;
  els.drawer.classList.add("open");
  els.drawer.setAttribute("aria-hidden", "false");
}

function closeOverlays(includeApproval = true) {
  els.drawer.classList.remove("open");
  els.drawer.setAttribute("aria-hidden", "true");
  els.drawer.inert = true;
  els.newSheet.classList.add("hidden");
  if (includeApproval && !state.pending.size) els.approvalSheet.classList.add("hidden");
  if (!state.pending.size) els.scrim.classList.add("hidden");
}

function disconnect() {
  releaseCodexWriter(null).catch(() => {});
  state.eventAbort?.abort();
  clearTimeout(state.reconnectTimer);
  localStorage.removeItem("remoteCodexToken");
  state.token = "";
  state.connected = false;
  closeOverlays();
  showPairing();
  updateConnectionUi();
}

function resizePrompt() {
  els.prompt.style.height = "auto";
  els.prompt.style.height = `${Math.min(els.prompt.scrollHeight, 124)}px`;
}

function syncViewportHeight() {
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height || window.innerHeight);
  document.documentElement.style.setProperty("--app-height", `${height}px`);
}

async function rpc(method, params = {}, provider = currentProvider()) {
  const response = await api("/api/rpc", { method: "POST", body: { provider, method, params } });
  return response.result;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: { ...authHeaders(), ...(options.body ? { "Content-Type": "application/json" } : {}) },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store",
  });
  if (!response.ok) throw await apiError(response);
  return response.json();
}

function authHeaders() { return { Authorization: `Bearer ${state.token}` }; }
async function apiError(response) {
  const value = await response.json().catch(() => ({}));
  return new Error(value.error || `请求失败 (${response.status})`);
}

function node(tag, className = "", text = "") {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== "") element.textContent = String(text);
  return element;
}

function option(value, label) { const element = document.createElement("option"); element.value = value; element.textContent = label; return element; }
function shortPath(path = "") { const parts = path.split("/").filter(Boolean); return parts.length ? parts.at(-1) : path || "—"; }
function relativeTime(seconds) {
  if (!seconds) return "刚刚";
  const delta = Math.max(0, Math.floor(Date.now() / 1000 - seconds));
  if (delta < 60) return "刚刚";
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}
function pretty(value) { return typeof value === "string" ? value : JSON.stringify(value, null, 2); }
function statusLabel(value) {
  const status = typeof value === "string" ? value : value?.type;
  return ({ pending: "等待中", in_progress: "进行中", inProgress: "进行中", completed: "完成", failed: "失败", declined: "已拒绝", interrupted: "已停止" })[status] || status || "进行中";
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3200);
}
