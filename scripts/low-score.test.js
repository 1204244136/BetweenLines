const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 与其它 e2e 一样：数据目录必须在 require 之前设好（模块级会读它）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-lowscore-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, startProofread } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");
const {
  DEFAULT_LOW_SCORE_PENALTY,
  DEFAULT_LOW_SCORE_ROWS,
  LOW_SCORE_PREFIX,
  causeLabel,
  isShiftCause,
  lowScoreBlock,
  lowScoreNote,
  normalizeCause,
  shouldCheckLowScore,
} = require("../src/workbenches/translation-compare/ai/low-score");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test("触发判据：只有扣分达到阈值的确定缺陷行才进归因层", () => {
  const low = { needsEdit: true, needsContext: false, better: "neither", penalty: 80, score: 20, grade: "poor" };
  assert.equal(shouldCheckLowScore({ decision: low }), true);
  // 阈值边界：恰好等于阈值触发，差一分不进（默认扣 60 分，等价 score ≤ 40）。
  assert.equal(shouldCheckLowScore({ decision: { ...low, penalty: DEFAULT_LOW_SCORE_PENALTY, score: 100 - DEFAULT_LOW_SCORE_PENALTY } }), true);
  assert.equal(shouldCheckLowScore({ decision: { ...low, penalty: DEFAULT_LOW_SCORE_PENALTY - 1, score: 41 } }), false);
  // 普通缺陷（fair 档、扣 30）不进这一层：否则每行都要多发一次请求。
  assert.equal(shouldCheckLowScore({ decision: { needsEdit: true, penalty: 30, score: 70, grade: "fair" } }), false);
  // 判不下来的行走补上下文那条路，不在这一层重复问。
  assert.equal(shouldCheckLowScore({ decision: { ...low, needsContext: true } }), false);
  assert.equal(shouldCheckLowScore({ decision: { ...low, better: "unclear", needsContext: false } }), false);
  // 无需修改的行不进来。
  assert.equal(shouldCheckLowScore({ decision: { needsEdit: false, penalty: 0, score: 100, grade: "excellent" } }), false);
  // 只判档位、没给分数的模型：系统按 poor 折算 penalty=45，够不上默认阈值 —— 判据只用扣分，不用档位兜底
  // （否则整个 poor 档都会被拉进来，阈值参数形同虚设）。
  assert.equal(shouldCheckLowScore({ decision: { needsEdit: true, penalty: 45, score: 55, grade: "poor" } }), false);
  // 真要让整个 poor 档都归因，把阈值调到折算值即可。
  assert.equal(shouldCheckLowScore({ decision: { needsEdit: true, penalty: 45, score: 55, grade: "poor" }, minPenalty: 45 }), true);
  // 前后都没有别的行时无从复核。
  assert.equal(shouldCheckLowScore({ decision: low, hasNeighbor: false }), false);
  assert.equal(shouldCheckLowScore({}), false);
  // 阈值可调：调高到 90 后，扣 80 的行不再进这一层。
  assert.equal(shouldCheckLowScore({ decision: low, minPenalty: 90 }), false);
});

test("归因取值归一：中英文与近义写法都收，认不出的按“未归因”处理", () => {
  assert.equal(normalizeCause("order-shift-next"), "order-shift-next");
  assert.equal(normalizeCause("与上一行错位"), "order-shift-prev");
  assert.equal(normalizeCause("跨行错位"), "order-shift");
  assert.equal(normalizeCause("Order-Shift-Prev"), "order-shift-prev");
  assert.equal(normalizeCause("对齐切分"), "boundary");
  assert.equal(normalizeCause("needs-context"), "context");
  assert.equal(normalizeCause("语义硬伤"), "meaning");
  assert.equal(normalizeCause("增译"), "content");
  assert.equal(normalizeCause("译名不一致"), "term");
  assert.equal(normalizeCause("翻译腔"), "wording");
  assert.equal(normalizeCause("原文风格"), "source-style");
  assert.equal(normalizeCause("无需修改"), "none");
  assert.equal(normalizeCause("归因不了"), "unclear");
  assert.equal(normalizeCause("看起来很怪"), "", "认不出的取值不能随便塞进某一类");
  assert.equal(normalizeCause(""), "");

  assert.equal(isShiftCause("order-shift-next"), true);
  assert.equal(isShiftCause("wording"), false);
  assert.match(causeLabel("boundary"), /对齐切分/);
  assert.equal(causeLabel("不存在"), "");
});

