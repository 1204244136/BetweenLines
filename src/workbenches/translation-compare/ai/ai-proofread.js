const { normalizeConnectionConfig } = require("../../../ai/connection-config");
const { protocolDefaults } = require("./proofread-defaults");
const { createStageBreaker, describeTrip, describePolicy, formatDuration } = require("./circuit-breaker");
const {
  CONCURRENCY_POLICY,
  createStageController,
  stepUpOnSuccess,
  stepDownOnLimit,
  stepDownOnOverload,
  collapseForBreaker,
  initialConcurrencyFor,
  describeConcurrencyPolicy,
  backoffDelayMs,
  shouldRetryRow,
} = require("./concurrency-controller");
const { AI_CONCURRENCY_LIMITS, resolveConcurrencyCap } = require("./concurrency-limits");
const { parseOptionalNumber, computeScoreAndGrade, normalizeGrade, normalizeSeverity } = require("./decision-score");
const fs = require("fs");
const { diffWordsWithSpace, diffChars } = require("diff");
const OpenCC = require("opencc-js");
const { toCn } = require("../../../ingest/text-utils");
const { classifyPrefilter } = require("./ai-prefilter");
const { displayTermPair, evaluateTermRow, loadTermTables, normalizeTermTablePaths, termTableSummary } = require("./term-table");
const { makeTermResult, termGuidanceFor, termTargetKeyFor } = require("./term-prefilter");
const { readResults, removeResultIndexes, removeResults, writeResults } = require("./result-store");
const { contextFromLayerEntry, speechHabitLayerFor } = require("../speech-habit-layer");
const { termLayerFor, variantIndexSets } = require("../term-layer");
const {
  activatedCharacterNames,
  chapterHabitBlock,
  detectCharacters,
  groupRowsByChapter,
  habitCandidatesForRow,
  speakerCheckBlock,
  speechHabitBlockForRow,
  loadSpeechTables,
  normalizeSpeechTablePaths,
  speechTableSummary,
  volumeHabitBlock,
  volumeKeyFromFiles,
} = require("./speech-habit");
const { rowSignature, sameProjectSnapshot } = require("../../../core/project-context");
const { toPathList } = require("../layer-sources");
const { resolveProjectArtifact } = require("../../../storage/project-store");
const {
  detectModelCapabilities,
  isReasoningModel,
  normalizeModelReasoningEffort,
  loadModelsDev,
} = require("./model-capabilities");
const {
  MODEL_RESPONSE_TIMEOUT_MS,
  TEXT_INTENSITY_TEMPERATURE_MAP,
  buildApiUrl,
  buildProtocolHeaders,
  buildChatCompletionBody: buildSharedChatCompletionBody,
  buildClaudeMessageBody,
  extractClaudeText,
  fetchJson: sharedFetchJson,
  isGptModel,
  normalizeNonGptTemperature,
  testModelConnectivity,
} = require("../../../ai/llm-client");
const { firstString, parseBoolean } = require("../../../ai/prompt-contract");
const toTw = OpenCC.Converter({ from: "cn", to: "tw" });
const { loadGlossary, glossaryPrompt } = require("./glossary");
const {
  DEFAULT_PROFILE_ID,
  listProfiles,
  proofreadPromptFor,
  buildProofreadSystemPrompt,
  profileEntities,
  profileLineStats,
  resolveProfile,
} = require("./proofread-contract");
const { detectRowFeatures } = require("./row-features");
// 实体闸门：只对某个角色/专有词成立的规则，按「本行有没有出现那个名字」注入。
const { detectRowEntities, entityGateReport } = require("./name-entities");
const { normalizeTargetPunctuation, restoreTerminalPunctuation } = require("./punctuation");
const { formatFixDetail, formatFixNote, guardRowFormat } = require("./format-guard");
const { webLookupBlock, webLookupEntries, webLookupNote, webLookupSites } = require("./web-lookup");
const {
  DEFAULT_LOW_SCORE_PENALTY,
  DEFAULT_LOW_SCORE_ROWS,
  causeLabel,
  isShiftCause,
  lowScoreBlock,
  lowScoreNote,
  normalizeCause,
  shouldCheckLowScore,
} = require("./low-score");
const {
  createStageMetrics,
  createStagePipelines,
  normalizeCritiqueResult,
  normalizeReviewStageResult,
  reviewStageResultFromLegacy,
  isFastPassDecision,
  computeResultMetricsDelta,
  applyMetricsDelta,
} = require("./stage-results");
const {
  buildStylistMessages,
  buildArbiterMessages,
  parseStylistResponse,
  parseArbiterResponse,
  createPersonaContext,
} = require("./persona-runtime");
const {
  shouldTriggerArbitration,
  applyArbitrationDecision,
  formatArbitrationNoteLines,
} = require("./arbiter");
const { AI_ERROR_KIND_LABELS, classifyAiError, recordAiErrorKind } = require("./error-kinds");
const { latestAiNotePart, splitNoteFields, stageNoteState } = require("./stage-note-state");
const {
  getModelProfile,
  scheduleModels,
} = require("./scheduler-profile");
const { normalizePresetPool, createPresetPool, assignPendingPresetIds } = require("./preset-pool");
const {
  globalFeedbackCollector,
} = require("./feedback-collector");
const {
  extractNeighborContext,
  resolveStageContext,
} = require("./pipeline-butler");

const knownModelFallbacks = [
  {
    pattern: /(?:^|\.)xiaomimimo\.com(?:\/|$)|(?:^|\/\/)token-plan-cn\.xiaomimimo\.com(?:\/|$)/i,
    models: [
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", protocol: "compatible", fallback: true },
      { id: "mimo-v2.5", name: "MiMo V2.5", protocol: "compatible", fallback: true },
    ],
  },
];


// isGptModel 与共享传输层 (src/ai/llm-client.js) 同源，那里是唯一事实来源。

function normalizeReasoningEffort(value, model, modelMeta = null) {
  return normalizeModelReasoningEffort(value, model, modelMeta);
}

// 语义强度档位与 temperature 的映射以共享传输层 (src/ai/llm-client.js) 为唯一事实来源。
const TEXT_INTENSITY_LEVELS = new Set(Object.keys(TEXT_INTENSITY_TEMPERATURE_MAP));

// 非推理模型的强度归一：优先语义档位（low~max），兼容旧客户端保存的数值 temperature。
function normalizeNonGptIntensity(value) {
  const trimmed = String(value ?? "").trim().toLowerCase();
  if (TEXT_INTENSITY_LEVELS.has(trimmed)) return trimmed;
  const temperature = normalizeNonGptTemperature(trimmed);
  return temperature != null ? String(temperature) : "";
}

const proofreadPrompts = {
  bilingual: proofreadPromptFor("bilingual"),
  trilingual: proofreadPromptFor("trilingual"),
};

const contextBudget = {
  maxRounds: 6,
  maxRows: 12,
  maxChars: 6000,
};

/**
 * 本次运行的失败明细：阶段 → 行号 → { kind, message }。
 * 与 stageMetrics 的异常计数分开存：计数是可撤销的数值 delta，明细是给人看的原始证据，
 * 用来回答「这些异常到底是哪几类问题、出在哪几行」。行重跑成功时按阶段精确清除。
 */
function createStageErrors() {
  return { stage1: {}, stage2: {}, stage3: {} };
}

function recordStageError(stage, rowIndex, error, forcedKind = "") {
  const bucket = status.stageErrors?.[stage];
  if (!bucket) return;
  const message = String(error?.message || error || "").replace(/\s+/g, " ").trim();
  bucket[String(rowIndex)] = {
    // 用户终止时 error 往往是中断异常（Aborted / socket closed），照它归类会记成网络故障，
    // 由调用点显式指定类别，别把「我按了停止」算成故障。
    kind: forcedKind || classifyAiError(error),
    message: message.slice(0, 200),
  };
}

function clearStageError(stage, rowIndex) {
  const bucket = status.stageErrors?.[stage];
  if (bucket) delete bucket[String(rowIndex)];
}

function withStageFailureNote(result, stage, error, { stopped = false, refusal = false } = {}) {
  const marker = stage === "stage2" ? "Stylist复审调用异常：" : "Arbiter仲裁调用异常：";
  const message = stopped
    ? "校对已终止。"
    : `${refusal ? "模型拒答：" : ""}${String(error?.message || error || "调用失败").replace(/\s+/g, " ").trim()}`;
  const lines = String(result.note || "").split("\n");
  const revisionLine = lines.findIndex((line) => line.startsWith("修改结果："));
  // 异常保留在当前备注块中；放在修改结果之前，避免被客户端当成成品修订正文。
  lines.splice(revisionLine < 0 ? lines.length : revisionLine, 0, `${marker}${message}`);
  return { ...result, note: lines.join("\n") };
}

/** 明细按阶段聚合成 { kind: { count, rows, sample } }，随状态接口回报给页面。 */
function stageErrorKindsSnapshot() {
  const snapshot = { stage1: {}, stage2: {}, stage3: {} };
  for (const stage of ["stage1", "stage2", "stage3"]) {
    const bucket = status.stageErrors?.[stage] || {};
    for (const [row, detail] of Object.entries(bucket)) {
      recordAiErrorKind(snapshot[stage], detail?.kind, Number(row), detail?.message);
    }
  }
  return snapshot;
}

const status = {
  running: false,
  kind: "proofread",
  stopRequested: false,
  runId: "",
  startedAt: null,
  finishedAt: null,
  target: "cn",
  proofreadMode: "bilingual",
  profileId: DEFAULT_PROFILE_ID,
  protocol: "local",
  provider: "",
  model: "",
  reasoningEffort: "",
  projectKey: "",
  rowsSignature: "",
  // 本次任务从哪一段起步（stage1/stage2/stage3），以及这条流水线会往下走到哪：
  // 「起点 + 下游配置」决定一切，客户端刷新页面后靠这两个字段恢复按钮与徽标状态。
  stageMode: "stage1",
  stageCascade: { toStylist: false, toArbiter: false },
  total: 0,
  queued: 0,
  processed: 0,
  handled: 0,
  prefiltered: 0,
  rulePrefiltered: 0,
  similarityPrefiltered: 0,
  structuredConflicts: 0,
  termPrefiltered: 0,
  termConflicts: 0,
  termInjected: 0,
  // 注音条目（非人名）的两类不完整证据，口径见 term-table.js 文件头：
  // termRubySkipped ＝ 中日两侧没有同时注音、且译文未出现该译名，因而未参与判定的候选条数；
  // termRubyDemoted ＝ 同样没有双侧注音，但译文确实用了该译名，因而降级为「只作一致性证据」的候选条数。
  termRubySkipped: 0,
  termRubyDemoted: 0,
  // 输出侧护栏：revisedText 混入原文（日文）文字而被作废、等待终审裁决的行数（见 guardTargetScript）。
  scriptLeaks: 0,
  // 成品格式门禁：多少行的修订结果被确定性修正过格式（换行/多余段落/首尾空白），各多少处；
  // 以及多少行因格式无法确定性还原（段结构不一致、noteref 标记增减）被作废转人工（见 format-guard.js）。
  formatEnabled: true,
  formatFixes: 0,
  formatLineBreaks: 0,
  formatParagraphs: 0,
  formatNoteFields: 0,
  formatVoids: 0,
  // 标点规范化：多少行的修改结果被统一过标点宽度/引号体例/补回过句末点号、各多少处（见 punctuation.js）。
  punctEnabled: true,
  punctFixes: 0,
  punctToFull: 0,
  punctToHalf: 0,
  punctQuotes: 0,
  // 无法确定性配对的弯引号会作废整条修订结果并转人工，不让它进入成品。
  punctQuoteVoids: 0,
  // 补回成对标记（引号/括号）内侧被模型删掉的句末点号的处数——原文省略不等于译文该省。
  punctRestored: 0,
  termTables: { files: [], entries: 0 },
  // 低分归因层：多少行因极低分进入归因复核、其中多少行真的归到跨行错位（计数在 resetStatus 里清零）。
  lowScoreEnabled: true,
  lowScorePenalty: DEFAULT_LOW_SCORE_PENALTY,
  lowScoreRows: DEFAULT_LOW_SCORE_ROWS,
  lowScoreChecks: 0,
  lowScoreCauses: {},
  lowScoreShifted: 0,
  speechHabitChapters: 0,
  speechHabitCharacters: [],
  skippedDone: 0,
  modelProcessed: 0,
  modelHandled: 0,
  modelRefusals: 0,
  suggested: 0,
  errors: 0,
  active: [],
  error: "",
  breakerWarning: "",
  stageMetrics: createStageMetrics(),
  stageErrors: createStageErrors(),
  stagePipelines: createStagePipelines(),
  presetPipelines: { stage1: [], stage2: [], stage3: [] },
  metrics: {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    modelCalls: 0,
    averageLatencyMs: 0,
  },
  logs: [],
  results: new Map(),
  resultChanges: [],
  resultRevision: 0,
};

function recordModelCallMetrics(latencyMs, usage = {}) {
  const promptTokens = Math.max(0, Number(usage.promptTokens) || 0);
  const completionTokens = Math.max(0, Number(usage.completionTokens) || 0);
  const totalTokens = Math.max(0, Number(usage.totalTokens) || (promptTokens + completionTokens) || 0);
  status.metrics.modelCalls += 1;
  status.metrics.totalLatencyMs += Math.max(0, Number(latencyMs) || 0);
  status.metrics.promptTokens += promptTokens;
  status.metrics.completionTokens += completionTokens;
  status.metrics.totalTokens += totalTokens;
  if (status.metrics.modelCalls > 0) {
    status.metrics.averageLatencyMs = Math.round(status.metrics.totalLatencyMs / status.metrics.modelCalls);
  }
}

let controllers = new Set();
// 每行当前结果对 stageMetrics 的贡献快照；行被重写/重跑时按同一份快照整体撤销，保证添加与撤销对称。
let resultMetricDeltas = new Map();
// 熔断由 circuit-breaker.js 内部裁决（不接受任何外部开关或阈值）。
// 每个「阶段 × 预设」各持一个断路器：一个预设失效时只暂停这条通道，
// 其它预设继续派发；只有阶段选中的预设全部失效，阶段才进入熔断状态。
let presetBreakers = new Map();
let presetBreakerTrips = new Map();
// 当前 runQueue 的阶段/预设拓扑。断路器的纯决策仍在 circuit-breaker.js，
// 这里仅负责把单通道结果汇总到阶段和整条流水线。
let breakerRuntime = null;
const STAGE_OUTCOME_LABELS = { stage1: "初审", stage2: "文学复审", stage3: "终审仲裁" };

function pushLog(line) {
  const text = String(line || "").replace(/\r\n?/g, "\n");
  for (const part of text.split("\n")) {
    if (!part) continue;
    status.logs.push(part);
  }
  if (status.logs.length > 300) {
    status.logs.splice(0, status.logs.length - 300);
  }
}

function clientStatus(options = {}) {
  // 页面刷新、控制台重启之后内存里可能一条结果都没有：按请求方自报的项目身份
  // 把落盘的结果装回来，让工作台还能把成果重新认领回去，而不是只剩浏览器内存那一份。
  adoptPersistedResults(options.projectKey, options.rowsSignature);
  const sameRun = Boolean(options.runId) && options.runId === status.runId;
  const afterRevision = sameRun ? clampInteger(options.afterRevision, 0, Number.MAX_SAFE_INTEGER, 0) : 0;
  const resultLimit = clampInteger(options.resultLimit, 0, 500, 0);
  const incrementalResults = status.resultChanges.slice(afterRevision, resultLimit ? afterRevision + resultLimit : undefined);
  const requestedProjectKey = String(options.projectKey || "");
  const requestedRowsSignature = String(options.rowsSignature || "");
  const sameRequestedScope = (!requestedProjectKey && !requestedRowsSignature)
    || (requestedProjectKey === String(status.projectKey || "")
      && requestedRowsSignature === String(status.rowsSignature || ""));
  const resultsForRevision = options.includeResults === false
    ? []
    : (resultLimit || afterRevision
      ? incrementalResults
      : Array.from(status.results.values()).sort((a, b) => a.index - b.index));
  const visibleResults = sameRequestedScope ? resultsForRevision : [];
  const deliveredRevision = options.includeResults === false
    ? afterRevision
    : (resultLimit || afterRevision
      ? (visibleResults.length ? visibleResults.at(-1).resultRevision : afterRevision)
      : status.resultRevision);
  return {
    running: status.running,
    kind: status.kind,
    stopRequested: status.stopRequested,
    runId: status.runId,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    target: status.target,
    proofreadMode: status.proofreadMode,
    profileId: status.profileId,
    profiles: listProfiles(),
    protocol: status.protocol,
    provider: status.provider,
    model: status.model,
    reasoningEffort: status.reasoningEffort,
    projectKey: status.projectKey,
    rowsSignature: status.rowsSignature,
    stageMode: status.stageMode,
    stageCascade: { ...status.stageCascade },
    total: status.total,
    queued: status.queued,
    processed: status.processed,
    handled: status.handled,
    prefiltered: status.prefiltered,
    rulePrefiltered: status.rulePrefiltered,
    similarityPrefiltered: status.similarityPrefiltered,
    structuredConflicts: status.structuredConflicts,
    termPrefiltered: status.termPrefiltered,
    termConflicts: status.termConflicts,
    termInjected: status.termInjected,
    concurrency: status.concurrency,
    currentConcurrency: status.currentConcurrency,
    concurrencyMax: status.concurrencyMax,
    concurrencyUps: status.concurrencyUps,
    concurrencyDowns: status.concurrencyDowns,
    concurrencyLimits: status.concurrencyLimits,
    peakConcurrency: status.peakConcurrency,
    termRubySkipped: status.termRubySkipped,
    termRubyDemoted: status.termRubyDemoted,
    // 输出侧护栏：多少行的修订结果因混入原文文字被作废（它们未定案、等待终审，不是失败）。
    scriptLeaks: status.scriptLeaks,
    // 成品格式门禁：这一层是否启用、多少行的修订结果被修正过格式（换行/多余段落/说明字段各多少处）、
    // 多少行因格式无法确定性还原被作废（作废行同样未定案、等待终审）。
    formatEnabled: status.formatEnabled,
    formatFixes: status.formatFixes,
    formatLineBreaks: status.formatLineBreaks,
    formatParagraphs: status.formatParagraphs,
    formatNoteFields: status.formatNoteFields,
    formatVoids: status.formatVoids,
    // 标点规范化：这一层是否启用、多少行的修改结果被改过、宽度/引号与补回句末点号各多少处。
    punctEnabled: status.punctEnabled,
    punctFixes: status.punctFixes,
    punctToFull: status.punctToFull,
    punctToHalf: status.punctToHalf,
    punctQuotes: status.punctQuotes,
    punctQuoteVoids: status.punctQuoteVoids,
    punctRestored: status.punctRestored,
    webLookups: status.webLookups,
    webLookupResolved: status.webLookupResolved,
    webLookupAttempts: status.webLookupAttempts,
    webLookupSites: status.webLookupSites || [],
    // 低分归因层：这一层是否启用、阈值与窗口、复核了多少行、各归因各多少行（跨行错位单列）。
    lowScoreEnabled: status.lowScoreEnabled,
    lowScorePenalty: status.lowScorePenalty,
    lowScoreRows: status.lowScoreRows,
    lowScoreChecks: status.lowScoreChecks,
    lowScoreShifted: status.lowScoreShifted,
    lowScoreCauses: status.lowScoreCauses,
    termTables: status.termTables,
    termTableStatus: options.includeTermTables === false ? null : termTableStatusFor(options.profileId || status.profileId),
    speechHabitStatus: options.includeTermTables === false ? null : speechHabitStatusFor(options.profileId || status.profileId),
    speechHabitChapters: status.speechHabitChapters,
    speechHabitCharacters: status.speechHabitCharacters,
    skippedDone: status.skippedDone,
    modelProcessed: status.modelProcessed,
    modelHandled: status.modelHandled,
    modelRefusals: status.modelRefusals,
    suggested: status.suggested,
    errors: status.errors,
    active: status.active,
    error: status.error,
    breakerWarning: status.breakerWarning,
    stageMetrics: { ...status.stageMetrics },
    // 异常分类明细：页面把「异常」指标的悬停提示按类别展开（哪几类问题、各多少行、出在哪几行）。
    stageErrors: stageErrorKindsSnapshot(),
    stagePipelines: createStagePipelines(status.stagePipelines),
    presetPipelines: {
      stage1: status.presetPipelines.stage1.map((item) => ({ ...item, activeRows: [...item.activeRows] })),
      stage2: status.presetPipelines.stage2.map((item) => ({ ...item, activeRows: [...item.activeRows] })),
      stage3: status.presetPipelines.stage3.map((item) => ({ ...item, activeRows: [...item.activeRows] })),
    },
    metrics: { ...status.metrics },
    feedbackStats: globalFeedbackCollector.getStatistics(),
    logs: options.includeLogs === false ? [] : status.logs,
    results: sameRequestedScope ? resultsForRevision : [],
    resultRevision: deliveredRevision,
    latestResultRevision: status.resultRevision,
    hasMoreResults: deliveredRevision < status.resultRevision,
    protocolDefaults,
    proofreadPrompt: proofreadPromptFor(status.proofreadMode, status.profileId),
  };
}

function readRows(inputProject = {}) {
  const compareJsonFile = resolveProjectArtifact(inputProject.projectKey, "translation-compare.json", {
    rowsSignature: inputProject.rowsSignature,
  });
  const data = JSON.parse(fs.readFileSync(compareJsonFile, "utf8"));
  return {
    // 构建期算好的说话习惯层（可能有，也可能没有：老快照或该档案没声明表）。
    speechHabits: data.speechHabits || null,
    // 构建期算好的对照表判定（行号结论，不落备注）：运行期用来交叉校验，避免页面与任务结论分叉。
    termPrefilter: data.termPrefilter || null,
    project: data.project || null,
    rows: data.rows || [],
    labels: data.labels || {},
  };
}

function requireMatchingProjectSnapshot(inputProject, currentProject) {
  if (!inputProject?.projectKey || !inputProject?.rowsSignature) {
    throw new Error("AI 校对请求缺少项目上下文，请从当前工作台重新启动。");
  }
  if (!currentProject?.projectKey || !currentProject?.rowsSignature) {
    throw new Error("当前工作台缺少项目上下文，请重新生成工作台。");
  }
  if (!sameProjectSnapshot(inputProject, currentProject)) {
    throw new Error("AI 校对请求不属于当前项目快照，请重新生成并打开工作台。");
  }
}

// 独立阶段二/三任务能不能复用上一轮任务留在内存里的结论。
// 从备注文本反推初审结论是有损的（lowScore 丢失、score 用 80 兜底、better 靠「参考/对照」字样猜），
// 而同一项目快照下的内存结论是完整的。项目或行集一变就不能复用——行号对不上，宁可退回有损重建。
function reusePreviousResults(config = {}) {
  const resumedCascade = config.continueOnly && stagePlan(config).cascadeToArbiter;
  if (config.targetStage !== "stage2" && config.targetStage !== "stage3" && !resumedCascade) return false;
  return Boolean(
    status.results.size > 0
    && status.projectKey
    && status.projectKey === config.projectKey
    && status.rowsSignature
    && status.rowsSignature === config.rowsSignature
  );
}

function cleanConfig(input = {}) {
  const { protocol, provider } = normalizeConnectionConfig(input);
  const defaults = protocolDefaults[protocol];
  const target = input.target === "tw" ? "tw" : "cn";
  const proofreadMode = input.proofreadMode === "trilingual" ? "trilingual" : "bilingual";
  // 并发上限：调度器在 1~上限 之间自动升降（见 concurrency-controller.js），没有「智能并发」开关。
  // resolveConcurrencyCap 同时把旧客户端的 smartConcurrency + concurrencyMax 折算成同一个上限。
  const concurrency = resolveConcurrencyCap(input);
  const similarityThreshold = clampNumber(input.similarityThreshold, 0.5, 1, 0.92);
  const model = String(input.model || defaults.model).trim();
  const modelMeta = detectModelCapabilities(model, provider, null,
    input.modelMeta?.id === model ? input.modelMeta : (Array.isArray(input.modelMetadata) ? input.modelMetadata.find((item) => item?.id === model) : null));
  // 特化侧档案：未知 id 一律回落到默认档案，避免旧客户端或手填值把提示词打空。
  // 档案决定默认提示词与两类辅助数据表，这里只解析一次。
  const profile = resolveProfile(input.profileId);
  const profileId = profile.id;
  // 线上查证的官方站点：显式传入（测试/临时）> 环境变量（换站点）> 档案声明；顺序就是查询顺序。
  // 字符串形式按 `;` 与换行拆分（环境变量友好），对象形式 `{ label, url }` 原样使用。
  const inputSites = Array.isArray(input.wikiSites) ? input.wikiSites : toPathList(input.wikiSites);
  const envSites = toPathList(process.env.TRANSCOMPARATOR_WIKI_SITES);
  return {
    protocol,
    provider,
    target,
    proofreadMode,
    profileId,
    // 对照表：显式传入 > 特化档案声明 > 环境变量，去重后按顺序加载。
    termTables: normalizeTermTablePaths([
      ...toPathList(input.termTables),
      ...toPathList(profile.termTables),
      ...toPathList(process.env.TRANSCOMPARATOR_TERM_TABLES),
    ]),
    // 说话习惯表同理；作用是按章/按卷命中人名后，把该角色的说话特色规则随请求注入。
    speechTables: normalizeSpeechTablePaths([
      ...toPathList(input.speechTables),
      ...toPathList(profile.speechTables),
      ...toPathList(process.env.TRANSCOMPARATOR_SPEECH_TABLES),
    ]),
    speechHabitScope: (input.speechHabitScope || profile.speechHabitScope) === "volume" ? "volume" : "chapter",
    // 线上查询层（判定链的最后一层，排在低分归因层之后）：官方站点入口由档案声明，**按声明顺序**依次查证（拿到关键信息就停），
    // 三个站点都不行再让模型自行检索，仍不行才转人工。本机不抓网页（实测这些站点对本机一律 403 风控挑战），
    // 这一层只把「去哪个站点、查哪些词、问什么、什么时候停」交给模型。站点为空时整层不启用。
    wikiSites: webLookupSites(
      inputSites.length
        ? inputSites
        : (envSites.length ? envSites : (Array.isArray(profile.wikiSites) ? profile.wikiSites : [])),
    ),
    webLookup: input.webLookup !== false && process.env.TRANSCOMPARATOR_WEB_LOOKUP !== "0",
    // 低分归因层：极低分（扣分达到阈值，或档位为 poor）的行先让模型解释低分原因、再按原因修，
    // 而不是把“与原文毫无关系”直接当逐句误译处理。跨行错位是归因里的必查项。
    lowScoreCheck: input.lowScoreCheck !== false && process.env.TRANSCOMPARATOR_LOW_SCORE !== "0",
    lowScorePenalty: clampInteger(
      input.lowScorePenalty ?? process.env.TRANSCOMPARATOR_LOW_SCORE_PENALTY,
      0,
      100,
      DEFAULT_LOW_SCORE_PENALTY,
    ),
    lowScoreRows: clampInteger(input.lowScoreRows, 1, 4, DEFAULT_LOW_SCORE_ROWS),
    // 标点规范化（确定性工序，排在输出侧护栏之前）：中文语境用全角、英文句子保持半角，
    // 只动标点宽度，并把改了几处如实写进备注与日志（提示词侧的对应要求写在排版层里）。
    punctNormalize: input.punctNormalize !== false && process.env.TRANSCOMPARATOR_PUNCT !== "0",
    // 成品格式门禁（确定性工序，排在标点规范化之前）：revisedText 必须是一整行/与目标列同段数，
    // 模型插入的换行与 `<br>` 一并并回本行；段数与 noteref 标记对不上时作废转人工（见 format-guard.js）。
    formatGuard: input.formatGuard !== false && process.env.TRANSCOMPARATOR_FORMAT !== "0",
    concurrency,
    similarityThreshold,
    projectKey: String(input.projectKey || "").trim(),
    rowsSignature: String(input.rowsSignature || "").trim(),
    forgetResultIndexes: normalizeIndexSet(input.forgetResultIndexes),
    baseUrl: String(input.baseUrl || defaults.baseUrl).trim().replace(/\/+$/, ""),
    model,
    modelMeta,
    reasoningEffort: modelMeta.reasoning
      ? normalizeReasoningEffort(input.reasoningEffort, model, modelMeta)
      : normalizeNonGptIntensity(input.reasoningEffort),
    apiKey: String(input.apiKey || "").trim(),
    systemPrompt: String(input.systemPrompt || "").trim() || proofreadPromptFor(proofreadMode, profileId).system,
    glossaryFile: String(input.glossaryFile || "").trim(),
    continueOnly: Boolean(input.continueOnly),
    completedIndexes: normalizeIndexSet(input.completedIndexes),
    targetStage: (input.stage === "stage2" || input.targetStage === "stage2") ? "stage2"
      : ((input.stage === "stage3" || input.targetStage === "stage3") ? "stage3"
      : ((input.stage === "all" || input.targetStage === "all") ? "all" : "stage1")),
    rowNotes: Object.fromEntries(Object.entries(
      (input.rowNotes && typeof input.rowNotes === "object") ? input.rowNotes : {}
    ).map(([index, note]) => [index, latestAiNotePart(note).trim()])),
    multiStageEnabled: Boolean(input.multiStageEnabled || input.challengerEnabled || input.singleModelPersona || input.stylistConfig || input.stage2Preset),
    challengerEnabled: Boolean(input.challengerEnabled),
    singleModelPersona: Boolean(input.singleModelPersona),
    arbiterEnabled: input.arbiterEnabled !== false,
    stylistConfig: input.stylistConfig ? cleanSubStageConfig(input.stylistConfig, defaults, concurrency) : (input.stage2Preset ? cleanSubStageConfig(input.stage2Preset, defaults, concurrency) : null),
    arbiterConfig: input.arbiterConfig ? cleanSubStageConfig(input.arbiterConfig, defaults, 2) : (input.stage3Preset ? cleanSubStageConfig(input.stage3Preset, defaults, 2) : null),
    // 阶段一的多预设池：页面上「适用 (N)」选中的每个预设都带着自己的连接参数与并发上限，
    // 服务端按预设各开各的并发。漏掉这一项，多预设池会整池丢失、只剩主配置一条通道。
    presetPool: cleanStagePresetPool(input.presetPool, null, defaults, concurrency),
    stylistPresets: cleanStagePresetPool(input.stylistPresets || input.stage2Presets, input.stylistConfig || input.stage2Preset, defaults, concurrency),
    arbiterPresets: cleanStagePresetPool(input.arbiterPresets || input.stage3Presets, input.arbiterConfig || input.stage3Preset, defaults, 2),
    // 本次任务里命中的行：术语提示段落按行号在此登记，跑任务时注入提示词（含术语冲突行）。
    termContext: new Map(),
    // 术语冲突（对照表有强证据差异）的行号：这些行**必须**经过模型，不能被规则/相似度预筛挡掉。
    termConflictIndexes: new Set(),
  };
}

