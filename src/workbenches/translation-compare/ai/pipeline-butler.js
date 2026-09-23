/**
 * Pipeline Butler (流水线管家)
 *
 * 职责契约：
 * 纯确定性、毫秒级系统管家，不调用任何 LLM，专注负责流水线阶段间的协调、上下文供给与风控防线：
 * 1. 客观偏离度度量与放飞熔断（Anti-Drift Circuit Breaker）：
 *    杜绝 Stylist“表面自报认同初审、实际大拆大改放飞自我”的漏洞；
 *    通过长度畸变率、字符骨架重合度（Dice）、初审核心纠错留存与术语保真度多维熔断，
 *    只有真正属于微调润色的改案才直通采纳，一旦检测到放飞重写立即唤醒 Arbiter 终审法官。
 * 2. 梯度上下文供给协调（Context Dispatcher）：
 *    统筹上下文由短变长（Gatekeeper 单行/0行 -> Stylist 前后各1行 -> Arbiter 前后各2行）。
 * 3. 仲裁工单生成（Arbitration Ticket Dispatcher）：
 *    当触发分歧或熔断时，为法官提供客观、结构化的送审理由。
 */

const DEFAULT_DRIFT_THRESHOLDS = Object.freeze({
  maxRelativeLengthDrift: 0.25, // 长度变动超过 25% 触发熔断
  minCharacterOverlap: 0.70,     // 字符骨架重合度（Dice系数）低于 70% 触发熔断
  minAbsoluteOverlapLength: 6,   // 极短句（<6字）容错下限
});

/**
 * 计算两个文本的字符级重叠率（Dice 系数：2 * |A ∩ B| / (|A| + |B|)）。
 * 忽略空白字符，使用 Multiset 频次匹配，抗语序调整且准确反映字符大换血程度。
 */
function calculateCharacterOverlap(textA = "", textB = "") {
  const cleanA = String(textA || "").replace(/\s+/g, "");
  const cleanB = String(textB || "").replace(/\s+/g, "");
  if (!cleanA && !cleanB) return 1.0;
  if (!cleanA || !cleanB) return 0.0;

  const countsA = new Map();
  for (const ch of cleanA) countsA.set(ch, (countsA.get(ch) || 0) + 1);

  const countsB = new Map();
  for (const ch of cleanB) countsB.set(ch, (countsB.get(ch) || 0) + 1);

  let common = 0;
  for (const [ch, countA] of countsA.entries()) {
    const countB = countsB.get(ch) || 0;
    common += Math.min(countA, countB);
  }

  return (2 * common) / (cleanA.length + cleanB.length);
}

/**
 * 测量复审改案相对于初审改案的客观偏离度指标。
 */
function measureTextDrift(gkText = "", styText = "") {
  const g = String(gkText || "").trim();
  const s = String(styText || "").trim();

  const lengthDelta = Math.abs(s.length - g.length);
  const lengthRatio = lengthDelta / Math.max(1, g.length);
  const charOverlap = calculateCharacterOverlap(g, s);

  return {
    gkLength: g.length,
    styLength: s.length,
    lengthDelta,
    lengthRatio,
    charOverlap,
  };
}

/**
 * 检验复审改案是否保留了命中术语的标准译名。
 */
function checkTermPreservation(styText = "", termGuidance = null) {
  if (!termGuidance || !Array.isArray(termGuidance.terms) || termGuidance.terms.length === 0) {
    return { preserved: true, missingTerms: [] };
  }
  const text = String(styText || "");
  const missing = [];
  for (const item of termGuidance.terms) {
    const target = item.target || item.translation;
    if (target && !text.includes(target)) {
      missing.push(target);
    }
  }
  return {
    preserved: missing.length === 0,
    missingTerms: missing,
  };
}

/**
 * 检验初审指出的核心纠错是否被复审意外回退为原译。
 * 例如：原译有错词 A，初审纠正为 B，若复审改案中又出现了 A 且没有 B，判定为纠错回退。
 */
function checkCorrectionRegression(targetText = "", gkText = "", styText = "", gatekeeperDecision = {}) {
  const summary = String(gatekeeperDecision.summary || "");
  const target = String(targetText || "");
  const sty = String(styText || "");
  const gk = String(gkText || "");

  // 1. 尝试从初审 summary 中提取被指控的错误短语（形如「...」或 “...” 或 '...'）
  const quotedErrors = [];
  const quoteRegex = /[「“'‘]([^」”'’]{2,16})[」”'’]/g;
  let match;
  while ((match = quoteRegex.exec(summary)) !== null) {
    const candidate = match[1].trim();
    // 只有当该词确实曾出现在原译 targetText 中，才算指控的待纠错词
    if (target.includes(candidate) && !gk.includes(candidate)) {
      quotedErrors.push(candidate);
    }
  }

  // 2. 检查复审改案是否又重新引入了这些错误词
  const regressed = quotedErrors.filter((errWord) => sty.includes(errWord));
  if (regressed.length > 0) {
    return {
      regressed: true,
      reason: `复审改案重新引入了初审已剔除的错误词：${regressed.map((w) => `「${w}」`).join("、")}`,
    };
  }

  return { regressed: false, reason: "" };
}

