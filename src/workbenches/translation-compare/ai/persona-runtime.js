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
    description: "站在客观中立的终审角度，对比原文、原译、Gatekeeper 初审与 Stylist 复审，裁定争端与最终版本。原则：不重新翻译；仲裁不局限于二选一，若初审与复审各有可取之处，应主动给出汲取双方优点的结合修改方案。",
    reasoningPreference: "high",
  },
});

/**
 * 契约：推理强度根据规则只由模型预设提供，角色绝不改变推理强度。
 * 仅对模型预设传入的 baseEffort 进行合法性归一化与保留，角色不覆写强度。
 */
function adaptPersonaReasoningEffort(persona, baseEffort, modelCapabilities = {}) {
  const raw = String(baseEffort || "").trim();
  if (!raw) return "";

  const caps = modelCapabilities || {};
  if (!caps.reasoning) return raw;

  return normalizeModelReasoningEffort(raw, caps.id, caps) || raw;
}

/**
 * Extract applicable rules from basePrompt for downstream personas (stylist/arbiter).
 * 契约：提示词由长变短、职责逐步收敛。
 * - Gatekeeper: 接收全量 basePrompt（最长：包含完整 MQM 打分标准、判定流程、排版与专有规范）。
 * - Stylist: 精简 basePrompt（中等：剥离初审打分、扣分、MQM 评级、初审决策字段，保留语言质感与排版呈现规范）。
 * - Arbiter: 极致精简 basePrompt（最短：彻底剥离初审打分、通用校对流程与冲突格式指令，仅保留排版硬约束与作品专有事实）。
 */
