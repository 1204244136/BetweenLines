/**
 * 读取表格文件（xlsx / csv / tsv / json）的共享能力，供对照表与术语表复用。
 *
 * 设计要点：
 * - 纯 Node 实现，不调用外部命令，不新增依赖；xlsx 直接按 ZIP 中央目录解出 XML。
 * - 必须按单元格引用（`r="D2"`）定位列：xlsx 会省略空单元格，按出现顺序取值会让稀疏行错位。
 * - 只做“读出二维表”，列语义由调用方按表头判定。
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { XMLParser } = require("fast-xml-parser");

// xlsx 的单元格文本可能整表被 ASCII-only 转义：`魔術師` 写成 `&#39764;&#34899;&#24072;`
// （真实故障的译名对照表是 openpyxl 写出的：`sheet1.xml` 1,622,103 字节里 >127 的字节数为 0，
// 17,602 个文本单元格里 14,894 个是这种数字字符引用）。fast-xml-parser 默认只解 XML 预定义实体
// （`&amp;`/`&lt;`…），数字字符引用原样返回——读出来的「原文」形如 `&#39764;&#34899;&#24072;`，
// 按首字分桶全落进 `&` 桶，中日文条目一条也匹配不上（表现是术语段整段为空、模型只能按通用词典
// 猜译名；整卷 3350 行的命中数为 5，解码后是 824）。
// 库里的开关就是 `htmlEntities`（内部正是作为 `numericAllowed` 传给实体解码器的）：打开后
// 数字字符引用与 `&nbsp;`/`&mdash;` 这类 HTML 命名实体一起解掉。解码与命名实体处理在同一次
// 扫描里完成，所以正文真想写 `&#39764;` 时 XML 里的 `&amp;#39764;` 只会退成字面量 `&#39764;`，
// 不会被二次解码成 `魔`——这一点由 `scripts/spreadsheet.test.js` 的用例守着。
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  removeNSPrefix: true,
  textNodeName: "#text",
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  htmlEntities: true,
});

const asArray = (value) => (value == null ? [] : (Array.isArray(value) ? value : [value]));
const textOf = (value) => {
  if (value == null) return "";
  if (typeof value === "object") {
    if (value["#text"] != null) return String(value["#text"]);
    return Object.entries(value)
      .filter(([key]) => key !== "@_")
      .map(([, item]) => textOf(item))
      .join("");
  }
  return String(value);
};

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 66000);
  for (let offset = buffer.length - 22; offset >= minimum; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("不是有效的 xlsx：找不到 ZIP 中央目录。");
}

// 读 ZIP：以中央目录为准（本地头可能把大小放在数据描述符里）。
function readZipEntries(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);
    let data = method === 0 ? raw : zlib.inflateRawSync(raw);
    if (uncompressedSize && data.length !== uncompressedSize) {
      data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(uncompressedSize, data.length) });
    }
    entries.set(name, data);
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function columnIndex(reference) {
  const letters = String(reference || "").match(/^[A-Za-z]+/);
  if (!letters) return -1;
  let index = 0;
  for (const char of letters[0].toUpperCase()) {
    index = index * 26 + (char.charCodeAt(0) - 64);
  }
  return index - 1;
}

function readSharedStrings(entries) {
  const data = entries.get("xl/sharedStrings.xml");
  if (!data) return [];
  const parsed = parser.parse(data.toString("utf8"));
  return asArray(parsed?.sst?.si).map((item) => textOf(item));
}

function readSheetTargets(entries) {
  const workbookData = entries.get("xl/workbook.xml");
  if (!workbookData) return [];
  const workbook = parser.parse(workbookData.toString("utf8"));
  const relationshipsData = entries.get("xl/_rels/workbook.xml.rels");
  const relationships = relationshipsData ? parser.parse(relationshipsData.toString("utf8")) : {};
  const targets = new Map(
    asArray(relationships?.Relationships?.Relationship).map((item) => [String(item.Id || ""), String(item.Target || "")]),
  );
  return asArray(workbook?.workbook?.sheets?.sheet).map((sheet, index) => {
    const id = String(sheet.id || sheet["r:id"] || "");
    const target = targets.get(id) || `worksheets/sheet${index + 1}.xml`;
    return {
      name: String(sheet.name || `sheet${index + 1}`),
      zipPath: target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`,
    };
  });
}

function readWorksheetRows(xml, sharedStrings) {
  const sheet = parser.parse(xml);
  const rows = [];
  for (const row of asArray(sheet?.worksheet?.sheetData?.row)) {
    const cells = [];
    let sequential = 0;
    for (const cell of asArray(row.c)) {
      const reference = String(cell.r || "");
      const index = reference ? columnIndex(reference) : sequential;
      sequential = index + 1;
      const type = String(cell.t || "");
      let value = "";
      if (type === "s") {
        value = sharedStrings[Number(textOf(cell.v))] ?? "";
      } else if (type === "inlineStr") {
        value = textOf(cell.is);
      } else {
        value = textOf(cell.v);
      }
      cells[index >= 0 ? index : cells.length] = String(value).trim();
    }
    for (let i = 0; i < cells.length; i += 1) if (cells[i] === undefined) cells[i] = "";
    rows.push(cells);
  }
  return rows;
}

function readDelimitedRows(text) {
  const lines = String(text).replace(/^\uFEFF/, "").split(/\r?\n/).filter((line) => line.trim() !== "");
  if (!lines.length) return [];
  const tabs = (lines[0].match(/\t/g) || []).length;
  const commas = (lines[0].match(/,/g) || []).length;
  const semicolons = (lines[0].match(/;/g) || []).length;
  const delimiter = tabs >= Math.max(commas, semicolons) && tabs > 0 ? "\t" : (semicolons > commas ? ";" : ",");
  return lines.map((line) => splitDelimitedLine(line, delimiter));
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === delimiter) {
      cells.push(value.trim());
      value = "";
      continue;
    }
    value += char;
  }
  cells.push(value.trim());
  return cells;
}

function readJsonRows(file) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  const items = Array.isArray(data) ? data : asArray(data.rows || data.entries || []);
  if (!items.length || Array.isArray(items[0])) return items.map((row) => asArray(row).map((cell) => String(cell ?? "").trim()));
  const headers = [...new Set(items.flatMap((item) => Object.keys(item)))];
  return [headers, ...items.map((item) => headers.map((header) => String(item[header] ?? "").trim()))];
}

/**
 * 读取表格为二维数组（第一行视为表头）。
 * @returns {{ file: string, sheet: string, rows: string[][] }}
 */
