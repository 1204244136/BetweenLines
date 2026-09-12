const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 与其它 e2e 一样：数据目录必须在 require 之前设好（模块级会读它）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-weblookup-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, startProofread } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");
const {
  WEB_LOOKUP_PREFIX,
  termExcerpt,
  webLookupBlock,
  webLookupEntries,
  webLookupNote,
  webLookupSites,
} = require("../src/workbenches/translation-compare/ai/web-lookup");
const { loadTermTables } = require("../src/workbenches/translation-compare/ai/term-table");

// 与示范档案里声明同形：三个官方站点入口，顺序就是查询顺序。
const SITES = [
  { label: "中文（灰机）", url: "https://toaru.huijiwiki.com/wiki/%E9%A6%96%E9%A1%B5" },
  { label: "日文（atwiki）", url: "https://w.atwiki.jp/index-index" },
  { label: "英文（Fandom）", url: "https://toarumajutsunoindex.fandom.com/wiki/Toaru_Majutsu_no_Index_Wiki" },
];

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function writeTerms() {
  const file = path.join(dataDir, "web-lookup-terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Ruby_Trans,Other_Fandom,Type",
    "グループ,,GROUP,,,组织/暗部",
    "【発信機】,はっしんき,【发信器】,,发射机,科技/装备",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);
  return { file, tables };
}

function guidanceFor(source, target, tables) {
  const { evaluateTermRow } = require("../src/workbenches/translation-compare/ai/term-table");
  const { termGuidanceFor } = require("../src/workbenches/translation-compare/ai/term-prefilter");
  const evaluation = evaluateTermRow({ source, target, tables });
  if (!evaluation) return null;
  const guidance = termGuidanceFor({ index: 1, jp: source }, { evaluation, targetKey: "cn", targetLabel: "非原文 B" });
  return guidance ? { ...guidance, evaluation } : null;
}

test("站点列表：字符串/对象都接受，去重并保持声明顺序（顺序就是查询顺序）", () => {
  assert.deepEqual(
    webLookupSites(SITES).map((site) => site.label),
    ["中文（灰机）", "日文（atwiki）", "英文（Fandom）"],
  );
  // 纯字符串数组：label 缺省用域名，顺序不变；重复 URL 只留一次。
  const short = webLookupSites(["https://example.com/a", "https://example.com/b", "https://example.com/a"]);
  assert.deepEqual(short.map((site) => site.url), ["https://example.com/a", "https://example.com/b"]);
  assert.equal(short[0].label, "example.com");
  assert.deepEqual(webLookupSites(""), []);
  assert.deepEqual(webLookupSites([{ label: "无地址" }]), []);
});

test("检索词条只来自假名存疑项：译名优先、原文备选，且带该行片段", () => {
  const { tables } = writeTerms();
  const jp = "街の八割を分類する六段階評価の、まさに頂点グループ。";
  const targetText = "<b>处于</b>顶级位置的一类人。";
  const guidance = guidanceFor(jp, targetText, tables);
  assert.equal(guidance.evaluation.kind, "advisory");

  const entries = webLookupEntries({ termGuidance: guidance, jp, targetText });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].terms, ["GROUP", "グループ"], "译名优先、原文作备选（不给直达链接，只给要查的词）");
  assert.match(entries[0].excerpt, /頂点グループ/);
  assert.equal(entries[0].targetText, "处于顶级位置的一类人。", "片段里的内联标记要剥掉");

  // 非存疑命中不给词条：conflict 由对照表直接给结论。
  const conflictGuidance = guidanceFor("ＧＰＳ発信機を取り外す。", "取下GPS信号发射机。", tables);
  assert.equal(conflictGuidance.evaluation.kind, "conflict");
  assert.deepEqual(webLookupEntries({ termGuidance: conflictGuidance, jp: "ＧＰＳ発信機。", targetText: "GPS发射机。" }), []);
  assert.deepEqual(webLookupEntries({ termGuidance: { terms: [] }, jp, targetText }), []);
});

