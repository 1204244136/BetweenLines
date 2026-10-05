const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-ai-persist-"));
const previousDataDir = process.env.TRANSCOMPARATOR_DATA_DIR;
process.env.TRANSCOMPARATOR_DATA_DIR = dataDir;

const { clearProofreadCache, clientStatus, startPrefilter } = require("./ai-proofread");
const {
  readResults,
  removeResults,
  resultsFile,
  writeResults,
} = require("../src/workbenches/translation-compare/ai/result-store");
const { createProjectContext } = require("./project-context");
const { createProjectStaging, projectArtifacts, publishProject } = require("./project-store");

test.after(() => {
  if (previousDataDir === undefined) delete process.env.TRANSCOMPARATOR_DATA_DIR;
  else process.env.TRANSCOMPARATOR_DATA_DIR = previousDataDir;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function publishFixture(name, rows) {
  const selection = {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, `${name}-source.txt`),
      cn: path.join(dataDir, `${name}-translation.txt`),
      tw: "",
    },
    labels: { jp: "原文 A", cn: "非原文 B", tw: "非原文 C" },
  };
  const project = createProjectContext(selection, rows);
  const staging = createProjectStaging(selection, { dataDir });
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project,
    rowsSignature: project.rowsSignature,
    rows,
  }), "utf8");
  for (const artifact of projectArtifacts) {
    const file = path.join(staging.dir, artifact);
    if (fs.existsSync(file)) continue;
    fs.writeFileSync(file, artifact.endsWith(".json") ? "{}" : "", "utf8");
  }
  publishProject(staging.dir, { dataDir });
  return project;
}

test("结果落盘层：按项目键 + 行集签名读写，身份对不上就拒绝交付", () => {
  const file = writeResults("proj-a", "sig-a", {
    runId: "run-1",
    kind: "proofread",
    total: 2,
    results: [{ index: 2, note: "b" }, { index: 1, note: "a" }],
  });
  assert.equal(file, resultsFile("proj-a", "sig-a"));
  const stored = readResults("proj-a", "sig-a");
  assert.equal(stored.results.length, 2);
  assert.deepEqual(stored.results.map((item) => item.index), [1, 2], "落盘按行号排序");
  assert.equal(readResults("proj-a", "sig-b"), null, "行集签名对不上不交付");
  assert.equal(readResults("proj-b", "sig-a"), null, "项目对不上不交付");
  assert.equal(removeResults("proj-a", "sig-a"), true);
  assert.equal(readResults("proj-a", "sig-a"), null);
});

test("控制台重启后，页面凭项目身份把落盘的成果重新认领回来", () => {
  // 模拟「控制台重启」：内存清空（但不能让这一步顺带删掉盘上的结果，所以先清再写盘）。
  clearProofreadCache();
  writeResults("proj-restart", "sig-restart", {
    runId: "run-restart",
    kind: "proofread",
    total: 3,
    finishedAt: "2026-10-05T05:00:00.000Z",
    results: [
      { index: 1, runId: "run-restart", status: "same", done: true, signature: "sig-1", note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否" },
      { index: 2, runId: "run-restart", status: "suggestion", done: true, signature: "sig-2", note: "[AI校对]\n语义是否相同：不同\n是否需要修改：是" },
      { index: 3, runId: "run-restart", status: "same", done: true, signature: "sig-3", note: "[AI校对]\n语义是否相同：相同\n是否需要修改：否" },
    ],
  });

  const page = clientStatus({ projectKey: "proj-restart", rowsSignature: "sig-restart", resultLimit: 2 });
  assert.equal(page.projectKey, "proj-restart");
  assert.equal(page.rowsSignature, "sig-restart");
  assert.equal(page.runId, "run-restart");
  assert.equal(page.results.length, 2, "按 resultLimit 分页交付");
  assert.deepEqual(page.results.map((item) => item.resultRevision), [1, 2], "重新编号，页面照常按修订游标增量拉取");
  assert.equal(page.hasMoreResults, true);

  const rest = clientStatus({
    projectKey: "proj-restart",
    rowsSignature: "sig-restart",
    runId: "run-restart",
    afterRevision: 2,
    resultLimit: 2,
  });
  assert.equal(rest.results.length, 1);
  assert.equal(rest.results[0].index, 3);
  assert.equal(rest.hasMoreResults, false);
});

test("页面不带项目身份、或身份对不上时，绝不把别的项目结果串过来", () => {
  clearProofreadCache();
  writeResults("proj-x", "sig-x", { runId: "r", results: [{ index: 1, note: "x" }] });
  assert.equal(clientStatus({}).results.length, 0, "没有身份就不交付");
  assert.equal(clientStatus({ projectKey: "proj-y", rowsSignature: "sig-x" }).results.length, 0, "项目对不上不交付");
});

test("新一轮只产出少量结果时，落盘与盘上已有结果合并，不覆盖上一轮成果", async () => {
  clearProofreadCache();
  const rows = Array.from({ length: 12 }, (_, offset) => ({
    index: offset + 1,
    jp: `同一段正文 ${offset + 1}`,
    cn: `同一段正文 ${offset + 1}`,
    tw: "",
    twCn: "",
    score: 1,
  }));
  const project = publishFixture("persist-merge", rows);
  // 盘上先放一份「上一轮」的结果：它们属于更早的运行，不该被这一轮抹掉。
  const previous = Array.from({ length: 5 }, (_, offset) => ({
    index: 900 + offset,
    runId: "run-previous",
    status: "suggestion",
    done: true,
    signature: `old-${offset}`,
    note: "[AI校对]\n语义是否相同：不同\n是否需要修改：是",
  }));
  writeResults(project.projectKey, project.rowsSignature, { runId: "run-previous", kind: "proofread", total: 5, results: previous });

  await startPrefilter({
    protocol: "compatible",
    baseUrl: "http://127.0.0.1:1",
    model: "unused",
    proofreadMode: "bilingual",
    projectKey: project.projectKey,
    rowsSignature: project.rowsSignature,
  });

  const stored = readResults(project.projectKey, project.rowsSignature);
  assert.equal(stored.results.length, previous.length + rows.length, "旧结果与新一轮结果都在盘上");
  assert.deepEqual(
    stored.results.filter((item) => item.index >= 900).map((item) => item.index),
    previous.map((item) => item.index),
    "上一轮的结论原样保留",
  );
  assert.equal(stored.results.filter((item) => item.index <= 12).length, rows.length, "本轮结果全部落盘");

  // 「清除 AI 运行记录」要连盘上的一份一起清掉，否则刷新页面又会把它装回来。
  clearProofreadCache();
  assert.equal(readResults(project.projectKey, project.rowsSignature), null);
});
