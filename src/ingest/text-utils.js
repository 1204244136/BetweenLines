const fs = require("fs");
const OpenCC = require("opencc-js");
const { readEpubText } = require("./epub-utils");
const { isEpubInput } = require("./epub-container");
const { formatForFile, readWithPandoc, textLength } = require("./pandoc-utils");
const { resolveBuildOutputDir } = require("../core/storage-layout");

const outputDir = resolveBuildOutputDir();

// 作品标题的通用形态：系列前缀 + 「某X的Y」或「とあるXのY」+ 可选卷号。
const genericWorkTitleLine = /^(?:(?:旧约|舊約|新约|新約|创约|創約)\s*)?(?:某[^\s]{1,12}(?:的|之)[^\s]{1,12}|とある[^\s]{1,14}の[^\s]{1,14})\s*\d*$/i;

const startMarkers = {
  tw: "",
  cn: "",
  jp: "",
};

const endMarkers = {
  tw: ["第一卷 後記", "\n後記\n"],
  cn: "后记",
  jp: "あとがき",
};

const chapterPatterns = {
  tw: /^(第[一二三四五六七八九十〇0-9０-９XxＸ]+卷\s+)?(引子(?:\s+.*)?|序\s+章.*|序\s*章(?:\s+.*)?|行間\s*[一二三四五六七八九十〇0-9０-９XxＸ]+|第[一二三四五六七八九十〇0-9０-９XxＸ]+(?:章|話)(?:\s+.*)?|終\s+章.*|終\s*章(?:\s+.*)?|尾[聲声](?:\s+.*)?|(?:Prologue|Epilogue|Before_the_Prologue|After_the_Epilogue|Between_the_Lines\s*[0-9XxＸ]+|Chapter\s*\d+|Sub\.\d+|Period\.\d+)(?:\s+.*)?)$/i,
  cn: /^(引子(?:\s+.*)?|序\s+章.*|序\s*章(?:\s+.*)?|行间\s*[一二三四五六七八九十〇0-9０-９XxＸ]+|第[一二三四五六七八九十〇0-9０-９XxＸ]+(?:章|话)(?:\s+.*)?|终\s+章.*|终\s*章(?:\s+.*)?|尾声(?:\s+.*)?|(?:Prologue|Epilogue|Before_the_Prologue|After_the_Epilogue|Between_the_Lines\s*[0-9XxＸ]+|Chapter\s*\d+|Sub\.\d+|Period\.\d+)(?:\s+.*)?)$/i,
  // 日文原版中不存在「引子」和「尾声」的文本标题（日文引子为序章前的无标题正文段落，尾声为后记后的无标题正文段落）；
  // 章节标题仅包含日文实际存在的标记。
  jp: /^(序\s+章.*|序\s*章(?:\s+.*)?|プロローグ(?:\s+.*)?|行間\s*[一二三四五六七八九十〇0-9０-９XxＸ]+|第[一二三四五六七八九十〇0-9０-９XxＸ]+(?:章|話)(?:\s+.*)?|終\s+章.*|終\s*章(?:\s+.*)?|エピローグ(?:\s+.*)?|(?:Prologue|Epilogue|Between_the_Lines\s*[0-9XxＸ]+|Chapter\s*\d+|Sub\.\d+|Period\.\d+)(?:\s+.*)?)$/i,
};

const toCn = OpenCC.Converter({ from: "tw", to: "cn" });

