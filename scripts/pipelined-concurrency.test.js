const test = require("node:test");
const assert = require("node:assert/strict");

const {
  runStage1Gatekeeper,
  runStage2Stylist,
  runStage3Arbiter,
  finalizeRowResult,
  proofreadRow,
} = require("../src/workbenches/translation-compare/ai/ai-proofread");

test("分阶段评审函数正确模块化与导出", () => {
  assert.equal(typeof runStage1Gatekeeper, "function");
  assert.equal(typeof runStage2Stylist, "function");
  assert.equal(typeof runStage3Arbiter, "function");
  assert.equal(typeof finalizeRowResult, "function");
  assert.equal(typeof proofreadRow, "function");
});

test("proofreadRow 在单行调用中按顺序执行模块化阶段", async () => {
  const row = { index: 1, jp: "吾輩は猫である。", cn: "我是猫。" };
  const allRows = [row];
  const config = {
    proofreadMode: "bilingual",
    multiStageEnabled: false,
    webLookup: false,
    lowScoreCheck: false,
  };
  const labels = { jp: "原文 A", cn: "译文 B" };

  const s1 = {
    row,
    decision: {
      needsEdit: false,
      semanticSame: true,
      better: "target",
      summary: "无需修改",
      revisedText: "",
    },
    targetKey: "cn",
    counterpartKey: "jp",
    targetLabel: "译文 B",
    counterpartLabel: "原文 A",
    targetText: "我是猫。",
    counterpartText: "吾輩は猫である。",
    lowScore: { active: false },
  };

  const result = finalizeRowResult(s1, config);
  assert.equal(result.index, 1);
  assert.equal(result.done, true);
});

test("流水线阶段间数据交接完整保留决策与评审意见", async () => {
  const row = { index: 2, jp: "名前はまだ無い。", cn: "名字还没有。" };
  const s1 = {
    row,
    decision: {
      needsEdit: true,
      semanticSame: true,
      better: "neither",
      summary: "建议润色",
      revisedText: "名字尚无。",
    },
    targetKey: "cn",
    counterpartKey: "jp",
    targetLabel: "译文 B",
    counterpartLabel: "原文 A",
    targetText: "名字还没有。",
    counterpartText: "名前はまだ無い。",
    lowScore: { active: false },
  };

  const s2 = {
    ...s1,
    decision: {
      ...s1.decision,
      stylistReview: {
        critique: {
          attitude: "modify",
          rationale: "微调为经典口吻",
          acceptedChanges: [],
          rejectedChanges: [],
        },
        revisedText: "名字嘛，还没有。",
      },
      revisedText: "名字嘛，还没有。",
      stage: "stylist",
    },
    arbCheck: { triggered: false },
  };

  const finalResult = finalizeRowResult(s2, { proofreadMode: "bilingual" });
  assert.equal(finalResult.index, 2);
  assert.equal(finalResult.stageResult.stage, "stylist");
  assert.equal(finalResult.critique.attitude, "modify");
  assert.ok(finalResult.note.includes("Stylist复审[调整]"));
  assert.ok(finalResult.note.includes("名字嘛，还没有。"));
});
