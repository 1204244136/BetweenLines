const { normalizeConnectionConfig } = require("../../ai/connection-config");
const { sanitizeModelMetadata } = require("./model-options");

// Pure helpers shared by the generated browser page and Node regression tests.
// 浏览器先注入共享 normalizeConnectionConfig，再注入本工厂。
function createPresetTools() {
  const PRESETS_STORAGE_KEY = "translation-compare-ai-presets-v2";

  // 并发边界必须与 Node 侧 ai/concurrency-limits.js 保持一致。本函数会被 toString()
  // 注入浏览器页面、不能引用模块作用域，因此自带一份同值字面量；两边的边界行为由
  // scripts/ai-smart-concurrency.test.js 的断言锁死，改一边必须同步改另一边。
  // 只有下界是硬约束：CONCURRENCY_MAX 是挡 Infinity / NaN 的算术护栏，不是业务上限。
  const CONCURRENCY_MIN = 1;
  const CONCURRENCY_MAX = Number.MAX_SAFE_INTEGER;
  const DEFAULT_CONCURRENCY = 3;

  function providerName(item) {
    return normalizeConnectionConfig(item || {}).provider;
  }

  // 旧预设不猜测厂商：地址仅用于未命名连接的身份与展示，永不展示凭证、查询串或片段。
  function providerEndpoint(item) {
    try {
      const url = new URL(item?.baseUrl || "");
      if (!["http:", "https:"].includes(url.protocol)) return "";
      return url.origin + url.pathname.replace(/\/+$/, "");
    } catch {
      return "";
    }
  }

  function providerKey(item) {
    const name = providerName(item);
    return name ? JSON.stringify(["name", name.toLowerCase()])
      : JSON.stringify(["endpoint", normalizeConnectionConfig(item || {}).protocol, providerEndpoint(item)]);
  }

  function providerLabel(item) {
    return providerName(item) || providerEndpoint(item)
      || ({ local: "本地服务", claude: "Claude 接口", compatible: "兼容接口" }[normalizeConnectionConfig(item || {}).protocol]);
  }

  function presetLabel(item) {
    const name = String(item?.name || "");
    const model = String(item?.model || "");
    return providerLabel(item) + " / " + name + (model && model !== name ? " · " + model : "");
  }

  function groupPresets(presets) {
    const groups = new Map();
    for (const preset of presets || []) {
      const key = providerKey(preset);
      if (!groups.has(key)) groups.set(key, { key, label: providerLabel(preset), presets: [] });
      groups.get(key).presets.push(preset);
    }
    return [...groups.values()].sort((a, b) => a.label.localeCompare(b.label, "zh-CN"));
  }

  function findPresetByName(presets, item) {
    const key = providerKey(item);
    const name = String(item?.name || "").trim();
    return presets.find((preset) => preset.name === name && providerKey(preset) === key) || null;
  }

  // 越界只补下界，不回落默认值：旧实现把 20 直接换成 3，用户在预设里选了 20 却静默跑成 3。
  // 非整数同样按四舍五入取整（与服务端 clampCap 同口径），只有 NaN / 非有限值才用 fallback。
  function clampPresetConcurrency(value, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    return Math.max(CONCURRENCY_MIN, Math.min(CONCURRENCY_MAX, Math.round(number)));
  }

  function sanitizePreset(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const name = String(item.name || "").trim();
    if (!name) return null;

    const id = String(item.id || "").trim() || ("preset_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
    const { protocol, provider } = normalizeConnectionConfig(item);
    const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
    const apiKey = typeof item.apiKey === "string" ? item.apiKey : "";
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const modelOptions = Array.isArray(item.modelOptions)
      ? item.modelOptions.map((opt) => (typeof opt === "string" ? opt.trim() : String(opt || "").trim())).filter(Boolean)
      : [];
    const reasoningEffort = typeof item.reasoningEffort === "string" ? item.reasoningEffort : "";
    const gptReasoningEffort = typeof item.gptReasoningEffort === "string" ? item.gptReasoningEffort : "";
    const nonGptIntensity = typeof item.nonGptIntensity === "string" ? item.nonGptIntensity : "";

    // 预设里只保存一个「并发上限」（字段名沿用 concurrency）。旧预设还带着 smartConcurrency + concurrencyMax：
    // 开启智能并发时有效上限是 max(concurrency, concurrencyMax)，这里折算后丢弃这两个字段，旧预设无需迁移即可沿用原天花板。
    let concurrency = clampPresetConcurrency(Number(item.concurrency), DEFAULT_CONCURRENCY);
    if (item.smartConcurrency === true && item.concurrencyMax != null) {
      concurrency = Math.max(concurrency, clampPresetConcurrency(Number(item.concurrencyMax), concurrency));
    }

    const now = Date.now();
    const createdAt = Number.isSafeInteger(Number(item.createdAt)) && Number(item.createdAt) > 0
      ? Number(item.createdAt)
      : now;
    const updatedAt = Number.isSafeInteger(Number(item.updatedAt)) && Number(item.updatedAt) > 0
      ? Number(item.updatedAt)
      : createdAt;

    return {
      id,
      name,
      protocol,
      provider,
      baseUrl,
      apiKey,
      model,
      modelOptions,
      modelMetadata: sanitizeModelMetadata(item.modelMetadata),
      reasoningEffort,
      gptReasoningEffort,
      nonGptIntensity,
      concurrency,
      createdAt,
      updatedAt,
    };
  }

  function parsePresets(raw) {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      return parsed.map(sanitizePreset).filter(Boolean);
    } catch {
      return [];
    }
  }

  function listPresets(storage) {
    if (!storage || typeof storage.getItem !== "function") return [];
    try {
      const raw = storage.getItem(PRESETS_STORAGE_KEY);
      return parsePresets(raw);
    } catch {
      return [];
    }
  }

  function getPreset(storage, id) {
    if (!id) return null;
    const list = listPresets(storage);
    return list.find((item) => item.id === String(id)) || null;
  }

  function savePreset(storage, presetData) {
    if (!storage || typeof storage.setItem !== "function") return null;
    const sanitized = sanitizePreset(presetData);
    if (!sanitized) return null;

    const list = listPresets(storage);
    let existingIndex = -1;
    if (presetData && presetData.id) {
      existingIndex = list.findIndex((item) => item.id === String(presetData.id));
    }
    const sameName = findPresetByName(list, sanitized);
    // 改名/改提供商不能把两个既有 ID 合并，阶段引用必须保持稳定。
    if (existingIndex >= 0 && sameName && sameName.id !== list[existingIndex].id) return null;
    if (existingIndex < 0 && sameName) {
      existingIndex = list.findIndex((item) => item.id === sameName.id);
    }

    const now = Date.now();
    if (existingIndex >= 0) {
      sanitized.id = list[existingIndex].id;
      sanitized.createdAt = list[existingIndex].createdAt || sanitized.createdAt;
      sanitized.updatedAt = now;
      list[existingIndex] = sanitized;
    } else {
      sanitized.createdAt = now;
      sanitized.updatedAt = now;
      list.push(sanitized);
    }

    try {
      storage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(list));
      return sanitized;
    } catch {
      return null;
    }
  }

  function deletePreset(storage, id) {
    if (!storage || typeof storage.setItem !== "function" || !id) return false;
    const list = listPresets(storage);
    const targetId = String(id);
    const filtered = list.filter((item) => item.id !== targetId);
    if (filtered.length === list.length) return false;
    try {
      storage.setItem(PRESETS_STORAGE_KEY, JSON.stringify(filtered));
      return true;
    } catch {
      return false;
    }
  }

  return {
    storageKey: PRESETS_STORAGE_KEY,
    providerName,
    providerKey,
    providerLabel,
    presetLabel,
    groupPresets,
    findPresetByName,
    sanitizePreset,
    parsePresets,
    listPresets,
    getPreset,
    savePreset,
    deletePreset,
  };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { createPresetTools };
}
