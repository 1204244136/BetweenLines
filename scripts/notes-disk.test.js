const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { createNotesFileStore } = require("../src/workbenches/translation-compare/notes-file-store");
const { createDiskNotesStorage } = require("../src/workbenches/translation-compare/notes-disk-storage");
const { createNotesStorage } = require("../src/workbenches/translation-compare/notes-storage");
const { createWorkbench, storageFixture, currentKey, siblingKey } = require("./workbench-fixture");
const { deleteProject, publishProject, projectArtifacts } = require("./project-store");
const codec = require("lz-string");

const raw = (text) => JSON.stringify({ 1: { note: text, manualDone: true, rowSig: "sig-1" } });
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-notes-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const store = createNotesFileStore({ dataDir });
  const calls = [];
  const control = { fail: false, defer: null };
  async function request(url, options = {}) {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, body });
    if (control.defer) await control.defer;
    if (control.fail) throw new Error("磁盘暂不可写");
    try {
      const action = url.split("/").at(-1);
      const payload = action === "spaces" ? store.list() : { space: ({ write: store.write,
        import: store.importSpace, delete: store.remove, recovery: store.markRecovery })[action](body) };
      return { ok: true, status: 200, json: async () => ({ ok: true, ...payload }) };
    } catch (error) {
      return { ok: false, status: error.statusCode || 400, json: async () => ({ ok: false, error: error.message }) };
    }
  }
  const create = (browser = storageFixture()) => createDiskNotesStorage({ bootstrap: store.list(),
    browserStorage: createNotesStorage(browser, codec), request, currentKey });
  return { dataDir, store, request, calls, control, create };
}

test("备注持久化与旧快照清理、项目删除独立，换会话或清空浏览器后仍可读取", async (t) => {
  const f = fixture(t);
  const disk = f.create();
  disk.setItem(currentKey, raw("人工备注"));
  assert.equal(disk.snapshot().pending, true);
  await disk.flush();
  const restarted = createNotesFileStore({ dataDir: f.dataDir });
  assert.equal(restarted.read(currentKey).raw, raw("人工备注"));
  const newBrowser = f.create(storageFixture());
  assert.equal(newBrowser.getItem(currentKey), raw("人工备注"));
  for (const id of ["old", "new"]) {
    const dir = path.join(f.dataDir, "projects", "project", "snapshots", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "project.json"), JSON.stringify({ id: "project", snapshotId: id,
      generatedAt: id === "new" ? "2026-02-01" : "2026-01-01" }));
  }
  const staging = path.join(f.dataDir, ".staging", "publish");
  fs.mkdirSync(staging, { recursive: true });
  for (const name of projectArtifacts) fs.writeFileSync(path.join(staging, name), "{}");
  fs.writeFileSync(path.join(staging, "translation-compare.json"), JSON.stringify({
    project: { projectKey: "project", generatedAt: "2026-03-01T00:00:00.000Z", rowsSignature: "rows" }, rows: [],
  }));
  publishProject(staging, { dataDir: f.dataDir });
  assert.equal(fs.existsSync(path.join(f.dataDir, "projects", "project", "snapshots", "old")), false);
  deleteProject("project", { dataDir: f.dataDir });
  assert.equal(restarted.read(currentKey).raw, raw("人工备注"));
});

