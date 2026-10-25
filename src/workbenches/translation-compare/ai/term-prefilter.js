/**
 * 译名表预处理的两条出口：
 *
 * 1. **结果写入层**（`makeTermResult`）：只有整行有效内容都是术语（`term-only`）时，
 *    才写工作台可解析的备注；备注格式与 AI 校对保持一致（前三行是客户端解析的固定前缀），
 *    只把标记换成 `[译名表]`，这样工作台的备注展示、筛选、人工确认与批量操作都能直接复用。
 * 2. **提示词注入层**（`termBlock`/`termGuidanceFor`）：**其余命中行（含术语冲突）一律交给模型**。
 *    依据不足（句中还有别的内容、假名写法存疑）时术语只能作提示；**术语冲突也不是终局**——
 *    译名表给的是证据与线索（译文现用某个写法、或整条没译出来），要不要改、改哪里由模型结合
 *    整句判断，结论写进 AI 的备注里。「术语判断」是模型分析里的一个环节，不是面向人工的结果。
 */
const { describeTermHit, displayTermPair, formatTermHitGroups, markUsedTermAliases, stripInlineMarkup } = require("./term-table");

const TERM_MARKER = "[译名表]";
// 注入的术语提示段落的段首标记：自定义提示词里若残留上一次的段落，组装阶段按此前缀剥离。
const TERM_BLOCK_PREFIX = "【术语（译名表命中）】";
// 旧自定义提示词和备注继续可读；只在新产物中使用「译名表」。
const LEGACY_TERM_BLOCK_PREFIX = "【术语（对照表命中）】";

/**
 * 冲突明细的“分析”首段：明细**只列真正存在译名差异**的条目。它服务于**离线审计报告**
 * （`scripts/term-prefilter.js`）与构建期概览——术语冲突不再写工作台备注，所以这里不再拼备注文本。
 *
 * `evaluation.hits` 是“译名表在本行匹配到的全部条目”，里面混着三类东西：真差异
 * （`consistent === false`）、已确认一致、以及只命中分段或读音写法因而**明确未参与判定**的条目。
 * 旧版把三类一起挂在「存在译名差异 N 条」标题下，于是同一句里既有“译文已使用该译名”，
 * 又有“原文只出现了分段写法，未参与译名一致性判定”，人工得读完整串才能找到那一条真差异；
 * 同姓角色的分段命中（原文一个「青山」会带出青山春人/秋子等）还会成串混进来。
 * 这会让没有实际冲突的分段命中和已一致项淹没真正的差异，
 * 所以这里改成“差异明细 + 其余只给计数”：信息不丢，噪音不刷屏。
 */
function conflictAnalysisHead(hits = []) {
  // 存疑项（命中的是假名写法，可能只是普通词）不算差异：它已由译名表注明“交上下文/模型判断”，
  // 混进差异明细会让人以为这里已经确定译名错了。
  const conflicts = hits.filter((hit) => hit.consistent === false && !hit.advisory);
  const advisory = hits.filter((hit) => hit.advisory === true);
  const unjudged = hits.filter((hit) => !hit.advisory
    && (hit.scope === "part" || (hit.scope === "ruby" && hit.consistent !== true)));
  const agreed = hits.filter((hit) => !conflicts.includes(hit) && !advisory.includes(hit) && !unjudged.includes(hit));
  const detail = conflicts.map((hit) => describeTermHit(hit)).join(" ");
  const rest = [];
  if (agreed.length) rest.push(`${agreed.length} 条已确认一致`);
  if (advisory.length) rest.push(`${advisory.length} 条命中的是假名写法、可能为普通词，需结合上下文判断`);
  if (unjudged.length) rest.push(`${unjudged.length} 条原文只有分段或读音写法，未参与差异判定`);
  const head = `命中译名表 ${hits.length} 条，其中 ${conflicts.length} 条存在译名差异：${detail}`;
  return rest.length ? `${head}（另有 ${rest.join("、")}）` : head;
}

/**
 * 备注与提示词的公共出口：`term-only` 写入工作台备注（译名表唯一能替模型出的结论）。
 *
 * **冲突不再由译名表出结论**：`conflict` 行照常交给模型，术语冲突只作为提示词注入，
 * 由模型结合整句判断（「术语判断」是模型分析里的一个环节，不是面向人工的终局结果），
 * 所以这里收到 `consistent`/`advisory`/`conflict` 都直接报错。
 */
function makeTermResult(row, labels, evaluation, comparisonMode = "trilingual", targetKey = "cn") {
  const targetLabel = targetKey === "tw" ? (labels.tw || "非原文 C") : (labels.cn || "译文 B");
  const termOnly = evaluation.kind === "term-only";
  if (!termOnly) {
    throw new Error(`译名表只写「整行只有术语」的结论，其余命中行（含术语冲突）一律注入提示词后交给模型，收到：${evaluation.kind}`);
  }
  const head = `分析：命中译名表 ${evaluation.hits.length} 条（译名一致）：${formatTermHitGroups(evaluation.hits)}`;
  const tail = `该行有效内容全部是本项目术语，术语之外没有问题可校，因此不调用模型（目标列：${targetLabel}）。`;
  const note = [
    TERM_MARKER,
    "语义是否相同：相同",
    "是否需要修改：否",
    `${head}${tail}`,
  ];
  return {
    runId: null,
    index: row.index,
    signature: null,
    targetKey,
    status: "term-prefilter",
    done: true,
    note: note.join("\n"),
  };
}

function termTargetKeyFor(comparisonMode, target) {
  if (comparisonMode === "bilingual") return "cn";
  return target === "tw" ? "tw" : "cn";
}

