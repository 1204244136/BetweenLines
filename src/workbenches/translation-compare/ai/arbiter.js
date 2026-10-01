/**
 * Arbiter: Stage 3 Chief Arbiter adjudication and trigger resolution.
 *
 * Implements Stage 3 of the staged review pipeline.
 * Activated strictly when disagreements arise between Gatekeeper (Stage 1)
 * and Stylist (Stage 2), or upon unresolved risk flags.
 *
 * Output adheres to ArbitrationResult:
 * - winner: "gatekeeper" | "stylist" | "synthesis" | "original" | "neither"
 * - reason: string
 * - riskFlags: string[]
 * - finalDecision: "replace" | "keep" | "unclear"
 * - revisedText: string
 */

const { normalizeArbitrationResult } = require("./stage-results");
const { inspectStylistDrift } = require("./pipeline-butler");

/**
 * Evaluates whether Stage 3 Arbitration must be triggered for a row.
 *
 * Trigger conditions:
 * 1. Explicit escalation by Stylist (attitude === 'escalate')
 * 2. Fundamental stance divergence: Gatekeeper says needsEdit=true, but Stylist rejects (attitude === 'reject')
 * 3. Substantial revision divergence & Butler Anti-Drift Circuit Breaker:
 *    Stylist proposed edits, examined by Butler through multi-dimensional objective drift metrics
 *    (length drift, character overlap, term preservation, and correction regression).
 * 4. High-risk signals: unresolved term conflicts or explicit risk flags
 */
function shouldTriggerArbitration({
  gatekeeperDecision = {},
  stylistReview = {},
  signals = {},
}) {
  const attitude = stylistReview.critique?.attitude || stylistReview.attitude;

  // 1. Explicit escalation
  if (attitude === "escalate") {
    return {
      triggered: true,
      reason: "Stylist 显式请求终审仲裁（escalate）。",
    };
  }

  // 2. Fundamental stance divergence
  const gkNeedsEdit = gatekeeperDecision.needsEdit === true;
  if (gkNeedsEdit && attitude === "reject") {
    return {
      triggered: true,
      reason: "初审 Gatekeeper 提出修改，但复审 Stylist 认为应当保留原译（reject）。",
    };
  }

  // 3. Substantial revision divergence & Butler Anti-Drift Circuit Breaker
  const gkText = String(gatekeeperDecision.revisedText || "").trim();
  const styText = String(stylistReview.revisedText || "").trim();
  if (gkNeedsEdit && gkText && styText && gkText !== styText) {
    const butlerInspection = inspectStylistDrift({
      gkText,
      styText,
      targetText: gatekeeperDecision.targetText || signals.targetText || "",
      gatekeeperDecision,
      stylistReview,
      signals,
    });

    if (butlerInspection.circuitBroken) {
      return {
        triggered: true,
        reason: butlerInspection.reason || "Gatekeeper 与 Stylist 提出了不同的修订方案。",
        butlerMetrics: butlerInspection.metrics,
      };
    }
  }

  // 4. High-risk signals requiring arbitration
  if (signals.termConflict && (!gkText || attitude !== "accept")) {
    return {
      triggered: true,
      reason: "检测到术语冲突且两阶段未达成一致。",
    };
  }

  if (Array.isArray(signals.riskFlags) && signals.riskFlags.length > 0) {
    return {
      triggered: true,
      reason: `存在高风险标记：${signals.riskFlags.join(", ")}。`,
    };
  }

  // 5. 初审存疑、复审又没能解除它 → 必须升级终审。
  // 复审「采纳初审改案 / 给出自己的改案 / 驳回」都算解除存疑；只表态采纳、手里却没有任何
  // 可用改案的行不算解除——那种行既没有定案依据，也不该由复审直接甩给人工：
  // 「待人工确认」是终审的判决，得先让终审看过这一行。
  const isGkUnclear = Boolean(
    gatekeeperDecision.needsContext === true ||
    gatekeeperDecision.better === "unclear" ||
    gatekeeperDecision.decision === "unclear"
  );
  const stylistResolvedUnclear = Boolean(
    (attitude === "accept" && gkText) ||
    (attitude === "modify" && styText) ||
    attitude === "reject"
  );
  if (isGkUnclear && !stylistResolvedUnclear) {
    return {
      triggered: true,
      reason: "事实初审存疑，复审未能给出可用结论，升级至终审仲裁。",
    };
  }

  return {
    triggered: false,
    reason: "",
  };
}

/**
 * Attempts to resolve arbitration deterministically when both agree or no conflict exists.
 */
function resolveDeterministicAgreement({
  gatekeeperDecision = {},
  stylistReview = {},
  targetText = "",
}) {
  const attitude = stylistReview.critique?.attitude || stylistReview.attitude;
  const gkText = String(gatekeeperDecision.revisedText || "").trim();
  const styText = String(stylistReview.revisedText || "").trim();

  // If stylist accepted completely and revisions match (or stylist deferred to gatekeeper)
  if (attitude === "accept" && (gkText === styText || !styText)) {
    return {
      resolved: true,
      result: normalizeArbitrationResult({
        winner: "gatekeeper",
        reason: "Stylist 完全采纳 Gatekeeper 初审方案。",
        finalDecision: gkText ? "replace" : "keep",
      }),
      revisedText: gkText,
    };
  }

  // If Gatekeeper had no edit and Stylist concurred
  if (!gatekeeperDecision.needsEdit && (attitude === "reject" || !attitude)) {
    return {
      resolved: true,
      result: normalizeArbitrationResult({
        winner: "original",
        reason: "两阶段均认可原译准确通顺，无需修改。",
        finalDecision: "keep",
      }),
      revisedText: targetText,
    };
  }

  return {
    resolved: false,
    result: null,
    revisedText: "",
  };
}

