/**
 * 原子落盘（src/core/atomic-fs.js）。
 *
 * 写法固定为「先写临时文件，再 rename 到目标」：读者要么看到旧文件、要么看到完整的新文件。
 * Windows 上 rename 覆盖已存在文件可能失败（目标被别的进程打开），此时退回
 * 「旧文件先挪到 .bak → 临时文件就位 → 删 .bak」；任何一步失败都把旧文件挪回来，
 * 绝不先删旧文件再尝试写入（AGENTS：关键 JSON 原子写失败时必须保留可恢复的旧副本）。
 */
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

function tempName(file, suffix) {
  return `${file}.${process.pid}-${crypto.randomBytes(5).toString("hex")}.${suffix}`;
}

function writeFileAtomic(file, content, encoding) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = tempName(file, "tmp");
  if (encoding) fs.writeFileSync(temp, content, encoding);
  else fs.writeFileSync(temp, content);
  try {
    fs.renameSync(temp, file);
    return;
  } catch (error) {
    if (!fs.existsSync(file)) {
      try { fs.rmSync(temp, { force: true }); } catch {}
      throw error;
    }
  }

  const backup = tempName(file, "bak");
  let backupCreated = false;
  try {
    fs.renameSync(file, backup);
    backupCreated = true;
    fs.renameSync(temp, file);
    try { fs.rmSync(backup, { force: true }); } catch {}
  } catch (error) {
    if (backupCreated && !fs.existsSync(file) && fs.existsSync(backup)) {
      try { fs.renameSync(backup, file); } catch {}
    }
    try { fs.rmSync(temp, { force: true }); } catch {}
    throw error;
  }
}

function writeJsonAtomic(file, value) {
  writeFileAtomic(file, JSON.stringify(value, null, 2), "utf8");
}

function readJsonFile(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

module.exports = {
  readJsonFile,
  writeFileAtomic,
  writeJsonAtomic,
};
