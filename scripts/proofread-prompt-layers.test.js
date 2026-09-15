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
  `  sections: [`,
  `    ...novel.sections,`,
  "    {",
  '      title: "探针小节",',
  "      lines: [",
  '        "常驻探针：这一条必须每行都出现。",',
  '        { text: "按行探针：只在命中 ruby 时出现。", features: ["ruby"] },',
  '        { text: "未注册特征探针：声明了不存在的特征，应按常驻处理。", features: ["notARealFeature"] },',
  // 实体闸门探针：名字都是中性夹具名，与具体作品无关（示范档案不再为某个角色开例外）。
  '        { text: "实体探针：只在出现甲野一郎时注入。", characters: ["甲野一郎"] },',
  '        { text: "实体内嵌探针：出现乙川次郎且本行有数字时才注入。", characters: ["乙川次郎"], features: ["numeric"] },',
  "      ],",
  "    },",
  "  ],",
  "};",
].join("\n"), "utf8");

process.env.TRANSCOMPARATOR_PROFILE_FILES = probeFile;

const {
  buildProofreadSystemPrompt,
  proofreadPromptFor,
  profileEntities,
  profileLineStats,
  promptLayerReport,
  resolveProfile,
} = require("../src/workbenches/translation-compare/ai/proofread-contract");
const {
  detectRowEntities,
  matchEntityIds,
} = require("../src/workbenches/translation-compare/ai/name-entities");
const {
  FEATURE_IDS,
  FEATURE_RULES,
  detectRowFeatures,
  featureUsage,
  unknownFeatureIds,
} = require("../src/workbenches/translation-compare/ai/row-features");
const { buildMessages, promptTrimSummary, resetPromptTrim } = require("./ai-proofread");
const { LOW_SCORE_PREFIX } = require("../src/workbenches/translation-compare/ai/low-score");

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
  parenthesis: { source: "（ふうん。……）", target: "（嗯。……）" },
  conjunction: { source: "しかし、", target: "然而——" },
  repeat: { source: "あああ、そうか。", target: "啊啊啊，是吗。" },
  speechEffect: { source: "ドキドキした。", target: "心跳不已。" },
  particle: { source: "まあ、いいか。", target: "嘛，算了吧。" },
  numeric: { source: "3キロ先だ。", target: "在3千米外。" },
  fragment: { source: "しかし、", target: "但是。" },
  outOfScope: { source: "本文。", target: "本文。\n\n特典附录。" },
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

// 同一批按行规范里的第二条：与「引号用途」共用 quote 特征、与「括号」共用 parenthesis 特征，
// 但各自独立裁剪与断言。成对标记（引号/括号）内侧句末点号的位置是中文规范问题，
// 不能用 A（日文）的标点当判据——见下面的假阳性回归（第 898 行的引号、第 1087 行的括号）。
const PAIR_PUNCT_MARKER = "内侧的句末点号按 B 的中文规范定位置";
// 引号有无不是缺陷判据（真实假阳性第 1683 行：原文「野戦病院。」、译文「战地医院」。，全卷同形状 27 行），
// 以及「标记内只是词/短语时句末点号落在外侧是常规写法」：这两条与「引号用途」共用 quote 特征注入。
const QUOTE_EVIDENCE_MARKER = "A 无引号不得判 B「误加引号」";
const PAIR_PUNCT_SCOPE_MARKER = "标记内只是半句话、一个词、短语或拟声";
// 注音条目同样补了一句证据边界：只能评价 B 里实际出现的注音。
const RUBY_EVIDENCE_MARKER = "判断只能针对 B 里实际出现的注音";
// 标点写法既约束判断也约束**改写**：真实回归是模型在 revisedText 里把「……」打成「......」，
// 而旧规范只写成“判 B 的缺陷”，模型便不拿它约束自己写出的文本。
const PUNCT_FULLWIDTH_MARKER = "中文正文里的标点一律用全角字形";
const PUNCT_REVISION_MARKER = "这一条同时约束你自己写出的 revisedText";
const ELLIPSIS_REWRITE_MARKER = "你的 revisedText 同样必须用「……」";

