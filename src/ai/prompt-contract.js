/**
 * Small prompt-building primitives shared by the domain workbenches.
 * Domain modules own their schemas and decisions; this module only keeps
 * transport-facing prompt structure consistent.
 */

const JSON_ONLY_INSTRUCTION =
  "只返回一个 JSON 对象，不要返回 Markdown、代码块、分析过程或额外解释。";

function promptSections(...sections) {
  return sections
    .flat(Infinity)
    .map((section) => String(section || "").trim())
    .filter(Boolean)
    .join("\n");
}

function withJsonOnly(system, schema) {
  const schemaKeys = schema && typeof schema === "object" ? Object.keys(schema) : [];
  const schemaHint = schemaKeys.length
    ? `必须使用以下英文键名且不得省略：${schemaKeys.join(", ")}。`
    : "";
  return promptSections(system, JSON_ONLY_INSTRUCTION, schemaHint);
}

function clamp(value, min = 0, max = 1) {
  const num = Number(value);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, num));
}

function firstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return fallback;
  if (["true", "1", "yes", "y", "是", "需要", "相同"].includes(text)) return true;
  if (["false", "0", "no", "n", "否", "不需要", "不同"].includes(text)) return false;
  return fallback;
}

module.exports = {
  JSON_ONLY_INSTRUCTION,
  promptSections,
  withJsonOnly,
  clamp,
  firstString,
  parseBoolean,
};
