// 生成页面的 VM 交互回归夹具：两个工作台的浏览器状态必须跑真实注入脚本来验证。
const vm = require("node:vm");
const { makeHtml } = require("./build-compare");

const projectKey = "project";
const currentKey = `translation-compare-notes-v7:${projectKey}:rows`;
const siblingKey = `translation-compare-notes-v7:${projectKey}:rowsPrevious`;

const ROWS = [
  { index: 1, jp: "原文一", cn: "译文一", relation: "1:1", score: 0.9, signature: "sig-1" },
  { index: 2, jp: "原文二", cn: "译文二", relation: "1:1", score: 0.9, signature: "sig-2" },
  { index: 3, jp: "原文三", cn: "译文三", relation: "1:1", score: 0.9, signature: "sig-3" },
];

function storageFixture(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data, failWrites: false,
    get length() { return data.size; },
    key(index) { return [...data.keys()][index] ?? null; },
    getItem(name) { return data.get(name) ?? null; },
    setItem(name, value) { if (this.failWrites) throw Error("QuotaExceededError"); data.set(name, String(value)); },
    removeItem(name) { data.delete(name); },
  };
}

function createWorkbench(storage = storageFixture(), options = {}) {
  const targetProjectKey = options.projectKey || projectKey;
  const targetCurrentKey = options.currentKey || `translation-compare-notes-v7:${targetProjectKey}:rows`;
  const html = makeHtml(options.rows || ROWS, {
    comparisonMode: "bilingual", files: { jp: "A.txt", cn: "B.txt" }, labels: { jp: "原文", cn: "译文" },
  }, { projectKey: targetProjectKey, rowsSignature: options.rowsSignature || "rows", notesStorage: { key: targetCurrentKey } });
  return createClientFixture(html, storage, options);
}

