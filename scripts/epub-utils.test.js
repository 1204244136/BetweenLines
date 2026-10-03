const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");
const JSZip = require("jszip");

const {
  epubHtmlToText,
  extractNoterefMarkup,
  joinHeadingLayers,
  readEpubSpineDocuments,
  readEpubTextFromSpine,
  readEpubTextWithPandoc,
  restorePandocNoterefMarkup,
} = require("./epub-utils");
const { sliceMainDocument, splitParagraphs } = require("./text-utils");

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

async function bodyBoundaryEpub(hasNav, unpacked, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "between-lines-epub-body-"));
  const zip = new JSZip();
  const names = overrides.names || (hasNav
    ? ["front.xhtml", "overview.xhtml", "opening.xhtml", "story.xhtml", "annotations.xhtml"]
    : ["S5_01_03-Information.xhtml", "S5_01_03-01_Introduction.xhtml", "S5_01_03-02.xhtml", "S5_01_03-03_Chapter1.xhtml", "S5_01_03-Note.xhtml"]);
  const labels = overrides.labels || ["制作信息", "简介", "引子", "第一章", "译注"];
  const noteref = `<a epub:type="noteref" href="${names[4]}#note1"><sup>㊟</sup></a>`;
  const documents = overrides.documents || [
    '<h1>制作信息</h1><p>本书由测试录入组制作。</p><p>这里的备注介绍了其他作品，句子完整也不是故事正文。</p>',
    '<h1>简介</h1><p>「简介中的对话也不能进入正文！」</p>',
    '<p>「走吧。」</p>',
    `<h1>第一章</h1><p>「等等。」</p><p>他在备注栏写下<ruby>约定<rt>Promise</rt></ruby>${noteref}。</p>`,
    '<h1>译注</h1><p id="note1" epub:type="footnote">这是独立译注页面里的解释内容。</p>',
  ];
  const manifest = names.map((name, index) => `<item id="doc-${index}" href="Text/${name}" media-type="application/xhtml+xml"/>`);
  if (hasNav) manifest.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>');
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.file("META-INF/container.xml", '<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container" version="1.0"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file("OEBPS/content.opf", '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">'
    + '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">body-boundary-test</dc:identifier><dc:title>Boundary test</dc:title><dc:language>zh</dc:language></metadata>'
    + `<manifest>${manifest.join("")}</manifest><spine>${names.map((name, index) => `<itemref idref="doc-${index}"/>`).join("")}</spine></package>`);
  for (let index = 0; index < names.length; index += 1) {
    zip.file(`OEBPS/Text/${names[index]}`, '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Boundary test</title></head>'
      + `<body>${documents[index]}</body></html>`);
  }
  if (hasNav) {
    zip.file("OEBPS/nav.xhtml", '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol>'
      + names.flatMap((name, index) => [].concat(labels[index] || []).map((label) => `<li><a href="Text/${name}">${label}</a></li>`)).join("")
      + '</ol></nav></body></html>');
  }
  const file = unpacked ? path.join(dir, "book") : path.join(dir, "book.epub");
  if (unpacked) {
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const target = path.join(file, entry.name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, await entry.async("nodebuffer"));
    }
  } else {
    fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer" }));
  }
  return { dir, file, names, noteref };
}

const pandocAvailable = spawnSync(process.env.PANDOC_BIN || "pandoc", ["--version"], { windowsHide: true }).status === 0;
for (const [name, documents, labels] of [
  ["后记后无导航标签的附录", [
    '<h1>第一章</h1><p>这是故事的正文。</p>',
    '<h1>后记</h1><p>作者后记。</p>',
    '<p>这是一段不应进入正文的附录说明。</p>',
  ], ["第一章", "后记", null]],
  ["同文件导航同时指向正文和后记", [
    '<h1>第一章</h1><p>这是故事的正文。</p><h1>后记</h1><p>作者后记。</p>',
  ], [["第一章", "后记"]]],
]) {
  test(`Pandoc 保留正文结束边界并排除${name}`, { skip: !pandocAvailable && "Pandoc unavailable" }, async () => {
    const fixture = await bodyBoundaryEpub(true, false, {
      names: documents.map((document, index) => `part-${index}.xhtml`),
      documents,
      labels,
    });
    const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
    process.env.TRANSCOMPARATOR_DATA_DIR = path.join(fixture.dir, "runtime-data");
    try {
      const text = await readEpubTextWithPandoc(fixture.file);
      const paragraphs = splitParagraphs(sliceMainDocument(text, "cn"), "cn");
      assert.deepEqual(paragraphs.map((paragraph) => paragraph.text), ["这是故事的正文。"]);
    } finally {
      if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
      else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
      fs.rmSync(fixture.dir, { recursive: true, force: true });
    }
  });
}

function inputBytes(file) {
  if (fs.statSync(file).isFile()) return fs.readFileSync(file);
  const contents = {};
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const relative = `${prefix}${entry.name}`;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(target, `${relative}/`);
      else contents[relative] = fs.readFileSync(target);
    }
  };
  visit(file);
  return contents;
}

for (const [converter, read, available] of [
  ["internal", readEpubTextFromSpine, true],
  ["pandoc", readEpubTextWithPandoc, pandocAvailable],
]) {
  for (const hasNav of [false, true]) {
    for (const unpacked of [false, true]) {
      test(`${converter} 按${hasNav ? "导航标签" : "文件语义"}排除${unpacked ? "解压" : "打包"} EPUB 非正文页且保留短开篇`, { skip: !available && "Pandoc unavailable" }, async () => {
        const fixture = await bodyBoundaryEpub(hasNav, unpacked);
        const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
        const dataDir = path.join(fixture.dir, "runtime-data");
        process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;
        try {
          const before = inputBytes(fixture.file);
          const text = await read(fixture.file);
          assert.doesNotMatch(text, /制作信息|测试录入组|这里的备注|简介|独立译注/);
          assert.match(text, /「走吧。」/);
          assert.match(text, /「等等。」/);
          assert.match(text, /他在备注栏写下<ruby>约定<rt>Promise<\/rt><\/ruby>/);
          assert.ok(text.includes(fixture.noteref));
          assert.deepEqual(inputBytes(fixture.file), before);
          const workDir = path.join(dataDir, "runtime", "work");
          assert.deepEqual(fs.existsSync(workDir) ? fs.readdirSync(workDir) : [], []);
          const spine = await readEpubSpineDocuments(fixture.file);
          for (const index of [0, 1, 4]) {
            const document = spine.find((item) => item.path.endsWith(fixture.names[index]));
            assert.equal(document.bodySelected, false, fixture.names[index]);
          }
        } finally {
          if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
          else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
          fs.rmSync(fixture.dir, { recursive: true, force: true });
        }
      });
    }
  }
}
