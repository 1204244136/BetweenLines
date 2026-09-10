const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");

const { detectLanguage, validateSpeakerSelection } = require("../src/workbenches/speaker-attribution/speaker-selection");
const { prealignLineUnits } = require("../src/workbenches/speaker-attribution/prealign");
const { compareTexts } = require("../src/workbenches/speaker-attribution/text-comparison");
const {
  ATTENTION_VERSION,
  SPEAKER_PROMPT_VERSION,
  buildAttentionPlan,
  buildSpeakerAttention,
  buildSpeakerPrompt,
  extractCandidateNames,
} = require("../src/workbenches/speaker-attribution/attention");
const {
  HEADER_ANCHORED_ALIGNMENT_VERSION,
  prealignEpubHeaderBlocks,
  stableEpubHeader,
} = require("../src/workbenches/speaker-attribution/epub-header-alignment");
const { build, clientRowsFor, createRows, renderHtml } = require("../src/workbenches/speaker-attribution/build-workbench");

function tempText(name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "between-lines-speaker-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text, "utf8");
  return { dir, file };
}

async function tempEpub(name, documents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "between-lines-speaker-epub-"));
  const file = path.join(dir, name);
  const zip = new JSZip();
  const manifest = [
    '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>',
    ...documents.map((document, index) => `<item id="doc-${index}" href="${document.name}" media-type="application/xhtml+xml"/>`),
  ].join("");
  const spine = documents.map((document, index) => `<itemref idref="doc-${index}"/>`).join("");
  const nav = documents.map((document) => `<li><a href="${document.name}">${document.label}</a></li>`).join("");

  zip.file("META-INF/container.xml", '<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>');
  zip.file("OEBPS/content.opf", `<?xml version="1.0"?><package><manifest>${manifest}</manifest><spine>${spine}</spine></package>`);
  zip.file("OEBPS/nav.xhtml", `<!DOCTYPE html><html><body><nav epub:type="toc"><ol>${nav}</ol></nav></body></html>`);
  for (const document of documents) {
    zip.file(`OEBPS/${document.name}`, `<!DOCTYPE html><html><body><p>${document.text.replace(/\n\n/g, "</p><p>")}</p></body></html>`);
  }
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  return { dir, file };
}

test("speaker selection supports monolingual and bilingual inputs", () => {
  const source = tempText("source.txt", "source");
  const parallel = tempText("parallel.txt", "parallel");
  try {
    assert.equal(validateSpeakerSelection({ source: source.file }).mode, "monolingual");
    assert.equal(validateSpeakerSelection({ source: source.file }).sourceLang, "auto");
    const bilingual = validateSpeakerSelection({ source: source.file, parallel: parallel.file });
    assert.equal(bilingual.mode, "bilingual");
    assert.equal(bilingual.lineUnitVersion, "quoted-dialogue-v1");
    assert.equal(bilingual.alignmentVersion, "monotonic-evidence-v5");
    assert.equal(bilingual.parallelLang, "auto");
    assert.equal(validateSpeakerSelection({ source: source.file, sourceLang: "en" }).sourceLang, "en");
    assert.throws(() => validateSpeakerSelection({ source: source.file, parallel: source.file }), /不能使用同一个文件/);
  } finally {
    fs.rmSync(source.dir, { recursive: true, force: true });
    fs.rmSync(parallel.dir, { recursive: true, force: true });
  }
});

test("speaker language detection recognizes Japanese, Chinese, and Latin text", () => {
  assert.equal(detectLanguage("これは日本語の台詞です。"), "jp");
  assert.equal(detectLanguage("这是用于确认说话人的中文台词。"), "cn");
  assert.equal(detectLanguage("This is an English line."), "en");
});

test("speaker build resolves automatic languages from quoted dialogue inputs", async () => {
  const source = tempText("source.txt", "「これは原文の台詞です。次の文も同じ発話です。」\n\n地の文です。");
  const parallel = tempText("parallel.txt", "「这是原文对应的主文本。下一句仍属于同一发言。」\n\n这是旁白。");
  try {
    const selection = validateSpeakerSelection({ source: source.file, parallel: parallel.file });
    const model = await build(selection);
    assert.equal(model.selection.sourceLang, "jp");
    assert.equal(model.selection.parallelLang, "cn");
    assert.equal(model.rows.length, 1);
    assert.equal(model.rows[0].sourceText, "「これは原文の台詞です。次の文も同じ発話です。」");
    assert.equal(model.rows[0].parallelText, "「这是原文对应的主文本。下一句仍属于同一发言。」");
  } finally {
    fs.rmSync(source.dir, { recursive: true, force: true });
    fs.rmSync(parallel.dir, { recursive: true, force: true });
  }
});

