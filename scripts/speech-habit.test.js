const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  activatedCharacterNames,
  chapterHabitBlock,
  characterAliases,
  compareVolume,
  describeHabit,
  detectCharacters,
  findHabitMisses,
  groupRowsByChapter,
  habitCandidatesForRow,
  hasHabitOccurrence,
  isHabitDetectable,
  loadSpeechTables,
  normalizeSpeechEntry,
  speakerCheckBlock,
  summarizeChapters,
  volumeHabitBlock,
  volumeKey,
  volumeKeyFromFiles,
} = require("../src/workbenches/translation-compare/ai/speech-habit");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-habits-"));

test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const HABIT_CSV = [
  "小说首次出现,角色,口癖,类型,x版,网翻,台版（转简中）,备注",
  "S1_04,甲野一郎,オレ,第一人称,本大爷,,俺,男性化自称",
  "S1_04,乙川次郎,ですの,谓语形式,的说,,,",
  "S1_08,丙山三郎,じゃん,谓语形式,的吧,,,",,
  "-,丁原四郎,力,名词后缀,力,,,XX力",
  "S2_01,戊田五郎,なの,句末语气词,-,嗯,,通常放在句尾",
  "S2_21,安娜·施普伦格尔,わらわ,第一人称,-,妾身,,古风化自称",
].join("\n");

function loadFixture() {
  const file = path.join(tempDir, "habits.csv");
  fs.writeFileSync(file, HABIT_CSV, "utf8");
  const tables = loadSpeechTables([file]);
  assert.deepEqual(tables.errors, []);
  return tables;
}

test("说话习惯表支持通用列名并保留原格式语义", () => {
  const file = path.join(tempDir, "generic-habits.csv");
  fs.writeFileSync(file, [
    "first-work,speaker,habit,type,target,other,reference,memo",
    "S1_04,甲野一郎,オレ,第一人称,本大爷,我,俺,男性化自称",
    ",乙川次郎,ですの,谓语形式,-,的说,,明确不作特殊处理",
  ].join("\n"), "utf8");
  const tables = loadSpeechTables([file]);
  assert.deepEqual(tables.errors, []);
  const [first, second] = tables.entries;
  assert.equal(first.character, "甲野一郎");
  assert.deepEqual(first.versions, { x: "本大爷", net: "我", tw: "俺" });
  assert.equal(first.firstWorkKey.code, "S1_04");
  assert.deepEqual(first.expectedWritings, ["本大爷"]);
  assert.equal(second.noSpecialHandling, true);
  assert.deepEqual(second.expectedWritings, []);
});

test("描述型习惯规则无需项目写法列，空白不等同于明确不处理", () => {
  const file = path.join(tempDir, "descriptive-habits.json");
  fs.writeFileSync(file, JSON.stringify([
    { 角色: "甲野一郎", 备注: "句尾采用口语短句" },
    { 角色: "乙川次郎", 备注: "语气正式", 项目写法: "" },
  ]), "utf8");
  const tables = loadSpeechTables([file]);
  assert.deepEqual(tables.errors, []);
  assert.equal(tables.entries.length, 2);
  assert.deepEqual(tables.entries.map((entry) => entry.noSpecialHandling), [false, false]);
  assert.deepEqual(tables.entries.map((entry) => entry.expectedWritings), [[], []]);
});

test("说话习惯表缺少角色或规则表头时报告格式要求", () => {
  for (const [name, content, missing] of [
    ["no-character.csv", "口癖,项目写法\nオレ,本大爷\n", /缺少必需表头：角色/],
    ["no-rule.csv", "角色,自定义列\n甲野一郎,说明\n", /口癖 \/ 项目写法 \/ 备注/],
  ]) {
    const file = path.join(tempDir, name);
    fs.writeFileSync(file, content, "utf8");
    const tables = loadSpeechTables([file]);
    assert.equal(tables.entries.length, 0);
    assert.match(tables.errors[0], missing);
  }
});

