const fs = require("fs");
const path = require("path");
const {
  readInputText,
  sliceMainForInput,
  splitParagraphs,
} = require("../../ingest/text-utils");
const { readEpubSpineDocuments } = require("../../ingest/epub-utils");
const { isEpubInput } = require("../../ingest/epub-container");
const { deriveContextUnits, deriveLineUnits } = require("../../ingest/line-units");
const { shortHash } = require("../../core/project-context");
const { escapeHtml, safeJson } = require("../../core/text-helpers");
const { writeFileAtomic, writeJsonAtomic } = require("../../core/atomic-fs");
const { storageLayout } = require("../../core/storage-layout");
const { detectLanguage, selectionFromArgs } = require("./speaker-selection");
const { compareTexts, joinTextItems } = require("./text-comparison");
const { prealignLineUnits } = require("./prealign");
const { createEpubUnitBlocks, prealignEpubHeaderBlocks } = require("./epub-header-alignment");
const {
  ATTENTION_VERSION,
  SPEAKER_PROMPT_VERSION,
  buildAttentionPlan,
  buildSpeakerAttention,
  buildSpeakerPrompt,
  speakerPrompt,
} = require("./attention");
const { inferSpeakerBatch } = require("./ai/speaker-inference");

const outputDir = path.resolve(
  process.env.BETWEENLINES_SPEAKER_OUTPUT_DIR
    || path.join(storageLayout().runtimeDir, "speaker-attribution"),
);
function readSpeakerWorkbenchAssets() {
  const publicDir = path.join(__dirname, "..", "..", "..", "public");
  return {
    workbenchStyle: fs.readFileSync(path.join(publicDir, "speaker-workbench-style.css"), "utf8"),
    aiPanelStyle: fs.readFileSync(path.join(publicDir, "ai-panel.css"), "utf8"),
    workbenchShared: fs.readFileSync(path.join(publicDir, "workbench-shared.js"), "utf8"),
    workbenchClient: fs.readFileSync(path.join(publicDir, "speaker-workbench-client.js"), "utf8"),
  };
}

const initialSpeakerAssets = readSpeakerWorkbenchAssets();
const workbenchStyle = initialSpeakerAssets.workbenchStyle;
const aiPanelStyle = initialSpeakerAssets.aiPanelStyle;
const workbenchShared = initialSpeakerAssets.workbenchShared;
const workbenchClient = initialSpeakerAssets.workbenchClient;

async function loadUnits(file, lang, inputMode) {
  if (isEpubInput(file)) {
    const documents = await readEpubSpineDocuments(file);
    const documentText = documents.map((document) => document.text).join("\n\n");
    const resolvedLanguage = !lang || lang === "auto" ? detectLanguage(documentText) : String(lang).toLowerCase();
    const structured = createEpubUnitBlocks(documents, resolvedLanguage);
    return {
      ...structured,
      language: resolvedLanguage,
      usesEpubHeaders: true,
    };
  }
  const text = await readInputText(file);
  const resolvedLanguage = !lang || lang === "auto" ? detectLanguage(text) : String(lang).toLowerCase();
  const body = sliceMainForInput(text, resolvedLanguage, inputMode, {});
  const paragraphs = splitParagraphs(body, resolvedLanguage);
  return {
    paragraphs,
    units: deriveLineUnits(paragraphs, { quotedOnly: true }),
    contextUnits: deriveContextUnits(paragraphs),
    blocks: [],
    language: resolvedLanguage,
    usesEpubHeaders: false,
  };
}

function emptyAlignment() {
  return {
    version: "none",
    required: false,
    performed: false,
    rows: [],
    sourceCount: 0,
    parallelCount: 0,
    unmatchedSource: 0,
    unmatchedParallel: 0,
    lowConfidence: 0,
  };
}

function rowContext(units, source) {
  if (!source) return [];
  const index = units.findIndex((unit) => unit.parentParagraphId === source.parentParagraphId
    && unit.startOffset < source.endOffset
    && unit.endOffset > source.startOffset);
  if (index < 0) return [];
  // 扩充基础上下文：至少覆盖前后 6 个句子单位，并优先完整保留发话所在自然段的全部叙述
  const start = Math.max(0, index - 6);
  const end = Math.min(units.length, index + 7);
  return units.slice(start, end).map((unit) => ({
    id: unit.id,
    text: unit.text,
    relation: unit.id === source.id ? "target" : "context",
    parentParagraphId: unit.parentParagraphId,
  }));
}

