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

function buildChatCompletionBody(messages, config = {}, modelMeta = null) {
  const caps = modelMeta || detectModelCapabilities(config.model, config.provider);
  const body = {
    model: config.model,
    messages,
    stream: false,
  };
  if (caps.reasoning || isGptModel(config.model)) {
    const effort = normalizeModelReasoningEffort(config.reasoningEffort, config.model, caps);
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

async function fetchJson(url, options, { timeoutMs = 90000, signal = null } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let abortedByCaller = false;

  const onCallerAbort = () => {
    abortedByCaller = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) {
      const err = new Error("操作已被取消");
      err.name = "AbortError";
      throw err;
    }
    signal.addEventListener("abort", onCallerAbort, { once: true });
  }

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const safeUrl = await assertSafeOutboundUrl(url);
    const response = await fetch(safeUrl, {
      ...options,
      redirect: "manual",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const error = new Error(`${url} 返回 HTTP ${response.status}: ${text.slice(0, 500)}`);
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
      const error = new Error(`${url} 返回了非 JSON 响应（${contentType}）：${preview || "空响应"}`);
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
    if (abortedByCaller && error?.name === "AbortError") {
      const abortError = new Error("请求已被取消");
      abortError.name = "AbortError";
      abortError.code = "ABORTED";
      throw abortError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    if (signal) {
      signal.removeEventListener("abort", onCallerAbort);
    }
  }
}

async function callChatCompletions(messages, config = {}, options = {}) {
  const provider = config.provider === "claude" ? "claude" : "compatible";
  const timeoutMs = options.timeoutMs || config.timeoutMs || 90000;
  const signal = options.signal || config.signal || null;

  if (provider === "claude") {
    const endpoint = buildApiUrl(config.baseUrl || "https://api.anthropic.com", "/v1/messages");
    const headers = buildProviderHeaders({ provider: "claude", apiKey: config.apiKey });
    const body = buildClaudeMessageBody(messages, config);
    const data = await fetchJson(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }, { timeoutMs, signal });
    return extractClaudeText(data);
  }

  const endpoint = buildApiUrl(config.baseUrl || "http://127.0.0.1:11434/v1", "/v1/chat/completions");
  const headers = buildProviderHeaders({ provider: "compatible", apiKey: config.apiKey });
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
  const provider = config.provider === "claude" ? "claude" : "compatible";
  const timeoutMs = options.timeoutMs || config.timeoutMs || 20000;
  const signal = options.signal || config.signal || null;
  const baseUrl = config.baseUrl || (provider === "claude" ? "https://api.anthropic.com" : "http://127.0.0.1:11434/v1");

  const endpoint = buildApiUrl(baseUrl, "/v1/models");
  const headers = buildProviderHeaders({ provider, apiKey: config.apiKey });

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
    const caps = detectModelCapabilities(id, provider);
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
      message: "请求超时，网络连接超时或模型响应过慢。",
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
  const provider = config.provider === "claude" ? "claude" : "compatible";
  const baseUrl = String(config.baseUrl || "").trim().replace(/\/+$/, "");
  const model = String(config.model || "").trim();
  const apiKey = String(config.apiKey || "").trim();
  const timeoutMs = options.timeoutMs || config.timeoutMs || 15000;
  const signal = options.signal || config.signal || null;

  if (!baseUrl) {
    return {
      ok: false,
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
    if (provider === "claude") {
      const endpoint = buildApiUrl(baseUrl || "https://api.anthropic.com", "/v1/messages");
      const headers = buildProviderHeaders({ provider: "claude", apiKey });
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
      const usage = {
        promptTokens: Number(data.usage?.input_tokens) || 0,
        completionTokens: Number(data.usage?.output_tokens) || 0,
        totalTokens: (Number(data.usage?.input_tokens) || 0) + (Number(data.usage?.output_tokens) || 0),
      };

      return {
        ok: true,
        provider: "claude",
        model,
        latencyMs,
        replyPreview,
        usage,
        message: `模型连通成功（耗时 ${latencyMs}ms）`,
      };
    }

    const endpoint = buildApiUrl(baseUrl || "http://127.0.0.1:11434/v1", "/v1/chat/completions");
    const headers = buildProviderHeaders({ provider: "compatible", apiKey });
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
    const usage = {
      promptTokens: Number(data.usage?.prompt_tokens) || 0,
      completionTokens: Number(data.usage?.completion_tokens) || 0,
      totalTokens: Number(data.usage?.total_tokens) || 0,
    };

    return {
      ok: true,
      provider: "compatible",
      model,
      latencyMs,
      replyPreview,
      usage,
      message: `模型连通成功（耗时 ${latencyMs}ms）`,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const diag = diagnoseConnectivityError(error, { model, baseUrl, provider });
    return {
      ok: false,
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
  assertSafeOutboundUrl,
  buildApiUrl,
  buildProviderHeaders,
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
