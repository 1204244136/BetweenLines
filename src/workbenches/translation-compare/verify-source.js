/**
 * 用 index-X 缓存的日文原文校验对齐产物与说话习惯判定。
 *
 * 为什么需要：快照里的 `jp` 列来自日文工作源，但经过转换与切分，可能丢失内容
 * （注音被剥掉、页首页尾被折叠、对齐时把行合并）。说话习惯层与译名层都建立在
 * 这份文本上，所以要用权威原文对照一次：
 *   1. 卷号与正文文件是否齐全；
 *   2. 快照里的章节名能否在原文里找到（行间/章节标题）；
 *   3. 角色人名在原文与快照 `jp` 列里的出现次数是否一致（少了说明快照丢了内容）；
 *   4. 各角色口癖在原文与快照里的出现次数是否一致（少了说明口癖被剥离，会给“特色流失”误报）。
 *
 * 原文工作源位于 `<index-X>/.cache/epub-work/japanese-text/[S3_01]…/item/*.xhtml`。
 */
const fs = require("fs");
const path = require("path");
const { toCn } = require("../../ingest/text-utils");

function stripInlineMarkup(text) {
  return String(text || "")
    .replace(/<rp[^>]*>[\s\S]*?<\/rp>/gi, "")
    .replace(/<rt[^>]*>[\s\S]*?<\/rt>/gi, "")
    .replace(/<[^>]*>/g, "");
}

function defaultIndexXDir() {
  if (process.env.INDEX_X_DIR) return process.env.INDEX_X_DIR;
  // 约定：index-X 与本仓库同级（AGENTS 中的 ../index-X）。
  const sibling = path.resolve(__dirname, "..", "..", "..", "..", "index-X");
  return fs.existsSync(sibling) ? sibling : "";
}

/** 找该卷的日文工作源目录：目录名以 `[<卷号>]` 开头。 */
function resolveJapaneseSourceDir({ indexXDir = "", volumeCode = "" } = {}) {
  const base = path.join(indexXDir || defaultIndexXDir(), ".cache", "epub-work", "japanese-text");
  if (!volumeCode) return { dir: "", base, error: "没有卷号：无法定位日文原文。" };
  if (!fs.existsSync(base)) return { dir: "", base, error: `日文原文目录不存在：${base}（先运行 index-X 的 tools/pull.ps1）。` };
  const match = fs.readdirSync(base, { withFileTypes: true })
    .filter((item) => item.isDirectory() && item.name.startsWith(`[${volumeCode}]`))
    .map((item) => item.name)
    .sort();
  if (!match.length) return { dir: "", base, error: `在 ${base} 下找不到 [${volumeCode}] 的日文原文目录。` };
  return { dir: path.join(base, match[0]), base, name: match[0] };
}

const BODY_FILE_PATTERN = /^[A-Z]\d+_\d+.*-\d+.*\.xhtml$/i;

/** 正文 XHTML 可能直接在包根下，也可能在 item/ 或 item/xhtml/ 里（两种布局都支持）。 */
function findBodyRoot(dir) {
  const candidates = [
    path.join(dir, "item", "xhtml"),
    path.join(dir, "item"),
    path.join(dir, "xhtml"),
    dir,
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const hasBody = fs.readdirSync(candidate).some((name) => BODY_FILE_PATTERN.test(name));
    if (hasBody) return candidate;
  }
  return candidates.find((candidate) => fs.existsSync(candidate)) || dir;
}

function listBodyFiles(dir) {
  const root = findBodyRoot(dir);
  return fs.readdirSync(root)
    .filter((name) => BODY_FILE_PATTERN.test(name))
    .sort()
    .map((name) => ({ name, file: path.join(root, name) }));
}

/** 读整卷正文：返回纯文本（去注音 rt）、正文文件清单与标题行。 */
function readJapaneseVolume(dir) {
  const files = listBodyFiles(dir);
  const parts = [];
  const headings = [];
  for (const item of files) {
    const raw = fs.readFileSync(item.file, "utf8");
    const text = stripInlineMarkup(raw);
    parts.push(text);
    for (const match of raw.matchAll(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/gi)) {
      const title = stripInlineMarkup(match[1]).replace(/\s+/g, " ").trim();
      if (title) headings.push({ file: item.name, title });
    }
  }
  return {
    files: files.map((item) => item.name),
    text: parts.join("\n"),
    headings,
  };
}

function countOccurrences(text, needle) {
  const value = String(needle || "");
  if (!value) return 0;
  let count = 0;
  let from = 0;
  while (from <= text.length) {
    const at = text.indexOf(value, from);
    if (at < 0) break;
    count += 1;
    from = at + value.length;
  }
  return count;
}

