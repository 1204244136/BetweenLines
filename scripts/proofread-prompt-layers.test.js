const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 探针档案必须在 require 注册表之前准备好（profiles/index.js 在模块加载时就读取档案目录）。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-layers-"));
const probeFile = path.join(tempDir, "layers-probe.js");
const novelPath = path.join(__dirname, "..", "src", "workbenches", "translation-compare", "ai", "profiles", "novel.js");

fs.writeFileSync(probeFile, [
  `const novel = require(${JSON.stringify(novelPath)});`,
  "module.exports = {",
  "  ...novel,",
  '  id: "layers-probe",',
  '  name: "行裁剪探针档案",',
  "  sections: [",
  "    {",
  '      title: "探针小节",',
  "      lines: [",
  '        "常驻探针：这一条必须每行都出现。",',
  '        { text: "按行探针：只在命中 ruby 时出现。", features: ["ruby"] },',
  '        { text: "未注册特征探针：声明了不存在的特征，应按常驻处理。", features: ["notARealFeature"] },',
  "      ],",
  "    },",
  "  ],",
  "};",
].join("\n"), "utf8");

process.env.TRANSCOMPARATOR_PROFILE_FILES = probeFile;

const {
  buildProofreadSystemPrompt,
  proofreadPromptFor,
  profileLineStats,
  promptLayerReport,
  resolveProfile,
} = require("../src/workbenches/translation-compare/ai/proofread-contract");
const {
  FEATURE_IDS,
  FEATURE_RULES,
  detectRowFeatures,
  featureUsage,
  unknownFeatureIds,
} = require("../src/workbenches/translation-compare/ai/row-features");
const { buildMessages, promptTrimSummary, resetPromptTrim } = require("./ai-proofread");

test.after(() => {
  delete process.env.TRANSCOMPARATOR_PROFILE_FILES;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// 每个注册特征的代表性样例行：既验证“特征可达”，也当按行裁剪的夹具。
const FEATURE_SAMPLES = {
  ruby: { source: "|食蜂[しょくほう]操祈", target: "<ruby>食蜂<rt>shokuho</rt></ruby>操祈" },
  emphasis: { source: "彼は﹅怒った﹅。", target: "他<b>生气</b>了。" },
  noteref: { source: "本文。", target: "本文<a epub:type=\"noteref\"><sup>㊟</sup></a>" },
  page: { source: "次のページ。", target: "<p class=\"pb\">换页了。</p>" },
  blank: { source: "前の段落。\n\n次の段落。", target: "前一段。\n\n后一段。" },
  ellipsis: { source: "そう……。", target: "这样......。" },
  interrobang: { source: "本当に！？", target: "真的？！" },
  quote: { source: "「そうか」と彼は言った。", target: "「是吗」他说。" },
  conjunction: { source: "しかし、", target: "然而——" },
  repeat: { source: "あああ、そうか。", target: "啊啊啊，是吗。" },
  speechEffect: { source: "ドキドキした。", target: "心跳不已。" },
  particle: { source: "まあ、いいか。", target: "嘛，算了吧。" },
  numeric: { source: "3キロ先だ。", target: "在3千米外。" },
};

function payload(overrides = {}) {
  return {
    row: { index: 1, jp: "高圧電流。", cn: "高压电流。" },
    targetLabel: "主文本（待修改文本）",
    targetText: "高压电流。",
    counterpartLabel: "原文 A",
    counterpartText: "高圧電流。",
    diffHelper: "x",
    context: [],
    contextMode: "none",
    ...overrides,
  };
}

// 每条按行规范的辨识短语：出现在提示词里就说明该条被注入了。
const ROW_LINE_MARKERS = {
  ruby: "基文[注文]",
  emphasis: "原文右侧傍点",
  noteref: "（*译注：…）",
  page: "段落 class",
  blank: "空行按规范折叠",
  ellipsis: "省略号被写成连续句号",
  interrobang: "按规范统一写成「？！」",
  quote: "引号用途：背景音与非人声",
  conjunction: "连接词独立成段",
  repeat: "重复出现的字或符号",
  speechEffect: "拟声词后的「と」不译",
  particle: "语气词与拟声词按中文语境选词",
  numeric: "小数用阿拉伯数字",
};

test("注册特征与实现一一对应，且每个特征都有可达的样例行", () => {
  assert.deepEqual(Object.keys(FEATURE_RULES).sort(), [...FEATURE_IDS].sort(), "每个注册特征都必须有实现");
  assert.equal(new Set(FEATURE_IDS).size, FEATURE_IDS.length, "特征 id 不得重复");
  for (const id of FEATURE_IDS) {
    const sample = FEATURE_SAMPLES[id];
    assert.ok(sample, `特征「${id}」缺少样例行：没有样例就无法证明它可达`);
    const hit = detectRowFeatures(sample);
    assert.equal(hit.has(id), true, `样例行应命中特征「${id}」，实际命中：${[...hit].join(",")}`);
  }
});

test("按行裁剪：只在当前行命中特征时才注入对应的特化规范", () => {
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  assert.equal(plain.size, 0, "纯叙述行不该命中任何特征");

  const trimmed = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  for (const [id, marker] of Object.entries(ROW_LINE_MARKERS)) {
    assert.equal(trimmed.includes(marker), false, `纯叙述行不该注入「${id}」的规范：${marker}`);
  }
  // 常驻条目：每条按行裁剪后仍必须保留（语义判断、证据边界、作品专有、说话特色）。
  for (const marker of [
    "人名或术语与译名表、前后文不一致",
    "行边界由上游对齐决定",
    "系列名、专有名词与术语以本项目译名表为准",
    "角色口癖、第一人称、句尾语气词",
  ]) {
    assert.equal(trimmed.includes(marker), true, `常驻条目被误裁：${marker}`);
  }
  // 通用侧、模式层、固定尾巴永远全量。
  for (const marker of ["【通用校对规则】", "当前是双语校对", "硬性格式约束", "只返回一个 JSON 对象"]) {
    assert.equal(trimmed.includes(marker), true, `不可裁剪的层丢了内容：${marker}`);
  }

  // 命中特征时才注入对应条目，且只注入相关的那几条。
  const withRuby = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    rowFeatures: detectRowFeatures(FEATURE_SAMPLES.ruby),
  });
  assert.equal(withRuby.includes(ROW_LINE_MARKERS.ruby), true);
  assert.equal(withRuby.includes(ROW_LINE_MARKERS.emphasis), false, "命中 ruby 不该连带注入傍点规范");
  assert.ok(withRuby.length > trimmed.length, "命中特征后提示词应当变长");
});