test("迁移全部项目、压缩和损坏的旧空间；同名冲突留副本，核验后才释放浏览器", async (t) => {
  const f = fixture(t);
  f.store.write({ key: currentKey, raw: raw("磁盘版本"), expectedVersion: null });
  const foreign = "translation-compare-notes-v7:foreign:rows";
  const broken = "translation-compare-notes-v6:old:broken";
  const auxiliary = currentKey + ":previous-notes-migration-1";
  const browser = storageFixture({ [broken]: "broken-json", [auxiliary]: "marker" });
  const encoded = createNotesStorage(browser, codec);
  encoded.setItem(currentKey, raw("浏览器版本"));
  encoded.setItem(foreign, raw("长备注".repeat(2000)));
  const disk = f.create(browser);
  assert.equal(disk.getItem(currentKey), raw("磁盘版本"));
  f.control.fail = true;
  await assert.rejects(disk.flush(), /暂不可写/);
  assert.equal(encoded.getItem(currentKey), raw("浏览器版本"));
  f.control.fail = false;
  await disk.flush();
  assert.equal(encoded.getItem(currentKey), null);
  assert.equal(encoded.getItem(foreign), null);
  assert.equal(encoded.getItem(broken), null);
  assert.equal(browser.getItem(auxiliary), "marker");
  const spaces = f.store.list().spaces;
  assert.ok(spaces.some((space) => space.key.startsWith(currentKey + ":import-") && space.raw === raw("浏览器版本")));
  assert.equal(f.store.read(broken).raw, "broken-json");
  const count = spaces.length;
  f.store.importSpace({ key: currentKey, raw: raw("浏览器版本") });
  assert.equal(f.store.list().spaces.length, count);
});

test("写入期间继续编辑最终保存最新内容，失败保留队列并可显式重试", async (t) => {
  const f = fixture(t);
  const disk = f.create();
  let release;
  f.control.defer = new Promise((resolve) => { release = resolve; });
  disk.setItem(currentKey, raw("第一版"));
  for (let i = 0; i < 5; i++) await Promise.resolve();
  disk.setItem(currentKey, raw("第二版"));
  release();
  await disk.flush();
  assert.equal(f.store.read(currentKey).raw, raw("第二版"));
  f.control.fail = true;
  disk.setItem(currentKey, raw("尚未保存"));
  await assert.rejects(disk.flush(), /暂不可写/);
  assert.equal(f.store.read(currentKey).raw, raw("第二版"));
  assert.equal(disk.getItem(currentKey), raw("尚未保存"));
  assert.equal(disk.snapshot().failed, true);
  f.control.fail = false;
  await disk.flush();
  assert.equal(f.store.read(currentKey).raw, raw("尚未保存"));
  assert.equal(disk.snapshot().pending, false);
});

test("多页面修改与删除使用版本检查，旧页面不能覆盖或复活记录", async (t) => {
  const f = fixture(t);
  f.store.write({ key: currentKey, raw: raw("基线"), expectedVersion: null });
  const a = f.create();
  const b = f.create();
  a.setItem(currentKey, raw("页面 A"));
  await a.flush();
  b.setItem(currentKey, raw("页面 B"));
  await assert.rejects(b.flush(), /其他页面/);
  assert.equal(b.snapshot().blocked, true);
  assert.equal(b.getItem(currentKey), raw("页面 B"));
  assert.equal(f.store.read(currentKey).raw, raw("页面 A"));
  const stale = f.create();
  a.removeItem(currentKey);
  await a.flush();
  stale.setItem(currentKey, raw("旧页面迟到结果"));
  await assert.rejects(stale.flush(), /其他页面/);
  assert.equal(f.store.read(currentKey).raw, null);
});

test("删除失败仍可导出原记录，刷新会检测其他页面的新版本", async (t) => {
  const f = fixture(t);
  f.store.importSpace({ key: siblingKey, raw: raw("历史记录") });
  const disk = f.create();
  f.control.fail = true;
  disk.removeItem(siblingKey);
  await assert.rejects(disk.flush());
  assert.equal(disk.getItem(siblingKey), raw("历史记录"));
  f.control.fail = false;
  await disk.flush();
  assert.equal(disk.getItem(siblingKey), null);
  f.store.write({ key: currentKey, raw: raw("别页新增"), expectedVersion: null });
  await assert.rejects(disk.refresh(), /其他页面/);
});

