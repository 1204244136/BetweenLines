const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildSpeechHabitLayer,
  contextFromLayerEntry,
  speechHabitLayerFor,
  speechTablesFingerprint,
} = require("../src/workbenches/translation-compare/speech-habit-layer");
const {
  chapterHabitBlock,
  detectCharacters,
  findHabitMisses,
  groupRowsByChapter,
  loadSpeechTables,
  speechHabitBlockForRow,
  volumeKeyFromFiles,
} = require("../src/workbenches/translation-compare/ai/speech-habit");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-layer-"));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

const HABIT_CSV = [
  "小说首次出现,角色,口癖,类型,x版,网翻,台版（转简中）,备注",
  "S1_04,甲野一郎,オレ,第一人称,本大爷,,俺,男性化自称",
  "S1_04,乙川次郎,ですの,谓语形式,的说,,",
].join("\n");

function writeTable(name = "habits.csv", content = HABIT_CSV) {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

function fixtureRows() {
  return [
    { index: 1, chapter: "正文", jp: "「オレは行く」と甲野一郎。", cn: "「我要去」甲野一郎说。" },
    { index: 2, chapter: "行间 一", jp: "関係ないですの、と乙川次郎。", cn: "乙川次郎说没关系。" },
    { index: 3, chapter: "行间 一", jp: "「ですの」と乙川次郎。", cn: "「的说」乙川次郎说。" },
  ];
}

const profile = (file, scope = "chapter") => ({
  id: "unit",
  name: "单元测试档案",
  speechTables: [file],
  speechHabitScope: scope,
});

test("构建期层记录章级命中、疑似流失行与表指纹", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildSpeechHabitLayer({ rows, projectFiles: {}, profiles: [profile(file)] });

  assert.equal(layer.errors.length, 0);
  const entry = layer.byProfile.unit;
  assert.equal(entry.scope, "chapter");
  assert.equal(entry.entries, 2);
  assert.equal(entry.chapters.length, 2);
  assert.deepEqual(entry.summary.activatedCharacters.sort(), ["乙川次郎", "甲野一郎"]);
  // 第 1 行原文 オレ 未译出、第 2 行 ですの 未译出 → 两行疑似流失；第 3 行译出了「的说」。
  assert.deepEqual(entry.missIndexes, [1, 2]);
  assert.match(entry.fingerprint, /^2\|habits\.csv:\d+:\d+#2$/);
  // 落盘块进快照与页面：只留表文件名，本机完整路径不出现。
  assert.deepEqual(entry.files, ["habits.csv"]);
  assert.equal(JSON.stringify(layer).includes(tempDir), false, "落盘块不得出现本机完整路径");

  // 章级只存角色引用；口癖/写法/备注放角色字典，避免逐章重复。
  const chapter = entry.chapters.find((item) => item.chapter === "行间 一");
  assert.deepEqual(chapter.characters.map((item) => item.character), ["乙川次郎"]);
  assert.equal(chapter.characters[0].activated, true);
  assert.equal(Object.hasOwn(chapter.characters[0], "expected"), false);
  assert.deepEqual(entry.characterRecords.map((item) => item.character).sort(), ["乙川次郎", "甲野一郎"]);
  assert.equal(entry.characterRecords.find((item) => item.character === "乙川次郎").versions.x, "的说");
  assert.equal(typeof chapter.characters[0].ref, "number");
});

test("运行期复用的上下文与现算结果完全一致", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildSpeechHabitLayer({ rows, projectFiles: {}, profiles: [profile(file)] });
  // 运行期用本次实际加载的表路径重算指纹（落盘块里只有文件名）。
  const match = speechHabitLayerFor(layer, "unit", { files: [file] });
  assert.equal(match.stale, false);

  const context = contextFromLayerEntry(match.entry);
  assert.equal(context.source, "snapshot");
  assert.equal(context.activatedChapters, 2);
  assert.deepEqual(context.activatedCharacters.sort(), ["乙川次郎", "甲野一郎"]);

  // 现算路径
  const tables = loadSpeechTables([file]);
  const volume = volumeKeyFromFiles({});
  for (const group of groupRowsByChapter(rows)) {
    const detected = detectCharacters({ rows: group.rows, tables, volume });
    const liveBlock = chapterHabitBlock({ chapter: group.chapter, characters: detected });
    const cachedBlock = context.blocks.get(group.chapter).block;
    assert.equal(cachedBlock, liveBlock, `${group.chapter} 的提示词块必须与现算一致`);

    const liveMisses = group.rows
      .flatMap((row) => findHabitMisses({ source: row.jp, target: row.cn, characters: detected }).map(() => row.index));
    const layerMisses = match.entry.chapters.find((item) => item.chapter === group.chapter).misses.map((miss) => miss.index);
    assert.deepEqual([...new Set(liveMisses)], layerMisses);
  }
});

