const fs = require("fs");
const { workIdPattern } = require("../core/work-id");
const os = require("os");
const path = require("path");
const readline = require("readline/promises");
const { formatForFile } = require("./pandoc-utils");
const { isEpubDirectory, isEpubInput } = require("./epub-container");
const { resolveBuildOutputDir, resolveSelectionFile } = require("../core/storage-layout");

const outputDir = resolveBuildOutputDir();
const selectionFile = resolveSelectionFile();
const langs = ["jp", "cn", "tw"];
const labels = {
  jp: "原文 A",
  cn: "非原文 B",
  tw: "非原文 C",
};
// 双语模式只有原文与一份译文两列，角色称谓与产物里都不能出现第三列的位置。
const bilingualLabels = {
  jp: "原文 A",
  cn: "译文 B",
};
const defaultDisplayLabels = { ...labels };
const defaultInlineMarkup = {
  ruby: true,
  bold: true,
  noteref: true,
};

function normalizePath(value) {
  if (!value) return "";
  const expanded = String(value).trim().replace(/^["']|["']$/g, "");
  if (!expanded) return "";
  if (expanded === "~") return os.homedir();
  if (expanded.startsWith(`~${path.sep}`) || expanded.startsWith("~/")) {
    return path.join(os.homedir(), expanded.slice(2));
  }
  return path.resolve(expanded);
}

function isSupportedInput(file) {
  if (!file) return false;
  if (fs.existsSync(file) && !fs.statSync(file).isFile()) return isEpubDirectory(file);
  if (/\.txt$/i.test(file)) return true;
  return Boolean(formatForFile(file));
}

function inferInputMode(files) {
  const extensions = Object.values(files).filter(Boolean).map((file) => isEpubInput(file) ? ".epub" : path.extname(file).toLowerCase());
  if (extensions.every((ext) => ext === ".txt")) return "txt";
  if (extensions.every((ext) => ext === ".epub")) return "epub";
  return "document";
}

function normalizeComparisonMode(value) {
  return value === "bilingual" ? "bilingual" : "trilingual";
}

// 双语模式不存在第三列：所有产物（选择快照、段落导出、比较行、页面标签）都只按这两列生成。
function activeLangs(comparisonMode) {
  return normalizeComparisonMode(comparisonMode) === "bilingual" ? ["jp", "cn"] : langs;
}

function roleLabels(comparisonMode = "trilingual") {
  return normalizeComparisonMode(comparisonMode) === "bilingual" ? bilingualLabels : labels;
}

// 辅助表属于生成输入；空数组明确表示不挂载，不从档案或环境变量补入。
function normalizeTableSelection(value) {
  const paths = (Array.isArray(value) ? value : [value])
    .flatMap((item) => String(item || "").split(/[;\n]/))
    .map(normalizePath).filter(Boolean);
  const unique = [...new Map(paths.map((file) => [process.platform === "win32" ? file.toLowerCase() : file, file])).values()];
  for (const file of unique) {
    if (!/\.(xlsx|csv|tsv|json)$/i.test(file)) throw new Error(`不支持的辅助表格式：${file}`);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`辅助表文件不存在：${file}`);
  }
  return unique;
}

function validateSelection(selection) {
  if (!selection?.files) throw new Error("Input selection is missing files.");
  const comparisonMode = normalizeComparisonMode(selection.comparisonMode);
  const requiredLangs = activeLangs(comparisonMode);
  for (const lang of requiredLangs) {
    const file = selection.files[lang];
    if (!file) throw new Error(`Missing ${lang} input file.`);
    if (!fs.existsSync(file)) throw new Error(`Input file does not exist: ${file}`);
    if (!isSupportedInput(file)) throw new Error(`Unsupported input file type: ${file}`);
  }
  const files = Object.fromEntries(requiredLangs.map((lang) => [
    lang,
    selection.files[lang] ? path.resolve(selection.files[lang]) : "",
  ]));
  const displayLabels = Object.fromEntries(
    Object.entries(selection.labels || {})
      .map(([lang, label]) => [lang, String(label || "").trim()])
      .filter(([lang, label]) => requiredLangs.includes(lang) && label),
  );
  const startMarkers = Object.fromEntries(
    Object.entries(selection.startMarkers || {})
      .filter(([lang, marker]) => requiredLangs.includes(lang) && marker),
  );
  return {
    comparisonMode,
    inputMode: selection.inputMode || inferInputMode(files),
    files,
    labels: Object.fromEntries(requiredLangs.map((lang) => [
      lang,
      displayLabels[lang] || defaultDisplayLabels[lang],
    ])),
    startMarkers,
    inlineMarkup: normalizeInlineMarkup(selection.inlineMarkup),
    writebackBackup: Boolean(selection.writebackBackup),
    termTables: normalizeTableSelection(selection.termTables),
    speechTables: normalizeTableSelection(selection.speechTables),
    glossaryFile: selection.glossaryFile ? path.resolve(selection.glossaryFile) : (process.env.TRANSCOMPARATOR_GLOSSARY_FILE ? normalizePath(process.env.TRANSCOMPARATOR_GLOSSARY_FILE) : ""),
  };
}

function normalizeInlineMarkup(value = {}) {
  return {
    ruby: value.ruby !== false,
    bold: value.bold !== false,
    noteref: value.noteref !== false,
  };
}

// file 可覆盖：调用方按当前 env 实时解析（TRANSCOMPARATOR_SELECTION_FILE），
// 而不是沿用本模块加载时捕获的常量，隔离测试与多数据目录场景才不会串。
function loadSavedSelection(file = selectionFile) {
  if (!fs.existsSync(file)) return null;
  return validateSelection(JSON.parse(fs.readFileSync(file, "utf8")));
}

function saveSelection(selection) {
  fs.mkdirSync(path.dirname(selectionFile), { recursive: true });
  fs.writeFileSync(selectionFile, JSON.stringify(validateSelection(selection), null, 2), "utf8");
}

function parseArgs(argv = process.argv.slice(2)) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      result[key] = true;
      continue;
    }
    result[key] = next;
    index += 1;
  }
  return result;
}

