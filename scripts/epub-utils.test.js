const assert = require("node:assert/strict");
const test = require("node:test");

const {
  epubHtmlToText,
  extractNoterefMarkup,
  joinHeadingLayers,
  restorePandocNoterefMarkup,
} = require("./epub-utils");

const originalNoteref = '<a class="nodeco" epub:type="noteref" href="S4_03-Note.xhtml#note6"><sup>㊟</sup></a>';

test("EPUB 转换默认保留完整的 noteref 注释标记", () => {
  const text = epubHtmlToText(`<p>before ${originalNoteref} after</p>`);

  assert.equal(text, `before ${originalNoteref} after`);
});

test("EPUB 转换移除普通超链接锚点标记", () => {
  const text = epubHtmlToText('<p>before <a href="chapter.xhtml">link</a> after</p>');

  assert.equal(text, "before link after");
});

test("EPUB 转换可在保留可见符号的同时移除 noteref 标记", () => {
  const text = epubHtmlToText(`<p>before ${originalNoteref} after</p>`, { inlineMarkup: { noteref: false } });

  assert.equal(text, "before ㊟ after");
});

test("将 Pandoc 转换后的 noteref 标记还原为原始 EPUB 标记", () => {
  const pandoc = '<p>text<a href="#S4_03-Note.xhtml_note6" class="nodeco noteref"><sup>㊟</sup></a></p>';
  const restored = restorePandocNoterefMarkup(pandoc, extractNoterefMarkup(originalNoteref));

  assert.equal(restored, `<p>text${originalNoteref}</p>`);
});

// 分层标题在 XHTML 中不写分隔符，视觉换行由 CSS 承担；还原成纯文本时必须按层用单个空格连接。
const layeredHeading =
  '<h1 class="heading-lines"><span class="heading-main">第一章</span>'
  + '<span class="heading-subtitle font08">简直就像是游乐园一般</span>'
  + '<span class="heading-code font06">Red_Wear,Big_Bag,and_Flying_Sledge.</span></h1>';

test("多层标题 span 之间以单个空格连接", () => {
  assert.equal(
    epubHtmlToText(layeredHeading),
    "第一章 简直就像是游乐园一般 Red_Wear,Big_Bag,and_Flying_Sledge.",
  );
});

test("保持单层标题与日文标题原样不变", () => {
  assert.equal(epubHtmlToText("<h1>行间　一</h1>"), "行间　一");
  assert.equal(epubHtmlToText("<h1>第一章　まるで遊園地のような</h1>"), "第一章　まるで遊園地のような");
});

test("将未包裹 span 的标题主文本与后续层级 span 正确连接", () => {
  assert.equal(
    epubHtmlToText('<h1>第一章<span class="heading-subtitle">副标题</span></h1>'),
    "第一章 副标题",
  );
});

test("保留标题层级内部的内联标记", () => {
  assert.equal(
    epubHtmlToText(
      '<h1 class="heading-lines"><span class="heading-main"><ruby>序<rt>じょ</rt></ruby>章</span>'
      + '<span class="heading-subtitle">开头</span></h1>',
    ),
    "<ruby>序<rt>じょ</rt></ruby>章 开头",
  );
});

test("标题层级连接不影响标题之外的非层级标记", () => {
  const body = "<p>正文<span>内联</span>继续。</p>";
  assert.equal(joinHeadingLayers(body), body);
  assert.equal(epubHtmlToText(body), "正文内联继续。");
});
