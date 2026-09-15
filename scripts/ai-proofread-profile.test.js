const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

// 本机作品档案通过环境变量或 profiles/local/ 载入，仓库内不留作品信息：
// 这里在 require 之前准备一个临时档案，同时验证“仓库外档案可加载、坏档案被跳过”。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "betweenlines-profiles-"));
const novelPath = path.join(__dirname, "..", "src", "workbenches", "translation-compare", "ai", "profiles", "novel.js");
const testProfileFile = path.join(tempDir, "test-profile.js");
const brokenProfileFile = path.join(tempDir, "broken-profile.js");

fs.writeFileSync(testProfileFile, [
  `const novel = require(${JSON.stringify(novelPath)});`,
  "module.exports = {",
  "  ...novel,",
  '  id: "test-profile",',
  '  name: "作品专有档案（测试）",',
  '  summary: "在通用小说成品规范之上追加测试档案专有约定。",',
  `  termTables: [${JSON.stringify(path.join(tempDir, "profile-terms.csv"))}],`,
  "  sections: [",
  "    ...novel.sections,",
  "    {",
  '      title: "测试档案专有约定",',
  '      lines: ["本作品译名以本机译名表为准，遇到专有词不要自由发挥。", "<角色甲>的固定语尾属于刻意语言特征，不得改写为通顺中文。"],',
  "    },",
  "  ],",
  "};",
].join("\n"), "utf8");
fs.writeFileSync(brokenProfileFile, "throw new Error('这个档案故意写坏了');\n", "utf8");
fs.writeFileSync(path.join(tempDir, "profile-terms.csv"), "Base_Ori,Base_Trans,Type\n【試作】,【试作】,术语\n", "utf8");

process.env.TRANSCOMPARATOR_PROFILE_FILES = `${testProfileFile};${brokenProfileFile}`;

const {
  buildProofreadSystemPrompt,
  genericHeader,
  listProfiles,
  profileEntities,
  proofreadPromptFor,
  resolveProfile,
} = require("../src/workbenches/translation-compare/ai/proofread-contract");
const { buildMessages, clientStatus } = require("./ai-proofread");
const { makeHtml } = require("./build-compare");
const { evaluateTermRow, loadTermTables } = require("../src/workbenches/translation-compare/ai/term-table");
const { TERM_BLOCK_PREFIX, termGuidanceFor } = require("../src/workbenches/translation-compare/ai/term-prefilter");
const { loadSpeechTables } = require("../src/workbenches/translation-compare/ai/speech-habit");

const testProfileName = "作品专有档案（测试）";
const testProfileMarker = `【成品校对规范：${testProfileName}】`;

