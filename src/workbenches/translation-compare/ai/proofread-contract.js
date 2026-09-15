const { JSON_ONLY_INSTRUCTION, promptSections, withJsonOnly } = require("../../../ai/prompt-contract");
const { DEFAULT_PROFILE_ID, listProfiles, resolveProfile } = require("./profiles");
// 按行裁剪的依据与特征注册表都在 row-features；这里只用它做“该条目是否注入”的判断。
const { FEATURE_IDS, unknownFeatureIds } = require("./row-features");
// 实体闸门（只对某个角色/专有词成立的规则按行注入）：声明名单由档案给出，判定在 name-entities。
const { detectRowEntities, entityGateReport, profileEntities } = require("./name-entities");
// 段首标记的唯一定义在注入层（term-prefilter）：这里只借用前缀做剥离，不复制字面量。
const { TERM_BLOCK_PREFIX } = require("./term-prefilter");
// 线上查证段的段首标记同样只在注入层定义一次。
const { WEB_LOOKUP_PREFIX } = require("./web-lookup");
// 低分归因段的段首标记同样只在注入层定义一次。
const { LOW_SCORE_PREFIX } = require("./low-score");

// 每种模式一段说明，只有当前模式需要担心的字段语义才出现在该模式的契约里。
// 双语没有 counterpart 列：对外只问“保持还是替换”，不再问“谁更好”，避免模型臆想“另一份译文”。
//
// **形态纪律：这里只声明「键名 + 取值」，字段怎么判断一律写在系统提示词里（通用侧/模式层/动态段）。**
// 理由有两条：① 用户载荷里的这个对象是**每一行**都要重发一份的，而它的旧版把档位定义、片段口径、
// 说话人判断与低分归因口径都抄了一遍（单行 1159 字符），等于把系统提示词里的规则再买一次单；
// ② 同一件事写成两份必然漂移（改了一处另一处没过期）。所以：
// 档位与分数口径 → 通用侧；decision/better 的语义 → 模式层；speaker → 说话人判断段；
// cause 取值 → 低分归因段；revisedText 的结构、语言与标记边界 → 通用侧与固定尾巴。
const modeSchemas = Object.freeze({
  bilingual: Object.freeze({
    semanticSame: "boolean",
    needsEdit: "boolean",
    needsContext: "boolean",
    decision: "keep | replace | unclear",
    score: "number|null",
    penalty: "number|null",
    grade: "excellent | good | fair | poor",
    severity: "none | minor | major | critical",
    summary: "string",
    speaker: "string",
    cause: "string",
    revisedText: "string",
  }),
  trilingual: Object.freeze({
    semanticSame: "boolean",
    needsEdit: "boolean",
    needsContext: "boolean",
    better: "target | counterpart | neither | unclear",
    score: "number|null",
    penalty: "number|null",
    grade: "excellent | good | fair | poor",
    severity: "none | minor | major | critical",
    summary: "string",
    speaker: "string",
    cause: "string",
    revisedText: "string",
  }),
});

// 兼容旧引用点：默认导出三语版本（键集合相同，只有 better/decision 说明不同）。
const proofreadOutputSchema = modeSchemas.trilingual;

// 硬性格式约束的权威文本：范围只到“目标列自身已有的内联标记”。说成笼统的“保留标记”会让模型
// 把原文那侧的标记也当成待保留对象，于是原文的 <ruby>基文<rt>注文</rt></ruby>（日文读音）被补进
// 中文修订结果——这正是“修订结果里唐突出现日文”的一条通路，解析层的目标列语言护栏是它的兜底。
const noterefConstraint = "硬性格式约束：只保留目标列自身已有的内联标记——目标列里的 EPUB noteref 注释标记必须在 revisedText 中逐字、原位保留，不得改动其任何标签、属性或内容；目标列里没有的标记不得从原文补进 revisedText（含原文的 ruby 注音、加粗与译注标记）。";

