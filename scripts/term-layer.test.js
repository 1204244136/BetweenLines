/**
 * 对照表层：构建期落盘的判定必须可复用、可审计，并且不碰行数据。
 * 判定规则本身的测试在 term-table.test.js / term-prefilter.test.js，这里只测「层」。
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const {
  buildTermLayer,
  describeTermLayerEntry,
  termLayerFor,
  termVariantKey,
  termVariantsFor,
  variantIndexSets,
} = require("../src/workbenches/translation-compare/term-layer");
const { rebuildCompareHtmlFromSnapshot } = require("./build-compare");

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-term-layer-"));
test.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

// 中性夹具：山田太郎（基文别名 3 字以上，可判不一致）、佐藤（2 字，只能确认一致）。
const TERM_CSV = [
  "Base_Ori,Ruby_Ori,Base_Trans,Type",
  "【山田太郎】,やまだたろう,山田太郎,人名",
  "【佐藤】,さとう,佐藤,人名",
].join("\n");

function writeTable(name = "terms.csv", content = TERM_CSV) {
  const file = path.join(tempDir, name);
  fs.writeFileSync(file, content, "utf8");
  return file;
}

const profile = (file) => ({ id: "unit", name: "单元测试档案", termTables: [file] });

/** 生成一个带对照表层的快照页面（页面徽标与离线脚本共用这一份数据）。 */
function buildFixturePage(label) {
  const file = writeTable(`${label}-terms.csv`);
  const rows = fixtureRows().map((row) => ({ ...row, signature: `sig-${row.index}` }));
  const layer = buildTermLayer({ rows, profiles: [profile(file)], comparisonMode: "bilingual" });
  const projectContext = {
    schemaVersion: 2,
    projectKey: `term-layer-${label}`,
    snapshotKey: `term-layer-${label}-1`,
    rowsSignature: "rows-sig",
    generatedAt: "2026-01-01T00:00:00.000Z",
    comparisonMode: "bilingual",
    notesStorage: { key: `term-layer-${label}-notes` },
  };
  const dir = path.join(tempDir, label);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "translation-compare.json"), JSON.stringify({
    project: projectContext,
    rowsSignature: "rows-sig",
    termPrefilter: layer,
    rows,
  }), "utf8");
  const rebuilt = rebuildCompareHtmlFromSnapshot(dir);
  const html = fs.readFileSync(rebuilt.htmlFile, "utf8");
  return { html, pageMeta: JSON.parse(html.match(/const pageMeta = (\{[\s\S]*?\});\n/)[1]) };
}

function fixtureRows() {
  return [
    { index: 1, chapter: "第一章", jp: "【山田太郎】が来た。", cn: "山田太郎来了。", tw: "山田太郎來了。" },
    { index: 2, chapter: "第一章", jp: "【山田太郎】が来た。", cn: "山田来了。", tw: "山田太郎來了。" },
    { index: 3, chapter: "第二章", jp: "【佐藤】が来た。", cn: "佐藤来了。", tw: "佐藤來了。" },
    { index: 4, chapter: "第二章", jp: "誰も来ない。", cn: "谁都没来。", tw: "誰都沒來。" },
  ];
}

test("构建期给出每个变体的命中判定与摘要", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildTermLayer({ rows, profiles: [profile(file)], comparisonMode: "bilingual" });

  assert.equal(layer.errors.length, 0);
  assert.equal(layer.version, 2);
  const entry = layer.byProfile.unit;
  assert.equal(entry.entries, 2);
  assert.equal(entry.defaultVariant, "bilingual:cn");
  assert.deepEqual(Object.keys(entry.variants), ["bilingual:cn"]);
  const variant = entry.variants["bilingual:cn"];
  assert.deepEqual(variant.consistent, [1, 3]);
  assert.deepEqual(variant.conflicts, [2]);
  assert.deepEqual(variant.chapters, [{ chapter: "第一章", hits: 2 }, { chapter: "第二章", hits: 1 }]);
  assert.equal(variant.summary.hits, 3);
  assert.equal(variant.summary.removedFromModel, 2);
  assert.equal(variant.summary.aiRows, 2);
  assert.match(entry.fingerprint, /^2\|terms\.csv:\d+:\d+#2$/);
  // 落盘块进快照与页面：只留表文件名，本机完整路径不出现。
  assert.deepEqual(entry.files, ["terms.csv"]);
  assert.equal(JSON.stringify(layer).includes(tempDir), false, "落盘块不得出现本机完整路径");
});

