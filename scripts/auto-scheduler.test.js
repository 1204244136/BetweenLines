const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getModelProfile,
  calculateRoleSuitability,
  recommendRole,
  scheduleModels,
} = require("../src/workbenches/translation-compare/ai/scheduler-profile");

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
  // Reasoning models are strong candidates for arbiter or gatekeeper
  assert.ok(["arbiter", "gatekeeper"].includes(reasonerRole.recommendedRole));

  const claudeRole = recommendRole("claude-3-7-sonnet");
  // Claude Sonnet is an excellent stylist
  assert.ok(["stylist", "arbiter"].includes(claudeRole.recommendedRole));
});

test("自动调度：scheduleModels 在 1、2、3 个模型间合理分配流水线角色", () => {
  // 1 model -> recommends persona runtime
  const single = scheduleModels(["deepseek-chat"]);
  assert.equal(single.mode, "single");
  assert.equal(single.recommendPersona, true);

  // 2 models -> dual challenger mode
  const dual = scheduleModels(["gpt-4o-mini", "claude-3-5-sonnet"]);
  assert.equal(dual.mode, "dual");
  assert.equal(dual.recommendPersona, false);
  assert.ok(dual.gatekeeper.id.includes("gpt-4o-mini")); // cheaper & strict
  assert.ok(dual.stylist.id.includes("claude-3-5-sonnet")); // higher literary

  // 3 models -> multi stage
  const multi = scheduleModels(["gpt-4o-mini", "claude-3-5-sonnet", "deepseek-reasoner"]);
  assert.equal(multi.mode, "multi");
  assert.ok(multi.gatekeeper.id.includes("gpt-4o-mini"));
  assert.ok(multi.stylist.id.includes("claude-3-5-sonnet"));
  assert.ok(multi.arbiter.id.includes("deepseek-reasoner"));
});
