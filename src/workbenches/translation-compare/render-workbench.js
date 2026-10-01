const fs = require("fs");
const path = require("path");
const { activeLangs, defaultDisplayLabels } = require("../../ingest/input-selection");
const { protocolDefaults } = require("./ai/proofread-defaults");
const { proofreadPromptFor, listProfiles } = require("./ai/proofread-contract");
const { normalizeGrade } = require("./ai/decision-score");
const { buildPersonaSystemPrompt } = require("./ai/persona-runtime");
const { createNotesTools } = require("./notes-spaces");
const { createPresetTools } = require("./ai-presets");
const { normalizeConnectionConfig } = require("../../ai/connection-config");
const { createStageNoteTools } = require("./ai/stage-note-state");
const { AI_CONCURRENCY_LIMITS: concurrencyLimits } = require("./ai/concurrency-limits");
const { escapeHtml, safeJson } = require("../../core/text-helpers");
const { resolveModelOptions, normalizeApiBaseUrl, restorableModelOptions } = require("./model-options");
const { alignLegacyNotes, alignNotesByIndex } = require("./notes-recovery");
const { loadJpPivotLang } = require("./alignment-artifact");
const { workbenchClientRows } = require("./row-output");
const {
  AI_ERROR_KIND_ORDER,
  AI_ERROR_KIND_LABELS,
  AI_ERROR_ROW_SAMPLE_LIMIT,
  AI_ERROR_ROW_DISPLAY_LIMIT,
  AI_ERROR_SAMPLE_DISPLAY_LIMIT,
  classifyAiError,
  recordAiErrorKind,
  mergeAiErrorKinds,
  sortAiErrorKinds,
  formatAiErrorRowList,
  formatAiErrorHoverTitle,
} = require("./ai/error-kinds");

function readWorkbenchAssets() {
  const publicDir = path.join(__dirname, "..", "..", "..", "public");
  return {
    workbenchStyle: fs.readFileSync(path.join(publicDir, "workbench-style.css"), "utf8"),
    aiPanelStyle: fs.readFileSync(path.join(publicDir, "ai-panel.css"), "utf8"),
    toastStyle: fs.readFileSync(path.join(publicDir, "toast.css"), "utf8"),
    workbenchShared: fs.readFileSync(path.join(publicDir, "workbench-shared.js"), "utf8"),
    workbenchDiff: fs.readFileSync(path.join(publicDir, "workbench-diff.js"), "utf8"),
    workbenchClient: fs.readFileSync(path.join(publicDir, "workbench-client.js"), "utf8"),
  };
}

function pivotLabel(pivotLang, labels) {
  return pivotLang === "cn" ? labels.cn : labels.tw;
}

