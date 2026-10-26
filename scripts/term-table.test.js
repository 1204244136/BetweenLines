const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  entryNeedsRuby,
  evaluateTermRow,
  findTermHits,
  loadTermTables,
  normalizeRubyText,
  normalizeTermEntry,
  rubyPairs,
  splitBracketed,
  stripInlineMarkup,
  stripMarks,
  termAliases,
} = require("../src/workbenches/translation-compare/ai/term-table");
const { conflictAnalysisHead, makeTermResult, TERM_MARKER, termGuidanceFor } = require("../src/workbenches/translation-compare/ai/term-prefilter");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-term-"));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("译名表解析：表头驱动、去装饰、分段与别名生成", () => {
  const entry = normalizeTermEntry({
    base_ori: "【東雲】【太郎】",
    ruby_ori: "しののめ,たろう",
    base_trans: "東雲太郎",
    type: "人名/日式全名",
  });
  assert.deepEqual(entry.sourceParts, ["東雲", "太郎"]);
  // 方括号只是给注音标记位置，正文里不出现：展示与匹配都用去方括号的原文。
  assert.equal(entry.plainSource, "東雲太郎");
  assert.equal(entry.plainTarget, "東雲太郎");
  // compareKey 走简繁归一：繁体基文与简体译名算同一个术语。
  assert.equal(entry.compareKey, "东云太郎");
  assert.deepEqual(entry.targetParts.map((part) => part.text), ["東雲", "太郎"]);

  const aliases = Object.fromEntries(termAliases(entry).map((item) => [item.alias, `${item.scope}${item.strong ? "/strong" : ""}`]));
  assert.equal(aliases["東雲太郎"], "term/strong");
  assert.equal(aliases["【東雲】【太郎】"], undefined, "带方括号的写法不该作为匹配别名");
  assert.equal(aliases["東雲"], "part");
  assert.equal(aliases["太郎"], "part");
  assert.equal(aliases["しののめ"], "ruby");
  // 3 字假名（たろう）在载入阶段就被排除：短读音会和普通词、长词片段撞车。
  assert.equal(aliases["たろう"], undefined);
  assert.equal(aliases["しののめたろう"], "ruby");
  // 注音按逗号顺序与各分段一一对应：不能把「太郎」的读音挂到别的段上。
  assert.equal(aliases["太郎（たろう）"], "ruby", "分段基文连着它自己的读音，比裸假名更可靠");
  assert.equal(aliases["東雲（しののめ）"], "ruby");
  assert.equal(aliases["美琴（しののめ）"], undefined, "读音不能与不对应的分段组合");

  // 2 字基文别名未达门槛（见 TERM_STRONG_MIN_LENGTH，现为 3 字）：只能确认一致，不能指控译名错误；
  // 读音与分段别名同样不判定。
  const shortEntry = normalizeTermEntry({ base_ori: "【時代】", base_trans: "【时代】", type: "术语" });
  assert.equal(termAliases(shortEntry).every((item) => item.strong === false), true);

  // 注音口径的元数据：注文归一成可比对形态（整串 + 各段），并据此判断该条目要不要过注音这一关。
  const rubyEntry = normalizeTermEntry({ base_ori: "【発信機】", ruby_ori: "ナノデバイス", base_trans: "【发信器】", type: "科技/装备" });
  assert.deepEqual(rubyEntry.rubyParts, ["ナノデバイス"]);
  assert.deepEqual(rubyEntry.rubyKeys, ["なのでばいす"]);
  assert.equal(rubyEntry.ruby, "ナノデバイス", "注文原样保留，显示与备注都用它");
  assert.equal(entryNeedsRuby(rubyEntry), true);
  assert.equal(entryNeedsRuby(normalizeTermEntry({ base_ori: "【発信機】", base_trans: "【发信器】", type: "科技/装备" })), false, "没有注音的条目不受注音口径约束");
  assert.equal(entryNeedsRuby(normalizeTermEntry({ base_ori: "【東雲】【太郎】", ruby_ori: "しののめ,たろう", base_trans: "東雲太郎", type: "人名/日式全名" })), false, "人名豁免：原文里的人名只在首次出现时注音");
  // 注音比对要能吃下“全尺寸假名”的写法：原文把「しょ」写成「しよ」，与表里的「しょ」指同一个读音。
  assert.equal(normalizeRubyText("しよくほう"), normalizeRubyText("しょくほう"));
  assert.equal(normalizeRubyText("レベル５"), normalizeRubyText("レベル5"));
  assert.deepEqual(
    rubyPairs("<ruby>発信機<rt>ナノデバイス</rt></ruby>と|常盤台[ときわだい]"),
    [{ base: "発信機", ruby: "ナノデバイス" }, { base: "常盤台", ruby: "ときわだい" }],
  );

  assert.deepEqual(splitBracketed("【山吹】中学正面基地局"), ["中学正面基地局", "山吹"]);
  assert.equal(stripMarks("【结界装置】"), "结界装置");
  assert.equal(stripInlineMarkup("<ruby>東雲<rt>しののめ</rt></ruby>は笑った"), "東雲は笑った");
});

