/**
 * 成品格式门禁（确定性工序）：结论产出之后、写回之前，按行落实「一行 = 一个成品段落」这条结构不变量。
 *
 * 为什么需要：`revisedText` 会被人工直接写回成品，而提示词只能“要求”，做不到“保证”。
 * 真实回归（第 1166 行）：那一行的原文列是**两段**（`…刺さったままだった。\n\n今のまま地面に…`，
 * 页面把换行渲染成空格，人眼看不出来），目标列只有一段；模型据此判定「译文把原文换行丢了」，
 * 于是把 `\n` 写进了修订结果——页面上修改结果被切成两行，写回时按 `\n{2,}` 分段的 `alignParts`
 * 随之错位（多余的替换段被 `<br/>` 接到末段、或多余的原文段被清空），而**行边界由对齐决定，
 * 不属于语言质量问题**（通用侧提示词已写明，这里做确定性兜底）。
 * 同一个形状还有几种面：`<br>` 换行标记、模型自己加的空行、行首行尾空白，
 * 以及目标列内联标记（EPUB noteref）被改写、丢失或从原文补入。
 *
 * 四条纪律（改这个文件前先读）：
 * - **只动结构与内联标记，不动文字**：除换行标记外不增删任何字符，不重排语序，不做任何语义判断；
 * - **段结构按写回口径判定**：一段 = 目标列按 `\n{2,}` 切出的片段（与 `src/ingest/writeback.js`
 *   的 `splitParts` 同一口径，两处口径必须一致）。目标列单段（实测整卷 3119 行里的绝大多数）时，
 *   修订结果也必须是一段——模型插入的换行与空行一律并回本行；目标列本身是多段行时必须段数相同；
 * - **修不了就作废转人工，不猜**：段数不一致、noteref 标记增减都无法确定性还原（段与段的对应
 *   关系、标记的原位都不可知），而写回是按段一一对应的，猜错会静默删改源文件——所以这里作废
 *   修订结果并置 `needsContext=true`，与 `ai-proofread.js` 的 `guardTargetScript` 同一处置；
 * - **改了什么必须留痕**：备注的分析栏里写一行「格式自动规范化：…」（说明行必须排在「修改结果：」
 *   之前，见 `analysisLines`），计数走 `status.formatFixes`/`formatVoids`/`formatLineBreaks`/
 *   `formatParagraphs`/`formatNoteFields`，任务结束由 `finish()` 汇报一次。
 */

// 备注分析栏那一行的段首标记：客户端 `isNoteProseLine` 按它把说明行归到分析栏，
// 否则它会并进「修改结果：」被当成成品文本写回（见 `public/workbench-client.js`）。
const FORMAT_NOTE_PREFIX = "格式自动规范化：";

// 换行标记与换行符：模型有时用 `<br>` 表达它“看到的原文换行”，与 `\n` 是同一件事。
// 一次匹配一整串（含两侧的空格与制表符），这样 `abc \n def` 不会留下双空格。
const BREAK_RUN_PATTERN = /(?:[ \t]*(?:\r\n?|\n|<br\s*\/?>))+[ \t]*/gi;
const BREAK_MARK_PATTERN = /<br\s*\/?>|\r\n?|\n/gi;
// 段分隔：直接复用 writeback.splitParts，保证口径永远一致（不再手写同一个正则）。
const { splitParts: splitParagraphs } = require("../../../ingest/writeback");
// 目标列的内联注释标记（成品 `<a epub:type="noteref">` 与 Pandoc 的 `class="…noteref…"` 两种写法）。
// 只认 `<a>` 标签上的 noteref：正文里光一个 `㊟` 符号不算标记（它可能就是普通文字）。
const NOTEREF_PATTERN = /<a\b[^>]*\bnoteref\b[^>]*>/gi;
const ASCII_ALNUM = /[A-Za-z0-9]/;

/** 目标列里有几个 noteref 标记（写回时这些标记必须逐字、原位保留）。 */
function countNoterefs(text) {
  return Array.from(String(text == null ? "" : text).matchAll(NOTEREF_PATTERN)).length;
}

/**
 * 换行处该接什么字符：中日文之间不加分隔符（中文正文不用空格断句），
 * 只有两侧都是 ASCII 字母/数字时才补一个空格——否则 `line\nbreak` 会被粘成 `linebreak`。
 */
