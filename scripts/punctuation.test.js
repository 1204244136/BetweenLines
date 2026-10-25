const assert = require("node:assert/strict");
const test = require("node:test");

const { normalizeTargetPunctuation, restoreTerminalPunctuation } = require("../src/workbenches/translation-compare/ai/punctuation");

/** 只取规范化后的文本，便于逐条断言。 */
function fix(text) {
  return normalizeTargetPunctuation(text).text;
}

/** 只取补回句末点号后的文本。 */
function restore(target, revised) {
  return restoreTerminalPunctuation(target, revised).text;
}

test("中文语境里的半角标点整体转全角", () => {
  // 合成回归夹具：模型在 revisedText 里打出「......」。
  const row = normalizeTargetPunctuation("哗啦啦啦!!隔壁传来一阵纸箱落地的声音,究竟是谁在整理仓库......");
  assert.equal(row.text, "哗啦啦啦！！隔壁传来一阵纸箱落地的声音，究竟是谁在整理仓库……");
  assert.equal(row.toFull, 3, "连续叹号、逗号、连点各算一处");
  assert.equal(row.toHalf, 0);

  assert.equal(fix("他来了,真的!!"), "他来了，真的！！");
  assert.equal(fix("他说:好的;然后走了."), "他说：好的；然后走了。");
  assert.equal(fix("他问'这样吗'?"), "他问'这样吗'？", "引号不在这一层的处理范围（配对与撇号交给提示词）");
  assert.equal(fix("声音很大..."), "声音很大……");
  assert.equal(fix("沉默。。。"), "沉默……");
  assert.equal(fix("(测试)通过"), "（测试）通过");
  assert.equal(fix("他(test)说"), "他（test）说", "括号前紧邻中文 → 整对转全角，不留半对");
  assert.equal(fix("传来了“咔哒”一声。"), "传来了「咔哒」一声。");
  assert.equal(fix('他说"这样吗"?'), "他说「这样吗」？");
});

test("中文语境的弯引号与直双引号统一成直角引号，英文语境与撇号不动", () => {
  const curly = normalizeTargetPunctuation("传来了“咔哒”一声。");
  assert.equal(curly.text, "传来了「咔哒」一声。");
  assert.equal(curly.quotes, 1);
  assert.equal(curly.unresolvedQuotes, 0);
  assert.equal(curly.changed, true);
  assert.equal(curly.toFull, 0, "引号体例不是标点宽度");

  const straight = normalizeTargetPunctuation('他说"这样吗"?');
  assert.equal(straight.text, "他说「这样吗」？");
  assert.equal(straight.quotes, 1);

  const englishCurly = normalizeTargetPunctuation("He said “hello”.");
  assert.equal(englishCurly.text, "He said “hello”.", "英文整句里的英文引号不硬转");
  assert.equal(englishCurly.quotes, 0);
  assert.equal(englishCurly.unresolvedQuotes, 2, "残留弯引号交给调用方作废转人工");

  const englishStraight = normalizeTargetPunctuation('He said "hello".');
  assert.equal(englishStraight.text, 'He said "hello".');
  assert.equal(englishStraight.changed, false);
  assert.equal(englishStraight.unresolvedQuotes, 0, "英文直双引号不属于成品弯引号门禁");
  assert.equal(fix("don't change"), "don't change", "撇号不当作单引号处理");
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

  // 跨标签的语境判断：标签占位符不代表任何语种，按标签另一侧的真实字符判断。
  assert.equal(fix("<b>你好</b>,走吧"), "<b>你好</b>，走吧");
  assert.equal(fix("他说<b>好</b>..."), "他说<b>好</b>……");
});

test("英文紧挨内联标记时标点保持半角", () => {
  // 回归：标签占位符曾被算作中文语境，标签旁的英文标点被一律全角化。
  for (const text of ["<b>Hello</b>, world.", "<b>English</b> (note) here", "<b>Wait</b>... what?"]) {
    const result = normalizeTargetPunctuation(text);
    assert.equal(result.text, text, `标签旁的英文标点被改动了：${text}`);
    assert.equal(result.changed, false);
  }
});

