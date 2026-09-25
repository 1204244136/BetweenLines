const { toCn } = require("../../ingest/text-utils");
const { bigramSet, jaccard } = require("../../core/text-helpers");
const { loadJpGroupAlignmentList, loadJpPivotLang } = require("./alignment-artifact");

function normalizeZh(text) {
  return toCn(text)
    .toLowerCase()
    .replace(/[「」『』“”‘’（）()【】《》〈〉—\-─…、，。！？：；,.!?;:\s0-9a-z]/g, "");
}

// 归一化口径（normalizeZh）是本模块的业务约定，决定两份非原文文本的对齐分数；二元组与 Jaccard 用共享实现。
function similarity(a, b) {
  return jaccard(bigramSet(normalizeZh(a)), bigramSet(normalizeZh(b)));
}

function lengthScore(a, b) {
  const aLen = Math.max(1, Array.from(normalizeZh(a)).length);
  const bLen = Math.max(1, Array.from(normalizeZh(b)).length);
  return Math.min(aLen, bLen) / Math.max(aLen, bLen);
}

function paragraphScore(a, b) {
  if (!a || !b) return 0;
  return (similarity(a, b) * 0.72) + (lengthScore(a, b) * 0.28);
}

function splitComparableUnits(text) {
  const normalized = String(text || "").replace(/\r\n?/g, "\n");
  const sentenceEnd = new Set(["。", "！", "？", "!", "?"]);
  const closers = new Set(["」", "』", "）", ")", "】"]);
  const units = [];
  let buffer = "";

  for (let i = 0; i < normalized.length; i += 1) {
    const char = normalized[i];
    buffer += char;
    if (!sentenceEnd.has(char)) continue;

    while (i + 1 < normalized.length && (sentenceEnd.has(normalized[i + 1]) || closers.has(normalized[i + 1]))) {
      i += 1;
      buffer += normalized[i];
    }

    const trimmed = buffer.trim();
    if (trimmed) units.push(trimmed);
    buffer = "";
  }

  const tail = buffer.trim();
  if (tail) units.push(tail);
  return units;
}

function makeFragmentItem(text, base) {
  return {
    sourceIndex: base?.sourceIndex ?? null,
    lang: base?.lang || "",
    chapter: base?.chapter || "",
    text,
    cnText: base?.lang === "tw" ? toCn(text) : text,
    chars: Array.from(text).length,
  };
}

function splitGroupItems(items) {
  const result = [];
  for (const item of items) {
    const units = splitComparableUnits(item.text);
    if (units.length <= 1) {
      result.push(item);
      continue;
    }
    for (const unit of units) result.push(makeFragmentItem(unit, item));
  }
  return result;
}

function joinTexts(items, field = "text") {
  return items.filter(Boolean).map((item) => item[field] || "").filter(Boolean).join("\n\n");
}

function sumChars(items) {
  return items.filter(Boolean).reduce((sum, item) => sum + (item.chars || 0), 0);
}

function groupText(items, lang) {
  if (lang === "twCn") return joinTexts(items, "cnText");
  return joinTexts(items, "text");
}

function groupScore(left, right) {
  if (!left.length || !right.length) return -0.22;
  const score = paragraphScore(groupText(left, "cn"), groupText(right, "twCn"));
  const mergePenalty = 0.03 * Math.max(0, left.length + right.length - 2);
  return score - mergePenalty;
}

function textLengthForAnchor(text) {
  return Array.from(normalizeZh(text)).length;
}

function bestRightForLeft(left, right, i, radius) {
  let best = null;
  const start = Math.max(0, i - radius);
  const end = Math.min(right.length - 1, i + radius);
  for (let j = start; j <= end; j += 1) {
    const score = paragraphScore(left[i].text, right[j].cnText);
    if (!best || score > best.score) best = { j, score };
  }
  return best;
}

function bestLeftForRight(left, right, j, radius) {
  let best = null;
  const start = Math.max(0, j - radius);
  const end = Math.min(left.length - 1, j + radius);
  for (let i = start; i <= end; i += 1) {
    const score = paragraphScore(left[i].text, right[j].cnText);
    if (!best || score > best.score) best = { i, score };
  }
  return best;
}