test("行级收窄：角色规则只进到提到他、或出现他口癖的那些行", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildSpeechHabitLayer({ rows, projectFiles: {}, profiles: [profile(file)] });
  const context = contextFromLayerEntry(layer.byProfile.unit);
  const entry = context.blocks.get("行间 一");
  const liveTables = loadSpeechTables([file]);
  const liveCharacters = detectCharacters({
    rows: rows.filter((row) => row.chapter === "行间 一"),
    tables: liveTables,
    volume: volumeKeyFromFiles({}),
  });

  const blockFor = (row) => speechHabitBlockForRow({
    chapter: "行间 一",
    row,
    characters: entry.characters_raw,
    volume: entry.volume,
  });

  // ① 本行点名了该角色 → 规则进这一行
  const named = blockFor({ jp: "「ですの」と乙川次郎。", cn: "「的说」乙川次郎说。" });
  assert.match(named, /乙川次郎/);
  assert.match(named, /^【说话习惯（本章）】/);
  // ② 本行只有台词、没点名，但原文出现了他的口癖 → 规则必须留着，否则“特色流失”判不出来
  const habitOnly = blockFor({ jp: "「ですの」と彼女は言った。", cn: "「的说」她说道。" });
  assert.match(habitOnly, /乙川次郎/);
  // ③ 本行既没提他、也没有他的口癖 → 不注入（章级判定里本章有他，但这一行与他无关）
  assert.equal(blockFor({ jp: "「オレは行く」と甲野一郎。", cn: "「我要去」甲野一郎说。" }), "");
  // ④ 行数据缺失（两侧都没有文本）→ 不裁剪，保留整章规则（与其它裁剪同一兜底口径）
  assert.match(blockFor({}), /乙川次郎/);
  // ⑤ 收窄后的块用同一个 chapterHabitBlock 拼装；整章都没提到任何角色时整段不注入
  assert.equal(blockFor({ jp: "窓の外は雨だった。", cn: "窗外下着雨。" }), "");

  // 现算路径与落盘块还原路径逐字一致（同一函数 + 同一角色集合）
  const live = speechHabitBlockForRow({
    chapter: "行间 一",
    row: { jp: "「ですの」と乙川次郎。", cn: "「的说」乙川次郎说。" },
    characters: liveCharacters,
  });
  assert.equal(live, named, "现算与落盘块还原必须产出逐字相同的行级块");
});

test("表被改过时指纹失效，运行期应回退现算", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildSpeechHabitLayer({ rows, projectFiles: {}, profiles: [profile(file)] });
  assert.equal(speechHabitLayerFor(layer, "unit", { files: [file] }).stale, false);

  // 追加一个角色（内容与 mtime 都变）→ 指纹过期
  fs.appendFileSync(file, "\nS1_04,丙山三郎,じゃん,谓语形式,,,,\n", "utf8");
  const stale = speechHabitLayerFor(layer, "unit", { files: [file] });
  assert.equal(stale.stale, true);
  assert.notEqual(stale.currentFingerprint, layer.byProfile.unit.fingerprint);
  assert.equal(speechTablesFingerprint([file]) === layer.byProfile.unit.fingerprint, false);

  // 没有该档案时返回 null，让调用方决定现算
  assert.equal(speechHabitLayerFor(layer, "does-not-exist", { files: [file] }), null);
  assert.equal(speechHabitLayerFor(null, "unit", { files: [file] }), null);

  // 解析不出表（档案不在注册表且没给 files）时视为不可信，不能静默复用旧结论
  const unverifiable = speechHabitLayerFor(layer, "unit");
  assert.equal(unverifiable.stale, true);
  assert.equal(unverifiable.currentFingerprint, "");
});

test("卷口径的落盘层还原成整卷块", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildSpeechHabitLayer({ rows, projectFiles: {}, profiles: [profile(file, "volume")] });
  const entry = layer.byProfile.unit;
  assert.equal(entry.scope, "volume");
  assert.deepEqual(entry.summary.activatedCharacters.sort(), ["乙川次郎", "甲野一郎"]);

  const context = contextFromLayerEntry(entry);
  assert.equal(context.scope, "volume");
  // 每一章都映射到同一个卷级块
  const blocks = [...context.blocks.values()].map((item) => item.block);
  assert.equal(new Set(blocks).size, 1);
  assert.match(blocks[0], /^【说话习惯（本卷）/);
});

