const $ = (selector) => document.querySelector(selector);
const els = {
  main: $("#main"), welcome: $("#welcome"), conversation: $("#conversation"), messageList: $("#messageList"),
  working: $("#workingIndicator"), composer: $("#composer"), prompt: $("#promptInput"), send: $("#sendButton"), stop: $("#stopButton"),
  title: $("#threadTitle"), statusText: $("#statusText"), statusDot: $("#statusDot"), drawerDot: $("#drawerStatusDot"),
  drawer: $("#sessionDrawer"), scrim: $("#scrim"), threadList: $("#threadList"), homeThreadList: $("#homeThreadList"),
  hostCwd: $("#hostCwd"), homeCwd: $("#homeCwd"), homeStatus: $("#homeStatus"), sessionCount: $("#sessionCount"), hostName: $("#hostName"),
  newSheet: $("#newThreadSheet"), approvalSheet: $("#approvalSheet"), approvalContent: $("#approvalContent"),
  pairing: $("#pairingSheet"), tokenInput: $("#tokenInput"), pairingError: $("#pairingError"), pairButton: $("#pairButton"),
  cwd: $("#cwdInput"), model: $("#modelSelect"), effort: $("#effortSelect"), approval: $("#approvalSelect"), sandbox: $("#sandboxSelect"),
  unsafeWarning: $("#unsafeWarning"), createThread: $("#createThreadButton"), toast: $("#toast"),
};

