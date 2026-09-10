const sentenceEndings = new Set(["。", "．", ".", "！", "!", "？", "?"]);
const closingMarks = new Set(["」", "』", "）", ")", "】", "]", "”", "’"]);
const quoteClosers = new Map([["「", "」"], ["『", "』"]]);
const dialogueCuePattern = /(?:说|問|问|答|道|曰|喊|叫|回|回应|告訴|告诉|称|解释|補充|补充|言っ|言う|答え|尋ね|叫ん|呼びかけ|告げ|返事|said|asked|replied|answered|called|told|explained)\s*$/iu;

function trimRange(text, start, end) {
  let trimmedStart = start;
  let trimmedEnd = end;
  while (trimmedStart < trimmedEnd && /\s/u.test(text[trimmedStart])) trimmedStart += 1;
  while (trimmedEnd > trimmedStart && /\s/u.test(text[trimmedEnd - 1])) trimmedEnd -= 1;
  return { start: trimmedStart, end: trimmedEnd };
}

function unitForRange(paragraph, text, start, end, unitIndex, isQuotedDialogue = false) {
  const range = trimRange(text, start, end);
  if (range.start >= range.end) return null;
  return {
    id: `${paragraph.lang || "text"}:${paragraph.sourceIndex ?? 0}:${unitIndex}`,
    parentParagraphId: `${paragraph.lang || "text"}:${paragraph.sourceIndex ?? 0}`,
    sourceIndex: paragraph.sourceIndex ?? null,
    lang: paragraph.lang || "",
    chapter: paragraph.chapter || "",
    text: text.slice(range.start, range.end),
    startOffset: range.start,
    endOffset: range.end,
    isQuotedDialogue,
  };
}

function startsDialogue(text, start) {
  const prefix = text.slice(0, start).trim();
  if (!prefix) return true;
  const lastQuoteEnd = Math.max(prefix.lastIndexOf("」"), prefix.lastIndexOf("』"));
  if (lastQuoteEnd !== -1) {
    const between = prefix.slice(lastQuoteEnd + 1).trim();
    const hasFullStop = [...sentenceEndings].some((mark) => (mark === "。" || mark === "．" || mark === ".") && between.includes(mark));
    if (!hasFullStop && (/^[，,、\s]*$/u.test(between) || /[，,、：:\s]$/u.test(between) || dialogueCuePattern.test(between))) {
      return true;
    }
  }
  const lastSentenceEnd = Math.max(...[...sentenceEndings].map((mark) => prefix.lastIndexOf(mark)));
  const tail = prefix.slice(lastSentenceEnd + 1).trim();
  if (!tail) return true;
  if (/[：:]$/u.test(tail)) return true;
  return dialogueCuePattern.test(tail);
}

function isDialogueQuote(text, start, end) {
  const body = text.slice(start, end);
  const suffix = text.slice(end).trimStart();
  if (startsDialogue(text, start)) {
    if (!suffix) return true;
    if (/[。．.!！?？]/u.test(body)) return true;
    if (/^[。．.!！?？；;，,、]/u.test(suffix)) return true;
    return dialogueCuePattern.test(suffix.slice(0, 12));
  }
  if (!/[。．.!！?？]/u.test(body)) return false;
  if (!suffix || /^[。．.!！?？；;，,、]/u.test(suffix)) return true;
  return dialogueCuePattern.test(suffix.slice(0, 12));
}

function splitQuotedDialogueUnits(paragraph = {}) {
  const text = String(paragraph.text || "");
  const units = [];
  const stack = [];
  let start = -1;

  for (let index = 0; index < text.length; index += 1) {
    const closer = quoteClosers.get(text[index]);
    if (closer) {
      if (!stack.length) start = index;
      stack.push(closer);
      continue;
    }
    if (!stack.length || text[index] !== stack.at(-1)) continue;
    stack.pop();
    if (stack.length) continue;
    if (isDialogueQuote(text, start, index + 1)) {
      const unit = unitForRange(paragraph, text, start, index + 1, units.length, true);
      if (unit) units.push(unit);
    }
    start = -1;
  }

  return units;
}

function splitParagraphIntoLineUnits(paragraph = {}, options = {}) {
  const text = String(paragraph.text || "");
  if (options.quotedOnly) return splitQuotedDialogueUnits(paragraph);
  const units = [];
  let start = 0;

  const pushUnit = (end) => {
    const unit = unitForRange(paragraph, text, start, end, units.length);
    if (unit) units.push(unit);
    start = end;
  };

  for (let index = 0; index < text.length; index += 1) {
    if (!sentenceEndings.has(text[index])) continue;
    let end = index + 1;
    while (end < text.length && (sentenceEndings.has(text[end]) || closingMarks.has(text[end]))) end += 1;
    pushUnit(end);
    index = end - 1;
  }

  pushUnit(text.length);
  return units;
}

function splitRangeIntoLineUnits(paragraph, text, start, end, units) {
  let cursor = start;
  const pushUnit = (rangeEnd) => {
    const unit = unitForRange(paragraph, text, cursor, rangeEnd, units.length);
    if (unit) units.push(unit);
    cursor = rangeEnd;
  };

  for (let index = start; index < end; index += 1) {
    if (!sentenceEndings.has(text[index])) continue;
    let rangeEnd = index + 1;
    while (rangeEnd < end && (sentenceEndings.has(text[rangeEnd]) || closingMarks.has(text[rangeEnd]))) rangeEnd += 1;
    pushUnit(rangeEnd);
    index = rangeEnd - 1;
  }
  pushUnit(end);
}

function splitParagraphIntoContextUnits(paragraph = {}) {
  const text = String(paragraph.text || "");
  const quoted = splitQuotedDialogueUnits(paragraph);
  if (!quoted.length) return splitParagraphIntoLineUnits(paragraph);

  const units = [];
  let cursor = 0;
  for (const quote of quoted) {
    if (quote.startOffset > cursor) splitRangeIntoLineUnits(paragraph, text, cursor, quote.startOffset, units);
    // 保留完整发话及其稳定的源 ID；仅对叙述行进行句子切分。
    units.push(quote);
    cursor = quote.endOffset;
  }
  if (cursor < text.length) splitRangeIntoLineUnits(paragraph, text, cursor, text.length, units);
  return units.sort((left, right) => left.startOffset - right.startOffset);
}

function deriveLineUnits(paragraphs = [], options = {}) {
  return paragraphs.flatMap((paragraph) => splitParagraphIntoLineUnits(paragraph, options));
}

function deriveContextUnits(paragraphs = []) {
  return paragraphs.flatMap((paragraph) => splitParagraphIntoContextUnits(paragraph));
}

module.exports = {
  deriveContextUnits,
  deriveLineUnits,
  splitParagraphIntoContextUnits,
  splitQuotedDialogueUnits,
  splitParagraphIntoLineUnits,
};