test("说话习惯表按表头解析，并生成强/弱名字关键词", () => {
  const tables = loadFixture();
  assert.equal(tables.entries.length, 6);
  const jiro = tables.entries.find((entry) => entry.character === "乙川次郎");
  assert.equal(jiro.habit, "ですの");
  assert.equal(jiro.type, "谓语形式");
  assert.deepEqual(jiro.expectedWritings, ["的说"]);

  assert.deepEqual(characterAliases("甲野一郎"), { strong: ["甲野一郎"], weak: ["甲野", "一郎"] });
  const western = characterAliases("凯兹·诺克莱本");
  assert.deepEqual(western.strong, ["凯兹·诺克莱本", "凯兹诺克莱本"]);
  assert.deepEqual(western.weak, ["凯兹", "诺克莱本"]);

  assert.equal(describeHabit(loadFixture().entries[0]), "甲野一郎：第一人称 「オレ」 → 本项目写作「本大爷」；「俺」（旧写法，不要回改）");
});

test("X版写 `-` 表示明确不作特殊处理，不得把网翻或台版当补回基准", () => {
  const tables = loadFixture();
  const go = tables.entries.find((entry) => entry.character === "戊田五郎");
  assert.deepEqual(go.versions, { x: "", net: "嗯", tw: "" });
  assert.equal(go.noSpecialHandling, true);
  assert.deepEqual(go.expectedWritings, []);
  assert.equal(isHabitDetectable(go), false);

  const rows = [{ index: 1, chapter: "第一章", jp: "「なの」と戊田五郎。", cn: "「的说」戊田五郎说。" }];
  const characters = detectCharacters({ rows, tables });
  assert.deepEqual(findHabitMisses({ source: rows[0].jp, target: rows[0].cn, characters }), []);
  const block = chapterHabitBlock({ chapter: "第一章", characters });
  assert.match(block, /戊田五郎：句末语气词 「なの」 → 不作特殊翻译处理，不得采用网翻版或台版写法（网翻「嗯」）/);
  assert.doesNotMatch(block, /本项目写作「嗯」/);
});

test("`わらわ` 按不作特殊处理注入，不能让模型回改成「妾身」", () => {
  const tables = loadFixture();
  const rows = [{
    index: 1,
    chapter: "行间〇",
    jp: "真実を知っているわらわからすれば、これはマサイク状態だわ、と安娜·施普伦格尔は言った。",
    cn: "在知晓真相的我看来，这已经是马赛克状态了呢。",
  }];
  const characters = detectCharacters({ rows, tables });
  const candidates = habitCandidatesForRow({ row: rows[0], characters });
  assert.deepEqual(candidates.map((item) => item.character), ["安娜·施普伦格尔"]);
  assert.equal(candidates[0].noSpecialHandling, true);
  assert.deepEqual(candidates[0].forbiddenWritings, [{ version: "网翻", value: "妾身" }]);
  assert.equal(candidates[0].detectable, false);

  const block = chapterHabitBlock({ chapter: "行间〇", characters });
  assert.match(block, /第一人称 「わらわ」 → 不作特殊翻译处理，不得采用网翻版或台版写法（网翻「妾身」）/);
  assert.doesNotMatch(block, /本项目写作「妾身」/);
  assert.deepEqual(findHabitMisses({ source: rows[0].jp, target: rows[0].cn, characters }), []);

  const speaker = speakerCheckBlock({ chapter: "行间〇", candidates });
  assert.match(speaker, /本项目明确不作特殊翻译处理的口癖/);
  assert.match(speaker, /不得采用网翻版或台版写法：网翻「妾身」/);
  assert.match(speaker, /不得据此判译文缺漏、扣分或要求补写/);
});

test("X版为 `-` 时同时禁止网翻版与台版写法", () => {
  const entry = normalizeSpeechEntry({
    角色: "测试角色",
    口癖: "测试口癖",
    类型: "第一人称",
    x版: "-",
    网翻: "网翻测试值",
    "台版（转简中）": "台版测试值",
    备注: "测试占位",
  });
  assert.match(
    describeHabit(entry),
    /不作特殊翻译处理，不得采用网翻版或台版写法（网翻「网翻测试值」；台版「台版测试值」）$/,
  );
});

