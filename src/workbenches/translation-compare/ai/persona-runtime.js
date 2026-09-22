/**
 * Persona Runtime: Single-Model Persona Differentiation.
 *
 * Emulates a multi-agent review pipeline when only a single model is available
 * by establishing completely isolated execution contexts and prompts:
 * - Gatekeeper: Strict Fact Checker (factual fidelity, omission/addition detection)
 * - Stylist: Literary Stylist (prose fluency, cadence, critique of Gatekeeper changes)
 * - Arbiter: Chief Arbiter (impartial judgment between original, Gatekeeper, and Stylist)
 *
 * Invariant: Messages and reasoning traces must never be shared across persona sessions.
 */

const { detectModelCapabilities, normalizeModelReasoningEffort } = require("./model-capabilities");
const { normalizeCritiqueResult, normalizeArbitrationResult } = require("./stage-results");

const PERSONAS = Object.freeze(["gatekeeper", "stylist", "arbiter"]);

const PERSONA_DEFINITIONS = Object.freeze({
  gatekeeper: {
    id: "gatekeeper",
    name: "事实质检员 (Gatekeeper)",
    role: "Strict Fact Checker",
    description: "专注于事实与语义一致性，严查错译、漏译、加译、人名术语与逻辑偏差。原则：宁可不改，绝不随意润色。",
    reasoningPreference: "low",
  },
  stylist: {
    id: "stylist",
    name: "文学责编 (Stylist)",
    role: "Literary Stylist & Critic",
    description: "专注于文学表现力、中文自然度、消除翻译腔与角色口吻。原则：首先审查 Gatekeeper 提出的修改方案，决定采纳/调整/拒绝，再输出精修方案。",
    reasoningPreference: "medium",
  },
  arbiter: {
    id: "arbiter",
    name: "终审法官 (Chief Arbiter)",
    role: "Chief Arbiter",
    description: "站在客观中立的终审角度，对比原文、原译、Gatekeeper 初审与 Stylist 复审，裁定争端与最终版本。原则：不重新翻译，只裁决已有方案最优解。",
    reasoningPreference: "high",
  },
});

/**
 * Adapt reasoning effort level according to persona responsibility and model capabilities.
 * Gatekeeper -> low/minimal/off
 * Stylist -> medium
 * Arbiter -> high/max
 */
function adaptPersonaReasoningEffort(persona, baseEffort, modelCapabilities = {}) {
  const caps = modelCapabilities || {};
  if (!caps.reasoning) return baseEffort || "";

  const supported = Array.isArray(caps.reasoningEfforts) ? caps.reasoningEfforts : [];
  if (supported.length === 0) return baseEffort || "";

  let target = "medium";
  if (persona === "gatekeeper") {
    target = supported.includes("low") ? "low" : (supported.includes("minimal") ? "minimal" : supported[0]);
  } else if (persona === "stylist") {
    target = supported.includes("medium") ? "medium" : supported[Math.floor(supported.length / 2)];
  } else if (persona === "arbiter") {
    target = supported.includes("high") ? "high" : (supported.includes("max") ? "max" : supported[supported.length - 1]);
  }

  return normalizeModelReasoningEffort(target, caps.id, caps) || baseEffort || target;
}

/**
 * Build the system prompt tailored specifically for the given persona.
 */