// 两个工作台都运行其生成页面的真实脚本，共享这一份最小 DOM/请求夹具。
function createClientFixture(html, storage = storageFixture(), options = {}) {
  const elements = new Map();
  const timeouts = [];
  const windowListeners = new Map();
  const documentListeners = new Map();
  const registerListener = (listeners, name, callback) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(callback);
  };
  const dispatchListeners = async (listeners, name, event = {}) => {
    for (const callback of listeners.get(name) || []) await callback(event);
    return event;
  };
  let createdSeq = 0;
  let timeoutSeq = 0;
  const scheduleTimeout = (callback, delay = 0) => {
    const id = ++timeoutSeq;
    timeouts.push({ id, callback, delay: Number(delay) || 0, cleared: false });
    return id;
  };
  const clearScheduledTimeout = (id) => {
    const timer = timeouts.find((item) => item.id === id);
    if (timer) timer.cleared = true;
  };
  const element = (rawId) => {
    const id = rawId === "aiStart" ? "stage1Start" : (rawId === "aiStop" ? "stage1Stop" : rawId);
    if (!elements.has(id)) {
      const listeners = new Map();
      const node = {
        hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", checked: false,
        dataset: {}, style: { setProperty() {} }, options: [], children: [], files: [], open: false,
        classList: (() => {
          const classes = new Set();
          return {
            add(...names) { names.forEach((n) => classes.add(n)); },
            remove(...names) { names.forEach((n) => classes.delete(n)); },
            toggle(name, force) {
              const shouldHave = force !== undefined ? Boolean(force) : !classes.has(name);
              if (shouldHave) classes.add(name); else classes.delete(name);
              return shouldHave;
            },
            contains(name) { return classes.has(name); },
          };
        })(),
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
        removeEventListener(name, fn) {
          const list = listeners.get(name);
          if (!list) return;
          const index = list.indexOf(fn);
          if (index >= 0) list.splice(index, 1);
        },
        listenerCount(name) { return (listeners.get(name) || []).length; },
        async dispatch(name, event = {}) { for (const fn of listeners.get(name) || []) await fn(event); },
        attributes: new Map(),
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        removeAttribute(name) { this.attributes.delete(name); },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        dispatchEvent(event) {
          for (const fn of listeners.get(event.type) || []) fn(event);
          return true;
        },
        contains(node) {
          for (let current = node; current; current = current.parentNode) if (current === this) return true;
          return false;
        },
        querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
        // 子节点要真的记下来：浮动提示的断言看的就是「页面上留下了哪几条提示」。
        append(...nodes) {
          for (const node of nodes) {
            this.children.push(node);
            if (node && typeof node === "object") node.parentNode = this;
          }
        },
        appendChild(node) { this.append(node); return node; },
        replaceChildren(...nodes) {
          this.children = [];
          this.append(...nodes);
        },
        remove() {
          const parent = this.parentNode;
          if (parent) parent.children = parent.children.filter((item) => item !== this);
        },
        focus() { this.focused = true; }, click() { if (!this.disabled) this.dispatchEvent({ type: "click", target: this }); },
        showModal() {
          this.open = true;
          // 页内确认弹窗（workbench-client.js 的 askConfirm）在测试里默认按 fixture 的
          // confirm 语义落定：默认「确认」，传 confirm: () => false 即「取消」。
          // 其它 dialog（备注找回预览、AI 启动方式选择）保持只打开，由测试自行驱动。
          if (this.id !== "genericConfirmDialog" || options.manualConfirm) return;
          const answer = options.confirm ? options.confirm(elements.get("genericConfirmMessage")?.textContent || "") : true;
          const target = elements.get(answer ? "genericConfirmOk" : "genericConfirmCancel");
          if (target) target.dispatch("click", { target });
        },
        close() {
          if (!this.open) return;
          this.open = false;
          Promise.resolve().then(() => this.dispatchEvent({ type: "close", target: this }));
        },
        getBoundingClientRect() { return { height: 0, top: 0, bottom: 0 }; },
      };
      let nodeId = id;
      Object.defineProperty(node, "id", {
        get() { return nodeId; },
        set(value) { nodeId = String(value); elements.set(nodeId, node); },
      });
      elements.set(id, node);
    }
    return elements.get(id);
  };
  for (const match of html.matchAll(/\bid="([^"]+)"/g)) element(match[1]);
  element("rowData").textContent = html.match(/<script id="rowData" type="application\/json">([\s\S]*?)<\/script>/)[1];
  if (options.diskBootstrap) element("notesDiskData").textContent = JSON.stringify(options.diskBootstrap);
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const statusQueue = options.statusQueue ? options.statusQueue.slice() : [];
  const fetches = [];
  const posts = [];
  const context = vm.createContext({
    document: {
      getElementById: options.strictIds ? (id) => elements.get(id) || null : element,
      querySelector: element, querySelectorAll() { return []; },
      createElement: (tag) => Object.assign(element("created-" + (++createdSeq)), { tagName: String(tag).toUpperCase() }),
      createElementNS: () => element("ns-" + (++createdSeq)),
      documentElement: element("html"), body: element("body"),
      addEventListener: (name, callback) => registerListener(documentListeners, name, callback),
    },
    localStorage: storage, console, URL, URLSearchParams, TextEncoder, Blob, Event,
    window: {
      addEventListener: (name, callback) => registerListener(windowListeners, name, callback),
      requestAnimationFrame() {},
      setTimeout: scheduleTimeout, clearTimeout: clearScheduledTimeout,
      prompt: options.prompt || ((msg, def) => def || ""),
      confirm: options.confirm || (() => true),
      location: { protocol: "file:", host: "" },
      innerHeight: 900,
      ...(options.windowData || {}),
    },
    navigator: {}, location: { protocol: "file:" },
    fetch(url, request = {}) {
      fetches.push(String(url));
      if (request.body) posts.push({ url: String(url), body: JSON.parse(String(request.body)) });
      const responses = options.apiResponses || {};
      if (Object.prototype.hasOwnProperty.call(responses, String(url))) {
        const payload = responses[String(url)];
        return Promise.resolve(typeof payload === "function" ? payload(request) : payload)
          .then((result) => ({ ok: result?.ok !== false, json: async () => result }));
      }
      // 状态请求可由测试延迟落定，与页面清除/启动操作交错；仍运行完整生成脚本。
      if (options.statusResponse && String(url).startsWith("/api/ai-proofread/status?")) {
        return Promise.resolve(options.statusResponse(String(url)))
          .then((result) => ({ ok: result?.ok !== false, json: async () => result }));
      }
      const payload = statusQueue.shift() || { ok: true, ai: { kind: "", runId: "", running: false, results: [] } };
      return Promise.resolve({ ok: true, json: async () => payload });
    },
    setTimeout: scheduleTimeout, clearTimeout: clearScheduledTimeout, setInterval() {},
    confirm: options.confirm || (() => true),
    prompt: options.prompt || ((msg, def) => def || ""),
    requestAnimationFrame() {},
  });
  vm.runInContext(script, context);
  return {
    html, element, storage, fetches, posts, timeouts,
    dispatchWindow: (name, event) => dispatchListeners(windowListeners, name, event),
    dispatchDocument: (name, event) => dispatchListeners(documentListeners, name, event),
    run: (code) => vm.runInContext(code, context),
    settle: async () => { for (let step = 0; step < 24; step += 1) await Promise.resolve(); },
    // 状态轮询是 async + await fetch：把微任务抽干（跨 VM 边界时 await 的延续排在后面）。
    refresh: async () => {
      vm.runInContext("refreshAiStatus()", context);
      for (let step = 0; step < 24; step += 1) await Promise.resolve();
    },
  };
}

// 服务端一轮预筛的状态响应：results 是分页返回的（客户端每次 resultLimit=64）。
function prefilterStatus({ runId = "run-1", results = [], running = false, hasMoreResults = false } = {}) {
  return {
    ok: true,
    ai: {
      kind: "prefilter", runId, running, finishedAt: running ? "" : "2026-01-01T00:00:00.000Z",
      projectKey, rowsSignature: "rows", total: ROWS.length, queued: 0, processed: results.length,
      handled: results.length, prefiltered: results.length, rulePrefiltered: results.length,
      similarityPrefiltered: 0, structuredConflicts: 0, resultRevision: results.length, results, hasMoreResults,
    },
  };
}

function prefilterResult(index, { runId = "run-1", status = "rule-prefilter", signature = `sig-${index}` } = {}) {
  return {
    runId, index, signature, status, done: status !== "rule-conflict", resultRevision: index,
    note: [`[${status === "similarity-prefilter" ? "相似度预筛" : "规则预筛"}]`, "语义是否相同：相同", "是否需要修改：否", "分析：预筛判定通过。"].join("\n"),
  };
}

// 页面当前留下的浮动提示（按渲染顺序）：每条取 .toast-text 的文字，也就是用户看到的回执。
function toastMessages(ui) {
  return ui.element("toastStack").children.map((node) => {
    const line = (node.children || []).find((child) => child && child.className === "toast-text");
    return line ? line.textContent : String(node.textContent ?? "");
  });
}

module.exports = { ROWS, projectKey, currentKey, siblingKey, storageFixture, createWorkbench, createClientFixture, toastMessages, prefilterStatus, prefilterResult };
