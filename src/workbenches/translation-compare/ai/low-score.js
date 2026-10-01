/**
 * 低分归因与修复层：本行被判为极低分（严重缺陷）时，先让模型**解释为什么该扣这么多分**，
 * 再按归因给出修复；顺序调换只是其中一类归因，不是这一层的全部。
 *
 * 位置（与既有分层的顺序）：
 *   对照表（离线判定） → 模型（必要时补相邻行再判） → **低分归因与修复（相邻行）** → 线上查询层 → 待人工确认。
 *
 * 为什么需要这一层：极低分（例如 20 分）在逐行视角下长得都一样——“与原文毫无关系”“凭空多出台词”，
 * 但真实原因可能完全不同：整行与相邻行**互换**了、本行只是上下句的一半、代词与省略主语依赖上下文、
 * 真的把否定/时态/因果弄错了、译文自己加了原文没有的话、原文本身晦涩被误判……原因不同，修法就不同：
 * 按错位修要重写整行并保持原文行序，按片段修就不该判缺陷，按上下文修要再补相邻行。
 * 所以低分不能直接当“逐句误译”处理，必须先归因、再动手。
 *
 * 四条纪律（改这个文件前先读）：
 * - **判据窄**：只有 `needsEdit=true`、不是 needsContext/unclear、且扣分达到阈值（或档位为 poor）
 *   的行走进来。普通缺陷（用词、翻译腔、行内语序）不进这一层，否则每行都要多发一次请求。
 * - **错位是必查项**：低分归因里最容易漏的就是“本行译文其实是邻行的内容”——逐行看它必然被误判成
 *   逐句重译，所以归因段强制先核对相邻行的原文/译文配对，再谈别的可能。
 * - **原文行序不动**：日语原文的行序与行边界由上游对齐给定。错位是**译文自身**的缺陷，
 *   只能在“本行原文该译成什么”的范围内修；禁止建议对调相邻两行、禁止把邻行译文
 *   或两行内容一起塞进 revisedText。这正是“保持日文顺序，但要意识到被调换了”的落点。
 * - **上下文优先**：现有相邻行不足以定论时，要求模型返回 needsContext=true，由程序继续补更多相邻行，
 *   而不是凭猜测产出 revisedText。宁多多问一轮，不产出编造的译文。
 *
 * `cause` 字段只在本次真的进入这一层时才需要填：未进入的行填什么都按“未归因”处理。
 */

// 提示词段的段首标记：自定义提示词里若残留旧段，组装阶段按此前缀剥离（见 proofread-contract）。
const LOW_SCORE_PREFIX = "【低分归因与修复（本行）】";

/** 扣分达到这个值（等价 score ≤ 40）就视为“极低分”，进入归因层。 */
const DEFAULT_LOW_SCORE_PENALTY = 60;
/** 归因时至少把窗口扩到本行前后各几行（仍不足时按模型的 needsContext 继续扩）。 */
const DEFAULT_LOW_SCORE_ROWS = 2;

/**
 * 归因取值 → 中文标签。取值集合就是这一层的“修复方式分支”：
 * 每一类对应的修法不同，所以不能让模型只回一句“译得不好”。
 */
const CAUSE_LABELS = Object.freeze({
  "order-shift-prev": "跨行错位（本行译文实际写的是上一行的内容）",
  "order-shift-next": "跨行错位（本行译文实际写的是下一行的内容）",
  "order-shift": "跨行错位（未给出方向）",
  boundary: "对齐切分（本行只是上下句的一半，行边界不属于语言质量）",
  context: "依据不足（需要更多相邻行才能定论）",
  meaning: "语义硬伤（否定/时态/主被动/主谓宾/因果/数字/人名等）",
  content: "内容层面（关键信息遗漏，或译文加了原文没有的话）",
  term: "术语或译名不一致",
  wording: "表达层（翻译腔、成分残缺、指代不明，未伤及核心语义）",
  "source-style": "原文风格化写法，不构成缺陷",
  none: "复核后认为无需修改",
  unclear: "归因不了，转终审确认",
});

