const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  clientGuids,
  pathToDirectory,
  pickerPathsFile,
  readPickerPaths,
  rememberPickerDir,
  resolvePickDir,
  roleClientGuid,
} = require("../src/runtime/picker-paths");

// 每个用例一个独立数据目录：默认目录记忆落在临时目录，测试不碰 out/ 下的用户数据。
function useFreshDataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "between-lines-data-"));
  process.env.TRANSCOMPARATOR_DATA_DIR = dir;
  return dir;
}

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `between-lines-${name}-`));
}

test("系统选择窗口脚本按入口接收起始目录，并保持 UTF-8 BOM", () => {
  const file = path.join(__dirname, "..", "scripts", "windows-path-picker.ps1");
  const bytes = fs.readFileSync(file);
  // Windows PowerShell 5.1 按 ANSI 读取无 BOM 文件，脚本里的中文标题会直接编译失败。
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  const source = bytes.toString("utf8");
  // SetFolder 覆盖系统记住的上次位置；SetDefaultFolder 只在没有记忆时才生效，达不到分入口的目的。
  assert.match(source, /SHCreateItemFromParsingName/);
  assert.match(source, /dialog\.SetFolder\(/);
  // 接口声明里必须有 SetDefaultFolder（COM 顺序），但调用只允许 SetFolder。
  assert.doesNotMatch(source, /dialog\.SetDefaultFolder\(/);
  assert.match(source, /\[string\]\$InitialDir/);
  assert.match(source, /\[string\]\$ClientGuid/);
});

test("三个导入入口各自使用独立的 ClientGuid", () => {
  const guids = ["jp", "cn", "tw"].map(roleClientGuid);
  assert.equal(new Set(guids).size, 3);
  assert.equal(roleClientGuid("jp"), clientGuids.jp);
  assert.equal(roleClientGuid("CN"), clientGuids.cn);
  // 未识别角色不新增 GUID，回落到历史默认值（jp 沿用旧 GUID，已存在的系统记忆不丢）。
  assert.equal(roleClientGuid("other"), clientGuids.jp);
  assert.equal(roleClientGuid(undefined), clientGuids.jp);
});

test("默认目录取文件所在目录、目录自身，路径失效时退回仍存在的父目录", () => {
  const root = tempDir("paths");
  const folder = path.join(root, "book");
  fs.mkdirSync(folder);
  const file = path.join(folder, "book.epub");
  fs.writeFileSync(file, "x");

  assert.equal(pathToDirectory(folder), folder);
  assert.equal(pathToDirectory(file), folder);
  // 文件已删除时仍能回到它原来所在的目录。
  assert.equal(pathToDirectory(path.join(folder, "gone.epub")), folder);
  assert.equal(pathToDirectory(""), "");
  assert.equal(pathToDirectory(path.join(root, "missing", "deep", "gone.epub")), "");
});

test("默认目录按入口分别记忆，已删除的目录不再参与", () => {
  useFreshDataDir();
  const root = tempDir("memory");
  const jpFolder = path.join(root, "jp");
  const cnFolder = path.join(root, "cn");
  fs.mkdirSync(jpFolder);
  fs.mkdirSync(cnFolder);
  const jpFile = path.join(jpFolder, "original.epub");
  fs.writeFileSync(jpFile, "x");

  assert.equal(rememberPickerDir("jp", jpFile), jpFolder);
  assert.equal(rememberPickerDir("cn", cnFolder), cnFolder);
  assert.deepEqual(readPickerPaths(), { jp: jpFolder, cn: cnFolder });
  assert.deepEqual(JSON.parse(fs.readFileSync(pickerPathsFile(), "utf8")), { jp: jpFolder, cn: cnFolder });

  // 目录被删除后不能再作为默认位置，否则选择窗口只会退回系统记忆。
  fs.rmSync(cnFolder, { recursive: true });
  assert.deepEqual(readPickerPaths(), { jp: jpFolder });
  assert.equal(rememberPickerDir("tw", ""), "");
  assert.equal(rememberPickerDir("", jpFolder), "");
  assert.deepEqual(readPickerPaths(), { jp: jpFolder });
});

test("起始目录优先级：当前卡片路径 > 该入口记忆 > 已登记选择", () => {
  useFreshDataDir();
  const root = tempDir("priority");
  const cardFolder = path.join(root, "card");
  const memoryFolder = path.join(root, "memory");
  const savedFolder = path.join(root, "saved");
  for (const folder of [cardFolder, memoryFolder, savedFolder]) fs.mkdirSync(folder);
  const savedSelection = { files: { jp: path.join(savedFolder, "saved.epub") } };

  assert.equal(resolvePickDir("jp", { savedSelection }), savedFolder);
  rememberPickerDir("jp", memoryFolder);
  assert.equal(resolvePickDir("jp", { savedSelection }), memoryFolder);
  assert.equal(
    resolvePickDir("jp", { currentPath: path.join(cardFolder, "card.epub"), savedSelection }),
    cardFolder,
  );
  // 未识别角色不猜目录，保持系统默认行为。
  assert.equal(resolvePickDir("", { currentPath: cardFolder }), "");
  // 记忆文件损坏时退回已登记选择，而不是让页面报错。
  fs.writeFileSync(pickerPathsFile(), "{ not json");
  assert.equal(resolvePickDir("jp", { savedSelection }), savedFolder);
});
