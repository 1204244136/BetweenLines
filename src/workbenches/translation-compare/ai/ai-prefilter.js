const { bigramSet, jaccard } = require("../../../core/text-helpers");

function canonicalText(text) {
  return String(text || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\s+/gu, "")
    .toLowerCase();
}

// 预筛相似度的归一化口径：决定哪些行会被判「几乎相同」而跳过模型，改它等于改预筛阈值。
function similarityText(text) {
  return canonicalText(text).replace(/[\p{P}\p{S}]/gu, "");
}

function textSimilarity(a, b) {
  return jaccard(bigramSet(similarityText(a)), bigramSet(similarityText(b)));
}

function isStructuredText(text) {
  const value = canonicalText(text);
  if (!value || Array.from(value).length > 32) return false;
  const numericOrSymbols = /\p{N}/u.test(value) && /^[\p{N}\p{P}\p{S}]+$/u.test(value);
  const asciiIdentifier = /[a-z0-9]/.test(value) && /^[a-z0-9._:/#%+\-]+$/.test(value);
  return numericOrSymbols || asciiIdentifier;
}

function protectedTokens(text) {
  return canonicalText(text).match(/[a-z]+|\p{N}+/gu) || [];
}

function canUseSimilarityPrefilter(left, right) {
  if (isStructuredText(left) || isStructuredText(right)) return false;
  const leftText = similarityText(left);
  const rightText = similarityText(right);
  const leftLength = Array.from(leftText).length;
  const rightLength = Array.from(rightText).length;
  if (Math.min(leftLength, rightLength) < 8) return false;
  if (Math.min(leftLength, rightLength) / Math.max(leftLength, rightLength) < 0.9) return false;
  return JSON.stringify(protectedTokens(left)) === JSON.stringify(protectedTokens(right));
}

function classifyPrefilter({ source = "", left = "", right = "", score = 0 }, similarityThreshold) {
  const sourceCanonical = canonicalText(source);
  const leftCanonical = canonicalText(left);
  const rightCanonical = canonicalText(right);

  if (!leftCanonical && !rightCanonical) {
    return { kind: "rule-empty", reason: "两份非原文均为空，无可校对内容。" };
  }

  const sourceStructured = isStructuredText(source);
  const leftStructured = isStructuredText(left);
  const rightStructured = isStructuredText(right);

  if (leftCanonical && leftCanonical === rightCanonical) {
    if (sourceStructured && leftStructured && sourceCanonical !== leftCanonical) {
      return {
        kind: "structured-conflict",
        reason: "结构化内容与原文不一致，需要人工确认。",
      };
    }
    return {
      kind: "rule-equivalent",
      reason: "繁简、全半角、空白或不可见字符归一化后完全一致。",
    };
  }

  const leftIsStructuredOrEmpty = leftStructured || !leftCanonical;
  const rightIsStructuredOrEmpty = rightStructured || !rightCanonical;
  if (leftIsStructuredOrEmpty && rightIsStructuredOrEmpty) {
    return {
      kind: "structured-conflict",
      reason: "两份非原文的结构化内容不一致，需要人工确认。",
    };
  }

  if (!canUseSimilarityPrefilter(left, right)) return null;
  const similarity = Math.max(Number(score) || 0, textSimilarity(left, right));
  if (similarity < similarityThreshold) return null;
  return {
    kind: "similarity",
    reason: "两份非原文通过受保护的正文相似度预筛选。",
    similarity,
  };
}

module.exports = {
  canUseSimilarityPrefilter,
  canonicalText,
  classifyPrefilter,
  isStructuredText,
  textSimilarity,
};
