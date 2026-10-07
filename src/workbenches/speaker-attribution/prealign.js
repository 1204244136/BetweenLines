const {
  alignmentScore,
  compareTexts,
  joinTextItems,
} = require("./text-comparison");

const ALIGNMENT_VERSION = "monotonic-evidence-v5";
const NEGATIVE_INFINITY = -1e9;

function clampBand(sourceCount, parallelCount, requested) {
  const distance = Math.abs(sourceCount - parallelCount);
  const minimum = Math.max(18, distance + 8);
  const configured = Number.isFinite(Number(requested)) ? Number(requested) : minimum;
  return Math.max(minimum, Math.min(192, Math.round(configured)));
}

function centerFor(sourceIndex, sourceCount, parallelCount) {
  return Math.round((sourceIndex / Math.max(1, sourceCount)) * parallelCount);
}

function rangeFor(sourceIndex, sourceCount, parallelCount, band) {
  const center = centerFor(sourceIndex, sourceCount, parallelCount);
  return {
    lo: Math.max(0, center - band),
    hi: Math.min(parallelCount, center + band),
  };
}

function scoreSpan(source, parallelItems) {
  return alignmentScore(source?.text || "", joinTextItems(parallelItems));
}

// 一次配对在对齐路径上的段落偏移（对照侧段落序号 - 原文侧段落序号）；缺少序号时为 NaN。
function pathOffset(source, parallel) {
  const offset = Number(parallel?.sourceIndex) - Number(source?.sourceIndex);
  return Number.isFinite(offset) ? offset : NaN;
}

// baselineOffset 是对齐路径上最近一个配对点的段落偏移。距离按路径判断而不是比较全书段落序号的
// 绝对值：全书序号的差距会随译文拆段、译注、预处理删段一路累积，比较绝对值会在偏移超过阈值后
// 禁止所有正确配对，把每句原文配到错误的对照行上。路径上还没有配对点时只受搜索带宽约束。
function canMatchParallelItem(source, parallel, options = {}, baselineOffset = NaN) {
  if (!source || !parallel) return false;
  if (options.ignoreSourceIndex) return true;

  const sourceIndex = Number(source.sourceIndex);
  const parallelIndex = Number(parallel.sourceIndex);
  if (Number.isFinite(sourceIndex) && Number.isFinite(parallelIndex)) {
    if (!Number.isFinite(baselineOffset)) return true;
    const configuredGap = Number(options.maxMatchSourceGap);
    const maxGap = Number.isFinite(configuredGap) ? Math.max(0, Math.floor(configuredGap)) : 2;
    return Math.abs((parallelIndex - sourceIndex) - baselineOffset) <= maxGap;
  }

  const hasMetadata = "parentParagraphId" in source || "parentParagraphId" in parallel
    || "sourceIndex" in source || "sourceIndex" in parallel;
  return !hasMetadata;
}

function canMergeParallelItems(left, right, options = {}) {
  if (!left || !right) return false;

  // A split utterance may produce multiple units inside one target paragraph.
  if (left.parentParagraphId && left.parentParagraphId === right.parentParagraphId) return true;

  // 对未提供结构元数据的调用方保留旧的仅数组行为。
  // 真实的摄取单元始终携带段落/源索引，因此在生产环境中
  // 该 fallback 不会隐藏距离较远的段落。
  const hasMetadata = "parentParagraphId" in left || "parentParagraphId" in right
    || "sourceIndex" in left || "sourceIndex" in right;
  return !hasMetadata;
}