test("页面默认提示词保持全量：裁剪只发生在真正发请求时", () => {
  const full = proofreadPromptFor("bilingual", "novel").system;
  for (const marker of Object.values(ROW_LINE_MARKERS)) {
    assert.equal(full.includes(marker), true, `默认提示词（人工阅读/编辑用）必须是全量，缺：${marker}`);
  }
  const stats = profileLineStats(resolveProfile("novel"), null);
  assert.equal(stats.omitted, 0, "全量模式下不该有被省略的条目");
  assert.ok(stats.conditional > 0, "档案里应当存在按行条目");
});

test("按行条目必须声明已注册的特征；未声明或不认识的条目按常驻处理", () => {
  const novel = resolveProfile("novel");
  assert.deepEqual(unknownFeatureIds(novel), [], "内置档案不得声明未注册的特征");
  const usage = featureUsage(novel);
  assert.ok(usage.conditional >= 10, "内置档案应当有一批按行条目");
  assert.ok(usage.always >= 10, "内置档案应当有一批常驻条目");

  // 探针档案：字符串条目每行都在；未注册特征按常驻处理（宁可多注入）。
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const probe = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "layers-probe", rowFeatures: plain });
  assert.equal(probe.includes("常驻探针：这一条必须每行都出现。"), true);
  assert.equal(probe.includes("按行探针：只在命中 ruby 时出现。"), false);
  assert.equal(probe.includes("未注册特征探针"), true, "声明了未注册特征的条目必须按常驻处理，不能静默消失");

  const withRuby = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "layers-probe",
    rowFeatures: detectRowFeatures(FEATURE_SAMPLES.ruby),
  });
  assert.equal(withRuby.includes("按行探针：只在命中 ruby 时出现。"), true);
  assert.deepEqual(unknownFeatureIds(resolveProfile("layers-probe")), ["notARealFeature"]);
});

test("行数据缺失时不裁剪：宁可多注入也不丢规范", () => {
  const nothing = detectRowFeatures({ source: "", target: "" });
  assert.equal(nothing.size, FEATURE_IDS.length, "两侧都没文本时全部按命中处理");
  const system = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: nothing });
  assert.equal(system, proofreadPromptFor("bilingual", "novel").system, "无法判断时必须与全量一致");
});