// 每条按行规范的辨识短语：出现在提示词里就说明该条被注入了。
// 注意 ruby 的辨识短语不能选「基文[注文]」这类字样：通用侧的输出语言约束里也会提到注音写法，
// 那样连纯叙述行都能匹配上，断言就失去意义了。
const ROW_LINE_MARKERS = {
  ruby: "普通词没有注音不算缺陷",
  emphasis: "原文右侧傍点",
  noteref: "（*译注：…）",
  page: "段落 class",
  blank: "空行按规范折叠",
  ellipsis: "省略号被写成连续句号",
  interrobang: "按规范统一写成「？！」",
  quote: "引号用途：背景音与非人声",
  // 括号与引号共用那条「成对标记内侧的句末点号」规范，所以这里的辨识短语与 quote 的不同。
  parenthesis: PAIR_PUNCT_MARKER,
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
    // 标点全角化是每行都要看的排版底线：任何一行都可能被改写，规范漏注入就等于模型
    // 只在“恰好出现连点”的行才受约束，其余行的改写可以随便打半角标点。
    PUNCT_FULLWIDTH_MARKER,
    PUNCT_REVISION_MARKER,
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

test("通用侧的三条可判定规则也按行注入：片段、noteref 与原文外内容", () => {
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const plainPrompt = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  for (const marker of ["任一侧是不完整片段", "EPUB 注释标记", "目标列中原文没有的特典"]) {
    assert.equal(plainPrompt.includes(marker), false, `普通完整行不该注入通用规则：${marker}`);
  }

  const fragment = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    rowFeatures: detectRowFeatures({ source: "しかし、", target: "但是。" }),
  });
  assert.equal(fragment.includes("任一侧是不完整片段"), true);

  const noteref = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    rowFeatures: detectRowFeatures({ source: "本文。", target: "本文<a epub:type=\"noteref\"><sup>㊟</sup></a>" }),
  });
  assert.equal(noteref.includes("EPUB 注释标记，不属于正文语义"), true);

  const outOfScope = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    rowFeatures: detectRowFeatures({ source: "本文。", target: "本文。\n\n特典附录。" }),
  });
  assert.equal(outOfScope.includes("目标列中原文没有的特典"), true);
});

test("原文侧的 HTML 注音也算命中：不能漏掉“原文有注音、译文没有”的行", () => {
  // 本工作台的日文原文列就是 <ruby>基文<rt>注文</rt></ruby> 形态（实测整卷 3119 行里 1116 行），
  // 探测器只认目标列会让其中 923 行拿不到注音规范——模型没有口径可依，就会照抄原文的日文读音。
  const row = {
    source: "「ねえ待って、無理だよ!! あのこれちょっと見て、手のトコ<ruby>鍋掴<rt>なべつか</rt></ruby>みたいになってるよ!!」",
    target: "「喂等等，办不到啦！！那个稍微看看这个，手部跟防烫隔热手套一样啊！！」",
  };
  const hit = detectRowFeatures(row);
  assert.equal(hit.has("ruby"), true, "原文侧带 <ruby> 却不命中，等于整条注音规范不注入");
  const system = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: hit });
  assert.equal(system.includes(ROW_LINE_MARKERS.ruby), true);
  // 目标列侧带注音（旧口径唯一认的那种）与译者稿形态都仍然命中。
  assert.equal(detectRowFeatures(FEATURE_SAMPLES.ruby).has("ruby"), true);
  assert.equal(detectRowFeatures({ source: "|鍋掴[なべつか]みたい", target: "跟隔热手套一样" }).has("ruby"), true);
});

