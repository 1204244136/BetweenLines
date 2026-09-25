// Pure helpers shared by the generated browser page and Node regression tests.
function createPresetTools() {
  const PRESETS_STORAGE_KEY = "translation-compare-ai-presets-v1";
  const VALID_PROVIDERS = ["local", "claude", "compatible"];

  // 并发边界必须与 Node 侧 ai/concurrency-limits.js 保持一致。本函数会被 toString()
  // 注入浏览器页面、不能引用模块作用域，因此自带一份同值字面量；两边的边界行为由
  // scripts/ai-smart-concurrency.test.js 的断言锁死，改一边必须同步改另一边。
  const CONCURRENCY_MIN = 1;
  const CONCURRENCY_MAX = 32;
  const DEFAULT_CONCURRENCY = 3;
  const DEFAULT_CONCURRENCY_MAX = 10;

  // 越界一律截断到边界，而不是回落到默认值：旧实现把 20 直接换成 3，
  // 用户在预设里选了 20 却静默跑成 3，且没有任何提示。
  function clampPresetConcurrency(value, fallback) {
    if (!Number.isSafeInteger(value)) return fallback;
    return Math.max(CONCURRENCY_MIN, Math.min(CONCURRENCY_MAX, value));
  }

  function sanitizePreset(item) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const name = String(item.name || "").trim();
    if (!name) return null;

    const id = String(item.id || "").trim() || ("preset_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8));
    const provider = VALID_PROVIDERS.includes(item.provider) ? item.provider : "local";
    const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
    const apiKey = typeof item.apiKey === "string" ? item.apiKey : "";
    const model = typeof item.model === "string" ? item.model.trim() : "";
    const modelOptions = Array.isArray(item.modelOptions)
      ? item.modelOptions.map((opt) => (typeof opt === "string" ? opt.trim() : String(opt || "").trim())).filter(Boolean)
      : [];
    const reasoningEffort = typeof item.reasoningEffort === "string" ? item.reasoningEffort : "";
    const gptReasoningEffort = typeof item.gptReasoningEffort === "string" ? item.gptReasoningEffort : "";
    const nonGptIntensity = typeof item.nonGptIntensity === "string" ? item.nonGptIntensity : "";

    const rawConcurrency = Number(item.concurrency);
    const concurrency = clampPresetConcurrency(rawConcurrency, DEFAULT_CONCURRENCY);

    const smartConcurrency = Boolean(item.smartConcurrency);
    const rawConcurrencyMax = Number(item.concurrencyMax);
    const concurrencyMax = clampPresetConcurrency(rawConcurrencyMax, DEFAULT_CONCURRENCY_MAX);

    const breakerThreshold = typeof item.breakerThreshold === "string" && item.breakerThreshold.trim()
      ? item.breakerThreshold.trim()
      : "50%";
    const breakerDisabled = Boolean(item.breakerDisabled);

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
      provider,
      baseUrl,
      apiKey,
      model,
      modelOptions,
      reasoningEffort,
      gptReasoningEffort,
      nonGptIntensity,
      concurrency,
      smartConcurrency,
      concurrencyMax,
      breakerThreshold,
      breakerDisabled,
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
    if (existingIndex < 0 && sanitized.name) {
      existingIndex = list.findIndex((item) => item.name === sanitized.name);
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
