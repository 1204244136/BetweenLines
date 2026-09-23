const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { projectSignature } = require("./project-context");
const {
  activateProject,
  createProjectStaging,
  deleteProject,
  getActiveProject,
  listProjects,
  projectArtifacts,
  publishProject,
  rebuildProjectHtml,
  resolveProjectArtifact,
  writeJsonAtomic,
} = require("./project-store");

test("显式禁用 noteref 保持兼容旧版项目标识", () => {
  const base = selection("C:\\books", "legacy");
  const legacy = { ...base, inlineMarkup: { ruby: true, bold: true } };
  const disabled = { ...base, inlineMarkup: { ruby: true, bold: true, noteref: false } };
  const enabled = { ...base, inlineMarkup: { ruby: true, bold: true, noteref: true } };

  assert.equal(projectSignature(disabled), projectSignature(legacy));
  assert.notEqual(projectSignature(enabled), projectSignature(legacy));
});

function selection(dataDir, sourceName) {
  return {
    comparisonMode: "bilingual",
    inputMode: "txt",
    files: {
      jp: path.join(dataDir, `${sourceName}-source.txt`),
      cn: path.join(dataDir, `${sourceName}-translation.txt`),
      tw: "",
    },
    labels: { jp: "原文", cn: "译文", tw: "版本 C" },
  };
}

function prepareStaging(dataDir, sourceName, generatedAt) {
  const selected = selection(dataDir, sourceName);
  const staging = createProjectStaging(selected, { dataDir });
  const rowsSignature = `${sourceName}-rows`;
  fs.writeFileSync(path.join(staging.dir, "translation-compare.json"), JSON.stringify({
    project: {
      projectKey: staging.projectKey,
      generatedAt,
      rowsSignature,
      comparisonMode: "bilingual",
      notesStorage: {
        key: `translation-compare-notes-v7:${staging.projectKey}:${rowsSignature}`,
      },
    },
    rowsSignature,
    rows: [{ index: 1, jp: sourceName }],
  }), "utf8");
  for (const name of projectArtifacts) {
    const file = path.join(staging.dir, name);
    if (!fs.existsSync(file)) fs.writeFileSync(file, `${sourceName}:${name}`, "utf8");
  }
  return staging;
}

