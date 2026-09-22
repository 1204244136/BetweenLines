const fs = require("fs");
const { diffWordsWithSpace } = require("diff");
const OpenCC = require("opencc-js");
const { toCn } = require("../../../ingest/text-utils");
const { classifyPrefilter } = require("./ai-prefilter");
const { displayTermPair, evaluateTermRow, loadTermTables, normalizeTermTablePaths, termTableSummary } = require("./term-table");
const { makeTermResult, termGuidanceFor, termTargetKeyFor } = require("./term-prefilter");
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
  CLAUDE_THINKING_BUDGETS,
  loadModelsDev,
} = require("./model-capabilities");
const {
  TEXT_INTENSITY_TEMPERATURE_MAP,
  buildApiUrl,
  buildProviderHeaders,
  extractClaudeText,
  isGptModel,
  normalizeNonGptTemperature,
  testModelConnectivity,
} = require("../../../ai/llm-client");
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
  normalizeArbitrationResult,
  reviewStageResultFromLegacy,
  isFastPassDecision,
} = require("./stage-results");
const {
  PERSONAS,
  PERSONA_DEFINITIONS,
  buildPersonaSystemPrompt,
  buildStylistMessages,
  buildArbiterMessages,
  parseStylistResponse,
  parseArbiterResponse,
  createPersonaContext,
} = require("./persona-runtime");
const {
  shouldTriggerArbitration,
  resolveDeterministicAgreement,
  applyArbitrationDecision,
  formatArbitrationNoteLines,
} = require("./arbiter");
const {
  getModelProfile,
  scheduleModels,
} = require("./scheduler-profile");
const {
  globalFeedbackCollector,
} = require("./feedback-collector");

const providerDefaults = {
  claude: {
    name: "Claude",
    baseUrl: "https://api.anthropic.com",
    model: "claude-sonnet-5",
    apiKeyPlaceholder: "填写 Claude Console API Key",
    note: "Claude 原生 Messages API；地址可填写主机或带 /v1 的 Base URL。",
  },
  compatible: {
    name: "第三方兼容服务",
    baseUrl: "",
    model: "",
    apiKeyPlaceholder: "按第三方服务要求填写",
    note: "第三方兼容服务需要填写服务商提供的 Base URL 和模型名。",
  },
  local: {
    name: "本地默认",
    baseUrl: "http://127.0.0.1:11434/v1",
    model: "qwen2.5:14b-instruct",
    apiKeyPlaceholder: "本地兼容服务通常可留空",
    note: "本地默认使用本机 OpenAI-compatible /v1 接口；如端口或模型不同，请按实际服务修改。",
  },
};

const knownModelFallbacks = [
  {
    pattern: /(?:^|\.)xiaomimimo\.com(?:\/|$)|(?:^|\/\/)token-plan-cn\.xiaomimimo\.com(?:\/|$)/i,
    models: [
      { id: "mimo-v2.5-pro", name: "MiMo V2.5 Pro", provider: "compatible", fallback: true },
      { id: "mimo-v2.5", name: "MiMo V2.5", provider: "compatible", fallback: true },
    ],
  },
];


const reasoningEfforts = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);

// isGptModel 与共享传输层 (src/ai/llm-client.js) 同源，那里是唯一事实来源。