test("译名表展示与提示词保留标准译名里的间隔号", () => {
  const file = path.join(tempDir, "separator-terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Base_Trans,Type",
    "イスラエル＝リガルディ,伊斯瑞·雷加第,人名/西式全名",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);

  const entry = tables.entries[0];
  assert.equal(entry.plainSource, "イスラエル＝リガルディ");
  assert.equal(entry.plainTarget, "伊斯瑞·雷加第");
  assert.equal(entry.targetText, "伊斯瑞·雷加第");
  assert.equal(entry.compareKey, "伊斯瑞雷加第", "匹配仍忽略间隔号，不能因展示修复而漏掉已有写法");

  const source = "「イスラエル＝リガルディの再来だ」";
  const target = "「装成伊斯瑞·雷加帝回归的样子」";
  const evaluation = evaluateTermRow({ source, target, tables });
  assert.equal(evaluation.kind, "conflict");
  const guidance = termGuidanceFor(
    { index: 766, jp: source },
    { evaluation, targetKey: "cn", targetLabel: "主文本（待修改文本）" },
  );
  assert.match(guidance.block, /- イスラエル＝リガルディ → 伊斯瑞·雷加第（人名\/西式全名）/);
  assert.equal(guidance.terms[0].target, "伊斯瑞·雷加第");
  assert.equal(guidance.terms[0].targetText, "伊斯瑞·雷加第");
  assert.match(guidance.terms[0].text, /伊斯瑞·雷加第/);
});

test("注音按方括号分段顺序对应，整条基文与整串读音都能命中", () => {
  const tables = loadFixtureTables();

  // 分段基文的整条写法（正文里的实际形态，没有方括号）必须命中整条术语。
  const full = findTermHits("東雲太郎が来た", tables);
  assert.equal(full.some((hit) => hit.alias === "東雲太郎" && hit.scope === "term"), true);
  // 整串读音（正文右侧注音）也算命中，但只作读音证据。
  const ruby = findTermHits("しののめたろうが来た", tables);
  assert.equal(ruby.some((hit) => hit.alias === "しののめたろう" && hit.scope === "ruby"), true);

  // 只写姓或名（分段命中）：不足以证明本行用的是这个术语，交回后续流程而不是判“一致”。
  assert.equal(evaluateTermRow({ source: "太郎は言った。", target: "太郎说道。", tables }), null);
  // 整串读音命中且译文确实用了该译名：可以确认一致。
  assert.equal(evaluateTermRow({ source: "しののめたろうが来た。", target: "東雲太郎来了。", tables }).kind, "consistent");
  // 整行就是该词时（正文里不会带方括号）可以直接跳过模型。
  assert.equal(evaluateTermRow({ source: "東雲太郎", target: "東雲太郎", tables }).kind, "term-only");
});

function loadFixtureTables() {
  const file = path.join(tempDir, "terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Ruby_Trans,Other_Fandom,Type",
    '【東雲】【太郎】,"しののめ,たろう",東雲太郎,Shinonome Taro,SHINONOME Taro,人名/日式全名',
    "【結界装置】,バリアユニット,【结界装置】,Barrier Unit,,装置",
    "【東雲寺】,しののめでら,东云寺,,,地名",
    // 短词条目刻意不写注音：2 字词只能确认一致，与注音口径是两回事，别混在一起测。
    "【時代】,,【时代】,,,术语",
    "【発信機】,はっしんき,【发信器】,,,科技/装备",
    "【常盤台中学】,ときわだいちゅうがく,常盘台中学,,,地名/学校",
    // 无注音的非人名条目：不受「双侧注音」口径约束，冲突/替换路径用它来测（注音条目已不允许指控）。
    "【召喚陣】,,【召唤阵】,Summon Circle,,术式",
    "【聖堂教会】,,【圣堂教会】,Holy Church,,组织/结社",
    // 注音只是这个词本身的普通读音（不是特殊别名）：中日两侧正文都不会注音，是「魔術 → 魔法」那一类。
    "【魔術】,まじゅつ,魔法,,,术语",
    // 真·双语注音专有名词：原文与译文两侧都会给这个中文译名加注音。
    "【心理掌握】,メンタルアウト,【心理掌握】,Mental Out,,能力",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);
  return tables;
}

// 带注音的条目（非人名）要在原文与译文**两侧**都对上注音，才算「表里那个专有名词」；
// 测试里用这个助手写「原文的注音形态」。
function withRuby(base, ruby, tail = "") {
  return `<ruby>${base}<rt>${ruby}</rt></ruby>${tail}`;
}

function loadInterruptedNameTables() {
  const file = path.join(tempDir, "interrupted-names.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Other_Fandom,Type",
    '【山田】【静香】,"やまだ,しずか",山田静华,山田静嘉,人名/日式全名',
    '【山田】【花子】,"やまだ,はなこ",山田花子,,人名/日式全名',
    "【タカハシ】,,高桥,,人名",
    "【ハールマン】,,哈尔曼,,人名",
    "【結界装置】,,结界装置,,装置",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);
  return tables;
}

