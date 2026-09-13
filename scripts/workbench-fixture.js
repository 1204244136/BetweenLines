// 生成页面的 VM 交互回归夹具：翻译比较工作台的备注/预筛状态都在客户端，必须跑真实注入脚本来验证。
// 被 notes-recovery-merge.test.js 与 prefilter-restore.test.js 共用。
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
    setItem(name, value) { if (this.failWrites) throw Error("QuotaExceededError"); data.set(name, value); },
    removeItem(name) { data.delete(name); },
  };
}

function createWorkbench(storage = storageFixture(), options = {}) {
  const elements = new Map();
  const element = (id) => {
    if (!elements.has(id)) {
      const listeners = new Map();
      elements.set(id, {
        hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", checked: false,
        dataset: {}, style: { setProperty() {} }, options: [], children: [], files: [], open: false,
        classList: { toggle() {}, add() {}, remove() {}, contains() { return false; } },
        addEventListener(name, fn) { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); },
        async dispatch(name, event = {}) { for (const fn of listeners.get(name) || []) await fn(event); },
        setAttribute() {}, removeAttribute() {}, getAttribute() { return null; },
        querySelectorAll() { return []; }, querySelector() { return null; }, closest() { return null; },
        replaceChildren() {}, append() {}, focus() {}, click() {},
        showModal() { this.open = true; }, close() { this.open = false; },
        getBoundingClientRect() { return { height: 0, top: 0, bottom: 0 }; },
      });
    }
    return elements.get(id);
  };
  const html = makeHtml(ROWS, {
    comparisonMode: "bilingual", files: { jp: "A.txt", cn: "B.txt" }, labels: { jp: "原文", cn: "译文" },
  }, { projectKey, rowsSignature: "rows", notesStorage: { key: currentKey } });
  element("rowData").textContent = html.match(/<script id="rowData" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const statusQueue = options.statusQueue ? options.statusQueue.slice() : [];
  const fetches = [];
  const posts = [];
  const context = vm.createContext({
    document: {
      getElementById: element, querySelector: element, querySelectorAll() { return []; },
      createElement: () => element(Symbol()), createElementNS: () => element(Symbol()),
      documentElement: element("html"), addEventListener() {},
    },
    localStorage: storage, console, URL, URLSearchParams, TextEncoder, Blob,
    window: { addEventListener() {}, requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {} },
    navigator: {}, location: { protocol: "file:" },
    fetch(url, request = {}) {
      fetches.push(String(url));
      if (request.body) posts.push({ url: String(url), body: JSON.parse(String(request.body)) });
      const responses = options.apiResponses || {};
      if (Object.prototype.hasOwnProperty.call(responses, String(url))) {
        const payload = responses[String(url)];
        return Promise.resolve({ ok: payload?.ok !== false, json: async () => payload });
      }
      const payload = statusQueue.shift() || { ok: true, ai: { kind: "", runId: "", running: false, results: [] } };
      return Promise.resolve({ ok: true, json: async () => payload });
    },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
    confirm() { return true; }, requestAnimationFrame() {},
  });
  vm.runInContext(script, context);
  return {
    element, storage, fetches, posts,
    run: (code) => vm.runInContext(code, context),
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

module.exports = { ROWS, projectKey, currentKey, siblingKey, storageFixture, createWorkbench, prefilterStatus, prefilterResult };
