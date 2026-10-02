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
  TERM_LAYER_VERSION,
  buildTermLayer,
  describeTermLayerEntry,
  termLayerFor,
  termVariantKey,
  termVariantsFor,
  variantIndexSets,
} = require("../src/workbenches/translation-compare/term-layer");
const { rebuildCompareHtmlFromSnapshot } = require("./build-compare");
const { evaluateTermRow, loadTermTables } = require("../src/workbenches/translation-compare/ai/term-table");
const { hitsUsedInRow } = require("../src/workbenches/translation-compare/ai/term-prefilter");
const { createClientFixture, storageFixture } = require("./workbench-fixture");

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
  assert.equal(layer.version, TERM_LAYER_VERSION);
  const entry = layer.byProfile.unit;
  assert.equal(entry.entries, 2);
  assert.equal(entry.defaultVariant, "bilingual:cn");
  assert.deepEqual(Object.keys(entry.variants), ["bilingual:cn"]);
  const variant = entry.variants["bilingual:cn"];
  assert.deepEqual(variant.consistent, [1, 3]);
  assert.deepEqual(variant.conflicts, [2]);
  // 一致的行里没有一行是“整行只有术语”（都还带着「が来た。」这类内容），因此一行都不跳过模型。
  assert.deepEqual(variant.termOnly, []);
  assert.deepEqual(variant.injected, [1, 3]);
  assert.deepEqual(variant.chapters, [{ chapter: "第一章", hits: 2 }, { chapter: "第二章", hits: 1 }]);
  assert.equal(variant.summary.hits, 3);
  assert.equal(variant.summary.termOnly, 0);
  assert.equal(variant.summary.injected, 2);
  assert.equal(variant.summary.removedFromModel, 0);
  assert.equal(variant.summary.aiRows, 4);
  // 夹具里两条都是人名条目（豁免注音口径），没有候选被排除。
  assert.equal(variant.summary.rubySkipped, 0);
  // 降级为「只作一致性证据」的候选同样要如实报数（本夹具全是人名条目，不受注音口径约束）。
  assert.equal(variant.summary.rubyDemoted, 0);
  assert.match(entry.fingerprint, new RegExp(`^${TERM_LAYER_VERSION}\\|terms\\.csv:\\d+:\\d+#2$`));
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
  assert.match(text, /对照表：1 张表 \/ 2 条术语 \/ 命中 3 行（译名一致 2（整行只有术语 0，需注入术语 2），术语冲突交 AI 判断 1，目标列 译文 B）/);
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
  assert.match(html, new RegExp(`"termPrefilter":\\{"version":${TERM_LAYER_VERSION}`));
  assert.deepEqual(pageMeta.termPrefilter.byProfile.unit.variants["bilingual:cn"].conflicts, [2]);
  assert.equal(pageMeta.termPrefilter.byProfile.unit.summary.hits, 3);
  // 页面嵌的也是文件名：分享页面不会带出本机目录结构。
  assert.deepEqual(pageMeta.termPrefilter.byProfile.unit.files, ["snapshot-terms.csv"]);
  assert.equal(html.includes(tempDir), false, "页面不得出现本机完整路径");
});

test("从旧版快照重建页面时按当前对照表重算术语对", () => {
  const file = writeTable(
    "rebuild-separator-terms.csv",
    ["Base_Ori,Base_Trans,Type", "イスラエル＝リガルディ,伊斯瑞·雷加第,人名/西式全名"].join("\n"),
  );
  const rows = [{
    index: 1,
    chapter: "第一章",
    jp: "イスラエル＝リガルディの再来だ。",
    cn: "伊斯瑞·雷加帝的再来。",
  }];
  const projectContext = {
    schemaVersion: 2,
    projectKey: "term-layer-stale-rebuild",
    snapshotKey: "term-layer-stale-rebuild-1",
    rowsSignature: "rows-sig",
    generatedAt: "2026-01-01T00:00:00.000Z",
    comparisonMode: "bilingual",
    notesStorage: { key: "term-layer-stale-rebuild-notes" },
  };
  const dir = path.join(tempDir, "stale-rebuild");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "translation-compare.json"), JSON.stringify({
    project: projectContext,
    rowsSignature: "rows-sig",
    termPrefilter: { version: 5, byProfile: {}, errors: [] },
    rows,
  }), "utf8");

  const rebuilt = rebuildCompareHtmlFromSnapshot(dir, { profiles: [profile(file)] });
  const html = fs.readFileSync(rebuilt.htmlFile, "utf8");
  const compare = JSON.parse(fs.readFileSync(path.join(dir, "translation-compare.json"), "utf8"));
  assert.equal(compare.termPrefilter.version, TERM_LAYER_VERSION);
  assert.deepEqual(
    compare.termPrefilter.byProfile.unit.variants["bilingual:cn"].terms["1"],
    ["イスラエル＝リガルディ → 伊斯瑞·雷加第（人名/西式全名）"],
  );
  assert.match(html, /イスラエル＝リガルディ → 伊斯瑞·雷加第（人名\/西式全名）/);
  assert.equal(html.includes("イスラエル＝リガルディ → 伊斯瑞雷加第"), false);
});