function reconstructMoves(sourceUnits, parallelUnits, traces, ranges) {
  const moves = [];
  let sourceIndex = sourceUnits.length;
  let parallelIndex = parallelUnits.length;

  while (sourceIndex > 0 || parallelIndex > 0) {
    const range = ranges[sourceIndex];
    const trace = traces[sourceIndex];
    const code = range && trace ? trace[parallelIndex - range.lo] : 0;

    if (code === 1 && sourceIndex > 0 && parallelIndex > 0) {
      moves.push({ source: sourceUnits[sourceIndex - 1], parallel: [parallelUnits[parallelIndex - 1]] });
      sourceIndex -= 1;
      parallelIndex -= 1;
      continue;
    }
    if (code === 2 && sourceIndex > 0 && parallelIndex > 1) {
      moves.push({
        source: sourceUnits[sourceIndex - 1],
        parallel: parallelUnits.slice(parallelIndex - 2, parallelIndex),
      });
      sourceIndex -= 1;
      parallelIndex -= 2;
      continue;
    }
    if (code === 3 && sourceIndex > 0) {
      moves.push({ source: sourceUnits[sourceIndex - 1], parallel: [] });
      sourceIndex -= 1;
      continue;
    }
    if (code === 4 && parallelIndex > 0) {
      moves.push({ source: null, parallel: [parallelUnits[parallelIndex - 1]] });
      parallelIndex -= 1;
      continue;
    }

    // 搜索带宽应包含终点。如果异常输入导致不可达状态，
    // 保持确定的恢复策略。
    if (sourceIndex > 0 && parallelIndex > 0) {
      moves.push({ source: sourceUnits[sourceIndex - 1], parallel: [parallelUnits[parallelIndex - 1]] });
      sourceIndex -= 1;
      parallelIndex -= 1;
    } else if (sourceIndex > 0) {
      moves.push({ source: sourceUnits[sourceIndex - 1], parallel: [] });
      sourceIndex -= 1;
    } else {
      moves.push({ source: null, parallel: [parallelUnits[parallelIndex - 1]] });
      parallelIndex -= 1;
    }
  }

  return moves.reverse();
}

function alignMonotonic(sourceUnits, parallelUnits, options = {}) {
  const sourceCount = sourceUnits.length;
  const parallelCount = parallelUnits.length;
  const band = clampBand(sourceCount, parallelCount, options.band);
  const gapPenalty = Number.isFinite(Number(options.gapPenalty)) ? Number(options.gapPenalty) : -0.10;
  const mergePenalty = Number.isFinite(Number(options.mergePenalty)) ? Number(options.mergePenalty) : -0.045;
  const traces = Array.from({ length: sourceCount + 1 }, () => null);
  const ranges = Array.from({ length: sourceCount + 1 }, () => null);
  let previous = null;
  let previousRange = null;
  let previousOffsets = null;

  for (let sourceIndex = 0; sourceIndex <= sourceCount; sourceIndex += 1) {
    const range = rangeFor(sourceIndex, sourceCount, parallelCount, band);
    const width = range.hi - range.lo + 1;
    const current = new Float64Array(width);
    current.fill(NEGATIVE_INFINITY);
    const trace = new Int8Array(width);
    // 每个状态沿最优路径记住最近一个配对点的段落偏移；NaN 表示路径上还没有配对。
    const offsets = new Float64Array(width);
    offsets.fill(NaN);

    for (let parallelIndex = range.lo; parallelIndex <= range.hi; parallelIndex += 1) {
      const offset = parallelIndex - range.lo;
      if (sourceIndex === 0 && parallelIndex === 0) {
        current[offset] = 0;
        continue;
      }

      let best = NEGATIVE_INFINITY;
      let code = 0;
      let bestOffset = NaN;
      const consider = (candidate, candidateCode, candidateOffset) => {
        if (candidate <= NEGATIVE_INFINITY / 2) return;
        // 分数相同时优先选择真实匹配，其次选择单行匹配，
        // 以免中性的跨语言先验产生不必要的未匹配行。
        if (candidate > best || (candidate === best && candidateCode < code)) {
          best = candidate;
          code = candidateCode;
          bestOffset = candidateOffset;
        }
      };

      if (previous && previousRange) {
        const inPrevious = (index) => index >= previousRange.lo && index <= previousRange.hi;
        const previousValue = (index) => (inPrevious(index) ? previous[index - previousRange.lo] : NEGATIVE_INFINITY);
        const previousOffset = (index) => (inPrevious(index) ? previousOffsets[index - previousRange.lo] : NaN);
        if (sourceIndex > 0) {
          consider(previousValue(parallelIndex) + gapPenalty, 3, previousOffset(parallelIndex));
          if (parallelIndex > 0) {
            const source = sourceUnits[sourceIndex - 1];
            const parallel = parallelUnits[parallelIndex - 1];
            if (canMatchParallelItem(source, parallel, options, previousOffset(parallelIndex - 1))) {
              consider(previousValue(parallelIndex - 1) + scoreSpan(source, [parallel]), 1, pathOffset(source, parallel));
            }
          }
          const mergeBaseline = parallelIndex > 1 ? previousOffset(parallelIndex - 2) : NaN;
          if (options.allowMergedParallel === true
            && parallelIndex > 1
            && canMergeParallelItems(parallelUnits[parallelIndex - 2], parallelUnits[parallelIndex - 1], options)
            && canMatchParallelItem(sourceUnits[sourceIndex - 1], parallelUnits[parallelIndex - 2], options, mergeBaseline)
            && canMatchParallelItem(sourceUnits[sourceIndex - 1], parallelUnits[parallelIndex - 1], options, mergeBaseline)) {
            const source = sourceUnits[sourceIndex - 1];
            consider(
              previousValue(parallelIndex - 2) + scoreSpan(source, parallelUnits.slice(parallelIndex - 2, parallelIndex)) + mergePenalty,
              2,
              pathOffset(source, parallelUnits[parallelIndex - 1]),
            );
          }
        }
      }

      if (offset > 0) consider(current[offset - 1] + gapPenalty, 4, offsets[offset - 1]);
      current[offset] = best;
      trace[offset] = code;
      offsets[offset] = bestOffset;
    }

    traces[sourceIndex] = trace;
    ranges[sourceIndex] = range;
    previous = current;
    previousRange = range;
    previousOffsets = offsets;
  }

  return reconstructMoves(sourceUnits, parallelUnits, traces, ranges);
}

