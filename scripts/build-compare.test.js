const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { createProjectContext } = require("./project-context");
const { createNotesTools } = require("../src/workbenches/translation-compare/notes-spaces");

const {
  alignLegacyNotes,
  alignNotesByIndex,
  exportRows,
  makeHtml,
  rebuildCompareHtmlFromSnapshot,
  restorableModelOptions,
  resolveModelOptions,
  rowFieldsFor,
  toCsv,
  workbenchClientRows,
} = require("./build-compare");

test("model refresh replaces models from the previous API base URL", () => {
  const result = resolveModelOptions([
    { id: "new-model-1" },
    { id: "new-model-2" },
  ], "old-model");

  assert.deepEqual(result.models, ["new-model-1", "new-model-2"]);
  assert.deepEqual(result.options, ["new-model-1", "new-model-2", "custom"]);
  assert.equal(result.selected, "new-model-1");
});

test("model refresh preserves the selection only when the new API still provides it", () => {
  const result = resolveModelOptions([
    "shared-model",
    "new-model",
    "shared-model",
  ], "shared-model");

  assert.deepEqual(result.models, ["shared-model", "new-model"]);
  assert.equal(result.selected, "shared-model");
});

test("model option cache is restored only for the API base URL that produced it", () => {
  const cached = {
    baseUrl: "https://new.example/v1/",
    modelOptionsBaseUrl: "https://new.example/v1",
    modelOptions: ["new-model"],
  };

  assert.deepEqual(restorableModelOptions(cached), ["new-model"]);
  assert.deepEqual(restorableModelOptions({ ...cached, baseUrl: "https://other.example/v1" }), []);
  assert.deepEqual(restorableModelOptions({ ...cached, modelOptionsBaseUrl: undefined }), []);
});

