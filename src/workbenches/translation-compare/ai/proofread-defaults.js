// 页面与运行服务共享的配置；导入时不创建任务或加载服务状态。
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

module.exports = { providerDefaults };
