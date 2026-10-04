const fs = require("fs");
const path = require("path");
const { loadParagraphs } = require("../../ingest/text-utils");
const { resolveBuildOutputDir } = require("../../core/storage-layout");
const { resolveInputSelection, activeLangs } = require("../../ingest/input-selection");
const { buildSpeechHabitLayer } = require("./speech-habit-layer");
const { TERM_LAYER_VERSION, buildTermLayer, describeTermLayerEntry } = require("./term-layer");
const { createProjectContext } = require("../../core/project-context");
const { publishProject } = require("../../storage/project-store");
const { reportProgress } = require("../../core/progress");
const { createPresetTools } = require("./ai-presets");
const { resolveModelOptions, restorableModelOptions } = require("./model-options");
const { alignLegacyNotes, alignNotesByIndex } = require("./notes-recovery");
const { assertSingleJpParagraphGroups } = require("./alignment-artifact");
const { alignRows } = require("./row-alignment");
const { rowFieldsFor, exportRows, workbenchClientRows, toCsv } = require("./row-output");
const { makeHtml, readWorkbenchAssets } = require("./render-workbench");

async function main() {
  const outputDir = resolveBuildOutputDir();
  fs.mkdirSync(outputDir, { recursive: true });

  reportProgress(5, "读取段落与对齐结果");
  const selection = await resolveInputSelection({ allowPrompt: false });
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const paragraphs = await loadParagraphs(selection);
  reportProgress(28, comparisonMode === "bilingual" ? "整理原文与译文段落" : "合并非原文对齐组");
  const rows = alignRows(paragraphs.cn, paragraphs.tw || [], paragraphs.jp, comparisonMode);
  reportProgress(58, "整理比较行", rows.length, rows.length);
  const scopedSelection = { ...selection, comparisonMode };
  const projectContext = createProjectContext(scopedSelection, rows);
  const counts = Object.fromEntries(activeLangs(comparisonMode).map((lang) => [lang, paragraphs[lang].length]));

  reportProgress(64, "计算说话习惯层");
  const speechHabits = buildSpeechHabitLayer({
    rows: exportRows(rows, comparisonMode),
    projectFiles: scopedSelection.files || {},
    envTables: String(process.env.TRANSCOMPARATOR_SPEECH_TABLES || "").split(/[;\n]/),
  });
  for (const [profileId, entry] of Object.entries(speechHabits.byProfile || {})) {
    console.log(`说话习惯（构建期）${profileId}：${entry.summary.chapters} 章 / ${entry.summary.activatedChapters} 章命中 ${entry.summary.activatedCharacters.length} 个角色 / ${entry.summary.missRows} 行疑似流失`);
  }
  for (const error of speechHabits.errors) console.warn(`说话习惯表告警：${error}`);

  // 对照表判定与模型无关：构建期算一次，页面在跑任务前就能看到哪些行会被对照表处理。
  reportProgress(67, "计算对照表层");
  const termPrefilter = buildTermLayer({
    rows: exportRows(rows, comparisonMode),
    envTables: String(process.env.TRANSCOMPARATOR_TERM_TABLES || "").split(/[;\n]/),
    comparisonMode,
  });
  for (const [profileId, entry] of Object.entries(termPrefilter.byProfile || {})) {
    console.log(`对照表（构建期）${profileId}：${describeTermLayerEntry(entry)}`);
  }
  for (const error of termPrefilter.errors) console.warn(`对照表告警：${error}`);

  reportProgress(70, "渲染工作台页面");
  const html = makeHtml(rows, scopedSelection, projectContext, speechHabits, termPrefilter);
  fs.writeFileSync(path.join(outputDir, "translation-compare.html"), html, "utf8");
  reportProgress(86, "写入导出文件");
  fs.writeFileSync(path.join(outputDir, "translation-compare.csv"), toCsv(rows, comparisonMode), "utf8");
  fs.writeFileSync(path.join(outputDir, "translation-compare.json"), JSON.stringify({
    project: projectContext,
    files: selection.files,
    labels: selection.labels,
    counts,
    rowsSignature: projectContext.rowsSignature,
    // 说话习惯层写在行数据之外（顶层块），不改变任何行字段与 signature。
    speechHabits,
    // 对照表判定同理：只存行号结论（命中/一致/冲突），结果与备注仍由运行期生成。
    termPrefilter,
    rows: exportRows(rows, comparisonMode),
  }, null, 2), "utf8");
  reportProgress(100, "比较工作台构建完成", rows.length, rows.length);

  const published = process.env.TRANSCOMPARATOR_OUTPUT_DIR
    ? null
    : publishProject(outputDir);

  // 只报告该模式实际参与的列：双语模式不会出现 "TW paragraphs: 0"。
  for (const [lang, count] of Object.entries(counts)) {
    console.log(`${lang.toUpperCase()} paragraphs: ${count}`);
  }
  console.log(`Comparison mode: ${comparisonMode === "bilingual" ? "双语（原文 A + 译文 B）" : "三语（原文 A + 非原文 B/C）"}`);
  console.log(`Rows: ${rows.length}`);
  if (published) {
    console.log(`Published project: ${published.id} (${published.outputUrl})`);
  } else {
    console.log(`HTML: ${path.join(outputDir, "translation-compare.html")}`);
    console.log(`CSV: ${path.join(outputDir, "translation-compare.csv")}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function snapshotComparisonMode(compareData) {
  const declared = compareData.project?.comparisonMode || compareData.comparisonMode;
  if (declared === "bilingual" || declared === "trilingual") return declared;
  // 旧快照没有声明模式时按数据推断：只有存在非空的第三列才算三语。
  return compareData.counts?.tw || compareData.files?.tw ? "trilingual" : "bilingual";
}

function pickComparisonMode(...candidates) {
  for (const candidate of candidates) {
    if (candidate === "bilingual" || candidate === "trilingual") return candidate;
  }
  return "trilingual";
}

function rebuildCompareHtmlFromSnapshot(snapshotDir, options = {}) {
  const dir = path.resolve(snapshotDir);
  const jsonFile = path.join(dir, "translation-compare.json");
  if (!fs.existsSync(jsonFile)) {
    throw new Error(`快照目录缺少 translation-compare.json：${dir}`);
  }
  const compareData = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  const selectionFile = path.join(dir, "input-selection.json");
  let selection;
  if (fs.existsSync(selectionFile)) {
    selection = JSON.parse(fs.readFileSync(selectionFile, "utf8"));
  } else {
    selection = {
      comparisonMode: snapshotComparisonMode(compareData),
      files: compareData.files || {},
      labels: compareData.labels || {},
      glossaryFile: compareData.project?.glossaryFile || "",
    };
  }
  const comparisonMode = pickComparisonMode(
    selection.comparisonMode,
    compareData.project?.comparisonMode,
    snapshotComparisonMode(compareData),
  );
  const projectContext = compareData.project
    || createProjectContext({ ...selection, comparisonMode }, compareData.rows || []);
  // 对照表层有版本语义：展示口径或命中口径升级后，旧快照里的术语对不能继续原样复用。
  // 这里按当前档案里的表重新计算一次；算不出任何表时保留旧块，避免把页面退化成“无对照表”。
  let termPrefilter = compareData.termPrefilter || null;
  if ((termPrefilter?.version || 0) !== TERM_LAYER_VERSION && Array.isArray(compareData.rows) && compareData.rows.length) {
    const rebuiltTerms = buildTermLayer({
      rows: compareData.rows,
      profiles: options.profiles || null,
      envTables: String(process.env.TRANSCOMPARATOR_TERM_TABLES || "").split(/[;\n]/),
      comparisonMode,
    });
    if (Object.keys(rebuiltTerms.byProfile || {}).length) {
      termPrefilter = rebuiltTerms;
      compareData.termPrefilter = rebuiltTerms;
      fs.writeFileSync(jsonFile, JSON.stringify(compareData, null, 2), "utf8");
    }
  }
  const html = makeHtml(
    compareData.rows || [],
    { ...selection, comparisonMode, labels: selection.labels || compareData.labels || {} },
    projectContext,
    compareData.speechHabits || null,
    termPrefilter,
    options.notesRecovery || null,
  );
  const htmlFile = path.join(dir, "translation-compare.html");
  fs.writeFileSync(htmlFile, html, "utf8");
  return {
    htmlFile,
    rowCount: (compareData.rows || []).length,
    notesKey: projectContext.notesStorage?.key || "",
  };
}

module.exports = {
  alignLegacyNotes,
  alignNotesByIndex,
  alignRows,
  createPresetTools,
  exportRows,
  main,
  makeHtml,
  readWorkbenchAssets,
  rebuildCompareHtmlFromSnapshot,
  restorableModelOptions,
  resolveModelOptions,
  rowFieldsFor,
  assertSingleJpParagraphGroups,
  toCsv,
  workbenchClientRows,
};
