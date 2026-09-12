const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { makeHtml, alignLegacyNotes } = require("./build-compare");
const { createNotesTools } = require("../src/workbenches/translation-compare/notes-spaces");

const helpers = createNotesTools(alignLegacyNotes);
const key = "translation-compare-notes-v7:project:rows";
const sourceKey = "translation-compare-notes-v7:previous:rows";

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
  const html = makeHtml([{ index: 1, jp: "原文", cn: "译文", relation: "1:1", score: 0.5, signature: "sig-1" }], {
    comparisonMode: "bilingual", files: { jp: "A.txt", cn: "B.txt" }, labels: { jp: "原文", cn: "译文" },
  }, { projectKey: "project", rowsSignature: "rows", notesStorage: { key } });
  element("rowData").textContent = html.match(/<script id="rowData" type="application\/json">([\s\S]*?)<\/script>/)[1];
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>\s*<\/body>/)[1];
  const context = vm.createContext({
    document: {
      getElementById: element, querySelector: element, querySelectorAll() { return []; },
      createElement: () => element(Symbol()), createElementNS: () => element(Symbol()),
      documentElement: element("html"), addEventListener() {},
    },
    localStorage: storage, console, URL, URLSearchParams, TextEncoder, Blob,
    window: { addEventListener() {}, requestAnimationFrame() {}, setTimeout() {}, clearTimeout() {} },
    navigator: {}, location: { protocol: "file:" },
    fetch: () => new Promise(() => {}), setTimeout() {}, clearTimeout() {}, setInterval() {},
    confirm() { return true; }, requestAnimationFrame() {},
  });
  vm.runInContext(script, context);
  return { element, context, storage, run: (code) => vm.runInContext(code, context) };
}

test("generated workbench recovers in memory on quota failure and preserves its source", () => {
  const raw = JSON.stringify({ 1: { note: "历史备注", manualDone: true } });
  const storage = storageFixture({ [sourceKey]: raw });
  storage.failWrites = true;
  const ui = createWorkbench(storage);
  assert.equal(ui.run('notes["1"].note'), "历史备注");
  assert.equal(storage.getItem(sourceKey), raw);
  assert.equal(storage.getItem(key), null);
  assert.equal(ui.element("notesSaveWarning").hidden, false);
  assert.match(ui.element("notesSaveState").textContent, /尚未保存/);
  storage.failWrites = false;
  ui.run("persistNotes()");
  assert.equal(JSON.parse(storage.getItem(key))[1].rowSig, "sig-1");
});

test("exports include unsaved revisions and unverified entries stay unverified across reloads", () => {
  const ui = createWorkbench(storageFixture({ [key]: "{}" }));
  ui.run('notes["1"] = { note: "待核验", manualDone: true, recoveredUnverified: true, rowSig: "old" }; persistNotes();');
  const saved = JSON.parse(ui.storage.getItem(key));
  assert.equal(saved[1].rowSig, undefined);
  const reopened = createWorkbench(ui.storage);
  assert.equal(reopened.run('notes["1"].manualDone'), false);
  reopened.run('notes["1"].revisionText = "尚未保存的修订"');
  const backup = JSON.parse(reopened.run("JSON.stringify(notesBackup(collectNotesSpaces()))"));
  assert.equal(JSON.parse(backup.spaces[0].raw)[1].revisionText, "尚未保存的修订");
});

test("explicitly cleared spaces stay empty and malformed current data is protected and backed up", () => {
  const old = JSON.stringify({ 1: { note: "旧记录", rowSig: "sig-1" } });
  const cleared = createWorkbench(storageFixture({ [key]: "{}", [sourceKey]: old }));
  assert.equal(cleared.run("Object.keys(notes).length"), 0);
  const corrupt = createWorkbench(storageFixture({ [key]: "{broken" }));
  assert.equal(corrupt.run("persistNotes()"), false);
  assert.equal(corrupt.storage.getItem(key), "{broken");
  const backup = JSON.parse(corrupt.run("JSON.stringify(notesBackup(collectNotesSpaces()))"));
  assert(backup.spaces.some((space) => space.raw === "{broken"));
});

