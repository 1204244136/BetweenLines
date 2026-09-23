const assert = require("node:assert/strict");
const test = require("node:test");

const { JSON_ONLY_INSTRUCTION } = require("../src/ai/prompt-contract");

const {
  buildMessages,
  decisionToResult,
  parseDecision,
  proofreadPromptFor,
} = require("./ai-proofread");

function payload() {
  return {
    row: { index: 1, jp: "原文", cn: "译文", tw: "另一译文" },
    targetLabel: "B 译文",
    targetText: "译文",
    counterpartLabel: "A 原文",
    counterpartText: "原文",
    diffHelper: "不生成跨语言词级差异",
    context: [],
    contextMode: "none",
  };
}

test("双语 AI 提示词将 A 视为原文且 B 为唯一可编辑的目标列", () => {
  const messages = buildMessages(payload(), { proofreadMode: "bilingual", systemPrompt: "base" });
  const user = JSON.parse(messages[1].content);
  assert.match(messages[0].content, /A 是原文.*B 是唯一译文与唯一修改列/);
  assert.match(messages[0].content, /A 不是可复制进 B 的候选译文/);
  assert.equal(user.comparisonMode, "bilingual");
  assert.match(user.modePolicy, /只能修改 B/);
  assert.equal(user.row.targetLabel, "B 译文");
  // 双语模式原文只以 source 出现一次，不再复制成 counterpartLabel/counterpartText。
  assert.equal(user.row.source, "原文");
  assert.equal(Object.hasOwn(user.row, "counterpartLabel"), false);
  assert.equal(Object.hasOwn(user.row, "counterpartText"), false);
});

test("三语 AI 提示词保持 B 与 C 同级且仅编辑选中的目标列", () => {
  const messages = buildMessages(payload(), { proofreadMode: "trilingual", systemPrompt: "base" });
  const user = JSON.parse(messages[1].content);
  assert.match(messages[0].content, /B、C 是同级非原文/);
  assert.match(messages[0].content, /只修改用户选择的目标列/);
  assert.equal(user.comparisonMode, "trilingual");
  assert.equal(user.row.counterpartLabel, "A 原文");
  assert.equal(user.row.counterpartText, "原文");
});

test("双语与三语工作台使用不同的默认提示词", () => {
  const bilingual = proofreadPromptFor("bilingual").system;
  const trilingual = proofreadPromptFor("trilingual").system;
  assert.notEqual(bilingual, trilingual);
  assert.match(bilingual, /B 是唯一译文与唯一修改列/);
  assert.match(bilingual, /不要假设存在另一份译文/);
  // 日文常省略主语，中文需要按习惯补出：该要求在双语契约里必须始终存在。
  assert.match(bilingual, /按中文习惯适当补上缺失的主语/);
  assert.match(bilingual, /只要其指代符合前文已确立的行为主体/);
  assert.match(bilingual, /EPUB 注释标记/);
  assert.match(trilingual, /B、C 是同级非原文材料/);
  assert.match(trilingual, /better=counterpart/);
  assert.match(trilingual, /MQM 风格分级/);
  // 片段行（如原文 “しかし、”、译文 “可是。”）只允许按片段判断，不得据断句判缺陷。
  assert.match(bilingual, /不完整片段/);
  assert.match(bilingual, /不得补全成完整句或改写上下句/);
  // summary 措辞与解析器的意图正则耦合，契约必须固定用词口径。
  assert.match(bilingual, /needsEdit=false 时以“无需修改”起头/);
  assert.match(bilingual, /needsEdit=true 时写明“需要修改”/);
  assert.equal(proofreadPromptFor("bilingual").outputSchema.severity.includes("critical"), true);
  assert.equal(proofreadPromptFor("bilingual").outputSchema.revisedText, "string");
  assert.match(proofreadPromptFor("bilingual").system, /EPUB noteref 注释标记必须在 revisedText 中逐字、原位保留/);
  // 双语契约不再问“谁更好”，只问“保持还是替换”：schema 里不能出现 counterpart 语义。
  const bilingualSchema = proofreadPromptFor("bilingual").outputSchema;
  assert.equal(Object.hasOwn(bilingualSchema, "decision"), true);
  assert.equal(Object.hasOwn(bilingualSchema, "better"), false);
  assert.match(bilingualSchema.decision, /keep \| replace \| unclear/);
  assert.doesNotMatch(JSON.stringify(bilingualSchema), /counterpart/);
  assert.match(proofreadPromptFor("trilingual").outputSchema.better, /counterpart/);
  assert.equal(Object.hasOwn(proofreadPromptFor("trilingual").outputSchema, "decision"), false);
  // 分数改为“能给就给、拿不准交给程序按 grade 折算”，模型不再做扣分算术。
  assert.match(bilingualSchema.score, /null/);
  assert.doesNotMatch(bilingual, /单项扣 30~50 分/);
  assert.match(bilingual, /只判档位、不自己算分/);
});