function selectionFromExplicitFiles(source) {
  const comparisonMode = normalizeComparisonMode(source.comparisonMode || source["comparison-mode"] || process.env.TRANSCOMPARATOR_COMPARISON_MODE);
  const files = {
    jp: normalizePath(source.jp || source["jp-file"] || process.env.TRANSCOMPARATOR_JP_FILE),
    cn: normalizePath(source.cn || source["cn-file"] || process.env.TRANSCOMPARATOR_CN_FILE),
    tw: normalizePath(source.tw || source["tw-file"] || process.env.TRANSCOMPARATOR_TW_FILE),
  };
  const requiredLangs = activeLangs(comparisonMode);
  if (!requiredLangs.every((lang) => files[lang])) return null;
  return validateSelection({
    files,
    comparisonMode,
    inputMode: source.mode || process.env.TRANSCOMPARATOR_INPUT_MODE || inferInputMode(files),
    startMarkers: startMarkersFromSource(source),
    glossaryFile: source.glossary || source["glossary-file"] || process.env.TRANSCOMPARATOR_GLOSSARY_FILE || "",
    termTables: source.termTables || source["term-tables"] || [],
    speechTables: source.speechTables || source["speech-tables"] || [],
  });
}

function startMarkersFromSource(source) {
  return Object.fromEntries(
    langs
      .map((lang) => [
        lang,
        source[`${lang}-start`] || process.env[`TRANSCOMPARATOR_${lang.toUpperCase()}_START_MARKER`] || "",
      ])
      .filter(([, marker]) => marker),
  );
}

function supportedFilesInDirectory(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() || entry.isDirectory())
    .map((entry) => path.join(dir, entry.name))
    .filter(isSupportedInput)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function guessLangOrder(files, comparisonMode = "trilingual") {
  const unused = new Set(files);
  const take = (predicate) => {
    for (const file of unused) {
      if (predicate(path.basename(file))) {
        unused.delete(file);
        return file;
      }
    }
    return null;
  };
  const result = {
    jp: take((name) => /[ぁ-んァ-ヶー]/.test(name) || /\b(?:jp|ja|japanese|raw)\b/i.test(name) || /とある/i.test(name)),
    cn: take((name) => /[简中汉栖这学园诡诈骗权译书录创]/i.test(name) || /\b(?:cn|zh|chs|chinese|sc)\b/i.test(name) || /[\[\(]?S\d+[^\]\)]*[\]\)]?.*X(?:\.epub|\.docx|\.txt|$)/i.test(name) || /X\.(?:epub|docx|txt)$/i.test(name)),
    tw: comparisonMode === "bilingual" ? null : take((name) => /[繁台臺這學園詐騙權譯鎌馬書錄創]/i.test(name) || /\b(?:tw|tc|traditional|cht)\b/i.test(name)),
  };
  for (const lang of activeLangs(comparisonMode)) {
    if (!result[lang]) {
      const [file] = unused;
      result[lang] = file;
      unused.delete(file);
    }
  }
  return result;
}

