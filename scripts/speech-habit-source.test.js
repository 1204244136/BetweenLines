const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  chapterHabitBlock,
  detectCharacters,
  findHabitMisses,
  habitCandidatesForRow,
  loadSpeechTables,
  speakerCheckBlock,
} = require("../src/workbenches/translation-compare/ai/speech-habit");
const {
  chapterMarkerKey,
  countInSource,
  defaultIndexXDir,
  findBodyRoot,
  readJapaneseVolume,
  resolveJapaneseSourceDir,
  verifyAgainstSource,
} = require("../src/workbenches/translation-compare/verify-source");
const { buildMessages, parseDecision, decisionToResult } = require("./ai-proofread");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-verify-"));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const HABIT_CSV = [
  "小说首次出现,角色,口癖,类型,x版,网翻,台版（转简中）,备注",
  "S1_04,甲野一郎,オレ,第一人称,本大爷,,俺,男性化自称",
  "S1_04,乙川次郎,じゃん,谓语形式,-,吧,,通常放在句尾",
].join("\n");

function loadFixture() {
  const file = path.join(tempDir, "habits.csv");
  fs.writeFileSync(file, HABIT_CSV, "utf8");
  return loadSpeechTables([file]);
}

// 单个用例专用的独立表（不干扰 loadFixture 的固定夹具）。
function loadHabitCsv(lines, name) {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, lines.join("\n"), "utf8");
  const tables = loadSpeechTables([file]);
  assert.deepEqual(tables.errors, []);
  return tables;
}

// 造一棵最小 index-X 日文原文树：<root>/.cache/epub-work/japanese-text/[S3_01]…/item/xhtml/*.xhtml
function writeFakeJapaneseSource(root, { volumeCode = "S3_01", files }) {
  const dir = path.join(root, ".cache", "epub-work", "japanese-text", `[${volumeCode}]某作品(01)`);
  const body = path.join(dir, "item", "xhtml");
  fs.mkdirSync(body, { recursive: true });
  fs.mkdirSync(path.join(dir, "META-INF"), { recursive: true });
  fs.writeFileSync(path.join(dir, "mimetype"), "application/epub+zip", "utf8");
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(body, name), content, "utf8");
  }
  return dir;
}

test("说话人候选来自本行命中的口癖，且只在有特征时出现", () => {
  const tables = loadFixture();
  const rows = [
    { index: 1, chapter: "第一章", jp: "「オレは行く」と甲野一郎。", cn: "「本大爷要去」甲野一郎。" },
    { index: 2, chapter: "第一章", jp: "甲野は黙っていた。", cn: "甲野沉默着。" },
  ];
  const characters = detectCharacters({ rows, tables });
  const candidates = habitCandidatesForRow({ row: rows[0], characters });
  assert.deepEqual(candidates.map((item) => item.character), ["甲野一郎"]);
  assert.equal(candidates[0].habit, "オレ");
  assert.equal(candidates[0].expected, "本大爷");
  assert.equal(candidates[0].confidence, "high");
  assert.equal(candidates[0].detectable, true, "登记了写法才可用于判断译文是否流失");

  // 本行没有口癖特征 → 不需要判断说话人
  assert.deepEqual(habitCandidatesForRow({ row: rows[1], characters }), []);
  // 只命中名字片段（未启用）的角色仍是候选，但标为低置信
  const fragmentOnly = detectCharacters({
    rows: [{ index: 3, chapter: "第二章", jp: "オレの話。", cn: "本大爷的事。" }],
    tables,
  });
  const low = habitCandidatesForRow({ row: { index: 3, jp: "オレの話。" }, characters: fragmentOnly });
  assert.deepEqual(low, []);
});

