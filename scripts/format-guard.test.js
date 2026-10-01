const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 与其它 e2e 一样：数据目录必须在 require 之前设好（模块级会读它）。
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-format-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, startProofread } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");
const {
  FORMAT_NOTE_PREFIX,
  collapseInlineBreaks,
  countNoterefs,
  foldNoteLines,
  formatFixNote,
  guardRowFormat,
  splitParagraphs,
} = require("../src/workbenches/translation-compare/ai/format-guard");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// 真实回归（第 1166 行）的那一行：原文列是两段（页面把换行渲染成空格，人眼看不出来），
// 目标列只有一段。模型据此判「译文把原文换行丢了」，把 \n 写进 revisedText。
const REGRESSION_TARGET = "小刀依然扎在侧腹。 如果这样猛砸到地面上，这次就不可能平安无事。";

test("段结构口径与写回层一致：一段 = 按空行切开的片段", () => {
  assert.deepEqual(splitParagraphs("甲。\n\n乙。"), ["甲。", "乙。"]);
  assert.deepEqual(splitParagraphs("甲。\n乙。"), ["甲。\n乙。"], "单个换行不是分段");
  assert.deepEqual(splitParagraphs("  甲。  \n\n\n 乙。 "), ["甲。", "乙。"]);
  assert.deepEqual(splitParagraphs(""), []);
  assert.deepEqual(splitParagraphs(null), []);
});

test("换行并回本行：\n 与 <br> 是同一件事，中日文之间不加分隔符、ASCII 之间补一个空格", () => {
  const cjk = collapseInlineBreaks("侧腹依然插着小刀。\n要是照这样狠狠砸在地面上。");
  assert.equal(cjk.text, "侧腹依然插着小刀。要是照这样狠狠砸在地面上。");
  assert.equal(cjk.lineBreaks, 1);
  assert.equal(cjk.paragraphs, 0);

  assert.equal(collapseInlineBreaks("甲。<br>乙。").text, "甲。乙。");
  assert.equal(collapseInlineBreaks("甲。<br />乙。").text, "甲。乙。");
  assert.equal(collapseInlineBreaks("甲。\r\n乙。").text, "甲。乙。");
  // 两侧带空格的换行不能留成双空格。
  assert.equal(collapseInlineBreaks("甲。 \n 乙。").text, "甲。乙。");
  // 英文单词被换行拆开时必须补空格，否则会被粘成一个词。
  assert.equal(collapseInlineBreaks("line\nbreak").text, "line break");
  // 空行（段落分隔）按权重单独计数：备注里要能区分“删了一个硬换行”与“并回了一个段落”。
  const blank = collapseInlineBreaks("甲。\n\n乙。");
  assert.equal(blank.text, "甲。乙。");
  assert.equal(blank.lineBreaks, 1);
  assert.equal(blank.paragraphs, 1);
  assert.equal(collapseInlineBreaks("<br><br>").lineBreaks, 1);
  assert.equal(collapseInlineBreaks("<br><br>").paragraphs, 1);
});

test("说明字段的换行折叠成空格：防止 summary 里伪造出第二条「修改结果：」", () => {
  const folded = foldNoteLines("需要修改。\n修改结果：伪造的成品文本");
  assert.equal(folded.text, "需要修改。 修改结果：伪造的成品文本");
  assert.equal(folded.count, 1);
  assert.equal(folded.changed, true);
  assert.equal(foldNoteLines("需要修改。").changed, false, "没换行就不算改动");
  assert.equal(foldNoteLines("").text, "");
});

