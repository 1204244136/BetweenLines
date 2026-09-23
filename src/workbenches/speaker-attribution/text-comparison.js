const { bigramSet, jaccard: setSimilarity, stripInvisible, unique } = require("../../core/text-helpers");

const HAN_PATTERN = /\p{Script=Han}/u;

function normalizeText(value) {
  return stripInvisible(value).toLowerCase();
}

function compactText(value) {
  return normalizeText(value).replace(/[\s\p{P}\p{S}]/gu, "");
}

function bigrams(value) {
  return bigramSet(compactText(value));
}

function extractNumbers(value) {
  return unique(normalizeText(value).match(/\d+(?:[.,]\d+)?/g) || []);
}

function extractTokens(value) {
  return unique(normalizeText(value).match(/[\p{L}\p{N}]+/gu) || []);
}

function extractHan(value) {
  return new Set(Array.from(compactText(value)).filter((char) => HAN_PATTERN.test(char)));
}

function punctuationShape(value) {
  const normalized = normalizeText(value).trim();
  const first = normalized[0] || "";
  const last = normalized.at(-1) || "";
  return {
    firstQuote: /^[「『“"'「]/u.test(first),
    lastQuote: /[」』”"'」]$/u.test(last),
    question: /[?？]/u.test(last),
    exclamation: /[!！]/u.test(last),
    sentenceEnd: /[。．.!！?？]$/u.test(last),
  };
}

function prepareText(value) {
  const text = String(value || "");
  const normalized = normalizeText(text);
  const compact = compactText(text);
  const chars = Array.from(compact);
  const punctuation = punctuationShape(text);
  const kana = chars.filter((char) => /[\u3040-\u30ff]/u.test(char)).length;
  const latin = chars.filter((char) => /[A-Za-z]/u.test(char)).length;
  return {
    text,
    normalized,
    compact,
    chars,
    length: chars.length,
    bigrams: bigrams(text),
    tokens: new Set(extractTokens(text)),
    han: extractHan(text),
    numbers: extractNumbers(text),
    punctuation,
    dialogue: punctuation.firstQuote || punctuation.lastQuote,
    kana,
    latin,
  };
}

function numberMatch(left, right) {
  if (!left.length && !right.length) return null;
  if (!left.length || !right.length) return 0;
  return left.join("|") === right.join("|") ? 1 : 0;
}

function booleanMatch(left, right) {
  return left === right ? 1 : 0;
}

function comparePrepared(left, right) {
  if (!left.length && !right.length) {
    return {
      score: 1,
      lexicalScore: 1,
      hanScore: 1,
      lengthScore: 1,
      punctuationScore: 1,
      dialogueScore: 1,
      numberScore: null,
      sharedTokens: [],
      confidence: "high",
      issues: [],
    };
  }

  const lexicalScore = Math.max(
    setSimilarity(left.bigrams, right.bigrams),
    setSimilarity(left.tokens, right.tokens),
  );
  const hanScore = setSimilarity(left.han, right.han);
  const lengthScore = Math.min(left.length, right.length) / Math.max(1, Math.max(left.length, right.length));
  const punctuationScore = [
    booleanMatch(left.punctuation.question, right.punctuation.question),
    booleanMatch(left.punctuation.exclamation, right.punctuation.exclamation),
    booleanMatch(left.punctuation.sentenceEnd, right.punctuation.sentenceEnd),
  ].reduce((sum, value) => sum + value, 0) / 3;
  const dialogueScore = booleanMatch(left.dialogue, right.dialogue);
  const numberScore = numberMatch(left.numbers, right.numbers);
  const sharedTokens = [...left.tokens].filter((token) => right.tokens.has(token) && token.length > 1).slice(0, 8);
  const numberSignal = numberScore == null ? 0.5 : numberScore;
  // 跨文字系统对（如日文假名与中文，或混合字符与纯拉丁字母）几乎没有共享字符，
  // 因此字符重叠相似度没有意义，且无论结构是否真正匹配都会拉低分数。
  // 在这种情况下，加权结构信号（长度、标点、对话）而不是词汇重叠。
  // 同文字系统对保留原有的权重设置。
  const crossScript = (left.kana > 0) !== (right.kana > 0)
    || (left.latin > 0) !== (right.latin > 0);
  const weights = crossScript
    ? { lexical: 0.18, han: 0.16, length: 0.32, punctuation: 0.18, dialogue: 0.08, number: 0.08 }
    : { lexical: 0.42, han: 0.16, length: 0.18, punctuation: 0.10, dialogue: 0.06, number: 0.08 };
  const score = Math.min(1, (
    lexicalScore * weights.lexical
    + hanScore * weights.han
    + lengthScore * weights.length
    + punctuationScore * weights.punctuation
    + dialogueScore * weights.dialogue
    + numberSignal * weights.number
  ));
  const issues = [];
  if (numberScore === 0) issues.push("数字不同");
  if (!punctuationScore) issues.push("句末标点不同");
  if (left.length >= 10 && right.length >= 10 && !sharedTokens.length && hanScore < 0.12) {
    issues.push("没有明显共享片段");
  }
  return {
    score: Number(score.toFixed(4)),
    lexicalScore: Number(lexicalScore.toFixed(4)),
    hanScore: Number(hanScore.toFixed(4)),
    lengthScore: Number(lengthScore.toFixed(4)),
    punctuationScore: Number(punctuationScore.toFixed(4)),
    dialogueScore,
    dialogue: left.dialogue && right.dialogue,
    numberScore,
    sharedTokens,
    confidence: score >= 0.62 ? "high" : (score >= 0.38 ? "medium" : "low"),
    issues,
  };
}

function compareTexts(leftText, rightText) {
  return comparePrepared(prepareText(leftText), prepareText(rightText));
}

function alignmentScore(leftText, rightText) {
  const comparison = compareTexts(leftText, rightText);
  // 微弱的中性先验使不同语言的行保持单调对齐；
  // 暴露的对比分数仍然报告是否存在文本证据。
  return Number(Math.min(1, 0.18 + comparison.score * 0.74).toFixed(4));
}

function joinTextItems(items = []) {
  return items.filter(Boolean).map((item) => item.text || "").filter(Boolean).join("\n\n");
}

module.exports = {
  alignmentScore,
  bigrams,
  compactText,
  comparePrepared,
  compareTexts,
  joinTextItems,
  normalizeText,
  prepareText,
  setSimilarity,
};
