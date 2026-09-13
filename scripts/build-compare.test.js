const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

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

  // 控制栈五个抽屉按数据流序自上而下，默认全部折叠；红框内容已并入抽屉
  assert.match(html, /<details id="prefilterPanel" class="panel-details" aria-label="预筛选">/);
  assert.match(html, /<details id="aiPanel" class="panel-details ai-panel" aria-label="AI 校对">/);
  assert.match(html, /<details id="filterPanel" class="panel-details" aria-label="筛选与显示">/);
  assert.match(html, /<details id="batchPanel" class="panel-details" aria-label="批量操作">/);
  assert.match(html, /<details id="notesPanel" class="panel-details" aria-label="备注空间与找回">/);
  const prefilterIdx = html.indexOf('id="prefilterPanel"');
  const aiIdx = html.indexOf('id="aiPanel"');
  const filterIdx = html.indexOf('id="filterPanel"');
  const batchIdx = html.indexOf('id="batchPanel"');
  const notesIdx = html.indexOf('id="notesPanel"');
  assert.ok(prefilterIdx >= 0 && prefilterIdx < aiIdx, "预筛选应在 AI 辅助校对之前");
  assert.ok(aiIdx < filterIdx, "AI 辅助校对应在筛选与显示之前");
  assert.ok(filterIdx < batchIdx, "筛选与显示应在批量操作之前");
  assert.ok(batchIdx < notesIdx, "批量操作应在备注空间与找回之前");
  // 五个新 details 都默认折叠（summary 上无 open 属性，且 details 标签本体也未打开）
  assert.match(html, /<details id="prefilterPanel" class="panel-details"(?![^>]*\bopen\b) aria-label="预筛选">/);
  assert.match(html, /<details id="aiPanel" class="panel-details ai-panel"(?![^>]*\bopen\b) aria-label="AI 校对">/);
  assert.match(html, /<details id="filterPanel" class="panel-details"(?![^>]*\bopen\b) aria-label="筛选与显示">/);
  assert.match(html, /<details id="batchPanel" class="panel-details"(?![^>]*\bopen\b) aria-label="批量操作">/);
  assert.match(html, /<details id="notesPanel" class="panel-details"(?![^>]*\bopen\b) aria-label="备注空间与找回">/);
  // 五个面板抽屉统辖于父抽屉之下，用于整组折叠；父级默认展开，不改变子级默认折叠
  assert.match(html, /<details id="controlStackPanel" class="panel-group" data-panel-group open aria-label="控制面板组">/);
  const groupIdx = html.indexOf('id="controlStackPanel"');
  const groupBodyIdx = html.indexOf('<div class="panel-group-body">');
  const groupEndIdx = html.indexOf('<dialog id="notesRecoveryDialog"');
  assert.ok(groupIdx >= 0 && groupIdx < prefilterIdx, "父抽屉应在第一个面板抽屉之前");
  assert.ok(groupBodyIdx > groupIdx && groupBodyIdx < prefilterIdx, "面板容器应在父抽屉内且先于第一个面板");
  const groupPanelSlice = html.slice(groupBodyIdx, groupEndIdx);
  ["prefilterPanel", "aiPanel", "filterPanel", "batchPanel", "notesPanel"].forEach((id) => {
    assert.ok(groupPanelSlice.includes('id="' + id + '"'), id + " 应位于父抽屉面板容器内");
  });
  assert.match(groupPanelSlice, /<\/details>\s*<\/div>\s*<\/details>\s*$/, "面板容器与父抽屉应在最后一个面板抽屉之后闭合，且容器内不含非面板节点");
  assert.match(html, /<span[^>]*data-panel-group-state[^>]*>/, "父摘要应带状态字段供客户端同步");
  // 摘要行带实时状态字段（属性顺序不固定）
  assert.match(html, /<span[^>]*(?:id="prefilterPanelState"[^>]*class="panel-summary-state"|class="panel-summary-state"[^>]*id="prefilterPanelState")[^>]*>/);
  assert.match(html, /<span[^>]*(?:id="aiPanelState"[^>]*class="ai-panel-state"|class="ai-panel-state"[^>]*id="aiPanelState")[^>]*>/);
  assert.match(html, /<span[^>]*(?:id="filterPanelState"[^>]*class="panel-summary-state"|class="panel-summary-state"[^>]*id="filterPanelState")[^>]*>/);
  assert.match(html, /<span[^>]*(?:id="batchPanelState"[^>]*class="panel-summary-state"|class="panel-summary-state"[^>]*id="batchPanelState")[^>]*>/);
  // 「筛选与显示」收纳了搜索、筛选分段与显示开关
  const filterPanel = html.slice(filterIdx, batchIdx);
  assert.match(filterPanel, /<div class="filter-bar" aria-label="筛选">/);
  assert.match(filterPanel, /id="query" class="filter-search"/);
  assert.match(filterPanel, /id="showSource" type="checkbox" checked>原文/);
  assert.match(filterPanel, /id="showRevisionDiff" type="checkbox" checked>修改差异/);
  // 「批量操作」只装修改结果按钮，不含显示开关
  const batchPanel = html.slice(batchIdx, notesIdx);
  assert.match(batchPanel, /<div class="action-bar">/);
  assert.match(batchPanel, /id="acceptAiSame" class="btn btn--success" type="button">确认自动不改/);
  assert.match(batchPanel, /id="exportNotes" class="btn" type="button" title="批量写回当前筛选结果中的全部修改结果">批量写回/);
  assert.match(batchPanel, /id="confirmRevisions" class="btn" type="button" title="将当前筛选结果中的修改结果标记为人工确认">批量确认/);
  assert.doesNotMatch(batchPanel, /id="showSource"/);
  assert.doesNotMatch(batchPanel, /id="showTranslationDiff"/);
  assert.doesNotMatch(batchPanel, /id="showRevisionDiff"/);

  const script = html.split("<script>")[1].split("</script>")[0];
  // 浮动提示容器：一次性按钮回执的落点，在控制面板之外（整组收起、抽屉滚出视野时仍然可见）
  assert.match(html, /<div id="toastStack" class="toast-stack" role="region" aria-live="polite" aria-label="操作提示"><\/div>/);
  assert.ok(html.indexOf('id="toastStack"') > html.indexOf("</main>"), "浮动提示容器应在正文之后，不受面板折叠影响");
  // 模型提示不再是固定位置的元素：刷新模型的结果改走浮动提示
  assert.doesNotMatch(html, /id="aiModelHint"/);
  // 父抽屉的摘要状态由客户端按组内面板展开数同步；toggle 不冒泡，必须捕获阶段监听
  assert.match(script, /function syncPanelGroupState\(group\) \{/);
  assert.match(script, /function bindPanelGroups\(scope = document\) \{/);
  assert.match(script, /group\.addEventListener\("toggle", \(\) => syncPanelGroupState\(group\), true\)/);
  assert.match(script, /bindPanelGroups\(\);/);
  const syncSource = script.match(/function syncPanelGroupState\(group\) \{[\s\S]*?\n    \}/)[0];
  const runSync = (openFlags) => {
    const fakeState = { textContent: "" };
    const fakeGroup = {
      querySelectorAll: () => openFlags.map((open) => ({ open })),
      querySelector: () => fakeState,
    };
    vm.runInNewContext(syncSource + "\nsyncPanelGroupState(fakeGroup);", { fakeGroup });
    return fakeState.textContent;
  };
  assert.equal(runSync([false, false, false, false, false]), "5 项全部收起");
  assert.equal(runSync([true, false, false, false, false]), "已展开 1/5 项");
  assert.equal(runSync([true, true, true, true, true]), "已展开 5/5 项");
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
  // 一次性回执（按钮结果、行内写回、模型刷新、一轮跑完）走浮动提示；
  // 固定状态行只留机器任务的持续状态，旧的 setTemporaryStatus 口径已删除。
  assert.match(script, /function showToast\(message, \{ tone = "info", durationMs = 6000 \} = \{\}\)/);
  assert.match(script, /const toastDurationScale = 0\.5/);
  assert.match(script, /const toastFadeMs = 180/);
  assert.match(script, /node\.classList\.add\("toast--leaving"\)/);
  assert.match(script, /function dismissToast\(id\)/);
  assert.match(html, /@keyframes toast-out/);
  assert.match(script, /while \(toasts\.length > toastMaxVisible\) dismissToast\(toasts\[0\]\.id\)/);
  assert.match(script, /showToast\(ai\.error \|\| finishedStatus/);
  assert.doesNotMatch(script, /setTemporaryStatus/);
  assert.doesNotMatch(script, /aiIds.modelHint/);
  assert.doesNotMatch(script, /statusMessageLockedUntil/);
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