test("成对标记内侧的句末点号：A 在 」/） 前省略它，不代表 B 多出句号是缺陷", () => {
  // 真实假阳性：原文（日文）在收尾符号前省略句末点号，译文（中文）按规范在标记内侧补出，
  // 模型据此判「对话尾部引号前多出句号」，扣分并在 revisedText 里删掉了这个点号。
  // 句末点号的位置是目标列语言的规范问题，A 的标点不是判据。
  const row = {
    source: "「はい、わかりました、と山田は律儀に報告いたします」",
    target: "「好的，我明白了，山田老老实实地报告道。」",
  };
  const hit = detectRowFeatures(row);
  assert.equal(hit.has("quote"), true, "带引号的行必须命中 quote 特征");
  const system = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: hit });
  assert.equal(system.includes(PAIR_PUNCT_MARKER), true, "成对标记内侧句末点号的规范必须注入到带引号的行");
  assert.equal(system.includes("不得据此判缺陷"), true);
  assert.equal(system.includes("也不得在 revisedText 里删掉它"), true);
  // 同一特征下的另一条规范（引号用途）仍按同一份裁剪结果注入，两条互不替代。
  assert.equal(system.includes(ROW_LINE_MARKERS.quote), true);
  // 真实回归（第 2064 行）：纯拟声词形成的句子允许使用「」，非人声音效规则不强行要求改『』
  assert.equal(system.includes("纯拟声词形成的句子例外"), true);

  // 回归（第 1087 行）：收尾符号是**括号**时同样要拿到这条规范——只认引号的特征会让
  // 整行括注的行拿不到它，模型便会再删一次句号。
  const bracketRow = { source: "（……現実にはそうなっていない）", target: "（实际上并没有变成那样。）" };
  const bracketHit = detectRowFeatures(bracketRow);
  assert.equal(bracketHit.has("parenthesis"), true, "带全角括号的行必须命中 parenthesis 特征");
  assert.equal(bracketHit.has("quote"), false, "整行括注的行没有引号");
  const bracketSystem = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: bracketHit });
  assert.equal(bracketSystem.includes(PAIR_PUNCT_MARKER), true, "整行括注的行必须拿到同一条点号规范");

  // 不带任何成对标记的叙述行不注入这条：按行裁剪照旧生效。
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const trimmed = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  assert.equal(trimmed.includes(PAIR_PUNCT_MARKER), false, "叙述行不该背上成对标记的点号规范");

  // 页面预填的默认提示词（全量）必须也带上它，人工读得到完整规范。
  assert.equal(proofreadPromptFor("bilingual", "novel").system.includes(PAIR_PUNCT_MARKER), true);
});

test("A 无引号不等于 B 误加引号：被提及的词用「」是成品写法，点号也不必挪进标记内", () => {
  // 真实假阳性（第 1683 行）：原文「野戦病院。」、译文「战地医院」。——模型在 summary 里写
  // 「译文误加引号且句末点号外置」，revisedText 里却只把句末点号挪进了引号内侧，分析与结果对不上。
  // 原因不是程序改的：输出侧三步（格式门禁/标点规范化/语言护栏）在这一行都是空操作，
  // `restoreTerminalPunctuation` 也没有补回引号的能力。模型只落地了提示词明确授权的那一半，
  // 所以缺的是规范：中文成品用直角引号标记被提及的词、心声、拟声与招牌，A 在这些位置常不加引号。
  const row = { source: "野戦病院。", target: "「战地医院」。" };
  const hit = detectRowFeatures(row);
  assert.equal(hit.has("quote"), true, "目标列用直角引号的行必须命中 quote 特征");
  const system = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: hit });
  assert.equal(system.includes(QUOTE_EVIDENCE_MARKER), true, "带引号的行必须拿到「A 无引号不算误加引号」这条证据边界");
  assert.equal(system.includes("也不得据此在 revisedText 里增删引号"), true);
  assert.equal(system.includes("被提及的词、短语、心声、拟声或招牌"), true);
  // 同一条特征带进来的点号规范必须限定范围：标记内只是词/短语时，点号落在外侧是常规写法。
  assert.equal(system.includes(PAIR_PUNCT_SCOPE_MARKER), true, "不限定范围时，被提及的词也会被挪点号");
  assert.equal(system.includes("也不必在 revisedText 里把它挪进标记内"), true);

  // 两条都是按行条目：不带引号的叙述行不背这两条。
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const trimmed = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  assert.equal(trimmed.includes(QUOTE_EVIDENCE_MARKER), false, "叙述行不该拿到引号证据边界");
  assert.equal(trimmed.includes(PAIR_PUNCT_SCOPE_MARKER), false, "叙述行不该拿到成对标记的点号范围");
  // 每行常驻的那条证据边界必须把引号与标点算进枚举：只写「注音、傍点、分页」时，
  // 「A 看不到某标记不得判 B 多出该写法是缺陷」这条原则覆盖不到引号，模型照样会自造缺陷。
  assert.equal(trimmed.includes("注音、傍点、分页、引号与标点等信息可能缺失"), true, "证据边界枚举要常驻并包含引号与标点");

  // 页面预填的默认提示词（全量）同样带上，人工读得到完整规范。
  const full = proofreadPromptFor("bilingual", "novel").system;
  assert.equal(full.includes(QUOTE_EVIDENCE_MARKER), true);
  assert.equal(full.includes(PAIR_PUNCT_SCOPE_MARKER), true);
});

