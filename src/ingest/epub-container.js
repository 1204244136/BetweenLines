const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");
const { XMLParser, XMLValidator } = require("fast-xml-parser");
const { storageLayout } = require("../core/storage-layout");
const { asArray } = require("../core/text-helpers");

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "", removeNSPrefix: true });

function isEpubDirectory(file) {
  try {
    return fs.statSync(file).isDirectory() && fs.statSync(path.join(file, "META-INF", "container.xml")).isFile();
  } catch {
    return false;
  }
}

function isEpubInput(file) {
  return Boolean(file) && (isEpubDirectory(file) || /\.epub$/i.test(file));
}

// All callers use relative EPUB paths. Never follow a link outside a local book.
function directoryEntries(dir) {
  const entries = [];
  function visit(current, prefix = "") {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const file = path.join(current, entry.name);
      const relativePath = `${prefix}${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error("EPUB 文件夹不能包含符号链接或目录联接。");
      if (entry.isDirectory()) visit(file, `${relativePath}/`);
      else if (entry.isFile()) entries.push({ path: relativePath, file, size: fs.statSync(file).size });
      else throw new Error("EPUB 文件夹只能包含普通文件和目录。");
    }
  }
  visit(dir);
  return entries;
}

async function loadEpubArchive(file) {
  if (!fs.statSync(file).isDirectory()) return JSZip.loadAsync(fs.readFileSync(file));
  if (!isEpubDirectory(file)) throw new Error("请选择单本解压 EPUB 的根目录（包含 META-INF/container.xml），而非书库或 OEBPS 子目录。");
  const zip = new JSZip();
  // EPUB requires the mimetype entry to be first and uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  for (const entry of directoryEntries(file)) {
    if (entry.path !== "mimetype") zip.file(entry.path, fs.readFileSync(entry.file));
  }
  await validateEpubArchive(zip);
  return zip;
}

async function validateEpubArchive(zip) {
  async function xml(name) {
    const entry = zip.file(name);
    if (!entry) throw new Error(`EPUB 文件夹缺少 ${name}。`);
    const text = await entry.async("string");
    if (XMLValidator.validate(text) !== true) throw new Error(`EPUB 文件夹中的 XML 无效：${name}`);
    return parser.parse(text);
  }
  const container = await xml("META-INF/container.xml");
  const opfPath = asArray(container.container?.rootfiles?.rootfile)[0]?.["full-path"];
  if (typeof opfPath !== "string" || !opfPath) throw new Error("EPUB container.xml 缺少 OPF 路径。");
  const opf = await xml(opfPath);
  const manifest = new Map(asArray(opf.package?.manifest?.item).map((item) => [item.id, item]));
  let documents = 0;
  for (const ref of asArray(opf.package?.spine?.itemref)) {
    if (String(ref.linear || "yes").toLowerCase() === "no") continue;
    const item = manifest.get(ref.idref);
    if (!item) throw new Error(`EPUB spine 引用了不存在的 manifest 项：${ref.idref}`);
    if (!/x?html/i.test(item["media-type"] || "")) continue;
    const href = String(item.href || "").split("#")[0].replace(/\\/g, "/");
    const documentPath = path.posix.join(path.posix.dirname(opfPath), href);
    if (!href || !zip.file(documentPath)) throw new Error(`EPUB 文件夹缺少正文文档：${documentPath}`);
    documents += 1;
  }
  if (!documents) throw new Error("EPUB OPF 中没有可读取的 spine 正文文档。");
}

async function withEpubFile(file, read) {
  if (!fs.statSync(file).isDirectory()) return read(file);
  const zip = await loadEpubArchive(file);
  const workDir = storageLayout().workDir;
  fs.mkdirSync(workDir, { recursive: true });
  const temporaryDir = fs.mkdtempSync(path.join(workDir, "epub-directory-"));
  try {
    const packed = path.join(temporaryDir, "input.epub");
    fs.writeFileSync(packed, await zip.generateAsync({ type: "nodebuffer", compression: "STORE" }));
    return await read(packed);
  } finally {
    // This exact directory was created above, under the runtime workspace.
    fs.rmSync(temporaryDir, { recursive: true, force: true });
  }
}

module.exports = { directoryEntries, isEpubDirectory, isEpubInput, loadEpubArchive, validateEpubArchive, withEpubFile };