test("双语模式决策使用 keep/replace 结论并兼容旧版 better 取值", () => {
  const keep = parseDecision(JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    decision: "keep",
    grade: "excellent",
    summary: "无需修改，译文与原文一致。",
    revisedText: "",
  }), { proofreadMode: "bilingual" });
  assert.equal(keep.better, "target");
  assert.equal(keep.needsEdit, false);
  assert.equal(keep.score, 100);

  const replace = parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    decision: "replace",
    grade: "fair",
    summary: "关键否定误译，需要修改。",
    revisedText: "他没去。",
  }), { proofreadMode: "bilingual" });
  assert.equal(replace.better, "neither");
  assert.equal(replace.needsEdit, true);
  // 只给 grade，分数由程序折算，模型不必算分。
  assert.equal(replace.score, 70);
  assert.equal(replace.penalty, 30);
  assert.equal(replace.severity, "major");

  // 双语没有另一份译文：模型若答 counterpart，按“仍需修改”处理，不产生“参考对照列”备注。
  const counterpart = parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "counterpart",
    grade: "good",
    summary: "需要修改。",
    revisedText: "他没去。",
  }), { proofreadMode: "bilingual" });
  assert.equal(counterpart.better, "neither");

  // 提示词要求“拿不准就填 null”：null 不能被当成 0 分，必须回落到 grade 折算。
  const nullScores = parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    decision: "replace",
    score: null,
    penalty: null,
    grade: "poor",
    summary: "核心事实颠倒，需要修改。",
    revisedText: "他去了。",
  }), { proofreadMode: "bilingual" });
  assert.equal(nullScores.score, 55);
  assert.equal(nullScores.penalty, 45);
  assert.equal(nullScores.grade, "poor");
  assert.equal(nullScores.severity, "critical");

  // 旧页面/旧自定义提示词仍输出 better=target/neither：解析必须保持兼容。
  const legacy = parseDecision(JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    grade: "excellent",
    summary: "无需修改。",
    revisedText: "",
  }), { proofreadMode: "bilingual" });
  assert.equal(legacy.better, "target");
  assert.equal(legacy.needsEdit, false);

  // 三语模式不受影响：counterpart 仍是有效结论。
  const trilingual = parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "counterpart",
    grade: "good",
    summary: "需要修改。",
    revisedText: "另一版本。",
  }), { proofreadMode: "trilingual" });
  assert.equal(trilingual.better, "counterpart");
});

test("双语结果状态绝不声称目标列优于对照列", () => {
  const keepDifferent = parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: false,
    needsContext: false,
    decision: "keep",
    grade: "excellent",
    summary: "无需修改，译文按中文习惯意译。",
    revisedText: "",
  }), { proofreadMode: "bilingual" });

  const bilingualResult = decisionToResult({ index: 1 }, keepDifferent, "主文本（待修改文本）", "原文 A", "cn", "bilingual");
  assert.equal(bilingualResult.status, "target-ok");
  assert.equal(bilingualResult.done, true);

  const trilingualResult = decisionToResult({ index: 1 }, keepDifferent, "非原文 B", "非原文 C", "cn", "trilingual");
  assert.equal(trilingualResult.status, "target-better");
});