function findLocalAnchors(left, right, radius = 6) {
  const anchors = [];
  let lastI = -1;
  let lastJ = -1;

  for (let i = 0; i < left.length; i += 1) {
    if (textLengthForAnchor(left[i].text) < 10) continue;
    const bestRight = bestRightForLeft(left, right, i, radius);
    if (!bestRight || bestRight.score < 0.34) continue;
    if (textLengthForAnchor(right[bestRight.j].cnText) < 10) continue;

    const bestLeft = bestLeftForRight(left, right, bestRight.j, radius);
    if (!bestLeft || bestLeft.i !== i) continue;
    if (i <= lastI || bestRight.j <= lastJ) continue;

    anchors.push({ i, j: bestRight.j, score: bestRight.score });
    lastI = i;
    lastJ = bestRight.j;
  }

  return anchors;
}

function alignGroupsCore(left, right, band = 60) {
  const n = left.length;
  const m = right.length;
  const moves = [[1, 1], [1, 2], [2, 1], [2, 2], [1, 0], [0, 1]];
  const neg = -1e9;
  const dp = Array.from({ length: n + 1 }, () => new Float32Array(m + 1).fill(neg));
  const trace = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => null));

  dp[0][0] = 0;
  for (let i = 0; i <= n; i += 1) {
    const expected = Math.round((i / Math.max(1, n)) * m);
    const jStart = Math.max(0, expected - band);
    const jEnd = Math.min(m, expected + band);

    for (let j = jStart; j <= jEnd; j += 1) {
      if (dp[i][j] <= neg / 2) continue;

      for (const [li, rj] of moves) {
        const ni = i + li;
        const nj = j + rj;
        if (ni > n || nj > m) continue;

        const nextExpected = Math.round((ni / Math.max(1, n)) * m);
        if (Math.abs(nj - nextExpected) > band) continue;

        const score = groupScore(left.slice(i, ni), right.slice(j, nj));
        const candidate = dp[i][j] + score;
        if (candidate > dp[ni][nj]) {
          dp[ni][nj] = candidate;
          trace[ni][nj] = [li, rj, score];
        }
      }
    }
  }

  const groups = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    let step = trace[i][j];
    if (!step) {
      step = i > 0 && j > 0 ? [1, 1, groupScore(left.slice(i - 1, i), right.slice(j - 1, j))]
        : i > 0 ? [1, 0, groupScore(left.slice(i - 1, i), [])]
          : [0, 1, groupScore([], right.slice(j - 1, j))];
    }

    const [li, rj, score] = step;
    const leftStart = i - li;
    const rightStart = j - rj;
    groups.push({
      left: left.slice(leftStart, i),
      right: right.slice(rightStart, j),
      score,
      relation: `${li}:${rj}`,
    });
    i = leftStart;
    j = rightStart;
  }

  return groups.reverse();
}

function alignGroups(left, right, band = 60) {
  const anchors = findLocalAnchors(left, right);
  if (!anchors.length) return alignGroupsCore(left, right, band);

  const groups = [];
  let leftStart = 0;
  let rightStart = 0;

  for (const anchor of anchors) {
    if (anchor.i > leftStart || anchor.j > rightStart) {
      groups.push(...alignGroupsCore(left.slice(leftStart, anchor.i), right.slice(rightStart, anchor.j), band));
    }
    groups.push({
      left: [left[anchor.i]],
      right: [right[anchor.j]],
      score: anchor.score,
      relation: "1:1",
    });
    leftStart = anchor.i + 1;
    rightStart = anchor.j + 1;
  }

  if (leftStart < left.length || rightStart < right.length) {
    groups.push(...alignGroupsCore(left.slice(leftStart), right.slice(rightStart), band));
  }

  return groups;
}

function mergePivotOrphanGroups(groups, pivotLang) {
  const result = [];
  for (let idx = 0; idx < groups.length; idx += 1) {
    const group = groups[idx];
    const isOrphan = groupPivotStart(group, pivotLang) == null;
    if (!isOrphan) {
      result.push({ ...group });
      continue;
    }
    // 孤儿组：pivot 方段落为空（如 pivotLang 为 cn 时的 0:1 组，或 pivotLang 为 tw 时的 1:0 组）
    // 必须并入相邻的有 pivot 坐标的组，绝不能丢弃非 pivot 侧的真实译文段落
    if (idx + 1 < groups.length && groupPivotStart(groups[idx + 1], pivotLang) != null) {
      const next = groups[idx + 1];
      next.left = [...group.left, ...next.left];
      next.right = [...group.right, ...next.right];
      next.cnStart = next.left[0]?.sourceIndex ?? null;
      next.cnEnd = next.left.length ? next.left[next.left.length - 1].sourceIndex + 1 : null;
      next.twStart = next.right[0]?.sourceIndex ?? null;
      next.twEnd = next.right.length ? next.right[next.right.length - 1].sourceIndex + 1 : null;
      next.relation = `${next.left.length}:${next.right.length}`;
    } else if (result.length > 0) {
      const prev = result[result.length - 1];
      prev.left = [...prev.left, ...group.left];
      prev.right = [...prev.right, ...group.right];
      prev.cnStart = prev.left[0]?.sourceIndex ?? null;
      prev.cnEnd = prev.left.length ? prev.left[prev.left.length - 1].sourceIndex + 1 : null;
      prev.twStart = prev.right[0]?.sourceIndex ?? null;
      prev.twEnd = prev.right.length ? prev.right[prev.right.length - 1].sourceIndex + 1 : null;
      prev.relation = `${prev.left.length}:${prev.right.length}`;
    }
  }
  return result;
}