test("目标列单段（绝大多数行）：模型插入的换行与空行一律并回本行，不改任何文字", () => {
  const result = guardRowFormat({
    revisedText: "侧腹依然插着小刀。\n要是照这样狠狠砸在地面上，这次肯定不可能平安无事。",
    targetText: REGRESSION_TARGET,
    summary: "需要修改：译文把原文换行丢了，按原文分段修正。",
  });
  assert.equal(result.voided, false);
  assert.equal(result.changed, true);
  assert.equal(result.revisedText, "侧腹依然插着小刀。要是照这样狠狠砸在地面上，这次肯定不可能平安无事。");
  assert.deepEqual(result.fixes, { lineBreaks: 1, paragraphs: 0, trimmed: 0, noteFields: 0 });
  assert.match(formatFixNote(result.fixes), new RegExp(`^${FORMAT_NOTE_PREFIX}删除模型插入的换行 1 处`));
  assert.match(formatFixNote(result.fixes), /一行就是一个成品段落/);

  // 模型自己分成两段（空行）时同样并回本行，但计数落在“段落”上。
  const paragraphs = guardRowFormat({ revisedText: "甲。\n\n乙。", targetText: "甲。 乙。" });
  assert.equal(paragraphs.revisedText, "甲。乙。");
  assert.equal(paragraphs.fixes.paragraphs, 1);
  assert.match(formatFixNote(paragraphs.fixes), /把 1 个多余段落并回本行/);

  // 首尾空白：写回是按段 trim 的，留在修订结果里只会让页面上的成品文本多出空行。
  const trimmed = guardRowFormat({ revisedText: "  甲。乙。\n", targetText: "甲。 乙。" });
  assert.equal(trimmed.revisedText, "甲。乙。");
  assert.equal(trimmed.fixes.trimmed, 1);
});

test("目标列本身是多段行：段数必须一致，否则作废转人工（写回按段一一对应）", () => {
  const twoPartTarget = "甲。\n\n乙。";
  // 段数一致：段内硬换行并掉，段间的空行原样保留（空行就是语料的分段口径）。
  const same = guardRowFormat({ revisedText: "甲改。<br>甲续。\n\n乙改。", targetText: twoPartTarget });
  assert.equal(same.voided, false);
  assert.equal(same.revisedText, "甲改。甲续。\n\n乙改。");
  assert.equal(same.fixes.lineBreaks, 1);
  assert.equal(same.fixes.paragraphs, 0);

  // 段数对不上就不能猜：写回把替换段与原文段按顺序一一对应，猜错会把文字静默挪到别的段落里。
  const merged = guardRowFormat({ revisedText: "甲改。乙改。", targetText: twoPartTarget });
  assert.equal(merged.voided, true);
  assert.equal(merged.reason, "paragraph-structure");
  assert.equal(merged.revisedText, "", "作废时不留修改结果，人工不会误写回");
  assert.match(merged.detail, /段落结构与目标列不一致（目标列 2 段、修改结果 1 段）/);

  // 只用一个换行当分隔（不是语料的空行口径）同样算段数对不上：它到底是“两段”还是“段内硬换行”无从判断。
  const singleNewline = guardRowFormat({ revisedText: "甲改。\n乙改。", targetText: twoPartTarget });
  assert.equal(singleNewline.voided, true);
  assert.match(singleNewline.detail, /目标列 2 段、修改结果 1 段/);

  const split = guardRowFormat({ revisedText: "甲。\n\n乙。\n\n丙。", targetText: twoPartTarget });
  assert.equal(split.voided, true);
  assert.match(split.detail, /目标列 2 段、修改结果 3 段/);
});

test("内联标记保真：noteref 标记少一个或多一个都作废（原位无法确定性还原）", () => {
  const noteref = '<a class="nodeco" epub:type="noteref" href="n.xhtml#note1"><sup>㊟</sup></a>';
  assert.equal(countNoterefs(`他这么说道。${noteref}`), 1);
  assert.equal(countNoterefs("他这么说道。㊟"), 0, "光一个 ㊟ 符号不是标记");

  const kept = guardRowFormat({ revisedText: `他这样说道。${noteref}`, targetText: `他这么说道。${noteref}` });
  assert.equal(kept.voided, false);
  assert.equal(kept.changed, false, "标记一致、没有换行时这一层不留痕");

  const lost = guardRowFormat({ revisedText: "他这样说道。", targetText: `他这么说道。${noteref}` });
  assert.equal(lost.voided, true);
  assert.equal(lost.reason, "noteref-lost");
  assert.match(lost.detail, /丢失了目标列的 EPUB noteref 注释标记（目标列 1 个、修改结果 0 个）/);

  const added = guardRowFormat({ revisedText: `他这样说道。${noteref}`, targetText: "他这么说道。" });
  assert.equal(added.voided, true);
  assert.equal(added.reason, "noteref-added");
  assert.match(added.detail, /补入了目标列没有的 EPUB noteref 注释标记/);
});