test("bilingual workbench fixes AI target to B and omits C", () => {
  const rows = [{
    index: 1,
    chapter: "正文",
    relation: "原文-译文 1:1",
    score: 0.8,
    jpAlignScore: 0.8,
    jp: "source",
    cn: "target",
    tw: "",
    twCn: "",
    jpChars: 6,
    cnChars: 6,
    twChars: 0,
    refinedScore: null,
  }];
  const selection = {
    comparisonMode: "bilingual",
    files: { jp: "A.txt", cn: "B.txt", tw: "" },
    labels: { jp: "A 原文", cn: "B 译文", tw: "C 版本" },
  };
  const projectContext = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  };

  const html = makeHtml(rows, selection, projectContext, "<pgr:powergrep/>");
  assert.match(html, /双语翻译对比校对工作台/);
  assert.match(html, /id="aiTarget" disabled/);
  assert.match(html, /<option value="cn">B 译文<\/option>/);
  assert.doesNotMatch(html, /<option value="tw">/);
  // 双语页面不携带第三列的任何痕迹：行数据与页面标签里都不该出现 tw 字段。
  const embeddedRows = JSON.parse(html.split('<script id="rowData" type="application/json">')[1].split("</script>")[0]);
  assert.deepEqual(Object.keys(embeddedRows[0]), [
    "index", "chapter", "relation", "jp", "jpAlignScore", "cn", "score", "cnChars", "jpChars", "signature", "cls", "scoreText", "jpAlignScoreText",
  ]);
  assert.match(html, /"pageLabels":\{"jp":"A 原文","cn":"B 译文"\}/);
  assert.doesNotMatch(embeddedRows[0].signature, /undefined/);
  assert.match(html, /目标固定为译文 B，参考原文 A/);
  assert.match(html, /\.ai-config-band\s*\{[^}]*grid-template-columns: 88px minmax\(0, 1fr\);/);
  assert.match(html, /id="aiServiceLabel" class="ai-config-label">AI 服务/);
  assert.match(html, /<option value="claude">Claude<\/option>/);
  assert.match(html, /id="aiProofreadLabel" class="ai-config-label">校对设置/);
  // 熔断阈值可在「校对设置」里手动调整，并支持整体停用
  assert.match(html, /id="aiBreakerThreshold" type="text" inputmode="decimal" value="50%"/);
  assert.match(html, /<input id="aiBreakerDisabled" type="checkbox">关闭/);
  assert.match(html, /class="ai-runbar"/);
  assert.doesNotMatch(html, /id="aiProofreadModeHint"/);
  assert.match(html, /translation-compare-ai-prompt-v1:/);
  assert.match(html, /pageMeta\.projectKey \|\| "unscoped"/);
  assert.match(html, /data-issue-severity="poor"/);
  assert.match(html, /质量评分|评分分级|质量分级/);
  assert.match(html, /issueSeverityFilter/);
  assert.match(html, /id="aiReasoningField" class="ai-field">/);
  assert.match(html, /<option value="" selected>模型默认<\/option>/);

  // 预筛选独立成模块：阈值迁出 AI 面板，筛选栏与操作栏按功能分离
  assert.match(html, /id="prefilterPanel"/);
  assert.match(html, /id="prefilterSimilarity"/);
  assert.match(html, /id="prefilterStart"/);
  assert.match(html, /id="prefilterConfirm"[^>]*disabled/);
  assert.match(html, /id="prefilterResultFilter"[^>]*disabled>预筛结果/);
  assert.doesNotMatch(html, /id="aiSimilarity"/);
  assert.match(html, /class="filter-bar"/);
  assert.match(html, /class="action-bar"/);
  assert.match(html, /class="segmented__btn/);
  assert.doesNotMatch(html, /class="filter-panel"/);
  assert.doesNotMatch(html, /class="toolbar-actions"/);

  const script = html.split("<script>")[1].split("</script>")[0];
  const globalConfigWriter = script.match(/function saveAiConfig\(\)[\s\S]*?function saveAiPrompt/)[0];
  assert.doesNotMatch(globalConfigWriter, /systemPrompt: aiIds\.prompt\.value/);
  assert.match(script, /localStorage\.setItem\(aiPromptStorageKey/);
  assert.match(script, /\/api\/prefilter\/start/);
  assert.match(script, /\/api\/prefilter\/stop/);
  assert.match(script, /similarityThreshold: parsePercentRatio\(prefilterIds\.similarity\.value\)/);
  assert.match(script, /const prefilterIds = \{/);
  assert.match(script, /const prefilterResultIds = new Set\(\)/);
  assert.match(script, /let prefilterResultsCatchingUp = false/);
  assert.match(script, /result\.status === "rule-prefilter" \|\| result\.status === "similarity-prefilter"/);
  assert.match(script, /const matchesPrefilterResult = !prefilterResultFilterActive \|\| prefilterResultIds\.has\(id\)/);
  assert.match(script, /prefilterResultFilter\.classList\.add\("is-active"\)/);
  assert.match(script, /prefilterIds\.confirm\.disabled = !prefilterResultFilterActive \|\| prefilterResultsCatchingUp/);
  assert.match(script, /当前预筛结果共 [\s\S]*?规则通过 [\s\S]*?相似度通过/);
  assert.match(script, /prefilterIds\.confirm\.addEventListener\("click"[\s\S]*?current\.manualDone = true;[\s\S]*?applyFilters\(\{ reset: false \}\)/);
  assert.doesNotMatch(script, /aiIds\.similarity/);
  assert.match(script, /afterRevision/);
  assert.match(script, /knownRequestId/);
  assert.match(script, /aiRequestCache/);
  assert.match(script, /aiStatusRefreshInFlight/);
  assert.match(script, /pendingResults\.length[\s\S]*?saveNotes\(\)[\s\S]*?updateDoneCount\(\)/);
  assert.match(script, /function writeNote\([^)]*\{ deferCommit = false \}/);
  assert.match(script, /function revisionTextFor\(item\)/);
  assert.match(script, /current\.revisionText = revisionEditor\.value/);
  assert.match(script, /const targetKey = revisionTargetFor\(item\)/);
  assert.match(script, /data-revision=/);
  assert.match(script, /writeNote\(String\(result\.index\), result\.note \|\| "", Boolean\(result\.done\), \{ deferCommit: true \}, result\.targetKey \|\| ""\)/);
  assert.match(script, /resultLimit: "64"/);
  assert.match(script, /requestIdleCallback\(commit, \{ timeout: 2000 \}\)/);
  assert.match(script, /window\.addEventListener\("pagehide", flushNotes\)/);
  assert.match(script, /markEntriesConfirmed\(pending\.map\(\(entry\) => entry\.id\)\);[\s\S]*?applyFilters\(\{ reset: false \}\);[\s\S]*?tableFrame\.scrollTop = 0;/);
  assert.match(script, /function visibleRevisionWriteButtons\(\)[\s\S]*?getClientRects\(\)\.length > 0/);
  assert.match(script, /function focusRevisionTarget\(target\)[\s\S]*?Math\.floor\(target\.filteredIndex \/ size\) \+ 1[\s\S]*?renderVisibleRows\(\)/);
  assert.match(script, /function focusAdjacentRevision\(direction, currentButton = null\)[\s\S]*?targets\[targetIndex \+ direction\]/);
  assert.doesNotMatch(script, /data-export-revision/);
  assert.doesNotMatch(script, /buildPgaContent/);
  assert.match(script, /input:not\(\[type="checkbox"\]\), textarea, select/);
  assert.match(script, /event\.key === "ArrowDown" \? 1 : -1/);
  assert.match(script, /preferredTop = Math\.max\(headerHeight \+ 16, Math\.round\(tableFrame\.clientHeight \* 0\.18\)\)/);
  assert.match(script, /keyboardScrollSpacer\.style\.height = Math\.max\(0, tableFrame\.clientHeight - preferredTop\) \+ "px"/);
  assert.match(script, /tableFrame\.scrollTop = Math\.max\(0, Math\.min\(rowTop - preferredTop, maxScrollTop\)\)/);
  assert.doesNotMatch(script, /scrollIntoView/);
  assert.match(script, /reasoningEffort: aiIds\.reasoningEffort\.value/);
  assert.match(script, /function updateInferenceSettingOptions\(\)/);
  assert.match(script, /const nonGptIntensityOptions = /);
  assert.match(script, /gptReasoningEffort: savedGptReasoningEffort/);
  assert.match(script, /nonGptIntensity: savedNonGptIntensity/);
  assert.match(script, /inferenceSettingVersion: 3/);
  assert.doesNotMatch(html, /backdrop-filter/);
  assert.doesNotThrow(() => new Function(script));
});

test("trilingual workbench lets AI target either B or C", () => {
  const rows = [{
    index: 1,
    chapter: "正文",
    relation: "B-C 1:1 / A-B 1:1",
    score: 0.8,
    jpAlignScore: 0.8,
    jp: "source",
    cn: "version b",
    tw: "version c",
    twCn: "version c",
    jpChars: 6,
    cnChars: 9,
    twChars: 9,
  }];
  const selection = {
    comparisonMode: "trilingual",
    files: { jp: "A.txt", cn: "B.txt", tw: "C.txt" },
    labels: { jp: "A 原文", cn: "B 版本", tw: "C 版本" },
  };
  const projectContext = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  };

  const html = makeHtml(rows, selection, projectContext, "<pgr:powergrep/>");
  assert.match(html, /三语翻译对比校对工作台/);
  assert.match(html, /<option value="cn">B 版本<\/option>/);
  assert.match(html, /<option value="tw">C 版本<\/option>/);
  assert.match(html, /目标可选非原文 B 或 C/);
  assert.match(html, /AI 翻译质量评分分级/);

  const script = html.split("<script>")[1].split("</script>")[0];
  assert.doesNotThrow(() => new Function(script));
});

test("bilingual CSV contains only source A and target B text columns", () => {
  const csv = toCsv([{ index: 1, jp: "source", cn: "target", tw: "unused" }], "bilingual");
  const [header] = csv.split("\n");
  assert.equal(header, "index,chapter,relation,score,jpAlignScore,jp,cn");
});

test("row artifacts keep only the fields the mode actually has", () => {
  const row = {
    index: 1,
    chapter: "正文",
    relation: "原文-译文 1:1",
    jp: "source",
    jpAlignScore: 0.8,
    cn: "target",
    tw: "",
    twCn: "",
    score: 0.8,
    refinedScore: null,
    cnChars: 6,
    twChars: 0,
    jpChars: 6,
  };

  assert.deepEqual(rowFieldsFor("bilingual").filter((field) => field.startsWith("tw")), []);
  assert.deepEqual(Object.keys(exportRows([row], "bilingual")[0]), [
    "index", "chapter", "relation", "jp", "jpAlignScore", "cn", "score", "cnChars", "jpChars", "signature",
  ]);

  // 三语模式保持完整：第三列文本、繁简对照和细分分数都在。
  const trilingualRow = { ...row, tw: "reference", twCn: "reference", twChars: 9, refinedScore: 0.4 };
  assert.deepEqual(exportRows([trilingualRow], "trilingual").map((item) => item.tw), ["reference"]);
  assert.equal(exportRows([trilingualRow], "trilingual")[0].refinedScore, 0.4);
  assert.deepEqual(
    Object.keys(workbenchClientRows([trilingualRow], "trilingual")[0]),
    [...rowFieldsFor("trilingual"), "signature", "cls", "scoreText", "jpAlignScoreText"],
  );
});

test("legacy notes remap by row signature without depending on row numbering", () => {
  const rows = [
    { index: 1, cn: "第一段译文内容aaaaaaaaaaaa", signature: "sig-a" },
    { index: 2, cn: "第二段译文内容bbbbbbbbbbbb", signature: "sig-b" },
  ];
  const result = alignLegacyNotes([
    { from: 900, signature: "sig-b", text: "" },
    { from: 901, signature: "sig-missing", text: "" },
  ], rows);
  assert.equal(result.method, "signature");
  assert.deepEqual(result.pairs, [{ from: 900, to: 2 }]);
  assert.equal(result.unmatched, 1);
});

test("legacy notes combine exact row signatures with safe text-anchor recovery", () => {
  const rows = Array.from({ length: 7 }, (_, offset) => ({
    index: offset + 11,
    cn: `第${offset + 1}段译文内容占位文本长度足够`,
    signature: `row-${offset + 11}`,
  }));
  const result = alignLegacyNotes([
    { from: 50, signature: "row-11", text: "" },
    { from: 52, signature: "", text: "第3段译文内容占位文本长度足够" },
    { from: 54, signature: "", text: "第5段译文内容占位文本长度足够" },
    { from: 56, signature: "", text: "第7段译文内容占位文本长度足够" },
    { from: 53, signature: "", text: "" },
  ], rows);
  assert.equal(result.method, "mixed");
  assert.deepEqual(result.pairs.map((pair) => `${pair.from}->${pair.to}`).sort(), ["50->11", "52->13", "53->14", "54->15", "56->17"]);
});

test("notes backup round-trips one space and imports conflicts as copies", () => {
  const tools = createNotesTools(alignLegacyNotes);
  const values = new Map([["translation-compare-notes-v7:project:rows", JSON.stringify({ "1": { note: "备注" } })]]);
  const storage = {
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, value); },
  };
  const spaces = tools.inventory(storage, "translation-compare-notes-v7:current:rows", {});
  const decoded = tools.decodeBackup(tools.backup(spaces.filter((space) => !space.current)));
  const imported = tools.importBackup(storage, decoded, "translation-compare-notes-v7:current:rows", 123);
  assert.equal(imported.imported.length, 0);
  assert.equal(imported.skipped, 1);
  decoded[0].raw = JSON.stringify({ "1": { note: "另一份" } });
  const conflict = tools.importBackup(storage, decoded, "translation-compare-notes-v7:current:rows", 123);
  assert.deepEqual(conflict.imported, ["translation-compare-notes-v7:project:rows:import-123"]);
  assert.equal(JSON.parse(values.get("translation-compare-notes-v7:project:rows"))["1"].note, "备注");
});