const modeMarkers = Object.freeze({
  bilingual: "当前是双语校对",
  trilingual: "当前是三语校对",
});

// 通用侧只放与作品、语言阶段无关的任务契约。字段默认值、档位定义、needsContext 口径都只在这里写一次：
// modeSchemas 负责“键名 + 取值”，本数组负责“怎么判断”，两边不再互相复述。
const sharedInstructions = [
  "你是严谨的翻译校对助手，辅助人工；按“原文边界→语义完整性→语言质量”内部判断，不输出推理，不把偏好当错误。证据优先级：原文人物、数字、否定、时态、因果动作 > 目标列完整准确 > 术语语体一致 > 局部措辞；无法证明的不猜。",
  // 通用侧只写“怎么判断”，字段取值（键名 + 枚举）在 modeSchemas 里声明一次：
  // 用户载荷里那份 outputSchema 每一行都要重发，两边都抄口径等于把同一件事买两次单。
  "semanticSame = 目标列与原文（双语）或另一非原文列（三语）的核心语义是否相同；needsEdit = 目标列是否需改动。两者独立：语义通顺但生硬或有明显问题时可 semanticSame=true、needsEdit=true。无明确意义、完整性、语法问题不建议修改；只做最小改动，不整段重译。",
  "需要修改时，revisedText 是目标列当前行的完整替换文本，保留其语言、字形和文体，不能只描述改法；不得合并相邻行、拆分行边界或交换、重排、合并相邻行。行内语序调整正常；整行内容与邻行互换属于错位缺陷，只能按本行原文重写本行。revisedText 必须通顺自然且符合目标语言母语表达习惯，读起来绝不能比待修改文本更加生硬拗口（严禁反向负优化）；若改写会产生死板字面对位、生硬倒装或恶性翻译腔病句，宁可无需修改（维持原样）或转人工（unclear），绝不输出劣质改写。",
  // revisedText 的结构口径：一行就是一个成品段落，段数由目标列当前行给定。原文那一侧的分行、空行
  // 与缩进是版式事实，不是译文的缺陷；模型据此往 revisedText 里插换行会让写回按段错位
  // （真实回归：第 1166 行原文那行是两段、目标列一段，模型判「译文丢了原文换行」并插入 `\n`）。
  // 输出侧的成品格式门禁（`format-guard.js`）是这条要求的确定性兜底，两条必须一起写。
  "revisedText 只能是**一整行文本**：不得含换行、空行或 <br> 等标记——一个行就是一个成品段落，段落结构由目标列当前行给定（目标列本身是多段时按同等段数输出、空行分隔，不增删段落）。原文那一侧的分行、空行、行首缩进都是版式事实，不是译文缺陷，不得据此改写段落结构。",
  // 输出语言只写这一层：修订结果进的是目标列成品，混进原文文字就是成品缺陷，不是措辞问题。
  // 解析层还有一道确定性护栏（ai-proofread 的目标列语言护栏），两条一起才挡得住“照抄日文读音”。
  "revisedText 只能是目标列语言的文字：不得出现原文词汇或假名；原文注音需保留时必须用目标列注音写法（稿件 |基文[注文]、成品 <ruby>基文<rt>注文</rt></ruby>），注文用目标列语言；拿不准注音宁可不加，也不得照抄原文读音——summary 为说明依据引用原文不受此限，revisedText 一律不行。",
  { text: "任一侧是不完整片段（以接续词、助词、标点结尾，缺少谓语，或明显只是上下句的一半）时：不得据该片段的句读、标点收尾或语气判定 needsEdit；若片段范围内两侧对应、差异只是断句位置或片段长度，判定 semanticSame=true、needsEdit=false；若无法判断语义对应，返回 needsContext=true；确实需要修改时，revisedText 仍须限制在该片段范围内，不得补全成完整句或改写上下句。", features: ["fragment"] },
  { text: "形如 <a ... epub:type=\"noteref\" ...><sup>㊟</sup></a> 的内容是 EPUB 注释标记，不属于正文语义；不得因其标签、属性、数量或位置差异判定翻译问题。", features: ["noteref"] },
  { text: "目标列中原文没有的特典、后记、译注、制作信息等不是翻译缺陷：不得据此判定 needsEdit=true，也不得在 revisedText 中删除、改写或补写这类内容；原文是准入边界。", features: ["outOfScope"] },
  "仅当确实依赖行外证据（代词指向、承接关系、省略主语、术语延续、伏笔指代）时才返回 needsContext=true；行内已有足够依据必须直接判断。不要在说明中索要上下文，系统会自动补行。",
  "只判档位、不自己算分：按缺陷档位（融合 MQM 风格分级与缺陷扣分口径）判 grade——poor=致命缺陷（颠倒核心事实/主谓宾/因果，反转性误译，专名灾难错译，关键语义大段脱落）；fair=严重缺陷（主干误漏译，关键否定/时态/语态/指代错误，口吻严重倒错）；good=轻微缺陷（轻度翻译腔、词句标点瑕疵、冗余）；excellent=无缺陷或仅修辞偏好。severity 映射：excellent→none、good→minor、fair→major、poor→critical。",
  "penalty 与 score 的关系是 score=100-penalty；能估整数就给，拿不准填 null 由程序按 grade 折算。needsEdit=false 时固定 score=100、penalty=0、grade=excellent、severity=none、revisedText 留空；needsContext=true 时 score/penalty 填 null 转人工，不自行扣分。",
  // 说话人判断口径不在这里重复：「【说话人判断（…）】」段落由说话习惯层动态生成并自带同一套口径，
  // 而它只在原文命中口癖时才出现——那正是需要这条规则的唯一场景。
  "summary 只写结论、扣分项与最关键证据，控制在一两句内，且与各项字段完全一致。措辞约定：needsEdit=false 时以“无需修改”起头，不出现建议/需要修改/润色等字样；needsEdit=true 时写明“需要修改”并列出扣分项，不以无需/不必起头。",
];

