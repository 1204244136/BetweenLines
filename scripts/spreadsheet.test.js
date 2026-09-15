/**
 * 共享表格读取器：xlsx / csv / tsv / json 一律由纯 Node 读取，不依赖本机 python。
 * 关键不变量是「按单元格引用定位列」——xlsx 会省略空单元格，按出现顺序取值会让稀疏行错位。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const JSZip = require("jszip");

const { readRecords, readSpreadsheet } = require("../src/core/spreadsheet");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-spreadsheet-"));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const HEADERS = ["Debuts", "Base_Ori", "Ruby_Ori", "Base_Trans", "Ruby_Trans", "Other_Fandom", "Type", "Memo1", "Memo2"];

function columnLetter(index) {
  let value = index + 1;
  let letters = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    value = Math.floor((value - 1) / 26);
  }
  return letters;
}

// 生成稀疏 xlsx：空单元格必须整格省略，读取方只能靠 r="D2" 定位列。
async function writeSparseXlsx(file, rows) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>`);
  zip.file("xl/workbook.xml", `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets></workbook>`);
  zip.file("xl/_rels/workbook.xml.rels", `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`);
  const sheetRows = rows.map((cells, rowIndex) => {
    const body = cells
      .map((value, column) => (value === "" || value == null
        ? ""
        : `<c r="${columnLetter(column)}${rowIndex + 1}" t="inlineStr"><is><t>${String(value)}</t></is></c>`))
      .join("");
    return `<row r="${rowIndex + 1}">${body}</row>`;
  }).join("");
  zip.file("xl/worksheets/sheet1.xml", `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

test("稀疏 xlsx 按单元格引用对齐列，不按出现顺序取值", async () => {
  const file = path.join(tempDir, "sparse.xlsx");
  await writeSparseXlsx(file, [
    HEADERS,
    ["甲系列", "社会復帰サポート初来株式会社", "", "社会康复支援初来株式会社", "", "", "地名/设施", "备注一", ""],
    ["甲系列", "【東雲】【太郎】", "しののめ,たろう", "東雲太郎", "", "Shinonome Taro", "人名/日式全名", "成员", "第1集"],
  ]);

  const table = readSpreadsheet(file);
  assert.equal(table.sheet, "data");
  // 表格读取会裁掉行尾空单元格，但中间的空列必须保留（稀疏行不能错位）。
  assert.deepEqual(table.rows[1], ["甲系列", "社会復帰サポート初来株式会社", "", "社会康复支援初来株式会社", "", "", "地名/设施", "备注一"]);

  const records = readRecords(file);
  assert.deepEqual(records.records[1], {
    debuts: "甲系列",
    base_ori: "【東雲】【太郎】",
    ruby_ori: "しののめ,たろう",
    base_trans: "東雲太郎",
    ruby_trans: "",
    other_fandom: "Shinonome Taro",
    type: "人名/日式全名",
    memo1: "成员",
    memo2: "第1集",
  });
});

test("术语表复用同一读取器：稀疏 xlsx 不错位，csv 引号字段不串列", async () => {
  const { loadGlossary } = require("../src/workbenches/translation-compare/ai/glossary");
  const file = path.join(tempDir, "glossary.xlsx");
  await writeSparseXlsx(file, [
    ["Base_Ori", "Ruby_Ori", "Base_Trans", "Type"],
    ["甲", "", "甲译", "术语"],
    ["【乙】【丙】", "おつ,へい", "乙丙", "人名/日式全名"],
  ]);
  const entries = loadGlossary(file);
  assert.deepEqual(entries.map((entry) => [entry.original, entry.translation]), [["甲", "甲译"], ["【乙】【丙】", "乙丙"]]);
  assert.equal(entries[1].rubyOriginal, "おつ,へい");

  const csv = path.join(tempDir, "glossary.csv");
  fs.writeFileSync(csv, 'Base_Ori,Ruby_Ori,Base_Trans\n【乙】【丙】,"おつ,へい",乙丙\n', "utf8");
  assert.deepEqual(loadGlossary(csv).map((entry) => [entry.original, entry.rubyOriginal, entry.translation]), [["【乙】【丙】", "おつ,へい", "乙丙"]]);
});

// 模拟 ASCII-only 导出的 xlsx：非 ASCII 字符写成数字字符引用，`&`/`<`/`>` 写成命名实体
// （真实故障表就是 openpyxl 写出的这种文件：`sheet1.xml` 里 >127 的字节数为 0）。
function asciiOnlyEscape(text) {
  return [...String(text)].map((char) => {
    if (char === "&") return "&amp;";
    if (char === "<") return "&lt;";
    if (char === ">") return "&gt;";
    return char.charCodeAt(0) > 127 ? `&#${char.charCodeAt(0)};` : char;
  }).join("");
}

test("ASCII-only 导出的 xlsx：数字字符引用要解回真实字符", async () => {
  const file = path.join(tempDir, "ascii-only.xlsx");
  await writeSparseXlsx(file, [
    HEADERS,
    ["甲系列", "【魔術】", "まじゅつ", "魔法", "", "", "术语", "", ""].map(asciiOnlyEscape),
    // 正文真想写「&#39764;」时 XML 里是 `&amp;#39764;`：只解一次，不能再退成「魔」。
    ["甲系列", asciiOnlyEscape("&#39764;"), "", "假词条", "", "", "术语", "", ""],
  ]);

  const { rows } = readSpreadsheet(file);
  assert.equal(rows[1][1], "【魔術】");
  assert.equal(rows[1][3], "魔法");
  assert.equal(rows[2][1], "&#39764;", "转义在解析时就解完了，不能再解第二次");

  const { records } = readRecords(file);
  assert.equal(records[0].base_ori, "【魔術】");
  assert.equal(records[0].base_trans, "魔法");

  // 端到端：对照表靠「按原文首字分桶 + 字面包含」匹配，未解码时条目会整体落进 `&` 桶，
  // 正文里没有任何 `&`，于是中日文条目一条都命中不了（这正是术语段整段为空的根因）。
  const { loadTermTables, findTermHits } = require("../src/workbenches/translation-compare/ai/term-table");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);
  assert.equal(tables.entries.some((entry) => entry.plainSource === "魔術" && entry.plainTarget === "魔法"), true);
  const hits = findTermHits("魔術を使う。", tables, { target: "使用魔法。" });
  assert.equal(hits.some((hit) => hit.entry.plainSource === "魔術"), true);
});