function selectionFromDirectory(dir, source = {}) {
  const inputDir = normalizePath(dir);
  const comparisonMode = normalizeComparisonMode(source.comparisonMode || source["comparison-mode"] || process.env.TRANSCOMPARATOR_COMPARISON_MODE);
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`Input directory does not exist: ${inputDir}`);
  }
  const files = supportedFilesInDirectory(inputDir);
  const minimumFiles = comparisonMode === "bilingual" ? 2 : 3;
  if (files.length < minimumFiles) {
    throw new Error(`Need at least ${minimumFiles} supported files in ${inputDir}; found ${files.length}.`);
  }
  return validateSelection({
    comparisonMode,
    files: guessLangOrder(files, comparisonMode),
    inputMode: source.mode || process.env.TRANSCOMPARATOR_INPUT_MODE || inferInputMode(guessLangOrder(files, comparisonMode)),
    startMarkers: startMarkersFromSource(source),
  });
}

function findMatchingEntry(dir, pattern) {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    const entries = fs.readdirSync(dir);
    for (const entry of entries) {
      if (pattern.test(entry) && isSupportedInput(path.join(dir, entry))) {
        return path.join(dir, entry);
      }
    }
  } catch {
    // 忽略无法读取的目录
  }
  return null;
}

function resolveIndexXCandidateDir(source = {}) {
  const custom = source["index-x-dir"] || source.indexXDir || process.env.INDEX_X_DIR || process.env.TRANSCOMPARATOR_INDEX_X_DIR;
  if (custom) return normalizePath(custom);
  const sibling = path.resolve(__dirname, "..", "..", "..", "index-X");
  if (fs.existsSync(sibling)) return sibling;
  return "";
}

function selectionFromWorkId(source = {}) {
  const workId = String(source["work-id"] || source.workId || source.work || process.env.TRANSCOMPARATOR_WORK_ID || "").trim();
  if (!workId) return null;

  const comparisonMode = normalizeComparisonMode(source.comparisonMode || source["comparison-mode"] || process.env.TRANSCOMPARATOR_COMPARISON_MODE);
  const indexXDir = resolveIndexXCandidateDir(source);
  const pattern = workIdPattern(workId);

  let cnFile = null;
  let jpFile = null;
  let twFile = null;

  if (indexXDir) {
    cnFile = findMatchingEntry(path.join(indexXDir, "output", "epubs"), pattern)
      || findMatchingEntry(path.join(indexXDir, "EPUB"), pattern)
      || findMatchingEntry(path.join(indexXDir, ".cache", "epub-work", "packed-epubs", "chinese-text"), pattern)
      || findMatchingEntry(path.join(indexXDir, ".cache", "epub-work", "chinese-text"), pattern);

    jpFile = findMatchingEntry(path.join(indexXDir, ".cache", "epub-work", "japanese-text"), pattern)
      || findMatchingEntry(path.join(indexXDir, ".cache", "epub-work", "packed-epubs", "japanese-text"), pattern);
  }

  const oneDriveBase = source["onedrive-dir"] || process.env.TRANSCOMPARATOR_ONEDRIVE_DIR || "";
  if (oneDriveBase && fs.existsSync(oneDriveBase)) {
    if (!cnFile) cnFile = findMatchingEntry(path.join(oneDriveBase, "X系列", "EPUB"), pattern);
    if (!jpFile) jpFile = findMatchingEntry(path.join(oneDriveBase, "日文原文"), pattern);
    if (comparisonMode !== "bilingual") {
      twFile = findMatchingEntry(path.join(oneDriveBase, "台版原文"), pattern);
    }
  }

  // 显式传入的文件具有更高优先级
  if (source.jp || source["jp-file"]) jpFile = normalizePath(source.jp || source["jp-file"]);
  if (source.cn || source["cn-file"]) cnFile = normalizePath(source.cn || source["cn-file"]);
  if (source.tw || source["tw-file"]) twFile = normalizePath(source.tw || source["tw-file"]);

  const files = { jp: jpFile || "", cn: cnFile || "", tw: twFile || "" };
  const requiredLangs = activeLangs(comparisonMode);
  if (!requiredLangs.every((lang) => files[lang] && fs.existsSync(files[lang]))) {
    return null;
  }

  return validateSelection({
    comparisonMode,
    inputMode: source.mode || process.env.TRANSCOMPARATOR_INPUT_MODE || inferInputMode(files),
    files,
    startMarkers: startMarkersFromSource(source),
  });
}

function selectionFromArgsOrEnv() {
  const args = parseArgs();
  const explicit = selectionFromExplicitFiles(args);
  if (explicit) return explicit;

  const fromWork = selectionFromWorkId(args);
  if (fromWork) return fromWork;

  const inputDir = args["input-dir"] || args.dir || process.env.TRANSCOMPARATOR_INPUT_DIR;
  if (inputDir) return selectionFromDirectory(inputDir, args);

  return null;
}