const modeContracts = Object.freeze({
  bilingual: {
    mode: "bilingual",
    instructions: [
      "当前是双语校对：A 是原文（通常为日文）与语义依据，也是准入边界；B 是唯一译文与唯一修改列。只处理 A 中存在的内容；B 中 A 没有的特典、后记、译注或制作信息不作为原文要求。",
      "A 常省略主语或人称代词。B 因照搬而成为无主句、成分残缺或指代不明时，可在 revisedText 中按中文习惯适当补上缺失的主语（代词或 A 与上下文已确立的称谓），但不得新增原文没有的行为主体；B 多出会改变行为主体或因果归属的主语则按误译处理。片段行按通用片段口径判断，不据此补成完整句。",
      "A 不是可复制进 B 的候选译文，不得把 A 直接复制进 B。不要假设存在另一份译文或比较不存在的 counterpartText。",
      "用 decision 表达结论：B 无需修改时 decision=keep；需要修改时 decision=replace 并给出可替换当前行的 revisedText；依据完全不足无法判断时用 decision=unclear（转人工确认），不用它表达“不确定要不要改”。",
    ],
  },
  trilingual: {
    mode: "trilingual",
    instructions: [
      "当前是三语校对：A 是原文和准入边界，B、C 是同级非原文材料，不预设哪一方更权威。",
      "先以 A 确认语义和正文边界，再比较 B 与 C；另一非原文只提供可验证的表达线索，不覆盖 A 的事实约束。只修改用户选择的目标列。",
      "若两份非原文不同但目标列更准确或更贴合 A，返回 semanticSame=false、needsEdit=false、better=target，不修改目标列。",
      "better=counterpart 表示另一非原文列更好：在目标列原文上只融入更优片段，调整为该列的字形和用词，并保留目标列已正确通顺的部分；禁止抛开现有译文重译整句。",
      "若 B、C 都与 A 不一致，或两者都可能正确而输入不足，返回 better=unclear、needsContext=true，不强行选择一方。",
    ],
  },
});

