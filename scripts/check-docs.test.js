const assert = require("node:assert/strict");
const test = require("node:test");
const { checkRepository } = require("./check-docs");

const registryFile = "docs/contracts/documentation-tools.md";
function fixture(overrides = {}) {
  const files = {
    "README.md": "npm run build\n[契约](docs/contracts/documentation-tools.md)\n",
    [registryFile]: [
      "| 路径 | 类别 | 唯一职责 / 边界 |",
      "| --- | --- | --- |",
      "| README.md | 操作 | 用户运行入口 |",
      `| ${registryFile} | 契约 | 唯一登记 |`,
      "",
      "| 路径 | 角色 | 实现 / 下游入口 | 输入与副作用边界 |",
      "| --- | --- | --- | --- |",
      "| src/build.js | CLI | 自身 | 输入选择，写工作台 |",
      "",
      "| npm script | 兼容别名目标 |",
      "| --- | --- |",
      "| legacy | build |",
    ].join("\n"),
    "src/build.js": "",
    "scripts/build.test.js": "",
    ...overrides,
  };
  return { files, packageData: { scripts: { build: "node src/build.js", legacy: "npm run build" } }, registryFile };
}
const codes = (input) => checkRepository(input).errors.map((error) => error.code);

test("覆盖登记、有效本地链接与显式 npm 别名通过；测试文件不单独登记", () => {
  const result = checkRepository(fixture());
  assert.deepEqual(result.errors, []);
  assert.equal(result.documentCount, 2);
  assert.equal(result.toolCount, 1);
});

test("新增文档和工具没有登记会失败", () => {
  assert.deepEqual(codes(fixture({ "docs/new.md": "", "scripts/new-helper.js": "" })), ["unregistered", "unregistered"]);
});

test("重复登记、错误类别与已删除的登记路径会失败", () => {
  const input = fixture();
  input.files[registryFile] += "\n\n| 路径 | 类别 | 唯一职责 / 边界 |\n| --- | --- | --- |\n| README.md | 操作 | 重复 |\n| docs/deleted.md | 未分类 | 丢失 |";
  assert.deepEqual(codes(input), ["duplicate", "missing-path", "missing-boundary"]);
});

test("检查相对链接、引用链接与越界链接，保留正确行号", () => {
  const input = fixture({ "README.md": "npm run build\n[缺失](docs/missing.md#heading)\n[越界](../outside.md)\n[引用][missing]\n[missing]: docs/absent.md\n" });
  const result = checkRepository(input);
  assert.deepEqual(result.errors.map(({ code, line }) => ({ code, line })), [
    { code: "broken-link", line: 2 }, { code: "outside-link", line: 3 }, { code: "broken-link", line: 5 },
  ]);
});

test("忽略代码块的 Markdown 示例、外链与片段；仍检查代码块内的 npm 命令", () => {
  const input = fixture({ "README.md": [
    "```powershell", "npm run build", "[示例](missing.md)", "```",
    "~~~markdown", "[示例](../outside.md)", "~~~",
    "[外链](https://example.test/page) [片段](#heading) [用户示例](app://example)",
  ].join("\n") });
  assert.deepEqual(codes(input), []);
  input.files["README.md"] += "\n```powershell\nnpm run missing\n```";
  assert.deepEqual(codes(input), ["unknown-npm"]);
});

test("未知 npm 命令、缺少用法与错误别名不能绕过覆盖检查", () => {
  assert.deepEqual(codes(fixture({ "README.md": "npm run missing" })), ["unknown-npm", "undocumented-npm"]);
  const input = fixture();
  input.packageData.scripts.legacy = "node src/build.js";
  assert.deepEqual(codes(input), ["invalid-alias"]);
});

test("文档链接支持编码、带空格路径与目录，npm 直接 src 入口必须存在", () => {
  const input = fixture({ "assets/space name.svg": "", "README.md": "npm run build\n[根](./) [登记](docs/contracts/) [中文](docs/contracts/documentation%2Dtools.md) [标题](<src/build.js> \"标题\") [空格](<assets/space name.svg>)" });
  assert.deepEqual(codes(input), []);
  delete input.files["src/build.js"];
  assert.deepEqual(codes(input), ["missing-path", "missing-script-path", "broken-link"]);
});

test("npm 的 scripts 入口同样检查存在性，自动发现测试的通配符保留", () => {
  const input = fixture();
  input.packageData.scripts.probe = 'powershell -File "scripts\\missing.ps1"';
  input.packageData.scripts.test = "node --test scripts/*.test.js";
  input.files["README.md"] += "\nnpm run probe\nnpm test";
  assert.deepEqual(codes(input), ["missing-script-path"]);
});

test("npm 转发的缺失目标和已登记的循环别名不能绕过用法检查", () => {
  const missing = fixture();
  missing.packageData.scripts.build = "npm run missing";
  assert.deepEqual(codes(missing), ["outside-inventory", "unknown-npm-target"]);

  const cycle = fixture();
  cycle.packageData.scripts.build = "npm run legacy";
  cycle.files[registryFile] = cycle.files[registryFile].replace("| src/build.js | CLI | 自身 | 输入选择，写工作台 |", "")
    + "\n| build | legacy |";
  cycle.files["README.md"] = "";
  assert.deepEqual(codes(cycle), ["cyclic-npm"]);
});
