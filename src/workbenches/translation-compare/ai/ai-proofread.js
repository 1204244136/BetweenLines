const fs = require("fs");
const { diffWordsWithSpace } = require("diff");
const OpenCC = require("opencc-js");
const { toCn } = require("../../../ingest/text-utils");
const { classifyPrefilter } = require("./ai-prefilter");
const { rowSignature, sameProjectSnapshot } = require("../../../core/project-context");
const { resolveProjectArtifact } = require("../../../storage/project-store");
const {
  detectModelCapabilities,
  isReasoningModel,
  normalizeModelReasoningEffort,
  CLAUDE_THINKING_BUDGETS,
  loadModelsDev,
} = require("./model-capabilities");
const { TEXT_INTENSITY_TEMPERATURE_MAP, normalizeNonGptTemperature } = require("../../../ai/llm-client");
const toTw = OpenCC.Converter({ from: "cn", to: "tw" });
const { loadGlossary, glossaryPrompt } = require("./glossary");
const { proofreadPromptFor, buildProofreadSystemPrompt } = require("./proofread-contract");

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

function isGptModel(model) {
  return /(?:^|\/)gpt(?:-|$)/i.test(String(model || "").trim());
}

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
  provider: "local",
  model: "",
  reasoningEffort: "",
  projectKey: "",
  rowsSignature: "",
  monitorEnabled: false,
  total: 0,
  queued: 0,
  processed: 0,
  handled: 0,
  prefiltered: 0,
  rulePrefiltered: 0,
  similarityPrefiltered: 0,
  structuredConflicts: 0,
  skippedDone: 0,
  modelProcessed: 0,
  modelHandled: 0,
  suggested: 0,
  errors: 0,
  active: [],
  activeRequests: [],
  recentRequests: [],
  error: "",
  logs: [],
  results: new Map(),
  resultChanges: [],
  resultRevision: 0,
};

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
  const knownRequestIds = new Set(Array.isArray(options.knownRequestIds) ? options.knownRequestIds : []);
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
    provider: status.provider,
    model: status.model,
    reasoningEffort: status.reasoningEffort,
    projectKey: status.projectKey,
    rowsSignature: status.rowsSignature,
    monitorEnabled: status.monitorEnabled,
    total: status.total,
    queued: status.queued,
    processed: status.processed,
    handled: status.handled,
    prefiltered: status.prefiltered,
    rulePrefiltered: status.rulePrefiltered,
    similarityPrefiltered: status.similarityPrefiltered,
    structuredConflicts: status.structuredConflicts,
    skippedDone: status.skippedDone,
    modelProcessed: status.modelProcessed,
    modelHandled: status.modelHandled,
    suggested: status.suggested,
    errors: status.errors,
    active: status.active,
    activeRequests: withElapsed(status.activeRequests).map((request) => requestForClient(request, knownRequestIds)),
    recentRequests: status.recentRequests.map((request) => requestForClient(request, knownRequestIds)),
    error: status.error,
    logs: options.includeLogs === false ? [] : status.logs,
    results,
    resultRevision: deliveredRevision,
    latestResultRevision: status.resultRevision,
    hasMoreResults: deliveredRevision < status.resultRevision,
    providerDefaults,
    proofreadPrompt: proofreadPromptFor(status.proofreadMode),
  };
}

function withElapsed(requests) {
  const now = Date.now();
  return requests.map((request) => ({
    ...request,
    elapsedMs: Math.max(0, now - Date.parse(request.startedAt || new Date())),
  }));
}

