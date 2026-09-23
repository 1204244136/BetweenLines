/**
 * 与领域无关的小型文本/集合工具（src/core/text-helpers.js）。
 *
 * 这里只放「换个模块也会写成一模一样」的函数；凡是带业务口径的归一化
 * （build-compare 的 normalizeZh、ai-prefilter 的 similarityText、text-comparison 的 compactText）
 * 一律留在各自模块——它们决定 rowsSignature 与预筛阈值，不能因为"看起来像"就合并。
 * bigramSet / jaccard 只接收调用方已经归一化好的字符串。
 */

function asArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

/** 去重并丢掉假值。 */
function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

/** 按候选表头顺序取第一个非空单元格（去首尾空白；只有空白的单元格视为空）。 */
function firstColumn(record, keys) {
  for (const key of keys) {
    const value = record?.[key];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return "";
}

/** HTML 文本/属性转义（属性值统一按双引号写，但 `'` 一并转义以防漂移）。 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 内嵌进 `<script>` 的 JSON：转义 `<` 防止提前闭合标签。 */
function safeJson(value) {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/** 剥掉内联标记；`<rt>`/`<rp>` 的注音内容随标记一起去掉，只留基文。 */
function stripInlineMarkup(text) {
  return String(text || "")
    .replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, "")
    .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<[^>]*>/g, "");
}

/** NFKC 归一并去掉零宽/双向控制字符；是否 lower/trim 由调用方决定。 */
function stripInvisible(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "");
}

/** 相邻字符二元组集合；`normalized` 必须是调用方按自己口径归一化后的字符串。 */
function bigramSet(normalized) {
  const chars = Array.from(String(normalized || ""));
  if (chars.length < 2) return new Set(chars);
  const grams = new Set();
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.add(chars[index] + chars[index + 1]);
  }
  return grams;
}

/** Jaccard 相似度；两个空集合视为完全相同，只有一侧为空视为完全不同。 */
function jaccard(left = new Set(), right = new Set()) {
  if (!left.size && !right.size) return 1;
  if (!left.size || !right.size) return 0;
  let intersection = 0;
  for (const value of left) if (right.has(value)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

module.exports = {
  asArray,
  bigramSet,
  countMatches,
  escapeHtml,
  firstColumn,
  jaccard,
  safeJson,
  stripInlineMarkup,
  stripInvisible,
  unique,
};
