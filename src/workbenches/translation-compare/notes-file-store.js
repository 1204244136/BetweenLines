const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { storageLayout } = require("../../core/storage-layout");
const { writeJsonAtomic } = require("../../core/atomic-fs");
const { safeJson } = require("../../core/text-helpers");
const { createNotesTools } = require("./notes-spaces");

const tools = createNotesTools();
const bootstrapMarker = '<script id="notesDiskData" type="application/json">null</script>';

// 备注是可变的长期用户数据，不属于生成快照或 AI 运行缓存。
function createNotesFileStore({ dataDir } = {}) {
  const directory = () => path.join(storageLayout(dataDir).notesDir, "translation-compare");
  const digest = (raw) => crypto.createHash("sha256").update(raw).digest("hex");
  function validateKey(key) {
    if (typeof key !== "string" || !key.startsWith(tools.prefix) || tools.auxiliary(key)
      || key.length > 2048 || /[\x00-\x1f]/.test(key)) throw new Error("备注空间标识无效。");
    return key;
  }
  const fileFor = (key) => path.join(directory(), digest(validateKey(key)) + ".json");
  function readFile(file) {
    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    validateKey(record.key);
    if (record.schemaVersion !== 1 || typeof record.version !== "string" || !record.version
      || (record.raw !== null && typeof record.raw !== "string")
      || (record.completedRecoveries !== undefined && (!Array.isArray(record.completedRecoveries)
        || record.completedRecoveries.some((id) => !/^[a-f0-9]{64}$/.test(id))))
      || record.checksum !== digest(JSON.stringify(record.raw)) || file !== fileFor(record.key)) {
      throw new Error("磁盘备注空间损坏，已暂停读写；请保留原文件。");
    }
    return record;
  }
  function read(key) {
    const file = fileFor(key);
    return fs.existsSync(file) ? readFile(file) : { key, raw: null, version: null };
  }
  function list() {
    const dir = directory();
    return { directory: dir, spaces: fs.existsSync(dir)
      ? fs.readdirSync(dir).filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
        .map((name) => readFile(path.join(dir, name))) : [] };
  }
  function commit(key, raw, completedRecoveries = read(key).completedRecoveries || []) {
    const record = { schemaVersion: 1, key, raw, version: crypto.randomUUID(),
      checksum: digest(JSON.stringify(raw)), completedRecoveries, updatedAt: new Date().toISOString() };
    writeJsonAtomic(fileFor(key), record);
    const verified = read(key);
    if (verified.version !== record.version || verified.raw !== raw) throw new Error("磁盘备注保存核验失败。");
    return verified;
  }
  function compareVersion(key, expectedVersion) {
    if (expectedVersion !== null && typeof expectedVersion !== "string") throw new Error("缺少备注空间版本。");
    const existing = read(key);
    if (existing.version !== expectedVersion) {
      const error = new Error("备注空间已被其他页面修改，已暂停保存；请导出本页记录后刷新核对。");
      error.statusCode = 409;
      throw error;
    }
    return existing;
  }
  function write({ key, raw, expectedVersion }) {
    validateKey(key);
    if (typeof raw !== "string" || tools.parse(raw) === null) throw new Error("备注内容无法解析，未覆盖磁盘记录。");
    const existing = compareVersion(key, expectedVersion);
    return existing.raw === raw ? existing : commit(key, raw);
  }
  function remove({ key, expectedVersion }) {
    compareVersion(key, expectedVersion);
    // 删除留下不带内容的版本标记，旧页面不能把已删除空间重新写回来。
    return commit(key, null);
  }
  function markRecovery({ key, expectedVersion, id }) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) throw new Error("备注恢复标记无效。");
    const existing = compareVersion(key, expectedVersion);
    if (existing.raw === null) throw new Error("备注尚未保存，不能登记恢复标记。");
    const completed = existing.completedRecoveries || [];
    return completed.includes(id) ? existing : commit(key, existing.raw, [...completed, id]);
  }
  function importSpace({ key, raw }) {
    validateKey(key);
    if (typeof raw !== "string") throw new Error("备注备份内容无效。");
    const base = key.replace(/:import-\d+(?:-\d+)?$/, "");
    const duplicate = list().spaces.find((item) => item.raw === raw
      && (item.key === key || item.key === base || item.key.startsWith(base + ":import-")));
    if (duplicate) return { ...duplicate, skipped: true };
    const existing = read(key);
    if (existing.version !== null) {
      key = base + ":import-" + Date.now();
      let counter = 1;
      while (read(key).version !== null) key = base + ":import-" + Date.now() + "-" + counter++;
    }
    // 损坏的旧空间也原样归档，不能因为解析失败就漏掉或清空。
    return commit(key, raw);
  }
  function inject(html) {
    if (!html.includes(bootstrapMarker)) {
      if (html.includes('id="rowData"') && html.includes('id="notesPanel"')) {
        // 旧快照仍读浏览器，迁移清理后会误呈现为空；升级前暂停旧脚本。
        return '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>请更新工作台布局</title>'
          + '<body><h1>请先应用新布局</h1><p>此工作台使用旧版备注存储。电脑里的备注仍保留；'
          + '请回到本地控制台，选择这个项目并点击「应用新布局」，然后重新打开工作台。</p>'
          + '<p><a href="/">返回本地控制台</a></p></body></html>';
      }
      return html;
    }
    let payload;
    try { payload = list(); }
    catch (error) { payload = { error: error.message, spaces: [] }; }
    return html.replace(bootstrapMarker, () => '<script id="notesDiskData" type="application/json">'
      + safeJson(payload) + "</script>");
  }
  return { read, list, write, remove, markRecovery, importSpace, inject };
}

module.exports = { createNotesFileStore };