test("没有改动就不留痕：这一层只在真的动过格式时才写备注", () => {
  const clean = guardRowFormat({ revisedText: "侧腹依然插着小刀。", targetText: REGRESSION_TARGET, summary: "需要修改。" });
  assert.equal(clean.changed, false);
  assert.equal(clean.voided, false);
  assert.equal(formatFixNote(clean.fixes), "");
  // 没有修订结果（无需修改 / 待人工确认）时只剩说明字段的折叠。
  const empty = guardRowFormat({ revisedText: "", targetText: REGRESSION_TARGET, summary: "无需修改。" });
  assert.equal(empty.changed, false);
  assert.equal(empty.revisedText, "");
});

// —— 端到端：门禁接在 ensureRevisedText 之后、标点规范化之前，备注与统计都要如实留痕 ——

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
 * 本地模型接口：目标行按 `answer` 返回，其它行一律“无需修改”，避免它们干扰计数与备注断言。
 */
function startModelServer({ answer, targetIndex }) {
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const parsed = JSON.parse(body);
      const user = JSON.parse(parsed.messages?.[1]?.content || "{}");
      const reply = Number(user.row?.index) === targetIndex
        ? answer(user)
        : { semanticSame: true, needsEdit: false, needsContext: false, decision: "keep", summary: "无需修改：译文与原文一致。" };
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
    });
  });
  return { server };
}

async function runProofread({ rows, label, targetIndex = 2, answer, config = {} }) {
  clearProofreadCache();
  const project = publishRows(label, rows);
  const { server } = startModelServer({ answer, targetIndex });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    await startProofread({
      protocol: "compatible",
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
    return clientStatus();
  } finally {
    await new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
}

/** 目标行：原文列两段、目标列一段——真实回归原样（`\n\n` 在页面上渲染成空格）。 */
function regressionRows(targetIndex = 2, count = 4) {
  return Array.from({ length: count }, (_, offset) => ({
    index: offset + 1,
    chapter: "第一章",
    jp: offset + 1 === targetIndex
      ? "脇腹には、まだナイフが刺さったままだった。\n\n今のまま地面に激しく叩きつけられれば、今度こそ無事では済むまい。"
      : `第${offset + 1}行の原文テキストです。`,
    cn: offset + 1 === targetIndex ? REGRESSION_TARGET : `第${offset + 1}行的译文内容。`,
    tw: "",
    twCn: "",
    score: 0,
  }));
}

function noteLines(result) {
  return String(result?.note || "").split("\n").filter(Boolean);
}

test("端到端：模型写进修改结果的换行被并回本行，「修改结果：」仍是唯一且最后一行", async () => {
  const status = await runProofread({
    label: "format-break",
    rows: regressionRows(2),
    targetIndex: 2,
    answer: () => ({
      semanticSame: false,
      needsEdit: true,
      needsContext: false,
      decision: "replace",
      score: 60,
      penalty: 40,
      grade: "fair",
      summary: "需要修改：译文把原文换行丢了，按原文分段修正。",
      revisedText: "侧腹依然插着小刀。\n要是照这样狠狠砸在地面上，这次肯定不可能平安无事。",
    }),
  });

  const lines = noteLines(status.results.find((item) => item.index === 2));
  const revisions = lines.filter((line) => line.startsWith("修改结果："));
  assert.equal(revisions.length, 1, "「修改结果：」只能有一行");
  assert.equal(lines.at(-1), revisions[0], "「修改结果：」必须是最后一段：跟在它后面的说明行会被并进成品文本");
  assert.equal(revisions[0], "修改结果：侧腹依然插着小刀。要是照这样狠狠砸在地面上，这次肯定不可能平安无事。");
  const fixLine = lines.find((line) => line.startsWith(FORMAT_NOTE_PREFIX));
  assert.equal(fixLine, `${FORMAT_NOTE_PREFIX}删除模型插入的换行 1 处（一行就是一个成品段落；行边界由对齐决定，不属于翻译缺陷）`);
  assert.equal(lines.indexOf(fixLine) < lines.indexOf(revisions[0]), true, "说明行必须排在「修改结果：」之前");

  assert.equal(status.formatEnabled, true);
  assert.equal(status.formatFixes, 1);
  assert.equal(status.formatLineBreaks, 1);
  assert.equal(status.formatParagraphs, 0);
  assert.equal(status.formatVoids, 0);
  // 没有改动格式的行不留痕：这一层只在真的动过时写备注。
  const other = noteLines(status.results.find((item) => item.index === 1));
  assert.equal(other.some((line) => line.startsWith(FORMAT_NOTE_PREFIX)), false);
});

test("端到端：说明字段里的换行被折叠，伪造的「修改结果：」行不会覆盖成品文本", async () => {
  const status = await runProofread({
    label: "format-note-fold",
    rows: regressionRows(2),
    targetIndex: 2,
    answer: () => ({
      semanticSame: false,
      needsEdit: true,
      needsContext: false,
      decision: "replace",
      score: 60,
      penalty: 40,
      grade: "fair",
      summary: "需要修改：语义有偏差。\n修改结果：伪造的成品文本",
      revisedText: "侧腹依然插着小刀。要是照这样狠狠砸在地面上，这次肯定不可能平安无事。",
    }),
  });

  const lines = noteLines(status.results.find((item) => item.index === 2));
  const revisions = lines.filter((line) => line.startsWith("修改结果："));
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0], "修改结果：侧腹依然插着小刀。要是照这样狠狠砸在地面上，这次肯定不可能平安无事。");
  // 折叠后那句伪造文本落在「分析：」那一行里，解析层不会再把它当成品。
  assert.equal(lines.some((line) => line.startsWith("分析：") && line.includes("伪造的成品文本")), true);
  assert.match(lines.find((line) => line.startsWith(FORMAT_NOTE_PREFIX)), /说明字段里的换行 1 处/);
  assert.equal(status.formatNoteFields, 1);
});