function makeHtml(rows, selection, projectContext, speechHabits = null, termPrefilter = null) {
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const bilingual = comparisonMode === "bilingual";
  const proofreadPrompt = proofreadPromptFor(comparisonMode);
  const stylistContractPrompt = buildPersonaSystemPrompt("stylist", "");
  const arbiterContractPrompt = buildPersonaSystemPrompt("arbiter", "");
  // 特化侧档案由 profiles/ 注册表提供，界面下拉只列出注册过的档案。
  const profileOptions = listProfiles();
  const generatedAt = new Date(projectContext.generatedAt).toLocaleString("zh-CN", { hour12: false });
  // 显示标签只覆盖该模式真实存在的列，双语页面不会出现第三列的名字。
  const labels = Object.fromEntries(activeLangs(comparisonMode).map((lang) => [
    lang,
    selection.labels?.[lang] || defaultDisplayLabels[lang],
  ]));
  const pivotLang = loadJpPivotLang(comparisonMode);
  const similarityLabel = bilingual ? `${labels.jp}-${labels.cn}` : `${labels.cn}-${labels.tw}`;
  const semanticLabel = `${labels.jp}-${pivotLabel(pivotLang, labels)}`;
  const stats = rows.reduce((acc, row) => {
    acc.total += 1;
    acc.emptySource += row.jp ? 0 : 1;
    acc.scoreSum += row.score || 0;
    return acc;
  }, { total: 0, emptySource: 0, scoreSum: 0 });
  const avgScore = stats.total ? stats.scoreSum / stats.total : 0;
  const fileNames = Object.fromEntries(Object.entries(selection.files || {})
    .map(([lang, file]) => [lang, path.basename(file)]));
  // 文件行与顶部元信息合并为一行，标题区只占两行，降低顶部区域整体高度。
  const fileSummary = `原文 A ${fileNames.jp || ""} · ${bilingual ? "译文 B" : "非原文 B"} ${fileNames.cn || ""}${bilingual ? "" : ` · 非原文 C ${fileNames.tw || ""}`}`;
  const rowsSignature = projectContext.rowsSignature;
  const storageKey = projectContext.notesStorage.key;
  const clientMeta = {
    project: projectContext,
    comparisonMode,
    pageLabels: labels,
    similarityLabel,
    semanticLabel,
    protocolDefaults,
    proofreadPrompt,
    // 每个特化档案自带默认提示词，客户端切换下拉时无需等状态轮询即可替换未手改的提示词。
    profiles: profileOptions.map((profile) => ({
      ...profile,
      prompt: proofreadPromptFor(comparisonMode, profile.id).system,
    })),
    rowsSignature,
    projectKey: projectContext.projectKey,
    glossaryFile: selection.glossaryFile || "",
    writebackBackup: Boolean(selection.writebackBackup),
    // 说话习惯层的构建期结果：页面用它显示“本卷命中概览”并标出疑似说话特色流失的行。
    speechHabits,
    // 对照表的构建期判定：页面用它标出“纯术语（跳过模型）/术语注入/术语冲突”的行，并给出预筛数字。
    termPrefilter,
  };
  const defaultProofreadMode = comparisonMode;
  const clientRows = workbenchClientRows(rows, comparisonMode);
  const rowsJson = safeJson(clientRows);
  const assets = readWorkbenchAssets();

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="transcomparator-session-token" content="">
  <title>${bilingual ? "双语" : "三语"}翻译对比校对工作台</title>
  <style>${assets.workbenchStyle}${assets.aiPanelStyle}${assets.toastStyle}</style>
</head>
<body>
  <div class="app-shell mode-${comparisonMode}">
    <header>
      <div class="topbar">
        <div class="topbar-text">
          <h1>${bilingual ? "双语" : "三语"}翻译对比校对工作台</h1>
          <div class="topbar-meta">
            <span>生成时间 ${escapeHtml(generatedAt)}</span>
            <span>平均相似 ${(avgScore * 100).toFixed(0)}%</span>
            <span>空原文 ${stats.emptySource}</span>
            <span class="files" title="${escapeHtml(fileSummary)}">${escapeHtml(fileSummary)}</span>
          </div>
        </div>
        <div class="stats" aria-label="校对统计">
          <div class="stat"><strong>${stats.total}</strong>总行</div>
          <div class="stat"><strong id="doneCount">0</strong>人工确认</div>
          <div class="stat"><strong id="aiDoneCount">0</strong>自动结果</div>
        </div>
      </div>
    </header>
    <div class="control-stack">
      <details id="controlStackPanel" class="panel-group" data-panel-group open aria-label="控制面板组">
        <summary class="panel-summary"><span>控制面板 <span class="panel-summary-state" id="controlStackState" data-panel-group-state>5 项全部收起</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开全部控制面板"></button></summary>
        <div class="panel-group-body">
        <details id="prefilterPanel" class="panel-details" aria-label="预筛选">
          <summary class="panel-summary"><span>预筛选 <span class="panel-summary-state" id="prefilterPanelState">尚未运行</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开预筛选"></button></summary>
          <p class="panel-desc">执行规则与相似度预筛，快速过滤无需校对的高一致性文本。</p>
          <div class="prefilter-body">
            <div class="prefilter-config">
              <div class="ai-field">
                <label for="prefilterSimilarity">${escapeHtml(similarityLabel)}相似度预筛</label>
                <input id="prefilterSimilarity" type="text" inputmode="decimal" value="92%" aria-label="${escapeHtml(similarityLabel)}相似度预筛百分比">
              </div>
              <p class="prefilter-hint">规则预筛统一繁简、全半角、空白和不可见字符；完全一致或两列均空直接通过，结构化内容不一致标记为冲突。相似度预筛只处理足够长的正文，数字或标识符不同、文本过短或长度差异明显时不启用。预筛结果会写入备注，AI 校对会跳过已通过预筛的行。</p>
            </div>
            <div class="prefilter-runbar">
              <div id="prefilterStats" class="prefilter-stats" aria-live="polite">尚未运行预筛选。</div>
              <div class="prefilter-actions">
                <button id="prefilterStart" class="btn btn--primary" type="button">开始预筛</button>
                <button id="prefilterConfirm" class="btn btn--success" type="button" disabled>确认预筛</button>
                <button id="prefilterStop" class="btn btn--danger" type="button" disabled>停止</button>
              </div>
            </div>
          </div>
        </details>
        <details id="aiPanel" class="panel-details ai-panel" aria-label="AI 校对">
          <summary class="ai-panel-title"><span>AI 辅助校对</span><span id="aiPanelState" class="ai-status-badge">就绪</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开 AI 辅助校对"></button></summary>
          <p class="panel-desc">配置模型服务与校对规范，深度审查翻译缺陷并提供修改建议。</p>
          <details id="aiConfigSection" class="ai-config-details" open><summary class="ai-section-summary">服务与任务设置</summary><div class="ai-config-stack">
            <section class="ai-config-band ai-service-band" aria-labelledby="aiServiceLabel">
              <div id="aiServiceLabel" class="ai-config-label">AI 服务</div>
              <div class="ai-service-content">
                <div id="aiServiceFields" class="ai-service-fields has-reasoning">
                  <div class="ai-service-row">
                    <div class="ai-field ai-preset-field">
                      <div class="ai-field-head">
                        <label for="aiPresetSelect">模型预设</label>
                      </div>
                      <div class="ai-preset-row">
                        <select id="aiPresetSelect">
                          <option value="">-- 自定义 / 未选择预设 --</option>
                        </select>
                        <div class="ai-preset-actions">
                          <button id="aiPresetSave" class="btn btn--subtle" type="button" title="将当前填写的配置覆盖保存到选中的预设" disabled>保存修改</button>
                          <button id="aiPresetSaveAs" class="btn btn--subtle" type="button" title="将当前填写的配置另存为新的模型预设">另存为预设</button>
                          <button id="aiPresetDelete" class="btn btn--subtle btn--danger-subtle" type="button" title="删除选中的模型预设" disabled>删除预设</button>
                        </div>
                      </div>
                    </div>
                    <div class="ai-field ai-provider-name-field">
                      <label for="aiProvider">提供商名称</label>
                      <div id="aiProviderCombobox" class="select-combobox provider-combobox">
                        <input id="aiProvider" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="aiProviderNames" autocomplete="off" placeholder="填写或选择提供商名称" title="留空时按接口地址区分；可为不同账号单独命名。">
                        <button id="aiProviderToggle" class="select-trigger provider-toggle" type="button" tabindex="-1" aria-label="选择已保存的提供商" aria-controls="aiProviderNames" aria-expanded="false">
                          <svg class="select-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.75 6.25L8 9.5L11.25 6.25" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"/></svg>
                        </button>
                        <div id="aiProviderNames" class="select-menu" role="listbox" aria-label="已保存的提供商" hidden></div>
                      </div>
                    </div>
                    <div class="ai-field ai-protocol-field">
                      <label for="aiProtocol">接口类型</label>
                      <select id="aiProtocol">
                        <option value="local">本地默认</option>
                        <option value="claude">Claude</option>
                        <option value="compatible">第三方兼容服务</option>
                      </select>
                    </div>
                    <div class="ai-field ai-url-field">
                      <label for="aiBaseUrl">地址</label>
                      <input id="aiBaseUrl" type="url" value="${escapeHtml(protocolDefaults.local.baseUrl)}">
                    </div>
                  </div>
                  <div class="ai-service-row">
                    <div class="ai-field ai-apikey-field">
                      <label for="aiApiKey">API Key</label>
                      <input id="aiApiKey" type="password" autocomplete="off" placeholder="${escapeHtml(protocolDefaults.local.apiKeyPlaceholder || "")}">
                    </div>
                    <div class="ai-field ai-model-field">
                      <div class="ai-field-head">
                        <label for="aiModel">模型</label>
                      </div>
                      <div class="ai-model-row">
                        <select id="aiModel">
                          <option value="${escapeHtml(protocolDefaults.local.model)}">${escapeHtml(protocolDefaults.local.model)}</option>
                        </select>
                        <div class="ai-model-actions">
                          <button id="aiRefreshModels" type="button" title="从接口获取可用模型列表">刷新</button>
                          <button id="aiTestModel" type="button" title="测试当前模型的网络连通性与响应">测试</button>
                        </div>
                      </div>
                    </div>
                    <div id="aiReasoningField" class="ai-field">
                      <label for="aiReasoningEffort">推理强度</label>
                      <select id="aiReasoningEffort" title="模型默认时不发送推理或采样参数">
                        <option value="" selected>模型默认</option>
                      </select>
                    </div>
                    <div class="ai-field" id="aiConcurrencyField">
                      <div class="ai-field-head">
                        <label for="aiConcurrency" id="aiConcurrencyLabel">并发上限</label>
                      </div>
                      <div class="ai-concurrency-inputs">
                        <input id="aiConcurrency" type="number" min="1" max="${concurrencyLimits.max}" value="3" title="并发上限（1~${concurrencyLimits.max}，默认 3）：实际并发由调度器在 1~上限 之间自动升降——请求稳定时逐步上探，遇到频控或过载自动降速，熔断冷却后从低位重新爬升。">
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            <section class="ai-config-band ai-proofread-band" aria-labelledby="aiProofreadLabel">
              <div id="aiProofreadLabel" class="ai-config-label">校对设置</div>
              <div class="ai-proofread-fields">
                <div class="ai-field">
                  <label for="aiProofreadMode">校对模式</label>
                  <select id="aiProofreadMode" disabled>
                    <option value="${defaultProofreadMode}">${bilingual ? "双语版本校对" : "三语语境校对"}</option>
                  </select>
                </div>
                <div class="ai-field">
                  <label for="aiTarget">校对列</label>
                  <select id="aiTarget"${bilingual ? " disabled" : ""}>
                    <option value="cn">${escapeHtml(labels.cn)}</option>
                    ${bilingual ? "" : `<option value="tw">${escapeHtml(labels.tw)}</option>`}
                  </select>
                </div>
                <div class="ai-field">
                  <label for="aiProfile">特化规范</label>
                  <select id="aiProfile" title="${escapeHtml(profileOptions.map((profile) => `${profile.name}：${profile.summary}`).join("\n"))}">
                    ${profileOptions.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === proofreadPrompt.profileId ? " selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}
                  </select>
                </div>
                <div class="ai-field ai-field--wide">
                  <span id="aiTermTableHint" class="ai-term-hint" data-state="pending" title="特化规范里声明的译名对照表：只有整行有效内容都是术语时才跳过模型；其余命中行（含术语冲突）都把术语作为提示词注入，整句交给模型判断。">对照表：检测中…</span>
                  <span id="aiSpeechHabitHint" class="ai-term-hint" data-state="pending" title="特化规范里声明的说话习惯表：按章/按卷命中人名后，该角色的说话特色不会被判为翻译错误。">说话习惯：检测中…</span>
                </div>
              </div>
            </section>
          </div></details>
          <div id="aiStageDashboard" class="ai-stage-dashboard" aria-label="审核流水线阶段统计">
            <div class="ai-stage-dashboard-header">
              <div class="ai-stage-dashboard-title-group">
                <span class="ai-stage-dashboard-title">认知审核阶段统计</span>
                <span id="aiStageSummaryNeedsEdit" class="ai-stage-badge ai-stage-badge--needs-edit" title="最终建议修改行数（点击筛选需修改行）" role="button" tabindex="0">建议修改: <strong id="metricFinalNeedsEdit">0</strong></span>
                <span id="aiStageSummaryUnchanged" class="ai-stage-badge ai-stage-badge--unchanged" title="最终判定无需修改行数（点击筛选无需修改行）" role="button" tabindex="0">无需修改: <strong id="metricFinalUnchanged">0</strong></span>
                <span id="aiStageSummaryNeedsCheck" class="ai-stage-badge ai-stage-badge--warning" title="需要人工确认的存疑行数" role="button" tabindex="0" hidden>待确认: <strong id="metricFinalNeedsCheck">0</strong></span>
                <span id="aiStageSummaryPendingArbiter" class="ai-stage-badge ai-stage-badge--warning" title="流水线尚未走到终审仲裁的存疑行数——「待人工确认」只能由终审分发，这些行还等着终审定案（点击筛选待终审行）" role="button" tabindex="0" hidden>待终审: <strong id="metricFinalPendingArbiter">0</strong></span>
                <span id="aiStageFastPassRate" class="ai-stage-badge" title="高置信度快速直通率 (Fast Pass)">快速直通: 0%</span>
              </div>
            </div>
            <div class="ai-stage-cards">
              <div class="ai-stage-card" id="stage1Card" data-filter-stage="1" title="阶段一 事实初审：事实性硬伤审查与直接通过">
                <div class="ai-stage-card-head" title="配置阶段一模型预设（默认使用主配置）">
                  <div class="ai-stage-card-title-row">
                    <span class="ai-stage-card-label">阶段一 事实初审</span>
                    <span id="stage1StatusPill" class="ai-stage-status-pill" data-state="idle">待命</span>
                  </div>
                  <div class="ai-stage-card-ctrls">
                    <select id="stage1PresetSelect" class="ai-stage-preset-select" title="阶段一模型预设（默认使用主配置）">
                      <option value="">使用主配置</option>
                    </select>
                    <div class="ai-stage-card-actions">
                      <button id="stage1Start" class="btn btn--primary btn--xs ai-stage-btn" type="button" title="启动阶段一事实初审">开始</button>
                      <button id="stage1Stop" class="btn btn--danger btn--xs ai-stage-btn" type="button" disabled title="停止阶段一任务">停止</button>
                    </div>
                  </div>
                </div>
                <div class="ai-stage-card-body" role="button" tabindex="0" aria-pressed="false" title="点击指标筛选/取消筛选阶段一通过行（回车或空格同样有效）">
                  <div class="ai-stage-card-main">
                    <div class="ai-stage-card-value" title="初审直接合格放行行数"><strong id="metricStage1Passed">0</strong><span class="ai-stage-unit">通过</span></div>
                    <div class="ai-stage-card-flow" title="初审发现硬伤或存疑待定，流入阶段二文学复审">
                      <span class="ai-stage-flow-arrow" aria-hidden="true">➔</span>
                      <span class="ai-stage-flow-pill" title="初审建议修改行数（流入复审）"><strong id="metricStage1NeedsEdit">0</strong><span class="ai-stage-unit">提改</span></span>
                      <span class="ai-stage-flow-pill is-unclear" id="stage1UnclearPill" title="初审存疑待定行数（流入复审）" hidden><strong id="metricStage1Unclear">0</strong><span class="ai-stage-unit">存疑</span></span>
                    </div>
                    <div class="ai-stage-card-sub">
                      <span class="ai-stage-sub-item" title="规则/术语/高置信无需调用模型直接放行">快速直通: <span id="metricFastPassHits">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item" title="初审总检验行数（通过 + 提改 + 存疑）">总检: <span id="metricStage1Total">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item ai-stage-sub-item--error" id="stage1ErrorItem" title="阶段一调用失败/异常行数">异常: <span id="metricStage1Errors">0</span></span>
                    </div>
                  </div>
                  <div id="stage1ProgressWrap" class="ai-stage-card-progress" hidden><span id="stage1Progress"></span></div>
                  <div id="stage1ActiveInfo" class="ai-stage-active-info" hidden><span class="ai-stage-active-dot" aria-hidden="true"></span>处理中: <span id="stage1ActiveRowsText"></span></div>
                </div>
              </div>
              <div class="ai-stage-card" id="stage2Card" data-filter-stage="2" title="阶段二 文学复审：文学责编复审与同行评议">
                <div class="ai-stage-card-head" title="配置阶段二模型预设（未启用时不执行复审）">
                  <div class="ai-stage-card-title-row">
                    <span class="ai-stage-card-label">阶段二 文学复审</span>
                    <span id="stage2StatusPill" class="ai-stage-status-pill" data-state="disabled">未启用</span>
                  </div>
                  <div class="ai-stage-card-ctrls">
                    <select id="stage2PresetSelect" class="ai-stage-preset-select" title="选择阶段二模型预设（不填代表不启用）">
                      <option value="">未启用</option>
                    </select>
                    <div class="ai-stage-card-actions">
                      <button id="stage2Start" class="btn btn--primary btn--xs ai-stage-btn" type="button" title="启动阶段二文学复审">开始</button>
                      <button id="stage2Stop" class="btn btn--danger btn--xs ai-stage-btn" type="button" disabled title="停止阶段二任务">停止</button>
                    </div>
                  </div>
                </div>
                <div class="ai-stage-card-body" role="button" tabindex="0" aria-pressed="false" title="点击指标筛选/取消筛选阶段二复审行（回车或空格同样有效）">
                  <div class="ai-stage-card-main">
                    <div class="ai-stage-card-value" title="承接阶段一初审提改行进行文学复审"><strong id="metricStage2Reviewed">0</strong><span class="ai-stage-unit">复审</span></div>
                    <div class="ai-stage-card-flow" title="复审与初审产生立场或方案分歧，流入阶段三终审仲裁">
                      <span class="ai-stage-flow-arrow" aria-hidden="true">➔</span>
                      <span class="ai-stage-flow-pill is-arb"><strong id="metricStage2Diverged">0</strong><span class="ai-stage-unit">分歧</span></span>
                    </div>
                    <div class="ai-stage-card-sub">
                      <span class="ai-stage-sub-item">采纳: <span id="metricCritiqueAccept">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item">调整: <span id="metricCritiqueModify">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item">驳回: <span id="metricCritiqueReject">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item" id="stage2EscalateItem" title="复审显式请求升级仲裁">升级仲裁: <span id="metricCritiqueEscalate">0</span></span>
                      <span class="ai-stage-sub-sep" id="stage2PendingSep" aria-hidden="true" hidden>·</span>
                      <span class="ai-stage-sub-item ai-stage-sub-item--warn" id="stage2PendingItem" title="最新一轮初审提改或存疑、尚未完成复审且未人工确认的行数（点击可筛选）" hidden>待复审: <span id="metricStage2Pending">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item ai-stage-sub-item--error" id="stage2ErrorItem" title="阶段二复审异常行数">异常: <span id="metricStage2Errors">0</span></span>
                    </div>
                  </div>
                  <div id="stage2ProgressWrap" class="ai-stage-card-progress" hidden><span id="stage2Progress"></span></div>
                  <div id="stage2ActiveInfo" class="ai-stage-active-info" hidden><span class="ai-stage-active-dot" aria-hidden="true"></span>处理中: <span id="stage2ActiveRowsText"></span></div>
                </div>
              </div>
              <div class="ai-stage-card" id="stage3Card" data-filter-stage="3" title="阶段三 终审仲裁：初审与复审分歧仲裁">
                <div class="ai-stage-card-head" title="配置阶段三模型预设（需先在阶段二选择预设启用）">
                  <div class="ai-stage-card-title-row">
                    <span class="ai-stage-card-label">阶段三 终审仲裁</span>
                    <span id="stage3StatusPill" class="ai-stage-status-pill" data-state="disabled">未启用</span>
                  </div>
                  <div class="ai-stage-card-ctrls">
                    <select id="stage3PresetSelect" class="ai-stage-preset-select" disabled title="需先在阶段二选择预设启用后，方可配置阶段三">
                      <option value="">未启用</option>
                    </select>
                    <div class="ai-stage-card-actions">
                      <button id="stage3Start" class="btn btn--primary btn--xs ai-stage-btn" type="button" title="启动阶段三终审仲裁">开始</button>
                      <button id="stage3Stop" class="btn btn--danger btn--xs ai-stage-btn" type="button" disabled title="停止阶段三任务">停止</button>
                    </div>
                  </div>
                </div>
                <div class="ai-stage-card-body" role="button" tabindex="0" aria-pressed="false" title="点击指标筛选/取消筛选阶段三仲裁行（回车或空格同样有效）">
                  <div class="ai-stage-card-main">
                    <div class="ai-stage-card-value" title="承接阶段二分歧行进行终审仲裁裁决"><strong id="metricStage3Arbitrated">0</strong><span class="ai-stage-unit">仲裁</span></div>
                    <div class="ai-stage-card-flow" title="终审裁决完毕，形成最终定案修改建议">
                      <span class="ai-stage-flow-arrow" aria-hidden="true">➔</span>
                      <span class="ai-stage-flow-pill is-settled"><strong id="metricStage3Settled">0</strong><span class="ai-stage-unit">定案</span></span>
                    </div>
                    <div class="ai-stage-card-sub">
                      <span class="ai-stage-sub-item" title="仲裁裁定支持初审方案">初审胜: <span id="metricArbGatekeeper">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item" title="仲裁裁定支持复审润色方案">复审胜: <span id="metricArbStylist">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item" title="仲裁综合双方优点给出结合方案">结合: <span id="metricArbSynthesis">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item" title="仲裁判定双方方案均不妥，维持原译">维持原译: <span id="metricArbOriginal">0</span></span>
                      <span class="ai-stage-sub-sep" id="stage3PendingSep" aria-hidden="true" hidden>·</span>
                      <span class="ai-stage-sub-item ai-stage-sub-item--warn" id="stage3PendingItem" title="复审已产生分歧但尚未执行终审仲裁的行数（点击可筛选）" hidden>待仲裁: <span id="metricStage3Pending">0</span></span>
                      <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                      <span class="ai-stage-sub-item ai-stage-sub-item--error" id="stage3ErrorItem" title="阶段三仲裁异常行数">异常: <span id="metricStage3Errors">0</span></span>
                    </div>
                  </div>
                  <div id="stage3ProgressWrap" class="ai-stage-card-progress" hidden><span id="stage3Progress"></span></div>
                  <div id="stage3ActiveInfo" class="ai-stage-active-info" hidden><span class="ai-stage-active-dot" aria-hidden="true"></span>处理中: <span id="stage3ActiveRowsText"></span></div>
                </div>
              </div>
            </div>
          </div>
        </details>
        <details id="filterPanel" class="panel-details" aria-label="筛选与批处理">
          <summary class="panel-summary"><span>筛选与批处理 <span class="panel-summary-state" id="filterPanelState">未筛选</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开筛选与批处理"></button></summary>
          <p class="panel-desc">按条件检索过滤表格行，控制列显示，并批量确认或写回修改。</p>
          <div class="filter-bar" aria-label="筛选">
            <input id="query" class="filter-search" type="search" placeholder="搜索原文、译文、备注">
            <div class="filter-groups">
              <div class="segmented" role="group" aria-label="相似度状态">
                <span class="segmented__label">相似度</span>
                <button type="button" class="segmented__btn is-active" data-severity="all">全部</button>
                <button type="button" class="segmented__btn" data-severity="review" title="相似度低于 18%">较低</button>
                <button type="button" class="segmented__btn" data-severity="watch" title="相似度为 18% 至 35%">中等</button>
                <button type="button" class="segmented__btn" data-severity="ok" title="相似度不低于 35%">较高</button>
              </div>
              <div class="segmented" role="group" aria-label="自动分析结果">
                <span class="segmented__label">自动</span>
                <button type="button" class="segmented__btn is-active" data-ai-result="all">全部</button>
                <button type="button" class="segmented__btn" data-ai-result="modify">需改</button>
                <button type="button" class="segmented__btn" data-ai-result="same">不改</button>
                <button type="button" class="segmented__btn" data-ai-result="unclear">待判</button>
              </div>
              <div class="segmented" role="group" aria-label="AI 翻译质量评分分级">
                <span class="segmented__label" title="按扣分制（满分100）质量分级筛选">评分</span>
                <button type="button" class="segmented__btn is-active" data-issue-severity="all">全部</button>
                <button type="button" class="segmented__btn" data-issue-severity="excellent" title="优等 (90~100分)：极佳，无缺陷或仅个别微瑕">优等</button>
                <button type="button" class="segmented__btn" data-issue-severity="good" title="良好 (75~89分)：总体良好，有个别轻微缺陷">良好</button>
                <button type="button" class="segmented__btn" data-issue-severity="fair" title="一般 (60~74分)：存在较明显缺陷，需重点修改">一般</button>
                <button type="button" class="segmented__btn" data-issue-severity="poor" title="较差 (<60分)：存在致命错译或严重缺陷，不及格">较差</button>
              </div>
              <button id="prefilterResultFilter" class="chip" type="button" aria-pressed="false" disabled>预筛结果</button>
              <button id="noteFilter" class="chip" type="button" aria-pressed="false">有备注</button>
              <button id="doneFilter" class="chip" type="button" data-mode="open" aria-pressed="false">未人工确认</button>
            </div>
            <button id="clearFilter" class="btn btn--ghost" type="button">清筛选</button>
          </div>
          <div class="action-bar">
            <div class="action-group" aria-label="显示设置">
              <span class="action-group__label">显示</span>
              <label class="toggle-inline"><input id="showSource" type="checkbox" checked>原文</label>
              ${bilingual ? "" : '<label class="toggle-inline"><input id="showTranslationDiff" type="checkbox" checked>译文差异</label>'}
              <label class="toggle-inline"><input id="showRevisionDiff" type="checkbox" checked>修改差异</label>
            </div>
            <div class="action-group" aria-label="修改结果操作">
              <span class="action-group__label">修改结果</span>
              <button id="acceptAiSame" class="btn btn--success" type="button" title="将全部 AI 判断不改的行标记为人工确认（无视当前筛选）">确认自动不改</button>
              <button id="exportNotes" class="btn" type="button" title="批量写回当前筛选结果中的全部修改结果">批量写回</button>
              <label class="toggle-inline" title="写回原文件前自动生成 .bak 备份副本；开关与当前项目绑定，默认关闭"><input id="writebackBackupToggle" type="checkbox">写回自动备份</label>
              <button id="confirmRevisions" class="btn" type="button" title="将当前筛选结果中的修改结果标记为人工确认">批量确认</button>
            </div>
          </div>
        </details>
        <details id="notesPanel" class="panel-details" aria-label="备注空间与找回">
          <summary class="panel-summary"><span>备注空间与找回 <span id="notesSaveState" class="notes-summary-state">保存在此浏览器</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开备注空间"></button></summary>
          <div class="notes-body">
            <div class="notes-toolbar">
              <p class="panel-desc">找回历史备注，或用 JSON 在浏览器之间备份与迁移。</p>
              <div class="notes-actions">
                <button id="exportAllNotes" class="btn" type="button">备份全部</button>
                <label class="notes-file-label" for="importNotesFile">导入备份<input id="importNotesFile" class="notes-file" type="file" accept=".json,application/json"></label>
                <button id="clearCurrentNotes" class="btn btn--subtle" type="button">清空本页</button>
                <button id="clearHistoryNotes" class="btn btn--subtle" type="button">清空历史</button>
                <button id="refreshNotesSpaces" class="btn btn--ghost" type="button">刷新</button>
              </div>
            </div>
            <div id="notesSaveWarning" class="notes-save-warning" role="status" hidden></div>
            <button id="retryNotesSave" class="btn btn--subtle" type="button" hidden>重试保存</button>
            <div id="notesCurrentSpace"></div>
            <div class="notes-history-heading"><strong>历史记录</strong><span id="notesSpaceSummary"></span></div>
            <div id="notesSpaceList" class="notes-space-list">正在读取本机备注空间...</div>
            <p id="notesPanelStatus" class="notes-panel-status" role="status"></p>
            <p class="notes-hint">优先按内容找回，保留本页已有记录。仅按行号或旧文本推断的记录需逐行核验后才能写回。迁移标记不属于备注，列表已自动排除；历史空间由你手动删除。</p>
          </div>
        </details>
        </div>
      </details>
      <dialog id="notesRecoveryDialog" class="notes-recovery-dialog" aria-labelledby="notesRecoveryTitle">
        <h2 id="notesRecoveryTitle">预览备注找回</h2>
        <div id="notesRecoveryPreview"></div>
        <div class="notes-dialog-actions"><button id="cancelNotesRecovery" class="btn btn--ghost" type="button" autofocus>取消</button><button id="applyNotesRecovery" class="btn btn--primary" type="button">找回记录</button></div>
      </dialog>
      <dialog id="aiConfirmDialog" class="notes-recovery-dialog ai-confirm-dialog" aria-labelledby="aiConfirmTitle">
        <h2 id="aiConfirmTitle">启动 AI 校对</h2>
        <p id="aiConfirmMessage" class="ai-confirm-message"></p>
        <div class="notes-dialog-actions">
          <button id="aiConfirmCancel" class="btn btn--ghost" type="button" autofocus>取消</button>
          <button id="aiConfirmKeep" class="btn btn--subtle" type="button">继续剩下的（未AI校对过的）</button>
          <button id="aiConfirmClear" class="btn btn--primary" type="button">从未人工确认处开始</button>
        </div>
      </dialog>
      <dialog id="genericConfirmDialog" class="notes-recovery-dialog generic-confirm-dialog" aria-labelledby="genericConfirmTitle">
        <h2 id="genericConfirmTitle">请确认</h2>
        <p id="genericConfirmMessage" class="generic-confirm-message"></p>
        <div class="notes-dialog-actions">
          <button id="genericConfirmCancel" class="btn btn--ghost" type="button" autofocus>取消</button>
          <button id="genericConfirmOk" class="btn btn--primary" type="button">确认</button>
        </div>
      </dialog>
    </div>
    <main class="wrap">
      <div class="table-frame">
        <table>
          <thead>
            <tr>
              <th>位置</th>
              <th>${escapeHtml(labels.jp)}</th>
              <th>译文对照</th>
              <th>校对备注</th>
            </tr>
          </thead>
          <tbody>
          </tbody>
        </table>
        <div id="keyboardScrollSpacer" class="keyboard-scroll-spacer" aria-hidden="true"></div>
      </div>
      <div id="paginationBar" class="pagination-bar">
        <div id="paginationStatus">正在准备行数据...</div>
        <div class="pagination-actions">
          <button id="firstPage" type="button">首页</button>
          <button id="prevPage" type="button">上一页</button>
          <label for="pageInput">第</label>
          <input id="pageInput" type="number" min="1" value="1" aria-label="页码">
          <span id="pageTotal">/ 1 页</span>
          <button id="nextPage" type="button">下一页</button>
          <button id="lastPage" type="button">末页</button>
        </div>
        <label class="pagination-size" for="pageSize">
          <span>每页</span>
          <select id="pageSize">
            <option value="50">50 行</option>
            <option value="100" selected>100 行</option>
            <option value="200">200 行</option>
            <option value="500">500 行</option>
          </select>
        </label>
      </div>
      <div id="emptyState" class="empty-state">没有匹配的行</div>
    </main>
  </div>
  <div id="toastStack" class="toast-stack" role="region" aria-live="polite" aria-label="操作提示"></div>
  <script id="rowData" type="application/json">${rowsJson}</script>
  <script>
    ${resolveModelOptions.toString()}
    ${normalizeApiBaseUrl.toString()}
    ${restorableModelOptions.toString()}
    ${alignLegacyNotes.toString()}
    ${alignNotesByIndex.toString()}
    ${createNotesTools.toString()}
    ${normalizeConnectionConfig.toString()}
    ${createPresetTools.toString()}
    ${createStageNoteTools.toString()}
    const { latestAiNotePart, stageNoteState } = createStageNoteTools();
    ${normalizeGrade.toString()}
    // 异常分类：与服务端同一份规则（ai/error-kinds.js），页面只负责把分类结果渲染成悬停明细。
    const AI_ERROR_KIND_ORDER = ${safeJson(AI_ERROR_KIND_ORDER)};
    const AI_ERROR_KIND_LABELS = ${safeJson(AI_ERROR_KIND_LABELS)};
    const AI_ERROR_ROW_SAMPLE_LIMIT = ${safeJson(AI_ERROR_ROW_SAMPLE_LIMIT)};
    const AI_ERROR_ROW_DISPLAY_LIMIT = ${safeJson(AI_ERROR_ROW_DISPLAY_LIMIT)};
    const AI_ERROR_SAMPLE_DISPLAY_LIMIT = ${safeJson(AI_ERROR_SAMPLE_DISPLAY_LIMIT)};
    ${classifyAiError.toString()}
    ${recordAiErrorKind.toString()}
    ${mergeAiErrorKinds.toString()}
    ${sortAiErrorKinds.toString()}
    ${formatAiErrorRowList.toString()}
    ${formatAiErrorHoverTitle.toString()}

    const storageKey = ${JSON.stringify(storageKey)};
    const pageMeta = ${safeJson(clientMeta)};
${assets.workbenchShared}
${assets.workbenchDiff}
${assets.workbenchClient}</script>
</body>
</html>`;
}

module.exports = { makeHtml, readWorkbenchAssets };
