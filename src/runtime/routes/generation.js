const { sendJson } = require("../http-json");
const fs = require("fs");
const { selectionFile, validateSelection } = require("../../ingest/input-selection");
const { readJsonFile } = require("../../core/atomic-fs");
const { clearProofreadCache, clientStatus: aiProofreadStatus } = require("../../workbenches/translation-compare/ai/ai-proofread");

function createGenerationRoutes({ generation, speaker, consoleApiVersion, runningTaskLabel }) {
  return async function handle(req, res, pathname, searchParams) {
    if (req.method === "POST" && pathname === "/api/run") {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行。", pipeline: generation.status() });
        return true;
      }
      if (speaker.running) {
        sendJson(res, 409, { ok: false, error: "Speaker Attribution 工作台正在生成。", pipeline: generation.status() });
        return true;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再生成新的工作台。`, pipeline: generation.status(), ai: aiProofreadStatus() });
        return true;
      }
      if (!fs.existsSync(selectionFile)) {
        sendJson(res, 400, { ok: false, error: "请先导入所需文件。", pipeline: generation.status() });
        return true;
      }
      clearProofreadCache();
      const selection = validateSelection(readJsonFile(selectionFile));
      generation.run(selection);
      sendJson(res, 202, { ok: true, apiVersion: consoleApiVersion, pipeline: generation.status() });
      return true;
    }

    if (req.method === "POST" && pathname === "/api/speaker-run") {
      if (speaker.running) {
        sendJson(res, 409, { ok: false, error: "Speaker Attribution 工作台正在生成。", pipeline: speaker.status() });
        return true;
      }
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "翻译比较工作台正在生成。", pipeline: speaker.status() });
        return true;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再生成 Speaker Attribution 工作台。`, pipeline: speaker.status() });
        return true;
      }
      if (!fs.existsSync(speaker.selectionFile)) {
        sendJson(res, 400, { ok: false, error: "请先导入所需文件。", pipeline: speaker.status() });
        return true;
      }
      speaker.readSelection();
      speaker.run();
      sendJson(res, 202, { ok: true, apiVersion: consoleApiVersion, pipeline: speaker.status() });
      return true;
    }

    return false;
  };
}

module.exports = { createGenerationRoutes };