test("文件身份与校验保护磁盘数据，动态注入不改生成快照也不允许脚本逃逸", (t) => {
  const f = fixture(t);
  f.store.importSpace({ key: currentKey, raw: raw("</script><script>alert(1)</script>") });
  const source = '<script id="notesDiskData" type="application/json">null</script>';
  const html = f.store.inject(source);
  assert.ok(html.includes("\\u003c/script>"));
  assert.equal(source, '<script id="notesDiskData" type="application/json">null</script>');
  assert.throws(() => f.store.write({ key: "../escape", raw: "{}", expectedVersion: null }));
  const directory = f.store.list().directory;
  const file = path.join(directory, fs.readdirSync(directory)[0]);
  const record = JSON.parse(fs.readFileSync(file, "utf8"));
  record.raw = "{}";
  fs.writeFileSync(file, JSON.stringify(record));
  assert.throws(() => f.store.list(), /损坏/);
  assert.match(f.store.inject(source), /error/);
});

test("迁移后旧工作台快照暂停浏览器脚本并引导更新，其他页面不受影响", (t) => {
  const f = fixture(t);
  const legacy = '<details id="notesPanel"></details><script id="rowData">[]</script><script>oldClient()</script>';
  const html = f.store.inject(legacy);
  assert.match(html, /请先应用新布局/);
  assert.doesNotMatch(html, /oldClient/);
  assert.equal(f.store.inject("<html>setup</html>"), "<html>setup</html>");
});

test("恢复标记单独写入失败不误报备注未保存，也不影响后续内容提交", async (t) => {
  const f = fixture(t);
  const disk = f.create();
  disk.setItem(currentKey, raw("恢复内容"));
  await disk.flush();
  f.control.fail = true;
  assert.equal(await disk.markRecovery("a".repeat(64)), false);
  assert.equal(disk.snapshot().failed, false);
  assert.equal(disk.snapshot().pending, false);
  assert.equal(f.store.read(currentKey).raw, raw("恢复内容"));
  f.control.fail = false;
  disk.setItem(currentKey, raw("后续编辑"));
  await disk.flush();
  assert.equal(f.store.read(currentKey).raw, raw("后续编辑"));
});

test("生成页面以磁盘回读为保存成功，迁移失败可重试且浏览器原数据不丢", async (t) => {
  const f = fixture(t);
  const browser = storageFixture({ [currentKey]: raw("旧记录") });
  const ui = createWorkbench(browser, { diskBootstrap: f.store.list(), windowData: { location: { protocol: "http:" } },
    apiResponses: Object.fromEntries(["write", "import", "delete"].map((action) => ["/api/notes/spaces/" + action,
      async (request) => (await f.request("/api/notes/spaces/" + action, request)).json()])) });
  f.control.fail = true;
  await ui.settle();
  assert.equal(browser.getItem(currentKey), raw("旧记录"));
  assert.match(ui.element("notesSaveState").textContent, /尚未保存/);
  f.control.fail = false;
  await ui.element("retryNotesSave").dispatch("click");
  await ui.settle();
  assert.match(ui.element("notesSaveState").textContent, /已保存到电脑/);
  assert.equal(browser.getItem(currentKey), null);
  assert.equal(JSON.parse(f.store.read(currentKey).raw)["1"].manualDone, true);
  ui.run('notes["1"].note = "更新后的人工备注"; saveNotes({ immediate: true })');
  assert.match(ui.element("notesSaveState").textContent, /正在保存/);
  await ui.settle();
  assert.equal(JSON.parse(f.store.read(currentKey).raw)["1"].note, "更新后的人工备注");
});

