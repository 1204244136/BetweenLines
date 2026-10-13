const { latestAiNotePart, splitNoteFields, stageNoteState } = require("./stage-note-state");

// 一次任务的起始条目准备：不加载任务 status、结果存储或网络。
// 输入已由任务入口完成项目校验；候选 rows 仍交给入口做规则/相似度预筛。
function prepareStageInputs({
  rows, config, plan, labels, notesSnapshotProvided = false,
  reusableResults = new Map(), currentResultFor = () => null, resolvedByTermTable = new Set(),
}) {
  const bilingual = config.proofreadMode === "bilingual";
  const defaultTargetKey = bilingual ? "cn" : config.target;
  const defaultCounterpartKey = bilingual ? "jp" : (defaultTargetKey === "cn" ? "tw" : "cn");
  const defaultTargetLabel = defaultTargetKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C");
  const defaultCounterpartLabel = defaultCounterpartKey === "jp"
    ? (labels.jp || "原文 A")
    : (defaultCounterpartKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C"));

  function memoryForRow(idx) {
    const result = reusableResults.get(idx) || currentResultFor(idx);
    if (!result) return null;
    // 同一快照也可能切换备注空间或重新初审；只复用与当前轮备注吻合的内存结论。
    if (notesSnapshotProvided &&
        (config.rowNotes[idx] || "") !== latestAiNotePart(result.note).trim()) return null;
    return result;
  }

  // 复审队列条目：优先用上一轮的内存结论（无损），拿不到才退回从备注文本反推（有损）。
  function buildStage2Item(row, noteText, memoryResult) {
    const isUnclear = Boolean(
      memoryResult?.stageResult?.decision === "unclear" ||
      memoryResult?.stageResult?.better === "unclear" ||
      memoryResult?.stageResult?.needsContext === true ||
      noteText.includes("是否需要修改：待人工确认") ||
      noteText.includes("是否需要修改：待终审") ||
      noteText.includes("存疑转人工") ||
      noteText.includes("初审存疑")
    );
    if (memoryResult && memoryResult.stageResult && (memoryResult.stageResult.needsEdit || isUnclear)) {
      const rememberedDecision = memoryResult.decision || memoryResult.stageResult;
      return {
        row,
        decision: {
          ...rememberedDecision,
          // 公开摘要使用 decision 键，复审提示词使用 better；存疑不能在内存续跑时丢失。
          better: isUnclear ? "unclear" : (rememberedDecision.better || rememberedDecision.decision),
        },
        targetKey: memoryResult.targetKey || defaultTargetKey,
        targetLabel: memoryResult.targetLabel || defaultTargetLabel,
        counterpartKey: memoryResult.counterpartKey || defaultCounterpartKey,
        counterpartLabel: memoryResult.counterpartLabel || defaultCounterpartLabel,
        targetText: memoryResult.targetText || textForKey(row, memoryResult.targetKey || defaultTargetKey),
        counterpartText: memoryResult.counterpartText || textForKey(row, memoryResult.counterpartKey || defaultCounterpartKey),
        lowScore: null,
      };
    }
    return reconstructStage1Result(row, noteText, config, labels);
  }

  function buildStage3Item(row, noteText, memoryResult) {
    // stageResult 是公开摘要，通常没有完整复审内容；拿它直接仲裁会丢失复审改案与理由。
    return (memoryResult?.decision?.stylistReview && config.continueOnly)
      ? {
          row,
          decision: memoryResult.decision,
          targetKey: memoryResult.targetKey || defaultTargetKey,
          targetLabel: memoryResult.targetLabel || defaultTargetLabel,
          counterpartKey: memoryResult.counterpartKey || defaultCounterpartKey,
          counterpartLabel: memoryResult.counterpartLabel || defaultCounterpartLabel,
          targetText: memoryResult.targetText || textForKey(row, memoryResult.targetKey || defaultTargetKey),
          counterpartText: memoryResult.counterpartText || textForKey(row, memoryResult.counterpartKey || defaultCounterpartKey),
          lowScore: null,
          arbCheck: { triggered: true },
        }
      : reconstructStage2Result(row, noteText, config, labels);
  }

  // 已经有初审结论、只差复审的行：它们不该再跑一遍初审，直接进复审队列。
  // 没有这一步，「待复审 N 行」只能等初审把它们重新产出一遍，复审并发配得再高也派不出活来。
  function collectResumedStage2(resolvedByTermTable = new Set()) {
    const resumed = [];
    const indexes = new Set();
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx)) continue;
      // 对照表已经直接定案的行（term-only）不再送复审，否则会白花一次调用。
      if (resolvedByTermTable.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      const memoryResult = memoryForRow(idx);
      if (!isStage2Candidate(noteText, memoryResult)) continue;
      // 已经有复审结论的行（含等待仲裁的）不在这里补跑：重跑复审只会白花一次调用。
      if (stageNoteState(noteText).reviewed || stageNoteState(noteText).arbitrated || memoryResult?.stylistReview) continue;
      resumed.push(buildStage2Item(row, noteText, memoryResult));
      indexes.add(idx);
    }
    return { resumed, indexes };
  }

  // 已有复审结论的仲裁待办直接续跑终审，保留前两段方案与异常留证。
  function collectResumedStage3(resolvedByTermTable = new Set()) {
    const resumed = [];
    const indexes = new Set();
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx) || resolvedByTermTable.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      const state = stageNoteState(noteText);
      if (!state.reviewed || !state.pendingArbitration) continue;
      resumed.push(buildStage3Item(row, noteText, memoryForRow(idx)));
      indexes.add(idx);
    }
    return { resumed, indexes };
  }

  const stageItems = { stage2: [], stage3: [] };
  const stage1Rows = [];
  let skippedDone = 0;

  if (config.targetStage === "stage2") {
    const resumedStage3 = plan.cascadeToArbiter && config.continueOnly
      ? collectResumedStage3() : { resumed: [], indexes: new Set() };
    stageItems.stage3 = resumedStage3.resumed;
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx) || resumedStage3.indexes.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      const memoryResult = memoryForRow(idx);
      if (isStage2Candidate(noteText, memoryResult)) {
        if (config.continueOnly && (stageNoteState(noteText).reviewed || stageNoteState(noteText).arbitrated || memoryResult?.stylistReview)) {
          skippedDone += 1;
          continue;
        }
        stageItems.stage2.push(buildStage2Item(row, noteText, memoryResult));
      } else {
        skippedDone += 1;
      }
    }
  } else if (config.targetStage === "stage3") {
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx)) continue;
      const noteText = config.rowNotes[idx] || "";
      const memoryResult = memoryForRow(idx);
      if (isStage3DisputeRow(row, noteText, memoryResult)) {
        if (config.continueOnly && (stageNoteState(noteText).arbitrated || memoryResult?.arbitration)) {
          skippedDone += 1;
          continue;
        }
        stageItems.stage3.push(buildStage3Item(row, noteText, memoryResult));
      } else {
        skippedDone += 1;
      }
    }
  } else {
    const resumedStage3 = plan.cascadeToArbiter && config.continueOnly
      ? collectResumedStage3(resolvedByTermTable) : { resumed: [], indexes: new Set() };
    const resumedStage2 = plan.cascadeToStylist && config.continueOnly
      ? collectResumedStage2(resolvedByTermTable) : { resumed: [], indexes: new Set() };
    stageItems.stage2 = resumedStage2.resumed;
    stageItems.stage3 = resumedStage3.resumed;
    for (const row of rows) {
      const idx = Number(row.index);
      if (config.completedIndexes.has(idx)) {
        skippedDone += 1;
        continue;
      }
      if (resumedStage2.indexes.has(idx) || resumedStage3.indexes.has(idx) || resolvedByTermTable.has(idx)) continue;
      stage1Rows.push(row);
    }
  }
  return { stage1Rows, stageItems, skippedDone };
}

