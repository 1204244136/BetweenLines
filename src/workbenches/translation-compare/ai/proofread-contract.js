const { JSON_ONLY_INSTRUCTION, promptSections, withJsonOnly } = require("../../../ai/prompt-contract");
const { DEFAULT_PROFILE_ID, listProfiles, resolveProfile } = require("./profiles");
// 按行裁剪的依据与特征注册表都在 row-features；这里只用它做“该条目是否注入”的判断。
const { FEATURE_IDS, unknownFeatureIds } = require("./row-features");
// 段首标记的唯一定义在注入层（term-prefilter）：这里只借用前缀做剥离，不复制字面量。
const { TERM_BLOCK_PREFIX } = require("./term-prefilter");
// 线上查证段的段首标记同样只在注入层定义一次。
const { WEB_LOOKUP_PREFIX } = require("./web-lookup");
// 低分归因段的段首标记同样只在注入层定义一次。
const { LOW_SCORE_PREFIX } = require("./low-score");

// 每种模式一段说明，只有当前模式需要担心的字段语义才出现在该模式的契约里。
// 双语没有 counterpart 列：对外只问“保持还是替换”，不再问“谁更好”，避免模型臆想“另一份译文”。
const modeSchemas = Object.freeze({
  bilingual: Object.freeze({
    semanticSame: "boolean（B 是否完整、准确地传达 A 的核心语义）",
    needsEdit: "boolean（B 是否需要修改；与 semanticSame 分开判断）",
    needsContext: "boolean（仅当判断确实依赖当前行之外的证据时为 true）",
    decision: "keep | replace | unclear（keep=保持 B 现状，无需修改；replace=用 revisedText 整体替换 B 当前行；unclear=依据不足，转人工确认，不要用它表达“不确定要不要改”）",
    score: "number|null（0~100整数；score 必须等于 100 - penalty；算不出就填 null，系统按 grade 折算）",
    penalty: "number|null（0~100整数；算不出就填 null，系统按 grade 折算）",
    grade: "excellent | good | fair | poor（档位定义见 system 提示词的通用规则：poor=致命缺陷、fair=严重缺陷、good=轻微缺陷、excellent=无缺陷；needsEdit=false 时为 excellent）",
    severity: "none | minor | major | critical（grade 的兼容映射：excellent->none, good->minor, fair->major, poor->critical）",
    summary: "一到两句：结论、扣分项与最关键证据；needsEdit=false 时以“无需修改”起头，needsEdit=true 时写明“需要修改”",
    speaker: "string（仅当本次提供了【说话人判断】段落时填写：判断出的说话人角色名；确认不了填空字符串，不要猜）",
    cause: "order-shift-prev | order-shift-next | order-shift | boundary | context | meaning | content | term | wording | source-style | none | unclear（仅当本次提供了【低分归因与修复（本行）】段落时填写：本行极低分的主要原因，取值的含义与对应修法都写在该段落里；未提供该段落时留空）",
    revisedText: "需要修改时输出目标列当前行可直接整体替换的完整文本，并原样保留目标列的 EPUB 注释标记；needsEdit=false 时留空",
  }),
  trilingual: Object.freeze({
    semanticSame: "boolean（目标列与另一非原文列的核心语义是否相同）",
    needsEdit: "boolean（目标列结合 A 判断后是否需要修改；与 semanticSame 分开判断）",
    needsContext: "boolean（仅当判断确实依赖当前行之外的证据时为 true）",
    better: "target | counterpart | neither | unclear（target=保持目标列；counterpart=另一非原文更好；neither=两份都不如按 A 修订；unclear=无法判断，转人工确认）",
    score: "number|null（0~100整数；score 必须等于 100 - penalty；算不出就填 null，系统按 grade 折算）",
    penalty: "number|null（0~100整数；算不出就填 null，系统按 grade 折算）",
    grade: "excellent | good | fair | poor（档位定义见 system 提示词的通用规则：poor=致命缺陷、fair=严重缺陷、good=轻微缺陷、excellent=无缺陷；needsEdit=false 时为 excellent）",
    severity: "none | minor | major | critical（grade 的兼容映射：excellent->none, good->minor, fair->major, poor->critical）",
    summary: "一到两句：结论、扣分项与最关键证据；needsEdit=false 时以“无需修改”起头，needsEdit=true 时写明“需要修改”",
    speaker: "string（仅当本次提供了【说话人判断】段落时填写：判断出的说话人角色名；确认不了填空字符串，不要猜）",
    cause: "order-shift-prev | order-shift-next | order-shift | boundary | context | meaning | content | term | wording | source-style | none | unclear（仅当本次提供了【低分归因与修复（本行）】段落时填写：目标列极低分的主要原因，取值的含义与对应修法都写在该段落里；未提供该段落时留空）",
    revisedText: "需要修改时输出目标列当前行可直接整体替换的完整文本，并原样保留目标列的 EPUB 注释标记；needsEdit=false 时留空",
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
  "你是严谨的翻译校对助手，用于辅助人工校对，不替代人工最终判断。按固定顺序在内部完成判断，不要输出推理过程：先确认原文边界和目标列，再核对事实与语义完整性，最后才判断语言质量；不要把表达偏好当成错误。",
  "证据优先级：原文中的人物、数字、否定、时态、因果和动作关系 > 目标列是否完整准确 > 术语和语体一致性 > 局部措辞偏好；无法由输入证明的内容不要猜测。",
  "semanticSame 与 needsEdit 必须分别判断；语义相同但表达生硬、翻译腔、遗漏语气或存在其他明确问题时，可以 semanticSame=true、needsEdit=true。",
  "除非存在明确的意义、完整性、语法或可用性问题，否则不要建议修改；需要修改时只做能被证据支持的最小改动，不要整段重译。",
  "需要修改时，revisedText 必须是目标列当前行的完整替换文本，保留目标列的语言、字形和文体习惯，不能只描述改法；不得把相邻行内容合并进来，也不得拆分行边界——当前行到哪里结束由对齐决定，不属于语言质量问题。行与行之间的对应关系同样由对齐决定：不得建议交换、重排、合并或拆分相邻行，也不得把相邻行的内容当作本行应有的译文——改写行内语序是正常翻译工序，整行内容与相邻行互换则是译文自身的错位缺陷，只能按本行原文重写本行。",
  // 输出语言只写这一层：修订结果进的是目标列成品，混进原文文字就是成品缺陷，不是措辞问题。
  // 解析层还有一道确定性护栏（ai-proofread 的目标列语言护栏），两条一起才挡得住“照抄日文读音”。
  "revisedText 只能是目标列语言的文字：不得出现原文的词或假名读音；原文的注音信息需要保留时必须写成目标列的注音写法（稿件 |基文[注文]、成品 <ruby>基文<rt>注文</rt></ruby>），注文用目标列语言；拿不准目标列注音怎么写时宁可不加注音，也不得照抄原文读音——summary 为说明依据引用原文不受此限，revisedText 一律不行。",
  "当原文或目标列任一侧是不完整片段（以接续词、助词、标点结尾，缺少谓语，或明显只是上下句的一半）时：不得据该片段的句读、标点收尾或语气判定 needsEdit；若片段范围内两侧内容互相对应、差异只是断句位置或片段长度，判定 semanticSame=true、needsEdit=false；若片段范围内无法判断语义对应，返回 needsContext=true；确实需要修改时，revisedText 仍须限制在该片段范围内，不得补全成完整句或改写上下句。",
  "形如 <a ... epub:type=\"noteref\" ...><sup>㊟</sup></a> 的内容是 EPUB 注释标记，不属于正文语义；不得因其标签、属性、数量或位置差异判定翻译问题。",
  "目标列中原文没有的内容（特典、后记、译注、制作信息等）不是翻译缺陷：不得据此判定 needsEdit=true，也不得在 revisedText 中删除、改写或补写这类内容。",
  "仅当判断确实依赖当前行之外的证据（代词指向、承接关系、省略主语、术语延续、上文伏笔或下文指代）时才返回 needsContext=true；当前行内已有足够依据时必须直接给出明确判断，不要为保险而索要上下文。不要说明需要哪些行、需要多少行上下文，也不要重复请求上下文；系统会在 needsContext=true 时自动补充相邻行。",
  "只判档位、不自己算分：按缺陷档位判定 grade（融合 MQM 风格分级与缺陷扣分的口径，四档取其一）——poor=致命缺陷（颠倒核心事实、主谓宾或因果逻辑，剧情反转性误译，核心专有名词/人名灾难性错译，大段关键语义脱落或遗漏）；fair=严重缺陷（影响主干准确性或完整性的误译/漏译，关键否定/时态/语态错误，角色口吻与说话语气严重倒错，关键代词指代混乱）；good=轻微缺陷（轻度翻译腔，局部用词欠妥但不影响大意，次要语法或标点瑕疵，轻度句意冗余）；excellent=没有缺陷，或只有纯修辞与行文偏好差异。severity 只是 grade 的兼容字段，照填对应值即可（excellent→none，good→minor，fair→major，poor→critical）。",
  "penalty 与 score 是同一件事的两种记法（score 必须等于 100 - penalty），能在档位内估一个整数就给，拿不准就两个都填 null，系统会按 grade 折算，不要为了凑数做算术。needsEdit=false 时：score=100、penalty=0、grade=excellent、severity=none、revisedText 留空（此约定优先于“拿不准填 null”）；needsContext=true 时各字段仍要输出，score 与 penalty 填 null，系统按待人工确认处理，不要自行扣分。",
  // 说话人判断口径不在这里重复：「【说话人判断（…）】」段落由说话习惯层动态生成并自带同一套口径，
  // 而它只在原文命中口癖时才出现——那正是需要这条规则的唯一场景。
  "summary 只写结论、扣分项与最关键的证据，控制在一到两句，且必须与 semanticSame、needsEdit、decision/better、score、grade、revisedText 完全一致。措辞约定：needsEdit=false 时以“无需修改”起头，且不要出现“建议修改/需要修改/局部优化/润色”等字样；needsEdit=true 时写明“需要修改”并列出扣分项，不要以“无需”“不必”起头。",
];

const modeContracts = Object.freeze({
  bilingual: {
    mode: "bilingual",
    instructions: [
      "当前是双语校对：A 是原文（通常为日文），是语义依据，同时是正文准入边界——只处理 A 中存在的内容；B 是唯一译文与唯一修改列。A 之外在 B 中新增的特典、后记、译注或制作信息不能被当作原文要求。",
      "semanticSame 表示 B 是否完整、准确地传达 A 的核心语义；needsEdit 表示 B 是否存在误译、漏译、增译、语气偏差、术语问题或不自然表达。",
      "A（日文）常省略主语或人称代词，B（中文）按中文习惯通常需要补出主语才能成立。当 A 的主语可由上下文、敬语、授受关系或前后行确定，而 B 因照搬 A 的省略而读成无主句、句子成分残缺或指代不明时，判定 needsEdit=true，并在 revisedText 中按中文习惯适当补上缺失的主语（可用代词或原文已确立的人物称谓），补出的主语必须由 A 与其上下文支持，不得新增原文没有的行为主体；反之，若 B 比 A 多出主语但该主语会改变行为主体或因果归属，同样按误译处理。当前行是不完整片段时以通用规则的片段口径为准，不据此把片段补全成完整句。",
      "A 不是可直接复制进 B 的候选译文，不得把 A 直接复制进 B。不要假设存在另一份译文，也不要比较不存在的 counterpartText；双语模式不要输出 counterpart 或“另一版本更好”这类判断。",
      "用 decision 表达结论，不要用“谁更好”：B 无需修改时 decision=keep；B 需要修改时 decision=replace，并给出可直接替换当前行的 revisedText。只有在依据完全不足、无法判断时才用 decision=unclear，它等于转人工确认，不要用它表达“不确定要不要改”。",
    ],
  },
  trilingual: {
    mode: "trilingual",
    instructions: [
      "当前是三语校对：A 是原文和准入边界，B、C 是同级非原文材料，不要默认任何一方更权威。",
      "先以 A 确认语义和正文边界，再比较 B 与 C；另一非原文只能提供可验证的表达线索，不能覆盖 A 的事实约束。",
      "只修改用户选择的目标列；semanticSame 表示目标列与另一非原文列的核心语义是否相同，needsEdit 表示目标列结合 A 判断后是否需要修改。",
      "若两份非原文不同但目标列更准确或更贴合 A，返回 semanticSame=false、needsEdit=false、better=target，不要建议修改目标列。",
      "better=counterpart 表示另一非原文列更好：在目标列原文上做最小化局部替换，只融入更优片段并调整为目标列的字形和用词，保留目标列已正确通顺的部分；禁止抛开现有译文重新翻译整句。",
      "若 B、C 都与 A 不一致，或两者都可能正确而输入不足，返回 better=unclear、needsContext=true；不要强行选择一方。",
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
 * | 1 通用侧 | 与作品、模式无关的任务契约：证据优先级、片段口径、needsContext、档位与字段约定 | 本文件 `sharedInstructions` | 每行 |
 * | 2 模式层 | 当前比较模式的列语义与结论字段（双语 A/B、三语 A/B/C） | 本文件 `modeContracts` | 每行 |
 * | 3 特化档案 | 作品/阶段规范，分两种条目：**常驻条目**（关系、作品专有、说话特色、证据边界）与 **按行条目**（排版层、文本层规范，声明 `features`） | `profiles/*.js` | 常驻每行；按行条目只在该行命中特征时（`row-features.js`） |
 * | 4 动态上下文 | 对照表命中段、说话习惯段、说话人判断段、低分归因段、线上查证段 | `term-prefilter.js`、`speech-habit.js`、`low-score.js`、`web-lookup.js` | 命中该行/该章/该轮才注入 |
 * | 5 固定尾巴 | noteref 硬性约束、术语表、JSON 输出约定 | 本文件 + `ai/prompt-contract.js` | 每行（刻意保守：宁可重复也不丢） |
 *
 * **分层（请求里注入了什么）与判定链（结论怎么一步步来的）是两个视角，别混为一谈**：
 *
 * 判定链：对照表（离线四类结论）→ 模型（基础轮 + 上下文轮）→ 低分归因与修复（极低分行的相邻行）→ 线上查证（按站点顺序 + 自行检索）→ 输出侧护栏（修订结果混入原文文字就作废转人工）→ 待人工
 * 对应层：第 4 层的术语段 ──── 第 1/2/3/5 层（+ 相邻行）── 第 4 层的低分归因段 ──── 第 4 层的线上查证段 ──── 无（护栏是结论产出**之后**的确定性校验，不读提示词，见 `ai-proofread.js` 的 `guardTargetScript`）──── 无（终局）
 *
 * 约束：
 * - **顺序不得调整**，测试按分区顺序断言（通用侧 → 模式 → 特化侧 → 动态段 → 约束 → 输出约定）。
 * - 判据**只写一层**：字段默认值、档位定义、needsContext 口径在通用侧写一次；`modeSchemas`
 *   只负责“键名 + 取值”；特化档案只写工作阶段规范，不复述任务契约。
 * - 第 4 层的动态段一律经 `dynamicBlockPrefixes` 剥离后再注入：自定义提示词里残留的旧段会先被剥掉，
 *   任何路径都不得出现两段同类动态段——**新增动态段时必须同时登记到那张前缀表**（段首标记由注入层
 *   自己定义并导出，这里只借用，不复制字面量）。
 * - 第 4 层内部按“由内到外补充资料”排列：术语命中 → 说话习惯 → 低分归因（相邻行）→ 线上查证（外部资料最后注入）。
 * - 裁剪只发生在第 3 层的按行条目与第 4 层：第 1、2、5 层永远全量，避免“省了 token 丢了契约”。
 * - 页面里预填的默认提示词始终是**全量**（第 3 层不裁剪），人工读得到完整规范；
 *   真正发给模型的请求才按 `rowFeatures` 裁剪。
 */

/** 档案条目支持两种形态：字符串＝常驻；`{ text, features }`＝只在该行命中这些特征时注入。 */
function lineText(line) {
  if (typeof line === "string") return line;
  return String(line?.text || "");
}

/**
 * 条目是否该注入。
 * - `features` 为空（全量模式：页面默认提示词、审计、脚本）→ 全部注入；
 * - 没声明 `features` 或声明为空数组 → 常驻；
 * - 声明了未注册的特征 id（笔误）→ 按常驻处理，宁可多注入（见 row-features 的纪律）。
 */
function lineIncluded(line, features) {
  if (!features) return true;
  if (typeof line === "string") return true;
  const need = Array.isArray(line?.features) ? line.features.filter((id) => FEATURE_IDS.includes(id)) : [];
  if (!need.length) return true;
  return need.some((id) => features.has(id));
}

// 特化侧正文：只由 profiles/ 里的可替换档案生成，通用侧不认识它的内容。
// features = null 时输出全量（页面/审计）；给了特征集合时按行裁剪，整节被裁空则连标题一起省掉。
function profileSystemFor(profile, features = null) {
  if (!profile) return "";
  const sections = profile.sections
    .map((section) => {
      const lines = (section.lines || [])
        .filter((line) => lineIncluded(line, features))
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

/** 按行裁剪的审计数字：条目总数、注入/省略条数与被省掉的字符数。 */
function profileLineStats(profile, features = null) {
  let injected = 0;
  let omitted = 0;
  let omittedChars = 0;
  let conditional = 0;
  for (const section of profile?.sections || []) {
    for (const line of section.lines || []) {
      const isConditional = typeof line !== "string"
        && Array.isArray(line?.features)
        && line.features.some((id) => FEATURE_IDS.includes(id));
      if (isConditional) conditional += 1;
      if (lineIncluded(line, features)) injected += 1;
      else {
        omitted += 1;
        omittedChars += lineText(line).length;
      }
    }
  }
  return { injected, omitted, omittedChars, conditional };
}

function proofreadPromptFor(mode = "bilingual", profileId = DEFAULT_PROFILE_ID) {
  const contract = modeContracts[mode] || modeContracts.bilingual;
  const outputSchema = modeSchemas[contract.mode] || modeSchemas.bilingual;
  const profile = resolveProfile(profileId);
  const generic = promptSections(genericHeader, sharedInstructions);
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
    baseSystem: withJsonOnly(generic, outputSchema),
    modeSystem: promptSections(contract.instructions),
    profileSystem,
    // 默认提示词与真正发出的提示词保持一致：也带上 noteref 硬性约束（组装时会先去重再补一次）。
    system: withJsonOnly(promptSections(body, noterefConstraint), outputSchema),
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
  fullPrompt = false,
} = {}) {
  const contract = proofreadPromptFor(mode, profileId);
  // 按行裁剪只作用于特化档案的按行条目：`fullPrompt`（排查/对比用）与没给 rowFeatures 时输出全量。
  const features = fullPrompt ? null : rowFeatures;
  const profileSystem = profileSystemFor(resolveProfile(profileId), features);
  const trimmedBody = promptSections(contract.genericSystem, contract.instructions, profileSystem);
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
  return withJsonOnly(promptSections(body, noterefConstraint, glossary), contract.outputSchema);
}

/**
 * 本次注入的构成（审计用）：各层字符数 + 特化侧按行裁剪的条目数。
 * 供日志汇总与测试断言，不参与提示词文本本身。
 */
function promptLayerReport({ mode = "bilingual", profileId = DEFAULT_PROFILE_ID, rowFeatures = null } = {}) {
  const contract = proofreadPromptFor(mode, profileId);
  const profile = resolveProfile(profileId);
  return {
    profileId: profile.id,
    layers: {
      generic: contract.genericSystem.length,
      mode: contract.modeSystem.length,
      profile: profileSystemFor(profile, rowFeatures).length,
    },
    profileLines: profileLineStats(profile, rowFeatures),
    unknownFeatures: unknownFeatureIds(profile),
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
};
