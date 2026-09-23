const assert = require("node:assert/strict");
const test = require("node:test");

const { deriveContextUnits, deriveLineUnits } = require("./line-units");

test("派生行单元保留其父段落与源文本偏移量", () => {
  const units = deriveLineUnits([{
    sourceIndex: 4,
    lang: "jp",
    chapter: "第一章",
    text: "これは一文です。これは二文です。",
  }]);

  assert.deepEqual(units.map((unit) => unit.text), ["これは一文です。", "これは二文です。"]);
  assert.deepEqual(units.map((unit) => unit.parentParagraphId), ["jp:4", "jp:4"]);
  assert.equal(units[0].startOffset, 0);
  assert.equal(units[1].startOffset, units[0].endOffset);
});

test("引号对话包含多句时保持为一个完整单元", () => {
  const [unit] = deriveLineUnits([{
    sourceIndex: 2,
    lang: "jp",
    chapter: "第一章",
    text: "他停顿了一下。『这是第一句。这是第二句！』然后转身离开。",
  }], { quotedOnly: true });

  assert.equal(unit.text, "『这是第一句。这是第二句！』");
  assert.equal(unit.startOffset, "他停顿了一下。『这是第一句。这是第二句！』然后转身离开。".indexOf("『"));
  assert.equal(unit.endOffset, unit.startOffset + unit.text.length);
  assert.equal(unit.isQuotedDialogue, true);
});

test("纯发话模式忽略叙述并独立保留各段发言", () => {
  const units = deriveLineUnits([{
    sourceIndex: 3,
    lang: "cn",
    text: "旁白。『第三句！』又说：「第四句」",
  }], { quotedOnly: true });

  assert.deepEqual(units.map((unit) => unit.text), ["『第三句！』", "「第四句」"]);
});

test("正文中提及的引号词语保留在叙述中而不生成发话行", () => {
  const text = "如果能把不良少年的「集团」彻底甩开，追丢山田的那群不良少年可能会打手机找人增援，也可能会骑摩托过来。所以为了让他们「筋疲力尽」，山田必须拿自己当「诱饵」，吸引他们不断地跑。";
  const units = deriveLineUnits([{ sourceIndex: 9, lang: "cn", text }], { quotedOnly: true });
  assert.deepEqual(units, []);
});

test("同一段落中被叙述打断的对话保留前后两段发话", () => {
  const text = "「ううん、大丈夫だよ？」ユキは、息を吐きながら、「大丈夫に、决まってるよ」";
  const units = deriveLineUnits([{ sourceIndex: 12, lang: "jp", text }], { quotedOnly: true });
  assert.deepEqual(units.map((u) => u.text), [
    "「ううん、大丈夫だよ？」",
    "「大丈夫に、决まってるよ」",
  ]);
});

test("说话提示词后的对话保持为一个完整单元", () => {
  const units = deriveLineUnits([{ sourceIndex: 10, lang: "cn", text: "山田说：「快跑！再坚持一下。」" }], { quotedOnly: true });
  assert.deepEqual(units.map((unit) => unit.text), ["「快跑！再坚持一下。」"]);
});

test("句中引述仅在具备对话标点时才作为发话采纳", () => {
  const units = deriveLineUnits([{ sourceIndex: 11, lang: "cn", text: "山田转身，『快跑！』。" }], { quotedOnly: true });
  assert.deepEqual(units.map((unit) => unit.text), ["『快跑！』"]);
});

test("上下文单元保持发话完整的同时保留周围叙述", () => {
  const units = deriveContextUnits([{
    sourceIndex: 5,
    lang: "jp",
    text: "他停下脚步。『第一句。第二句！』随后离开。",
  }]);

  assert.deepEqual(units.map((unit) => unit.text), ["他停下脚步。", "『第一句。第二句！』", "随后离开。"]);
  assert.equal(units[1].isQuotedDialogue, true);
});
