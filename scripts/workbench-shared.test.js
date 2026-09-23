const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "../public/workbench-shared.js"), "utf8");

function clipboardFixture({ writeText, fallback = () => true } = {}) {
  const state = { appended: 0, removed: 0, copied: "" };
  const helper = { style: {}, setAttribute() {}, select() {}, remove() { state.removed += 1; } };
  const context = vm.createContext({
    navigator: { clipboard: writeText ? { writeText } : undefined },
    document: {
      createElement: () => helper,
      body: { appendChild() { state.appended += 1; } },
      execCommand(command) {
        assert.equal(command, "copy");
        state.copied = helper.value;
        return fallback();
      },
    },
  });
  vm.runInContext(source, context);
  return { state, copy: (text) => context.copyText(text) };
}

test("共享复制：剪贴板 API 成功时无需旧式接口", async () => {
  let copied;
  const ui = clipboardFixture({ writeText: async (text) => { copied = text; } });
  await ui.copy("正文");
  assert.equal(copied, "正文");
  assert.equal(ui.state.appended, 0);
});

test("共享复制：剪贴板 API 拒绝后仍可通过旧式接口复制", async () => {
  const ui = clipboardFixture({ writeText: async () => { throw new Error("denied"); } });
  await ui.copy("修改结果");
  assert.equal(ui.state.copied, "修改结果");
  assert.equal(ui.state.removed, 1);
});

test("共享复制：旧式接口返回失败时拒绝成功回执并清理文本框", async () => {
  const ui = clipboardFixture({ fallback: () => false });
  await assert.rejects(ui.copy("正文"), /复制失败/);
  assert.equal(ui.state.removed, 1);
});

test("共享复制：两种接口均失败时传播异常并清理文本框", async () => {
  const ui = clipboardFixture({
    writeText: async () => { throw new Error("denied"); },
    fallback: () => { throw new Error("copy unavailable"); },
  });
  await assert.rejects(ui.copy("正文"), /copy unavailable/);
  assert.equal(ui.state.removed, 1);
});