// 通用侧标题：与作品、语言阶段无关的那部分规则从这里开始，便于人工核对拆分边界。
const genericHeader = "【通用校对规则】";

/**
 * 提示词分层（本文件是**唯一权威定义**，其它模块只消费不重定义）。
 *
 * 一次请求的 system 提示词由五层按固定顺序拼成，每层的职责与注入时机都不同：
 *
 * | 层 | 内容 | 来源 | 注入时机 |
 * |----|------|------|----------|
 * | 1 通用侧 | 与作品、模式无关的任务契约：证据优先级、needsContext、档位与字段约定；片段、noteref 语义与原文外内容按现象命中 | 本文件 `sharedInstructions` | 核心契约每行；三条条件规则命中 `fragment`/`noteref`/`outOfScope` 时 |
 * | 2 模式层 | 当前比较模式的列语义与结论字段（双语 A/B、三语 A/B/C） | 本文件 `modeContracts` | 每行 |
 * | 3 特化档案 | 作品/阶段规范，分三种条目：**常驻条目**（关系、作品专有、证据边界）、**按行条目**（排版层、文本层规范，声明 `features`）与**实体条目**（只对某个角色/专有词成立的规范，声明 `characters`） | `profiles/*.js` | 常驻每行；按行条目只在该行命中特征时（`row-features.js`）、实体条目只在该行真的出现那个名字时（`name-entities.js`） |
 * | 4 动态上下文 | 对照表命中段、说话习惯段、说话人判断段、低分归因段、线上查证段 | `term-prefilter.js`、`speech-habit.js`、`low-score.js`、`web-lookup.js` | 命中该行/该章/该轮才注入 |
 * | 5 固定尾巴 | noteref 硬性约束、术语表、JSON 输出约定 | 本文件 + `ai/prompt-contract.js` | 每行（刻意保守：宁可重复也不丢） |
 *
 * **分层（请求里注入了什么）与判定链（结论怎么一步步来的）是两个视角，别混为一谈**：
 *
 * 判定链：对照表（离线四类结论）→ 模型（基础轮 + 上下文轮）→ 低分归因与修复（极低分行的相邻行）→ 线上查证（按站点顺序 + 自行检索）→ 输出侧确定性工序（成品格式门禁 → 标点规范化：宽度统一、引号体例统一与成对标记内的句末点号还原 → 修订结果混入原文文字或残留无法配对的弯引号就作废转人工）→ 待人工
 * 对应层：第 4 层的术语段 ──── 第 1/2/3/5 层（+ 相邻行）── 第 4 层的低分归因段 ──── 第 4 层的线上查证段 ──── 无（输出侧的每一步都是结论产出**之后**的确定性工序，不读提示词，见 `format-guard.js`/`punctuation.js`/`ai-proofread.js` 的 `guardTargetScript`，三步顺序写在 `applyFormatGuard` → `normalizeDecisionPunctuation` → `guardTargetScript` 的调用处）──── 无（终局）
 *
 * 约束：
 * - **顺序不得调整**，测试按分区顺序断言（通用侧 → 模式 → 特化侧 → 动态段 → 约束 → 输出约定）。
 * - 判据**只写一层**：字段默认值、档位定义、needsContext 口径在通用侧写一次；`modeSchemas`
 *   只负责“键名 + 取值”；特化档案只写工作阶段规范，不复述任务契约。
 * - 第 4 层的动态段一律经 `dynamicBlockPrefixes` 剥离后再注入：自定义提示词里残留的旧段会先被剥掉，
 *   任何路径都不得出现两段同类动态段——**新增动态段时必须同时登记到那张前缀表**（段首标记由注入层
 *   自己定义并导出，这里只借用，不复制字面量）。
 * - 第 4 层内部按“由内到外补充资料”排列：术语命中 → 说话习惯 → 低分归因（相邻行）→ 线上查证（外部资料最后注入）。
 * - 第 1 层的三条通用条件规则、第 3 层的条件条目与第 4 层按行/按轮裁剪；第 2、5 层永远全量。
 * - 页面里预填的默认提示词始终是**全量**（第 3 层不裁剪），人工读得到完整规范；
 *   真正发给模型的请求才按 `rowFeatures`（版式/文字现象）与 `rowEntities`（本行出现了哪些角色/专有词）裁剪。
 * - 用户载荷里的 `modeSchemas`（`outputSchema`）**每一行都要重发一份**，所以它只声明“键名 + 取值”；
 *   字段怎么判断一律写在系统提示词里（通用侧 `sharedInstructions`、模式层、动态段），不要在那边抄第二遍。
 */

