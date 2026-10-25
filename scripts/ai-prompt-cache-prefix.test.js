const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CACHEABLE_PREFIX_LENGTH, JSON_ONLY_INSTRUCTION,
} = require("../src/ai/prompt-contract");
const {
  buildProofreadSystemPromptParts, buildProofreadSystemPrompt, proofreadPromptFor,
  listProfiles, resolveProfile, profileSystemFor, profileEntities, noterefConstraint,
} = require("../src/workbenches/translation-compare/ai/proofread-contract");
const { FEATURE_IDS, detectRowFeatures } = require("../src/workbenches/translation-compare/ai/row-features");
const { buildMessages } = require("../src/workbenches/translation-compare/ai/ai-proofread");
const { buildStylistMessages, buildArbiterMessages, extractSpecializedRules } = require("../src/workbenches/translation-compare/ai/persona-runtime");
const { buildSpeakerPrompt } = require("../src/workbenches/speaker-attribution/attention");

function ruleLines(text) {
  return text.split("\n").filter((line) => line && !line.startsWith("【") && !line.startsWith("— ")).sort();
}

test("提示词缓存：常驻前缀不随行特征、实体或动态资料变化，原有规则集合保持等价", () => {
  const genericGates = [
    ["任一侧是不完整片段", "fragment"],
    ["形如 <a", "noteref"],
    ["目标列中原文没有的特典", "outOfScope"],
  ];
  for (const listed of listProfiles()) {
    const profile = resolveProfile(listed.id);
    for (const mode of ["bilingual", "trilingual"]) {
      const contract = proofreadPromptFor(mode, profile.id);
      const genericMode = contract.body.slice(0, contract.body.indexOf(profile.marker));
      let stablePrefix = null;
      for (const feature of ["none", "all", ...FEATURE_IDS]) {
        const features = new Set(feature === "all" ? FEATURE_IDS : feature === "none" ? [] : [feature]);
        const scope = { features, entities: new Set(), sourceText: "本文。", targetText: "正文。" };
        const parts = buildProofreadSystemPromptParts({
          mode, profileId: profile.id, rowFeatures: features, rowEntities: scope.entities,
          sourceText: scope.sourceText, targetText: scope.targetText,
        });
        stablePrefix ??= parts.cacheablePrefix;
        assert.equal(parts.cacheablePrefix, stablePrefix, `${profile.id}/${mode}/${feature} 常驻前缀改变`);
        assert.ok(parts.system.startsWith(stablePrefix));
        const selectedGeneric = genericMode.split("\n").filter((line) =>
          genericGates.every(([marker, gate]) => !line.startsWith(marker) || features.has(gate))).join("\n");
        const legacyRules = [selectedGeneric, profileSystemFor(profile, scope), noterefConstraint, JSON_ONLY_INSTRUCTION].join("\n");
        assert.deepEqual(ruleLines(parts.system), ruleLines(legacyRules), `${profile.id}/${mode}/${feature} 规则正文或入选集合改变`);
      }
      const dynamic = buildProofreadSystemPromptParts({
        mode, profileId: profile.id, rowFeatures: new Set(), sourceText: "本文。", targetText: "正文。",
        termBlock: "【术语（译名表命中）】\n本行术语甲。", speechHabitBlock: "【说话习惯（本章）】\n本行口吻乙。",
      });
      assert.equal(dynamic.cacheablePrefix, stablePrefix);
      assert.ok(dynamic.system.indexOf("本行术语甲") > stablePrefix.length);
      const named = buildProofreadSystemPromptParts({
        mode, profileId: profile.id, rowFeatures: new Set(),
        rowEntities: new Set(profileEntities(profile).map((entity) => entity.id)),
        sourceText: "本文。", targetText: "正文。",
      });
      assert.equal(named.cacheablePrefix, stablePrefix, "命中实体专属规范不能改变常驻前缀");
    }
  }
});

test("提示词缓存：新版与旧版页面默认提示词仍按行裁剪，自定义补充与动态段不重复", () => {
  for (const mode of ["bilingual", "trilingual"]) {
    const contract = proofreadPromptFor(mode, "novel");
    const legacy = [contract.body, noterefConstraint, JSON_ONLY_INSTRUCTION].join("\n");
    const args = { mode, profileId: "novel", rowFeatures: new Set(), sourceText: "本文。", targetText: "正文。" };
    const expected = buildProofreadSystemPrompt(args);
    for (const customSystem of [contract.system, legacy]) {
      assert.equal(buildProofreadSystemPrompt({ ...args, customSystem }), expected);
      const edited = buildProofreadSystemPrompt({ ...args, customSystem: `${customSystem}\n附加规则：保留本机定制。` });
      assert.ok(edited.includes("附加规则：保留本机定制。"));
      assert.equal(edited.split("硬性格式约束：").length - 1, 1);
      assert.equal(edited.split(JSON_ONLY_INSTRUCTION).length - 1, 1);
    }
  }
});