test("注音规范只评价 B 里实际出现的注音：不得凭 A 里普通词的假名读音指控 B 保留注音", () => {
  const hit = detectRowFeatures(FEATURE_SAMPLES.ruby);
  const system = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: hit });
  assert.equal(system.includes(RUBY_EVIDENCE_MARKER), true);
  assert.equal(system.includes("不得写进 summary 当作扣分项"), true);
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const trimmed = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  assert.equal(trimmed.includes(RUBY_EVIDENCE_MARKER), false);
});

test("半角标点：连点行必须拿到省略号写法，且规范明确约束模型自己写出的修订结果", () => {
  // 真实回归（第 1040 行）：B 与 A 里都是省略号，模型却在 revisedText 里打出「......」，
  // 判定与改写用的是同一套规范，规范必须对自己的输出也生效。
  const row = {
    source: "という床全体を震わせるほど太い音の塊の正体は……。",
    target: "震撼整块地面的声音到底是......",
  };
  const hit = detectRowFeatures(row);
  assert.equal(hit.has("ellipsis"), true, "目标列里的连续半角点必须命中省略号特征");
  // 两个点与三个点是同一类缺陷：门槛与规范化层（punctuation.js 的 `\.{2,}`）必须一致。
  assert.equal(detectRowFeatures({ source: "そうだ。", target: "这样.." }).has("ellipsis"), true);
  const system = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: hit });
  assert.equal(system.includes(ELLIPSIS_REWRITE_MARKER), true, "省略号条目必须写明 revisedText 也要用「……」");
  assert.equal(system.includes("不要原样保留"), true);
  // 常驻的全角条款对任何行都在（模型可能在毫无连点的行里自行引入半角标点）。
  assert.equal(system.includes(PUNCT_REVISION_MARKER), true);
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const trimmed = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  assert.equal(trimmed.includes(ELLIPSIS_REWRITE_MARKER), false, "没有连点现象的行不背省略号条目");
  assert.equal(trimmed.includes(PUNCT_REVISION_MARKER), true, "但全角标点的底线每行都在");
});

test("输出语言约束与标记范围：修订结果不得写入原文文字，标记只留目标列自身已有的", () => {
  const plain = detectRowFeatures({ source: "高圧電流。", target: "高压电流。" });
  const full = proofreadPromptFor("bilingual", "novel").system;
  const trimmed = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", rowFeatures: plain });
  for (const text of [full, trimmed]) {
    // 通用侧与固定尾巴永远全量：裁剪之后这两条也必须在，否则模型只在“恰好命中 ruby”的行才受约束。
    assert.equal(text.includes("revisedText 只能是目标列语言的文字"), true);
    assert.equal(text.includes("不得照抄原文读音"), true);
    assert.equal(text.includes("只保留目标列自身已有的内联标记"), true);
    assert.equal(text.includes("目标列里没有的标记不得从原文补进 revisedText"), true);
    // 结构口径（一条 = 一个成品段落）同样是通用侧的常驻契约：它对应输出侧的成品格式门禁
    // （`ai/format-guard.js`）。提示词只能“要求”，所以两条必须成对存在，缺一条就等于只剩兜底、
    // 或者只剩要求（真实回归：原文那行是两段、目标列一段，模型判「译文丢了原文换行」并插入 `\n`）。
    assert.equal(text.includes("revisedText 只能是**一整行文本**"), true);
    assert.equal(text.includes("一个行就是一个成品段落"), true);
    assert.equal(text.includes("原文那一侧的分行、空行、行首缩进都是版式事实"), true);
  }
});

