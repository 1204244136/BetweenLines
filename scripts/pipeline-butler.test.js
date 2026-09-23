const test = require("node:test");
const assert = require("node:assert/strict");

const {
  calculateCharacterOverlap,
  measureTextDrift,
  checkTermPreservation,
  checkCorrectionRegression,
  inspectStylistDrift,
  extractNeighborContext,
} = require("../src/workbenches/translation-compare/ai/pipeline-butler");

const {
  shouldTriggerArbitration,
} = require("../src/workbenches/translation-compare/ai/arbiter");

test("管家偏离度度量：calculateCharacterOverlap 计算字符骨架重叠度", () => {
  // 完全相同
  assert.equal(calculateCharacterOverlap("他静静地推开了门。", "他静静地推开了门。"), 1.0);
  assert.equal(calculateCharacterOverlap("", ""), 1.0);

  // 微调一两个词（微小润色）：重合度高（>0.75）
  const minor = calculateCharacterOverlap("他静静地推开了门。", "他轻轻地推开了门。");
  assert.ok(minor >= 0.75, `微调重合度应大于 0.75，实际: ${minor}`);

  // 句式结构颠倒但词汇保持：重合度良好
  const inverted = calculateCharacterOverlap("正是因为如此，真相才浮出水面。", "真相浮出水面，正是因为如此。");
  assert.ok(inverted >= 0.90, `语序倒装词汇相同重合度应接近 1.0，实际: ${inverted}`);

  // 彻底大改大换血放飞自我：重合度极低（<0.6）
  const rewrite = calculateCharacterOverlap(
    "他静静地推开了门。",
    "伴随着一声若有若无的叹息，他宛如幽灵般悄然推开了那扇木门。"
  );
  assert.ok(rewrite < 0.60, `彻底放飞重写重合度应显著低于 0.60，实际: ${rewrite}`);
});

test("管家偏离度度量：measureTextDrift 准确计算长度与字符差异", () => {
  const drift = measureTextDrift("他推开门。", "他轻轻地推开了大门。");
  assert.equal(drift.gkLength, 5);
  assert.equal(drift.styLength, 10);
  assert.equal(drift.lengthDelta, 5);
  assert.equal(drift.lengthRatio, 1.0);
});

test("管家防放飞熔断：良性修辞微调顺利通过直通线", () => {
  const inspection = inspectStylistDrift({
    gkText: "正是因为如此，亚瑟·爱德华·伟特话语中的真意也随之显现。",
    styText: "正是因为如此，亚瑟·爱德华·伟特言语间的真意也随之浮现。",
    targetText: "正是因为如此，亚瑟·爱德华·伟特的那句「我喜欢你」背后的真意也随之显现。",
    gatekeeperDecision: {
      summary: "删去无中生有的「我喜欢你」",
      revisedText: "正是因为如此，亚瑟·爱德华·伟特话语中的真意也随之显现。",
    },
    stylistReview: {
      critique: {
        attitude: "modify",
        acceptedChanges: ["剔除虚假引语"],
        rejectedChanges: [],
      },
      revisedText: "正是因为如此，亚瑟·爱德华·伟特言语间的真意也随之浮现。",
    },
  });

  assert.equal(inspection.isBenignPolish, true, "字词微调且自报采纳初审时应放行");
  assert.equal(inspection.circuitBroken, false);
});

test("管家防放飞熔断：字数暴涨放飞自我触发长度熔断", () => {
  // 初审 10 个字，复审写了 20 个字（长度膨胀 100% > 25% 阈值）
  const inspection = inspectStylistDrift({
    gkText: "他静静地推开了房门。",
    styText: "伴随着若有若无的一声叹息，他宛如幽灵一般悄无声息地推开了那扇紧闭的房门。",
    targetText: "他把门给开了。",
    gatekeeperDecision: {
      summary: "修改僵硬把字句",
      revisedText: "他静静地推开了房门。",
    },
    stylistReview: {
      critique: {
        attitude: "modify",
        acceptedChanges: ["修正把字句"],
        rejectedChanges: [], // 谎报无驳回！
      },
      revisedText: "伴随着若有若无的一声叹息，他宛如幽灵一般悄无声息地推开了那扇紧闭的房门。",
    },
  });

  assert.equal(inspection.isBenignPolish, false);
  assert.equal(inspection.circuitBroken, true);
  assert.ok(inspection.reason.includes("字数与初审差异过大"));
  assert.ok(inspection.reason.includes("移交终审把关"));
});

test("管家防放飞熔断：整句大换血触发骨架重合度熔断", () => {
  // 字数接近，但字面几乎全换掉（重合度 < 70%）
  const inspection = inspectStylistDrift({
    gkText: "他的右腕之中装配着相异的术式。",
    styText: "交错潜藏在他右臂深处的两样法术。",
    targetText: "他的右手被植入了两种不同的法术。",
    gatekeeperDecision: {
      summary: "术式规范",
      revisedText: "他的右腕之中装配着相异的术式。",
    },
    stylistReview: {
      critique: {
        attitude: "modify",
        acceptedChanges: ["调整语态"],
        rejectedChanges: [], // 假装没有驳回
      },
      revisedText: "交错潜藏在他右臂深处的两样法术。",
    },
  });

  assert.equal(inspection.isBenignPolish, false);
  assert.equal(inspection.circuitBroken, true);
  assert.ok(inspection.reason.includes("字符骨架重合度过低"));
});