/** 档案条目支持三种形态：字符串＝常驻；`{ text, features }`＝按行命中版式/文字现象；
 *  `{ text, characters }`＝实体条目，只在该行真的出现该角色/专有词时注入。 */
function lineText(line) {
  if (typeof line === "string") return line;
  return String(line?.text || "");
}

/** 条目声明的实体名（`characters`）：为空表示不是实体条目。 */
function lineEntities(line) {
  if (typeof line === "string") return [];
  return Array.isArray(line?.characters) ? line.characters : [];
}

/** 条目声明的已注册特征（认不出的特征 id 由调用方决定如何处置）。 */
function lineFeatureIds(line) {
  if (typeof line === "string") return [];
  const raw = Array.isArray(line?.features) ? line.features : [];
  return raw.map((id) => String(id || "").trim()).filter(Boolean);
}

/** 实体条目的 id（`御坂妹妹|御坂` 的 id 是 `御坂妹妹`）。 */
function declaredEntityId(raw) {
  const [name] = String(raw || "").split("|").map((item) => item.trim());
  return name || "";
}

/**
 * 条目是否该注入。
 * `scope` 形如 `{ features, entities, declaredEntities, textMissing }`（由 `bindScope` 归一化）。
 * - `scope` 为 null（全量模式：页面默认提示词、审计、脚本）→ 全部注入；
 * - 没声明 `features`/`characters` 或声明为空 → 常驻；
 * - 声明了未注册的特征 id（笔误）→ 按常驻处理，宁可多注入（见 row-features 的纪律）；
 * - 两条声明都存在时是**与**关系：版式现象与角色都得对上；
 * - 实体 id 不在档案声明名单里（认不出）→ 按命中处理，宁可多注入；
 * - `textMissing`（两侧文本都没有）→ 按命中处理：此时连特征也探测不出来，条目不该因此消失
 *   （与 `detectRowFeatures` 的兜底同口径）。
 */
function lineIncluded(line, scope = null) {
  if (!scope) return true;
  if (typeof line === "string") return true;
  const need = lineFeatureIds(line).filter((id) => FEATURE_IDS.includes(id));
  if (need.length && !scope.textMissing && !need.some((id) => scope.features.has(id))) return false;
  const entities = lineEntities(line);
  if (entities.length && !scope.textMissing) {
    const hit = entities.some((raw) => {
      const id = declaredEntityId(raw);
      if (!id || !scope.declaredEntities.has(id)) return true;
      return scope.entities.has(id);
    });
    if (!hit) return false;
  }
  return true;
}

// 特化侧正文：只由 profiles/ 里的可替换档案生成，通用侧不认识它的内容。
// scope = null 时输出全量（页面/审计）；给了特征/实体集合时按行裁剪，整节被裁空则连标题一起省掉。
function profileSystemFor(profile, scope = null) {
  if (!profile) return "";
  const bound = bindScope(scope, profile);
  const sections = profile.sections
    .map((section) => {
      const lines = (section.lines || [])
        .filter((line) => lineIncluded(line, bound))
        .map(lineText)
        .filter(Boolean);
      return lines.length ? promptSections(`— ${section.title}`, lines) : "";
    })
    .filter(Boolean);
  return promptSections(
    `${profile.marker}${profile.summary ? ` ${profile.summary}` : ""}`,
    sections,
  );
}

