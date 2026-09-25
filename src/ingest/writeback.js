const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { XMLParser } = require("fast-xml-parser");
const { directoryEntries, isEpubDirectory } = require("./epub-container");
const { asArray } = require("../core/text-helpers");
const { writeFileAtomic } = require("../core/atomic-fs");

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true });
const htmlEntryPattern = /\.(?:x?html?)$/i;

// 写回目标形态
const TARGET_TEXT = "text";
const TARGET_HTML = "html";
const TARGET_EPUB_ARCHIVE = "epub-archive";
const TARGET_EPUB_DIRECTORY = "epub-directory";

const WRITEBACK_HINT = "支持 TXT、XHTML/HTML、EPUB 文件与解压 EPUB 目录。";

// 行锚点：一行文本必须落在上一行落点**之后**的段落上（工作台行序与文件段落序一致）。
// 锚点单调是防「嫁接到别处」的第一道闸门——本行文本在原位找不到时也不许回头或跳远重命中；
// 第二道闸门是「锚点附近有两处同样的段落就不猜、报歧义」。
//
// 锚点由**整卷行序**推进，而不是只由这次要写的行推进：未改动的行也要按自己的文本先占用
// 锚点，要改的行才落在自己那一处。只按条目推进时，同一段文字在别处先出现的那一行会被改掉
// （真实回归：一卷里两处独立成行的 <p>尽管如此。</p>，想写回第 667 行却写进了第 423 行）。
//
// 只保留这两条、**不做窗口限制**是实测结论：窗口一旦存在，全卷重复的短句（「「……」」这类）
// 会在窗口外找不到自己而整行漏写（真实语料实测漏写 1631/3120）；去掉窗口、只按锚点单调 +
// 局部重复判歧义，同一语料（S3_01 整卷 3120 行，且源文件已含若干外部改动）为 3102 写入 /
// 11 定位失败 / 7 歧义——失败的 11 行正是「页面快照与源文件不同步」该交人工的那些行。
//
// 间距阈值取 2：真实回归里两处相同的发话段落之间正好隔着一句旁白（索引差 2），
// 这条线以下就报歧义；全卷范围内的重复（差 3 以上）仍按顺序各归其位。
const NEAR_DUPLICATE_BLOCKS = 2;

// 允许在替换文本中原样保留的内联标记（与 ingest 归一化保留的集合一致）。
const preservedInlineTagPattern = /^(?:<\/?(?:ruby|rt|b|sup)(?:\s[^<>]*)?>|<a\b[^<>]*\bnoteref\b[^<>]*>|<\/a\s*>)$/i;
const blockElementPattern = /<(p|h[1-6]|blockquote|li|dd|dt)\b([^>]*)>([\s\S]*?)<\/\1>/gi;

function describeWritebackTarget(target) {
  if (!target) return { ok: false, kind: "", message: "没有已选择的原文件，无法写回。" };
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return { ok: false, kind: "", message: `写回目标不存在：${target}` };
  }
  if (stat.isDirectory()) {
    if (isEpubDirectory(target)) return { ok: true, kind: TARGET_EPUB_DIRECTORY };
    return { ok: false, kind: "", message: `写回目标目录不是单本解压的 EPUB（缺少 META-INF/container.xml）：${target}` };
  }
  const ext = path.extname(target).toLowerCase();
  if (ext === ".txt") return { ok: true, kind: TARGET_TEXT };
  if (ext === ".xhtml" || ext === ".html" || ext === ".htm") return { ok: true, kind: TARGET_HTML };
  if (ext === ".epub") return { ok: true, kind: TARGET_EPUB_ARCHIVE };
  return { ok: false, kind: "", message: `当前文件格式暂不支持直接写回（.${ext.slice(1) || "未知"}）。${WRITEBACK_HINT}` };
}

function decodeXmlEntities(text) {
  return String(text || "").replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|amp|lt|gt|quot|apos);/g, (match, dec, hex) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    switch (match) {
      case "&amp;": return "&";
      case "&lt;": return "<";
      case "&gt;": return ">";
      case "&quot;": return '"';
      case "&apos;": return "'";
      default: return match;
    }
  });
}