function readSpreadsheet(file, options = {}) {
  const target = String(file || "").trim();
  if (!target) throw new Error("没有提供表格文件路径。");
  if (!fs.existsSync(target)) throw new Error(`表格文件不存在：${target}`);
  const ext = path.extname(target).toLowerCase();
  if (ext === ".json") return { file: target, sheet: "", rows: readJsonRows(target) };
  if ([".csv", ".tsv", ".txt"].includes(ext)) {
    return { file: target, sheet: "", rows: readDelimitedRows(fs.readFileSync(target, "utf8")) };
  }
  if (ext !== ".xlsx") throw new Error(`不支持的表格格式：${ext || "（无扩展名）"}`);
  const entries = readZipEntries(fs.readFileSync(target));
  const sheets = readSheetTargets(entries);
  if (!sheets.length) throw new Error(`xlsx 里没有工作表：${target}`);
  const preferred = options.sheet
    ? sheets.find((sheet) => sheet.name === options.sheet)
    : (sheets.find((sheet) => sheet.name === "data") || sheets[0]);
  const sheet = preferred || sheets[0];
  const data = entries.get(sheet.zipPath);
  if (!data) throw new Error(`xlsx 里找不到工作表内容：${sheet.name}`);
  return {
    file: target,
    sheet: sheet.name,
    rows: readWorksheetRows(data.toString("utf8"), readSharedStrings(entries)),
  };
}

/**
 * 表头驱动：把二维表映射为对象数组，表头统一小写并去掉空白/连字符。
 */
function readRecords(file, options = {}) {
  const { sheet, rows } = readSpreadsheet(file, options);
  const headerRow = rows[0] || [];
  const headers = headerRow.map((cell) => normalizeHeader(cell));
  const records = rows.slice(1)
    .map((row) => Object.fromEntries(headers.map((header, index) => [header, String(row[index] ?? "").trim()])))
    .filter((record) => Object.values(record).some(Boolean));
  return { file, sheet, headers, records };
}

function normalizeHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
}

module.exports = {
  readRecords,
  readSpreadsheet,
  normalizeHeader,
};