test("提示词缓存：初审消息标记稳定system边界，user固定schema先于逐行资料", () => {
  for (const text of ["他打开了窗户。", "然而，", "「打开窗户。」"]) {
    const row = { index: 12, jp: "彼は窓を開けた。", cn: text };
    const messages = buildMessages({ row, targetLabel: "译文 B", counterpartLabel: "原文 A", targetText: text, context: [] }, { proofreadMode: "bilingual", profileId: "novel" });
    const expected = buildProofreadSystemPromptParts({ mode: "bilingual", profileId: "novel", sourceText: row.jp, targetText: text, rowFeatures: detectRowFeatures({ source: row.jp, target: text }) });
    assert.equal(messages[0][CACHEABLE_PREFIX_LENGTH], expected.cacheablePrefix.length);
    assert.equal(messages[0].content, expected.system);
    assert.equal(messages[1][CACHEABLE_PREFIX_LENGTH], undefined);
    const user = JSON.parse(messages[1].content);
    assert.ok(Object.keys(user).indexOf("outputSchema") < Object.keys(user).indexOf("row"));
    assert.ok(Object.keys(user).indexOf("outputSchema") < Object.keys(user).indexOf("contextPolicy"));
    assert.equal(user.outputSchema.counterpartText, undefined);
    assert.equal(user.row.counterpartText, undefined);
  }
});

test("提示词缓存：复审/仲裁的固定规则和schema先于本行术语与行号", () => {
  for (const build of [buildStylistMessages, (row, decision, options) => buildArbiterMessages(row, decision, {}, options)]) {
    const make = (index, term) => build({ index, jp: "本文。", cn: "正文。" }, { needsEdit: true, revisedText: "修文。" }, {
      basePrompt: "【成品校对规范：测试】\n标点必须正确。", glossary: "【全局术语表】\n全书固定条目。",
      termBlock: `【译名表（本行命中）】\n${term}`,
    });
    const first = make(1, "术语甲");
    const second = make(2, "术语乙");
    const length = first[0][CACHEABLE_PREFIX_LENGTH];
    assert.ok(length > 0);
    assert.equal(second[0][CACHEABLE_PREFIX_LENGTH], length);
    assert.equal(first[0].content.slice(0, length), second[0].content.slice(0, length));
    assert.ok(first[0].content.indexOf("术语甲") > length);
    assert.match(first[0].content.slice(0, length), /标点必须正确/);
    assert.match(first[0].content.slice(0, length), /全书固定条目/);
    assert.ok(first[1].content.indexOf("请按如下 JSON 结构回复") < first[1].content.search(/请(?:审阅|裁决)第/));
    assert.equal(first[1][CACHEABLE_PREFIX_LENGTH], undefined);
    assert.equal(first[1].content.slice(0, first[1].content.search(/请(?:审阅|裁决)第/)), second[1].content.slice(0, second[1].content.search(/请(?:审阅|裁决)第/)));
  }
});

test("提示词缓存：新顺序不改变复审/仲裁从完整默认提示词提炼的规则集合", () => {
  for (const listed of listProfiles()) for (const mode of ["bilingual", "trilingual"]) {
    const contract = proofreadPromptFor(mode, listed.id);
    const legacy = [contract.body, noterefConstraint, JSON_ONLY_INSTRUCTION].join("\n");
    for (const persona of ["stylist", "arbiter"]) {
      assert.deepEqual(ruleLines(extractSpecializedRules(contract.system, persona)), ruleLines(extractSpecializedRules(legacy, persona)), `${listed.id}/${mode}/${persona} 提炼规则改变`);
    }
  }
});

test("提示词缓存：说话人完整system可复用，schema先于目标行且保留模式裁剪", () => {
  for (const parallelText of ["", "“你好。”"]) {
    const built = buildSpeakerPrompt({ index: 3, sourceText: "「こんにちは。」", parallelText });
    assert.equal(built.messages[0][CACHEABLE_PREFIX_LENGTH], built.system.length);
    const user = JSON.parse(built.user);
    assert.ok(Object.keys(user).indexOf("outputSchema") < Object.keys(user).indexOf("target"));
    if (!parallelText) {
      assert.equal(user.target.parallelText, undefined);
      assert.equal(user.alignment, undefined);
    }
  }
});
