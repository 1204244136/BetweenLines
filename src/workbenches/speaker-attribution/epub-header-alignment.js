const path = require("path");
const { splitParagraphs } = require("../../ingest/text-utils");
const { deriveContextUnits, deriveLineUnits } = require("../../ingest/line-units");
const { ALIGNMENT_VERSION, prealignLineUnits } = require("./prealign");

const HEADER_ANCHORED_ALIGNMENT_VERSION = "header-anchored-monotonic-v4";
const HEADER_PATTERNS = [
  /(S\d+_\d+[a-z]?(?:_\d+)?-\d+)/i,
  /(S\d+_\d+[a-z]?_\d+-[A-Za-z][A-Za-z0-9_]*)/i,
  /(S\d+_\d+[a-z]?-[A-Za-z][A-Za-z0-9_]*)/i,
  /(S6_\d+\.\d+\.\d+-(?:\d+|[A-Za-z][A-Za-z0-9_]*))/i,
  /(S6_\d+\.\d+\.\d+)/i,
];
const PACKAGING_SUFFIX = /-(?:cover|back_cover|illustrations|information|introduction|note|special|navigation|contents|toc|colophon|copyright|afterwords?)$/i;
const PACKAGING_FILE_PATTERN = /-(?:cover|back_cover|illustrations|information|introduction|note|special|navigation|contents|toc|colophon|copyright)$/i;
const AFTERWORDS_FILE_PATTERN = /(?:[-_]afterwords?|[-_]後記|[-_]あとがき)(?:_p-\d+)?$/i;

function stableEpubHeader(filePath) {
  const base = path.posix.basename(String(filePath || "")).replace(/\.[^.]+$/, "");
  for (const pattern of HEADER_PATTERNS) {
    const match = base.match(pattern);
    if (!match) continue;
    return match[1]
      .replace(/(?:_p(?:-\d+)?|_chapter\d*|_afterwords?)$/i, "")
      .toUpperCase();
  }
  return "";
}

function isSpeakerBodyDocument(document, header) {
  if (!String(document?.text || "").trim()) return false;
  const base = path.posix.basename(String(document.path || "")).replace(/\.[^.]+$/, "");
  if (AFTERWORDS_FILE_PATTERN.test(base)) return false;
  if (PACKAGING_FILE_PATTERN.test(base) || PACKAGING_SUFFIX.test(header)) return false;
  if (document.bodySelected === false) return false;
  if (document.bodySelected === true) return true;
  return Boolean(document.isBodyCandidate && !document.isStructuralOnly && !document.isHardEndBoundary);
}

function chapterLabel(document, paragraph, header) {
  const documentLabel = header || document.labels?.[0] || `正文 ${document.spineIndex + 1}`;
  if (paragraph.chapter && paragraph.chapter !== "正文") return `${documentLabel} · ${paragraph.chapter}`;
  return documentLabel;
}

function createEpubUnitBlocks(documents = [], language = "und") {
  let sourceIndex = 0;
  const blocks = [];
  const paragraphs = [];
  const units = [];
  const contextUnits = [];

  for (const document of documents) {
    const header = stableEpubHeader(document.path);
    if (!isSpeakerBodyDocument(document, header)) continue;
    const documentParagraphs = splitParagraphs(document.text, language).map((paragraph) => ({
      ...paragraph,
      sourceIndex: sourceIndex++,
      chapter: chapterLabel(document, paragraph, header),
    }));
    const documentContextUnits = deriveContextUnits(documentParagraphs).map((unit) => ({
      ...unit,
      header,
      spineIndex: document.spineIndex,
    }));
    const documentUnits = deriveLineUnits(documentParagraphs, { quotedOnly: true }).map((unit) => ({
      ...unit,
      header,
      spineIndex: document.spineIndex,
    }));
    paragraphs.push(...documentParagraphs);
    contextUnits.push(...documentContextUnits);
    if (!documentUnits.length) continue;
    const block = {
      header,
      spineIndex: document.spineIndex,
      labels: document.labels || [],
      paragraphs: documentParagraphs,
      units: documentUnits,
    };
    blocks.push(block);
    units.push(...documentUnits);
  }

  return { blocks, paragraphs, units, contextUnits };
}

