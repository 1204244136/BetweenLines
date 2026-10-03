const fs = require("fs");
const path = require("path");
const { resolveBuildOutputDir } = require("../../core/storage-layout");

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
  const alignFile = path.join(resolveBuildOutputDir(), "jp-align.json");
  if (!fs.existsSync(alignFile)) return [];

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  const groups = (data.groups || [])
    .map((group) => ({ group, range: pivotRangeOf(group) }))
    .filter(({ range }) => range.start != null && range.end != null)
    .filter(({ group }) => group.jpStart !== group.jpEnd)
    .map(({ group, range }) => {
      if (!Number.isInteger(group.jpStart) || !Number.isInteger(group.jpEnd)
          || group.jpStart < 0 || group.jpEnd <= group.jpStart || group.jpEnd > jp.length
          || !Number.isInteger(range.start) || !Number.isInteger(range.end)
          || range.start < 0 || range.end < range.start) {
        throw new Error("原文对齐组的段落区间无效，请重新运行 npm run align:jp。");
      }
      return {
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
      };
    });
  assertSingleJpParagraphGroups(groups);
  const usedSourceIndexes = new Set();
  for (const group of groups) {
    if (usedSourceIndexes.has(group.jpStart)) {
      throw new Error(`原文段落 ${group.jpStart} 被多个对齐组重复使用，请重新运行 npm run align:jp。`);
    }
    usedSourceIndexes.add(group.jpStart);
  }
  return groups;
}

function loadJpPivotLang(comparisonMode = "trilingual") {
  if (comparisonMode === "bilingual") return "cn";
  const alignFile = path.join(resolveBuildOutputDir(), "jp-align.json");
  if (!fs.existsSync(alignFile)) return "tw";

  const data = JSON.parse(fs.readFileSync(alignFile, "utf8"));
  return data.pivotLang || "tw";
}

module.exports = { loadJpGroupAlignmentList, loadJpPivotLang, assertSingleJpParagraphGroups };