function extractSpecializedRules(basePrompt = "", persona = "gatekeeper") {
  if (!basePrompt) return "";
  if (persona === "gatekeeper") return basePrompt;

  const lines = basePrompt.split("\n");
  const filtered = [];
  let skippingJsonFormat = false;
  let skippingTermBlock = false;
  let skippingGeneralRulesForArbiter = false;

  for (const line of lines) {
    // 1. 过滤任何初审输出格式约定与 JSON 声明
    if (/【输出格式约定】|```json|JSON 格式如下|请输出合法的 JSON|输出字段说明/i.test(line)) {
      skippingJsonFormat = true;
      continue;
    }
    if (skippingJsonFormat) {
      if (line.startsWith("【") || line.startsWith("#") || /^\s*$/.test(line)) {
        skippingJsonFormat = false;
      } else {
        continue;
      }
    }

    // 2. 剥离 basePrompt 中可能残留的术语块，避免与 options.termBlock 重复注入
    if (line.includes("【译名对照表")) {
      skippingTermBlock = true;
      continue;
    }
    if (skippingTermBlock) {
      if (line.startsWith("【") || line.startsWith("#") || /^\s*$/.test(line)) {
        skippingTermBlock = false;
      } else {
        continue;
      }
    }

    // 3. 针对所有下游角色（Stylist/Arbiter），剥离初审特有的打分体系与字段指令
    if (/只判档位|不自己算分|MQM|penalty|score=|按缺陷档位|poor=|fair=|good=|excellent=|severity/i.test(line)) {
      continue;
    }
    if (/semanticSame|needsEdit|better.*target|counterpartText/i.test(line)) {
      continue;
    }
    if (/用 decision 表达结论|decision=keep|decision=replace|decision=unclear/i.test(line)) {
      continue;
    }
    if (/只返回一个 JSON 对象，不要返回 Markdown/i.test(line)) {
      continue;
    }

    // 4. 针对 Arbiter 的极致精简（最短提示词）：
    // Arbiter 专注于裁判原则与成品硬红线，跳过通用初审工作流程描述（如【通用校对规则】大段流程）
    if (persona === "arbiter") {
      if (/【通用校对规则】/.test(line)) {
        skippingGeneralRulesForArbiter = true;
        continue;
      }
      if (skippingGeneralRulesForArbiter) {
        // 遇到成品排版规范、作品专有事实或硬性格式约束时恢复接入
        if (line.startsWith("【成品校对规范") ||
            line.startsWith("【作品专有") ||
            line.startsWith("— 作品专有") ||
            line.startsWith("— 排版与呈现层") ||
            line.startsWith("— 文本层规范") ||
            line.startsWith("硬性格式约束")) {
          skippingGeneralRulesForArbiter = false;
        } else {
          continue;
        }
      }
      // 过滤与法官仲裁无关的初审流程说明
      if (/原文那一侧的分行|不要在说明中索要上下文|系统会自动补行|A 不是可复制进 B|按“原文边界|无法证明的不猜/i.test(line)) {
        continue;
      }
    }

    filtered.push(line);
  }
  return filtered.join("\n").trim();
}

/**
 * Build the system prompt tailored specifically for the given persona.
 */
function buildPersonaSystemPrompt(persona, basePrompt = "", options = {}) {
  const def = PERSONA_DEFINITIONS[persona] || PERSONA_DEFINITIONS.gatekeeper;
  const customRules = options.customRules ? `\n【附加特定规则】\n${options.customRules}` : "";
  const specializedBase = extractSpecializedRules(basePrompt, persona);
  const termBlock = options.termBlock || options.termGuidance?.block || "";
  const glossary = options.glossary || "";
  const termSection = [
    termBlock ? `\n${termBlock}` : "",
    glossary ? `\n${glossary}` : "",
  ].filter(Boolean).join("\n");

  if (persona === "gatekeeper") {
    return [
      `【当前身份与任务契约：${def.name}】`,
      "你是一名冷峻严苛的翻译事实质检员（Gatekeeper）。你的职责是严格审查译文是否存在事实性硬伤。",
      "1. 核心审查范围：错译、漏译、无依据加译、数字单位错误、否定翻转、主客体颠倒、专有名词与人名错乱。",
      "2. 绝对纪律：宁可不改，绝不擅自为了修辞美感而重写译文；若译文语义准确且无硬伤，必须判定无需修改（needsEdit=false）。",
      "3. 保持客观中立，指出硬伤时给出确凿证据。",
      termSection ? `\n${termSection}` : "",
      specializedBase ? `\n${specializedBase}` : "",
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
      "3. 术语与规范红线：在文学润色与消除翻译腔的同时，必须严格遵守译名对照表（若提供）与专有名词规范，不得为了追求修辞或句式流畅而擅自变更标准译名；若 Gatekeeper 已纠正术语，复审方案不得改回错误译名。",
      "4. 必须输出合法 JSON，包含 critique 结构：attitude, rationale, acceptedChanges, rejectedChanges，以及 revisedText（修改结果）。",
      termSection ? `\n${termSection}` : "",
      specializedBase ? `\n${specializedBase}` : "",
      customRules,
    ].filter(Boolean).join("\n");
  }

  if (persona === "arbiter") {
    return [
      `【当前身份与任务契约：${def.name}】`,
      "你是翻译评议委员会的终审法官（Chief Arbiter）。当事实质检员（Gatekeeper）与文学责编（Stylist）产生分歧，或遇到高风险疑难语句时，由你做出权威终审裁决。",
      "1. 审判原则：",
      "   - 忠实度第一：若某方案文采斐然但扭曲了原文真实含义，予以驳回；忠实准确是翻译的底线。",
      "   - 术语裁决权威：项目译名对照表与术语规范具有最高事实约束力。若某方方案遵守了术语表而另一方擅自发挥或遗漏，必须裁定遵守术语表的一方胜出（或在结合方案中强制采用标准术语）；仲裁定案绝不得在已提供术语表的情况下违背术语表标准译名。",
      "   - 裁决与结合机制（打破二选一）：原则上不重新翻译，只裁决已有方案最优解或融合长处，仲裁绝不仅限于二选一：",
      "     * 若某一方方案完全胜出，可直接裁定胜出（winner: 'gatekeeper' 或 'stylist'）；",
      "     * 若原译准确恰当且无需修改，可裁定维持原译（winner: 'original'）；",
      "     * 【核心结合方案】若初审（Gatekeeper）与复审（Stylist）的内容各有可取之处（例如：初审准确纠正了漏译错译或术语硬伤，复审语言更为自然生动但遗漏了初审的订正，或两者分别修正了不同缺陷），你应当主动融会贯通，给出汲取双方优点的结合修改方案（winner 设为 'synthesis'，并在 revisedText 给出具体的结合修改文本）；",
      "     * 若两方修改方案均存在严重缺陷且确实都需要修改，也可给出独立裁决修复方案（winner: 'neither'）。",
      "2. 必须输出合法 JSON，包含：winner ('gatekeeper'|'stylist'|'synthesis'|'original'|'neither'), reason, finalDecision ('keep'|'replace'|'unclear'), riskFlags, revisedText。",
      termSection ? `\n${termSection}` : "",
      specializedBase ? `\n${specializedBase}` : "",
      customRules,
    ].filter(Boolean).join("\n");
  }

  return basePrompt;
}

/**
 * Build messages for Stylist review.
 */
function buildStylistMessages(row, gatekeeperDecision, options = {}) {
  const baseSystem = buildPersonaSystemPrompt("stylist", options.basePrompt || "", options);
  const targetLabel = options.targetLabel || "当前译文";
  const sourceText = row.source || row.jp || "";
  const targetText = row.target || row.cn || "";
  const termGuidance = options.termGuidance || null;
  const context = options.context || null;

  const userPayload = {
    index: row.index,
    sourceText,
    targetText,
    ...(context ? {
      context: {
        note: "相邻行上下文（仅供判断语流衔接与语气连贯性，非当前修改目标）",
        ...context,
      },
    } : {}),
    ...(termGuidance ? {
      terms: {
        source: "译名对照表（本行命中的条目）",
        targetLabel,
        items: termGuidance.terms.map((term) => ({
          source: term.source,
          matchedAlias: term.alias,
          translation: term.target,
          type: term.type,
          note: term.note,
        })),
        note: "译文出现这些概念时必须使用对照表给出的标准译名；复审润色时不得擅自变更或回退标准译名。",
      },
    } : {}),
    ...(options.glossary ? {
      glossary: options.glossary,
    } : {}),
    gatekeeperReview: {
      needsEdit: gatekeeperDecision.needsEdit,
      better: gatekeeperDecision.better,
      summary: gatekeeperDecision.summary || "",
      revisedText: gatekeeperDecision.revisedText || "",
      score: gatekeeperDecision.score,
    },
    task: "请作为文学责编审查上述初审结果：给出你的 critique 评价（attitude: accept/modify/reject/escalate），并在需要修改时给出最终文学润色文本（revisedText）。若提供了译名对照表/术语表，复审润色必须严格遵循标准译名，不得擅自回退或改动。",
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
  const baseSystem = buildPersonaSystemPrompt("arbiter", options.basePrompt || "", options);
  const targetLabel = options.targetLabel || "当前译文";
  const sourceText = row.source || row.jp || "";
  const targetText = row.target || row.cn || "";
  const termGuidance = options.termGuidance || null;
  const context = options.context || null;

  const userPayload = {
    index: row.index,
    sourceText,
    targetText,
    ...(context ? {
      context: {
        note: "前后文语境依据（用于理清前因后果、指示代词与上下文事实，请作为终审裁决与结合方案的核心证据）",
        ...context,
      },
    } : {}),
    ...(termGuidance ? {
      terms: {
        source: "译名对照表（本行命中的条目）",
        targetLabel,
        items: termGuidance.terms.map((term) => ({
          source: term.source,
          matchedAlias: term.alias,
          translation: term.target,
          type: term.type,
          note: term.note,
        })),
        note: "译文出现这些概念时必须使用对照表给出的标准译名；术语一致性是硬性规范，仲裁裁决与结合方案必须遵守标准译名。",
      },
    } : {}),
    ...(options.glossary ? {
      glossary: options.glossary,
    } : {}),
    gatekeeperReview: {
      summary: gatekeeperDecision.summary || "",
      revisedText: gatekeeperDecision.revisedText || "",
    },
    stylistReview: {
      attitude: stylistCritique.attitude || "modify",
      rationale: stylistCritique.rationale || stylistCritique.summary || "",
      revisedText: stylistCritique.revisedText || "",
    },
    task: "请对比原文、原译以及初审与复审意见，做出终审裁决。仲裁不限于二选一：可裁定某方胜出或维持原译；若觉得初审和复审各有可取之处，请给出融合双方优点的结合修改方案（winner 设为 synthesis），并在 revisedText 中给出定案文本。若提供了术语表/译名对照表，裁决必须严格遵循标准译名。",
  };

  return [
    { role: "system", content: baseSystem },
    {
      role: "user",
      content: `请裁决第 ${row.index} 行的分歧：\n${JSON.stringify(userPayload, null, 2)}\n\n请按如下 JSON 结构回复：\n{\n  "winner": "gatekeeper | stylist | synthesis | original | neither",\n  "reason": "仲裁裁决理由（若采用结合方案，请说明分别吸取了初审与复审的哪些长处）",\n  "finalDecision": "replace | keep | unclear",\n  "riskFlags": [],\n  "revisedText": "最终定案文本（若采用结合方案或修改方案，给出完整成品文本；若维持原译可为空）"\n}`,
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
 * Normalize raw winner from Arbiter model response into canonical winner keys:
 * "gatekeeper" | "stylist" | "synthesis" | "original" | "neither"
 */
function normalizeArbiterWinner(rawWinner, fallbackDecision) {
  const text = String(rawWinner || "").trim().toLowerCase();
  if (["synthesis", "combined", "combination", "hybrid", "both", "blend", "merge", "结合", "结合方案", "综合", "综合方案", "兼顾", "融合"].includes(text)) {
    return "synthesis";
  }
  if (["gatekeeper", "gk", "初审", "初审方案", "事实初审", "事实方案"].includes(text)) {
    return "gatekeeper";
  }
  if (["stylist", "复审", "复审方案", "文学复审", "文学方案"].includes(text)) {
    return "stylist";
  }
  if (["original", "target", "原译", "维持原译", "不改", "无需修改", "keep"].includes(text)) {
    return "original";
  }
  if (["neither", "compromise", "折中", "折中方案", "独立", "独立方案"].includes(text)) {
    return "neither";
  }
  if (text) {
    if (text.includes("结合") || text.includes("综合") || text.includes("融合")) return "synthesis";
    if (text.includes("复审") || text.includes("stylist")) return "stylist";
    if (text.includes("初审") || text.includes("gatekeeper")) return "gatekeeper";
    if (text.includes("原译") || text.includes("维持")) return "original";
    return text;
  }
  return fallbackDecision === "keep" ? "original" : "stylist";
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

  const rawWinner = parsed.winner || (parsed.decision === "keep" ? "original" : "stylist");
  const normalizedWinner = normalizeArbiterWinner(rawWinner, parsed.finalDecision || parsed.decision);

  const result = normalizeArbitrationResult({
    winner: normalizedWinner,
    reason: parsed.reason || parsed.summary || parsed.rationale,
    riskFlags: parsed.riskFlags,
    finalDecision: parsed.finalDecision || parsed.decision || (normalizedWinner === "original" ? "keep" : "replace"),
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
  extractSpecializedRules,
  buildPersonaSystemPrompt,
  buildStylistMessages,
  buildArbiterMessages,
  parseStylistResponse,
  parseArbiterResponse,
  createPersonaContext,
};
