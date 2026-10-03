const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const { createProjectContext } = require("./project-context");
const { createNotesTools } = require("../src/workbenches/translation-compare/notes-spaces");
const { createWorkbench } = require("./workbench-fixture");

const {
  alignLegacyNotes,
  alignNotesByIndex,
  alignRows,
  exportRows,
  makeHtml,
  rebuildCompareHtmlFromSnapshot,
  restorableModelOptions,
  resolveModelOptions,
  rowFieldsFor,
  assertSingleJpParagraphGroups,
  toCsv,
  workbenchClientRows,
} = require("./build-compare");

test("模型刷新：使用新 API 地址返回的模型列表替换旧地址的模型", () => {
  const result = resolveModelOptions([
    { id: "new-model-1" },
    { id: "new-model-2" },
  ], "old-model");

  assert.deepEqual(result.models, ["new-model-1", "new-model-2"]);
  assert.deepEqual(result.options, ["new-model-1", "new-model-2", "custom"]);
  assert.equal(result.selected, "new-model-1");
});

test("模型刷新：仅当新 API 仍提供先前选中的模型时才保留选择", () => {
  const result = resolveModelOptions([
    "shared-model",
    "new-model",
    "shared-model",
  ], "shared-model");

  assert.deepEqual(result.models, ["shared-model", "new-model"]);
  assert.equal(result.selected, "shared-model");
});

test("模型选项缓存：仅对产生该缓存的 API 地址恢复选项缓存", () => {
  const cached = {
    baseUrl: "https://new.example/v1/",
    modelOptionsBaseUrl: "https://new.example/v1",
    modelOptions: ["new-model"],
  };

  assert.deepEqual(restorableModelOptions(cached), ["new-model"]);
  assert.deepEqual(restorableModelOptions({ ...cached, baseUrl: "https://other.example/v1" }), []);
  assert.deepEqual(restorableModelOptions({ ...cached, modelOptionsBaseUrl: undefined }), []);
});

test("旧快照里的多段原文对齐组要求重新对齐，不猜测逐段配对", () => {
  assert.throws(() => assertSingleJpParagraphGroups([{
    relation: "2:2",
    jpStart: 10,
    jpEnd: 12,
    pivotStart: 20,
    pivotEnd: 22,
    items: [{ text: "原文一" }, { text: "原文二" }],
    pivotItems: [{ sourceIndex: 21 }, { sourceIndex: 20 }],
  }]), /一张表格行只对应一段原文/);
});