test("X版为 `-` 的口癖注入不特殊处理硬约束，网翻写法不得当作补回基准", () => {
  const tables = loadFixture();
  const jp = "「じゃん」と乙川次郎。";
  const cn = "「吧」乙川次郎说。";
  const rows = [{ index: 1, chapter: "第一章", jp, cn }];
  const characters = detectCharacters({ rows, tables });
  const candidates = habitCandidatesForRow({ row: rows[0], characters });

  // 候选仍然给出（名字命中），但 X版 为 `-`（网翻虽有写法也不作数）→ 明确不特殊处理。
  assert.deepEqual(candidates.map((item) => item.character), ["乙川次郎"]);
  assert.equal(candidates[0].expected, "");
  assert.equal(candidates[0].detectable, false);
  assert.equal(candidates[0].noSpecialHandling, true);
  assert.deepEqual(candidates[0].forbiddenWritings, [{ version: "网翻", value: "吧" }]);

  const block = speakerCheckBlock({ chapter: "第一章", candidates });
  assert.match(block, /本项目明确不作特殊翻译处理的口癖/);
  assert.match(block, /不得采用网翻版或台版写法：网翻「吧」/);
  assert.match(block, /不得据此判译文缺漏、扣分或要求补写/);
  assert.doesNotMatch(block, /可按本项目写法判断的口癖/);

  // 不得算遗漏；章级块仍要注入“明确不特殊处理”的规则。
  assert.deepEqual(findHabitMisses({ source: jp, target: cn, characters }), []);
  const chapterBlock = chapterHabitBlock({ chapter: "第一章", characters });
  assert.match(chapterBlock, /乙川次郎：谓语形式 「じゃん」 → 不作特殊翻译处理，不得采用网翻版或台版写法（网翻「吧」）/);
});

test("说话人判断段落要求先定人、再处理习惯", () => {
  const tables = loadFixture();
  const rows = [{ index: 1, chapter: "第一章", jp: "「オレは行く」と甲野一郎。", cn: "「本大爷要去」甲野一郎。" }];
  const characters = detectCharacters({ rows, tables });
  const candidates = habitCandidatesForRow({ row: rows[0], characters });
  const block = speakerCheckBlock({ chapter: "第一章", candidates });
  assert.match(block, /^【说话人判断（本章）】/);
  assert.match(block, /先判断这一行到底是谁在说话，再据此处理/);
  assert.match(block, /speaker 字段/);
  assert.match(block, /甲野一郎「オレ」/);
  assert.equal(speakerCheckBlock({ chapter: "第一章", candidates: [] }), "");
});

test("只作线索的候选按真实原因分组：登记了写法的条目不会被说成“尚未登记译法”", () => {
  const tables = loadHabitCsv([
    "小说首次出现,角色,口癖,类型,x版,网翻,台版（转简中）,备注",
    // 类型留空：登记了写法，但这类用法不以字面出现为准
    "S1_01,己川六郎,やめてよね,,可别啦,,,有变体：やめてよ",
    // 真正没有登记写法
    "S1_01,庚川七郎,あたし,第一人称,,,,",
    // 写法与日文同形的锁定写法
    "S1_01,辛川八郎,力,名词后缀,力,,,XX力",
  ], "habits-clue-reasons.csv");
  const row = {
    index: 1,
    chapter: "第一章",
    jp: "「やめてよね」と己川六郎。「あたし」と庚川七郎。「力」と辛川八郎。",
    cn: "「住手啦」己川六郎说。「我」庚川七郎说。「力」辛川八郎说。",
  };
  const candidates = habitCandidatesForRow({ row, characters: detectCharacters({ rows: [row], tables }) });
  const modeOf = (name) => candidates.find((candidate) => candidate.character === name).mode;
  assert.equal(modeOf("己川六郎"), "none", "类型留空 → 不以字面出现为准");
  assert.equal(modeOf("庚川七郎"), "clue-only", "没有 X版 写法 → 未登记");
  assert.equal(modeOf("辛川八郎"), "locked", "写法与日文同形 → 锁定写法");
  assert.equal(candidates.every((candidate) => candidate.detectable === false), true, "三者都不能用来判特色流失");

  const block = speakerCheckBlock({ chapter: row.chapter, candidates });
  // 取「角色「口癖」」那一行（首行的候选名单里也有名字，不能用它来断言）
  const lineOf = (name) => block.split("\n").find((line) => line.includes(`${name}「`));
  // 一条都不许被静默丢掉
  for (const candidate of candidates) {
    assert.ok(lineOf(candidate.character), `${candidate.character} 必须出现在说话人判断段里`);
  }
  // 三类原因各说各的：只有真正未登记写法的条目才能被说成“尚未登记译法”
  assert.match(lineOf("庚川七郎"), /尚未登记这些口癖的译法/);
  assert.doesNotMatch(lineOf("己川六郎"), /尚未登记/);
  assert.match(lineOf("己川六郎"), /己川六郎「やめてよね」/);
  assert.doesNotMatch(lineOf("辛川八郎"), /尚未登记/);
  assert.match(lineOf("辛川八郎"), /写法和日文一致/);
  // 三行是互不相同的分组，且都保留“不得据此判缺漏”
  assert.notEqual(lineOf("己川六郎"), lineOf("庚川七郎"));
  assert.notEqual(lineOf("己川六郎"), lineOf("辛川八郎"));
  assert.notEqual(lineOf("庚川七郎"), lineOf("辛川八郎"));
  for (const name of ["己川六郎", "庚川七郎", "辛川八郎"]) {
    assert.match(lineOf(name), /判缺漏|判译文缺漏/);
  }
});