function parseStoredNote(note = "") {
  const lines = splitNoteFields(latestAiNotePart(note));
  const data = {
    semantic: "",
    modify: "",
    stage1: "",
    stage1Revision: "",
    stage2: null,
    stage2Revision: "",
    stage3: null,
    stage3Revision: "",
    revision: "",
    analysis: "",
    score: 80,
  };
  for (const line of lines) {
    if (line.startsWith("语义是否相同：")) data.semantic = line.slice("语义是否相同：".length).trim();
    else if (line.startsWith("是否需要修改：")) data.modify = line.slice("是否需要修改：".length).trim();
    else if (line.startsWith("Gatekeeper初审：")) data.stage1 = line.slice("Gatekeeper初审：".length).trim();
    else if (line.startsWith("初审改案：") || line.startsWith("初审建议：")) data.stage1Revision = line.replace(/^(初审改案|初审建议)：/, "").trim();
    else if (line.startsWith("Stylist复审")) {
      const match = line.match(/^Stylist复审(?:\[(.*?)\])?：([\s\S]*)$/);
      if (match) {
        data.stage2 = { attitude: match[1] || "modify", text: match[2]?.trim() || "" };
      }
    } else if (line.startsWith("复审改案：") || line.startsWith("复审建议：")) data.stage2Revision = line.replace(/^(复审改案|复审建议)：/, "").trim();
    else if (line.startsWith("Arbiter仲裁")) {
      const match = line.match(/^Arbiter仲裁(?:\[(.*?)\])?：([\s\S]*)$/);
      if (match) {
        data.stage3 = { winner: match[1] || "裁决", text: match[2]?.trim() || "" };
      }
    } else if (line.startsWith("仲裁改案：") || line.startsWith("仲裁建议：")) data.stage3Revision = line.replace(/^(仲裁改案|仲裁建议)：/, "").trim();
    else if (line.startsWith("修改结果：")) data.revision = line.slice("修改结果：".length).trim();
    else if (line.startsWith("分析：")) data.analysis = line.slice("分析：".length).trim();
  }
  return data;
}

