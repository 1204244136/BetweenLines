const test = require("node:test");
const assert = require("node:assert/strict");

const {
  sliceMainDocument,
  splitParagraphs,
} = require("./text-utils");
const { epubHtmlToText } = require("./epub-utils");

test("简介后的彩页标题结束简介范围，保留全部无标题引子", () => {
  for (const [lang, title] of [["cn", "彩页"], ["tw", "彩頁"], ["cn", "插图"], ["tw", "插圖"], ["cn", "Illustrations"]]) {
    const text = epubHtmlToText(
      '<h1>简介</h1><p>这是简介中的故事介绍。</p>'
      + '<p>「简介也可以包含对话！」</p>'
      + '<h1>' + title + '</h1><p><img src="cover.jpg"/></p>'
      + '<p>调查员走进了寂静的城市。</p><p>「怎么回事？」</p>'
      + '<h1>序章</h1><p>故事转到了另一处。</p>'
      + '<h1>後記</h1><p>作者的话。</p>',
    );
    const paragraphs = splitParagraphs(sliceMainDocument(text, lang), lang);
    assert.deepEqual(paragraphs.map((p) => p.text), [
      "调查员走进了寂静的城市。", "「怎么回事？」", "故事转到了另一处。",
    ], title);
    assert.deepEqual(paragraphs.map((p) => p.sourceIndex), [0, 1, 2]);
  }
});

test("简介正文中提到彩页不结束简介过滤", () => {
  const text = ["简介", "彩页里的城市正等待主角拯救。", "序章", "这里才是真正的故事。"].join(String.fromCharCode(10, 10));
  assert.deepEqual(splitParagraphs(sliceMainDocument(text, "cn"), "cn").map((p) => p.text), ["这里才是真正的故事。"]);
});

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

test("正文起点检测：不丢弃短且无句末点号的开篇引子，标题经节号仍被保留", () => {
  // 真实形态：正文页 <h1>第一章</h1><h2>1</h2><p>欢迎，上条当麻，</p><p>欢迎来到…</p>。
  // 「欢迎，上条当麻，」既无引号也无句末点号且短于判定阈值，曾被当成非正文块，
  // 正文起点随之落到下一段，首段被整段切掉，整卷跨语言错位一行。
  const source = [
    "第一章",
    "\n\n1",
    "\n\n欢迎，上条当麻，",
    "\n\n欢迎来到绚丽多彩的Underground！",
    "\n\n「唔……」",
    "\n\n听到耳中传来的声音，上条当麻这才发现呻吟声出自自己的口中。",
  ].join("");

  const sliced = sliceMainDocument(source, "cn");
  assert.match(sliced, /^第一章/);
  const paras = splitParagraphs(sliced, "cn");
  assert.deepEqual(paras.map((p) => p.text), [
    "1",
    "欢迎，上条当麻，",
    "欢迎来到绚丽多彩的Underground！",
    "「唔……」",
    "听到耳中传来的声音，上条当麻这才发现呻吟声出自自己的口中。",
  ]);
  assert.deepEqual(paras.map((p) => p.chapter), Array(5).fill("第一章"));
});

test("正文起点检测：简介之后的弱块不被并入正文", () => {
  // 简介范围内的块即使很短也不得成为正文起点；结束它的标题才是结构性边界。
  const source = [
    "简介",
    "\n\n这是个短介绍。",
    "\n\n序章",
    "\n\n短引子。",
    "\n\n接着是一段足够长的正文内容，用来确认正文已经真正开始。",
  ].join("");

  const paras = splitParagraphs(sliceMainDocument(source, "cn"), "cn");
  assert.deepEqual(paras.map((p) => p.text), [
    "短引子。",
    "接着是一段足够长的正文内容，用来确认正文已经真正开始。",
  ]);
  assert.equal(paras[0].chapter, "序章");
});