test("页面默认提示词保持全量：裁剪只发生在真正发请求时", () => {
  const full = proofreadPromptFor("bilingual", "novel").system;
  for (const marker of [
    ...Object.values(ROW_LINE_MARKERS),
    PAIR_PUNCT_MARKER,
    RUBY_EVIDENCE_MARKER,
    PUNCT_FULLWIDTH_MARKER,
    PUNCT_REVISION_MARKER,
    ELLIPSIS_REWRITE_MARKER,
  ]) {
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

// 实体闸门：只对某个角色/专有词成立的规则，按「本行有没有出现那个名字」注入。
// 为什么单列一组断言：这类规则以前只能写成常驻条目，于是整卷每一行都背着它
// （实测某卷 3119 行里，两条角色专属规则一次都没命中，却出现在每一次请求里），既花 token
// 又把注意力从「这一行到底哪里有问题」上稀释掉。夹具用中性人名，与具体作品无关。
const ENTITY_PROBES = [
  { label: "甲野一郎", marker: "实体探针：只在出现甲野一郎时注入。" },
  { label: "乙川次郎", marker: "实体内嵌探针：出现乙川次郎且本行有数字时才注入。" },
];

/** 探针行的提示词：给了本行文本，实体闸门才有判据。 */
function probeSystem(row) {
  return buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "layers-probe",
    rowFeatures: detectRowFeatures(row),
    sourceText: row.source,
    targetText: row.target,
  });
}

test("实体闸门：角色专属条目只在真的出现那个名字时注入", () => {
  const silentRow = { source: "「……うそ……？」", target: "「……骗人……？」" };
  const silent = probeSystem(silentRow);
  for (const { label, marker } of ENTITY_PROBES) {
    assert.equal(silent.includes(marker), false, `本行没有「${label}」时不该注入这条专属规范`);
  }
  // 常驻条目照旧每行都在（实体闸门只影响声明了 characters 的条目）。
  assert.equal(silent.includes("常驻探针：这一条必须每行都出现。"), true);

  // 名字出现在任一侧（原文或译文）都算命中：译者按译名写了中文名、原文只写了日文名时都要注入。
  const named = probeSystem({ source: "甲野一郎は笑った。", target: "甲野一郎笑了。" });
  assert.equal(named.includes(ENTITY_PROBES[0].marker), true, "出现该角色时必须注入他的专属规范");
  assert.equal(named.includes(ENTITY_PROBES[1].marker), false, "别的角色的专属规范不该连带注入");
  // 目标列侧单独命中同样算命中：判定看两侧文本。
  const targetOnly = detectRowEntities({
    source: "こうのいちろう。",
    target: "甲野一郎。",
    entities: profileEntities(resolveProfile("layers-probe")),
  });
  assert.equal(targetOnly.has("甲野一郎"), true);
  assert.equal(targetOnly.has("乙川次郎"), false);

  // 实体与版式现象同时声明时是**与**关系：没有数字的行不注入内嵌探针那条。
  const nameOnly = probeSystem({ source: "乙川次郎は歩いていた。", target: "乙川次郎走着。" });
  assert.equal(nameOnly.includes(ENTITY_PROBES[1].marker), false, "只有名字、没有数字的行不该注入内嵌探针");
  const nameAndNumber = probeSystem({ source: "乙川次郎は三番目だ。", target: "乙川次郎是第三个。" });
  assert.equal(nameAndNumber.includes(ENTITY_PROBES[1].marker), false, "原文用汉字数字不算 numeric 特征");
  const withDigit = probeSystem({ source: "乙川次郎3号だ。", target: "是乙川次郎3号。" });
  assert.equal(withDigit.includes(ENTITY_PROBES[1].marker), true, "名字与数字同时出现时必须注入");

  // 页面预填的默认提示词（全量）仍然包含全部条目：人工读得到完整规范。
  const full = proofreadPromptFor("bilingual", "layers-probe").system;
  for (const { marker } of ENTITY_PROBES) assert.equal(full.includes(marker), true);
});

test("实体闸门：行数据缺失或只给特征时不裁剪（宁可多注入）", () => {
  // 两侧都没有文本、也没给任何判定依据 → 与全量一致（沿用 row-features 的兜底口径）。
  const missing = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "layers-probe",
    rowFeatures: detectRowFeatures({ source: "", target: "" }),
    sourceText: "",
    targetText: "",
  });
  assert.equal(missing, proofreadPromptFor("bilingual", "layers-probe").system);

  // 只给特征（旧调用点）时的口径：**判定依据以调用方给的为准**。
  // 有文本 → 特征的判定照旧生效（命中省略号就注入省略号条目、其余按特征裁剪），实体不再被当成
  // 「命中」（没有文本就没有实体证据）；没有文本 → 连特征也探测不出来，整份退回全量。
  const featuresOnly = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "layers-probe",
    rowFeatures: detectRowFeatures({ source: "そう……。", target: "这样......。" }),
    sourceText: "そう……。",
    targetText: "这样......。",
  });
  assert.equal(featuresOnly.includes("省略号被写成连续句号"), true, "特征裁剪必须照旧生效");
  for (const { marker } of ENTITY_PROBES) assert.equal(featuresOnly.includes(marker), false);

  // TRANSCOMPARATOR_FULL_PROMPT=1 时实体闸门与特征裁剪一起退回全量。
  process.env.TRANSCOMPARATOR_FULL_PROMPT = "1";
  try {
    const full = buildMessages(payload(), { proofreadMode: "bilingual", profileId: "layers-probe" })[0].content;
    for (const { marker } of ENTITY_PROBES) assert.equal(full.includes(marker), true);
  } finally {
    delete process.env.TRANSCOMPARATOR_FULL_PROMPT;
  }
});

