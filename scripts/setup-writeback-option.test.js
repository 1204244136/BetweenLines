// 「写回自动备份」开关只归工作台页面所有：控制台曾经也放了一份同名模块，两处互相覆盖。
// 这里锁住移除后的两端行为——控制台不再渲染/提交该开关，服务端保存输入选择时沿用项目已有取值。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "setup-writeback-option-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
const { saveSelection } = require("../src/ingest/input-selection");
const { saveInputSelection } = require("../src/runtime/input-files");
const { createConsole, html } = require("./setup-console-fixture");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("控制台不再渲染写回选项，保存输入选择时也不提交备份开关", async () => {
  assert.doesNotMatch(html, /translationWritebackPanel|writebackBackup/, "控制台不得重新引入写回选项模块");
  const ui = createConsole();
  const requests = [];
  ui.context.fetch = async (url, options = {}) => {
    requests.push({ url, body: options.body ? JSON.parse(options.body) : null });
    return { json: async () => ({ ok: true, selection: {} }) };
  };
  ui.run(`state.roleFiles = {
    jp: { path: "/samples/jp.epub", name: "jp.epub", ext: "epub", size: 10 },
    cn: { path: "/samples/cn.epub", name: "cn.epub", ext: "epub", size: 10 },
    tw: null,
  };
  state.comparisonMode = "bilingual";`);
  await ui.run("persistSelection()");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/selection");
  assert.equal(Object.hasOwn(requests[0].body, "writebackBackup"), false);
});

test("服务端保存控制台输入选择时沿用项目已保存的备份设置", () => {
  const jp = path.join(dataDir, "jp.html");
  const cn = path.join(dataDir, "cn.html");
  fs.writeFileSync(jp, "<p>原文。</p>", "utf8");
  fs.writeFileSync(cn, "<p>译文。</p>", "utf8");
  const base = { comparisonMode: "bilingual", files: { jp, cn } };
  saveSelection({ ...base, writebackBackup: true });

  // 控制台保存时不再提交该字段：沿用已在工作台开启的设置，不得静默重置为关闭。
  const preserved = saveInputSelection(base);
  assert.equal(preserved.selection.writebackBackup, true);
  assert.equal(JSON.parse(fs.readFileSync(preserved.selectionFile, "utf8")).writebackBackup, true);

  // 其他调用方显式传参时仍然以传参为准。
  assert.equal(saveInputSelection({ ...base, writebackBackup: false }).selection.writebackBackup, false);
});