test("发布不可变快照并通过指针切换活动项目", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const first = publishProject(
      prepareStaging(dataDir, "first", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const second = publishProject(
      prepareStaging(dataDir, "second", "2026-07-21T10:00:00.000Z").dir,
      { dataDir },
    );

    assert.equal(getActiveProject({ dataDir }).id, second.id);
    assert.equal(fs.existsSync(path.join(dataDir, "translation-compare.html")), false);
    assert.equal(fs.existsSync(resolveProjectArtifact(first.id, "translation-compare.html", { dataDir })), true);
    assert.deepEqual(listProjects({ dataDir }).projects.map((project) => project.id), [second.id, first.id]);

    const activated = activateProject(first.id, { dataDir });
    assert.equal(activated.active, true);
    assert.equal(getActiveProject({ dataDir }).id, first.id);
    assert.equal(fs.existsSync(path.join(dataDir, "paragraphs.json")), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("发布失败时完整保留先前已发布的项目", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const published = publishProject(
      prepareStaging(dataDir, "stable", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const incomplete = createProjectStaging(selection(dataDir, "broken"), { dataDir });
    assert.throws(() => publishProject(incomplete.dir, { dataDir }), /待发布项目缺少文件/);
    assert.equal(getActiveProject({ dataDir }).id, published.id);
    assert.equal(fs.existsSync(incomplete.dir), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("重建页面布局时发布新的不可变快照", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const published = publishProject(
      prepareStaging(dataDir, "layout", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const oldHtmlFile = resolveProjectArtifact(published.id, "translation-compare.html", { dataDir });
    const oldHtml = fs.readFileSync(oldHtmlFile, "utf8");
    const oldSnapshotDir = path.dirname(oldHtmlFile);

    const rebuilt = rebuildProjectHtml(published.id, { dataDir });
    const active = getActiveProject({ dataDir });

    assert.notEqual(rebuilt.project.snapshotId, published.snapshotId);
    assert.equal(active.snapshotId, rebuilt.project.snapshotId);
    assert.equal(fs.readFileSync(oldHtmlFile, "utf8"), oldHtml);
    assert.equal(fs.existsSync(oldSnapshotDir), true);
    assert.notEqual(
      resolveProjectArtifact(published.id, "translation-compare.html", {
        dataDir,
        snapshotId: rebuilt.project.snapshotId,
      }),
      oldHtmlFile,
    );
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("原子 JSON 写入在替换失败时还原先前的文件", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  const file = path.join(dataDir, "active-project.json");
  const originalRename = fs.renameSync;
  try {
    writeJsonAtomic(file, { snapshotId: "old" });
    let renameCount = 0;
    fs.renameSync = (source, target) => {
      renameCount += 1;
      if (renameCount === 1 || renameCount === 3) {
        const error = new Error("simulated lock");
        error.code = "EPERM";
        throw error;
      }
      return originalRename(source, target);
    };

    assert.throws(
      () => writeJsonAtomic(file, { snapshotId: "new" }),
      /simulated lock/,
    );
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { snapshotId: "old" });
    assert.equal(fs.readdirSync(dataDir).filter((name) => /\.(tmp|bak)$/.test(name)).length, 0);
  } finally {
    fs.renameSync = originalRename;
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("活动项目指针可从最新的原子写备份中自动恢复", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const published = publishProject(
      prepareStaging(dataDir, "recover", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const pointerFile = path.join(dataDir, "active-project.json");
    const backupFile = `${pointerFile}.999-test.bak`;
    fs.copyFileSync(pointerFile, backupFile);
    fs.rmSync(pointerFile, { force: true });

    const recovered = getActiveProject({ dataDir });
    assert.equal(recovered.id, published.id);
    assert.equal(recovered.snapshotId, published.snapshotId);
    assert.equal(fs.existsSync(pointerFile), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("同一项目仅保留最新的两份快照", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const generated = ["20", "21", "22"].map((day) => publishProject(
      prepareStaging(dataDir, "same", `2026-07-${day}T10:00:00.000Z`).dir,
      { dataDir },
    ));
    const snapshotsDir = path.join(dataDir, "projects", generated[0].id, "snapshots");
    assert.equal(fs.readdirSync(snapshotsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length, 2);
    assert.equal(getActiveProject({ dataDir }).snapshotId, generated.at(-1).snapshotId);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("删除活动项目时回退至最新的剩余快照", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const first = publishProject(
      prepareStaging(dataDir, "first", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const second = publishProject(
      prepareStaging(dataDir, "second", "2026-07-21T10:00:00.000Z").dir,
      { dataDir },
    );

    activateProject(first.id, { dataDir });
    const result = deleteProject(first.id, { dataDir });
    assert.equal(result.wasActive, true);
    assert.equal(result.activeProject.id, second.id);
    assert.equal(getActiveProject({ dataDir }).id, second.id);
    assert.equal(fs.existsSync(path.join(dataDir, "projects", first.id)), false);
    assert.deepEqual(listProjects({ dataDir }).projects.map((project) => project.id), [second.id]);

    const last = deleteProject(second.id, { dataDir });
    assert.equal(last.activeProject, null);
    assert.equal(getActiveProject({ dataDir }), null);
    assert.equal(fs.existsSync(path.join(dataDir, "active-project.json")), false);
    assert.deepEqual(listProjects({ dataDir }).projects, []);
    assert.throws(() => deleteProject(second.id, { dataDir }), /项目不存在/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("删除非活动项目时保持当前活动指针不变", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    const first = publishProject(
      prepareStaging(dataDir, "first", "2026-07-20T10:00:00.000Z").dir,
      { dataDir },
    );
    const second = publishProject(
      prepareStaging(dataDir, "second", "2026-07-21T10:00:00.000Z").dir,
      { dataDir },
    );

    const result = deleteProject(first.id, { dataDir });
    assert.equal(result.wasActive, false);
    assert.equal(result.activeProject.id, second.id);
    assert.equal(getActiveProject({ dataDir }).id, second.id);
    assert.equal(fs.existsSync(path.join(dataDir, "projects", first.id)), false);
    assert.equal(fs.existsSync(path.join(dataDir, "projects", second.id)), true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test("拒绝能够逃逸出项目目录的项目标识", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "trans-comparator-projects-"));
  try {
    assert.throws(() => activateProject("../outside", { dataDir }), /项目标识无效/);
    assert.throws(() => deleteProject("../outside", { dataDir }), /项目标识无效/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