test("双语工作台将 AI 目标列固定为 B 并完全剔除 C 列", () => {
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
  // 熔断由服务端内部决策，页面不得再提供阈值或开关控件，也不得把这类字段带进请求
  assert.doesNotMatch(html, /aiBreaker|ai-breaker|熔断阈值/);
  assert.doesNotMatch(html, /circuitBreaker(ErrorRate|Enabled)|breakerThreshold|breakerDisabled/);
  assert.match(html, /id="aiStageDashboard"/);
  assert.match(html, /class="ai-stage-dashboard-header"/);
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

  // 控制栈四个抽屉按数据流序自上而下，默认全部折叠；红框内容已并入抽屉
  assert.match(html, /<details id="prefilterPanel" class="panel-details" aria-label="预筛选">/);
  assert.match(html, /<details id="aiPanel" class="panel-details ai-panel" aria-label="AI 校对">/);
  assert.match(html, /<details id="filterPanel" class="panel-details" aria-label="筛选与批处理">/);
  assert.doesNotMatch(html, /id="batchPanel"/, "批量操作已并入「筛选与批处理」，不再单独成抽屉");
  assert.match(html, /<details id="notesPanel" class="panel-details" aria-label="备注空间与找回">/);
  const prefilterIdx = html.indexOf('id="prefilterPanel"');
  const aiIdx = html.indexOf('id="aiPanel"');
  const filterIdx = html.indexOf('id="filterPanel"');
  const notesIdx = html.indexOf('id="notesPanel"');
  assert.ok(prefilterIdx >= 0 && prefilterIdx < aiIdx, "预筛选应在 AI 辅助校对之前");
  assert.ok(aiIdx < filterIdx, "AI 辅助校对应在筛选与批处理之前");
  assert.ok(filterIdx < notesIdx, "筛选与批处理应在备注空间与找回之前");
  // 四个 details 都默认折叠（summary 上无 open 属性，且 details 标签本体也未打开）
  assert.match(html, /<details id="prefilterPanel" class="panel-details"(?![^>]*\bopen\b) aria-label="预筛选">/);
  assert.match(html, /<details id="aiPanel" class="panel-details ai-panel"(?![^>]*\bopen\b) aria-label="AI 校对">/);
  assert.match(html, /<details id="filterPanel" class="panel-details"(?![^>]*\bopen\b) aria-label="筛选与批处理">/);
  assert.match(html, /<details id="notesPanel" class="panel-details"(?![^>]*\bopen\b) aria-label="备注空间与找回">/);
  // 面板抽屉统辖于父抽屉之下，用于整组折叠；父级默认展开，不改变子级默认折叠
  assert.match(html, /<details id="controlStackPanel" class="panel-group" data-panel-group open aria-label="控制面板组">/);
  const groupIdx = html.indexOf('id="controlStackPanel"');
  const groupBodyIdx = html.indexOf('<div class="panel-group-body">');
  const groupEndIdx = html.indexOf('<dialog id="notesRecoveryDialog"');
  assert.ok(groupIdx >= 0 && groupIdx < prefilterIdx, "父抽屉应在第一个面板抽屉之前");
  assert.ok(groupBodyIdx > groupIdx && groupBodyIdx < prefilterIdx, "面板容器应在父抽屉内且先于第一个面板");
  const groupPanelSlice = html.slice(groupBodyIdx, groupEndIdx);
  ["prefilterPanel", "aiPanel", "filterPanel", "notesPanel"].forEach((id) => {
    assert.ok(groupPanelSlice.includes('id="' + id + '"'), id + " 应位于父抽屉面板容器内");
  });
  assert.match(groupPanelSlice, /<\/details>\s*<\/div>\s*<\/details>\s*$/, "面板容器与父抽屉应在最后一个面板抽屉之后闭合，且容器内不含非面板节点");
  assert.match(html, /<span[^>]*data-panel-group-state[^>]*>/, "父摘要应带状态字段供客户端同步");

  // 四个内置标签页统一提供简明描述信息（panel-desc），且不提供收起面板冗余按钮
  assert.match(html, /<details id="prefilterPanel"[^>]*>\s*<summary[^>]*>.*?<\/summary>\s*<p class="panel-desc">执行规则与相似度预筛，快速过滤无需校对的高一致性文本。<\/p>/s);
  assert.match(html, /<details id="aiPanel"[^>]*>\s*<summary[^>]*>.*?<\/summary>\s*<p class="panel-desc">配置模型服务与校对规范，深度审查翻译缺陷并提供修改建议。<\/p>/s);
  assert.match(html, /<details id="filterPanel"[^>]*>\s*<summary[^>]*>.*?<\/summary>\s*<p class="panel-desc">按条件检索过滤表格行，控制列显示，并批量确认或写回修改。<\/p>/s);
  assert.match(html, /<div class="notes-toolbar">\s*<p class="panel-desc">仅显示当前项目的历史备注；切换项目后会自动切换到对应历史。可用 JSON 在浏览器之间备份与迁移。<\/p>/s);
  assert.doesNotMatch(html, /btn-collapse-panel/, "移除收起面板按钮，点击当前展开标签页即可收起");
  assert.doesNotMatch(html, />收起面板</, "页面模板中不应包含收起面板按钮文本");

  // 摘要行带实时状态字段（属性顺序不固定）
  assert.match(html, /<span[^>]*(?:id="prefilterPanelState"[^>]*class="panel-summary-state"|class="panel-summary-state"[^>]*id="prefilterPanelState")[^>]*>/);
  assert.match(html, /<span[^>]*(?:id="aiPanelState"[^>]*class="ai-status-badge"|class="ai-status-badge"[^>]*id="aiPanelState")[^>]*>/);
  assert.match(html, /<summary class="ai-panel-title"><span>AI 辅助校对<\/span>\s*<span[^>]*id="aiPanelState"[^>]*class="ai-status-badge"[^>]*>就绪<\/span>/, "栏位标题与状态徽章解耦，标题自身不包含状态标识");
  assert.doesNotMatch(html, /<span>AI 辅助校对\s*<span/, "栏位标题内部不直接嵌套状态元素");
  assert.match(html, /<span[^>]*(?:id="filterPanelState"[^>]*class="panel-summary-state"|class="panel-summary-state"[^>]*id="filterPanelState")[^>]*>/);
  // 「筛选与批处理」收纳了搜索、筛选分段、显示开关与批量按钮：筛选在前、显示在中、批量落盘在后
  const filterPanel = html.slice(filterIdx, notesIdx);
  assert.match(filterPanel, /<div class="filter-bar" aria-label="筛选">/);
  assert.match(filterPanel, /id="query" class="filter-search"/);
  assert.match(filterPanel, /id="showSource" type="checkbox" checked>原文/);
  assert.match(filterPanel, /id="showRevisionDiff" type="checkbox" checked>修改差异/);
  assert.match(filterPanel, /<div class="action-bar">/);
  assert.match(filterPanel, /id="acceptAiSame" class="btn btn--success" type="button" title="将全部 AI 判断不改的行标记为人工确认（无视当前筛选）">确认自动不改/);
  assert.match(filterPanel, /id="exportNotes" class="btn" type="button" title="批量写回当前筛选结果中的全部修改结果">批量写回/);
  assert.match(filterPanel, /id="confirmRevisions" class="btn" type="button" title="将当前筛选结果中的修改结果标记为人工确认">批量确认/);
  const displayIdx = filterPanel.indexOf('aria-label="显示设置"');
  const batchGroupIdx = filterPanel.indexOf('aria-label="修改结果操作"');
  assert.ok(filterPanel.indexOf('id="query"') < displayIdx, "筛选应在显示设置之前");
  assert.ok(displayIdx >= 0 && displayIdx < batchGroupIdx, "显示设置应在批量按钮之前，会改源文件的按钮放最后");

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
  assert.match(script, /aiStatusRefreshInFlight/);
  assert.doesNotMatch(script, /aiRequestCache/);
  assert.doesNotMatch(script, /knownRequestId/);
  assert.doesNotMatch(html, /id="aiMonitorSection"/);
  assert.doesNotMatch(html, /id="aiMonitorEnabled"/);
  assert.doesNotMatch(html, /AI 对话监控/);
  // 右上角固定状态行与全局进度条已移除：阶段进度改由每张阶段卡片自己的进度条承载。
  assert.doesNotMatch(html, /id="aiStatus"/);
  assert.doesNotMatch(html, /id="aiProgressWrap"/);
  assert.doesNotMatch(html, /ai-stage-dashboard-status-bar/);
  assert.doesNotMatch(script, /aiIds\.status/);
  assert.doesNotMatch(script, /aiIds\.progress/);
  assert.match(html, /id="stage1ProgressWrap"[\s\S]*?id="stage2ProgressWrap"[\s\S]*?id="stage3ProgressWrap"/);
  // 进度条必须排在「处理中: …」明细行之前：那行只在运行中出现，排在前面会把这一张卡片的
  // 进度条顶下去，三张卡片就不在同一水平线了。
  assert.match(html, /id="stage1ProgressWrap"[\s\S]*?id="stage1ActiveInfo"/);
  assert.match(html, /id="stage2ProgressWrap"[\s\S]*?id="stage2ActiveInfo"/);
  assert.match(html, /id="stage3ProgressWrap"[\s\S]*?id="stage3ActiveInfo"/);
  assert.match(script, /function renderStageProgress\(stageKey, done, total/);
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
  // 自定义下拉把被隐藏的原生 select 从 Tab 序列与可访问树里摘掉，否则每个下拉都会多出
  // 一个「聚焦了却看不见」的键盘停靠点；标签文本改挂到可见的 trigger 上。
  assert.match(script, /select\.tabIndex = -1;/);
  assert.match(script, /select\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(script, /const triggerLabel = String\(select\.labels\?\.\[0\]\?\.textContent \|\| ""\)\.trim\(\)/);
  // 阶段指标使用原生按钮；正文不再是整个阶段的筛选入口。
  assert.match(html, /<button id="stage1PassedItem" type="button" class="ai-stage-card-value ai-stage-metric" aria-pressed="false"/);
  assert.doesNotMatch(html, /<div class="ai-stage-card-body" role="button"/);
  assert.doesNotMatch(html, /data-filter-stage="/);
  assert.doesNotMatch(script, /activeStageFilter|toggleStageFilter|suppressStageCardFilter/);
  assert.match(script, /role="button" tabindex="0" aria-expanded="' \+ \(defaultOpen \? "true" : "false"\)/);
  assert.match(script, /if \(nativeButton\) return;/);
  assert.match(script, /pipelineBtn\.click\(\)/);
  assert.match(html, /\.ai-stage-card \.ai-stage-metric:focus-visible \{/);
  // 行内审核组件的 token 必须挂在 :root：它们渲染在表格里，不在 .ai-panel 子树内，
  // 挂在面板作用域会让徽标退化成无背景、无边框、hover 也无反馈的裸文字。
  assert.match(html, /:root \{[\s\S]{0,200}--ai-line: var\(--line, var\(--speaker-line\)\);/);
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
  // 一次性回执（按钮结果、行内写回、模型刷新、一轮跑完）走浮动提示；固定状态行只留机器任务的
  // 持续状态，旧的 setTemporaryStatus 口径已删除。实现本身抽到共享的 workbench-shared.js，
  // 由页面显式建一个 toast 中心并接线，说话人归属工作台用的是同一份。
  assert.match(script, /function createToastCenter\(\{ stackId = "toastStack", maxVisible = 4, durationScale = 0\.5, fadeMs = 180, defaultDurationMs = 6000 \} = \{\}\)/);
  assert.match(script, /const toastCenter = createToastCenter\(\);/);
  assert.match(script, /const showToast = toastCenter\.showToast;/);
  assert.match(script, /const dismissToast = toastCenter\.dismissToast;/);
  assert.match(script, /node\.classList\.add\("toast--leaving"\)/);
  assert.match(script, /while \(toasts\.length > maxVisible\) dismissToast\(toasts\[0\]\.id\)/);
  assert.match(html, /@keyframes toast-out/);
  assert.match(script, /showToast\(ai\.error \|\| finishedStatus/);
  assert.doesNotMatch(script, /setTemporaryStatus/);
  assert.doesNotMatch(script, /aiIds.modelHint/);
  assert.doesNotMatch(script, /statusMessageLockedUntil/);
  assert.doesNotThrow(() => new Function(script));
});

test("三语工作台允许 AI 目标列选择 B 或 C", () => {
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

test("双语 CSV 仅包含原文 A 与目标 B 的文本列", () => {
  const csv = toCsv([{ index: 1, jp: "source", cn: "target", tw: "unused" }], "bilingual");
  const [header] = csv.split("\n");
  assert.equal(header, "index,chapter,relation,score,jpAlignScore,jp,cn");
});

test("行产物仅保留当前模式实际具备的字段", () => {
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

test("历史备注按行签名重新映射，不依赖行号", () => {
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

test("历史备注将精确行签名与安全文本锚点找回相结合", () => {
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

test("备注备份支持单个空间往返并将冲突作为副本导入", () => {
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

test("备注清单排除迁移标记并准确统计 UTF-16 存储体积", () => {
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

test("当修订锚点偏移一致时，历史备注作为整块位移找回", () => {
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

test("修订锚点过少不足以证明备注属于当前行集", () => {
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

test("冲突锚点之间的历史备注作废丢弃而不靠猜测找回", () => {
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
  // 这三条都是文本锚点下的配对（记录里的「修改结果」就是目标行现在的正文），中间那一行照旧不猜。
  assert.deepEqual(result.pairs.map((pair) => `${pair.from}->${pair.to}`), ["3->1", "4->2", "10->3"]);
  assert.equal(result.pairs.every((pair) => pair.textConfirmed), true);
  assert.equal(result.unmatched, 1);
});

test("来自其他作品的历史备注不匹配当前任何行", () => {
  const result = alignLegacyNotes([
    { from: 1, signature: "", text: "完全不属于本书的译文内容abcdefg" },
    { from: 2, signature: "", text: "" },
  ], [{ index: 1, cn: "本书第一段译文内容hijklmn", signature: "sig-1" }]);
  assert.equal(result.pairs.length, 0);
});

test("应用新布局保留浏览器备注空间并携带找回辅助工具", () => {
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

test("按行号导入仅移动依然存在的行且绝不覆盖本页已有记录", () => {
  const rows = Array.from({ length: 5 }, (_, offset) => ({ index: offset + 1, cn: "行" + (offset + 1) }));
  const plan = alignNotesByIndex(["1", "2", "3", "9"], rows, ["2"]);
  assert.deepEqual(plan.pairs, [{ from: 1, to: 1 }, { from: 3, to: 3 }]);
  assert.equal(plan.missing, 1);
  assert.equal(plan.occupied, 1);
});

test("工作台页面包含备注空间面板并提供导出、导入与按行号恢复", () => {
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

test("重复内容的短行靠「同一行号 + 同一签名」认领，行集位移时不认领", () => {
  // 「……」这类短行在书里反复出现 → 行签名不唯一 → 老实现只能整条丢弃（真实回归：重新生成后少 84 条人工确认）。
  const build = (shift) => Array.from({ length: 24 }, (_, offset) => ({
    index: offset + 1 + shift,
    cn: offset === 7 || offset === 19 ? "「……」" : `第${offset + 1}段译文内容占位文本长度足够`,
    signature: offset === 7 || offset === 19 ? "dup" : `row-${offset + 1}`,
  }));
  const notes = Array.from({ length: 24 }, (_, offset) => ({
    from: offset + 1, signature: offset === 7 || offset === 19 ? "dup" : `row-${offset + 1}`, text: "",
  }));

  const stable = alignLegacyNotes(notes, build(0));
  assert.equal(stable.sameIndex, 2);
  assert.equal(stable.pairs.length, 24);
  assert.deepEqual(stable.pairs.filter((pair) => pair.sameIndex).map((pair) => pair.to), [8, 20]);

  // 行集整体位移时行号不再代表同一行：宁可不搬，也不把记录接到别的行上。
  const shifted = alignLegacyNotes(notes, build(3));
  assert.equal(shifted.sameIndex, 0);
  assert.equal(shifted.pairs.length, 22);
  assert.equal(shifted.unmatched, 2);
});

test("AI 辅助校对栏位标题与状态解耦，且状态徽章随任务运行动态更新", () => {
  const ui = createWorkbench();

  // 任务运行时动态切换为运行中状态，并赋予高亮类名
  ui.run('renderAiStatus({ kind: "ai", running: true, queued: 10, modelProcessed: 1, total: 10, results: [] })');
  assert.equal(ui.element("aiPanelState").textContent, "校对中...");
  assert.equal(ui.element("aiPanelState").className, "ai-status-badge is-running");

  // 任务完成时动态切换为完成状态
  ui.run('renderAiStatus({ kind: "ai", running: false, finishedAt: "2026-01-01T00:00:00.000Z", queued: 10, modelProcessed: 10, total: 10, results: [] })');
  assert.equal(ui.element("aiPanelState").textContent, "校对完成");
  assert.equal(ui.element("aiPanelState").className, "ai-status-badge");

  // 清除 AI 记录时恢复为就绪
  ui.run("renderClearedAiStatus()");
  assert.equal(ui.element("aiPanelState").textContent, "就绪");
  assert.equal(ui.element("aiPanelState").className, "ai-status-badge");
});

test("三语对齐：保留技术 pivot 侧为空的孤儿段落，安全归并至相邻表格行", () => {
  const cn = [
    { sourceIndex: 0, text: "简中第一句" },
    { sourceIndex: 1, text: "简中第二句" },
  ];
  const tw = [
    { sourceIndex: 0, text: "台版前置句" },
    { sourceIndex: 1, text: "台版第一句" },
    { sourceIndex: 2, text: "台版第二句" },
  ];
  const jp = [
    { sourceIndex: 0, text: "原文第一句" },
    { sourceIndex: 1, text: "原文第二句" },
  ];

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-align-"));
  const prevOutputDir = process.env.TRANSCOMPARATOR_OUTPUT_DIR;
  try {
    process.env.TRANSCOMPARATOR_OUTPUT_DIR = tempDir;
    fs.writeFileSync(path.join(tempDir, "jp-align.json"), JSON.stringify({
      pivotLang: "cn",
      groups: [
        { jpStart: 0, jpEnd: 1, pivotStart: 0, pivotEnd: 1, score: 0.9, relation: "1:1" },
        { jpStart: 1, jpEnd: 2, pivotStart: 1, pivotEnd: 2, score: 0.9, relation: "1:1" },
      ],
    }));

    const rows = alignRows(cn, tw, jp, "trilingual");
    const allTwText = rows.map((r) => r.tw).join(" ");
    assert.match(allTwText, /台版前置句/);
    assert.match(allTwText, /台版第一句/);
    assert.match(allTwText, /台版第二句/);
  } finally {
    if (prevOutputDir) process.env.TRANSCOMPARATOR_OUTPUT_DIR = prevOutputDir;
    else delete process.env.TRANSCOMPARATOR_OUTPUT_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
