/**
 * 对照表层：构建期算判定 + 运行期交叉校验。
 *
 * 为什么和说话习惯层不一样：
 * - 说话习惯层产出的**提示词上下文**（章级命中角色），运行期复用它就等价于现算，所以直接复用；
 * - 对照表层产出的是**行级结果**（写进备注、作为「不调用模型」的依据），结果的生成必须留在运行期：
 *   它要带当次任务的标签、目标列与「已人工确认」的过滤，构建期不能替用户写备注空间。
 * - 但「哪些行会被对照表命中、命中的是一致还是冲突」只依赖「整卷行数据 + 对照表」，与模型无关，
 *   因此在构建期算一次落盘：页面在跑任务之前就能标出待处理的行、给出预筛数字，
 *   离线脚本/AI/页面也能拿同一份结论对照，避免三处各算一份。
 *
 * 落盘块写在行数据之外（顶层 `termPrefilter`），不修改任何行字段，
 * 因此不改变 `rowsSignature`/`signature`，备注与写回定位不受影响。
 */
const {
  evaluateTermRow,
  loadTermTables,
  normalizeTermTablePaths,
} = require("./ai/term-table");
const { termTargetKeyFor } = require("./ai/term-prefilter");
const { listProfiles, resolveProfile } = require("./ai/proofread-contract");
const { tableFilesForProfile, tableSourceCandidates, toPathList } = require("./layer-sources");
const { tableFileNames, tablesFingerprint } = require("../../core/table-fingerprint");

// 2：落盘块的 `files` 从「本机完整路径」改成「文件名」，运行期改为按当前档案重算指纹。
const TERM_LAYER_VERSION = 2;

/**
 * 对照表判定与「校对模式 + 目标列」绑定：双语只有目标列 cn，三语可以是 cn 或 tw。
 * 构建期把该模式可能用到的变体都算好（每行判定一次只要几十微秒），
 * 运行期无论用户选哪一列都能命中同一份结论。
 */
function termVariantsFor(comparisonMode, targetKeys = null) {
  const mode = comparisonMode === "bilingual" ? "bilingual" : "trilingual";
  const keys = targetKeys || (mode === "bilingual" ? ["cn"] : ["cn", "tw"]);
  return keys.map((targetKey) => ({
    proofreadMode: mode,
    targetKey: termTargetKeyFor(mode, targetKey),
  }));
}

function termVariantKey(proofreadMode, targetKey) {
  return `${proofreadMode === "bilingual" ? "bilingual" : "trilingual"}:${termTargetKeyFor(proofreadMode, targetKey)}`;
}

function evaluateVariant({ rows = [], tables, proofreadMode, targetKey }) {
  const consistent = [];
  const conflicts = [];
  const chapters = new Map();
  for (const row of rows) {
    const evaluation = evaluateTermRow({
      source: row.jp || "",
      target: String(row[targetKey] ?? ""),
      tables,
    });
    if (!evaluation) continue;
    if (evaluation.kind === "consistent") consistent.push(Number(row.index));
    else conflicts.push(Number(row.index));
    const chapter = String(row.chapter || "");
    chapters.set(chapter, (chapters.get(chapter) || 0) + 1);
  }
  const hits = consistent.length + conflicts.length;
  return {
    proofreadMode,
    targetKey,
    hits,
    consistent,
    conflicts,
    chapters: [...chapters.entries()].map(([chapter, count]) => ({ chapter, hits: count })),
    summary: {
      rows: rows.length,
      hits,
      consistent: consistent.length,
      conflicts: conflicts.length,
      // 对照表直接出结论、不再交给模型的行数（其余还要过规则/相似度预筛与模型）。
      removedFromModel: consistent.length,
      aiRows: Math.max(0, rows.length - consistent.length),
      chapters: chapters.size,
    },
  };
}

/**
 * 构建期：为每个声明了对照表的档案算出各变体下的命中判定。
 * @returns {{ version: number, generatedAt: string, byProfile: Record<string, object>, errors: string[] }}
 */
