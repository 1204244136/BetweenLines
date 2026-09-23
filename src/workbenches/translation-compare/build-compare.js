const fs = require("fs");
const path = require("path");
const { outputDir, toCn, loadParagraphs } = require("../../ingest/text-utils");
const { resolveInputSelection, activeLangs, defaultDisplayLabels } = require("../../ingest/input-selection");
const { providerDefaults, proofreadPromptFor, errorCircuitBreaker, listProfiles, normalizeGrade } = require("./ai/ai-proofread");
const { buildPersonaSystemPrompt } = require("./ai/persona-runtime");
const { buildSpeechHabitLayer } = require("./speech-habit-layer");
const { TERM_LAYER_VERSION, buildTermLayer, describeTermLayerEntry } = require("./term-layer");
const { createProjectContext, rowSignature } = require("../../core/project-context");
const { publishProject } = require("../../storage/project-store");
const { createNotesTools } = require("./notes-spaces");
const { createPresetTools } = require("./ai-presets");
const { bigramSet, escapeHtml, jaccard, safeJson } = require("../../core/text-helpers");
const { reportProgress } = require("../../core/progress");

function readWorkbenchAssets() {
  const publicDir = path.join(__dirname, "..", "..", "..", "public");
  return {
    workbenchStyle: fs.readFileSync(path.join(publicDir, "workbench-style.css"), "utf8"),
    aiPanelStyle: fs.readFileSync(path.join(publicDir, "ai-panel.css"), "utf8"),
    workbenchShared: fs.readFileSync(path.join(publicDir, "workbench-shared.js"), "utf8"),
    workbenchClient: fs.readFileSync(path.join(publicDir, "workbench-client.js"), "utf8"),
  };
}

const initialWorkbenchAssets = readWorkbenchAssets();
const workbenchStyle = initialWorkbenchAssets.workbenchStyle;
const aiPanelStyle = initialWorkbenchAssets.aiPanelStyle;
const workbenchShared = initialWorkbenchAssets.workbenchShared;
const workbenchClient = initialWorkbenchAssets.workbenchClient;

function resolveModelOptions(models, selected = "") {
  const values = [];
  const seen = new Set();
  for (const model of models || []) {
    const value = String(typeof model === "string" ? model : model?.id || "").trim();
    if (!value || value === "custom" || seen.has(value)) continue;
    seen.add(value);
    values.push(value);
  }

  const current = String(selected || "").trim();
  return {
    models: values,
    options: [...values, "custom"],
    selected: seen.has(current) ? current : values[0] || "custom",
  };
}

function normalizeApiBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// 备注空间键随 projectKey / rowsSignature 变化后，历史备注只能按内容重新对应到当前行。
function alignLegacyNotes(entries, rows) {
  const normalize = (value) => String(value ?? "").replace(/\s+/g, "");
  const signatureTargets = new Map();
  const textTargets = new Map();
  const rowIndexes = new Set();
  const rowByIndex = new Map();
  const addUnique = (map, key, index) => {
    if (!map.has(key)) map.set(key, index);
    else if (map.get(key) !== index) map.set(key, null);
  };
  for (const row of rows || []) {
    if (!Number.isInteger(row?.index)) continue;
    rowIndexes.add(row.index);
    rowByIndex.set(row.index, row);
    const signature = String(row.signature || "");
    if (signature) addUnique(signatureTargets, signature, row.index);
    for (const column of ["cn", "tw", "twCn"]) {
      const text = normalize(row[column]);
      if (!text) continue;
      addUnique(textTargets, text, row.index);
    }
  }

  const total = (entries || []).length;
  const sourceSignatures = new Map();
  for (const entry of entries || []) {
    if (entry?.signature) sourceSignatures.set(entry.signature, (sourceSignatures.get(entry.signature) || 0) + 1);
  }
  const used = new Set();
  const pairs = [];
  const remaining = [];
  for (const entry of entries || []) {
    const from = Number(entry?.from);
    if (!Number.isInteger(from)) continue;
    const signature = String(entry.signature || "");
    const target = signature ? signatureTargets.get(signature) : undefined;
    if (target != null && sourceSignatures.get(signature) === 1 && !used.has(target)) {
      used.add(target);
      pairs.push({ from, to: target });
      continue;
    }
    remaining.push({ from, text: normalize(entry.text), signature });
  }
  const signaturePairs = pairs.slice();
  const anchors = [];
  for (const item of remaining) {
    if (item.text.length < 12) continue;
    const to = textTargets.get(item.text);
    if (to != null && !used.has(to)) anchors.push({ from: item.from, to });
  }
  const monotonic = [];
  const anchorTargets = new Map();
  for (const anchor of anchors) anchorTargets.set(anchor.to, (anchorTargets.get(anchor.to) || 0) + 1);
  for (const anchor of anchors.sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (anchorTargets.get(anchor.to) !== 1) continue;
    if (!monotonic.length || anchor.to > monotonic.at(-1).to) monotonic.push(anchor);
  }
  // 记录自带的「修改结果」与目标行正文逐字相同（且这段文本在当前行集里只属于那一行）时，
  // 那一行现在的正文就是人工批准并写回的成品——这是文本证据，不是行序推断。
  // 短文本只有在「本来就在这一行号上」时才够格：行号相同 + 正文逐字相同，两条独立证据互相钉住；
  // 换了行号的位置推断才需要长文本，免得一句「所有人。」把记录搬到别的行上。
  const textEvidence = (item, to) => item.text.length > 0 && textTargets.get(item.text) === to
    && (to === item.from || item.text.length >= 12);
  const aligned = [];
  // 少量长文本偶然相同不足以证明这份备注属于当前行集，宁可不找回。
  if (monotonic.length >= 3) {
    const offsetAt = (from) => {
      let before = null;
      let after = null;
      for (const anchor of monotonic) {
        if (anchor.from <= from) before = anchor;
        if (anchor.from >= from && !after) after = anchor;
      }
      if (!before || !after) return null;
      if (before === after) return before.to - before.from;
      const beforeOffset = before.to - before.from;
      return beforeOffset === after.to - after.from ? beforeOffset : null;
    };
    for (const item of remaining) {
      const offset = offsetAt(item.from);
      if (offset === null) continue;
      const to = item.from + offset;
      if (!rowIndexes.has(to) || used.has(to)) continue;
      used.add(to);
      aligned.push({ from: item.from, to, ...(textEvidence(item, to) ? { textConfirmed: true } : {}) });
    }
  }
  // 内容签名在整本书里重复的行（「……」这类短行反复出现）走不了签名通道，落在文本锚点覆盖范围之外时
  // 过去只能整条丢弃——重新生成工作台后少掉的人工确认主要出在这里。但「同一行号上的正文签名与旧记录一致」
  // 本身就是内容证据：这一行没有动过，记录就该搬回去。只在行集索引稳定（已匹配的记录绝大多数仍落在同一行号）
  // 时启用：插行/删行会让行号整体位移，那时同索引不再代表同一行。
  const settled = [...signaturePairs, ...aligned];
  const sameSeat = settled.filter((pair) => pair.to === pair.from).length;
  const sameIndexPairs = [];
  if (settled.length >= 10 && sameSeat / settled.length >= 0.9) {
    for (const item of remaining) {
      if (!item.signature || used.has(item.from)) continue;
      const row = rowByIndex.get(item.from);
      if (!row || String(row.signature || "") !== item.signature) continue;
      used.add(item.from);
      sameIndexPairs.push({ from: item.from, to: item.from, sameIndex: true, ...(textEvidence(item, item.from) ? { textConfirmed: true } : {}) });
    }
  }
  const merged = [...signaturePairs, ...aligned, ...sameIndexPairs];
  return {
    method: signaturePairs.length ? (aligned.length || sameIndexPairs.length ? "mixed" : "signature")
      : (sameIndexPairs.length && !aligned.length ? "sameIndex" : "anchors"),
    pairs: merged,
    unmatched: total - merged.length,
    anchors: monotonic.length,
    sameIndex: sameIndexPairs.length,
  };
}

