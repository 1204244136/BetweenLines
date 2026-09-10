const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { execFileSync } = require("child_process");

function cellText(value) { return String(value ?? "").replace(/^\uFEFF/, "").trim(); }
function normalizeEntry(row) {
  if (!row || typeof row !== "object") return null;
  const original = cellText(row.original ?? row.base_ori ?? row.source ?? row.jp ?? row["原名"]);
  const translation = cellText(row.translation ?? row.base_trans ?? row.target ?? row.cn ?? row["译名"]);
  if (!original || !translation) return null;
  return { original, translation, rubyOriginal: cellText(row.rubyOriginal ?? row.ruby_ori), rubyTranslation: cellText(row.rubyTranslation ?? row.ruby_trans), type: cellText(row.type) };
}
function parseDelimited(text) {
  const lines = text.split(/\r?\n/).filter(Boolean); if (!lines.length) return [];
  const split = l => l.split(/\t|,/).map(cellText); const head = split(lines[0]);
  return lines.slice(1).map(l => { const v=split(l); return normalizeEntry(Object.fromEntries(head.map((h,i)=>[h,v[i]]))); }).filter(Boolean);
}
function loadGlossary(file) {
  if (!file) return [];
  const ext = path.extname(file).toLowerCase();
  if (ext === ".json") { const data=JSON.parse(fs.readFileSync(file,"utf8")); return (Array.isArray(data)?data:(data.entries||[])).map(normalizeEntry).filter(Boolean); }
  if ([".csv",".tsv",".txt"].includes(ext)) return parseDelimited(fs.readFileSync(file,"utf8"));
  if (ext === ".xlsx") {
    try { const out = execFileSync("python", ["-c", "import zipfile,xml.etree.ElementTree as E,json,sys;z=zipfile.ZipFile(sys.argv[1]);n={'a':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'};s=[];r=E.fromstring(z.read('xl/sharedStrings.xml'));s=[''.join(t.text or '' for t in x.iter('{%s}t'%n['a'])) for x in r];r=E.fromstring(z.read('xl/worksheets/sheet1.xml'));rows=[];\nfor row in r.findall('.//a:row',n): rows.append([s[int(c.find('a:v',n).text)] if c.attrib.get('t')=='s' else (c.find('a:v',n).text if c.find('a:v',n) is not None else '') for c in row.findall('a:c',n)]); print(json.dumps(rows,ensure_ascii=False))", file], {encoding:"utf8"}); const rows=JSON.parse(out); const head=rows.shift()||[]; return rows.map(r=>normalizeEntry(Object.fromEntries(head.map((h,i)=>[h,r[i]])))).filter(Boolean); } catch {}
  }
  return [];
}
function glossaryPrompt(entries) { if (!entries.length) return ""; return "术语表（仅用于一致性参考；原文优先，不能机械替换）：\n" + entries.map(e => `- ${e.original} → ${e.translation}${e.rubyTranslation ? `（注音：${e.rubyTranslation}）` : ""}`).join("\n"); }
module.exports = { loadGlossary, glossaryPrompt, normalizeEntry };