test("人名旧译名嵌在标准译名内部时不误报，也不重复替换后缀", () => {
  const file = path.join(tempDir, "nested-person-names.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Base_Trans,Other_Fandom,Type",
    "エリザベス,伊丽莎白二世,伊丽莎白,人名",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  for (const target of ["伊丽莎白二世", "伊丽莎白……二世"]) {
    const evaluation = evaluateTermRow({ source: "エリザベスが来た。", target, tables });
    assert.equal(evaluation.kind, "consistent", target);
    assert.equal(evaluation.hits[0].via, "full");
  }
  const mixed = evaluateTermRow({ source: "エリザベスが来た。", target: "伊丽莎白二世与伊丽莎白", tables });
  assert.equal(mixed.kind, "conflict", "标准译名之外独立出现的旧写法仍须提示");
  assert.equal(mixed.revisedText, "", "无法用全局字符串替换安全地区分标准译名内外的旧写法");
});

test("人名内部的断句标点仍能命中完整姓名并提供标准译名", () => {
  const tables = loadInterruptedNameTables();
  for (const source of [
    "「山田、静香……ッ」",
    "「山田……静香……ッ」",
    "「山田 静香……ッ」",
    "「山、田静香……ッ」",
    `「${withRuby("山田", "やまだ")}、${withRuby("静香", "しずか")}……ッ」`,
  ]) {
    const evaluation = evaluateTermRow({ source, target: "「山田……静华……！」", tables });
    assert.ok(evaluation, source);
    assert.equal(evaluation.kind, "term-only", source);
    const name = evaluation.hits.find((hit) => hit.entry.plainSource === "山田静香");
    assert.equal(name.scope, "term", source);
    assert.equal(name.strong, true, source);
    assert.equal(name.via, "full", source);
    const guidance = termGuidanceFor({ jp: source }, { evaluation });
    assert.equal(guidance.count, 1, "同姓的花子不应随姓氏一起进入提示词");
    assert.match(guidance.block, /山田静香 → 山田静华/);
    assert.doesNotMatch(guidance.block, /山田花子/);
  }
});

test("断开的人名不能只凭正确姓氏掩盖名字中的错误字形", () => {
  const tables = loadInterruptedNameTables();
  for (const target of ["山田……静香", "山田、静香", "山……田静香", "山田静香"]) {
    const source = "山田、静香が来た。";
    const evaluation = evaluateTermRow({ source, target: `${target}来了。`, tables });
    assert.equal(evaluation?.kind, "conflict", target);
    const name = evaluation.hits.find((hit) => hit.entry.plainSource === "山田静香");
    assert.equal(name.consistent, false, target);
    const guidance = termGuidanceFor({ jp: source }, { evaluation });
    assert.equal(guidance.count, 1);
    assert.match(guidance.block, /山田静香 → 山田静华/);
  }
  const mixed = evaluateTermRow({
    source: "山田、静香が来た。山田、静香は笑った。",
    target: "山田……静华来了。山田……静香笑了。",
    tables,
  });
  assert.equal(mixed?.kind, "conflict", "首次出现的正确姓名不能掩盖同一行后续错误写法");
  assert.equal(evaluateTermRow({ source: "山田静香が来た。", target: "山田来了。", tables }).kind, "consistent", "真正只写姓氏的承接仍然允许");
});

test("人名跨标点匹配保留分段防撞车与句子边界", () => {
  const tables = loadInterruptedNameTables();
  for (const source of [
    "山田は来た。",
    "静香が来た。",
    "山田。静香",
    "「山田」「静香」",
    "山田\n静香",
    "山田と静香",
  ]) {
    assert.equal(evaluateTermRow({ source, target: "山田静华", tables }), null, source);
  }
  assert.equal(evaluateTermRow({ source: "結界、装置", target: "结界装置", tables }), null, "非人名术语不跨标点拼接");
  const source = "山田、花子が来た。";
  const evaluation = evaluateTermRow({ source, target: "山田花子来了。", tables });
  const guidance = termGuidanceFor({ jp: source }, { evaluation });
  assert.deepEqual(guidance.terms.map((term) => term.source), ["山田花子"]);
});

test("姓名内部停顿有长度上限，日语长音符仍是姓名字符", () => {
  const tables = loadInterruptedNameTables();
  const withinLimit = `山田${"…".repeat(8)}静香`;
  const tooLong = `山田${"…".repeat(9)}静香`;
  assert.equal(evaluateTermRow({ source: withinLimit, target: "山田静华", tables })?.kind, "term-only");
  assert.equal(evaluateTermRow({ source: tooLong, target: "山田静华", tables }), null);
  const source = "山田静香が来た。";
  const targetWithinLimit = evaluateTermRow({ source, target: `山田${"…".repeat(8)}静华`, tables });
  const targetTooLong = evaluateTermRow({ source, target: `山田${"…".repeat(9)}静华`, tables });
  assert.equal(targetWithinLimit.hits.find((hit) => hit.entry.plainSource === "山田静香").via, "full");
  assert.notEqual(targetTooLong.hits.find((hit) => hit.entry.plainSource === "山田静香").via, "full");
  assert.equal(evaluateTermRow({ source: "タカー、ハシ", target: "高桥", tables }), null, "不能把额外长音符当成停顿删除");
  assert.equal(evaluateTermRow({ source: "ハー、ルマン", target: "哈尔曼", tables })?.kind, "term-only", "表内原有长音符仍按姓名字符匹配");
  assert.equal(evaluateTermRow({ source: "ハルマン", target: "哈尔曼", tables }), null, "不能忽略表内原有长音符");
});

test("译文不会跨句子拼成完整姓名，已知旧译名优先于另一处正确全名", () => {
  const tables = loadInterruptedNameTables();
  const source = "山田静香が来た。";
  for (const target of ["山田。静华", "「山田」「静华」", "山田\n静华"]) {
    const evaluation = evaluateTermRow({ source, target, tables });
    assert.notEqual(evaluation?.hits.find((hit) => hit.entry.plainSource === "山田静香")?.via, "full", target);
  }
  const repeatedSource = "山田静香が来た。山田静香は笑った。";
  for (const target of ["山田静华来了，山田静嘉笑了。", "山田……静华来了，山田……静嘉笑了。"]) {
    const evaluation = evaluateTermRow({ source: repeatedSource, target, tables });
    assert.equal(evaluation?.kind, "conflict", target);
    assert.equal(evaluation.hits.find((hit) => hit.entry.plainSource === "山田静香").consistent, false);
  }
});

test("判定规则：命中整条术语才判，短词/读音/分段只确认或记录", () => {
  const tables = loadFixtureTables();

  // 一致：整条译名出现（句中还有别的内容 → 只能注入提示词，不能跳过模型）
  const inline = evaluateTermRow({ source: "東雲太郎は言った。", target: "東雲太郎说道。", tables });
  assert.equal(inline.kind, "consistent");
  assert.equal(inline.coverage.skip, false);
  // 一致：只写姓或名（分段写法）
  const partial = evaluateTermRow({ source: "東雲太郎は言った。", target: "東雲说道。", tables });
  assert.equal(partial.kind, "consistent");
  assert.equal(partial.hits[0].via, "part");
  // 一致：括号/字形差异（注音条目只对上原文侧时降级为一致性证据，但“译文用了译名”仍然成立）
  const rubyOnly = evaluateTermRow({ source: `それは${withRuby("結界装置", "バリアユニット")}だ。`, target: "那是名为结界装置的能力。", tables });
  assert.equal(rubyOnly.kind, "consistent");
  assert.equal(rubyOnly.hits[0].demoted, true, "没有双侧注音 → 降级为只作一致性证据");
  // 冲突：整条术语没使用本项目译名（基文别名达到门槛）——用无注音条目测：注音条目已不允许指控（见下一条测试）
  const conflict = evaluateTermRow({ source: "召喚陣を使う。", target: "使用魔法阵。", tables });
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.hits[0].consistent, false);
  assert.equal(conflict.revisedText, "", "没有可定位的旧译名时不能编造替换文本");
  // 冲突：译文里出现的是“其他译法”（英文写法），给出最小替换
  const replaced = evaluateTermRow({ source: "召喚陣を使う。", target: "使用Summon Circle。", tables });
  assert.equal(replaced.kind, "conflict");
  assert.equal(replaced.revisedText, "使用【召唤阵】。", "只替换术语，句子其余部分不动");
  // 短词不算强证据：命中但不判定，交回后续流程（放宽到 2 字实测假差异偏多，见 term-table.js 的门槛注释）
  const shortTerm = evaluateTermRow({ source: "その時代の話だ。", target: "那是这年头的事。", tables });
  assert.equal(shortTerm, null);
  // 短词命中且译文一致：仍然可以确认一致
  assert.equal(evaluateTermRow({ source: "その時代の話だ。", target: "那是【时代】的话题。", tables }).kind, "consistent");
  // 只命中读音：不判定
  assert.equal(evaluateTermRow({ source: "バリアユニットを使う。", target: "使用别的东西。", tables }), null);
  // 未命中
  assert.equal(evaluateTermRow({ source: "今日はいい天気だ。", target: "今天天气不错。", tables }), null);
});