function readText(file) {
  return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

async function readSelectedInputText(file, selection = {}) {
  if (isEpubInput(file)) return readEpubText(file, { inlineMarkup: selection.inlineMarkup });
  if (formatForFile(file)) return readWithPandoc(file);
  return readText(file);
}

const readInputText = (file) => readSelectedInputText(file);

function blockStartPattern(markers) {
  return new RegExp(
    `(?:^|\\n\\s*\\n)\\s*(?:${markers.map((marker) => marker.source || marker).join("|")})(?:\\s|$|[：:])`,
    "i",
  );
}

const documentEndPatterns = {
  tw: blockStartPattern([
    "第一卷\\s*後記",
    "後記",
    "電子書特典",
    "特典",
    "版權頁",
    "版權",
    "版权",
    "colophon",
    "copyright",
  ]),
  cn: blockStartPattern([
    "后记",
    "後記",
    "特典",
    "版权页",
    "版权",
    "版權",
    "译注",
    "譯注",
    "colophon",
    "copyright",
    "\\*\\s*为本书",
  ]),
  jp: blockStartPattern([
    "あとがき",
    "後書き",
    "特典",
    "奥付",
    "発行",
    "発行者",
    "colophon",
    "copyright",
    "©",
    "ASCII\\s+MEDIA\\s+WORKS",
    "KADOKAWA",
    "角川",
  ]),
};

function sliceMain(text, startMarker, endMarker, options = {}) {
  const { requireStart = true, trimEnd = true } = options;
  const start = text.indexOf(startMarker);
  if (start === -1) {
    if (requireStart) throw new Error(`Cannot find start marker: ${startMarker}`);
    return text;
  }
  if (!trimEnd) return text.slice(start);

  const markers = Array.isArray(endMarker) ? endMarker : [endMarker];
  const end = markers
    .map((marker) => text.indexOf(marker, start))
    .filter((index) => index !== -1)
    .sort((a, b) => a - b)[0] ?? -1;
  return text.slice(start, end === -1 ? text.length : end);
}

function normalizeBlock(block) {
  return String(block || "").replace(/\s+/g, " ").trim();
}

function blockRanges(text) {
  const ranges = [];
  const pattern = /\n\s*\n+/g;
  let start = 0;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    ranges.push({ start, end: match.index, text: text.slice(start, match.index) });
    start = pattern.lastIndex;
  }
  ranges.push({ start, end: text.length, text: text.slice(start) });
  return ranges;
}

function isFrontMatterBlock(block, lang) {
  const normalized = normalizeBlock(block);
  if (!normalized) return true;
  if (isMediaOnlyBlock(normalized)) return true;
  if (normalizeTitle(normalized, lang)) return true;
  if (/^(contents|目錄|目录|ＣＯＮＴＥＮＴＳ|navigation)$/i.test(normalized)) return true;
  if (/^(制作信息|製作信息|网翻|翻译|翻譯|校对|校對|美工|录入|錄入|简介|簡介|彩页|插图|插圖)(?:\s|：|:|$)/i.test(normalized)) return true;
  // 作品标题行：下面这份清单是本项目实际使用的规则，同时作为示范；同一形态的通用写法
  // （系列前缀 + 「某X的Y」/「とあるXのY」+ 可选卷号）由 genericWorkTitleLine 兜住，接别的作品时改这里即可。
  if (genericWorkTitleLine.test(normalized)) return true;
  if (/^(暗部共生少女|某暗部的少女共栖|とある暗部的少女共棲|某魔法的禁书目录|新约\s*某魔法的禁书目录|创约\s*某魔法的禁书目录|とある魔術の禁書目録|新約\s*とある魔術の禁書目録|創約\s*とある魔術の禁書目録)\s*\d*$/i.test(normalized)) return true;
  if (/^(鎌池和馬|镰池和马|鎌池和馬かまちかずま|はいむらきよたか|灰村清孝|近木野中哉|冬川基|乃木康仁|山路新)$/.test(normalized)) return true;
  if (/^(Information|Special|Note|Introduction|Contents|Cover|Back_cover|Illustrations)$/i.test(normalized)) return true;
  if (/著作権|権利|帰属|アスキー・メディアワークス|KADOKAWA|法律の定め|本書（電子版）|本電子書籍|本电子书籍|リーディングシステム|再ダウンロード|ePub3|Reasily|图书观看|內容由|内容由|试看学习交流|商業用途|商业用途|转载时请保留|如有任何问题请联系|汉化组|漢化組/i.test(normalized)) return true;
  return false;
}