test("三语模式算两个目标列变体，判定可以不同", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildTermLayer({ rows, profiles: [profile(file)], comparisonMode: "trilingual" });
  const entry = layer.byProfile.unit;
  assert.deepEqual(Object.keys(entry.variants).sort(), ["trilingual:cn", "trilingual:tw"]);
  // 第 2 行译文 B 用了错译名（冲突），译文 C 用的是正确译名（一致）。
  assert.deepEqual(entry.variants["trilingual:cn"].conflicts, [2]);
  assert.deepEqual(entry.variants["trilingual:tw"].conflicts, []);
  assert.deepEqual(entry.variants["trilingual:tw"].consistent.sort(), [1, 2, 3]);
  assert.equal(entry.defaultVariant, "trilingual:cn");
  assert.deepEqual(termVariantsFor("trilingual").map((item) => termVariantKey(item.proofreadMode, item.targetKey)), ["trilingual:cn", "trilingual:tw"]);
  assert.deepEqual(termVariantsFor("bilingual").map((item) => item.targetKey), ["cn"]);
});

test("运行期按档案 + 变体取用，指纹过期即视为不可信", () => {
  const file = writeTable();
  const rows = fixtureRows();
  const layer = buildTermLayer({ rows, profiles: [profile(file)], comparisonMode: "bilingual" });

  // 运行期用本次实际加载的表路径重算指纹（落盘块里只有文件名）。
  const match = termLayerFor(layer, "unit", { proofreadMode: "bilingual", targetKey: "tw", files: [file] });
  assert.equal(match.stale, false);
  // 双语恒为目标列 cn：传 tw 也会归一到 cn
  assert.equal(match.variantKey, "bilingual:cn");
  assert.ok(match.variant);
  assert.deepEqual([...variantIndexSets(match.variant).conflicts], [2]);

  // 该模式没算过的变体：指纹可信，但没有可复用的判定
  const trilingual = termLayerFor(layer, "unit", { proofreadMode: "trilingual", targetKey: "cn", files: [file] });
  assert.equal(trilingual.stale, false);
  assert.equal(trilingual.variant, null);
  assert.equal(trilingual.variantKey, "trilingual:cn");

  assert.equal(termLayerFor(layer, "missing", { proofreadMode: "bilingual", files: [file] }), null);
  assert.equal(termLayerFor(null, "unit", { proofreadMode: "bilingual", files: [file] }), null);

  // 解析不出表（档案不在注册表且没给 files）时视为不可信，不能静默复用旧结论
  const unverifiable = termLayerFor(layer, "unit", { proofreadMode: "bilingual" });
  assert.equal(unverifiable.stale, true);
  assert.equal(unverifiable.currentFingerprint, "");

  // 表被改过（内容与 mtime 都变）→ 指纹过期，运行期必须回退现算
  fs.appendFileSync(file, "\n【鈴木】,すずき,铃木,人名\n", "utf8");
  const stale = termLayerFor(layer, "unit", { proofreadMode: "bilingual", targetKey: "cn", files: [file] });
  assert.equal(stale.stale, true);
  assert.notEqual(stale.currentFingerprint, layer.byProfile.unit.fingerprint);
});

