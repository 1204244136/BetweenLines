/**
 * 翻译比较与说话人推断工作台的共享客户端逻辑 (public/workbench-shared.js)
 *
 * 由 build-compare 与 build-workbench 在构建时读取并注入到 HTML 页面脚本顶部。
 * 提供跨工作台统一的 API 请求鉴权、HTML 字符转义、模型能力启发式检测、推理档位映射与剪贴板操作。
 */

async function apiFetch(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const isApiRequest = String(url).startsWith("/api/");
  if (!isApiRequest || ["GET", "HEAD", "OPTIONS"].includes(method)) {
    return fetch(url, options);
  }
  const meta = document.querySelector('meta[name="transcomparator-session-token"]');
  const token = meta?.getAttribute("content") || "";
  const headers = { ...(options.headers || {}) };
  if (token) headers["X-TransComparator-Token"] = token;
  if (options.body != null && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
    headers["Content-Type"] = "application/json";
  }
  return fetch(url, { ...options, headers });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function copyText(value) {
  const text = String(value || "");
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {}
  }
  const helper = document.createElement("textarea");
  helper.value = text;
  helper.setAttribute("readonly", "");
  helper.style.position = "fixed";
  helper.style.left = "-9999px";
  helper.style.top = "0";
  document.body.appendChild(helper);
  try {
    helper.select();
    if (!document.execCommand("copy")) throw new Error("复制失败，请手动选择文本复制。");
  } finally {
    helper.remove();
  }
}

const thinkingLevelLabels = {
  "": "模型默认",
  off: "关闭思考",
  none: "无",
  minimal: "最小",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最大",
};

const nonGptIntensityOptions = [
  ["", "模型默认"],
  ["low", "低"],
  ["medium", "中"],
  ["high", "高"],
  ["xhigh", "极高"],
  ["ultra", "超高"],
  ["max", "最大"],
];
const nonReasoningIntensityOptions = nonGptIntensityOptions;

const aiModelMetadataMap = new Map();

function getClientModelCapabilities(modelName) {
  const id = String(modelName || "").trim();
  if (aiModelMetadataMap.has(id)) {
    return aiModelMetadataMap.get(id);
  }
  const lower = id.toLowerCase();
  if (/(?:^|\/)(?:o1|o3|o4)(?:-|$)/i.test(lower)) {
    return { reasoning: true, reasoningEfforts: ["low", "medium", "high"], supportsTemperature: false, source: "heuristic" };
  }
  if (/(?:^|\/)(?:deepseek-(?:r1|reasoner|v4)|r1\b)/i.test(lower)) {
    return { reasoning: true, reasoningEfforts: ["high", "max"], supportsTemperature: false, source: "heuristic" };
  }
  if (/(?:^|\/)(?:qwq|qvq)\b/i.test(lower)) {
    return { reasoning: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], supportsTemperature: false, source: "heuristic" };
  }
  if (/(?:^|\/)kimi-k3\b/i.test(lower)) {
    return { reasoning: true, reasoningEfforts: ["max"], supportsTemperature: false, source: "heuristic" };
  }
  if (/(?:^|\/)claude-(?:3-7|sonnet-4|sonnet-5|opus-4)/i.test(lower)) {
    return { reasoning: true, reasoningEfforts: ["low", "medium", "high", "max"], supportsTemperature: true, source: "heuristic" };
  }
  if (/(?:^|\/)gpt(?:-|$)/i.test(lower)) {
    return { reasoning: true, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], supportsTemperature: true, source: "heuristic" };
  }
  if (/(?:^|\/|-|_|\b)(?:thinking|reasoner|reasoning)\b/i.test(lower)) {
    return { reasoning: true, reasoningEfforts: ["low", "medium", "high"], supportsTemperature: false, source: "heuristic" };
  }
  return { reasoning: false, reasoningEfforts: [], supportsTemperature: true, source: "default" };
}

function buildReasoningOptions(caps) {
  const reasoningEfforts = Array.isArray(caps?.reasoningEfforts) && caps.reasoningEfforts.length > 0
    ? caps.reasoningEfforts
    : ["low", "medium", "high"];
  return [
    ["", "模型默认"],
    ...reasoningEfforts.map((effort) => [effort, thinkingLevelLabels[effort] || effort]),
  ];
}

function calculateTotalPages(totalCount, pageSizeValue, defaultSize = 100) {
  return Math.max(1, Math.ceil(Number(totalCount || 0) / Number(pageSizeValue || defaultSize)));
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    aiModelMetadataMap,
    apiFetch,
    buildReasoningOptions,
    calculateTotalPages,
    copyText,
    escapeHtml,
    getClientModelCapabilities,
    nonGptIntensityOptions,
    nonReasoningIntensityOptions,
    thinkingLevelLabels,
  };
}