function joinBreak(left, right) {
  const before = String(left || "").slice(-1);
  const after = String(right || "").slice(0, 1);
  if (!before || !after) return "";
  return ASCII_ALNUM.test(before) && ASCII_ALNUM.test(after) ? " " : "";
}

/**
 * 把一段文本里的换行全部并回同一段（纯函数）。
 *
 * @param {string} text 单段文本（多段文本要先按 `splitParagraphs` 切开，段间分隔不能被吃掉）
 * @returns {{text: string, lineBreaks: number, paragraphs: number}}
 *   `lineBreaks` 是删掉的换行处数（一串连续换行算一处）；`paragraphs` 其中属于段落分隔的处数
 *   （换行权重 ≥2：`\n\n` 或 `<br><br>`），用于在备注里区分“删了一个硬换行”与“并回了一个段落”。
 */
function collapseInlineBreaks(text) {
  const source = String(text == null ? "" : text);
  let lineBreaks = 0;
  let paragraphs = 0;
  const collapsed = source.replace(BREAK_RUN_PATTERN, (run, offset, whole) => {
    lineBreaks += 1;
    const weight = Array.from(run.matchAll(BREAK_MARK_PATTERN)).length;
    if (weight >= 2) paragraphs += 1;
    return joinBreak(whole.slice(0, offset), whole.slice(offset + run.length));
  });
  return { text: collapsed, lineBreaks, paragraphs };
}

/**
 * 说明字段（`summary`/`suggestion`）里的换行折叠成一个空格。
 *
 * 为什么连备注字段也要管：备注是按行取值的（客户端 `parseAutomatedNote`），`summary` 里换行后
 * 若出现一行以「修改结果：」起头，解析层会把它当成另一条修改结果并**覆盖**真正的成品文本——
 * 模型偶尔会把结论格式照抄进 summary，这一条是纯粹的防呆，不改变任何文字内容。
 */
function foldNoteLines(value) {
  const source = String(value == null ? "" : value);
  let count = 0;
  // 一次替换吃掉整串空白（含两侧空格），所以折叠后不会留下双空格。
  const folded = source.replace(/\s*\n\s*/g, () => {
    count += 1;
    return " ";
  }).trim();
  return { text: folded, count, changed: folded !== source.trim() };
}

/** 作废原因的中文说明：人工只读结果，也要一眼看出这行为什么被作废。 */
function formatVoidReason(reason, detail = {}) {
  const target = Number(detail.target || 0);
  const revised = Number(detail.revised || 0);
  if (reason === "paragraph-structure") {
    return `模型给出的修改结果段落结构与目标列不一致（目标列 ${target} 段、修改结果 ${revised} 段），写回按段一一对应，已作废并转人工确认。`;
  }
  if (reason === "noteref-lost") {
    return `模型给出的修改结果丢失了目标列的 EPUB noteref 注释标记（目标列 ${target} 个、修改结果 ${revised} 个），已作废并转人工确认。`;
  }
  if (reason === "noteref-added") {
    return `模型给出的修改结果补入了目标列没有的 EPUB noteref 注释标记（目标列 ${target} 个、修改结果 ${revised} 个），已作废并转人工确认。`;
  }
  return "";
}

/**
 * 一行的成品格式门禁（纯函数，不读配置、不写日志、不改全局状态）。
 *
 * 判据（按顺序）：
 * 1. **noteref 保真**（增减都作废）：目标列有几个 noteref 标记，修订结果就必须有几个——
 *    少了是成品丢注释，多了是把原文那侧的标记补了进来（提示词侧的硬性格式约束明确禁止）；
 * 2. **段结构保真**：目标列 ≥2 段时，修订结果的段数必须相同（不同则作废，不猜对应关系）；
 * 3. **并回本行**：目标列单段时把修订结果里的换行/空行全部并成一段；目标列多段时只并段内硬换行；
 * 4. **行首尾空白**去掉（写回是按段 trim 的，留着只会让页面上的成品文本多出空行）。
 *
 * @param {{revisedText?: string, targetText?: string, summary?: string, suggestion?: string}} input
 * @returns {{revisedText: string, summary: string, suggestion: string, changed: boolean,
 *   voided: boolean, reason: string, detail: string,
 *   fixes: {lineBreaks: number, paragraphs: number, trimmed: number, noteFields: number}}}
 *   `voided` 为 true 时 `revisedText` 恒为空串、`detail` 是给人工看的原因说明。
 */
