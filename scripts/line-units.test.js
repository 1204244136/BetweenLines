const assert = require("node:assert/strict");
const test = require("node:test");

const { deriveContextUnits, deriveLineUnits } = require("./line-units");

test("derived line units retain their parent paragraph and source offsets", () => {
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

test("quoted dialogue stays whole even when it contains multiple sentences", () => {
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

test("quoted dialogue mode omits narration and keeps separate utterances separate", () => {
  const units = deriveLineUnits([{
    sourceIndex: 3,
    lang: "cn",
    text: "旁白。『第三句！』又说：「第四句」",
  }], { quotedOnly: true });

  assert.deepEqual(units.map((unit) => unit.text), ["『第三句！』", "「第四句」"]);
});

test("inline quoted terms stay in narration instead of becoming speaker rows", () => {
  const text = "如果能把不良少年的「集团」彻底甩开，追丢山田的那群不良少年可能会打手机找人增援，也可能会骑摩托过来。所以为了让他们「筋疲力尽」，山田必须拿自己当「诱饵」，吸引他们不断地跑。";
  const units = deriveLineUnits([{ sourceIndex: 9, lang: "cn", text }], { quotedOnly: true });
  assert.deepEqual(units, []);
});

test("interrupted dialogue separated by narration in same paragraph retains both utterances", () => {
  const text = "「ううん、大丈夫だよ？」ユキは、息を吐きながら、「大丈夫に、決まってるよ」";
  const units = deriveLineUnits([{ sourceIndex: 12, lang: "jp", text }], { quotedOnly: true });
  assert.deepEqual(units.map((u) => u.text), [
    "「ううん、大丈夫だよ？」",
    "「大丈夫に、決まってるよ」",
  ]);
});

test("dialogue after a speech cue remains a complete unit", () => {
  const units = deriveLineUnits([{ sourceIndex: 10, lang: "cn", text: "山田说：「快跑！再坚持一下。」" }], { quotedOnly: true });
  assert.deepEqual(units.map((unit) => unit.text), ["「快跑！再坚持一下。」"]);
});

test("a mid-sentence quoted utterance is accepted only with dialogue punctuation", () => {
  const units = deriveLineUnits([{ sourceIndex: 11, lang: "cn", text: "山田转身，『快跑！』。" }], { quotedOnly: true });
  assert.deepEqual(units.map((unit) => unit.text), ["『快跑！』"]);
});

test("context units keep a complete utterance while retaining surrounding narration", () => {
  const units = deriveContextUnits([{
    sourceIndex: 5,
    lang: "jp",
    text: "他停下脚步。『第一句。第二句！』随后离开。",
  }]);

  assert.deepEqual(units.map((unit) => unit.text), ["他停下脚步。", "『第一句。第二句！』", "随后离开。"]);
  assert.equal(units[1].isQuotedDialogue, true);
});
