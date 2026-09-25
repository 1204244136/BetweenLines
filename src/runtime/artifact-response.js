const fs = require("fs");
const path = require("path");
const { getActiveProject, resolveProjectArtifact } = require("../storage/project-store");
const { sendError } = require("./http-json");

function createArtifactResponder({ publicDir, speakerOutputDir, injectSessionToken }) {
  function serveStatic(req, res, pathname) {
    const target = pathname === "/" ? path.join(publicDir, "setup.html") : path.join(publicDir, pathname);
    const resolved = path.resolve(target);
    if (resolved !== publicDir && !resolved.startsWith(`${publicDir}${path.sep}`)) {
      sendError(res, 403, new Error("Forbidden."));
      return;
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      sendError(res, 404, new Error("Not found."));
      return;
    }
    const ext = path.extname(resolved).toLowerCase();
    const type = ext === ".html" ? "text/html; charset=utf-8"
      : ext === ".css" ? "text/css; charset=utf-8"
        : ext === ".js" ? "text/javascript; charset=utf-8"
          : "application/octet-stream";
    res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    if (ext === ".html") {
      const html = injectSessionToken(fs.readFileSync(resolved, "utf8"));
      res.end(html);
      return;
    }
    fs.createReadStream(resolved).pipe(res);
  }

  function serveOutput(res, pathname) {
    try {
      if (pathname === "/output/speaker-attribution.html") {
        const speakerFile = path.join(speakerOutputDir, "speaker-attribution.html");
        if (!fs.existsSync(speakerFile)) throw new Error("Speaker Attribution 工作台尚未生成。");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        const html = injectSessionToken(fs.readFileSync(speakerFile, "utf8"));
        res.end(html);
        return;
      }
      const match = pathname.match(/^\/output\/([^/]+)\/translation-compare\.html$/);
      const activeProject = getActiveProject();
      const projectKey = match
        ? decodeURIComponent(match[1])
        : (pathname === "/output/translation-compare.html" ? activeProject?.id : "");
      if (!projectKey) throw new Error("工作台尚未生成。");
      const snapshotId = activeProject?.id === projectKey ? activeProject.snapshotId : "";
      const compareHtmlFile = resolveProjectArtifact(projectKey, "translation-compare.html", { snapshotId });
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      const html = injectSessionToken(fs.readFileSync(compareHtmlFile, "utf8"));
      res.end(html);
    } catch (error) {
      sendError(res, 404, error);
    }
  }

  return { serveStatic, serveOutput };
}

module.exports = { createArtifactResponder };
