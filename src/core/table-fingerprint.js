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
 * 落盘用：把表路径收成文件名列表。
 *
 * 构建期算出的层结论要写进 `translation-compare.json` 并嵌进页面，那里只该出现
 * 「是哪张表」，不该出现本机目录结构；完整路径只留在运行期（界面悬停提示、日志）。
 * 运行期要重算指纹时，从**当前档案声明**重新解析路径，而不是回读这里存的文件名。
 */
function tableFileNames(files = []) {
  return files.map((file) => path.basename(String(file || ""))).filter(Boolean);
}

/**
 * @param {number} version 层版本号：结构变化时递增，旧快照自然视为过期
 * @param {string[]} files 已经归一化过的表路径（运行期重算指纹时才需要真实路径）
 * @param {number} entries 解析出的条目数
 */
function tablesFingerprint(version, files = [], entries = 0) {
  return `${version}|${files.map((file) => `${fileFingerprint(file)}#${entries}`).join("|")}`;
}

module.exports = { fileFingerprint, tableFileNames, tablesFingerprint };