function alignRows(cn, tw, jp, comparisonMode = "trilingual") {
  const bilingual = comparisonMode === "bilingual";
  // 双语模式只有一份译文：不伪造 cn↔tw 对齐组，每个主文本段落直接作为技术 pivot 单元。
  const rawCnTw = bilingual
    ? cn.map((item) => ({
        left: [item],
        right: [],
        score: 0,
        relation: "1:0",
        cnStart: item.sourceIndex,
        cnEnd: item.sourceIndex + 1,
        twStart: null,
        twEnd: null,
      }))
    : alignGroups(cn, tw).map((group) => ({
        ...group,
        cnStart: group.left[0]?.sourceIndex ?? null,
        cnEnd: group.left.length ? group.left[group.left.length - 1].sourceIndex + 1 : null,
        twStart: group.right[0]?.sourceIndex ?? null,
        twEnd: group.right.length ? group.right[group.right.length - 1].sourceIndex + 1 : null,
      }));
  const pivotLang = loadJpPivotLang(comparisonMode);
  const cnTw = bilingual ? rawCnTw : mergePivotOrphanGroups(rawCnTw, pivotLang);
  const jpPivotGroups = loadJpGroupAlignmentList(jp);
  const rows = [];

  for (let i = 0; i < cnTw.length;) {
    const firstGroup = cnTw[i];
    const firstStart = groupPivotStart(firstGroup, pivotLang);
    const firstEnd = groupPivotEnd(firstGroup, pivotLang);
    if (firstStart == null || firstEnd == null) {
      i += 1;
      continue;
    }

    const firstJpGroups = jpPivotGroups.filter((group) => rangesOverlap(firstStart, firstEnd, group.pivotStart, group.pivotEnd));
    if (!firstJpGroups.length) {
      i += 1;
      continue;
    }

    let unionStart = Math.min(firstStart, ...firstJpGroups.map((group) => group.pivotStart));
    let unionEnd = Math.max(firstEnd, ...firstJpGroups.map((group) => group.pivotEnd));
    let endIndex = i + 1;
    let changed = true;

    while (changed) {
      changed = false;
      for (const jpGroup of jpPivotGroups) {
        if (rangesOverlap(unionStart, unionEnd, jpGroup.pivotStart, jpGroup.pivotEnd)) {
          const nextStart = Math.min(unionStart, jpGroup.pivotStart);
          const nextEnd = Math.max(unionEnd, jpGroup.pivotEnd);
          if (nextStart !== unionStart || nextEnd !== unionEnd) {
            unionStart = nextStart;
            unionEnd = nextEnd;
            changed = true;
          }
        }
      }

      while (endIndex < cnTw.length) {
        const nextGroup = cnTw[endIndex];
        const nextStart = groupPivotStart(nextGroup, pivotLang);
        const nextEnd = groupPivotEnd(nextGroup, pivotLang);
        if (nextStart == null || nextEnd == null) {
          endIndex += 1;
          continue;
        }
        if (nextStart >= unionEnd) break;
        unionStart = Math.min(unionStart, nextStart);
        unionEnd = Math.max(unionEnd, nextEnd);
        endIndex += 1;
        changed = true;
      }
    }

    const cnGroups = cnTw.slice(i, endIndex)
      .filter((group) => groupPivotStart(group, pivotLang) != null && groupPivotEnd(group, pivotLang) != null)
      .filter((group) => rangesOverlap(groupPivotStart(group, pivotLang), groupPivotEnd(group, pivotLang), unionStart, unionEnd));
    const jpGroups = jpPivotGroups.filter((group) => rangesOverlap(unionStart, unionEnd, group.pivotStart, group.pivotEnd));
    if (jpGroups.length) {
      rows.push(makeRow(rows.length + 1, cnGroups, jpGroups, comparisonMode));
    }
    i = endIndex;
  }

  return rows;
}

