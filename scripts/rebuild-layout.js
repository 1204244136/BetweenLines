const {
  getActiveProject,
  listProjects,
  rebuildProjectHtml,
} = require("../src/storage/project-store");

function resolveTargetProjectKey(argv = process.argv.slice(2), options = {}) {
  for (const arg of argv) {
    if (arg.startsWith("--project=")) {
      const value = arg.slice("--project=".length).trim();
      if (value) return value;
    } else if (!arg.startsWith("-") && arg.trim()) {
      return arg.trim();
    }
  }

  const active = getActiveProject(options);
  if (active?.id) return active.id;

  const { projects } = listProjects(options);
  if (projects && projects.length > 0) {
    return projects[0].id;
  }

  return "";
}

function main(argv = process.argv.slice(2), options = {}) {
  const targetKey = resolveTargetProjectKey(argv, options);
  if (!targetKey) {
    const message = "[layout] 未找到可重建布局的项目。请先生成工作台，或显式指定项目：npm run layout -- --project=<projectKey>";
    if (options.throwOnMissing) throw new Error(message);
    console.error(message);
    process.exit(1);
  }

  console.log(`[layout] 正在为项目重建工作台页面布局：${targetKey}...`);
  const result = rebuildProjectHtml(targetKey, options);
  const notesSpace = (result.notesKey || "").replace(/^translation-compare-notes-/, "");

  console.log(`[layout] 成功应用新布局！`);
  console.log(`  项目: ${result.project.name} (${result.project.id})`);
  console.log(`  快照: ${result.project.snapshotId}`);
  console.log(`  行数: ${result.project.rowCount}`);
  if (notesSpace) {
    console.log(`  备注空间: ${notesSpace}`);
  }
  console.log(`[layout] 已更新当前活动快照指针。请在浏览器中按 F5 刷新工作台页面查看最新布局。`);
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[layout] 重建布局失败: ${error.message || error}`);
    process.exit(1);
  }
}

module.exports = { main, resolveTargetProjectKey };
