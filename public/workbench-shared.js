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

/**
 * 浮动提示（Toast）中心：翻译比较与说话人归属两个工作台共用这一份实现，避免各写一套
 * 各自漂移的行为。共享的契约有：
 *   - 同一条消息连续出现只保留一条，并顺延它的存活时间；
 *   - 最多同时可见 maxVisible 条，超出淘汰最旧的一条；
 *   - 关闭先播淡出动画，动画结束（或超时兜底）才移除节点；
 *   - durationMs 是基准时长，实际停留 = durationMs × durationScale；error 语气不缩放（见 toastTimer），
 *     因为出错提示通常最长，折半会让用户读不完就被关掉（durationMs <= 0 表示不自动消失）。
 * 页面需要提供唯一容器 <div id="toastStack" class="toast-stack">…</div>，样式见 public/toast.css。
 */
function createToastCenter({ stackId = "toastStack", maxVisible = 4, durationScale = 0.5, fadeMs = 180, defaultDurationMs = 6000 } = {}) {
  const toasts = [];
  let seq = 0;

  // 出错提示是唯一的例外：它往往最长（含定位失败原因、未写入行数、接口报错原文），
  // 再按 durationScale 折半会让用户读不完就被关掉，所以按调用方给的时长原样停留。
  function toastTimer(toast, durationMs) {
    const scale = toast.tone === "error" ? 1 : durationScale;
    const visibleMs = durationMs > 0 ? Math.max(1, Math.round(durationMs * scale)) : 0;
    return visibleMs > 0 ? window.setTimeout(() => dismissToast(toast.id), visibleMs) : 0;
  }

  function dismissToast(id) {
    const index = toasts.findIndex((toast) => toast.id === String(id ?? ""));
    if (index < 0) return false;
    const [toast] = toasts.splice(index, 1);
    if (toast.timer) window.clearTimeout(toast.timer);
    const node = toast.node;
    if (!node) return true;
    if (typeof node.classList?.add === "function") node.classList.add("toast--leaving");
    let removed = false;
    const remove = () => {
      if (removed) return;
      removed = true;
      if (typeof node.remove === "function") node.remove();
    };
    if (typeof node.addEventListener === "function") node.addEventListener("animationend", remove, { once: true });
    window.setTimeout(remove, fadeMs + 80);
    return true;
  }

  // tone 表示结果的语气：info 中性、success 成功、watch 需要留意但没失败、error 失败。
  function showToast(message, { tone = "info", durationMs = defaultDurationMs } = {}) {
    const text = String(message ?? "").trim();
    if (!text) return "";
    const stack = document.getElementById(stackId);
    if (!stack) return "";
    const last = toasts[toasts.length - 1];
    if (last && last.message === text && last.tone === tone) {
      if (last.timer) window.clearTimeout(last.timer);
      last.timer = toastTimer(last, durationMs);
      return last.id;
    }
    const node = document.createElement("div");
    node.className = "toast toast--" + tone;
    node.setAttribute("role", tone === "error" ? "alert" : "status");
    node.dataset.toastId = String(++seq);
    const line = document.createElement("span");
    line.className = "toast-text";
    line.textContent = text;
    const close = document.createElement("button");
    close.type = "button";
    close.className = "toast-dismiss";
    close.textContent = "×";
    close.setAttribute("aria-label", "关闭提示");
    close.addEventListener("click", () => dismissToast(node.dataset.toastId));
    node.append(line, close);
    stack.append(node);
    const toast = { id: node.dataset.toastId, message: text, tone, node, timer: 0 };
    toasts.push(toast);
    toast.timer = toastTimer(toast, durationMs);
    while (toasts.length > maxVisible) dismissToast(toasts[0].id);
    return toast.id;
  }

  return { showToast, dismissToast, toasts };
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
    createToastCenter,
    escapeHtml,
    getClientModelCapabilities,
    nonGptIntensityOptions,
    nonReasoningIntensityOptions,
    thinkingLevelLabels,
  };
}