test("notes inventory excludes migration markers and measures UTF-16 storage", () => {
  const tools = createNotesTools(alignLegacyNotes);
  const values = new Map([
    ["translation-compare-notes-v7:p:r", JSON.stringify({ "1": { note: "中文", manualDone: true } })],
    ["translation-compare-notes-v7:p:r:previous-notes-migration-v2", "{}"],
  ]);
  const storage = {
    get length() { return values.size; }, key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.has(key) ? values.get(key) : null; }, setItem() {},
  };
  const inventory = tools.inventory(storage, "translation-compare-notes-v7:q:s", {});
  assert.equal(inventory.length, 2); // current virtual space + one stored space
  assert.equal(inventory[1].confirmed, 1);
  assert.equal(inventory[1].bytes, 2 * (inventory[1].key.length + values.get(inventory[1].key).length));
});

test("legacy notes shift as a block when revision anchors agree on one offset", () => {
  const rows = Array.from({ length: 20 }, (_, offset) => ({
    index: offset + 11,
    cn: `第${offset + 1}段译文内容占位文本长度足够`,
    signature: `row-${offset + 11}`,
  }));
  const result = alignLegacyNotes([
    { from: 13, signature: "", text: "第2段译文内容占位文本长度足够" },
    { from: 15, signature: "", text: "第4段译文内容占位文本长度足够" },
    { from: 17, signature: "", text: "第6段译文内容占位文本长度足够" },
    { from: 14, signature: "", text: "" },
  ], rows);
  assert.equal(result.method, "anchors");
  assert.equal(result.anchors, 3);
  assert.deepEqual(result.pairs.map((pair) => `${pair.from}->${pair.to}`).sort(), ["13->12", "14->13", "15->14", "17->16"]);
});