test("speaker review rows exclude narration while retaining it in context", async () => {
  const source = tempText("source.txt", "他停下脚步。『第一句。第二句！』随后离开。");
  try {
    const model = await build(validateSpeakerSelection({ source: source.file }));

    assert.equal(model.rows.length, 1);
    assert.equal(model.rows[0].sourceText, "『第一句。第二句！』");
    assert.ok(model.rows[0].context.some((item) => item.text === "他停下脚步。"));
  } finally {
    fs.rmSync(source.dir, { recursive: true, force: true });
  }
});

test("bilingual speaker rows are pre-aligned without reusing parallel lines", () => {
  const result = prealignLineUnits([
    { id: "s1", text: "A long sentence." },
    { id: "s2", text: "Another sentence." },
  ], [
    { id: "p1", text: "A long sentence." },
    { id: "p2", text: "Another sentence." },
  ]);

  assert.equal(result.required, true);
  assert.equal(result.performed, true);
  assert.deepEqual(result.rows.slice(0, 2).map((row) => row.parallel[0]?.id), ["p1", "p2"]);
});

test("stable EPUB headers retain S5 and S6 identifiers while ignoring wrappers", () => {
  assert.equal(stableEpubHeader("OEBPS/S1_03-05_p-004.xhtml"), "S1_03-05");
  assert.equal(stableEpubHeader("OEBPS/S5_01_03-02_Chapter2.xhtml"), "S5_01_03-02");
  assert.equal(stableEpubHeader("OEBPS/S6_24.06.07-02_Afterwords.xhtml"), "S6_24.06.07-02");
  assert.equal(stableEpubHeader("OEBPS/S1_25-Uiharu_Kazari_Afterwords.xhtml"), "S1_25-UIHARU_KAZARI");
});

test("header anchors prevent front matter from consuming dialogue lines", () => {
  const result = prealignEpubHeaderBlocks([
    { header: "S1_01-01", spineIndex: 1, units: [{ id: "s1", text: "原文对话。" }] },
  ], [
    { header: "S1_01-COPYRIGHT", spineIndex: 0, units: [{ id: "p-front", text: "Copyright 2026" }] },
    { header: "S1_01-01", spineIndex: 1, units: [{ id: "p1", text: "译文对话。" }] },
  ]);
  const dialogue = result.rows.find((row) => row.source?.id === "s1");
  const frontMatter = result.rows.find((row) => row.parallel.some((item) => item.id === "p-front"));

  assert.equal(result.version, HEADER_ANCHORED_ALIGNMENT_VERSION);
  assert.equal(result.headerAnchors.strategy, "stable-xhtml-header");
  assert.equal(dialogue.parallel[0].id, "p1");
  assert.equal(frontMatter.source, null);
  assert.equal(frontMatter.alignment.status, "unmatched-parallel");
});

test("header-anchored alignment ignores global paragraph offsets inside a shared header", () => {
  const result = prealignEpubHeaderBlocks([
    { header: "H1", spineIndex: 1, units: [{ id: "s1", text: "甲", sourceIndex: 0, parentParagraphId: "jp:0" }] },
    { header: "H2", spineIndex: 2, units: [{ id: "s2", text: "乙", sourceIndex: 10, parentParagraphId: "jp:10" }] },
  ], [
    { header: "H1", spineIndex: 1, units: [{ id: "p1", text: "甲", sourceIndex: 0, parentParagraphId: "cn:0" }] },
    { header: "H2", spineIndex: 2, units: [{ id: "p2", text: "乙", sourceIndex: 30, parentParagraphId: "cn:30" }] },
  ]);

  const second = result.rows.find((row) => row.source?.id === "s2");
  assert.equal(second.parallel[0].id, "p2");
  assert.equal(second.alignment.relation, "1:1");
});