test("非人名条目声明注音时，中日两侧都注音才算「表里那个专有名词」", () => {
  const tables = loadFixtureTables();

  // 误判修复：正文里的「ＧＰＳ発信機」是普通词义（发射机），表里那条「発信機/ナノデバイス」
  // 指的是另一个装备——只对上基文不能算命中，整行交回后续流程而不是报“译名差异”。
  const plainWord = evaluateTermRow({ source: "ＧＰＳ発信機を取り外す。", target: "取下GPS信号发射机。", tables });
  assert.equal(plainWord, null, "只对上基文、且译文没用该项目译名：不算命中");
  const wrongRuby = evaluateTermRow({ source: `ＧＰＳ${withRuby("発信機", "そうち")}を取り外す。`, target: "取下GPS信号发射机。", tables });
  assert.equal(wrongRuby, null, "原文注文与表里不一致时同样不算命中");

  // 只对上原文侧注音、译文侧没注音 → 降级为「只作一致性证据」：
  // 译文用了该项目译名才算命中；译文没用（发射机）时**不算命中、不注入、不指控**（刻意选的保守方向）。
  const demotedHit = evaluateTermRow({ source: `ＧＰＳ${withRuby("発信機", "はっしんき")}を取り外す。`, target: "取下GPS发信器。", tables });
  assert.equal(demotedHit.kind, "consistent");
  assert.equal(demotedHit.hits[0].entry.plainSource, "発信機");
  assert.equal(demotedHit.hits[0].demoted, true);
  assert.equal(demotedHit.rubySkipped, 0);
  assert.equal(demotedHit.rubyDemoted, 1, "降级命中的候选要如实报数");
  const demotedMiss = evaluateTermRow({ source: `ＧＰＳ${withRuby("発信機", "はっしんき")}を取り外す。`, target: "取下GPS信号发射机。", tables });
  assert.equal(demotedMiss, null, "只有原文侧注音不足以指控译名差异");
  const rejectedSamples = [];
  findTermHits(`ＧＰＳ${withRuby("発信機", "はっしんき")}を取り外す。`, tables, { target: "取下GPS信号发射机。", rejected: rejectedSamples });
  assert.deepEqual(rejectedSamples.map((item) => item.entry.plainSource), ["発信機"], "被排除的候选要如实报数");

  // 双侧都注音（原文注音对上 + 译文里也注了该词）→ 完整口径，不是降级命中。
  // 译文注的是该项目译名时结论是「一致」；注的是表外写法但读音对得上时，才是真正的译名差异（见下一个用例）。
  const both = evaluateTermRow({
    source: `ＧＰＳ${withRuby("発信機", "はっしんき")}を取り外す。`,
    target: `取下GPS${withRuby("发信器", "Nano-Device")}。`,
    tables,
  });
  assert.equal(both.kind, "consistent");
  assert.equal(both.hits[0].demoted, false);
  assert.equal(both.hits[0].consistent, true);
  assert.equal(both.rubyDemoted, 0);

  // 注文以正文形式出现（原文直接写出别名，而不是用注音标注）同样算原文侧证据；译文侧没注音仍是降级。
  const plainRuby = evaluateTermRow({ source: "これは発信機、はっしんきだ。", target: "这是发信器。", tables });
  assert.equal(plainRuby.kind, "consistent");
  assert.equal(plainRuby.hits[0].demoted, true);

  // 同一行里既有只对上基文的出现、又有对上原文注音的出现，译文也确实用了该译名：降级命中成立。
  const mixed = evaluateTermRow({
    source: `ＧＰＳ発信機と${withRuby("発信機", "はっしんき")}が並んでいる。`,
    target: "GPS发射机和发信器并排放着。",
    tables,
  });
  assert.equal(mixed.kind, "consistent");
  assert.equal(mixed.hits[0].demoted, true);
  assert.equal(mixed.rubySkipped, 0, "译文用了该译名：降级命中成立，不算排除");
  assert.ok(mixed.rubyDemoted >= 1);

  // 译文里连该译名都没有（降级且无法确认一致）：整条不算命中，两个条目的候选都如实报数。
  const skipped = evaluateTermRow({ source: "発信機と東雲寺を運ぶ。", target: "搬运这种装置。", tables });
  assert.equal(skipped, null);
  assert.equal(
    findTermHits("発信機と東雲寺を運ぶ。", tables, { target: "搬运这种装置。" }).some((hit) => hit.scope === "term"),
    false,
    "两个带注音的条目都只有基文命中：整条命中一个都不留",
  );
  const rejected = [];
  findTermHits("発信機と東雲寺を運ぶ。", tables, { target: "搬运这种装置。", rejected });
  assert.deepEqual(rejected.map((item) => item.entry.plainSource).sort(), ["東雲寺", "発信機"]);
  // 开关：关掉这条口径后回到旧行为（仅用于对比排查）。
  assert.equal(findTermHits("ＧＰＳ発信機を取り外す。", tables, { rubyStrict: false }).length, 1);
  // 不提供译文时同样退回旧口径：不能因为“拿不到译文”把注音条目整批当降级。
  assert.equal(findTermHits(`ＧＰＳ${withRuby("発信機", "はっしんき")}を取り外す。`, tables).length, 1);

  // 人名豁免：原文里的人名只在首次出现时注音，之后不带注音也必须照常判定。
  assert.equal(evaluateTermRow({ source: "東雲太郎は来なかった。", target: "他没有来。", tables }).kind, "conflict");

  // 原文把「しょ」写成全尺寸的「しよ」（しよくほう）时，仍要与表里的「しょくほう」算同一个读音。
  const fullWidth = evaluateTermRow({
    source: withRuby("常盤台中学", "ときわだいちゆうがく"),
    target: "常盘台中学",
    tables,
  });
  assert.equal(fullWidth.kind, "term-only");
});

