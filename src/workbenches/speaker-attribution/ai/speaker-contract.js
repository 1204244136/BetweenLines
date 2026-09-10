const {
  JSON_ONLY_INSTRUCTION,
  promptSections,
  withJsonOnly,
  clamp,
} = require("../../../ai/prompt-contract");

const SPEAKER_PROMPT_VERSION = "speaker-attribution-prompt-v2";

const speakerOutputSchema = Object.freeze({
  speaker: "string（confirmed 时必须是证据中的候选；其他状态必须为空）",
  status: "confirmed | unknown | multiple | needs-review",
  confidence: "0-1 数字，表示当前输入下的归属把握，不是注意力分数",
  evidence: "一到两句，引用 context id 或实际上下文短语；不得留空",
  needsContext: "boolean（仅在具体补充邻近线索可能改变判断时为 true）",
});

const VALID_STATUSES = new Set(["confirmed", "unknown", "multiple", "needs-review"]);

const sharedInstructions = [
  "你是严谨的说话人归属审阅助手，目标是辅助人工确认，不替代人工最终判断。",
  "只判断目标行这一整段「…」或『…』发话的说话人；引号内的多个句子属于同一次发话，不得拆分，也不要把叙述行当成待归属发话。",
  "充分利用 focusedContext 和 candidates 中能够在输入里找到的证据。候选列表是启发式检索提示；若文本叙述中有明确伴随动作或引语的主体人物，应据实归属。",
  "【伴随动作与引语归属原则】：发话紧随或紧承某人的伴随动作（如「…」と頭をかきむしりながらXは飛び出す、或「…」Xは走り出した/ため息をついた/苦笑した），该动作主体 X 即为发话人，属于明确高优先级直接证据，不强求死板的‘说/喊’动词。",
  "【连续独白与发话承接原则】：当发话表现为独白、感叹或连续自语（无交谈对象的独白），且前后叙述中该主体正在执行连贯动作（如奔跑、抱怨），且无第二角色介入时，该主体即为说话人；若包含 priorSpeaker（前文发话人），且属于未换人的连续独白，应当承接归属于该角色。",
  "先判断是否只有一个有证据支持的候选：只有一个才可 status=confirmed；多个候选互相冲突时 status=multiple；证据完全不足且扩大上下文也无法解决时 status=unknown；缺少邻近线索且补充更广泛上下文可能解决时 status=needs-review 并 needsContext=true。",
  "status=unknown 或 multiple 时 speaker 必须为空；不得凭空捏造无关姓名。confirmed 时 speaker 必须采用证据中的实际人物文本。",
  "confidence 表示当前归属把握：指向明确给出合理分值（如 0.7~0.95）；弱线索、冲突或跨语言猜测给中低分。",
  "evidence 用一到两句简短说明，引用实际上下文中的关键短语或动作依据；优先写出原文片段，不能写泛泛的‘根据上下文’。",
  "当当前局部窗口线索不足时，必须返回 needsContext=true，系统将依据渐进式披露原则自动扩充全景上下文重新推断。",
];

const modeContracts = Object.freeze({
  monolingual: {
    mode: "monolingual",
    instructions: [
      "当前是单语发话推断：依据文本上下文、伴随动作及对话轮次判断说话人。",
      "证据优先级为：明确的发话/伴随动作（「とXは…」或某人说话/动作接续） > 紧邻的连续独白与称谓轮次 > 更远的背景叙述；低优先级信号不能推翻明确高优先级证据。",
    ],
  },
  bilingual: {
    mode: "bilingual",
    instructions: [
      "当前是双语对照推断：原文与主文本互为对照参考，两者只是同一发话的两种表达。",
      "证据优先级为：明确的发话/伴随动作（「とXは…」或某人说话/动作接续） > 紧邻的连续独白与称谓轮次 > 更远的背景叙述 > 双语字符或长度相似度；低优先级信号不能推翻明确高优先级证据。",
      "双语输入中，原文与主文本只是同一发话的两种表达；不要因为字符不同、长度不同或对齐分数偏低就推断为不同说话人。",
    ],
  },
});

function speakerPromptFor(mode = "bilingual") {
  const contract = modeContracts[mode] || modeContracts.bilingual;
  const system = withJsonOnly(promptSections(sharedInstructions, contract.instructions), speakerOutputSchema);
  return {
    version: SPEAKER_PROMPT_VERSION,
    mode: contract.mode,
    system,
    baseSystem: withJsonOnly(sharedInstructions, speakerOutputSchema),
    modeSystem: promptSections(contract.instructions),
    outputSchema: speakerOutputSchema,
  };
}

function buildSpeakerSystemPrompt({ mode = "bilingual", customSystem = "" } = {}) {
  const contract = speakerPromptFor(mode);
  const custom = String(customSystem || "").trim();
  const base = custom && custom !== contract.system ? custom : contract.system;
  return withJsonOnly(promptSections(
    base,
    custom && custom !== contract.system ? contract.modeSystem : "",
  ), speakerOutputSchema);
}

function normalizeStatus(rawStatus, { needsContext = false, hasSpeaker = false } = {}) {
  const status = String(rawStatus || "").trim().toLowerCase();
  if (needsContext) return "needs-review";
  if (VALID_STATUSES.has(status)) return status;
  if (!hasSpeaker) return "unknown";
  return "confirmed";
}

function validateSpeakerOutput(rawParsed) {
  if (!rawParsed || typeof rawParsed !== "object") {
    return {
      speaker: "",
      status: "needs-review",
      confidence: 0,
      evidence: "模型输出无法解析为合规 JSON",
      needsContext: true,
    };
  }

  const rawSpeaker = typeof rawParsed.speaker === "string" ? rawParsed.speaker.trim() : "";
  const needsContext = Boolean(rawParsed.needsContext);
  let status = normalizeStatus(rawParsed.status, {
    needsContext,
    hasSpeaker: Boolean(rawSpeaker),
  });

  const confidence = clamp(rawParsed.confidence ?? (status === "confirmed" ? 0.8 : 0.2), 0, 1);
  const evidence = typeof rawParsed.evidence === "string" ? rawParsed.evidence.trim() : "";

  // Keep the normalized value aligned with the prompt contract. A model may
  // return a plausible name with an unresolved status, or omit evidence;
  // neither should silently become an adoptable confirmed prediction.
  if (status !== "confirmed") {
    status = status === "multiple" ? "multiple" : (needsContext ? "needs-review" : status);
  }
  const speaker = status === "confirmed" ? rawSpeaker : "";
  if (status === "confirmed" && !speaker) status = "unknown";

  return {
    speaker,
    status,
    confidence: Number(confidence.toFixed(3)),
    evidence: evidence || "模型未提供可核查的归属证据",
    needsContext: status === "needs-review" ? needsContext : false,
  };
}

const speakerPrompt = Object.freeze({
  version: SPEAKER_PROMPT_VERSION,
  system: speakerPromptFor("bilingual").system,
  outputSchema: speakerOutputSchema,
});

const speakerInstructions = [
  ...sharedInstructions,
  ...modeContracts.bilingual.instructions,
];

module.exports = {
  JSON_ONLY_INSTRUCTION,
  SPEAKER_PROMPT_VERSION,
  VALID_STATUSES,
  speakerOutputSchema,
  sharedInstructions,
  modeContracts,
  speakerInstructions,
  speakerPrompt,
  speakerPromptFor,
  buildSpeakerSystemPrompt,
  normalizeStatus,
  validateSpeakerOutput,
};
