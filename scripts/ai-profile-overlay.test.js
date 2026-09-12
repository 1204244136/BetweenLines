const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 叠加（extends）语义：本机档案只写差异字段，注册表把它合并进基底并沿用基底的 id。
// 全程使用自建基底，断言与本机 profiles/local/ 里有什么无关，换台机器跑结果一样。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-overlay-"));
const baseFile = path.join(tempDir, "overlay-base.js");
const patchFile = path.join(tempDir, "overlay-patch.js");
const danglingFile = path.join(tempDir, "overlay-dangling.js");
const redundantIdFile = path.join(tempDir, "overlay-redundant-id.js");
const baseTermsFile = path.join(tempDir, "overlay-terms-base.csv");
const extraTermsFile = path.join(tempDir, "overlay-terms-extra.csv");

fs.writeFileSync(baseFile, [
  "module.exports = {",
  '  id: "overlay-base",',
  '  name: "叠加基底（测试）",',
  '  summary: "基底自己的说明。",',
  "  termTables: [", `    ${JSON.stringify(baseTermsFile)},`, "  ],",
  "  sections: [",
  "    {",
  '      title: "基底小节",',
  '      lines: ["基底原始规则，应当被叠加档案替换。", "基底未被覆盖的规则。"],',
  "    },",
  "  ],",
  "};",
].join("\n"), "utf8");

// 叠加档案故意不写 id：它不是一个新档案，只是这一份档案的本机版本。
fs.writeFileSync(patchFile, [
  "module.exports = {",
  '  extends: "overlay-base",',
  '  name: "叠加档案（测试）",',
  '  summary: "叠加档案自己的说明。",',
  "  termTables: [", `    ${JSON.stringify(extraTermsFile)},`, "  ],",
  '  speechHabitScope: "volume",',
  "  sections: [",
  "    {",
  '      title: "基底小节",',
  '      lines: ["替换后的基底规则。"],',
  "    },",
  "    {",
  '      title: "叠加小节",',
  '      lines: ["叠加档案追加的规则。"],',
  "    },",
  "  ],",
  "};",
].join("\n"), "utf8");

// 叠加到不存在的基底：必须只告警并跳过，不能把坏档案拖成"另一份看起来正常的档案"。
fs.writeFileSync(danglingFile, [
  "module.exports = {",
  '  extends: "并没有这个档案",',
  '  name: "悬空叠加（测试）",',
  "  sections: [{ title: \"悬空小节\", lines: [\"不该出现在注册表里。\"] }],",
  "};",
].join("\n"), "utf8");

// 老写法（自带 id + extends）不该静默改语义：id 被忽略，但要告警说明。
fs.writeFileSync(redundantIdFile, [
  "module.exports = {",
  '  extends: "overlay-base",',
  '  id: "overlay-renamed",',
  "};",
].join("\n"), "utf8");

fs.writeFileSync(baseTermsFile, "Base_Ori,Base_Trans,Type\n【基底】,【基底译名】,术语\n", "utf8");
fs.writeFileSync(extraTermsFile, "Base_Ori,Base_Trans,Type\n【追加】,【追加译名】,术语\n", "utf8");

process.env.TRANSCOMPARATOR_PROFILE_FILES = [baseFile, patchFile, danglingFile, redundantIdFile].join(";");

// 加载期的告警在 require 时就发生了，先接管 console.warn 才能断言它。
const warnings = [];
const originalWarn = console.warn;
console.warn = (...args) => warnings.push(args.join(" "));
const { listProfiles, proofreadPromptFor, resolveProfile } = require("../src/workbenches/translation-compare/ai/proofread-contract");
const { clientStatus } = require("./ai-proofread");
console.warn = originalWarn;

test.after(() => {
  delete process.env.TRANSCOMPARATOR_PROFILE_FILES;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("叠加档案沿用基底 id：下拉里不会多出一份内容相同的档案", () => {
  const ids = listProfiles().map((profile) => profile.id);
  assert.equal(new Set(ids).size, ids.length, "下拉项 id 必须唯一");
  assert.equal(ids.includes("overlay-base"), true);
  assert.equal(ids.filter((id) => id === "overlay-base").length, 1);
  // 叠加档案没有自己的 id：它替换的是基底那一条，而不是另立一条。
  assert.equal(ids.includes("overlay-patch"), false);
  assert.equal(listProfiles().length, new Set(ids).size);
  // 叠加档案的名字接管了基底槽位，所以用户选到的那一项就是本机版本。
  assert.equal(listProfiles().find((profile) => profile.id === "overlay-base").name, "叠加档案（测试）");
});

test("叠加只覆盖显式声明的字段，其余沿用基底", () => {
  const merged = resolveProfile("overlay-base");
  // 显式声明：覆盖。
  assert.equal(merged.name, "叠加档案（测试）");
  assert.equal(merged.summary, "叠加档案自己的说明。");
  assert.equal(merged.speechHabitScope, "volume");
  assert.deepEqual(merged.termTables, [baseTermsFile, extraTermsFile]);
  // sections 按小节标题合并：同名小节被替换，不同名小节追加，基底其余小节保留。
  assert.deepEqual(merged.sections.map((section) => section.title), ["基底小节", "叠加小节"]);
  assert.deepEqual(merged.sections[0].lines, ["替换后的基底规则。"]);
  assert.deepEqual(merged.sections[1].lines, ["叠加档案追加的规则。"]);
  // 叠加档案不是一个新档案：id 与模块标识都跟着基底走。
  assert.equal(merged.id, "overlay-base");
  assert.equal(merged.marker, "【成品校对规范：叠加档案（测试）】");
  assert.equal("extends" in merged, false, "extends 只用于定位基底，不应留在档案上");
});

test("叠加后的提示词与辅助数据一起生效", () => {
  const prompt = proofreadPromptFor("bilingual", "overlay-base").profileSystem;
  assert.match(prompt, /【成品校对规范：叠加档案（测试）】/);
  assert.match(prompt, /叠加档案追加的规则。/);
  assert.match(prompt, /替换后的基底规则。/);
  // 同一小节的旧版本必须被替换掉，而不是两版规则同时进提示词。
  assert.doesNotMatch(prompt, /基底原始规则，应当被叠加档案替换。/);

  // 表按"再补一层"合并：基底的表继续生效，多出来的那一张一起加载。
  const status = clientStatus({ includeResults: false, profileId: "overlay-base" }).termTableStatus;
  assert.equal(status.files.length, 2);
  assert.equal(status.entries, 2);
  assert.deepEqual(status.errors, []);
});

test("叠加到不存在的基底时只告警并跳过", () => {
  assert.equal(listProfiles().some((profile) => profile.name === "悬空叠加（测试）"), false);
  assert.equal(resolveProfile("并没有这个档案").id, "novel", "坏叠加不得凭空造出档案，未知 id 仍回落默认");
  assert.equal(warnings.some((line) => line.includes("并没有这个档案")), true, "跳过的坏叠加必须留下告警");
});

test("叠加档案自带的 id 被忽略，但必须告警说明", () => {
  // 叠加档案不是一个新档案，id 由基底决定；老写法（自带 id + extends）不能让用户以为改名成功了。
  assert.equal(listProfiles().some((profile) => profile.id === "overlay-renamed"), false);
  assert.equal(warnings.some((line) => line.includes("overlay-renamed") && line.includes("已被忽略")), true);
  assert.equal(resolveProfile("overlay-base").name, "叠加档案（测试）");
});