test("摘要与缺表行为", () => {
  const file = writeTable();
  const layer = buildTermLayer({
    rows: fixtureRows(),
    profiles: [profile(file), { id: "plain", name: "无表档案", termTables: [] }],
    comparisonMode: "bilingual",
  });
  assert.deepEqual(Object.keys(layer.byProfile), ["unit"]);
  const text = describeTermLayerEntry(layer.byProfile.unit);
  assert.match(text, /对照表：1 张表 \/ 2 条术语 \/ 命中 3 行（译名一致 2，需人工确认 1，目标列 译文 B）/);
  assert.equal(describeTermLayerEntry(null), "");
});

test("构建期层不写进行数据，不影响行签名", () => {
  const file = writeTable();
  const rows = fixtureRows().map((row) => ({ ...row, signature: `sig-${row.index}` }));
  const snapshotRows = JSON.parse(JSON.stringify(rows));
  const layer = buildTermLayer({ rows, profiles: [profile(file)], comparisonMode: "bilingual" });
  assert.deepEqual(rows, snapshotRows, "构建期层不能修改传入的行对象");
  // 只存行号结论：块里不出现行文本，也不出现备注内容
  const text = JSON.stringify(layer);
  assert.equal(text.includes("山田太郎来了"), false);
  assert.equal(text.includes("[对照表]"), false);
});

test("从快照重建页面时沿用落盘的对照表判定", () => {
  const { html, pageMeta } = buildFixturePage("snapshot");
  assert.match(html, /"termPrefilter":\{"version":2/);
  assert.deepEqual(pageMeta.termPrefilter.byProfile.unit.variants["bilingual:cn"].conflicts, [2]);
  assert.equal(pageMeta.termPrefilter.byProfile.unit.summary.hits, 3);
  // 页面嵌的也是文件名：分享页面不会带出本机目录结构。
  assert.deepEqual(pageMeta.termPrefilter.byProfile.unit.files, ["snapshot-terms.csv"]);
  assert.equal(html.includes(tempDir), false, "页面不得出现本机完整路径");
});

test("页面按构建期判定给未跑过的行标出术语徽标，并跟随档案与目标列", () => {
  const { html, pageMeta } = buildFixturePage("badges");
  const script = html.split("<script>")[1].split("</script>")[0];
  const source = [
    script.match(/function termVariantKeyForPage\(\) \{[\s\S]*?\n    \}/)[0],
    script.match(/function currentTermVariant\(\) \{[\s\S]*?\n    \}/)[0],
    script.match(/function refreshTermVerdicts\(\) \{[\s\S]*?\n    \}/)[0],
    script.match(/function termLayerSummary\(\) \{[\s\S]*?\n    \}/)[0],
  ].join("\n");

  const run = (profileId, { proofreadMode = "bilingual", target = "cn" } = {}) => {
    const sandbox = {
      pageMeta,
      Map,
      String,
      Object,
      aiIds: {
        profile: { value: profileId },
        target: { value: target },
        proofreadMode: { value: proofreadMode },
      },
    };
    vm.createContext(sandbox);
    // `let` 声明的变量不会挂到沙箱对象上：显式导出一份给断言用。
    vm.runInNewContext(
      `let termLayer = pageMeta.termPrefilter || null;\nlet termVerdicts = new Map();\n${source}\nrefreshTermVerdicts();\nthis.__verdicts = termVerdicts;\nthis.__summary = termLayerSummary();`,
      sandbox,
    );
    return sandbox;
  };

  const own = run("unit");
  assert.equal(own.__verdicts.get("1"), "consistent");
  assert.equal(own.__verdicts.get("2"), "conflict");
  assert.equal(own.__verdicts.get("4"), undefined, "没命中的行不该有徽标");
  assert.match(own.__summary, /构建期预筛 3 行命中（一致 2 \/ 需确认 1），预计 2 行仍需 AI 判定/);

  // 换档案：该档案没有对照表 → 不发徽标；换成没算过的变体 → 回落到默认变体
  assert.equal(run("other").__verdicts.size, 0);
  const otherVariant = run("unit", { proofreadMode: "trilingual", target: "tw" });
  assert.equal(otherVariant.__verdicts.get("2"), "conflict", "没有该变体时回落到默认变体");
});
