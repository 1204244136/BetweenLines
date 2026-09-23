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

/**
 * Evaluates whether Stage 3 Arbitration must be triggered for a row.
 *
 * Trigger conditions:
 * 1. Explicit escalation by Stylist (attitude === 'escalate')
 * 2. Fundamental stance divergence: Gatekeeper says needsEdit=true, but Stylist rejects (attitude === 'reject')
 * 3. Substantial revision divergence: both proposed edits, but revisedTexts differ significantly
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

  // 3. Substantial revision divergence
  const gkText = String(gatekeeperDecision.revisedText || "").trim();
  const styText = String(stylistReview.revisedText || "").trim();
  if (gkNeedsEdit && gkText && styText && gkText !== styText) {
    return {
      triggered: true,
      reason: "Gatekeeper 与 Stylist 提出了不同的修订方案。",
    };
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
  const finalDecision = normArb.finalDecision || (isOriginal ? "keep" : "replace");

  let finalRevisedText = adjudicatedRevisedText;
  if (!finalRevisedText) {
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

  if (gatekeeperDecision.summary) {
    lines.push(`Gatekeeper初审：${gatekeeperDecision.summary}`);
  }
  const gkText = String(gatekeeperDecision.stage1RevisedText || gatekeeperDecision.revisedText || "").trim();
  const isGkDeleteIntent = Boolean(
    gatekeeperDecision.summary &&
    /(?:删除|删去|删掉|去除|去掉|增译|无中生有|多余|不应有)/.test(gatekeeperDecision.summary) &&
    (gatekeeperDecision.summary.includes(`「${gkText}」`) ||
     gatekeeperDecision.summary.includes(`“${gkText}”`) ||
     gatekeeperDecision.summary.includes(`‘${gkText}’`) ||
     (gkText.length <= 12 && gatekeeperDecision.summary.includes(gkText)))
  );
  const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(gkText);
  if (gatekeeperDecision.needsEdit !== false && gkText && !isGkDeleteIntent && !hasKana) {
    lines.push(`初审改案：${gkText}`);
  }

  const critique = stylistReview.critique || {};
  if (critique.rationale || stylistReview.summary) {
    const attMap = { accept: "采纳", modify: "调整", reject: "驳回", escalate: "提交仲裁" };
    const attLabel = attMap[critique.attitude] || critique.attitude || "复审";
    lines.push(`Stylist复审[${attLabel}]：${critique.rationale || stylistReview.summary}`);
  }
  const s2Text = String(gatekeeperDecision.stage2RevisedText || stylistReview.revisedText || "").trim();
  if (s2Text && s2Text !== gkText) {
    lines.push(`复审改案：${s2Text}`);
  }

  if (arbitration.reason) {
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
    };
    const winLabel = winnerMap[arbitration.winner] || arbitration.winner || "裁决";
    lines.push(`Arbiter仲裁[${winLabel}]：${arbitration.reason}`);
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