function describeSelection(selection) {
  const roleLabelsForMode = roleLabels(selection.comparisonMode);
  return activeLangs(selection.comparisonMode)
    .filter((lang) => selection.files[lang])
    .map((lang) => `${roleLabelsForMode[lang]}(${lang}): ${selection.files[lang]}`)
    .join("\n");
}

async function ask(rl, question, defaultValue = "") {
  const suffix = defaultValue ? ` [${defaultValue}]` : "";
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer || defaultValue;
}

async function askYesNo(rl, question, defaultValue = true) {
  const hint = defaultValue ? "Y/n" : "y/N";
  const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
  if (!answer) return defaultValue;
  return ["y", "yes", "是", "好"].includes(answer);
}

async function chooseFile(rl, files, lang, defaultFile, chosen, comparisonMode = "trilingual") {
  const role = roleLabels(comparisonMode)[lang];
  const defaultIndex = files.findIndex((file) => file === defaultFile) + 1;
  while (true) {
    const answer = await ask(rl, `选择${role}(${lang})文件编号`, String(defaultIndex || ""));
    const index = Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= files.length) {
      const file = files[index - 1];
      if (!chosen.has(file)) {
        chosen.add(file);
        return file;
      }
      console.log("这个文件已经选过了，请选择另一份。");
    } else {
      console.log("请输入列表中的数字编号。");
    }
  }
}

async function promptSelection(savedSelection = null) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    if (savedSelection) {
      console.log("当前保存的输入选择：");
      console.log(describeSelection(savedSelection));
      if (await askYesNo(rl, "继续使用这组选项", true)) return savedSelection;
    }

    const savedMode = normalizeComparisonMode(savedSelection?.comparisonMode);
    const comparisonMode = (await askYesNo(rl, "使用双语模式（原文 + 一份译文）", savedMode === "bilingual"))
      ? "bilingual"
      : "trilingual";
    const activeRoles = activeLangs(comparisonMode);
    const minimumFiles = activeRoles.length;

    const defaultDir = savedSelection ? path.dirname(savedSelection.files.jp) : "";
    const inputDir = normalizePath(await ask(rl, "输入源文件目录", defaultDir));
    const files = supportedFilesInDirectory(inputDir);
    if (files.length < minimumFiles) {
      throw new Error(`Need at least ${minimumFiles} supported files in ${inputDir}; found ${files.length}.`);
    }

    console.log("可选文件：");
    files.forEach((file, index) => {
      console.log(`${index + 1}. ${path.basename(file)}`);
    });

    const guessed = guessLangOrder(files, comparisonMode);
    const chosen = new Set();
    const selectedFiles = {};
    for (const lang of activeRoles) {
      selectedFiles[lang] = await chooseFile(rl, files, lang, guessed[lang], chosen, comparisonMode);
    }

    const startMarkers = {};
    if (await askYesNo(rl, "需要手动输入正文起始短语来跳过封面、目录或制作信息吗", false)) {
      for (const lang of activeRoles) {
        const marker = await ask(rl, `${roleLabels(comparisonMode)[lang]}(${lang})正文起始短语，可留空`);
        if (marker) startMarkers[lang] = marker;
      }
    }

    return validateSelection({
      comparisonMode,
      files: selectedFiles,
      inputMode: inferInputMode(selectedFiles),
      startMarkers,
    });
  } finally {
    rl.close();
  }
}

async function resolveInputSelection(options = {}) {
  const envSelection = selectionFromArgsOrEnv();
  if (envSelection) return envSelection;

  const savedSelection = loadSavedSelection();
  const canPrompt = options.allowPrompt !== false && process.stdin.isTTY && process.stdout.isTTY;
  if (canPrompt && (options.promptIfSaved || !savedSelection)) {
    return promptSelection(savedSelection);
  }
  if (savedSelection) return savedSelection;

  throw new Error(
    [
      "No input files selected.",
      "Run this script in an interactive terminal, or pass --input-dir <dir>,",
      "or set TRANSCOMPARATOR_JP_FILE and TRANSCOMPARATOR_CN_FILE",
      "(plus TRANSCOMPARATOR_TW_FILE for trilingual mode).",
    ].join(" "),
  );
}

module.exports = {
  normalizeTableSelection,
  activeLangs,
  guessLangOrder,
  inferInputMode,
  isSupportedInput,
  loadSavedSelection,
  normalizePath,
  roleLabels,
  selectionFile,
  resolveInputSelection,
  saveSelection,
  describeSelection,
  defaultDisplayLabels,
  defaultInlineMarkup,
  normalizeComparisonMode,
  supportedFilesInDirectory,
  validateSelection,
};
