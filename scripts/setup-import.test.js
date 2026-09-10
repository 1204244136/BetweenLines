const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const html = fs.readFileSync(path.join(__dirname, "..", "public", "setup.html"), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];

function createConsole() {
  const elements = new Map();
  const documentEvents = {};
  const element = (id) => {
    if (!elements.has(id)) {
      const attributes = {};
      elements.set(id, {
        hidden: true, disabled: false, value: "", textContent: "", innerHTML: "",
        dataset: {}, style: {}, classList: { toggle() {}, add() {}, remove() {} },
        addEventListener() {}, replaceChildren() {},
        setAttribute(name, value) { attributes[name] = value; },
        getAttribute(name) { return attributes[name]; },
        focus() { this.focused = true; },
      });
    }
    return elements.get(id);
  };
  const context = vm.createContext({
    document: {
      getElementById: element, querySelector: element, createElement: () => element(Symbol()),
      addEventListener(name, handler) { documentEvents[name] = handler; },
    },
    localStorage: { getItem() { return null; }, setItem() {} },
    fetch: async () => ({ json: async () => ({ ok: false }) }),
    setInterval() {},
  });
  vm.runInContext(script, context);
  const run = (code) => vm.runInContext(code, context);
  return { context, element, documentEvents, run };
}

for (const mode of ["file", "folder"]) {
  test(`console registers ${mode} with shared busy and success feedback`, async () => {
    const ui = createConsole();
    let finish;
    const file = { name: "sample", path: `/samples/${mode}`, ext: "epub", size: 1024,
      ...(mode === "folder" ? { kind: "directory" } : {}) };
    ui.context.fetch = (url, options) => {
      assert.equal(url, "/api/pick-path");
      assert.equal(JSON.parse(options.body).mode, mode);
      return new Promise((resolve) => { finish = () => resolve({ json: async () => ({ ok: true, file }) }); });
    };
    const pending = ui.run(`applyNativePick("jp", "${mode}")`);
    assert.equal(ui.element("jpDropzone").getAttribute("aria-busy"), "true");
    assert.equal(ui.element("cnDropzone").disabled, true);
    assert.equal(ui.element("runButton").disabled, true);
    finish();
    await pending;
    assert.equal(ui.run("state.roleFiles.jp.path"), file.path);
    assert.equal(ui.element("jpImportStatus").dataset.state, "ok");
    assert.match(ui.element("jpDropzone").innerHTML, mode === "folder" ? /EPUB 文件夹/ : /单个文件/);
    assert.equal(ui.element("jpDropzone").getAttribute("aria-busy"), "false");
    assert.equal(ui.element("cnDropzone").disabled, false);
  });
}

test("cancel, invalid selection and duplicate selection preserve the previous input", async () => {
  const ui = createConsole();
  ui.run('registerLocalFile("jp", { path: "/samples/old.epub", name: "old.epub", ext: "epub", size: 10 })');
  for (const payload of [{ ok: true, canceled: true }, { ok: false, error: "无效的 EPUB 文件夹" }]) {
    ui.context.fetch = async () => ({ json: async () => payload });
    await ui.run('applyNativePick("jp", "folder")');
    assert.equal(ui.run("state.roleFiles.jp.path"), "/samples/old.epub");
    assert.equal(ui.element("jpImportStatus").textContent, payload.canceled ? "已取消更换，保留原选择。" : payload.error);
  }
  ui.run('registerLocalFile("cn", { path: "/samples/other.epub", name: "other.epub", ext: "epub", size: 10 })');
  ui.context.fetch = async () => ({ json: async () => ({ ok: true, file: { path: "/samples/other.epub" } }) });
  await ui.run('applyNativePick("jp", "file")');
  assert.equal(ui.run("state.roleFiles.jp.path"), "/samples/old.epub");
  assert.match(ui.element("jpImportStatus").textContent, /选择不同的输入/);
});

test("manual path fallback retains copy provenance and its writeback label", async () => {
  const ui = createConsole();
  ui.element("jpLocalPath").value = '"/samples/imported.epub"';
  ui.context.fetch = async (url, options) => {
    assert.equal(url, "/api/validate-input");
    assert.equal(JSON.parse(options.body).path, "/samples/imported.epub");
    return { json: async () => ({ ok: true, file: {
      path: "/samples/imported.epub", name: "imported.epub", source: "copy", size: 10,
    } }) };
  };
  await ui.run('applyLocalPath("jp")');
  assert.equal(ui.run("state.roleFiles.jp.source"), "copy");
  assert.match(ui.element("jpDropzone").innerHTML, /写回已导入副本/);
});

test("Escape closes the import choices and returns focus to the owning card", () => {
  const ui = createConsole();
  ui.run('setPickMenuOpen("jp", true)');
  ui.documentEvents.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ui.element("jpPickMenu").hidden, true);
  assert.equal(ui.element("jpDropzone").getAttribute("aria-expanded"), "false");
  assert.equal(ui.element("jpDropzone").focused, true);
});