test("EPUB speaker build pairs matching body headers and excludes non-body pages", async () => {
  const source = await tempEpub("source.epub", [
    { name: "S1_01-COVER.xhtml", label: "封面", text: "封面" },
    { name: "S1_01-01Chapter2.xhtml", label: "第1章", text: "「原文第一句。」\n\n「原文第二句。」" },
    { name: "S1_01-COPYRIGHT.xhtml", label: "版权页", text: "Copyright 2026" },
    { name: "S1_01-AFTERWORDS.xhtml", label: "后记", text: "后记内容。" },
  ]);
  const parallel = await tempEpub("parallel.epub", [
    { name: "S1_01-COVER.xhtml", label: "封面", text: "封面" },
    { name: "S1_01-01_p-004.xhtml", label: "第1章", text: "「译文第一句。」\n\n「译文第二句。」" },
    { name: "S1_01-COPYRIGHT.xhtml", label: "版权页", text: "版权所有 2026" },
    { name: "S1_01-AFTERWORDS.xhtml", label: "后记", text: "后记内容。" },
  ]);
  try {
    const selection = validateSpeakerSelection({ source: source.file, parallel: parallel.file });
    const model = await build(selection);

    assert.equal(selection.alignmentVersion, HEADER_ANCHORED_ALIGNMENT_VERSION);
    assert.equal(model.alignment.version, HEADER_ANCHORED_ALIGNMENT_VERSION);
    assert.equal(model.alignment.headerAnchors.matched, 1);
    assert.equal(model.rows.length, 2);
    assert.ok(model.rows.every((row) => row.sourceText.includes("原文")));
    assert.ok(model.rows.every((row) => row.parallelText.includes("译文")));
    assert.ok(model.rows.every((row) => !/版权|Copyright|后记/.test(`${row.sourceText} ${row.parallelText}`)));
  } finally {
    fs.rmSync(source.dir, { recursive: true, force: true });
    fs.rmSync(parallel.dir, { recursive: true, force: true });
  }
});

test("cross-language fallback preserves extra parallel dialogue as an unmatched row", () => {
  const source = Array.from({ length: 4 }, (_, index) => ({
    id: `s${index + 1}`,
    lang: "jp",
    text: `日本語の台詞 ${index + 1}`,
  }));
  const parallel = Array.from({ length: 5 }, (_, index) => ({
    id: `p${index + 1}`,
    lang: "cn",
    text: `中文译文 ${index + 1}`,
  }));
  const result = prealignLineUnits(source, parallel, { threshold: 0.9 });
  const matchedIds = result.rows.flatMap((row) => row.parallel.map((item) => item.id));

  assert.equal(result.rows.length, 5);
  assert.equal(result.unmatchedSource, 0);
  assert.equal(result.unmatchedParallel, 1);
  assert.equal(result.lowConfidence, 4);
  assert.equal(new Set(matchedIds).size, parallel.length);
  assert.equal(result.rows.filter((row) => row.alignment.relation === "1:1").length, 4);
  assert.equal(result.rows.filter((row) => row.alignment.relation === "1:2").length, 0);
});

test("workbench rows exclude lines without source text during comparison", () => {
  const rows = createRows({
    rows: [{
      source: null,
      parallel: [{ id: "cn:1:0", text: "「哇……」" }],
      alignment: { status: "unmatched-parallel", relation: "0:1", score: 0 },
    }, {
      source: { id: "jp:1:0", text: "「誰だ？」" },
      parallel: [{ id: "cn:1:1", text: "「是谁？」" }],
      alignment: { status: "aligned", relation: "1:1", score: 0.9 },
    }],
  }, [], []);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceText, "「誰だ？」");
  assert.equal(rows[0].parallelText, "「是谁？」");
  assert.equal(rows[0].index, 1);
});

test("unmatched parallel dialogue retains its own context when explicitly included", () => {
  const rows = createRows({
    rows: [{
      source: null,
      parallel: [{
        id: "cn:4:0",
        parentParagraphId: "cn:4",
        startOffset: 5,
        endOffset: 11,
        text: "「是谁？」",
      }],
      alignment: { status: "unmatched-parallel", relation: "0:1", score: 0 },
    }],
  }, [], [{
    id: "cn:4:before",
    parentParagraphId: "cn:4",
    startOffset: 0,
    endOffset: 5,
    text: "张三问道：",
  }, {
    id: "cn:4:0",
    parentParagraphId: "cn:4",
    startOffset: 5,
    endOffset: 11,
    text: "「是谁？」",
  }], { includeMissingSource: true });

  assert.equal(rows[0].parallelText, "「是谁？」");
  assert.deepEqual(rows[0].context.map((item) => item.text), ["张三问道：", "「是谁？」"]);
  assert.equal(rows[0].context.at(-1).relation, "target");
});