/**
 * 管家核心防线：客观偏离度与放飞熔断审查（Butler Anti-Drift Inspector）。
 *
 * 审查原则：
 * 绝不能只听信 Stylist 自报的 rejectedChanges 为空！
 * 必须结合长度畸变、字符骨架重叠度、术语留存与纠错回退四大客观度量交叉验证：
 * - 只有【主观全盘接受初审】且【客观上确实是字词微调】的改案，管家才判定为良性微调直通放行；
 * - 只要命中任何一项客观偏离（长度变化过大、整句推倒重构、丢弃标准术语、回退原译错误），
 *   管家立即生成熔断工单，强制唤醒 Arbiter 终审法官把关。
 */
function inspectStylistDrift({
  gkText = "",
  styText = "",
  targetText = "",
  gatekeeperDecision = {},
  stylistReview = {},
  signals = {},
  thresholds = DEFAULT_DRIFT_THRESHOLDS,
}) {
  const g = String(gkText || "").trim();
  const s = String(styText || "").trim();
  const critique = stylistReview.critique || {};
  const attitude = critique.attitude || stylistReview.attitude;
  const rejectedChanges = Array.isArray(critique.rejectedChanges) ? critique.rejectedChanges : null;
  const acceptedChanges = Array.isArray(critique.acceptedChanges) ? critique.acceptedChanges : null;

  // 1. 度量客观偏离度
  const metrics = measureTextDrift(g, s);
  const termCheck = checkTermPreservation(s, signals.termGuidance);
  const regressionCheck = checkCorrectionRegression(targetText, g, s, gatekeeperDecision);

  // 2. 判定主观自评是否宣称采纳
  const subjectiveAcceptance = attitude === "modify" &&
    rejectedChanges !== null &&
    rejectedChanges.length === 0 &&
    acceptedChanges !== null &&
    acceptedChanges.length > 0;

  // 3. 判定客观偏离度熔断条件
  const lengthTooDrastic = metrics.gkLength >= thresholds.minAbsoluteOverlapLength &&
    metrics.lengthRatio > thresholds.maxRelativeLengthDrift;

  const overlapTooLow = (metrics.gkLength >= thresholds.minAbsoluteOverlapLength || metrics.styLength >= thresholds.minAbsoluteOverlapLength) &&
    metrics.charOverlap < thresholds.minCharacterOverlap;

  const hasExplicitRejection = rejectedChanges && rejectedChanges.length > 0;
  const hasTermConflict = Boolean(signals.termConflict) || !termCheck.preserved;
  const hasRiskSignals = Boolean(signals.lowScoreUncertain) || (Array.isArray(signals.riskFlags) && signals.riskFlags.length > 0);

  // 4. 熔断判定分析
  let driftReason = "";
  if (hasExplicitRejection) {
    driftReason = `Gatekeeper 与 Stylist 存在具体改动分歧（驳回项：${rejectedChanges.join("、")}）。`;
  } else if (!termCheck.preserved) {
    driftReason = `管家风控熔断：复审改案遗漏了标准术语「${termCheck.missingTerms.join("、")}」，疑似文学润色跑偏。`;
  } else if (hasTermConflict) {
    driftReason = "检测到术语冲突且两阶段未达成一致。";
  } else if (regressionCheck.regressed) {
    driftReason = `管家风控熔断：${regressionCheck.reason}。`;
  } else if (lengthTooDrastic) {
    const pct = Math.round(metrics.lengthRatio * 100);
    driftReason = `管家风控熔断：复审改案字数与初审差异过大（偏离度 ${pct}% > 阈值 ${Math.round(thresholds.maxRelativeLengthDrift * 100)}%），疑似过度增译或删减，移交终审把关。`;
  } else if (overlapTooLow) {
    const overlapPct = Math.round(metrics.charOverlap * 100);
    driftReason = `管家风控熔断：复审改案与初审字符骨架重合度过低（${overlapPct}% < 安全阈值 ${Math.round(thresholds.minCharacterOverlap * 100)}%），疑似整句推倒重构放飞，移交终审把关。`;
  } else if (hasRiskSignals) {
    driftReason = "存在高风险或低分不确定性标记，移交终审把关。";
  } else if (!subjectiveAcceptance) {
    driftReason = "Gatekeeper 与 Stylist 提出了不同的修订方案。";
  }

  // 5. 只有所有风控项全部安全，才判定为良性润色
  const isBenignPolish = subjectiveAcceptance &&
    !lengthTooDrastic &&
    !overlapTooLow &&
    termCheck.preserved &&
    !regressionCheck.regressed &&
    !hasTermConflict &&
    !hasRiskSignals;

  return {
    isBenignPolish,
    circuitBroken: !isBenignPolish,
    reason: driftReason,
    metrics: {
      ...metrics,
      termPreserved: termCheck.preserved,
      regressionFound: regressionCheck.regressed,
    },
  };
}