test("说话人判断随请求注入，并写入结果备注", () => {
  const tables = loadFixture();
  const row = { index: 1, chapter: "第一章", jp: "「オレは行く」と甲野一郎。", cn: "「本大爷要去」甲野一郎。" };
  const characters = detectCharacters({ rows: [row], tables });
  const candidates = habitCandidatesForRow({ row, characters });
  const messages = buildMessages({
    row,
    targetLabel: "主文本（待修改文本）",
    targetText: row.cn,
    counterpartLabel: "原文 A",
    counterpartText: row.jp,
    diffHelper: "x",
    context: [],
    contextMode: "none",
    speechHabit: {
      chapter: row.chapter,
      block: chapterHabitBlock({ chapter: row.chapter, characters }),
      characters: ["甲野一郎"],
      speakerCheck: { chapter: row.chapter, candidates, block: speakerCheckBlock({ chapter: row.chapter, candidates }) },
    },
  }, { proofreadMode: "bilingual" });

  const system = messages[0].content;
  assert.equal(system.split("【说话人判断（").length - 1, 1);
  assert.equal(system.split("【说话习惯（").length - 1, 1);
  assert.equal(system.split("只返回一个 JSON 对象").length - 1, 1);
  assert.match(system, /先判断这一行到底是谁在说话/);
  assert.match(system, /speaker 字段/);

  const user = JSON.parse(messages[1].content);
  assert.equal(user.speakerCheck.chapter, "第一章");
  assert.deepEqual(user.speakerCheck.candidates.map((item) => item.character), ["甲野一郎"]);
  // 规则句子只在系统提示词的【说话人判断】段落里发一次，载荷只给候选事实。
  assert.equal(user.speakerCheck.note, undefined, "说话人判断口径只在系统提示词里发一次");

  // 模型返回的说话人进入备注，便于人工核对。
  const decision = parseDecision(JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    decision: "keep",
    speaker: "甲野一郎",
    grade: "excellent",
    summary: "无需修改。",
    revisedText: "",
  }), { proofreadMode: "bilingual" });
  assert.equal(decision.speaker, "甲野一郎");
  const result = decisionToResult({ index: 1 }, decision, "主文本", "原文 A", "cn", "bilingual");
  assert.match(result.note, /说话人：甲野一郎/);

  // 没有说话人判断时字段为空，备注里也不出现该行。
  const noSpeaker = parseDecision(JSON.stringify({ semanticSame: true, needsEdit: false, needsContext: false, decision: "keep", summary: "无需修改。" }), { proofreadMode: "bilingual" });
  assert.equal(noSpeaker.speaker, "");
  assert.doesNotMatch(decisionToResult({ index: 2 }, noSpeaker, "主文本", "原文 A", "cn", "bilingual").note, /说话人：/);
});

