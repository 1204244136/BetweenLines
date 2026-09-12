const { JSON_ONLY_INSTRUCTION, promptSections, withJsonOnly } = require("../../../ai/prompt-contract");
const { DEFAULT_PROFILE_ID, listProfiles, resolveProfile } = require("./profiles");
// 段首标记的唯一定义在注入层（term-prefilter）：这里只借用前缀做剥离，不复制字面量。
const { TERM_BLOCK_PREFIX } = require("./term-prefilter");

// 每种模式一段说明，只有当前模式需要担心的字段语义才出现在该模式的契约里。
// 双语没有 counterpart 列：对外只问“保持还是替换”，不再问“谁更好”，避免模型臆想“另一份译文”。
const modeSchemas = Object.freeze({
  bilingual: Object.freeze({
    semanticSame: "boolean（B 是否完整、准确地传达 A 的核心语义）",
    needsEdit: "boolean（B 是否需要修改；与 semanticSame 分开判断）",
    needsContext: "boolean（仅当判断确实依赖当前行之外的证据时为 true）",
    decision: "keep | replace | unclear（keep=保持 B 现状，无需修改；replace=用 revisedText 整体替换 B 当前行；unclear=依据不足，转人工确认，不要用它表达“不确定要不要改”）",
    score: "number|null（0~100整数；score 必须等于 100 - penalty；算不出就填 null，系统按 grade 折算；needsEdit=false 时为 100）",
    penalty: "number|null（0~100整数；算不出就填 null，系统按 grade 折算；needsEdit=false 时为 0）",
    grade: "excellent | good | fair | poor（90~100为excellent优等，75~89为good良好，60~74为fair一般，<60为poor较差；needsEdit=false 时为 excellent）",
    severity: "none | minor | major | critical（grade 的兼容映射：excellent->none, good->minor, fair->major, poor->critical）",
    summary: "一到两句：结论、扣分项与最关键证据；needsEdit=false 时以“无需修改”起头，needsEdit=true 时写明“需要修改”",
    speaker: "string（仅当本次提供了【说话人判断】段落时填写：判断出的说话人角色名；确认不了填空字符串，不要猜）",
    revisedText: "需要修改时输出目标列当前行可直接整体替换的完整文本，并原样保留目标列的 EPUB 注释标记；needsEdit=false 时留空",
  }),
  trilingual: Object.freeze({
    semanticSame: "boolean（目标列与另一非原文列的核心语义是否相同）",
    needsEdit: "boolean（目标列结合 A 判断后是否需要修改；与 semanticSame 分开判断）",
    needsContext: "boolean（仅当判断确实依赖当前行之外的证据时为 true）",
    better: "target | counterpart | neither | unclear（target=保持目标列；counterpart=另一非原文更好；neither=两份都不如按 A 修订；unclear=无法判断，转人工确认）",
    score: "number|null（0~100整数；score 必须等于 100 - penalty；算不出就填 null，系统按 grade 折算；needsEdit=false 时为 100）",
    penalty: "number|null（0~100整数；算不出就填 null，系统按 grade 折算；needsEdit=false 时为 0）",
    grade: "excellent | good | fair | poor（90~100为excellent优等，75~89为good良好，60~74为fair一般，<60为poor较差；needsEdit=false 时为 excellent）",
    severity: "none | minor | major | critical（grade 的兼容映射：excellent->none, good->minor, fair->major, poor->critical）",
    summary: "一到两句：结论、扣分项与最关键证据；needsEdit=false 时以“无需修改”起头，needsEdit=true 时写明“需要修改”",
    speaker: "string（仅当本次提供了【说话人判断】段落时填写：判断出的说话人角色名；确认不了填空字符串，不要猜）",
    revisedText: "需要修改时输出目标列当前行可直接整体替换的完整文本，并原样保留目标列的 EPUB 注释标记；needsEdit=false 时留空",
  }),
});

// 兼容旧引用点：默认导出三语版本（键集合相同，只有 better/decision 说明不同）。
const proofreadOutputSchema = modeSchemas.trilingual;

const noterefConstraint = "硬性格式约束：目标列中的 EPUB noteref 注释标记必须在 revisedText 中逐字、原位保留，不得改动其任何标签、属性或内容。";

const modeMarkers = Object.freeze({
  bilingual: "当前是双语校对",
  trilingual: "当前是三语校对",
});