test("TRANSCOMPARATOR_FULL_PROMPT=1 时退回全量，用于对比排查", () => {
  const config = { proofreadMode: "bilingual", profileId: "novel" };
  const trimmed = buildMessages(payload(), config)[0].content;
  process.env.TRANSCOMPARATOR_FULL_PROMPT = "1";
  try {
    const full = buildMessages(payload(), config)[0].content;
    assert.equal(full, proofreadPromptFor("bilingual", "novel").system);
    assert.ok(full.length > trimmed.length);
  } finally {
    delete process.env.TRANSCOMPARATOR_FULL_PROMPT;
  }
});

test("裁剪可审计：报告给出各层长度与被省略的条目数", () => {
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const report = promptLayerReport({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  assert.equal(report.profileLines.omitted > 0, true);
  assert.equal(report.profileLines.omittedChars > 500, true, "被省略的规范应当有可观字符量");
  assert.equal(report.layers.generic > 0 && report.layers.mode > 0 && report.layers.profile > 0, true);
  assert.deepEqual(report.unknownFeatures, []);
});

test("任务结束时汇报本次裁剪省了多少条规范", () => {
  const config = { proofreadMode: "bilingual", profileId: "novel" };
  resetPromptTrim();
  assert.equal(promptTrimSummary(), "", "还没有请求时不汇报");
  buildMessages(payload(), config);
  buildMessages(payload({ targetText: "<ruby>高压<rt>gāo</rt></ruby>电流。", row: { index: 2, jp: "|高圧[こうあつ]電流。", cn: "" } }), config);
  const summary = promptTrimSummary();
  assert.match(summary, /提示词按行裁剪：2 行/);
  assert.match(summary, /省略 \d+ 条/);
  assert.match(summary, /平均每行省约 \d+ 字符/);
  assert.match(summary, /ruby 1 行/);
  resetPromptTrim();
});

test("第 4 层的动态段：术语 → 说话习惯 → 线上查证，各只出现一次且顺序固定", () => {
  // 四个段的段首标记都必须登记在 dynamicBlockPrefixes 里：自定义提示词残留的旧段先被剥掉，
  // 再按“由内到外补充资料”的顺序统一注入（新增动态段时若漏登记，这条测试会立刻失败）。
  const termBlock = "【术语（对照表命中）】\n本行原文命中了本项目译名对照表的下列条目：\n- グループ → GROUP（组织/暗部）";
  const habitBlock = "【说话习惯（本章）】本章「第一章」出现了以下角色（按人名命中判定）：这些角色的说话特色是刻意的语言特征。\n- 山田太郎：第一人称 「オレ」 → 本项目写作「本大爷」";
  const lookupBlock = "【线上查证（作品维基）】 第 1/3 站：中文（灰机）\n站点入口：https://example.com/wiki/";
  const counts = (text, needle) => text.split(needle).length - 1;

  const system = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    termBlock,
    speechHabitBlock: habitBlock,
    webLookupBlock: lookupBlock,
  });
  for (const needle of ["【术语（对照表命中）】", "【说话习惯（本章）】", "【线上查证（作品维基）】"]) {
    assert.equal(counts(system, needle), 1, `动态段只能出现一次：${needle}`);
  }
  const order = ["【术语（对照表命中）】", "【说话习惯（本章）】", "【线上查证（作品维基）】", "只返回一个 JSON 对象"]
    .map((needle) => system.indexOf(needle));
  assert.equal(order.every((index) => index >= 0), true, "动态段与固定尾巴都应在最终提示词里");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "顺序必须是 术语 → 说话习惯 → 线上查证 → JSON 约定");

  // 自定义提示词里残留的旧动态段要被剥掉（用户可能直接沿用上一次的整段文本）。
  // 注意动态段的边界是“到下一个【或硬性约束为止”，所以用户追加的规则要写在段**之前**才不会被吞掉
  // （这条纪律在 term-prefilter.test.js 里已有专门断言，这里只验剥离后不出现两份）。
  const stale = `${system}\n${lookupBlock}`;
  const rebuilt = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    customSystem: stale,
    termBlock,
    speechHabitBlock: habitBlock,
    webLookupBlock: lookupBlock,
  });
  for (const needle of ["【术语（对照表命中）】", "【说话习惯（本章）】", "【线上查证（作品维基）】"]) {
    assert.equal(counts(rebuilt, needle), 1, `残留的旧动态段没被剥干净：${needle}`);
  }
  // 没有命中任何动态段的行：四段都不出现（不能留空段或标题）。
  const plain = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel" });
  for (const needle of ["【术语（对照表命中）】", "【说话习惯（", "【说话人判断（", "【线上查证（作品维基）】"]) {
    assert.equal(plain.includes(needle), false, `没有命中时不该出现动态段：${needle}`);
  }
});
