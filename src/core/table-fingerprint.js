/**
 * 表格指纹：构建期把「按表算出来的结论」落盘，运行期必须先确认表没变过。
 *
 * 指纹口径固定为 `<版本>|<文件名>:<mtime>:<大小>#<条目数>`（多张表用 `|` 连接）。
 * 说话习惯层与对照表层共用这一份实现，避免两处口径漂移——只要口径一致，
 * 两个层的「复用 / 过期重算」判定就永远同步。
 *
 * 注意：文件名只取 basename。指纹只用来自查「同一路径下的表是否被换过」，
 * 不是内容校验，也不该把本机完整路径写进产物。
 */
const fs = require("fs");
const path = require("path");

function fileFingerprint(file) {
  try {
    const stat = fs.statSync(file);
    return `${path.basename(file)}:${Math.round(stat.mtimeMs)}:${stat.size}`;
  } catch {
    return `${path.basename(file)}:missing`;
  }
}

/**
 * @param {number} version 层版本号：结构变化时递增，旧快照自然视为过期
 * @param {string[]} files 已经归一化过的表路径
 * @param {number} entries 解析出的条目数
 */
function tablesFingerprint(version, files = [], entries = 0) {
  return `${version}|${files.map((file) => `${fileFingerprint(file)}#${entries}`).join("|")}`;
}

module.exports = { fileFingerprint, tablesFingerprint };