function buildPersonaSystemPrompt(persona, basePrompt = "", options = {}) {
  const def = PERSONA_DEFINITIONS[persona] || PERSONA_DEFINITIONS.gatekeeper;
  const customRules = options.customRules ? `\n【附加特定规则】\n${options.customRules}` : "";

  if (persona === "gatekeeper") {
    return [
      `【当前身份与任务契约：${def.name}】`,
      "你是一名冷峻严苛的翻译事实质检员（Gatekeeper）。你的职责是严格审查译文是否存在事实性硬伤。",
      "1. 核心审查范围：错译、漏译、无依据加译、数字单位错误、否定翻转、主客体颠倒、专有名词与人名错乱。",
      "2. 绝对纪律：宁可不改，绝不擅自为了修辞美感而重写译文；若译文语义准确且无硬伤，必须判定无需修改（needsEdit=false）。",
      "3. 保持客观中立，指出硬伤时给出确凿证据。",
      basePrompt ? `\n${basePrompt}` : "",
      customRules,
    ].filter(Boolean).join("\n");
  }

  if (persona === "stylist") {
    return [
      `【当前身份与任务契约：${def.name}】`,
      "你是一名资深的文学责编与风格审阅专家（Stylist）。你的职责是审视中文译本的自然度与文学表现力，并对事实初审员（Gatekeeper）的修改提案进行同行评审（Peer Critique）。",
      "1. 核心审查范围：中文表达是否通顺生动、是否残留生硬的日文翻译腔（如滥用被动态、的字过多、语序僵硬）、标点节奏、角色口吻契合度。",
      "2. 针对 Gatekeeper 初审方案的评审契约（Critique）：",
      "   - accept: 完全认同 Gatekeeper 的修改建议；",
      "   - modify: 认同 Gatekeeper 发现的硬伤，但在其建议基础上进行了更优雅生动的文学润色；",
      "   - reject: 认为 Gatekeeper 属于过度挑刺/将原作者意图误判为错误，建议维持原译；",
      "   - escalate: 双方存在深层歧义或上下文不足，需提交终审仲裁。",
      "3. 必须输出合法 JSON，包含 critique 结构：attitude, rationale, acceptedChanges, rejectedChanges，以及 revisedText（修改结果）。",
      basePrompt ? `\n${basePrompt}` : "",
      customRules,
    ].filter(Boolean).join("\n");
  }

  if (persona === "arbiter") {
    return [
      `【当前身份与任务契约：${def.name}】`,
      "你是翻译评议委员会的终审法官（Chief Arbiter）。当事实质检员（Gatekeeper）与文学责编（Stylist）产生分歧，或遇到高风险疑难语句时，由你做出权威终审裁决。",
      "1. 审判原则：",
      "   - 忠实度第一：如果某方案虽然文采斐然但扭曲了原文真实含义，予以驳回；",
      "   - 避免无谓重述：不重新翻译，只裁决已有方案最优解，优先在【原译】、【Gatekeeper方案】、【Stylist方案】之间裁定胜出者（winner: 'gatekeeper' | 'stylist' | 'original' | 'neither'）；",
      "   - 只有当既有方案全部存在致命硬伤时，才给出极简修复方案。",
      "2. 必须输出合法 JSON，包含：winner, reason, finalDecision ('keep'|'replace'|'unclear'), riskFlags, revisedText。",
      basePrompt ? `\n${basePrompt}` : "",
      customRules,
    ].filter(Boolean).join("\n");
  }

  return basePrompt;
}

/**
 * Build messages for Stylist review.
 */
function buildStylistMessages(row, gatekeeperDecision, options = {}) {
  const baseSystem = buildPersonaSystemPrompt("stylist", "", options);
  const targetLabel = options.targetLabel || "当前译文";
  const sourceText = row.source || row.jp || "";
  const targetText = row.target || row.cn || "";

  const userPayload = {
    index: row.index,
    sourceText,
    targetText,
    gatekeeperReview: {
      needsEdit: gatekeeperDecision.needsEdit,
      better: gatekeeperDecision.better,
      summary: gatekeeperDecision.summary || "",
      revisedText: gatekeeperDecision.revisedText || "",
      score: gatekeeperDecision.score,
    },
    task: "请作为文学责编审查上述初审结果：给出你的 critique 评价（attitude: accept/modify/reject/escalate），并在需要修改时给出最终文学润色文本（revisedText）。",
  };

  return [
    { role: "system", content: baseSystem },
    {
      role: "user",
      content: `请审阅第 ${row.index} 行的翻译与初审方案：\n${JSON.stringify(userPayload, null, 2)}\n\n请按如下 JSON 结构回复：\n{\n  "critique": {\n    "attitude": "accept | modify | reject | escalate",\n    "rationale": "评阅分析",\n    "acceptedChanges": ["采纳点"],\n    "rejectedChanges": ["驳回点"]\n  },\n  "revisedText": "最终润色文本（若无需修改或完全维持原译则为空）",\n  "summary": "简短综合意见"\n}`,
    },
  ];
}

/**
 * Build messages for Arbiter final decision.
 */
