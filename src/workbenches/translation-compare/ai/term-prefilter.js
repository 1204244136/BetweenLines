/**
 * 对照表预处理的“结果写入”层：把命中结果写成工作台可解析的备注。
 *
 * 备注格式与 AI 校对保持一致（前三行是客户端解析的固定前缀），只把标记换成 `[对照表]`，
 * 这样工作台的备注展示、筛选、人工确认与批量操作都能直接复用，不需要新的数据通道。
 */
const { describeTermHit, formatTermHitGroups } = require("./term-table");

const TERM_MARKER = "[对照表]";

function makeTermResult(row, labels, evaluation, comparisonMode = "trilingual", targetKey = "cn") {
  const targetLabel = targetKey === "tw" ? (labels.tw || "非原文 C") : (labels.cn || "译文 B");
  const consistent = evaluation.kind === "consistent";
  const hasRevision = Boolean(evaluation.revisedText);
  // 一致的行不需要任何操作，却常常命中好几条术语：这里用分组摘要，避免备注体积膨胀；
  // 冲突行要指出到底该改哪一处，保留逐条说明。
  const head = consistent
    ? `分析：命中对照表 ${evaluation.hits.length} 条（译名一致）：${formatTermHitGroups(evaluation.hits)}`
    : `分析：命中对照表 ${evaluation.hits.length} 条（存在译名差异）：${evaluation.hits.map((hit) => describeTermHit(hit)).join(" ")}`;
  const tail = hasRevision
    ? `只替换术语，未改动句子的其余部分。目标列：${targetLabel}。`
    : (consistent
      ? `无需修改，本行不再交给模型（目标列：${targetLabel}）。`
      : `未能在译文里定位到可确定替换的旧译名，请人工确认目标列（${targetLabel}）是否需要改写。`);
  const note = [
    TERM_MARKER,
    `语义是否相同：${consistent ? "相同" : (hasRevision ? "不同" : "待人工确认")}`,
    `是否需要修改：${consistent ? "否" : (hasRevision ? "是" : "待人工确认")}`,
    `${head}${tail}`,
  ];
  if (hasRevision) note.push(`修改结果：${evaluation.revisedText}`);
  return {
    runId: null,
    index: row.index,
    signature: null,
    targetKey,
    status: consistent ? "term-prefilter" : "suggestion",
    done: consistent,
    note: note.join("\n"),
  };
}

function termTargetKeyFor(comparisonMode, target) {
  if (comparisonMode === "bilingual") return "cn";
  return target === "tw" ? "tw" : "cn";
}

module.exports = {
  TERM_MARKER,
  makeTermResult,
  termTargetKeyFor,
};