test("归因段：先解释低分原因、错位必查、保持原文行序、不许猜译文", () => {
  const block = lowScoreBlock({ targetLabel: "译文 B", sourceLabel: "原文 A", rows: 2 });
  assert.match(block, new RegExp(`^${LOW_SCORE_PREFIX}`));
  assert.match(block, /先给出\*\*低分原因\*\*，再按原因修/);
  assert.match(block, /跨行错位（必查，且优先于其它判断）/);
  assert.match(block, /已给出本行前后各 2 行/);
  assert.match(block, /不得据此判缺陷/);
  assert.match(block, /语义硬伤|关键信息遗漏|术语或译名不一致|表达层/);
  assert.match(block, /不得建议对调相邻两行的译文/);
  assert.match(block, /不得把两行内容糅进一条 revisedText/);
  assert.match(block, /返回 needsContext=true/);
  assert.match(block, /不要凭猜测填 revisedText/);
  // 段里只说“分数低到需要归因”，不下发程序的阈值与轮次预算。
  assert.equal(/扣分阈值|penalty|maxRounds/.test(block), false);
  // 窗口是程序参数里唯一需要告诉模型的那个（决定它看到几行邻行）。
  assert.equal(lowScoreBlock({ rows: 0 }).includes("前后各 1 行"), true, "窗口下限为 1");
  assert.equal(lowScoreBlock({ rows: 99 }).includes("前后各 4 行"), true, "窗口上限为 4");
});

test("归因备注：每一类原因都写清“为什么低分”，错位额外写明方向与保持行序", () => {
  assert.equal(lowScoreNote({ checked: false }), "", "没进归因层的行不留痕");
  assert.match(
    lowScoreNote({ checked: true, cause: "order-shift-next", neighbors: 3 }),
    /低分归因：本行译文实际写的是\*\*下一行\*\*的内容（跨行错位），已保持原文行序、按本行原文重写/,
  );
  assert.match(lowScoreNote({ checked: true, cause: "order-shift-prev" }), /\*\*上一行\*\*/);
  assert.match(lowScoreNote({ checked: true, cause: "order-shift" }), /未给出方向/);
  assert.match(lowScoreNote({ checked: true, cause: "boundary", neighbors: 2 }), /低分归因：对齐切分/);
  assert.match(
    lowScoreNote({ checked: true, cause: "meaning", neighbors: 2 }),
    /语义硬伤（否定\/时态\/主被动\/主谓宾\/因果\/数字\/人名等）（已核对相邻 2 行）/,
  );
  assert.match(lowScoreNote({ checked: true, cause: "source-style" }), /不构成缺陷/);
  assert.match(lowScoreNote({ checked: true, cause: "none" }), /复核后认为无需修改/);
  assert.match(lowScoreNote({ checked: true, cause: "context", neighbors: 2 }), /转人工确认/);
  assert.match(lowScoreNote({ checked: true, cause: "unclear" }), /转人工确认/);
  assert.match(lowScoreNote({ checked: true }), /模型未给出明确归因/, "进了这一层但没填原因也要如实写");
  // 邻行数按**实际**核对到的行数写：窗口受数据集边界限制时，不能拿配置值冒充。
  assert.equal(/（已核对相邻/.test(lowScoreNote({ checked: true, cause: "meaning" })), false);
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

/** 目标行：与相邻行的译文互换（本行译文写的是下一行的内容），基础轮大概率被判极低分。 */
const SWAPPED_ROW = {
  index: 2,
  chapter: "第一章",
  jp: "二人の少女がいつも無邪気に尋ねてきた。",
  cn: "我很期待你。然而换言之这也将成为巨大的压力。",
  tw: "",
  twCn: "",
  score: 0,
};

/**
 * 本地模型接口：区分「基础轮」「归因轮」与其它行的常规轮。
 * - 目标行基础轮：返回极低分（score 20 / penalty 80 / grade poor），模拟截图中那类判定；
 * - 目标行归因轮：按 `diagnosis` 返回（可配 cause / needsEdit / needsContext）；
 * - 其它行：返回“无需修改”，避免它们也进入归因层干扰计数。
 */
function startModelServer({ diagnosis = {}, targetIndex = 2 } = {}) {
  const captured = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const system = parsed.messages?.[0]?.content || "";
      const user = JSON.parse(parsed.messages?.[1]?.content || "{}");
      const stage = system.includes(LOW_SCORE_PREFIX) ? "low-score" : "base";
      captured.push({ system, user, stage });
      let answer;
      if (Number(user.row?.index) !== targetIndex) {
        answer = { semanticSame: true, needsEdit: false, needsContext: false, summary: "无需修改：译文与原文一致。", decision: "keep" };
      } else if (stage === "base") {
        answer = {
          semanticSame: false,
          needsEdit: true,
          needsContext: false,
          decision: "replace",
          score: 20,
          penalty: 80,
          grade: "poor",
          summary: "需要修改：整行与原文无关，像凭空多出来的台词。",
          revisedText: "需要修改的占位文本。",
        };
      } else {
        answer = { semanticSame: false, needsEdit: true, needsContext: false, decision: "replace", score: 30, penalty: 70, grade: "poor", summary: "需要修改：按原文重写本行。", revisedText: "两位少女甚至天真无邪地问了过来。", ...diagnosis };
      }
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }));
    });
  });
  return { server, captured };
}