test("pre-alignment does not merge distant parallel dialogue units", () => {
  const result = prealignLineUnits([
    { id: "s1", text: "「……我到底哪里招惹到你了？」", sourceIndex: 52, parentParagraphId: "jp:52" },
  ], [
    { id: "p1", text: "「哇……」", sourceIndex: 45, parentParagraphId: "cn:45" },
    { id: "p2", text: "「……我到底哪里招惹到你了？」", sourceIndex: 52, parentParagraphId: "cn:52" },
  ]);

  assert.equal(result.rows.some((row) => row.alignment.relation === "1:2"), false);
  const matchedIds = result.rows.flatMap((row) => row.parallel.map((item) => item.id));
  assert.deepEqual(new Set(matchedIds), new Set(["p1", "p2"]));
  assert.ok(result.rows.some((row) => row.alignment.relation === "0:1"));
});

test("pre-alignment leaves an extra distant dialogue unmatched instead of shifting later rows", () => {
  const result = prealignLineUnits([
    { id: "s1", text: "「……我到底做了什么？」", sourceIndex: 52, parentParagraphId: "jp:52" },
    { id: "s2", text: "「我无法容忍比我强的人类。」", sourceIndex: 53, parentParagraphId: "jp:53" },
  ], [
    { id: "p-extra", text: "「哇……」", sourceIndex: 45, parentParagraphId: "cn:45" },
    { id: "p1", text: "「……我到底哪里招惹到你了？」", sourceIndex: 52, parentParagraphId: "cn:52" },
    { id: "p2", text: "「我不能容许这世界上有比我还强的『人类』。」", sourceIndex: 53, parentParagraphId: "cn:53" },
  ]);

  assert.equal(result.rows.some((row) => row.alignment.relation === "1:2"), false);
  const extra = result.rows.find((row) => row.parallel.some((item) => item.id === "p-extra"));
  assert.equal(extra?.alignment.relation, "0:1");
  assert.deepEqual(result.rows.filter((row) => row.source).slice(-2).map((row) => row.parallel.map((item) => item.id)), [["p1"], ["p2"]]);
});

test("pre-alignment only merges split units when explicitly enabled", () => {
  const result = prealignLineUnits([
    { id: "s1", text: "「第一段对应两句。」", sourceIndex: 7, parentParagraphId: "jp:7" },
  ], [
    { id: "p1", text: "「第一句。」", sourceIndex: 7, parentParagraphId: "cn:7" },
    { id: "p2", text: "「第二句。」", sourceIndex: 7, parentParagraphId: "cn:7" },
  ], { allowMergedParallel: true });

  assert.equal(result.rows[0].alignment.relation, "1:2");
});

test("pre-alignment preserves unmatched line directions for empty counterparts", () => {
  const sourceOnly = prealignLineUnits([{ id: "s1", text: "原文行。" }], []);
  const parallelOnly = prealignLineUnits([], [{ id: "p1", text: "主文本行。" }]);

  assert.equal(sourceOnly.rows[0].alignment.status, "unmatched-source");
  assert.equal(sourceOnly.rows[0].alignment.relation, "1:0");
  assert.equal(parallelOnly.rows[0].alignment.status, "unmatched-parallel");
  assert.equal(parallelOnly.rows[0].alignment.relation, "0:1");
});

test("text comparison exposes signals without treating them as semantic proof", () => {
  const comparison = compareTexts("第12章「Alice？」", "第13章「Alice！」");

  assert.equal(comparison.numberScore, 0);
  assert.ok(comparison.sharedTokens.includes("alice"));
  assert.ok(comparison.issues.includes("数字不同"));
  assert.equal(typeof comparison.score, "number");
});