test("管家防放飞熔断：润色时遗漏标准术语触发熔断", () => {
  const inspection = inspectStylistDrift({
    gkText: "他的右臂装配着两套相异的术式。",
    styText: "他右臂里潜藏着两种迥异的法术。", // 把术式润色丢了！
    targetText: "他的右手有法术。",
    gatekeeperDecision: {
      summary: "修正术语为术式",
      revisedText: "他的右臂装配着两套相异的术式。",
    },
    stylistReview: {
      critique: {
        attitude: "modify",
        acceptedChanges: ["动作生动化"],
        rejectedChanges: [],
      },
      revisedText: "他右臂里潜藏着两种迥异的法术。",
    },
    signals: {
      termGuidance: {
        terms: [{ source: "術式", target: "术式" }],
      },
    },
  });

  assert.equal(inspection.isBenignPolish, false);
  assert.equal(inspection.circuitBroken, true);
  assert.ok(inspection.reason.includes("遗漏了标准术语「术式」"));
});

test("管家防放飞熔断：润色时重新带回初审已删除的错误词触发熔断", () => {
  const inspection = inspectStylistDrift({
    gkText: "正是因为如此，伟特言语间的真意随之显现。",
    styText: "正是因为如此，伟特那句「我喜欢你」背后的深意悄然浮现。", // 竟然把「我喜欢你」又加回来了！
    targetText: "正是因为如此，亚瑟·爱德华·伟特的那句「我喜欢你」背后的真意也随之显现。",
    gatekeeperDecision: {
      summary: "需要修改：删去无中生有的虚假引语「我喜欢你」",
      revisedText: "正是因为如此，伟特言语间的真意随之显现。",
    },
    stylistReview: {
      critique: {
        attitude: "modify",
        acceptedChanges: ["文学意境提升"],
        rejectedChanges: [],
      },
      revisedText: "正是因为如此，伟特那句「我喜欢你」背后的深意悄然浮现。",
    },
  });

  assert.equal(inspection.isBenignPolish, false);
  assert.equal(inspection.circuitBroken, true);
  assert.ok(inspection.reason.includes("重新引入了初审已剔除的错误词：「我喜欢你」"));
});

test("管家仲裁联动：shouldTriggerArbitration 与管家熔断无缝协同", () => {
  // 1. 正常良性润色：管家放行，shouldTriggerArbitration 不触发仲裁
  const benignCheck = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "他静静地推开了门。" },
    stylistReview: {
      critique: { attitude: "modify", acceptedChanges: ["微调语气"], rejectedChanges: [] },
      revisedText: "他轻轻地推开了门。",
    },
  });
  assert.equal(benignCheck.triggered, false);

  // 2. 放飞重构大换血：管家熔断，shouldTriggerArbitration 触发终审仲裁
  const wildCheck = shouldTriggerArbitration({
    gatekeeperDecision: { needsEdit: true, revisedText: "他静静地推开了门。" },
    stylistReview: {
      critique: { attitude: "modify", acceptedChanges: ["文风修饰"], rejectedChanges: [] },
      revisedText: "伴随着微风的一丝呜咽，他宛如暗夜里的幽灵悄然无息地推开了那扇虚掩的木门。",
    },
  });
  assert.equal(wildCheck.triggered, true);
  assert.ok(wildCheck.reason.includes("管家风控熔断"));
  assert.ok(wildCheck.butlerMetrics);
});

test("管家上下文供给：extractNeighborContext 准确按梯度切割", () => {
  const allRows = [
    { index: 10, jp: "第10行原文", cn: "第10行译文" },
    { index: 11, jp: "第11行原文", cn: "第11行译文" },
    { index: 12, jp: "第12行原文", cn: "第12行译文" },
    { index: 13, jp: "第13行原文", cn: "第13行译文" },
    { index: 14, jp: "第14行原文", cn: "第14行译文" },
  ];

  // 1. Stylist 中等上下文 (radius = 1)
  const styCtx = extractNeighborContext(allRows, 12, 1);
  assert.equal(styCtx.before.length, 1);
  assert.equal(styCtx.before[0].index, 11);
  assert.equal(styCtx.after.length, 1);
  assert.equal(styCtx.after[0].index, 13);

  // 2. Arbiter 充分长上下文 (radius = 2)
  const arbCtx = extractNeighborContext(allRows, 12, 2);
  assert.equal(arbCtx.before.length, 2);
  assert.equal(arbCtx.before[0].index, 10);
  assert.equal(arbCtx.before[1].index, 11);
  assert.equal(arbCtx.after.length, 2);
  assert.equal(arbCtx.after[0].index, 13);
  assert.equal(arbCtx.after[1].index, 14);

  // 3. 边界首行与尾行容错
  const headCtx = extractNeighborContext(allRows, 10, 2);
  assert.equal(headCtx.before.length, 0);
  assert.equal(headCtx.after.length, 2);

  const tailCtx = extractNeighborContext(allRows, 14, 2);
  assert.equal(tailCtx.before.length, 2);
  assert.equal(tailCtx.after.length, 0);
});