function buildTermLayer({ rows = [], profiles = null, envTables = [], comparisonMode = "bilingual" } = {}) {
  const byProfile = {};
  const errors = [];
  const candidates = tableSourceCandidates({
    profiles: profiles || listProfiles().map((item) => resolveProfile(item.id)),
    envTables,
    tableKey: "termTables",
    normalize: normalizeTermTablePaths,
    envName: "环境变量指定的对照表",
  });

  const variants = termVariantsFor(comparisonMode);
  const defaultVariant = termVariantKey(variants[0].proofreadMode, variants[0].targetKey);

  for (const candidate of candidates) {
    const tables = loadTermTables(candidate.files);
    if (tables.errors.length) errors.push(...tables.errors);
    if (!tables.entries.length) continue;

    const built = {};
    for (const variant of variants) {
      const key = termVariantKey(variant.proofreadMode, variant.targetKey);
      built[key] = evaluateVariant({ rows, tables, ...variant });
    }
    const main = built[defaultVariant];
    byProfile[candidate.id] = {
      id: candidate.id,
      name: candidate.name,
      // 只留文件名：这是要进快照与页面的，本机完整路径不该出现在产物里。
      files: tableFileNames(candidate.files),
      fingerprint: tablesFingerprint(TERM_LAYER_VERSION, candidate.files, tables.entries.length),
      entries: tables.entries.length,
      defaultVariant,
      variants: built,
      summary: main.summary,
    };
  }

  return {
    version: TERM_LAYER_VERSION,
    generatedAt: new Date().toISOString(),
    byProfile,
    errors,
  };
}

/**
 * 运行期：本次实际用到的对照表路径。
 *
 * 指纹要 stat 真实文件，而落盘块里只有文件名，所以运行期必须自己解析路径——
 * 口径与构建期 `tableSourceCandidates` 相同（档案声明 → 环境变量，同一份归一化与去重），
 * 否则同一张表会被算成两个不同的来源、指纹永远对不上。
 */
function currentTermFiles(profileId, envTables) {
  return tableFilesForProfile(resolveProfile(profileId), {
    tableKey: "termTables",
    envTables: envTables === undefined ? process.env.TRANSCOMPARATOR_TERM_TABLES : envTables,
    normalize: normalizeTermTablePaths,
  });
}

/**
 * 运行期取用：指纹一致且变体存在时给出可复用的判定，否则让调用方自己重算。
 * 与说话习惯层同口径——表被改过就回退现算，并提示重新构建工作台。
 *
 * @param {string[]} [files] 本次**实际加载**的表路径（含显式指定的表）。不传时按当前档案解析；
 *   两种情况都解析不出表时视为不可信（stale），绝不静默复用旧结论。
 */
function termLayerFor(layer, profileId, { proofreadMode = "bilingual", targetKey = "cn", files = null } = {}) {
  if (!layer || !layer.byProfile) return null;
  const entry = layer.byProfile[profileId] || null;
  if (!entry) return null;
  const currentFiles = files ? normalizeTermTablePaths(files) : currentTermFiles(profileId);
  const current = currentFiles.length
    ? tablesFingerprint(TERM_LAYER_VERSION, currentFiles, entry.entries || 0)
    : "";
  const key = termVariantKey(proofreadMode, targetKey);
  return {
    stale: !current || current !== entry.fingerprint,
    entry,
    variantKey: key,
    variant: (entry.variants || {})[key] || null,
    currentFingerprint: current,
  };
}

/** 变体判定 → 行号集合，供运行期交叉校验与页面徽标使用。 */
function variantIndexSets(variant) {
  return {
    consistent: new Set((variant?.consistent || []).map(Number)),
    conflicts: new Set((variant?.conflicts || []).map(Number)),
  };
}

/** 构建期日志与脚本共用的一句话摘要。 */
function describeTermLayerEntry(entry, variantKey = "") {
  if (!entry) return "";
  const variant = (entry.variants || {})[variantKey || entry.defaultVariant] || null;
  if (!variant) return "";
  const targetLabel = variant.targetKey === "tw" ? "非原文 C" : "译文 B";
  return `对照表：${(entry.files || []).length} 张表 / ${entry.entries} 条术语 / 命中 ${variant.hits} 行（译名一致 ${variant.summary.consistent}，需人工确认 ${variant.summary.conflicts}，目标列 ${targetLabel}）`;
}

module.exports = {
  TERM_LAYER_VERSION,
  buildTermLayer,
  describeTermLayerEntry,
  termLayerFor,
  termVariantKey,
  termVariantsFor,
  variantIndexSets,
};
