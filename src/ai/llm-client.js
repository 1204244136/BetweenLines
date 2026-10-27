const { normalizeConnectionConfig } = require("./connection-config");
const { normalizeTokenUsage } = require("./token-usage");
const { CACHEABLE_PREFIX_LENGTH } = require("./prompt-contract");
/**
 * 共享底层 LLM 客户端与传输层 (src/ai/llm-client.js)
 *
 * 遵循 AGENTS.md 与 src/ai/README.md 契约：
 * 纯技术传输层，不强加任何领域特定模型（翻译/说话人/校对字段）。
 * 提供标准的 OpenAI 兼容协议与 Claude 原生 Messages 协议传输能力，
 * 支持请求超时、取消信号、思考/推理参数映射以及安全 JSON 反序列化。
 */

const dns = require("node:dns").promises;
const net = require("node:net");
// 非流式生成要等完整正文（含推理）才返回，预算与模型列表/连通测试分开。
const MODEL_RESPONSE_TIMEOUT_MS = 300000;
const {
  detectModelCapabilities,
  normalizeModelReasoningEffort,
  CLAUDE_THINKING_BUDGETS,
} = require("../workbenches/translation-compare/ai/model-capabilities");

const blockedMetadataHosts = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "instance-data",
  "instance-data.ec2.internal",
]);
const outboundHostCache = new Map();
const outboundHostCacheTtlMs = 60 * 1000;

function isBlockedAddress(address) {
  const value = String(address || "").toLowerCase().split("%")[0];
  if (net.isIPv4(value)) {
    const octets = value.split(".").map(Number);
    return octets[0] === 0
      || (octets[0] === 169 && octets[1] === 254)
      || octets[0] >= 224;
  }
  if (net.isIPv6(value)) {
    if (value.startsWith("::ffff:")) return isBlockedAddress(value.slice("::ffff:".length));
    return value === "::"
      || /^fe[89ab]/i.test(value)
      || /^ff/i.test(value);
  }
  return false;
}

async function resolveOutboundAddresses(hostname) {
  const cached = outboundHostCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  const addresses = records.map((record) => record.address);
  outboundHostCache.set(hostname, {
    addresses,
    expiresAt: Date.now() + outboundHostCacheTtlMs,
  });
  return addresses;
}

async function assertSafeOutboundUrl(url) {
  let parsed;
  try {
    parsed = new URL(String(url || ""));
  } catch {
    throw new Error("模型接口地址无效。");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("模型接口只支持 http:// 或 https:// 地址。");
  }
  if (parsed.username || parsed.password) {
    throw new Error("模型接口地址不能包含用户名或密码。");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!hostname) throw new Error("模型接口地址缺少主机名。");
  if (blockedMetadataHosts.has(hostname)) {
    throw new Error("拒绝访问云元数据地址。");
  }
  const addresses = net.isIP(hostname) ? [hostname] : await resolveOutboundAddresses(hostname);
  if (!addresses.length) throw new Error(`无法解析模型接口主机：${hostname}`);
  if (addresses.some(isBlockedAddress)) {
    throw new Error(`拒绝访问 link-local、多播或未指定地址：${hostname}`);
  }
  return parsed.toString();
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

function buildProtocolHeaders(config = {}) {
  const { protocol } = normalizeConnectionConfig(config, "compatible");
  const headers = { "content-type": "application/json" };
  if (protocol === "claude") {
    headers["anthropic-version"] = "2023-06-01";
    if (config.apiKey) headers["x-api-key"] = config.apiKey;
  } else if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

function isGptModel(model) {
  return /(?:^|\/)gpt(?:-|$)/i.test(String(model || "").trim());
}

const TEXT_INTENSITY_TEMPERATURE_MAP = {
  low: 0.2,
  medium: 0.5,
  high: 0.7,
  xhigh: 0.85,
  ultra: 0.95,
  max: 1.0,
};

function normalizeNonGptTemperature(value) {
  if (value == null || String(value).trim() === "") return null;
  const trimmed = String(value).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TEXT_INTENSITY_TEMPERATURE_MAP, trimmed)) {
    return TEXT_INTENSITY_TEMPERATURE_MAP[trimmed];
  }
  const temperature = Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
    return null;
  }
  return Math.round(temperature * 10) / 10;
}