// 块级匹配用的“可比文本”：去注释、剥离 ruby 注音（rt 不属于正文文本流）、去标签、解码实体、去所有空白。
function comparableText(value) {
  return decodeXmlEntities(
    String(value || "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<ruby\b[^>]*>([\s\S]*?)<\/ruby>/gi, (match, inner) => inner.replace(/<rt\b[^>]*>[\s\S]*?<\/rt>/gi, ""))
      .replace(/<[^<>]*>/g, ""),
  ).replace(/\s+/g, "");
}

function escapeXmlText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// 把校对后的替换文本编码为 XML 片段：白名单内联标记原样保留，其余内容转义。
function encodeRevisionForXml(text) {
  const tokens = [];
  const masked = String(text || "").replace(/<[^<>]*>/g, (tag) => {
    tokens.push(preservedInlineTagPattern.test(tag) ? tag : escapeXmlText(tag));
    return `\u0002${tokens.length - 1}\u0003`;
  });
  return masked
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u0002(\d+)\u0003/g, (_, index) => tokens[Number(index)]);
}

function splitParts(text) {
  return String(text || "")
    .split(/\r?\n\s*\r?\n+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function previewText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

// 把 searchParts 与 replaceParts 对齐成逐段替换指令。
// 段数一致时一一对应；原文段更多时多余的原文段清空；替换段更多时多余段以 <br/> 连接到末段。
function alignParts(searchParts, replaceParts, encode = encodeRevisionForXml, separator = "<br/>") {
  const n = searchParts.length;
  const m = replaceParts.length;
  const instructions = [];
  if (n === m) {
    for (let index = 0; index < n; index += 1) {
      instructions.push({ search: searchParts[index], replacement: encode(replaceParts[index]) });
    }
    return instructions;
  }
  if (n > m) {
    for (let index = 0; index < m - 1; index += 1) {
      instructions.push({ search: searchParts[index], replacement: encode(replaceParts[index]) });
    }
    for (let index = m - 1; index < n; index += 1) {
      instructions.push({
        search: searchParts[index],
        replacement: index === m - 1 ? encode(replaceParts[m - 1]) : "",
      });
    }
    return instructions;
  }
  for (let index = 0; index < n - 1; index += 1) {
    instructions.push({ search: searchParts[index], replacement: encode(replaceParts[index]) });
  }
  const tail = replaceParts.slice(n - 1).map((part) => encode(part)).join(separator);
  instructions.push({ search: searchParts[n - 1], replacement: tail });
  return instructions;
}

// EPUB 内文档顺序：优先 OPF spine，其余文档按字典序附加在后，保证全局定位游标与行顺序一致。
async function orderEpubDocuments(names, readText) {
  const normalized = names.map((name) => name.replace(/\\/g, "/"));
  const byLower = new Map(normalized.map((name) => [name.toLowerCase(), name]));
  const ordered = [];
  const used = new Set();
  try {
    const containerName = byLower.get("meta-inf/container.xml");
    if (containerName) {
      const container = xmlParser.parse(await readText(containerName));
      const opfPath = asArray(container?.container?.rootfiles?.rootfile)[0]?.["full-path"];
      if (typeof opfPath === "string" && opfPath) {
        const opfName = byLower.get(opfPath.replace(/\\/g, "/").toLowerCase());
        if (opfName) {
          const opf = xmlParser.parse(await readText(opfName));
          const base = path.posix.dirname(opfPath.replace(/\\/g, "/"));
          const resolveOpfPath = (href) => {
            if (!href) return "";
            const joined = path.posix.join(base === "." ? "" : base, String(href).split("#")[0].replace(/\\/g, "/"));
            return byLower.get(joined.toLowerCase()) || "";
          };
          const manifestItems = asArray(opf?.package?.manifest?.item);
          const byId = new Map(
            manifestItems
              .map((item) => [String(item?.id || ""), resolveOpfPath(item?.href)])
              .filter(([, documentPath]) => documentPath),
          );
          // 纯导航文档（带 properties="nav"，或命名为 nav.xhtml / toc.xhtml）不作为正文写回文档
          const navPaths = new Set(
            manifestItems
              .filter((item) => String(item?.properties || "").includes("nav"))
              .map((item) => resolveOpfPath(item?.href))
              .filter(Boolean),
          );
          for (const ref of asArray(opf?.package?.spine?.itemref)) {
            const documentPath = byId.get(String(ref?.idref || ""));
            if (documentPath && !used.has(documentPath) && htmlEntryPattern.test(documentPath) && !navPaths.has(documentPath)) {
              used.add(documentPath);
              ordered.push(documentPath);
            }
          }
        }
      }
    }
  } catch {
    // OPF 解析失败时回退到字典序，不影响写回。
  }
  // 剩余的非导航 HTML 文档按字典序附加在后
  const remaining = normalized
    .filter((name) => !used.has(name) && htmlEntryPattern.test(name) && !name.toLowerCase().endsWith("nav.xhtml") && !name.toLowerCase().endsWith("toc.xhtml"))
    .sort((a, b) => a.localeCompare(b));
  return [...ordered, ...remaining];
}

async function loadWritebackDocuments(target, kind) {
  if (kind === TARGET_TEXT || kind === TARGET_HTML) {
    return { documents: [{ key: target, kind, html: fs.readFileSync(target, "utf8") }], zip: null };
  }
  if (kind === TARGET_EPUB_DIRECTORY) {
    const allNames = directoryEntries(target).map((entry) => entry.path.replace(/\\/g, "/"));
    const ordered = await orderEpubDocuments(allNames, (name) => fs.readFileSync(path.join(target, name), "utf8"));
    return {
      documents: ordered.map((name) => ({ key: name, html: fs.readFileSync(path.join(target, name), "utf8") })),
      zip: null,
    };
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(target));
  const allNames = Object.keys(zip.files).filter((name) => !zip.files[name].dir);
  const ordered = await orderEpubDocuments(allNames, (name) => zip.file(name).async("string"));
  const documents = [];
  for (const name of ordered) {
    documents.push({ key: name, html: await zip.file(name).async("string") });
  }
  return { documents, zip };
}

// 块序号计数器：跨文档累加，锚点才能在文档之间保持单调。
// 每次 `prepareDocuments` 重置，避免同一进程里多次写回互相污染序号。
let blockIndexCursor = 0;

// TXT 按空行划分段落，保留原字符串偏移；只替换段落正文，不触碰 BOM、缩进和分隔符。
function textDocumentBlocks(doc, docIndex) {
  const blocks = [];
  const separators = /\r?\n\s*\r?\n+/g;
  let start = 0;
  const append = (end) => {
    const raw = doc.html.slice(start, end);
    const text = raw.trim();
    if (!text) return;
    const innerStart = start + raw.length - raw.trimStart().length;
    blocks.push({ docIndex, index: blockIndexCursor++, start: innerStart, openEnd: innerStart,
      innerStart, innerEnd: innerStart + text.length, end: innerStart + text.length,
      comparable: plainComparableText(text), used: false });
  };
  for (const match of doc.html.matchAll(separators)) {
    append(match.index);
    start = match.index + match[0].length;
  }
  append(doc.html.length);
  return blocks;
}

function plainComparableText(value) {
  return String(value || "").replace(/\s+/g, "");
}

function documentBlocks(doc, docIndex = -1) {
  if (doc.blocks) return doc.blocks;
  if (doc.kind === TARGET_TEXT) return (doc.blocks = textDocumentBlocks(doc, docIndex));
  const blocks = [];
  const pattern = new RegExp(blockElementPattern.source, "gi");
  let match;
  while ((match = pattern.exec(doc.html)) !== null) {
    const tagName = match[1];
    const openTagEnd = match.index + match[0].indexOf(">") + 1;
    const closeTag = `</${tagName}>`;
    const innerEnd = match.index + match[0].length - closeTag.length;
    blocks.push({
      docIndex,
      tagName,
      index: blockIndexCursor++,
      start: match.index,
      openEnd: openTagEnd,
      innerStart: openTagEnd,
      innerEnd,
      end: match.index + match[0].length,
      comparable: comparableText(match[3]),
      used: false,
    });
  }
  doc.blocks = blocks;
  return blocks;
}

// 文档的块级列表缓存。块序号必须**全局单调**：定位引擎的锚点跨文档推进，
// 只有每本文档内部编号会让「换到下一本文档后」的判断整体错位。
function prepareDocuments(documents) {
  blockIndexCursor = 0;
  documents.forEach((doc, docIndex) => {
    documentBlocks(doc, docIndex);
  });
  return documents;
}

/**
 * 定位：从锚点向后扫描**未占用**的块，取第一处文本相同的段落。
 *
 * 三条纪律（缺一条就会把内容写到别的段落上）：
 * - **锚点单调**：只在上一行落点之后找。回头匹配会把上一行刚改过的位置再改一次。
 * - **不占用已改块**：同一段落被前一行改过之后不再参与本行匹配。
 * - **近处重复即歧义**：锚点附近（索引差 ≤ `NEAR_DUPLICATE_BLOCKS`）出现两处同样的文本时，
 *   无从判断改的是哪一处，报 `ambiguous`；相隔较远的重复（全卷多处「「……」」）按顺序各归其位。
 *
 * 找不到就返回空，由上层把整行记为「未写入」——**绝不退化成模糊匹配**：本行文本在原位
 * 找不到，说明源文件已被改动（例如页面快照生成之后做过对齐调整），此时任何「再往前找找」
 * 都可能把这一行的内容写到别的段落甚至别的文档上；真实回归就是这么把一章的句子写进了另一章。
 */
function locate(text, state, options = {}) {
  const maxBlock = Number.isInteger(options.maxBlock) ? options.maxBlock : Infinity;
  const candidates = [];
  for (let docIndex = state.docIndex; docIndex < state.documents.length && candidates.length < 2; docIndex += 1) {
    for (const block of state.documents[docIndex].blocks) {
      if (block.index < state.lastBlock || block.used || !block.comparable) continue;
      // 更靠后的待写回条目已经在这一块或更早处有可用锚点。当前行若越过它，
      // 后面的条目将永远无法从当前锚点回退到自己的位置；同块仍允许先序行占用。
      if (block.index > maxBlock) break;
      if (block.comparable !== text) continue;
      candidates.push(block);
      if (candidates.length >= 2) break;
    }
  }
  if (!candidates.length) return { hit: null, ambiguous: false };
  const [first, second] = candidates;
  // 第二处必须紧挨着第一处才算歧义：隔得远的那一处是同一段文字在别处出现，不是同一个位置的两种可能。
  if (second && second.index - first.index <= NEAR_DUPLICATE_BLOCKS) {
    return { hit: null, ambiguous: true, candidates: [first.index, second.index] };
  }
  return {
    hit: { docIndex: first.docIndex, start: first.innerStart, end: first.innerEnd, block: first },
    ambiguous: false,
  };
}

// 全局单调锚点：工作台行顺序与原文顺序一致，定位从上一行的落点之后继续。
// `lastBlock` 是行锚点——定位失败的行不推进锚点，也不会把它后面的行一起带偏到别处。
function createPlacementState(documents) {
  prepareDocuments(documents);
  return {
    documents,
    comparableText: documents[0]?.kind === TARGET_TEXT ? plainComparableText : comparableText,
    docIndex: 0,
    // 仅用于整行放弃后的回滚：有「已占用」标记在，定位本身不再依赖字符偏移。
    offset: 0,
    lastBlock: 0,
    // 为 searchPart 定位一个替换区间；命中不唯一时报歧义。
    place(searchPart, options = {}) {
      const text = this.comparableText(searchPart);
      if (!text) return { hit: null, ambiguous: false };
      return locate(text, this, options);
    },
    // 确认一次成功落点：锚点推进到该块之后。
    commit(hit) {
      if (hit.block) {
        hit.block.used = true;
        this.lastBlock = hit.block.index + 1;
      }
      this.docIndex = hit.docIndex;
      this.offset = hit.end;
      return hit;
    },
    // 整行放弃时回滚：锚点与「已占用」标记一起还原，
    // 否则这一行试错时占掉的段落会跟着消失，后面的行反而少了一个候选。
    snapshot() {
      return {
        docIndex: this.docIndex,
        offset: this.offset,
        lastBlock: this.lastBlock,
        used: this.documents.flatMap((doc) => doc.blocks || []).filter((block) => block.used),
      };
    },
    restore(snapshot) {
      this.docIndex = snapshot.docIndex;
      this.offset = snapshot.offset;
      this.lastBlock = snapshot.lastBlock;
      for (const doc of this.documents) {
        for (const block of doc.blocks || []) {
          if (block.used && !snapshot.used.includes(block)) block.used = false;
        }
      }
    },
    // 为说话人写回定位目标块：返回块的 openEnd 作为插入点，定位规则与文本写回一致。
    placeBlockForInsert(text, speaker, options = {}) {
      const located = this.place(text, options);
      if (!located.hit?.block) return located;
      const block = located.hit.block;
      const html = this.documents[block.docIndex].html;
      // 已有说话人注释的块视为已写回，跳过且不计入更新（仍推进锚点）。
      const skipped = html.slice(block.openEnd, block.openEnd + 12).startsWith("<!--Speaker:");
      return {
        hit: {
          docIndex: block.docIndex,
          start: block.openEnd,
          end: block.openEnd,
          replacement: skipped ? "" : `<!--Speaker:${speaker}-->`,
          block,
          skipped,
        },
        ambiguous: false,
      };
    },
  };
}

// 条目的行号：工作台行号是 1 起的整数，写回按它把「未改动的行」插回行序里。
function entryRowIndex(entry) {
  const id = Number(entry?.id ?? entry?.index);
  return Number.isInteger(id) && id >= 1 ? id : 0;
}

function buildBlockIndex(documents) {
  const index = new Map();
  for (const doc of documents) {
    for (const block of doc.blocks || []) {
      if (!block.comparable) continue;
      if (!index.has(block.comparable)) index.set(block.comparable, []);
      index.get(block.comparable).push(block.index);
    }
  }
  return index;
}

function firstBlockAtOrAfter(index, text, lastBlock) {
  const blocks = index.get(text);
  if (!blocks || !blocks.length) return null;
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (blocks[middle] < lastBlock) low = middle + 1;
    else high = middle;
  }
  return low < blocks.length ? blocks[low] : null;
}

// 未改动的行（seekRow）不能越过紧随其后的写回条目的可用锚点。
// 1. 只看当前行之后的最近一个待写回条目（nextAnchor），不被全书更靠后的条目误限；
// 2. 多候选短文本不作为硬上限，避免因常见短语在前面偶然出现而误伤前面的行。
function futureEntryBlockLimit(state, futureAnchors, currentRow, blockIndex) {
  let nextAnchor = null;
  for (const anchor of futureAnchors) {
    if (anchor.row > currentRow && anchor.text) {
      if (!nextAnchor || anchor.row < nextAnchor.row) {
        nextAnchor = anchor;
      }
    }
  }
  if (!nextAnchor) return Infinity;

  const blocks = blockIndex.get(nextAnchor.text);
  if (!blocks || !blocks.length) return Infinity;

  const candidate = firstBlockAtOrAfter(blockIndex, nextAnchor.text, state.lastBlock);
  if (candidate == null) return Infinity;

  // 如果该文本在全书有多处候选，且这个候选距离当前 lastBlock 太近，
  // 但 nextAnchor.row 却距离 currentRow 较远，说明该 candidate 是前面的同名短语，不是该条目真正的目标。
  if (blocks.length > 1) {
    const rowDiff = nextAnchor.row - currentRow;
    const blockDiff = candidate - state.lastBlock;
    if (rowDiff > 3 && blockDiff < rowDiff - 2) {
      return Infinity;
    }
  }

  return candidate;
}

// 一条写回条目落盘：逐段定位，任一段定位失败或命中不唯一就整行放弃（锚点与占用标记一起回滚）。
// 后面的行仍然按它们自己的位置定位——绝不因为这一行没写成就把内容挪到别处。
function placeEntry(state, entry, options = {}) {
  const searchParts = splitParts(entry.searchText);
  const replaceParts = splitParts(entry.replaceText);
  if (!searchParts.length || !replaceParts.length) return { placements: [], empty: true };
  const textDocument = state.documents[0]?.kind === TARGET_TEXT ? state.documents[0] : null;
  const newline = textDocument?.html.includes("\r\n") ? "\r\n" : "\n";
  const instructions = textDocument
    ? alignParts(searchParts, replaceParts, (text) => text.replace(/\r?\n/g, newline), newline + newline)
    : alignParts(searchParts, replaceParts);
  const snapshot = state.snapshot();
  const placements = [];
  let failed = null;
  let conflict = null;
  for (const instruction of instructions) {
    const located = state.place(instruction.search, options);
    if (located.hit) {
      state.commit(located.hit);
      placements.push({ ...located.hit, replacement: instruction.replacement });
      continue;
    }
    if (located.ambiguous) conflict = { search: instruction.search, candidates: located.candidates || [] };
    else failed = instruction;
    break;
  }
  if (failed || conflict) {
    state.restore(snapshot);
    return { placements: [], failed, conflict };
  }
  return { placements, failed: null, conflict: null };
}

// 没能落地的行文本：后面出现同一段文字时，第一处候选可能正是它该改而没占住的那一处。
function noteUnresolved(unresolved, parts, normalize = comparableText) {
  for (const part of parts) {
    const text = normalize(part);
    if (text) unresolved.add(text);
  }
}

// 未改动的行只推进锚点：命中就占用（后面的行从它之后继续找），命中不到或命中不唯一就停在原地。
// 这份行清单只服务定位，所以这里不报错、也不越过这一段往前跳。
function seekRow(state, text, unresolved, options = {}) {
  const parts = splitParts(text);
  for (let index = 0; index < parts.length; index += 1) {
    const located = state.place(parts[index], options);
    if (!located.hit) {
      noteUnresolved(unresolved, parts.slice(index), state.comparableText);
      return false;
    }
    state.commit(located.hit);
  }
  return true;
}

/**
 * 定位计划：把「要改的行」（entries）与「整卷行序」（`options.rowTexts`，第 i 行对应下标 i-1）
 * 合成一条单调的定位链。
 *
 * 为什么需要整卷行序：写回请求只带要改的行，但同一段文字在整卷里可能出现多次。只按条目推进
 * 锚点时，第二处的那一行会从卷首开始找、命中第一处并把它改掉（真实回归：两处独立成行的
 * <p>尽管如此。</p>，想写回第 667 行却写进了第 423 行）。把未改动的行也按行序插进来占用锚点，
 * 重复段落才各归其位。缺这份行清单（旧调用方、单条脚本）时退化成只按条目推进。
 *
 * 前一行没能落地（定位失败或命中不唯一）时，它没占住的那段文字记为「未落地」：后面遇到同一段
 * 文字的行报歧义，不猜第一处候选是不是它的。
 */
/**
 * 行序定位的公共骨架：去重 → 按行号登记锚点 → 逐行推进（无条目的行只占锚点）→ 落地 → 按文档分组。
 * 文本写回与说话人标注只在「实体字段名、落地方式、报告措辞」上不同，由 `strategy` 提供：
 * - `textOf(entry)`：该条目的正文（`searchText` / `text`）
 * - `report(entry, reason)`：missed/ambiguous 里一条记录的形状
 * - `commit(state, entry, options)`：返回 `{ empty?, failed?, conflict?, skipped?, placements: [] }`
 * - `blockedReason(preview)`：前面同段文字没落地时的歧义措辞
 */
function planPlacements(documents, entries, options, strategy) {
  const state = createPlacementState(documents);
  const rowTexts = Array.isArray(options.rowTexts) ? options.rowTexts : [];
  const placements = [];
  const touched = new Set();
  const missed = [];
  const ambiguous = [];
  const unresolved = new Set();
  // 同一行（同 id 同文本）在一次请求里出现两次时只落一次，第二次直接跳过：
  // 第一次已经把该段落改掉、再写一遍只会命中同一处或漂到别处，两种结果都不是用户要的；
  // 也不把它计进 updated——那会让「已写回 N 处」比实际写入的段落多。
  const seenEntries = new Set();
  const byRow = new Map();
  const loose = [];
  const futureAnchors = [];
  let updated = 0;
  let skipped = 0;

  for (const entry of entries) {
    const key = `${strategy.idOf(entry) ?? ""}\u0000${String(strategy.textOf(entry) || "")}`;
    if (seenEntries.has(key)) continue;
    seenEntries.add(key);
    const row = entryRowIndex(entry);
    if (!row) {
      loose.push(entry);
      continue;
    }
    if (!byRow.has(row)) byRow.set(row, entry);
  }
  for (const [row, entry] of byRow) {
    futureAnchors.push({ row, text: state.comparableText(splitParts(strategy.textOf(entry))[0]) });
  }
  const blockIndex = buildBlockIndex(state.documents);

  const commitEntry = (entry, commitOptions = {}) => {
    const outcome = strategy.commit(state, entry, commitOptions);
    if (outcome.empty) return;
    if (outcome.failed || outcome.conflict) {
      noteUnresolved(unresolved, splitParts(strategy.textOf(entry)), state.comparableText);
      const target = outcome.conflict ? ambiguous : missed;
      target.push(strategy.report(entry, outcome.conflict ? outcome.conflict.reason : outcome.failed.reason));
      return;
    }
    if (outcome.skipped) {
      skipped += 1;
      return;
    }
    placements.push(...outcome.placements);
    for (const placement of outcome.placements) touched.add(placement.docIndex);
    updated += 1;
  };

  const maxRow = byRow.size ? Math.max(...byRow.keys()) : 0;
  for (let row = 1; row <= maxRow; row += 1) {
    const maxBlock = futureEntryBlockLimit(state, futureAnchors, row, blockIndex);
    const entry = byRow.get(row);
    if (!entry) {
      seekRow(state, rowTexts[row - 1], unresolved, { maxBlock });
      continue;
    }
    const parts = splitParts(strategy.textOf(entry));
    const blocked = parts.find((part) => unresolved.has(state.comparableText(part)));
    if (blocked) {
      noteUnresolved(unresolved, parts, state.comparableText);
      ambiguous.push(strategy.report(entry, strategy.blockedReason(previewText(blocked))));
      continue;
    }
    commitEntry(entry);
  }
  for (const entry of loose) commitEntry(entry);
  const byDocument = new Map();
  for (const placement of placements) {
    if (!byDocument.has(placement.docIndex)) byDocument.set(placement.docIndex, []);
    byDocument.get(placement.docIndex).push(placement);
  }
  const planned = [];
  for (const [docIndex, list] of byDocument) {
    list.sort((a, b) => b.start - a.start);
    planned.push({ docIndex, list });
  }
  return { planned, touched, updated, skipped, missed, ambiguous };
}

function planReplacements(documents, entries, options = {}) {
  const result = planPlacements(documents, entries, options, {
    idOf: (entry) => entry?.id ?? entry?.index,
    textOf: (entry) => entry?.searchText,
    report: (entry, reason) => ({
      index: entry.id ?? entry.index ?? null,
      searchText: previewText(entry.searchText),
      reason,
    }),
    blockedReason: (preview) => `本行前面有同一段文字的行没能写回（${preview}），无法确定原文件里的这一处属于哪一行`,
    commit: (state, entry, commitOptions) => {
      const outcome = placeEntry(state, entry, commitOptions);
      if (outcome.conflict) {
        outcome.conflict.reason = `原文件中有多处同样的段落，无法确定该改哪一处：${previewText(outcome.conflict.search)}`;
      } else if (outcome.failed) {
        outcome.failed.reason = `未能在原文件中定位段落：${previewText(outcome.failed.search)}`;
      }
      return outcome;
    },
  });
  // 文本写回没有「已存在即跳过」的语义，对外形状保持不带 skipped。
  const { skipped, ...rest } = result;
  return rest;
}

// 说话人标注与文本写回共用同一套定位纪律（行序锚定 + 单调 + 不占用已写块 + 近处重复即歧义）。
function planSpeakerAnnotations(documents, entries, options = {}) {
  return planPlacements(documents, entries, options, {
    idOf: (entry) => entry?.index,
    textOf: (entry) => entry?.text,
    report: (entry, reason) => ({
      index: entry.index ?? null,
      text: previewText(entry.text),
      reason,
    }),
    blockedReason: (preview) => `本行前面有同一段发话的行没能写回（${preview}），无法确定原文件里的这一处属于哪一行`,
    commit: (state, entry, commitOptions) => {
      const snapshot = state.snapshot();
      const speaker = String(entry.speaker || "").replace(/-{2,}/g, "-").trim();
      const located = state.placeBlockForInsert(entry.text, speaker, commitOptions);
      const placement = located.hit;
      if (!placement) {
        // 定位失败或命中不唯一时锚点不动，后面的行按各自的位置重来。
        state.restore(snapshot);
        const preview = previewText(entry.text);
        return located.ambiguous
          ? { conflict: { reason: `原文件中有多处同样的发话段落，无法确定该标注哪一处：${preview}` }, placements: [] }
          : { failed: { reason: `未能在原文件中定位发话段落：${preview}` }, placements: [] };
      }
      state.commit(placement);
      if (placement.skipped) return { skipped: true, placements: [] };
      return { placements: [placement] };
    },
  });
}

function applyPlacements(planned, documents) {
  for (const { docIndex, list } of planned) {
    const doc = documents[docIndex];
    let html = doc.html;
    for (const placement of list) {
      html = html.slice(0, placement.start) + placement.replacement + html.slice(placement.end);
    }
    doc.html = html;
  }
}

async function repackEpubZip(zip) {
  const names = Object.keys(zip.files)
    .filter((name) => !zip.files[name].dir && name.replace(/\\/g, "/").toLowerCase() !== "mimetype")
    .sort((a, b) => a.localeCompare(b));
  const output = new JSZip();
  // EPUB 规范要求 mimetype 条目第一位且不压缩。
  output.file("mimetype", "application/epub+zip", { compression: "STORE" });
  for (const name of names) {
    output.file(name.replace(/\\/g, "/"), await zip.files[name].async("nodebuffer"), { compression: "DEFLATE" });
  }
  return output.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

function atomicWrite(file, content) {
  writeFileAtomic(file, content);
}

async function saveWritebackDocuments(target, kind, documents, zip, touched) {
  if (kind === TARGET_TEXT || kind === TARGET_HTML) {
    for (const index of touched) atomicWrite(documents[index].key, documents[index].html);
    return;
  }
  if (kind === TARGET_EPUB_DIRECTORY) {
    for (const index of touched) atomicWrite(path.join(target, documents[index].key), documents[index].html);
    return;
  }
  for (const index of touched) zip.file(documents[index].key, documents[index].html);
  const buffer = await repackEpubZip(zip);
  atomicWrite(target, buffer);
}

// 同一服务进程内，按真实路径串行化整个读改写事务；失败不阻塞后续请求。
const writebackQueues = new Map();
async function withWritebackLock(target, operation) {
  const resolved = fs.realpathSync(target);
  const key = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const previous = writebackQueues.get(key) || Promise.resolve();
  const current = previous.then(() => operation(resolved));
  const settled = current.then(() => {}, () => {});
  writebackQueues.set(key, settled);
  try {
    return await current;
  } finally {
    if (writebackQueues.get(key) === settled) writebackQueues.delete(key);
  }
}

// 把一组 { searchText, replaceText } 写回目标（TXT / XHTML / EPUB 文件 / 解压 EPUB 目录）。
// 返回 `updated`（真正写入的行数）、`missed`（定位失败，未写入）与 `ambiguous`（命中不唯一，未写入）。
// 两类未写入的行都必须如实上报：静默跳过会让用户以为已经写回，模糊兜底则会把内容写到别的段落上。
// `options.rowTexts`（可选）是目标列**按行序**排列的整卷行文本（第 i 行对应下标 i-1）：
// 未改动的行也按序占锚点，重复段落才能各归其位，详见 planReplacements。
async function applyTextReplacements(target, entries, options = {}) {
  return withWritebackLock(target, async (target) => {
    const described = describeWritebackTarget(target);
    if (!described.ok) throw new Error(described.message);
    const { documents, zip } = await loadWritebackDocuments(target, described.kind);
    const plan = planReplacements(documents, entries, options);
    if (plan.planned.length) {
      applyPlacements(plan.planned, documents);
      await saveWritebackDocuments(target, described.kind, documents, zip, plan.touched);
    }
    return { updated: plan.updated, missed: plan.missed, ambiguous: plan.ambiguous };
  });
}

// 把说话人标记 <!--Speaker:xxx--> 注入包含发话文本的块级元素。
// `options.rowTexts` 与文本写回同义：那一路是发话所在列的整卷行文本。
async function applySpeakerAnnotations(target, entries, options = {}) {
  return withWritebackLock(target, async (target) => {
    const described = describeWritebackTarget(target);
    if (!described.ok) throw new Error(described.message);
    if (described.kind === TARGET_TEXT) {
      throw new Error(`TXT 纯文本没有块级段落结构，暂不支持说话人写回。${WRITEBACK_HINT}`);
    }
    const { documents, zip } = await loadWritebackDocuments(target, described.kind);
    const plan = planSpeakerAnnotations(documents, entries, options);
    if (plan.planned.length) {
      applyPlacements(plan.planned, documents);
      await saveWritebackDocuments(target, described.kind, documents, zip, plan.touched);
    }
    return { updated: plan.updated, skipped: plan.skipped, missed: plan.missed, ambiguous: plan.ambiguous };
  });
}

module.exports = {
  applySpeakerAnnotations,
  applyTextReplacements,
  describeWritebackTarget,
  encodeRevisionForXml,
  splitParts,
  WRITEBACK_HINT,
};
