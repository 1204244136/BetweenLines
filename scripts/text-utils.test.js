const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sliceMainDocument,
  splitParagraphs,
} = require("./text-utils");

test("recognizes Japanese and Chinese episode headings in combined works", () => {
  const jp = splitParagraphs("第一話\n\n本文です。\n\n第二話 別の事件\n\n続きです。", "jp");
  assert.deepEqual(jp.map((paragraph) => paragraph.chapter), ["第一話", "第二話 別の事件"]);

  const cn = splitParagraphs("第一话\n\n这是正文。\n\n第2话 后续\n\n这是后续。", "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), ["第一话", "第2话 后续"]);
});

test("does not truncate a later work after an intermediate afterword", () => {
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

test("recognizes index-X prologue, intro and epilogue headings", () => {
  const cn = splitParagraphs("引子\n\n引子正文内容。\n\n序章 启程\n\n序章正文。\n\n尾声\n\n尾声叙述。", "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), ["引子", "序章 启程", "尾声"]);

  // 日文原版没有「引子」「尾声」标题文本（为无标题正文块，正文默认归属于当前章节或「正文」）
  const jp = splitParagraphs("プロローグ前の無題本文です。\n\nプロローグ\n\n始まりの本文。\n\nエピローグ\n\n終わりの本文。", "jp");
  assert.deepEqual(jp.map((paragraph) => paragraph.chapter), ["正文", "プロローグ", "エピローグ"]);
});

test("treats layered index-X chapter headings as chapter boundaries", () => {
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

test("recognizes 〇 and X chapter markers used by index-X headings", () => {
  const cn = splitParagraphs("行间X\n\n正文一。\n\n第〇九章 对抗\n\n正文二。", "cn");
  assert.deepEqual(cn.map((paragraph) => paragraph.chapter), ["行间X", "第〇九章 对抗"]);

  const jp = splitParagraphs("行間　Ｘ\n\n本文一。\n\n第〇九章　対決\n\n本文二。", "jp");
  assert.deepEqual(jp.map((paragraph) => paragraph.chapter), ["行間 Ｘ", "第〇九章 対決"]);
});
