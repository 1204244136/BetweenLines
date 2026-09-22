const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCritiqueResult, normalizeReviewStageResult, normalizeArbitrationResult, reviewStageResultFromLegacy, createStageMetrics, incrementStageMetric, isFastPassDecision } = require("../src/workbenches/translation-compare/ai/stage-results");

test("critique result is normalized to the stable contract", () => {
  assert.deepEqual(normalizeCritiqueResult({ attitude: "modify", rationale: 12, acceptedChanges: ["a", 2] }), {
    attitude: "modify", rationale: "12", acceptedChanges: ["a", "2"], rejectedChanges: [],
  });
  assert.equal(normalizeCritiqueResult({ attitude: "unknown" }).attitude, "escalate");
});

test("stage metrics are additive and reject invalid counters", () => {
  const metrics = createStageMetrics({ fastPassHits: 2, stage1Passed: -4 });
  incrementStageMetric(metrics, "fastPassHits");
  incrementStageMetric(metrics, "stage1Passed", 3);
  incrementStageMetric(metrics, "missing");
  assert.equal(metrics.fastPassHits, 3);
  assert.equal(metrics.stage1Passed, 3);
  assert.equal(metrics.missing, undefined);
});

test("fast pass requires a settled no-edit decision", () => {
  assert.equal(isFastPassDecision({ needsEdit: false }), true);
  assert.equal(isFastPassDecision({ needsEdit: false, needsContext: true }), false);
  assert.equal(isFastPassDecision({ needsEdit: false, better: "unclear" }), false);
  assert.equal(isFastPassDecision({ needsEdit: true }), false);
});

test("review stage result clamps and normalizes its stable fields", () => {
  assert.deepEqual(normalizeReviewStageResult({ stage: "stylist", modelId: 7, confidence: 2, needsEdit: 1 }), {
    stage: "stylist", modelId: "7", persona: "stylist", needsEdit: false, needsContext: false,
    decision: "", summary: "", revisedText: "", confidence: 1,
  });
});

test("arbitration result keeps a stable, presentation-free contract", () => {
  assert.deepEqual(normalizeArbitrationResult({ winner: 2, reason: null, riskFlags: ["logic", 3], finalDecision: "replace" }), {
    winner: "2", reason: "", riskFlags: ["logic", "3"], finalDecision: "replace",
  });
});

test("legacy result conversion supplies a gatekeeper stage without mutating the result", () => {
  const legacy = { done: true, note: "same" };
  assert.deepEqual(reviewStageResultFromLegacy(legacy, "model-a"), {
    stage: "gatekeeper", modelId: "model-a", persona: "gatekeeper", needsEdit: false,
    needsContext: false, decision: "prefilter", summary: "same", revisedText: "", confidence: null,
  });
  assert.deepEqual(legacy, { done: true, note: "same" });
});
