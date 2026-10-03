const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { alignRows } = require("../src/workbenches/translation-compare/row-alignment");

function paragraphs(texts, lang) {
  return texts.map((text, sourceIndex) => ({ sourceIndex, lang, chapter: "正文", text, cnText: text, chars: Array.from(text).length }));
}

function withAlignment(groups, pivotLang, run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "between-lines-source-only-"));
  const previousOutput = process.env.TRANSCOMPARATOR_OUTPUT_DIR;
  process.env.TRANSCOMPARATOR_OUTPUT_DIR = directory;
  try {
    fs.writeFileSync(path.join(directory, "jp-align.json"), JSON.stringify({ groups, pivotLang }));
    return run();
  } finally {
    if (previousOutput === undefined) delete process.env.TRANSCOMPARATOR_OUTPUT_DIR;
    else process.env.TRANSCOMPARATOR_OUTPUT_DIR = previousOutput;
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function group(jpStart, jpEnd, pivotStart, pivotEnd, score = -0.26) {
  return { jpStart, jpEnd, pivotStart, pivotEnd, score, relation: `${jpEnd - jpStart}:${pivotEnd - pivotStart}` };
}

for (const [mode, pivotLang] of [["bilingual", "cn"], ["trilingual", "cn"], ["trilingual", "tw"]]) {
  test(`${mode}/${pivotLang} 保留开头、中间、结尾连续的原文独有段落`, () => {
    const jp = paragraphs(["原文开头甲。", "原文开头乙。", "原文匹配甲。", "原文中间。", "原文匹配乙。", "原文结尾甲。", "原文结尾乙。"], "jp");
    const cn = paragraphs(["译文第一段。", "译文第二段。", "原文以外的译文。"], "cn");
    const tw = mode === "bilingual" ? [] : paragraphs(cn.map((item) => item.text), "tw");
    const groups = [group(0, 1, 0, 0), group(1, 2, 0, 0), group(2, 3, 0, 1, 0.91), group(3, 4, 1, 1), group(4, 5, 1, 2, 0.82), group(5, 6, 2, 2), group(6, 7, 2, 2), group(7, 7, 2, 3)];
    const rows = withAlignment(groups, pivotLang, () => alignRows(cn, tw, jp, mode));
    assert.deepEqual(rows.map((row) => row.jp), jp.map((item) => item.text));
    assert.deepEqual(rows.map((row) => row.index), [1, 2, 3, 4, 5, 6, 7]);
    assert.deepEqual(rows.filter((row) => row.cn).map((row) => row.cn), [cn[0].text, cn[1].text]);
    assert.deepEqual(rows.filter((row) => row.cn).map((row) => row.jpAlignScore), [0.91, 0.82]);
    for (const index of [0, 1, 3, 5, 6]) {
      assert.equal(rows[index].cn, "");
      assert.equal(rows[index].cnChars, 0);
      assert.equal(rows[index].jpAlignScore, -0.26);
      assert.match(rows[index].relation, /1:0/);
      if (mode === "trilingual") {
        assert.equal(rows[index].tw, "");
        assert.equal(rows[index].twCn, "");
        assert.equal(rows[index].twChars, 0);
      } else {
        assert.equal(Object.hasOwn(rows[index], "tw"), false);
      }
    }
  });

  test(`${mode}/${pivotLang} 无译文时仍逐段保留全部原文`, () => {
    const jp = paragraphs(["原文甲。", "原文乙。"], "jp");
    const rows = withAlignment([group(0, 1, 0, 0), group(1, 2, 0, 0)], pivotLang, () => alignRows([], [], jp, mode));
    assert.deepEqual(rows.map((row) => row.jp), jp.map((item) => item.text));
    assert.ok(rows.every((row) => row.cn === ""));
  });

  test(`${mode}/${pivotLang} 空原文不生成译文独有行`, () => {
    const cn = paragraphs(["只有译文。"], "cn");
    const tw = mode === "bilingual" ? [] : paragraphs(["只有译文。"], "tw");
    assert.deepEqual(withAlignment([group(0, 0, 0, 1)], pivotLang, () => alignRows(cn, tw, [], mode)), []);
  });
}

test("重复的长原文按源索引逐段保留，不把内容相同视为复用", () => {
  const text = "这是内容相同但属于不同源段落的长原文。".repeat(12);
  const jp = paragraphs([text, text, text], "jp");
  const cn = paragraphs(["只有中间段落有译文。"], "cn");
  const rows = withAlignment([group(0, 1, 0, 0), group(1, 2, 0, 1, 0.9), group(2, 3, 1, 1)], "cn", () => alignRows(cn, [], jp, "bilingual"));
  assert.deepEqual(rows.map((row) => row.jp), [text, text, text]);
  assert.deepEqual(rows.map((row) => row.cn), ["", cn[0].text, ""]);
});

test("原文独有行的插入保留既有 pivot 行顺序与分数", () => {
  const jp = paragraphs(["原文甲。", "原文独有。", "原文乙。"], "jp");
  const cn = paragraphs(["译文乙。", "译文甲。"], "cn");
  const rows = withAlignment([group(0, 1, 1, 2, 0.9), group(1, 2, 1, 1), group(2, 3, 0, 1, 0.8)], "cn", () => alignRows(cn, [], jp, "bilingual"));
  assert.deepEqual(rows.filter((row) => row.cn).map((row) => [row.jp, row.cn, row.score]), [[jp[2].text, cn[0].text, 0.8], [jp[0].text, cn[1].text, 0.9]]);
  assert.equal(rows[0].jp, jp[1].text);
  assert.equal(rows[0].cn, "");
});

test("重复对齐组不能让同一个长原文索引跨行复用", () => {
  const jp = paragraphs(["这是一段不得重复使用的长原文。".repeat(12)], "jp");
  const cn = paragraphs(["译文。"], "cn");
  assert.throws(() => withAlignment([group(0, 1, 0, 0), group(0, 1, 0, 1, 0.9)], "cn", () => alignRows(cn, [], jp, "bilingual")), /重复使用/);
});

test("无效或越界的原文独有对齐组要求重新对齐", () => {
  const jp = paragraphs(["原文甲。", "原文乙。"], "jp");
  for (const invalid of [group(-1, 0, 0, 0), group(2, 3, 0, 0), group(0, 1, -1, -1), group(0, 1, 2, 1)]) {
    assert.throws(() => withAlignment([invalid], "cn", () => alignRows([], [], jp, "bilingual")), /段落区间无效/);
  }
  assert.throws(() => withAlignment([group(0, 2, 0, 0)], "cn", () => alignRows([], [], jp, "bilingual")), /一张表格行只对应一段原文/);
  assert.throws(() => withAlignment([group(0, 1, 0, 0)], "cn", () => alignRows([], [], [], "bilingual")), /段落区间无效/);
});
