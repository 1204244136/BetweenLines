const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REGISTRY = "docs/contracts/documentation-tools.md";
const DOCUMENT_KINDS = new Set(["操作", "导航", "现状", "契约", "历史", "计划"]);
const TOOL_ROLES = new Set(["CLI", "兼容桥", "内部辅助", "测试夹具"]);

function withoutFences(text) {
  let fence = null;
  return String(text).split("\n").map((line) => {
    const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (!fence && match) {
      fence = { mark: match[1][0], length: match[1].length };
      return "";
    }
    if (fence) {
      if (match && match[1][0] === fence.mark && match[1].length >= fence.length && !match[2].trim()) fence = null;
      return "";
    }
    return line;
  }).join("\n");
}

function tableRows(text) {
  const rows = [];
  let header = null;
  for (const [index, line] of withoutFences(text).split("\n").entries()) {
    if (!line.trim().startsWith("|")) { header = null; continue; }
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim().replace(/^`(.*)`$/, "$1"));
    if (cells.every((cell) => /^:?-+:?$/.test(cell))) continue;
    if (!header) { header = cells; continue; }
    rows.push({ cells: Object.fromEntries(header.map((name, i) => [name, cells[i] || ""])), line: index + 1 });
  }
  return rows;
}

function npmCommands(text) {
  return [...String(text).matchAll(/\bnpm\s+(?:run\s+([\w:-]+)|(?:test|t)(?=[\s`]|$))/g)].map((match) => ({
    name: match[1] || "test", line: String(text).slice(0, match.index).split("\n").length,
  }));
}

function directEntryPaths(scripts) {
  return Object.values(scripts).flatMap((command) => [...String(command).replace(/\\/g, "/")
    .matchAll(/(?:^|[\s"';&])((?:\.\/)?(?:src|scripts)\/[^\s"';&]+\.(?:js|py|ps1))(?=[\s"';&]|$)/g)]
    .map((match) => match[1].replace(/^\.\//, ""))
    .filter((file) => !/[*?\[\]{}]/.test(file)));
}

function isTool(file, sourceTools) {
  return !/\.test\.js$/i.test(file) && (
    /^scripts\/.*\.(?:js|py|ps1)$/i.test(file)
    || /^[^/]+\.(?:bat|py)$/i.test(file)
    || sourceTools.has(file)
  );
}

function markdownTargets(text) {
  const plain = withoutFences(text);
  const targets = [];
  const patterns = [
    /!?\[[^\]\n]*\]\(\s*(<[^>\n]*>(?:\s+["'][^)\n]*["'])?|[^)\n]*)\)/g,
    /^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]*>|\S+)/gm,
  ];
  for (const pattern of patterns) for (const match of plain.matchAll(pattern)) {
    const raw = match[1].trim();
    targets.push({ target: raw.startsWith("<") ? raw.slice(1, raw.indexOf(">")) : raw.split(/\s/)[0], line: plain.slice(0, match.index).split("\n").length });
  }
  return targets;
}

// Injectable file contents keep regression tests independent of Git and local inputs.
function checkRepository({ files, packageData, registryFile = REGISTRY }) {
  const contents = files instanceof Map ? files : new Map(Object.entries(files));
  const knownFiles = new Set(contents.keys());
  const scripts = packageData?.scripts || {};
  const entryPaths = new Set(directEntryPaths(scripts));
  const sourceTools = new Set([...entryPaths].filter((file) => file.startsWith("src/")));
  const documents = [...knownFiles].filter((file) => /\.md$/i.test(file));
  const tools = [...knownFiles].filter((file) => isTool(file, sourceTools));
  const expected = new Set([...documents, ...tools]);
  const errors = [];
  const report = (code, file, line, message) => errors.push({ code, file, line, message });
  const registered = new Set();
  const aliases = new Map();

  if (!contents.has(registryFile)) report("missing-registry", registryFile, 1, "缺少文档与工具职责登记表");
  for (const row of tableRows(contents.get(registryFile) || "")) {
    const entry = row.cells;
    if (Object.hasOwn(entry, "路径")) {
      const file = entry["路径"];
      if (registered.has(file)) report("duplicate", registryFile, row.line, `路径重复登记：${file}`);
      registered.add(file);
      if (!knownFiles.has(file)) report("missing-path", registryFile, row.line, `登记路径不存在或不在 Git 可见范围：${file}`);
      else if (!expected.has(file)) report("outside-inventory", registryFile, row.line, `登记路径不是文档或工具：${file}`);
      if (/\.md$/i.test(file)) {
        if (!DOCUMENT_KINDS.has(entry["类别"]) || !entry["唯一职责 / 边界"]) report("missing-boundary", registryFile, row.line, `文档缺少有效类别或职责：${file}`);
      } else if (!TOOL_ROLES.has(entry["角色"]) || !entry["实现 / 下游入口"] || !entry["输入与副作用边界"]) {
        report("missing-boundary", registryFile, row.line, `工具缺少角色、下游或副作用边界：${file}`);
      }
    }
    if (entry["npm script"] && entry["兼容别名目标"]) {
      const name = entry["npm script"];
      const target = entry["兼容别名目标"];
      if (aliases.has(name)) report("duplicate-alias", registryFile, row.line, `npm 别名重复登记：${name}`);
      aliases.set(name, target);
      if (!Object.hasOwn(scripts, name) || !Object.hasOwn(scripts, target) || scripts[name].trim() !== `npm run ${target}`) {
        report("invalid-alias", registryFile, row.line, `npm 别名与 package.json 不一致：${name} → ${target}`);
      }
    }
  }
  for (const file of expected) if (!registered.has(file)) report("unregistered", file, 1, "文档或工具没有职责登记");
  for (const file of entryPaths) if (!knownFiles.has(file)) report("missing-script-path", "package.json", 1, `npm 入口不存在：${file}`);

  const commandGraph = new Map(Object.entries(scripts).map(([name, command]) => [name, npmCommands(command).map((entry) => entry.name)]));
  for (const [name, targets] of commandGraph) for (const target of targets) {
    if (!commandGraph.has(target)) report("unknown-npm-target", "package.json", 1, `npm 转发目标不存在：${name} → ${target}`);
  }
  const visited = new Set();
  const active = [];
  function visitCommand(name) {
    const cycleStart = active.indexOf(name);
    if (cycleStart >= 0) {
      report("cyclic-npm", "package.json", 1, `npm 命令循环调用：${[...active.slice(cycleStart), name].join(" → ")}`);
      return;
    }
    if (visited.has(name) || !commandGraph.has(name)) return;
    active.push(name);
    for (const target of commandGraph.get(name)) visitCommand(target);
    active.pop();
    visited.add(name);
  }
  for (const name of commandGraph.keys()) visitCommand(name);

  for (const file of documents) {
    const content = contents.get(file) || "";
    for (const { name, line } of npmCommands(content)) if (!Object.hasOwn(scripts, name)) report("unknown-npm", file, line, `npm script 不存在：${name}`);
    for (const { target, line } of markdownTargets(content)) {
      if (!target || target.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      let decoded;
      try { decoded = decodeURIComponent(target.split(/[?#]/)[0]); }
      catch { report("invalid-link", file, line, `链接编码无效：${target}`); continue; }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), decoded.replace(/\\/g, "/"))).replace(/\/$/, "");
      if (path.posix.isAbsolute(decoded) || resolved === ".." || resolved.startsWith("../")) {
        report("outside-link", file, line, `本地链接越出仓库：${target}`);
      } else if (resolved !== "." && !knownFiles.has(resolved) && ![...knownFiles].some((name) => name.startsWith(`${resolved}/`))) {
        report("broken-link", file, line, `本地链接目标不存在：${target}`);
      }
    }
  }
  const readmeCommands = new Set(npmCommands(contents.get("README.md") || "").map(({ name }) => name));
  for (const name of Object.keys(scripts)) if (!readmeCommands.has(name) && !aliases.has(name)) {
    report("undocumented-npm", "README.md", 1, `npm script 缺少用法或兼容别名声明：${name}`);
  }
  return { errors, documentCount: documents.length, toolCount: tools.length, scriptCount: Object.keys(scripts).length };
}

function main(root = path.resolve(__dirname, "..")) {
  const names = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0").filter((file) => file && fs.existsSync(path.join(root, file)));
  const files = new Map(names.map((file) => [file, /\.md$/i.test(file) && !file.startsWith("out/") ? fs.readFileSync(path.join(root, file), "utf8") : ""]));
  const packageData = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const result = checkRepository({ files, packageData });
  for (const error of result.errors) console.error(`${error.file}:${error.line} [${error.code}] ${error.message}`);
  if (!result.errors.length) console.log(`文档与工具覆盖检查通过：${result.documentCount} 份文档、${result.toolCount} 个工具、${result.scriptCount} 个 npm scripts。`);
  process.exitCode = result.errors.length ? 1 : 0;
  return result;
}

if (require.main === module) {
  try { main(); }
  catch (error) { console.error(`文档与工具覆盖检查失败：${error.message}`); process.exitCode = 1; }
}

module.exports = { checkRepository, main };