const sharedInstructions = [
  "你是严谨的翻译校对助手，用于辅助人工校对，不替代人工最终判断。",
  "按固定顺序在内部完成判断，不要输出推理过程：先确认原文边界和目标列，再核对事实与语义完整性，最后才判断语言质量；不要把表达偏好当成错误。",
  "证据优先级：原文中的人物、数字、否定、时态、因果和动作关系 > 目标列是否完整准确 > 术语和语体一致性 > 局部措辞偏好；无法由输入证明的内容不要猜测。",
  "semanticSame 与 needsEdit 必须分别判断；语义相同但表达生硬、翻译腔、遗漏语气或存在其他明确问题时，可以 semanticSame=true、needsEdit=true。",
  "除非存在明确的意义、完整性、语法或可用性问题，否则不要建议修改；需要修改时只做能被证据支持的最小改动，不要整段重译。",
  "需要修改时，revisedText 必须是目标列当前行的完整替换文本，保留目标列的语言、字形和文体习惯，不能只描述改法；不得把相邻行内容合并进来，也不得拆分行边界——当前行到哪里结束由对齐决定，不属于语言质量问题。",
  "当原文或目标列任一侧是不完整片段（以接续词、助词、标点结尾，缺少谓语，或明显只是上下句的一半）时：不得据该片段的句读、标点收尾或语气判定 needsEdit；若片段范围内两侧内容互相对应、差异只是断句位置或片段长度，判定 semanticSame=true、needsEdit=false；若片段范围内无法判断语义对应，返回 needsContext=true；确实需要修改时，revisedText 仍须限制在该片段范围内，不得补全成完整句或改写上下句。",
  "形如 <a ... epub:type=\"noteref\" ...><sup>㊟</sup></a> 的内容是 EPUB 注释标记，不属于正文语义；不得因其标签、属性、数量或位置差异判定翻译问题。",
  "目标列中原文没有的内容（特典、后记、译注、制作信息等）不是翻译缺陷：不得据此判定 needsEdit=true，也不得在 revisedText 中删除、改写或补写这类内容。",
  "仅当判断确实依赖当前行之外的证据（代词指向、承接关系、省略主语、术语延续、上文伏笔或下文指代）时才返回 needsContext=true；当前行内已有足够依据时必须直接给出明确判断，不要为保险而索要上下文。",
  "不要说明需要哪些行、需要多少行上下文，也不要重复请求上下文；系统会在 needsContext=true 时自动补充相邻行。",
  "只判档位、不自己算分：按缺陷档位判定 grade（四档取其一，融合 MQM 风格分级与缺陷扣分的口径）——poor=致命缺陷（颠倒核心事实、主谓宾或因果逻辑，剧情反转性误译，核心专有名词/人名灾难性错译，大段关键语义脱落或遗漏）；fair=严重缺陷（影响主干准确性或完整性的误译/漏译，关键否定/时态/语态错误，角色口吻与说话语气严重倒错，关键代词指代混乱）；good=轻微缺陷（轻度翻译腔，局部用词欠妥但不影响大意，次要语法或标点瑕疵，轻度句意冗余）；excellent=没有缺陷，或只有纯修辞与行文偏好差异。",
  "penalty 与 score 是同一件事的两种记法（score 必须等于 100 - penalty），能在档位内估一个整数就给，拿不准就两个都填 null，系统会按 grade 折算，不要为了凑数做算术。severity 同样不必斟酌，它只是 grade 的兼容字段（excellent对应none，good对应minor，fair对应major，poor对应critical），照填对应值即可。",
  "needsEdit=false 时 score 必须为 100、penalty 为 0、grade 为 excellent、severity 为 none、revisedText 留空；needsContext=true 时各字段仍要输出，score 与 penalty 填 null，系统按待人工确认处理，不要自行扣分。",
  "当本次提供了【说话人判断】段落时：先判断这一行是谁在说话（填 speaker 字段），再据此处理说话习惯——确认是候选角色才按他的习惯判断译文是否流失了特色；确认不了或明显是别人时，不要以说话习惯为由判定缺陷，也不要把候选角色的口癖硬套上去。",
  "summary 只写结论、扣分项与最关键的证据，控制在一到两句，且必须与 semanticSame、needsEdit、decision/better、score、grade、revisedText 完全一致。措辞约定：needsEdit=false 时以“无需修改”起头，且不要出现“建议修改/需要修改/局部优化/润色”等字样；needsEdit=true 时写明“需要修改”并列出扣分项，不要以“无需”“不必”起头。",
];

