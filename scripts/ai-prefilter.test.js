const test = require("node:test");
const assert = require("node:assert/strict");
const {
  canUseSimilarityPrefilter,
  canonicalText,
  classifyPrefilter,
} = require("./ai-prefilter");

test("canonicalText 规范化全半角、空白与不可见字符", () => {
  assert.equal(canonicalText("\uFEFF ３\u200B "), "3");
});

test("全角与半角数字行在确定性规则上完全等价", () => {
  assert.deepEqual(
    classifyPrefilter({ source: "３", left: "3", right: "３", score: 0.28 }, 0.92)?.kind,
    "rule-equivalent",
  );
});

test("与原文不一致的结构化内容分流至人工复核", () => {
  assert.equal(
    classifyPrefilter({ source: "4", left: "３", right: "3", score: 1 }, 0.92)?.kind,
    "structured-conflict",
  );
});

test("存在差异的结构化数值绝不进入 AI 校对", () => {
  assert.equal(
    classifyPrefilter({ source: "4", left: "3", right: "4", score: 0 }, 0.92)?.kind,
    "structured-conflict",
  );
});

test("非原文列为空的行直接跳过且无需发起 AI 调用", () => {
  assert.equal(
    classifyPrefilter({ source: "本文", left: "", right: "", score: 0 }, 0.92)?.kind,
    "rule-empty",
  );
});

test("短文本的标点差异不视为确定性相等", () => {
  assert.equal(classifyPrefilter({ left: "哇！", right: "哇。", score: 1 }, 0.92), null);
});

test("相似度预筛拒绝包含变更数字词元的行", () => {
  const left = "这是用于校验第3章节编号是否一致的一段较长正文内容";
  const right = "这是用于校验第4章节编号是否一致的一段较长正文内容";
  assert.equal(canUseSimilarityPrefilter(left, right), false);
  assert.equal(classifyPrefilter({ left, right, score: 1 }, 0.92), null);
});

test("通过安全守卫的长文本仍可应用配置的相似度阈值", () => {
  const left = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜甲";
  const right = "天地玄黄宇宙洪荒日月盈昃辰宿列张寒来暑往秋收冬藏闰余成岁律吕调阳云腾致雨露结为霜乙";
  assert.equal(canUseSimilarityPrefilter(left, right), true);
  assert.equal(classifyPrefilter({ left, right, score: 0.96 }, 0.92)?.kind, "similarity");
});