function readRows(inputProject = {}) {
  const compareJsonFile = resolveProjectArtifact(inputProject.projectKey, "translation-compare.json", {
    rowsSignature: inputProject.rowsSignature,
  });
  const data = JSON.parse(fs.readFileSync(compareJsonFile, "utf8"));
  return {
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
  const concurrency = clampInteger(input.concurrency, 1, 12, 3);
  const similarityThreshold = clampNumber(input.similarityThreshold, 0.5, 1, 0.92);
  const circuitBreakerErrorRate = clampNumber(
    input.circuitBreakerErrorRate,
    errorCircuitBreaker.minErrorRate,
    1,
    errorCircuitBreaker.errorRate,
  );
  const model = String(input.model || defaults.model).trim();
  return {
    provider,
    target,
    proofreadMode,
    concurrency,
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
    systemPrompt: String(input.systemPrompt || "").trim() || proofreadPromptFor(proofreadMode).system,
    glossaryFile: String(input.glossaryFile || "").trim(),
    completedIndexes: normalizeIndexSet(input.completedIndexes),
    monitorEnabled: Boolean(input.monitorEnabled),
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
  status.provider = config.provider;
  status.model = config.model;
  status.reasoningEffort = config.reasoningEffort;
  status.projectKey = config.projectKey;
  status.rowsSignature = config.rowsSignature;
  status.monitorEnabled = config.monitorEnabled;
  status.total = rowsLength;
  status.queued = 0;
  status.processed = 0;
  status.handled = 0;
  status.prefiltered = 0;
  status.rulePrefiltered = 0;
  status.similarityPrefiltered = 0;
  status.structuredConflicts = 0;
  status.skippedDone = 0;
  status.modelProcessed = 0;
  status.modelHandled = 0;
  status.suggested = 0;
  status.errors = 0;
  status.active = [];
  status.activeRequests = [];
  status.recentRequests = [];
  status.error = "";
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

function requestForClient(request, knownRequestIds) {
  if (!knownRequestIds.has(request.id)) return request;
  const { messages, ...summary } = request;
  return summary;
}

function addResult(result, { prefilterKind = "" } = {}) {
  status.resultRevision += 1;
  const storedResult = { ...result, resultRevision: status.resultRevision };
  status.results.set(result.index, storedResult);
  status.resultChanges.push(storedResult);
  status.processed += 1;
  if (result.done) status.handled += 1;
  if (prefilterKind) {
    status.prefiltered += 1;
    if (prefilterKind === "rule") status.rulePrefiltered += 1;
    if (prefilterKind === "similarity") status.similarityPrefiltered += 1;
    if (prefilterKind === "structured-conflict") status.structuredConflicts += 1;
  } else {
    status.modelProcessed += 1;
    if (result.done) status.modelHandled += 1;
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
  const { project, rows } = readRows(config);
  requireMatchingProjectSnapshot(config, project);
  config.proofreadMode = project.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  config.kind = "prefilter";
  resetStatus(config, rows.length);
  const labels = {
    jp: "原文 A",
    cn: "非原文 B",
    tw: "非原文 C",
    ...(input.labels || {}),
  };

  let pending = 0;
  for (const row of rows) {
    if (config.completedIndexes.has(Number(row.index))) {
      status.skippedDone += 1;
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
  pushLog(`预筛选：人工确认跳过 ${status.skippedDone} 行，规则跳过 ${status.rulePrefiltered} 行，结构化冲突 ${status.structuredConflicts} 行，相似度跳过 ${status.similarityPrefiltered} 行，剩余 ${pending} 行需要 AI 校对。`);
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

  const { project, rows } = readRows(config);
  requireMatchingProjectSnapshot(config, project);
  config.proofreadMode = project.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  if (!String(input.systemPrompt || "").trim()) {
    config.systemPrompt = proofreadPromptFor(config.proofreadMode).system;
  }
  if (config.proofreadMode === "bilingual") config.target = "cn";
  resetStatus(config, rows.length);
  const labels = {
    jp: "原文 A",
    cn: "非原文 B",
    tw: "非原文 C",
    ...(input.labels || {}),
  };
  const queue = [];

  for (const row of rows) {
    if (config.completedIndexes.has(Number(row.index))) {
      status.skippedDone += 1;
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
      continue;
    }
    queue.push(row);
  }

  status.queued = queue.length;
  pushLog(`${config.proofreadMode === "bilingual" ? "双语版本校对" : "三语语境校对"}：人工确认跳过 ${status.skippedDone} 行，规则跳过 ${status.rulePrefiltered} 行，结构化冲突 ${status.structuredConflicts} 行，相似度跳过 ${status.similarityPrefiltered} 行，剩余 ${queue.length} 行进入 AI 校对。`);
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

function buildApiUrl(baseUrl, endpoint) {
  const base = String(baseUrl || "").trim().replace(/\/+$/, "");
  const path = `/${String(endpoint || "").trim().replace(/^\/+/, "")}`;
  if (!base) return path;
  const endpointSuffix = path.replace(/^\/v\d+(?=\/|$)/i, "");
  try {
    const url = new URL(base);
    const currentPath = url.pathname.replace(/\/+$/, "");
    const existingEndpoint = currentPath.match(/\/(?:chat\/completions|messages|models)$/i);
    if (existingEndpoint) {
      url.pathname = `${currentPath.slice(0, -existingEndpoint[0].length)}${endpointSuffix}`;
    } else if (/\/v\d+$/i.test(currentPath)) {
      url.pathname = `${currentPath}${endpointSuffix}`;
    } else {
      url.pathname = `${currentPath}${path}`;
    }
    return url.toString();
  } catch {
    const existingEndpoint = base.match(/\/(?:chat\/completions|messages|models)$/i);
    if (existingEndpoint) return `${base.slice(0, -existingEndpoint[0].length)}${endpointSuffix}`;
    if (/\/v\d+$/i.test(base)) return `${base}${endpointSuffix}`;
    return `${base}${path}`;
  }
}

function buildProviderHeaders(config = {}) {
  const headers = { "content-type": "application/json" };
  if (config.provider === "claude") {
    headers["anthropic-version"] = "2023-06-01";
    if (config.apiKey) headers["x-api-key"] = config.apiKey;
  } else if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

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
  status.monitorEnabled = false;
  status.total = 0;
  status.queued = 0;
  status.processed = 0;
  status.handled = 0;
  status.prefiltered = 0;
  status.rulePrefiltered = 0;
  status.similarityPrefiltered = 0;
  status.structuredConflicts = 0;
  status.skippedDone = 0;
  status.modelProcessed = 0;
  status.modelHandled = 0;
  status.suggested = 0;
  status.errors = 0;
  status.active = [];
  status.activeRequests = [];
  status.recentRequests = [];
  status.error = "";
  status.logs = [];
  status.results = new Map();
  status.resultChanges = [];
  status.resultRevision = 0;
  controllers = new Set();
  recentModelOutcomes = [];
  return clientStatus();
}

async function runQueue(queue, allRows, config, labels) {
  let next = 0;
  async function worker() {
    while (!status.stopRequested) {
      const offset = next;
      next += 1;
      if (offset >= queue.length) return;
      const row = queue[offset];
      status.active.push(row.index);
      try {
        const result = await proofreadRow(row, allRows, config, labels);
        addResult(result);
        if (!status.stopRequested) recordModelOutcome(false, config);
      } catch (error) {
        const fatalRequestError = isFatalRequestError(error) && !status.stopRequested;
        addResult({
          runId: status.runId,
          index: row.index,
          signature: rowSignature(row),
          status: status.stopRequested && !fatalRequestError ? "stopped" : "error",
          done: false,
          note: `[AI校对]\n${status.stopRequested && !fatalRequestError ? "校对已终止。" : `调用失败：${error.message || String(error)}`}`,
        });
        if (fatalRequestError) stopForFatalRequestError(error);
        else if (!status.stopRequested) recordModelOutcome(true, config);
      } finally {
        status.active = status.active.filter((index) => index !== row.index);
      }
    }
  }

  await Promise.all(Array.from({ length: config.concurrency }, worker));
  finish();
}

function finish() {
  if (!status.running) return;
  status.running = false;
  status.finishedAt = new Date().toISOString();
  const isPrefilter = status.kind === "prefilter";
  if (status.stopRequested) {
    pushLog(isPrefilter ? "预筛选已终止。" : "AI 校对已终止。");
  } else {
    pushLog(isPrefilter ? "预筛选完成。" : "AI 校对完成。");
  }
}

function isFatalRequestError(error) {
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

async function proofreadRow(row, allRows, config, labels) {
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
    context: [],
    contextMode: "none",
  };
  const contextState = createContextState(row.index, allRows, targetKey, counterpartKey, config.proofreadMode);
  let decision = null;
  for (let round = 0; round <= contextBudget.maxRounds; round += 1) {
    const hasContext = contextState.items.length > 0;
    const messages = buildMessages({
      ...basePayload,
      context: contextState.items,
      contextMode: hasContext ? "requested" : "none",
    }, config);
    const stage = round === 0 ? "base" : `context-${round}`;
    const stageLabel = round === 0 ? "当前行判断" : `扩展上下文 ${round}`;
    const content = await trackedCallModel(row, stage, stageLabel, messages, config);
    decision = parseDecision(content);
    if (!shouldRetryWithContext(decision)) break;
    if (round >= contextBudget.maxRounds) break;
    const added = expandContextRing(contextState);
    if (!added.length) break;
  }
  decision = ensureRevisedText(decision, targetKey, targetText, counterpartText, config.proofreadMode);
  return decisionToResult(row, decision, targetLabel, counterpartLabel, targetKey);
}

async function trackedCallModel(row, stage, stageLabel, messages, config) {
  if (!config.monitorEnabled) {
    pushLog(`第 ${row.index} 行：${stageLabel}，等待模型返回。`);
    return callModel(messages, config);
  }
  const requestId = `${status.runId}:${row.index}:${stage}:${Date.now()}`;
  const startedAt = new Date().toISOString();
  const request = {
    id: requestId,
    rowIndex: row.index,
    stage,
    stageLabel,
    provider: config.provider,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    startedAt,
    state: "waiting",
    messages: summarizeMessages(messages),
  };
  status.activeRequests.push(request);
  pushLog(`第 ${row.index} 行：${stageLabel}，等待模型返回。`);
  try {
    const content = await callModel(messages, config);
    finishRequest(requestId, {
      state: "done",
      finishedAt: new Date().toISOString(),
      responsePreview: previewText(content),
    });
    return content;
  } catch (error) {
    finishRequest(requestId, {
      state: status.stopRequested ? "stopped" : "error",
      finishedAt: new Date().toISOString(),
      error: error.message || String(error),
    });
    throw error;
  }
}

function finishRequest(requestId, patch) {
  const index = status.activeRequests.findIndex((request) => request.id === requestId);
  if (index < 0) return;
  const [request] = status.activeRequests.splice(index, 1);
  const finished = {
    ...request,
    ...patch,
  };
  finished.elapsedMs = Math.max(0, Date.parse(finished.finishedAt || new Date()) - Date.parse(finished.startedAt || new Date()));
  status.recentRequests.unshift(finished);
  if (status.recentRequests.length > 8) {
    status.recentRequests.splice(8);
  }
}

function summarizeMessages(messages) {
  return messages.map((message) => ({
    role: message.role,
    content: previewText(message.content, 10000),
  }));
}

function previewText(value, maxLength = 1200) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}\n...（已截断，完整内容已发送给模型）`;
}

function shouldRetryWithContext(decision) {
  return Boolean(decision.needsContext) || decision.better === "unclear";
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
    if (state.items.length >= contextBudget.maxRows) break;
    const id = String(candidate.row.index);
    if (state.included.has(id)) continue;
    const item = contextRow(candidate.row, candidate.relative, state.targetKey, state.counterpartKey, state.proofreadMode);
    const nextChars = state.chars + contextItemChars(item);
    if (nextChars > contextBudget.maxChars && added.length) break;
    state.included.add(id);
    state.items.push(item);
    state.chars = nextChars;
    added.push(item);
  }
  state.items.sort((a, b) => a.index - b.index);
  return added;
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

function buildMessages(payload, config = {}) {
  const bilingualMode = config.proofreadMode === "bilingual";
  const user = {
    task: `${bilingualMode ? "双语版本校对" : "三语语境校对"}；校对目标列：${payload.targetLabel}`,
    comparisonMode: bilingualMode ? "bilingual" : "trilingual",
    modePolicy: bilingualMode
      ? "以原文 A 与译文 B 的语义对应为主要判断对象；只能修改 B，原文 A 用于确认语义边界、遗漏和误译。"
      : "同时参考原文、目标列和另一非原文列，判断目标列是否准确、通顺并符合原文语义；两份非原文仍是同级材料。",
    contextPolicy: payload.contextMode === "auto"
      ? "已提供自动补充的相邻上下文，请结合上下文给出最终判断。"
      : payload.contextMode === "requested"
        ? "已按固定策略补充当前行前后文。若仍不足，请返回 needsContext=true；若足够，请给出最终判断。"
        : "当前只提供目标行。若当前行不足以判断，请返回 needsContext=true；不要猜测，也不要为保险索要上下文。",
    contextBudget: {
      maxRounds: contextBudget.maxRounds,
      maxRows: contextBudget.maxRows,
      maxChars: contextBudget.maxChars,
    },
    outputSchema: proofreadPromptFor(bilingualMode ? "bilingual" : "trilingual").outputSchema,
    row: {
      index: payload.row.index,
      source: payload.row.jp || "",
      targetLabel: payload.targetLabel,
      targetText: payload.targetText || "",
      // 双语模式只有原文 A 与译文 B 两列，原文已经作为 source 给出，不再重复 counterpart 字段。
      ...(bilingualMode ? {} : {
        counterpartLabel: payload.counterpartLabel,
        counterpartText: payload.counterpartText || "",
      }),
      diffHelper: payload.diffHelper,
    },
    contextExpansion: {
      rounds: payload.context?.length ? Math.ceil(payload.context.length / 2) : 0,
      strategy: "每轮补充当前行前一行和后一行，最多 6 轮。",
    },
    nearbyRows: payload.context,
  };
  const glossary = config.glossaryFile ? glossaryPrompt(loadGlossary(config.glossaryFile)) : "";
  return [
    { role: "system", content: buildProofreadSystemPrompt({
      mode: bilingualMode ? "bilingual" : "trilingual",
      customSystem: config.systemPrompt,
      glossary,
    }) },
    { role: "user", content: JSON.stringify(user, null, 2) },
  ];
}

async function callModel(messages, config) {
  if (config.provider === "claude") return callClaude(messages, config);
  return callOpenAiCompatible(messages, config);
}

async function callOpenAiCompatible(messages, config) {
  const headers = buildProviderHeaders(config);
  const body = buildChatCompletionBody(messages, config);
  const data = await fetchJson(buildApiUrl(config.baseUrl, "/v1/chat/completions"), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return data.choices?.[0]?.message?.content || "";
}

async function callClaude(messages, config) {
  const data = await fetchJson(buildApiUrl(config.baseUrl, "/v1/messages"), {
    method: "POST",
    headers: buildProviderHeaders(config),
    body: JSON.stringify(buildClaudeMessageBody(messages, config)),
  });
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

function extractClaudeText(data = {}) {
  if (typeof data.content === "string") return data.content;
  if (!Array.isArray(data.content)) return "";
  return data.content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("");
}

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

function parseDecision(content) {
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
  const better = normalizeBetter(data.better);
  const needsEdit = parseNeedsEdit(data.needsEdit, semanticSame, better);
  const rawScore = parseOptionalNumber(firstString(data.score, data["评分"], data["得分"], data["质量得分"]));
  const rawPenalty = parseOptionalNumber(firstString(data.penalty, data["扣分"], data["扣除分值"]));
  const rawGrade = firstString(data.grade, data["质量等级"], data["质量分级"], data["等级"]);
  const rawSeverity = firstString(data.severity, data.issueSeverity, data["严重程度"], data["严重性"]);

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
    suggestion: String(data.suggestion || "").trim(),
    replacement: String(data.replacement || "").trim(),
    revisedText,
  });
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
  if (["target", "目标", "目标列", "当前列", "本列", "原目标"].includes(text)) return "target";
  if (["counterpart", "other", "另一列", "对照列", "对方", "另一版本", "参考列"].includes(text)) return "counterpart";
  if (["neither", "none", "都不", "都不好", "两者都不", "均不"].includes(text)) return "neither";
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

function decisionToResult(row, decision, targetLabel, counterpartLabel, targetKey = "") {
  if (decision.needsContext || decision.better === "unclear") {
    return {
      runId: status.runId,
      index: row.index,
      signature: rowSignature(row),
      targetKey,
      status: "suggestion",
      done: false,
      note: [
        "[AI校对]",
        `语义是否相同：${decision.semanticSame ? "相同" : "不同"}`,
        "是否需要修改：待人工确认",
        analysisLine(decision),
      ].filter(Boolean).join("\n"),
    };
  }

  if (!decision.needsEdit) {
    return {
      runId: status.runId,
      index: row.index,
      signature: rowSignature(row),
      targetKey,
      status: decision.semanticSame ? "same" : "target-better",
      done: true,
      note: [
        "[AI校对]",
        `语义是否相同：${decision.semanticSame ? "相同" : "不同"}`,
        "是否需要修改：否",
        analysisLine(decision),
      ].filter(Boolean).join("\n"),
    };
  }

  const lines = ["[AI校对]"];
  lines.push(`语义是否相同：${decision.semanticSame ? "相同" : "不同"}`);
  if (decision.better === "counterpart") {
    lines.push("是否需要修改：是");
    lines.push(...scoreAndGradeLines(decision));
    lines.push(analysisLine(decision, decision.revisedText ? "" : decision.suggestion || `参考${counterpartLabel}修订${targetLabel}。`));
    if (decision.revisedText) lines.push(`修改结果：${decision.revisedText}`);
  } else if (decision.better === "neither") {
    lines.push("是否需要修改：是");
    lines.push(...scoreAndGradeLines(decision));
    lines.push(analysisLine(decision, decision.revisedText ? "" : decision.suggestion || "按原文重新整理译文。"));
    if (decision.revisedText) lines.push(`修改结果：${decision.revisedText}`);
  } else {
    lines.push("是否需要修改：待人工确认");
    lines.push(analysisLine(decision));
  }

  return {
    runId: status.runId,
    index: row.index,
    signature: rowSignature(row),
    targetKey,
    status: "suggestion",
    done: false,
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

function severityLine(decision) {
  const labels = { minor: "轻微", major: "严重", critical: "致命" };
  return `严重程度：${labels[normalizeSeverity(decision.severity, true)] || "严重"}`;
}

function analysisLine(decision, fallback = "") {
  const text = [decision.summary, fallback].filter(Boolean).join(" ");
  return text ? `分析：${text}` : "";
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
  isGptModel,
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
  startPrefilter,
  startProofread,
  stopProofread,
};
