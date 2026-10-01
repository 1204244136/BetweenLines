// 可序列化到浏览器的纯函数；不得捕获 Node 运行时依赖。

function resolveModelOptions(models, selected = "") {
  const values = [];
  const seen = new Set();
  for (const model of models || []) {
    const value = String(typeof model === "string" ? model : model?.id || "").trim();
    if (!value || value === "custom" || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }

  const current = String(selected || "").trim();
  return {
    models: values,
    options: [...values, "custom"],
    selected: seen.has(current) ? current : values[0] || "custom",
  };
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// 仅持久化模型能力白名单，不保存接口原始响应里的额外字段。
function sanitizeModelMetadata(models) {
  if (!Array.isArray(models)) return [];
  return models.filter((item) => item && typeof item.id === "string" && item.id.trim()
    && typeof item.reasoning === "boolean").map((item) => ({
    id: item.id.trim(),
    reasoning: item.reasoning,
    reasoningEfforts: item.reasoning && Array.isArray(item.reasoningEfforts)
      ? [...new Set(item.reasoningEfforts.map((value) => String(value).trim().toLowerCase())
        .filter((value) => ["off", "none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value)))] : [],
    supportsTemperature: typeof item.supportsTemperature === "boolean" ? item.supportsTemperature : !item.reasoning,
    source: ["manifest", "provider", "models-dev", "heuristic", "default"].includes(item.source) ? item.source : "provider",
  }));
}

function restorableModelOptions(saved) {
  if (!saved || typeof saved !== "object") return [];
  const baseUrl = normalizeApiBaseUrl(saved.baseUrl);
  const optionsBaseUrl = normalizeApiBaseUrl(saved.modelOptionsBaseUrl);
  if (!baseUrl || !optionsBaseUrl || baseUrl !== optionsBaseUrl) return [];
  const metadata = new Map(sanitizeModelMetadata(saved.modelMetadata).map((item) => [item.id, item]));
  return Array.isArray(saved.modelOptions)
    ? saved.modelOptions.map((item) => String(item || "").trim()).filter(Boolean).map((id) => metadata.get(id) || id)
    : [];
}

module.exports = { resolveModelOptions, normalizeApiBaseUrl, restorableModelOptions, sanitizeModelMetadata };
