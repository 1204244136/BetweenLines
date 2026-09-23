const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeCritiqueResult,
  normalizeReviewStageResult,
  normalizeArbitrationResult,
  reviewStageResultFromLegacy,
  createStageMetrics,
  incrementStageMetric,
  isFastPassDecision,
} = require("../src/workbenches/translation-compare/ai/stage-results");

const {
  getModelProfile,
  calculateRoleSuitability,
  recommendRole,
  scheduleModels,
} = require("../src/workbenches/translation-compare/ai/scheduler-profile");

const {
  PERSONAS,
  PERSONA_DEFINITIONS,
  adaptPersonaReasoningEffort,
  buildPersonaSystemPrompt,
  parseStylistResponse,
  parseArbiterResponse,
  createPersonaContext,
} = require("../src/workbenches/translation-compare/ai/persona-runtime");

const {
  shouldTriggerArbitration,
  resolveDeterministicAgreement,
  applyArbitrationDecision,
  formatArbitrationNoteLines,
} = require("../src/workbenches/translation-compare/ai/arbiter");

const {
  FeedbackCollector,
  normalizeFeedbackEvent,
} = require("../src/workbenches/translation-compare/ai/feedback-collector");

// ==========================================
// 1. 阶段评审结果契约与指标 (Stage Results & Metrics)
// ==========================================

test("评审结果被规范化为稳定契约结构", () => {
  assert.deepEqual(normalizeCritiqueResult({ attitude: "modify", rationale: 12, acceptedChanges: ["a", 2] }), {
    attitude: "modify", rationale: "12", acceptedChanges: ["a", "2"], rejectedChanges: [],
  });
  assert.equal(normalizeCritiqueResult({ attitude: "unknown" }).attitude, "escalate");
});

test("阶段指标累加正确并拒绝非法计数项", () => {
  const metrics = createStageMetrics({ fastPassHits: 2, stage1Passed: -4 });
  incrementStageMetric(metrics, "fastPassHits");
  incrementStageMetric(metrics, "stage1Passed", 3);
  incrementStageMetric(metrics, "missing");
  assert.equal(metrics.fastPassHits, 3);
  assert.equal(metrics.stage1Passed, 3);
  assert.equal(metrics.missing, undefined);
});

test("快速直通要求确定无需修改且不需上下文的明确结论", () => {
  assert.equal(isFastPassDecision({ needsEdit: false }), true);
  assert.equal(isFastPassDecision({ needsEdit: false, needsContext: true }), false);
  assert.equal(isFastPassDecision({ needsEdit: false, better: "unclear" }), false);
  assert.equal(isFastPassDecision({ needsEdit: true }), false);
});

test("评审阶段结果约束并归一化其稳定字段", () => {
  assert.deepEqual(normalizeReviewStageResult({ stage: "stylist", modelId: 7, confidence: 2, needsEdit: 1 }), {
    stage: "stylist", modelId: "7", persona: "stylist", needsEdit: false, needsContext: false,
    decision: "", summary: "", revisedText: "", confidence: 1,
  });
});

test("仲裁结果保持与表现层解耦的稳定契约", () => {
  assert.deepEqual(normalizeArbitrationResult({ winner: 2, reason: null, riskFlags: ["logic", 3], finalDecision: "replace" }), {
    winner: "2", reason: "", riskFlags: ["logic", "3"], finalDecision: "replace",
  });
});

test("旧版结果转换补充 Gatekeeper 阶段且不修改原对象", () => {
  const legacy = { done: true, note: "same" };
  assert.deepEqual(reviewStageResultFromLegacy(legacy, "model-a"), {
    stage: "gatekeeper", modelId: "model-a", persona: "gatekeeper", needsEdit: false,
    needsContext: false, decision: "prefilter", summary: "same", revisedText: "", confidence: null,
  });
  assert.deepEqual(legacy, { done: true, note: "same" });
});

// ==========================================
// 2. 模型画像与角色调度 (Scheduler & Profiles)
// ==========================================

test("模型画像：getModelProfile 返回带有准确评分的精选档案", () => {
  const profile = getModelProfile("deepseek-reasoner");
  assert.equal(profile.source, "curated");
  assert.equal(profile.reasoning, true);
  assert.ok(profile.strictness >= 9.0);
  assert.ok(profile.reasoningScore >= 9.0);

  const claudeProfile = getModelProfile("claude-3-7-sonnet");
  assert.equal(claudeProfile.source, "curated");
  assert.ok(claudeProfile.literary >= 9.0);
});

