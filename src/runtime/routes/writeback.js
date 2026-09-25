const { sendJson, sendError, readJson } = require("../http-json");
const { getActiveProject, readProjectSelection } = require("../../storage/project-store");
const { applySpeakerAnnotations, applyTextReplacements } = require("../../ingest/writeback");
// 写回的行序清单（第 i 行对应下标 i-1）只做形状校验：它是定位线索而不是可信输入，
// 对不上就按 missed/ambiguous 上报，不参与任何文本决策。
function sanitizeRowTexts(value) {
  return Array.isArray(value) ? value.map((text) => String(text ?? "")) : [];
}


function createWritebackRoutes({ speaker, importedInputsDir }) {
  return async function handle(req, res, pathname, searchParams) {
    if (req.method === "POST" && pathname === "/api/translation-export") {
      const payload = await readJson(req);
      const project = getActiveProject();
      if (!payload.projectKey || !payload.rowsSignature
        || payload.projectKey !== project?.id || payload.rowsSignature !== project?.rowsSignature) {
        sendError(res, 409, new Error("写回请求与当前项目内容不一致，请切回对应项目并重新打开工作台；旧页面请先应用新布局。"));
        return true;
      }
      const selection = readProjectSelection(project.id, { snapshotId: project.snapshotId });
      if (!selection?.files) throw new Error("没有可写回的输入选择，请先生成工作台。");
      // 按写回目标列（targetKey）分组：cn 写回主文本，tw 写回参考文本，互不混写。
      const groups = new Map();
      // 行序清单按同一列分组，用于「未改动的行也按行序占住锚点」，见 applyTextReplacements。
      const rowTextsByKey = payload.rowTexts && typeof payload.rowTexts === "object" ? payload.rowTexts : {};
      for (const entry of (Array.isArray(payload.entries) ? payload.entries : [])) {
        const searchText = String(entry?.searchText || "");
        const replaceText = String(entry?.replaceText || "");
        if (!searchText || !replaceText || searchText === replaceText) continue;
        const key = entry?.targetKey === "tw" ? "tw" : "cn";
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push({ id: entry?.id, searchText, replaceText });
      }
      if (!groups.size) throw new Error("没有可写回的修改结果。");
      let updated = 0;
      const missed = [];
      const ambiguous = [];
      const targets = [];
      for (const [key, entries] of groups) {
        const target = selection.files[key];
        if (!target) throw new Error(`没有已选择的${key === "tw" ? "参考文本" : "主文本"}文件，无法写回。`);
        const result = await applyTextReplacements(target, entries, { rowTexts: sanitizeRowTexts(rowTextsByKey[key]) });
        updated += result.updated;
        missed.push(...result.missed);
        ambiguous.push(...(result.ambiguous || []));
        targets.push(target);
      }
      const importedCopy = targets.some((target) => target.startsWith(importedInputsDir));
      sendJson(res, 200, { ok: true, target: targets[0] || "", targets, updated, missed, ambiguous, importedCopy });
      return true;
    }
    if (req.method === "POST" && pathname === "/api/speaker-export") {
      const payload = await readJson(req);
      const selection = speaker.readSelection();
      if (!selection?.files?.source) throw new Error("没有已选择的原文件。");
      const target = selection.files.parallel || selection.files.source;
      const rows = Array.isArray(payload.rows) ? payload.rows : (payload.row ? [payload.row] : []);
      const entries = rows
        .map((row) => ({
          index: row?.index,
          speaker: String(row?.speaker || "").trim(),
          text: String(row?.parallel || row?.source || ""),
        }))
        .filter((entry) => entry.speaker && entry.text);
      if (!entries.length) throw new Error("没有可写回的说话人。");
      const result = await applySpeakerAnnotations(target, entries, { rowTexts: sanitizeRowTexts(payload.rowTexts) });
      // ambiguous 也要如实返回：没写回的行走客户端会当成已写回，把没标注的行从复核视野里抹掉。
      sendJson(res, 200, { ok: true, target, updated: result.updated, skipped: result.skipped, missed: result.missed, ambiguous: result.ambiguous });
      return true;
    }
    return false;
  };
}

module.exports = { createWritebackRoutes };
