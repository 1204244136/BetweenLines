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
  const stage1Unclear = Math.max(0, Number(value.stage1Unclear) || 0);
  const stage1Total = Math.max(stage1Passed + stage1NeedsEdit + stage1Unclear, Number(value.stage1Total) || 0);
  const stage2Reviewed = Math.max(0, Number(value.stage2Reviewed) || 0);
  const stage3Arbitrated = Math.max(0, Number(value.stage3Arbitrated) || 0);
  const stage2Diverged = Math.max(0, Number(value.stage2Diverged) || stage3Arbitrated);
  const stage2Pending = Math.max(0, Number(value.stage2Pending) || (stage1NeedsEdit + stage1Unclear - stage2Reviewed));
  const stage3Pending = Math.max(0, Number(value.stage3Pending) || (stage2Diverged - stage3Arbitrated));
  const arbitrationGatekeeper = Math.max(0, Number(value.arbitrationGatekeeper) || 0);
  const arbitrationStylist = Math.max(0, Number(value.arbitrationStylist) || 0);
  const arbitrationSynthesis = Math.max(0, Number(value.arbitrationSynthesis) || 0);
  const arbitrationOriginal = Math.max(0, Number(value.arbitrationOriginal) || 0);
  const stage3Settled = Math.max(stage3Arbitrated, Number(value.stage3Settled) || (arbitrationGatekeeper + arbitrationStylist + arbitrationSynthesis + arbitrationOriginal));
  const finalNeedsEdit = Math.max(0, Number(value.finalNeedsEdit) || 0);
  const finalUnchanged = Math.max(0, Number(value.finalUnchanged) || 0);
  const finalNeedsCheck = Math.max(0, Number(value.finalNeedsCheck) || 0);
  const finalPendingArbiter = Math.max(0, Number(value.finalPendingArbiter) || 0);
  const totalAudited = Math.max(stage1Total, finalNeedsEdit + finalUnchanged + finalNeedsCheck + finalPendingArbiter, Number(value.totalAudited) || 0);

  return {
    stage1Passed,
    stage1NeedsEdit,
    stage1Unclear,
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
    finalPendingArbiter,
    totalAudited,
  };
}

function normalizeAttitudes(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  for (const attitude of CRITIQUE_ATTITUDES) {
    result[attitude] = Math.max(0, Number(source[attitude]) || 0);
  }
  return result;
}

