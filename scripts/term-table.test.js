const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  evaluateTermRow,
  findTermHits,
  loadTermTables,
  normalizeTermEntry,
  splitBracketed,
  stripInlineMarkup,
  stripMarks,
  termAliases,
} = require("../src/workbenches/translation-compare/ai/term-table");
const { makeTermResult, TERM_MARKER } = require("../src/workbenches/translation-compare/ai/term-prefilter");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-term-"));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

test("对照表解析：表头驱动、去装饰、分段与别名生成", () => {
  const entry = normalizeTermEntry({
    base_ori: "【東雲】【太郎】",
    ruby_ori: "しののめ,たろう",
    base_trans: "東雲太郎",
    type: "人名/日式全名",
  });
  assert.deepEqual(entry.sourceParts, ["東雲", "太郎"]);
  // compareKey 走简繁归一：繁体基文与简体译名算同一个术语。
  assert.equal(entry.compareKey, "东云太郎");
  assert.deepEqual(entry.targetParts.map((part) => part.text), ["東雲", "太郎"]);

  const aliases = Object.fromEntries(termAliases(entry).map((item) => [item.alias, `${item.scope}${item.strong ? "/strong" : ""}`]));
  assert.equal(aliases["東雲太郎"], "term/strong");
  assert.equal(aliases["東雲"], "part");
  assert.equal(aliases["太郎"], "part");
  assert.equal(aliases["しののめ"], "ruby");
  assert.equal(aliases["しののめたろう"], "ruby");

  // 短词（2 字）不算强证据，只能确认一致；读音与分段同样不判定。
  const shortEntry = normalizeTermEntry({ base_ori: "【時代】", base_trans: "【时代】", type: "术语" });
  assert.equal(termAliases(shortEntry).every((item) => item.strong === false), true);

  assert.deepEqual(splitBracketed("【山吹】中学正面基地局"), ["中学正面基地局", "山吹"]);
  assert.equal(stripMarks("【结界装置】"), "结界装置");
  assert.equal(stripInlineMarkup("<ruby>東雲<rt>しののめ</rt></ruby>は笑った"), "東雲は笑った");
});

function loadFixtureTables() {
  const file = path.join(tempDir, "terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Ruby_Trans,Other_Fandom,Type",
    '【東雲】【太郎】,"しののめ,たろう",東雲太郎,Shinonome Taro,SHINONOME Taro,人名/日式全名',
    "【結界装置】,バリアユニット,【结界装置】,Barrier Unit,,装置",
    "【東雲寺】,しののめでら,东云寺,,,地名",
    "【時代】,じだい,【时代】,,,术语",
    "【発信機】,はっしんき,【发信器】,,,科技/装备",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);
  return tables;
}

test("判定规则：命中整条术语才判，短词/读音/分段只确认或记录", () => {
  const tables = loadFixtureTables();

  // 一致：整条译名出现
  assert.equal(evaluateTermRow({ source: "東雲太郎は言った。", target: "東雲太郎说道。", tables }).kind, "consistent");
  // 一致：只写姓或名（分段写法）
  const partial = evaluateTermRow({ source: "東雲太郎は言った。", target: "東雲说道。", tables });
  assert.equal(partial.kind, "consistent");
  assert.equal(partial.hits[0].via, "part");
  // 一致：括号/字形差异
  assert.equal(evaluateTermRow({ source: "それは【結界装置】だ。", target: "那是名为结界装置的能力。", tables }).kind, "consistent");
  // 冲突：整条术语没使用本项目译名（≥3 字强证据）
  const conflict = evaluateTermRow({ source: "ＧＰＳ発信機を取り外す。", target: "取下GPS信号发射机。", tables });
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.hits[0].consistent, false);
  assert.equal(conflict.revisedText, "", "没有可定位的旧译名时不能编造替换文本");
  // 冲突：译文里出现的是“其他译法”，给出最小替换
  const replaced = evaluateTermRow({ source: "【結界装置】を使う。", target: "使用Barrier Unit。", tables });
  assert.equal(replaced.kind, "conflict");
  assert.equal(replaced.revisedText, "使用【结界装置】。");
  // 短词不算强证据：命中但不判定，交回后续流程
  const shortTerm = evaluateTermRow({ source: "その時代の話だ。", target: "那是这年头的事。", tables });
  assert.equal(shortTerm, null);
  // 短词命中且译文一致：仍然可以确认一致
  assert.equal(evaluateTermRow({ source: "その時代の話だ。", target: "那是【时代】的话题。", tables }).kind, "consistent");
  // 只命中读音：不判定
  assert.equal(evaluateTermRow({ source: "バリアユニットを使う。", target: "使用别的东西。", tables }), null);
  // 未命中
  assert.equal(evaluateTermRow({ source: "今日はいい天気だ。", target: "今天天气不错。", tables }), null);
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

test("对照表结果写成可解析的备注，并区分一致与待确认", () => {

  const tables = loadFixtureTables();
  const labels = { jp: "原文 A", cn: "主文本（待修改文本）", tw: "非原文 C" };

  const consistent = makeTermResult({ index: 838 }, labels, evaluateTermRow({
    source: "東雲太郎は言った。",
    target: "東雲太郎说道。",
    tables,
  }), "bilingual", "cn");
  assert.match(consistent.note, new RegExp(`^${TERM_MARKER.replace("[", "\\[")}`));
  assert.match(consistent.note, /语义是否相同：相同/);
  assert.match(consistent.note, /是否需要修改：否/);
  assert.equal(consistent.done, true);
  assert.equal(consistent.status, "term-prefilter");

  const conflict = makeTermResult({ index: 839 }, labels, evaluateTermRow({
    source: "ＧＰＳ発信機を取り外す。",
    target: "取下GPS信号发射机。",
    tables,
  }), "bilingual", "cn");
  assert.match(conflict.note, /是否需要修改：待人工确认/);
  assert.match(conflict.note, /【発信機】 → 【发信器】/);
  assert.equal(conflict.done, false);
  assert.equal(conflict.status, "suggestion");
  assert.equal(/修改结果：/.test(conflict.note), false, "没有确定替换时不应输出修改结果");

  const replaced = makeTermResult({ index: 840 }, labels, evaluateTermRow({
    source: "【結界装置】を使う。",
    target: "使用Barrier Unit。",
    tables,
  }), "bilingual", "cn");
  assert.match(replaced.note, /是否需要修改：是/);
  assert.match(replaced.note, /修改结果：使用【结界装置】。/);
});