// 同一段文本里既数日文写法又数简转写法会重复计数，只在两者写法不同时才各数一次。
function countInSource(sourcePlain, sourceCn, needle) {
  const original = String(needle || "");
  if (!original) return 0;
  const simplified = toCn(original);
  const count = countOccurrences(sourcePlain, original);
  return simplified === original ? count : count + countOccurrences(sourceCn, simplified);
}

const CHINESE_NUMERALS = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const CHAPTER_MARKER = /^(序\s*章|プロローグ|行\s*間\s*([一二三四五六七八九十0-9]+)|行\s*间\s*([一二三四五六七八九十0-9]+)|第\s*([一二三四五六七八九十0-9]+)\s*章|終\s*章|终\s*章|エピローグ|あとがき|后记)/;

function numeral(value) {
  if (value == null) return "";
  const text = String(value).trim();
  if (/^\d+$/.test(text)) return text;
  return CHINESE_NUMERALS[text] ? String(CHINESE_NUMERALS[text]) : text;
}

/**
 * 章标题的稳定标记：中日两侧的章名是翻译关系（「第一章 まるで遊園地のような…」对
 * 「第一章 简直就像是游乐园一般…」），不能按整串比对；这里只取
 * 「序章 / 行间N / 第N章 / 终章 / 尾声」这类结构标记来对齐两侧。
 */
function chapterMarkerKey(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  const match = value.match(CHAPTER_MARKER);
  if (!match) return "";
  if (match[1] === "序章" || match[1] === "序 章" || match[1] === "プロローグ") return "序章";
  if (match[1].startsWith("行")) return `行间${numeral(match[2] ?? match[3])}`;
  if (match[4] != null) return `第${numeral(match[4])}章`;
  if (match[1] === "終章" || match[1] === "終 章" || match[1] === "终章" || match[1] === "终 章") return "终章";
  if (match[1] === "エピローグ") return "尾声";
  return "后记";
}

/**
 * 校验：章节结构 / 人名 / 口癖 在“日文原文”与“快照 jp 列”之间的一致性。
 */
function verifyAgainstSource({ indexXDir = "", volume = null, rows = [], tables = null } = {}) {
  const volumeCode = volume?.code || "";
  const resolved = resolveJapaneseSourceDir({ indexXDir, volumeCode });
  if (!resolved.dir) return { ok: false, volume: volumeCode, error: resolved.error };

  const source = readJapaneseVolume(resolved.dir);
  const sourceCn = toCn(source.text);
  const sourcePlain = source.text;
  const rowText = rows.map((row) => String(row.jp || "")).join("\n");
  const rowTextCn = toCn(rowText);

  const sourceMarkers = source.headings
    .map((heading) => ({ ...heading, key: chapterMarkerKey(toCn(heading.title)) }))
    .filter((heading) => heading.key);
  const sourceKeys = sourceMarkers.map((heading) => heading.key);
  const chapters = [...new Set(rows.map((row) => String(row.chapter || "").trim()).filter(Boolean))]
    .map((chapter) => {
      const key = chapterMarkerKey(chapter);
      return { chapter, key, foundInSource: key ? sourceKeys.includes(key) : true };
    });

  const characters = (tables?.entries || []).map((entry) => {
    const nameCountSource = countInSource(sourcePlain, sourceCn, entry.character);
    const nameCountRows = countInSource(rowText, rowTextCn, entry.character);
    const habitCountSource = entry.hasLiteralHabit ? countInSource(sourcePlain, sourceCn, entry.habit) : 0;
    const habitCountRows = entry.hasLiteralHabit ? countInSource(rowText, rowTextCn, entry.habit) : 0;
    return {
      character: entry.character,
      habit: entry.habit,
      type: entry.type,
      nameCountSource,
      nameCountRows,
      habitCountSource,
      habitCountRows,
      // 原文有、快照少了 → 快照可能丢了内容（会影响习惯判定与补回提示）
      missingHabitOccurrences: Math.max(0, habitCountSource - habitCountRows),
    };
  }).filter((item) => item.nameCountSource || item.nameCountRows || item.habitCountSource);

  return {
    ok: true,
    volume: volumeCode,
    sourceDir: resolved.dir,
    sourceName: resolved.name,
    sourceFiles: source.files,
    headings: source.headings,
    sourceMarkers,
    chapters,
    chaptersMissing: chapters.filter((item) => !item.foundInSource).map((item) => item.chapter),
    characters: characters.sort((a, b) => b.habitCountSource - a.habitCountSource),
    habitsLostInSnapshot: characters.filter((item) => item.missingHabitOccurrences > 0),
  };
}

module.exports = {
  chapterMarkerKey,
  countInSource,
  countOccurrences,
  findBodyRoot,
  defaultIndexXDir,
  listBodyFiles,
  readJapaneseVolume,
  resolveJapaneseSourceDir,
  stripInlineMarkup,
  verifyAgainstSource,
};
