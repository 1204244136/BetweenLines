/**
 * 对照表层：构建期算判定 + 运行期交叉校验。
 *
 * 为什么和说话习惯层不一样：
 * - 说话习惯层产出的**提示词上下文**（章级命中角色），运行期复用它就等价于现算，所以直接复用；
 * - 对照表层产出的是**行级结果**（写进备注、作为「不调用模型」的唯一依据：整行只有术语），结果的生成必须留在运行期：
 *   它要带当次任务的标签、目标列与「已人工确认」的过滤，构建期不能替用户写备注空间。
 * - 但「哪些行会被对照表命中、命中是一致还是冲突、哪些行整行只有术语」只依赖「整卷行数据 + 对照表」，
 *   与模型无关，因此在构建期算一次落盘：页面在跑任务之前就能标出待处理的行、给出预筛数字，
 *   离线脚本/AI/页面也能拿同一份结论对照，避免三处各算一份。
 *
 * 落盘块区分两类命中一致的行（`termOnly` / `injected`）：
 * - `termOnly`：原文的有效内容本身就是术语，对照表能给出完整结论，跳过模型；
 * - `injected`：术语一致但句中还有别的内容，这一行仍要交给模型，只把术语当提示词注入。
 * 对照表只能证明「术语用对了」，证明不了「整句翻译没问题」，所以两者绝不能混为一谈。
 *
 * 块里还带一份 `terms`（行号 → 该行命中的术语对，每行最多 `TERMS_PER_ROW_CAP` 条）：
 * 它只由「原文 + 对照表」决定，不涉及模型，因此可以随页面下发，让人在跑任务之前就能看见
 * “这行到底命中了哪些术语”；**行文本与备注仍然不进产物**。
 *
 * 落盘块写在行数据之外（顶层 `termPrefilter`），不修改任何行字段，
 * 因此不改变 `rowsSignature`/`signature`，备注与写回定位不受影响。
 */
const {
  displayTermPair,
  evaluateTermRow,
  loadTermTables,
  normalizeTermTablePaths,
} = require("./ai/term-table");
const { hitsUsedInRow, termTargetKeyFor } = require("./ai/term-prefilter");
const { listProfiles, resolveProfile } = require("./ai/proofread-contract");
const { tableFilesForProfile, tableSourceCandidates, toPathList } = require("./layer-sources");
const { tableFileNames, tablesFingerprint } = require("../../core/table-fingerprint");

// 2：落盘块的 `files` 从「本机完整路径」改成「文件名」，运行期改为按当前档案重算指纹。
// 3：每个变体多一份 `terms`（行号 → 命中的术语对），供页面在跑任务之前就显示“这行命中了哪些术语”。
// 4：非人名条目声明注音时要求「基文 + 注文」都在原文里对上，命中集合随之变化；旧快照的判定口径不同，
//    必须靠版本号判过期（否则运行期会拿新口径去对旧结论，报出一堆假分叉）。
// 5：注音条目改成「中日两侧都注音才算表里那个专有名词」（见 ai/term-table.js 文件头）：
//    只对上原文侧的候选降级为「只作一致性证据」——译文用了该译名才算命中，否则不算命中。
//    影响的是命中集合本身（读音类条目重新参与判定），同样必须靠版本号判过期。
const TERM_LAYER_VERSION = 5;

