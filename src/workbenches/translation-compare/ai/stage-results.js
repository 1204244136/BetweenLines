/**
 * Shared, backwards-compatible result contracts for the staged review pipeline.
 * This module is deliberately free of transport or UI concerns so every future
 * stage can use the same shape without introducing a second execution loop.
 */

const CRITIQUE_ATTITUDES = new Set(["accept", "modify", "reject", "escalate"]);

const REVIEW_STAGES = new Set(["gatekeeper", "stylist", "arbiter"]);

function normalizeArbitrationResult(value = {}) {
  const riskFlags = Array.isArray(value.riskFlags) ? value.riskFlags.map(String) : [];
  return {
    winner: String(value.winner || ""),
    reason: String(value.reason || ""),
    riskFlags,
    finalDecision: String(value.finalDecision || ""),
  };
}

function normalizeReviewStageResult(value = {}) {
  const stage = REVIEW_STAGES.has(value.stage) ? value.stage : "gatekeeper";
  const confidence = Number(value.confidence);
  return {
    stage,
    modelId: String(value.modelId || ""),
    persona: String(value.persona || stage),
    needsEdit: value.needsEdit === true,
    needsContext: value.needsContext === true,
    decision: String(value.decision || ""),
    summary: String(value.summary || ""),
    revisedText: String(value.revisedText || ""),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
  };
}

function reviewStageResultFromLegacy(result = {}, modelId = "") {
  return normalizeReviewStageResult({
    stage: "gatekeeper",
    modelId,
    needsEdit: result.done !== true,
    needsContext: result.done !== true,
    decision: result.done ? "prefilter" : "escalate",
    summary: result.note,
  });
}

function normalizeCritiqueResult(value = {}) {
  const attitude = CRITIQUE_ATTITUDES.has(value.attitude) ? value.attitude : "escalate";
  return {
    attitude,
    rationale: String(value.rationale || ""),
    acceptedChanges: Array.isArray(value.acceptedChanges) ? value.acceptedChanges.map(String) : [],
    rejectedChanges: Array.isArray(value.rejectedChanges) ? value.rejectedChanges.map(String) : [],
  };
}

function createStageMetrics(value = {}) {
  const stage1Passed = Math.max(0, Number(value.stage1Passed) || 0);
  const stage1NeedsEdit = Math.max(0, Number(value.stage1NeedsEdit) || 0);
  const stage1Total = Math.max(stage1Passed + stage1NeedsEdit, Number(value.stage1Total) || 0);
  const stage2Reviewed = Math.max(0, Number(value.stage2Reviewed) || 0);
  const stage3Arbitrated = Math.max(0, Number(value.stage3Arbitrated) || 0);
  const stage2Diverged = Math.max(0, Number(value.stage2Diverged) || stage3Arbitrated);
  const stage2Pending = Math.max(0, Number(value.stage2Pending) || (stage1NeedsEdit - stage2Reviewed));
  const stage3Pending = Math.max(0, Number(value.stage3Pending) || (stage2Diverged - stage3Arbitrated));
  const arbitrationGatekeeper = Math.max(0, Number(value.arbitrationGatekeeper) || 0);
  const arbitrationStylist = Math.max(0, Number(value.arbitrationStylist) || 0);
  const arbitrationSynthesis = Math.max(0, Number(value.arbitrationSynthesis) || 0);
  const arbitrationOriginal = Math.max(0, Number(value.arbitrationOriginal) || 0);
  const stage3Settled = Math.max(stage3Arbitrated, Number(value.stage3Settled) || (arbitrationGatekeeper + arbitrationStylist + arbitrationSynthesis + arbitrationOriginal));
  const finalNeedsEdit = Math.max(0, Number(value.finalNeedsEdit) || 0);
  const finalUnchanged = Math.max(0, Number(value.finalUnchanged) || 0);
  const finalNeedsCheck = Math.max(0, Number(value.finalNeedsCheck) || 0);
  const totalAudited = Math.max(stage1Total, finalNeedsEdit + finalUnchanged + finalNeedsCheck, Number(value.totalAudited) || 0);

  return {
    stage1Passed,
    stage1NeedsEdit,
    stage1Total,
    stage1Errors: Math.max(0, Number(value.stage1Errors) || 0),
    stage2Reviewed,
    stage2Diverged,
    stage2Pending,
    stage2Errors: Math.max(0, Number(value.stage2Errors) || 0),
    stage3Arbitrated,
    stage3Settled,
    stage3Pending,
    stage3Errors: Math.max(0, Number(value.stage3Errors) || 0),
    fastPassHits: Math.max(0, Number(value.fastPassHits) || 0),
    webLookupHits: Math.max(0, Number(value.webLookupHits) || 0),
    lowScoreHits: Math.max(0, Number(value.lowScoreHits) || 0),
    critiqueAccept: Math.max(0, Number(value.critiqueAccept) || 0),
    critiqueReject: Math.max(0, Number(value.critiqueReject) || 0),
    critiqueModify: Math.max(0, Number(value.critiqueModify) || 0),
    critiqueEscalate: Math.max(0, Number(value.critiqueEscalate) || 0),
    arbitrationGatekeeper,
    arbitrationStylist,
    arbitrationSynthesis,
    arbitrationOriginal,
    finalNeedsEdit,
    finalUnchanged,
    finalNeedsCheck,
    totalAudited,
  };
}

function createStagePipelines(value = {}) {
  const normalizeStageState = (stage = {}) => ({
    inFlight: Math.max(0, Number(stage.inFlight) || 0),
    pending: Math.max(0, Number(stage.pending) || 0),
    activeRows: Array.isArray(stage.activeRows) ? stage.activeRows.map(Number).filter(Number.isFinite) : [],
  });
  return {
    stage1: normalizeStageState(value.stage1),
    stage2: normalizeStageState(value.stage2),
    stage3: normalizeStageState(value.stage3),
  };
}

function incrementStageMetric(metrics, key, amount = 1) {
  if (!metrics || !Object.prototype.hasOwnProperty.call(metrics, key)) return metrics;
  metrics[key] = Math.max(0, metrics[key] + (Number(amount) || 0));
  return metrics;
}

// Fast Pass is intentionally strict: only a model decision that needs no edit,
// no context expansion, and no unresolved conclusion may close the AI path.
function isFastPassDecision(decision = {}) {
  return decision.needsEdit === false
    && decision.needsContext !== true
    && decision.better !== "unclear"
    && decision.decision !== "unclear"
    && decision.fastPass !== false;
}

module.exports = {
  CRITIQUE_ATTITUDES,
  REVIEW_STAGES,
  normalizeArbitrationResult,
  normalizeReviewStageResult,
  reviewStageResultFromLegacy,
  normalizeCritiqueResult,
  createStageMetrics,
  createStagePipelines,
  incrementStageMetric,
  isFastPassDecision,
};