test("同一角色的多条习惯不会被字典折叠", () => {
  const file = writeTable("multi.csv", [
    "小说首次出现,角色,口癖,类型,x版,网翻,台版（转简中）,备注",
    "S1_04,多人角色,力,名词后缀,力,,,XX力",
    "S1_04,多人角色,ダゾ,谓语形式,哒唑,,,句尾",
    "S1_04,多人角色,オレ,第一人称,本大爷,,俺,男性化自称",
  ].join("\n"));
  const rows = [{ index: 1, chapter: "第一章", jp: "多人角色のダゾ。", cn: "多人角色说道。" }];
  const layer = buildSpeechHabitLayer({ rows, projectFiles: {}, profiles: [profile(file)] });
  const entry = layer.byProfile.unit;
  assert.equal(entry.characterRecords.length, 3, "每条习惯都要保留");
  const context = contextFromLayerEntry(entry);
  const block = context.blocks.get("第一章").block;
  // 两条可检测的习惯都要出现在块里；同形条目（力→力）没有“补回”可言，不进提示词。
  assert.match(block, /谓语形式 「ダゾ」/);
  assert.match(block, /第一人称 「オレ」/);
  assert.doesNotMatch(block, /名词后缀 「力」/);
  // 同一角色有多条习惯时，本章角色名只算一次（否则载荷里的 characters 看着像两个人）。
  assert.deepEqual(context.blocks.get("第一章").characters, ["多人角色"]);
});

test("没有声明说话习惯表的档案不进层", () => {
  const file = writeTable();
  const layer = buildSpeechHabitLayer({
    rows: fixtureRows(),
    projectFiles: {},
    profiles: [profile(file), { id: "plain", name: "无表档案", speechTables: [] }],
  });
  assert.deepEqual(Object.keys(layer.byProfile), ["unit"]);
});

test("构建期层不写进行数据，不影响行签名", () => {
  const { buildSpeechHabitLayer: build } = require("../src/workbenches/translation-compare/speech-habit-layer");
  const file = writeTable();
  const rows = fixtureRows().map((row) => ({ ...row, signature: `sig-${row.index}` }));
  const snapshotRows = JSON.parse(JSON.stringify(rows));
  build({ rows, projectFiles: {}, profiles: [profile(file)] });
  assert.deepEqual(rows, snapshotRows, "构建层不能修改传入的行对象");
});

test("从快照重建页面时沿用落盘的说话习惯层", () => {
  const { rebuildCompareHtmlFromSnapshot } = require("./build-compare");
  const file = writeTable();
  const rows = fixtureRows().map((row) => ({ ...row, signature: `sig-${row.index}` }));
  const layer = buildSpeechHabitLayer({ rows, projectFiles: {}, profiles: [profile(file)] });
  const projectContext = {
    schemaVersion: 2,
    projectKey: "layer-test",
    snapshotKey: "layer-test-1",
    rowsSignature: "rows-sig",
    generatedAt: "2026-01-01T00:00:00.000Z",
    comparisonMode: "bilingual",
    notesStorage: { key: "layer-test-notes" },
  };
  const dir = path.join(tempDir, "snapshot");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "translation-compare.json"), JSON.stringify({
    project: projectContext,
    rowsSignature: "rows-sig",
    speechHabits: layer,
    rows,
  }), "utf8");

  const rebuilt = rebuildCompareHtmlFromSnapshot(dir);
  const html = fs.readFileSync(rebuilt.htmlFile, "utf8");
  assert.match(html, /"speechHabits":\{"version":2/);
  assert.match(html, /"missIndexes":\[1,2\]/);
  // 页面嵌的也是文件名：分享页面不会带出本机目录结构。
  assert.match(html, /"files":\["habits\.csv"\]/);
  assert.equal(html.includes(tempDir.replace(/\\/g, "\\\\")) || html.includes(tempDir), false, "页面不得出现本机完整路径");
  const pageMeta = JSON.parse(html.match(/const pageMeta = (\{[\s\S]*?\});\n/)[1]);
  assert.equal(pageMeta.speechHabits.byProfile.unit.summary.missRows, 2);
  assert.equal(pageMeta.speechHabits.byProfile.unit.summary.activatedCharacters.length, 2);
});
