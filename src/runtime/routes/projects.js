const { sendJson } = require("../http-json");
const { saveSelection } = require("../../ingest/input-selection");
const { activateProject, deleteProject, listProjects, readProjectSelection } = require("../../storage/project-store");
const { clearProofreadCache, clientStatus: aiProofreadStatus } = require("../../workbenches/translation-compare/ai/ai-proofread");
const { savedFilePayloads } = require("../input-files");

function createProjectRoutes({ generation, consoleApiVersion, runningTaskLabel }) {
  return async function handle(req, res, pathname, searchParams) {
    if (req.method === "GET" && pathname === "/api/projects") {
      sendJson(res, 200, { ok: true, apiVersion: consoleApiVersion, ...listProjects() });
      return true;
    }

    if (req.method === "POST" && /^\/api\/projects\/[^/]+\/activate$/.test(pathname)) {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行，暂时不能切换项目。" });
        return true;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再切换项目。` });
        return true;
      }
      clearProofreadCache();
      const projectKey = decodeURIComponent(pathname.split("/")[3]);
      const project = activateProject(projectKey);
      const saved = readProjectSelection(projectKey, { snapshotId: project.snapshotId });
      saveSelection(saved);
      generation.markProjectReady(project);
      sendJson(res, 200, {
        ok: true,
        apiVersion: consoleApiVersion,
        project,
        saved,
        savedFiles: savedFilePayloads(saved),
        pipeline: generation.status(),
        ...listProjects({ adoptCurrent: false }),
      });
      return true;
    }

    if (req.method === "DELETE" && /^\/api\/projects\/[^/]+$/.test(pathname)) {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行，暂时不能删除项目。" });
        return true;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再删除项目。` });
        return true;
      }
      const projectKey = decodeURIComponent(pathname.split("/")[3]);
      try {
        const { wasActive, activeProject } = deleteProject(projectKey);
        if (wasActive) clearProofreadCache();
        const payload = {
          ok: true,
          apiVersion: consoleApiVersion,
          project: activeProject,
          deletedProjectKey: projectKey,
          deletedWasActive: wasActive,
          pipeline: generation.status(),
          ...listProjects({ adoptCurrent: false }),
        };
        if (wasActive && activeProject) {
          // 快照目录已经删除成功；自动切到后备项目时若源文件缺失，只降级为提示，不让删除整体失败。
          try {
            const saved = readProjectSelection(activeProject.id, { snapshotId: activeProject.snapshotId });
            saveSelection(saved);
            generation.markProjectReady(activeProject);
            payload.saved = saved;
            payload.savedFiles = savedFilePayloads(saved);
            payload.pipeline = generation.status();
          } catch (error) {
            payload.warning = `项目已删除，但自动切换失败：${error.message || error}`;
          }
        }
        sendJson(res, 200, payload);
      } catch (error) {
        const message = error.message || "删除项目失败。";
        sendJson(res, /无效|不存在/.test(message) ? 400 : 500, { ok: false, error: message });
      }
      return true;
    }

    if (req.method === "POST" && /^\/api\/projects\/[^/]+\/rebuild-html$/.test(pathname)) {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行，暂时不能更新页面布局。" });
        return true;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再更新页面布局。` });
        return true;
      }
      const projectKey = decodeURIComponent(pathname.split("/")[3]);
      try {
        const { rebuildProjectHtml } = require("../../storage/project-store");
        const rebuilt = rebuildProjectHtml(projectKey);
        const notesSpace = rebuilt.notesKey.replace(/^translation-compare-notes-/, "");
        sendJson(res, 200, {
          ok: true,
          apiVersion: consoleApiVersion,
          project: rebuilt.project,
          message: notesSpace
            ? `页面布局已更新，已热加载最新样式与代码（未重新进行文件比对）。本页读取的备注空间：${notesSpace}。请在工作台页面按 F5 刷新查看。`
            : "页面布局已更新，已热加载最新样式与代码（未重新进行文件比对）。请在工作台页面按 F5 刷新查看。",
          ...listProjects({ adoptCurrent: false }),
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || "更新页面布局失败。" });
      }
      return true;
    }

    return false;
  };
}

module.exports = { createProjectRoutes };