async function runProofread({ rows, label, diagnosis = {}, targetIndex = 2, config = {} }) {
  clearProofreadCache();
  const project = publishRows(label, rows);
  const { server, captured } = startModelServer({ diagnosis, targetIndex });
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
      ...config,
    });
    const deadline = Date.now() + 10000;
    while (clientStatus({ includeResults: false }).running && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { captured, status: clientStatus(), targetIndex };
  } finally {
    await new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }
}

function rowsForTarget(targetIndex, count = 7) {
  return Array.from({ length: count }, (_, offset) => ({
    // 只有目标行的译文与原文不搭（模拟跨行错位），其余行正常。
    index: offset + 1,
    chapter: "第一章",
    jp: `第${offset + 1}行の原文テキストです。`,
    cn: offset + 1 === targetIndex
      ? SWAPPED_ROW.cn
      : `第${offset + 1}行的译文内容。`,
    tw: "",
    twCn: "",
    score: 0,
  }));
}

test("极低分先归因：转到归因轮、补相邻行、按原因修，结果与统计都留痕", async () => {
  const { captured, status } = await runProofread({
    rows: rowsForTarget(2),
    label: "low-score-shift",
    diagnosis: { cause: "order-shift-next" },
  });

  const targetCalls = captured.filter((call) => Number(call.user.row?.index) === 2);
  const otherCalls = captured.filter((call) => Number(call.user.row?.index) !== 2);
  assert.equal(targetCalls.length, 2, "目标行：基础轮 1 次 + 归因轮 1 次");
  assert.equal(targetCalls[0].stage, "base");
  assert.equal(targetCalls[0].system.includes(LOW_SCORE_PREFIX), false, "基础轮不带归因段");

  // 归因轮：段、载荷与窗口都要到位。
  const attribution = targetCalls[1];
  assert.equal(attribution.stage, "low-score");
  assert.match(attribution.system, new RegExp(LOW_SCORE_PREFIX));
  assert.match(attribution.system, /跨行错位（必查/);
  assert.match(attribution.system, /不得建议对调相邻两行的译文/);
  assert.equal(attribution.user.lowScore.window, DEFAULT_LOW_SCORE_ROWS);
  assert.match(attribution.user.lowScore.reason, /极低分/);
  const nearby = attribution.user.nearbyRows.map((item) => item.index);
  assert.deepEqual(nearby, [1, 3, 4], "窗口按前后各 2 行扩（一侧行不足时由另一侧补上），当前行自己不在里面");
  assert.equal(nearby.includes(2), false, "当前行不在 nearbyRows 里（它自己就是 row）");  assert.match(attribution.user.nearbyRows[0].source, /原文テキスト/);
  assert.match(attribution.user.nearbyRows[0].target, /译文内容/);

  // 其它行照常判，不该被卷进这一层。
  assert.equal(otherCalls.every((call) => call.stage === "base"), true);

  // 结果：备注写明低分原因、保持原文行序；状态与统计如实留痕。
  const result = status.results.find((item) => item.index === 2);
  assert.match(result.note, /低分归因：本行译文实际写的是\*\*下一行\*\*的内容（跨行错位），已保持原文行序、按本行原文重写/);
  assert.match(result.note, /修改结果：两位少女甚至天真无邪地问了过来。/);
  // 备注按行取值：「修改结果：」必须是最后一段且只放本行成品文本，说明行跟在它后面
  // 会被并进修改结果（页面上就是可写回文本），所以低分归因写在分析栏里。
  const noteLines = result.note.split("\n");
  assert.equal(noteLines.at(-1), "修改结果：两位少女甚至天真无邪地问了过来。");
  const analysisIndex = noteLines.findIndex((line) => line.startsWith("分析："));
  const attributionIndex = noteLines.findIndex((line) => line.startsWith("低分归因："));
  assert.equal(attributionIndex > analysisIndex && attributionIndex < noteLines.length - 1, true, "低分归因写在分析栏里（分析之后、修改结果之前）");
  assert.equal(status.lowScoreChecks, 1);
  assert.equal(status.lowScoreShifted, 1);
  assert.deepEqual(status.lowScoreCauses, { "order-shift-next": 1 });
  assert.equal(status.lowScoreEnabled, true);
  assert.equal(status.lowScorePenalty, DEFAULT_LOW_SCORE_PENALTY);
  assert.match(status.logs.join("\n"), /转入低分归因复核（先解释低分原因再修，跨行错位为必查项，窗口 ±2 行）/);
  assert.match(status.logs.join("\n"), /低分归因 → order-shift-next/);
  assert.match(status.logs.join("\n"), /低分归因：1 行因扣分达到阈值转入复核.*其中跨行错位 1 行/);
});