test("speaker attention prioritizes attribution cues and compresses context", () => {
  const row = {
    id: "line-1",
    index: 1,
    sourceText: "「你好。」",
    parallelText: "「你好。」",
    context: [
      { id: "before", text: "张三说：「你好。」", relation: "context" },
      { id: "target", text: "「你好。」", relation: "target" },
      { id: "after", text: "他转身离开。", relation: "context-after" },
    ],
    alignment: { score: 0.8, relation: "1:1" },
  };
  const attention = buildSpeakerAttention(row, { maxItems: 2 });
  assert.equal(attention.version, ATTENTION_VERSION);
  assert.equal(attention.focus.length, 2);
  assert.equal(attention.focus[0].id, "target");
  assert.equal(attention.candidates[0].name, "张三");
  assert.ok(attention.budget.selectedItems < attention.budget.inputItems);
  assert.deepEqual(extractCandidateNames("Alice said: \"Hello\""), ["Alice"]);
  assert.deepEqual(extractCandidateNames("上条当麻は『無理』と言った。"), ["上条当麻"]);
  const quotedContext = buildSpeakerAttention({ context: [{ id: "q", text: "『上条当麻』", relation: "context", isQuotedDialogue: true }, { id: "target", text: "「你好」", relation: "target" }] });
  assert.deepEqual(quotedContext.candidates, []);
});

test("speaker attention does not treat the first context item as the target when target is omitted", () => {
  const attention = buildSpeakerAttention({
    id: "line-3",
    sourceText: "「目标」",
    context: [{ id: "before", text: "Alice said: hello", relation: "context" }],
  });

  assert.equal(attention.focus[0].id, "line-3");
  assert.equal(attention.focus[0].relation, "target");
  assert.equal(attention.focus[1].id, "before");
});

test("speaker prompt combines focused evidence with a strict JSON contract", () => {
  const prompt = buildSpeakerPrompt({
    id: "line-2",
    index: 2,
    sourceText: "『谁在这里？』",
    parallelText: "『誰がここに？』",
    context: [{ id: "target", text: "『谁在这里？』", relation: "target" }],
    alignment: { score: 0.4, relation: "1:1" },
  });
  assert.equal(prompt.version, SPEAKER_PROMPT_VERSION);
  assert.match(prompt.system, /不得拆分/);
  const user = JSON.parse(prompt.user);
  assert.equal(user.task, "speaker-attribution");
  assert.equal(user.target.index, 2);
  assert.equal(user.outputSchema.status, "confirmed | unknown | multiple | needs-review");
  assert.equal(prompt.messages.length, 2);
});

test("speaker attention plan orders high-signal rows before deferred rows", () => {
  const plan = buildAttentionPlan([
    { index: 1, attention: { level: "low", score: 0.2, needsMoreContext: true }, prompt: { user: "low" } },
    { index: 2, attention: { level: "high", score: 0.8, needsMoreContext: false }, prompt: { user: "high" } },
    { index: 3, attention: { level: "medium", score: 0.5, needsMoreContext: false }, prompt: { user: "medium" } },
  ]);
  assert.deepEqual(plan.queue, [2, 3, 1]);
  assert.deepEqual(plan.counts, { high: 1, medium: 1, low: 1, needsMoreContext: 1 });
  assert.equal(plan.strategy, "evidence-priority-v1");
});

test("speaker workbench renders a paged review workspace", () => {
  const html = renderHtml({
    analysisKey: "test",
    sourceLineCount: 1,
    parallelLineCount: 0,
    generatedAt: "2026-01-01T00:00:00.000Z",
    selection: { mode: "monolingual", files: { source: "source.txt" } },
    alignment: { version: "none", unmatchedSource: 0, unmatchedParallel: 0, lowConfidence: 0 },
    rows: [{
      id: "line-1",
      source: { text: "谁在说话？" },
      parallel: [],
      context: [],
      alignment: { status: "source-only", relation: "1:0", score: 1 },
      speaker: "",
      confidence: "",
      status: "needs-review",
      evidence: "",
    }],
  });

  const rows = clientRowsFor({ rows: [{ id: "line-1", source: { text: "谁在说话？" }, parallel: [], alignment: {} }] });
  const scripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];

  assert.match(html, /说话人归属工作台/);
  assert.match(html, /speakerPagination/);
  assert.match(html, /data-field="speaker"/);
  assert.match(html, /谁在说话/);
  assert.match(html, /<tbody><\/tbody>/);
  assert.equal(rows[0].sourceText, "谁在说话？");
  assert.doesNotThrow(() => new Function(scripts.at(-1)[1]));
});
