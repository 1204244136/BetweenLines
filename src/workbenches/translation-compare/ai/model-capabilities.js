/**
 * 模型能力与思考强度检测模块（参考 dsh-model-detector 架构设计）。
 *
 * 核心原则：
 * 1. 分层优先级检测（manifest 人工档位优先，与 dsh-model-detector 的
 *    thinkingLevelMap 优先原则一致；models.dev 只为清单未收录的模型富化）：
 *    - 命中内置薄覆盖清单 manifest（针对重点模型与国产模型的人工调优档位与兼容协议）
 *    - 采用端点明确声明的模型能力及档位列表
 *    - 尝试 models.dev（社区维护的权威元数据源：reasoning、reasoning_options）
 *    - 基于模型名称的启发式规则（正则等效判定，覆盖 o1/o3/DeepSeek-R1/QwQ/Claude-3.7/Kimi-K3 等）
 *    - 保守默认（非推理模型，支持 temperature）
 * 2. 思考档位按模型富化，绝不套用统一档位：
 *    - 不同模型声明和支持的档位不同（例如 o1/o3-mini 支持 low/medium/high；
 *      DeepSeek-R1 支持 high/max；Kimi K3 仅支持 max；GPT-5 支持全档位）。
 *    - 严格依据模型能力返回该模型专属的合法思考强度档位列表。
 * 3. 严格的温度与思考协议互斥：
 *    - 纯推理模型（如 o1、o3-mini、deepseek-reasoner 等）不支持 temperature 参数，避免请求报 400。
 *    - Claude 思考模型（如 Claude 3.7 Sonnet）启用 thinking 时，必须发送 thinking budget，且 temperature 不得设置非 1 值。
 */

const MODELS_DEV_URL = "https://models.dev/api.json";

/** 标准思考档位全集（与 pi-ai / DSH 词汇表对齐，升序排列） */
const ALL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** 思考档位中文标签展示 */
const THINKING_LEVEL_LABELS = {
  "": "模型默认",
  off: "关闭思考 (off)",
  none: "无 (none)",
  minimal: "最小 (minimal)",
  low: "低 (low)",
  medium: "中 (medium)",
  high: "高 (high)",
  xhigh: "极高 (xhigh)",
  max: "最大 (max)",
};

/** Claude 思考档位到 Token 预算的映射 */
const CLAUDE_THINKING_BUDGETS = {
  minimal: 1024,
  low: 2048,
  medium: 4096,
  high: 8192,
  xhigh: 16384,
  max: 32768,
};

/**
 * 内置薄覆盖清单（Curated Manifest）。
 * 覆盖 models.dev 尚未收录、端点未透出，或有特殊协议要求的重点模型。
 */