function cleanSubStageConfig(input = {}, fallbackDefaults = {}, defaultConcurrency = 3) {
  if (!input || typeof input !== "object") return null;
  const { protocol, provider } = normalizeConnectionConfig(input);
  const defaults = protocolDefaults[protocol] || fallbackDefaults;
  const model = String(input.model || defaults.model || "").trim();
  if (!model) return null;
  const modelMeta = detectModelCapabilities(model, provider, null,
    input.modelMeta?.id === model ? input.modelMeta : (Array.isArray(input.modelMetadata) ? input.modelMetadata.find((item) => item?.id === model) : null));
  const baseUrl = String(input.baseUrl || defaults.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(input.apiKey || "").trim();
  const reasoningEffort = modelMeta.reasoning
    ? normalizeReasoningEffort(input.reasoningEffort, model, modelMeta)
    : normalizeNonGptIntensity(input.reasoningEffort);

  // 各阶段各自的并发上限（预设里的 concurrency）；旧预设的 smartConcurrency + concurrencyMax 同样折算。
  const concurrency = resolveConcurrencyCap(input, defaultConcurrency);

  return {
    protocol,
    provider,
    baseUrl,
    model,
    apiKey,
    modelMeta,
    reasoningEffort,
    concurrency,
  };
}

// 阶段预设池的清洗：连接参数走 cleanSubStageConfig，但必须保住预设身份（presetId / name）。
// 只清洗不保身份的话，运行状态里的预设 id 会退化成 preset-1、preset-2，页面上「适用 (N)」
// 选中的那几个预设标签就永远对不上运行数据，每个预设各自的并发也就无从展示。
// fallbackConf 是「这个阶段只配了一个预设」时的兜底连接（主配置 / stylistConfig / arbiterConfig）。
function cleanStagePresetPool(value, fallbackConf = null, fallbackDefaults = {}, defaultConcurrency = 3) {
  const fallbackPreset = fallbackConf ? normalizePresetPool([fallbackConf])[0] || null : null;
  return normalizePresetPool(value, fallbackPreset)
    .map((item) => {
      const cleaned = cleanSubStageConfig(item, fallbackDefaults, defaultConcurrency);
      if (!cleaned) return null;
      return { ...cleaned, presetId: item.presetId, name: item.name };
    })
    .filter(Boolean);
}

function normalizeIndexSet(value) {
  const source = Array.isArray(value) ? value : [];
  const indexes = source
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
  return new Set(indexes);
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, number));
}

function resetStatus(config, rowsLength) {
  status.running = true;
  status.kind = config.kind || "proofread";
  status.stopRequested = false;
  status.runId = new Date().toISOString();
  status.startedAt = status.runId;
  status.finishedAt = null;
  status.target = config.target;
  status.proofreadMode = config.proofreadMode;
  status.profileId = resolveProfile(config.profileId).id;
  status.protocol = config.protocol;
  status.provider = config.provider;
  status.model = config.model;
  status.reasoningEffort = config.reasoningEffort;
  status.projectKey = config.projectKey;
  status.rowsSignature = config.rowsSignature;
  {
    // 如实回报本次任务的起点与级联范围：客户端据此恢复按钮态与徽标，不靠猜。
    const plan = stagePlan(config);
    status.stageMode = plan.startsAt;
    status.stageCascade = { toStylist: plan.cascadeToStylist, toArbiter: plan.cascadeToArbiter };
  }
  // concurrency 是起步并发、concurrencyMax 是并发上限；实际放行的并发随调度器升降，runQueue 开跑后覆盖 currentConcurrency。
  status.concurrency = initialConcurrencyFor(config.concurrency);
  status.currentConcurrency = status.concurrency;
  status.concurrencyMax = config.concurrency;
  status.concurrencyUps = 0;
  status.concurrencyDowns = 0;
  status.concurrencyLimits = 0;
  status.peakConcurrency = status.concurrency;
  status.total = rowsLength;
  status.queued = 0;
  status.processed = 0;
  status.handled = 0;
  status.prefiltered = 0;
  status.rulePrefiltered = 0;
  status.similarityPrefiltered = 0;
  status.structuredConflicts = 0;
  status.termPrefiltered = 0;
  status.termConflicts = 0;
  status.termInjected = 0;
  // 输出侧护栏：多少行的 revisedText 混进了原文（日文）文字而被作废转人工（提示词约束之外的确定性闸门）。
  status.scriptLeaks = 0;
  // 成品格式门禁：把修订结果的格式按成品结构确定性修正（单行/同段数/去首尾空白），修不了就作废转人工。
  status.formatEnabled = config.formatGuard !== false;
  status.formatFixes = 0;
  status.formatLineBreaks = 0;
  status.formatParagraphs = 0;
  status.formatNoteFields = 0;
  status.formatVoids = 0;
  // 标点规范化：把修改结果里的标点宽度按语境统一（中文全角、英文半角），并补回被删掉的句末点号。
  status.punctEnabled = config.punctNormalize !== false;
  status.punctFixes = 0;
  status.punctToFull = 0;
  status.punctToHalf = 0;
  status.punctQuotes = 0;
  status.punctQuoteVoids = 0;
  status.punctRestored = 0;
  // 线上查询层：多少行模型判断不了而进入查证、一共问了几轮、其中多少行据此得出结论。
  status.webLookups = 0;
  status.webLookupResolved = 0;
  status.webLookupAttempts = 0;
  // 低分归因层：本次任务的开关、阈值、窗口与计数（状态接口据此如实显示这一层有没有生效）。
  status.lowScoreEnabled = config.lowScoreCheck !== false;
  status.lowScorePenalty = config.lowScorePenalty;
  status.lowScoreRows = config.lowScoreRows;
  status.lowScoreChecks = 0;
  status.lowScoreShifted = 0;
  status.lowScoreCauses = {};
  status.skippedDone = 0;
  status.modelProcessed = 0;
  status.modelHandled = 0;
  status.modelRefusals = 0;
  status.suggested = 0;
  status.errors = 0;
  status.active = [];
  status.error = "";
  status.breakerWarning = "";
  status.stageMetrics = createStageMetrics();
  status.stageErrors = createStageErrors();
  status.stagePipelines = createStagePipelines();
  status.presetPipelines = { stage1: [], stage2: [], stage3: [] };
  status.presetPipelines = { stage1: [], stage2: [], stage3: [] };
  status.metrics = {
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    totalLatencyMs: 0,
    modelCalls: 0,
    averageLatencyMs: 0,
  };
  status.logs = [];
  status.results = new Map();
  resultMetricDeltas = new Map();
  status.resultChanges = [];
  status.resultRevision = 0;
  controllers = new Set();
  presetBreakers = new Map();
  presetBreakerTrips = new Map();
  breakerRuntime = null;
}

function makePrefilterResult(row, labels, classification, comparisonMode = "trilingual") {
  const sourceLabel = labels.jp || "原文 A";
  const leftLabel = comparisonMode === "bilingual" ? sourceLabel : (labels.cn || "非原文 B");
  const rightLabel = comparisonMode === "bilingual" ? (labels.cn || "译文 B") : (labels.tw || "非原文 C");
  const isConflict = classification.kind === "structured-conflict";
  const isSimilarity = classification.kind === "similarity";
  const marker = isSimilarity ? "[相似度预筛]" : "[规则预筛]";
  const analysis = isSimilarity
    ? `${leftLabel} 与 ${rightLabel} 的受保护正文相似度为 ${Math.round(classification.similarity * 100)}%。`
    : classification.reason;
  return {
    runId: status.runId,
    index: row.index,
    signature: rowSignature(row),
    status: isConflict ? "rule-conflict" : (isSimilarity ? "similarity-prefilter" : "rule-prefilter"),
    done: !isConflict,
    note: [
      marker,
      `语义是否相同：${isConflict ? "待人工确认" : "相同"}`,
      `是否需要修改：${isConflict ? "待人工确认" : "否"}`,
      `分析：${analysis}${row.jp ? ` 参照列：${sourceLabel}。` : ""}`,
    ].filter(Boolean).join("\n"),
  };
}

// —— AI 结果落盘 ——
// 服务端内存里的结果只活在这次会话里：开新任务会清空，控制台重启更是什么都不剩。
// 浏览器 localStorage 只有约 10 MB 且被多个项目共享，写满时页面上的备注就只剩内存副本，
// 刷新即丢。AI 结果是可重新交付的服务端产物，所以按「项目键 + 行集签名」落一份盘，
// 页面刷新或服务重启后由 clientStatus 整份重新交付。
//
// 落盘节奏按「脏行数」触发：整份快照一次就是几 MB，2250 行的任务若每两秒写一次会白白
// 写掉几个 GB。累积到阈值或超过最长等待就写一次，任务收尾再完整写一次——代价是崩溃时
// 最多丢这么多行，而中途刷新并不受影响（任务还在服务端跑，页面重新连上继续拉）。
const RESULTS_PERSIST_DIRTY_LIMIT = 200;
const RESULTS_PERSIST_MAX_DELAY_MS = 30000;
let resultsPersistTimer = null;
let resultsPersistDirty = 0;

function resultsPersistTarget() {
  const projectKey = String(status.projectKey || "");
  const rowsSignature = String(status.rowsSignature || "");
  if (!projectKey || !rowsSignature) return null;
  return { projectKey, rowsSignature };
}

function persistResultsNow() {
  if (resultsPersistTimer) {
    clearTimeout(resultsPersistTimer);
    resultsPersistTimer = null;
  }
  resultsPersistDirty = 0;
  const target = resultsPersistTarget();
  if (!target || !status.results.size) return false;
  // 与盘上已有结果合并：新一轮可能只跑了少数行（其余被判定为已完成而跳过），
  // 直接整份覆盖会把上一轮的结论抹掉。
  const merged = new Map();
  const stored = readResults(target.projectKey, target.rowsSignature);
  for (const item of stored?.results || []) merged.set(Number(item.index), item);
  for (const [index, item] of status.results) merged.set(Number(index), item);
  writeResults(target.projectKey, target.rowsSignature, {
    runId: status.runId,
    kind: status.kind,
    total: status.total,
    finishedAt: status.finishedAt || "",
    results: [...merged.values()],
  });
  return true;
}

function scheduleResultsPersist() {
  resultsPersistDirty += 1;
  // 攒够一批就先落一次：长任务里既有「崩溃时最多丢这么多行」的上界，也不会写成写放大。
  if (resultsPersistDirty >= RESULTS_PERSIST_DIRTY_LIMIT) {
    try {
      persistResultsNow();
    } catch (error) {
      pushLog(`AI 结果落盘失败：${error.message || error}`);
    }
    return;
  }
  if (resultsPersistTimer) return;
  resultsPersistTimer = setTimeout(() => {
    resultsPersistTimer = null;
    try {
      persistResultsNow();
    } catch (error) {
      pushLog(`AI 结果落盘失败：${error.message || error}`);
    }
  }, RESULTS_PERSIST_MAX_DELAY_MS);
  // 落盘定时器不该拖住进程退出。
  if (typeof resultsPersistTimer.unref === "function") resultsPersistTimer.unref();
}

function resetIdleStatus({ clearPersisted = false } = {}) {
  if (resultsPersistTimer) {
    clearTimeout(resultsPersistTimer);
    resultsPersistTimer = null;
  }
  resultsPersistDirty = 0;
  if (clearPersisted && status.projectKey && status.rowsSignature) {
    removeResults(status.projectKey, status.rowsSignature);
  }
  status.stopRequested = false;
  status.kind = "proofread";
  status.runId = "";
  status.startedAt = null;
  status.finishedAt = null;
  status.projectKey = "";
  status.rowsSignature = "";
  status.concurrency = AI_CONCURRENCY_LIMITS.defaultConcurrency;
  status.currentConcurrency = AI_CONCURRENCY_LIMITS.defaultConcurrency;
  status.concurrencyMax = AI_CONCURRENCY_LIMITS.defaultConcurrency;
  status.concurrencyUps = 0;
  status.concurrencyDowns = 0;
  status.concurrencyLimits = 0;
  status.peakConcurrency = AI_CONCURRENCY_LIMITS.defaultConcurrency;
  status.total = 0;
  status.queued = 0;
  status.processed = 0;
  status.handled = 0;
  status.prefiltered = 0;
  status.rulePrefiltered = 0;
  status.similarityPrefiltered = 0;
  status.structuredConflicts = 0;
  status.termPrefiltered = 0;
  status.termConflicts = 0;
  status.termInjected = 0;
  status.scriptLeaks = 0;
  status.webLookups = 0;
  status.webLookupResolved = 0;
  status.webLookupAttempts = 0;
  status.lowScoreChecks = 0;
  status.lowScoreShifted = 0;
  status.lowScoreCauses = {};
  status.termTables = { files: [], entries: 0 };
  status.speechHabitChapters = 0;
  status.speechHabitCharacters = [];
  status.skippedDone = 0;
  status.modelProcessed = 0;
  status.modelHandled = 0;
  status.suggested = 0;
  status.errors = 0;
  status.active = [];
  status.error = "";
  status.breakerWarning = "";
  status.stageMetrics = createStageMetrics();
  status.stageErrors = createStageErrors();
  status.stagePipelines = createStagePipelines();
  status.logs = [];
  status.results = new Map();
  resultMetricDeltas = new Map();
  status.resultChanges = [];
  status.resultRevision = 0;
  controllers = new Set();
  presetBreakers = new Map();
  presetBreakerTrips = new Map();
  breakerRuntime = null;
}

/**
 * 页面刷新或控制台重启后内存里可能一条结果都没有：这时按请求方自报的项目身份，
 * 把落盘的结果重新装回 status，让 clientStatus 照常交付给工作台。
 * 只在「没有运行中的任务、且内存里没有别的项目结果」时接管，避免把别的项目结论串过来。
 */
function adoptPersistedResults(projectKey, rowsSignature) {
  const key = String(projectKey || "");
  const signature = String(rowsSignature || "");
  if (!key || !signature) return false;
  if (status.running) return false;
  if ((status.results.size || status.resultChanges.length)
      && (status.projectKey !== key || status.rowsSignature !== signature)) {
    resetIdleStatus({ clearPersisted: false });
  }
  if (status.results.size || status.resultChanges.length) return false;
  const stored = readResults(key, signature);
  if (!stored || !stored.results.length) return false;
  status.projectKey = key;
  status.rowsSignature = signature;
  status.kind = stored.kind || "proofread";
  status.runId = stored.runId || status.runId;
  status.finishedAt = stored.finishedAt || status.finishedAt;
  status.total = stored.total || stored.results.length;
  status.results = new Map();
  status.resultChanges = [];
  status.resultRevision = 0;
  for (const item of stored.results) {
    status.resultRevision += 1;
    const result = { ...item, resultRevision: status.resultRevision };
    status.results.set(Number(result.index), result);
    status.resultChanges.push(result);
  }
  return true;
}

function addResult(result, { prefilterKind = "" } = {}) {
  status.resultRevision += 1;
  // Every result, including deterministic prefilter rows and transport errors,
  // exposes the same stage contract for consumers that do not understand the
  // legacy note/status fields yet.
  const storedResult = {
    ...result,
    stageResult: result.stageResult || reviewStageResultFromLegacy(result, status.model),
    resultRevision: status.resultRevision,
  };
  // 一行可能被后续阶段或重跑再次写入：指标是「每行当前结果」的快照，
  // 先按上次记下的贡献整体撤销，再按新结果累加。
  const previousDelta = resultMetricDeltas.get(result.index);
  if (previousDelta) applyMetricsDelta(status.stageMetrics, previousDelta, -1);
  status.results.set(result.index, storedResult);
  status.resultChanges.push(storedResult);
  status.processed += 1;
  if (result.done) status.handled += 1;
  if (prefilterKind) {
    status.prefiltered += 1;
    if (prefilterKind === "rule") status.rulePrefiltered += 1;
    if (prefilterKind === "similarity") status.similarityPrefiltered += 1;
    if (prefilterKind === "structured-conflict") status.structuredConflicts += 1;
    if (prefilterKind === "term") status.termPrefiltered += 1;
  } else {
    status.modelProcessed += 1;
    if (result.done) status.modelHandled += 1;
  }
  if (result.status === "suggestion") status.suggested += 1;
  if (result.status === "error") status.errors += 1;

  // 所有阶段指标由同一个纯函数得出，添加与撤销共用，不再各写一套判据。
  const delta = computeResultMetricsDelta(storedResult, { prefilterKind });
  resultMetricDeltas.set(result.index, delta);
  applyMetricsDelta(status.stageMetrics, delta, 1);
  // 每批结果都排队落盘（节流）：这样刷新页面时，成果在服务端已经有一份。
  scheduleResultsPersist();
}

async function startPrefilter(input) {
  if (status.running) {
    const error = new Error(status.kind === "prefilter" ? "预筛选正在运行。" : "AI 校对正在运行。");
    error.code = "RUNNING";
    throw error;
  }

  const config = cleanConfig(input);
  const { project, rows, termPrefilter } = readRows(config);
  requireMatchingProjectSnapshot(config, project);
  forgetRequestedResultIndexes(config);
  config.proofreadMode = project.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  config.kind = "prefilter";
  config.termLayer = termPrefilter;
  resetStatus(config, rows.length);
  const labels = {
    jp: "原文 A",
    cn: "非原文 B",
    tw: "非原文 C",
    ...(input.labels || {}),
  };

  let pending = 0;
  // 预筛选同样先过一遍对照表：只有整行都是术语的行会落地，其余命中行留给模型（含术语冲突行）。
  const resolvedByTermTable = applyTermTable(config, rows, labels);
  for (const row of rows) {
    if (config.completedIndexes.has(Number(row.index))) {
      status.skippedDone += 1;
      continue;
    }
    if (resolvedByTermTable.has(Number(row.index))) continue;
    // 术语冲突行不吃预筛：这类行必须由模型给出术语判断（术语判断是模型分析里的一环）。
    if (isTermConflictRow(config, row.index)) {
      pending += 1;
      continue;
    }
    const left = config.proofreadMode === "bilingual" ? (row.jp || "") : (row.cn || "");
    const right = config.proofreadMode === "bilingual" ? (row.cn || "") : (row.twCn || toCn(row.tw || ""));
    const classification = classifyPrefilter({
      source: row.jp || "",
      left,
      right,
      score: row.score,
    }, config.similarityThreshold);
    if (classification) {
      const prefilterKind = classification.kind === "similarity"
        ? "similarity"
        : (classification.kind === "structured-conflict" ? "structured-conflict" : "rule");
      addResult(makePrefilterResult(row, labels, classification, config.proofreadMode), { prefilterKind });
    } else {
      pending += 1;
    }
  }

  status.queued = pending;
  pushLog(`预筛选：人工确认跳过 ${status.skippedDone} 行，对照表跳过 ${status.termPrefiltered} 行，规则跳过 ${status.rulePrefiltered} 行，结构化冲突 ${status.structuredConflicts} 行，相似度跳过 ${status.similarityPrefiltered} 行；术语冲突 ${status.termConflicts} 行按口径留给 AI 判断（不吃预筛），剩余 ${pending} 行需要 AI 校对。`);
  finish();
  return clientStatus({ includeResults: false });
}