test("查证段：只给站点入口与词条，写明“拿到关键信息就停、查不到不许猜”", () => {
  const entries = [{ terms: ["GROUP", "グループ"], excerpt: "…まさに頂点グループ。", targetText: "处于顶级位置的一类人。", type: "组织/暗部" }];

  const first = webLookupBlock({ sites: SITES, entries, round: 0 });
  assert.match(first, new RegExp(`^${WEB_LOOKUP_PREFIX} 第 1/3 站：中文（灰机）`));
  assert.match(first, /站点入口：https:\/\/toaru\.huijiwiki\.com\/wiki\/%E9%A6%96%E9%A1%B5/);
  assert.equal(/wiki\/GROUP/.test(first), false, "不给直达词条链接（猜条目名容易错）");
  assert.match(first, /词条：GROUP、グループ（组织\/暗部）/);
  assert.match(first, /站内查找/);
  assert.match(first, /打不开、站内搜不到、查到的内容与问题无关时，都不要猜测/);
  assert.match(first, /拿到足以定论的关键信息就\*\*立即\*\*给出结论/);
  assert.match(first, /下一个站点/);

  // 最后一轮：官方站点都没结果，改为自行检索。
  const last = webLookupBlock({ sites: SITES, entries, round: SITES.length });
  assert.match(last, /官方站点均未获得有效信息，改为自行检索/);
  assert.match(last, /浏览器、搜索引擎/);
  assert.match(last, /不要用训练记忆或常识顶替/);
  assert.equal(webLookupBlock({ sites: SITES, entries: [] }), "");

  assert.match(webLookupNote({ concluded: true, siteLabel: "日文（atwiki）" }), /线上查证：日文（atwiki）查到依据/);
  assert.match(webLookupNote({ concluded: true, siteLabel: "" }), /模型自行检索后得出结论/);
  assert.match(
    webLookupNote({ concluded: false, triedLabels: ["中文（灰机）", "日文（atwiki）", "英文（Fandom）", "自行检索"] }),
    /已依次尝试 中文（灰机） → 日文（atwiki） → 英文（Fandom） → 自行检索，均未获得有效内容，转人工确认/,
  );
});

test("上下文片段：术语附近、剥掉内联标记、边界不越界", () => {
  const long = `${"あ".repeat(40)}グループ${"い".repeat(40)}`;
  assert.equal(termExcerpt(long, "グループ", 6), `…${"あ".repeat(6)}グループ${"い".repeat(6)}…`);
  assert.equal(termExcerpt("グループだ。", "グループ", 6), "グループだ。");
  assert.equal(termExcerpt("<ruby>食蜂<rt>しょくほう</rt></ruby>の話", "食蜂", 6), "食蜂の話");
});

function publishRows(label, rows) {
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
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({ project, rows }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });
  return project;
}

/**
 * 本地模型接口：可指定“第几轮开始能给出结论”。
 * `concludeAtRound` = 1 表示第一次查证（第 1 站）就有结论；4 表示要查到“自行检索”那轮才行；null 表示怎么都判不了。
 */
function startModelServer(concludeAtRound = null) {
  const captured = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const system = parsed.messages?.[0]?.content || "";
      const user = JSON.parse(parsed.messages?.[1]?.content || "{}");
      // 轮次：0 = 基础判断（不带查证段）；1..3 = 第 N 站；4 = 自行检索那一轮。
      const stationMatch = system.match(/第 (\d+)\/(\d+) 站/);
      const lookupRound = stationMatch
        ? Number(stationMatch[1])
        : (system.includes(WEB_LOOKUP_PREFIX) ? 4 : 0);
      captured.push({ system, user, lookupRound });
      const answered = concludeAtRound !== null && lookupRound >= concludeAtRound;
      const answer = answered
        ? { semanticSame: true, needsEdit: false, needsContext: false, decision: "keep", summary: "据查到的资料，这里是普通名词“集团”，译文无需修改。" }
        : { semanticSame: false, needsEdit: false, needsContext: true, summary: "这一行的假名写法无法确定指代。" };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  return { server, captured };
}