/**
 * 构造请求体。`options.effortNormalizer(value, model, caps)` 允许领域层替换推理档位归一化
 * ；不传时用模型元数据表的口径，仅允许该模型明确支持的档位。
 */
function buildChatCompletionBody(messages, config = {}, modelMeta = null, options = {}) {
  const caps = modelMeta || detectModelCapabilities(config.model, config.provider, null,
    config.modelMeta?.id === config.model ? config.modelMeta : null);
  const normalizeEffort = options.effortNormalizer || normalizeModelReasoningEffort;
  const body = {
    model: config.model,
    messages,
    stream: false,
  };
  if (caps.reasoning) {
    const effort = normalizeEffort(config.reasoningEffort, config.model, caps);
    if (effort && effort !== "off" && effort !== "none") {
      body.reasoning_effort = effort;
    }
  } else {
    const temperature = normalizeNonGptTemperature(config.temperature ?? config.reasoningEffort);
    if (temperature != null && caps.supportsTemperature !== false) {
      body.temperature = temperature;
    }
  }
  return body;
}

function buildClaudeSystem(messages) {
  const systemMessages = messages.filter((message) => message.role === "system" && String(message.content || ""));
  const blocks = [];
  let breakpoints = 0;
  let stablePrefixOpen = true;
  for (const [index, message] of systemMessages.entries()) {
    const content = String(message.content || "");
    const separator = index > 0 ? "\n\n" : "";
    const boundary = message[CACHEABLE_PREFIX_LENGTH];
    const declaredStable = Number.isInteger(boundary) && boundary > 0 && boundary <= content.length;
    if (stablePrefixOpen && declaredStable && breakpoints < 4) {
      blocks.push({ type: "text", text: separator + content.slice(0, boundary), cache_control: { type: "ephemeral" } });
      if (boundary < content.length) blocks.push({ type: "text", text: content.slice(boundary) });
      breakpoints += 1;
    } else {
      blocks.push({ type: "text", text: separator + content });
    }
    // Claude 断点覆盖此前全部内容；遇到动态或未声明的文本后不能再标后续断点。
    stablePrefixOpen = stablePrefixOpen && declaredStable && boundary === content.length;
  }
  // 未声明稳定前缀的旧调用保留字符串请求格式；不替调用方猜缓存边界。
  return breakpoints > 0 ? blocks : blocks.map((block) => block.text).join("");
}

