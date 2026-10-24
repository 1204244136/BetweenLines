const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decisionToResult,
  clientStatus,
  isStage3DisputeRow,
  isStage2Candidate,
} = require("../src/workbenches/translation-compare/ai/ai-proofread");

const {
  createPersonaContext,
  extractSpecializedRules,
  buildPersonaSystemPrompt,
  buildStylistMessages,
  buildArbiterMessages,
  parseStylistResponse,
  parseArbiterResponse,
} = require("../src/workbenches/translation-compare/ai/persona-runtime");

function extractPersonaUserPayload(content) {
  const heading = content.search(/请(?:审阅|裁决)第 \d+ 行/);
  const start = content.indexOf("：\n", heading) + 2;
  return JSON.parse(content.slice(start));
}

const {
  shouldTriggerArbitration,
  applyArbitrationDecision,
  formatArbitrationNoteLines,
} = require("../src/workbenches/translation-compare/ai/arbiter");

const {
  scheduleModels,
  getModelProfile,
} = require("../src/workbenches/translation-compare/ai/scheduler-profile");

test("阶段二队列判定：初审存疑行必须进入文学复审", () => {
  const note = [
    "[AI校对]",
    "语义是否相同：待确认",
    "是否需要修改：待人工确认",
    "Gatekeeper初审：存在疑点，需结合上下文判断",
  ].join("\n");
  assert.equal(isStage2Candidate(note), true);
  assert.equal(isStage2Candidate("[AI校对]\n是否需要修改：否\nGatekeeper初审：无需修改"), false);
});

test("多阶段流水线端到端：快速直通 Fast Pass 路径", () => {
  const row = { index: 10, jp: "おはようございます。", cn: "早上好。" };
  const gatekeeperDecision = {
    semanticSame: true,
    needsEdit: false,
    better: "target",
    summary: "译文准确自然，无事实硬伤",
    revisedText: "",
    fastPass: true,
  };

  const result = decisionToResult(row, gatekeeperDecision, "译文 B", "原文 A", "cn", "bilingual");
  assert.equal(result.done, true);
  assert.equal(result.fastPass, true);
  assert.equal(result.stageResult.stage, "gatekeeper");
  assert.equal(result.critique, null, "阶段一直接通过且未经历复审的行，critique 为 null，绝不误标记为复审驳回");
  assert.equal(result.arbitration, null);
});

test("多阶段流水线端到端：Stylist 复审评审与改案微调采纳", () => {
  const row = { index: 15, jp: "彼は静かに扉を開けた。", cn: "他把门给静悄悄地开了。" };
  const gatekeeperDecision = {
    semanticSame: true,
    needsEdit: true,
    better: "neither",
    summary: "语序有些奇怪，建议按原文修整",
    revisedText: "他静静地推开了门。",
    score: 80,
    penalty: 20,
    grade: "fair",
  };

  // Stylist reviews Gatekeeper proposal
  const stylistReviewRaw = {
    critique: {
      attitude: "modify",
      rationale: "原初审修改基本准确，但使用'推开'更符合原文动作韵律，微调字词。",
      acceptedChanges: ["修正僵硬的把字句"],
      rejectedChanges: [],
    },
    revisedText: "他轻轻地推开了门。",
    summary: "进一步文学修饰",
  };

  const decisionWithStylist = {
    ...gatekeeperDecision,
    stylistReview: stylistReviewRaw,
    revisedText: stylistReviewRaw.revisedText,
    stage: "stylist",
    stylistModelId: "claude-3-5-sonnet",
  };

  const result = decisionToResult(row, decisionWithStylist, "译文 B", "原文 A", "cn", "bilingual");
  assert.equal(result.done, false);
  assert.equal(result.stageResult.stage, "stylist");
  assert.equal(result.stageResult.modelId, "claude-3-5-sonnet");
  assert.equal(result.critique.attitude, "modify");
  assert.equal(result.arbitration, null);
  assert.ok(result.note.includes("Stylist复审[调整]"));
  assert.ok(result.note.includes("修改结果：他轻轻地推开了门。"));
});