/**
 * 术语提示段：把本行命中的术语与标准译名写给模型。
 * 只放“这一行用到了哪些术语”，不放“整卷术语表”，也不替模型判断整句；
 * 段内自带边界说明，模型必须结合原文与整句判断，不得把术语当机械替换指令。
 */
function termBlock(lines = [], targetLabel = "") {
  const rows = lines.filter(Boolean);
  if (!rows.length) return "";
  const target = String(targetLabel || "").trim();
  return [
    TERM_BLOCK_PREFIX,
    "本行原文命中了本项目译名表的下列条目：",
    ...rows.map((line) => `- ${line}`),
    `用法：${target ? `${target}里` : "译文里"}出现这些概念时，必须使用译名表给出的标准译名；发现译文用了其他译法、英文写法或字形不一致时，给出只替换术语的最小修改。`,
    "术语判断是本次分析里的一个环节：条目后面注明「译文未出现该译名」或「译文现用××」时，说明这一条的写法与项目译名不一致——请结合整句判断，确指该术语就必须用译名表译名并给出只替换术语的最小修改，只是普通词义、或原文此处本来就不是那个术语时按语义处理，并在结论里写明你的判断依据。",
    "边界：译名表只能证明术语译名对不对，不能证明整句翻译没有问题。术语之外的语义、完整性、语气与行文仍按常规规则逐项核对；译名表与原文冲突时以原文为准，不要机械替换。",
  ].join("\n");
}

/**
 * 本行**确实用到**的术语命中：提示词与页面上的术语块共用这一个筛子，
 * 保证「注入给模型的」与「显示给人的」是同一批术语。
 *
 * 只有两种情况算“用到了”：
 * - `term`：原文命中了整条术语；
 * - `ruby` 且译名一致：原文写的是读音、译文确实用了这个译名。
 * `part`（只命中姓或名）一律不算：同姓的其他角色会靠共用分段集体命中，把本行根本没出现的名字
 * 混进来（实测「御坂」一行会带出御坂美鈴、御坂旅挂）。覆盖率与判定另有各自口径，不受此影响。
 */
function hitsUsedInRow(sourceText, hits = []) {
  const byEntry = new Map();
  for (const hit of hits) {
    if (!byEntry.has(hit.entry.source)) byEntry.set(hit.entry.source, hit);
  }
  const candidates = [...byEntry.values()].filter((hit) => hit.scope === "term" || (hit.scope === "ruby" && hit.consistent === true));
  if (!candidates.length) return [];
  // 把候选条目的全部别名一起在原文里标出来，再判断每个条目是否真的用到（长别名优先、互不重叠）。
  const used = new Set(markUsedTermAliases(stripInlineMarkup(sourceText), candidates.flatMap((hit) => hit.aliases || []), { includeParts: false })
    .used.map((item) => item.alias));
  return candidates.filter((hit) => (hit.aliases || []).some((alias) => used.has(alias.alias)));
}

/**
 * 一行的术语提示内容：命中行才会返回；返回后由调用方（ai-proofread）组装成提示词段落。
 * 命中项按原文去重（同一术语在本行可能出现多次）。
 */
function termGuidanceFor(row, { evaluation = null, targetKey = "cn", targetLabel = "" } = {}) {
  if (!evaluation || !evaluation.hits || !evaluation.hits.length) return null;
  const terms = hitsUsedInRow(row?.jp || "", evaluation.hits).map((hit) => {
    const { entry, consistent, variant, scope, via, strong, advisory, demoted } = hit;
    const note = describeTermHit(hit);
    // 术语一律用去方括号的形态显示：表里的【】只是给注音标记位置，正文里不出现。
    const line = {
      source: entry.plainSource || entry.source,
      alias: entry.plainSource || entry.alias,
      target: entry.plainTarget || entry.target,
      targetText: entry.targetText || entry.target,
      type: entry.type || "",
      scope,
      strong: Boolean(strong),
      consistent: consistent === true,
      // 存疑项：命中的是假名写法（可能只是普通词），由模型结合上下文判断此处是否确指该术语。
      advisory: advisory === true,
      // 降级项：原文与译文没有同时注音，只作“译文用了该项目译名”的证据，不据此判定译名对错。
      demoted: demoted === true,
      variant: variant ? { from: variant.from, kind: variant.kind } : null,
      note,
    };
    line.text = displayTermPair(entry);
    // 提示词里的措辞面向模型：译名表给的是证据与线索，要不要改、改哪里由模型结合整句判断，
    // 所以不写「请人工确认」这类面向人工的结论口吻（备注向的措辞留在 note 里，离线脚本还在用）。
    if (variant) line.text += `（译文现用「${variant.from}」，属${variant.kind}，请判断是否需要改用本项目译名）`;
    else if (advisory) line.text += "（可能为普通词，需结合上下文判断）";
    else if (!consistent) line.text += "（译文未出现该译名，请判断此处是否确指该术语、是否需要改用该项目译名）";
    else if (demoted) line.text += "（原文与译文未同时注音，只作一致性证据：译文已用该译名，不据此改译名）";
    else if (via === "part") line.text += "（译文用了分段写法）";
    return line;
  });
  // 一条都没剩下（例如只靠分段或读音撞车）：本行当作没有术语提示。
  if (!terms.length) return null;
  return {
    targetLabel,
    count: terms.length,
    terms,
    block: termBlock(terms.map((term) => term.text), targetLabel),
  };
}

module.exports = {
  LEGACY_TERM_BLOCK_PREFIX,
  TERM_BLOCK_PREFIX,
  TERM_MARKER,
  conflictAnalysisHead,
  hitsUsedInRow,
  makeTermResult,
  termBlock,
  termGuidanceFor,
  termTargetKeyFor,
};
