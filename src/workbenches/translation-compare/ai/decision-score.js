// 评分、等级与严重度的纯计算；不读取任务状态。
function parseOptionalNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function computeScoreAndGrade({ needsEdit, rawScore, rawPenalty, rawGrade, rawSeverity }) {
  if (!needsEdit) {
    return {
      score: 100,
      penalty: 0,
      grade: "excellent",
      severity: "none",
    };
  }

  let penalty = null;
  let score = null;
  if (rawPenalty !== null) {
    penalty = Math.max(0, Math.min(100, Math.round(rawPenalty)));
  }
  if (rawScore !== null) {
    score = Math.max(0, Math.min(100, Math.round(rawScore)));
    if (penalty === null) penalty = Math.max(0, 100 - score);
  } else if (penalty !== null) {
    score = Math.max(0, 100 - penalty);
  }

  const normalizedGrade = normalizeGrade(rawGrade || rawSeverity);
  if (score === null) {
    if (normalizedGrade === "poor" || normalizedGrade === "critical") {
      penalty = 45;
      score = 55;
    } else if (normalizedGrade === "good" || normalizedGrade === "minor") {
      penalty = 15;
      score = 85;
    } else if (normalizedGrade === "excellent") {
      penalty = 5;
      score = 95;
    } else {
      penalty = 30;
      score = 70;
    }
  }

  let grade = "fair";
  if (score >= 90) grade = "excellent";
  else if (score >= 75) grade = "good";
  else if (score >= 60) grade = "fair";
  else grade = "poor";

  let severity = "major";
  if (grade === "excellent") severity = penalty > 0 ? "minor" : "none";
  else if (grade === "good") severity = "minor";
  else if (grade === "fair") severity = "major";
  else if (grade === "poor") severity = "critical";

  return {
    score,
    penalty: penalty ?? Math.max(0, 100 - score),
    grade,
    severity,
  };
}

function normalizeGrade(value) {
  const text = String(value || "").trim().toLowerCase();
  if (["excellent", "优等", "优秀", "优", "a"].includes(text)) return "excellent";
  if (["good", "良好", "良", "b", "minor", "轻微", "低"].includes(text)) return "good";
  if (["fair", "一般", "待改", "中等", "及格", "c", "major", "严重", "重大"].includes(text)) return "fair";
  if (["poor", "较差", "不及格", "差", "d", "critical", "致命", "高"].includes(text)) return "poor";
  return "";
}

function normalizeSeverity(value, needsEdit = true) {
  if (!needsEdit) return "none";
  const text = String(value || "").trim().toLowerCase();
  if (["critical", "致命", "高", "high"].includes(text)) return "critical";
  if (["major", "严重", "重大", "主要", "中", "medium"].includes(text)) return "major";
  if (["minor", "轻微", "次要", "低", "low"].includes(text)) return "minor";
  return "major";
}

module.exports = { parseOptionalNumber, computeScoreAndGrade, normalizeGrade, normalizeSeverity };