async function startProofread(input) {
  if (status.running) {
    const error = new Error("AI 校对正在运行。");
    error.code = "RUNNING";
    throw error;
  }

  const config = cleanConfig(input);
  if (!config.model) throw new Error("请输入模型名称。");
  if (!config.baseUrl) throw new Error("请输入接口地址。");

  const { project, rows, speechHabits: snapshotSpeechHabits, termPrefilter } = readRows(config);
  requireMatchingProjectSnapshot(config, project);
  forgetRequestedResultIndexes(config);
  config.proofreadMode = project.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  config.termLayer = termPrefilter;
  if (!String(input.systemPrompt || "").trim()) {
    config.systemPrompt = proofreadPromptFor(config.proofreadMode, config.profileId).system;
  }
  if (config.proofreadMode === "bilingual") config.target = "cn";
  // 独立阶段二/三任务要复用上一轮留在内存里的结论：resetStatus 会清空 status.results，
  // 所以必须在它之前把可复用的快照摘出来，否则复审只能从备注文本反推（有损）。
  const reusableResults = reusePreviousResults(config) ? new Map(status.results) : new Map();
  resetStatus(config, rows.length);
  // 按行裁剪的审计计数按任务清零：任务完成时会汇报本次省了多少条特化规范。
  resetPromptTrim();
  // 状态接口如实显示本次任务用的查证站点顺序（未声明/已关闭时为空数组，前端据此说明这一层未启用）。
  status.webLookupSites = config.webLookup ? config.wikiSites.map((site) => site.label) : [];
  const labels = {
    jp: "原文 A",
    cn: "非原文 B",
    tw: "非原文 C",
    ...(input.labels || {}),
  };
  const queue = [];
  // 说话习惯层：按章/按卷判定人名命中，命中即把该角色的说话特色规则随每次请求注入。
  // 它不产出结果、也不跳过行，只影响模型对“刻意特色”的判断与补回建议。
  config.speechHabitContext = buildSpeechHabitContext(config, rows, project, snapshotSpeechHabits);
  if (config.speechHabitContext) {
    const { tables, scope, activatedChapters, activatedCharacters, volume } = config.speechHabitContext;
    status.speechHabitChapters = activatedChapters;
    status.speechHabitCharacters = activatedCharacters;
    pushLog(`${speechTableSummary(tables)}：按${scope === "volume" ? "卷" : "章"}命中 ${activatedChapters} ${scope === "volume" ? "卷" : "章"} / ${activatedCharacters.length} 个角色${volume?.code ? `（${volume.code}）` : ""}，这些角色的说话特色不会被判为翻译错误。`);
  }
  const bilingual = config.proofreadMode === "bilingual";
  const defaultTargetKey = bilingual ? "cn" : config.target;
  const defaultCounterpartKey = bilingual ? "jp" : (defaultTargetKey === "cn" ? "tw" : "cn");
  const defaultTargetLabel = defaultTargetKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C");
  const defaultCounterpartLabel = defaultCounterpartKey === "jp"
    ? (labels.jp || "原文 A")
    : (defaultCounterpartKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C"));

  function memoryForRow(idx) {
    const result = reusableResults.get(idx) || status.results.get(idx);
    if (!result) return null;
    // 同一快照也可能切换备注空间或重新初审；只复用与当前轮备注吻合的内存结论。
    if (input.rowNotes && typeof input.rowNotes === "object" &&
        (config.rowNotes[idx] || "") !== latestAiNotePart(result.note).trim()) return null;
    return result;
  }

  // 复审队列条目：优先用上一轮的内存结论（无损），拿不到才退回从备注文本反推（有损）。
  function buildStage2Item(row, noteText, memoryResult) {
    const isUnclear = Boolean(
      memoryResult?.stageResult?.decision === "unclear" ||
      memoryResult?.stageResult?.better === "unclear" ||
      memoryResult?.stageResult?.needsContext === true ||
      noteText.includes("是否需要修改：待人工确认") ||
      noteText.includes("是否需要修改：待终审") ||
      noteText.includes("存疑转人工") ||
      noteText.includes("初审存疑")
    );
    if (memoryResult && memoryResult.stageResult && (memoryResult.stageResult.needsEdit || isUnclear)) {
      const rememberedDecision = memoryResult.decision || memoryResult.stageResult;
      return {
        row,
        decision: {
          ...rememberedDecision,
          // 公开摘要使用 decision 键，复审提示词使用 better；存疑不能在内存续跑时丢失。
          better: isUnclear ? "unclear" : (rememberedDecision.better || rememberedDecision.decision),
        },
        targetKey: memoryResult.targetKey || defaultTargetKey,
        targetLabel: memoryResult.targetLabel || defaultTargetLabel,
        counterpartKey: memoryResult.counterpartKey || defaultCounterpartKey,
        counterpartLabel: memoryResult.counterpartLabel || defaultCounterpartLabel,
        targetText: memoryResult.targetText || textForKey(row, memoryResult.targetKey || defaultTargetKey),
        counterpartText: memoryResult.counterpartText || textForKey(row, memoryResult.counterpartKey || defaultCounterpartKey),
        lowScore: null,
      };
    }
    return reconstructStage1Result(row, noteText, config, labels);
  }

  function buildStage3Item(row, noteText, memoryResult) {
    // stageResult 是公开摘要，通常没有完整复审内容；拿它直接仲裁会丢失复审改案与理由。
    return (memoryResult?.decision?.stylistReview && config.continueOnly)
      ? {
          row,
          decision: memoryResult.decision,
          targetKey: memoryResult.targetKey || defaultTargetKey,
          targetLabel: memoryResult.targetLabel || defaultTargetLabel,
          counterpartKey: memoryResult.counterpartKey || defaultCounterpartKey,
          counterpartLabel: memoryResult.counterpartLabel || defaultCounterpartLabel,
          targetText: memoryResult.targetText || textForKey(row, memoryResult.targetKey || defaultTargetKey),
          counterpartText: memoryResult.counterpartText || textForKey(row, memoryResult.counterpartKey || defaultCounterpartKey),
          lowScore: null,
          arbCheck: { triggered: true },
        }
      : reconstructStage2Result(row, noteText, config, labels);
  }

  // 已经有初审结论、只差复审的行：它们不该再跑一遍初审，直接进复审队列。
  // 没有这一步，「待复审 N 行」只能等初审把它们重新产出一遍，复审并发配得再高也派不出活来。
  function collectResumedStage2(resolvedByTermTable = new Set()) {
    const resumed = [];
    const indexes = new Set();
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx)) continue;
      // 对照表已经直接定案的行（term-only）不再送复审，否则会白花一次调用。
      if (resolvedByTermTable.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      const memoryResult = memoryForRow(idx);
      if (!isStage2Candidate(noteText, memoryResult)) continue;
      // 已经有复审结论的行（含等待仲裁的）不在这里补跑：重跑复审只会白花一次调用。
      if (stageNoteState(noteText).reviewed || stageNoteState(noteText).arbitrated || memoryResult?.stylistReview) continue;
      resumed.push(buildStage2Item(row, noteText, memoryResult));
      indexes.add(idx);
    }
    return { resumed, indexes };
  }

  // 已有复审结论的仲裁待办直接续跑终审，保留前两段方案与异常留证。
  function collectResumedStage3(resolvedByTermTable = new Set()) {
    const resumed = [];
    const indexes = new Set();
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx) || resolvedByTermTable.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      const state = stageNoteState(noteText);
      if (!state.reviewed || !state.pendingArbitration) continue;
      resumed.push(buildStage3Item(row, noteText, memoryForRow(idx)));
      indexes.add(idx);
    }
    return { resumed, indexes };
  }

  const plan = stagePlan(config);
  let stageItems = { stage2: [], stage3: [] };

  if (config.targetStage === "stage2") {
    if (!config.stylistConfig && !config.singleModelPersona) {
      const error = new Error("请先在阶段二选择模型预设以启用文学复审。");
      error.code = "STAGE2_CONFIG_MISSING";
      throw error;
    }
    const resumedStage3 = plan.cascadeToArbiter && config.continueOnly
      ? collectResumedStage3()
      : { resumed: [], indexes: new Set() };
    stageItems.stage3 = resumedStage3.resumed;
    const items = [];
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx)) continue;
      if (resumedStage3.indexes.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      // 优先用上一轮的内存结论（无损），拿不到才退回从备注文本反推。
      const memoryResult = memoryForRow(idx);
      const hasSuggestion = isStage2Candidate(noteText, memoryResult);
      if (hasSuggestion) {
        if (config.continueOnly && (stageNoteState(noteText).reviewed || stageNoteState(noteText).arbitrated || memoryResult?.stylistReview)) {
          status.skippedDone += 1;
          continue;
        }
        items.push(buildStage2Item(row, noteText, memoryResult));
      } else {
        status.skippedDone += 1;
      }
    }
    stageItems.stage2 = items;
    status.queued = items.length + resumedStage3.resumed.length;
    pushLog(`阶段二 文学复审：共 ${items.length} 行初审修改建议与存疑行进入复审队列。`);
    if (resumedStage3.resumed.length) {
      pushLog(`级联续跑：${resumedStage3.resumed.length} 行已有复审结论、只差仲裁，直接进入仲裁队列（不再重跑复审）。`);
    }
    if (status.queued === 0) {
      pushLog("阶段二 文学复审：当前没有需要复审的初审修改建议或存疑行。");
      finish();
      return clientStatus({ includeResults: false });
    }
    runQueue([], rows, config, labels, stageItems).catch((error) => {
      status.error = error.message || String(error);
      pushLog(status.error);
      finish();
    });
    return clientStatus({ includeResults: false });
  }

  if (config.targetStage === "stage3") {
    if (!config.arbiterConfig && !config.singleModelPersona) {
      const error = new Error("请先在阶段三选择模型预设以启用终审仲裁。");
      error.code = "STAGE3_CONFIG_MISSING";
      throw error;
    }
    const items = [];
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      // 优先用上一轮的内存结论（无损），拿不到才退回从备注文本反推。
      const memoryResult = memoryForRow(idx);
      const hasDispute = isStage3DisputeRow(row, noteText, memoryResult);
      if (hasDispute) {
        if (config.continueOnly && (stageNoteState(noteText).arbitrated || memoryResult?.arbitration)) {
          status.skippedDone += 1;
          continue;
        }
        items.push(buildStage3Item(row, noteText, memoryResult));
      } else {
        status.skippedDone += 1;
      }
    }
    stageItems.stage3 = items;
    status.queued = items.length;
    pushLog(`阶段三 终审仲裁：共 ${items.length} 行复审分歧进入仲裁队列。`);
    if (items.length === 0) {
      pushLog("阶段三 终审仲裁：当前没有需要终审仲裁的分歧行。");
      finish();
      return clientStatus({ includeResults: false });
    }
    runQueue([], rows, config, labels, stageItems).catch((error) => {
      status.error = error.message || String(error);
      pushLog(status.error);
      finish();
    });
    return clientStatus({ includeResults: false });
  }

  // 对照表预处理：先于规则/相似度预筛运行——命中的行直接用表里的内容判定，不再交给模型。
  const resolvedByTermTable = applyTermTable(config, rows, labels);

  const resumedStage3 = plan.cascadeToArbiter && config.continueOnly
    ? collectResumedStage3(resolvedByTermTable)
    : { resumed: [], indexes: new Set() };
  stageItems.stage3 = resumedStage3.resumed;
  if (resumedStage3.resumed.length) {
    pushLog(`级联续跑：${resumedStage3.resumed.length} 行已有复审结论、只差仲裁，直接进入仲裁队列（不再重跑初审与复审）。`);
  }

  // 级联续跑：已经有初审结论、只差复审的行直接进复审队列，不再重跑初审。
  // 没有这一步，界面上「待复审 N 行」只能等初审把它们重新产出一遍，复审并发配得再高也派不出活来。
  // 只在「继续剩下的」时启用：「从未人工确认处开始」已经把这些行的备注清掉了，本来就没东西可续。
  let resumedStage2 = { resumed: [], indexes: new Set() };
  if (plan.cascadeToStylist && config.continueOnly) {
    resumedStage2 = collectResumedStage2(resolvedByTermTable);
    stageItems.stage2 = resumedStage2.resumed;
    if (resumedStage2.resumed.length) {
      pushLog(`级联续跑：${resumedStage2.resumed.length} 行已有初审结论、只差复审，直接进入复审队列（不再重跑初审）。`);
    }
  }

  for (const row of rows) {
    if (config.completedIndexes.has(Number(row.index))) {
      status.skippedDone += 1;
      continue;
    }
    if (resumedStage2.indexes.has(Number(row.index))) continue;
    if (resumedStage3.indexes.has(Number(row.index))) continue;
    if (resolvedByTermTable.has(Number(row.index))) continue;
    // 术语冲突行不吃规则/相似度预筛：这一行的术语判断必须由模型结合整句给出。
    if (!isTermConflictRow(config, row.index)) {
      const left = config.proofreadMode === "bilingual" ? (row.jp || "") : (row.cn || "");
      const right = config.proofreadMode === "bilingual" ? (row.cn || "") : (row.twCn || toCn(row.tw || ""));
      const classification = classifyPrefilter({
        source: row.jp || "",
        left,
        right,
        score: row.score,
      }, config.similarityThreshold);
      if (classification) {
        const prefilterKind = classification.kind === "similarity"
          ? "similarity"
          : (classification.kind === "structured-conflict" ? "structured-conflict" : "rule");
        addResult(makePrefilterResult(row, labels, classification, config.proofreadMode), { prefilterKind });
        continue;
      }
    }
    queue.push(row);
  }

  status.queued = queue.length + resumedStage2.resumed.length + resumedStage3.resumed.length;
  pushLog(`${config.proofreadMode === "bilingual" ? "双语版本校对" : "三语语境校对"}：人工确认跳过 ${status.skippedDone} 行，对照表跳过 ${status.termPrefiltered} 行，对照表注入术语 ${status.termInjected} 行（照常交给模型，含术语冲突行），规则跳过 ${status.rulePrefiltered} 行，结构化冲突 ${status.structuredConflicts} 行，相似度跳过 ${status.similarityPrefiltered} 行，术语冲突 ${status.termConflicts} 行不吃预筛、留给 AI 判断，剩余 ${queue.length} 行进入 AI 校对${resumedStage2.resumed.length ? `；另有 ${resumedStage2.resumed.length} 行续跑复审` : ""}${resumedStage3.resumed.length ? `；另有 ${resumedStage3.resumed.length} 行续跑仲裁` : ""}。`);
  pushLog(describeConcurrencyPolicy(config.concurrency));
  pushLog(describePolicy());
  runQueue(queue, rows, config, labels, stageItems).catch((error) => {
    status.error = error.message || String(error);
    pushLog(status.error);
    finish();
  });
  return clientStatus({ includeResults: false });
}

async function listModels(input = {}) {
  const config = cleanConfig({ ...input, model: input.model || "placeholder" });
  if (!config.baseUrl) throw new Error("请输入接口地址。");

  let modelsDevData = null;
  try {
    modelsDevData = await loadModelsDev();
  } catch {
    // 允许离线或网络受限时静默回退到 manifest 与启发式规则
  }

  try {
    const headers = buildProtocolHeaders(config);
    const candidates = buildModelUrlCandidates(config.baseUrl);
    const errors = [];
    for (const url of candidates) {
      try {
        const data = await fetchJson(url, {
          method: "GET",
          headers,
        }, { track: false, timeoutMs: 20000 });
        return { models: normalizeModelList(data.data || data.models || [], config.provider, modelsDevData), source: "remote", candidates };
      } catch (error) {
        errors.push(`${url}: ${error.message || String(error)}`);
      }
    }
    throw new Error(errors.join(" | "));
  } catch (error) {
    const fallback = modelFallbackForBaseUrl(config.baseUrl);
    if (fallback.length) {
      return {
        models: normalizeModelList(fallback, config.provider, modelsDevData),
        source: "fallback",
        candidates: buildModelUrlCandidates(config.baseUrl),
        warning: `模型列表接口不可用，已使用内置供应商模型列表。原始错误：${error.message || String(error)}`,
      };
    }
    throw error;
  }
}

async function testModel(input = {}) {
  const model = String(input.model || "").trim();
  const config = cleanConfig({ ...input, model: model || "placeholder" });
  if (!model) {
    return {
      ok: false,
      protocol: config.protocol,
      provider: config.provider,
      model: "",
      latencyMs: 0,
      error: "未选择或填写模型名称，请先选择或输入模型。",
      code: "MISSING_MODEL",
      httpStatus: null,
      message: "模型连通失败：未选择或填写模型名称，请先选择或输入模型。",
    };
  }
  return testModelConnectivity({
    protocol: config.protocol,
    provider: config.provider,
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model,
    reasoningEffort: config.reasoningEffort,
  });
}