test("实体闸门的审计：报告命中了哪些声明、省掉了哪些，并在任务结束时汇报", () => {
  const entities = profileEntities(resolveProfile("layers-probe"));
  assert.deepEqual(entities.map((entity) => entity.id), ["甲野一郎", "乙川次郎"]);
  // 别名口径：全名与去分隔符写法都算命中（`甲野一郎|甲野` 这种显式片段别名由档案自己声明）。
  assert.equal(matchEntityIds("甲野一郎笑了。", entities).has("甲野一郎"), true);
  assert.equal(matchEntityIds("乙川次郎3号", entities).has("乙川次郎"), true);
  assert.equal(matchEntityIds("甲野花子走在路上。", entities).has("甲野一郎"), false, "片段命中不得放宽到同姓的别的角色");

  const report = promptLayerReport({
    mode: "bilingual",
    profileId: "layers-probe",
    rowFeatures: detectRowFeatures({ source: "甲野一郎は笑った。", target: "甲野一郎笑了。" }),
    sourceText: "甲野一郎は笑った。",
    targetText: "甲野一郎笑了。",
  });
  assert.equal(report.profileLines.entityGated, 2, "档案里的实体条目数应能被点出来");
  assert.deepEqual(report.entities.hit, ["甲野一郎"]);
  assert.deepEqual(report.entities.skipped, ["乙川次郎"]);

  const config = { proofreadMode: "bilingual", profileId: "layers-probe" };
  resetPromptTrim();
  buildMessages(payload({ row: { index: 1, jp: "甲野一郎は笑った。", cn: "甲野一郎笑了。" }, targetText: "甲野一郎笑了。" }), config);
  buildMessages(payload({
    row: { index: 2, jp: "乙川次郎3号だ。", cn: "是乙川次郎3号。" },
    targetText: "是乙川次郎3号。",
  }), config);
  const summary = promptTrimSummary();
  assert.match(summary, /2 行/);
  assert.match(summary, /角色\/专有词专属条目因本行未出现该名字而省掉 \d+ 次/);
  assert.match(summary, /甲野一郎 1 行/);
  assert.match(summary, /乙川次郎 1 行/);
  resetPromptTrim();
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

test("真实行样本保持压缩后的请求预算", () => {
  const messages = buildMessages({
    row: {
      index: 3014,
      jp: "ただし彼女は『理解者』、少年の支え方なら心得ている。",
      cn: "但是对于怎么让作为「理解者」的少年振作起来，她还是很有心得的。",
    },
    targetLabel: "主文本（待修改文本）",
    targetText: "但是对于怎么让作为「理解者」的少年振作起来，她还是很有心得的。",
    counterpartLabel: "原文 A",
    counterpartText: "ただし彼女は『理解者』、少年の支え方なら心得ている。",
    context: [],
    contextMode: "none",
  }, { proofreadMode: "bilingual", profileId: "demo" });
  // 预算按实测最坏行（带成对标记的 demo 行）定基线。第 1683 行的两处证据边界（引号有无不算缺陷、
  // 成对标记内的点号规范只对完整引述/整行括注生效）让这一行 +148 字符；每行常驻的只有证据边界枚举 +6。
  assert.ok(messages[0].content.length <= 4200, `system 前缀仍过长：${messages[0].content.length}`);
  assert.ok(messages[1].content.length <= 900, `user 载荷仍过长：${messages[1].content.length}`);
  assert.ok(messages[0].content.length + messages[1].content.length <= 5100, "单行请求总长度超过预算");
});

test("第 4 层的动态段：术语 → 说话习惯 → 低分归因 → 线上查证，各只出现一次且顺序固定", () => {
  // 每个段的段首标记都必须登记在 dynamicBlockPrefixes 里：自定义提示词残留的旧段先被剥掉，
  // 再按“由内到外补充资料”的顺序统一注入（新增动态段时若漏登记，这条测试会立刻失败）。
  const termBlock = "【术语（对照表命中）】\n本行原文命中了本项目译名对照表的下列条目：\n- グループ → GROUP（组织/暗部）";
  const habitBlock = "【说话习惯（本章）】本章「第一章」出现了以下角色（按人名命中判定）：这些角色的说话特色是刻意的语言特征。\n- 山田太郎：第一人称 「オレ」 → 本项目写作「本大爷」";
  const scoreBlock = `${LOW_SCORE_PREFIX}\n本行刚被判为极低分（严重缺陷）……`;
  const lookupBlock = "【线上查证（作品维基）】 第 1/3 站：中文（灰机）\n站点入口：https://example.com/wiki/";
  const markers = ["【术语（对照表命中）】", "【说话习惯（本章）】", LOW_SCORE_PREFIX, "【线上查证（作品维基）】"];
  const counts = (text, needle) => text.split(needle).length - 1;

  const system = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    termBlock,
    speechHabitBlock: habitBlock,
    lowScoreBlock: scoreBlock,
    webLookupBlock: lookupBlock,
  });
  for (const needle of markers) {
    assert.equal(counts(system, needle), 1, `动态段只能出现一次：${needle}`);
  }
  const order = [...markers, "只返回一个 JSON 对象"]
    .map((needle) => system.indexOf(needle));
  assert.equal(order.every((index) => index >= 0), true, "动态段与固定尾巴都应在最终提示词里");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "顺序必须是 术语 → 说话习惯 → 低分归因 → 线上查证 → JSON 约定");

  // 自定义提示词里残留的旧动态段要被剥掉（用户可能直接沿用上一次的整段文本）。
  // 注意动态段的边界是“到下一个【或硬性约束为止”，所以用户追加的规则要写在段**之前**才不会被吞掉
  // （这条纪律在 term-prefilter.test.js 里已有专门断言，这里只验剥离后不出现两份）。
  const stale = `${system}\n${lookupBlock}\n${scoreBlock}`;
  const rebuilt = buildProofreadSystemPrompt({
    mode: "bilingual",
    profileId: "novel",
    customSystem: stale,
    termBlock,
    speechHabitBlock: habitBlock,
    lowScoreBlock: scoreBlock,
    webLookupBlock: lookupBlock,
  });
  for (const needle of markers) {
    assert.equal(counts(rebuilt, needle), 1, `残留的旧动态段没被剥干净：${needle}`);
  }
  // 没有命中任何动态段的行：所有段都不出现（不能留空段或标题）。
  const plain = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel" });
  for (const needle of [...markers.slice(0, 2), "【说话人判断（", markers[2], markers[3]]) {
    assert.equal(plain.includes(needle), false, `没有命中时不该出现动态段：${needle}`);
  }
});
