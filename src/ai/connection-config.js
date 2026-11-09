// 纯函数，同时注入工作台页面与说话人页面：两个函数都不引用模块作用域，可单独 toString() 注入。
// protocol 决定传输；provider 只表示供应商。
const CONNECTION_PROTOCOLS = ["local", "claude", "compatible"];

// 地址 → 接口类型：只认「连到哪儿」，不读供应商名，也不发探测请求。
// 界面不提供手动覆盖，地址是唯一依据；protocol 为空表示地址本身还看不出接口类型（留空或无法解析），
// 由调用方保留当前值或回落到默认档。
function inferProtocolFromBaseUrl(baseUrl) {
  const localHosts = new Set([
    "localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal", "gateway.docker.internal",
  ]);

  function isLocalHost(host) {
    if (!host) return false;
    if (localHosts.has(host)) return true;
    if (/\.(?:localhost|local|internal)$/.test(host)) return true;
    if (/^127\./.test(host)) return true;
    if (/^10\./.test(host)) return true;
    if (/^192\.168\./.test(host)) return true;
    const privateClassB = host.match(/^172\.(\d{1,2})\./);
    if (privateClassB && Number(privateClassB[1]) >= 16 && Number(privateClassB[1]) <= 31) return true;
    // 100.64.0.0/10（CGNAT）：本机代理与容器网络常落在这个私有段。
    if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)) return true;
    // IPv6 唯一本地地址（fc00::/7），容器与本机代理同样常见。
    if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
    return false;
  }

  function isClaudeEndpoint(host, path) {
    const hostParts = host.split(/[.\-_:]+/).filter(Boolean);
    if (hostParts.includes("anthropic") || hostParts.includes("claude")) return true;
    if (/(?:^|\/)anthropic(?:\/|$)/.test(path) || /(?:^|\/)claude(?:\/|$)/.test(path)) return true;
    // Messages 端点（/v1/messages、/messages）是 Claude 原生协议的确定信号。
    return /(?:^|\/)(?:v\d+\/)?messages?$/.test(path);
  }

  const raw = String(baseUrl == null ? "" : baseUrl).trim();
  if (!raw) return { protocol: "", reason: "未填写地址" };
  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : "http://" + raw);
  } catch {
    return { protocol: "", reason: "地址无法解析" };
  }
  if (!["http:", "https:"].includes(url.protocol)) return { protocol: "", reason: "地址不是 HTTP(S)" };

  const host = String(url.hostname || "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  const path = String(url.pathname || "").toLowerCase().replace(/\/+$/, "");

  // Claude 原生协议优先于本地判定：本机转发的 /v1/messages 仍然是 Claude 协议。
  if (isClaudeEndpoint(host, path)) {
    return { protocol: "claude", reason: "地址指向 Claude 原生 Messages 接口" };
  }
  if (isLocalHost(host)) {
    return { protocol: "local", reason: "地址指向本机或局域网服务" };
  }
  return { protocol: "compatible", reason: "公网地址按 OpenAI 兼容接口处理" };
}

function normalizeConnectionConfig(input = {}, fallbackProtocol = "local") {
  const protocols = ["local", "claude", "compatible"];
  if (Object.prototype.hasOwnProperty.call(input, "provider") && !Object.prototype.hasOwnProperty.call(input, "protocol")) {
    const error = new Error("连接配置缺少 protocol，请应用新布局并刷新工作台后重试。");
    error.code = "MISSING_PROTOCOL";
    throw error;
  }
  const explicitProtocol = protocols.includes(input.protocol) ? input.protocol : "";
  // 没有显式接口类型时按地址推断；地址也认不出才回落到调用方默认档。
  const detectedProtocol = explicitProtocol ? "" : inferProtocolFromBaseUrl(input.baseUrl).protocol;
  return {
    protocol: explicitProtocol || detectedProtocol || fallbackProtocol,
    provider: typeof input.provider === "string" ? input.provider.trim() : "",
  };
}

module.exports = {
  CONNECTION_PROTOCOLS,
  inferProtocolFromBaseUrl,
  normalizeConnectionConfig,
};