// 通用侧同样支持按行条目：语义判断和输出契约留常驻，只有可观察现象触发的规则才按当前行注入。
function genericSystemFor(scope = null) {
  const bound = bindScope(scope, null);
  const lines = sharedInstructions
    .filter((line) => lineIncluded(line, bound))
    .map(lineText)
    .filter(Boolean);
  return promptSections(genericHeader, lines);
}

/**
 * 裁剪依据归一化。两种入参形态都接受：
 * - `Set`（旧口径）= 只给行特征，等价于 `{ features }`；
 * - `{ features?, entities?, sourceText?, targetText? }`（实体闸门加入后的口径）。
 * `features`/`entities` 都是 null 时按全量处理——没给依据就等于判断不出这一行需要什么，宁可全注入。
 * profile 绑上去是为了让实体判定能取到档案声明的名单（名字写错/认不出的声明按命中处理）。
 */
function bindScope(scope, profile) {
  if (!scope) return null;
  const raw = scope instanceof Set ? { features: scope } : scope;
  if (raw.features == null && raw.entities == null) return null;
  const src = String(raw.sourceText ?? "").trim();
  const dst = String(raw.targetText ?? "").trim();
  return {
    features: raw.features || new Set(),
    entities: raw.entities || new Set(),
    declaredEntities: new Set(profileEntities(profile).map((entity) => entity.id)),
    // 两侧文本都没有、又没有给出任何判定依据时，不做裁剪：特征与实体都判断不了，条目不该因此消失。
    // 反过来，调用方给了 features/entities 就说明它已经判定过了（旧调用点只给 features 也走这一支），
    // 缺文本不再当借口——否则「只给特征」的老口径会静默变成全量。
    textMissing: !src && !dst && raw.features == null && raw.entities == null,
  };
}

/**
 * 按行裁剪的审计数字：条目总数、注入/省略条数、被省掉的字符数，以及实体闸门的两类计数
 * （`entityGated` = 声明了实体的条目总数；`entitySkipped` = 其中因本行没出现该名字而被省掉的条数，
 * 它是「闸门到底有没有生效」的唯一凭据——少了它，名字写错或别名写窄导致的静默失效没人看得出来）。
 */
function profileLineStats(profile, scope = null) {
  let injected = 0;
  let omitted = 0;
  let omittedChars = 0;
  let conditional = 0;
  let entityGated = 0;
  let entitySkipped = 0;
  const bound = bindScope(scope, profile);
  for (const section of profile?.sections || []) {
    for (const line of section.lines || []) {
      const gated = lineEntities(line).length > 0;
      const isConditional = gated || lineFeatureIds(line).some((id) => FEATURE_IDS.includes(id));
      if (isConditional) conditional += 1;
      if (gated) entityGated += 1;
      if (lineIncluded(line, bound)) injected += 1;
      else {
        omitted += 1;
        omittedChars += lineText(line).length;
        if (gated) entitySkipped += 1;
      }
    }
  }
  return { injected, omitted, omittedChars, conditional, entityGated, entitySkipped };
}

function proofreadPromptFor(mode = "bilingual", profileId = DEFAULT_PROFILE_ID) {
  const contract = modeContracts[mode] || modeContracts.bilingual;
  const outputSchema = modeSchemas[contract.mode] || modeSchemas.bilingual;
  const profile = resolveProfile(profileId);
  const generic = genericSystemFor();
  // 页面预填、脚本审计用全量：人工要能读到完整规范，裁剪只发生在真正发请求时。
  const profileSystem = profileSystemFor(profile);
  // body 是“通用侧 + 当前模式规则 + 特化侧”的完整正文（不含 JSON 输出约定与 noteref 硬性约束），
  // 默认提示词与自定义提示词都按同一顺序合并注入。
  const body = promptSections(generic, contract.instructions, profileSystem);
  return {
    ...contract,
    outputSchema,
    profileId: profile.id,
    profileName: profile.name,
    profileMarker: profile.marker,
    body,
    genericSystem: generic,
    baseSystem: withJsonOnly(generic, outputSchema, { includeKeys: false }),
    modeSystem: promptSections(contract.instructions),
    profileSystem,
    // 默认提示词与真正发出的提示词保持一致：也带上 noteref 硬性约束（组装时会先去重再补一次）。
    system: withJsonOnly(promptSections(body, noterefConstraint), outputSchema, { includeKeys: false }),
  };
}

