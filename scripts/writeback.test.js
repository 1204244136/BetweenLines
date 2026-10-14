const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyTextReplacements, applySpeakerAnnotations, describeWritebackTarget } = require("../src/ingest/writeback");

// 最小解压 EPUB 夹具：正文放在两个文档里，写回必须按「行序 = 文档序 = 段落序」定位。
function epubFixture({ first = [], second = [], extra = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-fixture-"));
  fs.mkdirSync(path.join(dir, "META-INF"), { recursive: true });
  fs.mkdirSync(path.join(dir, "OEBPS", "Text"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "META-INF", "container.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n',
    "utf8",
  );
  const items = [["a", "Text/a.xhtml"], ["b", "Text/b.xhtml"]];
  fs.writeFileSync(
    path.join(dir, "OEBPS", "content.opf"),
    `<?xml version="1.0" encoding="UTF-8"?>\n<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><manifest>${items
      .map(([id, href]) => `<item id="${id}" href="${href}" media-type="application/xhtml+xml"/>`)
      .join("")}</manifest><spine>${items.map(([id]) => `<itemref idref="${id}"/>`).join("")}</spine></package>\n`,
    "utf8",
  );
  const document = (paragraphs) =>
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html>\n<html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title></head><body>\n${paragraphs
      .map((text) => `<p>${text}</p>`)
      .join("\n")}\n</body></html>\n`;
  fs.writeFileSync(path.join(dir, "OEBPS", "Text", "a.xhtml"), document(first), "utf8");
  fs.writeFileSync(path.join(dir, "OEBPS", "Text", "b.xhtml"), document(second), "utf8");
  for (const [name, content] of Object.entries(extra)) {
    fs.writeFileSync(path.join(dir, "OEBPS", "Text", name), content, "utf8");
  }
  return dir;
}

const bodyOf = (dir, name) => fs.readFileSync(path.join(dir, "OEBPS", "Text", name), "utf8");
const paragraphsOf = (dir, name) => [...bodyOf(dir, name).matchAll(/<p>([\s\S]*?)<\/p>/g)].map((match) => match[1]);

test("写回：旧短句不能越过未修改的上下文去占用后文同句", async () => {
  const dir = epubFixture({
    first: ["开场。", "问句已改。", "前文锚点。", "前段已改。", "重复句。", "中间锚点。", "重复句。", "收场。", "「？」"],
  });
  try {
    const result = await applyTextReplacements(dir, [
      { id: 5, searchText: "重复句。", replaceText: "第一处改。" },
      { id: 7, searchText: "重复句。", replaceText: "第二处改。" },
    ], { rowTexts: ["开场。", "「？」", "前文锚点。", "前段旧文。", "重复句。", "中间锚点。", "重复句。", "收场。", "「？」"] });
    assert.equal(result.updated, 2);
    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.ambiguous, []);
    assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["开场。", "问句已改。", "前文锚点。", "前段已改。", "第一处改。", "中间锚点。", "第二处改。", "收场。", "「？」"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("写回：附近重复句通过前后唯一上下文定位，单行与说话人都不误写另一处", async () => {
  for (const speaker of [false, true]) {
    const dir = epubFixture({ first: ["开场。", "重复句。", "中间锚点。", "重复句。", "收场。"] });
    try {
      const options = { rowTexts: ["开场。", "重复句。", "中间锚点。", "重复句。", "收场。"] };
      const result = speaker
        ? await applySpeakerAnnotations(dir, [{ index: 2, text: "重复句。", speaker: "甲" }], options)
        : await applyTextReplacements(dir, [{ id: 2, searchText: "重复句。", replaceText: "第一处改。" }], options);
      assert.equal(result.updated, 1);
      assert.deepEqual(result.missed, []);
      assert.deepEqual(result.ambiguous, []);
      assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["开场。", speaker ? "<!--Speaker:甲-->重复句。" : "第一处改。", "中间锚点。", "重复句。", "收场。"]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});

test("写回：源文件段落顺序与唯一上下文相反时拒写", async () => {
  const dir = epubFixture({ first: ["后文锚点。", "重复句。", "前文锚点。", "重复句。"] });
  try {
    const before = bodyOf(dir, "a.xhtml");
    const result = await applyTextReplacements(dir, [
      { id: 2, searchText: "重复句。", replaceText: "不应落盘。" },
    ], { rowTexts: ["前文锚点。", "重复句。", "后文锚点。", "重复句。"] });
    assert.equal(result.updated, 0);
    assert.equal(result.missed.length + result.ambiguous.length, 1);
    assert.equal(bodyOf(dir, "a.xhtml"), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("写回：旧目标在上下文范围内消失时不能替换后方同文", async () => {
  const dir = epubFixture({ first: ["开场。", "已修改。", "中间锚点。", "目标旧文。", "收场。"] });
  try {
    const before = bodyOf(dir, "a.xhtml");
    const result = await applyTextReplacements(dir, [
      { id: 2, searchText: "目标旧文。", replaceText: "不应落盘。" },
    ], { rowTexts: ["开场。", "目标旧文。", "中间锚点。", "目标旧文。", "收场。"] });
    assert.equal(result.updated, 0);
    assert.equal(result.missed.length, 1);
    assert.equal(bodyOf(dir, "a.xhtml"), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("写回：上下文范围内仍有两处相距较远的候选时不猜第一处", async () => {
  const dir = epubFixture({ first: ["开场。", "重复句。", "甲段已改。", "乙段已改。", "丙段已改。", "重复句。", "收场。"] });
  try {
    const before = bodyOf(dir, "a.xhtml");
    const result = await applyTextReplacements(dir, [
      { id: 2, searchText: "重复句。", replaceText: "不应落盘。" },
    ], { rowTexts: ["开场。", "重复句。", "甲段旧文。", "乙段旧文。", "丙段旧文。", "重复句。", "收场。"] });
    assert.equal(result.updated, 0);
    assert.equal(result.ambiguous.length, 1);
    assert.equal(bodyOf(dir, "a.xhtml"), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("写回：源文件新增段落后仍按精确上下文定位，不按段落号偏移", async () => {
  const dir = epubFixture({ first: ["开场。", "新增段落。", "重复句。", "中间锚点。", "重复句。", "收场。"] });
  try {
    const result = await applyTextReplacements(dir, [
      { id: 4, searchText: "重复句。", replaceText: "第二处改。" },
    ], { rowTexts: ["开场。", "重复句。", "中间锚点。", "重复句。", "收场。"] });
    assert.equal(result.updated, 1);
    assert.deepEqual(result.missed, []);
    assert.deepEqual(result.ambiguous, []);
    assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["开场。", "新增段落。", "重复句。", "中间锚点。", "第二处改。", "收场。"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("写回：中途定位失败的行不会被嫁接到后面的段落上", async () => {
  // 第二行的原文已被外部改动（页面仍持有旧文本），第三、四行是它后面真正的行。
  const dir = epubFixture({
    first: ["第一行原文。", "第二行原文。", "第三行原文。"],
    second: ["第四行原文。"],
  });
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "第一行原文。", replaceText: "第一行改后。" },
    { id: "2", searchText: "已经被改掉的旧文本。", replaceText: "第二行改后。" },
    { id: "3", searchText: "第三行原文。", replaceText: "第三行改后。" },
    { id: "4", searchText: "第四行原文。", replaceText: "第四行改后。" },
  ]);

  assert.equal(result.updated, 3);
  assert.deepEqual(result.missed.map((item) => item.index), ["2"]);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["第一行改后。", "第二行原文。", "第三行改后。"]);
  // 关键断言：第四行的内容没有因为第二行定位失败而落到第三行上。
  assert.deepEqual(paragraphsOf(dir, "b.xhtml"), ["第四行改后。"]);
});

test("写回：跨文档的孤儿行不会覆盖别的文档里的段落", async () => {
  // 页面上的第二行来自第二个文档，但那个文档的该段已被删除；
  // 旧实现在这里会一路向前匹配到第三个文档的第一段并把内容写进去。
  const dir = epubFixture({
    first: ["甲段原文。", "乙段原文。"],
    second: ["丙段原文。"],
  });
  const before = bodyOf(dir, "b.xhtml");
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "甲段原文。", replaceText: "甲段改后。" },
    { id: "2", searchText: "乙段原文。", replaceText: "乙段改后。" },
    { id: "3", searchText: "已经消失的段落。", replaceText: "丙段改后。" },
  ]);

  assert.equal(result.updated, 2);
  assert.deepEqual(result.missed.map((item) => item.index), ["3"]);
  assert.equal(bodyOf(dir, "b.xhtml"), before);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["甲段改后。", "乙段改后。"]);
});

test("写回：相距很近的重复段落报歧义而不是挑一处改", async () => {
  // 真实回归的形状：两处相同的发话段落之间只隔一句旁白，改哪一处无从判断。
  const dir = epubFixture({
    first: ["「……」", "旁白。", "「……」", "后面段落。"],
    second: [],
  });
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "「……」", replaceText: "「……（改）」" },
  ]);

  assert.equal(result.updated, 0);
  assert.deepEqual(result.missed, []);
  assert.equal(result.ambiguous.length, 1);
  assert.equal(result.ambiguous[0].index, "1");
  assert.match(result.ambiguous[0].reason, /多处同样的段落/);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["「……」", "旁白。", "「……」", "后面段落。"]);
});

test("写回：重复出现的短句按行序各归其位，就近优先", async () => {
  const dir = epubFixture({
    first: ["「……」", "甲段。", "乙段。", "丙段。", "「……」", "丁段。"],
    second: [],
  });
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "「……」", replaceText: "「……（一）」" },
    { id: "2", searchText: "「……」", replaceText: "「……（二）」" },
  ]);

  assert.equal(result.updated, 2);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["「……（一）」", "甲段。", "乙段。", "丙段。", "「……（二）」", "丁段。"]);
});

test("写回：卷内两处相同段落，只写第二处时不会落到第一处", async () => {
  // 真实回归：S3_01 的 Chapter1 里有两处独立成行的 <p>尽管如此。</p>（第 423 行与第 667 行），
  // 只写回第二处时，旧实现从卷首开始找、命中第一处并把它改掉。
  const dir = epubFixture({
    first: ["开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此。", "收场。"],
    second: [],
  });
  const rowTexts = ["开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此。"];
  const result = await applyTextReplacements(dir, [
    { id: "6", searchText: "尽管如此。", replaceText: "尽管如此（第二处改）。" },
  ], { rowTexts });

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  // 第一处（第 2 行）不动，第二处（第 6 行）才改。
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), [
    "开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此（第二处改）。", "收场。",
  ]);
});

test("写回：未改动的重复行也要按行序占住锚点", async () => {
  // 第 2、6 行都是「尽管如此。」，这次只改第 6 行。行序清单把没改动的第 2 行也插回来，
  // 第 6 行才落得到第二处；第 3~5 行照样按各自的文本推进锚点。
  const dir = epubFixture({
    first: ["开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此。", "收场。"],
    second: [],
  });
  const rowTexts = ["开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此。", "收场。"];
  const result = await applyTextReplacements(dir, [
    { id: "6", searchText: "尽管如此。", replaceText: "改后。" },
    { id: "3", searchText: "甲段。", replaceText: "甲段改后。" },
  ], { rowTexts });

  assert.equal(result.updated, 2);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), [
    "开场。", "尽管如此。", "甲段改后。", "乙段。", "丙段。", "改后。", "收场。",
  ]);
});

test("写回：没有行序清单时退化为只按条目推进（旧调用方）", async () => {
  // 服务端与页面总是带上行序清单；这里锁住缺清单时的退化行为，避免它悄悄变成乱写。
  const dir = epubFixture({
    first: ["开场。", "尽管如此。", "甲段。", "乙段。", "丙段。", "尽管如此。", "收场。"],
    second: [],
  });
  const result = await applyTextReplacements(dir, [
    { id: "6", searchText: "尽管如此。", replaceText: "尽管如此（改）。" },
  ]);

  assert.equal(result.updated, 1);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), [
    "开场。", "尽管如此（改）。", "甲段。", "乙段。", "丙段。", "尽管如此。", "收场。",
  ]);
});

test("写回：前面有同一段文字的行没能落地时报歧义，不猜第一处", async () => {
  // 第 2 行是多段行，它的第一段在原文件里已经不存在（页面快照与源文件不同步）：这一行没落地，
  // 它没占住的「同一句。」就不能被第 5 行认领为「自己那一处」——否则第 5 行的修改结果会写进
  // 第 2 行的第二段。
  const dir = epubFixture({
    first: ["开场。", "同一句。", "乙段。", "丙段。", "同一句。", "收场。"],
    second: [],
  });
  const rowTexts = ["开场。", "已经不在的段落。\n\n同一句。", "乙段。", "丙段。", "同一句。"];
  const result = await applyTextReplacements(dir, [
    { id: "5", searchText: "同一句。", replaceText: "同一句（改）。" },
  ], { rowTexts });

  assert.equal(result.updated, 0);
  assert.deepEqual(result.missed, []);
  assert.equal(result.ambiguous.length, 1);
  assert.match(result.ambiguous[0].reason, /前面有同一段文字/);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["开场。", "同一句。", "乙段。", "丙段。", "同一句。", "收场。"]);
});

test("写回：连续多段同文本与连续多行同文本一一对应时按行序落位", async () => {
  // 真实事件：某卷第二章连续三段 `<p>也就是说。</p>`，工作台这三行也连续。「近处重复即歧义」
  // 曾经让这一簇永远写不回去——两边都严格连续、数量又相等时行序已经把落位定死，应当按行序取。
  const dir = epubFixture({
    first: ["开场。", "也是。", "也是。", "也是。", "收场。"],
    second: [],
  });
  const rowTexts = ["开场。", "也是。", "也是。", "也是。", "收场。"];
  const result = await applyTextReplacements(dir, [
    { id: "3", searchText: "也是。", replaceText: "第三处改。" },
  ], { rowTexts });

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["开场。", "也是。", "第三处改。", "也是。", "收场。"]);
});

test("写回：行数与连续同文本块数对不上时仍报歧义", async () => {
  // 源文件里连续三段「也是。」，页面只有连续两行：数量对不上，落位无从确定，必须继续拒写。
  const dir = epubFixture({
    first: ["开场。", "也是。", "也是。", "也是。", "收场。"],
    second: [],
  });
  const rowTexts = ["开场。", "也是。", "也是。", "收场。"];
  const result = await applyTextReplacements(dir, [
    { id: "3", searchText: "也是。", replaceText: "也是（改）。" },
  ], { rowTexts });

  assert.equal(result.updated, 0);
  assert.equal(result.ambiguous.length, 1);
  assert.match(result.ambiguous[0].reason, /多处同样的段落|前面有同一段文字/);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["开场。", "也是。", "也是。", "也是。", "收场。"]);
});

test("写回：前面未落地的同文本簇不再连坐后面的唯一一处", async () => {
  // 真实事件：第二章连续三段 `<p>也就是说。</p>`（页面只有一行同文本，判歧义），第七章另一处
  // 同文本位置唯一、锚点刚好停在它上面，却因为全卷按文本记为「未落地」而被拒写。
  // 未落地的范围只能覆盖那一簇，候选越过之后必须照常定位。
  const dir = epubFixture({
    first: ["开场。", "同一句。", "同一句。", "同一句。", "甲段。", "乙段。", "丙段。", "丁段。", "收场。"],
    second: ["同一句。", "结尾。"],
  });
  const rowTexts = ["开场。", "同一句。", "甲段。", "乙段。", "丙段。", "丁段。", "同一句。", "结尾。"];
  const result = await applyTextReplacements(dir, [
    { id: "7", searchText: "同一句。", replaceText: "同一句（改）。" },
  ], { rowTexts });

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  // 第一节里的那一簇一段都不能动。
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["开场。", "同一句。", "同一句。", "同一句。", "甲段。", "乙段。", "丙段。", "丁段。", "收场。"]);
  assert.deepEqual(paragraphsOf(dir, "b.xhtml"), ["同一句（改）。", "结尾。"]);
});

test("写回：前面未改动的短句不能越过后面条目的目标块", async () => {
  // 页面第 2 行是「但是。」，源文件原位其实是「话说回来。」；卷末另有一处「但是。」。
  // 旧实现会让第 2 行直接吃到卷末，锚点越过第 3 行的目标块，导致真正的写回条目 missed。
  const dir = epubFixture({
    first: ["开场。", "话说回来。", "目标行。", "甲段。", "乙段。", "但是。", "收场。"],
    second: [],
  });
  const rowTexts = ["开场。", "但是。", "目标行。"];
  const result = await applyTextReplacements(dir, [
    { id: "3", searchText: "目标行。", replaceText: "目标行改后。" },
  ], { rowTexts });

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), [
    "开场。", "话说回来。", "目标行改后。", "甲段。", "乙段。", "但是。", "收场。",
  ]);
});

test("写回：同一行在同一批里出现两次时只落一次", async () => {
  const dir = epubFixture({ first: ["只有一行。"], second: [] });
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "只有一行。", replaceText: "改后。" },
    { id: "1", searchText: "只有一行。", replaceText: "改后。" },
  ]);

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["改后。"]);
});

test("写回：含内联标记的段落整段替换并保留标记", async () => {
  const dir = epubFixture({
    first: ['带<ruby>注音<rt>ルビ</rt></ruby>的段落。', "普通段落。"],
    second: [],
  });
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "带<ruby>注音<rt>ルビ</rt></ruby>的段落。", replaceText: "带<ruby>注音<rt>读音</rt></ruby>的段落改后。" },
  ]);

  assert.equal(result.updated, 1);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ['带<ruby>注音<rt>读音</rt></ruby>的段落改后。', "普通段落。"]);
});

test("写回：多段合并行按空行逐段写回", async () => {
  const dir = epubFixture({
    first: ["第一段。", "第二段。", "第三段。"],
    second: [],
  });
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "第一段。\n\n第二段。", replaceText: "第一段改后。\n\n第二段改后。" },
  ]);

  assert.equal(result.updated, 1);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["第一段改后。", "第二段改后。", "第三段。"]);
});

test("说话人写回：定位失败的行不标注，且不影响后面的行", async () => {
  const dir = epubFixture({
    first: ["「甲发言。」", "「乙发言。」", "「丙发言。」"],
    second: [],
  });
  const result = await applySpeakerAnnotations(dir, [
    { index: 1, text: "「甲发言。」", speaker: "甲" },
    { index: 2, text: "「找不到的发言。」", speaker: "乙" },
    { index: 3, text: "「丙发言。」", speaker: "丙" },
  ]);

  assert.equal(result.updated, 2);
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.missed.map((item) => item.index), [2]);
  assert.deepEqual(result.ambiguous, []);
  const html = bodyOf(dir, "a.xhtml");
  assert.match(html, /<!--Speaker:甲-->/);
  assert.match(html, /<!--Speaker:丙-->/);
  assert.doesNotMatch(html, /<!--Speaker:乙-->/);
});

test("说话人写回：同一句发话出现两次时按行序归位", async () => {
  // 卷里两处相同的发话段落（相隔较远）：只写第 5 行时，行序清单让它落到第二处。
  const dir = epubFixture({
    first: ["「……」", "甲段。", "乙段。", "丙段。", "「……」", "丁段。"],
    second: [],
  });
  const rowTexts = ["「……」", "甲段。", "乙段。", "丙段。", "「……」"];
  const result = await applySpeakerAnnotations(dir, [
    { index: 5, text: "「……」", speaker: "乙" },
  ], { rowTexts });

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  const html = bodyOf(dir, "a.xhtml");
  assert.equal((html.match(/<!--Speaker:/g) || []).length, 1);
  assert.match(html, /<p>「……」<\/p>[\s\S]*<p><!--Speaker:乙-->「……」<\/p>/);
});

test("说话人写回：前面未改动的短句不能越过后面条目的目标块", async () => {
  const dir = epubFixture({
    first: ["开场。", "话说回来。", "「目标发言。」", "甲段。", "乙段。", "「但是。」", "收场。"],
    second: [],
  });
  const rowTexts = ["开场。", "「但是。」", "「目标发言。」"];
  const result = await applySpeakerAnnotations(dir, [
    { index: 3, text: "「目标发言。」", speaker: "甲" },
  ], { rowTexts });

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  assert.match(bodyOf(dir, "a.xhtml"), /<p><!--Speaker:甲-->「目标发言。」<\/p>/);
});

test("说话人写回：已标注的段落只计 skipped，重复标注不重复写", async () => {
  const dir = epubFixture({ first: ["「甲发言。」"], second: [] });
  await applySpeakerAnnotations(dir, [{ index: 1, text: "「甲发言。」", speaker: "甲" }]);
  const again = await applySpeakerAnnotations(dir, [{ index: 1, text: "「甲发言。」", speaker: "甲" }]);

  assert.equal(again.updated, 0);
  assert.equal(again.skipped, 1);
  assert.equal((bodyOf(dir, "a.xhtml").match(/<!--Speaker:甲-->/g) || []).length, 1);
});

test("写回目标识别：解压 EPUB 目录之外的目录被拒绝", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-not-epub-"));
  const described = describeWritebackTarget(dir);
  assert.equal(described.ok, false);
  assert.match(described.message, /不是单本解压的 EPUB/);
});

test("写回：批量写回中靠后条目包含早期重复或短文本时，绝不误杀前面的条目", async () => {
  // 原文在前面有小节序号「8」，中间有正文，后面又出现小节序号「8」
  const dir = epubFixture({
    first: ["开场。", "8", "第一段正文。", "第二段正文。", "8", "结尾。"],
    second: [],
  });
  const rowTexts = ["开场。", "8", "第一段正文。", "第二段正文。", "8", "结尾。"];
  // 批量写回：同时修改第 3 行（第一段正文）和第 5 行（第二处「8」）
  const result = await applyTextReplacements(dir, [
    { id: "3", searchText: "第一段正文。", replaceText: "第一段正文改后。" },
    { id: "5", searchText: "8", replaceText: "8改后。" },
  ], { rowTexts });

  assert.equal(result.updated, 2);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), [
    "开场。", "8", "第一段正文改后。", "第二段正文。", "8改后。", "结尾。",
  ]);
});

test("写回：EPUB 目录中的 nav 导航文件不参与正文写回与定位干扰", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-nav-fixture-"));
  fs.mkdirSync(path.join(dir, "META-INF"), { recursive: true });
  fs.mkdirSync(path.join(dir, "OEBPS", "Text"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "META-INF", "container.xml"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>\n',
    "utf8",
  );
  // nav.xhtml 位于根目录（字母序优先于 OEBPS），带有 properties="nav" 且不在 spine 中
  fs.writeFileSync(
    path.join(dir, "nav.xhtml"),
    '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><nav><ol><li><a href="OEBPS/Text/chap.xhtml">8</a></li></ol></nav></html>',
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "OEBPS", "content.opf"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<package version="3.0" xmlns="http://www.idpf.org/2007/opf" unique-identifier="id"><manifest><item id="nav" href="../nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="chap" href="Text/chap.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chap"/></spine></package>\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(dir, "OEBPS", "Text", "chap.xhtml"),
    '<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>小说正文第一段。</p><p>8</p></body></html>',
    "utf8",
  );

  const rowTexts = ["小说正文第一段。", "8"];
  const result = await applyTextReplacements(dir, [
    { id: "1", searchText: "小说正文第一段。", replaceText: "小说正文第一段改后。" },
    { id: "2", searchText: "8", replaceText: "8章节标题改后。" },
  ], { rowTexts });

  assert.equal(result.updated, 2);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  // nav.xhtml 不被修改，chap.xhtml 正确修改
  const navContent = fs.readFileSync(path.join(dir, "nav.xhtml"), "utf8");
  assert.match(navContent, />8<\/a>/);
  const chapContent = fs.readFileSync(path.join(dir, "OEBPS", "Text", "chap.xhtml"), "utf8");
  assert.match(chapContent, /<p>小说正文第一段改后。<\/p>/);
  assert.match(chapContent, /<p>8章节标题改后。<\/p>/);
});


test("并发 EPUB 写回保留所有修改，文本与说话人共用队列", async () => {
  const JSZip = require("jszip");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-concurrent-"));
  const target = path.join(dir, "book.epub");
  try {
    const zip = new JSZip();
    zip.file("mimetype", "application/epub+zip");
    zip.file("chapter.xhtml", "<p>甲段。</p><p>乙段。</p><p>「对白。」</p>");
    fs.writeFileSync(target, await zip.generateAsync({ type: "nodebuffer" }));
    const results = await Promise.all([
      applyTextReplacements(target, [{ id: 1, searchText: "甲段。", replaceText: "甲段改后。" }]),
      applyTextReplacements(path.join(dir, ".", "book.epub"), [{ id: 2, searchText: "乙段。", replaceText: "乙段改后。" }]),
      applySpeakerAnnotations(target, [{ index: 3, text: "「对白。」", speaker: "角色甲" }]),
    ]);
    assert.deepEqual(results.map(result => result.updated), [1, 1, 1]);
    const saved = await JSZip.loadAsync(fs.readFileSync(target));
    assert.equal(await saved.file("chapter.xhtml").async("string"),
      "<p>甲段改后。</p><p>乙段改后。</p><p><!--Speaker:角色甲-->「对白。」</p>");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("写回队列在请求失败后继续处理后续请求", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-queue-failure-"));
  const target = path.join(dir, "sample.html");
  try {
    fs.writeFileSync(target, "<p>原段。</p>");
    const failed = applyTextReplacements(target, null);
    const success = applyTextReplacements(target, [{ id: 1, searchText: "原段。", replaceText: "改段。" }]);
    await assert.rejects(failed);
    assert.equal((await success).updated, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "<p>改段。</p>");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("TXT 写回保留 BOM、CRLF、缩进、空行与字面标签及实体", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-txt-"));
  const target = path.join(dir, "sample.txt");
  try {
    const before = "\uFEFF  首段。  \r\n \r\n  字面 <b>标签</b>与 &amp;。\r\n续行。  \r\n\r\n尾段。\r\n";
    fs.writeFileSync(target, before);
    const searchText = "字面 <b>标签</b>与 &amp;。 续行。";
    const replaceText = "保留 <b>字样</b> &amp; 与 <符号>。";
    const result = await applyTextReplacements(target, [{ id: 2, searchText, replaceText }], { rowTexts: ["首段。", searchText] });
    assert.equal(result.updated, 1);
    assert.equal(fs.readFileSync(target, "utf8"), before.replace("字面 <b>标签</b>与 &amp;。\r\n续行。", replaceText));
    await assert.rejects(applySpeakerAnnotations(target, [{ text: "首段。", speaker: "甲" }]), /暂不支持说话人写回/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("TXT 多段写回使用原生换行，不注入 HTML", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-txt-parts-"));
  const target = path.join(dir, "sample.txt");
  try {
    fs.writeFileSync(target, "首段。\r\n\r\n尾段。");
    const result = await applyTextReplacements(target, [{ id: 1, searchText: "首段。", replaceText: "改案一。\n\n改案二。" }]);
    assert.equal(result.updated, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "改案一。\r\n\r\n改案二。\r\n\r\n尾段。");
    const merged = await applyTextReplacements(target, [{ id: 1, searchText: "改案一。\r\n\r\n改案二。", replaceText: "合并改案。" }]);
    assert.equal(merged.updated, 1);
    assert.equal(fs.readFileSync(target, "utf8"), "合并改案。\r\n\r\n\r\n\r\n尾段。");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("TXT 重复段落与缺失段落拒绝猜写，字面标签不被剥离", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-txt-ambiguity-"));
  const target = path.join(dir, "sample.txt");
  try {
    const before = "同段。\n\n旁白。\n\n同段。\n\n<b>字面。</b>";
    fs.writeFileSync(target, before);
    const result = await applyTextReplacements(target, [
      { searchText: "同段。", replaceText: "改段。" },
      { searchText: "不存在。", replaceText: "改段。" },
      { searchText: "字面。", replaceText: "改段。" },
    ]);
    assert.equal(result.updated, 0);
    assert.equal(result.ambiguous.length, 1);
    assert.equal(result.missed.length, 2);
    assert.equal(fs.readFileSync(target, "utf8"), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test("写回默认关闭备份，开启 backup 选项时保留每次原始字节备份且重复写入不覆盖历史", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "writeback-backup-"));
  try {
    for (const ext of ["txt", "html", "epub"]) {
      const file = path.join(dir, "sample." + ext);
      let original = Buffer.from(ext === "txt" ? "原段。" : "<p>原段。</p>");
      if (ext === "epub") {
        const zip = new (require("jszip"))();
        zip.file("chapter.xhtml", original);
        original = await zip.generateAsync({ type: "nodebuffer" });
      }
      fs.writeFileSync(file, original);
      assert.equal((await applyTextReplacements(file, [{ searchText: "不存在。", replaceText: "不写。" }])).updated, 0);
      assert.equal(fs.existsSync(file + ".bak"), false);

      // 默认关闭备份：写回成功但不生成 .bak 文件
      await applyTextReplacements(file, [{ searchText: "原段。", replaceText: "改段一。" }]);
      assert.equal(fs.existsSync(file + ".bak"), false);

      // 显式开启 backup: true 时生成 .bak 文件并保留历史
      await applyTextReplacements(file, [{ searchText: "改段一。", replaceText: "改段二。" }], { backup: true });
      assert.equal(fs.existsSync(file + ".bak"), true);
      const intermediate = fs.readFileSync(file);
      await applyTextReplacements(file, [{ searchText: "改段二。", replaceText: "改段三。" }], { backup: true });
      const backups = fs.readdirSync(dir).filter(name => name.startsWith("sample." + ext + ".") && name.endsWith(".bak"));
      assert.equal(backups.length, 2);
      assert.deepEqual(fs.readFileSync(path.join(dir, backups.find(name => name !== "sample." + ext + ".bak"))), intermediate);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("解压 EPUB 备份失败时不修改任何正文，恢复后仍可写入", async (t) => {
  const dir = epubFixture({ first: ["甲段。"], second: ["乙段。"] });
  const first = path.join(dir, "OEBPS", "Text", "a.xhtml");
  const second = path.join(dir, "OEBPS", "Text", "b.xhtml");
  const before = [fs.readFileSync(first), fs.readFileSync(second)];
  const copyFile = fs.copyFileSync;
  const mocked = t.mock.method(fs, "copyFileSync", (source, ...args) => {
    if (source === second) throw Object.assign(new Error("备份磁盘写入失败"), { code: "EIO" });
    return copyFile(source, ...args);
  });
  try {
    await assert.rejects(applyTextReplacements(dir, [
      { id: 1, searchText: "甲段。", replaceText: "甲改。" },
      { id: 2, searchText: "乙段。", replaceText: "乙改。" },
    ], { backup: true }), /备份磁盘写入失败/);
    assert.deepEqual(fs.readFileSync(first), before[0]);
    assert.deepEqual(fs.readFileSync(second), before[1]);
    mocked.mock.restore();
    await applySpeakerAnnotations(dir, [{ index: 2, text: "乙段。", speaker: "甲" }], { backup: true });
    assert.deepEqual(fs.readFileSync(second + ".bak"), before[1]);
  } finally { mocked.mock.restore(); fs.rmSync(dir, { recursive: true, force: true }); }
});

// 真实回归：某卷三段段落尾部各带 4 个 U+200B（出版社排版残留）。提取端 `html-to-text`
// 把零宽空格当可折叠空白丢掉，工作台行文本因此不含它；写回端若照原文保留，块的可比文本
// 就与行文本对不上，批量写回后这几行一律报「未能在原文件中定位段落」。
test("写回：段落尾部的零宽空格不参与定位，且写回后仍留在原处", async () => {
  const zeroWidth = "\u200b".repeat(4);
  const dir = epubFixture({ first: [`尾零宽原文。${zeroWidth}`, `第二行原文。${zeroWidth}`], second: [] });
  const result = await applyTextReplacements(dir, [
    { id: 1, searchText: "尾零宽原文。", replaceText: "尾零宽改后。" },
  ]);

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(result.ambiguous, []);
  // 替换只覆盖可见文本：原文件里的零宽字符一个不少地留在原位。
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), [`尾零宽改后。${zeroWidth}`, `第二行原文。${zeroWidth}`]);
});

test("写回：段落中部的零宽空格按提取端口径忽略（提取端把它折成空格）", async () => {
  const dir = epubFixture({ first: ["前\u200b后原文。"], second: [] });
  const result = await applyTextReplacements(dir, [
    // 行文本来自提取端：段中的零宽空格已被折叠成普通空格。
    { id: 1, searchText: "前 后原文。", replaceText: "前 后改后。" },
  ]);

  assert.equal(result.updated, 1);
  assert.deepEqual(result.missed, []);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), ["前 后改后。"]);
});

// 零宽空格在块首/块尾都要按同一口径处理：只收缩尾部会让首部零宽字符的段落仍然定位失败。
test("写回：段落首部的零宽空格同样被忽略且保留", async () => {
  const zeroWidth = "\u200b".repeat(2);
  const dir = epubFixture({ first: [`${zeroWidth}首零宽原文。`], second: [] });
  const result = await applyTextReplacements(dir, [
    { id: 1, searchText: "首零宽原文。", replaceText: "首零宽改后。" },
  ]);

  assert.equal(result.updated, 1);
  assert.deepEqual(paragraphsOf(dir, "a.xhtml"), [`${zeroWidth}首零宽改后。`]);
});