test("注音只是这个词本身的普通读音时不再整条排除（魔術 → 魔法）", () => {
  const tables = loadFixtureTables();

  // 原文与译文两侧都不注音（没有作者会给普通词标读音）：旧口径把它整条排除，行被裸着交给模型，
  // 模型只能按通用词典把 魔術 判成「魔术」。新口径下它是降级命中：译文用了译名表译名 → 出一致结论。
  const evaluation = evaluateTermRow({ source: "魔術。", target: "魔法。", tables });
  assert.equal(evaluation.kind, "term-only", "整行有效内容就是术语 → 译名表直接出结论、跳过模型");
  assert.equal(evaluation.hits[0].entry.plainSource, "魔術");
  assert.equal(evaluation.hits[0].demoted, true);
  assert.equal(evaluation.hits[0].consistent, true);
  assert.equal(evaluation.rubySkipped, 0, "不再因为“注音没对上”整条排除");
  assert.equal(evaluation.rubyDemoted, 1);

  // 备注要写清这是「译文用了该项目译名」的证据，不据此判定译名对错。
  const result = makeTermResult({ index: 355 }, { jp: "原文 A", cn: "主文本（待修改文本）", tw: "" }, evaluation, "bilingual", "cn");
  assert.equal(result.status, "term-prefilter");
  assert.match(result.note, /魔術 → 魔法/);
  assert.match(result.note, /未双侧注音，只作一致性证据/);
  assert.equal(/请人工确认是否需要替换/.test(result.note), false, "不得写成必须替换的指控");

  // 反向：译文写成表外的「魔术」时，降级口径**不指控**（静默交回后续流程）——与本文件头的保守方向一致。
  assert.equal(evaluateTermRow({ source: "魔術。", target: "魔术。", tables }), null);

  // 真·双语注音专有名词（能力名）：两侧都注音 → 完整口径，不是降级命中。
  const both = evaluateTermRow({
    source: `${withRuby("心理掌握", "メンタルアウト")}。`,
    target: `${withRuby("心理掌握", "Mental Out")}。`,
    tables,
  });
  assert.equal(both.kind, "term-only");
  assert.equal(both.hits[0].demoted, false);
  assert.equal(both.rubyDemoted, 0);
  // 只有原文侧注音（译文没注音）：降级——译文用了译名仍算一致，译文没用就不算命中。
  const oneSided = evaluateTermRow({ source: `${withRuby("心理掌握", "メンタルアウト")}を使う。`, target: "使用心理掌握。", tables });
  assert.equal(oneSided.hits[0].demoted, true);
  assert.equal(evaluateTermRow({ source: `${withRuby("心理掌握", "メンタルアウト")}を使う。`, target: "使用别的能力。", tables }), null);
  // 译文注音的是别的词（既不是该条目的中文译名，注音也不是表里那条读音）：不算译文侧证据，仍走降级。
  const wrongTargetRuby = evaluateTermRow({
    source: `${withRuby("心理掌握", "メンタルアウト")}を使う。`,
    target: `使用${withRuby("别的能力", "Other Power")}。`,
    tables,
  });
  assert.equal(wrongTargetRuby, null, "译文侧的注音要落在该条目的中文译名或其读音上");

  // 译文用了表外的中文写法、但注音就是表里那条读音（ruby_trans）：
  // 这仍是「中日两侧都注音」，而且正是要指控的译名不一致（表里 心理掌握，译文写别的词）。
  const foreignSpelling = evaluateTermRow({
    source: `${withRuby("心理掌握", "メンタルアウト")}を使う。`,
    target: `使用${withRuby("心理操作", "Mental Out")}。`,
    tables,
  });
  assert.equal(foreignSpelling.kind, "conflict", "注音对上了就是表里那个词：译文没用该项目译名要报出来");
  assert.equal(foreignSpelling.hits[0].demoted, false);
  assert.equal(foreignSpelling.hits[0].entry.plainSource, "心理掌握");
});