function describeMove(move, options = {}) {
  const sourceText = move.source?.text || "";
  const parallelText = joinTextItems(move.parallel);
  const comparison = sourceText && parallelText
    ? compareTexts(sourceText, parallelText)
    : null;
  let status = "aligned-low-confidence";
  let score = 0;
  let relation = `${move.source ? 1 : 0}:${move.parallel.length}`;
  if (!move.source) {
    status = "unmatched-parallel";
    relation = `0:${move.parallel.length}`;
  } else if (!move.parallel.length) {
    status = "unmatched-source";
    relation = "1:0";
  } else {
    score = alignmentScore(sourceText, parallelText);
    const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.62;
    status = comparison.score >= threshold ? "aligned" : "aligned-low-confidence";
  }
  return {
    source: move.source,
    parallel: move.parallel,
    alignment: {
      status,
      score,
      relation,
      confidence: comparison?.confidence || "none",
      comparison,
    },
  };
}

function prealignLineUnits(sourceUnits = [], parallelUnits = [], options = {}) {
  if (!sourceUnits.length && !parallelUnits.length) {
    return {
      version: ALIGNMENT_VERSION,
      required: true,
      performed: true,
      rows: [],
      sourceCount: 0,
      parallelCount: 0,
      unmatchedSource: 0,
      unmatchedParallel: 0,
      lowConfidence: 0,
    };
  }

  if (!sourceUnits.length) {
    const rows = parallelUnits.map((parallel) => describeMove({ source: null, parallel: [parallel] }, options));
    return {
      version: ALIGNMENT_VERSION,
      required: true,
      performed: true,
      rows,
      sourceCount: 0,
      parallelCount: parallelUnits.length,
      unmatchedSource: 0,
      unmatchedParallel: parallelUnits.length,
      lowConfidence: 0,
      band: clampBand(0, parallelUnits.length, options.band),
    };
  }

  if (!parallelUnits.length) {
    const rows = sourceUnits.map((source) => describeMove({ source, parallel: [] }, options));
    return {
      version: ALIGNMENT_VERSION,
      required: true,
      performed: true,
      rows,
      sourceCount: sourceUnits.length,
      parallelCount: 0,
      unmatchedSource: sourceUnits.length,
      unmatchedParallel: 0,
      lowConfidence: 0,
      band: clampBand(sourceUnits.length, 0, options.band),
    };
  }

  const rows = alignMonotonic(sourceUnits, parallelUnits, options).map((move) => describeMove(move, options));
  return {
    version: ALIGNMENT_VERSION,
    required: true,
    performed: true,
    rows,
    sourceCount: sourceUnits.length,
    parallelCount: parallelUnits.length,
    unmatchedSource: rows.filter((row) => row.alignment.status === "unmatched-source").length,
    unmatchedParallel: rows
      .filter((row) => row.alignment.status === "unmatched-parallel")
      .reduce((sum, row) => sum + row.parallel.length, 0),
    lowConfidence: rows.filter((row) => row.alignment.status === "aligned-low-confidence").length,
    band: clampBand(sourceUnits.length, parallelUnits.length, options.band),
  };
}

module.exports = {
  ALIGNMENT_VERSION,
  alignMonotonic,
  prealignLineUnits,
};
