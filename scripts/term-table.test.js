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
const { makeTermResult, TERM_MARKER, termGuidanceFor } = require("../src/workbenches/translation-compare/ai/term-prefilter");

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

  // 短词（2 字）不算强证据，只能确认一致；读音与分段同样不判定。
  const shortEntry = normalizeTermEntry({ base_ori: "【時代】", base_trans: "【时代】", type: "术语" });
  assert.equal(termAliases(shortEntry).every((item) => item.strong === false), true);

  assert.deepEqual(splitBracketed("【山吹】中学正面基地局"), ["中学正面基地局", "山吹"]);
  assert.equal(stripMarks("【结界装置】"), "结界装置");
  assert.equal(stripInlineMarkup("<ruby>東雲<rt>しののめ</rt></ruby>は笑った"), "東雲は笑った");
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
    "【時代】,じだい,【时代】,,,术语",
    "【発信機】,はっしんき,【发信器】,,,科技/装备",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);
  return tables;
}

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

test("只有整行有效内容都是术语时才跳过模型", () => {
  const tables = loadFixtureTables();

  // 整行就是术语（术语之外只剩一个助词）：对照表能给出完整结论，允许跳过模型。
  const termOnly = evaluateTermRow({ source: "【結界装置】だ。", target: "这是【结界装置】。", tables });
  assert.equal(termOnly.kind, "term-only");
  assert.equal(termOnly.coverage.residue, 1);
  assert.equal(termOnly.coverage.residueText, "だ");
  assert.equal(termOnly.coverage.skip, true);
  assert.equal(evaluateTermRow({ source: "【発信機】", target: "【发信器】", tables }).kind, "term-only");

  // 句中还有正常内容：命中的术语再一致，也不能把整句当成“翻译没问题”。
  const embedded = evaluateTermRow({
    source: "それは【結界装置】という名前の能力だ。",
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
  const source = "それは【結界装置】という名前の能力だ。";
  const evaluation = evaluateTermRow({ source, target: "那是名为结界装置的能力。", tables });
  const guidance = termGuidanceFor({ index: 5, jp: source }, { evaluation, targetKey: "cn", targetLabel: "主文本（待修改文本）" });
  assert.equal(guidance.count, 1);
  assert.match(guidance.block, /^【术语（对照表命中）】/);
  assert.match(guidance.block, /- 結界装置 → 结界装置（装置）/);
  assert.match(guidance.block, /边界：对照表只能证明术语译名对不对/);
  // 命中但译文里找不到该术语：仍要提示（可能是真漏译），并说明依据。
  const missingSource = "東雲太郎は来なかった。";
  const missing = evaluateTermRow({ source: missingSource, target: "他没有来。", tables });
  const missingGuidance = termGuidanceFor({ index: 6, jp: missingSource }, { evaluation: missing, targetKey: "cn", targetLabel: "B" });
  assert.match(missingGuidance.terms[0].text, /译文未出现该译名，请人工确认是否需要替换/);
  // 一行里既有整条术语命中、又有分段写法命中：提示只保留整条术语（分段写法的证据太弱，
  // 同姓的其他角色会靠共用分段集体挤进提示词）。
  const mixedSource = "東雲は来なかった。だが【結界装置】は動いた。";
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

test("对照表结果写成可解析的备注，并区分一致与待确认", () => {

  const tables = loadFixtureTables();
  const labels = { jp: "原文 A", cn: "主文本（待修改文本）", tw: "非原文 C" };

  // 整行只有术语：跳过模型，备注要写清跳过的理由。
  const termOnly = makeTermResult({ index: 838 }, labels, evaluateTermRow({
    source: "【結界装置】だ。",
    target: "这是【结界装置】。",
    tables,
  }), "bilingual", "cn");
  assert.match(termOnly.note, new RegExp(`^${TERM_MARKER.replace("[", "\\[")}`));
  assert.match(termOnly.note, /语义是否相同：相同/);
  assert.match(termOnly.note, /是否需要修改：否/);
  assert.match(termOnly.note, /该行有效内容全部是本项目术语/);
  assert.equal(termOnly.done, true);
  assert.equal(termOnly.status, "term-prefilter");

  // 术语一致但句中还有别的内容：不写“无需修改”的完成态——那一行根本不由对照表出结论。
  const injected = evaluateTermRow({
    source: "東雲太郎は言った。",
    target: "東雲太郎说道。",
    tables,
  });
  assert.equal(injected.kind, "consistent");
  assert.throws(() => makeTermResult({ index: 841 }, labels, injected, "bilingual", "cn"), /只能写纯术语行或冲突行/);

  const conflict = makeTermResult({ index: 839 }, labels, evaluateTermRow({
    source: "ＧＰＳ発信機を取り外す。",
    target: "取下GPS信号发射机。",
    tables,
  }), "bilingual", "cn");
  assert.match(conflict.note, /是否需要修改：待人工确认/);
  assert.match(conflict.note, /発信機 → 发信器/);
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

test("冲突备注只列真正的译名差异，一致项与分段命中只给计数", () => {
  const tables = loadFixtureTables();
  const labels = { jp: "原文 A", cn: "主文本（待修改文本）", tw: "非原文 C" };

  // 一行里同时有三种命中：真差异（発信機 没译成「发信器」）、已确认一致（東雲寺）、
  // 以及只出现姓氏「東雲」而带出的分段命中（東雲太郎，本行并没有写全名）。
  const evaluation = evaluateTermRow({
    source: "東雲は発信機を東雲寺に置いた。",
    target: "东云把发射机放在了东云寺。",
    tables,
  });
  assert.equal(evaluation.kind, "conflict");
  assert.equal(evaluation.hits.length, 3);
  const note = makeTermResult({ index: 842 }, labels, evaluation, "bilingual", "cn").note;

  // 明细只列差异项；标题的条数口径与明细一致。
  assert.match(note, /命中对照表 3 条，其中 1 条存在译名差异：/);
  assert.match(note, /発信機 → 发信器/);
  assert.match(note, /（另有 1 条已确认一致、1 条原文只有分段或读音写法，未参与差异判定）/);
  // 一致项与分段命中的条目名不再进明细：旧版把它们贴在「存在译名差异」标题下，
  // 同一句里既有「译文已使用该译名」又有「未参与译名一致性判定」，人工要读完整串才找到真差异。
  assert.equal(/東雲寺 → 东云寺/.test(note), false, "已确认一致的条目不该列进差异明细");
  assert.equal(/東雲太郎 → 東雲太郎/.test(note), false, "只命中分段写法的同姓角色不该列进差异明细");
  assert.equal(/未参与译名一致性判定/.test(note), false);
  assert.equal(/译文已使用该译名/.test(note), false);
});

test("假名写法的术语不由对照表定论，改为注入提示交给模型判断", () => {
  const file = path.join(tempDir, "kana-terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Type",
    "グループ,,GROUP,组织/暗部",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);

  // 原文「頂点グループ」是普通名词用法，译文写成“一类人”是对的；但同一写法在别的场景确实指那个组织，
  // 所以既不粗暴删条目、也不由对照表定论：标成 advisory，把判断权交给模型（人工核对模型结论）。
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

  // 对照表不给结论：advisory 行不许走 makeTermResult（它只处理纯术语行与冲突行）。
  assert.throws(
    () => makeTermResult({ index: 843 }, { jp: "原文 A", cn: "主文本（待修改文本）", tw: "" }, evaluation, "bilingual", "cn"),
    /只能写纯术语行或冲突行/,
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

test("真差异与假名存疑同时命中时，备注只列真差异、存疑项只给计数", () => {
  const file = path.join(tempDir, "mixed-terms.csv");
  fs.writeFileSync(file, [
    "Base_Ori,Ruby_Ori,Base_Trans,Type",
    "グループ,,GROUP,组织/暗部",
    "【発信機】,はっしんき,【发信器】,科技/装备",
  ].join("\n"), "utf8");
  const tables = loadTermTables([file]);
  assert.deepEqual(tables.errors, []);

  const evaluation = evaluateTermRow({
    source: "頂点グループをＧＰＳ発信機で探す。",
    target: "用GPS信号发射机寻找顶点集团。",
    tables,
  });
  // 有强证据差异时整行仍由对照表出结论（最小替换或转人工），但存疑项不能被写成差异。
  assert.equal(evaluation.kind, "conflict");
  const note = makeTermResult({ index: 844 }, { jp: "原文 A", cn: "主文本（待修改文本）", tw: "" }, evaluation, "bilingual", "cn").note;
  assert.match(note, /命中对照表 2 条，其中 1 条存在译名差异：発信機 → 发信器/);
  assert.match(note, /（另有 1 条命中的是假名写法、可能为普通词，需结合上下文判断）/);
  assert.equal(/グループ → GROUP（组织\/暗部）：译文未出现该译名/.test(note), false, "存疑项不得写成译名差异");
});