function buildClaudeMessageBody(messages, config = {}, modelMeta = null) {
  const caps = modelMeta || detectModelCapabilities(config.model, config.provider, null,
    config.modelMeta?.id === config.model ? config.modelMeta : null);
  const system = buildClaudeSystem(messages);
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
    const temperature = normalizeNonGptTemperature(config.temperature ?? config.reasoningEffort);
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

/** 错误信息里的地址去掉凭据与查询串，避免把 key 写进日志。 */
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

function isRetryableStreamInterruption(error) {
  if (!error || error.name === "AbortError" || error.code === "HTTP_ERROR" || error.code === "ACCOUNT_RESTRICTED") return false;
  const text = [error.message, error.cause?.message].filter(Boolean).join(" ").toLowerCase();
  const code = String(error.code || error.cause?.code || "").toUpperCase();
  return error.code === "STREAM_INTERRUPTED"
    || code === "UND_ERR_SOCKET"
    || /terminated|socket hang up|error reading a body from connection|connection reset|other side closed|body.*(?:closed|aborted)/.test(text);
}

function isAccountRestrictionResponse(text) {
  let payload;
  try { payload = JSON.parse(text); } catch { return false; }
  const detail = payload?.error && typeof payload.error === "object" ? payload.error : payload;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return false;
  const codes = [detail.code, detail.type].map((value) => String(value ?? "").trim().toUpperCase());
  if (codes.some((code) => ["ACCOUNT_RESTRICTED", "ACCOUNT_BLOCKED", "ACCOUNT_SUSPENDED", "ACCOUNT_BANNED"].includes(code))) return true;
  const message = typeof detail.message === "string" ? detail.message : "";
  const knownRiskCode = codes.includes("11140") || /\bcode\s*[:=]?\s*11140\b/i.test(message);
  // 网关可能把上游账号拒绝包装成 429；业务码与账号限制语义同时成立才覆盖频控分类。
  return knownRiskCode && /(?:账号|账户)[^。！？\n]{0,80}(?:异常行为|限制|受限|封禁|冻结|停用)|(?:限制|封禁|冻结|停用)[^。！？\n]{0,40}(?:账号|账户)|\baccount\b.{0,80}\b(?:restricted|blocked|suspended|banned|abnormal behavior)\b/i.test(message);
}

function waitForStreamRetry(delayMs, signal) {
  if (signal?.aborted) {
    const error = new Error("操作已被取消");
    error.name = "AbortError";
    error.code = "ABORTED";
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const error = new Error("操作已被取消");
      error.name = "AbortError";
      error.code = "ABORTED";
      reject(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function fetchJson(url, options, {
  timeoutMs = 90000,
  signal = null,
  // 流中断发生在 HTTP 200 之后，通常是代理/上游连接短暂断开；只重发完整请求，
  // 不把它交给阶段并发调度器下调并发。调用方仍可通过 signal 立即取消。
  maxStreamRetries = 2,
  streamRetryDelayMs = 250,
} = {}) {
  // 出站地址安全校验可能包含 DNS 解析，只做一次，且不占用每次请求的响应超时预算。
  const safeUrl = await assertSafeOutboundUrl(url);
  let streamRetry = 0;

  while (true) {
    const controller = new AbortController();
    let timedOut = false;
    let abortedByCaller = false;
    let requestStarted = false;
    let requestStartedAt = 0;
    let response = null;
    let timeout = null;
    const onCallerAbort = () => {
      abortedByCaller = true;
      controller.abort();
    };
    if (signal) {
      if (signal.aborted) {
        const error = new Error("操作已被取消");
        error.name = "AbortError";
        error.code = "ABORTED";
        throw error;
      }
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      requestStartedAt = Date.now();
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      requestStarted = true;
      response = await fetch(safeUrl, {
        ...options,
        redirect: "manual",
        signal: controller.signal,
      });
      if (!response.ok) {
        // 状态码已足够判定限流/认证/服务端错误，错误正文读不完也不能丢掉它。
        let text = "";
        let bodyError = null;
        try {
          text = await response.text();
        } catch (cause) {
          if (abortedByCaller) throw cause;
          bodyError = cause;
        }
        const detail = bodyError
          ? (timedOut ? `错误正文未能完整读取（本地等待上限 ${Math.ceil(timeoutMs / 1000)} 秒）` : "错误正文读取中断")
          : text.slice(0, 500);
        const accountRestricted = !bodyError && isAccountRestrictionResponse(text);
        const error = new Error(`${accountRestricted ? "账号访问受限：" : ""}${displayRequestUrl(url)} 返回 HTTP ${response.status}: ${detail}`);
        error.code = accountRestricted ? "ACCOUNT_RESTRICTED" : "HTTP_ERROR";
        error.httpStatus = response.status;
        error.responseBody = text;
        error.receivedHeaders = true;
        error.elapsedMs = Date.now() - requestStartedAt;
        if (bodyError) error.cause = bodyError;
        if (timedOut) {
          error.timeoutPhase = "reading_body";
          error.timeoutMs = timeoutMs;
        }
        const retryAfter = response.headers?.get?.("retry-after");
        if (retryAfter) error.retryAfter = retryAfter;
        throw error;
      }
      let text;
      try {
        text = await response.text();
      } catch (cause) {
        if (!abortedByCaller && !timedOut && isRetryableStreamInterruption(cause)) {
          const error = new Error(`${displayRequestUrl(url)} 响应流中断：${cause.message || String(cause)}`);
          error.code = "STREAM_INTERRUPTED";
          error.retryable = true;
          error.cause = cause;
          throw error;
        }
        throw cause;
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
      if (abortedByCaller && controller.signal.aborted) {
        const abortError = new Error("请求已被取消");
        abortError.name = "AbortError";
        abortError.code = "ABORTED";
        throw abortError;
      }
      if (timedOut && requestStarted && controller.signal.aborted && !["HTTP_ERROR", "ACCOUNT_RESTRICTED"].includes(error?.code)) {
        const phase = response ? `已收到 HTTP ${response.status}，读取响应正文` : "等待响应头";
        const timeoutError = new Error(`本地请求超时（${Math.ceil(timeoutMs / 1000)} 秒；${phase}）`);
        timeoutError.code = "REQUEST_TIMEOUT";
        timeoutError.timeoutPhase = response ? "reading_body" : "waiting_response";
        timeoutError.timeoutMs = timeoutMs;
        timeoutError.elapsedMs = Date.now() - requestStartedAt;
        timeoutError.receivedHeaders = Boolean(response);
        timeoutError.httpStatus = response?.status || null;
        timeoutError.cause = error;
        throw timeoutError;
      }
      if (isRetryableStreamInterruption(error) && streamRetry < maxStreamRetries && !signal?.aborted) {
        streamRetry += 1;
        await waitForStreamRetry(streamRetryDelayMs * streamRetry, signal);
        continue;
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

async function callChatCompletions(messages, config = {}, options = {}) {
  const { protocol } = normalizeConnectionConfig(config, "compatible");
  const timeoutMs = options.timeoutMs || config.timeoutMs || MODEL_RESPONSE_TIMEOUT_MS;
  const signal = options.signal || config.signal || null;

  if (protocol === "claude") {
    const endpoint = buildApiUrl(config.baseUrl || "https://api.anthropic.com", "/v1/messages");
    const headers = buildProtocolHeaders({ protocol: "claude", apiKey: config.apiKey });
    const body = buildClaudeMessageBody(messages, config);
    const data = await fetchJson(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { timeoutMs, signal });
    return extractClaudeText(data);
  }

  const endpoint = buildApiUrl(config.baseUrl || "http://127.0.0.1:11434/v1", "/v1/chat/completions");
  const headers = buildProtocolHeaders({ protocol: "compatible", apiKey: config.apiKey });
  const body = buildChatCompletionBody(messages, config);
  const data = await fetchJson(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  }, { timeoutMs, signal });
  return data.choices?.[0]?.message?.content || "";
}

function cleanJsonPayload(rawText) {
  const text = String(rawText || "").trim();
  if (!text) return null;

  // 剥离 ```json ... ``` 或 ``` ... ``` 代码块标记
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = codeBlockMatch ? codeBlockMatch[1].trim() : text;

  try {
    return JSON.parse(candidate);
  } catch {
    // 尝试寻找最外层 { ... }
    const firstBrace = candidate.indexOf("{");
    const lastBrace = candidate.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      const slice = candidate.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(slice);
      } catch {}
    }
    return null;
  }
}

async function listProviderModels(config = {}, options = {}) {
  const { protocol, provider } = normalizeConnectionConfig(config, "compatible");
  const timeoutMs = options.timeoutMs || config.timeoutMs || 20000;
  const signal = options.signal || config.signal || null;
  const baseUrl = config.baseUrl || (protocol === "claude" ? "https://api.anthropic.com" : "http://127.0.0.1:11434/v1");

  const endpoint = buildApiUrl(baseUrl, "/v1/models");
  const headers = buildProtocolHeaders({ protocol, apiKey: config.apiKey });

  const data = await fetchJson(endpoint, {
    method: "GET",
    headers,
  }, { timeoutMs, signal });

  const items = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : (Array.isArray(data) ? data : []));
  const seen = new Set();
  const models = [];

  for (const item of items) {
    const id = String(item.id || item.name || item.model || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const caps = detectModelCapabilities(id, provider, null, item);
    models.push({
      id,
      name: String(item.name || item.id || id),
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

function diagnoseConnectivityError(error, context = {}) {
  const rawMessage = error?.message || String(error || "");
  const httpStatus = error?.httpStatus || (rawMessage.match(/HTTP (\d+)/i) ? Number(RegExp.$1) : null);
  const code = error?.code || error?.cause?.code || "";

  if (code === "ACCOUNT_RESTRICTED") {
    return {
      message: "账号访问受限：上游账号被限制，请检查账号状态或选择可用的模型预设后重试。",
      code: "ACCOUNT_RESTRICTED",
      httpStatus,
    };
  }

  if (code === "ECONNREFUSED" || error?.cause?.code === "ECONNREFUSED" || /ECONNREFUSED/i.test(rawMessage)) {
    return {
      message: "无法连接到接口服务（连接被拒绝），请检查服务是否已启动、端口是否正确。",
      code: "CONNECTION_REFUSED",
      httpStatus,
    };
  }
  if (code === "ENOTFOUND" || error?.cause?.code === "ENOTFOUND" || /ENOTFOUND/i.test(rawMessage)) {
    return {
      message: "域名解析失败（ENOTFOUND），请检查接口地址的主机名是否正确。",
      code: "DNS_RESOLUTION_FAILED",
      httpStatus,
    };
  }
  if (code === "REQUEST_TIMEOUT" || error?.name === "TimeoutError" || /超时/i.test(rawMessage)) {
    return {
      message: code === "REQUEST_TIMEOUT" && error?.timeoutPhase
        ? rawMessage
        : "请求超时，网络连接超时或模型响应过慢。",
      code: "REQUEST_TIMEOUT",
      httpStatus,
    };
  }
  if (httpStatus === 401) {
    return {
      message: "认证失败（HTTP 401）：API Key 无效或未提供，请检查 API Key 配置。",
      code: "UNAUTHORIZED",
      httpStatus: 401,
    };
  }
  if (httpStatus === 403) {
    return {
      message: "访问受限（HTTP 403）：没有权限访问该接口/模型或所在地区受限。",
      code: "FORBIDDEN",
      httpStatus: 403,
    };
  }
  if (httpStatus === 404) {
    const modelHint = context.model ? `「${context.model}」` : "";
    return {
      message: `模型或端点不存在（HTTP 404）：请确认模型名称${modelHint}是否正确，或接口路径是否匹配。`,
      code: "NOT_FOUND",
      httpStatus: 404,
    };
  }
  if (httpStatus === 429) {
    return {
      message: "请求受限或额度不足（HTTP 429）：遭遇并发频控（Rate Limit）或账户余额不足。",
      code: "RATE_LIMITED",
      httpStatus: 429,
    };
  }
  if (httpStatus >= 500) {
    return {
      message: `模型服务端异常（HTTP ${httpStatus}）：服务提供方内部发生错误，请稍后重试。`,
      code: "SERVER_ERROR",
      httpStatus,
    };
  }
  if (code === "INVALID_JSON_RESPONSE") {
    return {
      message: "接口返回了非 JSON 响应，可能是网关、反向代理或登录页拦截并返回了 HTML。",
      code: "INVALID_JSON_RESPONSE",
      httpStatus,
    };
  }
  return {
    message: rawMessage || "连通性测试失败，未知错误。",
    code: code || "UNKNOWN_ERROR",
    httpStatus,
  };
}

async function testModelConnectivity(config = {}, options = {}) {
  const { protocol, provider } = normalizeConnectionConfig(config, "compatible");
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(config.model || "").trim();
  const apiKey = String(config.apiKey || "").trim();
  const timeoutMs = options.timeoutMs || config.timeoutMs || 15000;
  const signal = options.signal || config.signal || null;

  if (!baseUrl) {
    return {
      ok: false,
      protocol,
      provider,
      model,
      latencyMs: 0,
      error: "未填写接口地址，请先输入接口地址。",
      code: "MISSING_BASE_URL",
      httpStatus: null,
      message: "模型连通失败：未填写接口地址，请先输入接口地址。",
    };
  }

  if (!model) {
    return {
      ok: false,
      protocol,
      provider,
      model,
      latencyMs: 0,
      error: "未选择或填写模型名称，请先选择或输入模型。",
      code: "MISSING_MODEL",
      httpStatus: null,
      message: "模型连通失败：未选择或填写模型名称，请先选择或输入模型。",
    };
  }

  const startTime = Date.now();
  const probeMessages = [{ role: "user", content: "Hi" }];

  try {
    if (protocol === "claude") {
      const endpoint = buildApiUrl(baseUrl || "https://api.anthropic.com", "/v1/messages");
      const headers = buildProtocolHeaders({ protocol: "claude", apiKey });
      const body = {
        model,
        max_tokens: 5,
        messages: probeMessages,
      };
      const data = await fetchJson(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      }, { timeoutMs, signal });

      const latencyMs = Date.now() - startTime;
      const replyPreview = extractClaudeText(data).trim();
      const usage = normalizeTokenUsage(data.usage, "claude");

      return {
        ok: true,
        protocol,
        provider,
        model,
        latencyMs,
        replyPreview,
        usage,
        message: `模型连通成功（耗时 ${latencyMs}ms）`,
      };
    }

    const endpoint = buildApiUrl(baseUrl || "http://127.0.0.1:11434/v1", "/v1/chat/completions");
    const headers = buildProtocolHeaders({ protocol: "compatible", apiKey });
    const caps = detectModelCapabilities(model, provider);

    const makeProbeBody = (useCompletionTokens) => {
      const body = {
        model,
        messages: probeMessages,
        stream: false,
      };
      if (useCompletionTokens) {
        body.max_completion_tokens = 16;
      } else {
        body.max_tokens = 5;
      }
      return body;
    };

    const preferCompletionTokens = caps.reasoning || isGptModel(model);
    let data;

    try {
      data = await fetchJson(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(makeProbeBody(preferCompletionTokens)),
      }, { timeoutMs, signal });
    } catch (err) {
      const errText = String(err?.message || "");
      const isTokenParamError = err?.httpStatus === 400 && (/max_tokens/i.test(errText) || /max_completion_tokens/i.test(errText));
      if (isTokenParamError) {
        data = await fetchJson(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(makeProbeBody(!preferCompletionTokens)),
        }, { timeoutMs, signal: options.signal });
      } else {
        throw err;
      }
    }

    const latencyMs = Date.now() - startTime;
    const replyPreview = String(data.choices?.[0]?.message?.content || "").trim();
    const usage = normalizeTokenUsage(data.usage);

    return {
      ok: true,
      protocol,
      provider,
      model,
      latencyMs,
      replyPreview,
      usage,
      message: `模型连通成功（耗时 ${latencyMs}ms）`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const diag = diagnoseConnectivityError(error, { model, baseUrl, protocol });
    return {
      ok: false,
      protocol,
      provider,
      model,
      latencyMs,
      error: diag.message,
      rawError: error.message || String(error),
      httpStatus: diag.httpStatus || null,
      code: diag.code || "UNKNOWN_ERROR",
      message: `模型连通失败：${diag.message}`,
    };
  }
}

module.exports = {
  MODEL_RESPONSE_TIMEOUT_MS,
  assertSafeOutboundUrl,
  buildApiUrl,
  buildProtocolHeaders,
  buildChatCompletionBody,
  buildClaudeMessageBody,
  extractClaudeText,
  fetchJson,
  callChatCompletions,
  cleanJsonPayload,
  listProviderModels,
  diagnoseConnectivityError,
  testModelConnectivity,
  isGptModel,
  TEXT_INTENSITY_TEMPERATURE_MAP,
  normalizeNonGptTemperature,
};