test("章节结构标记把中日标题对齐到同一把钥匙", () => {
  assert.equal(chapterMarkerKey("行間 一"), "行间1");
  assert.equal(chapterMarkerKey("行间 一"), "行间1");
  assert.equal(chapterMarkerKey("第一章 まるで遊園地のような Red_Wear"), "第1章");
  assert.equal(chapterMarkerKey("第一章 简直就像是游乐园一般"), "第1章");
  assert.equal(chapterMarkerKey("終 章 白雪と鮮紅"), "终章");
  assert.equal(chapterMarkerKey("终 章 白雪与鲜红"), "终章");
  assert.equal(chapterMarkerKey("序章 イヴの最初に"), "序章");
  assert.equal(chapterMarkerKey("あとがき"), "后记");
  assert.equal(chapterMarkerKey("正文"), "");
});

test("原文与快照的计数不重复统计同一写法", () => {
  const source = "オレとオレ。译本作 訳。";
  const simplified = "オレとオレ。译本作 译。";
  // 假名写法简繁同形：只数一次，不能因为同时数了简体版而翻倍。
  assert.equal(countInSource(source, simplified, "オレ"), 2);
  // 汉字写法简繁不同：两种写法各数一次。
  assert.equal(countInSource(source, simplified, "訳"), 1);
  assert.equal(countInSource(source, simplified, "訳"), countInSource("訳", "译", "訳"));
});

test("用日文原文校验：目录解析、章节标记与口癖计数", () => {
  const root = path.join(tempDir, "index-X");
  writeFakeJapaneseSource(root, {
    files: {
      "S3_01-01.xhtml": '<html><body><h1>序章 イヴの最初に</h1><p>オレは行く。</p></body></html>',
      "S3_01-02.xhtml": '<html><body><h1>行間 一</h1><p>関係ないじゃん。オレの話だ。</p></body></html>',
      "S3_01-03.xhtml": '<html><body><h1>第一章 まるで遊園地のような</h1><p>甲野一郎と、じゃん。</p></body></html>',
    },
  });

  const resolved = resolveJapaneseSourceDir({ indexXDir: root, volumeCode: "S3_01" });
  assert.equal(Boolean(resolved.dir), true);
  assert.match(resolved.name, /^\[S3_01\]/);
  assert.match(findBodyRoot(resolved.dir), /item[\\/]xhtml$/);

  const volume = readJapaneseVolume(resolved.dir);
  assert.equal(volume.files.length, 3);
  assert.equal(volume.headings.length, 3);

  const tables = loadFixture();
  const rows = [
    { index: 1, chapter: "正文", jp: "オレは行く。", cn: "我要去。" },
    { index: 2, chapter: "行间 一", jp: "関係ないじゃん。オレの話だ。", cn: "没关系吧。我的事。" },
    { index: 3, chapter: "第一章 简直就像是游乐园一般", jp: "甲野一郎と、じゃん。", cn: "甲野一郎，还有吧。" },
  ];
  const report = verifyAgainstSource({ indexXDir: root, volume: { code: "S3_01" }, rows, tables });
  assert.equal(report.ok, true);
  assert.deepEqual(report.sourceMarkers.map((item) => item.key), ["序章", "行间1", "第1章"]);
  assert.deepEqual(report.chaptersMissing, []);

  const ichiro = report.characters.find((item) => item.character === "甲野一郎");
  assert.equal(ichiro.nameCountSource, 1);
  assert.equal(ichiro.nameCountRows, 1);
  assert.equal(ichiro.habitCountSource, 2);
  assert.equal(ichiro.habitCountRows, 2);
  assert.equal(ichiro.missingHabitOccurrences, 0);

  // 快照漏掉一次口癖时，校验能报出来（原文 2 次、快照 1 次）。
  const lossy = verifyAgainstSource({
    indexXDir: root,
    volume: { code: "S3_01" },
    rows: [{ index: 1, chapter: "正文", jp: "オレは行く。", cn: "我要去。" }],
    tables,
  });
  const lost = lossy.habitsLostInSnapshot.find((item) => item.character === "甲野一郎");
  assert.equal(lost.habitCountSource, 2);
  assert.equal(lost.habitCountRows, 1);
  assert.equal(lost.missingHabitOccurrences, 1);

  // 找不到卷目录时给出明确错误，而不是抛异常。
  const missing = verifyAgainstSource({ indexXDir: root, volume: { code: "S9_99" }, rows: [], tables });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /找不到 【S9_99】/);
});

test("默认 index-X 目录按同级仓库约定探测", () => {
  const dir = defaultIndexXDir();
  assert.equal(typeof dir, "string");
  if (dir) assert.match(dir, /index-X$/);
});

