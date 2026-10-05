// AI 校对结果的落盘层：把服务端内存里的结果快照写到 out/runtime/ai-results/，
// 让「刷新页面 / 重启控制台服务」之后还能把结果重新交付给工作台。
//
// 为什么需要它：浏览器 localStorage 只有约 10 MB，且被多个项目共享；
// 一旦写满，页面上的备注就只活在内存里，刷新即丢。AI 结果是可重新交付的服务端产物，
// 不该让浏览器存储成为它唯一的落脚点。
const fs = require("fs");
const path = require("path");
const { storageLayout } = require("../../../core/storage-layout");
const { writeJsonAtomic } = require("../../../core/atomic-fs");

const SCHEMA_VERSION = 1;

function aiResultsDir(dataDir) {
  return path.join(storageLayout(dataDir).runtimeDir, "ai-results");
}

// 项目键与行集签名都是短哈希，但仍然按文件名安全字符收口，避免路径穿越。
function safeSegment(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 80);
}

function resultsFile(projectKey, rowsSignature, dataDir) {
  return path.join(aiResultsDir(dataDir), `${safeSegment(projectKey)}-${safeSegment(rowsSignature)}.json`);
}

function readResults(projectKey, rowsSignature, options = {}) {
  if (!projectKey || !rowsSignature) return null;
  const file = resultsFile(projectKey, rowsSignature, options.dataDir);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  // 身份对不上就当作没有：宁可让页面显示「无结果」，也不把别的项目的结论交付出去。
  if (String(parsed.projectKey || "") !== String(projectKey)) return null;
  if (String(parsed.rowsSignature || "") !== String(rowsSignature)) return null;
  const results = Array.isArray(parsed.results) ? parsed.results.filter((item) => item && item.index != null) : [];
  return {
    schemaVersion: Number(parsed.schemaVersion) || 0,
    projectKey: String(parsed.projectKey),
    rowsSignature: String(parsed.rowsSignature),
    runId: String(parsed.runId || ""),
    kind: String(parsed.kind || ""),
    total: Number(parsed.total) || 0,
    finishedAt: String(parsed.finishedAt || ""),
    updatedAt: String(parsed.updatedAt || ""),
    results,
  };
}

function writeResults(projectKey, rowsSignature, payload, options = {}) {
  if (!projectKey || !rowsSignature) return null;
  const file = resultsFile(projectKey, rowsSignature, options.dataDir);
  const results = (Array.isArray(payload?.results) ? payload.results : [])
    .filter((item) => item && item.index != null)
    .sort((a, b) => Number(a.index) - Number(b.index));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonAtomic(file, {
    schemaVersion: SCHEMA_VERSION,
    projectKey: String(projectKey),
    rowsSignature: String(rowsSignature),
    runId: String(payload?.runId || ""),
    kind: String(payload?.kind || ""),
    total: Number(payload?.total) || 0,
    finishedAt: String(payload?.finishedAt || ""),
    updatedAt: new Date().toISOString(),
    results,
  });
  return file;
}

function removeResults(projectKey, rowsSignature, options = {}) {
  if (!projectKey || !rowsSignature) return false;
  const file = resultsFile(projectKey, rowsSignature, options.dataDir);
  try {
    fs.rmSync(file, { force: true });
    return true;
  } catch (error) {
    return false;
  }
}

function removeResultIndexes(projectKey, rowsSignature, indexes, options = {}) {
  if (!projectKey || !rowsSignature) return 0;
  const stored = readResults(projectKey, rowsSignature, options);
  if (!stored) return 0;
  const toRemove = new Set((Array.isArray(indexes) ? indexes : [...(indexes || [])])
    .map((index) => Number(index))
    .filter((index) => Number.isSafeInteger(index) && index > 0));
  if (!toRemove.size) return 0;
  const kept = stored.results.filter((item) => !toRemove.has(Number(item.index)));
  const removed = stored.results.length - kept.length;
  if (!removed) return 0;
  if (kept.length) {
    writeResults(projectKey, rowsSignature, { ...stored, results: kept }, options);
  } else {
    removeResults(projectKey, rowsSignature, options);
  }
  return removed;
}

function removeProjectResults(projectKey, options = {}) {
  if (!projectKey) return 0;
  const directory = aiResultsDir(options.dataDir);
  if (!fs.existsSync(directory)) return 0;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(directory, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    if (String(parsed?.projectKey || "") !== String(projectKey)) continue;
    try {
      fs.rmSync(file, { force: true });
      removed += 1;
    } catch {}
  }
  return removed;
}

module.exports = {
  SCHEMA_VERSION,
  aiResultsDir,
  readResults,
  removeProjectResults,
  removeResultIndexes,
  removeResults,
  resultsFile,
  writeResults,
};