function createRows(alignment, sourceUnits, parallelUnits = [], options = {}) {
  const alignmentRows = Array.isArray(alignment?.rows) ? alignment.rows : [];
  const candidateRows = options.includeMissingSource
    ? alignmentRows
    : alignmentRows.filter((row) => Boolean(row.source && String(row.source.text || "").trim()));
  // 单语工作台没有对照列：不生成 parallel/parallelText/comparison，也不向模型声明 bilingual 模式。
  const bilingual = options.bilingual !== false;
  const speakerMode = bilingual ? "bilingual" : "monolingual";

  return candidateRows.map((row, index) => {
    const sourceText = row.source?.text || "";
    const parallelText = joinTextItems(row.parallel);
    const contextTarget = row.source || row.parallel?.[0] || null;
    const contextUnits = row.source ? sourceUnits : parallelUnits;
    const comparison = row.alignment?.comparison || (sourceText && parallelText ? compareTexts(sourceText, parallelText) : null);
    const rowAlignment = { ...(row.alignment || {}) };
    delete rowAlignment.comparison;

    // 检测源文本或对照文本中是否已存在写回的说话人标记（如 <!--Speaker:xxx-->、\uE000Speaker:xxx\uE001 等）
    const combinedTexts = `${sourceText} ${bilingual ? parallelText : ""}`;
    const writtenMatch = combinedTexts.match(/(?:<!--|\uE000|【)Speaker:([^>】\u0001\n]+?)(?:-->|\uE001|】)/);
    const writtenSpeaker = writtenMatch ? writtenMatch[1].trim() : "";
    const isWritten = Boolean(writtenSpeaker);

    // 清理展现文本中的写回标记，保持显示内容干净
    const cleanSourceText = sourceText.replace(/(?:<!--|\uE000|【)Speaker:[^>】\u0001\n]+?(?:-->|\uE001|】)/g, "").trim();
    const cleanParallelText = parallelText.replace(/(?:<!--|\uE000|【)Speaker:[^>】\u0001\n]+?(?:-->|\uE001|】)/g, "").trim();

    const baseRow = {
      id: `line-${index + 1}`,
      index: index + 1,
      chapter: row.source?.chapter || row.parallel?.[0]?.chapter || "",
      source: row.source,
      sourceText: cleanSourceText || sourceText,
      ...(bilingual ? { parallel: row.parallel, parallelText: cleanParallelText || parallelText } : {}),
      context: rowContext(contextUnits, contextTarget),
      alignment: rowAlignment,
      ...(bilingual ? { comparison } : {}),
      speaker: writtenSpeaker,
      confidence: isWritten ? "1.0" : "",
      status: isWritten ? "written" : "needs-review",
      evidence: isWritten ? "原文件中已存在说话人写回标识" : "",
      isWritten,
    };
    const attention = buildSpeakerAttention(baseRow, { mode: speakerMode });
    const prompt = buildSpeakerPrompt(baseRow, { attention, mode: speakerMode });
    return {
      ...baseRow,
      attention,
      prompt: {
        version: prompt.version,
      },
    };
  });
}

