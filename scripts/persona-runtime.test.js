const test = require("node:test");
const assert = require("node:assert/strict");
const {
  PERSONAS,
  PERSONA_DEFINITIONS,
  adaptPersonaReasoningEffort,
  buildPersonaSystemPrompt,
  buildStylistMessages,
  buildArbiterMessages,
  parseStylistResponse,
  parseArbiterResponse,
  createPersonaContext,
} = require("../src/workbenches/translation-compare/ai/persona-runtime");

test("角色运行时：导出合法的角色清单与角色定义", () => {
  assert.deepEqual(PERSONAS, ["gatekeeper", "stylist", "arbiter"]);
  assert.ok(PERSONA_DEFINITIONS.gatekeeper.name.includes("Gatekeeper"));
  assert.ok(PERSONA_DEFINITIONS.stylist.name.includes("Stylist"));
  assert.ok(PERSONA_DEFINITIONS.arbiter.name.includes("Arbiter"));
});

test("角色运行时：adaptPersonaReasoningEffort 根据角色动态调整推理强度", () => {
  const o1Caps = { id: "o1", reasoning: true, reasoningEfforts: ["low", "medium", "high"] };

  const gkEffort = adaptPersonaReasoningEffort("gatekeeper", "", o1Caps);
  assert.equal(gkEffort, "low");

  const styEffort = adaptPersonaReasoningEffort("stylist", "", o1Caps);
  assert.equal(styEffort, "medium");

  const arbEffort = adaptPersonaReasoningEffort("arbiter", "", o1Caps);
  assert.equal(arbEffort, "high");
});

test("角色运行时：buildPersonaSystemPrompt 为每个角色生成特化的系统指令", () => {
  const gkPrompt = buildPersonaSystemPrompt("gatekeeper", "base-rules");
  assert.ok(gkPrompt.includes("冷峻严苛"));
  assert.ok(gkPrompt.includes("绝不擅自为了修辞美感而重写译文"));

  const styPrompt = buildPersonaSystemPrompt("stylist", "base-rules");
  assert.ok(styPrompt.includes("文学责编"));
  assert.ok(styPrompt.includes("Critique"));

  const arbPrompt = buildPersonaSystemPrompt("arbiter", "base-rules");
  assert.ok(arbPrompt.includes("终审法官"));
  assert.ok(arbPrompt.includes("不重新翻译"));
});

test("角色运行时：parseStylistResponse 正确解析结构化的复审评审结果", () => {
  const raw = JSON.stringify({
    critique: {
      attitude: "modify",
      rationale: "语义正确但语序僵硬",
      acceptedChanges: ["修正漏译的动词"],
      rejectedChanges: ["直译导致的被动句"],
    },
    revisedText: "更优美的译文",
    summary: "精修译文",
  });

  const parsed = parseStylistResponse(raw);
  assert.equal(parsed.critique.attitude, "modify");
  assert.equal(parsed.critique.rationale, "语义正确但语序僵硬");
  assert.equal(parsed.revisedText, "更优美的译文");
});

test("角色运行时：parseArbiterResponse 正确解析结构化的终审仲裁结果", () => {
  const raw = JSON.stringify({
    winner: "stylist",
    reason: "文学性显著提高且未伤及原文信息",
    finalDecision: "replace",
    riskFlags: ["mild_colloquialism"],
    revisedText: "终审裁定的译文",
  });

  const parsed = parseArbiterResponse(raw);
  assert.equal(parsed.arbitration.winner, "stylist");
  assert.equal(parsed.arbitration.finalDecision, "replace");
  assert.equal(parsed.revisedText, "终审裁定的译文");
});

test("角色运行时：createPersonaContext 构建相互隔离的运行时上下文", () => {
  const baseConfig = { model: "o3-mini", provider: "local" };
  const ctxA = createPersonaContext("gatekeeper", baseConfig);
  const ctxB = createPersonaContext("stylist", baseConfig);

  assert.notEqual(ctxA.persona, ctxB.persona);
  assert.notEqual(ctxA.systemPrompt, ctxB.systemPrompt);
  assert.notEqual(ctxA.messageHistory, ctxB.messageHistory);
});
