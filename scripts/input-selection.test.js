const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  guessLangOrder,
  inferInputMode,
  validateSelection,
} = require("./input-selection");
const { loadParagraphs } = require("./text-utils");
const { projectSignature } = require("../src/core/project-context");

function withTextFiles(count, callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-selection-"));
  try {
    const files = Array.from({ length: count }, (_, index) => {
      const file = path.join(dir, `text-${index + 1}.txt`);
      fs.writeFileSync(file, `paragraph ${index + 1}`, "utf8");
      return file;
    });
    callback(files);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("双语输入选择完全丢弃第三角色（tw）", () => {
  withTextFiles(2, ([jp, cn]) => {
    const selection = validateSelection({
      comparisonMode: "bilingual",
      files: { jp, cn, tw: "" },
      labels: { jp: "原文", cn: "主文本", tw: "参考文本" },
      startMarkers: { tw: "不该出现的起始短语" },
    });
    assert.equal(selection.comparisonMode, "bilingual");
    assert.deepEqual(Object.keys(selection.files), ["jp", "cn"]);
    assert.equal(Object.hasOwn(selection.files, "tw"), false);
    assert.deepEqual(Object.keys(selection.labels), ["jp", "cn"]);
    assert.deepEqual(selection.startMarkers, {});
    assert.equal(selection.inputMode, "txt");
    assert.deepEqual(selection.inlineMarkup, { ruby: true, bold: true, noteref: true });
  });
});

test("内联标记选择支持禁用 EPUB noteref 保留", () => {
  withTextFiles(2, ([jp, cn]) => {
    const selection = validateSelection({
      comparisonMode: "bilingual",
      files: { jp, cn, tw: "" },
      inlineMarkup: { noteref: false },
    });

    assert.deepEqual(selection.inlineMarkup, { ruby: true, bold: true, noteref: false });
  });
});

test("三语模式严格要求提供三份文件", () => {
  withTextFiles(2, ([jp, cn]) => {
    assert.throws(
      () => validateSelection({ comparisonMode: "trilingual", files: { jp, cn, tw: "" } }),
      /Missing tw input file/,
    );
  });
});

test("默认显示标签使用文本角色，已保存标签及项目身份保持不变", () => {
  withTextFiles(3, ([jp, cn, tw]) => {
    for (const comparisonMode of ["bilingual", "trilingual"]) {
      const input = { comparisonMode, files: { jp, cn, tw } };
      const generic = validateSelection(input);
      const expected = { jp: "原文 A", cn: "非原文 B" };
      if (comparisonMode === "trilingual") expected.tw = "非原文 C";
      assert.deepEqual(generic.labels, expected);

      const saved = validateSelection({ ...input, labels: { jp: "英文原稿", cn: "译稿甲", tw: "校订稿乙" } });
      assert.equal(saved.labels.jp, "英文原稿");
      assert.equal(saved.labels.cn, "译稿甲");
      if (comparisonMode === "trilingual") assert.equal(saved.labels.tw, "校订稿乙");
      assert.deepEqual(validateSelection(saved), saved, "重新读取输入登记时保留用户已保存的标签");
      assert.equal(projectSignature(saved), projectSignature(generic), "显示标签不改变项目或备注身份");
    }
  });
});

test("双语文件推测保持第三角色为空", () => {
  withTextFiles(2, (files) => {
    const guessed = guessLangOrder(files, "bilingual");
    assert.ok(guessed.jp);
    assert.ok(guessed.cn);
    assert.equal(guessed.tw, null);
    assert.equal(inferInputMode(guessed), "txt");
  });
});

test("双语段落导出不读取也不产出第三份文件", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-paragraphs-"));
  const jp = path.join(dir, "a.txt");
  const cn = path.join(dir, "b.txt");
  fs.writeFileSync(jp, "source paragraph", "utf8");
  fs.writeFileSync(cn, "target paragraph", "utf8");
  try {
    const paragraphs = await loadParagraphs({
      comparisonMode: "bilingual",
      inputMode: "txt",
      files: { jp, cn },
    });
    assert.ok(paragraphs.jp.length > 0);
    assert.ok(paragraphs.cn.length > 0);
    // 双语模式不写 tw 键，而不是写一个空数组冒充真实存在的列。
    assert.equal(Object.hasOwn(paragraphs, "tw"), false);
    assert.equal(paragraphs.comparisonMode, "bilingual");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