test("多阶段流水线端到端：双角色立场分歧触发 Arbiter 仲裁裁决", () => {
  const row = { index: 20, jp: "それは紛れもない真実だった。", cn: "那是货真价实的真相。" };
  const gatekeeperDecision = {
    semanticSame: true,
    needsEdit: true,
    better: "neither",
    summary: "货真价实多形容商品，用在真理真相上属于词语搭配不当",
    revisedText: "那是毋庸置疑的真实。",
  };

  // Stylist rejects the Gatekeeper proposal, wanting to keep original translation style
  const stylistReview = {
    critique: {
      attitude: "reject",
      rationale: "口语化对话中'货真价实'增强了角色的市井语气，并非绝对硬伤，无需强改。",
      acceptedChanges: [],
      rejectedChanges: ["毋庸置疑过于书面化"],
    },
    revisedText: "",
    summary: "建议保留原译以尊重角色个性",
  };

  // Check arbitration trigger
  const check = shouldTriggerArbitration({
    gatekeeperDecision,
    stylistReview,
  });
  assert.equal(check.triggered, true);

  // Arbiter adjudicates between the two
  const arbiterResult = {
    winner: "stylist",
    reason: "本段为第一人称内心独白，带有通俗语调，Stylist 辩护成立，维持原译更为自然。",
    finalDecision: "keep",
    riskFlags: [],
  };

  const applied = applyArbitrationDecision({
    arbitration: arbiterResult,
    gatekeeperDecision,
    stylistReview,
    targetText: row.cn,
  });

  assert.equal(applied.winner, "stylist");
  assert.equal(applied.needsEdit, false);

  const decisionWithArbitration = {
    ...gatekeeperDecision,
    stylistReview,
    arbitration: applied.arbitration,
    needsEdit: applied.needsEdit,
    revisedText: applied.revisedText,
    stage: "arbiter",
    arbitrationModelId: "o3-mini",
  };

  const result = decisionToResult(row, decisionWithArbitration, "译文 B", "原文 A", "cn", "bilingual");
  assert.equal(result.done, true);
  assert.equal(result.stageResult.stage, "arbiter");
  assert.equal(result.arbitration.winner, "stylist");
  assert.ok(result.note.includes("Arbiter仲裁[复审方案]"));
});

test("多阶段流水线端到端：初审与复审各有长处，Arbiter 给出打破二选一的结合修改方案（synthesis）", () => {
  const row = {
    index: 43,
    jp: "彼の右腕には、二つの異なる術式が組み込まれていた。",
    cn: "他的右手被植入了两种不同的法术。",
  };

  // 1. 初审 Gatekeeper：纠正专有名词术语（术式而非普通法术），但改得略显僵硬
  const gatekeeperDecision = {
    needsEdit: true,
    better: "neither",
    semanticSame: false,
    score: 80,
    summary: "术语硬伤：'術式' 应统一规范为专用术语'术式'，而非普通'法术'。",
    revisedText: "他的右腕之中，装配着两套相异的术式。",
    stage1RevisedText: "他的右腕之中，装配着两套相异的术式。",
  };

  // 2. 复审 Stylist：润色行文流畅度，消除'被植入'的僵硬语感，但沿用了'法术'
  const stylistReview = {
    critique: {
      attitude: "modify",
      rationale: "原句带有生硬的被动与翻译腔；改为主谓流畅表达更具文学表现力，但初审的'装配'过于机械化。",
      acceptedChanges: ["消除生硬被动语态"],
      rejectedChanges: ["装配过于机械"],
    },
    revisedText: "在他右臂之中，交错潜藏着两种迥异的法术。",
    summary: "润色为更自然的中文动作描写",
  };

  // 3. 触发仲裁
  const check = shouldTriggerArbitration({
    gatekeeperDecision,
    stylistReview,
  });
  assert.equal(check.triggered, true);

  // 4. Arbiter 终审仲裁：认可初审的术语'术式'，同时采纳复审的文学意蕴与流畅动作描写，给出融合两者的结合方案
  const arbiterResult = {
    winner: "synthesis",
    reason: "初审纠正术语'术式'准确无误，必须保留；复审对动词与句式韵律的重构极佳。结合双方优点，融汇为最终定案。",
    finalDecision: "replace",
    riskFlags: [],
  };

  const combinedText = "在他右臂之中，交错潜藏着两种迥异的术式。";
  const applied = applyArbitrationDecision({
    arbitration: arbiterResult,
    gatekeeperDecision,
    stylistReview,
    targetText: row.cn,
    adjudicatedRevisedText: combinedText,
  });

  assert.equal(applied.winner, "synthesis");
  assert.equal(applied.needsEdit, true);
  assert.equal(applied.revisedText, combinedText);

  const decisionWithArbitration = {
    ...gatekeeperDecision,
    stylistReview,
    arbitration: applied.arbitration,
    needsEdit: applied.needsEdit,
    revisedText: applied.revisedText,
    stage3RevisedText: applied.revisedText,
    stage: "arbiter",
    arbitrationModelId: "deepseek-reasoner",
  };

  const result = decisionToResult(row, decisionWithArbitration, "译文 B", "原文 A", "cn", "bilingual");
  assert.equal(result.done, false); // needsEdit=true -> suggestion / 待确认修改
  assert.equal(result.stageResult.stage, "arbiter");
  assert.equal(result.arbitration.winner, "synthesis");
  assert.ok(result.note.includes("Arbiter仲裁[结合方案]：初审纠正术语'术式'准确无误"));
  assert.ok(result.note.includes(`仲裁改案：${combinedText}`));
  assert.ok(result.note.includes(`修改结果：${combinedText}`));
});

