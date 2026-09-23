const { getActiveProject, resolveProjectArtifact } = require("../project-store");
const { readJsonFile } = require("../../src/core/atomic-fs");

function loadActiveCompareData() {
  const active = getActiveProject();
  if (!active) throw new Error("没有活动项目：请先在控制台生成一次，或运行 npm run align:jp && npm run build。");
  const file = resolveProjectArtifact(active.id, "translation-compare.json", { snapshotId: active.snapshotId });
  const data = readJsonFile(file);
  return {
    project: data.project || {},
    file,
    rows: Array.isArray(data.rows) ? data.rows : [],
    data,
  };
}

module.exports = {
  loadActiveCompareData,
};