async function build(selection, options = {}) {
  const bilingual = selection.mode === "bilingual";
  const source = await loadUnits(selection.files.source, selection.sourceLang, selection.inputMode);
  let alignment = emptyAlignment();
  let parallel = null;

  if (bilingual) {
    parallel = await loadUnits(selection.files.parallel, selection.parallelLang, selection.inputMode);
    alignment = source.usesEpubHeaders && parallel.usesEpubHeaders
      ? prealignEpubHeaderBlocks(source.blocks, parallel.blocks)
      : prealignLineUnits(source.units, parallel.units);
  } else {
    alignment.rows = source.units.map((unit) => ({
      source: unit,
      parallel: [],
      alignment: { status: "source-only", score: 1, relation: "1:0", confidence: "none" },
    }));
    alignment.sourceCount = source.units.length;
  }

  const resolvedSelection = {
    ...selection,
    sourceLang: source.language,
    // 单语模式没有对照文本：parallel 相关键不进入快照，也不参与分析签名。
    files: bilingual ? { ...selection.files } : { source: selection.files.source },
    alignmentVersion: bilingual ? alignment.version : "none",
  };
  if (bilingual) resolvedSelection.parallelLang = parallel.language;
  else delete resolvedSelection.parallelLang;
  const rows = createRows(
    alignment,
    source.contextUnits || source.units,
    parallel?.contextUnits || parallel?.units || [],
    { bilingual },
  );
  const attentionPlan = buildAttentionPlan(rows);
  if (selection.ai?.enabled) {
    await inferSpeakerBatch(rows, selection.ai, {
      concurrency: selection.ai.concurrency,
      cacheFile: selection.ai.cacheFile,
      signal: options.signal,
      onProgress: options.onProgress,
    });
  }
  const rowIdentity = rows.map((row) => [
    row.source?.id || "",
    row.sourceText,
    row.parallel?.map((item) => item.id || "").join(",") || "",
    row.parallelText,
    row.alignment?.status || "",
    row.alignment?.relation || "",
  ].join("\u001e")).join("\u001f");
  const analysisKey = shortHash([
    resolvedSelection.analysisType,
    resolvedSelection.mode,
    resolvedSelection.files.source,
    resolvedSelection.files.parallel,
    resolvedSelection.sourceLang,
    resolvedSelection.parallelLang,
    resolvedSelection.lineUnitVersion,
    resolvedSelection.alignmentVersion,
    rowIdentity,
  ].join("\u001f"));
  return {
    schemaVersion: 2,
    analysisType: selection.analysisType,
    analysisKey,
    generatedAt: new Date().toISOString(),
    selection: resolvedSelection,
    sourceParagraphCount: source.paragraphs.length,
    sourceLineCount: source.units.length,
    ...(bilingual ? {
      parallelParagraphCount: parallel.paragraphs.length,
      parallelLineCount: parallel.units.length,
    } : {}),
    // alignment.rows 只是中间产物：每行的 source/parallel/comparison 已经在 rows 里带上下文落盘，
    // 再持久化一份会让工作台文件成倍膨胀。
    alignment: publicAlignment(alignment, bilingual),
    rows,
    attentionPlan,
    attentionVersion: ATTENTION_VERSION,
    promptVersion: SPEAKER_PROMPT_VERSION,
  };
}

function publicAlignment(alignment = {}, bilingual = false) {
  const { rows, ...summary } = alignment;
  if (bilingual) return summary;
  // 单语模式没有对照列：不保留 parallel/unmatchedParallel/lowConfidence 这类永远为 0 的占位字段。
  return {
    version: summary.version,
    required: summary.required,
    performed: summary.performed,
    sourceCount: summary.sourceCount,
    unmatchedSource: summary.unmatchedSource,
  };
}

function clientRowsFor(model) {
  // 单语工作台不向页面注入对照列字段，双语工作台才带 parallelText/comparison。
  const bilingual = model.selection?.mode === "bilingual";
  return model.rows.map((row, index) => {
    const sourceText = row.sourceText ?? row.source?.text ?? "";
    const parallelText = row.parallelText ?? joinTextItems(row.parallel);
    return {
      id: row.id || `line-${index + 1}`,
      index: row.index || index + 1,
      chapter: row.chapter || row.source?.chapter || row.parallel?.[0]?.chapter || "",
      sourceText,
      ...(bilingual ? {
        parallelText,
        comparison: row.comparison || (sourceText && parallelText ? compareTexts(sourceText, parallelText) : null),
      } : {}),
      context: row.context || [],
      alignment: row.alignment || {},
      attention: row.attention || null,
      prompt: row.prompt || null,
      prediction: row.prediction || row.ai || null,
      speaker: row.speaker || "",
      confidence: row.confidence || "",
      status: row.status || "needs-review",
      evidence: row.evidence || "",
      isWritten: Boolean(row.isWritten),
    };
  });
}

