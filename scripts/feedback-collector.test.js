const test = require("node:test");
const assert = require("node:assert/strict");
const {
  FeedbackCollector,
  normalizeFeedbackEvent,
} = require("../src/workbenches/translation-compare/ai/feedback-collector");

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