function guardRowFormat(input = {}) {
  const notes = foldNoteLines(input.summary);
  const suggestion = foldNoteLines(input.suggestion);
  const revised = String(input.revisedText == null ? "" : input.revisedText);
  const targetText = String(input.targetText == null ? "" : input.targetText);
  const fixes = { lineBreaks: 0, paragraphs: 0, trimmed: 0, noteFields: notes.count + suggestion.count };
  const result = {
    revisedText: revised,
    summary: notes.text,
    suggestion: suggestion.text,
    changed: notes.changed || suggestion.changed,
    voided: false,
    reason: "",
    detail: "",
    fixes,
  };
  // 没有修订结果（无需修改、待人工确认、或已被语言护栏作废）时只剩说明字段的折叠。
  if (!revised) return result;

  const targetNoterefs = countNoterefs(targetText);
  const revisedNoterefs = countNoterefs(revised);
  if (targetNoterefs !== revisedNoterefs) {
    const reason = revisedNoterefs < targetNoterefs ? "noteref-lost" : "noteref-added";
    const detail = { target: targetNoterefs, revised: revisedNoterefs };
    return { ...result, revisedText: "", changed: true, voided: true, reason, detail: formatVoidReason(reason, detail) };
  }

  const parts = splitParagraphs(revised);
  const targetCount = Math.max(splitParagraphs(targetText).length, 1);
  if (targetCount >= 2 && parts.length !== targetCount) {
    const detail = { target: targetCount, revised: parts.length };
    return {
      ...result,
      revisedText: "",
      changed: true,
      voided: true,
      reason: "paragraph-structure",
      detail: formatVoidReason("paragraph-structure", detail),
    };
  }

  // 目标列单段：整行当一段处理，模型插入的段落分隔也一并并回（那些分隔本来就是它自己加的）。
  // 目标列多段：逐段处理，段间分隔原样保留（段数已核对过）。
  const groups = targetCount === 1 ? [revised] : parts;
  const collapsed = groups.map((part) => collapseInlineBreaks(part));
  const joined = collapsed.map((part) => part.text).join("\n\n");
  const text = joined.trim();
  for (const part of collapsed) {
    fixes.lineBreaks += part.lineBreaks;
    fixes.paragraphs += part.paragraphs;
  }
  fixes.trimmed = text === joined ? 0 : 1;
  const changed = text !== revised || result.changed;
  return { ...result, revisedText: text, changed, fixes };
}

/**
 * 改动明细（日志与备注共用一份措辞，避免两处漂移）：没有改动时返回空串。
 * 备注意外多加一句口径说明（`formatFixNote`），日志只用明细。
 */
function formatFixDetail(fix) {
  if (!fix) return "";
  const parts = [];
  if (fix.lineBreaks) parts.push(`删除模型插入的换行 ${fix.lineBreaks} 处`);
  if (fix.paragraphs) parts.push(`把 ${fix.paragraphs} 个多余段落并回本行`);
  if (fix.trimmed) parts.push("去掉行首尾空白");
  if (fix.noteFields) parts.push(`说明字段里的换行 ${fix.noteFields} 处`);
  return parts.join("、");
}

/**
 * 备注分析栏那一行：程序改过模型输出就必须让人工看见（它不是模型写的措辞）。
 * 没有改动时返回空串（这一层只在真的动过格式时留痕）。
 */
function formatFixNote(fix) {
  const detail = formatFixDetail(fix);
  if (!detail) return "";
  return `${FORMAT_NOTE_PREFIX}${detail}（一行就是一个成品段落；行边界由对齐决定，不属于翻译缺陷）`;
}

module.exports = {
  FORMAT_NOTE_PREFIX,
  collapseInlineBreaks,
  countNoterefs,
  foldNoteLines,
  formatFixDetail,
  formatFixNote,
  formatVoidReason,
  guardRowFormat,
  splitParagraphs,
};
