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

function restorableModelOptions(saved) {
  if (!saved || typeof saved !== "object") return [];
  const baseUrl = normalizeApiBaseUrl(saved.baseUrl);
  const optionsBaseUrl = normalizeApiBaseUrl(saved.modelOptionsBaseUrl);
  if (!baseUrl || !optionsBaseUrl || baseUrl !== optionsBaseUrl) return [];
  return Array.isArray(saved.modelOptions)
    ? saved.modelOptions.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

module.exports = { resolveModelOptions, normalizeApiBaseUrl, restorableModelOptions };