test.after(() => {
  delete process.env.TRANSCOMPARATOR_PROFILE_FILES;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function payload(overrides = {}) {
  return {
    row: { index: 838, jp: "しかし、", cn: "可是。", tw: "" },
    targetLabel: "主文本（待修改文本）",
    targetText: "可是。",
    counterpartLabel: "原文 A",
    counterpartText: "しかし、",
    diffHelper: "双语模式不生成跨语言词级差异；请依据原文 A 与译文 B 的语义对应判断。",
    context: [],
    contextMode: "none",
    ...overrides,
  };
}

function countOf(text, pattern) {
  return (text.match(pattern) || []).length;
}

test("通用侧与特化侧各自独立，合并注入时顺序固定", () => {
  const contract = proofreadPromptFor("bilingual", "test-profile");

  assert.ok(contract.genericSystem.startsWith(genericHeader));
  // 通用侧不认识作品规范：成品、注音、傍点、译名表这些只属于特化档案。
  for (const term of ["成品校对规范", "傍点", "译名表", "直角引号", "B 由译者稿件"]) {
    assert.doesNotMatch(contract.genericSystem, new RegExp(term), `通用侧不应出现特化内容：${term}`);
  }
  // 特化侧不重复通用侧的任务契约与输出约定。
  for (const term of ["只判档位、不自己算分", "只返回一个 JSON 对象"]) {
    assert.doesNotMatch(contract.profileSystem, new RegExp(term), `特化侧不应重复通用内容：${term}`);
  }

  const order = [
    genericHeader,
    "当前是双语校对",
    testProfileMarker,
    "硬性格式约束：",
    "只返回一个 JSON 对象",
  ].map((needle) => contract.system.indexOf(needle));
  assert.equal(order.every((index) => index >= 0), true, "合并后的提示词缺少某个分区");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "分区顺序必须是通用侧 → 模式 → 特化侧 → 约束 → 输出约定");
});

test("特化档案可替换、可继承，未知档案回落到默认，坏档案被跳过", () => {
  const novel = proofreadPromptFor("bilingual", "novel");
  const work = proofreadPromptFor("bilingual", "test-profile");

  assert.equal(novel.profileId, "novel");
  assert.equal(work.profileId, "test-profile");
  // 仓库内自带通用档案与示范档案；额外档案由环境变量或 profiles/local/ 追加。
  const ids = listProfiles().map((profile) => profile.id);
  assert.equal(ids[0], "novel");
  assert.equal(ids.includes("demo"), true);
  assert.equal(ids.includes("test-profile"), true);
  assert.equal(new Set(ids).size, ids.length);

  // work 在 novel 之上追加专有约定，而不是重写一份。
  const novelProfile = resolveProfile("novel");
  for (const section of novelProfile.sections) {
    assert.match(work.profileSystem, new RegExp(section.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(work.profileSystem, /测试档案专有约定/);
  assert.equal(resolveProfile("不存在的档案").id, "novel");
  assert.equal(resolveProfile("").id, "novel");

  const user = JSON.parse(buildMessages(payload(), {
    proofreadMode: "bilingual",
    profileId: "不存在的档案",
  })[1].content);
  assert.deepEqual(user.profile, { id: "novel", name: "小说成品（简中 EPUB）" });

  // 特化侧的第二类内容：档案可以声明辅助判断数据（译名对照表），状态接口如实报告。
  assert.deepEqual(resolveProfile("test-profile").termTables, [path.join(tempDir, "profile-terms.csv")]);
  const status = clientStatus({ includeResults: false, profileId: "test-profile" }).termTableStatus;
  assert.equal(status.files.length, 1);
  assert.equal(status.entries, 1);
  assert.deepEqual(status.errors, []);
  assert.deepEqual(clientStatus({ includeResults: false, profileId: "novel" }).termTableStatus.files, []);
});

test("规范要点确实进入了特化侧提示词", () => {
  const novel = proofreadPromptFor("bilingual", "novel").profileSystem;

  // 原文/稿件/成品关系与容忍边界
  assert.match(novel, /A 是日文原文（分页源整理后的对齐工作源），B 是发布成品/);
  assert.match(novel, /打碎语序、拆分长句、改变描述方式/);
  // 日式句法（谓语先行倒装、句末吊挂代词、主语与敬体字面直译）在中文成品里是缺陷，
  // 反过来「与原文语序不同」不是：同一条口径写在特化侧（A 是日文原文、B 是中文成品
  // 这个工作阶段），并同样约束模型自己写出的 revisedText，不放进模式层。
  assert.match(novel, /谓语先行的倒装与句末追补主语/);
  assert.match(novel, /不得保留或引入日式倒装与句末吊挂的代词/);
  // 规范里的具体条款
  assert.match(novel, /省略号被写成连续句号或连续英文句点/);
  assert.match(novel, /「！？」按规范统一写成「？！」/);
  // 标点全角化既约束判断也约束改写（真实回归：模型在 revisedText 里打出「......」）：
  // 半角只在 ASCII 数字/英文/URL/代码里合法，从 B 保留的不合规写法要在 revisedText 里一并改掉。
  assert.match(novel, /中文正文里的标点一律用全角字形/);
  assert.match(novel, /半角标点只允许出现在 ASCII 数字、英文缩写、URL 与代码里/);
  assert.match(novel, /这一条同时约束你自己写出的 revisedText/);
  assert.match(novel, /你的 revisedText 同样必须用「……」/);
  // 英文句子反过来必须用半角：否则“标点全角化”这条要求会把整段英文写坏（确定性规范化层同理）。
  assert.match(novel, /整段英文句子反过来必须用半角/);
  // 成对标记（引号/括号）内侧句末点号的位置按目标列（中文）规范判断，不以原文标点为判据；
  // 注音条例只能评价 B 里实际出现的注音（两条都是真实假阳性的回归断言：第 898 行引号、第 1087 行括号）。
  assert.match(novel, /内侧的句末点号按 B 的中文规范定位置/);
  assert.match(novel, /句末点号与句内点号之间的取舍/);
  assert.match(novel, /判断只能针对 B 里实际出现的注音/);
  assert.match(novel, /原文右侧傍点/);
  assert.match(novel, /该注音的术语没有注音/);
  assert.match(novel, /|基文\[注文\]/);
  assert.match(novel, /连接词独立成段/);
  assert.match(novel, /破折号或逗号衔接/);
  assert.match(novel, /小数用阿拉伯数字/);
  assert.match(novel, /译名表/);
  // 证据边界的枚举必须包含引号与标点：只列注音/傍点/分页时，「A 看不到某标记不得判 B 多出该写法」
  // 这条原则覆盖不到引号，模型就会在 summary 里自造「译文误加引号」（真实假阳性第 1683 行）。
  assert.match(novel, /注音、傍点、分页、引号与标点等信息可能缺失/);
  // 引号有无不是缺陷判据，且点号规范只对「完整引述/整行括注」生效——两条都在 quote 条目里。
  assert.match(novel, /A 无引号不得判 B「误加引号」/);
  assert.match(novel, /标记内只是半句话、一个词、短语或拟声（被提及而不成句）/);
  assert.match(novel, /不出现儿化音/);
  // 作品专有信息：通用档案只描述形态，具体作品名留在本机档案里
  assert.match(novel, /角色口癖、固定语尾与人物专属书写方式以译名表\/口癖表为准/);
  assert.match(novel, /咒语、咏唱与仪式台词允许为了美感和中文语感调整句式/);
});

test("仓库自带的示范档案展示作品专有档案的写法", () => {
  const demo = resolveProfile("demo");
  const novel = resolveProfile("novel");
  const ids = listProfiles().map((profile) => profile.id);
  assert.equal(ids[0], "novel");
  assert.equal(ids.includes("demo"), true);

  // 示范档案继承通用规范，只追加作品专有事实；两者都是内置档案。
  // 注意 `demo` 是稳定的档案槽位：本机若在 profiles/local/ 里用 extends 叠加它，
  // 名字会变成本机名（见 ai-profile-overlay.test.js），所以这里只断言与叠加无关的事实。
  assert.equal(demo.id, "demo");
  for (const section of novel.sections) {
    assert.equal(demo.sections.some((item) => item.title === section.title), true, `示范档案缺少通用小节：${section.title}`);
  }
  const ownSections = demo.sections.filter((section) => !novel.sections.some((item) => item.title === section.title));
  assert.equal(ownSections.length, 1);
  assert.equal(ownSections[0].title, "本作品专有事实");

  const demoPrompt = proofreadPromptFor("bilingual", "demo").profileSystem;
  assert.match(demoPrompt, /本作品专有事实/);
  // 通用规范里已经写过的规则不在示范档案里重复。
  assert.equal(countOf(demoPrompt, /以译名表\/口癖表为准/g), 1);
  // 作品相关的具体内容只集中在示范档案里，通用档案不出现。
  assert.doesNotMatch(proofreadPromptFor("bilingual", "novel").profileSystem, /某魔法的禁书目录/);
  assert.match(demoPrompt, /某魔法的禁书目录/);
  // 示范档案不再为单个角色开 `characters` 例外：角色规则走说话习惯表（表就内化在该档案自己身上），
  // 实体闸门只留给「离开那个名字就无从谈起的专有规则」，由探针档案覆盖（proofread-prompt-layers.test.js）。
  assert.deepEqual(profileEntities(demo), []);
  const demoTable = loadSpeechTables(demo.speechTables);
  assert.deepEqual(demoTable.errors, []);
  assert.equal(demoTable.entries.length > 0, true, "示范档案的说话习惯表内化在档案文件里");
});

test("自定义提示词与特化档案合并时不会出现两套规范或两份输出约定", () => {
  const workDefault = proofreadPromptFor("bilingual", "test-profile").system;
  const novelDefault = proofreadPromptFor("bilingual", "novel").system;
  const cases = {
    空自定义: "",
    当前档案默认: workDefault,
    默认提示词里改过字: workDefault.replace("你是严谨的翻译校对助手", "你是严谨的翻译校对助手（本机定制）"),
    短自定义: "只做保守校对。",
    页面里残留的旧档案: novelDefault,
    用户在档案块后追加的规则: `${novelDefault}\n补充：本项目术语以译名表为准，遇到专有词不要自由发挥。`,
  };

  for (const [label, systemPrompt] of Object.entries(cases)) {
    const content = buildMessages(payload(), {
      proofreadMode: "bilingual",
      profileId: "test-profile",
      systemPrompt,
    })[0].content;
    assert.equal(countOf(content, /只返回一个 JSON 对象/g), 1, `${label} 的 JSON 输出约定重复`);
    assert.equal(countOf(content, /必须使用以下英文键名/g), 0, `${label} 不应在 system 里重复键名清单`);
    assert.equal(countOf(content, /硬性格式约束/g), 1, `${label} 的硬性格式约束重复`);
    assert.equal(countOf(content, /【成品校对规范：/g), 1, `${label} 的档案块重复或残留`);
    assert.equal(content.includes(testProfileMarker), true, `${label} 没有注入当前选中的档案`);
    assert.doesNotMatch(content, /【成品校对规范：小说成品/, `${label} 残留了旧档案块`);
  }

  // 用户在档案块之后写的规则必须保留。
  const kept = buildMessages(payload(), {
    proofreadMode: "bilingual",
    profileId: "test-profile",
    systemPrompt: cases.用户在档案块后追加的规则,
  })[0].content;
  assert.match(kept, /补充：本项目术语以译名表为准，遇到专有词不要自由发挥。/);
});

test("AI 面板按注册表渲染特化规范下拉，并按档案嵌入默认提示词", () => {
  const rows = [{
    index: 1,
    chapter: "正文",
    relation: "原文-译文 1:1",
    score: 0.8,
    jpAlignScore: 0.8,
    jp: "しかし、",
    cn: "可是。",
    tw: "",
    twCn: "",
    jpChars: 4,
    cnChars: 3,
    twChars: 0,
    refinedScore: null,
  }];
  const selection = {
    comparisonMode: "bilingual",
    files: { jp: "A.txt", cn: "B.txt", tw: "" },
    labels: { jp: "A 原文", cn: "B 译文", tw: "C 版本" },
  };
  const projectContext = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    projectKey: "project",
    rowsSignature: "rows",
    notesStorage: { key: "notes" },
  };

  const html = makeHtml(rows, selection, projectContext);
  assert.match(html, /<label for="aiProfile">特化规范<\/label>/);
  // 面板上能看到对照表状态，一眼确认表有没有生效。
  assert.match(html, /id="aiTermTableHint"/);
  assert.match(html, /特化规范里声明的译名对照表/);
  assert.match(html, /<option value="novel" selected>小说成品（简中 EPUB）<\/option>/);
  assert.match(html, new RegExp(`<option value="test-profile">${testProfileName}</option>`));

  const pageMeta = JSON.parse(html.match(/const pageMeta = (\{[\s\S]*?\});\n/)[1]);
  const profileIds = pageMeta.profiles.map((profile) => profile.id);
  assert.equal(profileIds[0], "novel");
  assert.equal(profileIds.includes("test-profile"), true);
  for (const profile of pageMeta.profiles) {
    assert.match(profile.prompt, new RegExp(`【成品校对规范：${profile.name}】`));
  }
  const novelEntry = pageMeta.profiles.find((profile) => profile.id === "novel");
  const workEntry = pageMeta.profiles.find((profile) => profile.id === "test-profile");
  assert.notEqual(novelEntry.prompt, workEntry.prompt);
  assert.match(workEntry.prompt, /测试档案专有约定/);
  assert.equal(pageMeta.proofreadPrompt.profileId, "novel");
});

test("对照表命中的术语作为提示词注入，且不会与自定义提示词里的残留段落重复", () => {
  const tables = loadTermTables([path.join(tempDir, "profile-terms.csv")]);
  // 整行不止术语：一致也只作提示，不能跳过模型，因此这里必须由提示词把术语告诉模型。
  const source = "【試作】の機体を動かす。";
  const evaluation = evaluateTermRow({ source, target: "启动试作的机体。", tables });
  assert.equal(evaluation.kind, "consistent");
  const guidance = termGuidanceFor({ index: 838, jp: source }, { evaluation, targetKey: "cn", targetLabel: "主文本（待修改文本）" });
  assert.match(guidance.block, new RegExp(`^${TERM_BLOCK_PREFIX}`));
  assert.match(guidance.block, /- 試作 → 试作（术语）/);

  const config = { proofreadMode: "bilingual", profileId: "test-profile", systemPrompt: "" };
  const system = buildMessages(payload({ termGuidance: guidance }), config)[0].content;
  assert.equal(countOf(system, new RegExp(TERM_BLOCK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")), 1);
  assert.match(system, /- 試作 → 试作（术语）/);
  // 用户自定义提示词里若残留上一行的术语段：先剥掉再注入本次的，只能剩一段。
  // 注意边界：动态段（术语段/说话习惯段/档案块）都按“到下一个【小节或硬性约束”结尾，
  // 因此追加规则要写在段之前，写在段之后会被当成该段的一部分剥掉——与档案块同一条既有规则。
  const stale = `${proofreadPromptFor("bilingual", "test-profile").system}\n补充：术语段之前的规则要保留。\n${guidance.block}`;
  const rebuilt = buildMessages(payload({ termGuidance: guidance }), { ...config, systemPrompt: stale })[0].content;
  assert.equal(countOf(rebuilt, new RegExp(TERM_BLOCK_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")), 1);
  assert.match(rebuilt, /补充：术语段之前的规则要保留。/);
  // 未命中术语的行不注入段落。
  const empty = buildMessages(payload(), config)[0].content;
  assert.equal(empty.includes(TERM_BLOCK_PREFIX), false);
});

test("buildProofreadSystemPrompt 直接调用时同样合并两侧并保留硬性约束", () => {
  const system = buildProofreadSystemPrompt({ mode: "trilingual", profileId: "novel", glossary: "术语表：某术语=某译名。" });
  assert.match(system, new RegExp(genericHeader));
  assert.match(system, /当前是三语校对/);
  assert.match(system, /【成品校对规范：小说成品（简中 EPUB）】/);
  assert.match(system, /术语表：某术语=某译名。/);
  assert.equal(countOf(system, /只返回一个 JSON 对象/g), 1);
});
