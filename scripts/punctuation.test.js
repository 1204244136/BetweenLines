const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeTargetPunctuation } = require("../src/workbenches/translation-compare/ai/punctuation");

/** 只取规范化后的文本，便于逐条断言。 */
function fix(text) {
  return normalizeTargetPunctuation(text).text;
}

test("中文语境里的半角标点整体转全角", () => {
  // 真实回归（第 1040 行）：模型在 revisedText 里打出「......」。
  const row = normalizeTargetPunctuation("咚咚咚咚哗啦啦啦啦!!这足以震撼整块地板的粗重巨响,其真面目到底是......");
  assert.equal(row.text, "咚咚咚咚哗啦啦啦啦！！这足以震撼整块地板的粗重巨响，其真面目到底是……");
  assert.equal(row.toFull, 3, "连续叹号、逗号、连点各算一处");
  assert.equal(row.toHalf, 0);

  assert.equal(fix("他来了,真的!!"), "他来了，真的！！");
  assert.equal(fix("他说:好的;然后走了."), "他说：好的；然后走了。");
  assert.equal(fix("他问'这样吗'?"), "他问'这样吗'？", "引号不在这一层的处理范围（配对与撇号交给提示词）");
  assert.equal(fix("声音很大..."), "声音很大……");
  assert.equal(fix("沉默。。。"), "沉默……");
  assert.equal(fix("(测试)通过"), "（测试）通过");
  assert.equal(fix("他(test)说"), "他（test）说", "括号前紧邻中文 → 整对转全角，不留半对");
});

test("整行只有标点或拟声符号时不被当成英文（整卷实测过的误判）", () => {
  // 真实整卷 dry-run 里最刺眼的一批：标准省略号被改成「...」甚至「。。。」。
  // 反向规范化必须有正向的 ASCII 证据，不能只看“附近没有汉字”。
  for (const text of ["「……」", "「……？」", "「～～～！！！」", "……", "……………………………………………………………………………………………………………………………………………………………………………………………………………………"]) {
    const result = normalizeTargetPunctuation(text);
    assert.equal(result.text, text, `纯标点/拟声行被改动了：${text}`);
    assert.equal(result.changed, false);
  }
  // 反向：中文语境里的半角连点在引号内也要转成「……」（正向方向不受影响）。
  assert.equal(fix("「...」"), "「……」");
  assert.equal(fix("他来了.."), "他来了……");
  assert.equal(fix("剩下 1..5 页。"), "剩下 1..5 页。", "数字区间里的连点不受影响");
});

test("英文句子与 ASCII 词元保持半角", () => {
  for (const text of [
    "Wait, this is a test. Really? Yes, it is.",
    "It costs 1,000 dollars (about $10.5), right?",
    "See http://a.b/c?x=1 for details.",
    "Hello (test) world.",
  ]) {
    const result = normalizeTargetPunctuation(text);
    assert.equal(result.text, text, `英文句子被改动了：${text}`);
    assert.equal(result.changed, false);
    assert.equal(result.toFull + result.toHalf, 0);
  }
});

test("英文语境里出现的全角标点还原成半角", () => {
  const mixed = normalizeTargetPunctuation("This is a test， isn't it？");
  assert.equal(mixed.text, "This is a test, isn't it?");
  assert.equal(mixed.toHalf, 2);
  assert.equal(mixed.toFull, 0);
  assert.equal(fix("abc（test）def"), "abc(test)def");
  assert.equal(fix("Well……ok"), "Well...ok");
});

test("数字、版本号、缩写与单位里的点半角不动", () => {
  assert.equal(fix("长3.5米,重1,000克."), "长3.5米，重1,000克。");
  assert.equal(fix("版本 v1.2 已发布,见 e.g. 说明."), "版本 v1.2 已发布，见 e.g. 说明。", "缩写里的点必须保留");
  assert.equal(fix("S1_01 与 S2_22r 都在."), "S1_01 与 S2_22r 都在。");
  assert.equal(fix("他是 Level 5."), "他是 Level 5.", "紧贴 ASCII 词的句点按英文处理，保持半角");
});

test("内联标记整段跳过，标签内的标点不被改写", () => {
  const ruby = "<ruby>心理掌握<rt>Mental Out</rt></ruby>很厉害.";
  assert.equal(fix(ruby), "<ruby>心理掌握<rt>Mental Out</rt></ruby>很厉害。");

  const noteref = '<a epub:type="noteref"><sup>㊟</sup></a>这是译注,对吗?';
  const fixed = fix(noteref);
  assert.equal(fixed, '<a epub:type="noteref"><sup>㊟</sup></a>这是译注，对吗？');
  assert.equal(fixed.includes('epub:type="noteref"'), true, "标签属性里的冒号与引号必须原样保留");

  // 跨标签的语境判断：标签占位符算作文档上下文的一侧。
  assert.equal(fix("<b>你好</b>,走吧"), "<b>你好</b>，走吧");
});

test("空值与纯文本不受影响", () => {
  for (const text of ["", "纯中文没有标点", "Hello world"]) {
    const result = normalizeTargetPunctuation(text);
    assert.equal(result.text, text);
    assert.equal(result.changed, false);
  }
  assert.deepEqual(normalizeTargetPunctuation(null), { text: "", changed: false, toFull: 0, toHalf: 0 });
});