test("校对流水线优先复用构建期结果，表改动后回退重算", async () => {
  const fsSync = require("node:fs");
  const http = require("node:http");
  const { buildSpeechHabitLayer } = require("../src/workbenches/translation-compare/speech-habit-layer");
  const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "betweenlines-habit-layer-e2e-"));
  const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
  process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
  delete require.cache[require.resolve("./ai-proofread")];
  const { clearProofreadCache, clientStatus, startProofread } = require("./ai-proofread");
  const { createProjectContext } = require("./project-context");
  const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");

  const tableFile = path.join(dataDir, "habits.csv");
  fsSync.writeFileSync(tableFile, HABIT_CSV, "utf8");
  const rows = [
    { index: 1, chapter: "行间 一", jp: "「オレは行く」と甲野一郎。", cn: "甲野一郎说要去。", tw: "", twCn: "", score: 0 },
  ];
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: { jp: path.join(dataDir, "a.txt"), cn: path.join(dataDir, "b.txt"), tw: "" },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  const layer = buildSpeechHabitLayer({
    rows,
    projectFiles: selection.files,
    profiles: [{ id: "novel", name: "小说成品（简中 EPUB）", speechTables: [tableFile], speechHabitScope: "chapter" }],
  });
  fsSync.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    speechHabits: layer,
    rows,
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fsSync.existsSync(file)) continue;
    fsSync.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });

  const captured = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      captured.push(JSON.parse(body));
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        semanticSame: true, needsEdit: false, needsContext: false, decision: "keep", summary: "无需修改。",
      }) } }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const run = async () => {
    clearProofreadCache();
    const address = server.address();
    await startProofread({
      protocol: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 1,
      speechTables: [tableFile],
      profileId: "novel",
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });
    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return clientStatus();
  };

  try {
    const first = await run();
    assert.match(first.logs.join("\n"), /说话习惯：复用构建期结果/);
    assert.equal(captured.length, 1);
    assert.match(captured[0].messages[0].content, /【说话习惯（本章）】/);
    assert.deepEqual(
      JSON.parse(captured[0].messages[1].content).chapterSpeechHabits.characters,
      ["甲野一郎"],
    );

    // 表被改过：指纹过期 → 本次按最新表重算，并在日志里提示重建工作台。
    fsSync.appendFileSync(tableFile, "\nS1_04,乙川次郎,じゃん,谓语形式,,,,\n", "utf8");
    const second = await run();
    assert.match(second.logs.join("\n"), /说话习惯表在构建之后被修改过，本次按最新表重算/);
    assert.equal(captured.length, 2);
    assert.match(captured[1].messages[0].content, /【说话习惯（本章）】/);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
    if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
    else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
    fsSync.rmSync(dataDir, { recursive: true, force: true });
    delete require.cache[require.resolve("./ai-proofread")];
  }
});