test("模型画像：getModelProfile 为未知模型提供合理的启发式评估", () => {
  const customReasoner = getModelProfile("my-custom-r1-model");
  assert.equal(customReasoner.source, "heuristic");
  assert.ok(customReasoner.reasoningScore >= 8.5);

  const customHaiku = getModelProfile("custom-mini-flash-7b");
  assert.equal(customHaiku.source, "heuristic");
  assert.ok(customHaiku.cost <= 2.5);
});

test("角色推荐：recommendRole 准确识别模型特长并推荐合适角色", () => {
  const reasonerRole = recommendRole("deepseek-reasoner");
  assert.ok(["arbiter", "gatekeeper"].includes(reasonerRole.recommendedRole));

  const claudeRole = recommendRole("claude-3-7-sonnet");
  assert.ok(["stylist", "arbiter"].includes(claudeRole.recommendedRole));
});

test("自动调度：scheduleModels 在 1、2、3 个模型间合理分配流水线角色", () => {
  const single = scheduleModels(["deepseek-chat"]);
  assert.equal(single.mode, "single");
  assert.equal(single.recommendPersona, true);

  const dual = scheduleModels(["gpt-4o-mini", "claude-3-5-sonnet"]);
  assert.equal(dual.mode, "dual");
  assert.equal(dual.recommendPersona, false);
  assert.ok(dual.gatekeeper.id.includes("gpt-4o-mini"));
  assert.ok(dual.stylist.id.includes("claude-3-5-sonnet"));

  const multi = scheduleModels(["gpt-4o-mini", "claude-3-5-sonnet", "deepseek-reasoner"]);
  assert.equal(multi.mode, "multi");
  assert.ok(multi.gatekeeper.id.includes("gpt-4o-mini"));
  assert.ok(multi.stylist.id.includes("claude-3-5-sonnet"));
  assert.ok(multi.arbiter.id.includes("deepseek-reasoner"));
});

// ==========================================
// 3. 角色运行时 (Persona Runtime)
// ==========================================

test("角色运行时：导出合法的角色清单与角色定义", () => {
  assert.deepEqual(PERSONAS, ["gatekeeper", "stylist", "arbiter"]);
  assert.ok(PERSONA_DEFINITIONS.gatekeeper.name.includes("Gatekeeper"));
  assert.ok(PERSONA_DEFINITIONS.stylist.name.includes("Stylist"));
  assert.ok(PERSONA_DEFINITIONS.arbiter.name.includes("Arbiter"));
});

