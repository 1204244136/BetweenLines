const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-term-e2e-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, startProofread } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");
const { buildTermLayer } = require("../src/workbenches/translation-compare/term-layer");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeTermTable(label) {
  const file = path.join(dataDir, `${label}-terms.csv`);
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Ruby_Trans,Other_Fandom,Type",
    "【発信機】,はっしんき,【发信器】,,发射机,科技/装备",
    "【東雲】【太郎】,\"しののめ,たろう\",東雲太郎,Shinonome Taro,,人名/日式全名",
  ].join("\n"), "utf8");
  return file;
}

function publishRows(label, rows, extra = {}) {
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, `${label}-source.txt`),
      cn: path.join(dataDir, `${label}-translation.txt`),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    ...extra,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });
  return project;
}

test("对照表只跳过整行都是术语的行，其余命中行注入术语后照常调用模型", async () => {
  clearProofreadCache();
  const rows = [
    { index: 1, jp: "ＧＰＳ発信機を取り外す。", cn: "取下GPS信号发射机。", tw: "", twCn: "", score: 0 },
    { index: 2, jp: "東雲太郎は言った。", cn: "東雲太郎说道。", tw: "", twCn: "", score: 0 },
    { index: 3, jp: "【発信機】", cn: "【发信器】", tw: "", twCn: "", score: 0 },
    { index: 4, jp: "今日はいい天気だ。", cn: "今天天气不错。", tw: "", twCn: "", score: 0 },
  ];
  const project = publishRows("term-resolved", rows);

  let requestCount = 0;
  const sentSystems = [];
  const server = http.createServer((request, response) => {
    requestCount += 1;
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        sentSystems.push(parsed.messages[0].content);
      } catch {
        sentSystems.push("");
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        semanticSame: true,
        needsEdit: false,
        needsContext: false,
        decision: "keep",
        summary: "无需修改。",
      }) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 1,
      termTables: [writeTermTable("resolved")],
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    const byIndex = new Map(finished.results.map((result) => [result.index, result]));

    // 第 1 行：译文用了对照表里的“其他译法”，给出只替换术语的最小修改。
    assert.match(byIndex.get(1).note, /^\[对照表\]/);
    assert.match(byIndex.get(1).note, /修改结果：取下GPS信号【发信器】。/);
    assert.equal(byIndex.get(1).done, false);
    // 第 2 行：术语一致，但句中还有别的内容 → 不写对照表备注，注入术语后由模型给结论。
    assert.match(byIndex.get(2).note, /^\[AI校对\]/);
    // 第 3 行：整行有效内容就是术语，直接标记完成。
    assert.match(byIndex.get(3).note, /^\[对照表\]/);
    assert.match(byIndex.get(3).note, /该行有效内容全部是本项目术语/);
    assert.match(byIndex.get(3).note, /是否需要修改：否/);
    assert.equal(byIndex.get(3).done, true);
    // 第 4 行：没命中对照表，仍然交给模型。
    assert.match(byIndex.get(4).note, /^\[AI校对\]/);

    assert.equal(requestCount, 2, "第 2 行（术语+别的词）和第 4 行（未命中）都要调用模型");
    const injectedSystem = sentSystems.find((system) => system.includes("【术语（对照表命中）】"));
    assert.ok(injectedSystem, "命中术语但整行不止术语时，标签与术语要作为提示词注入");
    assert.match(injectedSystem, /- 東雲太郎 → 東雲太郎（人名\/日式全名）/);
    assert.match(injectedSystem, /对照表只能证明术语译名对不对，不能证明整句翻译没有问题/);
    assert.equal(finished.termPrefiltered, 2, "跳过模型的只有冲突行与纯术语行");
    assert.equal(finished.termInjected, 1, "注入提示词的行要单独计数");
    assert.equal(finished.termConflicts, 1);
    assert.deepEqual(finished.termTables.entries, 2);
    assert.match(finished.logs.join("\n"), /对照表：1 张表 \/ 2 条术语：命中 3 行（整行只有术语、跳过模型 1，需人工确认 1）/);
    assert.match(finished.logs.join("\n"), /另有 1 行的术语一致但句中还有别的词，按提示词注入后照常交给模型/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});

test("状态接口给出对照表状态：条数、路径去重、失败告警", () => {
  const table = writeTermTable("status");
  try {
    // 同一张表的三种写法（原样、绝对路径、带 ./ 的相对写法）必须只算一张表。
    process.env.TRANSCOMPARATOR_TERM_TABLES = [table, path.resolve(table), path.join(path.dirname(table), ".", path.basename(table))].join(";");
    const status = clientStatus({ includeResults: false, profileId: "novel" }).termTableStatus;
    assert.equal(status.files.length, 1);
    assert.equal(status.entries, 2);
    assert.deepEqual(status.errors, []);
    assert.deepEqual(status.sheets, ["status-terms.csv"], "csv 没有工作表名时回落到文件名");

    process.env.TRANSCOMPARATOR_TERM_TABLES = path.join(dataDir, "missing-table.xlsx");
    const failed = clientStatus({ includeResults: false, profileId: "novel" }).termTableStatus;
    assert.equal(failed.entries, 0);
    assert.equal(failed.errors.length, 1);
    assert.match(failed.errors[0], /表格文件不存在/);
  } finally {
    delete process.env.TRANSCOMPARATOR_TERM_TABLES;
  }

  const none = clientStatus({ includeResults: false, profileId: "novel" }).termTableStatus;
  assert.deepEqual(none.files, [], "没有声明对照表时要如实报告未声明");
  assert.equal(none.entries, 0);
});

test("运行期把本次判定与构建期落盘结论对照：一致时明说、不一致时告警", async () => {
  clearProofreadCache();
  const table = writeTermTable("layer-match");
  const rows = [
    { index: 1, jp: "ＧＰＳ発信機を取り外す。", cn: "取下GPS信号发射机。", tw: "", twCn: "", score: 0 },
    { index: 2, jp: "東雲太郎は言った。", cn: "東雲太郎说道。", tw: "", twCn: "", score: 0 },
  ];
  const layer = buildTermLayer({
    rows,
    profiles: [{ id: "novel", name: "对照表层测试档案", termTables: [table] }],
    comparisonMode: "bilingual",
  });
  const project = publishRows("term-layer-match", rows, { termPrefilter: layer });

  const run = async (label) => {
    await startProofread({
      provider: "compatible",
      baseUrl: "http://127.0.0.1:1/v1",
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 1,
      profileId: "novel",
      termTables: [table],
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });
    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return clientStatus().logs.join("\n");
  };

  // 表没变：两次判定一致，日志要明确说出「与构建期预筛一致」。
  const matched = await run("match");
  assert.match(matched, /对照表：与构建期预筛一致（构建期判定 2 行，本次参与 2 行）/);

  // 表被改过：指纹过期，运行期按最新表判定并提示重新构建工作台。
  fs.appendFileSync(table, "\n【天気】,てんき,【天气】,,,常用词\n", "utf8");
  const stale = await run("stale");
  assert.match(stale, /对照表文件在构建工作台之后被修改过/);
  assert.equal(/与构建期预筛一致/.test(stale), false);
});

test("没有对照表时行为与之前一致，全部交给模型", async () => {
  clearProofreadCache();
  const rows = [
    { index: 1, jp: "ＧＰＳ発信機を取り外す。", cn: "取下GPS信号发射机。", tw: "", twCn: "", score: 0 },
  ];
  const project = publishRows("term-disabled", rows);

  let requestCount = 0;
  const server = http.createServer((request, response) => {
    requestCount += 1;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      semanticSame: false,
      needsEdit: true,
      needsContext: false,
      decision: "replace",
      grade: "fair",
      summary: "术语译名需要修改。",
      revisedText: "取下GPS信号【发信器】。",
    }) } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 1,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    assert.equal(requestCount, 1);
    assert.equal(finished.termPrefiltered, 0);
    assert.match(finished.results[0].note, /^\[AI校对\]/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }
});