/** 一类取值对应一组可接受的写法（中英文与口语说法都收），未经归一的值一律丢弃。 */
const CAUSE_ALIASES = Object.freeze({
  "order-shift-prev": ["order-shift-prev", "shifted-prev", "prev", "previous", "swap-prev", "错位-上", "错位-前", "与上一行错位", "与前行错位", "本行译文是上一行的内容"],
  "order-shift-next": ["order-shift-next", "shifted-next", "next", "swap-next", "错位-下", "错位-后", "与下一行错位", "与后行错位", "本行译文是下一行的内容"],
  "order-shift": ["order-shift", "shift", "shifted", "swap", "reorder", "错位", "跨行错位", "顺序调换", "调换"],
  boundary: ["boundary", "alignment", "align", "fragment", "split", "片段", "对齐切分", "行边界", "断句位置"],
  context: ["context", "needs-context", "needscontext", "上下文", "依据不足", "上下文不足", "需要更多上下文"],
  meaning: ["meaning", "semantic", "sense", "语义", "语义硬伤", "误译", "错译"],
  content: ["content", "omission", "addition", "missing", "遗漏", "漏译", "增译", "信息脱落"],
  term: ["term", "terminology", "glossary", "术语", "译名", "译名不一致"],
  wording: ["wording", "expression", "style-of-target", "表达", "表达层", "翻译腔", "措辞", "成分残缺"],
  "source-style": ["source-style", "sourcestyle", "style", "原文风格", "风格化", "原文晦涩", "刻意重复"],
  none: ["none", "no-issue", "noissue", "ok", "无需修改", "不构成缺陷", "误判", "评分过高"],
  unclear: ["unclear", "unknown", "unsure", "不确定", "无法判断", "归因不了", "待确认", "转人工"],
});

/**
 * 是否进入低分归因层（纯函数，与请求无关，便于测试）。
 * - 只处理“已判为需要修改、且判得下来”的行：needsContext / unclear 走的是补上下文那条路；
 * - 判据只有一条：**扣分达到 `minPenalty`**（默认 60，等价 score ≤ 40）。不用档位兜底，
 *   是因为 `computeScoreAndGrade` 会把“只给 poor 档、不给分数”的行折算出 penalty=45，
 *   一旦用档位兜底就等于把整个 poor 档（score < 60）都拉进这一层，阈值参数也就形同虚设；
 *   真要让整档都归因，把 `minPenalty` 调到 45 即可（配合 `TRANSCOMPARATOR_LOW_SCORE_PENALTY`）；
 * - `hasNeighbor=false`（本行前后都没有别的行）时无从复核，直接跳过。
 */
function shouldCheckLowScore({ decision, minPenalty = DEFAULT_LOW_SCORE_PENALTY, hasNeighbor = true } = {}) {
  if (!decision || !hasNeighbor) return false;
  if (decision.needsEdit !== true) return false;
  if (decision.needsContext || decision.better === "unclear") return false;
  const penalty = Number(decision.penalty);
  return Number.isFinite(penalty) && penalty >= minPenalty;
}

/** `cause` 字段归一化：接受中英文与常见近义写法；认不出时返回空串（按“未归因”处理）。 */
function normalizeCause(value) {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  for (const [cause, aliases] of Object.entries(CAUSE_ALIASES)) {
    if (aliases.includes(text)) return cause;
  }
  // 带方向的错位说法散布在别名里，这里再兜一层前缀匹配（如 "order-shift-prev 跨行错位"）。
  for (const cause of Object.keys(CAUSE_ALIASES)) {
    if (text.startsWith(cause)) return cause;
  }
  return "";
}

/** 归因标签：备注、日志与状态显示共用一套措辞，未知取值退回空串。 */
function causeLabel(cause) {
  return CAUSE_LABELS[cause] || "";
}

/** 是否把原因归到“跨行错位”这一支（统计与备注的单列计数只看它）。 */
function isShiftCause(cause) {
  return cause === "order-shift" || cause === "order-shift-prev" || cause === "order-shift-next";
}

/** 错位方向的中文说法（只在原因确实是错位时用）。 */
function causeDirection(cause) {
  if (cause === "order-shift-prev") return "上一行";
  if (cause === "order-shift-next") return "下一行";
  return "";
}

/**
 * 一轮归因段：说明“为什么现在要复核”“按什么顺序归因”“每一类归因怎么修”。
 * 相邻行的原文与译文配对由 user 载荷的 `nearbyRows` 给出，段里只写规则，不复制行文本。
 */