test("too few revision anchors does not prove the notes belong to this row set", () => {
  const rows = [
    { index: 1, cn: "锚点甲aaaaaaaaaaaaaaaa", signature: "sig-1" },
    { index: 2, cn: "锚点乙aaaaaaaaaaaaaaaa", signature: "sig-2" },
  ];
  const result = alignLegacyNotes([
    { from: 3, signature: "", text: "锚点甲aaaaaaaaaaaaaaaa" },
    { from: 4, signature: "", text: "锚点乙aaaaaaaaaaaaaaaa" },
  ], rows);
  assert.deepEqual(result.pairs, []);
  assert.equal(result.anchors, 2);
});

test("legacy notes between conflicting anchors are dropped instead of guessed", () => {
  const rows = [
    { index: 1, cn: "锚点甲aaaaaaaaaaaaaaaa", signature: "sig-1" },
    { index: 2, cn: "锚点乙aaaaaaaaaaaaaaaa", signature: "sig-2" },
    { index: 3, cn: "锚点丙aaaaaaaaaaaaaaaa", signature: "sig-3" },
  ];
  const result = alignLegacyNotes([
    { from: 3, signature: "", text: "锚点甲aaaaaaaaaaaaaaaa" },
    { from: 4, signature: "", text: "锚点乙aaaaaaaaaaaaaaaa" },
    { from: 10, signature: "", text: "锚点丙aaaaaaaaaaaaaaaa" },
    { from: 6, signature: "", text: "" },
  ], rows);
  assert.deepEqual(result.pairs, [{ from: 3, to: 1 }, { from: 4, to: 2 }, { from: 10, to: 3 }]);
  assert.equal(result.unmatched, 1);
});