function normalizeModelList(items, provider, modelsDevData = null) {
  const seen = new Set();
  const models = [];
  for (const item of items) {
    const id = String(item.id || item.name || item.model || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const caps = detectModelCapabilities(id, provider, modelsDevData, item);
    models.push({
      id,
      name: String(item.name || item.id || item.model || id),
      provider,
      reasoning: caps.reasoning,
      reasoningEfforts: caps.reasoningEfforts,
      supportsTemperature: caps.supportsTemperature,
      thinkingFormat: caps.thinkingFormat,
      source: caps.source,
    });
  }
  models.sort((a, b) => a.id.localeCompare(b.id, "en"));
  return models;
}

function buildModelUrlCandidates(baseUrl) {
  const trimmed = String(baseUrl || "").trim().replace(/\/+$/, "");
  if (!trimmed) return [];
  return [buildApiUrl(trimmed, "/v1/models")];
}

// buildApiUrl / buildProtocolHeaders 与共享传输层 (src/ai/llm-client.js) 同源。

function modelFallbackForBaseUrl(baseUrl) {
  const value = String(baseUrl || "");
  const fallback = knownModelFallbacks.find((item) => item.pattern.test(value));
  return fallback ? fallback.models : [];
}

function stopProofread() {
  if (!status.running) return clientStatus({ includeResults: false });
  status.stopRequested = true;
  pushLog(status.kind === "prefilter" ? "收到终止请求，正在停止预筛选。" : "收到终止请求，正在停止新的 AI 调用。");
  for (const controller of controllers) controller.abort();
  if (typeof currentQueueWakeup === "function") {
    currentQueueWakeup();
  }
  return clientStatus({ includeResults: false });
}

// 运行中改预设集合：删掉的预设，它的待审行立刻改派给其余预设；新加的预设立刻抢活。
// 任务没在跑时抛 NOT_RUNNING——那种情况下改动会在下次启动时随请求体一起生效。
function updateStagePresets(payload = {}) {
  // 只对正在跑的 AI 校对任务开放：预筛走的是另一条队列，没有阶段预设池可改。
  if (!status.running || status.kind === "prefilter" || typeof activePresetPoolUpdater !== "function") {
    const error = new Error("当前没有正在运行的 AI 校对任务：预设改动会在下次启动时生效。");
    error.code = "NOT_RUNNING";
    throw error;
  }
  const stage = payload.stage === "stage2" ? "stage2" : (payload.stage === "stage3" ? "stage3" : "stage1");
  const presets = cleanStagePresetPool(payload.presets, null, {}, AI_CONCURRENCY_LIMITS.defaultConcurrency);
  const result = activePresetPoolUpdater(stage, presets);
  return {
    stage,
    added: result.added,
    removed: result.removed,
    fallback: result.fallback,
    rejected: Boolean(result.rejected),
    ai: clientStatus({ includeResults: false }),
  };
}

function clearProofreadCache() {
  if (status.running) {
    const error = new Error(status.kind === "prefilter" ? "预筛选正在运行，请先停止任务再清除缓存。" : "AI 校对正在运行，请先停止任务再清除缓存。");
    error.code = "RUNNING";
    throw error;
  }
  // 「清除 AI 运行记录」必须连落盘的一份一起清：否则刷新页面时它又会被装回来。
  resetIdleStatus({ clearPersisted: true });
  return clientStatus();
}

let currentQueueWakeup = null;
// 运行中的预设池热更新入口：runQueue 挂上，任务结束时摘掉（见 updateStagePresets）。
let activePresetPoolUpdater = null;

function isConcurrencyOrRateLimitError(error) {
  if (!error) return false;
  if (isModelRefusalError(error)) return false;

  const httpStatus = Number(error.httpStatus || error.status || error.statusCode);
  if (httpStatus === 429 || httpStatus === 503 || httpStatus === 529) return true;

  const code = String(error.code || "").toUpperCase();
  if (
    code === "RATE_LIMIT" ||
    code === "RATE_LIMIT_EXCEEDED" ||
    code === "TOO_MANY_REQUESTS" ||
    code === "RESOURCE_EXHAUSTED" ||
    code === "OVERLOADED" ||
    code === "CONCURRENCY_LIMIT"
  ) {
    return true;
  }

  const textToCheck = [
    error.message,
    error.responseBody,
    error.error?.message,
    typeof error.cause === "object" ? error.cause?.message : "",
  ].filter(Boolean).join(" ").toLowerCase();

  const rateLimitPatterns = [
    "rate_limit",
    "rate limit",
    "ratelimit",
    "too many requests",
    "requests per minute",
    "requests per second",
    "requests per day",
    "requests per hour",
    "tokens per minute",
    "concurrency limit",
    "concurrency exceeded",
    "exceeded concurrency",
    "quota exceeded",
    "exceeded your quota",
    "exceeded your current quota",
    "resource_exhausted",
    "resource exhausted",
    "overloaded",
    "temporarily overloaded",
    "server is overloaded",
    "service is overloaded",
    "slow down",
    "try again in ",
  ];

  return rateLimitPatterns.some((pattern) => textToCheck.includes(pattern));
}

function parseRateLimitReason(error) {
  if (!error) return "频控限制";
  if (error.httpStatus === 429) return "HTTP 429 请求频次超限";
  if (error.httpStatus === 529) return "HTTP 529 服务过载";
  if (error.httpStatus === 503) return "HTTP 503 服务暂时不可用";
  const text = [error.message, error.responseBody].filter(Boolean).join(" ");
  if (/concurrency/i.test(text)) return "并发超限";
  if (/tokens? per minute|tpm/i.test(text)) return "Token 速率限制 (TPM)";
  if (/requests? per|rpm/i.test(text)) return "请求速率限制 (RPM)";
  if (/quota/i.test(text)) return "额度频控限制";
  if (/overloaded/i.test(text)) return "服务端负载过高";
  return "接口频控限制";
}

// all 模式只有在阶段二真的配了模型时才级联：否则 runStage2Stylist 会回落主配置，
// 等于背着用户多跑一轮复审。抽成纯函数是为了让这条前提能被直接断言。
// 阶段编排只有两个输入：从哪一段起步（targetStage），以及这条流水线到底有几段（下游配没配模型）。
// 行为统一为「从起点一路推进到已启用的尽头」——只跑单阶段就是下游没配模型，
// 不再有「级联 / 不级联」的模式开关：那会让「阶段一 开始」这一个按钮同时表示两件事。
function stagePlan(config = {}) {
  const persona = Boolean(config.singleModelPersona);
  const hasStylist = Boolean(config.stylistConfig) || persona;
  const hasArbiter = (Boolean(config.arbiterConfig) || persona) && config.arbiterEnabled !== false;
  // "all" 是旧客户端传来的兼容值，语义等同「从阶段一起步」。
  const startsAt = config.targetStage === "stage2" ? "stage2"
    : (config.targetStage === "stage3" ? "stage3" : "stage1");
  return {
    startsAt,
    // 从阶段一起步时初审产出的行继续往下走；从阶段二起步时复审产生的分歧继续往下走。
    // 仲裁只能接在复审后面，所以从阶段一起步时必须先有复审才谈得上仲裁。
    cascadeToStylist: startsAt === "stage1" && hasStylist,
    // 语义是「本次流水线覆盖到仲裁」，不是「有没有下游可级联」：从阶段三起步时本次跑的就是仲裁，
    // 报 false 会让客户端把阶段三卡片误显示成「未接入」，而仲裁其实正在一行行跑。
    cascadeToArbiter: startsAt === "stage3"
      ? hasArbiter
      : ((startsAt === "stage1" ? hasStylist : startsAt === "stage2") && hasArbiter),
  };
}

function shouldCascadeStages(config = {}) {
  return stagePlan(config).cascadeToStylist;
}

async function runQueue(queue, allRows, config, labels, stageItems = {}) {
  // 流水线阶段解耦队列（Staged Pipelining Queues）
  // 各阶段独立并发、独立退避：stage1 初审完一行就把它推给 stage2Pending，
  // stage2 复审出分歧就推给 stage3Pending，谁都不必等前一阶段整体收尾。
  const plan = stagePlan(config);
  const stage1Pending = plan.startsAt === "stage1" ? [...queue] : [];
  // 阶段二的初始队列：从阶段二起步时是本次筛出的复审行；从阶段一起步且配了复审时，
  // 是「已有初审结论、只差复审」的续跑行——它们与初审刚产出的行走同一个队列、同一套并发。
  const stage2Pending = (plan.startsAt === "stage2" || plan.cascadeToStylist) ? [...(stageItems.stage2 || [])] : [];
  const stage3Pending = (plan.startsAt === "stage3" || plan.cascadeToArbiter) ? [...(stageItems.stage3 || [])] : [];

  let stage1InFlight = 0;
  let stage2InFlight = 0;
  let stage3InFlight = 0;

  // 复审完成的实时计数（复审一结束就 +1，不等它仲裁定案）：只服务运行中的实时显示，
  // 任务结束时 status.stagePipelines 会被 finish() 重置，最终统计仍以 stageMetrics 为准。
  let stage2ReviewedLive = 0;
  const stage2AttitudesLive = { accept: 0, modify: 0, reject: 0, escalate: 0 };

  const minConcurrency = 1;
  const maxRowRetries = 3;
  // 上探最短间隔可被环境变量缩短，仅供回归测试把秒级间隔压到毫秒级；不是运行时开关。
  const policy = {
    ...CONCURRENCY_POLICY,
    minStepIntervalMs: Number(process.env.TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL) || CONCURRENCY_POLICY.minStepIntervalMs,
  };
  // 过载型失败：并发过高时最典型的三种表现。拒答、坏 JSON、认证/配置错误都不是并发造成的，不参与。
  const overloadKinds = new Set(["timeout", "server_error", "network"]);

  // 各阶段的并发上限来自各自的预设（config.stylistConfig / arbiterConfig 的 concurrency）；没配预设时回落到默认。
  const createStageCtrl = (stageKey, label, conf, defaultConcurrency) => createStageController({
    stageKey,
    label,
    config: conf,
    fallbackConcurrency: defaultConcurrency,
    clampInteger,
  });

  const s1Ctrl = createStageCtrl("stage1", "初审", config, config.concurrency);
  const s2Ctrl = createStageCtrl("stage2", "文学复审", config.stylistConfig, config.concurrency);
  const s3Ctrl = createStageCtrl("stage3", "终审仲裁", config.arbiterConfig, 2);
  s1Ctrl.presetId = String(config.presetId || "主配置");
  s2Ctrl.presetId = String(config.stylistConfig?.presetId || "阶段二");
  s3Ctrl.presetId = String(config.arbiterConfig?.presetId || "阶段三");
  const stageCtrls = { stage1: s1Ctrl, stage2: s2Ctrl, stage3: s3Ctrl };

  // 每个预设一条独立的并发通道：预设各配各的并发上限，阶段总并发是各通道之和。
  // 只用一个阶段控制器时，多预设会被「第一个预设（或主配置）的上限」卡住——界面选了 3 个预设、
  // 每个 3 并发，实际却只有 3 个请求在飞，预设的独立并发等于没生效。
  // 通道仍承担该预设自己的慢启动、上探、下调与熔断塌缩；阶段控制器只留退避窗口与重试计数。
  const createStageChannel = (stageKey, label, defaultConcurrency) => (preset, index, total) => {
    const channel = createStageController({
      stageKey,
      label,
      config: preset,
      fallbackConcurrency: defaultConcurrency,
      clampInteger,
    });
    // 多预设时并发日志要能区分是哪条连接在升降，否则三行「初审：并发从 3 翻倍至 6」看不出是谁。
    channel.presetId = String(preset.presetId || "");
    channel.presetLabel = total > 1 ? String(preset.name || preset.presetId || `预设 ${index + 1}`) : "";
    return channel;
  };

  const pools = {
    stage1: createPresetPool(
      config.presetPool?.length ? config.presetPool : [{ ...config, presetId: config.presetId || "主配置", name: config.presetName || "主配置" }],
      config,
      { createChannel: createStageChannel("stage1", "初审", config.concurrency) }
    ),
    stage2: createPresetPool(config.stylistPresets, config.stylistConfig, {
      createChannel: createStageChannel("stage2", "文学复审", config.concurrency),
    }),
    stage3: createPresetPool(config.arbiterPresets, config.arbiterConfig, {
      createChannel: createStageChannel("stage3", "终审仲裁", 2),
    }),
  };
  for (const stage of Object.keys(pools)) status.presetPipelines[stage] = pools[stage].snapshot();

  const activeBreakerStages = new Set([plan.startsAt]);
  if (plan.cascadeToStylist) activeBreakerStages.add("stage2");
  if (plan.cascadeToArbiter) activeBreakerStages.add("stage3");
  breakerRuntime = {
    pools,
    activeStages: activeBreakerStages,
    brokenStages: new Set(),
    syncQueues: null,
  };

  // 这一行的并发通道：派发时按预设绑定，成功/失败都回它自己的通道做升降。
  const channelFor = (stageKey, presetId) => pools[stageKey].channelOf(presetId) || stageCtrls[stageKey];
  // 阶段可派发量 = 各预设通道当前允许并发之和（没配预设时退回阶段控制器）。
  const stageAllowance = (stageKey) => pools[stageKey].totalQuota() || stageCtrls[stageKey].currentConcurrency;
  const stageAllowanceMax = (stageKey) => pools[stageKey].totalMaxQuota() || stageCtrls[stageKey].maxConcurrency;

  function syncPresetPipelines() {
    for (const stage of Object.keys(pools)) {
      status.presetPipelines[stage] = pools[stage].snapshot().map((item) => ({
        ...item,
        breakerState: isPresetBreakerTripped(stage, item.presetId)
          ? "tripped"
          : stageBreaker(stage, item.presetId).state,
        breakerTripped: isPresetBreakerTripped(stage, item.presetId),
      }));
    }
  }

  status.concurrency = pools.stage1.totalInitialQuota() || s1Ctrl.initialConcurrency;
  status.currentConcurrency = stageAllowance("stage1");
  status.concurrencyMax = stageAllowanceMax("stage1");
  status.peakConcurrency = status.currentConcurrency;
  status.concurrencyUps = 0;
  status.concurrencyDowns = 0;
  status.concurrencyLimits = 0;

  // 上一次整队分配时各预设池的版本：版本变了（运行中增删过预设）才整队重算绑定，
  // 稳态下沿用原有绑定，避免每轮派发都无谓地重排。
  const assignedPoolVersions = { stage1: -1, stage2: -1, stage3: -1 };

  function syncStagePipelineQueues() {
    const queues = { stage1: stage1Pending, stage2: stage2Pending, stage3: stage3Pending };
    for (const stageKey of Object.keys(queues)) {
      const pool = pools[stageKey];
      const reassign = assignedPoolVersions[stageKey] !== pool.version;
      assignedPoolVersions[stageKey] = pool.version;
      assignPendingPresetIds(pool, queues[stageKey], {
        reassign,
        isEligible: (preset) => !isPresetBreakerTripped(stageKey, preset?.presetId),
      });
    }
    // 触顶计数与预设总数：页面据此区分「N/M 触顶」与「全部触顶」，
    // 不在客户端重算一遍触顶口径。
    const presetSummary = (stageKey) => ({
      presetCount: pools[stageKey].presets.length,
      toppedCount: pools[stageKey].toppedCount(),
      breakerTrippedCount: currentStagePresetIds(stageKey).filter((id) => isPresetBreakerTripped(stageKey, id)).length,
      breakerBroken: isStageBreakerBroken(stageKey),
    });
    status.stagePipelines.stage1.pending = stage1Pending.length;
    status.stagePipelines.stage1.inFlight = stage1InFlight;
    status.stagePipelines.stage1.concurrency = stageAllowance("stage1");
    status.stagePipelines.stage1.concurrencyMax = stageAllowanceMax("stage1");
    Object.assign(status.stagePipelines.stage1, presetSummary("stage1"));

    status.stagePipelines.stage2.pending = stage2Pending.length;
    status.stagePipelines.stage2.inFlight = stage2InFlight;
    status.stagePipelines.stage2.reviewed = stage2ReviewedLive;
    status.stagePipelines.stage2.attitudes = { ...stage2AttitudesLive };
    status.stagePipelines.stage2.concurrency = stageAllowance("stage2");
    status.stagePipelines.stage2.concurrencyMax = stageAllowanceMax("stage2");
    Object.assign(status.stagePipelines.stage2, presetSummary("stage2"));

    status.stagePipelines.stage3.pending = stage3Pending.length;
    status.stagePipelines.stage3.inFlight = stage3InFlight;
    status.stagePipelines.stage3.concurrency = stageAllowance("stage3");
    status.stagePipelines.stage3.concurrencyMax = stageAllowanceMax("stage3");
    Object.assign(status.stagePipelines.stage3, presetSummary("stage3"));
    syncPresetPipelines();
  }
  breakerRuntime.syncQueues = syncStagePipelineQueues;
  syncStagePipelineQueues();
  if (plan.cascadeToStylist) {
    pushLog(`级联流水线：从阶段一起步，初审完一行立即移交复审（并发上限 ${stageAllowanceMax("stage2")}）${plan.cascadeToArbiter ? `，复审出分歧立即移交仲裁（并发上限 ${stageAllowanceMax("stage3")}）` : "，阶段三终审仲裁未启用"}，不等前一阶段整体跑完。`);
  } else if (plan.cascadeToArbiter) {
    pushLog(`级联流水线：从阶段二起步，复审出分歧立即移交仲裁（并发上限 ${stageAllowanceMax("stage3")}），不等复审整体跑完。`);
  }

  // 并发变了：同步状态接口里的实时并发与峰值（状态接口的 currentConcurrency 只代表初审）。
  // 多预设时这里是各通道之和，单个预设时就是那一条通道，口径与派发上限一致。
  function syncConcurrency() {
    const total = stageAllowance("stage1");
    status.peakConcurrency = Math.max(status.peakConcurrency, total);
    status.currentConcurrency = total;
  }

  // 运行中增删预设：把新集合应用到池上，立刻重排队列并唤醒派发。
  // 在飞的请求不打断（已经发出去的结果不浪费），但它不再拿到新活；
  // 被删预设腾出来的待审行会立刻按积压均衡改派给其余预设，新预设则立刻开始抢活。
  function applyPresetPoolUpdate(stageKey, incomingPresets) {
    const pool = pools[stageKey];
    const incoming = normalizePresetPool(incomingPresets);
    // 删空即回落到该阶段的兜底连接（阶段一 → 主配置，阶段二/三 → 各自的单预设配置）：
    // 否则这一阶段的队列会悬在半空，任务永远跑不完。
    const fallbackConf = stageKey === "stage1"
      ? { ...config, presetId: config.presetId || "主配置", name: config.presetName || "主配置" }
      : (stageKey === "stage2" ? config.stylistConfig : config.arbiterConfig);
    const target = incoming.length ? incoming : normalizePresetPool([fallbackConf].filter(Boolean));
    // 连兜底配置都没有（这一阶段本来就没配过模型）：拒绝这次改动，
    // 否则这一阶段的队列会悬空，任务永远跑不完。
    if (!target.length) return { added: [], removed: [], fallback: false, rejected: true };
    const targetIds = new Set(target.map((item) => item.presetId));

    const removed = [];
    for (const presetId of [...pool.state.keys()]) {
      if (targetIds.has(presetId)) continue;
      if (pool.removePreset(presetId)) removed.push(presetId);
    }
    const added = [];
    for (const preset of target) {
      if (pool.state.has(preset.presetId)) continue;
      if (pool.addPreset(preset)) added.push(preset.presetId);
    }
    const fallbackApplied = !incoming.length && target.length > 0;
    if (!removed.length && !added.length) return { added, removed, fallback: fallbackApplied };

    // 运行中加入健康预设后，阶段不再是「全部熔断」；新预设应立即接手待派发队列。
    if (!isStageBreakerBroken(stageKey)) breakerRuntime?.brokenStages?.delete(stageKey);

    // 池的 version 已变：这次 sync 会整队重算绑定（新预设分到活、被删预设的行让出去），
    // 再唤醒派发让新增的并发立刻用起来。
    syncStagePipelineQueues();
    if (typeof currentQueueWakeup === "function") currentQueueWakeup();
    const label = STAGE_OUTCOME_LABELS[stageKey] || stageKey;
    if (added.length) {
      pushLog(`[预设池] ${label}：运行中加入 ${added.length} 个预设，立刻参与派发。`);
    }
    if (removed.length) {
      pushLog(`[预设池] ${label}：运行中移除 ${removed.length} 个预设，其待审行已改派给其余预设；在飞的请求跑完即止。`);
    }
    if (fallbackApplied) {
      pushLog(`[预设池] ${label}：预设已全部移除，回落到阶段配置继续跑完剩余行。`);
    }
    return { added, removed, fallback: fallbackApplied };
  }
  activePresetPoolUpdater = (stageKey, presets) => applyPresetPoolUpdate(stageKey, presets);

  // 多预设时日志带上预设名：否则「初审：并发从 3 翻倍至 6」重复出现，分不清是哪条连接。
  const stageTag = (ctrl) => (ctrl.presetLabel
    ? `${ctrl.label}·${ctrl.presetLabel}：`
    : (ctrl.stageKey === "stage1" ? "" : `${ctrl.label}：`));

  // 上游正常应答：喂给该预设自己的调度器判断要不要上探。失败窗口逼近熔断线（pressure）时
  // 只暂停这一条预设的上探，状态翻转时各记一行日志，让用户看得到「并发为什么停在这儿」。
  function onStageSuccess(ctrl) {
    const wasPaused = ctrl.rampPaused;
    const step = stepUpOnSuccess(ctrl, { pressure: stageBreaker(ctrl.stageKey, ctrl.presetId).pressure, policy });
    if (ctrl.rampPaused !== wasPaused) {
      pushLog(ctrl.rampPaused
        ? `[并发调度] ${stageTag(ctrl)}失败率已逼近熔断线，暂停上探，并发维持 ${ctrl.currentConcurrency}。`
        : `[并发调度] ${stageTag(ctrl)}失败率回落，恢复上探。`);
    }
    if (!step) return;
    status.concurrencyUps += 1;
    syncConcurrency();
    pushLog(step.mode === "slow-start"
      ? `[并发调度] ${stageTag(ctrl)}一整轮请求全部正常，并发从 ${step.from} 翻倍至 ${step.to}（上限 ${ctrl.maxConcurrency}）。`
      : `[并发调度] ${stageTag(ctrl)}连续 ${step.successes} 次请求正常，并发从 ${step.from} 上探至 ${step.to}（上限 ${ctrl.maxConcurrency}）。`);
  }

  // 成功既喂该预设的断路器，也可能顺带解除它设下的冷却（迟到的成功说明上游已经放行）。
  function noteStageSuccess(channel) {
    clearCooldownIf(channel, recordStageSuccess(channel.stageKey, channel.presetId));
    onStageSuccess(channel);
  }

  // 断路器恢复：撤销冷却窗口，并把退避档位归零。
  // consecutiveLimits 只由成功清零，若停在最大档，恢复后的下一次 429 仍会按最长退避。
  function clearCooldownIf(ctrl, recovered) {
    if (!recovered) return;
    ctrl.backoffUntil = Math.min(ctrl.backoffUntil, Date.now());
    ctrl.consecutiveLimits = 0;
    if (ctrl.backoffTimer) {
      clearTimeout(ctrl.backoffTimer);
      ctrl.backoffTimer = null;
    }
  }

  let dispatchWake = null;

  // 半开探测期（冷却已过、尚未收到非限流答复）每个预设只放行一个请求；
  // 健康预设不受这条通道的半开状态影响。
  function scheduleBackoffWake(stageKey, ctrl) {
    if (!ctrl || ctrl.backoffTimer) return;
    const waitMs = Math.max(10, ctrl.backoffUntil - Date.now());
    if (waitMs <= 0) return;
    ctrl.backoffTimer = setTimeout(() => {
      ctrl.backoffTimer = null;
      dispatchWake?.();
    }, waitMs);
  }

  function presetCanDispatch(stageKey, item) {
    const presetId = item?.presetId;
    if (!presetId || isPresetBreakerTripped(stageKey, presetId)) return false;
    const breaker = stageBreaker(stageKey, presetId);
    const channel = item.channel || stageCtrls[stageKey];
    if (!channel || Date.now() < channel.backoffUntil) {
      scheduleBackoffWake(stageKey, channel);
      return false;
    }
    if (breaker.state === "open") {
      // 断路器冷却由 onStageRateLimit 写入 channel.backoffUntil；这里再兜底一次，
      // 防止旧任务或迟到结果把通道留在 open 状态却没有定时器唤醒。
      scheduleBackoffWake(stageKey, channel);
      return false;
    }
    // pool.next 已经按 channel.currentConcurrency 检查在飞数；半开时再收紧到单发。
    return breaker.state !== "half-open" || item.inFlight < 1;
  }

  // 过载型失败（超时 / 5xx / 断连）：并发下调一档。这类失败不重试、也不退避，但它们会进熔断的失败窗口，
  // 提前把并发压下来是为了在「错误率熔断」终止任务之前先把失败率压回去。返回是否属于过载型。
  function onStageOverload(channel, rowIndex, error, startedAt) {
    const kind = classifyAiError(error);
    if (!overloadKinds.has(kind)) return false;
    const step = stepDownOnOverload(channel, { startedAt, minConcurrency, policy });
    if (step) {
      status.concurrencyDowns += 1;
      syncConcurrency();
      syncStagePipelineQueues();
      pushLog(`[并发调度] ${stageTag(channel)}第 ${rowIndex} 行遭遇${AI_ERROR_KIND_LABELS[kind]}，并发从 ${step.from} 下调至 ${step.to}，先缓解上游压力。`);
    }
    return true;
  }

  // channel 负责这一行所属预设的并发升降、退避窗口与单行重试计数；
  // 不再把某个预设的限流状态写入同阶段共享控制器。
  function onStageRateLimit(channel, rowIndex, error, pendingQueue, itemToRetry, startedAt, stageCtrl) {
    const retryCtrl = channel || stageCtrl;
    status.concurrencyLimits += 1;
    retryCtrl.consecutiveLimits += 1;

    const step = stepDownOnLimit(channel, { startedAt, minConcurrency, policy });
    if (step) {
      status.concurrencyDowns += 1;
      syncConcurrency();
    }

    const retries = (retryCtrl.rowRetryCounts.get(rowIndex) || 0) + 1;
    retryCtrl.rowRetryCounts.set(rowIndex, retries);

    // 生产环境保留随机抖动，避免多个客户端在同一时刻重试；测试可把上限设为 0，
    // 只验证退避与断路器状态转换而不为随机等待付出时间成本。
    const jitterLimit = Number(process.env.TRANSCOMPARATOR_RETRY_JITTER_MS);
    const jitterMs = Number.isFinite(jitterLimit) && jitterLimit >= 0 ? jitterLimit : 500;
    const delayMs = backoffDelayMs(retryCtrl.consecutiveLimits, error.retryAfter)
      + (jitterMs > 0 ? Math.floor(Math.random() * jitterMs) : 0);
    retryCtrl.backoffUntil = Math.max(retryCtrl.backoffUntil, Date.now() + delayMs);
    scheduleBackoffWake(channel.stageKey, retryCtrl);

    if (shouldRetryRow(retries, maxRowRetries, status.stopRequested)) {
      const stageNamePart = channel.stageKey === "stage1" ? "" : `${channel.label}`;
      pushLog(`[频控退避] 第 ${rowIndex} 行${stageNamePart}遭遇${parseRateLimitReason(error)}，并发下调至 ${stageAllowance(channel.stageKey)}，退避 ${(delayMs / 1000).toFixed(1)} 秒后进行第 ${retries}/${maxRowRetries} 次重试。`);
      pendingQueue.unshift(itemToRetry);
      syncStagePipelineQueues();
      return true;
    }

    // 单行重试已用尽：交给该预设自己的断路器裁决是「记这一行失败」「该预设冷却」还是「预设熔断」。
    if (status.stopRequested) return false;
    const verdict = stageBreaker(channel.stageKey, channel.presetId).recordLimitExhausted();
    if (verdict.action === "fail") return false;
    if (verdict.action === "trip") {
      stopForBreakerTrip(verdict, channel.stageKey, channel.presetId);
      return false;
    }
    // 冷却：这一行没有真正被处理过，不记失败，回到队头等冷却结束；
    // 重试计数置满，让它成为「单发探测」——再被限流就立刻回报断路器，而不是再烧一轮退避。
    retryCtrl.rowRetryCounts.set(rowIndex, maxRowRetries);
    retryCtrl.backoffUntil = Math.max(retryCtrl.backoffUntil, verdict.until);
    scheduleBackoffWake(channel.stageKey, retryCtrl);
    pendingQueue.unshift(itemToRetry);
    if (verdict.opened) {
      // 联动：只有当前预设的断路器打开时，塌缩当前预设通道；同阶段其它预设保持运行。
      const collapsedFrom = channel.currentConcurrency;
      const collapsedTo = collapseForBreaker(channel, { minConcurrency, policy }).to;
      if (collapsedFrom > collapsedTo) {
        status.concurrencyDowns += 1;
        syncConcurrency();
      }
      const restartTarget = Math.max(0, Number(channel.slowStartThreshold) || 0);
      const label = presetBreakerLabel(channel.stageKey, channel.presetId);
      const attempt = `第 ${verdict.cycle}/${verdict.cycles} 档`;
      pushLog(verdict.cycle === 1
        ? `[熔断] ${label}：连续多行限流重试用尽，暂停派发 ${formatDuration(verdict.cooldownMs)}（${attempt}冷却），冷却后单发探测；已完成的行不受影响。`
        : `[熔断] ${label}：探测仍被限流，继续冷却 ${formatDuration(verdict.cooldownMs)}（${attempt}冷却）。`);
      // 只在第一档冷却说明一次：后续档位并发早已是最低，重复播报没有信息量。
      if (verdict.cycle === 1) {
        pushLog(`[并发调度] ${label}：熔断冷却，并发降到 ${collapsedTo}（冷却前 ${collapsedFrom}）；恢复后从 ${collapsedTo} 起步慢启动，先爬到 ${restartTarget}，再逐步上探（上限 ${channel.maxConcurrency}）。`);
      }
    }
    syncStagePipelineQueues();
    return true;
  }

  return new Promise((resolve) => {
    let settled = false;

    function clearAllTimers() {
      const seen = new Set();
      for (const stageKey of Object.keys(pools)) {
        const controls = [stageCtrls[stageKey], ...pools[stageKey].channels()];
        for (const ctrl of controls) {
          if (!ctrl || seen.has(ctrl)) continue;
          seen.add(ctrl);
          if (ctrl.backoffTimer) {
            clearTimeout(ctrl.backoffTimer);
            ctrl.backoffTimer = null;
          }
        }
      }
    }

    function checkDone() {
      if (settled) return;
      // 阶段全部预设熔断后，队列中的剩余行无法再派发；把它视为该阶段已排空，
      // 但仍等待已经发出的请求收尾，并让其它健康阶段继续运行。
      const stageDrained = (stageKey, pending, inFlight) =>
        (pending.length === 0 && inFlight === 0) || (isStageBreakerBroken(stageKey) && inFlight === 0);
      const allEmpty = stageDrained("stage1", stage1Pending, stage1InFlight)
        && stageDrained("stage2", stage2Pending, stage2InFlight)
        && stageDrained("stage3", stage3Pending, stage3InFlight);

      if (status.stopRequested || allEmpty) {
        settled = true;
        clearAllTimers();
        dispatchWake = null;
        currentQueueWakeup = null;
        activePresetPoolUpdater = null;
        finish();
        resolve();
      }
    }

    currentQueueWakeup = () => {
      clearAllTimers();
      dispatch();
    };

    function dispatch() {
      if (status.stopRequested || settled) {
        checkDone();
        return;
      }

      // 1. 优先调度 Stage 3 (Arbiter 终审仲裁)，尽快完成已产生分歧的行
      while (stage3Pending.length > 0 && !status.stopRequested && !settled) {
        const preset = pools.stage3.next((item) => presetCanDispatch("stage3", item));
        if (!preset) break;
        const s2Item = stage3Pending.shift();
        s2Item.presetId = preset.presetId;
        s2Item.presetConfig = pools.stage3.presets.find((item) => item.presetId === preset.presetId);
        pools.stage3.begin(preset.presetId, s2Item.row.index);
        stage3InFlight += 1;
        syncStagePipelineQueues();
        executeStage3(s2Item);
      }

      // 2. 调度 Stage 2 (Stylist 文学复审)，消费 Stage 1 已经初审完且建议修改的行
      while (stage2Pending.length > 0 && !status.stopRequested && !settled) {
        const preset = pools.stage2.next((item) => presetCanDispatch("stage2", item));
        if (!preset) break;
        const s1Item = stage2Pending.shift();
        s1Item.presetId = preset.presetId;
        s1Item.presetConfig = pools.stage2.presets.find((item) => item.presetId === preset.presetId);
        pools.stage2.begin(preset.presetId, s1Item.row.index);
        stage2InFlight += 1;
        syncStagePipelineQueues();
        executeStage2(s1Item);
      }

      // 3. 调度 Stage 1 (Gatekeeper 事实初审)
      while (stage1Pending.length > 0 && !status.stopRequested && !settled) {
        const preset = pools.stage1.next((item) => presetCanDispatch("stage1", item));
        if (!preset) break;
        const row = stage1Pending.shift();
        row.presetConfig = pools.stage1.presets.find((item) => item.presetId === preset.presetId);
        row.presetId = preset.presetId;
        pools.stage1.begin(preset.presetId, row.index);
        stage1InFlight += 1;
        syncStagePipelineQueues();
        executeStage1(row);
      }

      checkDone();
    }

    dispatchWake = dispatch;

    async function executeStage1(row) {
      status.active.push(row.index);
      status.stagePipelines.stage1.activeRows.push(row.index);
      syncStagePipelineQueues();
      // 这一行正在被（重新）处理：先撤掉它上一次的初审异常明细，成功就不再补记，失败才重新登记。
      clearStageError("stage1", row.index);
      // 这一行派给哪个预设，成功/失败就回哪条并发通道做升降（阶段控制器只留退避窗口）。
      const channel = channelFor("stage1", row.presetId);
      // 请求发出时间：catch 里判断「这次失败是不是下调之前发出的请求」（同一次拥塞事件只下调一次）。
      const requestStartedAt = Date.now();
      try {
        const s1 = await runStage1Gatekeeper(row, allRows, config, labels);
        if (!status.stopRequested) {
          noteStageSuccess(channel);
        }

        const isNeedsEdit = Boolean(s1.decision?.needsEdit && (s1.decision?.revisedText || s1.decision?.better === "counterpart" || s1.decision?.better === "neither"));
        const isUnclearOrNeedsContext = s1.decision?.needsContext === true || s1.decision?.better === "unclear" || s1.decision?.decision === "unclear";
        // 认知审核新契约：无需修改且非存疑行 Fast Pass 放行直接完成；提改行与存疑待判行在级联模式下均流入 Stage 2！
        const canCascadeToStage2 = plan.cascadeToStylist && (isNeedsEdit || isUnclearOrNeedsContext);

        if (!canCascadeToStage2) {
          // 命中无需修改直通放行，或这条流水线没有下游：无需 Stage 2，直接完成输出
          const result = finalizeRowResult(s1, config);
          addResult(result);
          status.active = status.active.filter((idx) => idx !== row.index);
        } else {
          // 提改行与存疑待判行均推入 Stage 2 文学复审队列！
          stage2Pending.push(s1);
          syncStagePipelineQueues();
          if (isUnclearOrNeedsContext) {
            pushLog(`第 ${row.index} 行：事实初审判定存疑待定，移交 Stage 2 (Stylist 文学复审队列进一步审查)。`);
          } else {
            pushLog(`第 ${row.index} 行：事实初审提出修改，移交 Stage 2 (Stylist 文学复审队列)。`);
          }
        }
      } catch (error) {
        const isRefusal = isModelRefusalError(error);
        // 频控识别与并发调度无关：任何并发上限下 429 都要退避重试，不能当成普通失败一路刷到队列尽头。
        const isRateLimit = !isRefusal && isConcurrencyOrRateLimitError(error) && !status.stopRequested;
        const fatalRequestError = !isRefusal && !isRateLimit && isFatalRequestError(error) && !status.stopRequested;

        if (isRefusal) {
          clearCooldownIf(channel, recordStageNotLimited("stage1", channel.presetId));
          status.modelRefusals += 1;
          const targetKey = config.proofreadMode === "bilingual" ? "cn" : config.target;
          addResult(makeRefusalResult(row, error, targetKey));
          pushLog(`第 ${row.index} 行：模型拒答（内容安全审查），已自动跳过并标记待终审。`);
          status.active = status.active.filter((idx) => idx !== row.index);
        } else if (isRateLimit) {
          const retried = onStageRateLimit(channel, row.index, error, stage1Pending, row, requestStartedAt, s1Ctrl);
          if (!retried) {
            pushLog(`[频控退避] 第 ${row.index} 行连续 ${maxRowRetries} 次触发频控限制，已达到最大重试次数，标记为调用失败。`);
            recordStageError("stage1", row.index, error, "rate_limit");
            addResult({
              runId: status.runId,
              index: row.index,
              signature: rowSignature(row),
              stage: "stage1",
              status: "error",
              done: false,
              note: `[AI校对]\n调用失败（频控限制已达重试上限）：${error.message || String(error)}`,
            });
          }
          status.active = status.active.filter((idx) => idx !== row.index);
        } else {
          const isStopped = status.stopRequested && !fatalRequestError;
          recordStageError("stage1", row.index, error, isStopped ? "stopped" : "");
          addResult({
            runId: status.runId,
            index: row.index,
            signature: rowSignature(row),
            stage: "stage1",
            status: isStopped ? "stopped" : "error",
            done: false,
            note: `[AI校对]\n${isStopped ? "校对已终止。" : `调用失败：${error.message || String(error)}`}`,
          });
          if (fatalRequestError) {
            stopForFatalRequestError(error);
          } else if (!status.stopRequested) {
            onStageOverload(channel, row.index, error, requestStartedAt);
            clearCooldownIf(channel, recordStageFailure("stage1", channel.presetId));
          }
          status.active = status.active.filter((idx) => idx !== row.index);
        }
      } finally {
        pools.stage1.finish(row.presetId, row.index, { ok: !status.stageErrors.stage1[row.index] });
        status.stagePipelines.stage1.activeRows = status.stagePipelines.stage1.activeRows.filter((idx) => idx !== row.index);
        stage1InFlight -= 1;
        syncStagePipelineQueues();
        dispatch();
      }
    }

    async function executeStage2(s1Item) {
      if (!status.active.includes(s1Item.row.index)) status.active.push(s1Item.row.index);
      status.stagePipelines.stage2.activeRows.push(s1Item.row.index);
      syncStagePipelineQueues();
      // 与初审对称：这一行正在被（重新）复审，先撤掉上一次的复审异常明细，失败才重新登记。
      clearStageError("stage2", s1Item.row.index);
      // 同理：这一行派给哪个预设，就回哪条通道做升降。
      const channel = channelFor("stage2", s1Item.presetId);
      // 请求发出时间：catch 里判断「这次失败是不是下调之前发出的请求」（同一次拥塞事件只下调一次）。
      const requestStartedAt = Date.now();
      try {
        const s2 = await runStage2Stylist(s1Item, config, labels, allRows);
        // 复审内部已经把异常回退成「采纳初审方案」，但这一行仍必须走统一错误处理：
        // 频控时重试、其余计入复审异常；静默吞掉的话它在指标上会凭空消失。
        if (s2.stageError) throw s2.stageError;
        if (!status.stopRequested) {
          // 与初审对称：成功也必须进熔断窗口，否则窗口里只剩失败样本，错误率会虚高到 100%。
          noteStageSuccess(channel);
        }
        // 复审一完成就计入实时计数，不等仲裁结束：触发仲裁的行要等 Stage 3 跑完才 finalize，
        // stageMetrics 到那一刻才 +1，阶段二卡片会长时间停在很小的数字上，看起来像「阶段二没干活」。
        const stylistReview = s2.decision?.stylistReview;
        if (stylistReview) {
          stage2ReviewedLive += 1;
          const liveAttitude = String(stylistReview.critique?.attitude || "");
          if (Object.prototype.hasOwnProperty.call(stage2AttitudesLive, liveAttitude)) {
            stage2AttitudesLive[liveAttitude] += 1;
          }
        }
        if (s2.arbCheck?.triggered && plan.cascadeToArbiter) {
          // 产生分歧，且这条流水线配了仲裁：推入 Stage 3 队列！
          stage3Pending.push(s2);
          syncStagePipelineQueues();
          pushLog(`第 ${s2.row.index} 行：文学复审产生分歧，移交 Stage 3 (Arbiter 终审仲裁队列)。`);
        } else {
          // 没有下游仲裁，或未产生分歧：采纳复审结论，直接完成
          const result = finalizeRowResult(s2, config);
          addResult(result);
          status.active = status.active.filter((idx) => idx !== s2.row.index);
        }
      } catch (error) {
        const isRefusal = isModelRefusalError(error);
        const isRateLimit = !isRefusal && isConcurrencyOrRateLimitError(error) && !status.stopRequested;
        // 与初审对称：接口配置类致命错误（400/401/404/非 JSON 响应）不能一行行刷到底，
        // 必须立刻终止整条流水线；其余非频控失败也要进熔断采样，否则「复审全失败」永远拦不住。
        const fatalRequestError = !isRefusal && !isRateLimit && isFatalRequestError(error) && !status.stopRequested;
        if (isRateLimit && onStageRateLimit(channel, s1Item.row.index, error, stage2Pending, s1Item, requestStartedAt, s2Ctrl)) {
          // 成功推回 stage2Pending 重试
        } else {
          if (isRateLimit) {
            pushLog(`[频控退避] 第 ${s1Item.row.index} 行文学复审连续 ${maxRowRetries} 次触发频控限制，已达重试上限，回退至初审方案。`);
          } else if (isRefusal) {
            pushLog(`第 ${s1Item.row.index} 行：文学复审被模型拒答（内容安全审查），回退至初审方案。`);
          } else {
            pushLog(`第 ${s1Item.row.index} 行：Stylist 异常（${error.message}），回退至初审方案。`);
          }
          const isStopped = status.stopRequested && !fatalRequestError;
          status.stageMetrics.stage2Errors += 1;
          recordStageError("stage2", s1Item.row.index, error, isStopped ? "stopped" : (isRateLimit ? "rate_limit" : (isRefusal ? "refusal" : "")));
          const result = withStageFailureNote(finalizeRowResult(s1Item, config), "stage2", error, { stopped: isStopped, refusal: isRefusal });
          addResult(result);
          status.active = status.active.filter((idx) => idx !== s1Item.row.index);
          if (fatalRequestError) stopForFatalRequestError(error);
          // 拒答是上游的正常应答，不是接口故障：不进失败窗口，只证明限流已放行。
          else if (isRefusal) clearCooldownIf(channel, recordStageNotLimited("stage2", channel.presetId));
          else if (!status.stopRequested && !isRateLimit) {
            onStageOverload(channel, s1Item.row.index, error, requestStartedAt);
            clearCooldownIf(channel, recordStageFailure("stage2", channel.presetId));
          }
        }
      } finally {
        pools.stage2.finish(s1Item.presetId, s1Item.row.index, { ok: !status.stageErrors.stage2[s1Item.row.index] });
        status.stagePipelines.stage2.activeRows = status.stagePipelines.stage2.activeRows.filter((idx) => idx !== s1Item.row.index);
        if (!plan.cascadeToArbiter || !stage3Pending.some((item) => item.row.index === s1Item.row.index)) {
          if (!stage2Pending.some((item) => item.row?.index === s1Item.row.index)) {
            status.active = status.active.filter((idx) => idx !== s1Item.row.index);
          }
        }
        stage2InFlight -= 1;
        syncStagePipelineQueues();
        dispatch();
      }
    }

    async function executeStage3(s2Item) {
      if (!status.active.includes(s2Item.row.index)) status.active.push(s2Item.row.index);
      status.stagePipelines.stage3.activeRows.push(s2Item.row.index);
      syncStagePipelineQueues();
      // 同理：先撤掉这一行上一次的仲裁异常明细。
      clearStageError("stage3", s2Item.row.index);
      // 同理：这一行派给哪个预设，就回哪条通道做升降。
      const channel = channelFor("stage3", s2Item.presetId);
      // 请求发出时间：catch 里判断「这次失败是不是下调之前发出的请求」（同一次拥塞事件只下调一次）。
      const requestStartedAt = Date.now();
      try {
        const s3 = await runStage3Arbiter(s2Item, config, labels, allRows);
        // 同理：仲裁失败的行走统一错误处理（频控重试 / 计入仲裁异常 / 回退复审方案），
        // 别让「处理了却不定案」变成静默。
        if (s3.stageError) throw s3.stageError;
        if (!status.stopRequested) {
          // 与初审对称：成功也必须进熔断窗口，否则窗口里只剩失败样本，错误率会虚高到 100%。
          noteStageSuccess(channel);
        }
        const result = finalizeRowResult(s3, config);
        addResult(result);
        status.active = status.active.filter((idx) => idx !== s2Item.row.index);
      } catch (error) {
        const isRefusal = isModelRefusalError(error);
        const isRateLimit = !isRefusal && isConcurrencyOrRateLimitError(error) && !status.stopRequested;
        // 与初审对称：接口配置类致命错误（400/401/404/非 JSON 响应）不能一行行刷到底，
        // 必须立刻终止整条流水线；其余非频控失败也要进熔断采样，否则「仲裁全失败」永远拦不住
        // （现象：阶段三「异常」一路涨到队列尽头，定案数却不动，用户只能眼睁睁看着）。
        const fatalRequestError = !isRefusal && !isRateLimit && isFatalRequestError(error) && !status.stopRequested;
        if (isRateLimit && onStageRateLimit(channel, s2Item.row.index, error, stage3Pending, s2Item, requestStartedAt, s3Ctrl)) {
          // 成功推回 stage3Pending 重试
        } else {
          if (isRateLimit) {
            pushLog(`[频控退避] 第 ${s2Item.row.index} 行终审仲裁连续 ${maxRowRetries} 次触发频控限制，已达重试上限，回退至复审方案。`);
          } else if (isRefusal) {
            pushLog(`第 ${s2Item.row.index} 行：终审仲裁被模型拒答（内容安全审查），回退至复审方案。`);
          } else {
            pushLog(`第 ${s2Item.row.index} 行：Arbiter 异常（${error.message}），回退至复审方案。`);
          }
          const isStopped = status.stopRequested && !fatalRequestError;
          status.stageMetrics.stage3Errors += 1;
          recordStageError("stage3", s2Item.row.index, error, isStopped ? "stopped" : (isRateLimit ? "rate_limit" : (isRefusal ? "refusal" : "")));
          const result = withStageFailureNote(finalizeRowResult(s2Item, config), "stage3", error, { stopped: isStopped, refusal: isRefusal });
          addResult(result);
          status.active = status.active.filter((idx) => idx !== s2Item.row.index);
          if (fatalRequestError) stopForFatalRequestError(error);
          else if (isRefusal) clearCooldownIf(channel, recordStageNotLimited("stage3", channel.presetId));
          else if (!status.stopRequested && !isRateLimit) {
            onStageOverload(channel, s2Item.row.index, error, requestStartedAt);
            clearCooldownIf(channel, recordStageFailure("stage3", channel.presetId));
          }
        }
      } finally {
        pools.stage3.finish(s2Item.presetId, s2Item.row.index, { ok: !status.stageErrors.stage3[s2Item.row.index] });
        status.stagePipelines.stage3.activeRows = status.stagePipelines.stage3.activeRows.filter((idx) => idx !== s2Item.row.index);
        if (!stage3Pending.some((item) => item.row?.index === s2Item.row.index)) {
          status.active = status.active.filter((idx) => idx !== s2Item.row.index);
        }
        stage3InFlight -= 1;
        syncStagePipelineQueues();
        dispatch();
      }
    }

    dispatch();
  });
}

function finish() {
  if (!status.running) return;
  status.running = false;
  status.finishedAt = new Date().toISOString();
  status.active = [];
  status.stagePipelines = createStagePipelines();
  // 收尾时立即落盘、不等节流：这是刷新页面后能把本轮成果重新交付出去的关键一份。
  try {
    persistResultsNow();
  } catch (error) {
    pushLog(`AI 结果落盘失败：${error.message || error}`);
  }
  const isPrefilter = status.kind === "prefilter";
  if (!isPrefilter) {
    const summary = promptTrimSummary();
    if (summary) pushLog(summary);
    const lowScore = lowScoreSummary();
    if (lowScore) pushLog(lowScore);
    const lookup = webLookupSummary();
    if (lookup) pushLog(lookup);
    if (status.modelRefusals) {
      pushLog(`模型拒答防护：${status.modelRefusals} 行因触发内容安全审查被拒答，已自动跳过并标记待终审。`);
    }
    if (status.scriptLeaks) {
      pushLog(`输出语言护栏：${status.scriptLeaks} 行的修改结果混入了原文（日文）文字，已作废，等待终审裁决。`);
    }
    if (status.formatFixes) {
      pushLog(`成品格式门禁：${status.formatFixes} 行的修改结果按成品结构修正了格式（删除换行 ${status.formatLineBreaks} 处、并回段落 ${status.formatParagraphs} 处、说明字段换行 ${status.formatNoteFields} 处）。`);
    }
    if (status.formatVoids) {
      pushLog(`成品格式门禁：${status.formatVoids} 行的修改结果因格式无法确定性还原（段落结构不一致或内联标记增减）被作废，等待终审裁决。`);
    }
    if (!status.formatFixes && !status.formatVoids && status.formatEnabled === false) {
      pushLog("成品格式门禁：已关闭。");
    }
    if (status.punctToFull || status.punctToHalf) {
      pushLog(`标点规范化：${status.punctFixes} 行的修改结果统一了标点宽度（半角→全角 ${status.punctToFull} 处，全角→半角 ${status.punctToHalf} 处）；英文句子保持半角。`);
    }
    if (status.punctQuotes) {
      pushLog(`标点规范化：把 ${status.punctQuotes} 处中文语境的双引号统一成直角引号「」。`);
    }
    if (status.punctQuoteVoids) {
      pushLog(`标点规范化：${status.punctQuoteVoids} 行的修改结果含无法确定性配对的弯引号，已作废，等待终审裁决。`);
    }
    if (status.punctRestored) {
      pushLog(`标点规范化：补回 ${status.punctRestored} 处被删掉的句末点号（引号/括号内侧的句末点号是中文规范写法，原文省略不等于译文该省）。`);
    }
    if (!status.punctFixes && !status.punctQuoteVoids && !status.punctRestored && status.punctEnabled === false) {
      pushLog("标点规范化：已关闭。");
    }
    pushLog(`并发调度统计：起步并发 ${status.concurrency || AI_CONCURRENCY_LIMITS.defaultConcurrency}，峰值并发 ${status.peakConcurrency || status.concurrency || AI_CONCURRENCY_LIMITS.defaultConcurrency}，并发下调 ${status.concurrencyDowns || 0} 次，并发上探 ${status.concurrencyUps || 0} 次，遭遇限流 ${status.concurrencyLimits || 0} 次。`);
  }
  if (status.stopRequested) {
    pushLog(isPrefilter ? "预筛选已终止。" : "AI 校对已终止。");
  } else {
    pushLog(isPrefilter ? "预筛选完成。" : "AI 校对完成。");
  }
}

function forgetRequestedResultIndexes(config) {
  if (!config.forgetResultIndexes?.size || !config.projectKey || !config.rowsSignature) return 0;
  return removeResultIndexes(config.projectKey, config.rowsSignature, config.forgetResultIndexes);
}

function clearProofreadResults(input = {}) {
  if (status.running) {
    const error = new Error("AI 校对正在运行，请先停止任务再清除结果。");
    error.code = "RUNNING";
    throw error;
  }
  const config = cleanConfig(input);
  if (!config.projectKey || !config.rowsSignature) {
    throw new Error("清除 AI 结果请求缺少项目上下文。");
  }
  const { project } = readRows(config);
  requireMatchingProjectSnapshot(config, project);
  if (!config.forgetResultIndexes.size) return { cleared: 0 };
  const cleared = removeResultIndexes(config.projectKey, config.rowsSignature, config.forgetResultIndexes);
  if (status.projectKey === config.projectKey && status.rowsSignature === config.rowsSignature) {
    status.results = new Map([...status.results].filter(([index]) => !config.forgetResultIndexes.has(Number(index))));
    const remaining = [...status.results.values()].sort((a, b) => Number(a.resultRevision) - Number(b.resultRevision));
    status.resultChanges = [];
    status.resultRevision = 0;
    for (const item of remaining) {
      const result = { ...item, resultRevision: ++status.resultRevision };
      status.results.set(Number(result.index), result);
      status.resultChanges.push(result);
    }
  }
  return { cleared };
}

function isModelRefusalError(error) {
  if (!error) return false;
  if (error.code === "MODEL_REFUSAL" || error.code === "CONTENT_FILTER") return true;

  const textToCheck = [
    error.message,
    error.responseBody,
    error.code,
  ].filter(Boolean).join(" ").toLowerCase();

  const refusalPatterns = [
    "declined to answer",
    "content_filter",
    "content filter",
    "content management policy",
    "responsible ai",
    "safety policy",
    "safety violation",
    "safety check",
    "policy violation",
    "violates policy",
    "violated our content policy",
    "sensitive content",
    "prohibited content",
    "moderation",
    "refused to respond",
  ];

  return refusalPatterns.some((pattern) => textToCheck.includes(pattern));
}

function formatRefusalReason(error) {
  if (!error) return "触发内容安全审查策略";
  const raw = String(error.responseBody || error.message || "").trim();
  try {
    const parsed = JSON.parse(raw);
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {}
  const match = raw.match(/(?:the model declined to answer|content_filter|content management policy|responsible ai|safety policy|safety violation|policy violation|violates policy|sensitive content|prohibited content)[^"'\r\n]*/i);
  if (match) return match[0].trim();
  return String(error.message || raw).slice(0, 200).trim() || "模型拒绝回答本行内容";
}

function makeRefusalResult(row, error, targetKey = "") {
  const reason = formatRefusalReason(error);
  return {
    runId: status.runId,
    index: row.index,
    signature: rowSignature(row),
    targetKey,
    status: "suggestion",
    done: false,
    note: [
      "[AI校对]",
      "语义是否相同：待终审",
      "是否需要修改：待终审",
      `分析：模型拒答（触发内容安全审查策略）。本行原文或译文可能包含敏感词，模型拒绝回答，本行未定案，等待终审裁决。 拒答详情：${reason}`,
    ].join("\n"),
  };
}

function isFatalRequestError(error) {
  if (isModelRefusalError(error)) return false;
  if (isConcurrencyOrRateLimitError(error)) return false;
  return error?.code === "INVALID_JSON_RESPONSE"
    || [400, 401, 403, 404, 405, 415, 422].includes(error?.httpStatus);
}

function stopForFatalRequestError(error) {
  status.stopRequested = true;
  status.error = `AI 接口配置或响应异常，任务已自动终止：${error.message || String(error)}`;
  pushLog(status.error);
  for (const controller of controllers) controller.abort();
}

function breakerPresetId(presetId) {
  return String(presetId || "__stage__");
}

function stageBreaker(stageKey, presetId = "__stage__") {
  const key = `${stageKey}:${breakerPresetId(presetId)}`;
  let breaker = presetBreakers.get(key);
  if (!breaker) {
    // TRANSCOMPARATOR_BREAKER_TIME_SCALE 只缩放冷却时长，供回归测试把分钟级冷却压到毫秒级；不是运行时开关。
    breaker = createStageBreaker({ timeScale: Number(process.env.TRANSCOMPARATOR_BREAKER_TIME_SCALE) || 1 });
    presetBreakers.set(key, breaker);
  }
  return breaker;
}

function breakerTripBucket(stageKey) {
  let bucket = presetBreakerTrips.get(stageKey);
  if (!bucket) {
    bucket = new Map();
    presetBreakerTrips.set(stageKey, bucket);
  }
  return bucket;
}

function currentStagePresetIds(stageKey) {
  const presets = breakerRuntime?.pools?.[stageKey]?.presets;
  if (Array.isArray(presets) && presets.length) return presets.map((item) => String(item.presetId));
  return [...breakerTripBucket(stageKey).keys()];
}

function isPresetBreakerTripped(stageKey, presetId) {
  return breakerTripBucket(stageKey).has(breakerPresetId(presetId));
}

function isStageBreakerBroken(stageKey) {
  const ids = currentStagePresetIds(stageKey);
  return ids.length > 0 && ids.every((id) => isPresetBreakerTripped(stageKey, id));
}

function allActiveStagesBroken() {
  const stages = breakerRuntime?.activeStages;
  if (!(stages instanceof Set) || !stages.size) return false;
  return [...stages].every((stageKey) => isStageBreakerBroken(stageKey));
}

function presetBreakerLabel(stageKey, presetId) {
  const stageLabel = STAGE_OUTCOME_LABELS[stageKey] || stageKey;
  const presets = breakerRuntime?.pools?.[stageKey]?.presets || [];
  if (presets.length <= 1) return stageLabel;
  const preset = presets.find((item) => String(item.presetId) === breakerPresetId(presetId));
  return `${stageLabel}·${preset?.name || preset?.presetId || breakerPresetId(presetId)}`;
}

function stageTripText(trip, stageKey, presetId, terminal = false) {
  const label = terminal
    ? (STAGE_OUTCOME_LABELS[stageKey] || stageKey)
    : presetBreakerLabel(stageKey, presetId);
  const text = describeTrip(trip, label);
  return terminal ? text : text.replace("任务已自动终止。", "该预设已暂停。");
}

function stopForBreakerTrip(trip, stageKey, presetId) {
  if (!trip || status.stopRequested) return;
  const id = breakerPresetId(presetId);
  const bucket = breakerTripBucket(stageKey);
  if (!bucket.has(id)) {
    bucket.set(id, trip);
    pushLog(`[熔断] ${stageTripText(trip, stageKey, id)} 其它预设继续运行。`);
  }

  const stageBroken = isStageBreakerBroken(stageKey);
  if (stageBroken && !breakerRuntime?.brokenStages?.has(stageKey)) {
    breakerRuntime?.brokenStages?.add(stageKey);
    const count = currentStagePresetIds(stageKey).length;
    pushLog(`[熔断] ${STAGE_OUTCOME_LABELS[stageKey] || stageKey}：当前阶段选择的 ${count} 个预设均已熔断，暂停该阶段后续派发。`);
    breakerRuntime?.syncQueues?.();
  } else {
    // 当前预设后续不再接收新行；其待派发工作会在下一轮同步时改派给健康预设。
    breakerRuntime?.syncQueues?.();
  }

  // 只有参与本次流水线的每个阶段都进入「全部预设熔断」才终止整条任务。
  if (allActiveStagesBroken()) {
    status.stopRequested = true;
    status.error = stageTripText(trip, stageKey, id, true);
    pushLog(status.error);
    for (const controller of controllers) controller.abort();
  } else if (!status.breakerWarning) {
    // 保留首个预设熔断原因供状态面板与日志诊断；它不是整体终止信号，
    // stopRequested 仍只在所有参与阶段都熔断时置为 true。
    status.breakerWarning = stageTripText(trip, stageKey, id, false);
    status.error = status.breakerWarning;
  }
}

// 一次成功的模型调用。返回 recovered=true 表示该预设刚从限流冷却中恢复。
function recordStageSuccess(stageKey, presetId) {
  if (isPresetBreakerTripped(stageKey, presetId)) return false;
  const { recovered, trip } = stageBreaker(stageKey, presetId).recordSuccess();
  if (recovered) pushLog(`[熔断] ${presetBreakerLabel(stageKey, presetId)}：请求重新通过，限流冷却解除，恢复正常派发。`);
  if (trip) stopForBreakerTrip(trip, stageKey, presetId);
  return recovered;
}

// 一次非限流的真实失败（5xx、超时、断连等）。限流耗尽走 onStageRateLimit 里的限流轨，不进这里。
function recordStageFailure(stageKey, presetId) {
  if (isPresetBreakerTripped(stageKey, presetId)) return false;
  const { recovered, trip } = stageBreaker(stageKey, presetId).recordFailure();
  if (recovered) pushLog(`[熔断] ${presetBreakerLabel(stageKey, presetId)}：请求已拿到非限流的答复，限流冷却解除。`);
  if (trip) stopForBreakerTrip(trip, stageKey, presetId);
  return recovered;
}

// 拒答：上游正常应答，只解除限流轨，不计成败。
function recordStageNotLimited(stageKey, presetId) {
  if (isPresetBreakerTripped(stageKey, presetId)) return false;
  const { recovered } = stageBreaker(stageKey, presetId).recordNotLimited();
  if (recovered) pushLog(`[熔断] ${presetBreakerLabel(stageKey, presetId)}：请求已拿到非限流的答复，限流冷却解除。`);
  return recovered;
}

async function runStage1Gatekeeper(row, allRows, config, labels) {
  const stageConfig = row.presetConfig || config;
  if (stageConfig !== config) config = { ...config, ...stageConfig };
  const bilingual = config.proofreadMode === "bilingual";
  const targetKey = bilingual ? "cn" : config.target;
  const counterpartKey = bilingual ? "jp" : (targetKey === "cn" ? "tw" : "cn");
  const targetLabel = targetKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C");
  const counterpartLabel = counterpartKey === "jp"
    ? (labels.jp || "原文 A")
    : (counterpartKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C"));
  const targetText = textForKey(row, targetKey);
  const counterpartText = textForKey(row, counterpartKey);
  const diffHelper = bilingual
    ? "双语模式不生成跨语言词级差异；请依据原文 A 与译文 B 的语义对应判断。"
    : diffSummary(row.cn || "", row.twCn || row.tw || "", labels);
  const basePayload = {
    row,
    targetLabel,
    counterpartLabel,
    targetText,
    counterpartText,
    diffHelper,
    speechHabit: speechHabitFor(row, config.speechHabitContext),
    // 对照表命中的术语：只作为提示词注入，不替模型下结论（跳过模型的行根本不会走到这里）。
    termGuidance: config.termContext?.get(Number(row.index)) || null,
    context: [],
    contextMode: "none",
  };
  const contextState = createContextState(row.index, allRows, targetKey, counterpartKey, config.proofreadMode);
  const continuation = findContinuationContext(row.index, allRows, targetKey);
  if (continuation) {
    includeContextRow(contextState, continuation.row, continuation.relative, continuation.relation);
    basePayload.continuation = {
      relation: continuation.relation,
      targetEcho: continuation.targetEcho,
    };
    pushLog(`第 ${row.index} 行：原文短式开头在下一行同头重复，已自动带入下一行作承接上下文。`);
  }
  const inferredSubject = findInferredSubjectContext(row.index, allRows, targetKey);
  if (inferredSubject) {
    for (const candidate of inferredSubject.candidates) {
      includeContextRow(contextState, candidate.row, candidate.relative, inferredSubject.relation);
    }
    basePayload.inferredSubject = {
      relation: inferredSubject.relation,
      pronoun: inferredSubject.pronoun,
    };
    pushLog(`第 ${row.index} 行：译文引入原文未直接给出的人称代词「${inferredSubject.pronoun}」，已自动带入前序上下文作指代依据。`);
  }
  const speechMerge = findSpeechMergeContext(row.index, allRows, targetKey);
  if (speechMerge) {
    includeContextRow(contextState, speechMerge.row, speechMerge.relative, speechMerge.relation);
    basePayload.speechMerge = {
      relation: speechMerge.relation,
      verb: speechMerge.verb,
    };
    pushLog(`第 ${row.index} 行：原文为接续片段且译文含引述动词「${speechMerge.verb}」，已自动带入下一行作跨行核对依据。`);
  }
  // 低分归因层：极低分的行不能直接当“逐句误译”处理。基础轮一旦判出极低分，本轮起就按归因口径继续问，
  // 并把窗口一次扩到本行前后各 N 行（前后都没有行的行无从复核，自动跳过）。一旦触发就持续生效，
  // 保证同一行的判断口径前后一致。触发判断放在**拿到结论之后**：模型给出定论时主循环本来就要 break，
  // 只有在这里拦一下，低分才有机会被归因复核。
  const lowScore = { active: false };
  let decision = null;
  for (let round = 0; round <= contextBudget.maxRounds; round += 1) {
    const hasContext = contextState.items.length > 0;
    const messages = buildMessages({
      ...basePayload,
      context: contextState.items,
      contextMode: hasContext ? "requested" : "none",
      lowScore: lowScore.active ? { rows: config.lowScoreRows } : null,
    }, config);
    const stageLabel = round === 0
      ? "当前行判断"
      : (lowScore.active ? `低分归因与修复 ${round}` : `扩展上下文 ${round}`);
    pushLog(`第 ${row.index} 行：${stageLabel}，等待模型返回。`);
    const content = await callModel(messages, config);
    decision = parseDecision(content, { proofreadMode: config.proofreadMode });
    const entersLowScore = !lowScore.active && config.lowScoreCheck && hasNeighborRow(contextState)
      && shouldCheckLowScore({ decision, minPenalty: config.lowScorePenalty });
    if (!shouldRetryWithContext(decision) && !entersLowScore) break;
    if (round >= contextBudget.maxRounds) break;
    if (entersLowScore) {
      lowScore.active = true;
      ensureContextRadius(contextState, config.lowScoreRows);
      pushLog(`第 ${row.index} 行：扣分达到阈值（≥${config.lowScorePenalty} 分），转入低分归因复核（先解释低分原因再修，跨行错位为必查项，窗口 ±${config.lowScoreRows} 行）。`);
      continue;
    }
    const isPureFragment = isPureSymmetricFragmentRow(row, targetKey);
    const hasGivenContext = contextState.items.length > 0;
    if (isPureFragment || (isAlignFragmentRow(row, targetKey) && hasGivenContext)) {
      pushLog(`第 ${row.index} 行：判定为对齐片段行，不再扩展上下文，直接转终审确认。`);
      break;
    }
    const added = expandContextRing(contextState);
    if (!added.length) break;
  }
  // 归因结果落进备注与统计：人工只读结果，也要能看出这行为什么低分、按哪一类原因修的。
  if (lowScore.active) {
    const cause = decision?.cause || "";
    status.lowScoreChecks += 1;
    if (cause) {
      status.lowScoreCauses[cause] = (status.lowScoreCauses[cause] || 0) + 1;
    }
    if (isShiftCause(cause)) status.lowScoreShifted += 1;
    pushLog(`第 ${row.index} 行：低分归因 → ${cause || "未给出明确归因（结论见备注）"}。`);
    decision = {
      ...decision,
      lowScore: { checked: true, cause, window: contextState.radius, neighbors: contextState.items.length },
    };
  }
  // 线上查询层（最后一层，排在“转人工”之前）：模型明确判断不了、相邻行也补过之后，按顺序去官方站点查证。
  if (config.webLookup && config.wikiSites.length && shouldRetryWithContext(decision)) {
    const entries = webLookupEntries({
      termGuidance: basePayload.termGuidance,
      jp: row.jp || "",
      targetText,
    });
    if (entries.length) {
      status.webLookups += 1;
      const queries = entries.flatMap((item) => item.terms).join("、");
      const triedLabels = [];
      const lastRound = config.wikiSites.length;
      for (let round = 0; round <= lastRound; round += 1) {
        const site = config.wikiSites[round];
        const label = site ? site.label : "自行检索";
        const stageLabel = site
          ? `线上查证 ${round + 1}/${config.wikiSites.length}（${label}）`
          : "线上查证（自行检索）";
        pushLog(`第 ${row.index} 行：查询「${queries}」→ ${stageLabel}。`);
        const messages = buildMessages({
          ...basePayload,
          context: contextState.items,
          contextMode: contextState.items.length ? "requested" : "none",
          webLookup: { entries, sites: config.wikiSites, round },
        }, config);
        pushLog(`第 ${row.index} 行：${stageLabel}，等待模型返回。`);
        const content = await callModel(messages, config);
        const next = parseDecision(content, { proofreadMode: config.proofreadMode });
        status.webLookupAttempts += 1;
        if (!shouldRetryWithContext(next)) {
          decision = { ...next, webLookup: { concluded: true, siteLabel: site ? site.label : "", triedLabels: [...triedLabels] } };
          status.webLookupResolved += 1;
          pushLog(`第 ${row.index} 行：${label} 获得依据并给出结论（依据已写入备注）。`);
          break;
        }
        triedLabels.push(label);
        decision = { ...next, webLookup: { concluded: false, triedLabels: [...triedLabels] } };
        if (status.stopRequested) break;
        pushLog(`第 ${row.index} 行：${label} 未获得有效信息，${round < lastRound ? "换下一个来源" : "转终审确认"}。`);
      }
    }
  }
  decision = ensureRevisedText(decision, targetKey, targetText, counterpartText, config.proofreadMode);
  // 防呆：如果初审判定需要修改且说明是删除/增译，但 revisedText 却填了待删除词，作废该局部短语避免误导下游 Stylist
  if (decision.needsEdit && decision.revisedText) {
    const isDeleteWord = Boolean(
      decision.summary &&
      /(?:删除|删去|删掉|去除|去掉|增译|无中生有|多余|不应有)/.test(decision.summary) &&
      (decision.summary.includes(`「${decision.revisedText}」`) ||
       decision.summary.includes(`“${decision.revisedText}”`) ||
       decision.summary.includes(`‘${decision.revisedText}’`) ||
       (decision.revisedText.length <= 12 && decision.summary.includes(decision.revisedText))) &&
      (targetText.includes(decision.revisedText) || decision.revisedText.length < targetText.length * 0.6)
    );
    if (isDeleteWord) {
      decision = { ...decision, revisedText: "" };
    }
  }
  return {
    row,
    decision,
    targetKey,
    counterpartKey,
    targetLabel,
    counterpartLabel,
    targetText,
    counterpartText,
    lowScore,
    allRows,
  };
}

function parseStoredNote(note = "") {
  const lines = splitNoteFields(latestAiNotePart(note));
  const data = {
    semantic: "",
    modify: "",
    stage1: "",
    stage1Revision: "",
    stage2: null,
    stage2Revision: "",
    stage3: null,
    stage3Revision: "",
    revision: "",
    analysis: "",
    score: 80,
  };
  for (const line of lines) {
    if (line.startsWith("语义是否相同：")) data.semantic = line.slice("语义是否相同：".length).trim();
    else if (line.startsWith("是否需要修改：")) data.modify = line.slice("是否需要修改：".length).trim();
    else if (line.startsWith("Gatekeeper初审：")) data.stage1 = line.slice("Gatekeeper初审：".length).trim();
    else if (line.startsWith("初审改案：") || line.startsWith("初审建议：")) data.stage1Revision = line.replace(/^(初审改案|初审建议)：/, "").trim();
    else if (line.startsWith("Stylist复审")) {
      const match = line.match(/^Stylist复审(?:\[(.*?)\])?：([\s\S]*)$/);
      if (match) {
        data.stage2 = { attitude: match[1] || "modify", text: match[2]?.trim() || "" };
      }
    } else if (line.startsWith("复审改案：") || line.startsWith("复审建议：")) data.stage2Revision = line.replace(/^(复审改案|复审建议)：/, "").trim();
    else if (line.startsWith("Arbiter仲裁")) {
      const match = line.match(/^Arbiter仲裁(?:\[(.*?)\])?：([\s\S]*)$/);
      if (match) {
        data.stage3 = { winner: match[1] || "裁决", text: match[2]?.trim() || "" };
      }
    } else if (line.startsWith("仲裁改案：") || line.startsWith("仲裁建议：")) data.stage3Revision = line.replace(/^(仲裁改案|仲裁建议)：/, "").trim();
    else if (line.startsWith("修改结果：")) data.revision = line.slice("修改结果：".length).trim();
    else if (line.startsWith("分析：")) data.analysis = line.slice("分析：".length).trim();
  }
  return data;
}

function isStage3DisputeRow(row, noteText = "", memoryResult = null) {
  if (String(noteText || "").trim()) {
    const state = stageNoteState(noteText);
    return state.arbitrated || state.diverged;
  }
  if (memoryResult) {
    if (memoryResult.arbitration) return true;
    if (memoryResult.arbCheck?.triggered || memoryResult.decision?.arbCheck?.triggered) return true;
    const critiqueAtt = memoryResult.critique?.attitude || memoryResult.stageResult?.critique?.attitude;
    if (critiqueAtt === "modify" || critiqueAtt === "reject" || critiqueAtt === "escalate") return true;
    if (memoryResult.stageResult?.decision === "escalate") return true;
  }
  return false;
}

// Stage 2 consumes both Gatekeeper edits and unresolved/unclear rows.
function isStage2Candidate(noteText = "", memoryResult = null) {
  if (String(noteText || "").trim()) return stageNoteState(noteText).candidate;
  const stageResult = memoryResult?.stageResult || memoryResult?.decision || {};
  const isUnclear = Boolean(
    stageResult.decision === "unclear" ||
    stageResult.better === "unclear" ||
    stageResult.needsContext === true
  );
  const hasEdit = Boolean(
    stageResult.needsEdit === true
  );
  return hasEdit || isUnclear;
}

function reconstructStage1Result(row, noteText, config, labels) {
  noteText = latestAiNotePart(noteText);
  const parsed = parseStoredNote(noteText);
  const bilingual = config.proofreadMode === "bilingual";
  const targetKey = bilingual ? "cn" : config.target;
  const counterpartKey = bilingual ? "jp" : (targetKey === "cn" ? "tw" : "cn");
  const targetLabel = targetKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C");
  const counterpartLabel = counterpartKey === "jp"
    ? (labels.jp || "原文 A")
    : (counterpartKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C"));
  const targetText = textForKey(row, targetKey);
  const counterpartText = textForKey(row, counterpartKey);

  const revisedText = parsed.stage1Revision || parsed.revision || "";
  const isNeedsCheck = parsed.modify === "待终审" || parsed.modify === "待人工确认" || parsed.modify === "人工确认" || noteText.includes("待人工确认") || noteText.includes("存疑");
  const better = bilingual
    ? (parsed.modify === "是" ? "neither" : (isNeedsCheck ? "unclear" : "keep"))
    : (parsed.modify === "是"
        ? (noteText.includes("参考") || noteText.includes("对照") ? "counterpart" : "neither")
        : (parsed.modify === "否" ? "target" : "unclear"));
  const decision = {
    needsEdit: parsed.modify === "是" || Boolean(revisedText),
    needsContext: isNeedsCheck,
    semanticSame: parsed.semantic !== "不同",
    better,
    summary: parsed.analysis || parsed.stage1 || (parsed.modify === "是" ? "初审建议修改" : (isNeedsCheck ? "初审存疑待人工确认" : "无需修改")),
    revisedText,
    score: parsed.score || (isNeedsCheck ? null : 80),
    stage1RevisedText: revisedText,
  };

  return {
    row,
    decision,
    targetKey,
    counterpartKey,
    targetLabel,
    counterpartLabel,
    targetText,
    counterpartText,
    lowScore: null,
  };
}

function reconstructStage2Result(row, noteText, config, labels) {
  const s1 = reconstructStage1Result(row, noteText, config, labels);
  const parsed = parseStoredNote(noteText);
  const s2Revised = parsed.stage2Revision || (parsed.stage3 ? (parsed.stage1Revision || "") : (parsed.revision || s1.decision.revisedText || ""));
  const attitude = parsed.stage2?.attitude || "modify";

  s1.decision.stylistReview = {
    critique: {
      attitude,
      rationale: parsed.stage2?.text || parsed.analysis || "文学复审意见",
      acceptedChanges: [],
      rejectedChanges: [],
    },
    revisedText: s2Revised,
    summary: parsed.stage2?.text || "",
  };
  s1.decision.stage2RevisedText = s2Revised;
  s1.arbCheck = {
    triggered: true,
    reason: parsed.stage2?.text || "分歧仲裁",
  };
  return s1;
}

async function runStage2Stylist(stage1Result, config, labels, extraAllRows = null) {
  if (stage1Result.presetConfig) config = { ...config, stylistConfig: stage1Result.presetConfig };
  const { row, targetLabel, lowScore } = stage1Result;
  let decision = { ...stage1Result.decision };
  decision.stage1RevisedText = String(stage1Result.decision?.revisedText || "");

  pushLog(`第 ${row.index} 行：初审建议修改，转入 Stage 2 (Stylist 文学复审)。`);

  let sConf = config.stylistConfig;
  if (!sConf) {
    if (config.singleModelPersona) {
      const pCtx = createPersonaContext("stylist", config);
      sConf = pCtx.config;
    } else {
      sConf = config;
    }
  }

  const termGuidance = config.termContext?.get(Number(row.index)) || null;
  const glossary = config.glossaryFile ? glossaryPrompt(loadGlossary(config.glossaryFile)) : (config.glossary || "");
  const allRows = extraAllRows || stage1Result.allRows || config.allRows || null;
  const stylistContext = resolveStageContext({
    stage: "stylist",
    allRows,
    rowIndex: row.index,
    row,
    gatekeeperDecision: decision,
    targetKey: stage1Result.targetKey,
  });

  const stylistMessages = buildStylistMessages(row, decision, {
    targetLabel,
    targetText: stage1Result.targetText,
    counterpartText: stage1Result.counterpartText,
    counterpartLabel: stage1Result.counterpartLabel,
    basePrompt: config.systemPrompt,
    termGuidance,
    glossary,
    context: stylistContext,
  });

  let arbCheck = { triggered: false };
  let stageError = null;
  try {
    const stylistRaw = await callModel(stylistMessages, sConf);
    const stylistReview = parseStylistResponse(stylistRaw);
    decision.stylistReview = stylistReview;
    decision.stylistModelId = sConf.model;
    decision.stage2RevisedText = String(stylistReview.revisedText || "");

    pushLog(`第 ${row.index} 行：Stylist 复审完成（attitude: ${stylistReview.critique.attitude}）。`);

    arbCheck = shouldTriggerArbitration({
      gatekeeperDecision: decision,
      stylistReview,
      signals: {
        termConflict: isTermConflictRow(config, row.index),
        termGuidance,
        lowScoreUncertain: lowScore?.active,
        targetText: stage1Result.targetText,
      },
    });

    if (!arbCheck.triggered || config.arbiterEnabled === false) {
      if (stylistReview.critique.attitude === "modify" && stylistReview.revisedText) {
        decision.revisedText = stylistReview.revisedText;
        decision.needsEdit = true;
        decision.needsContext = false;
        decision.better = config.proofreadMode === "bilingual" ? "neither" : "counterpart";
      } else if (stylistReview.critique.attitude === "reject") {
        decision.needsEdit = false;
        decision.revisedText = "";
        decision.needsContext = false;
        if (decision.better === "unclear") {
          decision.better = config.proofreadMode === "bilingual" ? "keep" : "target";
        }
      } else if (stylistReview.critique.attitude === "accept" && decision.stage1RevisedText) {
        // 复审明确认可初审改案 = 定案。这里必须把 better 一并改成定案值：初审判「存疑」时
        // （模型结论自相矛盾，normalizeDecision 保守归类为 unclear）只清 needsContext 会留下
        // better=unclear，decisionToResult 会把它写成「终审定案为待人工确认」——而这一行根本没走到终审。
        decision.needsEdit = true;
        decision.needsContext = false;
        decision.better = config.proofreadMode === "bilingual" ? "neither" : "counterpart";
      }
      decision.stage = "stylist";
    }
  } catch (stylistErr) {
    // 同样不在这里吞掉：交给 runQueue 走「频控重试 → 计入复审异常 → 回退初审方案」，
    // 否则失败的行既不算复审、也不算异常，在指标上凭空消失。
    stageError = stylistErr;
  }

  return {
    ...stage1Result,
    decision,
    arbCheck,
    stageError,
  };
}

async function runStage3Arbiter(stage2Result, config, labels, extraAllRows = null) {
  if (stage2Result.presetConfig) config = { ...config, arbiterConfig: stage2Result.presetConfig };
  const { row, targetLabel, targetText } = stage2Result;
  let decision = { ...stage2Result.decision };
  const stylistReview = decision.stylistReview || {};

  pushLog(`第 ${row.index} 行：触发 Stage 3 (Arbiter 终审仲裁)：${stage2Result.arbCheck?.reason || "分歧仲裁"}`);

  let aConf = config.arbiterConfig;
  if (!aConf) {
    if (config.singleModelPersona) {
      const pCtx = createPersonaContext("arbiter", config);
      aConf = pCtx.config;
    } else {
      aConf = config;
    }
  }

  const termGuidance = config.termContext?.get(Number(row.index)) || null;
  const glossary = config.glossaryFile ? glossaryPrompt(loadGlossary(config.glossaryFile)) : (config.glossary || "");
  const allRows = extraAllRows || stage2Result.allRows || config.allRows || null;
  const arbiterContext = resolveStageContext({
    stage: "arbiter",
    allRows,
    rowIndex: row.index,
    row,
    gatekeeperDecision: decision,
    targetKey: stage2Result.targetKey,
    forceContext: true,
  });

  const arbiterMessages = buildArbiterMessages(row, decision, stylistReview, {
    targetLabel,
    targetText: stage2Result.targetText,
    counterpartText: stage2Result.counterpartText,
    counterpartLabel: stage2Result.counterpartLabel,
    basePrompt: config.systemPrompt,
    termGuidance,
    glossary,
    context: arbiterContext,
  });

  let stageError = null;
  try {
    const arbiterRaw = await callModel(arbiterMessages, aConf);
    const arbiterParsed = parseArbiterResponse(arbiterRaw);

    const applied = applyArbitrationDecision({
      arbitration: arbiterParsed.arbitration,
      gatekeeperDecision: decision,
      stylistReview,
      targetText,
      adjudicatedRevisedText: arbiterParsed.revisedText,
    });

    decision.arbitration = applied.arbitration;
    decision.arbitrationModelId = aConf.model;
    if (applied.revisedText) {
      decision.revisedText = applied.revisedText;
      decision.stage3RevisedText = applied.revisedText;
    }
    decision.needsEdit = applied.needsEdit;
    if (applied.isUnclear) {
      decision.better = "unclear";
      decision.needsContext = true;
    } else {
      decision.needsContext = false;
      if (applied.finalDecision === "keep") {
        decision.needsEdit = false;
        decision.revisedText = "";
        decision.better = config.proofreadMode === "bilingual" ? "keep" : "target";
      } else if (applied.finalDecision === "replace") {
        decision.needsEdit = true;
        decision.better = config.proofreadMode === "bilingual" ? "neither" : "counterpart";
      }
    }
    decision.stage = "arbiter";
    pushLog(`第 ${row.index} 行：Arbiter 仲裁定案（胜出者: ${applied.winner}，最终结论: ${applied.finalDecision}）。`);
  } catch (arbiterErr) {
    // 不在这里吞掉：把异常带回 runQueue，让它走统一的「频控重试 → 计入仲裁异常 → 回退复审方案」。
    // 吞掉的话这一行在指标上会凭空消失——既不算仲裁定案，也不算异常，用户只看到「处理了却不定案」。
    stageError = arbiterErr;
  }

  return {
    ...stage2Result,
    decision,
    stageError,
  };
}

function finalizeRowResult(stageResult, config) {
  const { row, targetKey, counterpartKey, targetLabel, counterpartLabel, targetText, lowScore } = stageResult;
  let decision = stageResult.decision;

  // 成品格式门禁（确定性工序，输出侧的第一关）
  decision = applyFormatGuard(decision, row, config, targetText);
  // 标点规范化（确定性工序）
  decision = normalizeDecisionPunctuation(decision, row, config, targetText);
  // 输出侧兜底（最后一关）
  const guarded = guardTargetScript(decision, targetText);
  if (guarded !== decision) {
    status.scriptLeaks += 1;
    pushLog(`第 ${row.index} 行：修改结果混入原文（日文）文字，已作废，等待终审裁决。`);
  }
  const result = decisionToResult(row, guarded, targetLabel, counterpartLabel, targetKey, config.proofreadMode);
  result.stageSignals = {
    lowScore: Boolean(lowScore?.active),
    webLookup: Boolean(guarded.webLookup?.concluded),
  };
  return result;
}

async function proofreadRow(row, allRows, config, labels) {
  const s1 = await runStage1Gatekeeper(row, allRows, config, labels);
  const isFastPass = !s1.decision.needsEdit && isFastPassDecision(s1.decision);
  if (isFastPass || !(config.multiStageEnabled || config.challengerEnabled || config.singleModelPersona)) {
    return finalizeRowResult(s1, config);
  }
  const s2 = await runStage2Stylist(s1, config, labels, allRows);
  if (s2.arbCheck?.triggered && config.arbiterEnabled !== false) {
    const s3 = await runStage3Arbiter(s2, config, labels, allRows);
    return finalizeRowResult(s3, config);
  }
  return finalizeRowResult(s2, config);
}

function shouldRetryWithContext(decision) {
  return Boolean(decision.needsContext) || decision.better === "unclear";
}

/**
 * 术语冲突行必须经过模型：对照表已经在这类行上给出强证据差异（译文现用别的写法、或整条没译出来），
 * 若被规则/相似度预筛按“看起来差不多”挡掉，这一行的术语判断就没人做了——而术语判断正是模型分析的一环。
 */
function isTermConflictRow(config, index) {
  const indexes = config && config.termConflictIndexes;
  return Boolean(indexes && indexes.has(Number(index)));
}

/**
 * 对照表预处理：命中行按「整行是否只有术语」分流，并返回被它直接处理掉的行号集合。
 * - `term-only`：整行有效内容就是术语，直接写成结果，不调用模型；
 * - `consistent`：术语一致但句中还有别的内容——照常交给模型，只把术语当提示词注入；
 * - `advisory`：命中的是假名写法（グループ、メンバー…），可能只是普通词——**不由对照表定论**，
 *   注入术语提示后照常交给模型，由模型结合上下文判断此处是否确指该术语（与人工核对模型结论）；
 * - `conflict`：译名不一致（强证据且非假名写法）——**同样交给模型**：对照表只提供证据与线索
 *   （译文现用某个写法、或整条没译出来），要不要改由模型结合整句判断，「术语判断」是模型分析里
 *   的一个环节。这些行还会登记进 `config.termConflictIndexes`，在预筛阶段豁免（不许被相似度挡掉）。
 * 只有 `term-only` 会由对照表直接写结论、跳过模型；AI 校对与预筛选共用这条路径，它不调用模型。
 */
function applyTermTable(config, rows, labels) {
  const resolved = new Set();
  const termTables = termTablesFor(config);
  if (!termTables) return resolved;
  status.termTables = { files: termTables.files, entries: termTables.entries.length };
  let consistentRows = 0;
  let conflictRows = 0;
  let advisoryRows = 0;
  const skippedByTable = [];
  const targetKey = termTargetKeyFor(config.proofreadMode, config.target);
  const targetLabel = targetKey === "tw" ? (labels.tw || "非原文 C") : (labels.cn || "译文 B");
  // 被注音口径排除的候选：非人名条目声明了注音时，要么中日两侧都注音（完整判定），
  // 要么降级为只作一致性证据——这里收集的是“降级且译文也没用该译名”的候选。
  // 只统计与提示，不改变结论——它回答的是“表里有这条、本行为什么没算命中”。
  const rubySkippedCandidates = [];
  // 降级为「只作一致性证据」的候选（没有双侧注音，但译文确实用了该译名）：算命中，只是不能指控译名差异。
  const rubyDemotedCandidates = [];
  for (const row of rows) {
    const index = Number(row.index);
    const evaluation = evaluateTermRow({
      source: row.jp || "",
      target: textForKey(row, targetKey),
      tables: termTables,
      rejected: rubySkippedCandidates,
      demoted: rubyDemotedCandidates,
    });
    if (!evaluation) continue;
    if (evaluation.kind === "conflict") {
      conflictRows += 1;
      config.termConflictIndexes.add(index);
    } else if (evaluation.kind === "advisory") advisoryRows += 1;
    else consistentRows += 1;
    if (config.completedIndexes.has(index)) continue;
    // 除「整行只有术语」外，命中的行都把术语当提示词注入、照常交给模型：
    // 术语一致只能证明术语用对了，术语冲突则要由模型结合整句判断该不该改。
    if (evaluation.kind !== "term-only") {
      config.termContext.set(index, termGuidanceFor(row, { evaluation, targetKey, targetLabel }));
      continue;
    }
    skippedByTable.push(index);
    const result = makeTermResult(row, labels, evaluation, config.proofreadMode, targetKey);
    result.runId = status.runId;
    result.signature = rowSignature(row);
    addResult(result, { prefilterKind: "term" });
    resolved.add(index);
  }
  status.termConflicts = conflictRows;
  status.termInjected = [...config.termContext.keys()].length;
  status.termRubySkipped = rubySkippedCandidates.length;
  status.termRubyDemoted = rubyDemotedCandidates.length;
  pushLog(`${termTableSummary(termTables)}：命中 ${consistentRows + conflictRows + advisoryRows} 行（整行只有术语、跳过模型 ${skippedByTable.length}，术语冲突 ${conflictRows}，存疑交模型判断 ${advisoryRows}），另有 ${status.termInjected} 行的术语作为提示词注入后照常交给模型（含术语冲突行：术语判断由模型结合整句给出，不再直接转人工）。`);
  if (rubyDemotedCandidates.length) {
    // 如实说出来：这些条目声明了注音，但本行原文与译文没有同时注音——按新口径它们只作一致性证据
    // （译文用了该项目译名才留下），不能据此指控译名差异。
    const samples = [...new Set(rubyDemotedCandidates.map((item) => displayTermPair(item.entry)))].slice(0, 5);
    pushLog(`对照表：${rubyDemotedCandidates.length} 条候选因中日两侧没有同时注音，降级为只作一致性证据（例：${samples.join("、")}）。`);
  }
  if (rubySkippedCandidates.length) {
    // 如实说出来：这些候选是“表里有这条、本行却没算命中”的——非人名条目带注音时的匹配口径。
    const samples = [...new Set(rubySkippedCandidates.map((item) => displayTermPair(item.entry)))].slice(0, 5);
    pushLog(`对照表：${rubySkippedCandidates.length} 条候选因没有同时注音、且译文未出现该译名而未参与判定（例：${samples.join("、")}）。`);
  }
  compareWithTermLayer(config, { resolved, targetKey, skippedByTable });
  return resolved;
}

/**
 * 与构建期结论交叉校验：对照表判定是确定性函数，两条路径算出来的「命中行」与「跳过模型的纯术语行」
 * 必须一致。不一致只有两种可能——对照表在构建之后被改过（指纹过期），或者页面上的徽标已经过期。
 * 这里不改结论（运行期算的就是本次生效的判定），只把分叉显式说出来。
 */
function compareWithTermLayer(config, { resolved, targetKey, skippedByTable = [] }) {
  // 指纹按**本次实际加载的表**重算：落盘块里只有文件名，本机路径不回读产物。
  const match = termLayerFor(config.termLayer, config.profileId, {
    proofreadMode: config.proofreadMode,
    targetKey,
    files: config.termTables,
  });
  if (!match) return;
  if (match.stale) {
    pushLog("对照表：对照表文件在构建工作台之后被修改过，本次按最新表判定；重新构建工作台可让页面徽标同步。");
    return;
  }
  if (!match.variant) return;
  const built = variantIndexSets(match.variant);
  const predicted = new Set([...built.consistent, ...built.conflicts]);
  // 两侧都排除「已人工确认」的行：运行期本来就会跳过它们。
  const expected = new Set([...predicted].filter((index) => !config.completedIndexes.has(index)));
  const missing = [...expected].filter((index) => !config.termContext.has(index) && !resolved.has(index));
  const extra = [...resolved].filter((index) => !predicted.has(index));
  // 快照可能由旧版本生成（那时所有命中行都会跳过模型）：这种分叉要如实报告，不能静默按新规则跑。
  const skips = new Set(skippedByTable);
  const builtSkips = [...built.termOnly].filter((index) => !config.completedIndexes.has(index));
  const skipMismatch = built.termOnly.size && (builtSkips.some((index) => !skips.has(index)) || [...skips].some((index) => !built.termOnly.has(index)));
  if (!missing.length && !extra.length && !skipMismatch) {
    pushLog(`对照表：与构建期预筛一致（构建期判定 ${predicted.size} 行，本次参与 ${expected.size} 行）。`);
    return;
  }
  pushLog(`对照表：运行期判定与构建期预筛不一致（少 ${missing.length} 行 / 多 ${extra.length} 行${skipMismatch ? " / 跳过模型的行集合不同" : ""}）；重新构建工作台后再核对页面徽标。`);
}

// 表路径写法（数组 / `;` / 换行）的解析与构建期共用同一实现，避免两处口径漂移。

// 对照表按“文件 + 修改时间”缓存：一次任务内只解析一次，表格改动后自动重载。
// 即使解析结果为空（坏文件）也缓存，避免每次状态轮询都重读整张表。
const termTableCache = new Map();

function fileSignature(file) {
  try {
    const stat = fs.statSync(file);
    return `${file}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return `${file}:missing`;
  }
}

function loadTermTablesCached(files) {
  const unique = normalizeTermTablePaths(files || []);
  if (!unique.length) return null;
  const signature = unique.map(fileSignature).join("|");
  const cached = termTableCache.get(signature);
  if (cached) return cached;
  const tables = loadTermTables(unique);
  termTableCache.clear();
  termTableCache.set(signature, tables);
  return tables;
}

function termTablesFor(config) {
  const tables = loadTermTablesCached(config.termTables);
  if (!tables) return null;
  if (tables.errors.length) pushLog(`对照表加载告警：${tables.errors.join("；")}`);
  return tables.entries.length ? tables : null;
}

/**
 * 界面用的对照表状态：当前特化档案（加环境变量）声明了哪些表、能解析出多少条。
 * 不写日志，供状态轮询调用。
 */
function termTableStatusFor(profileId) {
  const files = normalizeTermTablePaths([
    ...toPathList(resolveProfile(profileId).termTables),
    ...toPathList(process.env.TRANSCOMPARATOR_TERM_TABLES),
  ]);
  if (!files.length) return { files: [], sheets: [], entries: 0, errors: [] };
  const tables = loadTermTablesCached(files);
  return {
    files,
    sheets: tables?.sheetNames || [],
    entries: tables?.entries.length || 0,
    errors: tables?.errors || [],
  };
}

// 说话习惯表同样按“文件 + 修改时间”缓存。
const speechTableCache = new Map();

function loadSpeechTablesCached(files) {
  const unique = normalizeSpeechTablePaths(files || []);
  if (!unique.length) return null;
  const signature = unique.map(fileSignature).join("|");
  const cached = speechTableCache.get(signature);
  if (cached) return cached;
  const tables = loadSpeechTables(unique);
  speechTableCache.clear();
  speechTableCache.set(signature, tables);
  return tables;
}

function speechHabitStatusFor(profileId) {
  const profile = resolveProfile(profileId);
  const files = normalizeSpeechTablePaths([
    ...toPathList(profile.speechTables),
    ...toPathList(process.env.TRANSCOMPARATOR_SPEECH_TABLES),
  ]);
  if (!files.length) return { files: [], sheets: [], entries: 0, errors: [], scope: profile.speechHabitScope };
  const tables = loadSpeechTablesCached(files);
  return {
    files,
    sheets: tables?.sheetNames || [],
    entries: tables?.entries.length || 0,
    errors: tables?.errors || [],
    scope: profile.speechHabitScope,
  };
}

/**
 * 说话习惯上下文（每次任务建一次）：按章（或整卷）判定人名命中，
 * 命中即代表该角色的说话习惯很可能出现在这一章/这一卷，于是把对应规则随请求注入。
 * 不做逐行认人——一行台词往往看不出说话人。
 */
function buildSpeechHabitContext(config, rows, project, snapshotLayer = null) {
  // 构建期已经算过章级判定：指纹一致就直接复用，避免每次任务重算，也让页面/离线脚本/AI 看到同一份结论。
  // 指纹按本次实际加载的表重算（落盘块里只有文件名，本机路径不回读产物）。
  const layerMatch = speechHabitLayerFor(snapshotLayer, config.profileId, { files: config.speechTables });
  if (layerMatch && !layerMatch.stale) {
    const context = contextFromLayerEntry(layerMatch.entry);
    pushLog(`说话习惯：复用构建期结果（${context.tables.entries} 条，按${context.scope === "volume" ? "卷" : "章"}命中 ${context.activatedChapters} ${context.scope === "volume" ? "卷" : "章"} / ${context.activatedCharacters.length} 个角色）${context.volume?.code ? `，本卷 ${context.volume.code}` : ""}。`);
    return context;
  }
  if (layerMatch && layerMatch.stale) {
    pushLog("说话习惯：说话习惯表在构建之后被修改过，本次按最新表重算；重新构建工作台可让页面同步。");
  }
  const tables = loadSpeechTablesCached(config.speechTables);
  if (!tables) return null;
  if (tables.errors.length) pushLog(`说话习惯表加载告警：${tables.errors.join("；")}`);
  if (!tables.entries.length) return null;
  const volume = volumeKeyFromFiles(project?.files);
  const scope = config.speechHabitScope === "volume" ? "volume" : "chapter";
  const blocks = new Map();
  let activatedChapters = 0;
  let activatedCharacters = new Set();
  if (scope === "volume") {
    const characters = detectCharacters({ rows, tables, volume });
    const block = volumeHabitBlock({ volume, characters });
    const names = activatedCharacterNames(characters);
    for (const row of rows) blocks.set(String(row.chapter || ""), { block, characters: names, characters_raw: characters });
    activatedChapters = block ? 1 : 0;
    activatedCharacters = new Set(names);
  } else {
    for (const group of groupRowsByChapter(rows)) {
      const characters = detectCharacters({ rows: group.rows, tables, volume });
      const block = chapterHabitBlock({ chapter: group.chapter, characters });
      const names = activatedCharacterNames(characters);
      blocks.set(group.chapter, { block, characters: names, characters_raw: characters });
      if (!block) continue;
      activatedChapters += 1;
      for (const name of names) activatedCharacters.add(name);
    }
  }
  return {
    tables,
    volume,
    scope,
    blocks,
    activatedChapters,
    activatedCharacters: [...activatedCharacters],
  };
}

function speechHabitFor(row, context) {
  if (!context) return null;
  const chapter = String(row.chapter || "").trim() || "（未标注章节）";
  // 快照上下文把整章（或整卷）挂在同一个章名上；卷口径的行也要能按章名回退取到。
  const entry = context.blocks.get(chapter) || context.blocks.get(String(row.chapter || ""));
  if (!entry) return null;
  // 本行原文出现了说话习惯特征时，先让模型判断说话人是谁，再据此处理（防误报 + 补回）。
  const candidates = habitCandidatesForRow({ row, characters: entry.characters_raw || [] });
  const speakerCheck = candidates.length
    ? { chapter, candidates, block: speakerCheckBlock({ chapter, candidates }) }
    : null;
  // 行级收窄：章级块里的角色收窄到「本行提到他」或「本行原文出现了他的口癖」的那些。
  // 两条路径（落盘块还原 / 现算）都经同一函数，因此提示词逐字一致；
  // 收窄后没有任何角色时整段不注入（而不是留一段空标题）。
  const block = speechHabitBlockForRow({
    chapter,
    row,
    characters: entry.characters_raw || [],
    volume: entry.volume || context.volume || null,
  });
  if (!block && !speakerCheck) return null;
  // `chapterBlock` 只用于审计（章级口径 vs 行级收窄省了多少），不进请求：`block` 才是要注入的那一份。
  return { chapter, block, chapterBlock: entry.block || "", characters: entry.characters, speakerCheck };
}

// 对齐片段行：行边界由上游对齐切出（以续接标点结尾，或结尾本身就是一个接续词）。
// 这类行信息不完整，补相邻行也解决不了“这一行该怎么读”，所以模型再要上下文也不再重试。
// 只在模型已经返回 needsContext 之后才用它，因此不会主动把完整行判成缺陷。
const fragmentTrailingPunctuation = /[、，,：:；;]\s*$/u;
const fragmentTrailingConjunction = /(?:しかし|だが|でも|ところが|そして|また|つまり|ただし|だから|そこで|すると|ゆえに|なぜなら|それでも|けれども|けれど|けど|のに|ので)$/u;

function isAlignFragmentText(text) {
  const value = String(text || "").trim();
  if (!value) return false;
  return fragmentTrailingPunctuation.test(value) || fragmentTrailingConjunction.test(value);
}

function isAlignFragmentRow(row, targetKey) {
  return isAlignFragmentText(row?.jp) || isAlignFragmentText(row?.[targetKey]);
}

const CHINESE_FRAGMENT_CONJUNCTION = /^(?:可是|但是|不过|不過|然而|而且|并且|並且|因此|所以|于是|於是|只是|但|可|若|如果|即使|虽然|雖然|尽管|儘管|另外|此外|同时|同時|那么|那麼|便|就)[。！？!?、，,]?$/u;
const PURE_FRAGMENT_MAX_CHARS = 12;

function isPureFragmentText(text, lang = "jp") {
  const value = visibleInlineText(text);
  if (!value) return true;
  const stripped = value.replace(/^[\s「『“‘（(【[]+/u, "").replace(/[\s」』”’）)】\]。！？!?…‥、，,：:；;]+$/u, "").trim();
  if (!stripped) return true;
  if (lang === "jp") {
    if (fragmentTrailingConjunction.test(stripped)) return true;
  } else {
    if (CHINESE_FRAGMENT_CONJUNCTION.test(stripped)) return true;
  }
  if (isAlignFragmentText(value) && [...value].length <= PURE_FRAGMENT_MAX_CHARS) {
    return true;
  }
  return false;
}

/**
 * 纯对称片段行：两侧均为极短的残片或接续词（如「しかし、」↔「可是。」）。
 * 这类行无论补多少上下文都不改变其片段本质，索要上下文时直接终局转人工。
 */
function isPureSymmetricFragmentRow(row, targetKey) {
  const sourceIsPure = isPureFragmentText(row?.jp, "jp");
  const targetIsPure = isPureFragmentText(row?.[targetKey], "cn");
  return sourceIsPure && targetIsPure;
}

// 承接重复开头：短行是下一行开头的先现（例如「それは。」→「それはとても……」）。
// 它不是靠收尾形态能判出的片段行，而是必须拿下一行才能看见的跨行结构；检测到后基础轮就带上下一行，
// 避免模型把先现行的「それは / 虽然」当成独立指示代词或让步连词另行改译。
const CONTINUATION_MAX_OPENING_CHARS = 16;
const continuationLeadingMarks = /^[\s「『“‘（(【[]+/u;
const continuationTrailingMarks = /[\s」』”’）)】\]]+$/u;
const continuationTerminalMarks = /[。！？!?…‥、，,：:；;]+$/u;

function visibleInlineText(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function continuationOpening(value) {
  const text = visibleInlineText(value)
    .replace(continuationLeadingMarks, "")
    .replace(continuationTrailingMarks, "")
    .replace(continuationTerminalMarks, "")
    .trim();
  if (!text || [...text].length > CONTINUATION_MAX_OPENING_CHARS) return "";
  return /[A-Za-z0-9\u3040-\u30ff\u3400-\u9fff]/u.test(text) ? text : "";
}

function repeatedOpening(currentText, nextText) {
  const opening = continuationOpening(currentText);
  if (!opening) return "";
  const current = visibleInlineText(currentText);
  const next = visibleInlineText(nextText).replace(continuationLeadingMarks, "");
  if (!next || next === current || !next.startsWith(opening)) return "";
  const remainder = next.slice(opening.length).replace(/^[\s、，,：:；;]+/u, "");
  return remainder ? opening : "";
}

/**
 * 找出当前短行的下一行是否以同一开头完整承接。
 * 判定只以原文为准；目标列是否也保留重复开头作为 `targetEcho` 单独返回，供请求策略如实措辞。
 */
function findContinuationContext(rowIndex, rows, targetKey) {
  const position = rows.findIndex((item) => Number(item.index) === Number(rowIndex));
  if (position < 0 || position + 1 >= rows.length) return null;
  const row = rows[position];
  const nextRow = rows[position + 1];
  const sourceOpening = repeatedOpening(row?.jp, nextRow?.jp);
  if (!sourceOpening) return null;
  return {
    row: nextRow,
    relative: 1,
    relation: "next-row-same-opening",
    sourceOpening,
    targetEcho: Boolean(repeatedOpening(row?.[targetKey], nextRow?.[targetKey])),
  };
}

const CHINESE_THIRD_PERSON_PRONOUNS = /(?<![其吉维利排自])([他她它](?:们)?)(?![人])/u;
const JAPANESE_THIRD_PERSON_PRONOUNS = /(?:彼(?:ら|女(?:ら)?)?|あいつ(?:ら)?|やつ(?:ら)?|奴(?:ら)?|こいつ(?:ら)?|そいつ(?:ら)?|アイツ(?:ラ)?|ヤツ(?:ラ)?|コイツ(?:ラ)?|ソイツ(?:ラ)?)/u;

/**
 * 找出当前行是否在原文未直接给出第三人称代词的情况下，译文补充了第三人称代词（如「他/她/它/他们/她们/它们」）。
 * 若成立，则将同章前序 1~2 行作为指代依据主动带入基础轮请求，掐灭模型脱离前文脑补主体的空间。
 */
function findInferredSubjectContext(rowIndex, rows, targetKey) {
  const position = rows.findIndex((item) => Number(item.index) === Number(rowIndex));
  if (position <= 0) return null;
  const row = rows[position];
  const targetText = visibleInlineText(row?.[targetKey]);
  const sourceText = visibleInlineText(row?.jp);
  if (!targetText) return null;
  const pronounMatch = targetText.match(CHINESE_THIRD_PERSON_PRONOUNS);
  if (!pronounMatch) return null;
  if (JAPANESE_THIRD_PERSON_PRONOUNS.test(sourceText)) return null;

  const chapter = String(row?.chapter || "").trim();
  const candidates = [];
  const prevRow = rows[position - 1];
  if (!prevRow || String(prevRow.chapter || "").trim() !== chapter) return null;
  candidates.push({ row: prevRow, relative: -1 });

  // 若前一行是纯对话（以引号包裹）或过短（<= 12 字符），且再前一行仍在同章，可额外带上前第二行
  const prevSource = visibleInlineText(prevRow.jp);
  const isQuoteOnly = /^[\s「『“‘（(【[][\s\S]*[」』”’）)】\]]$/u.test(prevSource);
  if ((isQuoteOnly || [...prevSource].length <= 12) && position >= 2) {
    const prevPrevRow = rows[position - 2];
    if (prevPrevRow && String(prevPrevRow.chapter || "").trim() === chapter) {
      candidates.unshift({ row: prevPrevRow, relative: -2 });
    }
  }

  return {
    candidates,
    relation: "prev-row-inferred-subject",
    pronoun: pronounMatch[1],
  };
}

const SPEECH_MERGE_CHINESE_VERBS = /(?:问道|说道|喊道|答道|叹道|笑道|冷笑道|苦笑道|怒道|喝道|骂道|反问道|追问道|质问道|低语道|自语道|喃喃道|嘀咕道|心想|暗想|寻思|反问|询问|追问)[。！？!?]?\s*$/u;
const SPEECH_MERGE_COLON_VERBS = /(?:说|问|道|想|喊|答|叹|叫)[：:]\s*$/u;
const JAPANESE_EXPLICIT_SPEECH_VERBS = /(?:[言話訊尋問叫呟答述][っいたう]|思っ|考え)/u;
const JAPANESE_SUSPENDED_TRAILING = /(?:[てで]|ながら|つつ|たり)[、,]?\s*$/u;

/**
 * 找出当前行是否在原文为悬挂接续片段（如以连用形「て、/で、」或顿号「、」收尾、且未直接给出言语动词），
 * 而译文末尾包含了引述/言语动作动词（如「问道/说道/喊道/答道/反问」等）。
 * 若成立，则将同章下一行作为跨行引语合并的核对依据主动带入基础轮，
 * 避免模型因单行无法确证后文而停留在 needsContext 或被片段规则直接转人工。
 */
function findSpeechMergeContext(rowIndex, rows, targetKey) {
  const position = rows.findIndex((item) => Number(item.index) === Number(rowIndex));
  if (position < 0 || position + 1 >= rows.length) return null;
  const row = rows[position];
  const targetText = visibleInlineText(row?.[targetKey]);
  const sourceText = visibleInlineText(row?.jp);
  if (!targetText || !sourceText) return null;

  // 1. 译文末尾需含有言语/引述动词（或冒号引导）
  const verbMatch = targetText.match(SPEECH_MERGE_CHINESE_VERBS) || targetText.match(SPEECH_MERGE_COLON_VERBS);
  if (!verbMatch) return null;
  const verb = verbMatch[0].replace(/[。！？!?：:\s]+$/u, "");

  // 2. 原文必须呈现未完结的接续形态，且原文自身并未明确写出引述动词
  const isSuspended = fragmentTrailingPunctuation.test(sourceText)
    || JAPANESE_SUSPENDED_TRAILING.test(sourceText)
    || fragmentTrailingConjunction.test(sourceText);
  if (!isSuspended) return null;
  if (JAPANESE_EXPLICIT_SPEECH_VERBS.test(sourceText)) return null;

  // 3. 下一行必须在同一章节内
  const chapter = String(row?.chapter || "").trim();
  const nextRow = rows[position + 1];
  if (!nextRow || String(nextRow.chapter || "").trim() !== chapter) return null;

  return {
    row: nextRow,
    relative: 1,
    relation: "next-row-speech-merge",
    verb,
  };
}

function createContextState(rowIndex, rows, targetKey, counterpartKey, proofreadMode = "trilingual") {
  const position = rows.findIndex((item) => Number(item.index) === Number(rowIndex));
  return {
    rowIndex,
    rows,
    position,
    targetKey,
    counterpartKey,
    proofreadMode,
    included: new Set([String(rowIndex)]),
    items: [],
    radius: 0,
    chars: 0,
  };
}

function includeContextRow(state, row, relative, relation = "") {
  if (!row || state.items.length >= contextBudget.maxRows) return null;
  const id = String(row.index);
  if (state.included.has(id)) return null;
  const item = contextRow(row, relative, state.targetKey, state.counterpartKey, state.proofreadMode);
  if (relation) item.relation = relation;
  const nextChars = state.chars + contextItemChars(item);
  if (nextChars > contextBudget.maxChars && state.items.length > 0) return null;
  state.included.add(id);
  state.items.push(item);
  state.items.sort((a, b) => a.index - b.index);
  state.chars = nextChars;
  return item;
}

function expandContextRing(state) {
  if (state.position < 0) return [];
  state.radius += 1;
  const candidates = [];
  const before = state.rows[state.position - state.radius];
  const after = state.rows[state.position + state.radius];
  if (before) candidates.push({ row: before, relative: -state.radius });
  if (after) candidates.push({ row: after, relative: state.radius });

  const added = [];
  for (const candidate of candidates) {
    const item = includeContextRow(state, candidate.row, candidate.relative);
    if (item) added.push(item);
  }
  return added;
}

/**
 * 低分归因层要把窗口一次扩到前后各 `radius` 行（比按 needsContext 一轮一轮扩更省请求），
 * 同时仍受 `contextBudget` 的行数/字符上限约束：行用尽时 expandContextRing 返回空，循环即停。
 */
function ensureContextRadius(state, radius) {
  if (state.position < 0) return;
  const target = Math.max(1, Math.round(Number(radius) || 1));
  while (state.radius < target) {
    if (!expandContextRing(state).length) break;
  }
}

/** 本行前后至少还有一行时才谈得上“跨行错位”：首行/末行无从复核，直接跳过归因层。 */
function hasNeighborRow(state) {
  if (state.position < 0) return false;
  return Boolean(state.rows[state.position - 1] || state.rows[state.position + 1]);
}

function contextRow(row, relative, targetKey, counterpartKey, proofreadMode = "trilingual") {
  const item = {
    index: row.index,
    relative,
    position: relative < 0 ? `前 ${Math.abs(relative)} 行` : `后 ${relative} 行`,
    source: row.jp || "",
    target: textForKey(row, targetKey),
  };
  // 双语模式的对照列就是原文 A：再发一份 counterpart 只会把同一段文本重复给模型。
  if (proofreadMode !== "bilingual") item.counterpart = textForKey(row, counterpartKey);
  return item;
}

function textForKey(row, key) {
  if (key === "jp") return row.jp || "";
  if (key === "tw") return row.tw || "";
  return row.cn || "";
}

function contextItemChars(item) {
  return [item.source, item.target, item.counterpart]
    .reduce((sum, value) => sum + String(value || "").length, 0);
}

/**
 * 标点规范化层：把模型给出的修订结果按语境统一标点宽度（中文全角、英文半角），
 * 把中文语境的可配对双引号统一成直角引号，并补回被模型删掉的成对标记内侧句末点号，
 * 见 `punctuation.js`。
 *
 * 为什么要有这一层：成品规范要求中文正文全角标点、完整句的句末点号落在引号/括号内侧，
 * 而提示词只能“要求”做不到“保证”——实测模型会在自己的 revisedText 里打出「......」，
 * 也会把英文句子里的标点写成全角，还会把目标列本来就合规的句末点号判成「多出句号」删掉
 * （真实回归：第 898 行与第 1087 行）。备注里的「修改结果：」会被人工直接写回成品，
 * 所以这里做一次确定性统一与补回。
 *
 * 四条纪律：**只动标点**（不动任何其他字符，也不重排语序）；**英文句子保持半角**
 * （反向还原要求正向 ASCII 证据，见 `punctuation.js` 的 `isLatinContext`）；
 * **无法确定性配对的弯引号作废转人工**；**改了什么必须留痕**——计数走
 * `status.punctFixes`/`punctToFull`/`punctToHalf`/`punctQuotes`/`punctQuoteVoids`/`punctRestored`，
 * 备注的分析栏里写一行「标点自动规范化：…」（说明行必须排在「修改结果：」之前，见 `analysisLines`）。
 */
function normalizeDecisionPunctuation(decision, row, config, targetText = "") {
  if (!config?.punctNormalize || !decision?.revisedText) return decision;
  const width = normalizeTargetPunctuation(decision.revisedText);
  if (width.unresolvedQuotes) {
    status.punctQuoteVoids += 1;
    pushLog(`第 ${row.index} 行：修改结果含无法确定性配对的弯引号，已作废，等待终审裁决。`);
    return {
      ...decision,
      revisedText: "",
      suggestion: "",
      punctFix: null,
      quoteVoid: true,
      needsContext: true,
      better: "unclear",
      severity: "none",
      summary: [
        String(decision.summary || "").trim(),
        "模型给出的修改结果含无法确定性转换为「」的弯引号（可能未配对或处在英文语境），已作废，等待终审裁决——成品引号必须使用「」/『』。",
      ].filter(Boolean).join(" "),
    };
  }
  const terminal = restoreTerminalPunctuation(targetText, width.text);
  if (!width.changed && !terminal.changed) return decision;
  status.punctFixes += 1;
  status.punctToFull += width.toFull;
  status.punctToHalf += width.toHalf;
  status.punctQuotes += width.quotes;
  status.punctRestored += terminal.restored;
  const detail = [];
  if (width.toFull || width.toHalf) detail.push(`半角→全角 ${width.toFull} 处，全角→半角 ${width.toHalf} 处`);
  if (width.quotes) detail.push(`双引号→直角引号 ${width.quotes} 处`);
  if (terminal.restored) detail.push(`补回引号/括号内的句末点号 ${terminal.restored} 处`);
  pushLog(`第 ${row.index} 行：修改结果的标点已按成品写法统一（${detail.join("；")}）。`);
  return {
    ...decision,
    revisedText: terminal.text,
    punctFix: { toFull: width.toFull, toHalf: width.toHalf, quotes: width.quotes, restored: terminal.restored },
  };
}

/**
 * 成品格式门禁（确定性工序，输出侧的第一关，排在标点规范化与语言护栏之前）。
 *
 * 为什么要有这一层：`revisedText` 会被人工直接写回成品，而提示词只能“要求”，做不到“保证”。
 * 真实回归（第 1166 行）：原文那一行是两段（`…刺さったままだった。\n\n今のまま地面に…`），
 * 目标列只有一段，模型据此判定「译文把原文换行丢了」，把 `\n` 写进了修订结果——
 * 页面上修改结果被切成两行，写回时按 `\n{2,}` 分段的 `alignParts` 随之错位。行边界由对齐决定，
 * 不属于语言质量问题（通用侧提示词与低分归因层都写了这条，这里做确定性兜底）。
 *
 * 三档处置：
 * - **能确定性还原就修**：并回模型插入的换行/`<br>`/空行、去掉首尾空白，并把改了什么写进备注分析栏；
 * - **同一个行里的结构性事实对不上就作废转人工**：段数与目标列不一致（写回按段一一对应，猜错会
 *   静默删改源文件）、noteref 标记比目标列少或多（少是丢注释，多是从原文补入）；
 * - **永远顺手做的一件防呆**：`summary`/`suggestion` 里的换行折叠成空格——备注按行取值，
 *   说明字段里换行后若出现一行以「修改结果：」起头，解析层会把它当成成品文本覆盖真正的修订结果。
 *
 * 开关 `formatGuard:false` / `TRANSCOMPARATOR_FORMAT=0`；计数走 `status.formatFixes`/`formatVoids`/
 * `formatLineBreaks`/`formatParagraphs`/`formatNoteFields`，`finish()` 汇报一次。
 */
function applyFormatGuard(decision, row, config, targetText) {
  if (!config?.formatGuard || !decision) return decision;
  const result = guardRowFormat({
    revisedText: decision.revisedText,
    targetText,
    summary: decision.summary,
    suggestion: decision.suggestion,
  });
  const next = { ...decision, summary: result.summary, suggestion: result.suggestion };
  if (result.voided) {
    status.formatVoids += 1;
    pushLog(`第 ${row.index} 行：${result.detail}`);
    return {
      ...next,
      revisedText: "",
      suggestion: "",
      // 修订结果都作废了，标点规范化也就不存在了：一并抹掉，备注里不会留下空的「标点自动规范化」口径。
      punctFix: null,
      formatVoid: result.reason,
      needsContext: true,
      better: "unclear",
      severity: "none",
      summary: [String(next.summary || "").trim(), result.detail].filter(Boolean).join(" "),
    };
  }
  if (!result.changed) return next;
  status.formatFixes += 1;
  status.formatLineBreaks += result.fixes.lineBreaks;
  status.formatParagraphs += result.fixes.paragraphs;
  status.formatNoteFields += result.fixes.noteFields;
  pushLog(`第 ${row.index} 行：修改结果的格式已按成品结构规范化（${formatFixDetail(result.fixes)}）。`);
  return { ...next, revisedText: result.revisedText, formatFix: result.fixes };
}

/**
 * 目标列语言护栏：修订结果里混进原文（日文）文字时一律作废并转人工。
 *
 * 为什么需要：提示词只能“要求”模型，做不到“保证”。模型有两种情况下会写出带原文文字的修订结果——
 * ① 原文有注音标记（<ruby>鍋掴<rt>なべつか</rt></ruby>）而目标列没有，它判定“译文漏了注音”，
 *    手上却没有目标列的读音可写，于是照抄日文读音；② 上下文轮/低分归因轮把相邻行的原文
 *    当成了可复制文本。而备注里的「修改结果：」会被人工直接写回成品，等于把日文写进中文成品，
 * 所以这里必须有一道确定性闸门（提示词侧的同名约束写在 proofread-contract 的通用规则里）。
 *
 * 判据很窄（两条同时成立才拦）：目标列当前行**本来不含假名**（含则说明该列有刻意的假名写法，
 * 例如作品里允许的片假名口癖，不拦），而 revisedText 含假名。summary 里的原文引用不受影响——
 * 它只进备注，不进成品。
 */
const SOURCE_SCRIPT_PATTERN = /[\u3041-\u3096\u309d-\u309f\u30a1-\u30f6\u30fc]/u;

function hasTargetScriptLeak(revisedText, targetText) {
  const revised = String(revisedText || "");
  if (!revised || !SOURCE_SCRIPT_PATTERN.test(revised)) return false;
  return !SOURCE_SCRIPT_PATTERN.test(String(targetText || ""));
}

function guardTargetScript(decision, targetText) {
  if (!decision || !hasTargetScriptLeak(decision.revisedText, targetText)) return decision;
  return {
    ...decision,
    revisedText: "",
    suggestion: "",
    // 修订结果都作废了，标点规范化也就不存在了：一并抹掉，备注里不会出现「标点自动规范化」的空口径。
    punctFix: null,
    needsContext: true,
    better: "unclear",
    severity: "none",
    scriptLeak: true,
    summary: [
      String(decision.summary || "").trim(),
      "模型给出的修改结果混入了原文（日文）文字，已作废，等待终审裁决——成品不得写入原文文字。",
    ].filter(Boolean).join(" "),
  };
}

function ensureRevisedText(decision, targetKey, targetText, counterpartText, proofreadMode = "trilingual") {
  if (!decision.needsEdit || decision.better === "target" || decision.better === "unclear") return decision;
  if (decision.revisedText) return decision;

  const fallback = proofreadMode !== "bilingual" && decision.better === "counterpart"
    ? convertToTargetScript(counterpartText, targetKey)
    : "";
  return {
    ...decision,
    revisedText: fallback,
    summary: [decision.summary, fallback ? "模型未给出 revisedText，已使用另一版本转换为目标列字形作为完整修改结果。" : ""]
      .filter(Boolean)
      .join(" "),
  };
}

function convertToTargetScript(text, targetKey) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (targetKey === "cn") return toCn(value);
  if (targetKey === "tw") return toTw(value);
  return value;
}

function diffSummary(fromText, toText, labels) {
  if (!fromText || !toText) return "差异辅助未发现明显词级差异。";
  const hasCjk = /[\u4e00-\u9fa5\u3040-\u30ff]/.test(fromText + toText);
  const rawParts = hasCjk ? diffChars(fromText, toText) : diffWordsWithSpace(fromText, toText);
  // 合并连续的同类型片段，使字符级差异聚合为自然的词块
  const parts = [];
  for (const part of rawParts) {
    const last = parts[parts.length - 1];
    if (last && Boolean(last.added) === Boolean(part.added) && Boolean(last.removed) === Boolean(part.removed)) {
      last.value += part.value;
    } else {
      parts.push({ ...part });
    }
  }

  const changes = [];
  let totalChangedChars = 0;
  for (const part of parts) {
    const value = String(part.value || "").trim();
    if (!value) continue;
    if (part.removed || part.added) {
      totalChangedChars += value.length;
      if (part.removed) changes.push(`- ${value}`);
      if (part.added) changes.push(`+ ${value}`);
    }
  }
  const left = labels.cn || "非原文 B";
  const right = labels.tw || "非原文 C";
  if (!changes.length) {
    return "差异辅助未发现明显词级差异。";
  }
  // 限制与防杂乱收敛：若整句差异过于密集（超过12处变动或变更比例过高），碎词diff只会造成视觉与认知噪音，
  // 此时收敛为概括性边界提示，防止模型被参考列的琐碎差异误导或将非目标列句式强行搬运。
  const maxLen = Math.max(fromText.length, toText.length, 1);
  if (changes.length > 12 || (changes.length >= 6 && totalChangedChars / maxLen > 0.7)) {
    return `${left} 与 ${right} 差异较大（行文与句式各有特色）：仅供理解参考，严禁把参考列的风格差异当成错误，校对仍以原文 A 语义为唯一准绳。`;
  }
  // 正常微小差异，最多保留前 8 条关键差异，避免过长膨胀
  const cappedChanges = changes.slice(0, 8);
  const suffix = changes.length > 8 ? `\n...（其余 ${changes.length - 8} 处微小差异已折叠）` : "";
  return `${left} -> ${right}简体化\n${cappedChanges.join("\n")}${suffix}`;
}

/**
 * 按行裁剪的审计计数（每次任务重置；只记数字与特征分布，不落盘、不进产物）。
 * 目的是让人能看到“这一批请求到底省掉了什么”，而不是只能相信裁剪逻辑。
 * `entitySkipped` 是实体闸门的反向计数：本行没出现那个角色/专有词、因而被省掉的专属条目条数
 * （少了它，闸门静默失效时没人看得出来）。
 */
const promptTrim = {
  rows: 0,
  omittedLines: 0,
  omittedChars: 0,
  entitySkipped: 0,
  habitRows: 0,
  habitChars: 0,
  habitDroppedRows: 0,
  featureHits: new Map(),
  entityHits: new Map(),
};

function resetPromptTrim() {
  promptTrim.rows = 0;
  promptTrim.omittedLines = 0;
  promptTrim.omittedChars = 0;
  promptTrim.entitySkipped = 0;
  promptTrim.habitRows = 0;
  promptTrim.habitChars = 0;
  promptTrim.habitDroppedRows = 0;
  promptTrim.featureHits = new Map();
  promptTrim.entityHits = new Map();
}

/**
 * 说话习惯段的按行收窄计数（第 4 层的裁剪，与特化侧的条目裁剪分开记）：
 * 章级口径会把整章命中的角色规则发给该章每一行，行级收窄后只发给「提到该角色」或
 * 「原文出现了他的口癖」的行。这里记的是收窄前后实际注入的块大小与被整段省掉的行数，
 * 用来回答「这一段到底省了多少」——没有它，收窄失效时没人看得出来。
 */
function recordSpeechHabitTrim(chapterBlock = "", rowBlock = "") {
  const chapter = String(chapterBlock || "").length;
  const row = String(rowBlock || "").length;
  promptTrim.habitRows += 1;
  promptTrim.habitChars += row;
  if (chapter > 0 && row === 0) promptTrim.habitDroppedRows += 1;
}

function recordPromptTrim(config, rowFeatures, rowEntities, fullPrompt = false) {
  promptTrim.rows += 1;
  for (const id of rowFeatures) {
    promptTrim.featureHits.set(id, (promptTrim.featureHits.get(id) || 0) + 1);
  }
  if (fullPrompt) return;
  const profile = resolveProfile(config.profileId);
  const stats = profileLineStats(profile, { features: rowFeatures, entities: rowEntities });
  promptTrim.omittedLines += stats.omitted;
  promptTrim.omittedChars += stats.omittedChars;
  for (const id of entityGateReport(profile, rowEntities).hit) {
    promptTrim.entityHits.set(id, (promptTrim.entityHits.get(id) || 0) + 1);
  }
  promptTrim.entitySkipped += stats.entitySkipped;
}

function promptTrimSummary() {
  if (!promptTrim.rows) return "";
  const average = Math.round(promptTrim.omittedChars / promptTrim.rows);
  const top = [...promptTrim.featureHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([id, count]) => `${id} ${count} 行`)
    .join("、");
  const entities = [...promptTrim.entityHits.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, count]) => `${id} ${count} 行`)
    .join("、");
  const entityPart = promptTrim.entitySkipped
    ? `；其中角色/专有词专属条目因本行未出现该名字而省掉 ${promptTrim.entitySkipped} 次`
      + `（出现过的：${entities || "（无）"}）`
    : "";
  const habitPart = promptTrim.habitDroppedRows
    ? `；说话习惯段按行收窄：${promptTrim.habitDroppedRows} 行因本行没提到本章任何角色而整段未注入（收窄后共注入 ${promptTrim.habitChars} 字符）`
    : "";
  return `提示词按行裁剪：${promptTrim.rows} 行共省略 ${promptTrim.omittedLines} 条只在特定版式/文字现象或特定角色下才需要的特化规范（平均每行省约 ${average} 字符）${entityPart}${habitPart}；命中特征：${top || "（无）"}。`;
}

/**
 * 低分归因层的一次任务汇总：只有真的复核过才汇报。
 * 汇报的是“这一层到底做了什么”：复核了几行、其中多少行归到跨行错位、原因分布如何——
 * 人工据此判断是模型判分过狠（大量 none/source-style）还是译文真有大问题。
 */
function lowScoreSummary() {
  if (!status.lowScoreChecks) return "";
  const causes = Object.entries(status.lowScoreCauses || {})
    .sort((a, b) => b[1] - a[1])
    .map(([cause, count]) => `${causeLabel(cause) || cause} ${count} 行`)
    .join("、");
  return `低分归因：${status.lowScoreChecks} 行因扣分达到阈值转入复核（先解释低分原因再修，跨行错位为必查项），其中跨行错位 ${status.lowScoreShifted} 行${causes ? `；原因分布：${causes}` : ""}。`;
}

/** 线上查询层的一次任务汇总：只有真的用过才汇报，避免每次任务都刷一行“没用上”。 */
function webLookupSummary() {
  if (!status.webLookups) return "";
  const order = (status.webLookupSites || []).join(" → ") || "（未声明站点）";
  return `线上查证：${status.webLookups} 行模型判断不了，已按顺序查证 ${order} → 自行检索（共 ${status.webLookupAttempts} 轮，其中 ${status.webLookupResolved} 行据此得出结论，其余仍转人工）。`;
}

function buildMessages(payload, config = {}) {
  const bilingualMode = config.proofreadMode === "bilingual";
  const proofreadMode = bilingualMode ? "bilingual" : "trilingual";
  const profileId = resolveProfile(config.profileId).id;
  const contract = proofreadPromptFor(proofreadMode, profileId);
  const user = {
    task: `${bilingualMode ? "双语版本校对" : "三语语境校对"}；校对目标列：${payload.targetLabel}`,
    comparisonMode: proofreadMode,
    profile: { id: contract.profileId, name: contract.profileName },
    // 说话习惯层：完整规则与说话人判断口径都在系统提示词的【说话习惯】【说话人判断】段落里，
    // 这里只给出本行/本卷的范围与候选事实（谁、什么类型、期望写法、能否用于判断流失），
    // 不再复述规则句子。detectable=false 的候选只作说话人线索：理由有三种（未登记写法 /
    // 类型或长度不适合逐字比对 / 与日文同形的锁定写法），由系统提示词的说话人判断段按真实原因
    // 分开说明；这里只给事实（含 expected），不要把原因压成一句转述给模型。
    ...(payload.speechHabit?.speakerCheck ? {
      speakerCheck: {
        chapter: payload.speechHabit.speakerCheck.chapter,
        candidates: payload.speechHabit.speakerCheck.candidates.map((candidate) => ({
          character: candidate.character,
          type: candidate.type,
          habit: candidate.habit,
          expected: candidate.expected,
          confidence: candidate.confidence,
          detectable: candidate.detectable === true,
        })),
      },
    } : {}),
    ...(payload.speechHabit ? {
      chapterSpeechHabits: {
        scope: config.speechHabitScope === "volume" ? "volume" : "chapter",
        chapter: payload.speechHabit.chapter,
        characters: payload.speechHabit.characters,
      },
    } : {}),
    ...(payload.termGuidance ? {
      // 术语提示只影响“概念该用哪个译名”，不改变整行判断：系统提示词里已有完整边界说明，
      // 这里只列出本行实际命中的条目，并把结论字段交回给模型的常规判断。
      terms: {
        source: "译名对照表（本行命中的条目）",
        targetLabel: payload.targetLabel,
        items: payload.termGuidance.terms.map((term) => ({
          source: term.source,
          matchedAlias: term.alias,
          translation: term.target,
          type: term.type,
          note: term.note,
        })),
        note: "译文出现这些概念时必须使用对照表给出的标准译名；一致性只覆盖术语，句子的其余部分仍按常规规则逐项核对。",
      },
    } : {}),
    // 线上查询层：把「去哪个站点入口、查哪些词、问什么」给模型，由它自己站内查找（本机不抓网页）。
    // 一轮只给一个站点，程序按声明顺序推进，模型给出能定论的结论就停——后面的站点不再发。
    ...(payload.webLookup?.entries?.length ? (() => {
      const site = payload.webLookup.sites[payload.webLookup.round] || null;
      return {
        webLookup: {
          source: site ? `作品维基（第 ${payload.webLookup.round + 1} 站）` : "作品维基（官方站点均无结果，改为自行检索）",
          site: site ? { label: site.label, entry: site.url } : null,
          terms: payload.webLookup.entries.map((item) => ({
            terms: item.terms,
            excerpt: item.excerpt,
            target: item.targetText,
            type: item.type,
          })),
          note: site
            ? "请访问这个站点入口并在站内查找上面的词条；只依据实际查到的内容判断，打不开或搜不到就返回 needsContext=true / decision=unclear（程序会接着给下一个站点）；拿到能定论的关键信息就立即给结论，不要继续查别的来源。"
            : "官方站点都没有查到能用的信息。请用你自己的能力（浏览器、搜索引擎，或你确实掌握的可信资料）再找一次；取不到内容时不要用记忆顶替，照常返回 unable 判断。",
        },
      };
    })() : {}),
    // 低分归因层：只告诉模型“这一行的分数低到需要先归因”，阈值与窗口是程序参数，不写进请求。
    ...(payload.lowScore ? {
      lowScore: {
        reason: "本行初判为极低分（严重缺陷）。请按系统提示词的【低分归因与修复（本行）】段落，先给出低分原因（cause）再按原因修；跨行错位是必查项。",
        window: payload.lowScore.rows,
      },
    } : {}),
    ...(payload.continuation ? {
      continuation: {
        relation: payload.continuation.relation,
        targetEcho: payload.continuation.targetEcho === true,
      },
    } : {}),
    ...(payload.inferredSubject ? {
      inferredSubject: {
        relation: payload.inferredSubject.relation,
        pronoun: payload.inferredSubject.pronoun,
      },
    } : {}),
    ...(payload.speechMerge ? {
      speechMerge: {
        relation: payload.speechMerge.relation,
        verb: payload.speechMerge.verb,
      },
    } : {}),
    modePolicy: bilingualMode
      ? "A 是原文与准入边界，用于确认语义、遗漏、误译和增译；只能修改 B。"
      : "A 是原文与准入边界；B、C 同级，只修改所选目标列。",
    contextPolicy: [
      payload.contextMode === "auto"
        ? "已补相邻上下文，请据此给出最终判断。"
        : payload.contextMode === "requested"
          ? "已补相邻上下文；仍不足返回 needsContext=true，足够则给出最终判断。"
          : "只提供目标行；不足则返回 needsContext=true，不要猜测或为保险索要上下文。",
      payload.context?.length ? "相邻行只作判断依据，不是修改对象；revisedText 只针对当前目标行。" : "",
      payload.continuation
        ? (payload.continuation.targetEcho
          ? "本行与下一行构成同头承接：目标列已经沿用同一承接开头，必须把它当作上下句递进装置，不能把本行当独立句改译成另一个含义；revisedText 仍只写本行。"
          : "本行原文是下一行开头的短式先现（同头承接）。目标列没有沿用同一开头时，要结合下一行判断能否自然承接；不能脱离下一行把本行当独立句改译。revisedText 仍只写本行。")
        : "",
      payload.inferredSubject
        ? `目标列使用了原文未直接给出的代词「${payload.inferredSubject.pronoun}」，已自动带入前序上下文作为指代依据；请结合前文判断代词所指的行为主体是否成立，不得脱离前文臆测主体或误判为擅改主体。revisedText 仍只写本行。`
        : "",
      payload.speechMerge
        ? `原文为未完结的接续片段，而目标列末尾出现了引述动词「${payload.speechMerge.verb}」，疑似发生跨行引语合并；已自动提供下一行上下文作为核对依据。若下一行确实对应该说话内容或动作，属于合理的跨行语流调整，不应误判为擅自增译；revisedText 仍只针对当前目标行。`
        : "",
    ].filter(Boolean).join(" "),
    // contextBudget（轮数/行数/字符上限）与 contextExpansion 是程序内部参数，模型无法也无需据此判断，
    // 提示词已要求不得猜测上下文范围，因此不再随请求下发。
    outputSchema: contract.outputSchema,
    row: {
      index: payload.row.index,
      source: payload.row.jp || "",
      targetLabel: payload.targetLabel,
      targetText: payload.targetText || "",
      // 双语模式只有原文 A 与译文 B 两列，原文已经作为 source 给出，不再重复 counterpart 字段。
      ...(bilingualMode ? {} : {
        counterpartLabel: payload.counterpartLabel,
        counterpartText: payload.counterpartText || "",
        diffHelper: payload.diffHelper,
      }),
    },
    // 上下文只以实际行数据形式给出（含行号与相对位置），不再附带“补充几轮”这类程序细节。
    nearbyRows: payload.context,
  };
  const glossary = config.glossaryFile ? glossaryPrompt(loadGlossary(config.glossaryFile)) : "";
  // 按行裁剪：从本行原文与目标列文本探测特征（注音、加粗、译注标记、分页、省略号、引号、
  // 连接词、数字单位……），特化档案里声明了 features 的条目只在这时注入。探测与纪律见 row-features.js。
  const rowSource = payload.row.jp || payload.row.source || "";
  const rowTarget = payload.targetText || "";
  const rowFeatures = detectRowFeatures({ source: rowSource, target: rowTarget });
  // 实体闸门：档案里声明了 characters 的条目（只对某个角色/专有词成立的规则）只在本行真的出现
  // 那个名字时注入。判定与纪律见 name-entities.js；声明名单由档案给出，不在这一层猜作品设定。
  const rowEntities = detectRowEntities({
    source: rowSource,
    target: rowTarget,
    entities: profileEntities(resolveProfile(profileId)),
  });
  // 排查用：TRANSCOMPARATOR_FULL_PROMPT=1 时不做按行裁剪（特征与实体闸门一起退回全量）。
  const fullPrompt = process.env.TRANSCOMPARATOR_FULL_PROMPT === "1";
  recordPromptTrim(config, rowFeatures, rowEntities, fullPrompt);
  // 第 4 层的说话习惯段：`payload.speechHabit.block` 已经是**按行收窄**过的（见 speechHabitFor），
  // 这里记一次「章级块 vs 本行块」的对比供审计（`TRANSCOMPARATOR_FULL_PROMPT=1` 时两者相同，数字自然显示为“没有省”）。
  const habitBlock = [payload.speechHabit?.block || "", payload.speechHabit?.speakerCheck?.block || ""].filter(Boolean).join("\n");
  recordSpeechHabitTrim(payload.speechHabit?.chapterBlock || payload.speechHabit?.block || "", habitBlock);
  return [
    { role: "system", content: buildProofreadSystemPrompt({
      mode: proofreadMode,
      profileId,
      customSystem: config.systemPrompt,
      glossary,
      speechHabitBlock: habitBlock,
      termBlock: payload.termGuidance?.block || "",
      // 低分归因段：只在因极低分转入复核的那些轮次注入（段内自带归因口径与“保持原文行序”的修法）。
      lowScoreBlock: payload.lowScore
        ? lowScoreBlock({
          targetLabel: payload.targetLabel,
          sourceLabel: bilingualMode ? payload.counterpartLabel : "原文 A",
          rows: payload.lowScore.rows,
        })
        : "",
      webLookupBlock: webLookupBlock(payload.webLookup || {}),
      rowFeatures,
      rowEntities,
      sourceText: rowSource,
      targetText: rowTarget,
      fullPrompt,
    }) },
    { role: "user", content: JSON.stringify(user, null, 2) },
  ];
}

async function callModel(messages, config) {
  if (config.protocol === "claude") return callClaude(messages, config);
  return callOpenAiCompatible(messages, config);
}

async function callOpenAiCompatible(messages, config) {
  const startTime = Date.now();
  const headers = buildProtocolHeaders(config);
  const body = buildChatCompletionBody(messages, config);
  const data = await fetchJson(buildApiUrl(config.baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, { timeoutMs: MODEL_RESPONSE_TIMEOUT_MS });
  const latencyMs = Date.now() - startTime;
  const usage = {
    promptTokens: Number(data.usage?.prompt_tokens) || 0,
    completionTokens: Number(data.usage?.completion_tokens) || 0,
    totalTokens: Number(data.usage?.total_tokens) || 0,
  };
  recordModelCallMetrics(latencyMs, usage);
  const firstChoice = data.choices?.[0];
  if (firstChoice?.message?.refusal) {
    const error = new Error(`The model declined to answer: ${firstChoice.message.refusal}`);
    error.code = "MODEL_REFUSAL";
    throw error;
  }
  if (firstChoice?.finish_reason === "content_filter") {
    const error = new Error("The response was filtered due to the content management policy.");
    error.code = "CONTENT_FILTER";
    throw error;
  }
  return firstChoice?.message?.content || "";
}

async function callClaude(messages, config) {
  const startTime = Date.now();
  const data = await fetchJson(buildApiUrl(config.baseUrl, "/v1/messages"), {
    method: "POST",
    headers: buildProtocolHeaders(config),
    body: JSON.stringify(buildClaudeMessageBody(messages, config)),
  }, { timeoutMs: MODEL_RESPONSE_TIMEOUT_MS });
  const latencyMs = Date.now() - startTime;
  const usage = {
    promptTokens: Number(data.usage?.input_tokens) || 0,
    completionTokens: Number(data.usage?.output_tokens) || 0,
    totalTokens: (Number(data.usage?.input_tokens) || 0) + (Number(data.usage?.output_tokens) || 0),
  };
  recordModelCallMetrics(latencyMs, usage);
  if (data.stop_reason === "refusal") {
    const error = new Error("The model declined to answer (Claude refusal).");
    error.code = "MODEL_REFUSAL";
    throw error;
  }
  return extractClaudeText(data);
}

// 请求体构造与 JSON 传输以共享传输层 (src/ai/llm-client.js) 为唯一事实来源：
// 那里负责出站地址校验（拒绝云元数据 / link-local）、禁止自动跟随重定向与超时。
// AI 校对只在两点上做领域包装：GPT 系列放行任意合法推理档位（normalizeReasoningEffort），
// 以及把本轮请求登记到 `controllers` 以便「停止」时整体中止。

function buildChatCompletionBody(messages, config = {}, modelMeta = null) {
  return buildSharedChatCompletionBody(messages, config, modelMeta, { effortNormalizer: normalizeReasoningEffort });
}

async function fetchJson(url, options, fetchOptions = {}) {
  const track = fetchOptions.track !== false;
  const controller = new AbortController();
  if (track) controllers.add(controller);
  try {
    return await sharedFetchJson(url, options, {
      timeoutMs: fetchOptions.timeoutMs || 90000,
      signal: controller.signal,
    });
  } finally {
    if (track) controllers.delete(controller);
  }
}

function parseDecision(content, options = {}) {
  const proofreadMode = options.proofreadMode || "";
  const text = String(content || "").trim();
  const jsonText = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/) || ["{}"])[0];
  const data = JSON.parse(jsonText);
  const summary = firstString(data.summary, data.analysis, data.reason, data.explanation, data["分析"], data["分析过程"]);
  const revisedText = firstString(
    data.revisedText,
    data.revision,
    data.result,
    data.modifiedText,
    data.correctedText,
    data.replacement,
    data["修改结果"],
    data["修改后文本"],
    data["完整修改结果"]
  );
  const semanticSame = parseBoolean(data.semanticSame, false);
  // 双语契约用 decision=keep/replace/unclear 表达结论；旧提示词里的 better 仍然接受。
  const better = normalizeBetterValue(data.decision ?? data["结论"] ?? data.better, proofreadMode);
  const needsEdit = parseNeedsEdit(data.needsEdit, semanticSame, better);
  const rawScore = parseOptionalNumber(firstString(data.score, data["评分"], data["得分"], data["质量得分"]));
  const rawPenalty = parseOptionalNumber(firstString(data.penalty, data["扣分"], data["扣除分值"]));
  const rawGrade = firstString(data.grade, data["质量等级"], data["质量分级"], data["等级"]);
  const rawSeverity = firstString(data.severity, data.issueSeverity, data["严重程度"], data["严重性"]);
  // 说话人判断：只有提示词给出【说话人判断】时模型才会填；不确定时为空。
  const speaker = firstString(data.speaker, data["说话人"], data["说话者"], data.speakerName);
  // 低分归因：只有提示词给出【低分归因与修复（本行）】时才会填；认不出的取值按“未归因”处理。
  const cause = normalizeCause(firstString(data.cause, data["低分原因"], data["原因"], data["归因"], data.causeType));

  return normalizeDecision({
    semanticSame,
    needsEdit,
    needsContext: parseBoolean(data.needsContext, false),
    better,
    ...computeScoreAndGrade({
      needsEdit,
      rawScore,
      rawPenalty,
      rawGrade,
      rawSeverity,
    }),
    summary,
    speaker,
    cause,
    suggestion: String(data.suggestion || "").trim(),
    replacement: String(data.replacement || "").trim(),
    revisedText,
  });
}

function normalizeBetterValue(value, proofreadMode = "") {
  const better = normalizeBetter(value);
  // 双语没有“另一份译文”可比较：模型若答 counterpart，按“仍需修改”处理。
  if (proofreadMode === "bilingual" && better === "counterpart") return "neither";
  return better;
}

function normalizeBetter(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["target", "目标", "目标列", "当前列", "本列", "原目标", "keep", "保持", "保留", "维持", "不改", "无需修改"].includes(text)) return "target";
  if (["counterpart", "other", "另一列", "对照列", "对方", "另一版本", "参考列"].includes(text)) return "counterpart";
  if (["neither", "none", "都不", "都不好", "两者都不", "均不", "replace", "替换", "改写", "修订", "需要修改"].includes(text)) return "neither";
  if (["unclear", "unknown", "不确定", "无法判断", "待确认"].includes(text)) return "unclear";
  return ["target", "counterpart", "neither", "unclear"].includes(text) ? text : "unclear";
}

function parseNeedsEdit(value, semanticSame, better) {
  if (value !== undefined && value !== null && String(value).trim() !== "") {
    return parseBoolean(value, false);
  }
  if (better === "counterpart" || better === "neither") return true;
  if (semanticSame || better === "target") return false;
  return false;
}

function normalizeDecision(decision) {
  const intent = summaryIntent(decision.summary);
  let next = { ...decision };
  if (intent === "no-edit" && next.needsEdit) {
    next = {
      ...next,
      needsEdit: false,
      better: next.semanticSame ? "neither" : "target",
      revisedText: "",
      suggestion: "",
      score: 100,
      penalty: 0,
      grade: "excellent",
      severity: "none",
    };
  } else if (intent === "edit" && !next.needsEdit) {
    next = {
      ...next,
      needsEdit: true,
      better: next.better === "target" ? "unclear" : next.better,
      ...computeScoreAndGrade({
        needsEdit: true,
        rawScore: next.score === 100 ? null : next.score,
        rawPenalty: next.penalty === 0 ? null : next.penalty,
        rawGrade: next.grade === "excellent" ? null : next.grade,
        rawSeverity: next.severity === "none" ? null : next.severity,
      }),
    };
  }
  if (!next.needsEdit && next.revisedText) {
    next = { ...next, revisedText: "" };
  }
  if (!next.needsEdit) {
    next.score = 100;
    next.penalty = 0;
    next.grade = "excellent";
    next.severity = "none";
  } else if (next.needsContext || next.better === "unclear") {
    next.severity = "none";
  } else {
    next.severity = normalizeSeverity(next.severity, true);
  }
  return next;
}

function summaryIntent(summary) {
  const text = String(summary || "").replace(/\s+/g, "");
  if (!text) return "";
  if (/(无需|无须|不需|不需要|不用|不必)(修改|改写|修订|调整|优化)|无需改|不用改|保持目标列|目标列更(准确|自然|合适|好)|目标列已经/.test(text)) {
    return "no-edit";
  }
  if (/(需要|需|应|应该|建议)(修改|改写|修订|调整|优化|润色)|改为|修正为|以.+为基准|参考.+修订|进行局部优化|局部优化|作为修改结果|修改结果/.test(text)) {
    return "edit";
  }
  return "";
}

function decisionToResult(row, decision, targetLabel, counterpartLabel, targetKey = "", proofreadMode = "") {
  const bilingual = proofreadMode === "bilingual";
  // 双语没有“另一份译文”可比较：counterpart 一律按“仍需修改”处理。
  const better = bilingual && decision.better === "counterpart" ? "neither" : decision.better;
  const hasStageTraces = Boolean(
    decision.stylistReview ||
    decision.arbitration ||
    decision.stage === "gatekeeper" ||
    decision.stage === "stylist" ||
    decision.stage === "arbiter" ||
    decision.stage1Summary ||
    decision.stage1RevisedText ||
    Boolean(decision.summary && (decision.needsContext || better === "unclear" || decision.needsEdit))
  );
  const multiStageLines = hasStageTraces
    ? formatArbitrationNoteLines({
        gatekeeperDecision: decision,
        stylistReview: decision.stylistReview,
        arbitration: decision.arbitration,
      })
    : [];

  const effectiveStage = decision.stage || (decision.arbitration ? "arbiter" : (decision.stylistReview ? "stylist" : "gatekeeper"));
  const effectiveModelId = (effectiveStage === "arbiter" ? decision.arbitrationModelId : (effectiveStage === "stylist" ? decision.stylistModelId : status.model)) || status.model;
  // 「待人工确认」是终审的判决：只有真正走到终审的行才配这个结论。没经过终审的存疑行标成
  // 「待终审」——它还等着终审仲裁定案（当前没配终审，或者这条流水线没把它送进终审）。
  const arbitratedRow = Boolean(decision.arbitration) || effectiveStage === "arbiter";
  const unclearLabel = arbitratedRow ? "待人工确认" : "待终审";

  if (decision.needsContext || better === "unclear") {
    return {
      runId: status.runId,
      index: row.index,
      signature: rowSignature(row),
      targetKey,
      status: "suggestion",
      done: false,
      critique: decision.stylistReview?.critique || normalizeCritiqueResult({ attitude: "escalate", rationale: decision.summary }),
      arbitration: decision.arbitration || null,
      stageResult: normalizeReviewStageResult({
        stage: effectiveStage,
        modelId: effectiveModelId,
        persona: effectiveStage,
        needsEdit: decision.needsEdit,
        needsContext: decision.needsContext,
        decision: better,
        summary: decision.summary,
        revisedText: decision.revisedText,
        confidence: decision.score != null ? Number(decision.score) / 100 : null,
      }),
      note: [
        "[AI校对]",
        `语义是否相同：${decision.semanticSame ? "相同" : "不同"}`,
        `是否需要修改：${unclearLabel}`,
        speakerLine(decision),
        ...multiStageLines,
        ...analysisLines(decision),
      ].filter(Boolean).join("\n"),
    };
  }

  if (!decision.needsEdit) {
    return {
      runId: status.runId,
      index: row.index,
      signature: rowSignature(row),
      targetKey,
      // 双语只有原文 A 与译文 B，没有“目标列比另一份译文更好”这回事：
      // 语义不同却无需修改，表示 B 作为译文是成立的（keep），不是“比谁更好”。
      status: decision.semanticSame ? "same" : (bilingual ? "target-ok" : "target-better"),
      done: true,
      fastPass: isFastPassDecision(decision),
      critique: decision.stylistReview?.critique || null,
      arbitration: decision.arbitration || null,
      stageResult: normalizeReviewStageResult({
        stage: effectiveStage,
        modelId: effectiveModelId,
        persona: effectiveStage,
        needsEdit: decision.needsEdit,
        needsContext: decision.needsContext,
        decision: better,
        summary: decision.summary,
        revisedText: decision.revisedText,
        confidence: decision.score != null ? Number(decision.score) / 100 : null,
      }),
      note: [
        "[AI校对]",
        `语义是否相同：${decision.semanticSame ? "相同" : "不同"}`,
        "是否需要修改：否",
        // 快速直通必须落进备注：前端按备注复算指标，不写就只能把「未进复审的放行行」全当直通，直通率恒为 100%。
        isFastPassDecision(decision) ? "快速直通：是" : "",
        speakerLine(decision),
        ...multiStageLines,
        ...analysisLines(decision),
      ].filter(Boolean).join("\n"),
    };
  }

  const lines = ["[AI校对]"];
  lines.push(`语义是否相同：${decision.semanticSame ? "相同" : "不同"}`);
  if (decision.speaker) lines.push(speakerLine(decision));
  // 低分归因与线上查证都写在分析栏里（`analysisLines`），**不**跟在「修改结果：」后面——
  // 备注按行取值，放在后面的说明行会被并进修改结果，再被人工写回成品。
  if (better === "counterpart") {
    lines.push("是否需要修改：是");
    lines.push(...scoreAndGradeLines(decision));
    lines.push(...multiStageLines);
    lines.push(...analysisLines(decision, decision.revisedText ? "" : decision.suggestion || `参考${counterpartLabel}修订${targetLabel}。`));
    if (decision.revisedText) lines.push(`修改结果：${decision.revisedText}`);
  } else if (better === "neither") {
    lines.push("是否需要修改：是");
    lines.push(...scoreAndGradeLines(decision));
    lines.push(...multiStageLines);
    lines.push(...analysisLines(decision, decision.revisedText ? "" : decision.suggestion || "按原文重新整理译文。"));
    if (decision.revisedText) lines.push(`修改结果：${decision.revisedText}`);
  } else {
    lines.push(`是否需要修改：${unclearLabel}`);
    lines.push(...multiStageLines);
    lines.push(...analysisLines(decision));
  }

  return {
    runId: status.runId,
    index: row.index,
    signature: rowSignature(row),
    targetKey,
    status: "suggestion",
    done: false,
    critique: decision.stylistReview?.critique || normalizeCritiqueResult({
      // A concrete revision is a modification proposal. Without a concrete
      // revisedText the row cannot be accepted automatically and remains an
      // escalation candidate.
      attitude: better === "unclear" || !decision.revisedText ? "escalate" : "modify",
      rationale: decision.summary,
      acceptedChanges: decision.revisedText ? [decision.revisedText] : [],
    }),
    arbitration: decision.arbitration || null,
    stageResult: normalizeReviewStageResult({
      stage: effectiveStage,
      modelId: effectiveModelId,
      persona: effectiveStage,
      needsEdit: decision.needsEdit,
      needsContext: decision.needsContext,
      decision: better,
      summary: decision.summary,
      revisedText: decision.revisedText,
      confidence: decision.score != null ? Number(decision.score) / 100 : null,
    }),
    note: lines.join("\n"),
  };
}

function scoreAndGradeLines(decision) {
  const gradeLabels = { excellent: "优等", good: "良好", fair: "一般", poor: "较差" };
  const severityLabels = { minor: "轻微", major: "严重", critical: "致命", none: "无" };
  const lines = [];
  if (decision.score !== undefined && decision.score !== null) {
    lines.push(`质量评分：${decision.score}分（扣${decision.penalty || 0}分）`);
  }
  if (decision.grade) {
    lines.push(`质量分级：${gradeLabels[decision.grade] || "一般"}`);
  }
  if (decision.severity && decision.severity !== "none") {
    lines.push(`严重程度：${severityLabels[normalizeSeverity(decision.severity, true)] || "严重"}`);
  }
  return lines;
}

function speakerLine(decision) {
  return decision.speaker ? `说话人：${decision.speaker}（据说话习惯特征判断）` : "";
}

/**
 * 低分归因在备注里的那一行：人工只读结果，也要能一眼看出“这行为什么低分、按哪一类原因修的”。
 * 没有进入归因层的行走不到这里（`decision.lowScore` 只在那一层才挂上）。
 */
function lowScoreLine(decision) {
  if (!decision?.lowScore) return "";
  return lowScoreNote({
    checked: decision.lowScore.checked === true,
    cause: decision.lowScore.cause || "",
    neighbors: decision.lowScore.neighbors || 0,
  });
}

/**
 * 线上查证在备注里的那一行：人工只读结果，也必须能看出结论的依据来自哪里。
 * 没有进入线上查询层的行走不到这里（`decision.webLookup` 只在那一轮才挂上）。
 */
function webLookupLine(decision) {
  if (!decision?.webLookup) return "";
  return webLookupNote({
    concluded: decision.webLookup.concluded === true,
    siteLabel: decision.webLookup.siteLabel || "",
    triedLabels: decision.webLookup.triedLabels || [],
  });
}

/**
 * 分析栏的那几行：模型给的 summary / fallback，加上**确定性层**留在分析里的痕迹
 * （格式自动规范化、标点自动规范化、低分归因、线上查证）。它们必须排在「修改结果：」**之前**：
 * 备注是按行取值的（`public/workbench-client.js` 的 `parseAutomatedNote`），跟在「修改结果：」后面的
 * 未识别行会被并进修改结果，而修改结果在页面上就是可写回文本——那等于把说明写进成品。
 */
function analysisLines(decision, fallback = "") {
  const text = [decision.summary, fallback].filter(Boolean).join(" ");
  return [
    text ? `分析：${text}` : "",
    formatFixLine(decision),
    punctFixLine(decision),
    lowScoreLine(decision),
    webLookupLine(decision),
  ].filter(Boolean);
}

/**
 * 成品格式门禁在备注里的那一行：程序并回了模型插入的换行/段落时如实留痕（它不是模型写的措辞）。
 * 只有真的改过格式才留痕（`decision.formatFix` 只在 `applyFormatGuard` 里挂上）；
 * 因格式无法确定性还原而**作废**的行不写这一行——原因已经并进 `summary`，写在「分析：」里。
 */
function formatFixLine(decision) {
  return formatFixNote(decision?.formatFix);
}

/**
 * 标点规范化在备注里的那一行：程序改过模型输出就必须让人工看见（它不是模型写的措辞）。
 * 只有真的改过才留痕（`decision.punctFix` 只在 `normalizeDecisionPunctuation` 里挂上）。
 */
function punctFixLine(decision) {
  const fix = decision?.punctFix;
  if (!fix) return "";
  const parts = [];
  if (fix.toFull) parts.push(`半角→全角 ${fix.toFull} 处`);
  if (fix.toHalf) parts.push(`全角→半角 ${fix.toHalf} 处`);
  if (fix.quotes) parts.push(`弯引号/直双引号→直角引号 ${fix.quotes} 处`);
  if (fix.restored) parts.push(`补回引号/括号内的句末点号 ${fix.restored} 处`);
  if (!parts.length) return "";
  // 宽度口径的括注只在真的动过宽度时才出现；只补回句末点号时那句话与它无关。
  const suffix = (fix.toFull || fix.toHalf) ? "（中文标点全角、英文句子半角）" : "";
  return `标点自动规范化：${parts.join("、")}${suffix}`;
}

module.exports = {
  buildApiUrl,
  buildChatCompletionBody,
  buildClaudeMessageBody,
  buildMessages,
  buildProtocolHeaders,
  callModel,
  clearProofreadCache,
  clearProofreadResults,
  clientStatus,
  decisionToResult,
  detectModelCapabilities,
  diffSummary,
  extractClaudeText,
  findContinuationContext,
  findInferredSubjectContext,
  findSpeechMergeContext,
  guardTargetScript,
  hasTargetScriptLeak,
  isConcurrencyOrRateLimitError,
  parseRateLimitReason,
  isGptModel,
  isModelRefusalError,
  isAlignFragmentRow,
  isAlignFragmentText,
  isPureSymmetricFragmentRow,
  isReasoningModel,
  listModels,
  loadModelsDev,
  normalizeModelReasoningEffort,
  normalizeNonGptTemperature,
  normalizeReasoningEffort,
  normalizeGrade,
  normalizeSeverity,
  parseDecision,
  protocolDefaults,
  proofreadPromptFor,
  proofreadPrompts,
  promptTrimSummary,
  resetPromptTrim,
  DEFAULT_PROFILE_ID,
  listProfiles,
  resolveProfile,
  startPrefilter,
  startProofread,
  stopProofread,
  updateStagePresets,
  recordHumanFeedback: (event) => globalFeedbackCollector.record(event),
  getFeedbackStatistics: () => globalFeedbackCollector.getStatistics(),
  globalFeedbackCollector,
  scheduleModels,
  getModelProfile,
  createPersonaContext,
  runStage1Gatekeeper,
  runStage2Stylist,
  runStage3Arbiter,
  isStage3DisputeRow,
  isStage2Candidate,
  finalizeRowResult,
  proofreadRow,
  testModel,
  cleanConfig,
  cleanSubStageConfig,
  stagePlan,
  shouldCascadeStages,
  reusePreviousResults,
};