function normalizeReasoningEffort(value, model, modelMeta = null) {
  const effort = String(value || "").trim().toLowerCase();
  if (isGptModel(model) && reasoningEfforts.has(effort)) return effort;
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

const errorCircuitBreaker = {
  minimumSamples: 10,
  windowSize: 20,
  errorRate: 0.5,
  minErrorRate: 0.1,
};

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
  provider: "local",
  model: "",
  reasoningEffort: "",
  projectKey: "",
  rowsSignature: "",
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
  // 输出侧护栏：revisedText 混入原文（日文）文字而被作废、转人工确认的行数（见 guardTargetScript）。
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
  stageMetrics: createStageMetrics(),
  stagePipelines: createStagePipelines(),
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
let recentModelOutcomes = [];

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
  const sameRun = Boolean(options.runId) && options.runId === status.runId;
  const afterRevision = sameRun ? clampInteger(options.afterRevision, 0, Number.MAX_SAFE_INTEGER, 0) : 0;
  const resultLimit = clampInteger(options.resultLimit, 0, 500, 0);
  const incrementalResults = status.resultChanges.slice(afterRevision, resultLimit ? afterRevision + resultLimit : undefined);
  const results = options.includeResults === false
    ? []
    : (resultLimit || afterRevision
      ? incrementalResults
      : Array.from(status.results.values()).sort((a, b) => a.index - b.index));
  const deliveredRevision = options.includeResults === false
    ? afterRevision
    : (resultLimit || afterRevision
      ? (results.length ? results.at(-1).resultRevision : afterRevision)
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
    provider: status.provider,
    model: status.model,
    reasoningEffort: status.reasoningEffort,
    projectKey: status.projectKey,
    rowsSignature: status.rowsSignature,
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
    smartConcurrency: status.smartConcurrency,
    currentConcurrency: status.currentConcurrency,
    concurrencyMax: status.concurrencyMax,
    concurrencyUps: status.concurrencyUps,
    concurrencyDowns: status.concurrencyDowns,
    concurrencyLimits: status.concurrencyLimits,
    peakConcurrency: status.peakConcurrency,
    termRubySkipped: status.termRubySkipped,
    termRubyDemoted: status.termRubyDemoted,
    // 输出侧护栏：多少行的修订结果因混入原文文字被作废（它们已转人工确认，不是失败）。
    scriptLeaks: status.scriptLeaks,
    // 成品格式门禁：这一层是否启用、多少行的修订结果被修正过格式（换行/多余段落/说明字段各多少处）、
    // 多少行因格式无法确定性还原被作废（作废行同样已转人工确认）。
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
    stageMetrics: { ...status.stageMetrics },
    stagePipelines: createStagePipelines(status.stagePipelines),
    metrics: { ...status.metrics },
    feedbackStats: globalFeedbackCollector.getStatistics(),
    logs: options.includeLogs === false ? [] : status.logs,
    results,
    resultRevision: deliveredRevision,
    latestResultRevision: status.resultRevision,
    hasMoreResults: deliveredRevision < status.resultRevision,
    providerDefaults,
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

function cleanConfig(input = {}) {
  const provider = providerDefaults[input.provider] ? input.provider : "local";
  const defaults = providerDefaults[provider];
  const target = input.target === "tw" ? "tw" : "cn";
  const proofreadMode = input.proofreadMode === "trilingual" ? "trilingual" : "bilingual";
  const envSmart = process.env.TRANSCOMPARATOR_SMART_CONCURRENCY === "1";
  const smartConcurrency = input.smartConcurrency != null ? Boolean(input.smartConcurrency) : envSmart;
  const concurrency = clampInteger(input.concurrency, 1, 12, 3);
  const envMax = process.env.TRANSCOMPARATOR_CONCURRENCY_MAX ? Number(process.env.TRANSCOMPARATOR_CONCURRENCY_MAX) : null;
  const rawConcurrencyMax = input.concurrencyMax != null ? Number(input.concurrencyMax) : (envMax ?? 10);
  const concurrencyMax = Math.max(concurrency, clampInteger(rawConcurrencyMax, 1, 20, 10));
  const similarityThreshold = clampNumber(input.similarityThreshold, 0.5, 1, 0.92);
  const circuitBreakerErrorRate = clampNumber(
    input.circuitBreakerErrorRate,
    errorCircuitBreaker.minErrorRate,
    1,
    errorCircuitBreaker.errorRate,
  );
  const model = String(input.model || defaults.model).trim();
  // 特化侧档案：未知 id 一律回落到默认档案，避免旧客户端或手填值把提示词打空。
  // 档案决定默认提示词与两类辅助数据表，这里只解析一次。
  const profile = resolveProfile(input.profileId);
  const profileId = profile.id;
  // 线上查证的官方站点：显式传入（测试/临时）> 环境变量（换站点）> 档案声明；顺序就是查询顺序。
  // 字符串形式按 `;` 与换行拆分（环境变量友好），对象形式 `{ label, url }` 原样使用。
  const inputSites = Array.isArray(input.wikiSites) ? input.wikiSites : toPathList(input.wikiSites);
  const envSites = toPathList(process.env.TRANSCOMPARATOR_WIKI_SITES);
  return {
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
    smartConcurrency,
    concurrencyMax,
    similarityThreshold,
    circuitBreakerErrorRate,
    circuitBreakerEnabled: input.circuitBreakerEnabled !== false,
    projectKey: String(input.projectKey || "").trim(),
    rowsSignature: String(input.rowsSignature || "").trim(),
    baseUrl: String(input.baseUrl || defaults.baseUrl).trim().replace(/\/+$/, ""),
    model,
    reasoningEffort: (isGptModel(model) || isReasoningModel(model))
      ? normalizeReasoningEffort(input.reasoningEffort, model)
      : normalizeNonGptIntensity(input.reasoningEffort),
    apiKey: String(input.apiKey || "").trim(),
    systemPrompt: String(input.systemPrompt || "").trim() || proofreadPromptFor(proofreadMode, profileId).system,
    glossaryFile: String(input.glossaryFile || "").trim(),
    completedIndexes: normalizeIndexSet(input.completedIndexes),
    multiStageEnabled: Boolean(input.multiStageEnabled || input.challengerEnabled || input.singleModelPersona || input.stylistConfig || input.stage2Preset),
    challengerEnabled: Boolean(input.challengerEnabled),
    singleModelPersona: Boolean(input.singleModelPersona),
    arbiterEnabled: input.arbiterEnabled !== false,
    stylistConfig: input.stylistConfig ? cleanSubStageConfig(input.stylistConfig, defaults) : (input.stage2Preset ? cleanSubStageConfig(input.stage2Preset, defaults) : null),
    arbiterConfig: input.arbiterConfig ? cleanSubStageConfig(input.arbiterConfig, defaults) : (input.stage3Preset ? cleanSubStageConfig(input.stage3Preset, defaults) : null),
    // 本次任务里命中的行：术语提示段落按行号在此登记，跑任务时注入提示词（含术语冲突行）。
    termContext: new Map(),
    // 术语冲突（对照表有强证据差异）的行号：这些行**必须**经过模型，不能被规则/相似度预筛挡掉。
    termConflictIndexes: new Set(),
  };
}

function cleanSubStageConfig(input = {}, fallbackDefaults = {}) {
  if (!input || typeof input !== "object") return null;
  const provider = providerDefaults[input.provider] ? input.provider : "local";
  const defaults = providerDefaults[provider] || fallbackDefaults;
  const model = String(input.model || defaults.model || "").trim();
  if (!model) return null;
  const baseUrl = String(input.baseUrl || defaults.baseUrl || "").trim().replace(/\/+$/, "");
  const apiKey = String(input.apiKey || "").trim();
  const reasoningEffort = (isGptModel(model) || isReasoningModel(model))
    ? normalizeReasoningEffort(input.reasoningEffort, model)
    : normalizeNonGptIntensity(input.reasoningEffort);
  return {
    provider,
    baseUrl,
    model,
    apiKey,
    reasoningEffort,
  };
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
  status.provider = config.provider;
  status.model = config.model;
  status.reasoningEffort = config.reasoningEffort;
  status.projectKey = config.projectKey;
  status.rowsSignature = config.rowsSignature;
  status.concurrency = config.concurrency;
  status.smartConcurrency = Boolean(config.smartConcurrency);
  status.currentConcurrency = config.concurrency;
  status.concurrencyMax = config.concurrencyMax;
  status.concurrencyUps = 0;
  status.concurrencyDowns = 0;
  status.concurrencyLimits = 0;
  status.peakConcurrency = config.concurrency;
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
  status.stageMetrics = createStageMetrics();
  status.stagePipelines = createStagePipelines();
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
  status.resultChanges = [];
  status.resultRevision = 0;
  controllers = new Set();
  recentModelOutcomes = [];
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
    // Deterministic prefilter results are the first Fast Pass implementation:
    // they complete without spending a model request.
    if (result.done) {
      status.stageMetrics.fastPassHits += 1;
      status.stageMetrics.stage1Passed += 1;
    }
  } else {
    status.modelProcessed += 1;
    if (result.done) status.modelHandled += 1;
    // A model result that closes without a suggestion is the Gatekeeper's
    // positive path. Suggestions are the first observable Stylist review
    // boundary; keeping these counters here preserves one execution loop.
    if (result.done) status.stageMetrics.stage1Passed += 1;
    if (result.fastPass === true) status.stageMetrics.fastPassHits += 1;
    if (result.status === "suggestion") status.stageMetrics.stage2Reviewed += 1;
    if (result.stageSignals?.lowScore) status.stageMetrics.lowScoreHits += 1;
    if (result.stageSignals?.webLookup) status.stageMetrics.webLookupHits += 1;
    const attitude = result.critique?.attitude;
    if (attitude === "accept") status.stageMetrics.critiqueAccept += 1;
    if (attitude === "reject") status.stageMetrics.critiqueReject += 1;
    if (attitude === "modify") status.stageMetrics.critiqueModify += 1;
    if (attitude === "escalate") status.stageMetrics.critiqueEscalate += 1;
    if (result.arbitration || result.stageResult?.stage === "arbiter") {
      status.stageMetrics.stage3Arbitrated += 1;
    }
  }
  if (result.status === "suggestion") status.suggested += 1;
  if (result.status === "error") status.errors += 1;
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
  config.proofreadMode = project.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  config.termLayer = termPrefilter;
  if (!String(input.systemPrompt || "").trim()) {
    config.systemPrompt = proofreadPromptFor(config.proofreadMode, config.profileId).system;
  }
  if (config.proofreadMode === "bilingual") config.target = "cn";
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
  // 对照表预处理：先于规则/相似度预筛运行——命中的行直接用表里的内容判定，不再交给模型。
  const resolvedByTermTable = applyTermTable(config, rows, labels);

  for (const row of rows) {
    if (config.completedIndexes.has(Number(row.index))) {
      status.skippedDone += 1;
      continue;
    }
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

  status.queued = queue.length;
  pushLog(`${config.proofreadMode === "bilingual" ? "双语版本校对" : "三语语境校对"}：人工确认跳过 ${status.skippedDone} 行，对照表跳过 ${status.termPrefiltered} 行，对照表注入术语 ${status.termInjected} 行（照常交给模型，含术语冲突行），规则跳过 ${status.rulePrefiltered} 行，结构化冲突 ${status.structuredConflicts} 行，相似度跳过 ${status.similarityPrefiltered} 行，术语冲突 ${status.termConflicts} 行不吃预筛、留给 AI 判断，剩余 ${queue.length} 行进入 AI 校对。`);
  pushLog(config.smartConcurrency
    ? `智能并发：已开启，初始并发 ${config.concurrency}，上限 ${config.concurrencyMax}。稳定请求自动上探，遭遇频控限制自动退避降速。`
    : `并发设置：固定并发 ${config.concurrency}。`);
  pushLog(config.circuitBreakerEnabled
    ? `错误率熔断：最近 ${errorCircuitBreaker.windowSize} 次调用中失败占比达到 ${Math.round(config.circuitBreakerErrorRate * 100)}% 时自动终止。`
    : "错误率熔断：已关闭，调用失败不会自动终止任务。");
  runQueue(queue, rows, config, labels).catch((error) => {
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
    const headers = buildProviderHeaders(config);
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
    const caps = detectModelCapabilities(id, provider, modelsDevData);
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

// buildApiUrl / buildProviderHeaders 与共享传输层 (src/ai/llm-client.js) 同源。

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

function clearProofreadCache() {
  if (status.running) {
    const error = new Error(status.kind === "prefilter" ? "预筛选正在运行，请先停止任务再清除缓存。" : "AI 校对正在运行，请先停止任务再清除缓存。");
    error.code = "RUNNING";
    throw error;
  }
  status.stopRequested = false;
  status.kind = "proofread";
  status.runId = "";
  status.startedAt = null;
  status.finishedAt = null;
  status.projectKey = "";
  status.rowsSignature = "";
  status.concurrency = 3;
  status.smartConcurrency = false;
  status.currentConcurrency = 3;
  status.concurrencyMax = 10;
  status.concurrencyUps = 0;
  status.concurrencyDowns = 0;
  status.concurrencyLimits = 0;
  status.peakConcurrency = 3;
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
  status.stageMetrics = createStageMetrics();
  status.stagePipelines = createStagePipelines();
  status.logs = [];
  status.results = new Map();
  status.resultChanges = [];
  status.resultRevision = 0;
  controllers = new Set();
  recentModelOutcomes = [];
  return clientStatus();
}

let currentQueueWakeup = null;

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

async function runQueue(queue, allRows, config, labels) {
  const isSmart = Boolean(config.smartConcurrency);
  let currentConcurrency = config.concurrency;
  const maxConcurrency = isSmart ? config.concurrencyMax : config.concurrency;
  const minConcurrency = 1;

  status.smartConcurrency = isSmart;
  status.concurrency = config.concurrency;
  status.currentConcurrency = currentConcurrency;
  status.concurrencyMax = maxConcurrency;
  status.peakConcurrency = currentConcurrency;
  status.concurrencyUps = 0;
  status.concurrencyDowns = 0;
  status.concurrencyLimits = 0;

  // 流水线阶段解耦队列（Staged Pipelining Queues）
  // Stage 1 事实初审一产出建议，立刻推入 Stage 2 队列，Stylist 无需等待后续行的初审！
  const stage1Pending = [...queue];
  const stage2Pending = [];
  const stage3Pending = [];

  let stage1InFlight = 0;
  let stage2InFlight = 0;
  let stage3InFlight = 0;

  function syncStagePipelineQueues() {
    status.stagePipelines.stage1.pending = stage1Pending.length;
    status.stagePipelines.stage1.inFlight = stage1InFlight;
    status.stagePipelines.stage2.pending = stage2Pending.length;
    status.stagePipelines.stage2.inFlight = stage2InFlight;
    status.stagePipelines.stage3.pending = stage3Pending.length;
    status.stagePipelines.stage3.inFlight = stage3InFlight;
  }
  syncStagePipelineQueues();

  const stage2Concurrency = Math.max(1, Math.min(config.concurrencyMax || config.concurrency || 3, 4));
  const stage3Concurrency = 2;

  let consecutiveSuccesses = 0;
  let consecutiveLimits = 0;
  let lastAdjustmentAt = Date.now();
  let lastScaleDownAt = 0;
  let backoffUntil = 0;
  let backoffTimer = null;
  const rowRetryCounts = new Map();
  const maxRowRetries = 3;
  const scaleUpThreshold = 5;
  const minProbeIntervalMs = Number(process.env.TRANSCOMPARATOR_SMART_PROBE_INTERVAL) || 3000;

  return new Promise((resolve) => {
    let settled = false;

    function checkDone() {
      if (settled) return;
      const allEmpty = stage1Pending.length === 0 && stage1InFlight === 0
        && stage2Pending.length === 0 && stage2InFlight === 0
        && stage3Pending.length === 0 && stage3InFlight === 0;

      if (status.stopRequested || allEmpty) {
        settled = true;
        if (backoffTimer) {
          clearTimeout(backoffTimer);
          backoffTimer = null;
        }
        currentQueueWakeup = null;
        finish();
        resolve();
      }
    }

    currentQueueWakeup = () => {
      if (backoffTimer) {
        clearTimeout(backoffTimer);
        backoffTimer = null;
      }
      dispatch();
    };

    function dispatch() {
      if (status.stopRequested || settled) {
        checkDone();
        return;
      }

      // 1. 优先调度 Stage 3 (Arbiter 终审仲裁)，尽快完成已产生分歧的行
      while (stage3InFlight < stage3Concurrency && stage3Pending.length > 0 && !status.stopRequested && !settled) {
        const s2Item = stage3Pending.shift();
        stage3InFlight += 1;
        syncStagePipelineQueues();
        executeStage3(s2Item);
      }

      // 2. 调度 Stage 2 (Stylist 文学复审)，消费 Stage 1 已经初审完且建议修改的行
      while (stage2InFlight < stage2Concurrency && stage2Pending.length > 0 && !status.stopRequested && !settled) {
        const s1Item = stage2Pending.shift();
        stage2InFlight += 1;
        syncStagePipelineQueues();
        executeStage2(s1Item);
      }

      // 3. 调度 Stage 1 (Gatekeeper 事实初审)
      const now = Date.now();
      const inBackoff = now < backoffUntil;
      if (inBackoff && !backoffTimer) {
        const waitMs = Math.max(10, backoffUntil - now);
        backoffTimer = setTimeout(() => {
          backoffTimer = null;
          dispatch();
        }, waitMs);
      }

      if (!inBackoff) {
        while (stage1InFlight < currentConcurrency && stage1Pending.length > 0 && !status.stopRequested && !settled) {
          const row = stage1Pending.shift();
          stage1InFlight += 1;
          syncStagePipelineQueues();
          executeStage1(row);
        }
      }

      checkDone();
    }

    async function executeStage1(row) {
      status.active.push(row.index);
      status.stagePipelines.stage1.activeRows.push(row.index);
      syncStagePipelineQueues();
      try {
        const s1 = await runStage1Gatekeeper(row, allRows, config, labels);
        if (!status.stopRequested) {
          recordModelOutcome(false, config);
          if (isSmart) {
            consecutiveLimits = 0;
            consecutiveSuccesses += 1;
            const elapsed = Date.now() - lastAdjustmentAt;
            if (consecutiveSuccesses >= scaleUpThreshold && elapsed >= minProbeIntervalMs && currentConcurrency < maxConcurrency) {
              const prev = currentConcurrency;
              currentConcurrency = Math.min(maxConcurrency, currentConcurrency + 1);
              status.currentConcurrency = currentConcurrency;
              status.peakConcurrency = Math.max(status.peakConcurrency, currentConcurrency);
              status.concurrencyUps += 1;
              consecutiveSuccesses = 0;
              lastAdjustmentAt = Date.now();
              pushLog(`[智能并发] 连续 ${scaleUpThreshold} 次请求正常，并发从 ${prev} 上探至 ${currentConcurrency}（上限 ${maxConcurrency}）。`);
            }
          }
        }

        const isFastPass = !s1.decision.needsEdit && isFastPassDecision(s1.decision);
        const isMultiStage = Boolean(config.multiStageEnabled || config.challengerEnabled || config.singleModelPersona);

        if (isFastPass || !isMultiStage) {
          // 命中 Fast Pass 或单阶段：无需 Stage 2，直接完成输出
          const result = finalizeRowResult(s1, config);
          addResult(result);
          status.active = status.active.filter((idx) => idx !== row.index);
        } else {
          // 提出修改：立即推入 Stage 2 队列，Stylist 可以立刻并发启动，不阻塞 Stage 1 审后续行！
          stage2Pending.push(s1);
          syncStagePipelineQueues();
          pushLog(`第 ${row.index} 行：事实初审完成，移交 Stage 2 (Stylist 文学复审队列)。`);
        }
      } catch (error) {
        const isRefusal = isModelRefusalError(error);
        const isRateLimit = isSmart && !isRefusal && isConcurrencyOrRateLimitError(error) && !status.stopRequested;
        const fatalRequestError = !isRefusal && !isRateLimit && isFatalRequestError(error) && !status.stopRequested;

        if (isRefusal) {
          status.modelRefusals += 1;
          const targetKey = config.proofreadMode === "bilingual" ? "cn" : config.target;
          addResult(makeRefusalResult(row, error, targetKey));
          pushLog(`第 ${row.index} 行：模型拒答（内容安全审查），已自动跳过并标记待人工确认。`);
          status.active = status.active.filter((idx) => idx !== row.index);
        } else if (isRateLimit) {
          status.concurrencyLimits += 1;
          consecutiveSuccesses = 0;
          consecutiveLimits += 1;

          const now = Date.now();
          if (now - lastScaleDownAt > 800) {
            const prev = currentConcurrency;
            const next = prev > 3
              ? Math.max(minConcurrency, Math.floor(prev * 0.7))
              : Math.max(minConcurrency, prev - 1);
            if (next < prev) {
              currentConcurrency = next;
              status.currentConcurrency = currentConcurrency;
              status.concurrencyDowns += 1;
              lastScaleDownAt = now;
              lastAdjustmentAt = now;
            }
          }

          const retries = (rowRetryCounts.get(row.index) || 0) + 1;
          rowRetryCounts.set(row.index, retries);

          let delayMs = Math.min(10000, 1500 * Math.pow(1.5, Math.min(4, consecutiveLimits - 1))) + Math.floor(Math.random() * 500);
          if (error.retryAfter) {
            const parsed = parseFloat(error.retryAfter);
            if (Number.isFinite(parsed) && parsed > 0) {
              delayMs = Math.min(15000, parsed * 1000);
            }
          }
          backoffUntil = Math.max(backoffUntil, Date.now() + delayMs);

          if (retries <= maxRowRetries && !status.stopRequested) {
            pushLog(`[智能并发] 第 ${row.index} 行遭遇${parseRateLimitReason(error)}，并发下调至 ${currentConcurrency}，退避 ${(delayMs / 1000).toFixed(1)} 秒后进行第 ${retries}/${maxRowRetries} 次重试。`);
            stage1Pending.unshift(row);
            syncStagePipelineQueues();
          } else {
            pushLog(`[智能并发] 第 ${row.index} 行连续 ${maxRowRetries} 次触发频控限制，已达到最大重试次数，标记为调用失败。`);
            addResult({
              runId: status.runId,
              index: row.index,
              signature: rowSignature(row),
              status: "error",
              done: false,
              note: `[AI校对]\n调用失败（频控限制已达重试上限）：${error.message || String(error)}`,
            });
            recordModelOutcome(true, config);
          }
          status.active = status.active.filter((idx) => idx !== row.index);
        } else {
          addResult({
            runId: status.runId,
            index: row.index,
            signature: rowSignature(row),
            status: status.stopRequested && !fatalRequestError ? "stopped" : "error",
            done: false,
            note: `[AI校对]\n${status.stopRequested && !fatalRequestError ? "校对已终止。" : `调用失败：${error.message || String(error)}`}`,
          });
          if (fatalRequestError) {
            stopForFatalRequestError(error);
          } else if (!status.stopRequested) {
            recordModelOutcome(true, config);
          }
          status.active = status.active.filter((idx) => idx !== row.index);
        }
      } finally {
        status.stagePipelines.stage1.activeRows = status.stagePipelines.stage1.activeRows.filter((idx) => idx !== row.index);
        stage1InFlight -= 1;
        syncStagePipelineQueues();
        dispatch();
      }
    }

    async function executeStage2(s1Item) {
      status.stagePipelines.stage2.activeRows.push(s1Item.row.index);
      syncStagePipelineQueues();
      try {
        const s2 = await runStage2Stylist(s1Item, config, labels);
        if (s2.arbCheck?.triggered && config.arbiterEnabled !== false) {
          // 产生分歧，触发终审仲裁，推入 Stage 3 队列！
          stage3Pending.push(s2);
          syncStagePipelineQueues();
          pushLog(`第 ${s2.row.index} 行：文学复审产生分歧，移交 Stage 3 (Arbiter 终审仲裁队列)。`);
        } else {
          // 未产生分歧：采纳复审结论，直接完成
          const result = finalizeRowResult(s2, config);
          addResult(result);
          status.active = status.active.filter((idx) => idx !== s2.row.index);
        }
      } catch (error) {
        pushLog(`第 ${s1Item.row.index} 行：Stylist 异常（${error.message}），回退至初审方案。`);
        const result = finalizeRowResult(s1Item, config);
        addResult(result);
        status.active = status.active.filter((idx) => idx !== s1Item.row.index);
      } finally {
        status.stagePipelines.stage2.activeRows = status.stagePipelines.stage2.activeRows.filter((idx) => idx !== s1Item.row.index);
        stage2InFlight -= 1;
        syncStagePipelineQueues();
        dispatch();
      }
    }

    async function executeStage3(s2Item) {
      status.stagePipelines.stage3.activeRows.push(s2Item.row.index);
      syncStagePipelineQueues();
      try {
        const s3 = await runStage3Arbiter(s2Item, config, labels);
        const result = finalizeRowResult(s3, config);
        addResult(result);
      } catch (error) {
        pushLog(`第 ${s2Item.row.index} 行：Arbiter 异常（${error.message}），回退至复审方案。`);
        const result = finalizeRowResult(s2Item, config);
        addResult(result);
      } finally {
        status.stagePipelines.stage3.activeRows = status.stagePipelines.stage3.activeRows.filter((idx) => idx !== s2Item.row.index);
        status.active = status.active.filter((idx) => idx !== s2Item.row.index);
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
  status.stagePipelines = createStagePipelines();
  const isPrefilter = status.kind === "prefilter";
  if (!isPrefilter) {
    const summary = promptTrimSummary();
    if (summary) pushLog(summary);
    const lowScore = lowScoreSummary();
    if (lowScore) pushLog(lowScore);
    const lookup = webLookupSummary();
    if (lookup) pushLog(lookup);
    if (status.modelRefusals) {
      pushLog(`模型拒答防护：${status.modelRefusals} 行因触发内容安全审查被拒答，已自动跳过并转人工确认。`);
    }
    if (status.scriptLeaks) {
      pushLog(`输出语言护栏：${status.scriptLeaks} 行的修改结果混入了原文（日文）文字，已作废并转人工确认。`);
    }
    if (status.formatFixes) {
      pushLog(`成品格式门禁：${status.formatFixes} 行的修改结果按成品结构修正了格式（删除换行 ${status.formatLineBreaks} 处、并回段落 ${status.formatParagraphs} 处、说明字段换行 ${status.formatNoteFields} 处）。`);
    }
    if (status.formatVoids) {
      pushLog(`成品格式门禁：${status.formatVoids} 行的修改结果因格式无法确定性还原（段落结构不一致或内联标记增减）被作废并转人工确认。`);
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
      pushLog(`标点规范化：${status.punctQuoteVoids} 行的修改结果含无法确定性配对的弯引号，已作废并转人工确认。`);
    }
    if (status.punctRestored) {
      pushLog(`标点规范化：补回 ${status.punctRestored} 处被删掉的句末点号（引号/括号内侧的句末点号是中文规范写法，原文省略不等于译文该省）。`);
    }
    if (!status.punctFixes && !status.punctQuoteVoids && !status.punctRestored && status.punctEnabled === false) {
      pushLog("标点规范化：已关闭。");
    }
    if (status.smartConcurrency) {
      pushLog(`智能并发统计：初始并发 ${status.concurrency || 3}，峰值并发 ${status.peakConcurrency || status.concurrency || 3}，并发下调 ${status.concurrencyDowns || 0} 次，并发上探 ${status.concurrencyUps || 0} 次，遭遇限流 ${status.concurrencyLimits || 0} 次。`);
    }
  }
  if (status.stopRequested) {
    pushLog(isPrefilter ? "预筛选已终止。" : "AI 校对已终止。");
  } else {
    pushLog(isPrefilter ? "预筛选完成。" : "AI 校对完成。");
  }
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
      "语义是否相同：待人工确认",
      "是否需要修改：待人工确认",
      `分析：模型拒答（触发内容安全审查策略）。本行原文或译文可能包含敏感词，模型拒绝回答，已自动转由人工核验。 拒答详情：${reason}`,
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

function recordModelOutcome(failed, config = {}) {
  if (config.circuitBreakerEnabled === false) return;
  const threshold = clampNumber(config.circuitBreakerErrorRate, errorCircuitBreaker.minErrorRate, 1, errorCircuitBreaker.errorRate);
  recentModelOutcomes.push(Boolean(failed));
  if (recentModelOutcomes.length > errorCircuitBreaker.windowSize) {
    recentModelOutcomes.splice(0, recentModelOutcomes.length - errorCircuitBreaker.windowSize);
  }
  if (recentModelOutcomes.length < errorCircuitBreaker.minimumSamples) return;

  const errorCount = recentModelOutcomes.filter(Boolean).length;
  const errorRate = errorCount / recentModelOutcomes.length;
  if (errorRate < threshold) return;

  status.stopRequested = true;
  status.error = `AI 请求错误率熔断：最近 ${recentModelOutcomes.length} 次处理中有 ${errorCount} 次失败（${Math.round(errorRate * 100)}%，阈值 ${Math.round(threshold * 100)}%），任务已自动终止。`;
  pushLog(status.error);
  for (const controller of controllers) controller.abort();
}

async function runStage1Gatekeeper(row, allRows, config, labels) {
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
      pushLog(`第 ${row.index} 行：判定为对齐片段行，不再扩展上下文，直接转人工确认。`);
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
        pushLog(`第 ${row.index} 行：${label} 未获得有效信息，${round < lastRound ? "换下一个来源" : "转人工确认"}。`);
      }
    }
  }
  decision = ensureRevisedText(decision, targetKey, targetText, counterpartText, config.proofreadMode);
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
  };
}

async function runStage2Stylist(stage1Result, config, labels) {
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

  const stylistMessages = buildStylistMessages(row, decision, {
    targetLabel,
    basePrompt: config.systemPrompt,
  });

  let arbCheck = { triggered: false };
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
        lowScoreUncertain: lowScore?.active,
      },
    });

    if (!arbCheck.triggered || config.arbiterEnabled === false) {
      if (stylistReview.critique.attitude === "modify" && stylistReview.revisedText) {
        decision.revisedText = stylistReview.revisedText;
      } else if (stylistReview.critique.attitude === "reject") {
        decision.needsEdit = false;
        decision.revisedText = "";
      }
      decision.stage = "stylist";
    }
  } catch (stylistErr) {
    pushLog(`第 ${row.index} 行：Stylist 审阅过程中异常（${stylistErr.message}），回退至 Gatekeeper 初审方案。`);
  }

  return {
    ...stage1Result,
    decision,
    arbCheck,
  };
}

async function runStage3Arbiter(stage2Result, config, labels) {
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

  const arbiterMessages = buildArbiterMessages(row, decision, stylistReview, {
    targetLabel,
    basePrompt: config.systemPrompt,
  });

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
    decision.stage = "arbiter";
    pushLog(`第 ${row.index} 行：Arbiter 仲裁定案（胜出者: ${applied.winner}，最终结论: ${applied.finalDecision}）。`);
  } catch (arbiterErr) {
    pushLog(`第 ${row.index} 行：Arbiter 仲裁过程中异常（${arbiterErr.message}），回退至复审方案。`);
  }

  return {
    ...stage2Result,
    decision,
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
    pushLog(`第 ${row.index} 行：修改结果混入原文（日文）文字，已作废并转人工确认。`);
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
  const s2 = await runStage2Stylist(s1, config, labels);
  if (s2.arbCheck?.triggered && config.arbiterEnabled !== false) {
    const s3 = await runStage3Arbiter(s2, config, labels);
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
    pushLog(`第 ${row.index} 行：修改结果含无法确定性配对的弯引号，已作废并转人工确认。`);
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
        "模型给出的修改结果含无法确定性转换为「」的弯引号（可能未配对或处在英文语境），已作废并转人工确认——成品引号必须使用「」/『』。",
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
      "模型给出的修改结果混入了原文（日文）文字，已作废并转人工确认——成品不得写入原文文字。",
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
  const parts = diffWordsWithSpace(fromText, toText);
  const changes = [];
  for (const part of parts) {
    const value = String(part.value || "").trim();
    if (!value) continue;
    if (part.removed) changes.push(`- ${value}`);
    if (part.added) changes.push(`+ ${value}`);
    if (changes.length >= 24) break;
  }
  const left = labels.cn || "非原文 B";
  const right = labels.tw || "非原文 C";
  return changes.length
    ? `${left} -> ${right}简体化\n${changes.join("\n")}`
    : "差异辅助未发现明显词级差异。";
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
  if (config.provider === "claude") return callClaude(messages, config);
  return callOpenAiCompatible(messages, config);
}

async function callOpenAiCompatible(messages, config) {
  const startTime = Date.now();
  const headers = buildProviderHeaders(config);
  const body = buildChatCompletionBody(messages, config);
  const data = await fetchJson(buildApiUrl(config.baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
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
    headers: buildProviderHeaders(config),
    body: JSON.stringify(buildClaudeMessageBody(messages, config)),
  });
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

function buildClaudeMessageBody(messages, config = {}, modelMeta = null) {
  const caps = modelMeta || detectModelCapabilities(config.model, config.provider);
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => String(message.content || ""))
    .filter(Boolean)
    .join("\n\n");
  const effort = caps.reasoning ? normalizeModelReasoningEffort(config.reasoningEffort, config.model, caps) : "";
  const isThinkingEnabled = caps.reasoning && effort && effort !== "off" && effort !== "none";
  const budgetTokens = isThinkingEnabled ? (CLAUDE_THINKING_BUDGETS[effort] || 4096) : 0;
  const maxTokens = isThinkingEnabled ? Math.max(8192, budgetTokens + 4096) : 4096;

  const body = {
    model: config.model,
    max_tokens: maxTokens,
    messages: messages
      .filter((message) => message.role !== "system")
      .map((message) => ({ role: message.role, content: message.content })),
  };
  if (system) body.system = system;
  if (isThinkingEnabled) {
    body.thinking = {
      type: "enabled",
      budget_tokens: budgetTokens,
    };
  } else {
    const temperature = normalizeNonGptTemperature(config.reasoningEffort);
    if (temperature != null && caps.supportsTemperature !== false) body.temperature = temperature;
  }
  return body;
}

// extractClaudeText 与共享传输层 (src/ai/llm-client.js) 同源。
// 注意：下面两个 body 构造函数不是共享层的副本——共享层读 config.temperature ?? config.reasoningEffort，
// 而 AI 校对只接受语义强度档位（reasoningEffort），两者不要合并。

function buildChatCompletionBody(messages, config = {}, modelMeta = null) {
  const caps = modelMeta || detectModelCapabilities(config.model, config.provider);
  const body = {
    model: config.model,
    messages,
    stream: false,
  };
  if (caps.reasoning || isGptModel(config.model)) {
    const reasoningEffort = normalizeReasoningEffort(config.reasoningEffort, config.model, caps);
    if (reasoningEffort && reasoningEffort !== "off" && reasoningEffort !== "none") {
      body.reasoning_effort = reasoningEffort;
    }
  } else {
    const temperature = normalizeNonGptTemperature(config.reasoningEffort);
    if (temperature != null && caps.supportsTemperature !== false) {
      body.temperature = temperature;
    }
  }
  return body;
}

async function fetchJson(url, options, fetchOptions = {}) {
  const controller = new AbortController();
  const track = fetchOptions.track !== false;
  const timeoutMs = fetchOptions.timeoutMs || 90000;
  let timedOut = false;
  if (track) controllers.add(controller);
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${displayRequestUrl(url)} 返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
      error.code = "HTTP_ERROR";
      error.httpStatus = response.status;
      error.responseBody = text;
      const retryAfter = response.headers?.get?.("retry-after");
      if (retryAfter) {
        error.retryAfter = retryAfter;
      }
      throw error;
    }
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch (cause) {
      const contentType = response.headers.get("content-type") || "未知类型";
      const preview = text.replace(/\s+/g, " ").trim().slice(0, 160);
      const error = new Error(`${displayRequestUrl(url)} 返回了非 JSON 响应（${contentType}）：${preview || "空响应"}`);
      error.code = "INVALID_JSON_RESPONSE";
      error.cause = cause;
      throw error;
    }
  } catch (error) {
    if (timedOut && error?.name === "AbortError") {
      const timeoutError = new Error(`请求超时（${Math.ceil(timeoutMs / 1000)} 秒）`);
      timeoutError.code = "REQUEST_TIMEOUT";
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
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

function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function computeScoreAndGrade({ needsEdit, rawScore, rawPenalty, rawGrade, rawSeverity }) {
  if (!needsEdit) {
    return {
      score: 100,
      penalty: 0,
      grade: "excellent",
      severity: "none",
    };
  }

  let penalty = null;
  let score = null;
  if (rawPenalty !== null) {
    penalty = Math.max(0, Math.min(100, Math.round(rawPenalty)));
  }
  if (rawScore !== null) {
    score = Math.max(0, Math.min(100, Math.round(rawScore)));
    if (penalty === null) penalty = Math.max(0, 100 - score);
  } else if (penalty !== null) {
    score = Math.max(0, 100 - penalty);
  }

  const normalizedGrade = normalizeGrade(rawGrade || rawSeverity);
  if (score === null) {
    if (normalizedGrade === "poor" || normalizedGrade === "critical") {
      penalty = 45;
      score = 55;
    } else if (normalizedGrade === "good" || normalizedGrade === "minor") {
      penalty = 15;
      score = 85;
    } else if (normalizedGrade === "excellent") {
      penalty = 5;
      score = 95;
    } else {
      penalty = 30;
      score = 70;
    }
  }

  let grade = "fair";
  if (score >= 90) grade = "excellent";
  else if (score >= 75) grade = "good";
  else if (score >= 60) grade = "fair";
  else grade = "poor";

  let severity = "major";
  if (grade === "excellent") severity = penalty > 0 ? "minor" : "none";
  else if (grade === "good") severity = "minor";
  else if (grade === "fair") severity = "major";
  else if (grade === "poor") severity = "critical";

  return {
    score,
    penalty: penalty ?? Math.max(0, 100 - score),
    grade,
    severity,
  };
}

function normalizeGrade(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["excellent", "优等", "优秀", "优", "a"].includes(text)) return "excellent";
  if (["good", "良好", "良", "b", "minor", "轻微", "低"].includes(text)) return "good";
  if (["fair", "一般", "待改", "中等", "及格", "c", "major", "严重", "重大"].includes(text)) return "fair";
  if (["poor", "较差", "不及格", "差", "d", "critical", "致命", "高"].includes(text)) return "poor";
  return "";
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["true", "1", "yes", "y", "是", "需要", "相同"].includes(text)) return true;
  if (["false", "0", "no", "n", "否", "不需要", "不同"].includes(text)) return false;
  return fallback;
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

function displayRequestUrl(value) {
  try {
    const url = new URL(String(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return String(value || "").split(/[?#]/, 1)[0];
  }
}

function normalizeSeverity(value, needsEdit = true) {
  if (!needsEdit) return "none";
  const text = String(value || "").trim().toLowerCase();
  if (["critical", "致命", "高", "high"].includes(text)) return "critical";
  if (["major", "严重", "重大", "主要", "中", "medium"].includes(text)) return "major";
  if (["minor", "轻微", "次要", "低", "low"].includes(text)) return "minor";
  return "major";
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
  const multiStageLines = (decision.stylistReview || decision.arbitration)
    ? formatArbitrationNoteLines({
        gatekeeperDecision: decision,
        stylistReview: decision.stylistReview,
        arbitration: decision.arbitration,
      })
    : [];

  const effectiveStage = decision.stage || (decision.arbitration ? "arbiter" : (decision.stylistReview ? "stylist" : "gatekeeper"));
  const effectiveModelId = (effectiveStage === "arbiter" ? decision.arbitrationModelId : (effectiveStage === "stylist" ? decision.stylistModelId : status.model)) || status.model;

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
        "是否需要修改：待人工确认",
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
      critique: decision.stylistReview?.critique || normalizeCritiqueResult({ attitude: "reject", rationale: decision.summary }),
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
    lines.push("是否需要修改：待人工确认");
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
  buildProviderHeaders,
  callModel,
  clearProofreadCache,
  clientStatus,
  decisionToResult,
  detectModelCapabilities,
  errorCircuitBreaker,
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
  normalizeSeverity,
  parseDecision,
  providerDefaults,
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
  recordHumanFeedback: (event) => globalFeedbackCollector.record(event),
  getFeedbackStatistics: () => globalFeedbackCollector.getStatistics(),
  globalFeedbackCollector,
  scheduleModels,
  getModelProfile,
  createPersonaContext,
  runStage1Gatekeeper,
  runStage2Stylist,
  runStage3Arbiter,
  finalizeRowResult,
  proofreadRow,
  testModel,
};