// JSON 输出约定由组装阶段统一追加：自定义提示词里的同名行先逐行去掉。
// 按“行”剥离而不是从标记处截断，用户写在默认提示词之后的补充规则不会被误删。
function stripJsonContract(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => {
      const value = line.trim();
      return !value.startsWith(JSON_ONLY_INSTRUCTION) && !value.startsWith(jsonKeyHintPrefix);
    })
    .join("\n")
    .trim();
}

const profileBlockPrefix = "【成品校对规范：";
const speechHabitPrefix = "【说话习惯（";
const jsonKeyHintPrefix = "必须使用以下英文键名";

// 硬性约束由组装阶段统一追加；自定义提示词里已有的那一行要先去掉，避免重复。
function stripNoterefConstraint(text) {
  return String(text || "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("硬性格式约束："))
    .join("\n")
    .trim();
}

// 自定义提示词里可能还留着上一次选中的特化档案（例如页面预填的是默认档案，用户又换了下拉）。
// 档案块到下一个顶层小节（【…）或硬性约束为止；剥离后由本次选中的档案统一注入，避免两套规范并存。
function stripProfileBlock(text) {
  const value = String(text || "");
  const start = value.indexOf(profileBlockPrefix);
  if (start < 0) return value.trim();
  const rest = value.slice(start + profileBlockPrefix.length);
  const boundary = rest.search(/\n(?=【|硬性格式约束：)/);
  const end = boundary < 0 ? value.length : start + profileBlockPrefix.length + boundary + 1;
  return `${value.slice(0, start)}${value.slice(end)}`.trim();
}

// 说话习惯段与说话人判断段都是动态生成的（按章、按行）：自定义提示词里可能留着上一次的，
// 先剥掉再注入本次的。段首标记用前缀匹配，避免与档案正文里提到的「【说话习惯】」混淆。
// 对照表命中段、低分归因段与线上查证段同理（按行/按轮生成，只会出现在命中的那一次请求里）。
const dynamicBlockPrefixes = [
  speechHabitPrefix,
  "【说话人判断（",
  TERM_BLOCK_PREFIX,
  LOW_SCORE_PREFIX,
  WEB_LOOKUP_PREFIX,
];

function stripSpeechHabitBlock(text) {
  let value = String(text || "");
  // 反复剥离，直到再没有可剥离的动态段落（自定义提示词里可能残留多段）。
  for (let pass = 0; pass < 10; pass += 1) {
    const prefix = dynamicBlockPrefixes.find((item) => value.includes(item));
    if (!prefix) break;
    const start = value.indexOf(prefix);
    const rest = value.slice(start + prefix.length);
    const boundary = rest.search(/\n(?=【|硬性格式约束：)/);
    const end = boundary < 0 ? value.length : start + prefix.length + boundary + 1;
    value = `${value.slice(0, start)}${value.slice(end)}`;
  }
  return value.trim();
}

function buildProofreadSystemPrompt({
  mode = "bilingual",
  profileId = DEFAULT_PROFILE_ID,
  customSystem = "",
  glossary = "",
  speechHabitBlock = "",
  termBlock = "",
  lowScoreBlock = "",
  webLookupBlock = "",
  rowFeatures = null,
  sourceText = "",
  targetText = "",
  rowEntities = null,
  fullPrompt = false,
} = {}) {
  const contract = proofreadPromptFor(mode, profileId);
  const profile = resolveProfile(profileId);
  // 按行裁剪只作用于特化档案的按行条目与实体条目：`fullPrompt`（排查/对比用）时两者都退回全量。
  const features = fullPrompt ? null : rowFeatures;
  // 实体命中：给了本行文本就现算（角色名只在真的出现在这一行时才注入那条规则），
  // 显式传了 rowEntities 就以它为准（便于调用方复用同一次判定）。
  const entities = fullPrompt
    ? null
    : (rowEntities || detectRowEntities({ source: sourceText, target: targetText, entities: profileEntities(profile) }));
  const genericSystem = genericSystemFor({ features, sourceText, targetText });
  const profileSystem = profileSystemFor(profile, { features, entities, sourceText, targetText });
  const trimmedBody = promptSections(genericSystem, contract.instructions, profileSystem);
  // 界面预填的就是完整默认提示词（含 JSON 输出约定与硬性约束），用户可能只改了几个字：
  // 先剥掉旧的 JSON 尾巴、硬性约束行、上一次的特化档案块、上一章的说话习惯段、上一行的术语段与
  // 低分归因段，再按“是否已带本模式规则”补模式规则，特化侧、说话习惯层、对照表命中段与
  // 低分归因段总是按本次上下文重新注入。
  const custom = stripSpeechHabitBlock(stripNoterefConstraint(stripProfileBlock(stripJsonContract(customSystem))));
  // 动态段按“由内到外补充资料”的顺序排列：术语命中 → 说话习惯 → 低分归因（相邻行）→ 线上查证（最外层）。
  const dynamicBlocks = [
    String(termBlock || "").trim(),
    String(speechHabitBlock || "").trim(),
    String(lowScoreBlock || "").trim(),
    String(webLookupBlock || "").trim(),
  ];
  const body = !custom || custom === contract.body
    ? promptSections(trimmedBody, ...dynamicBlocks)
    : promptSections(
      custom,
      custom.includes(modeMarkers[contract.mode]) ? "" : contract.modeSystem,
      profileSystem,
      ...dynamicBlocks,
    );
  return withJsonOnly(promptSections(body, noterefConstraint, glossary), contract.outputSchema, { includeKeys: false });
}

/**
 * 本次注入的构成（审计用）：各层字符数 + 特化侧按行裁剪的条目数 + 实体闸门命中了哪些声明。
 * 供日志汇总与测试断言，不参与提示词文本本身。
 * 入参与 `buildProofreadSystemPrompt` 一致：`rowFeatures`/`rowEntities` 为 null 表示全量。
 */
function promptLayerReport({
  mode = "bilingual",
  profileId = DEFAULT_PROFILE_ID,
  rowFeatures = null,
  rowEntities = null,
  sourceText = "",
  targetText = "",
} = {}) {
  const contract = proofreadPromptFor(mode, profileId);
  const profile = resolveProfile(profileId);
  const entities = rowEntities
    || detectRowEntities({ source: sourceText, target: targetText, entities: profileEntities(profile) });
  const scope = { features: rowFeatures, entities, sourceText, targetText };
  return {
    profileId: profile.id,
    layers: {
      generic: genericSystemFor(scope).length,
      mode: contract.modeSystem.length,
      profile: profileSystemFor(profile, scope).length,
    },
    profileLines: profileLineStats(profile, scope),
    unknownFeatures: unknownFeatureIds(profile),
    entities: entityGateReport(profile, entities),
  };
}

module.exports = {
  JSON_ONLY_INSTRUCTION,
  DEFAULT_PROFILE_ID,
  genericHeader,
  listProfiles,
  profileLineStats,
  proofreadOutputSchema,
  promptLayerReport,
  modeSchemas,
  noterefConstraint,
  profileSystemFor,
  proofreadPromptFor,
  buildProofreadSystemPrompt,
  modeContracts,
  resolveProfile,
  detectRowEntities,
  entityGateReport,
  profileEntities,
};