function lowScoreBlock({ targetLabel = "目标列", sourceLabel = "原文 A", rows = DEFAULT_LOW_SCORE_ROWS } = {}) {
  const raw = Number(rows);
  const window = Number.isFinite(raw) ? Math.min(4, Math.max(1, Math.round(raw))) : DEFAULT_LOW_SCORE_ROWS;
  return [
    LOW_SCORE_PREFIX,
    `本行刚被判为极低分（严重缺陷），但“看起来与${sourceLabel}无关”“像凭空多出来的话”这类现象背后往往是不同的原因，修法也不同。请在定稿前先给出**低分原因**，再按原因修：`,
    `1. 先核对跨行错位（必查，且优先于其它判断）：逐条对照 nearbyRows 里每一行的${sourceLabel}与${targetLabel}配对（已给出本行前后各 ${window} 行，不足时按第 5 点继续索取），判断本行${targetLabel}的内容是否其实对应**相邻某一行**的${sourceLabel}。两个方向都要看：本行承接了下一行的内容，或上一行的内容落到了本行。逐行视角下这种错位必然表现为“整行重译”，所以不能跳过这一步。`,
    `2. 再排除行边界问题：本行是否只是上下句的一半（以接续词、助词或标点收尾，缺少谓语）？如果是，行边界与断句位置由上游对齐决定，不属于语言质量问题——不得据此判缺陷，也不得把片段补全成完整句或改写上下句。`,
    `3. 然后才是真正的语言问题：语义硬伤（否定、时态、主被动、主谓宾、因果、数字、人名）、关键信息遗漏或${targetLabel}自己加的原文没有的话、术语或译名不一致、表达层问题（翻译腔、成分残缺、指代不明）。若${sourceLabel}本身晦涩、比喻跳脱或刻意重复，语义可以合理解释时不要判缺陷。`,
    `4. 把结论写进 cause（取值见输出约定），并在 summary 里用一句话说明“为什么扣这么多分、依据是什么”，再接修复说明；不要只写“需要修改”。`,
    `5. 若给出的相邻行仍不足以归因或确定本行该译成什么，返回 needsContext=true 并说明卡在哪里；程序会继续补更多相邻行。不要凭猜测填 revisedText——编造的译文比“待人工确认”代价大得多。`,
    `6. 修的时候保持${sourceLabel}的行序：错位只能按“本行${sourceLabel}该译成什么”来修，不得建议对调相邻两行的译文，不得把邻行${targetLabel}搬进本行，也不得把两行内容糅进一条 revisedText；revisedText 只覆盖本行。`,
    "7. 只依据给出的行文本判断，不要假设还存在未给出的行；复核后如果认为本行其实无需修改（例如原因只是原文风格或对齐片段），如实填 cause=none 或该类别，并按输出约定把 needsEdit 判为 false。",
  ].join("\n");
}

/**
 * 归因结果在备注里的那一行：人工只读结果，也要能一眼看出“这行为什么低分、修的是哪一类问题”。
 * 没有进入归因层的行走不到这里（`decision.lowScore` 只在这一层才挂上）。
 * `neighbors` 是**实际**核对到的相邻行数（窗口受数据集边界与预算限制，可能少于配置值）：
 * 备注如实写实际数字，不写“前后各 N 行”这种按配置推出来的说法。
 */
function lowScoreNote({ checked = false, cause = "", neighbors = 0 } = {}) {
  if (!checked) return "";
  const label = causeLabel(cause);
  const count = Number(neighbors) > 0 ? Math.round(Number(neighbors)) : 0;
  const windowText = count > 0 ? `（已核对相邻 ${count} 行）` : "";
  if (isShiftCause(cause)) {
    const direction = causeDirection(cause);
    return direction
      ? `低分归因：本行译文实际写的是**${direction}**的内容（跨行错位），已保持原文行序、按本行原文重写`
      : "低分归因：跨行错位（模型未给出方向），已保持原文行序、按本行原文重写";
  }
  if (!cause) {
    return `低分归因：已按低分复核口径核对相邻行${windowText}，模型未给出明确归因（结论见上方分析）`;
  }
  if (cause === "context" || cause === "unclear") {
    return `低分归因：${label}${windowText}，转终审确认`;
  }
  return `低分归因：${label}${windowText}`;
}

module.exports = {
  CAUSE_LABELS,
  DEFAULT_LOW_SCORE_PENALTY,
  DEFAULT_LOW_SCORE_ROWS,
  LOW_SCORE_PREFIX,
  causeDirection,
  causeLabel,
  isShiftCause,
  lowScoreBlock,
  lowScoreNote,
  normalizeCause,
  shouldCheckLowScore,
};