async function runProofread({ rows, label, termTables, sites = SITES, webLookup = true, concludeAtRound = 1 }) {
  clearProofreadCache();
  const project = publishRows(label, rows);
  const { server, captured } = startModelServer(concludeAtRound);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await startProofread({
      provider: "compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: "test-model",
      proofreadMode: "bilingual",
      concurrency: 1,
      termTables: [termTables],
      wikiSites: sites,
      webLookup,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });
    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { captured, status: clientStatus() };
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

const ADVISORY_ROW = {
  index: 218,
  chapter: "第一章",
  jp: "街の八割を分類する六段階評価の、まさに頂点グループ。",
  cn: "在把都市居民分成六级的评价系统中，处于顶级位置的一类人。",
  tw: "", twCn: "", score: 0,
};

test("按顺序查：第 1 站拿到关键信息就停，后面的站点与自行检索都不再发", async () => {
  const { file } = writeTerms();
  const { captured, status } = await runProofread({
    rows: [ADVISORY_ROW],
    label: "web-lookup-first",
    termTables: file,
    concludeAtRound: 1,
  });

  assert.equal(captured.length, 2, "基础判断 1 轮 + 第 1 站查证 1 轮，第 2/3 站与自行检索都不发");
  assert.equal(captured[0].system.includes(WEB_LOOKUP_PREFIX), false, "基础轮不带查证段");
  assert.match(captured[1].system, /第 1\/3 站：中文（灰机）/);
  assert.match(captured[1].system, /站点入口：https:\/\/toaru\.huijiwiki\.com\/wiki\/%E9%A6%96%E9%A1%B5/);
  assert.equal(captured[1].user.webLookup.site.label, "中文（灰机）");
  assert.deepEqual(captured[1].user.webLookup.terms[0].terms, ["GROUP", "グループ"]);

  const result = status.results.find((item) => item.index === 218);
  assert.match(result.note, /线上查证：中文（灰机）查到依据/);
  assert.equal(result.done, true, "拿到依据后这一行就算完成，人工只接受结果");
  assert.equal(status.webLookups, 1);
  assert.equal(status.webLookupAttempts, 1);
  assert.equal(status.webLookupResolved, 1);
  assert.deepEqual(status.webLookupSites, ["中文（灰机）", "日文（atwiki）", "英文（Fandom）"]);
  assert.match(status.logs.join("\n"), /查询「GROUP、グループ」→ 线上查证 1\/3（中文（灰机））/);
  assert.match(status.logs.join("\n"), /线上查证：1 行模型判断不了，已按顺序查证 中文（灰机） → 日文（atwiki） → 英文（Fandom） → 自行检索/);
});

test("第 1 站查不到就换下一个：查到即停，不再查第 3 站", async () => {
  const { file } = writeTerms();
  const { captured, status } = await runProofread({
    rows: [ADVISORY_ROW],
    label: "web-lookup-second",
    termTables: file,
    concludeAtRound: 2,
  });

  assert.equal(captured.length, 3, "基础 + 第 1 站 + 第 2 站；第 3 站不再发");
  assert.match(captured[1].system, /第 1\/3 站：中文（灰机）/);
  assert.match(captured[2].system, /第 2\/3 站：日文（atwiki）/);
  assert.equal(/第 3\/3 站/.test(captured.map((call) => call.system).join("\n")), false);
  const result = status.results.find((item) => item.index === 218);
  assert.match(result.note, /线上查证：日文（atwiki）查到依据/);
  assert.equal(status.webLookupAttempts, 2);
  assert.match(status.logs.join("\n"), /中文（灰机） 未获得有效信息，换下一个来源/);
});

test("三个站点都不行 → 让模型自行检索；还不行 → 备注写清尝试轨迹并转人工", async () => {
  const { file } = writeTerms();

  // 自行检索那轮给出结论。
  const resolved = await runProofread({
    rows: [ADVISORY_ROW],
    label: "web-lookup-self",
    termTables: file,
    concludeAtRound: 4,
  });
  assert.equal(resolved.captured.length, 5, "基础 + 3 站 + 自行检索");
  assert.match(resolved.captured[4].system, /官方站点均未获得有效信息，改为自行检索/);
  assert.equal(resolved.captured[4].user.webLookup.site, null);
  const selfResult = resolved.status.results.find((item) => item.index === 218);
  assert.match(selfResult.note, /线上查证：模型自行检索后得出结论/);
  assert.equal(selfResult.done, true);

  // 连自行检索都判不了：终局为待人工，备注列出完整尝试轨迹。
  const stuck = await runProofread({
    rows: [{ ...ADVISORY_ROW, index: 219 }],
    label: "web-lookup-stuck",
    termTables: file,
    concludeAtRound: null,
  });
  assert.equal(stuck.captured.length, 5, "这一层最多 4 轮查证，不会无限循环");
  const stuckResult = stuck.status.results.find((item) => item.index === 219);
  assert.match(stuckResult.note, /是否需要修改：待人工确认/);
  assert.match(stuckResult.note, /线上查证：已依次尝试 中文（灰机） → 日文（atwiki） → 英文（Fandom） → 自行检索，均未获得有效内容，转人工确认/);
  assert.equal(stuckResult.done, false);
  assert.equal(stuck.status.webLookupResolved, 0);
  assert.equal(stuck.status.webLookupAttempts, 4);
});

test("关闭开关或档案没声明站点时这一层完全不动（不注入、不额外请求）", async () => {
  const { file } = writeTerms();
  const off = await runProofread({ rows: [ADVISORY_ROW], label: "web-lookup-off", termTables: file, webLookup: false });
  assert.equal(off.captured.length, 1, "关了开关就只问一次模型");
  assert.equal(off.captured[0].system.includes(WEB_LOOKUP_PREFIX), false);
  assert.equal(off.captured[0].user.webLookup, undefined);
  assert.equal(off.status.webLookups, 0);
  assert.deepEqual(off.status.webLookupSites, []);
  assert.equal(/线上查证/.test(off.status.results.find((item) => item.index === 218).note), false);

  const noSites = await runProofread({ rows: [ADVISORY_ROW], label: "web-lookup-nosites", termTables: file, sites: [] });
  assert.equal(noSites.captured.length, 1, "没有站点声明就不进入这一层");
  assert.equal(noSites.status.webLookups, 0);
});

test("非存疑行不进这一层：译名差异行由对照表直接给结论", async () => {
  const { tables } = writeTerms();
  const jp = "ＧＰＳ発信機を取り外す。";
  const targetText = "取下GPS信号发射机。";
  const guidance = guidanceFor(jp, targetText, tables);
  assert.equal(guidance.evaluation.kind, "conflict");
  assert.deepEqual(webLookupEntries({ termGuidance: guidance, jp, targetText }), []);
});