test("角色运行时：adaptPersonaReasoningEffort 严格遵从模型预设，角色不改变推理强度", () => {
  const o1Caps = { id: "o1", reasoning: true, reasoningEfforts: ["low", "medium", "high"] };

  // 1. 预设明确指定强度时，所有角色均保留预设强度，绝不擅自篡改
  assert.equal(adaptPersonaReasoningEffort("gatekeeper", "high", o1Caps), "high");
  assert.equal(adaptPersonaReasoningEffort("stylist", "high", o1Caps), "high");
  assert.equal(adaptPersonaReasoningEffort("arbiter", "high", o1Caps), "high");

  assert.equal(adaptPersonaReasoningEffort("gatekeeper", "low", o1Caps), "low");
  assert.equal(adaptPersonaReasoningEffort("stylist", "low", o1Caps), "low");
  assert.equal(adaptPersonaReasoningEffort("arbiter", "low", o1Caps), "low");

  // 2. 预设未配置推理强度时，角色不擅自填充默认强度
  assert.equal(adaptPersonaReasoningEffort("gatekeeper", "", o1Caps), "");
  assert.equal(adaptPersonaReasoningEffort("stylist", "", o1Caps), "");
  assert.equal(adaptPersonaReasoningEffort("arbiter", "", o1Caps), "");
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

test("角色运行时：parseArbiterResponse 正确解析打破二选一的结合修改方案（synthesis）", () => {
  const rawEng = JSON.stringify({
    winner: "synthesis",
    reason: "初审纠正了否定时态硬伤，复审消除了翻译腔，两者结合为最优解",
    finalDecision: "replace",
    riskFlags: [],
    revisedText: "结合初审准确性与复审文学性的定案文本",
  });
  const parsedEng = parseArbiterResponse(rawEng);
  assert.equal(parsedEng.arbitration.winner, "synthesis");
  assert.equal(parsedEng.arbitration.finalDecision, "replace");
  assert.equal(parsedEng.revisedText, "结合初审准确性与复审文学性的定案文本");

  // 支持中文 winner 声明，自动归一化为 synthesis
  const rawZh = JSON.stringify({
    winner: "结合方案",
    reason: "综合初审与复审的长处",
    revisedText: "中文归一定案文本",
  });
  const parsedZh = parseArbiterResponse(rawZh);
  assert.equal(parsedZh.arbitration.winner, "synthesis");
  assert.equal(parsedZh.arbitration.finalDecision, "replace");
  assert.equal(parsedZh.revisedText, "中文归一定案文本");
});

test("角色运行时：createPersonaContext 构建相互隔离的运行时上下文", () => {
  const baseConfig = { model: "o3-mini", provider: "local" };
  const ctxA = createPersonaContext("gatekeeper", baseConfig);
  const ctxB = createPersonaContext("stylist", baseConfig);

  assert.notEqual(ctxA.persona, ctxB.persona);
  assert.notEqual(ctxA.systemPrompt, ctxB.systemPrompt);
  assert.notEqual(ctxA.messageHistory, ctxB.messageHistory);
});

// ==========================================
// 4. 仲裁决议与分歧判定 (Arbitration)
// ==========================================

test("仲裁触发：shouldTriggerArbitration 准确检测主动升级与立场分歧", () => {
  const esc = shouldTriggerArbitration({
    stylistReview: { critique: { attitude: "escalate" } },
  });
  assert.equal(esc.triggered, true);

  const div = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "方案A" },
    stylistReview: { critique: { attitude: "reject" } },
  });
  assert.equal(div.triggered, true);

  const textDiff = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "方案A" },
    stylistReview: { critique: { attitude: "modify" }, revisedText: "方案B" },
  });
  assert.equal(textDiff.triggered, true);

  const agree = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "方案A" },
    stylistReview: { critique: { attitude: "accept" }, revisedText: "方案A" },
  });
  assert.equal(agree.triggered, false);
});

test("确定性一致判定：resolveDeterministicAgreement 捕获方案完全一致情况", () => {
  const resolved = resolveDeterministicAgreement({
    gatekeeperDecision: { needsEdit: true, revisedText: "修订内容" },
    stylistReview: { critique: { attitude: "accept" }, revisedText: "修订内容" },
  });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.result.winner, "gatekeeper");
  assert.equal(resolved.revisedText, "修订内容");
});

test("仲裁决议应用：applyArbitrationDecision 准确选择胜出修订案", () => {
  const applied = applyArbitrationDecision({
    arbitration: { winner: "stylist", finalDecision: "replace" },
    gatekeeperDecision: { revisedText: "初审文本" },
    stylistReview: { revisedText: "文学润色文本" },
  });
  assert.equal(applied.winner, "stylist");
  assert.equal(applied.needsEdit, true);
  assert.equal(applied.revisedText, "文学润色文本");
});

test("仲裁决议应用：applyArbitrationDecision 支持结合修改方案并采用 Arbiter 融合文本", () => {
  const applied = applyArbitrationDecision({
    arbitration: { winner: "synthesis", reason: "融合初审纠错与复审句式" },
    gatekeeperDecision: { revisedText: "初审纠错文本" },
    stylistReview: { revisedText: "复审润色文本" },
    adjudicatedRevisedText: "仲裁结合两者的全新定案文本",
  });
  assert.equal(applied.winner, "synthesis");
  assert.equal(applied.finalDecision, "replace");
  assert.equal(applied.needsEdit, true);
  assert.equal(applied.revisedText, "仲裁结合两者的全新定案文本");
});

test("仲裁备注格式化：formatArbitrationNoteLines 生成结构化分析轨迹", () => {
  const lines = formatArbitrationNoteLines({
    gatekeeperDecision: { summary: "发现漏译形容词" },
    stylistReview: { critique: { attitude: "modify", rationale: "补充形容词但重构为优雅主谓句" } },
    arbitration: { winner: "stylist", reason: "Stylist 方案更符合中文叙述节奏" },
  });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("Gatekeeper初审"));
  assert.ok(lines[1].includes("Stylist复审[调整]"));
  assert.ok(lines[2].includes("Arbiter仲裁[复审方案]"));
});