function isDialogueBlock(normalized) {
  const trimmed = normalized.trim();
  const startsWithQuote = /^[「『“"]/.test(trimmed);
  const hasPairedQuotes = /[「『“][^」』”]+[」』”]/.test(trimmed);
  const hasDialogueMarks = /[。．.!！？?，、…—~～]/.test(trimmed);
  return (startsWithQuote || hasPairedQuotes) && (hasDialogueMarks || trimmed.length >= 4);
}

function isLikelyBodyBlock(block, lang) {
  const normalized = normalizeBlock(block);
  if (isFrontMatterBlock(normalized, lang)) return false;
  if (isDialogueBlock(normalized)) return true;
  const sentenceMarks = (normalized.match(/[。．.!！？?]/g) || []).length;
  if (sentenceMarks > 0 && textLength(normalized) >= 6) return true;
  return textLength(normalized) >= 80;
}

function isOpeningChapterTitle(title) {
  return /^(引子|序\s*章|プロローグ|第[一1１〇0]章|第[一1１〇0]話|Prologue|Before_the_Prologue|Chapter\s*1\b)/i.test(title);
}

function findBodyStart(text, lang, markers = {}) {
  const startMarker = markers[lang] ?? startMarkers[lang];
  if (startMarker) {
    const start = text.indexOf(startMarker);
    if (start !== -1) return start;
  }

  let inSynopsis = false;
  // 正文起点 = 最近一次结构性边界（简介范围、章节标题、媒体占位）之后的第一个非前置块，
  // 而不是「第一个通过正文判定的块」。后者会把判定为弱块的开篇段落连同它前面的块一起
  // 切掉：中文开篇「欢迎，上条当麻，」短且以逗号收尾，isLikelyBodyBlock 返回 false，
  // 于是正文从下一段「欢迎来到绚丽多彩的Underground！」才开始，首段被永久丢弃，
  // 造成整卷跨语言错位。判定只用来确认「这里确实进入了正文」，不再决定起点位置。
  let bodyStart = null;
  let bodyStartIndex = -1;
  const ranges = blockRanges(text);
  for (let k = 0; k < ranges.length; k += 1) {
    const range = ranges[k];
    const normalized = normalizeBlock(range.text);
    if (/^(简介|簡介)(?:\s|：|:|$)/i.test(normalized)) {
      inSynopsis = true;
      bodyStart = null;
      bodyStartIndex = -1;
      continue;
    }
    if (inSynopsis) {
      // 图片可能在 EPUB 转换时被移除，只剩独立彩页标题。
      // 该标题已结束简介章节，不能继续吞掉随后无标题的引子。
      if (isMediaOnlyBlock(normalized) || /^(彩[页頁]|插[图圖]|Illustrations)$/i.test(normalized)) {
        inSynopsis = false;
        bodyStart = null;
        bodyStartIndex = -1;
        continue;
      }
      if (normalizeTitle(normalized, lang)) {
        // 标题已结束简介章节，它本身是结构性边界；紧随其后的块才是候选起点。
        inSynopsis = false;
        bodyStart = null;
        bodyStartIndex = -1;
        continue;
      }
      continue;
    }
    if (isFrontMatterBlock(normalized, lang)) {
      bodyStart = null;
      bodyStartIndex = -1;
      continue;
    }
    if (bodyStart === null) {
      bodyStart = range.start;
      bodyStartIndex = k;
    }
    if (isLikelyBodyBlock(range.text, lang)) {
      // 开篇章节标题紧挨正文起点时一并保留，否则会被切掉并把首章降级为「正文」。
      if (bodyStartIndex > 0) {
        const prevRange = ranges[bodyStartIndex - 1];
        const prevTitle = normalizeTitle(normalizeBlock(prevRange.text), lang);
        if (prevTitle && isOpeningChapterTitle(prevTitle)) {
          return prevRange.start;
        }
      }
      return bodyStart;
    }
  }
  return -1;
}

function sliceMainDocument(text, lang, markers = {}) {
  const start = findBodyStart(text, lang, markers);
  const body = start === -1 ? text : text.slice(start);
  const pattern = documentEndPatterns[lang];
  if (!pattern) return body;

  // 合并的 EPUB 可能包含处于中间位置的后记，后方紧跟另一部作品。
  // 仅在下一个标记之前未出现后续章节标题时才截断后记/附录标记；
  // 否则继续扫描直到找到最终末尾标记。
  const matcher = new RegExp(pattern.source, `${pattern.flags.replace(/g/g, "")}g`);
  let match;
  while ((match = matcher.exec(body)) !== null) {
    const remainder = body.slice(match.index + match[0].length);
    const nextMarker = remainder.search(pattern);
    const section = nextMarker === -1 ? remainder : remainder.slice(0, nextMarker);
    const hasLaterChapter = blockRanges(section).some((range) => Boolean(normalizeTitle(range.text, lang)));
    if (!hasLaterChapter) return body.slice(0, match.index);
  }
  return body;
}

function sliceMainForInput(text, lang, inputMode = "document", markers = {}) {
  if (inputMode !== "txt") return sliceMainDocument(text, lang, markers);

  const startMarker = markers[lang] ?? startMarkers[lang];
  if (!startMarker) return sliceMainDocument(text, lang, markers);

  return sliceMain(text, startMarker, endMarkers[lang], {
    requireStart: Boolean(startMarker),
    trimEnd: true,
  });
}

function normalizeTitle(line, lang) {
  const trimmed = line.trim();
  if (!trimmed) return "";
  const pattern = chapterPatterns[lang];
  if (!pattern) return "";
  const match = trimmed.match(pattern);
  return match ? trimmed : "";
}

function isMediaOnlyBlock(block) {
  const trimmed = block.trim();
  return /^(?:\[\s*(?:图片|圖片|图像|圖像|插图|插圖|image|img|p\d{1,5})?\s*\]\s*)+$/i.test(trimmed);
}

function splitParagraphs(text, lang) {
  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.replace(/\n+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .filter((block) => !/^[\-─－—＊*☆★\s]+$/.test(block))
    .filter((block) => !isMediaOnlyBlock(block));

  let currentChapter = "正文";
  const paragraphs = [];

  for (const block of blocks) {
    const title = normalizeTitle(block, lang);
    if (title) {
      currentChapter = title;
      continue;
    }

    paragraphs.push({
      sourceIndex: paragraphs.length,
      lang,
      chapter: currentChapter,
      text: block,
      cnText: lang === "tw" ? toCn(block) : block,
      chars: Array.from(block).length,
    });
  }

  return paragraphs;
}

async function loadParagraphs(selection) {
  const files = selection?.files;
  if (!files) throw new Error("loadParagraphs requires an input selection.");
  const inputMode = selection.inputMode || "document";
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const markers = selection.startMarkers || {};
  const readLang = async (lang) => splitParagraphs(
    sliceMainForInput(await readSelectedInputText(files[lang], selection), lang, inputMode, markers),
    lang,
  );

  const cn = await readLang("cn");
  const jp = await readLang("jp");
  if (comparisonMode !== "bilingual") {
    // 三语模式：三列同级材料都要导出。
    return { comparisonMode, tw: await readLang("tw"), cn, jp };
  }
  // 双语模式没有第三列：不生成 tw 键，避免下游把它当成一份真实存在的空文本。
  return { comparisonMode, cn, jp };
}

module.exports = {
  outputDir,
  toCn,
  readText,
  readInputText,
  sliceMain,
  sliceMainDocument,
  sliceMainForInput,
  splitParagraphs,
  loadParagraphs,
};
