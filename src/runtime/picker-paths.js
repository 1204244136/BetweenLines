/**
 * 各导入入口的默认目录（src/runtime/picker-paths.js）。
 *
 * 系统选择窗口（Windows Common Item Dialog）默认按 ClientGuid 记忆「上次访问位置」，
 * 三个导入入口共用同一份记忆，于是每次都要从别处的目录重新导航回来。这里让每个角色
 * （jp/cn/tw）各自独立：
 * - 独立 ClientGuid：即使没有可用的显式目录，Windows 自身的记忆也按入口分开；
 * - 独立默认目录：由「当前卡片路径 → 该入口上次实际选择位置 → 已登记选择」依次推导，
 *   交给选择窗口用 SetFolder 强制定位（SetFolder 会覆盖系统记忆，SetDefaultFolder 不会）。
 *
 * 记忆只保存目录，不保存文件：文件被删掉后仍能回到它原来所在的目录。
 */
const fs = require("fs");
const path = require("path");
const { readJsonFile, writeJsonAtomic } = require("../core/atomic-fs");
const { storageLayout } = require("../core/storage-layout");
const { normalizePath } = require("../ingest/input-selection");

const pickRoles = ["jp", "cn", "tw"];

// 每个入口一个稳定 GUID：Windows 按 GUID 分别持久化上次位置、列宽与排序。
// jp 沿用历史 GUID，让已存在的系统记忆不丢。
const clientGuids = {
  jp: "2B25D048-9026-4C30-A916-E559C747E4C3",
  cn: "7C41F2A9-5E38-4B62-9D0A-1F6B8C3E5A21",
  tw: "A5E6D3B7-2C94-41F8-8B5D-6E27A0C4F913",
};

function normalizePickRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return pickRoles.includes(value) ? value : "";
}

function roleClientGuid(role) {
  return clientGuids[normalizePickRole(role)] || clientGuids.jp;
}

function pickerPathsFile() {
  return storageLayout().pickerPathsFile;
}

// 文件取所在目录、目录取自身；路径已不存在时退回仍存在的父目录，都没有则返回空串。
function pathToDirectory(target) {
  const value = normalizePath(target);
  if (!value) return "";
  try {
    return fs.statSync(value).isDirectory() ? value : path.dirname(value);
  } catch {
    const parent = path.dirname(value);
    return parent && parent !== value && fs.existsSync(parent) ? parent : "";
  }
}

// 读取时丢掉已被删除的目录：默认路径指向不存在的位置只会让选择窗口退回系统记忆。
function readPickerPaths(file = pickerPathsFile()) {
  if (!file || !fs.existsSync(file)) return {};
  let stored;
  try {
    stored = readJsonFile(file);
  } catch {
    return {};
  }
  if (!stored || typeof stored !== "object") return {};
  return Object.fromEntries(
    pickRoles
      .map((role) => [role, typeof stored[role] === "string" ? stored[role] : ""])
      .filter(([, dir]) => dir && fs.existsSync(dir)),
  );
}

function rememberPickerDir(role, target, file = pickerPathsFile()) {
  const normalizedRole = normalizePickRole(role);
  if (!normalizedRole) return "";
  const directory = pathToDirectory(target);
  if (!directory) return "";
  writeJsonAtomic(file, { ...readPickerPaths(file), [normalizedRole]: directory });
  return directory;
}

// 起始目录优先级：当前卡片路径 > 该入口上次实际选择位置 > 已登记选择。
// 卡片路径最贴近用户此刻的心理预期（「从我当前这个文件附近再找一份」），
// 记忆次之（最近一次在文件系统里导航到的地方），已登记选择作为兜底。
function resolvePickDir(role, { currentPath = "", remembered = null, savedSelection = null } = {}) {
  const normalizedRole = normalizePickRole(role);
  if (!normalizedRole) return "";
  const candidates = [
    currentPath,
    (remembered || readPickerPaths())[normalizedRole],
    savedSelection?.files?.[normalizedRole],
  ];
  for (const candidate of candidates) {
    const directory = pathToDirectory(candidate);
    if (directory) return directory;
  }
  return "";
}

module.exports = {
  clientGuids,
  normalizePickRole,
  pathToDirectory,
  pickRoles,
  pickerPathsFile,
  readPickerPaths,
  rememberPickerDir,
  resolvePickDir,
  roleClientGuid,
};
