const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const test = require("node:test");
const { computeScoreAndGrade, normalizeGrade, normalizeSeverity } = require("../src/workbenches/translation-compare/ai/decision-score");

test("渲染与纯计算模块可独立导入，不加载 AI 任务服务或构建入口", () => {
  const script = [
    'const assert = require("node:assert/strict");',
    'const path = require("node:path");',
    'require("./src/workbenches/translation-compare/render-workbench");',
    'require("./src/workbenches/translation-compare/row-output");',
    'require("./src/workbenches/translation-compare/notes-recovery");',
    'const loaded = Object.keys(require.cache).map(file => path.basename(file));',
    'for (const name of ["ai-proofread.js", "build-compare.js", "input-server.js"]) assert.equal(loaded.includes(name), false, name);',
  ].join("\n");
  execFileSync(process.execPath, ["-e", script], { cwd: path.resolve(__dirname, ".."), stdio: "pipe" });
});

test("评分保持无需修改、扣分推导、等级阈值及越界裁剪口径", () => {
  const score = (overrides) => computeScoreAndGrade({ needsEdit: true, rawScore: null, rawPenalty: null, rawGrade: "", rawSeverity: "", ...overrides });
  assert.deepEqual(score({ needsEdit: false, rawScore: 0 }), { score: 100, penalty: 0, grade: "excellent", severity: "none" });
  assert.deepEqual(score({ rawPenalty: 25 }), { score: 75, penalty: 25, grade: "good", severity: "minor" });
  assert.deepEqual(score({ rawScore: 59 }), { score: 59, penalty: 41, grade: "poor", severity: "critical" });
  assert.deepEqual(score({ rawScore: 60 }), { score: 60, penalty: 40, grade: "fair", severity: "major" });
  assert.equal(score({ rawScore: 90 }).grade, "excellent");
  assert.equal(score({ rawScore: 150 }).score, 100);
  assert.equal(score({ rawPenalty: 120 }).score, 0);
  assert.equal(score({ rawGrade: "较差" }).score, 55);
  assert.equal(score({}).score, 70);
  assert.equal(normalizeGrade("  GOOD "), "good");
  assert.equal(normalizeGrade("unknown"), "");
  assert.equal(normalizeSeverity("致命", false), "none");
});
