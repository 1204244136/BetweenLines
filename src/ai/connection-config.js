// 纯函数，同时注入工作台页面。protocol 决定传输；provider 只表示供应商。
function normalizeConnectionConfig(input = {}, fallbackProtocol = "local") {
  const protocols = ["local", "claude", "compatible"];
  if (Object.prototype.hasOwnProperty.call(input, "provider") && !Object.prototype.hasOwnProperty.call(input, "protocol")) {
    const error = new Error("连接配置缺少 protocol，请应用新布局并刷新工作台后重试。");
    error.code = "MISSING_PROTOCOL";
    throw error;
  }
  return {
    protocol: protocols.includes(input.protocol) ? input.protocol : fallbackProtocol,
    provider: typeof input.provider === "string" ? input.provider.trim() : "",
  };
}

module.exports = { normalizeConnectionConfig };