// 每行最多随页面带上这么多条术语：命中行平均 2~3 条，上限定得宽松但能挡住病态行（同一行命中几十条）。
const TERMS_PER_ROW_CAP = 8;

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
  // 命中但整行还有术语之外的内容：一致性只覆盖术语，这些行仍要交给模型（术语只作提示词注入）。
  const injected = [];
  // 整行有效内容就是术语：对照表能给出完整结论，跳过模型（这是唯一跳过模型的情形）。
  const termOnly = [];
  // 术语冲突行：对照表有强证据差异，但**结论仍由模型结合整句给出**（术语判断是模型分析的一环）。
  // 这里单独列出是为了让页面标出“这行有术语冲突、注意模型怎么说”，不再表示“需人工确认”。
  const conflicts = [];
  // 其中「存疑」的那部分：命中的是假名写法（グループ、メンバー…），可能只是普通词。
  // 它们同样交给模型判断，单独计数是为了让人一眼看出“有多少行是拿不准才交给 AI 的”。
  let advisoryRows = 0;
  // 行号 → 该行命中的术语对（去方括号的「原文 → 译名（类型）」）：页面在跑任务前就能显示命中了什么。
  const terms = {};
  const chapters = new Map();
  // 被注音口径排除的候选（基文命中、但中日两侧没有同时注音，且译文也没用该译名；详见 term-table.js
  // 文件头）。它不改变结论，只用于说明“表里有这条、本行却没算命中”的原因，方便核对规则是否过严。
  const rubySkippedCandidates = [];
  // 降级为「只作一致性证据」的候选（同样是没有双侧注音，但译文确实用了该译名）。
  // 它们**算命中**，只是没有任何指控译名差异的能力；单独计数是为了看清新口径的影响面。
  const rubyDemotedCandidates = [];
  for (const row of rows) {
    const evaluation = evaluateTermRow({
      source: row.jp || "",
      target: String(row[targetKey] ?? ""),
      tables,
      rejected: rubySkippedCandidates,
      demoted: rubyDemotedCandidates,
    });
    if (!evaluation) continue;
    if (evaluation.kind === "term-only") termOnly.push(Number(row.index));
    else if (evaluation.kind === "conflict") conflicts.push(Number(row.index));
    else {
      injected.push(Number(row.index));
      if (evaluation.kind === "advisory") advisoryRows += 1;
    }
    // 页面上的术语块只列本行**确实用到**的术语（与注入给模型的同一批，见 hitsUsedInRow）。
    const pairs = [...new Set(hitsUsedInRow(row.jp || "", evaluation.hits).map((hit) => displayTermPair(hit.entry)))];
    if (pairs.length) terms[Number(row.index)] = pairs.slice(0, TERMS_PER_ROW_CAP);
    const chapter = String(row.chapter || "");
    chapters.set(chapter, (chapters.get(chapter) || 0) + 1);
  }
  // consistent 是「译名一致」的合并集合（页面徽标按它渲染），termOnly 是其中被跳过模型的那部分。
  const consistent = [...termOnly, ...injected].sort((a, b) => a - b);
  const hits = consistent.length + conflicts.length;
  return {
    proofreadMode,
    targetKey,
    hits,
    consistent,
    termOnly: termOnly.slice().sort((a, b) => a - b),
    injected: injected.slice().sort((a, b) => a - b),
    conflicts,
    terms,
    chapters: [...chapters.entries()].map(([chapter, count]) => ({ chapter, hits: count })),
    summary: {
      rows: rows.length,
      hits,
      consistent: consistent.length,
      termOnly: termOnly.length,
      injected: injected.length,
      advisory: advisoryRows,
      conflicts: conflicts.length,
      // 基文命中、但中日两侧没有同时注音且译文也没用该译名，因而被排除的候选条数
      // （非人名条目带注音时的匹配口径，见 term-table.js）。
      rubySkipped: rubySkippedCandidates.length,
      // 同样没有双侧注音、但译文用了该译名，因而降级为「只作一致性证据」的候选条数：
      // 它们算命中，只是不再具备指控译名差异的能力。
      rubyDemoted: rubyDemotedCandidates.length,
      // 对照表直接出结论、不再交给模型的行数（其余还要过规则/相似度预筛与模型）。
      removedFromModel: termOnly.length,
      aiRows: Math.max(0, rows.length - termOnly.length),
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
  const consistent = new Set((variant?.consistent || []).map(Number));
  const conflicts = new Set((variant?.conflicts || []).map(Number));
  // 旧快照只有 consistent/conflicts：那时所有命中一致的行都会跳过模型，
  // 这里回落到同一语义（termOnly=consistent），避免用新规则误读旧结论。
  const declared = Array.isArray(variant?.termOnly) ? variant.termOnly.map(Number) : [...consistent];
  const termOnly = new Set(declared);
  const injected = new Set([...consistent].filter((index) => !termOnly.has(index)));
  return { consistent, conflicts, termOnly, injected };
}

/** 构建期日志与脚本共用的一句话摘要。 */
function describeTermLayerEntry(entry, variantKey = "") {
  if (!entry) return "";
  const variant = (entry.variants || {})[variantKey || entry.defaultVariant] || null;
  if (!variant) return "";
  const targetLabel = variant.targetKey === "tw" ? "非原文 C" : "译文 B";
  const summary = variant.summary || {};
  const detail = summary.termOnly === undefined
    ? `译名一致 ${summary.consistent}`
    : `译名一致 ${summary.consistent}（整行只有术语 ${summary.termOnly}，需注入术语 ${summary.injected}）`;
  return `对照表：${(entry.files || []).length} 张表 / ${entry.entries} 条术语 / 命中 ${variant.hits} 行（${detail}，术语冲突交 AI 判断 ${summary.conflicts}，目标列 ${targetLabel}）`;
}

module.exports = {
  TERM_LAYER_VERSION,
  TERMS_PER_ROW_CAP,
  buildTermLayer,
  describeTermLayerEntry,
  termLayerFor,
  termVariantKey,
  termVariantsFor,
  variantIndexSets,
};
