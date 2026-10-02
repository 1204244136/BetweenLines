/**
 * 翻译比较与说话人推断工作台的共享客户端逻辑 (public/workbench-shared.js)
 *
 * 由 build-compare 与 build-workbench 在构建时读取并注入到 HTML 页面脚本顶部。
 * 提供统一的 API 请求鉴权、字符转义、确认弹窗、Toast、模型能力适配与剪贴板操作。
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

// 两个工作台共用确认交互；文案只写 textContent，关闭事件落定后才展示下一条确认。
function createConfirmDialog({ showToast: reportToast } = {}) {
  let queue = Promise.resolve();
  let fallbackToastCenter;

  function dialogElements() {
    let dialog = document.getElementById("genericConfirmDialog");
    if (!dialog) {
      dialog = document.createElement("dialog");
      dialog.id = "genericConfirmDialog";
      dialog.className = "workbench-confirm-dialog generic-confirm-dialog";
      dialog.setAttribute("aria-labelledby", "genericConfirmTitle");
      dialog.setAttribute("aria-describedby", "genericConfirmMessage");
      const title = document.createElement("h2");
      title.id = "genericConfirmTitle";
      const message = document.createElement("p");
      message.id = "genericConfirmMessage";
      message.className = "generic-confirm-message";
      const actions = document.createElement("div");
      actions.className = "workbench-confirm-actions";
      const cancel = document.createElement("button");
      cancel.id = "genericConfirmCancel";
      cancel.type = "button";
      cancel.className = "workbench-confirm-button";
      cancel.textContent = "取消";
      cancel.setAttribute("autofocus", "");
      const ok = document.createElement("button");
      ok.id = "genericConfirmOk";
      ok.type = "button";
      actions.append(cancel, ok);
      dialog.append(title, message, actions);
      document.body.append(dialog);
      return { dialog, title, message, cancel, ok };
    }
    return {
      dialog,
      title: document.getElementById("genericConfirmTitle"),
      message: document.getElementById("genericConfirmMessage"),
      cancel: document.getElementById("genericConfirmCancel"),
      ok: document.getElementById("genericConfirmOk"),
    };
  }

  function unavailable() {
    const toast = reportToast || (fallbackToastCenter ||= createToastCenter()).showToast;
    toast("无法打开页内确认框，本次操作已取消。请使用支持 dialog 的浏览器并应用最新工作台页面。", { tone: "error" });
    return false;
  }

  function present(message, { title = "请确认", confirmText = "确认", danger = true } = {}) {
    const ids = dialogElements();
    const { dialog, ok, cancel } = ids;
    if (!ids.title || !ids.message || !ok || !cancel || typeof dialog.showModal !== "function" || typeof dialog.close !== "function" || dialog.open) return unavailable();
    dialog.classList.add("workbench-confirm-dialog");
    dialog.setAttribute("aria-describedby", "genericConfirmMessage");
    ids.title.textContent = String(title);
    ids.message.textContent = String(message ?? "");
    ok.textContent = String(confirmText);
    ok.className = "workbench-confirm-button " + (danger ? "is-danger" : "is-primary");
    cancel.className = "workbench-confirm-button";
    return new Promise((resolve) => {
      let settled = false;
      let closing = false;
      let answer = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        ok.removeEventListener("click", onOk);
        cancel.removeEventListener("click", onCancel);
        dialog.removeEventListener("cancel", onCancel);
        dialog.removeEventListener("close", onClose);
        resolve(value);
      }
      function close(value) {
        if (closing || settled) return;
        closing = true;
        answer = value;
        // 等原生 close 事件到达才 resolve，避免上一条的延迟 close 误取消下一条。
        if (dialog.open) dialog.close();
        else finish(value);
      }
      const onOk = () => close(true);
      const onCancel = (event) => { event?.preventDefault?.(); close(false); };
      const onClose = () => finish(answer);
      ok.addEventListener("click", onOk);
      cancel.addEventListener("click", onCancel);
      dialog.addEventListener("cancel", onCancel);
      dialog.addEventListener("close", onClose);
      try {
        dialog.showModal();
        if (dialog.open) cancel.focus();
      } catch {
        finish(unavailable());
      }
    });
  }

  function askConfirm(message, options) {
    const pending = queue.then(() => present(message, options)).catch(() => unavailable());
    queue = pending.then(() => undefined);
    return pending;
  }
  return { askConfirm };
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
  const resolve = typeof resolveClientModelCapabilities === "function"
    ? resolveClientModelCapabilities
    : require("../src/workbenches/translation-compare/ai/model-capabilities").detectModelCapabilities;
  return resolve(id, "", {}, aiModelMetadataMap.get(id));
}

function buildReasoningOptions(caps) {
  const reasoningEfforts = Array.isArray(caps?.reasoningEfforts) && caps.reasoningEfforts.length > 0
    ? caps.reasoningEfforts
    : [];
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
    createConfirmDialog,
    createToastCenter,
    escapeHtml,
    getClientModelCapabilities,
    nonGptIntensityOptions,
    nonReasoningIntensityOptions,
    thinkingLevelLabels,
  };
}
