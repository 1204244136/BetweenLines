const assert = require("node:assert/strict");
const test = require("node:test");

const { createConsole, html } = require("./setup-console-fixture");

for (const mode of ["file", "folder"]) {
  test(`控制台登记${mode === "folder" ? "文件夹" : "文件"}：具备忙碌态与成功反馈`, async () => {
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

test("取消、无效选择及重复选择时保留先前的输入", async () => {
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

test("手动路径回退保留副本来源与对应写回标签", async () => {
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

test("按下 Escape 关闭导入选项菜单并将焦点返还所属卡片", () => {
  const ui = createConsole();
  ui.run('setPickMenuOpen("jp", true)');
  ui.documentEvents.keydown({ key: "Escape", preventDefault() {} });
  assert.equal(ui.element("jpPickMenu").hidden, true);
  assert.equal(ui.element("jpDropzone").getAttribute("aria-expanded"), "false");
  assert.equal(ui.element("jpDropzone").focused, true);
});

test("选择窗口请求带上所属导入入口与该卡片当前路径", async () => {
  const ui = createConsole();
  ui.run('registerLocalFile("cn", { path: "/samples/main/book.epub", name: "book.epub", ext: "epub", size: 10 })');
  let body;
  ui.context.fetch = async (url, options) => {
    assert.equal(url, "/api/pick-path");
    body = JSON.parse(options.body);
    return { json: async () => ({ ok: true,
      file: { path: "/samples/main/next.epub", name: "next.epub", ext: "epub", size: 10 } }) };
  };
  await ui.run('applyNativePick("cn", "file")');
  // 服务端据此为每个入口分别推导起始目录，而不是三个入口共用一份「上次位置」。
  assert.equal(body.role, "cn");
  assert.equal(body.currentPath, "/samples/main/book.epub");
  assert.equal(ui.run("state.roleFiles.cn.path"), "/samples/main/next.epub");
});

test("导入选项菜单只保留标题，不再显示默认目录提示", () => {
  // 提示与标题同行时，长路径会把「选择导入方式」挤成竖排；该提示已整体移除。
  assert.doesNotMatch(html, /PickDefault/);
  assert.doesNotMatch(html, /pick-menu-hint/);
  assert.doesNotMatch(html, /默认打开/);
});
