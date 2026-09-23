const test = require("node:test");
const assert = require("node:assert/strict");

const {
  decisionToResult,
  clientStatus,
} = require("../src/workbenches/translation-compare/ai/ai-proofread");

const {
  createPersonaContext,
  buildStylistMessages,
  buildArbiterMessages,
  parseStylistResponse,
  parseArbiterResponse,
} = require("../src/workbenches/translation-compare/ai/persona-runtime");

const {
  shouldTriggerArbitration,
  applyArbitrationDecision,
  formatArbitrationNoteLines,
} = require("../src/workbenches/translation-compare/ai/arbiter");

const {
  scheduleModels,
  getModelProfile,
} = require("../src/workbenches/translation-compare/ai/scheduler-profile");

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
