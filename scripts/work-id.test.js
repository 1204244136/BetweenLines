const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { workIdFromPath, workIdPattern } = require("../src/core/work-id");
const { volumeKeyFromFiles } = require("../src/workbenches/translation-compare/ai/speech-habit");
const { resolveJapaneseSourceDir } = require("../src/workbenches/translation-compare/verify-source");

test("新旧定界符识别完整作品号，拒绝前缀与残缺日期", () => {
  for (const code of ["S1_01", "S2_22r", "S5_01_03", "S6_24.06.07"]) {
    for (const name of [`【${code}】作品`, `[${code}]作品`]) {
      assert.equal(workIdFromPath(name), code.toUpperCase());
      assert.equal(workIdPattern(code).test(name), true);
    }
  }
  assert.equal(workIdPattern("S5_01").test("【S5_01_03】作品"), false);
  assert.equal(workIdFromPath("【S6_24.06】作品"), "");
  assert.equal(volumeKeyFromFiles({ cn: "【S3_01】作品" }).code, "S3_01");
});

test("日文源查找支持全角目录并不误选相邻作品", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-id-"));
  try {
    const base = path.join(root, ".cache", "epub-work", "japanese-text");
    fs.mkdirSync(path.join(base, "【S3_01】作品"), { recursive: true });
    fs.mkdirSync(path.join(base, "【S3_010】其他"));
    assert.equal(resolveJapaneseSourceDir({ indexXDir: root, volumeCode: "S3_01" }).name, "【S3_01】作品");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