function isStage3DisputeRow(row, noteText = "", memoryResult = null) {
  if (String(noteText || "").trim()) {
    const state = stageNoteState(noteText);
    return state.arbitrated || state.diverged;
  }
  if (memoryResult) {
    if (memoryResult.arbitration) return true;
    if (memoryResult.arbCheck?.triggered || memoryResult.decision?.arbCheck?.triggered) return true;
    const critiqueAtt = memoryResult.critique?.attitude || memoryResult.stageResult?.critique?.attitude;
    if (critiqueAtt === "modify" || critiqueAtt === "reject" || critiqueAtt === "escalate") return true;
    if (memoryResult.stageResult?.decision === "escalate") return true;
  }
  return false;
}

// Stage 2 consumes both Gatekeeper edits and unresolved/unclear rows.
function isStage2Candidate(noteText = "", memoryResult = null) {
  if (String(noteText || "").trim()) return stageNoteState(noteText).candidate;
  const stageResult = memoryResult?.stageResult || memoryResult?.decision || {};
  const isUnclear = Boolean(
    stageResult.decision === "unclear" ||
    stageResult.better === "unclear" ||
    stageResult.needsContext === true
  );
  const hasEdit = Boolean(
    stageResult.needsEdit === true
  );
  return hasEdit || isUnclear;
}

function reconstructStage1Result(row, noteText, config, labels) {
  noteText = latestAiNotePart(noteText);
  const parsed = parseStoredNote(noteText);
  const bilingual = config.proofreadMode === "bilingual";
  const targetKey = bilingual ? "cn" : config.target;
  const counterpartKey = bilingual ? "jp" : (targetKey === "cn" ? "tw" : "cn");
  const targetLabel = targetKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C");
  const counterpartLabel = counterpartKey === "jp"
    ? (labels.jp || "原文 A")
    : (counterpartKey === "cn" ? (labels.cn || "非原文 B") : (labels.tw || "非原文 C"));
  const targetText = textForKey(row, targetKey);
  const counterpartText = textForKey(row, counterpartKey);

  const revisedText = parsed.stage1Revision || parsed.revision || "";
  const isNeedsCheck = parsed.modify === "待终审" || parsed.modify === "待人工确认" || parsed.modify === "人工确认" || noteText.includes("待人工确认") || noteText.includes("存疑");
  const better = bilingual
    ? (parsed.modify === "是" ? "neither" : (isNeedsCheck ? "unclear" : "keep"))
    : (parsed.modify === "是"
        ? (noteText.includes("参考") || noteText.includes("对照") ? "counterpart" : "neither")
        : (parsed.modify === "否" ? "target" : "unclear"));
  const decision = {
    needsEdit: parsed.modify === "是" || Boolean(revisedText),
    needsContext: isNeedsCheck,
    semanticSame: parsed.semantic !== "不同",
    better,
    summary: parsed.analysis || parsed.stage1 || (parsed.modify === "是" ? "初审建议修改" : (isNeedsCheck ? "初审存疑待人工确认" : "无需修改")),
    revisedText,
    score: parsed.score || (isNeedsCheck ? null : 80),
    stage1RevisedText: revisedText,
  };

  return {
    row,
    decision,
    targetKey,
    counterpartKey,
    targetLabel,
    counterpartLabel,
    targetText,
    counterpartText,
    lowScore: null,
  };
}

function reconstructStage2Result(row, noteText, config, labels) {
  const s1 = reconstructStage1Result(row, noteText, config, labels);
  const parsed = parseStoredNote(noteText);
  const s2Revised = parsed.stage2Revision || (parsed.stage3 ? (parsed.stage1Revision || "") : (parsed.revision || s1.decision.revisedText || ""));
  const attitude = parsed.stage2?.attitude || "modify";

  s1.decision.stylistReview = {
    critique: {
      attitude,
      rationale: parsed.stage2?.text || parsed.analysis || "文学复审意见",
      acceptedChanges: [],
      rejectedChanges: [],
    },
    revisedText: s2Revised,
    summary: parsed.stage2?.text || "",
  };
  s1.decision.stage2RevisedText = s2Revised;
  s1.arbCheck = {
    triggered: true,
    reason: parsed.stage2?.text || "分歧仲裁",
  };
  return s1;
}

function textForKey(row, key) {
  if (key === "jp") return row.jp || "";
  if (key === "tw") return row.tw || "";
  return row.cn || "";
}

module.exports = { prepareStageInputs, isStage2Candidate, isStage3DisputeRow, textForKey };
