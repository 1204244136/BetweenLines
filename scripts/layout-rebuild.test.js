const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  publishProject,
  rebuildProjectHtml,
  getActiveProject,
  invalidateWorkbenchModuleCache,
  projectArtifacts,
} = require("../src/storage/project-store");
const { readWorkbenchAssets } = require("../src/workbenches/translation-compare/build-compare");
const { resolveTargetProjectKey } = require("./rebuild-layout");

function prepareStaging(dataDir, label = "layout-test") {
  const stagingDir = path.join(dataDir, "staging", `${label}-${Date.now()}`);
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(
    path.join(stagingDir, "input-selection.json"),
    JSON.stringify({
      comparisonMode: "bilingual",
      files: { source: "source.txt", cn: "cn.txt" },
      labels: { source: "原文", cn: "译文" },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(
    path.join(stagingDir, "translation-compare.json"),
    JSON.stringify({
      files: { source: "source.txt", cn: "cn.txt" },
      labels: { source: "原文", cn: "译文" },
      project: {
        projectKey: label,
        rowsSignature: `sig-${label}`,
        comparisonMode: "bilingual",
        generatedAt: new Date().toISOString(),
        notesStorage: {
          key: `translation-compare-notes-v7:${label}:sig-${label}`,
        },
      },
      rows: [
        {
          index: 0,
          chapter: "1",
          relation: "1:1",
          score: 0.95,
          jpAlignScore: 0.95,
          jp: "テスト",
          cn: "测试",
        },
      ],
    }, null, 2),
    "utf8",
  );
  for (const name of projectArtifacts) {
    const file = path.join(stagingDir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${label}:${name}`, "utf8");
  }
  return { dir: stagingDir };
}

test("invalidateWorkbenchModuleCache clears require.cache for workbenches and core", () => {
  const buildComparePath = require.resolve("../src/workbenches/translation-compare/build-compare");
  require(buildComparePath);
  assert.equal(Boolean(require.cache[buildComparePath]), true);

  invalidateWorkbenchModuleCache();
  assert.equal(require.cache[buildComparePath], undefined);
});

test("readWorkbenchAssets dynamically returns current public assets", () => {
  const assets = readWorkbenchAssets();
  assert.equal(typeof assets.workbenchStyle, "string");
  assert.equal(typeof assets.aiPanelStyle, "string");
  assert.equal(typeof assets.workbenchClient, "string");
  assert.equal(assets.workbenchStyle.includes(".app-shell"), true);
  assert.equal(assets.workbenchClient.includes("bindPanelGroups"), true);
});

test("rebuildProjectHtml in same process generates updated html without restarting server", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-layout-test-"));
  const cssFile = path.join(__dirname, "..", "public", "workbench-style.css");
  const originalCss = fs.readFileSync(cssFile, "utf8");
  const canaryToken = `/* canary-layout-test-${Date.now()} */`;

  try {
    const staging = prepareStaging(dataDir, "rebuild-canary");
    const published = publishProject(staging.dir, { dataDir });

    const initialHtmlFile = path.join(dataDir, "projects", published.id, "snapshots", published.snapshotId, "translation-compare.html");
    const initialHtml = fs.readFileSync(initialHtmlFile, "utf8");
    assert.equal(initialHtml.includes(canaryToken), false);

    // 模拟开发者在服务未重启的情况下，向 public/workbench-style.css 写入新样式
    fs.writeFileSync(cssFile, `${originalCss}\n${canaryToken}\n`, "utf8");

    // 调用 rebuildProjectHtml（同控制台点击「应用新布局」）
    const rebuilt = rebuildProjectHtml(published.id, { dataDir });
    const rebuiltHtmlFile = path.join(dataDir, "projects", published.id, "snapshots", rebuilt.project.snapshotId, "translation-compare.html");
    const rebuiltHtml = fs.readFileSync(rebuiltHtmlFile, "utf8");

    // 验证新快照中的 HTML 立即内嵌了最新修改，无需重启服务进程！
    assert.equal(rebuiltHtml.includes(canaryToken), true);
  } finally {
    fs.writeFileSync(cssFile, originalCss, "utf8");
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rebuild-layout CLI resolves target project key accurately", () => {
  assert.equal(resolveTargetProjectKey(["--project=custom-key"]), "custom-key");
  assert.equal(resolveTargetProjectKey(["positional-key"]), "positional-key");
});

test("rebuild-layout CLI main() rebuilds layout and updates active snapshot", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-cli-test-"));
  const { main } = require("./rebuild-layout");
  try {
    const staging = prepareStaging(dataDir, "cli-project");
    const published = publishProject(staging.dir, { dataDir });

    const result = main(["--project=" + published.id], { dataDir });
    assert.equal(result.project.id, published.id);
    assert.notEqual(result.project.snapshotId, published.snapshotId);
    assert.equal(getActiveProject({ dataDir }).snapshotId, result.project.snapshotId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("rebuild-layout CLI main() throws when no project is found", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-cli-empty-"));
  const { main } = require("./rebuild-layout");
  try {
    assert.throws(
      () => main([], { dataDir, throwOnMissing: true }),
      /未找到可重建布局的项目/,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