const state = {
  token: "", connected: false, codexReady: false, transportSecure: true, cwd: "", threads: [], models: [], current: null,
  items: new Map(), itemOrder: [], pending: new Map(), activeTurnId: null, busy: false,
  selectedEffort: "", eventAbort: null, reconnectTimer: null,
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
  $("#sessionsButton").addEventListener("click", openDrawer);
  $("#threadHeading").addEventListener("click", openDrawer);
  $("#viewAllThreadsButton").addEventListener("click", openDrawer);
  $("#closeDrawerButton").addEventListener("click", closeOverlays);
  $("#newThreadButton").addEventListener("click", openNewThread);
  $("#drawerNewButton").addEventListener("click", openNewThread);
  $("#welcomeStartButton").addEventListener("click", openNewThread);
  $("#disconnectButton").addEventListener("click", disconnect);
  els.scrim.addEventListener("click", closeOverlays);
  document.querySelectorAll(".sheet-close").forEach((button) => button.addEventListener("click", closeOverlays));
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
    state.transportSecure = status.transportSecure;
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

async function refreshAll(initial = false) {
  if (!state.token) return;
  const tasks = [loadThreads(), loadPending()];
  if (initial || !state.models.length) tasks.push(loadModels());
  await Promise.allSettled(tasks);
}

async function loadModels() {
  const result = await rpc("model/list", { limit: 100, includeHidden: false });
  state.models = (result?.data || []).filter((model) => !model.hidden);
  const selected = els.model.value;
  els.model.replaceChildren(option("", "跟随 Codex 默认"));
  for (const model of state.models) els.model.append(option(model.model || model.id, model.displayName || model.model));
  if ([...els.model.options].some((item) => item.value === selected)) els.model.value = selected;
}

async function loadThreads() {
  const result = await rpc("thread/list", { limit: 100, sortKey: "updated_at", sortDirection: "desc" });
  state.threads = result?.data || [];
  renderThreads();
}

async function loadPending() {
  const result = await api("/api/pending");
  for (const request of result.data || []) state.pending.set(String(request.id), request);
  renderApproval();
}

function connectEvents() {
  clearTimeout(state.reconnectTimer);
  state.eventAbort?.abort();
  state.eventAbort = new AbortController();
  streamEvents(state.eventAbort.signal).catch((error) => {
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

function handleBridgeEvent(event) {
  if (event.kind === "connected") return;
  if (event.kind === "bridge") {
    state.codexReady = event.message.status === "ready";
    if (event.message.error) toast(event.message.error);
    return updateConnectionUi();
  }
  if (event.kind === "serverRequest") {
    state.pending.set(String(event.message.id), event.message);
    return renderApproval();
  }
  if (event.kind === "requestResolved") {
    state.pending.delete(String(event.message.id));
    return renderApproval();
  }
  if (event.kind === "notification") handleNotification(event.message);
}

function handleNotification({ method, params = {} }) {
  if (method === "turn/started" && isCurrent(params.threadId)) {
    state.activeTurnId = params.turn?.id || state.activeTurnId;
    setBusy(true);
  } else if (method === "turn/completed" && isCurrent(params.threadId)) {
    setBusy(false);
    state.activeTurnId = null;
    if (params.turn?.status === "failed") toast(params.turn.error?.message || "任务执行失败");
    loadThreads().catch(() => {});
  } else if (method === "item/started" && isCurrent(params.threadId)) {
    upsertItem(params.item);
  } else if (method === "item/completed" && isCurrent(params.threadId)) {
    upsertItem(params.item);
  } else if (method === "item/agentMessage/delta" && isCurrent(params.threadId)) {
    const item = state.items.get(params.itemId) || { id: params.itemId, type: "agentMessage", text: "" };
    item.text = `${item.text || ""}${params.delta || ""}`;
    upsertItem(item);
  } else if (method === "item/commandExecution/outputDelta" && isCurrent(params.threadId)) {
    const item = state.items.get(params.itemId);
    if (item) { item.aggregatedOutput = `${item.aggregatedOutput || ""}${params.delta || ""}`; upsertItem(item); }
  } else if (method === "thread/name/updated") {
    loadThreads().catch(() => {});
    if (isCurrent(params.threadId) && params.name) { state.current.name = params.name; els.title.textContent = params.name; }
  } else if (method === "error" && (!params.threadId || isCurrent(params.threadId))) {
    toast(params.error?.message || params.message || "Codex 返回了错误");
  }
}

function isCurrent(threadId) { return Boolean(state.current && state.current.id === threadId); }

function upsertItem(item, shouldRender = true) {
  if (!item?.id) return;
  if (!state.items.has(item.id)) state.itemOrder.push(item.id);
  state.items.set(item.id, item);
  if (shouldRender) renderMessages();
}

async function openThread(thread) {
  closeOverlays();
  els.title.textContent = thread.name || thread.preview || "未命名会话";
  showConversation();
  state.activeTurnId = null;
  setBusy(thread.status?.type === "active");
  try {
    const result = await rpc("thread/resume", { threadId: thread.id });
    state.current = result.thread;
    state.selectedEffort = result.reasoningEffort || "";
    state.items.clear();
    state.itemOrder = [];
    for (const turn of result.thread?.turns || []) {
      for (const item of turn.items || []) upsertItem(item, false);
      if (turn.status === "inProgress") state.activeTurnId = turn.id;
    }
    els.title.textContent = result.thread?.name || result.thread?.preview || "未命名会话";
    setBusy(result.thread?.status?.type === "active" || Boolean(state.activeTurnId));
    renderThreads();
    renderMessages(true);
  } catch (error) {
    toast(error.message);
  }
}

function openNewThread() {
  closeOverlays();
  els.cwd.value ||= state.cwd;
  els.newSheet.classList.remove("hidden");
}

async function createThread() {
  const cwd = els.cwd.value.trim();
  if (!cwd) return toast("请输入电脑上的工作目录");
  els.createThread.disabled = true;
  els.createThread.textContent = "正在创建…";
  try {
    const params = {
      cwd,
      approvalPolicy: els.approval.value,
      sandbox: els.sandbox.value,
      ...(els.model.value ? { model: els.model.value } : {}),
    };
    const result = await rpc("thread/start", params);
    state.current = result.thread;
    state.selectedEffort = els.effort.value;
    state.items.clear();
    state.itemOrder = [];
    state.activeTurnId = null;
    setBusy(false);
    els.title.textContent = "新会话";
    showConversation();
    closeOverlays();
    await loadThreads();
    if (window.matchMedia("(min-width: 760px)").matches) els.prompt.focus();
  } catch (error) {
    toast(error.message);
  } finally {
    els.createThread.disabled = false;
    els.createThread.textContent = "创建会话";
  }
}

async function sendPrompt() {
  const text = els.prompt.value.trim();
  if (!text) return;
  if (!state.current) return openNewThread();
  els.send.disabled = true;
  try {
    const input = [{ type: "text", text }];
    if (state.busy && state.activeTurnId) {
      await rpc("turn/steer", { threadId: state.current.id, input, expectedTurnId: state.activeTurnId });
      toast("已插入当前任务");
    } else {
      const result = await rpc("turn/start", {
        threadId: state.current.id,
        input,
        ...(state.selectedEffort ? { effort: state.selectedEffort } : {}),
      });
      state.activeTurnId = result.turn?.id || null;
      setBusy(true);
    }
    els.prompt.value = "";
    resizePrompt();
  } catch (error) {
    toast(error.message);
  } finally {
    els.send.disabled = false;
  }
}

async function stopTurn() {
  if (!state.current || !state.activeTurnId) return;
  els.stop.disabled = true;
  try {
    await rpc("turn/interrupt", { threadId: state.current.id, turnId: state.activeTurnId });
  } catch (error) {
    toast(error.message);
  } finally {
    els.stop.disabled = false;
  }
}

function renderThreads() {
  els.threadList.replaceChildren();
  els.homeThreadList.replaceChildren();
  els.sessionCount.textContent = `${state.threads.length} 个会话`;
  if (!state.threads.length) {
    els.threadList.append(node("div", "thread-empty", "还没有会话，先创建一个吧"));
    els.homeThreadList.append(node("div", "thread-empty", "还没有会话"));
    return;
  }
  for (const thread of state.threads) els.threadList.append(threadButton(thread));
  for (const thread of state.threads.slice(0, 5)) els.homeThreadList.append(threadButton(thread));
}

function renderMessages(forceScroll = false) {
  const shouldStick = forceScroll || state.busy || isNearBottom();
  els.messageList.replaceChildren();
  for (const id of state.itemOrder) {
    const item = state.items.get(id);
    const element = itemElement(item);
    if (element) els.messageList.append(element);
  }
  if (shouldStick) requestAnimationFrame(scrollToLatest);
}

function threadButton(thread) {
  const button = node("button", `thread-item${thread.id === state.current?.id ? " active" : ""}`);
  button.type = "button";
  const main = node("span", "thread-row-main");
  main.append(node("strong", "thread-row-title", thread.name || thread.preview || "未命名会话"));
  main.append(node("span", "thread-row-meta", `${shortPath(thread.cwd)} · ${relativeTime(thread.updatedAt)}`));
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
    root.append(node("div", "message-label", "CODEX"));
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

function renderRichText(container, text) {
  const parts = text.split("```");
  parts.forEach((part, index) => {
    if (index % 2) {
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      code.textContent = part.replace(/^\w+\n/, "");
      pre.append(code);
      container.append(pre);
    } else {
      for (const paragraph of part.split(/\n{2,}/)) if (paragraph) container.append(node("p", "", paragraph));
    }
  });
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
  els.approvalContent.append(node("div", "approval-icon", "!"));

  if (request.method === "item/commandExecution/requestApproval") {
    els.approvalContent.append(node("p", "eyebrow", "APPROVAL REQUIRED"), node("h2", "", "允许执行命令？"));
    if (params.reason) els.approvalContent.append(node("p", "approval-copy", params.reason));
    els.approvalContent.append(node("pre", "approval-code", `${params.command || "未知命令"}${params.cwd ? `\n\n工作目录：${params.cwd}` : ""}`));
    const actions = node("div", "approval-actions three");
    actions.append(approvalButton("拒绝", "deny", () => answerRequest(request, { decision: "decline" })));
    actions.append(approvalButton("本次允许", "allow", () => answerRequest(request, { decision: "accept" })));
    actions.append(approvalButton("本会话允许", "", () => answerRequest(request, { decision: "acceptForSession" })));
    els.approvalContent.append(actions);
  } else if (request.method === "item/fileChange/requestApproval") {
    els.approvalContent.append(node("p", "eyebrow", "FILE CHANGE"), node("h2", "", "允许修改文件？"));
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
    els.approvalContent.append(node("p", "approval-copy", `当前版本还不能处理 ${request.method}，请在电脑上的 Codex 客户端完成。`));
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

function setBusy(value) {
  state.busy = value;
  els.working.classList.toggle("hidden", !value);
  els.stop.classList.toggle("hidden", !value);
  els.statusDot.classList.toggle("busy", value);
  $("#composerHint").textContent = value ? "正在工作，可以继续插话" : "发送消息";
  updateConnectionUi();
}

function updateConnectionUi() {
  const online = state.connected && state.codexReady;
  els.statusDot.classList.toggle("online", online && !state.busy);
  els.statusDot.classList.toggle("busy", online && state.busy);
  els.drawerDot.classList.toggle("online", online);
  const label = !state.connected ? "已断线" : !state.codexReady ? "Codex 未就绪" : state.busy ? "正在工作" : "已连接";
  els.statusText.textContent = label;
  els.homeStatus.textContent = label;
  els.homeStatus.classList.toggle("online", online && !state.busy);
  els.homeStatus.classList.toggle("busy", online && state.busy);
}

function showConversation() {
  els.welcome.classList.add("hidden");
  els.conversation.classList.remove("hidden");
  els.composer.classList.remove("hidden");
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

async function rpc(method, params = {}) {
  const response = await api("/api/rpc", { method: "POST", body: { method, params } });
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
  return ({ inProgress: "进行中", completed: "完成", failed: "失败", declined: "已拒绝", interrupted: "已停止" })[status] || status || "进行中";
}

let toastTimer;
function toast(message) {
  clearTimeout(toastTimer);
  els.toast.textContent = message;
  els.toast.classList.remove("hidden");
  toastTimer = setTimeout(() => els.toast.classList.add("hidden"), 3200);
}