function coalesceHeaderBlocks(blocks = [], side) {
  const byHeader = new Map();
  const segments = [];

  for (const block of blocks) {
    if (!block.header) {
      segments.push({ key: `${side}:${block.spineIndex}`, header: "", units: block.units });
      continue;
    }
    let segment = byHeader.get(block.header);
    if (!segment) {
      segment = { key: block.header, header: block.header, units: [] };
      byHeader.set(block.header, segment);
      segments.push(segment);
    }
    segment.units.push(...block.units);
  }

  return { segments, byHeader };
}

function summarizeRows(rows, sourceCount, parallelCount, extra = {}) {
  return {
    required: true,
    performed: true,
    rows,
    sourceCount,
    parallelCount,
    unmatchedSource: rows.filter((row) => row.alignment.status === "unmatched-source").length,
    unmatchedParallel: rows
      .filter((row) => row.alignment.status === "unmatched-parallel")
      .reduce((sum, row) => sum + row.parallel.length, 0),
    lowConfidence: rows.filter((row) => row.alignment.status === "aligned-low-confidence").length,
    ...extra,
  };
}

function prealignEpubHeaderBlocks(sourceBlocks = [], parallelBlocks = [], options = {}) {
  const source = coalesceHeaderBlocks(sourceBlocks, "source");
  const parallel = coalesceHeaderBlocks(parallelBlocks, "parallel");
  const sharedHeaders = source.segments
    .map((segment) => segment.header)
    .filter((header) => header && parallel.byHeader.has(header));
  const sourceUnits = sourceBlocks.flatMap((block) => block.units);
  const parallelUnits = parallelBlocks.flatMap((block) => block.units);

  if (!sharedHeaders.length) {
    const fallback = prealignLineUnits(sourceUnits, parallelUnits, options);
    return {
      ...fallback,
      headerAnchors: {
        strategy: "global-fallback",
        matched: 0,
        sourceBlocks: source.segments.length,
        parallelBlocks: parallel.segments.length,
      },
    };
  }

  const rows = [];
  const consumedParallel = new Set();
  // sourceIndex 在 EPUB 单元中是跨文件的全局段落索引；进入同一稳定表头
  // 后，前置文件数量差异不应阻止单调对齐。表头已经提供了更强的范围约束。
  const segmentOptions = { ...options, ignoreSourceIndex: true };
  for (const sourceSegment of source.segments) {
    const parallelSegment = sourceSegment.header ? parallel.byHeader.get(sourceSegment.header) : null;
    if (parallelSegment) {
      rows.push(...prealignLineUnits(sourceSegment.units, parallelSegment.units, segmentOptions).rows);
      consumedParallel.add(parallelSegment.key);
    } else {
      rows.push(...prealignLineUnits(sourceSegment.units, [], segmentOptions).rows);
    }
  }
  for (const parallelSegment of parallel.segments) {
    if (consumedParallel.has(parallelSegment.key)) continue;
    rows.push(...prealignLineUnits([], parallelSegment.units, segmentOptions).rows);
  }

  return summarizeRows(rows, sourceUnits.length, parallelUnits.length, {
    version: HEADER_ANCHORED_ALIGNMENT_VERSION,
    headerAnchors: {
      strategy: "stable-xhtml-header",
      matched: sharedHeaders.length,
      sourceBlocks: source.segments.length,
      parallelBlocks: parallel.segments.length,
    },
  });
}

module.exports = {
  ALIGNMENT_VERSION,
  HEADER_ANCHORED_ALIGNMENT_VERSION,
  createEpubUnitBlocks,
  prealignEpubHeaderBlocks,
  stableEpubHeader,
};
