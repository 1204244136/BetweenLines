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

function writeTermTable(label, extraRows = []) {
  const file = path.join(dataDir, `${label}-terms.csv`);
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Ruby_Trans,Other_Fandom,Type",
    "【発信機】,はっしんき,【发信器】,,发射机,科技/装备",
    "【東雲】【太郎】,\"しののめ,たろう\",東雲太郎,Shinonome Taro,,人名/日式全名",
    // 注音条目只能确认一致、不能指控译名差异（见 term-table.js 文件头），
    // 所以“术语冲突”这条路要用无注音条目来测。
    "【召喚陣】,,【召唤阵】,,魔法阵,术式",
    ...extraRows,
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
    // 无注音条目命中强证据差异（译文用的是“其他译法”）——术语冲突行不吃预筛，
    // 必须照样调用模型（术语判断是模型分析的一环），所以这里刻意给了很高的相似度分。
    { index: 1, jp: "召喚陣を取り外す。", cn: "取下魔法阵。", tw: "", twCn: "", score: 0.99 },
    { index: 2, jp: "東雲太郎は言った。", cn: "東雲太郎说道。", tw: "", twCn: "", score: 0 },
    // 注音条目：原文侧注音对上（`<ruby>発信機<rt>はっしんき</rt></ruby>`），译文也确实用了该项目译名，
    // 但译文侧没有注音 → 降级为只作一致性证据，仍然可以判「整行只有术语」并跳过模型。
    { index: 3, jp: "<ruby>発信機<rt>はっしんき</rt></ruby>", cn: "【发信器】", tw: "", twCn: "", score: 0 },
    { index: 4, jp: "今日はいい天気だ。", cn: "今天天气不错。", tw: "", twCn: "", score: 0 },
    // 命中的是假名写法（グループ）：可能只是普通词，对照表不得定论，必须交给模型判断。
    { index: 5, jp: "街の八割を分類する六段階評価の、まさに頂点グループ。", cn: "在把都市居民分成六级的评价系统中，处于顶级位置的一类人。", tw: "", twCn: "", score: 0 },
    // 注音条目降级、且译文没用该项目译名（正文里的「ＧＰＳ発信機」是普通词义的发射机）：
    // 不算命中、不注入、不指控——这是这条口径刻意选的保守方向。
    { index: 6, jp: "ＧＰＳ<ruby>発信機<rt>はっしんき</rt></ruby>を取り外す。", cn: "取下GPS信号发射机。", tw: "", twCn: "", score: 0 },
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
      termTables: [writeTermTable("resolved", ["グループ,,GROUP,,,组织/暗部"])],
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });

    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const finished = clientStatus();
    const byIndex = new Map(finished.results.map((result) => [result.index, result]));

    // 第 1 行：术语冲突 → 不由对照表出结论，注入冲突线索后交给模型（相似度分再高也不吃预筛）。
    assert.match(byIndex.get(1).note, /^\[AI校对\]/, "术语冲突行必须经过模型，不写面向人工的对照表结论");
    // 第 2 行：术语一致，但句中还有别的内容 → 不写对照表备注，注入术语后由模型给结论。
    assert.match(byIndex.get(2).note, /^\[AI校对\]/);
    // 第 3 行：整行有效内容就是术语，直接标记完成（唯一跳过模型的情形）。
    assert.match(byIndex.get(3).note, /^\[对照表\]/);
    assert.match(byIndex.get(3).note, /该行有效内容全部是本项目术语/);
    assert.match(byIndex.get(3).note, /是否需要修改：否/);
    assert.match(byIndex.get(3).note, /未双侧注音，只作一致性证据/, "降级命中不写指控口吻");
    assert.equal(byIndex.get(3).done, true);
    // 第 4 行：没命中对照表，仍然交给模型。
    assert.match(byIndex.get(4).note, /^\[AI校对\]/);
    // 第 5 行：命中的是假名写法（可能只是普通词）→ 对照表不得出结论，照常交给模型判断。
    assert.match(byIndex.get(5).note, /^\[AI校对\]/, "存疑行不该写对照表结论");
    assert.equal(byIndex.get(5).done, true);
    // 第 6 行：降级且译文没用该项目译名 → 不算命中，普通 AI 行（不注入、不指控）。
    assert.match(byIndex.get(6).note, /^\[AI校对\]/);

    assert.equal(requestCount, 5, "第 1 行（术语冲突）、第 2 行（术语+别的词）、第 4 行（未命中）、第 5 行（存疑）、第 6 行（注音不足不算命中）都要调用模型");
    const injectedSystem = sentSystems.find((system) => system.includes("東雲太郎 → 東雲太郎"));
    assert.ok(injectedSystem, "命中术语但整行不止术语时，标签与术语要作为提示词注入");
    assert.match(injectedSystem, /【术语（对照表命中）】/);
    assert.match(injectedSystem, /- 東雲太郎 → 東雲太郎（人名\/日式全名）/);
    assert.match(injectedSystem, /对照表只能证明术语译名对不对，不能证明整句翻译没有问题/);
    assert.match(injectedSystem, /术语判断是本次分析里的一个环节/, "提示词要说明术语判断是模型分析的一环");
    // 术语冲突同样注入，但措辞面向模型：给的是证据与线索，要不要改由模型结合整句判断。
    const conflictSystem = sentSystems.find((system) => system.includes("召喚陣 → 召唤阵"));
    assert.ok(conflictSystem, "术语冲突必须注入提示词，由模型给出术语判断");
    assert.match(conflictSystem, /召喚陣 → 召唤阵（术式）（译文现用「魔法阵」，属其他译法，请判断是否需要改用本项目译名）/, "冲突线索要写明译文现用的是哪种写法");
    assert.equal(/请人工确认是否需要替换/.test(conflictSystem), false, "提示词不写面向人工的结论口吻");
    // 注音条目没有双侧注音时只能确认一致：不写冲突线索，也不注入“译文现用××”的指控。
    assert.equal(/発信機 → 发信器（科技\/装备）（译文现用/.test(sentSystems.join("\n")), false, "只有原文侧注音的候选不得指控译名差异");
    // 存疑项同样注入，但标签上写明需要结合上下文判断，避免模型机械替换普通词。
    const advisorySystem = sentSystems.find((system) => system.includes("グループ → GROUP"));
    assert.ok(advisorySystem, "存疑术语必须注入提示词，由模型判断此处是否确指该术语");
    assert.match(advisorySystem, /グループ → GROUP（组织\/暗部）（可能为普通词，需结合上下文判断）/);
    assert.equal(finished.termPrefiltered, 1, "跳过模型的只剩纯术语行");
    assert.equal(finished.termInjected, 3, "注入提示词的行要单独计数（含术语冲突行与存疑行）");
    assert.equal(finished.termConflicts, 1);
    assert.equal(finished.termRubyDemoted, 1, "降级为只作一致性证据的候选要如实报数");
    assert.deepEqual(finished.termTables.entries, 4);
    assert.match(finished.logs.join("\n"), /对照表：1 张表 \/ 4 条术语：命中 4 行（整行只有术语、跳过模型 1，术语冲突 1，存疑交模型判断 1），另有 3 行的术语作为提示词注入后照常交给模型/);
    assert.match(finished.logs.join("\n"), /1 条候选因中日两侧没有同时注音，降级为只作一致性证据/);
    assert.match(finished.logs.join("\n"), /1 条候选因没有同时注音、且译文未出现该译名而未参与判定/, "第 6 行的候选要如实报数");
    assert.match(finished.logs.join("\n"), /术语冲突 1 行不吃预筛、留给 AI 判断/);
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
    assert.equal(status.entries, 3);
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
    { index: 1, jp: "召喚陣を取り外す。", cn: "取下魔法阵。", tw: "", twCn: "", score: 0 },
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