function createStagePipelines(value = {}) {
  const normalizeStageState = (stage = {}) => ({
    inFlight: Math.max(0, Number(stage.inFlight) || 0),
    pending: Math.max(0, Number(stage.pending) || 0),
    // 复审完成的实时计数：复审完但触发仲裁的行要等仲裁结束才 finalize，
    // stageMetrics 到那一刻才 +1，阶段二卡片会长时间停在很小的数字上，
    // 看起来就像「阶段二没干活、阶段三抢跑」。这份计数只服务运行中的实时显示。
    reviewed: Math.max(0, Number(stage.reviewed) || 0),
    attitudes: normalizeAttitudes(stage.attitudes),
    concurrency: stage.concurrency != null ? Math.max(1, Number(stage.concurrency) || 1) : null,
    // 并发上限（面板上的「并发上限」）；concurrency 是调度器当前实际放行的并发。
    concurrencyMax: stage.concurrencyMax != null ? Math.max(1, Number(stage.concurrencyMax) || 1) : null,
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

// 仲裁胜方归类：服务端与前端（public/workbench-client.js 内的同名逻辑）必须保持同一优先级。
// 「结合」类必须先于「初审/复审」判断，否则「融合初审与复审优点」会被误记为初审胜。
function classifyArbitrationWinner(winner = "") {
  const text = String(winner || "").trim().toLowerCase();
  if (!text) return "other";
  if (/结合|综合|折中|融合|synthesis|combined|compromise/.test(text)) return "synthesis";
  if (/维持|原译|original|target/.test(text)) return "original";
  if (/初审|gatekeeper|\bgk\b/.test(text)) return "gatekeeper";
  if (/复审|stylist/.test(text)) return "stylist";
  return "other";
}

const ARBITRATION_WINNER_METRIC = {
  gatekeeper: "arbitrationGatekeeper",
  stylist: "arbitrationStylist",
  synthesis: "arbitrationSynthesis",
  original: "arbitrationOriginal",
};

// 「待终审」是流水线还没走到终审的中间态：既不是终审分发的「待人工确认」，也不是终局结论。
function isPendingArbiterResult(result = {}) {
  return String(result.note || "").includes("是否需要修改：待终审");
}

function isExplicitNeedsCheckResult(result = {}) {
  // 必须先排除「待终审」：下面两条按 stageResult 的判据会把没经过终审的存疑行也算成待确认，
  // 那正是「待人工确认只能由终审分发」要挡住的情况。
  if (isPendingArbiterResult(result)) return false;
  return String(result.note || "").includes("是否需要修改：待人工确认")
    || result.stageResult?.decision === "unclear"
    || result.stageResult?.needsContext === true;
}

/**
 * 单行结果对各阶段指标的「贡献」，是纯函数。
 * addResult 把这份贡献记下并累加；行被重写/重跑时按记下的同一份贡献整体撤销，
 * 这样添加与撤销天然对称，不再需要两套手写的判据。
 * 不含 stage1Total / totalAudited 之外的派生量，派生量由 recomputeDerivedMetrics 统一算。
 */
function computeResultMetricsDelta(result = {}, { prefilterKind = "" } = {}) {
  const delta = {};
  const add = (key, amount = 1) => { delta[key] = (delta[key] || 0) + amount; };
  const noteText = String(result.note || "");
  const needsCheck = isExplicitNeedsCheckResult(result);
  const needsEdit = (noteText.includes("是否需要修改：是")
    || Boolean(result.stageResult?.needsEdit && result.stageResult?.revisedText)) && !needsCheck;
  const stage = result.stage || result.stageResult?.stage;
  const arbitrated = Boolean(result.arbitration || result.stageResult?.stage === "arbiter");
  const attitude = result.critique?.attitude;

  add("totalAudited");

  if (prefilterKind) {
    if (result.done) {
      add("fastPassHits");
    }
  } else {
    if (result.fastPass === true) add("fastPassHits");
    if (result.stageSignals?.lowScore) add("lowScoreHits");
    if (result.stageSignals?.webLookup) add("webLookupHits");

    // 只有真正经历过 Stage 2 复审的行才计入复审指标；阶段一直接通过的行绝不能记成复审驳回。
    const hasStage2Review = Boolean(
      result.stylistReview
      || result.stageResult?.stage === "stylist"
      || result.stageResult?.stage === "arbiter"
      || (attitude && !result.fastPass && result.stageResult?.stage !== "gatekeeper")
    );
    if (hasStage2Review && attitude) {
      add("stage2Reviewed");
      if (attitude === "accept") add("critiqueAccept");
      if (attitude === "reject") add("critiqueReject");
      if (attitude === "modify") add("critiqueModify");
      if (attitude === "escalate") add("critiqueEscalate");
    } else if (result.status === "suggestion" && result.stageResult?.stage === "stylist") {
      add("stage2Reviewed");
    }
    // 复审分歧：复审态度为调整/驳回/升级，或该行已被仲裁（仲裁过的行必然是分歧行）。
    // 一行最多贡献 1，且不再依赖非加性的 max 兜底，撤销时才能精确还原。
    const diverged = (hasStage2Review && (attitude === "modify" || attitude === "reject" || attitude === "escalate"))
      || arbitrated;
    if (diverged) add("stage2Diverged");

    if (arbitrated) {
      add("stage3Arbitrated");
      add("stage3Settled");
      const bucket = ARBITRATION_WINNER_METRIC[
        classifyArbitrationWinner(result.arbitration?.winner || result.stageResult?.winner)
      ];
      if (bucket) add(bucket);
    }
  }

  if (result.status === "error") {
    if (stage === "arbiter" || stage === "stage3") add("stage3Errors");
    else if (stage === "stylist" || stage === "stage2") add("stage2Errors");
    else add("stage1Errors");
  }

  // 最终结论
  if (result.done === true) add("finalUnchanged");
  else if (needsCheck) add("finalNeedsCheck");
  else if (isPendingArbiterResult(result)) add("finalPendingArbiter");
  else if (result.status === "suggestion" && needsEdit) add("finalNeedsEdit");
  else if (result.status !== "error") add("finalNeedsCheck");

  // 阶段一归类：一行只进「通过 / 提改 / 存疑」其中一个桶，通过 + 提改 + 存疑 = 总检。
  // 进入过复审或仲裁的行，其初审必然是提改（done 但被复审驳回也是如此），不能再记成通过。
  const s1NeedsEdit = Boolean(
    needsEdit
    || (result.stageResult?.needsEdit && !needsCheck)
    || result.stylistReview
    || arbitrated
  );
  if (s1NeedsEdit) add("stage1NeedsEdit");
  else if (needsCheck) add("stage1Unclear");
  else if (result.done) add("stage1Passed");

  return delta;
}

function applyMetricsDelta(metrics, delta = {}, sign = 1) {
  for (const [key, amount] of Object.entries(delta)) {
    metrics[key] = Math.max(0, (Number(metrics[key]) || 0) + sign * amount);
  }
  recomputeDerivedMetrics(metrics);
  return metrics;
}

function recomputeDerivedMetrics(metrics) {
  metrics.stage1Total = (metrics.stage1Passed || 0) + (metrics.stage1NeedsEdit || 0) + (metrics.stage1Unclear || 0);
  metrics.stage2Pending = Math.max(0, (metrics.stage1NeedsEdit || 0) + (metrics.stage1Unclear || 0) - (metrics.stage2Reviewed || 0));
  metrics.stage3Pending = Math.max(0, (metrics.stage2Diverged || 0) - (metrics.stage3Arbitrated || 0));
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
  normalizeAttitudes,
  incrementStageMetric,
  isFastPassDecision,
  classifyArbitrationWinner,
  computeResultMetricsDelta,
  applyMetricsDelta,
  recomputeDerivedMetrics,
};