test("卷号比较与从输入路径推断当前卷", () => {
  assert.deepEqual(volumeKey("S3_01"), { series: 3, volume: 1, code: "S3_01" });
  assert.equal(volumeKey("随便写的"), null);
  assert.equal(compareVolume(volumeKey("S1_04"), volumeKey("S3_01")) < 0, true);
  assert.equal(compareVolume(volumeKey("S4_01"), volumeKey("S3_01")) > 0, true);
  // 卷号从输入文件名推断：只认 [S<系列>_<卷序>] 这个前缀，标题文字不参与。
  const volume = volumeKeyFromFiles({ cn: "D:\\EPUB\\[S3_01]某示例作品 01X" });
  assert.equal(volume.code, "S3_01");
});

test("按章命中人名才启用该角色的说话特色，片段命中只报告", () => {
  const tables = loadFixture();
  const rows = [
    { index: 1, chapter: "第一章", jp: "「オレは関係ない」と甲野一郎は言った。", cn: "「跟我没关系」甲野一郎说道。" },
    { index: 2, chapter: "第一章", jp: "甲野の言葉に、一郎は頷いた。", cn: "甲野点了点头。" },
    { index: 3, chapter: "第二章", jp: "「〜じゃん」", cn: "「～吧」" },
  ];
  const groups = groupRowsByChapter(rows);
  assert.deepEqual(groups.map((group) => group.chapter), ["第一章", "第二章"]);

  const first = detectCharacters({ rows: groups[0].rows, tables });
  const jiro = first.find((item) => item.entry.character === "甲野一郎");
  assert.equal(jiro.activated, true, "出现全名即启用");
  assert.equal(jiro.detectedBy, "名字命中");

  // 只出现名字片段（甲野/一郎 两行）：不启用，只作提及。
  const fragmentOnly = detectCharacters({
    rows: [
      { index: 10, chapter: "第三章", jp: "甲野の話だ。", cn: "是甲野的事。" },
      { index: 11, chapter: "第三章", jp: "一郎は笑った。", cn: "一郎笑了。" },
      { index: 12, chapter: "第三章", jp: "甲野と言えば一郎。", cn: "说到甲野就是一郎。" },
    ],
    tables,
  });
  const mentioned = fragmentOnly.find((item) => item.entry.character === "甲野一郎");
  assert.equal(mentioned.activated, false);
  assert.equal(chapterHabitBlock({ chapter: "第三章", characters: fragmentOnly }), "", "只有片段命中时不注入习惯规则");

  // 卷过滤：S1_08 才登场的角色在 S3_01 之前的卷里不参与判定。
  const early = detectCharacters({
    rows: [{ index: 20, chapter: "第一章", jp: "丙山三郎が来た。", cn: "丙山三郎来了。" }],
    tables,
    volume: volumeKey("S1_04"),
  });
  assert.equal(early.some((item) => item.entry.character === "丙山三郎"), false);
  const later = detectCharacters({
    rows: [{ index: 20, chapter: "第一章", jp: "丙山三郎が来た。", cn: "丙山三郎来了。" }],
    tables,
    volume: volumeKey("S3_01"),
  });
  assert.equal(later.some((item) => item.entry.character === "丙山三郎"), true);
});

test("同一个角色的多条习惯只算一个角色名", () => {
  const tables = loadFixture();
  const detected = detectCharacters({
    rows: [{ index: 1, chapter: "第一章", jp: "甲野一郎が来た。乙川次郎も来た。", cn: "甲野一郎来了。乙川次郎也来了。" }],
    tables,
  });
  assert.equal(detected.length, 2);
  // 逐条取名字会把同一角色算两次；这里按角色去重（规则仍逐条写在提示词里）。
  assert.deepEqual(activatedCharacterNames(detected), ["甲野一郎", "乙川次郎"]);
  assert.deepEqual(activatedCharacterNames([
    { entry: { character: "甲野一郎" }, activated: true },
    { entry: { character: "甲野一郎" }, activated: true },
    { entry: { character: "乙川次郎" }, activated: false },
  ]), ["甲野一郎"]);
});