test("空值与纯文本不受影响", () => {
  for (const text of ["", "纯中文没有标点", "Hello world"]) {
    const result = normalizeTargetPunctuation(text);
    assert.equal(result.text, text);
    assert.equal(result.changed, false);
  }
  assert.deepEqual(normalizeTargetPunctuation(null), {
    text: "",
    changed: false,
    toFull: 0,
    toHalf: 0,
    quotes: 0,
    unresolvedQuotes: 0,
  });
});

test("被删掉的成对标记内侧句末点号要补回来", () => {
  // 回归形态：目标列整行括注、点号落在括号内，模型判「括号内句末添加了多余的句号」
  // 并在改写里删掉了它——这句话是中文规范写法，原文（日文）省略不等于译文该省。
  const bracket = restoreTerminalPunctuation("（……现在还没有到达车站。）", "（……现在还没有到达车站）");
  assert.equal(bracket.text, "（……现在还没有到达车站。）");
  assert.equal(bracket.restored, 1);
  assert.equal(bracket.changed, true);
  // 回归形态：同一个形状出现在引号里，模型同时删了点号、改写了措辞。
  const quote = restoreTerminalPunctuation("「……甲野简明扼要地说明道。」", "「……甲野认真仔细地说明道」");
  assert.equal(quote.text, "「……甲野认真仔细地说明道。」");
  assert.equal(quote.restored, 1);
  // 只删点号、没有别的改动时同样补回。
  assert.equal(restore("（他说。）", "（他说）"), "（他说。）");
  assert.equal(restore("「住手！」", "「住手」"), "「住手！」");
});

test("只补「单独一个、且后面确实还有收尾符号」的句末点号", () => {
  // 成对的「。。」本身就是缺陷，删掉它属于修正，不能补回来。
  assert.equal(restore("（混蛋。。）", "（混蛋。）"), "（混蛋。）");
  // 收尾符号被一起删掉时不能补：补回去等于造一个没有收尾符号的句末点号。
  assert.equal(restore("（他说。）", "（他说"), "（他说");
  // 点号后面紧跟的不是成对标记的收尾符号（这里是行尾/句中的点号）→ 不在这一层的处理范围。
  assert.equal(restore("他没有来。", "他没有来"), "他没有来");
  assert.equal(restore("先走一步。然后回头。", "先走一步然后回头。"), "先走一步然后回头。");
  // 顺手改了措辞不影响补回那一个点号（删的确实是单独一个、且收尾符号还在原位）。
  assert.equal(restore("（他来了。）", "（他真的来了）"), "（他真的来了。）");
  // 极端情形（模型把开头括号与部分正文一起删掉、只留下收尾符号）：这一个点号照样补回——
  // 文本已经被那次改动改坏（括号不成对），人工在 diff 里一眼可见，不由标点这一层兜底。
  assert.equal(restore("（他来了。）", "来了）"), "来了。）");
  // 省略号带语气与信息内容，删它属于语义判断，不由标点工序代劳。
  assert.equal(restore("（原来如此……）", "（原来如此）"), "（原来如此）");
  // 修订结果已经在收尾符号前给了点号：不重复补。
  assert.equal(restore("（他说。）", "（他说。）"), "（他说。）");
});

test("补回句末点号只在中文全角形态上生效，且不动其他字符", () => {
  const result = restoreTerminalPunctuation("「そうか。」", "「そうか」");
  assert.equal(result.text, "「そうか。」");
  assert.equal(result.restored, 1);
  // 空值与非中文收尾符号不受影响。
  assert.deepEqual(restoreTerminalPunctuation("", ""), { text: "", changed: false, restored: 0 });
  assert.deepEqual(restoreTerminalPunctuation(null, null), { text: "", changed: false, restored: 0 });
  assert.equal(restore("(He said.)", "(He said)"), "(He said)");
});
