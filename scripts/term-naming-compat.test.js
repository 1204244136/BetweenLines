const test = require("node:test");
const assert = require("node:assert/strict");
const { createWorkbench, storageFixture, currentKey } = require("./workbench-fixture");
const { splitAiNoteParts, stageNoteState } = require("../src/workbenches/translation-compare/ai/stage-note-state");
const { buildProofreadSystemPrompt } = require("../src/workbenches/translation-compare/ai/proofread-contract");
const { buildPersonaSystemPrompt } = require("../src/workbenches/translation-compare/ai/persona-runtime");
const { TERM_MARKER, TERM_BLOCK_PREFIX, termBlock } = require("../src/workbenches/translation-compare/ai/term-prefilter");

test("译名表更名：新旧备注都保留术语徽标、预筛分类和审核边界", () => {
  const priorAi = "[AI校对]\n是否需要修改：是\n初审改案：新的译文";
  for (const marker of ["[对照表]", TERM_MARKER]) {
    const note = `${marker}\n语义是否相同：相同\n是否需要修改：否\n分析：术语一致。`;
    assert.deepEqual(splitAiNoteParts(`${priorAi}\n\n${note}`), [priorAi, note]);
    assert.equal(stageNoteState(note).pendingReview, false);
    // 历史版本允许术语冲突备注，仍应识别它的人工审核候选身份。
    assert.equal(stageNoteState(note.replace("是否需要修改：否", "是否需要修改：是")).candidate, true);
    const ui = createWorkbench(storageFixture({
      [currentKey]: JSON.stringify({ 1: { note, signature: "sig-1" } }),
    }));
    assert.equal(ui.run("prefilterResultKind(allRows[0])"), "term");
    assert.equal(ui.run("aiBadgeState(notes['1']).text"), "术语一致");
    assert.equal(ui.run("notes['1'].note"), note, "读取旧备注不能改写长期保存的备注正文");
  }
});

test("译名表更名：自定义提示词残留的新旧术语段均被替换，只注入本行条目", () => {
  const current = termBlock(["新术语 → 新译名"]);
  assert.equal(TERM_MARKER, "[译名表]");
  assert.ok(current.startsWith(TERM_BLOCK_PREFIX));
  for (const stalePrefix of ["【术语（对照表命中）】", TERM_BLOCK_PREFIX, "【译名对照表（本行命中）】", "【译名表（本行命中）】"]) {
    const customSystem = `自定义保留规则\n${stalePrefix}\n- 过期术语 → 过期译名\n【自定义后续规则】\n继续保留`;
    const prompt = buildProofreadSystemPrompt({ mode: "bilingual", profileId: "novel", customSystem, termBlock: current });
    assert.ok(prompt.includes("自定义保留规则"));
    assert.ok(prompt.includes("继续保留"));
    assert.ok(!prompt.includes("过期译名"));
    assert.equal(prompt.split(TERM_BLOCK_PREFIX).length - 1, 1);
    for (const persona of ["stylist", "arbiter"]) {
      const downstream = buildPersonaSystemPrompt(persona, customSystem, { termBlock: current });
      assert.ok(!downstream.includes("过期译名"));
      assert.ok(downstream.includes("继续保留"));
      assert.equal(downstream.split(TERM_BLOCK_PREFIX).length - 1, 1);
    }
  }
});