function buildArbiterMessages(row, gatekeeperDecision, stylistCritique, options = {}) {
  const baseSystem = buildPersonaSystemPrompt("arbiter", "", options);
  const sourceText = row.source || row.jp || "";
  const targetText = row.target || row.cn || "";

  const userPayload = {
    index: row.index,
    sourceText,
    targetText,
    gatekeeperReview: {
      summary: gatekeeperDecision.summary || "",
      revisedText: gatekeeperDecision.revisedText || "",
    },
    stylistReview: {
      attitude: stylistCritique.attitude || "modify",
      rationale: stylistCritique.rationale || stylistCritique.summary || "",
      revisedText: stylistCritique.revisedText || "",
    },
    task: "请对比原文、原译以及初审与复审意见，做出终审裁决。判定哪一方胜出（winner），并给出最终定案文本（revisedText）。",
  };

  return [
    { role: "system", content: baseSystem },
    {
      role: "user",
      content: `请裁决第 ${row.index} 行的分歧：\n${JSON.stringify(userPayload, null, 2)}\n\n请按如下 JSON 结构回复：\n{\n  "winner": "gatekeeper | stylist | original | neither",\n  "reason": "仲裁裁决理由",\n  "finalDecision": "replace | keep | unclear",\n  "riskFlags": [],\n  "revisedText": "最终定案文本"\n}`,
    },
  ];
}

/**
 * Parse Stylist model output into normalized critique and revisedText.
 */
function parseStylistResponse(content) {
  const text = String(content || "").trim();
  const jsonText = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/) || ["{}"])[0];
  let parsed = {};
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = {};
  }

  const rawCritique = parsed.critique || parsed;
  const critique = normalizeCritiqueResult({
    attitude: rawCritique.attitude || rawCritique.status,
    rationale: rawCritique.rationale || rawCritique.reason || parsed.summary,
    acceptedChanges: rawCritique.acceptedChanges,
    rejectedChanges: rawCritique.rejectedChanges,
  });

  const revisedText = String(
    parsed.revisedText ||
    parsed.revision ||
    parsed.modifiedText ||
    rawCritique.revisedText ||
    ""
  ).trim();

  return {
    critique,
    revisedText,
    summary: String(parsed.summary || critique.rationale || "").trim(),
  };
}

/**
 * Parse Arbiter model output into normalized ArbitrationResult.
 */
function parseArbiterResponse(content) {
  const text = String(content || "").trim();
  const jsonText = text.startsWith("{") ? text : (text.match(/\{[\s\S]*\}/) || ["{}"])[0];
  let parsed = {};
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    parsed = {};
  }

  const result = normalizeArbitrationResult({
    winner: parsed.winner || (parsed.decision === "keep" ? "original" : "stylist"),
    reason: parsed.reason || parsed.summary || parsed.rationale,
    riskFlags: parsed.riskFlags,
    finalDecision: parsed.finalDecision || parsed.decision,
  });

  const revisedText = String(
    parsed.revisedText ||
    parsed.finalText ||
    parsed.revision ||
    ""
  ).trim();

  return {
    arbitration: result,
    revisedText,
  };
}

/**
 * Creates an isolated execution context for a given persona.
 */
function createPersonaContext(persona, baseConfig = {}, options = {}) {
  const validPersona = PERSONAS.includes(persona) ? persona : "gatekeeper";
  const def = PERSONA_DEFINITIONS[validPersona];
  const caps = detectModelCapabilities(baseConfig.model, baseConfig.provider);
  const reasoningEffort = adaptPersonaReasoningEffort(validPersona, baseConfig.reasoningEffort, caps);

  return {
    persona: validPersona,
    definition: def,
    config: {
      ...baseConfig,
      reasoningEffort,
    },
    systemPrompt: buildPersonaSystemPrompt(validPersona, options.basePrompt, options),
    // Independent message log to guarantee zero shared state across sessions
    messageHistory: [],
  };
}

module.exports = {
  PERSONAS,
  PERSONA_DEFINITIONS,
  adaptPersonaReasoningEffort,
  buildPersonaSystemPrompt,
  buildStylistMessages,
  buildArbiterMessages,
  parseStylistResponse,
  parseArbiterResponse,
  createPersonaContext,
};