const STAGE_CONTEXT_PROFILES = Object.freeze({
  gatekeeper: {
    appetite: "strict-evidence", // 极克制：严格依赖显式语法线索（由 continuation/inferredSubject 等负责）
    maxRadius: 1,
    maxRows: 2,
  },
  stylist: {
    appetite: "flow-sensitive",   // 语流敏感：仅当检测到指示代词、承接连词、对话或衔接改动时按需激活
    maxRadius: 1,
    maxRows: 2,
  },
  arbiter: {
    appetite: "dispute-evidence", // 争议证据：终审裁决涉及双方分歧或放飞熔断，调阅最充分证据链
    maxRadius: 2,
    maxRows: 4,
  },
});

/**
 * 探测当前行是否具有“语流承接敏感性”（供 Stylist 阶段按需激活上下文欲望）。
 * 拒绝无脑硬塞：若句子完全独立自洽，则不激活上下文欲望，保持单行专注。
 */
function needsFlowContext(row = {}, gatekeeperDecision = {}, targetKey = "cn") {
  const source = String(row.source || row.jp || "");
  const target = String(row.target || row[targetKey] || row.cn || "");
  const summary = String(gatekeeperDecision.summary || "");

  // 1. 原文或译文包含指示代词、承接连词、因果前提等语流关联词
  const flowPattern = /(?:この|その|あの|これ|それ|あれ|というのも|しかし|だが|そして|なぜなら|をもってすれば|この事実|まさに|正是|因此|然而|但是|这一|有了这|随后|不过|与此同时|话虽如此|尽管|既然|反之|由此可见)/i;
  if (flowPattern.test(source) || flowPattern.test(target)) return true;

  // 2. 属于对话行、心声或带引号的片段（需要关注说话人来回与语气承接）
  if (/[「『]/.test(source) || /[「『“”]/.test(target)) return true;

  // 3. 初审意见中直接指出了承接、语序、指代或连词问题
  if (/(?:上下文|连词|主语|代词|指代|承接|语序|衔接|倒装|前文|后文|话语)/.test(summary)) return true;

  return false;
}

/**
 * 管家按需上下文供给器 (On-Demand Context Dispatcher)。
 *
 * 契约：按需供给、柔和分配。
 * - Gatekeeper: 严格证据驱动（默认 0 行，语法硬线索由专有探测器挂载）；
 * - Stylist: 语流敏感驱动（仅在命中指示代词、承接连词、对话语境或衔接改动时，在 1 行额度内按需供给）；
 * - Arbiter: 争议裁决驱动（终审分歧必然涉及语境辨析，在 2 行额度内按需供给完整证据链）。
 */
function resolveStageContext({
  stage = "stylist",
  allRows = null,
  rowIndex = null,
  row = {},
  gatekeeperDecision = {},
  targetKey = "cn",
  forceContext = false,
}) {
  if (!Array.isArray(allRows) || allRows.length === 0 || rowIndex == null) return null;
  const profile = STAGE_CONTEXT_PROFILES[stage] || STAGE_CONTEXT_PROFILES.stylist;

  // Stylist 阶段：仅当探测到语流承接需求时才唤醒上下文供给，否则保持单行专注
  if (stage === "stylist" && !forceContext) {
    const wantsContext = needsFlowContext(row, gatekeeperDecision, targetKey);
    if (!wantsContext) return null; // 独立普通句子，柔和免供上下文
  }

  // 根据阶段配额额度提取上下文行
  return extractNeighborContext(allRows, rowIndex, profile.maxRadius, targetKey);
}

/**
 * 管家上下文分发器：按阶段梯度提取邻近行上下文。
 * 契约：上下文由短变长。
 * - Gatekeeper: 默认单行判定，特殊语法关联时由调度器按需补入；
 * - Stylist: radius = 1（前后各 1 行，中等上下文，审视语流连贯性）；
 * - Arbiter: radius = 2（前后各 2 行，长上下文，提供完整因果证据链）。
 */
function extractNeighborContext(allRows, currentIndex, radius = 1, targetKey = "cn") {
  if (!Array.isArray(allRows) || allRows.length === 0 || !radius || radius <= 0) return null;
  const idx = Number(currentIndex);
  const pos = allRows.findIndex((r) => Number(r.index) === idx);
  if (pos === -1) return null;

  const before = [];
  const after = [];

  for (let i = Math.max(0, pos - radius); i < pos; i += 1) {
    const r = allRows[i];
    before.push({
      index: r.index,
      sourceText: r.source || r.jp || "",
      targetText: r.target || r[targetKey] || r.cn || "",
    });
  }

  for (let i = pos + 1; i <= Math.min(allRows.length - 1, pos + radius); i += 1) {
    const r = allRows[i];
    after.push({
      index: r.index,
      sourceText: r.source || r.jp || "",
      targetText: r.target || r[targetKey] || r.cn || "",
    });
  }

  if (before.length === 0 && after.length === 0) return null;
  return { before, after };
}

module.exports = {
  DEFAULT_DRIFT_THRESHOLDS,
  STAGE_CONTEXT_PROFILES,
  calculateCharacterOverlap,
  measureTextDrift,
  checkTermPreservation,
  checkCorrectionRegression,
  inspectStylistDrift,
  needsFlowContext,
  resolveStageContext,
  extractNeighborContext,
};