// 按行号搬回：行号本身没有内容证据，所以只搬当前行集里仍存在的行，
// 且当前空间已有记录的行不被覆盖。
function alignNotesByIndex(entryIds, rows, occupiedIds) {
  const rowIndexes = new Set();
  for (const row of rows || []) {
    if (Number.isInteger(row?.index)) rowIndexes.add(row.index);
  }
  const occupied = new Set();
  for (const id of occupiedIds || []) occupied.add(String(id));
  const pairs = [];
  let missing = 0;
  let occupiedCount = 0;
  for (const rawId of entryIds || []) {
    const from = Number(rawId);
    if (!Number.isInteger(from)) continue;
    if (!rowIndexes.has(from)) { missing += 1; continue; }
    if (occupied.has(String(from))) { occupiedCount += 1; continue; }
    occupied.add(String(from));
    pairs.push({ from, to: from });
  }
  return { pairs, missing, occupied: occupiedCount };
}

function restorableModelOptions(saved) {
  if (!saved || typeof saved !== "object") return [];
  const baseUrl = normalizeApiBaseUrl(saved.baseUrl);
  const optionsBaseUrl = normalizeApiBaseUrl(saved.modelOptionsBaseUrl);
  if (!baseUrl || !optionsBaseUrl || baseUrl !== optionsBaseUrl) return [];
  return Array.isArray(saved.modelOptions)
    ? saved.modelOptions.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

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

function alignRows(cn, tw, jp, comparisonMode = "trilingual") {
  const bilingual = comparisonMode === "bilingual";
  // 双语模式只有一份译文：不伪造 cn↔tw 对齐组，每个主文本段落直接作为技术 pivot 单元。
  const cnTw = bilingual
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
  const jpPivotGroups = loadJpGroupAlignmentList(jp);
  const pivotLang = loadJpPivotLang(comparisonMode);
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

function pivotLabel(pivotLang, labels) {
  return pivotLang === "cn" ? labels.cn : labels.tw;
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

function pivotRangeOf(group) {
  // jp-align.json 现在只写 pivotStart/pivotEnd；旧快照仍带 twStart/twEnd 别名。
  return {
    start: group.pivotStart ?? group.twStart ?? null,
    end: group.pivotEnd ?? group.twEnd ?? null,
  };
}

/** 一张表格行只能包含一段原文；旧快照仍带多段原文组时要求重新对齐，不能猜测配对。 */
function assertSingleJpParagraphGroups(groups) {
  for (const group of groups) {
    const items = Array.isArray(group.items) ? group.items : [];
    if (items.length <= 1) continue;
    throw new Error(
      `原文对齐组 ${group.jpStart}:${group.jpEnd} 包含 ${items.length} 个原文段落；`
      + "工作台要求一张表格行只对应一段原文，请重新运行 npm run align:jp。"
    );
  }
  return groups;
}

function loadJpGroupAlignmentList(jp) {
  const alignFile = path.join(outputDir, "jp-align.json");
  if (!fs.existsSync(alignFile)) return [];

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  const groups = (data.groups || [])
    .map((group) => ({ group, range: pivotRangeOf(group) }))
    .filter(({ range }) => range.start != null && range.end != null && range.start !== range.end)
    .filter(({ group }) => group.jpStart !== group.jpEnd)
    .map(({ group, range }) => ({
      score: group.score,
      relation: group.relation,
      pivotStart: range.start,
      pivotEnd: range.end,
      jpStart: group.jpStart,
      jpEnd: group.jpEnd,
      items: jp.slice(group.jpStart, group.jpEnd),
      pivotItems: Array.from(
        { length: range.end - range.start },
        (_, index) => ({ sourceIndex: range.start + index })
      ),
    }));
  return assertSingleJpParagraphGroups(groups);
}

function loadJpPivotLang(comparisonMode = "trilingual") {
  if (comparisonMode === "bilingual") return "cn";
  const alignFile = path.join(outputDir, "jp-align.json");
  if (!fs.existsSync(alignFile)) return "tw";

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  return data.pivotLang || "tw";
}

function rowClass(score) {
  if (score >= 0.35) return "ok";
  if (score >= 0.18) return "watch";
  return "review";
}

// 每种模式只保留自己那一组字段：双语模式没有第三列，产物里就不出现 tw/twCn/twChars/refinedScore。
const rowFieldsByMode = {
  bilingual: ["index", "chapter", "relation", "jp", "jpAlignScore", "cn", "score", "cnChars", "jpChars"],
  trilingual: [
    "index", "chapter", "relation", "jp", "jpAlignScore", "cn", "tw", "twCn",
    "score", "refinedScore", "cnChars", "twChars", "jpChars",
  ],
};

function rowFieldsFor(comparisonMode) {
  return rowFieldsByMode[comparisonMode === "bilingual" ? "bilingual" : "trilingual"];
}

function pickRowFields(row, fields) {
  const picked = {};
  for (const field of fields) {
    if (row[field] !== undefined) picked[field] = row[field];
  }
  return picked;
}

function exportRows(rows, comparisonMode = "trilingual") {
  const fields = rowFieldsFor(comparisonMode);
  return rows.map((row) => ({ ...pickRowFields(row, fields), signature: rowSignature(row) }));
}

function workbenchClientRows(rows, comparisonMode = "trilingual") {
  const fields = rowFieldsFor(comparisonMode);
  return rows.map((row) => {
    const cls = rowClass(row.score);
    return {
      ...pickRowFields(row, fields),
      signature: rowSignature(row),
      cls,
      scoreText: `${((row.score || 0) * 100).toFixed(0)}%`,
      jpAlignScoreText: row.jpAlignScore == null ? "" : `${(row.jpAlignScore * 100).toFixed(0)}%`,
    };
  });
}

function makeHtml(rows, selection, projectContext, speechHabits = null, termPrefilter = null) {
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const bilingual = comparisonMode === "bilingual";
  const proofreadPrompt = proofreadPromptFor(comparisonMode);
  const stylistContractPrompt = buildPersonaSystemPrompt("stylist", "");
  const arbiterContractPrompt = buildPersonaSystemPrompt("arbiter", "");
  // 特化侧档案由 profiles/ 注册表提供，界面下拉只列出注册过的档案。
  const profileOptions = listProfiles();
  const generatedAt = new Date(projectContext.generatedAt).toLocaleString("zh-CN", { hour12: false });
  // 显示标签只覆盖该模式真实存在的列，双语页面不会出现第三列的名字。
  const labels = Object.fromEntries(activeLangs(comparisonMode).map((lang) => [
    lang,
    selection.labels?.[lang] || defaultDisplayLabels[lang],
  ]));
  const pivotLang = loadJpPivotLang(comparisonMode);
  const similarityLabel = bilingual ? `${labels.jp}-${labels.cn}` : `${labels.cn}-${labels.tw}`;
  const semanticLabel = `${labels.jp}-${pivotLabel(pivotLang, labels)}`;
  const stats = rows.reduce((acc, row) => {
    acc.total += 1;
    acc.emptySource += row.jp ? 0 : 1;
    acc.scoreSum += row.score || 0;
    return acc;
  }, { total: 0, emptySource: 0, scoreSum: 0 });
  const avgScore = stats.total ? stats.scoreSum / stats.total : 0;
  const fileNames = Object.fromEntries(Object.entries(selection.files || {})
    .map(([lang, file]) => [lang, path.basename(file)]));
  // 文件行与顶部元信息合并为一行，标题区只占两行，降低顶部区域整体高度。
  const fileSummary = `原文 A ${fileNames.jp || ""} · ${bilingual ? "译文 B" : "非原文 B"} ${fileNames.cn || ""}${bilingual ? "" : ` · 非原文 C ${fileNames.tw || ""}`}`;
  const rowsSignature = projectContext.rowsSignature;
  const storageKey = projectContext.notesStorage.key;
  const clientMeta = {
    project: projectContext,
    comparisonMode,
    pageLabels: labels,
    similarityLabel,
    semanticLabel,
    providerDefaults,
    proofreadPrompt,
    // 每个特化档案自带默认提示词，客户端切换下拉时无需等状态轮询即可替换未手改的提示词。
    profiles: profileOptions.map((profile) => ({
      ...profile,
      prompt: proofreadPromptFor(comparisonMode, profile.id).system,
    })),
    rowsSignature,
    projectKey: projectContext.projectKey,
    glossaryFile: selection.glossaryFile || "",
    // 说话习惯层的构建期结果：页面用它显示“本卷命中概览”并标出疑似说话特色流失的行。
    speechHabits,
    // 对照表的构建期判定：页面用它标出“纯术语（跳过模型）/术语注入/术语冲突”的行，并给出预筛数字。
    termPrefilter,
  };
  const defaultProofreadMode = comparisonMode;
  const clientRows = workbenchClientRows(rows, comparisonMode);
  const rowsJson = safeJson(clientRows);
  const assets = readWorkbenchAssets();

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="transcomparator-session-token" content="">
  <title>${bilingual ? "双语" : "三语"}翻译对比校对工作台</title>
  <style>${assets.workbenchStyle}${assets.aiPanelStyle}</style>
</head>
<body>
  <div class="app-shell mode-${comparisonMode}">
    <header>
      <div class="topbar">
        <div class="topbar-text">
          <h1>${bilingual ? "双语" : "三语"}翻译对比校对工作台</h1>
          <div class="topbar-meta">
            <span>生成时间 ${escapeHtml(generatedAt)}</span>
            <span>平均相似 ${(avgScore * 100).toFixed(0)}%</span>
            <span>空原文 ${stats.emptySource}</span>
            <span class="files" title="${escapeHtml(fileSummary)}">${escapeHtml(fileSummary)}</span>
          </div>
        </div>
        <div class="stats" aria-label="校对统计">
          <div class="stat"><strong>${stats.total}</strong>总行</div>
          <div class="stat"><strong id="doneCount">0</strong>人工确认</div>
          <div class="stat"><strong id="aiDoneCount">0</strong>自动结果</div>
        </div>
      </div>
    </header>
    <div class="control-stack">
      <details id="controlStackPanel" class="panel-group" data-panel-group open aria-label="控制面板组">
        <summary class="panel-summary"><span>控制面板 <span class="panel-summary-state" id="controlStackState" data-panel-group-state>5 项全部收起</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开全部控制面板"></button></summary>
        <div class="panel-group-body">
        <details id="prefilterPanel" class="panel-details" aria-label="预筛选">
          <summary class="panel-summary"><span>预筛选 <span class="panel-summary-state" id="prefilterPanelState">尚未运行</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开预筛选"></button></summary>
          <p class="panel-desc">执行规则与相似度预筛，快速过滤无需校对的高一致性文本。</p>
          <div class="prefilter-body">
            <div class="prefilter-config">
              <div class="ai-field">
                <label for="prefilterSimilarity">${escapeHtml(similarityLabel)}相似度预筛</label>
                <input id="prefilterSimilarity" type="text" inputmode="decimal" value="92%" aria-label="${escapeHtml(similarityLabel)}相似度预筛百分比">
              </div>
              <p class="prefilter-hint">规则预筛统一繁简、全半角、空白和不可见字符；完全一致或两列均空直接通过，结构化内容不一致标记为冲突。相似度预筛只处理足够长的正文，数字或标识符不同、文本过短或长度差异明显时不启用。预筛结果会写入备注，AI 校对会跳过已通过预筛的行。</p>
            </div>
            <div class="prefilter-runbar">
              <div id="prefilterStats" class="prefilter-stats" aria-live="polite">尚未运行预筛选。</div>
              <div class="prefilter-actions">
                <button id="prefilterStart" class="btn btn--primary" type="button">开始预筛</button>
                <button id="prefilterConfirm" class="btn btn--success" type="button" disabled>确认预筛</button>
                <button id="prefilterStop" class="btn btn--danger" type="button" disabled>停止</button>
              </div>
            </div>
          </div>
        </details>
        <details id="aiPanel" class="panel-details ai-panel" aria-label="AI 校对">
          <summary class="ai-panel-title"><span>AI 辅助校对</span><span id="aiPanelState" class="ai-status-badge">就绪</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开 AI 辅助校对"></button></summary>
          <p class="panel-desc">配置模型服务与校对规范，深度审查翻译缺陷并提供修改建议。</p>
          <details id="aiConfigSection" class="ai-config-details" open><summary class="ai-section-summary">服务与任务设置</summary><div class="ai-config-stack">
            <section class="ai-config-band ai-service-band" aria-labelledby="aiServiceLabel">
              <div id="aiServiceLabel" class="ai-config-label">AI 服务</div>
              <div class="ai-service-content">
                <div id="aiServiceFields" class="ai-service-fields has-reasoning">
                  <div class="ai-service-row">
                    <div class="ai-field ai-preset-field">
                      <div class="ai-field-head">
                        <label for="aiPresetSelect">模型预设</label>
                      </div>
                      <div class="ai-preset-row">
                        <select id="aiPresetSelect">
                          <option value="">-- 自定义 / 未选择预设 --</option>
                        </select>
                        <div class="ai-preset-actions">
                          <button id="aiPresetSave" class="btn btn--subtle" type="button" title="将当前填写的配置覆盖保存到选中的预设" disabled>保存修改</button>
                          <button id="aiPresetSaveAs" class="btn btn--subtle" type="button" title="将当前填写的配置另存为新的模型预设">另存为预设</button>
                          <button id="aiPresetDelete" class="btn btn--subtle btn--danger-subtle" type="button" title="删除选中的模型预设" disabled>删除预设</button>
                        </div>
                      </div>
                    </div>
                    <div class="ai-field ai-provider-field">
                      <label for="aiProvider">接口</label>
                      <select id="aiProvider">
                        <option value="local">本地默认</option>
                        <option value="claude">Claude</option>
                        <option value="compatible">第三方兼容服务</option>
                      </select>
                    </div>
                    <div class="ai-field ai-url-field">
                      <label for="aiBaseUrl">地址</label>
                      <input id="aiBaseUrl" type="url" value="${escapeHtml(providerDefaults.local.baseUrl)}">
                    </div>
                  </div>
                  <div class="ai-service-row">
                    <div class="ai-field ai-apikey-field">
                      <label for="aiApiKey">API Key</label>
                      <input id="aiApiKey" type="password" autocomplete="off" placeholder="${escapeHtml(providerDefaults.local.apiKeyPlaceholder || "")}">
                    </div>
                    <div class="ai-field ai-model-field">
                      <div class="ai-field-head">
                        <label for="aiModel">模型</label>
                      </div>
                      <div class="ai-model-row">
                        <select id="aiModel">
                          <option value="${escapeHtml(providerDefaults.local.model)}">${escapeHtml(providerDefaults.local.model)}</option>
                        </select>
                        <div class="ai-model-actions">
                          <button id="aiRefreshModels" type="button" title="从接口获取可用模型列表">刷新</button>
                          <button id="aiTestModel" type="button" title="测试当前模型的网络连通性与响应">测试</button>
                        </div>
                      </div>
                    </div>
                    <div id="aiReasoningField" class="ai-field">
                      <label for="aiReasoningEffort">推理强度</label>
                      <select id="aiReasoningEffort" title="模型默认时不发送推理或采样参数">
                        <option value="" selected>模型默认</option>
                      </select>
                    </div>
                  </div>
                </div>
              </div>
            </section>
            <section class="ai-config-band ai-proofread-band" aria-labelledby="aiProofreadLabel">
              <div id="aiProofreadLabel" class="ai-config-label">校对设置</div>
              <div class="ai-proofread-fields">
                <div class="ai-field">
                  <label for="aiProofreadMode">校对模式</label>
                  <select id="aiProofreadMode" disabled>
                    <option value="${defaultProofreadMode}">${bilingual ? "双语版本校对" : "三语语境校对"}</option>
                  </select>
                </div>
                <div class="ai-field">
                  <label for="aiTarget">校对列</label>
                  <select id="aiTarget"${bilingual ? " disabled" : ""}>
                    <option value="cn">${escapeHtml(labels.cn)}</option>
                    ${bilingual ? "" : `<option value="tw">${escapeHtml(labels.tw)}</option>`}
                  </select>
                </div>
                <div class="ai-field">
                  <label for="aiProfile">特化规范</label>
                  <select id="aiProfile" title="${escapeHtml(profileOptions.map((profile) => `${profile.name}：${profile.summary}`).join("\n"))}">
                    ${profileOptions.map((profile) => `<option value="${escapeHtml(profile.id)}"${profile.id === proofreadPrompt.profileId ? " selected" : ""}>${escapeHtml(profile.name)}</option>`).join("")}
                  </select>
                </div>
                <div class="ai-field ai-field--wide">
                  <span id="aiTermTableHint" class="ai-term-hint" data-state="pending" title="特化规范里声明的译名对照表：只有整行有效内容都是术语时才跳过模型；其余命中行（含术语冲突）都把术语作为提示词注入，整句交给模型判断。">对照表：检测中…</span>
                  <span id="aiSpeechHabitHint" class="ai-term-hint" data-state="pending" title="特化规范里声明的说话习惯表：按章/按卷命中人名后，该角色的说话特色不会被判为翻译错误。">说话习惯：检测中…</span>
                </div>
                <div class="ai-field" id="aiConcurrencyField">
                  <div class="ai-field-head">
                    <label for="aiConcurrency" id="aiConcurrencyLabel">并发</label>
                    <label class="ai-concurrency-smart" for="aiSmartConcurrency" title="开启智能并发：以初始并发启动，连续请求稳定后自动向上试探，遇到并发/频控限制（HTTP 429 等）自动降低并发并退避重试。"><input id="aiSmartConcurrency" type="checkbox">智能并发</label>
                  </div>
                  <div class="ai-concurrency-inputs">
                    <input id="aiConcurrency" type="number" min="1" max="12" value="3" title="并发数（开启智能并发时为初始并发，默认 3）">
                    <div id="aiConcurrencyMaxWrap" class="ai-concurrency-max-wrap" hidden>
                      <span class="ai-concurrency-sep">上限</span>
                      <input id="aiConcurrencyMax" type="number" min="1" max="20" value="10" title="并发上限（智能并发允许达到的最大并发数，默认 10）">
                    </div>
                  </div>
                </div>
                <div class="ai-field" id="aiBreakerField">
                  <div class="ai-field-head">
                    <label for="aiBreakerThreshold">熔断阈值</label>
                    <label class="ai-breaker-off" for="aiBreakerDisabled" title="关闭后 AI 调用失败不再自动终止任务；接口配置或响应异常仍会终止。"><input id="aiBreakerDisabled" type="checkbox">关闭</label>
                  </div>
                  <div class="ai-breaker-inputs">
                    <input id="aiBreakerThreshold" type="text" inputmode="decimal" value="${Math.round(errorCircuitBreaker.errorRate * 100)}%"
                      title="最近 ${errorCircuitBreaker.windowSize} 次 AI 调用中失败占比达到该比例时自动终止任务；累计满 ${errorCircuitBreaker.minimumSamples} 次结果后开始判定。范围 ${Math.round(errorCircuitBreaker.minErrorRate * 100)}%–100%。">
                  </div>
                </div>
              </div>
            </section>
          </div></details>
          <div class="ai-runbar">
            <div class="toggle-row ai-options">
              <label><input id="aiPromptVisible" type="checkbox">内置提示词</label>
            </div>
            <div class="ai-status">
              <div id="aiStatus" class="ai-status-text" title="就绪">就绪</div>
              <div id="aiProgressWrap" class="ai-progress" aria-hidden="true" hidden><span id="aiProgress"></span></div>
            </div>
            <div class="ai-actions">
              <button id="aiStart" class="btn btn--primary" type="button">开始</button>
              <button id="aiStop" class="btn btn--danger" type="button" disabled>停止</button>
              <button id="clearAiLog" class="btn btn--subtle" type="button">清除 AI 记录</button>
            </div>
          </div>
          <div id="aiStageDashboard" class="ai-stage-dashboard" aria-label="审核流水线阶段统计">
            <div class="ai-stage-dashboard-header">
              <span class="ai-stage-dashboard-title">认知审核阶段统计</span>
              <span id="aiStageFastPassRate" class="ai-stage-badge" title="高置信度快速直通率 (Fast Pass)">快速直通: 0%</span>
            </div>
            <div class="ai-stage-cards">
              <div class="ai-stage-card" id="stage1Card" data-filter-stage="1" title="阶段一 事实初审：事实性硬伤审查与直接通过">
                <div class="ai-stage-card-head" title="配置阶段一模型预设（默认使用主配置）">
                  <div class="ai-stage-card-title-row">
                    <span class="ai-stage-card-label">阶段一 事实初审</span>
                    <span id="stage1StatusPill" class="ai-stage-status-pill" data-state="idle">待命</span>
                  </div>
                  <select id="stage1PresetSelect" class="ai-stage-preset-select" title="阶段一模型预设（默认使用主配置）">
                    <option value="">使用主配置</option>
                  </select>
                </div>
                <div class="ai-stage-card-body" title="点击指标筛选/取消筛选阶段一通过行">
                  <div class="ai-stage-card-value"><strong id="metricStage1Passed">0</strong><span class="ai-stage-unit">通过</span></div>
                  <div class="ai-stage-card-sub">
                    <span class="ai-stage-sub-item">快速直通: <span id="metricFastPassHits">0</span></span>
                  </div>
                  <div id="stage1ActiveInfo" class="ai-stage-active-info" hidden>处理中: <span id="stage1ActiveRowsText"></span></div>
                </div>
              </div>
              <div class="ai-stage-card" id="stage2Card" data-filter-stage="2" title="阶段二 文学复审：文学责编复审与同行评议">
                <div class="ai-stage-card-head" title="配置阶段二模型预设（未启用时不执行复审）">
                  <div class="ai-stage-card-title-row">
                    <span class="ai-stage-card-label">阶段二 文学复审</span>
                    <span id="stage2StatusPill" class="ai-stage-status-pill" data-state="disabled">未启用</span>
                  </div>
                  <select id="stage2PresetSelect" class="ai-stage-preset-select" title="选择阶段二模型预设（不填代表不启用）">
                    <option value="">未启用</option>
                  </select>
                </div>
                <div class="ai-stage-card-body" title="点击指标筛选/取消筛选阶段二复审行">
                  <div class="ai-stage-card-value"><strong id="metricStage2Reviewed">0</strong><span class="ai-stage-unit">复审</span></div>
                  <div class="ai-stage-card-sub">
                    <span class="ai-stage-sub-item">采纳: <span id="metricCritiqueAccept">0</span></span>
                    <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                    <span class="ai-stage-sub-item">调整: <span id="metricCritiqueModify">0</span></span>
                    <span class="ai-stage-sub-sep" aria-hidden="true">·</span>
                    <span class="ai-stage-sub-item">驳回: <span id="metricCritiqueReject">0</span></span>
                  </div>
                  <div id="stage2ActiveInfo" class="ai-stage-active-info" hidden>处理中: <span id="stage2ActiveRowsText"></span></div>
                </div>
              </div>
              <div class="ai-stage-card" id="stage3Card" data-filter-stage="3" title="阶段三 终审仲裁：初审与复审分歧仲裁">
                <div class="ai-stage-card-head" title="配置阶段三模型预设（需先在阶段二选择预设启用）">
                  <div class="ai-stage-card-title-row">
                    <span class="ai-stage-card-label">阶段三 终审仲裁</span>
                    <span id="stage3StatusPill" class="ai-stage-status-pill" data-state="disabled">未启用</span>
                  </div>
                  <select id="stage3PresetSelect" class="ai-stage-preset-select" disabled title="需先在阶段二选择预设启用后，方可配置阶段三">
                    <option value="">未启用</option>
                  </select>
                </div>
                <div class="ai-stage-card-body" title="点击指标筛选/取消筛选阶段三仲裁行">
                  <div class="ai-stage-card-value"><strong id="metricStage3Arbitrated">0</strong><span class="ai-stage-unit">仲裁</span></div>
                  <div class="ai-stage-card-sub">
                    <span class="ai-stage-sub-item">升级仲裁: <span id="metricCritiqueEscalate">0</span></span>
                  </div>
                  <div id="stage3ActiveInfo" class="ai-stage-active-info" hidden>处理中: <span id="stage3ActiveRowsText"></span></div>
                </div>
              </div>
            </div>
          </div>
          <details id="aiPromptSection" class="ai-section">
            <summary><span>内置提示词与阶段契约</span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开内置提示词与阶段契约"></button></summary>
            <div class="ai-prompt-box">
              <div class="ai-prompt-tabs" role="tablist" aria-label="提示词与阶段契约切换">
                <button type="button" class="ai-prompt-tab is-active" data-prompt-tab="stage1">初审与全局规范</button>
                <button type="button" class="ai-prompt-tab" data-prompt-tab="stage2">阶段二 文学复审契约</button>
                <button type="button" class="ai-prompt-tab" data-prompt-tab="stage3">阶段三 终审仲裁契约</button>
              </div>
              <div id="promptTabStage1" class="ai-prompt-tab-pane is-active">
                <div class="ai-prompt-head">
                  <span class="ai-prompt-note">Stage 1 事实质检与全局规则（严查硬伤、漏译、加译与术语）：</span>
                  <div class="ai-prompt-actions">
                    <button id="aiPromptReset" type="button">恢复默认</button>
                  </div>
                </div>
                <textarea id="aiPrompt" spellcheck="false">${escapeHtml(proofreadPrompt.system)}</textarea>
              </div>
              <div id="promptTabStage2" class="ai-prompt-tab-pane" hidden>
                <div class="ai-prompt-head">
                  <span class="ai-prompt-note">Stage 2 文学责编契约（同行评审与文学润色规则）：</span>
                </div>
                <textarea id="aiPromptStage2" spellcheck="false" readonly>${escapeHtml(stylistContractPrompt)}</textarea>
              </div>
              <div id="promptTabStage3" class="ai-prompt-tab-pane" hidden>
                <div class="ai-prompt-head">
                  <span class="ai-prompt-note">Stage 3 终审法官契约（中立客观裁决初审与复审分歧）：</span>
                </div>
                <textarea id="aiPromptStage3" spellcheck="false" readonly>${escapeHtml(arbiterContractPrompt)}</textarea>
              </div>
            </div>
          </details>
        </details>
        <details id="filterPanel" class="panel-details" aria-label="筛选与批处理">
          <summary class="panel-summary"><span>筛选与批处理 <span class="panel-summary-state" id="filterPanelState">未筛选</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开筛选与批处理"></button></summary>
          <p class="panel-desc">按条件检索过滤表格行，控制列显示，并批量确认或写回修改。</p>
          <div class="filter-bar" aria-label="筛选">
            <input id="query" class="filter-search" type="search" placeholder="搜索原文、译文、备注">
            <div class="filter-groups">
              <div class="segmented" role="group" aria-label="相似度状态">
                <span class="segmented__label">相似度</span>
                <button type="button" class="segmented__btn is-active" data-severity="all">全部</button>
                <button type="button" class="segmented__btn" data-severity="review" title="相似度低于 18%">较低</button>
                <button type="button" class="segmented__btn" data-severity="watch" title="相似度为 18% 至 35%">中等</button>
                <button type="button" class="segmented__btn" data-severity="ok" title="相似度不低于 35%">较高</button>
              </div>
              <div class="segmented" role="group" aria-label="自动分析结果">
                <span class="segmented__label">自动</span>
                <button type="button" class="segmented__btn is-active" data-ai-result="all">全部</button>
                <button type="button" class="segmented__btn" data-ai-result="modify">需改</button>
                <button type="button" class="segmented__btn" data-ai-result="same">不改</button>
                <button type="button" class="segmented__btn" data-ai-result="unclear">待判</button>
              </div>
              <div class="segmented" role="group" aria-label="AI 翻译质量评分分级">
                <span class="segmented__label" title="按扣分制（满分100）质量分级筛选">评分</span>
                <button type="button" class="segmented__btn is-active" data-issue-severity="all">全部</button>
                <button type="button" class="segmented__btn" data-issue-severity="excellent" title="优等 (90~100分)：极佳，无缺陷或仅个别微瑕">优等</button>
                <button type="button" class="segmented__btn" data-issue-severity="good" title="良好 (75~89分)：总体良好，有个别轻微缺陷">良好</button>
                <button type="button" class="segmented__btn" data-issue-severity="fair" title="一般 (60~74分)：存在较明显缺陷，需重点修改">一般</button>
                <button type="button" class="segmented__btn" data-issue-severity="poor" title="较差 (<60分)：存在致命错译或严重缺陷，不及格">较差</button>
              </div>
              <button id="prefilterResultFilter" class="chip" type="button" aria-pressed="false" disabled>预筛结果</button>
              <button id="noteFilter" class="chip" type="button" aria-pressed="false">有备注</button>
              <button id="doneFilter" class="chip" type="button" data-mode="open" aria-pressed="false">未人工确认</button>
            </div>
            <button id="clearFilter" class="btn btn--ghost" type="button">清筛选</button>
          </div>
          <div class="action-bar">
            <div class="action-group" aria-label="显示设置">
              <span class="action-group__label">显示</span>
              <label class="toggle-inline"><input id="showSource" type="checkbox" checked>原文</label>
              ${bilingual ? "" : '<label class="toggle-inline"><input id="showTranslationDiff" type="checkbox" checked>译文差异</label>'}
              <label class="toggle-inline"><input id="showRevisionDiff" type="checkbox" checked>修改差异</label>
            </div>
            <div class="action-group" aria-label="修改结果操作">
              <span class="action-group__label">修改结果</span>
              <button id="acceptAiSame" class="btn btn--success" type="button" title="将全部 AI 判断不改的行标记为人工确认（无视当前筛选）">确认自动不改</button>
              <button id="exportNotes" class="btn" type="button" title="批量写回当前筛选结果中的全部修改结果">批量写回</button>
              <button id="confirmRevisions" class="btn" type="button" title="将当前筛选结果中的修改结果标记为人工确认">批量确认</button>
            </div>
          </div>
        </details>
        <details id="notesPanel" class="panel-details" aria-label="备注空间与找回">
          <summary class="panel-summary"><span>备注空间与找回 <span id="notesSaveState" class="notes-summary-state">保存在此浏览器</span></span><button class="details-toggle" type="button" data-details-toggle aria-label="折叠或展开备注空间"></button></summary>
          <div class="notes-body">
            <div class="notes-toolbar">
              <p class="panel-desc">找回历史备注，或用 JSON 在浏览器之间备份与迁移。</p>
              <div class="notes-actions">
                <button id="exportAllNotes" class="btn" type="button">备份全部</button>
                <label class="notes-file-label" for="importNotesFile">导入备份<input id="importNotesFile" class="notes-file" type="file" accept=".json,application/json"></label>
                <button id="clearCurrentNotes" class="btn btn--subtle" type="button">清空本页</button>
                <button id="clearHistoryNotes" class="btn btn--subtle" type="button">清空历史</button>
                <button id="refreshNotesSpaces" class="btn btn--ghost" type="button">刷新</button>
              </div>
            </div>
            <div id="notesSaveWarning" class="notes-save-warning" role="status" hidden></div>
            <button id="retryNotesSave" class="btn btn--subtle" type="button" hidden>重试保存</button>
            <div id="notesCurrentSpace"></div>
            <div class="notes-history-heading"><strong>历史记录</strong><span id="notesSpaceSummary"></span></div>
            <div id="notesSpaceList" class="notes-space-list">正在读取本机备注空间...</div>
            <p id="notesPanelStatus" class="notes-panel-status" role="status"></p>
            <p class="notes-hint">优先按内容找回，保留本页已有记录。仅按行号或旧文本推断的记录需逐行核验后才能写回。迁移标记不属于备注，列表已自动排除；历史空间由你手动删除。</p>
          </div>
        </details>
        </div>
      </details>
      <dialog id="notesRecoveryDialog" class="notes-recovery-dialog" aria-labelledby="notesRecoveryTitle">
        <h2 id="notesRecoveryTitle">预览备注找回</h2>
        <div id="notesRecoveryPreview"></div>
        <div class="notes-dialog-actions"><button id="cancelNotesRecovery" class="btn btn--ghost" type="button" autofocus>取消</button><button id="applyNotesRecovery" class="btn btn--primary" type="button">找回记录</button></div>
      </dialog>
      <dialog id="aiConfirmDialog" class="notes-recovery-dialog ai-confirm-dialog" aria-labelledby="aiConfirmTitle">
        <h2 id="aiConfirmTitle">启动 AI 校对</h2>
        <p id="aiConfirmMessage" class="ai-confirm-message"></p>
        <div class="notes-dialog-actions">
          <button id="aiConfirmCancel" class="btn btn--ghost" type="button" autofocus>取消</button>
          <button id="aiConfirmKeep" class="btn btn--subtle" type="button">保留并开始</button>
          <button id="aiConfirmClear" class="btn btn--primary" type="button">清空并开始</button>
        </div>
      </dialog>
    </div>
    <main class="wrap">
      <div class="table-frame">
        <table>
          <thead>
            <tr>
              <th>位置</th>
              <th>${escapeHtml(labels.jp)}</th>
              <th>译文对照</th>
              <th>校对备注</th>
            </tr>
          </thead>
          <tbody>
          </tbody>
        </table>
        <div id="keyboardScrollSpacer" class="keyboard-scroll-spacer" aria-hidden="true"></div>
      </div>
      <div id="paginationBar" class="pagination-bar">
        <div id="paginationStatus">正在准备行数据...</div>
        <div class="pagination-actions">
          <button id="firstPage" type="button">首页</button>
          <button id="prevPage" type="button">上一页</button>
          <label for="pageInput">第</label>
          <input id="pageInput" type="number" min="1" value="1" aria-label="页码">
          <span id="pageTotal">/ 1 页</span>
          <button id="nextPage" type="button">下一页</button>
          <button id="lastPage" type="button">末页</button>
        </div>
        <label class="pagination-size" for="pageSize">
          <span>每页</span>
          <select id="pageSize">
            <option value="50">50 行</option>
            <option value="100" selected>100 行</option>
            <option value="200">200 行</option>
            <option value="500">500 行</option>
          </select>
        </label>
      </div>
      <div id="emptyState" class="empty-state">没有匹配的行</div>
    </main>
  </div>
  <div id="toastStack" class="toast-stack" role="region" aria-live="polite" aria-label="操作提示"></div>
  <script id="rowData" type="application/json">${rowsJson}</script>
  <script>
    ${resolveModelOptions.toString()}
    ${normalizeApiBaseUrl.toString()}
    ${restorableModelOptions.toString()}
    ${alignLegacyNotes.toString()}
    ${alignNotesByIndex.toString()}
    ${createNotesTools.toString()}
    ${createPresetTools.toString()}
    ${normalizeGrade.toString()}

    const storageKey = ${JSON.stringify(storageKey)};
    const pageMeta = ${safeJson(clientMeta)};
${assets.workbenchShared}
${assets.workbenchClient}</script>
</body>
</html>`;
}

function toCsv(rows, comparisonMode = "trilingual") {
  const cols = comparisonMode === "bilingual"
    ? ["index", "chapter", "relation", "score", "jpAlignScore", "jp", "cn"]
    : ["index", "chapter", "relation", "score", "jpAlignScore", "jp", "cn", "tw", "twCn"];
  const escapeCsv = (value) => `"${String(value ?? "").replace(/"/g, '""')}"`;
  return [
    cols.join(","),
    ...rows.map((row) => cols.map((col) => escapeCsv(row[col])).join(",")),
  ].join("\n");
}

async function main() {
  fs.mkdirSync(outputDir, { recursive: true });

  reportProgress(5, "读取段落与对齐结果");
  const selection = await resolveInputSelection({ allowPrompt: false });
  const comparisonMode = selection.comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const paragraphs = await loadParagraphs(selection);
  reportProgress(28, comparisonMode === "bilingual" ? "整理原文与译文段落" : "合并非原文对齐组");
  const rows = alignRows(paragraphs.cn, paragraphs.tw || [], paragraphs.jp, comparisonMode);
  reportProgress(58, "整理比较行", rows.length, rows.length);
  const scopedSelection = { ...selection, comparisonMode };
  const projectContext = createProjectContext(scopedSelection, rows);
  const counts = Object.fromEntries(activeLangs(comparisonMode).map((lang) => [lang, paragraphs[lang].length]));

  reportProgress(64, "计算说话习惯层");
  const speechHabits = buildSpeechHabitLayer({
    rows: exportRows(rows, comparisonMode),
    projectFiles: scopedSelection.files || {},
    envTables: String(process.env.TRANSCOMPARATOR_SPEECH_TABLES || "").split(/[;\n]/),
  });
  for (const [profileId, entry] of Object.entries(speechHabits.byProfile || {})) {
    console.log(`说话习惯（构建期）${profileId}：${entry.summary.chapters} 章 / ${entry.summary.activatedChapters} 章命中 ${entry.summary.activatedCharacters.length} 个角色 / ${entry.summary.missRows} 行疑似流失`);
  }
  for (const error of speechHabits.errors) console.warn(`说话习惯表告警：${error}`);

  // 对照表判定与模型无关：构建期算一次，页面在跑任务前就能看到哪些行会被对照表处理。
  reportProgress(67, "计算对照表层");
  const termPrefilter = buildTermLayer({
    rows: exportRows(rows, comparisonMode),
    envTables: String(process.env.TRANSCOMPARATOR_TERM_TABLES || "").split(/[;\n]/),
    comparisonMode,
  });
  for (const [profileId, entry] of Object.entries(termPrefilter.byProfile || {})) {
    console.log(`对照表（构建期）${profileId}：${describeTermLayerEntry(entry)}`);
  }
  for (const error of termPrefilter.errors) console.warn(`对照表告警：${error}`);

  reportProgress(70, "渲染工作台页面");
  const html = makeHtml(rows, scopedSelection, projectContext, speechHabits, termPrefilter);
  fs.writeFileSync(path.join(outputDir, "translation-compare.html"), html, "utf8");
  reportProgress(86, "写入导出文件");
  fs.writeFileSync(path.join(outputDir, "translation-compare.csv"), toCsv(rows, comparisonMode), "utf8");
  fs.writeFileSync(path.join(outputDir, "translation-compare.json"), JSON.stringify({
    project: projectContext,
    files: selection.files,
    labels: selection.labels,
    counts,
    rowsSignature: projectContext.rowsSignature,
    // 说话习惯层写在行数据之外（顶层块），不改变任何行字段与 signature。
    speechHabits,
    // 对照表判定同理：只存行号结论（命中/一致/冲突），结果与备注仍由运行期生成。
    termPrefilter,
    rows: exportRows(rows, comparisonMode),
  }, null, 2), "utf8");
  reportProgress(100, "比较工作台构建完成", rows.length, rows.length);

  const published = process.env.TRANSCOMPARATOR_OUTPUT_DIR
    ? null
    : publishProject(outputDir);

  // 只报告该模式实际参与的列：双语模式不会出现 "TW paragraphs: 0"。
  for (const [lang, count] of Object.entries(counts)) {
    console.log(`${lang.toUpperCase()} paragraphs: ${count}`);
  }
  console.log(`Comparison mode: ${comparisonMode === "bilingual" ? "双语（原文 A + 译文 B）" : "三语（原文 A + 非原文 B/C）"}`);
  console.log(`Rows: ${rows.length}`);
  if (published) {
    console.log(`Published project: ${published.id} (${published.outputUrl})`);
  } else {
    console.log(`HTML: ${path.join(outputDir, "translation-compare.html")}`);
    console.log(`CSV: ${path.join(outputDir, "translation-compare.csv")}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

function snapshotComparisonMode(compareData) {
  const declared = compareData.project?.comparisonMode || compareData.comparisonMode;
  if (declared === "bilingual" || declared === "trilingual") return declared;
  // 旧快照没有声明模式时按数据推断：只有存在非空的第三列才算三语。
  return compareData.counts?.tw || compareData.files?.tw ? "trilingual" : "bilingual";
}

function pickComparisonMode(...candidates) {
  for (const candidate of candidates) {
    if (candidate === "bilingual" || candidate === "trilingual") return candidate;
  }
  return "trilingual";
}

function rebuildCompareHtmlFromSnapshot(snapshotDir, options = {}) {
  const dir = path.resolve(snapshotDir);
  const jsonFile = path.join(dir, "translation-compare.json");
  if (!fs.existsSync(jsonFile)) {
    throw new Error(`快照目录缺少 translation-compare.json：${dir}`);
  }
  const compareData = JSON.parse(fs.readFileSync(jsonFile, "utf8"));
  const selectionFile = path.join(dir, "input-selection.json");
  let selection;
  if (fs.existsSync(selectionFile)) {
    selection = JSON.parse(fs.readFileSync(selectionFile, "utf8"));
  } else {
    selection = {
      comparisonMode: snapshotComparisonMode(compareData),
      files: compareData.files || {},
      labels: compareData.labels || {},
      glossaryFile: compareData.project?.glossaryFile || "",
    };
  }
  const comparisonMode = pickComparisonMode(
    selection.comparisonMode,
    compareData.project?.comparisonMode,
    snapshotComparisonMode(compareData),
  );
  const projectContext = compareData.project
    || createProjectContext({ ...selection, comparisonMode }, compareData.rows || []);
  // 对照表层有版本语义：展示口径或命中口径升级后，旧快照里的术语对不能继续原样复用。
  // 这里按当前档案里的表重新计算一次；算不出任何表时保留旧块，避免把页面退化成“无对照表”。
  let termPrefilter = compareData.termPrefilter || null;
  if ((termPrefilter?.version || 0) !== TERM_LAYER_VERSION && Array.isArray(compareData.rows) && compareData.rows.length) {
    const rebuiltTerms = buildTermLayer({
      rows: compareData.rows,
      profiles: options.profiles || null,
      envTables: String(process.env.TRANSCOMPARATOR_TERM_TABLES || "").split(/[;\n]/),
      comparisonMode,
    });
    if (Object.keys(rebuiltTerms.byProfile || {}).length) {
      termPrefilter = rebuiltTerms;
      compareData.termPrefilter = rebuiltTerms;
      fs.writeFileSync(jsonFile, JSON.stringify(compareData, null, 2), "utf8");
    }
  }
  const html = makeHtml(
    compareData.rows || [],
    { ...selection, comparisonMode, labels: selection.labels || compareData.labels || {} },
    projectContext,
    compareData.speechHabits || null,
    termPrefilter,
  );
  const htmlFile = path.join(dir, "translation-compare.html");
  fs.writeFileSync(htmlFile, html, "utf8");
  return {
    htmlFile,
    rowCount: (compareData.rows || []).length,
    notesKey: projectContext.notesStorage?.key || "",
  };
}

module.exports = {
  alignLegacyNotes,
  alignNotesByIndex,
  alignRows,
  createPresetTools,
  exportRows,
  main,
  makeHtml,
  readWorkbenchAssets,
  rebuildCompareHtmlFromSnapshot,
  restorableModelOptions,
  resolveModelOptions,
  rowFieldsFor,
  assertSingleJpParagraphGroups,
  toCsv,
  workbenchClientRows,
};