test("只有整行有效内容都是术语时才跳过模型", () => {
  const tables = loadFixtureTables();

  // 整行就是术语（术语之外只剩一个助词）：译名表能给出完整结论，允许跳过模型。
  const termOnly = evaluateTermRow({ source: `${withRuby("結界装置", "バリアユニット")}だ。`, target: "这是【结界装置】。", tables });
  assert.equal(termOnly.kind, "term-only");
  assert.equal(termOnly.coverage.residue, 1);
  assert.equal(termOnly.coverage.residueText, "だ");
  assert.equal(termOnly.coverage.skip, true);
  assert.equal(evaluateTermRow({ source: withRuby("発信機", "はっしんき"), target: "【发信器】", tables }).kind, "term-only");

  // 句中还有正常内容：命中的术语再一致，也不能把整句当成“翻译没问题”。
  const embedded = evaluateTermRow({
    source: `それは${withRuby("結界装置", "バリアユニット")}という名前の能力だ。`,
    target: "那是名为结界装置的能力。",
    tables,
  });
  assert.equal(embedded.kind, "consistent", "术语之外还有内容时必须继续交给模型");
  assert.ok(embedded.coverage.residue >= 8);

  const mixed = evaluateTermRow({ source: "東雲太郎は笑いながら歩いた。", target: "東雲太郎笑着走了。", tables });
  assert.equal(mixed.kind, "consistent");
  assert.equal(mixed.coverage.residueText, "は笑いながら歩いた");
  assert.ok(mixed.coverage.ratio > 0.2);
});

test("短词不会在长词内部误命中，注音内容不参与匹配", () => {
  const kanaFile = path.join(tempDir, "kana.csv");
  fs.writeFileSync(kanaFile, [
    "Base_Ori,Ruby_Ori,Base_Trans,Type",
    "タク,,巧,人名/日式名字",
    "サポートシステム,,支援系统,术语",
  ].join("\n"), "utf8");
  const kanaTables = loadTermTables([kanaFile]);
  // 2 字假名条目（タク）在载入阶段就被排除：它会落在 サンタクロース 这类长词片段里；
  // 4 字及以上的假名术语正常参与匹配。
  assert.equal(kanaTables.entries.length, 1);
  assert.deepEqual(findTermHits("サンタクロースと違って", kanaTables), []);
  assert.deepEqual(findTermHits("タクは笑った", kanaTables), []);
  assert.equal(findTermHits("サポートシステムを使う", kanaTables).length, 1);
  // 注音 rt 内容不参与匹配：读音不是正文（否则读音会与后面的正文拼成长词串误命中）
  const tables = loadFixtureTables();
  const rtHits = findTermHits("<ruby>東雲寺<rt>しののめでら</rt></ruby>の前", tables);
  assert.equal(rtHits.every((hit) => hit.scope !== "ruby"), true, "rt 里的读音不能参与匹配");
  assert.equal(rtHits.some((hit) => hit.alias === "東雲寺"), true, "基文仍然要参与匹配");
});

