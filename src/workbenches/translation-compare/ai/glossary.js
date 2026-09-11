const fs = require("fs");
const path = require("path");
const { readRecords } = require("../../../core/spreadsheet");

function cellText(value) { return String(value ?? "").replace(/^\uFEFF/, "").trim(); }
function normalizeEntry(row) {
  if (!row || typeof row !== "object") return null;
  const original = cellText(row.original ?? row.base_ori ?? row.source ?? row.jp ?? row["原名"]);
  const translation = cellText(row.translation ?? row.base_trans ?? row.target ?? row.cn ?? row["译名"]);
  if (!original || !translation) return null;
  return { original, translation, rubyOriginal: cellText(row.rubyOriginal ?? row.ruby_ori), rubyTranslation: cellText(row.rubyTranslation ?? row.ruby_trans), type: cellText(row.type) };
}
// 表格一律走共享读取器：xlsx 按单元格引用对齐稀疏行，csv/tsv 处理引号包裹的分隔符，
// 不依赖本机是否有 python。
function loadGlossary(file) {
  if (!file) return [];
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return (Array.isArray(data) ? data : (data.entries || [])).map(normalizeEntry).filter(Boolean);
  }
  if ([".csv", ".tsv", ".txt", ".xlsx"].includes(ext)) {
    try {
      return readRecords(file).records.map(normalizeEntry).filter(Boolean);
    } catch (error) {
      console.warn(`[ai] 术语表读取失败，已忽略：${file}：${error.message}`);
      return [];
    }
  }
  return [];
}
function glossaryPrompt(entries) { if (!entries.length) return ""; return "术语表（仅用于一致性参考；原文优先，不能机械替换）：\n" + entries.map(e => `- ${e.original} → ${e.translation}${e.rubyTranslation ? `（注音：${e.rubyTranslation}）` : ""}`).join("\n"); }
module.exports = { loadGlossary, glossaryPrompt, normalizeEntry };