test("阶段三队列判定：isStage3DisputeRow 全面覆盖已仲裁行与各类分歧行", () => {
  const row = { index: 1, jp: "テスト原文", cn: "测试译文" };

  // 1. 已有仲裁方案的行（完全结束状态）：无论 noteText 还是 memoryResult 均必须被识别为阶段三候选行
  const noteArbitrated = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：建议修改",
    "初审改案：改案A",
    "Stylist复审[调整]：深化文学修辞",
    "复审改案：改案B",
    "Arbiter仲裁[初审方案]：初审术语准确",
    "仲裁改案：改案A",
    "修改结果：改案A",
  ].join("\n");
  assert.equal(isStage3DisputeRow(row, noteArbitrated, null), true, "包含 Arbiter仲裁 的行必须被识别为阶段三行");

  // 2. 复审为调整（modify）分歧行，但无「提交仲裁/分歧/escalate」字样
  const noteModifyDiverged = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：建议修改硬伤",
    "初审改案：改案A",
    "Stylist复审[调整]：深化文学修辞",
    "复审改案：改案B",
    "修改结果：改案B",
  ].join("\n");
  assert.equal(isStage3DisputeRow(row, noteModifyDiverged, null), true, "复审调整且存在改案差异必须被识别为分歧行");

  // 3. 复审为驳回（reject）分歧行，但无「提交仲裁/分歧/escalate」字样
  const noteRejectDiverged = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：建议修改",
    "初审改案：改案A",
    "Stylist复审[驳回]：原译顺畅无瑕疵",
    "修改结果：改案A",
  ].join("\n");
  assert.equal(isStage3DisputeRow(row, noteRejectDiverged, null), true, "初审提改且复审驳回必须被识别为分歧行");

  // 4. 复审为采纳（accept），两阶段一致，无需进入仲裁
  const noteAcceptAgreed = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：是",
    "Gatekeeper初审：建议修改",
    "初审改案：改案A",
    "Stylist复审[采纳]：赞同初审修改",
    "修改结果：改案A",
  ].join("\n");
  assert.equal(isStage3DisputeRow(row, noteAcceptAgreed, null), false, "复审采纳且无仲裁记录不应被识别为分歧行");

  // 5. 初审无需修改（快速直通），不进入仲裁
  const notePassed = [
    "[AI校对]",
    "语义是否相同：相同",
    "是否需要修改：否",
    "Gatekeeper初审：无需修改",
    "分析：原译准确。",
  ].join("\n");
  assert.equal(isStage3DisputeRow(row, notePassed, null), false, "初审直接通过的行不应被识别为分歧行");

  // 6. 内存 memoryResult 存在分歧标记
  assert.equal(isStage3DisputeRow(row, "", { critique: { attitude: "modify" } }), true, "内存 critique attitude 为 modify 时必须被识别为分歧");
  assert.equal(isStage3DisputeRow(row, "", { critique: { attitude: "reject" } }), true, "内存 critique attitude 为 reject 时必须被识别为分歧");
  assert.equal(isStage3DisputeRow(row, "", { arbitration: { winner: "gatekeeper" } }), true, "内存存在 arbitration 必须被识别为已仲裁行");
});

