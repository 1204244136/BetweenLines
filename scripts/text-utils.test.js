const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sliceMainDocument,
  splitParagraphs,
} = require("./text-utils");

test("识别合卷作品中的中日文章节/话数标题", () => {
  const jp = splitParagraphs("第一話\n\n本文です。\n\n第二話 別の事件\n\n続きです。", "jp");
  assert.deepEqual(jp.map((paragraph) => paragraph.chapter), ["第一話", "第二話 別の事件"]);

  const cn = splitParagraphs("第一话\n\n这是正文。\n\n第2话 后续\n\n这是后续。", "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), ["第一话", "第2话 后续"]);
});

test("遇到中途后记时不截断后续作品的正文", () => {
  const source = [
    "第一章",
    "\n\n第一部正文内容足够长，可以被正文检测逻辑识别。",
    "\n\nあとがき",
    "\n\n第一部后记。",
    "\n\n第二話",
    "\n\n第二部正文内容足够长，可以被正文检测逻辑识别。",
    "\n\nあとがき",
    "\n\n最终后记。",
  ].join("");

  const sliced = sliceMainDocument(source, "jp");
  assert.match(sliced, /第二部正文/);
  assert.doesNotMatch(sliced, /最终后记/);
});

test("识别 index-X 的引子、序章与尾声标题", () => {
  const cn = splitParagraphs("引子\n\n引子正文内容。\n\n序章 启程\n\n序章正文。\n\n尾声\n\n尾声叙述。", "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), ["引子", "序章 启程", "尾声"]);

  // 日文原版没有「引子」「尾声」标题文本（为无标题正文块，正文默认归属于当前章节或「正文」）
  const jp = splitParagraphs("プロローグ前の無題本文です。\n\nプロローグ\n\n始まりの本文。\n\nエピローグ\n\n終わりの本文。", "jp");
  assert.deepEqual(jp.map((paragraph) => paragraph.chapter), ["正文", "プロローグ", "エピローグ"]);
});

test("将多层 index-X 章节标题视为章节边界", () => {
  // 层间空格连接后的标题形态（见 epub-utils 的标题分层处理）
  const source = [
    "行间　一",
    "\n\n行间正文。",
    "\n\n第一章 简直就像是游乐园一般 Red_Wear,Big_Bag,and_Flying_Sledge.",
    "\n\n第一章正文。",
  ].join("");

  const cn = splitParagraphs(source, "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.text), ["行间正文。", "第一章正文。"]);
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), [
    "行间 一",
    "第一章 简直就像是游乐园一般 Red_Wear,Big_Bag,and_Flying_Sledge.",
  ]);
});

test("识别 index-X 标题中使用的 〇 与 X 章节编号标记", () => {
  const cn = splitParagraphs("行间X\n\n正文一。\n\n第〇九章 对抗\n\n正文二。", "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), ["行间X", "第〇九章 对抗"]);

  const jp = splitParagraphs("行間　Ｘ\n\n本文一。\n\n第〇九章　対決\n\n本文二。", "jp");
  assert.deepEqual(jp.map((paragraph) => paragraph.chapter), ["行間 Ｘ", "第〇九章 対決"]);
});

test("正文起点检测：保留短于 18 字的开篇对话段落且不将其当作前言过滤", () => {
  const source = [
    "目錄",
    "\n\n序章　四名少女",
    "\n\n第一章　白井黑子毫不猶豫",
    "\n\n「啊，御坂學姊！這裡這裡！」",
    "\n\n身穿制服的佐天淚子，下意識地起身朝對方揮手。在放學後的鬧區若不做到這種地步，就算待在同個地方也很容易錯過彼此。",
  ].join("");

  const sliced = sliceMainDocument(source, "tw");
  assert.match(sliced, /「啊，御坂學姊！這裡這裡！」/);
  const paras = splitParagraphs(sliced, "tw");
  assert.equal(paras[0].text, "「啊，御坂學姊！這裡這裡！」");
});

test("正文起点检测：保留紧挨正文开篇的章节标题而非切除降级为正文", () => {
  const source = [
    "彩页",
    "\n\n序章 四位少女",
    "\n\n「学姐，御坂学姐！看这边！我们在这！」",
    "\n\n身穿校服的佐天泪子下意识地从座位上站了起来，使劲地挥着手。",
  ].join("");

  const sliced = sliceMainDocument(source, "cn");
  assert.match(sliced, /^序章 四位少女/);
  const paras = splitParagraphs(sliced, "cn");
  assert.equal(paras[0].chapter, "序章 四位少女");
  assert.equal(paras[0].text, "「学姐，御坂学姐！看这边！我们在这！」");
});