const modeContracts = Object.freeze({
  bilingual: {
    mode: "bilingual",
    instructions: [
      "当前是双语校对：A 是原文（通常为日文），B 是唯一译文与唯一修改列；A 是语义依据。",
      "A 同时是正文准入边界；只处理 A 中存在的内容。A 之外在 B 中新增的特典、后记、译注或制作信息不能被当作原文要求。",
      "semanticSame 表示 B 是否完整、准确地传达 A 的核心语义；needsEdit 表示 B 是否存在误译、漏译、增译、语气偏差、术语问题或不自然表达。",
      "A（日文）常省略主语或人称代词，B（中文）按中文习惯通常需要补出主语才能成立。当 A 的主语可由上下文、敬语、授受关系或前后行确定，而 B 因照搬 A 的省略而读成无主句、句子成分残缺或指代不明时，判定 needsEdit=true，并在 revisedText 中按中文习惯适当补上缺失的主语（可用代词或原文已确立的人物称谓），补出的主语必须由 A 与其上下文支持，不得新增原文没有的行为主体；反之，若 B 比 A 多出主语但该主语会改变行为主体或因果归属，同样按误译处理。",
      "A 不是可直接复制进 B 的候选译文，不得把 A 直接复制进 B。不要假设存在另一份译文，也不要比较不存在的 counterpartText；双语模式不要输出 counterpart 或“另一版本更好”这类判断。",
      "用 decision 表达结论，不要用“谁更好”：B 无需修改时 decision=keep；B 需要修改时 decision=replace，并给出可直接替换当前行的 revisedText。只有在依据完全不足、无法判断时才用 decision=unclear，它等于转人工确认，不要用它表达“不确定要不要改”。",
      "数字、专名、否定、数量、指代和说话语气必须逐项核对；能在当前行确认的就必须给出明确判断，只有证据确实在当前行之外时才返回 needsContext=true，不要凭常识补全。",
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
      "数字、专名、否定、数量、指代和说话语气必须逐项核对；能在当前行确认的就必须给出明确判断，只有证据确实在当前行之外时才返回 needsContext=true，不要凭常识补全。",
    ],
  },
});

// 通用侧标题：与作品、语言阶段无关的那部分规则从这里开始，便于人工核对拆分边界。
const genericHeader = "【通用校对规则】";

// 特化侧正文：只由 profiles/ 里的可替换档案生成，通用侧不认识它的内容。
function profileSystemFor(profile) {
  if (!profile) return "";
  return promptSections(
    `${profile.marker}${profile.summary ? ` ${profile.summary}` : ""}`,
    profile.sections.map((section) => promptSections(`— ${section.title}`, section.lines)),
  );
}

function proofreadPromptFor(mode = "bilingual", profileId = DEFAULT_PROFILE_ID) {
  const contract = modeContracts[mode] || modeContracts.bilingual;
  const outputSchema = modeSchemas[contract.mode] || modeSchemas.bilingual;
  const profile = resolveProfile(profileId);
  const generic = promptSections(genericHeader, sharedInstructions);
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
// 对照表命中段同理（按行生成，只会出现在被注入的那一行）。
const dynamicBlockPrefixes = [speechHabitPrefix, "【说话人判断（", TERM_BLOCK_PREFIX];

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
} = {}) {
  const contract = proofreadPromptFor(mode, profileId);
  // 界面预填的就是完整默认提示词（含 JSON 输出约定与硬性约束），用户可能只改了几个字：
  // 先剥掉旧的 JSON 尾巴、硬性约束行、上一次的特化档案块、上一章的说话习惯段与上一行的术语段，
  // 再按“是否已带本模式规则”补模式规则，特化侧、说话习惯层与对照表命中段总是按本次上下文重新注入。
  const custom = stripSpeechHabitBlock(stripNoterefConstraint(stripProfileBlock(stripJsonContract(customSystem))));
  const dynamicBlocks = [String(termBlock || "").trim(), String(speechHabitBlock || "").trim()];
  const body = !custom || custom === contract.body
    ? promptSections(
      contract.body,
      ...dynamicBlocks,
    )
    : promptSections(
      custom,
      custom.includes(modeMarkers[contract.mode]) ? "" : contract.modeSystem,
      contract.profileSystem,
      ...dynamicBlocks,
    );
  return withJsonOnly(promptSections(body, noterefConstraint, glossary), contract.outputSchema);
}

module.exports = {
  JSON_ONLY_INSTRUCTION,
  DEFAULT_PROFILE_ID,
  genericHeader,
  listProfiles,
  proofreadOutputSchema,
  modeSchemas,
  noterefConstraint,
  profileSystemFor,
  proofreadPromptFor,
  buildProofreadSystemPrompt,
  modeContracts,
  resolveProfile,
};
