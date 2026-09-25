const crypto = require("crypto");

// 安全策略只依赖监听配置，不读取业务状态，也不发送响应。
function createRequestSecurity({ host, defaultPort }) {
  const apiSessionToken = crypto.randomBytes(32).toString("hex");
  const csrfHeaderName = "x-transcomparator-token";
  const sessionMetaPattern = /(<meta\s+name="transcomparator-session-token"\s+content=")[^"]*("\s*>)/i;

  function timingSafeTokenEqual(actual, expected) {
    const left = Buffer.from(String(actual || ""), "utf8");
    const right = Buffer.from(String(expected || ""), "utf8");
    return left.length === right.length && crypto.timingSafeEqual(left, right);
  }

  function requestPort(req) {
    return Number(req.socket?.localPort) || defaultPort;
  }

  function isAllowedRequestHost(req) {
    const hostHeader = String(req.headers.host || "").toLowerCase();
    const port = requestPort(req);
    return hostHeader === `${host}:${port}`
      || hostHeader === `localhost:${port}`;
  }

  function isAllowedRequestOrigin(req) {
    const origin = String(req.headers.origin || "").toLowerCase();
    if (!origin) return true;
    const port = requestPort(req);
    return origin === `http://${host}:${port}`
      || origin === `http://localhost:${port}`;
  }

  function isAllowedFetchSite(req) {
    const site = String(req.headers["sec-fetch-site"] || "").toLowerCase();
    return !site || site === "same-origin" || site === "none";
  }

  function isAllowedRequestSource(req) {
    return isAllowedRequestHost(req)
      && isAllowedRequestOrigin(req)
      && isAllowedFetchSite(req);
  }

  function requiresApiSessionToken(req) {
    return !["GET", "HEAD", "OPTIONS"].includes(String(req.method || "").toUpperCase());
  }

  function hasValidApiSessionToken(req) {
    return timingSafeTokenEqual(req.headers[csrfHeaderName], apiSessionToken);
  }

  function injectSessionToken(html) {
    return html.replace(sessionMetaPattern, '$1' + apiSessionToken + '$2');
  }

  return { requestPort, isAllowedRequestSource, requiresApiSessionToken, hasValidApiSessionToken, injectSessionToken };
}

module.exports = { createRequestSecurity };