test("术语提示只注入本行真正用到的条目", () => {
  const tables = loadFixtureTables();
  const source = `それは${withRuby("結界装置", "バリアユニット")}という名前の能力だ。`;
  const evaluation = evaluateTermRow({ source, target: "那是名为结界装置的能力。", tables });
  const guidance = termGuidanceFor({ index: 5, jp: source }, { evaluation, targetKey: "cn", targetLabel: "主文本（待修改文本）" });
  assert.equal(guidance.count, 1);
  assert.match(guidance.block, /^【术语（译名表命中）】/);
  assert.match(guidance.block, /- 結界装置 → 结界装置（装置）/);
  assert.match(guidance.block, /术语判断是本次分析里的一个环节/);
  assert.match(guidance.block, /边界：译名表只能证明术语译名对不对/);
  // 命中但译文里找不到该术语：仍要提示（可能是真漏译），措辞面向模型（要不要改由模型判断）。
  const missingSource = "東雲太郎は来なかった。";
  const missing = evaluateTermRow({ source: missingSource, target: "他没有来。", tables });
  const missingGuidance = termGuidanceFor({ index: 6, jp: missingSource }, { evaluation: missing, targetKey: "cn", targetLabel: "B" });
  assert.match(missingGuidance.terms[0].text, /译文未出现该译名，请判断此处是否确指该术语/);
  assert.equal(/请人工确认是否需要替换/.test(missingGuidance.terms[0].text), false, "提示词不写面向人工的结论口吻");
  // 一行里既有整条术语命中、又有分段写法命中：提示只保留整条术语（分段写法的证据太弱，
  // 同姓的其他角色会靠共用分段集体挤进提示词）。
  const mixedSource = `東雲は来なかった。だが${withRuby("結界装置", "バリアユニット")}は動いた。`;
  const mixedRow = evaluateTermRow({ source: mixedSource, target: "东云没有来。但结界装置启动了。", tables });
  const partGuidance = termGuidanceFor({ index: 6, jp: mixedSource }, { evaluation: mixedRow, targetKey: "cn", targetLabel: "B" });
  assert.equal(partGuidance.count, 1);
  assert.match(partGuidance.block, /- 結界装置 → 结界装置（装置）/);
  assert.equal(/東雲太郎/.test(partGuidance.block), false, "分段写法不进提示词");
  // 只靠读音撞车：译文里出现的是别的角色的名字（同姓），本行并没有用到这个术语 → 不注入，
  // 否则等于让模型去找一个本行根本不会出现的词（同一姓氏下会靠共用读音集体命中）。
  const noiseSource = "しののめが来た。だがバリアユニットは動いた。";
  const rubyNoise = evaluateTermRow({ source: noiseSource, target: "但别的人来了。结界装置启动了。", tables });
  assert.equal(rubyNoise.kind, "consistent");
  assert.equal(rubyNoise.hits[0].scope, "ruby");
  assert.equal(rubyNoise.hits[0].consistent, null, "读音不能确认一致性");
  const noiseGuidance = termGuidanceFor({ index: 7, jp: noiseSource }, { evaluation: rubyNoise, targetKey: "cn", targetLabel: "B" });
  assert.equal(noiseGuidance.terms.some((term) => term.source.includes("東雲")), false, "读音撞车且译文里没有该术语时不该注入");
  assert.equal(noiseGuidance.terms.some((term) => term.source.includes("結界装置")), true, "该行真正用到的术语仍要注入");
  // 读音撞车的条目真的出现在译文里时：仍然注入（这条证据是成立的）。
  const rubyReal = evaluateTermRow({ source: noiseSource, target: "东云来了。但结界装置启动了。", tables });
  const realGuidance = termGuidanceFor({ index: 7, jp: noiseSource }, { evaluation: rubyReal, targetKey: "cn", targetLabel: "B" });
  assert.equal(realGuidance.terms.some((term) => term.source.includes("東雲")), true);
});

test("译名表只写「整行只有术语」的备注，冲突行改由模型出结论", () => {

  const tables = loadFixtureTables();
  const labels = { jp: "原文 A", cn: "主文本（待修改文本）", tw: "非原文 C" };

  // 整行只有术语：跳过模型，备注要写清跳过的理由。
  const termOnly = makeTermResult({ index: 838 }, labels, evaluateTermRow({
    source: `${withRuby("結界装置", "バリアユニット")}だ。`,
    target: "这是【结界装置】。",
    tables,
  }), "bilingual", "cn");
  assert.match(termOnly.note, new RegExp(`^${TERM_MARKER.replace("[", "\\[")}`));
  assert.match(termOnly.note, /语义是否相同：相同/);
  assert.match(termOnly.note, /是否需要修改：否/);
  assert.match(termOnly.note, /该行有效内容全部是本项目术语/);
  assert.equal(termOnly.done, true);
  assert.equal(termOnly.status, "term-prefilter");

  // 术语一致但句中还有别的内容：不写“无需修改”的完成态——那一行根本不由译名表出结论。
  const injected = evaluateTermRow({
    source: "東雲太郎は言った。",
    target: "東雲太郎说道。",
    tables,
  });
  assert.equal(injected.kind, "consistent");
  assert.throws(() => makeTermResult({ index: 841 }, labels, injected, "bilingual", "cn"), /只写「整行只有术语」的结论/);

  // 术语冲突同样不由译名表出结论：它注入提示词后交给模型，所以写备注的入口直接报错。
  const conflictSource = "召喚陣を使う。";
  const conflictEvaluation = evaluateTermRow({
    source: conflictSource,
    target: "使用魔法阵。",
    tables,
  });
  assert.equal(conflictEvaluation.kind, "conflict");
  assert.throws(
    () => makeTermResult({ index: 839 }, labels, conflictEvaluation, "bilingual", "cn"),
    /只写「整行只有术语」的结论/,
    "术语冲突不再写成面向人工的结论",
  );
  // 差异明细仍可供离线审计与人工核对模型的判断依据。
  assert.match(conflictAnalysisHead(conflictEvaluation.hits), /召喚陣 → 召唤阵/);
  const guidance = termGuidanceFor(
    { index: 839, jp: conflictSource },
    { evaluation: conflictEvaluation, targetKey: "cn", targetLabel: "B" },
  );
  assert.match(guidance.terms[0].text, /译文未出现该译名，请判断此处是否确指该术语/);

  const replacedEvaluation = evaluateTermRow({
    source: "召喚陣を使う。",
    target: "使用Summon Circle。",
    tables,
  });
  assert.equal(replacedEvaluation.kind, "conflict");
  // 只替换术语会是什么样子仍然算出来（审计参考），但它不再是结论。
  assert.equal(replacedEvaluation.revisedText, "使用【召唤阵】。");
  assert.throws(() => makeTermResult({ index: 840 }, labels, replacedEvaluation, "bilingual", "cn"), /只写「整行只有术语」的结论/);
});