test("多阶段流水线：Stylist 与 Arbiter 完整接收术语表与特化规范注入", () => {
  const row = {
    index: 107,
    jp: "純粋とか徹底とか言えば聞こえは良いが、魔術の天才の表の肩書きはほぼ無職。",
    cn: "当然，说他纯粹也好，彻底也罢，但这魔法天才的公开身份却是近乎无业游民。",
  };

  const gatekeeperDecision = {
    needsEdit: true,
    better: "neither",
    semanticSame: true,
    summary: "原译增译了'当然'并漏掉'聞こえは良い'，且'魔術'应统一为专用术语'魔术'。",
    revisedText: "说他纯粹也好，彻底也罢，听起来固然不错，但这魔术天才表面上的头衔基本就是个无业游民。",
    stage1RevisedText: "说他纯粹也好，彻底也罢，听起来固然不错，但这魔术天才表面上的头衔基本就是个无业游民。",
  };

  const stylistReview = {
    attitude: "modify",
    rationale: "初审纠正术语'魔术'准确，但'头衔'用词偏生硬，进行了文学润色。",
    revisedText: "说他纯粹也好，彻底也罢，听起来固然不错，但这位魔术天才明面上的公开身份却近乎无业游民。",
  };

  const termGuidance = {
    targetLabel: "当前译文",
    count: 1,
    terms: [
      {
        source: "魔術",
        alias: "魔術",
        target: "魔术",
        type: "术语",
        note: "魔術 → 魔术（术语）",
      },
    ],
    block: "【译名对照表（本行命中）】\n- 魔術 → 魔术（术语）\n用法：译文里出现这些概念时，必须使用对照表给出的标准译名。",
  };

  const basePrompt = "【通用校对规则】\n核心校对规范A\n【成品校对规范：测试规范】\n— 小说文体要求\n注意人物语气与对话节奏。";
  const glossary = "术语表（全卷）：\n- アニー → 安妮";

  // 1. 验证 Stylist 消息构造
  const stylistMessages = buildStylistMessages(row, gatekeeperDecision, {
    targetLabel: "当前译文",
    basePrompt,
    termGuidance,
    glossary,
  });

  assert.equal(stylistMessages.length, 2);
  const stylistSystem = stylistMessages[0].content;
  assert.ok(stylistSystem.includes("【当前身份与任务契约：文学责编 (Stylist)】"));
  assert.ok(stylistSystem.includes("术语与规范红线"));
  assert.ok(stylistSystem.includes("【译名对照表（本行命中）】"));
  assert.ok(stylistSystem.includes("魔術 → 魔术（术语）"));
  assert.ok(stylistSystem.includes("术语表（全卷）"));
  assert.ok(stylistSystem.includes("注意人物语气与对话节奏"));

  const extractUserPayload = extractPersonaUserPayload;

  const stylistUserJson = extractUserPayload(stylistMessages[1].content);
  assert.ok(stylistUserJson.terms, "Stylist user payload 必须包含 terms 字段");
  assert.equal(stylistUserJson.terms.items[0].translation, "魔术");
  assert.equal(stylistUserJson.glossary, glossary);

  // 2. 验证 Arbiter 消息构造
  const arbiterMessages = buildArbiterMessages(row, gatekeeperDecision, stylistReview, {
    targetLabel: "当前译文",
    basePrompt,
    termGuidance,
    glossary,
  });

  assert.equal(arbiterMessages.length, 2);
  const arbiterSystem = arbiterMessages[0].content;
  assert.ok(arbiterSystem.includes("【当前身份与任务契约：终审法官 (Chief Arbiter)】"));
  assert.ok(arbiterSystem.includes("术语裁决权威"));
  assert.ok(arbiterSystem.includes("【译名对照表（本行命中）】"));
  assert.ok(arbiterSystem.includes("魔術 → 魔术（术语）"));
  assert.ok(arbiterSystem.includes("术语表（全卷）"));
  assert.ok(arbiterSystem.includes("注意人物语气与对话节奏"));

  const arbiterUserJson = extractUserPayload(arbiterMessages[1].content);
  assert.ok(arbiterUserJson.terms, "Arbiter user payload 必须包含 terms 字段，绝不能让仲裁法官在缺乏术语表的情况下盲猜");
  assert.equal(arbiterUserJson.terms.items[0].source, "魔術");
  assert.equal(arbiterUserJson.terms.items[0].translation, "魔术");
  assert.equal(arbiterUserJson.glossary, glossary);
  assert.ok(arbiterUserJson.task.includes("若提供了术语表/译名对照表，裁决必须严格遵循标准译名"));
});

