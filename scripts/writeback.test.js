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
