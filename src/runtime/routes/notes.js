const { readJson, sendJson, sendError } = require("../http-json");
const { createNotesFileStore } = require("../../workbenches/translation-compare/notes-file-store");

function createNotesRoutes({ store = createNotesFileStore() } = {}) {
  return async function handle(req, res, pathname) {
    if (!pathname.startsWith("/api/notes/spaces")) return false;
    try {
      if (req.method === "GET" && pathname === "/api/notes/spaces") {
        sendJson(res, 200, { ok: true, ...store.list() });
        return true;
      }
      const mutations = { "/api/notes/spaces/write": store.write,
        "/api/notes/spaces/import": store.importSpace, "/api/notes/spaces/delete": store.remove,
        "/api/notes/spaces/recovery": store.markRecovery };
      if (req.method !== "POST" || !mutations[pathname]) return false;
      const space = mutations[pathname](await readJson(req));
      sendJson(res, 200, { ok: true, space });
    } catch (error) { sendError(res, error.statusCode || 400, error); }
    return true;
  };
}

module.exports = { createNotesRoutes };