function renderHtml(model) {
  const bilingual = model.selection.mode === "bilingual";
  const sourceName = path.basename(model.selection.files?.source || "");
  const parallelName = path.basename(model.selection.files?.parallel || "");
  const generatedAt = new Date(model.generatedAt).toLocaleString("zh-CN", { hour12: false });
  const rowsJson = safeJson(clientRowsFor(model));
  const lowConfidence = model.alignment.lowConfidence || 0;
  const unmatchedSource = model.alignment.unmatchedSource || 0;
  const unmatchedParallel = model.alignment.unmatchedParallel || 0;
  const headerAnchors = model.alignment.headerAnchors;
  const headerDetail = headerAnchors?.strategy === "stable-xhtml-header"
    ? `已按 ${headerAnchors.matched} 个 EPUB 表头分段。`
    : (headerAnchors?.strategy === "global-fallback" ? "没有共同 EPUB 表头，已使用整篇顺序对齐。" : "");
  const attentionCounts = model.attentionPlan?.counts || {};
  const attentionDetail = model.attentionPlan
    ? `归属证据排序：高 ${attentionCounts.high || 0}、中 ${attentionCounts.medium || 0}、低 ${attentionCounts.low || 0}；${attentionCounts.needsMoreContext || 0} 行缺少可辨识的归属证据（建议结合对话轮次人工判断）。`
    : "";
  const dialogueScope = "只展示带「」或『』的完整发话；引号内多句保持同一行。";
  const alignmentText = bilingual
    ? `双语预对齐 ${model.alignment.version}：${dialogueScope}${headerDetail}${attentionDetail}${lowConfidence} 行对齐证据较弱，${unmatchedSource} 行原文未匹配，${unmatchedParallel} 行主文本未匹配。`
    : `单语模式：${dialogueScope}${attentionDetail}`;

  const pageMeta = {
    analysisKey: model.analysisKey,
    bilingual,
    generatedAt,
    sourceLineCount: model.sourceLineCount,
    // 单语页面没有对照列，也不注入对照相关的元数据。
    ...(bilingual ? {
      parallelLineCount: model.parallelLineCount,
      parallelLang: model.selection.parallelLang || "und",
      alignmentVersion: model.alignment.version,
    } : {}),
    sourceLang: model.selection.sourceLang || "und",
    alignmentText,
    attentionVersion: model.attentionVersion || ATTENTION_VERSION,
    prompt: {
      version: model.promptVersion || SPEAKER_PROMPT_VERSION,
      system: speakerPrompt.system,
      outputSchema: speakerPrompt.outputSchema,
    },
    attentionPlan: model.attentionPlan || null,
  };
  const sourceLabel = bilingual ? "原文（参考）" : "主文本";
  const parallelHeader = bilingual ? '<th>主文本 / 文本对照</th>' : "";
  const overviewNote = bilingual
    ? " 文本对照只显示可验证的结构信号，不把跨语言字符重合当作语义结论。"
    : "";
  const overviewStats = bilingual
    ? `<dl><div><dt>原文行</dt><dd>${model.sourceLineCount}</dd></div><div><dt>主文本行</dt><dd>${model.parallelLineCount}</dd></div><div><dt>对齐版本</dt><dd>${escapeHtml(model.alignment.version)}</dd></div></dl>`
    : `<dl><div><dt>主文本行</dt><dd>${model.sourceLineCount}</dd></div><div><dt>发话行</dt><dd>${model.rows.length}</dd></div></dl>`;

  const assets = readSpeakerWorkbenchAssets();

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="transcomparator-session-token" content="">
<title>说话人归属工作台</title><style>${assets.workbenchStyle}${assets.aiPanelStyle}</style></head>
<body><div class="speaker-app${bilingual ? " is-bilingual" : " is-monolingual"}">
  <header class="speaker-header"><div class="speaker-topbar">
    <div><p class="speaker-kicker">BetweenLines / 说话人归属</p><h1>说话人归属工作台</h1>
      <div class="speaker-subtle">${escapeHtml(bilingual ? "原文参考 + 主文本完整发话对照" : "主文本完整发话归属确认")} · 生成于 ${escapeHtml(generatedAt)}</div>
      <div class="speaker-files" title="${escapeHtml(sourceName)}${bilingual ? ` · ${escapeHtml(parallelName)}` : ""}">${escapeHtml(sourceLabel)}：${escapeHtml(sourceName)}${bilingual ? ` · 主文本：${escapeHtml(parallelName)}` : ""}</div>
    </div>
    <div class="speaker-stats" aria-label="归属统计">
      <div class="speaker-stat"><strong>${model.rows.length}</strong>总行</div>
      <div class="speaker-stat"><strong id="speakerVisibleCount">${model.rows.length}</strong>当前显示</div>
      <div class="speaker-stat"><strong id="speakerAiProcessedCount">0</strong>AI已处理</div>
      <div class="speaker-stat"><strong id="speakerPendingCount">${model.rows.length}</strong>待确认</div>
      <div class="speaker-stat"><strong id="speakerConfirmedCount">0</strong>已确认</div>
    </div>
  </div></header>
  <div class="speaker-controls">
    <section class="speaker-overview" aria-label="对齐概览">
      <div class="speaker-overview-copy"><strong>工作范围：</strong>${escapeHtml(alignmentText)}${overviewNote}</div>
      ${overviewStats}
    </section>
    <!-- 板块一：AI 推断服务与配置（结构与翻译工作台 AI 面板共用 public/ai-panel.css 组件体系） -->
    <details id="speakerAiPanel" class="panel-details ai-panel" open aria-label="AI 推断">
      <summary class="ai-panel-title"><span>AI 推断服务</span><span id="speakerAiSummaryBadge" class="ai-status-badge">就绪</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开 AI 推断服务"></button></summary>
      <details class="ai-config-details" open><summary class="ai-section-summary">服务与任务设置</summary><div class="ai-config-stack">
        <section class="ai-config-band ai-service-band" aria-labelledby="speakerAiServiceLabel">
          <div id="speakerAiServiceLabel" class="ai-config-label">AI 服务</div>
          <div class="ai-service-fields has-reasoning">
            <div class="ai-field">
              <label for="speakerAiProvider">接口服务</label>
              <select id="speakerAiProvider">
                <option value="local">本地默认 (Ollama/vLLM)</option>
                <option value="compatible">第三方兼容 (OpenAI 协议)</option>
                <option value="claude">Claude 原生</option>
              </select>
            </div>
            <div class="ai-field">
              <label for="speakerAiBaseUrl">API 地址 (Base URL)</label>
              <input id="speakerAiBaseUrl" type="text" placeholder="http://127.0.0.1:11434/v1" value="http://127.0.0.1:11434/v1">
            </div>
            <div class="ai-field">
              <div class="ai-field-head">
                <label for="speakerAiModel">模型名称</label>
                <span id="speakerAiModelHint" class="ai-model-hint" hidden></span>
              </div>
              <div class="ai-model-row">
                <select id="speakerAiModel">
                  <option value="qwen2.5:14b-instruct">qwen2.5:14b-instruct</option>
                </select>
                <div class="ai-model-actions">
                  <button id="speakerAiTestModel" type="button" title="测试当前模型的网络连通性与 API 响应">测试</button>
                  <button id="speakerAiRefreshModels" type="button" title="从当前 API 地址拉取可用模型列表">拉取模型</button>
                </div>
              </div>
            </div>
            <div id="speakerAiReasoningField" class="ai-field">
              <label for="speakerAiReasoningEffort">推理强度</label>
              <select id="speakerAiReasoningEffort">
                <option value="">模型默认</option>
              </select>
            </div>
            <div class="ai-field">
              <label for="speakerAiApiKey">API Key</label>
              <input id="speakerAiApiKey" type="password" placeholder="本地服务通常留空">
            </div>
          </div>
        </section>
        <section class="ai-config-band ai-band--muted" aria-labelledby="speakerAiInferenceLabel">
          <div id="speakerAiInferenceLabel" class="ai-config-label">推断设置</div>
          <div class="ai-proofread-fields">
            <div class="ai-field">
              <label for="speakerAiConcurrency">并发数</label>
              <input id="speakerAiConcurrency" type="number" min="1" max="8" value="3">
            </div>
          </div>
        </section>
      </div></details>
      <div class="ai-runbar ai-runbar--two">
        <div class="ai-status">
          <div id="speakerAiStatusText" class="ai-status-text" title="未运行">未运行</div>
          <div id="speakerAiProgressWrap" class="ai-progress" hidden><span id="speakerAiProgressBar"></span></div>
        </div>
        <div class="ai-actions">
          <button id="speakerAiStart" class="speaker-primary" type="button">开始 AI 推断</button>
          <button id="speakerAiStop" type="button" disabled>停止</button>
          <button id="speakerBatchAdopt" type="button" class="speaker-btn-secondary" title="将置信度 ≥ 80% 的发话批量写回原文件">批量写回 (≥80%)</button>
          <button id="speakerAiClearCache" type="button">清除推断记录</button>
        </div>
      </div>
    </details>

    <!-- 板块二：文本处理、筛选与写回工作区 -->
    <section class="speaker-text-workspace" aria-label="文本处理工作区">
      <div class="speaker-filterbar" aria-label="工作台综合操作栏">
        <input id="speakerQuery" class="speaker-search" type="search" placeholder="搜索文本、章节、说话人或依据">
        <div class="speaker-filtergroups">
          <div class="speaker-segmented" role="group" aria-label="判断状态"><span class="speaker-segmented-label">状态</span>
            <button type="button" data-status-filter="all" class="is-active">全部</button><button type="button" data-status-filter="needs-review">待确认</button><button type="button" data-status-filter="confirmed">已确认</button><button type="button" data-status-filter="written">已写回</button><button type="button" data-status-filter="narration">旁白</button><button type="button" data-status-filter="multiple">多人</button><button type="button" data-status-filter="unknown">未知</button>
          </div>
          <div class="speaker-segmented" role="group" aria-label="对齐状态"><span class="speaker-segmented-label">对齐</span>
            <button type="button" data-alignment-filter="all" class="is-active">全部</button><button type="button" data-alignment-filter="low">需复核</button><button type="button" data-alignment-filter="unmatched">未匹配</button>
          </div>
          <button id="speakerPendingOnly" class="speaker-chip" type="button" aria-pressed="false">只看待确认</button>
          <div class="speaker-display-toggles" aria-label="显示设置">
            ${bilingual ? '<label class="speaker-toggle"><input id="speakerShowParallel" type="checkbox" checked>主文本对照</label>' : ""}
            <label class="speaker-toggle"><input id="speakerShowContext" type="checkbox" checked>上下文</label>
          </div>
        </div>
        <div class="speaker-toolbar-actions">
          <button id="speakerClearFilters" class="speaker-btn-subtle" type="button">清除筛选</button>
        </div>
      </div>
    </section>
  </div>
  <main class="speaker-wrap"><div id="speakerTableFrame" class="speaker-tableframe"><table id="speakerTable"><thead><tr><th>定位与对齐证据</th><th>${escapeHtml(sourceLabel)}</th>${parallelHeader}<th>说话人判断</th></tr></thead><tbody></tbody></table></div>
    <div id="speakerPagination" class="speaker-pagination"><div id="speakerPaginationStatus">正在准备行数据...</div><div class="speaker-pagination-actions"><button id="speakerFirstPage" type="button">首页</button><button id="speakerPrevPage" type="button">上一页</button><label for="speakerPageInput">第</label><input id="speakerPageInput" type="number" min="1" value="1" aria-label="页码"><span id="speakerPageTotal">/ 1 页</span><button id="speakerNextPage" type="button">下一页</button><button id="speakerLastPage" type="button">末页</button></div><label class="speaker-pagination-size" for="speakerPageSize"><span>每页</span><select id="speakerPageSize"><option value="25">25 行</option><option value="50" selected>50 行</option><option value="100">100 行</option><option value="200">200 行</option></select></label></div>
    <div id="speakerEmpty" class="speaker-empty">没有匹配的行</div>
  </main>
</div><script id="rowData" type="application/json">${rowsJson}</script><script>
window.speakerStorageKey = ${safeJson(`between-lines:speaker-attribution:${model.analysisKey}:v2`)};
window.speakerPageMeta = ${safeJson(pageMeta)};
${assets.workbenchShared}
${assets.workbenchClient}
</script></body></html>`;
}

async function main(argv = process.argv.slice(2)) {
  const selection = selectionFromArgs(argv);
  const model = await build(selection);
  writeModel(model);
  console.log(`Speaker workbench: ${path.join(outputDir, "speaker-attribution.html")}`);
  console.log(`Mode: ${selection.mode}; source lines: ${model.sourceLineCount}; rows: ${model.rows.length}`);
  if (selection.mode === "bilingual") console.log(`Pre-alignment: ${model.alignment.version}`);
}

function writeModel(model, targetDir = outputDir) {
  const jsonFile = path.join(targetDir, "speaker-attribution.json");
  const htmlFile = path.join(targetDir, "speaker-attribution.html");
  writeJsonAtomic(jsonFile, model);
  writeFileAtomic(htmlFile, renderHtml(model), "utf8");
  return {
    jsonFile,
    htmlFile,
  };
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exit(1); });

module.exports = {
  build,
  buildSpeakerWorkbench: build,
  clientRowsFor,
  createRows,
  emptyAlignment,
  loadUnits,
  main,
  readSpeakerWorkbenchAssets,
  renderHtml,
  writeModel,
  writeSpeakerModel: writeModel,
};