test("章级与卷级提示块说明“刻意特色”与补回口径", () => {
  const tables = loadFixture();
  const rows = [{ index: 1, chapter: "第一章", jp: "甲野一郎が来た。", cn: "甲野一郎来了。" }];
  const characters = detectCharacters({ rows, tables });
  const block = chapterHabitBlock({ chapter: "第一章", characters });
  assert.match(block, /^【说话习惯（本章）】本章「第一章」/);
  assert.match(block, /保留它们不算翻译腔、病句、错字或 OCR 瑕疵/);
  assert.match(block, /补回特色的最小 revisedText/);
  assert.match(block, /甲野一郎：第一人称 「オレ」/);
  assert.equal(chapterHabitBlock({ chapter: "空章", characters: [] }), "");

  const volume = volumeHabitBlock({ volume: volumeKey("S3_01"), characters });
  assert.match(volume, /^【说话习惯（本卷 S3_01）】/);
});

test("补回检测只在可靠的类型与位置上生效", () => {
  const tables = loadFixture();
  const jiro = tables.entries.find((entry) => entry.character === "乙川次郎");
  const shiro = tables.entries.find((entry) => entry.character === "丁原四郎");
  const ichiro = tables.entries.find((entry) => entry.character === "甲野一郎");
  const go = tables.entries.find((entry) => entry.character === "戊田五郎");

  // 结构性特征（中译同形、单字口癖）不参与字面流失检测。
  assert.equal(isHabitDetectable(shiro), false);
  assert.equal(isHabitDetectable(jiro), true);
  assert.equal(isHabitDetectable(ichiro), true);
  // X版为 `-` 时是明确的不特殊处理；不做字面流失检测，详情由提示词侧接管。
  assert.equal(isHabitDetectable(go), false);

  const characters = [ichiro, jiro, shiro, go].map((entry) => ({ entry, activated: true }));

  // 句末语气词/谓语形式必须在句末：「じゃんけん」不算。
  const janken = findHabitMisses({ source: "じゃんけんをしよう。", target: "来猜拳吧。", characters: [{ entry: tables.entries.find((entry) => entry.character === "丙山三郎"), activated: true }] });
  assert.deepEqual(janken, []);
  const sentenceEnd = findHabitMisses({ source: "「本当に、じゃん☆」", target: "「真的吗☆」", characters: [{ entry: tables.entries.find((entry) => entry.character === "丙山三郎"), activated: true }] });
  assert.equal(sentenceEnd.length, 1);
  assert.equal(sentenceEnd[0].character, "丙山三郎");

  // 单字汉字口癖（名词后缀「力」= XX力）必须落在**词首**：否则「風力/火力/磁力/能力」都会被当成
  // 该角色的口癖（实测某卷 37 个说话人候选行里 32 行是这种误报，说话人判断与特色流失全线跑偏）。
  const chikjo = { entry: { character: "己田六郎", habit: "力", type: "名词后缀", hasLiteralHabit: true, versions: { x: "", net: "", tw: "" }, expectedWritings: ["力"] }, activated: true };
  assert.equal(hasHabitOccurrence("風力発電のものである。", chikjo.entry), false, "風力 不是她的口癖");
  assert.equal(hasHabitOccurrence("艦砲クラスの火力を持った。", chikjo.entry), false, "火力 不是她的口癖");
  assert.equal(hasHabitOccurrence("磁力でビルを縫って飛ぶ。", chikjo.entry), false, "磁力 不是她的口癖");
  assert.equal(hasHabitOccurrence("<ruby>超能力<rt>ちょうのうりょく</rt></ruby>者だ。", chikjo.entry), false, "汉字连写的 能力 也不算");
  assert.equal(hasHabitOccurrence("力のゴリ押しが通じる。", chikjo.entry), true, "独立使用的「力」仍然算命中");
  assert.equal(hasHabitOccurrence("「力！」と叫んだ。", chikjo.entry), true, "引号后的独立用法算命中");
  assert.equal(hasHabitOccurrence("すごい力だ。", chikjo.entry), false, "前面是假名的「力」不算（属于普通词的一部分）");
  assert.equal(hasHabitOccurrence("彼女は<ruby>魔<rt>ま</rt></ruby>力を使った。", chikjo.entry), false, "注音标记不改变前一个字是汉字的事实");
  const warawa = tables.entries.find((entry) => entry.habit === "わらわ");
  assert.equal(hasHabitOccurrence("真実を知っているわらわからすれば。", warawa), true, "第一人称可紧跟在谓语后，再接格助词");
  assert.equal(hasHabitOccurrence("わらわしい。", warawa), false, "后面的假名不构成助词时不算第一人称命中");
  // 只有译文使用 X版 登记写法才算译出；网翻/台版不是当前项目的判定基准。
  assert.deepEqual(findHabitMisses({ source: "オレは行く。", target: "本大爷要去。", characters }), []);
  assert.equal(findHabitMisses({ source: "オレは行く。", target: "俺要去。", characters }).length, 1);
  // 译文完全没体现第一人称口癖 → 提示补回。
  const missed = findHabitMisses({ source: "オレは行く。", target: "我要去。", characters });
  assert.equal(missed.length, 1);
  assert.equal(missed[0].expected, "本大爷");
  // 落在外语词中间的第一人称不算出现（前面是假名）。
  assert.deepEqual(findHabitMisses({ source: "それオレンジだ。", target: "那是橙子。", characters }), []);
  // 段落里没有该口癖则不提示。
  assert.deepEqual(findHabitMisses({ source: "今日はいい天気だ。", target: "今天天气不错。", characters }), []);
});

