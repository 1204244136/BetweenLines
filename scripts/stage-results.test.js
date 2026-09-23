const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCritiqueResult, normalizeReviewStageResult, normalizeArbitrationResult, reviewStageResultFromLegacy, createStageMetrics, incrementStageMetric, isFastPassDecision } = require("../src/workbenches/translation-compare/ai/stage-results");

test("评审结果被规范化为稳定契约结构", () => {
  assert.deepEqual(normalizeCritiqueResult({ attitude: "modify", rationale: 12, acceptedChanges: ["a", 2] }), {
    attitude: "modify", rationale: "12", acceptedChanges: ["a", "2"], rejectedChanges: [],
  });
  assert.equal(normalizeCritiqueResult({ attitude: "unknown" }).attitude, "escalate");
});

test("阶段指标累加正确并拒绝非法计数项", () => {
  const metrics = createStageMetrics({ fastPassHits: 2, stage1Passed: -4 });
  incrementStageMetric(metrics, "fastPassHits");
  incrementStageMetric(metrics, "stage1Passed", 3);
  incrementStageMetric(metrics, "missing");
  assert.equal(metrics.fastPassHits, 3);
  assert.equal(metrics.stage1Passed, 3);
  assert.equal(metrics.missing, undefined);
});

test("快速直通要求确定无需修改且不需上下文的明确结论", () => {
  assert.equal(isFastPassDecision({ needsEdit: false }), true);
  assert.equal(isFastPassDecision({ needsEdit: false, needsContext: true }), false);
  assert.equal(isFastPassDecision({ needsEdit: false, better: "unclear" }), false);
  assert.equal(isFastPassDecision({ needsEdit: true }), false);
});

test("评审阶段结果约束并归一化其稳定字段", () => {
  assert.deepEqual(normalizeReviewStageResult({ stage: "stylist", modelId: 7, confidence: 2, needsEdit: 1 }), {
    stage: "stylist", modelId: "7", persona: "stylist", needsEdit: false, needsContext: false,
    decision: "", summary: "", revisedText: "", confidence: 1,
  });
});

test("仲裁结果保持与表现层解耦的稳定契约", () => {
  assert.deepEqual(normalizeArbitrationResult({ winner: 2, reason: null, riskFlags: ["logic", 3], finalDecision: "replace" }), {
    winner: "2", reason: "", riskFlags: ["logic", "3"], finalDecision: "replace",
  });
});

test("旧版结果转换补充 Gatekeeper 阶段且不修改原对象", () => {
  const legacy = { done: true, note: "same" };
  assert.deepEqual(reviewStageResultFromLegacy(legacy, "model-a"), {
    stage: "gatekeeper", modelId: "model-a", persona: "gatekeeper", needsEdit: false,
    needsContext: false, decision: "prefilter", summary: "same", revisedText: "", confidence: null,
  });
  assert.deepEqual(legacy, { done: true, note: "same" });
});
