const { sendJson, readJson } = require("../http-json");
const { clearProofreadCache, clearProofreadResults, clientStatus: aiProofreadStatus, listModels, startPrefilter, startProofread, stopProofread, testModel, updateStagePresets } = require("../../workbenches/translation-compare/ai/ai-proofread");
const { inferSpeakerRow } = require("../../workbenches/speaker-attribution/ai/speaker-inference");
const { listProviderModels, testModelConnectivity } = require("../../ai/llm-client");

async function handleAiRoutes(req, res, pathname, searchParams) {
  if (req.method === "GET" && pathname === "/api/ai-proofread/status") {
    sendJson(res, 200, {
      ok: true,
      ai: aiProofreadStatus({
        runId: searchParams.get("runId") || "",
        afterRevision: searchParams.get("afterRevision") || 0,
        resultLimit: searchParams.get("resultLimit") || 0,
        profileId: searchParams.get("profileId") || "",
        // 页面自报项目身份：内存里没有结果时（刷新页面、控制台重启）据此把落盘的结果装回来。
        projectKey: searchParams.get("projectKey") || "",
        rowsSignature: searchParams.get("rowsSignature") || "",
        includeLogs: searchParams.get("compact") !== "1",
      }),
    });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ai-proofread/models") {
    const payload = await readJson(req);
    sendJson(res, 200, { ok: true, models: await listModels(payload) });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ai-proofread/test") {
    try {
      const payload = await readJson(req);
      const result = await testModel(payload);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ai-proofread/start") {
    const payload = await readJson(req);
    try {
      sendJson(res, 202, { ok: true, ai: await startProofread(payload) });
    } catch (error) {
      sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ai-proofread/stop") {
    // 旧页面的预筛停止仍发送空 POST；带阶段参数的新请求才读取 JSON。
    const hasBody = Number(req.headers["content-length"]) > 0 || Boolean(req.headers["transfer-encoding"]);
    const payload = hasBody ? await readJson(req) : {};
    try {
      sendJson(res, 200, { ok: true, ai: stopProofread(payload) });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
    }
    return true;
  }

  // 运行中增删阶段预设：新预设立刻参与派发，被删预设的待审行立刻改派。
  // 任务没在跑时不接受（409）：那种改动本来就会随下次启动的请求体生效。
  if (req.method === "POST" && pathname === "/api/ai-proofread/presets") {
    try {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...updateStagePresets(payload) });
    } catch (error) {
      sendJson(res, error.code === "NOT_RUNNING" ? 409 : 400, { ok: false, error: error.message || String(error) });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ai-proofread/cache/clear") {
    try {
      sendJson(res, 200, { ok: true, ai: clearProofreadCache() });
    } catch (error) {
      sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/ai-proofread/results/clear") {
    try {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...clearProofreadResults(payload) });
    } catch (error) {
      sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message || String(error) });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/prefilter/start") {
    const payload = await readJson(req);
    try {
      sendJson(res, 202, { ok: true, ai: await startPrefilter(payload) });
    } catch (error) {
      sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/prefilter/stop") {
    sendJson(res, 200, { ok: true, ai: stopProofread() });
    return true;
  }

  if (req.method === "POST" && pathname === "/api/speaker-ai/models") {
    try {
      const payload = await readJson(req);
      const models = await listProviderModels(payload);
      sendJson(res, 200, { ok: true, models });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/speaker-ai/test") {
    try {
      const payload = await readJson(req);
      const result = await testModelConnectivity(payload);
      sendJson(res, 200, result);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message || String(error) });
    }
    return true;
  }

  if (req.method === "POST" && pathname === "/api/speaker-ai/infer") {
    try {
      const payload = await readJson(req);
      const prediction = await inferSpeakerRow(payload.row, payload.config || {});
      sendJson(res, 200, { ok: true, prediction });
    } catch (error) {
      sendJson(res, 500, { ok: false, error: error.message || String(error) });
    }
    return true;
  }

  return false;
}

module.exports = { handleAiRoutes };
