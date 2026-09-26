const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { storageLayout } = require("../core/storage-layout");
const { directoryEntries } = require("../ingest/epub-container");
const {
  guessLangOrder,
  inferInputMode,
  normalizeComparisonMode,
  normalizePath,
  saveSelection,
  selectionFile,
  defaultDisplayLabels,
  defaultInlineMarkup,
  isSupportedInput,
  supportedFilesInDirectory,
  validateSelection,
} = require("../ingest/input-selection");

const rootDir = path.join(__dirname, "..", "..");
const importedInputsDir = storageLayout().importedInputsDir;

function filePayload(file) {
  const stat = fs.statSync(file);
  const resolved = path.resolve(file);
  const isImportedCopy = resolved.startsWith(`${path.resolve(importedInputsDir)}${path.sep}`);
  const source = isImportedCopy ? "copy" : "local";
  if (stat.isDirectory()) {
    const entries = directoryEntries(file);
    return { path: file, name: path.basename(file), ext: "epub", kind: "directory", source,
      size: entries.reduce((total, entry) => total + entry.size, 0), fileCount: entries.length };
  }
  return {
    path: file,
    name: path.basename(file),
    ext: path.extname(file).slice(1).toLowerCase(),
    size: stat.size,
    source,
  };
}

// 文件和文件夹都使用 Windows Common Item Dialog，只切换选择模式。
// 两种模式因此共享同一套导航界面和最近访问位置，并返回可直接写回的真实路径。
function pickNativePath(mode) {
  const pickerScript = path.join(rootDir, "scripts", "windows-path-picker.ps1");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-File", pickerScript,
      "-Mode", mode === "folder" ? "folder" : "file",
    ], {
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error && error.killed) {
        reject(new Error("选择窗口超时未响应，请重试。"));
        return;
      }
      if (error) {
        reject(new Error("无法打开系统选择窗口（仅支持 Windows 本机环境）。"));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function validateLocalInputPath(target) {
  if (!target) throw new Error("请输入文件或解压 EPUB 目录的本地路径。");
  if (!fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
  if (!isSupportedInput(target)) {
    throw new Error("不支持的文件类型。请选择 TXT、EPUB、DOCX、HTML、ODT、Markdown、RTF 文件或解压的 EPUB 目录。");
  }
}

function savedFilePayloads(saved) {
  if (!saved?.files) return {};
  return Object.fromEntries(
    ["jp", "cn", "tw"]
      .map((role) => [role, saved.files[role]])
      .filter(([, file]) => file && fs.existsSync(file))
      .map(([role, file]) => [role, filePayload(file)]),
  );
}

function scanDirectory(dir, comparisonMode = "trilingual") {
  const inputDir = normalizePath(dir);
  const mode = normalizeComparisonMode(comparisonMode);
  if (!inputDir) throw new Error("请输入源文件目录。");
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`目录不存在：${inputDir}`);
  }

  const files = supportedFilesInDirectory(inputDir);
  const minimumFiles = mode === "bilingual" ? 2 : 3;
  if (files.length < minimumFiles) {
    throw new Error(`至少需要 ${minimumFiles} 个支持的源文件；当前找到 ${files.length} 个。`);
  }

  const guessed = guessLangOrder(files, mode);
  return {
    comparisonMode: mode,
    inputDir,
    files: files.map(filePayload),
    guessed,
    inputMode: inferInputMode(guessed),
  };
}

function saveInputSelection(payload) {
  const files = {
    jp: normalizePath(payload.files?.jp),
    cn: normalizePath(payload.files?.cn),
    tw: normalizePath(payload.files?.tw),
  };
  const startMarkers = Object.fromEntries(
    Object.entries(payload.startMarkers || {})
      .map(([lang, value]) => [lang, String(value || "").trim()])
      .filter(([, value]) => value),
  );
  const selection = validateSelection({
    files,
    comparisonMode: payload.comparisonMode,
    inputMode: payload.inputMode || inferInputMode(files),
    labels: payload.labels || defaultDisplayLabels,
    startMarkers,
    inlineMarkup: {
      ...defaultInlineMarkup,
      ...(payload.inlineMarkup || {}),
    },
    writebackBackup: Boolean(payload.writebackBackup),
  });
  saveSelection(selection);
  return { selection, selectionFile };
}

module.exports = { filePayload, pickNativePath, validateLocalInputPath, savedFilePayloads, scanDirectory, saveInputSelection };
