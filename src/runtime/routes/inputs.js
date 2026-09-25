const { sendJson, readJson } = require("../http-json");
const { normalizePath } = require("../../ingest/input-selection");
const { filePayload, pickNativePath, validateLocalInputPath, scanDirectory, saveInputSelection } = require("../input-files");

function createInputRoutes({ speaker }) {
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
      sendJson(res, 200, { ok: true, file: filePayload(target) });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/pick-path") {
      const payload = await readJson(req);
      const mode = payload?.mode === "folder" ? "folder" : "file";
      const picked = await pickNativePath(mode);
      if (!picked) {
        sendJson(res, 200, { ok: true, canceled: true });
        return true;
      }
      const target = normalizePath(picked);
      validateLocalInputPath(target);
      sendJson(res, 200, { ok: true, file: filePayload(target) });
      return true;
    }

    return false;
  };
}

module.exports = { createInputRoutes };
