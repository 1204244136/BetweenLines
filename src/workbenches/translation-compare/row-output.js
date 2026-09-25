const { rowSignature } = require("../../core/project-context");

function rowClass(score) {
  if (score >= 0.35) return "ok";
  if (score >= 0.18) return "watch";
  return "review";
}

// 每种模式只保留自己那一组字段：双语模式没有第三列，产物里就不出现 tw/twCn/twChars/refinedScore。
const rowFieldsByMode = {
  bilingual: ["index", "chapter", "relation", "jp", "jpAlignScore", "cn", "score", "cnChars", "jpChars"],
  trilingual: [
    "index", "chapter", "relation", "jp", "jpAlignScore", "cn", "tw", "twCn",
    "score", "refinedScore", "cnChars", "twChars", "jpChars",
  ],
};

function rowFieldsFor(comparisonMode) {
  return rowFieldsByMode[comparisonMode === "bilingual" ? "bilingual" : "trilingual"];
}

function pickRowFields(row, fields) {
  const picked = {};
  for (const field of fields) {
    if (row[field] !== undefined) picked[field] = row[field];
  }
  return picked;
}

function exportRows(rows, comparisonMode = "trilingual") {
  const fields = rowFieldsFor(comparisonMode);
  return rows.map((row) => ({ ...pickRowFields(row, fields), signature: rowSignature(row) }));
}

function workbenchClientRows(rows, comparisonMode = "trilingual") {
  const fields = rowFieldsFor(comparisonMode);
  return rows.map((row) => {
    const cls = rowClass(row.score);
    return {
      ...pickRowFields(row, fields),
      signature: rowSignature(row),
      cls,
      scoreText: `${((row.score || 0) * 100).toFixed(0)}%`,
      jpAlignScoreText: row.jpAlignScore == null ? "" : `${(row.jpAlignScore * 100).toFixed(0)}%`,
    };
  });
}

function toCsv(rows, comparisonMode = "trilingual") {
  const cols = comparisonMode === "bilingual"
    ? ["index", "chapter", "relation", "score", "jpAlignScore", "jp", "cn"]
    : ["index", "chapter", "relation", "score", "jpAlignScore", "jp", "cn", "tw", "twCn"];
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [
    cols.join(","),
    ...rows.map((row) => cols.map((col) => escapeCsv(row[col])).join(",")),
  ].join("\n");
}

module.exports = { rowFieldsFor, exportRows, workbenchClientRows, toCsv };
