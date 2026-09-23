const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  canUseSimilarityPrefilter,
  canonicalText,
  classifyPrefilter,
} = require("./ai-prefilter");
const { clearProofreadCache, clientStatus, startPrefilter } = require("./ai-proofread");
const { createProjectContext } = require("./project-context");
const {
  createProjectStaging,
  projectArtifacts,
  publishProject,
} = require("./project-store");

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

test("startPrefilter 在无模型或 Base URL 时对规则等价行直接完成预筛", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-prefilter-"));
  const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
  process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

  function publishRows(rows, selection) {
    const project = createProjectContext(selection, rows);
    const staging = createProjectStaging(selection, { dataDir });
    fs.writeFileSync(
      path.join(staging.dir, "translation-compare.json"),
      JSON.stringify({ project, rowsSignature: project.rowsSignature, rows }),
      "utf8",
    );
    for (const name of projectArtifacts) {
      const file = path.join(staging.dir, name);
      if (fs.existsSync(file)) continue;
      fs.writeFileSync(file, name.endsWith(".json") ? "{}" : "", "utf8");
    }
    publishProject(staging.dir, { dataDir });
    return project;
  }

  try {
    clearProofreadCache();
    const selection = {
      comparisonMode: "bilingual",
      inputMode: "txt",
      files: { jp: path.join(dataDir, "source.txt"), cn: path.join(dataDir, "translation.txt"), tw: "" },
      labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
    };
    const rows = Array.from({ length: 10 }, (_, offset) => {
      const text = "完全相同的规则预筛文本 " + (offset + 1);
      return { index: offset + 1, jp: text, cn: text, tw: "", twCn: "", score: 1 };
    });
    const project = publishRows(rows, selection);

    const started = await startPrefilter({
      similarityThreshold: 0.92,
      projectKey: project.projectKey,
      rowsSignature: project.rowsSignature,
    });
    assert.equal(started.kind, "prefilter");
    assert.equal(started.running, false);
    assert.equal(started.total, 10);
    assert.equal(started.rulePrefiltered, 10);
    assert.equal(started.prefiltered, 10);
    assert.equal(started.queued, 0);
    assert.equal(started.modelProcessed, 0);

    const full = clientStatus();
    assert.equal(full.kind, "prefilter");
    assert.equal(full.results.length, 10);
    const first = full.results[0];
    assert.match(first.note, /^\[规则预筛\]/);
    assert.equal(first.done, true);
  } finally {
    if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
    else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
