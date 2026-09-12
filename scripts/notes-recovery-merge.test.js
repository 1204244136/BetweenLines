const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { makeHtml } = require("./build-compare");

const projectKey = "project";
const currentKey = `translation-compare-notes-v7:${projectKey}:rows`;
const siblingKey = `translation-compare-notes-v7:${projectKey}:rowsPrevious`;

const ROWS = [
  { index: 1, jp: "原文一", cn: "译文一", relation: "1:1", score: 0.9, signature: "sig-1" },
  { index: 2, jp: "原文二", cn: "译文二", relation: "1:1", score: 0.9, signature: "sig-2" },
];
const prefilterNote = "[规则预筛]\n语义是否相同：相同\n是否需要修改：否\n分析：规则预筛判定通过。";
const aiNote = "[AI校对]\n语义是否相同：不同\n是否需要修改：是\n分析：漏译。\n修改结果：改写后的译文内容。";

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

function createWorkbench(storage = storageFixture()) {
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
  const context = vm.createContext({
    document: {
      getElementById: element, querySelector: element, querySelectorAll() { return []; },
      createElement: () => element(Symbol()), createElementNS: () => element(Symbol()),
      documentElement: element("html"), addEventListener() {},
    },
    localStorage: storage, console, URL, Blob,
    window: { addEventListener() {}, requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {} },
    navigator: {}, location: { protocol: "file:" },
    fetch: () => new Promise(() => {}), setTimeout() {}, clearTimeout() {}, setInterval() {},
    confirm() { return true; }, requestAnimationFrame() {},
  });
  vm.runInContext(script, context);
  return { element, context, storage, run: (code) => vm.runInContext(code, context) };
}

test("条目相同的历史空间照旧找回（合并改写不改变原行为）", () => {
  const storage = storageFixture({
    [siblingKey]: JSON.stringify({
      1: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-1" },
      2: { note: aiNote, done: true, manualDone: true, aiDone: true, revisionText: "改写后的译文内容。", rowSig: "sig-2" },
    }),
  });
  const ui = createWorkbench(storage);
  assert.equal(ui.run('notes["1"].manualDone'), true);
  assert.equal(ui.run('notes["2"].manualDone'), true);
  assert.equal(ui.run('notes["2"].revisionText'), "改写后的译文内容。");
  assert.equal(JSON.parse(storage.getItem(currentKey))[1].rowSig, "sig-1");
});

test("同一行在多份历史空间记录不同时逐字段合并，不再把人工确认整条丢掉", () => {
  const storage = storageFixture({
    [siblingKey]: JSON.stringify({
      1: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-1" },
    }),
    "translation-compare-notes-v7:project:rowsOlder": JSON.stringify({
      1: { note: aiNote, done: true, manualDone: true, aiDone: true, revisionText: "改写后的译文内容。", revisionTarget: "cn", rowSig: "sig-1" },
    }),
  });
  const ui = createWorkbench(storage);
  // 两处空间对第 1 行的记录不同（预筛结论 ↔ AI 结论），过去会被 variants.size === 1 整条丢弃。
  assert.equal(ui.run('Boolean(notes["1"])'), true, "记录不同也必须找回");
  assert.equal(ui.run('notes["1"].manualDone'), true, "人工确认必须保留");
  assert.equal(ui.run('notes["1"].done'), true);
  assert.equal(ui.run('notes["1"].revisionText'), "改写后的译文内容。");
  assert.match(ui.run('notes["1"].note'), /修改结果：改写后的译文内容。/);
  assert.equal(ui.run('notes["1"].mergedFromSpaces'), true);
  const saved = JSON.parse(storage.getItem(currentKey));
  assert.equal(saved[1].manualDone, true);
  assert.equal(saved[1].rowSig, "sig-1");
  assert.match(ui.element("aiStatus").textContent, /合并了多个历史版本的记录/);
});

test("预览找回时本页已有记录的行也按签名合并，不丢历史空间里的人工确认", () => {
  const storage = storageFixture({
    // 本页空间已有第 1 行的 AI 结论（未确认）；历史空间里同一行是「确认预筛」的人工确认。
    [currentKey]: JSON.stringify({
      1: { note: aiNote, done: false, manualDone: false, aiDone: true, revisionText: "改写后的译文内容。", revisionTarget: "cn", rowSig: "sig-1" },
    }),
    [siblingKey]: JSON.stringify({
      1: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-1" },
      2: { note: prefilterNote, done: true, manualDone: true, aiDone: true, revisionText: "", rowSig: "sig-2" },
    }),
  });
  const ui = createWorkbench(storage);
  assert.equal(ui.run('notes["1"].manualDone'), false, "没有找回动作之前本页记录不该被改动");
  const space = ui.run(`collectNotesSpaces().find((item) => item.key === ${JSON.stringify(siblingKey)}).raw`);
  ui.run(`previewNotesRecovery(collectNotesSpaces().find((item) => item.key === ${JSON.stringify(siblingKey)}))`);
  // 第 1 行本页已有记录：按签名合并（人工确认保留）；第 2 行本页没有记录：照常待找回。
  assert.equal(ui.run('notes["1"].manualDone'), true, "历史空间的人工确认必须合并进本页记录");
  assert.equal(ui.run('notes["1"].mergedFromSpaces'), true);
  assert.equal(ui.run("pendingNotesRecovery.plan.merged"), 1);
  assert.equal(ui.run("pendingNotesRecovery.plan.pairs.map((pair) => pair.to).join(',')"), "2");
  assert.equal(ui.element("applyNotesRecovery").textContent, "找回 1 条");
  const plan = JSON.parse(ui.run("JSON.stringify(pendingNotesRecovery.plan)"));
  assert.equal(plan.pairs.length, 1);
  assert.equal(ui.run(`localStorage.getItem(${JSON.stringify(siblingKey)})`), space, "来源空间始终保留");
});