test("归因结论写进备注：非错位原因按类别标注，复核后推翻低分也如实写", async () => {
  const meaning = await runProofread({
    rows: rowsForTarget(2),
    label: "low-score-meaning",
    diagnosis: { cause: "meaning" },
  });
  const meaningResult = meaning.status.results.find((item) => item.index === 2);
  assert.match(meaningResult.note, /低分归因：语义硬伤（否定\/时态\/主被动\/主谓宾\/因果\/数字\/人名等）（已核对相邻 3 行）/);
  assert.equal(meaning.status.lowScoreShifted, 0);
  assert.deepEqual(meaning.status.lowScoreCauses, { meaning: 1 });

  // 复核后认为本来就不该扣这么多分：needsEdit 回到 false，结果标为完成，但归因痕迹保留。
  const cleared = await runProofread({
    rows: rowsForTarget(2),
    label: "low-score-none",
    diagnosis: { cause: "source-style", needsEdit: false, decision: "keep", revisedText: "", summary: "无需修改：原文本身就是这种晦涩写法。" },
  });
  const clearedResult = cleared.status.results.find((item) => item.index === 2);
  assert.match(clearedResult.note, /是否需要修改：否/);
  assert.match(clearedResult.note, /低分归因：原文风格化写法，不构成缺陷/);
  assert.equal(clearedResult.done, true);
  assert.deepEqual(cleared.status.lowScoreCauses, { "source-style": 1 });
});

test("归因轮要上下文时继续补行：窗口一轮比一轮宽，仍判不了就转人工", async () => {
  const { captured, status } = await runProofread({
    rows: rowsForTarget(4),
    label: "low-score-context",
    targetIndex: 4,
    // 归因轮始终判不下来：程序应继续扩窗口，而不是直接产出编造的译文。
    diagnosis: { needsContext: true, cause: "context", needsEdit: false, decision: "unclear", summary: "依据不足，需要更多相邻行。", revisedText: "" },
  });

  const targetCalls = captured.filter((call) => Number(call.user.row?.index) === 4);
  assert.equal(targetCalls.length, 3, "基础轮 + 归因轮 2 次：窗口扩到数据集边界后不再重复提问");
  assert.equal(targetCalls[0].stage, "base");
  assert.equal(targetCalls.slice(1).every((call) => call.stage === "low-score"), true, "触发后每轮都按归因口径问");
  const windows = targetCalls.slice(1).map((call) => call.user.nearbyRows.length);
  assert.deepEqual(windows, [4, 6], "先一次补到前后各 2 行，再按 needsContext 继续扩到数据集边界");
  assert.equal(targetCalls.at(-1).system.includes(LOW_SCORE_PREFIX), true, "补上下文轮次仍带归因段，口径不跳");

  const result = status.results.find((item) => item.index === 4);
  assert.match(result.note, /是否需要修改：待人工确认/);
  assert.match(result.note, /低分归因：依据不足（需要更多相邻行才能定论）（已核对相邻 6 行），转人工确认/);
  assert.equal(result.done, false);
  assert.equal(status.lowScoreChecks, 1);
});

test("关闭开关或行数据不足时这一层完全不动（不注入、不额外请求）", async () => {
  const off = await runProofread({
    rows: rowsForTarget(2),
    label: "low-score-off",
    config: { lowScoreCheck: false },
  });
  const offCalls = off.captured.filter((call) => Number(call.user.row?.index) === 2);
  assert.equal(offCalls.length, 1, "关了开关就只问一次模型");
  assert.equal(off.captured.some((call) => call.system.includes(LOW_SCORE_PREFIX)), false);
  assert.equal(off.status.lowScoreChecks, 0);
  assert.equal(off.status.lowScoreEnabled, false);
  assert.equal(/低分归因/.test(off.status.results.find((item) => item.index === 2).note), false);

  // 阈值调高到 90：扣 80 的行不再进这一层（阈值可配）。
  const strict = await runProofread({
    rows: rowsForTarget(2),
    label: "low-score-strict",
    config: { lowScorePenalty: 90 },
  });
  assert.equal(strict.captured.filter((call) => Number(call.user.row?.index) === 2).length, 1);
  assert.equal(strict.status.lowScoreChecks, 0);
});

test("首行没有可复核的邻行时跳过这一层（只有一行数据也一样）", async () => {
  const { captured, status } = await runProofread({
    rows: [{ ...SWAPPED_ROW, index: 1 }],
    label: "low-score-single",
    targetIndex: 1,
    diagnosis: { cause: "order-shift-next" },
  });
  assert.equal(captured.length, 1, "前后都没有行可核对，不进入归因层");
  assert.equal(captured[0].system.includes(LOW_SCORE_PREFIX), false);
  assert.equal(status.lowScoreChecks, 0);
});