test("automatic recovery merges contradictory historical notes for the same row signature instead of dropping them", () => {
  // 同一行在两份历史空间里记录不同（例如 [规则预筛] 结论 ↔ [AI校对] 结论）：按行内容签名逐字段合并，
  // 不再整条丢弃——那样会把「确认预筛」的人工确认一起丢掉。
  const ui = createWorkbench(storageFixture({
    [sourceKey]: JSON.stringify({ 1: { note: "第一份记录", manualDone: true, rowSig: "sig-1" } }),
    "translation-compare-notes-v5:previous:rows": JSON.stringify({ 1: { note: "不同的记录", rowSig: "sig-1" } }),
  }));
  assert.equal(ui.run("Object.keys(notes).length"), 1);
  assert.equal(ui.run('notes["1"].manualDone'), true, "任一历史空间确认过、行签名又对得上，人工确认必须保留");
  assert.match(ui.run('notes["1"].note'), /第一份记录/);
  assert.match(ui.run('notes["1"].note'), /不同的记录/);
  assert.notEqual(ui.storage.getItem(key), null);
});

test("automatic recovery never invents manual confirmation for unconfirmed historical notes", () => {
  const ui = createWorkbench(storageFixture({
    [sourceKey]: JSON.stringify({ 1: { note: "第一份记录", rowSig: "sig-1" } }),
    "translation-compare-notes-v5:previous:rows": JSON.stringify({ 1: { note: "不同的记录", rowSig: "sig-1" } }),
  }));
  assert.equal(ui.run("Object.keys(notes).length"), 1);
  assert.equal(ui.run('notes["1"].manualDone'), false);
  assert.equal(ui.run('notes["1"].mergedFromSpaces'), undefined);
});

test("preview requires an explicit index action and never overwrites rows added during preview", async () => {
  const unrelated = "translation-compare-notes-v7:other:otherRows";
  const ui = createWorkbench(storageFixture({ [key]: "{}", [unrelated]: JSON.stringify({ 1: { note: "其他项目" } }) }));
  ui.run('previewNotesRecovery(notesSpaceInventory.find(space => !space.current))');
  assert.equal(ui.element("applyNotesRecovery").disabled, true);
  ui.run('previewNotesRecovery(notesSpaceInventory.find(space => !space.current), true)');
  assert.equal(ui.element("applyNotesRecovery").disabled, false);
  ui.run('notes["1"] = { note: "新写的备注" }');
  await ui.element("applyNotesRecovery").dispatch("click");
  assert.equal(ui.run('notes["1"].note'), "新写的备注");
});

test("file imports use the same backup decoder and do not overwrite active state", async () => {
  const ui = createWorkbench(storageFixture({ [key]: JSON.stringify({ 1: { note: "当前备注" } }) }));
  ui.element("importNotesFile").files = [{ text: async () => JSON.stringify({ 1: { note: "旧单空间备份" } }) }];
  await ui.element("importNotesFile").dispatch("change");
  assert.equal(ui.run('notes["1"].note'), "当前备注");
  assert.equal(ui.storage.length, 2);
  assert.match(ui.element("notesPanelStatus").textContent, /已导入 1/);
  await ui.element("importNotesFile").dispatch("change");
  assert.equal(ui.storage.length, 2);
});

test("individual confirmation clears recovery quarantine and writes a fresh signature", async () => {
  const ui = createWorkbench(storageFixture({ [key]: JSON.stringify({ 1: { note: "待核验", recoveredUnverified: true } }) }));
  const box = { dataset: { done: "1" }, checked: true, closest() { return ui.element("row-1"); } };
  await ui.element("tbody").dispatch("change", { target: { closest(selector) { return selector === "[data-done]" ? box : null; } } });
  ui.run("persistNotes()");
  const saved = JSON.parse(ui.storage.getItem(key))[1];
  assert.equal(saved.recoveredUnverified, undefined);
  assert.equal(saved.manualDone, true);
  assert.equal(saved.rowSig, "sig-1");
});

test("a second page changing the active space cannot be overwritten by a delayed save or retry", async () => {
  const ui = createWorkbench(storageFixture({ [key]: "{}" }));
  ui.run('notes["1"] = { note: "本页编辑" }');
  const other = JSON.stringify({ 1: { note: "另一页修改" } });
  ui.storage.setItem(key, other);
  assert.equal(ui.run("persistNotes()"), false);
  await ui.element("retryNotesSave").dispatch("click");
  assert.equal(ui.storage.getItem(key), other);
  assert.equal(ui.run('notes["1"].note'), "本页编辑");
  assert.equal(ui.element("notesSaveWarning").hidden, false);
});