test("迁移并发新建当前空间保留双方且暂停提交，导入不能绕过当前空间版本检查", async (t) => {
  const f = fixture(t);
  const browser = storageFixture({ [currentKey]: raw("本页旧记录") });
  const disk = f.create(browser);
  f.store.write({ key: currentKey, raw: raw("别页记录"), expectedVersion: null });
  await assert.rejects(disk.flush(), /其他页面/);
  assert.equal(f.store.read(currentKey).raw, raw("别页记录"));
  assert.ok(f.store.list().spaces.some((space) => space.raw === raw("本页旧记录")));
  const other = f.create();
  const latest = f.store.read(currentKey);
  f.store.write({ key: currentKey, raw: raw("别页更新"), expectedVersion: latest.version });
  await assert.rejects(other.importSpaces([{ key: currentKey, raw: raw("别页更新") }]), /其他页面/);
  assert.equal(other.getItem(currentKey), raw("别页记录"));
  assert.equal(other.snapshot().blocked, true);
  assert.equal(f.store.read(currentKey).raw, raw("别页更新"));
});

test("回执不匹配或浏览器记录中途变化时不清理，清理权限失败不误报磁盘保存失败", async (t) => {
  const f = fixture(t);
  const browser = storageFixture({ [currentKey]: raw("迁移版本") });
  let disk = createDiskNotesStorage({ bootstrap: f.store.list(), currentKey,
    browserStorage: createNotesStorage(browser, codec), request: async () => ({ ok: true,
      json: async () => ({ ok: true, space: { key: currentKey, raw: "{}", version: "bad-receipt" } }) }) });
  await assert.rejects(disk.flush(), /核验/);
  assert.equal(browser.getItem(currentKey), raw("迁移版本"));
  disk = createDiskNotesStorage({ bootstrap: f.store.list(), currentKey,
    browserStorage: createNotesStorage(browser, codec), request: async (url, options) => {
      const response = await f.request(url, options);
      browser.setItem(currentKey, raw("旧页新版本"));
      return response;
    } });
  await disk.flush();
  assert.equal(browser.getItem(currentKey), raw("旧页新版本"));
  assert.match(disk.snapshot().cleanupWarning, /发生变化/);
  browser.removeItem = () => { throw new Error("禁止清理"); };
  disk = f.create(browser);
  await disk.flush();
  assert.equal(disk.snapshot().failed, false);
  assert.match(disk.snapshot().cleanupWarning, /未能清理/);
  assert.ok(f.store.list().spaces.some((space) => space.raw === raw("旧页新版本")));
});

test("生成页面待写时关闭有保护；恢复标记在磁盘持久化，清空浏览器后不重复恢复", async (t) => {
  const f = fixture(t);
  const browser = storageFixture();
  const apiResponses = Object.fromEntries(["write", "import", "delete", "recovery"].map((action) => ["/api/notes/spaces/" + action,
    async (request) => (await f.request("/api/notes/spaces/" + action, request)).json()]));
  const ui = createWorkbench(browser, { diskBootstrap: f.store.list(), windowData: { location: { protocol: "http:" } }, apiResponses });
  await ui.settle();
  let release;
  f.control.defer = new Promise((resolve) => { release = resolve; });
  const seed = { key: currentKey, id: "a".repeat(64), raw: raw("恢复备注") };
  const restoring = ui.run(`pageMeta.notesRecovery = ${JSON.stringify(seed)}; restorePageNotesSeed()`);
  await ui.settle();
  assert.equal(browser.getItem("translation-compare-recovery-v1:project:" + seed.id), null);
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  await ui.dispatchWindow("beforeunload", event);
  assert.equal(event.prevented, true);
  release();
  await restoring;
  await ui.settle();
  assert.deepEqual(f.store.read(currentKey).completedRecoveries, [seed.id]);
  await ui.element("clearCurrentNotes").dispatch("click");
  const cleared = f.store.read(currentKey);
  assert.equal(cleared.raw, "{}");
  assert.deepEqual(cleared.completedRecoveries, [seed.id]);
  const reloaded = createWorkbench(storageFixture(), { diskBootstrap: f.store.list(), windowData: { location: { protocol: "http:" } }, apiResponses });
  await reloaded.run(`pageMeta.notesRecovery = ${JSON.stringify(seed)}; restorePageNotesSeed()`);
  assert.equal(reloaded.run("Object.keys(notes).length"), 0);
});