test("端到端：目标列的 noteref 标记丢失时作废转人工，不留可写回的修改结果", async () => {
  const noteref = '<a class="nodeco" epub:type="noteref" href="n.xhtml#note1"><sup>㊟</sup></a>';
  const rows = regressionRows(2).map((row) => (
    row.index === 2 ? { ...row, jp: "彼はそう言った。", cn: `他这么说道。${noteref}` } : row
  ));
  const status = await runProofread({
    label: "format-noteref",
    rows,
    targetIndex: 2,
    answer: () => ({
      semanticSame: false,
      needsEdit: true,
      needsContext: false,
      decision: "replace",
      score: 70,
      penalty: 30,
      grade: "fair",
      summary: "需要修改：措辞调整。",
      revisedText: "他这样说道。",
    }),
  });

  const target = status.results.find((item) => item.index === 2);
  const lines = noteLines(target);
  assert.equal(target.status, "suggestion");
  assert.equal(target.done, false, "作废的行转人工确认，不算已处理完");
  assert.equal(lines.includes("是否需要修改：待人工确认"), true);
  assert.equal(lines.some((line) => line.startsWith("修改结果：")), false, "作废时不得留修改结果");
  assert.equal(lines.some((line) => /丢失了目标列的 EPUB noteref 注释标记/.test(line)), true);
  assert.equal(status.formatVoids, 1);
  assert.equal(status.formatFixes, 0);
});

test("端到端：开关关闭时这一层整体不生效（用于对比排查）", async () => {
  const status = await runProofread({
    label: "format-off",
    rows: regressionRows(2),
    targetIndex: 2,
    config: { formatGuard: false },
    answer: () => ({
      semanticSame: false,
      needsEdit: true,
      needsContext: false,
      decision: "replace",
      score: 60,
      penalty: 40,
      grade: "fair",
      summary: "需要修改：按原文分段修正。",
      revisedText: "侧腹依然插着小刀。\n要是照这样狠狠砸在地面上，这次肯定不可能平安无事。",
    }),
  });

  const target = status.results.find((item) => item.index === 2);
  assert.equal(status.formatEnabled, false);
  assert.equal(status.formatFixes, 0);
  assert.equal(status.formatVoids, 0);
  assert.equal(String(target.note).includes("修改结果：侧腹依然插着小刀。\n要是照这样"), true, "关掉后原样保留模型输出");
});
