/**
 * 目标列标点的确定性规范化（半角 ↔ 全角）：结论产出之后的最后一道工序，只动标点。
 *
 * 为什么需要：成品规范（`profiles/novel.js` 的排版层）要求中文正文用全角标点，但提示词只能“要求”，
 * 做不到“保证”——实测模型会在自己的 revisedText 里打出「......」（第 1040 行真实回归），
 * 也会把整段英文句子里的标点写成全角。而备注里的「修改结果：」会被人工直接写回成品，
 * 所以这一层按语境做确定性的宽度统一，并把改了几处如实报给备注与日志（不静默改模型输出）。
 *
 * 三条边界（改这个文件前先读）：
 * - **英文句子与 ASCII 词元保持半角**：一段英文（标点两侧都是字母/数字）里的逗号、句点、问号
 *   一律不动；反过来，只有在**有正向 ASCII 证据**时（见 `isLatinContext`）才把全角标点还原成半角——
 *   否则“标点全角化”这条要求会把英文句子写坏，这正是「出现英文句子时应该用半角」的落点。
 *   反向判据必须是正向证据：整卷实测表明，只按“附近没有汉字”判断会把整行只有标点与拟声符号的行
 *   （`「……」`、`「～～～！！！」`、整行的 `……`）当成英文，把标准省略号改坏（3119 行里 50 行误判）。
 * - **只认语境，不认语义**：判据只有一条——标点紧邻的左右字符（跳过空白与引号）是什么。
 *   数字、版本号、缩写（`3.5`、`v1.2`、`e.g.`）、URL（`http://a.b/c?x=1`）之所以安全，
 *   正是因为它们的标点两侧都是 ASCII，不需要任何词语级判断。
 * - **内联标记整段跳过**：`<ruby>基文<rt>注文</rt></ruby>`、`<a epub:type="noteref">` 这类标签
 *   先摘出来再按序还原，标签内部的标点（属性里的 `:`、`"`）不会被改写；引号本身
 *   （`"` `'` → 「」『』）也不在这里处理——配对与撇号判断交给提示词，硬转换会改坏英文缩写。
 *
 * 计数口径：`toFull`/`toHalf` 是**处**（一次规范化动作：连续同类标点算一处、成对括号算一处），
 * 不是字符数。
 */

// 内联标记先摘出来，用私用区字符占位：它同时充当“文档上下文里的一侧”，
// 这样 `<b>你好</b>，` 这种跨标签的语境判断与中文语境一致。
const TAG_PATTERN = /<\/?[A-Za-z][^>]*>/g;
const TAG_SENTINEL = "\uE000";
// 中日文语境：CJK 标点、假名、汉字、全角形式，以及标签占位符。
const CJK_CONTEXT = /[\u3000-\u303f\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff01-\uff60\uffe0-\uffe6\uE000]/u;
// “这一段文字是中日文写的”判据（反向规范化用）：只看汉字、假名与标签占位符，**不算标点**。
const CJK_SCRIPT = /[\u3040-\u30ff\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uE000]/u;
const ASCII_ALNUM = /[A-Za-z0-9]/;
// 找“左右邻居”时一并跳过的字符：空白与引号。引号不参与判宽度，但它挡在中间会让
// 「他问'这样吗'?」这类写法判不出中文语境。
const SKIP_FOR_NEIGHBOUR = /[\s"'\u2018\u2019\u201c\u201d]/u;

const HALF_TO_FULL = Object.freeze({ ",": "，", ".": "。", "!": "！", "?": "？", ";": "；", ":": "：" });
const FULL_TO_HALF = Object.freeze({ "，": ",", "。": ".", "！": "!", "？": "?", "；": ";", "：": ":" });
const OPENERS = "（(";
const CLOSERS = "）)";
const ELLIPSIS = "……";

/** 左侧最近的、不在跳过表里的字符（`index` 是区间的**起始**下标）。 */
function neighbourBefore(text, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!SKIP_FOR_NEIGHBOUR.test(text[i])) return text[i];
  }
  return "";
}

/** 右侧最近的、不在跳过表里的字符（`index` 是区间的**结束**下标 + 1）。 */
function neighbourAfter(text, index) {
  for (let i = index; i < text.length; i += 1) {
    if (!SKIP_FOR_NEIGHBOUR.test(text[i])) return text[i];
  }
  return "";
}

/**
 * 反向规范化的语境判断（全角 → 半角）：必须有**正向的 ASCII 证据**。
 *
 * 判据（`start` 为起始下标、`end` 为结束下标 + 1）：
 * - 左右紧邻字符都是 ASCII 字母/数字 → 英文句子内部，还原；
 * - 只有一侧是、另一侧是行边界 → 还要求整段文本里没有汉字/假名（`This is a test， isn't it？`
 *   句末的问号因此会还原，而 `他说 ABC。` 的句号保持全角）；
 * - 一侧是 ASCII、另一侧是 `」`/`、` 之类的字符，或两侧都不是 ASCII → 按中文处理，不动。
 */
function isLatinContext(text, start, end) {
  const before = neighbourBefore(text, start);
  const after = neighbourAfter(text, end);
  const beforeAscii = ASCII_ALNUM.test(before);
  const afterAscii = ASCII_ALNUM.test(after);
  if (beforeAscii && afterAscii) return true;
  if (!beforeAscii && !afterAscii) return false;
  const other = beforeAscii ? after : before;
  if (other) return false;
  return !CJK_SCRIPT.test(text);
}