test("页面按构建期判定给未跑过的行标出术语徽标，并跟随档案与目标列", () => {
  const { html, pageMeta } = buildFixturePage("badges");
  const script = html.split("<script>")[1].split("</script>")[0].replace(/\r\n?/g, "\n");
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
  assert.equal(own.__verdicts.get("1"), "injected", "术语一致但整行不止术语：徽标必须说明仍会交给模型");
  assert.equal(own.__verdicts.get("2"), "conflict", "术语冲突行照样交给模型，构建期只标出冲突（徽标不是终局结论）");
  assert.equal(own.__verdicts.get("4"), undefined, "没命中的行不该有徽标");
  assert.match(own.__summary, /构建期预筛 3 行命中（整行只有术语、跳过模型 0；其余 3 行注入术语后交给模型，其中术语冲突 1 行），预计 4 行仍需 AI 判定/);

  // 换档案：该档案没有对照表 → 不发徽标；换成没算过的变体 → 回落到默认变体
  assert.equal(run("other").__verdicts.size, 0);
  const otherVariant = run("unit", { proofreadMode: "trilingual", target: "tw" });
  assert.equal(otherVariant.__verdicts.get("2"), "conflict", "没有该变体时回落到默认变体");
});

function createTermWorkbench(label) {
  const { html, pageMeta } = buildFixturePage(label);
  const ui = createClientFixture(html, storageFixture());
  ui.run('aiIds.profile.value = "unit"; aiIds.proofreadMode.value = "bilingual"; aiIds.target.value = "cn"; refreshTermVerdicts();');
  return { ui, pageMeta };
}

