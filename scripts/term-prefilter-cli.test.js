const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { parseArgs } = require("./term-prefilter");

const cli = path.join(__dirname, "term-prefilter.js");

function runCli(args) {
  const dataDir = path.join(os.tmpdir(), `between-lines-term-cli-${randomUUID()}`);
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: { ...process.env, TRANSCOMPARATOR_DATA_DIR: dataDir },
    timeout: 15000,
  });
  assert.ifError(result.error);
  assert.equal(fs.existsSync(dataDir), false, "参数校验不应创建运行时数据目录");
  return result;
}

for (const args of [["--json"], ["--out", "report.json"], ["--limit", "20"], ["--limit", "0"], ["--all"], ["-o", "report.json"], ["-n", "0"]]) {
  test(`构建期汇总拒绝 ${args.join(" ")}，在读取项目之前返回非 0`, () => {
    const result = runCli(["--from-snapshot", ...args]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--from-snapshot 只提供构建期文本汇总，不能与/);
    assert.ok(result.stderr.includes(args[0]));
    assert.doesNotMatch(result.stderr, /没有活动项目/);
  });
}

test("帮助命令无需加载活动项目，并明确构建期汇总的组合限制", () => {
  const result = runCli(["--help"]);
  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /只输出构建期落盘的文本汇总/);
  assert.match(result.stdout, /不能与 --json、--out、--limit、--all 组合/);
  assert.match(result.stdout, /-o、-n 同样不支持/);
});

test("非快照模式继续解析 JSON、报告、明细范围及目标列选项", () => {
  const options = parseArgs(["--table", "terms.csv", "--profile", "demo", "--target", "tw", "--json", "--out", "report.json", "--limit", "3", "--all"]);
  assert.equal(options.fromSnapshot, false);
  assert.deepEqual(options.tables, ["terms.csv"]);
  assert.equal(options.profileId, "demo");
  assert.equal(options.target, "tw");
  assert.equal(options.json, true);
  assert.equal(options.out, "report.json");
  assert.equal(options.limit, 3);
  assert.equal(options.showAll, true);
  const aliases = parseArgs(["-t", "terms.csv", "-p", "demo", "-o", "report.json", "-n", "3"]);
  assert.deepEqual(aliases.tables, options.tables);
  assert.equal(aliases.profileId, options.profileId);
  assert.equal(aliases.out, options.out);
  assert.equal(aliases.limit, options.limit);
});