test("仲裁备注格式化：记录各阶段特有修订文本以追踪演进链条", () => {
  const lines = formatArbitrationNoteLines({
    gatekeeperDecision: {
      summary: "指出语病重复与事实增补",
      needsEdit: true,
      stage1RevisedText: "亚雷斯塔尚未登门",
    },
    stylistReview: {
      critique: { attitude: "modify", rationale: "增强隐喻，提升文采" },
      revisedText: "亚雷斯塔尚未叩响门扉",
    },
    arbitration: {
      winner: "stylist",
      reason: "复审方案更具文学意蕴",
    },
  });
  assert.ok(lines.some((l) => l === "Gatekeeper初审：指出语病重复与事实增补"));
  assert.ok(lines.some((l) => l === "初审改案：亚雷斯塔尚未登门"));
  assert.ok(lines.some((l) => l.startsWith("Stylist复审[调整]：")));
  assert.ok(lines.some((l) => l === "复审改案：亚雷斯塔尚未叩响门扉"));
  assert.ok(lines.some((l) => l.startsWith("Arbiter仲裁[复审方案]：")));
});

test("仲裁备注格式化：支持结合修改方案并在备注中生成「仲裁[结合方案]」与「仲裁改案」", () => {
  const lines = formatArbitrationNoteLines({
    gatekeeperDecision: {
      summary: "指出关键术语漏译",
      needsEdit: true,
      stage1RevisedText: "初审纠错文本",
    },
    stylistReview: {
      critique: { attitude: "modify", rationale: "改善行文语序" },
      revisedText: "复审润色文本",
    },
    arbitration: {
      winner: "synthesis",
      reason: "初审术语准确，复审句式优美，汲取双方优点进行结合",
      revisedText: "仲裁结合定案文本",
    },
  });
  assert.ok(lines.some((l) => l.startsWith("Arbiter仲裁[结合方案]：初审术语准确，复审句式优美")));
  assert.ok(lines.some((l) => l === "仲裁改案：仲裁结合定案文本"));
});

// ==========================================
// 5. 人工反馈收集器 (Feedback Collector)
// ==========================================

test("反馈收集：normalizeFeedbackEvent 优雅处理无效事件取值", () => {
  const norm = normalizeFeedbackEvent({ action: "invalid", index: -5 });
  assert.equal(norm.action, "accepted_ai");
  assert.equal(norm.index, 0);
  assert.equal(norm.stage, "gatekeeper");
});

test("反馈收集：FeedbackCollector 追踪人工反馈事件并计算统计指标", () => {
  const collector = new FeedbackCollector();

  collector.record({
    action: "accepted_ai",
    index: 1,
    stage: "stylist",
    modelId: "claude-3-5-sonnet",
  });
  collector.record({
    action: "accepted_ai",
    index: 2,
    stage: "stylist",
    modelId: "claude-3-5-sonnet",
  });
  collector.record({
    action: "rejected_ai",
    index: 3,
    stage: "gatekeeper",
    modelId: "gpt-4o",
  });
  collector.record({
    action: "modified_ai",
    index: 4,
    stage: "arbiter",
    modelId: "deepseek-reasoner",
  });

  const stats = collector.getStatistics();
  assert.equal(stats.total, 4);
  assert.equal(stats.accepted, 2);
  assert.equal(stats.rejected, 1);
  assert.equal(stats.modified, 1);
  assert.equal(stats.acceptanceRate, 50);
  assert.equal(stats.rejectionRate, 25);

  assert.equal(stats.byStage.stylist.accepted, 2);
  assert.equal(stats.byStage.gatekeeper.rejected, 1);
});

test("反馈收集：FeedbackCollector 支持与 JSON 的序列化及反序列化", () => {
  const c1 = new FeedbackCollector();
  c1.record({ action: "accepted_ai", index: 10 });
  const serialized = c1.toJSON();

  const c2 = new FeedbackCollector();
  c2.fromJSON(serialized);
  assert.equal(c2.events.length, 1);
  assert.equal(c2.events[0].index, 10);
});