test("术语预判将状态与命中条数合为单一入口，清单独立于状态徽标组", () => {
  const { ui, pageMeta } = createTermWorkbench("termlist");
  assert.deepEqual(pageMeta.termPrefilter.byProfile.unit.variants["bilingual:cn"].terms["1"], ["山田太郎 → 山田太郎（人名）"]);
  const hit = ui.run('renderRow(allRows.find((row) => row.index === 1))');
  assert.match(hit, /<button type="button" class="term-chip is-injected" data-term-chip="1"/);
  assert.match(hit, /term-chip-label">术语注入<\/span><span class="term-chip-count">1<\/span>/);
  assert.equal((hit.match(/>术语注入</g) || []).length, 1, "注入状态与清单入口只占一个控件");
  assert.match(hit, /aria-expanded="false"/);
  assert.match(hit, /aria-controls="term-list-1"/);
  assert.match(hit, /<ul id="term-list-1" class="term-chip-list" data-term-list="1"[^>]*\bhidden>/);
  assert.match(hit, /山田太郎 → 山田太郎（人名）/);
  assert.match(hit, /构建期判定：本行原文命中对照表 1 条术语/);
  assert.doesNotMatch(hit, /term-chip-state">预判</, "预判来源放在悬停说明里，不再重复占位");
  assert.match(hit, /<div class="confirm-status">[\s\S]*?<\/div><div class="term-chip-slot" data-term-chip-slot="1">/);
  assert.doesNotMatch(hit, /<div class="confirm-status">(?:(?!<\/div>)[\s\S])*data-term-chip/, "展开清单不能位于宽度受限的状态徽标组里");

  const conflict = ui.run('renderTermChipHtml("2", "")');
  assert.match(conflict, /class="term-chip is-conflict"/);
  assert.match(conflict, /term-chip-label">术语冲突<\/span><span class="term-chip-count">1<\/span>/);
  ui.run('termVerdicts.set("3", "term-only")');
  const termOnly = ui.run('renderTermChipHtml("3", "")');
  assert.match(termOnly, /class="term-chip is-term-only"/);
  assert.match(termOnly, /term-chip-label">纯术语<\/span><span class="term-chip-count">1<\/span>/);

  const miss = ui.run('renderRow(allRows.find((row) => row.index === 4))');
  assert.doesNotMatch(miss, /data-term-chip="4"/);
  assert.doesNotMatch(miss, /data-term-list="4"/);
  assert.match(miss, /data-term-chip-slot="4"><\/div>/);
});

test("术语入口兼容缺少清单或判定的历史快照，不制造空清单", () => {
  const { ui } = createTermWorkbench("termlegacy");
  for (const [verdict, text] of [["injected", "术语注入"], ["conflict", "术语冲突"], ["term-only", "纯术语"]]) {
    ui.run(`termEntries.delete("1"); termVerdicts.set("1", ${JSON.stringify(verdict)});`);
    const html = ui.run('renderTermChipHtml("1", "")');
    assert.match(html, /<span class="ai-confirm-badge /);
    assert.ok(html.includes(">" + text + "</span>"), "旧快照仍须显示术语状态");
    assert.doesNotMatch(html, /<button|data-term-list|term-chip-count|aria-expanded/, "没有条目时不能给出可点击的空清单");
  }
  assert.equal(ui.run('renderTermChipHtml("1", "已有校对备注")'), "", "真实备注到达后不再展示旧构建判定");

  ui.run('termEntries.set("1", ["山田太郎 → 山田太郎（人名）"]); termVerdicts.delete("1");');
  const generic = ui.run('renderTermChipHtml("1", "")');
  assert.match(generic, /class="term-chip"/);
  assert.match(generic, /term-chip-label">术语<\/span><span class="term-chip-count">1<\/span>/);
  assert.match(generic, /term-chip-state">预判<\/span>/);

  ui.run('delete termLayer.byProfile.unit.variants["bilingual:cn"].termOnly; refreshTermVerdicts();');
  assert.equal(ui.run('termVerdicts.get("1")'), "term-only", "旧版无 termOnly 时沿用当时一致即跳过模型的语义");
});

test("术语入口一次点击只开合一次，刷新行时保留用户选择", async () => {
  const { ui } = createTermWorkbench("termtoggle");
  const button = ui.element("term-test-button");
  button.dataset.termChip = "1";
  button.setAttribute("aria-expanded", "false");
  const list = ui.element("term-list-1");
  list.hidden = true;
  const row = ui.element("term-test-row");
  row.querySelector = (selector) => selector === "[data-term-chip]" ? button : (selector === "[data-term-list]" ? list : null);
  ui.run('renderedRowsById.set("1", document.getElementById("term-test-row"));');
  const event = {
    target: { closest: (selector) => selector === "[data-term-chip]" ? button : null },
    preventDefault() {}, stopPropagation() {},
  };

  await ui.element("tbody").dispatch("click", event);
  assert.equal(button.getAttribute("aria-expanded"), "true");
  assert.equal(list.hidden, false);
  assert.equal(ui.run('termOpenRows.has("1")'), true);
  const rerendered = ui.run('renderRow(allRows.find((item) => item.index === 1))');
  assert.match(rerendered, /aria-expanded="true"/);
  assert.match(rerendered, /data-term-list="1"[^>]*>/);
  assert.doesNotMatch(rerendered, /data-term-list="1"[^>]*\bhidden/);

  await ui.element("tbody").dispatch("click", event);
  assert.equal(button.getAttribute("aria-expanded"), "false");
  assert.equal(list.hidden, true);
  assert.equal(ui.run('termOpenRows.has("1")'), false);
});

test("校对备注到达后替换术语预判，保留清单与开合并避免重复重建", () => {
  const { ui } = createTermWorkbench("termnote");
  const slot = ui.element("term-test-slot");
  let button = ui.element("term-note-button-0");
  button.parentNode = slot;
  button.setAttribute("aria-expanded", "false");
  const list = ui.element("term-list-1");
  list.hidden = true;
  slot.querySelector = (selector) => selector === "[data-term-chip]" ? button : null;
  let markup = ui.run('renderTermChipHtml("1", "")');
  let replacements = 0;
  Object.defineProperty(slot, "innerHTML", {
    get() { return markup; },
    set(value) {
      // 浏览器重新读取 innerHTML 时会规范化布尔属性，不再逐字等于传入字符串。
      markup = String(value).replace(/ hidden>/g, ' hidden="">');
      replacements += 1;
      button.parentNode = null;
      button = ui.element("term-note-button-" + replacements);
      button.parentNode = slot;
      button.setAttribute("aria-expanded", markup.match(/aria-expanded="(true|false)"/)[1]);
      list.hidden = /data-term-list="1"[^>]*\bhidden/.test(markup);
    },
  });
  const row = ui.element("term-note-row");
  row.querySelector = (selector) => ({
    "[data-term-chip-slot]": slot,
    "[data-term-chip]": button,
    "[data-term-list]": list,
  })[selector] || null;
  ui.run('renderedRowsById.set("1", document.getElementById("term-note-row")); setTermOpen("1", true);');
  ui.run('document.activeElement = document.getElementById("term-note-button-0");');
  const note = ["[AI校对]", "语义是否相同：相同", "是否需要修改：否", "分析：术语与正文含义一致。"].join("\n");
  const write = `writeNote("1", ${JSON.stringify(note)}, true, { deferCommit: true });`;
  ui.run(write);
  assert.match(markup, /class="term-chip"/);
  assert.match(markup, /term-chip-label">术语<\/span><span class="term-chip-count">1<\/span>/);
  assert.match(markup, /term-chip-state">结论<\/span>/);
  assert.doesNotMatch(markup, /is-injected|术语注入|构建期判定/);
  assert.match(markup, /山田太郎 → 山田太郎（人名）/);
  assert.match(markup, /术语清单来自对照表/);
  assert.match(markup, /aria-expanded="true"/);
  assert.doesNotMatch(markup, /data-term-list="1"[^>]*\bhidden/);
  assert.equal(replacements, 1);
  assert.equal(button.focused, true, "备注替换正在操作的按钮时必须恢复键盘焦点");

  ui.run(write);
  assert.equal(replacements, 1, "重复轮询同一备注不能重建并收起术语清单");
  assert.equal(ui.run('termOpenRows.has("1")'), true);

  ui.run('setTermOpen("1", false);');
  ui.run(write);
  assert.match(markup, /data-term-list="1"[^>]*hidden=""/);
  assert.equal(replacements, 2);
  ui.run(write);
  assert.equal(replacements, 2, "浏览器将 hidden 序列化为 hidden=空字符串后也不应重复重建");
  assert.equal(list.hidden, true);
  assert.equal(ui.run('termOpenRows.has("1")'), false);
});

test("只有整行都是术语的行才标成跳过模型", () => {
  const file = writeTable("term-only-terms.csv");
  const rows = [
    { index: 1, chapter: "第一章", jp: "【山田太郎】", cn: "【山田太郎】" },
    { index: 2, chapter: "第一章", jp: "【山田太郎】が来た。", cn: "山田太郎来了。" },
    { index: 3, chapter: "第一章", jp: "【佐藤】", cn: "佐藤" },
  ];
  const layer = buildTermLayer({ rows, profiles: [profile(file)], comparisonMode: "bilingual" });
  const variant = layer.byProfile.unit.variants["bilingual:cn"];
  // 第 3 行只命中 2 字短词（佐藤）：短词不能指控译名错误，但当整行就是这个词时，
  // 一致性仍然覆盖了整行的有效内容，因此允许跳过模型。
  assert.deepEqual(variant.termOnly, [1, 3]);
  assert.deepEqual(variant.injected, [2]);
  assert.equal(variant.summary.removedFromModel, 2);
  assert.equal(variant.summary.aiRows, 1);
  const { termOnly, injected } = variantIndexSets(variant);
  assert.deepEqual([...termOnly], [1, 3]);
  assert.deepEqual([...injected], [2]);
  // 芯片列表与「跳过模型」的判定同源：命中术语的行才有列表。
  assert.deepEqual(variant.terms["3"], ["佐藤 → 佐藤（人名）"]);
  assert.equal(variant.terms["4"], undefined, "没命中的行不该有术语列表");
});

test("只命中分段写法或读音撞车的行不算“用到这个术语”", () => {
  const file = writeTable("segment-terms.csv");
  const tables = loadTermTables([file]);
  // 原文只写姓（山田）：命中分段别名，但不足以说明本行指的是「山田太郎」，交回后续流程。
  assert.equal(evaluateTermRow({ source: "山田は来なかった。", target: "山田没有来。", tables }), null);
  // 原文写的是别的角色，只因为共用读音而命中：不算用到（只有读音、译文里也没有这个名字）。
  assert.equal(evaluateTermRow({ source: "しののめが来た。", target: "别人来了。", tables }), null);
  // 单段条目（佐藤）本身就是整条术语，正常参与判定。
  const single = evaluateTermRow({ source: "佐藤は来なかった。", target: "佐藤没有来。", tables });
  assert.equal(single.kind, "consistent");
  assert.deepEqual(hitsUsedInRow("佐藤は来なかった。", single.hits).map((hit) => hit.entry.source), ["【佐藤】"]);
  // 分段命中不进“用到的术语”：提示词与页面芯片都不会拿它当本行术语。
  const partOnly = hitsUsedInRow("山田は来なかった。", [{ entry: tables.entries[0], alias: "山田", scope: "part", strong: false, consistent: true, aliases: tables.entries[0].aliases }]);
  assert.deepEqual(partOnly, []);
  const full = evaluateTermRow({ source: "山田太郎が来た。", target: "山田太郎来了。", tables });
  assert.deepEqual(hitsUsedInRow("山田太郎が来た。", full.hits).map((hit) => hit.entry.source), ["【山田太郎】"]);
});