test("校对流水线把说话人判断发给模型", async () => {
  const fsSync = require("node:fs");
  const http = require("node:http");
  const dataDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "betweenlines-habit-e2e-"));
  const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
  process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
  delete require.cache[require.resolve("./ai-proofread")];
  const { clearProofreadCache, clientStatus, startProofread } = require("./ai-proofread");
  const { createProjectContext } = require("./project-context");
  const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");

  const tableFile = path.join(dataDir, "habits.csv");
  fsSync.writeFileSync(tableFile, HABIT_CSV, "utf8");

  try {
    const rows = [
      { index: 1, chapter: "行间 一", jp: "「オレは関係ない」と甲野一郎は笑った。", cn: "甲野一郎笑了笑。", tw: "", twCn: "", score: 0 },
    ];
    const selection = {
      comparisonMode: "bilingual",
      inputMode: "txt",
      files: { jp: path.join(dataDir, "a.txt"), cn: path.join(dataDir, "b.txt"), tw: "" },
      labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
    };
    const project = createProjectContext(selection, rows);
    const staging = createProjectStaging(selection, { dataDir });
    fsSync.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
      project,
      rowsSignature: project.rowsSignature,
      rows,
    }), "utf8");
    for (const name of projectArtifacts) {
      const file = path.join(staging.dir, name);
      if (fsSync.existsSync(file)) continue;
      fsSync.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
    }
    publishProject(staging.dir, { dataDir });

    const captured = [];
    const server = http.createServer((request, response) => {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        captured.push(JSON.parse(body));
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
          semanticSame: false,
          needsEdit: true,
          needsContext: false,
          decision: "replace",
          speaker: "甲野一郎",
          grade: "good",
          summary: "说话特色流失，需要修改。",
          revisedText: "「跟本大爷没关系」，甲野一郎笑了笑。",
        }) } }] }));
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      await startProofread({
        protocol: "compatible",
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        model: "test-model",
        proofreadMode: "bilingual",
        concurrency: 1,
        speechTables: [tableFile],
        projectKey: project.projectKey,
        rowsSignature: project.rowsSignature,
      });
      const deadline = Date.now() + 10000;
      while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.equal(captured.length, 1);
      const system = captured[0].messages[0].content;
      const user = JSON.parse(captured[0].messages[1].content);
      assert.match(system, /【说话习惯（本章）】/);
      assert.match(system, /【说话人判断（本章）】/);
      assert.match(system, /先判断这一行到底是谁在说话/);
      assert.deepEqual(user.speakerCheck.candidates.map((item) => item.character), ["甲野一郎"]);
      assert.deepEqual(user.chapterSpeechHabits.characters, ["甲野一郎"]);

      const finished = clientStatus();
      assert.match(finished.results[0].note, /说话人：甲野一郎（据说话习惯特征判断）/);
      assert.equal(finished.speechHabitChapters, 1);
      assert.deepEqual(finished.speechHabitCharacters, ["甲野一郎"]);
    } finally {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    }
  } finally {
    if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
    else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
    fsSync.rmSync(dataDir, { recursive: true, force: true });
    delete require.cache[require.resolve("./ai-proofread")];
  }
});

test("说话习惯随请求注入：系统提示词一段、用户载荷只给范围", () => {
  const tables = loadFixture();
  const row = { index: 1, chapter: "第一章", jp: "「オレは行く」と甲野一郎。", cn: "「我要去」甲野一郎说。" };
  const characters = detectCharacters({ rows: [row], tables });
  const block = chapterHabitBlock({ chapter: row.chapter, characters });
  const names = characters.filter((item) => item.activated).map((item) => item.entry.character);

  const messages = buildMessages({
    row,
    targetLabel: "主文本（待修改文本）",
    targetText: row.cn,
    counterpartLabel: "原文 A",
    counterpartText: row.jp,
    diffHelper: "x",
    context: [],
    contextMode: "none",
    speechHabit: { chapter: row.chapter, block, characters: names },
  }, { proofreadMode: "bilingual" });

  const system = messages[0].content;
  assert.equal(system.split("【说话习惯（").length - 1, 1, "说话习惯段只能出现一次");
  assert.equal(system.split("只返回一个 JSON 对象").length - 1, 1);
  assert.equal(system.split("硬性格式约束").length - 1, 1);
  assert.match(system, /甲野一郎：第一人称 「オレ」/);

  const user = JSON.parse(messages[1].content);
  assert.deepEqual(user.chapterSpeechHabits, {
    scope: "chapter",
    chapter: "第一章",
    characters: ["甲野一郎"],
  });
  assert.equal(user.chapterSpeechHabits.block, undefined, "完整规则只在系统提示词里发一次");
  assert.equal(user.chapterSpeechHabits.note, undefined, "规则句子不随载荷重发");

  // 没有说话习惯上下文时，提示词里不出现该段落，用户载荷也不带该字段。
  const plain = buildMessages({
    row, targetLabel: "t", targetText: row.cn, counterpartLabel: "s", counterpartText: row.jp,
    diffHelper: "x", context: [], contextMode: "none",
  }, { proofreadMode: "bilingual" });
  // 特化档案里会用「【说话习惯】」提到这个段落，因此按带括号的段首标记断言。
  assert.doesNotMatch(plain[0].content, /【说话习惯（/);
  assert.equal(JSON.parse(plain[1].content).chapterSpeechHabits, undefined);
});