test("legacy notes from another work match nothing", () => {
  const result = alignLegacyNotes([
    { from: 1, signature: "", text: "完全不属于本书的译文内容abcdefg" },
    { from: 2, signature: "", text: "" },
  ], [{ index: 1, cn: "本书第一段译文内容hijklmn", signature: "sig-1" }]);
  assert.equal(result.pairs.length, 0);
});

test("applying a new layout keeps the browser notes space and ships the recovery helper", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-relayout-"));
  try {
    const selection = {
      comparisonMode: "bilingual",
      inputMode: "txt",
      files: { jp: "A.txt", cn: "B.txt", tw: "" },
      labels: { jp: "A 原文", cn: "B 译文", tw: "C 版本" },
    };
    const rows = [{ index: 1, relation: "原文-译文 1:1", jp: "本文", cn: "译文", score: 0.5 }];
    const projectContext = createProjectContext(selection, rows);
    fs.writeFileSync(path.join(dir, "translation-compare.json"), JSON.stringify({
      project: projectContext,
      rowsSignature: projectContext.rowsSignature,
      rows,
    }), "utf8");

    const rebuilt = rebuildCompareHtmlFromSnapshot(dir);
    const html = fs.readFileSync(rebuilt.htmlFile, "utf8");
    assert.equal(rebuilt.notesKey, projectContext.notesStorage.key);
    assert.equal(html.includes(`const storageKey = "${projectContext.notesStorage.key}";`), true);
    assert.equal(html.includes("function alignLegacyNotes(entries, rows)"), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("index import only moves rows that still exist and never overwrites this page", () => {
  const rows = Array.from({ length: 5 }, (_, offset) => ({ index: offset + 1, cn: "行" + (offset + 1) }));
  const plan = alignNotesByIndex(["1", "2", "3", "9"], rows, ["2"]);
  assert.deepEqual(plan.pairs, [{ from: 1, to: 1 }, { from: 3, to: 3 }]);
  assert.equal(plan.missing, 1);
  assert.equal(plan.occupied, 1);
});

test("workbench ships the notes space panel with export, import and index restore", () => {
  const rows = [{ index: 1, relation: "原文-译文 1:1", jp: "本文", cn: "译文", score: 0.5 }];
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: { jp: "A.txt", cn: "B.txt", tw: "" },
    labels: { jp: "A 原文", cn: "B 译文", tw: "C 版本" },
  };
  const html = makeHtml(rows, selection, {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  }, "");
  assert.match(html, /id="notesPanel"/);
  assert.match(html, /id="notesSpaceList"/);
  assert.match(html, /id="exportAllNotes"/);
  assert.match(html, /id="importNotesFile"[^>]*type="file"/);
  assert.equal(html.includes("function alignNotesByIndex(entryIds, rows, occupiedIds)"), true);
});
