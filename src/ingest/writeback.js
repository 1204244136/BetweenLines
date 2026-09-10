const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { XMLParser } = require("fast-xml-parser");
const { directoryEntries, isEpubDirectory } = require("./epub-container");

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true });
const asArray = (value) => (value == null ? [] : (Array.isArray(value) ? value : [value]));
const htmlEntryPattern = /\.(?:x?html?)$/i;

// 写回目标形态
const TARGET_TEXT = "text";
const TARGET_HTML = "html";
const TARGET_EPUB_ARCHIVE = "epub-archive";
const TARGET_EPUB_DIRECTORY = "epub-directory";

const WRITEBACK_HINT = "支持 TXT、XHTML/HTML、EPUB 文件与解压 EPUB 目录。";

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
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function previewText(text) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  return value.length > 60 ? `${value.slice(0, 60)}…` : value;
}

// 把 searchParts 与 replaceParts 对齐成逐段替换指令。
// 段数一致时一一对应；原文段更多时多余的原文段清空；替换段更多时多余段以 <br/> 连接到末段。
function alignParts(searchParts, replaceParts) {
  const n = searchParts.length;
  const m = replaceParts.length;
  const instructions = [];
  if (n === m) {
    for (let index = 0; index < n; index += 1) {
      instructions.push({ search: searchParts[index], replacement: encodeRevisionForXml(replaceParts[index]) });
    }
    return instructions;
  }
  if (n > m) {
    for (let index = 0; index < m - 1; index += 1) {
      instructions.push({ search: searchParts[index], replacement: encodeRevisionForXml(replaceParts[index]) });
    }
    for (let index = m - 1; index < n; index += 1) {
      instructions.push({
        search: searchParts[index],
        replacement: index === m - 1 ? encodeRevisionForXml(replaceParts[m - 1]) : "",
      });
    }
    return instructions;
  }
  for (let index = 0; index < n - 1; index += 1) {
    instructions.push({ search: searchParts[index], replacement: encodeRevisionForXml(replaceParts[index]) });
  }
  const tail = replaceParts.slice(n - 1).map((part) => encodeRevisionForXml(part)).join("<br/>");
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
          const byId = new Map(
            asArray(opf?.package?.manifest?.item)
              .map((item) => [String(item?.id || ""), resolveOpfPath(item?.href)])
              .filter(([, documentPath]) => documentPath),
          );
          for (const ref of asArray(opf?.package?.spine?.itemref)) {
            const documentPath = byId.get(String(ref?.idref || ""));
            if (documentPath && !used.has(documentPath)) {
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
  const remaining = normalized.filter((name) => !used.has(name)).sort((a, b) => a.localeCompare(b));
  return [...ordered, ...remaining];
}

async function loadWritebackDocuments(target, kind) {
  if (kind === TARGET_TEXT || kind === TARGET_HTML) {
    return { documents: [{ key: target, html: fs.readFileSync(target, "utf8") }], zip: null };
  }
  if (kind === TARGET_EPUB_DIRECTORY) {
    const names = directoryEntries(target)
      .filter((entry) => htmlEntryPattern.test(entry.path))
      .map((entry) => entry.path.replace(/\\/g, "/"));
    const ordered = await orderEpubDocuments(names, (name) => fs.readFileSync(path.join(target, name), "utf8"));
    return {
      documents: ordered.map((name) => ({ key: name, html: fs.readFileSync(path.join(target, name), "utf8") })),
      zip: null,
    };
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(target));
  const names = Object.keys(zip.files).filter((name) => !zip.files[name].dir && htmlEntryPattern.test(name));
  const ordered = await orderEpubDocuments(names, (name) => zip.file(name).async("string"));
  const documents = [];
  for (const name of ordered) {
    documents.push({ key: name, html: await zip.file(name).async("string") });
  }
  return { documents, zip };
}

function documentBlocks(doc) {
  if (doc.blocks) return doc.blocks;
  const blocks = [];
  const pattern = new RegExp(blockElementPattern.source, "gi");
  let match;
  while ((match = pattern.exec(doc.html)) !== null) {
    const tagName = match[1];
    const openTagEnd = match.index + match[0].indexOf(">") + 1;
    const closeTag = `</${tagName}>`;
    const innerEnd = match.index + match[0].length - closeTag.length;
    blocks.push({
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

// 全局单调游标：工作台行顺序与原文顺序一致，定位从上次命中之后继续，
// 避免重复出现的短句被错误替换到前面的段落。
function createPlacementState(documents) {
  return {
    docIndex: 0,
    offset: 0,
    // 在游标之后为 searchText 定位一个替换区间；直排优先，其次块级可比匹配。
    place(searchPart, replacement) {
      for (let index = this.docIndex; index < documents.length; index += 1) {
        const from = index === this.docIndex ? this.offset : 0;
        const found = documents[index].html.indexOf(searchPart, from);
        if (found >= 0) {
          return { docIndex: index, start: found, end: found + searchPart.length, replacement };
        }
      }
      const comparable = comparableText(searchPart);
      if (comparable) {
        for (let index = this.docIndex; index < documents.length; index += 1) {
          const floor = index === this.docIndex ? this.offset : 0;
          for (const block of documentBlocks(documents[index])) {
            if (block.used || block.end <= floor || !block.comparable) continue;
            if (block.comparable === comparable) {
              block.used = true;
              return { docIndex: index, start: block.innerStart, end: block.innerEnd, replacement };
            }
          }
        }
      }
      return null;
    },
    // 为说话人写回定位目标块：返回块的 openEnd 作为插入点。
    placeBlockForInsert(text, speaker) {
      const comparable = comparableText(text);
      if (!comparable) return null;
      const comment = `<!--Speaker:${speaker}-->`;
      for (let index = this.docIndex; index < documents.length; index += 1) {
        const floor = index === this.docIndex ? this.offset : 0;
        const html = documents[index].html;
        for (const block of documentBlocks(documents[index])) {
          if (block.used || block.end <= floor || !block.comparable) continue;
          if (block.comparable !== comparable) continue;
          block.used = true;
          // 已有说话人注释的块视为已写回，跳过且不计入更新。
          if (html.slice(block.openEnd, block.openEnd + 12).startsWith("<!--Speaker:")) {
            return { docIndex: index, start: block.openEnd, end: block.openEnd, replacement: "", skipped: true };
          }
          return { docIndex: index, start: block.openEnd, end: block.openEnd, replacement: comment };
        }
      }
      return null;
    },
  };
}

function planReplacements(documents, entries) {
  const state = createPlacementState(documents);
  const placements = [];
  const touched = new Set();
  const missed = [];
  let updated = 0;
  for (const entry of entries) {
    const snapshot = { docIndex: state.docIndex, offset: state.offset };
    const searchParts = splitParts(entry.searchText);
    const replaceParts = splitParts(entry.replaceText);
    if (!searchParts.length || !replaceParts.length) continue;
    const instructions = alignParts(searchParts, replaceParts);
    const entryPlacements = [];
    let failed = null;
    for (const instruction of instructions) {
      const placement = state.place(instruction.search, instruction.replacement);
      if (!placement) {
        failed = instruction;
        break;
      }
      entryPlacements.push(placement);
      state.docIndex = placement.docIndex;
      state.offset = placement.end;
    }
    if (failed) {
      // 该行任一段落定位失败则整行放弃，游标回到行前位置。
      state.docIndex = snapshot.docIndex;
      state.offset = snapshot.offset;
      missed.push({
        index: entry.id ?? entry.index ?? null,
        searchText: previewText(entry.searchText),
        reason: `未能在原文件中定位段落：${previewText(failed.search)}`,
      });
      continue;
    }
    placements.push(...entryPlacements);
    for (const placement of entryPlacements) touched.add(placement.docIndex);
    updated += 1;
  }
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
  return { planned, touched, updated, missed };
}

function planSpeakerAnnotations(documents, entries) {
  const state = createPlacementState(documents);
  const placements = [];
  const touched = new Set();
  const missed = [];
  let updated = 0;
  let skipped = 0;
  for (const entry of entries) {
    const snapshot = { docIndex: state.docIndex, offset: state.offset };
    const speaker = String(entry.speaker || "").replace(/-{2,}/g, "-").trim();
    const placement = state.placeBlockForInsert(entry.text, speaker);
    if (!placement) {
      state.docIndex = snapshot.docIndex;
      state.offset = snapshot.offset;
      missed.push({
        index: entry.index ?? null,
        text: previewText(entry.text),
        reason: `未能在原文件中定位发话段落：${previewText(entry.text)}`,
      });
      continue;
    }
    if (placement.skipped) {
      state.docIndex = placement.docIndex;
      state.offset = placement.end;
      skipped += 1;
      continue;
    }
    placements.push(placement);
    touched.add(placement.docIndex);
    state.docIndex = placement.docIndex;
    state.offset = placement.end;
    updated += 1;
  }
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
  return { planned, touched, updated, skipped, missed };
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
  const temp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    fs.writeFileSync(temp, content);
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* 尽力清理临时文件 */ }
    throw error;
  }
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

// 把一组 { searchText, replaceText } 写回目标（TXT / XHTML / EPUB 文件 / 解压 EPUB 目录）。
async function applyTextReplacements(target, entries) {
  const described = describeWritebackTarget(target);
  if (!described.ok) throw new Error(described.message);
  const { documents, zip } = await loadWritebackDocuments(target, described.kind);
  const plan = planReplacements(documents, entries);
  if (plan.planned.length) {
    applyPlacements(plan.planned, documents);
    await saveWritebackDocuments(target, described.kind, documents, zip, plan.touched);
  }
  return { updated: plan.updated, missed: plan.missed };
}

// 把说话人标记 <!--Speaker:xxx--> 注入包含发话文本的块级元素。
async function applySpeakerAnnotations(target, entries) {
  const described = describeWritebackTarget(target);
  if (!described.ok) throw new Error(described.message);
  if (described.kind === TARGET_TEXT) {
    throw new Error(`TXT 纯文本没有块级段落结构，暂不支持说话人写回。${WRITEBACK_HINT}`);
  }
  const { documents, zip } = await loadWritebackDocuments(target, described.kind);
  const plan = planSpeakerAnnotations(documents, entries);
  if (plan.planned.length) {
    applyPlacements(plan.planned, documents);
    await saveWritebackDocuments(target, described.kind, documents, zip, plan.touched);
  }
  return { updated: plan.updated, skipped: plan.skipped, missed: plan.missed };
}

module.exports = {
  applySpeakerAnnotations,
  applyTextReplacements,
  describeWritebackTarget,
  encodeRevisionForXml,
  WRITEBACK_HINT,
};
