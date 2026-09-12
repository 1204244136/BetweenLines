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
  isHabitDetectable,
  loadSpeechTables,
  normalizeSpeechEntry,
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
  "S2_01,戊田五郎,なの,句末语气词,,,,通常放在句尾",
].join("\n");

function loadFixture() {
  const file = path.join(tempDir, "habits.csv");
  fs.writeFileSync(file, HABIT_CSV, "utf8");
  const tables = loadSpeechTables([file]);
  assert.deepEqual(tables.errors, []);
  return tables;
}

test("说话习惯表按表头解析，并生成强/弱名字关键词", () => {
  const tables = loadFixture();
  assert.equal(tables.entries.length, 5);
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
  assert.match(block, /不得判为翻译腔、病句或误译/);
  assert.match(block, /补回的最小改动/);
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
  // 没有任何目标写法（x版/网翻/台版都空，只有备注）时也没有“流失”可言：
  // 备注写的是说明，不是译文里该出现的东西，拿它比对只会每行都报流失。
  assert.equal(isHabitDetectable(go), false);

  const characters = [ichiro, jiro, shiro, go].map((entry) => ({ entry, activated: true }));

  // 句末语气词/谓语形式必须在句末：「じゃんけん」不算。
  const janken = findHabitMisses({ source: "じゃんけんをしよう。", target: "来猜拳吧。", characters: [{ entry: tables.entries.find((entry) => entry.character === "丙山三郎"), activated: true }] });
  assert.deepEqual(janken, []);
  const sentenceEnd = findHabitMisses({ source: "「本当に、じゃん」", target: "「真的吗。」", characters: [{ entry: tables.entries.find((entry) => entry.character === "丙山三郎"), activated: true }] });
  assert.equal(sentenceEnd.length, 1);
  assert.equal(sentenceEnd[0].character, "丙山三郎");

  // 译文已使用本项目写法（或任一版本写法）就不算流失。
  assert.deepEqual(findHabitMisses({ source: "オレは行く。", target: "本大爷要去。", characters }), []);
  assert.deepEqual(findHabitMisses({ source: "オレは行く。", target: "俺要去。", characters }), []);
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