function isCjkSide(ch) {
  return Boolean(ch) && CJK_CONTEXT.test(ch);
}

function matchingCloser(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    if (OPENERS.includes(text[i])) depth += 1;
    else if (CLOSERS.includes(text[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 括号成对处理：整对一起改或不改，避免出现「（test)」这种半对。
 * - 半角 → 全角：括号内是中日文，或括号外紧邻的一侧是中日文；
 * - 全角 → 半角：括号内没有中日文，且括号外两侧都是 ASCII 字母/数字（英文句子里的括号）。
 * 落单的括号一律不动。
 */
function normalizeBrackets(text, stats) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (!OPENERS.includes(ch)) {
      out += ch;
      i += 1;
      continue;
    }
    const closeIndex = matchingCloser(text, i);
    if (closeIndex === -1) {
      out += ch;
      i += 1;
      continue;
    }
    const inner = text.slice(i + 1, closeIndex);
    const before = neighbourBefore(text, i);
    const after = neighbourAfter(text, closeIndex + 1);
    const innerHasCjk = CJK_CONTEXT.test(inner);
    if (ch === "(" && (innerHasCjk || isCjkSide(before) || isCjkSide(after))) {
      out += `（${inner}）`;
      stats.toFull += 1;
    } else if (ch === "（" && !innerHasCjk && isLatinContext(text, i, closeIndex + 1)) {
      out += `(${inner})`;
      stats.toHalf += 1;
    } else {
      out += `${ch}${inner}${text[closeIndex]}`;
    }
    i = closeIndex + 1;
  }
  return out;
}

/**
 * 省略号：连续句号（两个及以上）或连续半角点（两个及以上）在中文语境下统一写成「……」；
 * 只有正向 ASCII 证据成立时，「……」才还原成三个半角点。单个「…」不动——那是另一条（形态）规范。
 */
function normalizeEllipsis(text, stats) {
  let out = text.replace(/。{2,}/gu, () => {
    stats.toFull += 1;
    return ELLIPSIS;
  });
  out = out.replace(/\.{2,}/g, (run, offset, whole) => {
    const before = neighbourBefore(whole, offset);
    const after = neighbourAfter(whole, offset + run.length);
    if (!isCjkSide(before) && !isCjkSide(after)) return run;
    stats.toFull += 1;
    return ELLIPSIS;
  });
  out = out.replace(/……/gu, (run, offset, whole) => {
    if (!isLatinContext(whole, offset, offset + run.length)) return run;
    stats.toHalf += 1;
    return "...";
  });
  return out;
}

/**
 * 单个标点（，。？！；：）按语境定宽度：连续同类标点整串一起判，避免「！！」被改成「！!」。
 * 半角在中文语境（任一侧是中日文）→ 全角；全角在英文语境（见 `isLatinContext`）→ 半角。
 *
 * 句点有一条例外：**紧贴 ASCII 字母/数字的 `.` 不动**（`e.g.`、`U.S.A.`、`Mr.`、`Level 5.`
 * 这类写法一旦被“全角化”就成了坏文本）。代价是中文句子以英文词收尾时那个句点保持半角——
 * 与“英文语境用半角”一致，可以接受。
 */
function normalizeSingleMarks(text, stats) {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const toFull = HALF_TO_FULL[ch];
    const toHalf = FULL_TO_HALF[ch];
    if (!toFull && !toHalf) {
      out += ch;
      i += 1;
      continue;
    }
    let end = i;
    while (end + 1 < text.length && text[end + 1] === ch) end += 1;
    const runLength = end - i + 1;
    const before = neighbourBefore(text, i);
    const after = neighbourAfter(text, end + 1);
    const gluedToLatin = ch === "." && i > 0 && ASCII_ALNUM.test(text[i - 1]);
    if (toFull && !gluedToLatin && (isCjkSide(before) || isCjkSide(after))) {
      out += toFull.repeat(runLength);
      stats.toFull += 1;
    } else if (toHalf && isLatinContext(text, i, end + 1)) {
      out += toHalf.repeat(runLength);
      stats.toHalf += 1;
    } else {
      out += text.slice(i, end + 1);
    }
    i = end + 1;
  }
  return out;
}

/**
 * 目标列文本的标点宽度规范化（纯函数，不读配置、不写日志）。
 *
 * @param {string} value 模型给出的 revisedText（或任何要写回成品的文本）
 * @returns {{text: string, changed: boolean, toFull: number, toHalf: number}}
 *   `toFull`/`toHalf` 是半角→全角、全角→半角的**处**数；`changed` 为 false 时 text 与入参逐字相同。
 */
function normalizeTargetPunctuation(value) {
  const original = String(value == null ? "" : value);
  const stats = { toFull: 0, toHalf: 0 };
  if (!original) return { text: original, changed: false, ...stats };

  const tags = [];
  const guarded = original.replace(TAG_PATTERN, (tag) => {
    tags.push(tag);
    return TAG_SENTINEL;
  });
  let text = normalizeBrackets(guarded, stats);
  text = normalizeEllipsis(text, stats);
  text = normalizeSingleMarks(text, stats);
  let cursor = 0;
  text = text.replace(new RegExp(TAG_SENTINEL, "gu"), () => (cursor < tags.length ? tags[cursor++] : TAG_SENTINEL));

  return { text, changed: text !== original, ...stats };
}

module.exports = {
  ELLIPSIS,
  normalizeTargetPunctuation,
};
