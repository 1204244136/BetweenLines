const path = require("path");

const langs = ["jp", "cn", "tw"];
const notesStorageVersion = "v7";

function shortHash(value) {
  const text = String(value || "");
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function rowSignature(row) {
  if (row?.signature) return String(row.signature);
  return shortHash([
    row?.jp || "",
    row?.cn || "",
    row?.tw || "",
    row?.twCn || "",
    row?.relation || "",
  ].join("\u001f"));
}

function tableSignature(rows) {
  return shortHash((rows || []).map((row) => `${row.index}:${rowSignature(row)}`).join("\u001e"));
}

function normalizeFiles(files = {}, comparisonMode = "trilingual") {
  const roles = comparisonMode === "bilingual" ? ["jp", "cn"] : langs;
  return Object.fromEntries(roles
    .filter((lang) => files[lang])
    .map((lang) => [lang, path.resolve(files[lang])]));
}

function projectSignature(selection = {}) {
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const files = normalizeFiles(selection.files, comparisonMode);
  const inlineMarkup = { ...(selection.inlineMarkup || {}) };
  if (inlineMarkup.noteref === false) delete inlineMarkup.noteref;
  const identity = [
    // 三列位置固定参与身份，缺失的列以空串占位，保证项目键不随产物字段裁剪而漂移。
    ...langs.map((lang) => files[lang] || ""),
    selection.inputMode || "",
    JSON.stringify(selection.startMarkers || {}),
    JSON.stringify(inlineMarkup),
  ];
  if (comparisonMode === "bilingual") identity.splice(3, 0, "bilingual");
  return shortHash(identity.join("\u001f"));
}

function createProjectContext(selection = {}, rows = [], options = {}) {
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const files = normalizeFiles(selection.files, comparisonMode);
  const labels = Object.fromEntries(Object.entries(selection.labels || {})
    .filter(([lang]) => lang in files));
  const projectKey = projectSignature(selection);
  const rowsSignature = options.rowsSignature || tableSignature(rows);
  const storagePrefix = `translation-compare-notes-${notesStorageVersion}:${projectKey}:`;
  return {
    schemaVersion: 1,
    projectKey,
    snapshotKey: rowsSignature,
    rowsSignature,
    generatedAt: options.generatedAt || new Date().toISOString(),
    comparisonMode,
    inputMode: selection.inputMode || "",
    files,
    labels,
    notesStorage: {
      version: notesStorageVersion,
      prefix: storagePrefix,
      key: `${storagePrefix}${rowsSignature}`,
    },
  };
}

function sameProjectSnapshot(a = {}, b = {}) {
  return Boolean(
    a.projectKey &&
    a.rowsSignature &&
    a.projectKey === b.projectKey &&
    a.rowsSignature === b.rowsSignature
  );
}

module.exports = {
  createProjectContext,
  projectSignature,
  rowSignature,
  sameProjectSnapshot,
  shortHash,
  tableSignature,
};