test("多阶段流水线：无术语命中行优雅降级，不引入多余 terms 结构", () => {
  const row = { index: 1, jp: "普通の文章です。", cn: "这是普通的句子。" };
  const gatekeeperDecision = { needsEdit: false, revisedText: "" };
  const stylistReview = { attitude: "accept", rationale: "原译自然", revisedText: "" };

  const arbiterMessages = buildArbiterMessages(row, gatekeeperDecision, stylistReview, {
    targetLabel: "当前译文",
  });
  const arbiterUserJson = extractPersonaUserPayload(arbiterMessages[1].content);
  assert.equal(arbiterUserJson.terms, undefined, "无术语命中行不注入 terms 字段");
  assert.equal(arbiterUserJson.glossary, undefined);
});

test("多阶段流水线：提示词由长变短，职责逐步收敛（Gatekeeper > Stylist > Arbiter）", () => {
  const fullBasePrompt = [
    "【通用校对规则】",
    "你是严谨的翻译校对助手，辅助人工；按“原文边界→语义完整性→语言质量”内部判断，不输出推理，不把偏好当错误。",
    "证据优先级：原文人物、数字、否定、时态、因果动作 > 目标列完整准确 > 术语语体一致 > 局部措辞；无法证明的不猜。",
    "semanticSame = 目标列与原文（双语）或另一非原文列（三语）的核心语义是否相同；needsEdit = 目标列是否需改动。两者独立：语义通顺但生硬或有明显问题时可 semanticSame=true、needsEdit=true。",
    "只判档位、不自己算分：按缺陷档位（融合 MQM 风格分级与缺陷扣分口径）判 grade——poor=致命缺陷（颠倒核心事实/主谓宾/因果，反转性误译，专名灾难错译，关键语义大段脱落）；fair=严重缺陷（主干误漏译，关键否定/时态/语态/指代错误，口吻严重倒错）；good=轻微缺陷（轻度翻译腔、词句标点瑕疵、冗余）；excellent=无缺陷或仅修辞偏好。severity 映射：excellent→none、good→minor、fair→major、poor→critical。",
    "penalty 与 score 的关系是 score=100-penalty；能估整数就给，拿不准填 null 由程序按 grade 折算。needsEdit=false 时固定 score=100、penalty=0、grade=excellent、severity=none、revisedText 留空；needsContext=true 时 score/penalty 填 null 转人工，不自行扣分。",
    "A 常省略主语或人称代词。B 因照搬而成为无主句、成分残缺或指代不明时，可在 revisedText 中按中文习惯适当补上缺失的主语（代词或 A 与上下文已确立的称谓），只要其指代符合前文已确立的行为主体，属于合规翻译，不得误判为改变主体；仅当 B 臆造不合前文事实的主语、或确实改变行为主体/因果归属时才按误译处理。",
    "用 decision 表达结论：B 无需修改时 decision=keep；需要修改时 decision=replace 并给出可替换当前行的 revisedText；依据完全不足无法判断时用 decision=unclear（转人工确认），不用它表达“不确定要不要改”。",
    "只返回一个 JSON 对象，不要返回 Markdown、代码块、分析过程或额外解释。",
    "【成品校对规范：测试规范】",
    "— 排版与呈现层",
    "标点全角化：中文正文里的标点一律用全角字形，省略号用「……」。",
    "目标列内联标记必须原样原位保留，严禁日文假名泄露。",
    "— 作品专有信息与语言特征",
    "系列名写作「某魔法的禁书目录」。",
  ].join("\n");

  const row = { index: 120, jp: "この事実をもってすれば、アーサー=エドワード=ウェイトの言葉の真意が滲む。", cn: "正是因为如此，亚瑟·爱德华·伟特的那句「我喜欢你」背后的真意也随之显现。" };
  const gkDecision = { needsEdit: true, revisedText: "正是因为如此，伟特话语中的真意也随之显现。" };
  const styReview = { attitude: "modify", revisedText: "有了这一事实，伟特言语间的真意便浮现了出来。" };

  const gkPrompt = buildPersonaSystemPrompt("gatekeeper", fullBasePrompt);
  const styPrompt = buildPersonaSystemPrompt("stylist", fullBasePrompt);
  const arbPrompt = buildPersonaSystemPrompt("arbiter", fullBasePrompt);

  const gkRules = extractSpecializedRules(fullBasePrompt, "gatekeeper");
  const styRules = extractSpecializedRules(fullBasePrompt, "stylist");
  const arbRules = extractSpecializedRules(fullBasePrompt, "arbiter");

  // 1. 验证特化提取的基础规则长度严格单调递减（Gatekeeper > Stylist > Arbiter）
  assert.ok(gkRules.length > styRules.length, "Gatekeeper 基础规则长度必须长于 Stylist");
  assert.ok(styRules.length > arbRules.length, "Stylist 基础规则长度必须长于 Arbiter");

  // 2. 验证总系统提示词规模由长变短（Gatekeeper > Stylist > Arbiter）
  assert.ok(gkPrompt.length > styPrompt.length, "Gatekeeper 总提示词必须长于 Stylist");
  assert.ok(styPrompt.length > arbPrompt.length, "Stylist 总提示词必须长于 Arbiter");

  // 2. 验证 Gatekeeper 包含 MQM 打分体系
  assert.ok(gkPrompt.includes("只判档位、不自己算分"));
  assert.ok(gkPrompt.includes("score=100-penalty"));

  // 3. 验证 Stylist 剥离了初审打分体系，但保留了排版规范与文学审阅
  assert.ok(!styPrompt.includes("只判档位、不自己算分"));
  assert.ok(!styPrompt.includes("score=100-penalty"));
  assert.ok(styPrompt.includes("标点全角化"));
  assert.ok(styPrompt.includes("文学责编"));

  // 4. 验证 Arbiter 极致精简：彻底剥离通用校对流程与打分冲突指令，仅保留核心审判原则与排版硬红线
  assert.ok(!arbPrompt.includes("【通用校对规则】"));
  assert.ok(!arbPrompt.includes("只判档位、不自己算分"));
  assert.ok(!arbPrompt.includes("用 decision 表达结论"));
  assert.ok(arbPrompt.includes("【当前身份与任务契约：终审法官 (Chief Arbiter)】"));
  assert.ok(arbPrompt.includes("忠实度第一"));
  assert.ok(arbPrompt.includes("核心结合方案"));
  assert.ok(arbPrompt.includes("标点全角化"));
  assert.ok(arbPrompt.includes("系列名写作「某魔法的禁书目录」"));
});