/**
 * Apply the adjudicated arbitration decision to produce the final revision and status.
 */
function applyArbitrationDecision({
  arbitration = {},
  gatekeeperDecision = {},
  stylistReview = {},
  targetText = "",
  adjudicatedRevisedText = "",
}) {
  const normArb = normalizeArbitrationResult(arbitration);
  const winner = normArb.winner;
  const isOriginal = winner === "original" || winner === "target";
  const isSynthesis = winner === "synthesis" || winner === "combined" || winner === "compromise" || winner === "结合方案" || winner === "综合方案";
  const isUnclear = normArb.finalDecision === "unclear" || winner === "unclear";
  const finalDecision = isUnclear ? "unclear" : (normArb.finalDecision || (isOriginal ? "keep" : "replace"));

  let finalRevisedText = adjudicatedRevisedText;
  if (!finalRevisedText && !isUnclear) {
    if (winner === "stylist") {
      finalRevisedText = stylistReview.revisedText || gatekeeperDecision.revisedText || "";
    } else if (winner === "gatekeeper") {
      finalRevisedText = gatekeeperDecision.revisedText || "";
    } else if (isOriginal) {
      finalRevisedText = "";
    } else if (isSynthesis) {
      // 结合方案在未提供独立定案文本时的安全回退
      finalRevisedText = stylistReview.revisedText || gatekeeperDecision.revisedText || "";
    } else {
      finalRevisedText = stylistReview.revisedText || gatekeeperDecision.revisedText || "";
    }
  }

  const needsEdit = finalDecision === "replace" && Boolean(finalRevisedText);

  return {
    arbitration: normArb,
    finalDecision,
    winner,
    needsEdit,
    isUnclear,
    revisedText: finalRevisedText,
  };
}

/**
 * Format structured note lines containing multi-stage trace for inspection.
 */
function formatArbitrationNoteLines({
  gatekeeperDecision = {},
  stylistReview = {},
  arbitration = {},
}) {
  const lines = [];

  const gkSummary = gatekeeperDecision.stage1Summary || gatekeeperDecision.summary || "";
  if (gkSummary) {
    lines.push(`Gatekeeper初审：${gkSummary}`);
  }
  const gkText = String(gatekeeperDecision.stage1RevisedText || gatekeeperDecision.revisedText || "").trim();
  const isGkDeleteIntent = Boolean(
    gkSummary &&
    /(?:删除|删去|删掉|去除|去掉|增译|无中生有|多余|不应有)/.test(gkSummary) &&
    (gkSummary.includes(`「${gkText}」`) ||
     gkSummary.includes(`“${gkText}”`) ||
     gkSummary.includes(`‘${gkText}’`) ||
     (gkText.length <= 12 && gkSummary.includes(gkText)))
  );
  const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(gkText);
  const isVoided = Boolean(
    gatekeeperDecision.formatVoid ||
    (gkSummary && (
      gkSummary.includes("丢失了目标列的 EPUB noteref 注释标记") ||
      gkSummary.includes("段落结构与目标列不一致")
    ))
  );
  if (gatekeeperDecision.needsEdit !== false && gkText && !isGkDeleteIntent && !hasKana && !isVoided) {
    lines.push(`初审改案：${gkText}`);
  }

  const critique = stylistReview.critique || {};
  const stylistText = critique.rationale || stylistReview.summary || stylistReview.rationale || "";
  if (stylistText || stylistReview.attitude || critique.attitude) {
    const attMap = { accept: "采纳", modify: "调整", reject: "驳回", escalate: "提交仲裁", unclear: "存疑" };
    const rawAtt = critique.attitude || stylistReview.attitude || "复审";
    const attLabel = attMap[rawAtt] || rawAtt || "复审";
    lines.push(`Stylist复审[${attLabel}]：${stylistText || "文学复审完成"}`);
  }
  const s2Text = String(gatekeeperDecision.stage2RevisedText || stylistReview.revisedText || "").trim();
  if (s2Text && s2Text !== gkText) {
    lines.push(`复审改案：${s2Text}`);
  }

  if (arbitration && (arbitration.reason || arbitration.finalDecision || arbitration.winner)) {
    const winnerMap = {
      gatekeeper: "初审方案",
      stylist: "复审方案",
      synthesis: "结合方案",
      combined: "结合方案",
      combination: "结合方案",
      hybrid: "结合方案",
      both: "结合方案",
      "结合方案": "结合方案",
      "综合方案": "结合方案",
      original: "维持原译",
      target: "维持原译",
      neither: "折中方案",
      compromise: "结合方案",
      "折中方案": "结合方案",
      unclear: "存疑待定",
    };
    const winLabel = winnerMap[arbitration.winner] || (arbitration.finalDecision === "unclear" ? "存疑待定" : (arbitration.winner || "裁决"));
    const defaultArbReason = arbitration.finalDecision === "unclear"
      ? "终审法官全面权衡初审与复审意见，依据依然不足或存在深层分歧，建议转人工确认。"
      : "终审裁决定案。";
    lines.push(`Arbiter仲裁[${winLabel}]：${arbitration.reason || defaultArbReason}`);
    const s3Text = String(arbitration.revisedText || gatekeeperDecision.stage3RevisedText || "").trim();
    const isSynthesis = arbitration.winner === "synthesis" ||
      arbitration.winner === "combined" ||
      arbitration.winner === "compromise" ||
      winLabel === "结合方案";
    if (s3Text && (isSynthesis || (s3Text !== s2Text && s3Text !== gkText))) {
      lines.push(`仲裁改案：${s3Text}`);
    }
  }

  return lines;
}

module.exports = {
  shouldTriggerArbitration,
  resolveDeterministicAgreement,
  applyArbitrationDecision,
  formatArbitrationNoteLines,
};
