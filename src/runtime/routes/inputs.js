const { sendJson, readJson } = require("../http-json");
const path = require("path");
const { normalizePath, normalizeTableSelection } = require("../../ingest/input-selection");
const { filePayload, pickDirForRole, pickNativePath, rememberPickedDir, validateLocalInputPath, scanDirectory, saveInputSelection } = require("../input-files");

// pickPath 可注入：系统选择窗口只能在 Windows 本机弹出，路由测试用假实现替掉它。
function createInputRoutes({ speaker, pickPath = pickNativePath }) {
  return async function handle(req, res, pathname, searchParams) {
    if (req.method === "GET" && pathname === "/api/scan") {
      sendJson(res, 200, { ok: true, ...scanDirectory(searchParams.get("dir"), searchParams.get("mode")) });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/selection") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...saveInputSelection(payload) });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/speaker-selection") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...speaker.saveSelection(payload) });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/validate-input") {
      const payload = await readJson(req);
      const target = normalizePath(payload?.path || "");
      validateLocalInputPath(target);
      // 粘贴路径登记的入口与系统窗口登记共用同一份默认目录记忆。
      rememberPickedDir(payload?.role, target);
      sendJson(res, 200, { ok: true, file: filePayload(target) });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/pick-path") {
      const payload = await readJson(req);
      const mode = payload?.mode === "folder" ? "folder" : "file";
      const role = payload?.role;
      const currentPath = typeof payload?.currentPath === "string" ? payload.currentPath : "";
      // 起始目录按导入入口各自推导：原文 / 主文本 / 参考文本互不干扰。
      const initialDir = pickDirForRole(role, currentPath);
      const picked = await pickPath(mode, { role, initialDir });
      if (!picked) {
        sendJson(res, 200, { ok: true, canceled: true });
        return true;
      }
      const target = normalizePath(picked);
      validateLocalInputPath(target);
      rememberPickedDir(role, target);
      sendJson(res, 200, { ok: true, file: filePayload(target) });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/pick-table") {
      const payload = await readJson(req);
      const currentPath = typeof payload.currentPath === "string" ? normalizePath(payload.currentPath) : "";
      const picked = await pickPath("file", { tables: true, initialDir: currentPath ? path.dirname(currentPath) : "" });
      if (!picked) {
        sendJson(res, 200, { ok: true, canceled: true });
        return true;
      }
      const [target] = normalizeTableSelection([picked]);
      sendJson(res, 200, { ok: true, file: filePayload(target) });
      return true;
    }

    return false;
  };
}

module.exports = { createInputRoutes };