test("recovery excludes ambiguous signatures and marks text inference as unverified", () => {
  const rows = [{ index: 1, signature: "same" }, { index: 2, signature: "same" }];
  assert.equal(helpers.plan({ 3: { note: "note", rowSig: "same" } }, rows, {}).pairs.length, 0);
  assert.equal(helpers.plan({ 3: { note: "a", rowSig: "same" }, 4: { note: "b", rowSig: "same" } }, [rows[0]], {}).pairs.length, 0);
  const plan = helpers.plan({ 1: { note: "old", recoveredUnverified: true } }, rows, {}, { sameSnapshot: true });
  assert.equal(plan.verified, 0);
  assert.equal(plan.unverified, 1);
});

test("partial file imports preserve every existing space and report remaining failures", () => {
  const storage = storageFixture({ [key]: "{}" });
  let writes = 0;
  const set = storage.setItem.bind(storage);
  storage.setItem = (...args) => { if (++writes > 1) throw Error("Quota"); set(...args); };
  const result = helpers.importBackup(storage, [{ key: sourceKey, raw: "{}" }, { key: sourceKey + ":import-1", raw: '{"1":{"note":"x"}}' }], key);
  assert.equal(result.imported.length, 1);
  assert.equal(result.failed, 1);
  assert.equal(storage.getItem(key), "{}");
  assert.throws(() => helpers.decodeBackup({ format: "betweenlines-notes", version: 1, spaces: [{ key: "other-app", raw: "{}" }] }));
  assert.throws(() => helpers.decodeBackup({ 1: "not a note" }));
});

test("clear current notes keeps history, and clear history keeps the current space", async () => {
  const historyKey = "translation-compare-notes-v7:previous:rows";
  const ui = createWorkbench(storageFixture({
    [key]: JSON.stringify({ 1: { note: "当前记录" } }),
    [historyKey]: JSON.stringify({ 1: { note: "历史记录" } }),
  }));
  await ui.element("clearCurrentNotes").dispatch("click");
  assert.equal(ui.storage.getItem(key), "{}");
  assert.notEqual(ui.storage.getItem(historyKey), null);
  assert.equal(ui.run("Object.keys(notes).length"), 0);
  ui.storage.setItem(key, JSON.stringify({ 1: { note: "当前记录" } }));
  ui.run('notes["1"] = { note: "当前记录" }; lastPersistedNotesRaw = localStorage.getItem(storageKey); renderNotesSpaces();');
  await ui.element("clearHistoryNotes").dispatch("click");
  assert.notEqual(ui.storage.getItem(key), null);
  assert.equal(ui.storage.getItem(historyKey), null);
});

test("低分归因与线上查证属于分析栏，不会被并进可写回的修改结果", () => {
  const prose = [
    "修改结果：不如说越来越大了。",
    "低分归因：本行译文实际写的是**下一行**的内容（跨行错位），已保持原文行序、按本行原文重写",
    "线上查证：日文（atwiki）查到依据（结论见上方分析）",
    "标点自动规范化：半角→全角 3 处（中文标点全角、英文句子半角）",
  ];
  const note = [
    "[AI校对]",
    "语义是否相同：不同",
    "是否需要修改：是",
    "质量评分：20分（扣80分）",
    "分析：需要修改，存在严重的跨行错位与语义脱落。",
    ...prose,
  ].join("\n");
  // 修复前的备注就是这个形状：说明行跟在「修改结果：」后面，解析时会被并进修改结果。
  const legacyRevision = `不如说越来越大了。\n${prose[1]}\n${prose[2]}\n${prose[3]}`;
  const ui = createWorkbench(storageFixture({ [key]: JSON.stringify({ 1: { note, revisionText: legacyRevision } }) }));

  const parsed = ui.run('parseAutomatedNote(notes["1"].note)');
  assert.equal(parsed.revision, "不如说越来越大了。", "修改结果只能是本行成品文本");
  assert.match(parsed.analysis, /^需要修改，存在严重的跨行错位与语义脱落。\n/);
  assert.match(parsed.analysis, /低分归因：本行译文实际写的是\*\*下一行\*\*的内容/);
  assert.match(parsed.analysis, /线上查证：日文（atwiki）查到依据/);
  assert.match(parsed.analysis, /标点自动规范化：半角→全角 3 处/);

  assert.equal(
    ui.run('revisionTextFor(notes["1"])'),
    "不如说越来越大了。",
    "载入旧备注时要把并进修改结果的说明行剥掉，否则「写回」会把归因说明写进成品",
  );
  assert.equal(ui.run('isNoteProseLine("低分归因：跨行错位")'), true);
  assert.equal(ui.run('isNoteProseLine("标点自动规范化：半角→全角 3 处")'), true);
  assert.equal(ui.run('isNoteProseLine("修改结果：不如说越来越大了。")'), false);
});
