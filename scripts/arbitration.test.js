const test = require("node:test");
const assert = require("node:assert/strict");
const {
  shouldTriggerArbitration,
  resolveDeterministicAgreement,
  applyArbitrationDecision,
  formatArbitrationNoteLines,
} = require("../src/workbenches/translation-compare/ai/arbiter");

test("shouldTriggerArbitration detects escalation and stance divergence", () => {
  // Escalation by stylist
  const esc = shouldTriggerArbitration({
    stylistReview: { critique: { attitude: "escalate" } },
  });
  assert.equal(esc.triggered, true);

  // Gatekeeper wants edit, stylist rejects
  const div = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "方案A" },
    stylistReview: { critique: { attitude: "reject" } },
  });
  assert.equal(div.triggered, true);

  // Substantial revision divergence
  const textDiff = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "方案A" },
    stylistReview: { critique: { attitude: "modify" }, revisedText: "方案B" },
  });
  assert.equal(textDiff.triggered, true);

  // Agreement -> no trigger
  const agree = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "方案A" },
    stylistReview: { critique: { attitude: "accept" }, revisedText: "方案A" },
  });
  assert.equal(agree.triggered, false);
});

test("resolveDeterministicAgreement catches trivial agreements", () => {
  const resolved = resolveDeterministicAgreement({
    gatekeeperDecision: { needsEdit: true, revisedText: "修订内容" },
    stylistReview: { critique: { attitude: "accept" }, revisedText: "修订内容" },
  });
  assert.equal(resolved.resolved, true);
  assert.equal(resolved.result.winner, "gatekeeper");
  assert.equal(resolved.revisedText, "修订内容");
});

test("applyArbitrationDecision selects winning revision accurately", () => {
  const applied = applyArbitrationDecision({
    arbitration: { winner: "stylist", finalDecision: "replace" },
    gatekeeperDecision: { revisedText: "初审文本" },
    stylistReview: { revisedText: "文学润色文本" },
  });
  assert.equal(applied.winner, "stylist");
  assert.equal(applied.needsEdit, true);
  assert.equal(applied.revisedText, "文学润色文本");
});

test("formatArbitrationNoteLines generates structured analysis traces", () => {
  const lines = formatArbitrationNoteLines({
    gatekeeperDecision: { summary: "发现漏译形容词" },
    stylistReview: { critique: { attitude: "modify", rationale: "补充形容词但重构为优雅主谓句" } },
    arbitration: { winner: "stylist", reason: "Stylist 方案更符合中文叙述节奏" },
  });
  assert.equal(lines.length, 3);
  assert.ok(lines[0].includes("Gatekeeper初审"));
  assert.ok(lines[1].includes("Stylist复审[调整]"));
  assert.ok(lines[2].includes("Arbiter仲裁[Stylist方案]"));
});