test("多阶段流水线：上下文由短变长（Stylist 前后各 1 行，Arbiter 前后各 2 行提供完整因果证据）", () => {
  const row = { index: 120, jp: "この事実をもってすれば、アーサー=エドワード=ウェイトの言葉の真意が滲む。", cn: "正是因为如此，亚瑟·爱德华·伟特的那句「我喜欢你」背后的真意也随之显现。" };
  const gkDecision = { needsEdit: true, revisedText: "修改文本" };
  const styReview = { attitude: "modify", revisedText: "润色文本" };

  const mockContext = {
    before: [
      { index: 118, sourceText: "前第2行原文", targetText: "前第2行译文" },
      { index: 119, sourceText: "前第1行原文", targetText: "前第1行译文" },
    ],
    after: [
      { index: 121, sourceText: "后第1行原文", targetText: "后第1行译文" },
      { index: 122, sourceText: "后第2行原文", targetText: "后第2行译文" },
    ],
  };

  const arbiterMessages = buildArbiterMessages(row, gkDecision, styReview, {
    targetLabel: "当前译文",
    context: mockContext,
  });

  const payload = extractPersonaUserPayload(arbiterMessages[1].content);

  assert.ok(payload.context, "Arbiter payload 必须接收 context 语境");
  assert.equal(payload.context.before.length, 2, "Arbiter 拥有更长的前置语境（2行）");
  assert.equal(payload.context.after.length, 2, "Arbiter 拥有更长的后置语境（2行）");
  assert.ok(payload.context.note.includes("前后文语境依据"));
});