test("冲突明细只列真正的译名差异，一致项与分段命中只给计数", () => {
  const tables = loadFixtureTables();

  // 一行里同时有三种命中：真差异（召喚陣 没译成「召唤阵」）、已确认一致（聖堂教会）、
  // 以及只出现姓氏「東雲」而带出的分段命中（東雲太郎，本行并没有写全名）。
  const evaluation = evaluateTermRow({
    source: "東雲は召喚陣を聖堂教会に置いた。",
    target: "东云把魔法阵放在了圣堂教会。",
    tables,
  });
  assert.equal(evaluation.kind, "conflict");
  assert.equal(evaluation.hits.length, 3);
  // 术语冲突不再写备注，差异明细由离线审计报告使用（同一份措辞，人工据此核对模型结论）。
  const head = conflictAnalysisHead(evaluation.hits);

  // 明细只列差异项；标题的条数口径与明细一致。
  assert.match(head, /命中译名表 3 条，其中 1 条存在译名差异：/);
  assert.match(head, /召喚陣 → 召唤阵/);
  assert.match(head, /（另有 1 条已确认一致、1 条原文只有分段或读音写法，未参与差异判定）/);
  // 一致项与分段命中的条目名不再进明细：旧版把它们贴在「存在译名差异」标题下，
  // 同一句里既有「译文已使用该译名」又有「未参与译名一致性判定」，人工要读完整串才找到真差异。
  assert.equal(/聖堂教会 → 圣堂教会/.test(head), false, "已确认一致的条目不该列进差异明细");
  assert.equal(/東雲太郎 → 東雲太郎/.test(head), false, "只命中分段写法的同姓角色不该列进差异明细");
  assert.equal(/未参与译名一致性判定/.test(head), false);
  assert.equal(/译文已使用该译名/.test(head), false);
});

test("假名写法的术语不由译名表定论，改为注入提示交给模型判断", () => {
  const file = path.join(tempDir, "kana-terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Type",
    "グループ,,GROUP,组织/暗部",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);

  // 原文「頂点グループ」是普通名词用法，译文写成“一类人”是对的；但同一写法在别的场景确实指那个组织，
  // 所以既不粗暴删条目、也不由译名表定论：标成 advisory，把判断权交给模型（人工核对模型结论）。
  const source = "街の八割、実に一八〇万人を一律で分類する六段階評価の、まさに頂点グループ。";
  const evaluation = evaluateTermRow({
    source,
    target: "在将都市居民的八成、实际总共180万人进行统一分类的六级评价系统中，处于顶级位置的一类人。",
    tables,
  });
  assert.equal(evaluation.kind, "advisory");
  assert.equal(evaluation.advisory.length, 1);
  assert.equal(evaluation.advisory[0].entry.plainSource, "グループ");
  assert.equal(evaluation.advisory[0].variant, null);

  // 译名表不给结论：advisory 行不许走 makeTermResult（它只写「整行只有术语」这一种结论）。
  assert.throws(
    () => makeTermResult({ index: 843 }, { jp: "原文 A", cn: "主文本（待修改文本）", tw: "" }, evaluation, "bilingual", "cn"),
    /只写「整行只有术语」的结论/,
  );

  // 改为注入提示词：模型必须结合上下文判断此处是否确指该术语，而不是机械替换。
  const guidance = termGuidanceFor({ index: 843, jp: source }, { evaluation, targetKey: "cn", targetLabel: "主文本（待修改文本）" });
  assert.equal(guidance.terms.length, 1);
  assert.equal(guidance.terms[0].advisory, true);
  assert.equal(guidance.terms[0].source, "グループ");
  assert.match(guidance.terms[0].note, /原文命中的是假名写法（可能是普通词或音译名），译文未使用该译名——请结合上下文判断/);
  assert.match(guidance.terms[0].note, /只是普通词义时按普通词处理，不要强改/);
  assert.match(guidance.terms[0].text, /（可能为普通词，需结合上下文判断）/);
  assert.equal(/请人工确认是否需要替换/.test(guidance.terms[0].note), false, "存疑项不得写成必须替换的指控");
});

test("真差异与假名存疑同时命中时，明细只列真差异、存疑项只给计数", () => {
  const file = path.join(tempDir, "mixed-terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Type",
    "グループ,,GROUP,组织/暗部",
    "【召喚陣】,,【召唤阵】,术式",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);

  const evaluation = evaluateTermRow({
    source: "頂点グループを召喚陣で探す。",
    target: "用魔法阵寻找顶点集团。",
    tables,
  });
  // 有强证据差异时整行仍交给模型，差异明细只列真差异，存疑项不能被写成差异。
  assert.equal(evaluation.kind, "conflict");
  const head = conflictAnalysisHead(evaluation.hits);
  assert.match(head, /命中译名表 2 条，其中 1 条存在译名差异：召喚陣 → 召唤阵/);
  assert.match(head, /（另有 1 条命中的是假名写法、可能为普通词，需结合上下文判断）/);
  assert.equal(/グループ → GROUP（组织\/暗部）：译文未出现该译名/.test(head), false, "存疑项不得写成译名差异");
});