test("按章与按卷汇总给出启用角色与疑似流失行", () => {
  const tables = loadFixture();
  const rows = [
    { index: 1, chapter: "第一章", jp: "「オレは行く」と甲野一郎。", cn: "「我要去」甲野一郎说。" },
    { index: 2, chapter: "第一章", jp: "関係ない。", cn: "没关系。" },
    { index: 3, chapter: "第二章", jp: "「ですの」と乙川次郎。", cn: "「的说」乙川次郎说。" },
    { index: 4, chapter: "第二章", jp: "「行くですの」と乙川次郎。", cn: "「我要去了」乙川次郎说。" },
  ];
  const chapters = summarizeChapters({ rows, tables, volume: volumeKey("S3_01") });
  assert.equal(chapters.length, 2);
  assert.equal(chapters[0].chapter, "第一章");
  assert.equal(chapters[0].characters.filter((item) => item.activated).length, 1);
  assert.equal(chapters[0].habitRows, 1);
  assert.equal(chapters[0].misses[0].index, 1);
  // 第 3 行译文用了本项目写法「的说」→ 不算流失；第 4 行没有体现 → 提示补回。
  assert.equal(chapters[1].habitRows, 1);
  assert.deepEqual(chapters[1].misses.map((miss) => miss.index), [4]);

  const volume = summarizeChapters({ rows, tables, volume: volumeKey("S3_01"), scope: "volume" });
  assert.equal(volume.length, 1);
  assert.equal(volume[0].chapter, "S3_01");
  assert.equal(volume[0].indexRange[1], 4);
});

test("normalizeSpeechEntry 处理空口癖与占位符", () => {
  const entry = normalizeSpeechEntry({ 角色: "某角色", 口癖: "-", 类型: "句式", 备注: "句尾最后一个假名变为片假名" });
  assert.equal(entry.habit, "");
  assert.equal(entry.hasLiteralHabit, false);
  assert.equal(isHabitDetectable(entry), false);
  assert.match(describeHabit(entry), /句式 → 备注：句尾最后一个假名变为片假名/);
});