test("系统提示词携带单一 JSON 契约与模式块，键名留由 user.outputSchema 定义", () => {
  const countOf = (text, pattern) => (text.match(pattern) || []).length;
  const defaultPrompt = proofreadPromptFor("bilingual").system;
  // 旧版本页面里嵌的默认提示词尾部重复过两份 JSON 约定，重新校对时也必须收敛成一份。
  const staleDuplicateTail = [
    proofreadPromptFor("bilingual").body,
    JSON_ONLY_INSTRUCTION,
    "必须使用以下英文键名且不得省略：semanticSame, needsEdit。",
    "硬性格式约束：目标列中的 EPUB noteref 注释标记必须在 revisedText 中逐字、原位保留。",
    JSON_ONLY_INSTRUCTION,
    "必须使用以下英文键名且不得省略：semanticSame, needsEdit。",
  ].join("\n");

  const cases = {
    默认提示词: defaultPrompt,
    空自定义: "",
    文本框里改过字: defaultPrompt.replace("你是严谨的翻译校对助手", "你是严谨的翻译校对助手（本机定制）"),
    短自定义: "只做保守校对。",
    旧版重复尾巴: staleDuplicateTail,
  };
  for (const [label, systemPrompt] of Object.entries(cases)) {
    const content = buildMessages(payload(), { proofreadMode: "bilingual", systemPrompt })[0].content;
    assert.equal(countOf(content, /只返回一个 JSON 对象/g), 1, `${label} 的 JSON 输出约定重复`);
    assert.equal(countOf(content, /必须使用以下英文键名/g), 0, `${label} 不应在 system 里重复键名清单`);
    assert.equal(countOf(content, /当前是双语校对/g), 1, `${label} 的模式规则重复`);
    assert.equal(countOf(content, /硬性格式约束/g), 1, `${label} 的硬性格式约束重复`);
    assert.doesNotMatch(content, /当前是三语校对/, `${label} 混入了他模式规则`);
  }
});

test("用户载荷携带相邻行但不包含程序端上下文配额", () => {
  const messages = buildMessages({
    ...payload(),
    context: [{ index: 2, relative: 1, position: "后 1 行", source: "原文2", target: "译文2" }],
    contextMode: "requested",
  }, { proofreadMode: "bilingual" });
  const user = JSON.parse(messages[1].content);

  assert.equal(Object.hasOwn(user, "contextBudget"), false);
  assert.equal(Object.hasOwn(user, "contextExpansion"), false);
  assert.equal(user.nearbyRows.length, 1);
  assert.match(user.contextPolicy, /相邻行只作判断依据/);
});

test("自定义 AI 提示词依然强制注入 noteref 保留硬性约束", () => {
  const messages = buildMessages(payload(), { proofreadMode: "bilingual", systemPrompt: "custom" });

  assert.match(messages[0].content, /硬性格式约束/);
  assert.match(messages[0].content, /noteref 注释标记必须.*逐字、原位保留/);
});

test("AI 决策仅在确定需要修改时归一化 MQM 风格严重程度", () => {
  assert.equal(parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    severity: "critical",
    summary: "关键数值误译，需要修改。",
    revisedText: "修订文本",
  })).severity, "critical");

  assert.equal(parseDecision(JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    severity: "major",
    summary: "无需修改。",
    revisedText: "",
  })).severity, "none");

  assert.equal(parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    summary: "存在明确误译，需要修改。",
    revisedText: "修订文本",
  })).severity, "major");

  assert.equal(parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    severity: "none",
    summary: "存在明确误译，需要修改。",
    revisedText: "修订文本",
  })).severity, "major");
});

test("AI 结果备注仅在确定需要修改时包含严重程度信息", () => {
  const edited = parseDecision(JSON.stringify({
    semanticSame: false,
    needsEdit: true,
    needsContext: false,
    better: "neither",
    severity: "critical",
    summary: "关键数值误译，需要修改。",
    revisedText: "修订文本",
  }));
  const unchanged = parseDecision(JSON.stringify({
    semanticSame: true,
    needsEdit: false,
    needsContext: false,
    better: "target",
    severity: "critical",
    summary: "无需修改。",
    revisedText: "",
  }));

  const editedResult = decisionToResult({ index: 1 }, edited, "译文", "对照译文", "tw");
  assert.equal(editedResult.targetKey, "tw");
  assert.match(editedResult.note, /严重程度：致命/);
  assert.doesNotMatch(decisionToResult({ index: 2 }, unchanged, "译文", "对照译文", "cn").note, /严重程度：/);
});