const MANIFEST = {
  // 当前工作台使用的 Gemini 3.8 Flash 路由；网关档位后缀只参与能力匹配，不改请求 ID。
  "gemini-3.8-flash": {
    name: "Gemini 3.8 Flash",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: true,
    thinkingFormat: "openai",
  },
  // DeepSeek 家族
  "deepseek-reasoner": {
    name: "DeepSeek R1 (Reasoner)",
    reasoning: true,
    reasoningEfforts: ["high", "max"],
    supportsTemperature: false,
    thinkingFormat: "deepseek",
  },
  "deepseek-r1": {
    name: "DeepSeek R1",
    reasoning: true,
    reasoningEfforts: ["high", "max"],
    supportsTemperature: false,
    thinkingFormat: "deepseek",
  },
  "deepseek-v4-flash": {
    name: "DeepSeek V4 Flash",
    reasoning: true,
    reasoningEfforts: ["high", "max"],
    supportsTemperature: false,
    thinkingFormat: "deepseek",
  },
  "deepseek-v4-pro": {
    name: "DeepSeek V4 Pro",
    reasoning: true,
    reasoningEfforts: ["high", "max"],
    supportsTemperature: false,
    thinkingFormat: "deepseek",
  },

  // OpenAI 推理家族
  "o1": {
    name: "OpenAI o1",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "o1-mini": {
    name: "OpenAI o1-mini",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "o1-preview": {
    name: "OpenAI o1-preview",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "o3": {
    name: "OpenAI o3",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "o3-mini": {
    name: "OpenAI o3-mini",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "o4-mini": {
    name: "OpenAI o4-mini",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "gpt-5": {
    name: "GPT-5",
    reasoning: true,
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    supportsTemperature: true,
    thinkingFormat: "openai",
  },
  "gpt-5.6": {
    name: "GPT-5.6",
    reasoning: true,
    reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
    supportsTemperature: true,
    thinkingFormat: "openai",
  },

  // Anthropic Claude 思考模型
  "claude-3-7-sonnet": {
    name: "Claude 3.7 Sonnet",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "max"],
    supportsTemperature: true,
    thinkingFormat: "claude",
  },
  "claude-sonnet-4": {
    name: "Claude Sonnet 4",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "max"],
    supportsTemperature: true,
    thinkingFormat: "claude",
  },
  "claude-sonnet-5": {
    name: "Claude Sonnet 5",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "max"],
    supportsTemperature: true,
    thinkingFormat: "claude",
  },
  "claude-opus-4": {
    name: "Claude Opus 4",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "max"],
    supportsTemperature: true,
    thinkingFormat: "claude",
  },

  // 国内厂商重点推理模型
  "kimi-k3": {
    name: "Kimi K3",
    reasoning: true,
    reasoningEfforts: ["max"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "qwq-32b": {
    name: "QwQ 32B",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "qwq": {
    name: "QwQ",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high", "xhigh"],
    supportsTemperature: false,
    thinkingFormat: "openai",
  },
  "mimo-v2.5": {
    name: "MiMo V2.5",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: true,
    thinkingFormat: "openai",
  },
  "mimo-v2.5-pro": {
    name: "MiMo V2.5 Pro",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: true,
    thinkingFormat: "openai",
  },
  "glm-5": {
    name: "GLM-5",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: true,
    thinkingFormat: "openai",
  },
  "glm-5.1": {
    name: "GLM-5.1",
    reasoning: true,
    reasoningEfforts: ["low", "medium", "high"],
    supportsTemperature: true,
    thinkingFormat: "openai",
  },
};

/** models.dev 内存缓存 */
let cachedModelsDev = null;
let cachedModelsDevError = null;

/** 异步拉取 models.dev 并缓存（一次会话，8s 超时防卡死） */
async function loadModelsDev() {
  if (cachedModelsDev !== null) return cachedModelsDev;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(MODELS_DEV_URL, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      cachedModelsDevError = `HTTP ${res.status}`;
      cachedModelsDev = {};
      return cachedModelsDev;
    }
    const json = await res.json();
    if (json && typeof json === "object") {
      cachedModelsDev = json;
      cachedModelsDevError = null;
      return json;
    }
    cachedModelsDevError = "响应不是有效对象";
  } catch (err) {
    cachedModelsDevError = String(err?.message ?? err);
  } finally {
    clearTimeout(timer);
  }
  cachedModelsDev = {};
  return cachedModelsDev;
}

function getModelsDevStatus() {
  return {
    loaded: Boolean(cachedModelsDev && Object.keys(cachedModelsDev).length > 0),
    providers: cachedModelsDev ? Object.keys(cachedModelsDev).length : 0,
    error: cachedModelsDevError,
  };
}

/** 归一化模型 ID */
function normalizeModelId(id) {
  return String(id || "")
    .trim()
    .toLowerCase()
    .replace(/^(?:(?:cn|global|intl|us|eu|jp|sg|hk|uk|ams|hf)[:/]|[a-z0-9_.-]+\/)+/, "")
    .replace(/[-_.@](?:intl|global|cn|us|eu|jp|sg|hk|uk|ams)$/, "")
    .replace(/[-_.:](?:extra[-_.])?(?:xhigh|minimal|low|medium|high|tiered|thinking|nothinking|agent)(?=[-_.]|$)/g, "")
    .replace(/(?:[-_.])?(?:[12]\d{7}|\d{6})\s*$/g, "")
    .replace(/[-_.]expires(?:[-_.]on)?[-_.]?\d{0,8}$/, "")
    .replace(/[-_.](?:latest|beta|rc|dev|preview|ga|stable)\b(?:[-_.]|\b)/g, "")
    .replace(/[-_.]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** 名字等效判定 */
function modelNameEquivalent(a, b) {
  const na = normalizeModelId(a);
  const nb = normalizeModelId(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.startsWith(nb) || nb.startsWith(na)) {
    const rest = na.length > nb.length ? na.slice(nb.length) : nb.slice(na.length);
    return /^[-.\d]*$/.test(rest);
  }
  return false;
}

/** 在字典中按名字等效寻找条目 */
function findEntryByName(dict, id) {
  if (!dict) return undefined;
  if (dict[id]) return dict[id];
  const target = normalizeModelId(id);
  // 先匹配归一化后的完整名字，避免先遇到短名字时吞掉更精确的条目；保留 max 等模型档。
  for (const key of Object.keys(dict)) {
    if (normalizeModelId(key) === target) return dict[key];
  }
  for (const key of Object.keys(dict)) {
    if (modelNameEquivalent(key, target)) {
      return dict[key];
    }
  }
  return undefined;
}

/** 从 models.dev 全局寻找条目 */
function findInModelsDev(modelsDev, id, provider) {
  if (!modelsDev || typeof modelsDev !== "object") return undefined;
  if (provider && modelsDev[provider]?.models) {
    const hit = findEntryByName(modelsDev[provider].models, id);
    if (hit) return hit;
  }
  // 自定义网关名称不一定是 models.dev 的提供方 ID，优先查真实厂商，避免任取另一网关。
  const normalized = normalizeModelId(id);
  const upstream = normalized.startsWith("gemini-") ? "google"
    : normalized.startsWith("claude-") ? "anthropic"
    : normalized.startsWith("deepseek-") ? "deepseek" : "";
  if (upstream) {
    const hit = findEntryByName(modelsDev[upstream]?.models, id);
    if (hit) return hit;
  }
  for (const provKey of Object.keys(modelsDev)) {
    const hit = findEntryByName(modelsDev[provKey]?.models, id);
    if (hit) return hit;
  }
  return undefined;
}

/** 解析 models.dev 中的 reasoning_options */
function extractEffortsFromModelsDev(md) {
  if (!md) return undefined;
  const opt = md.reasoning_options;
  const arr = Array.isArray(opt) ? opt : opt ? [opt] : [];
  const effort = arr.find((o) => o && typeof o === "object" && o.type === "effort" && Array.isArray(o.values));
  if (!effort || !Array.isArray(effort.values) || effort.values.length === 0) return undefined;
  const valid = [];
  for (const raw of effort.values) {
    const val = String(raw || "").trim().toLowerCase();
    const mapped = val === "none" ? "off" : val;
    if (ALL_THINKING_LEVELS.includes(mapped) || val === "none") {
      valid.push(val);
    }
  }
  return valid.length > 0 ? Array.from(new Set(valid)) : undefined;
}

/**
 * 启发式规则检测模型能力（当 models.dev 与清单均未明确定义时）
 */
function heuristicCapabilities(modelId) {
  const name = normalizeModelId(modelId);

  // 1. OpenAI o 系列推理模型：o1, o1-mini, o3, o3-mini, o4 等
  if (/(?:^|\/)(?:o1|o3|o4)(?:-|$)/i.test(name)) {
    return {
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
      supportsTemperature: false,
      thinkingFormat: "openai",
      source: "heuristic",
    };
  }

  // 2. GPT-5 及更高版本
  if (/(?:^|\/)gpt-(?:5|o\d)/i.test(name)) {
    return {
      reasoning: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      supportsTemperature: true,
      thinkingFormat: "openai",
      source: "heuristic",
    };
  }

  // 3. 通用 GPT 匹配（保持与原测试 gpt-5.6 / gpt-* 兼容）
  if (/(?:^|\/)gpt(?:-|$)/i.test(name)) {
    return {
      reasoning: true,
      reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      supportsTemperature: true,
      thinkingFormat: "openai",
      source: "heuristic",
    };
  }

  // 4. DeepSeek R1 / Reasoner / V4 推理模型
  if (/(?:^|\/)(?:deepseek-(?:r1|reasoner|v4)|r1\b)/i.test(name)) {
    return {
      reasoning: true,
      reasoningEfforts: ["high", "max"],
      supportsTemperature: false,
      thinkingFormat: "deepseek",
      source: "heuristic",
    };
  }

  // 5. QwQ / QvQ
  if (/(?:^|\/)(?:qwq|qvq)\b/i.test(name)) {
    return {
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      supportsTemperature: false,
      thinkingFormat: "openai",
      source: "heuristic",
    };
  }

  // 6. Kimi K3
  if (/(?:^|\/)kimi-k3\b/i.test(name)) {
    return {
      reasoning: true,
      reasoningEfforts: ["max"],
      supportsTemperature: false,
      thinkingFormat: "openai",
      source: "heuristic",
    };
  }

  // 7. Claude 3.7+ / Sonnet 4 / Sonnet 5 / Opus 4 思考模型
  if (/(?:^|\/)claude-(?:3-7|sonnet-4|sonnet-5|opus-4)/i.test(name)) {
    return {
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high", "max"],
      supportsTemperature: true,
      thinkingFormat: "claude",
      source: "heuristic",
    };
  }

  // 8. 名字包含明确 thinking / reasoner / reasoning 的模型
  if (/(?:^|\/|-|_|\b)(?:thinking|reasoner|reasoning)\b/i.test(String(modelId || ""))) {
    return {
      reasoning: true,
      reasoningEfforts: ["low", "medium", "high"],
      supportsTemperature: false,
      thinkingFormat: "openai",
      source: "heuristic",
    };
  }

  // 9. 保守默认：非推理模型
  return {
    reasoning: false,
    reasoningEfforts: [],
    supportsTemperature: true,
    thinkingFormat: "none",
    source: "default",
  };
}

/**
 * 检测模型能力：manifest -> 端点声明 -> models.dev -> heuristic -> default。
 *
 * @param {string} modelId
 * @param {string} [provider]
 * @param {object} [modelsDevData] 可选注入已拉取的 models.dev 数据
 * @param {object} [declared] 该模型的端点声明或已保存的能力白名单
 * @returns {object} { id, name, reasoning, reasoningEfforts, supportsTemperature, thinkingFormat, source }
 */
function detectModelCapabilities(modelId, provider = "", modelsDevData = null, declared = null) {
  const id = String(modelId || "").trim();
  if (!id) {
    return {
      id: "",
      name: "",
      reasoning: false,
      reasoningEfforts: [],
      supportsTemperature: true,
      thinkingFormat: "none",
      source: "default",
    };
  }

  // 1. 命中内置 Manifest 清单（人工维护档位优先，会话内行为稳定且不依赖网络时序）
  const mf = findEntryByName(MANIFEST, id);
  if (mf) {
    return {
      id,
      name: mf.name || id,
      reasoning: Boolean(mf.reasoning),
      reasoningEfforts: [...(mf.reasoningEfforts || [])],
      supportsTemperature: mf.supportsTemperature !== false,
      thinkingFormat: mf.thinkingFormat || "openai",
      source: "manifest",
    };
  }

  // 2. 端点自声明（参考 dsh-model-detector），不把普通模型目录的 id/name 当能力声明。
  const raw = declared && typeof declared === "object" ? declared : {};
  const effortValues = raw.reasoning_supported_efforts ?? raw.reasoningSupportedEfforts
    ?? raw.reasoning_efforts ?? raw.reasoningEfforts;
  const declaredEfforts = Array.isArray(effortValues)
    ? extractEffortsFromModelsDev({ reasoning_options: { type: "effort", values: effortValues } })
    : extractEffortsFromModelsDev(raw);
  const declaredReasoning = raw.supports_reasoning ?? raw.supportsReasoning ?? raw.reasoning;
  if (declaredEfforts || typeof declaredReasoning === "boolean") {
    const reasoning = declaredEfforts ? true : declaredReasoning;
    return {
      id, name: typeof raw.name === "string" ? raw.name : id,
      reasoning,
      reasoningEfforts: reasoning ? (declaredEfforts || []) : [],
      supportsTemperature: typeof raw.supportsTemperature === "boolean" ? raw.supportsTemperature : !reasoning,
      thinkingFormat: id.toLowerCase().includes("claude") ? "claude" : "openai",
      source: ["manifest", "provider", "models-dev", "heuristic", "default"].includes(raw.source) ? raw.source : "provider",
    };
  }

  // 3. models.dev 匹配（清单未收录的模型从这里富化）
  const md = findInModelsDev(modelsDevData || cachedModelsDev, id, provider);
  if (md) {
    const mdEfforts = extractEffortsFromModelsDev(md);
    const reasoning = md.reasoning === true || Boolean(mdEfforts && mdEfforts.length > 0);
    return {
      id,
      name: md.name || id,
      reasoning,
      reasoningEfforts: mdEfforts || [],
      supportsTemperature: md.supportsTemperature !== false && !reasoning,
      thinkingFormat: md.thinkingFormat || (id.toLowerCase().includes("claude") ? "claude" : "openai"),
      source: "models-dev",
    };
  }

  // 4. 启发式命名规则与默认回退
  const heuristic = heuristicCapabilities(id);
  return {
    id,
    name: id,
    ...heuristic,
  };
}

// 把同一组纯函数及其显式依赖注入两个工作台；不带 fetch、Node 依赖或服务器缓存。
function browserModelCapabilitiesSource() {
  return [
    "const resolveClientModelCapabilities = (() => {",
    "const ALL_THINKING_LEVELS = " + JSON.stringify(ALL_THINKING_LEVELS) + ";",
    "const MANIFEST = " + JSON.stringify(MANIFEST).replace(/</g, "\\u003c") + ";",
    "const cachedModelsDev = null;",
    ...[normalizeModelId, modelNameEquivalent, findEntryByName, findInModelsDev,
      extractEffortsFromModelsDev, heuristicCapabilities, detectModelCapabilities].map((fn) => fn.toString()),
    "return detectModelCapabilities; })();",
  ].join("\n");
}

/**
 * 判断是否为推理模型（支持模型元数据或根据名称判断）
 */
function isReasoningModel(model, modelMeta = null) {
  if (modelMeta && typeof modelMeta.reasoning === "boolean") {
    return modelMeta.reasoning;
  }
  const caps = detectModelCapabilities(model);
  return caps.reasoning;
}

/**
 * 校验并规范化针对特定模型的思考强度参数。
 * “绝不套用统一档位”：仅当该模型显式支持所选档位时才接受，否则回退为空（使用模型默认）。
 */
function normalizeModelReasoningEffort(value, model, modelMeta = null) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw || raw === "default") return "";

  const caps = modelMeta || detectModelCapabilities(model);
  if (!caps.reasoning) return "";

  const supported = Array.isArray(caps.reasoningEfforts) ? caps.reasoningEfforts : [];
  // 只要支持列表包含该档位（或 none/off 等价）
  if (supported.includes(raw)) return raw;
  if (raw === "off" && supported.includes("none")) return "none";
  if (raw === "none" && supported.includes("off")) return "off";

  // 若模型只支持单一档位（如 kimi-k3 只有 max）或用户传了合法档位但元数据未穷举，进行容错校验
  return "";
}

module.exports = {
  ALL_THINKING_LEVELS,
  CLAUDE_THINKING_BUDGETS,
  MANIFEST,
  MODELS_DEV_URL,
  THINKING_LEVEL_LABELS,
  detectModelCapabilities,
  browserModelCapabilitiesSource,
  normalizeModelId,
  getModelsDevStatus,
  isReasoningModel,
  loadModelsDev,
  normalizeModelReasoningEffort,
};