function groupPivotStart(group, pivotLang) {
  return pivotLang === "cn" ? group.cnStart : group.twStart;
}

function groupPivotEnd(group, pivotLang) {
  return pivotLang === "cn" ? group.cnEnd : group.twEnd;
}

function makeRow(index, cnGroups, jpGroups, comparisonMode = "trilingual") {
    const bilingual = comparisonMode === "bilingual";
    const cnItems = cnGroups.flatMap((group) => group.left);
    const jpItems = uniqueBySourceIndex(jpGroups.flatMap((group) => group.items));
    const jpText = joinTexts(jpItems, "text");
    const jpRelation = relationSummary(jpGroups, "items", "pivotItems");
    const jpScore = average(jpGroups.map((group) => group.score));

    if (bilingual) {
      // 双语模式：cn 是唯一译文，不生成第三列文本、繁简对照、字符数和细分对齐副产物。
      return {
        index,
        chapter: cnItems[0]?.chapter || jpItems[0]?.chapter || "",
        relation: `原文-译文 ${jpRelation}`,
        jp: jpText,
        jpAlignScore: jpGroups.length ? jpScore : null,
        cn: groupText(cnItems, "cn"),
        score: jpScore,
        cnChars: sumChars(cnItems),
        jpChars: sumChars(jpItems),
      };
    }

    const twItems = cnGroups.flatMap((group) => group.right);
    const cnText = groupText(cnItems, "cn");
    const twText = groupText(twItems, "tw");
    const twCnText = groupText(twItems, "twCn");
    const baseScore = cnText && twCnText ? paragraphScore(cnText, twCnText) : 0;
    const refined = refineLowConfidenceGroups(cnItems, twItems, baseScore);
    const cnRelation = refined ? `细分 ${refined.relation}` : relationSummary(cnGroups, "left", "right");

    return {
      index,
      chapter: cnItems[0]?.chapter || twItems[0]?.chapter || jpItems[0]?.chapter || "",
      relation: `简台 ${cnRelation}${jpRelation ? ` / 日文 ${jpRelation}` : ""}`,
      jp: jpText,
      jpAlignScore: jpGroups.length ? jpScore : null,
      cn: refined?.cnText ?? cnText,
      tw: refined?.twText ?? twText,
      twCn: refined?.twCnText ?? twCnText,
      score: refined?.score ?? baseScore,
      refinedScore: refined?.averageMatched ?? null,
      cnChars: sumChars(cnItems),
      twChars: sumChars(twItems),
      jpChars: sumChars(jpItems),
    };
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

function uniqueBySourceIndex(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    if (!item || seen.has(item.sourceIndex)) continue;
    seen.add(item.sourceIndex);
    result.push(item);
  }
  return result;
}

function relationSummary(groups, leftKey, rightKey) {
  const leftCount = groups.reduce((sum, group) => sum + group[leftKey].length, 0);
  const rightCount = groups.reduce((sum, group) => sum + group[rightKey].length, 0);
  if (groups.length === 1 && groups[0].relation) return groups[0].relation;
  return `${leftCount}:${rightCount}`;
}

function refineLowConfidenceGroups(cnItems, twItems, baseScore) {
  if (baseScore >= 0.22 || !cnItems.length || !twItems.length) return null;

  const cnFragments = splitGroupItems(cnItems);
  const twFragments = splitGroupItems(twItems);
  if (cnFragments.length === cnItems.length && twFragments.length === twItems.length) return null;
  if (cnFragments.length > 8 || twFragments.length > 8) return null;

  const refinedGroups = alignGroupsCore(cnFragments, twFragments, 8);
  const refinedScore = paragraphScore(groupText(cnFragments, "cn"), groupText(twFragments, "twCn"));
  const matchedScores = refinedGroups
    .filter((group) => group.left.length && group.right.length)
    .map((group) => paragraphScore(groupText(group.left, "cn"), groupText(group.right, "twCn")));
  const averageMatched = average(matchedScores) ?? 0;

  if (averageMatched < Math.max(0.26, baseScore + 0.12)) return null;

  return {
    groups: refinedGroups,
    score: refinedScore,
    relation: relationSummary(refinedGroups, "left", "right"),
    cnText: groupText(cnFragments, "cn"),
    twText: groupText(twFragments, "tw"),
    twCnText: groupText(twFragments, "twCn"),
    averageMatched,
  };
}

function average(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

module.exports = { alignRows };
