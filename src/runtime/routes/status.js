const { sendJson } = require("../http-json");
const fs = require("fs");
const { selectionFile } = require("../../ingest/input-selection");
const { readJsonFile } = require("../../core/atomic-fs");
const { listProjects } = require("../../storage/project-store");
const { filePayload, savedFilePayloads } = require("../input-files");

function createStatusRoutes({ generation, speaker, consoleApiVersion }) {
  return async function handle(req, res, pathname, searchParams) {
    if (req.method === "GET" && pathname === "/api/status") {
      const saved = fs.existsSync(selectionFile)
        ? readJsonFile(selectionFile)
        : null;
      const savedSpeaker = speaker.readSelection();
      sendJson(res, 200, {
        ok: true,
        apiVersion: consoleApiVersion,
        nativePicker: process.platform === "win32",
        selectionFile,
        saved,
        savedFiles: savedFilePayloads(saved),
        pipeline: generation.status(),
        speakerSaved: savedSpeaker,
        speakerSavedFiles: savedSpeaker
          ? {
            jp: filePayload(savedSpeaker.files.source),
            cn: savedSpeaker.files.parallel ? filePayload(savedSpeaker.files.parallel) : null,
          }
          : {},
        speaker: speaker.status(),
        ...listProjects(),
      });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/speaker-status") {
      const saved = speaker.readSelection();
      sendJson(res, 200, {
        ok: true,
        apiVersion: consoleApiVersion,
        selectionFile: speaker.selectionFile,
        saved,
        savedFiles: saved
          ? {
            jp: filePayload(saved.files.source),
            cn: saved.files.parallel ? filePayload(saved.files.parallel) : null,
          }
          : {},
        pipeline: speaker.status(),
      });
      return true;
    }

    return false;
  };
}

module.exports = { createStatusRoutes };
