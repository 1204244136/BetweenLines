const fs = require("fs");
const crypto = require("crypto");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { execFile } = require("child_process");
const { directoryEntries } = require("../ingest/epub-container");
const {
  guessLangOrder,
  inferInputMode,
  normalizeComparisonMode,
  normalizePath,
  saveSelection,
  selectionFile,
  defaultDisplayLabels,
  defaultInlineMarkup,
  isSupportedInput,
  supportedFilesInDirectory,
  validateSelection,
} = require("../ingest/input-selection");
const {
  clearProofreadCache,
  clientStatus: aiProofreadStatus,
  listModels,
  startPrefilter,
  startProofread,
  stopProofread,
} = require("../workbenches/translation-compare/ai/ai-proofread");
const {
  activateProject,
  deleteProject,
  getActiveProject,
  listProjects,
  readProjectSelection,
  resolveProjectArtifact,
} = require("../storage/project-store");
const { GenerationPipeline } = require("./generation-pipeline");
const { storageLayout } = require("../core/storage-layout");
const {
  applySpeakerAnnotations,
  applyTextReplacements,
} = require("../ingest/writeback");
const { validateSpeakerSelection } = require("../workbenches/speaker-attribution/speaker-selection");
const {
  buildSpeakerWorkbench,
  writeSpeakerModel,
} = require("../workbenches/speaker-attribution/build-workbench");
const {
  inferSpeakerRow,
} = require("../workbenches/speaker-attribution/ai/speaker-inference");
const {
  listProviderModels,
} = require("../ai/llm-client");

const rootDir = path.join(__dirname, "..", "..");
const publicDir = path.join(rootDir, "public");
const dataLayout = storageLayout();
const defaultPort = Number(process.env.TRANSCOMPARATOR_SETUP_PORT || 4317);
const host = "127.0.0.1";
const importedInputsDir = dataLayout.importedInputsDir;
const consoleApiVersion = 5;
const generation = new GenerationPipeline();
const speakerRuntimeDir = path.join(dataLayout.runtimeDir, "speaker-attribution");
const speakerSelectionFile = path.join(speakerRuntimeDir, "input-selection.json");
const speakerOutputDir = speakerRuntimeDir;
const speakerPipeline = {
  running: false,
  step: "idle",
  progress: { current: 0, total: 1, percent: 0, step: "idle" },
  code: null,
  error: "",
  startedAt: null,
  finishedAt: null,
  logs: [],
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendError(res, status, error) {
  sendJson(res, status, { ok: false, error: error.message || String(error) });
}

function runningTaskLabel() {
  return aiProofreadStatus().kind === "prefilter" ? "预筛选" : "AI 校对";
}

function readJson(req, maxBytes = 128 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(new Error("Request body is not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function filePayload(file) {
  const stat = fs.statSync(file);
  const resolved = path.resolve(file);
  const isImportedCopy = resolved.startsWith(`${path.resolve(importedInputsDir)}${path.sep}`);
  const source = isImportedCopy ? "copy" : "local";
  if (stat.isDirectory()) {
    const entries = directoryEntries(file);
    return { path: file, name: path.basename(file), ext: "epub", kind: "directory", source,
      size: entries.reduce((total, entry) => total + entry.size, 0), fileCount: entries.length };
  }
  return {
    path: file,
    name: path.basename(file),
    ext: path.extname(file).slice(1).toLowerCase(),
    size: stat.size,
    source,
  };
}

// 文件和文件夹都使用 Windows Common Item Dialog，只切换选择模式。
// 两种模式因此共享同一套导航界面和最近访问位置，并返回可直接写回的真实路径。
function pickNativePath(mode) {
  const pickerScript = path.join(rootDir, "scripts", "windows-path-picker.ps1");
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoProfile",
      "-STA",
      "-File", pickerScript,
      "-Mode", mode === "folder" ? "folder" : "file",
    ], {
      encoding: "utf8",
      timeout: 10 * 60 * 1000,
      windowsHide: true,
    }, (error, stdout) => {
      if (error && error.killed) {
        reject(new Error("选择窗口超时未响应，请重试。"));
        return;
      }
      if (error) {
        reject(new Error("无法打开系统选择窗口（仅支持 Windows 本机环境）。"));
        return;
      }
      resolve(String(stdout || "").trim());
    });
  });
}

function validateLocalInputPath(target) {
  if (!target) throw new Error("请输入文件或解压 EPUB 目录的本地路径。");
  if (!fs.existsSync(target)) throw new Error(`路径不存在：${target}`);
  if (!isSupportedInput(target)) {
    throw new Error("不支持的文件类型。请选择 TXT、EPUB、DOCX、HTML、ODT、Markdown、RTF 文件或解压的 EPUB 目录。");
  }
}

function savedFilePayloads(saved) {
  if (!saved?.files) return {};
  return Object.fromEntries(
    ["jp", "cn", "tw"]
      .map((role) => [role, saved.files[role]])
      .filter(([, file]) => file && fs.existsSync(file))
      .map(([role, file]) => [role, filePayload(file)]),
  );
}

function scanDirectory(dir, comparisonMode = "trilingual") {
  const inputDir = normalizePath(dir);
  const mode = normalizeComparisonMode(comparisonMode);
  if (!inputDir) throw new Error("请输入源文件目录。");
  if (!fs.existsSync(inputDir) || !fs.statSync(inputDir).isDirectory()) {
    throw new Error(`目录不存在：${inputDir}`);
  }

  const files = supportedFilesInDirectory(inputDir);
  const minimumFiles = mode === "bilingual" ? 2 : 3;
  if (files.length < minimumFiles) {
    throw new Error(`至少需要 ${minimumFiles} 个支持的源文件；当前找到 ${files.length} 个。`);
  }

  const guessed = guessLangOrder(files, mode);
  return {
    comparisonMode: mode,
    inputDir,
    files: files.map(filePayload),
    guessed,
    inputMode: inferInputMode(guessed),
  };
}

function saveInputSelection(payload) {
  const files = {
    jp: normalizePath(payload.files?.jp),
    cn: normalizePath(payload.files?.cn),
    tw: normalizePath(payload.files?.tw),
  };
  const startMarkers = Object.fromEntries(
    Object.entries(payload.startMarkers || {})
      .map(([lang, value]) => [lang, String(value || "").trim()])
      .filter(([, value]) => value),
  );
  const selection = validateSelection({
    files,
    comparisonMode: payload.comparisonMode,
    inputMode: payload.inputMode || inferInputMode(files),
    labels: payload.labels || defaultDisplayLabels,
    startMarkers,
    inlineMarkup: {
      ...defaultInlineMarkup,
      ...(payload.inlineMarkup || {}),
    },
  });
  saveSelection(selection);
  return { selection, selectionFile };
}

function saveSpeakerInputSelection(payload) {
  const files = {
    source: normalizePath(payload.files?.source || payload.files?.jp),
    parallel: normalizePath(payload.files?.parallel || payload.files?.cn),
  };
  const selection = validateSpeakerSelection({
    source: files.source,
    parallel: files.parallel,
  });
  fs.mkdirSync(speakerRuntimeDir, { recursive: true });
  fs.writeFileSync(speakerSelectionFile, JSON.stringify(selection, null, 2), "utf8");
  return { selection, selectionFile: speakerSelectionFile };
}

function readSpeakerSelection() {
  if (!fs.existsSync(speakerSelectionFile)) return null;
  const stored = JSON.parse(fs.readFileSync(speakerSelectionFile, "utf8"));
  return validateSpeakerSelection({
    source: stored.files?.source || stored.source,
    parallel: stored.files?.parallel || stored.parallel,
  });
}

function pushSpeakerLog(message) {
  if (message) speakerPipeline.logs.push(String(message));
  if (speakerPipeline.logs.length > 100) speakerPipeline.logs.splice(0, speakerPipeline.logs.length - 100);
}

function speakerStatus() {
  const outputFile = path.join(speakerOutputDir, "speaker-attribution.html");
  return {
    ...speakerPipeline,
    outputExists: fs.existsSync(outputFile),
    outputUrl: fs.existsSync(outputFile) ? "/output/speaker-attribution.html" : "",
  };
}

function runSpeakerPipeline() {
  if (speakerPipeline.running) return;
  speakerPipeline.running = true;
  speakerPipeline.step = "building";
  speakerPipeline.progress = { current: 0, total: 1, percent: 10, step: "building", detail: "读取输入并准备工作台" };
  speakerPipeline.code = null;
  speakerPipeline.error = "";
  speakerPipeline.startedAt = new Date().toISOString();
  speakerPipeline.finishedAt = null;
  speakerPipeline.logs = [];

  Promise.resolve().then(async () => {
    const selection = readSpeakerSelection();
    if (!selection) throw new Error("请先导入所需文件。");
    pushSpeakerLog(`Mode: ${selection.mode}`);
    const model = await buildSpeakerWorkbench(selection);
    speakerPipeline.progress = { current: 1, total: 1, percent: 95, step: "writing", detail: "写入工作台" };
    writeSpeakerModel(model, speakerOutputDir);
    if (selection.mode === "bilingual") pushSpeakerLog(`Pre-alignment: ${model.alignment.version}`);
    pushSpeakerLog(`Done. Rows: ${model.rows.length}`);
    speakerPipeline.step = "done";
    speakerPipeline.progress = { current: 1, total: 1, percent: 100, step: "done" };
    speakerPipeline.code = 0;
  }).catch((error) => {
    speakerPipeline.step = "failed";
    speakerPipeline.progress = { ...speakerPipeline.progress, step: "failed" };
    speakerPipeline.code = 1;
    speakerPipeline.error = error.message || String(error);
    pushSpeakerLog(speakerPipeline.error);
  }).finally(() => {
    speakerPipeline.running = false;
    speakerPipeline.finishedAt = new Date().toISOString();
  });
}

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
  fs.createReadStream(resolved).pipe(res);
}

function serveOutput(res, pathname) {
  try {
    if (pathname === "/output/speaker-attribution.html") {
      const speakerFile = path.join(speakerOutputDir, "speaker-attribution.html");
      if (!fs.existsSync(speakerFile)) throw new Error("Speaker Attribution 工作台尚未生成。");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      fs.createReadStream(speakerFile).pipe(res);
      return;
    }
    const match = pathname.match(/^\/output\/([^/]+)\/translation-compare\.html$/);
    const projectKey = match
      ? decodeURIComponent(match[1])
      : (pathname === "/output/translation-compare.html" ? getActiveProject()?.id : "");
    if (!projectKey) throw new Error("工作台尚未生成。");
    const compareHtmlFile = resolveProjectArtifact(projectKey, "translation-compare.html");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    fs.createReadStream(compareHtmlFile).pipe(res);
  } catch (error) {
    sendError(res, 404, error);
  }
}

async function handleApi(req, res, pathname, searchParams) {
  try {
    if (req.method === "POST" && pathname === "/api/translation-export") {
      const payload = await readJson(req);
      const project = getActiveProject();
      const selection = readProjectSelection(project?.id, { snapshotId: project?.snapshotId });
      if (!selection?.files) throw new Error("没有可写回的输入选择，请先生成工作台。");
      // 按写回目标列（targetKey）分组：cn 写回主文本，tw 写回参考文本，互不混写。
      const groups = new Map();
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
        const result = await applyTextReplacements(target, entries);
        updated += result.updated;
        missed.push(...result.missed);
        ambiguous.push(...(result.ambiguous || []));
        targets.push(target);
      }
      const importedCopy = targets.some((target) => target.startsWith(importedInputsDir));
      sendJson(res, 200, { ok: true, target: targets[0] || "", targets, updated, missed, ambiguous, importedCopy });
      return;
    }
    if (req.method === "POST" && pathname === "/api/speaker-export") {
      const payload = await readJson(req);
      const selection = readSpeakerSelection();
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
      const result = await applySpeakerAnnotations(target, entries);
      sendJson(res, 200, { ok: true, target, updated: result.updated, skipped: result.skipped, missed: result.missed });
      return;
    }
    if (req.method === "GET" && pathname === "/api/status") {
      const saved = fs.existsSync(selectionFile)
        ? JSON.parse(fs.readFileSync(selectionFile, "utf8"))
        : null;
      const savedSpeaker = readSpeakerSelection();
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
        speaker: speakerStatus(),
        ...listProjects(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/speaker-status") {
      const saved = readSpeakerSelection();
      sendJson(res, 200, {
        ok: true,
        apiVersion: consoleApiVersion,
        selectionFile: speakerSelectionFile,
        saved,
        savedFiles: saved
          ? {
            jp: filePayload(saved.files.source),
            cn: saved.files.parallel ? filePayload(saved.files.parallel) : null,
          }
          : {},
        pipeline: speakerStatus(),
      });
      return;
    }

    if (req.method === "GET" && pathname === "/api/projects") {
      sendJson(res, 200, { ok: true, apiVersion: consoleApiVersion, ...listProjects() });
      return;
    }

    if (req.method === "POST" && /^\/api\/projects\/[^/]+\/activate$/.test(pathname)) {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行，暂时不能切换项目。" });
        return;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再切换项目。` });
        return;
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
      return;
    }

    if (req.method === "DELETE" && /^\/api\/projects\/[^/]+$/.test(pathname)) {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行，暂时不能删除项目。" });
        return;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再删除项目。` });
        return;
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
      return;
    }

    if (req.method === "POST" && /^\/api\/projects\/[^/]+\/rebuild-html$/.test(pathname)) {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行，暂时不能更新页面布局。" });
        return;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再更新页面布局。` });
        return;
      }
      const projectKey = decodeURIComponent(pathname.split("/")[3]);
      try {
        const { rebuildProjectHtml } = require("../storage/project-store");
        const rebuilt = rebuildProjectHtml(projectKey);
        const notesSpace = rebuilt.notesKey.replace(/^translation-compare-notes-/, "");
        sendJson(res, 200, {
          ok: true,
          apiVersion: consoleApiVersion,
          project: rebuilt.project,
          message: notesSpace
            ? `页面布局已更新，未重新进行文件比对。本页读取的备注空间：${notesSpace}（备注与人工确认都在浏览器本地）`
            : "页面布局已更新，未重新进行文件比对，已有数据与备注保持完整。",
          ...listProjects({ adoptCurrent: false }),
        });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || "更新页面布局失败。" });
      }
      return;
    }

    if (req.method === "GET" && pathname === "/api/scan") {
      sendJson(res, 200, { ok: true, ...scanDirectory(searchParams.get("dir"), searchParams.get("mode")) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/selection") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...saveInputSelection(payload) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/speaker-selection") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, ...saveSpeakerInputSelection(payload) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/validate-input") {
      const payload = await readJson(req);
      const target = normalizePath(payload?.path || "");
      validateLocalInputPath(target);
      sendJson(res, 200, { ok: true, file: filePayload(target) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/pick-path") {
      const payload = await readJson(req);
      const mode = payload?.mode === "folder" ? "folder" : "file";
      const picked = await pickNativePath(mode);
      if (!picked) {
        sendJson(res, 200, { ok: true, canceled: true });
        return;
      }
      const target = normalizePath(picked);
      validateLocalInputPath(target);
      sendJson(res, 200, { ok: true, file: filePayload(target) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/run") {
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "生成流程正在运行。", pipeline: generation.status() });
        return;
      }
      if (speakerPipeline.running) {
        sendJson(res, 409, { ok: false, error: "Speaker Attribution 工作台正在生成。", pipeline: generation.status() });
        return;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再生成新的工作台。`, pipeline: generation.status(), ai: aiProofreadStatus() });
        return;
      }
      if (!fs.existsSync(selectionFile)) {
        sendJson(res, 400, { ok: false, error: "请先导入所需文件。", pipeline: generation.status() });
        return;
      }
      clearProofreadCache();
      const selection = validateSelection(JSON.parse(fs.readFileSync(selectionFile, "utf8")));
      generation.run(selection);
      sendJson(res, 202, { ok: true, apiVersion: consoleApiVersion, pipeline: generation.status() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/speaker-run") {
      if (speakerPipeline.running) {
        sendJson(res, 409, { ok: false, error: "Speaker Attribution 工作台正在生成。", pipeline: speakerStatus() });
        return;
      }
      if (generation.running) {
        sendJson(res, 409, { ok: false, error: "翻译比较工作台正在生成。", pipeline: speakerStatus() });
        return;
      }
      if (aiProofreadStatus().running) {
        sendJson(res, 409, { ok: false, error: `${runningTaskLabel()}正在运行，请先停止后再生成 Speaker Attribution 工作台。`, pipeline: speakerStatus() });
        return;
      }
      if (!fs.existsSync(speakerSelectionFile)) {
        sendJson(res, 400, { ok: false, error: "请先导入所需文件。", pipeline: speakerStatus() });
        return;
      }
      readSpeakerSelection();
      runSpeakerPipeline();
      sendJson(res, 202, { ok: true, apiVersion: consoleApiVersion, pipeline: speakerStatus() });
      return;
    }

    if (req.method === "GET" && pathname === "/api/ai-proofread/status") {
      sendJson(res, 200, {
        ok: true,
        ai: aiProofreadStatus({
          runId: searchParams.get("runId") || "",
          afterRevision: searchParams.get("afterRevision") || 0,
          resultLimit: searchParams.get("resultLimit") || 0,
          profileId: searchParams.get("profileId") || "",
          knownRequestIds: searchParams.getAll("knownRequestId"),
          includeLogs: searchParams.get("compact") !== "1",
        }),
      });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/models") {
      const payload = await readJson(req);
      sendJson(res, 200, { ok: true, models: await listModels(payload) });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/start") {
      const payload = await readJson(req);
      try {
        sendJson(res, 202, { ok: true, ai: await startProofread(payload) });
      } catch (error) {
        sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/stop") {
      sendJson(res, 200, { ok: true, ai: stopProofread() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/ai-proofread/cache/clear") {
      try {
        sendJson(res, 200, { ok: true, ai: clearProofreadCache() });
      } catch (error) {
        sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/prefilter/start") {
      const payload = await readJson(req);
      try {
        sendJson(res, 202, { ok: true, ai: await startPrefilter(payload) });
      } catch (error) {
        sendJson(res, error.code === "RUNNING" ? 409 : 400, { ok: false, error: error.message, ai: aiProofreadStatus() });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/prefilter/stop") {
      sendJson(res, 200, { ok: true, ai: stopProofread() });
      return;
    }

    if (req.method === "POST" && pathname === "/api/speaker-ai/models") {
      try {
        const payload = await readJson(req);
        const models = await listProviderModels(payload);
        sendJson(res, 200, { ok: true, models });
      } catch (error) {
        sendJson(res, 400, { ok: false, error: error.message || String(error) });
      }
      return;
    }

    if (req.method === "POST" && pathname === "/api/speaker-ai/infer") {
      try {
        const payload = await readJson(req);
        const prediction = await inferSpeakerRow(payload.row, payload.config || {});
        sendJson(res, 200, { ok: true, prediction });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error.message || String(error) });
      }
      return;
    }

    sendError(res, 404, new Error(`Unknown local API endpoint: ${pathname}`));
  } catch (error) {
    sendError(res, 400, error);
  }
}

function createServer() {
  return http.createServer((req, res) => {
    const url = new URL(req.url, `http://${host}:${defaultPort}`);
    if (url.pathname.startsWith("/api/")) {
      handleApi(req, res, url.pathname, url.searchParams);
      return;
    }
    if (url.pathname.startsWith("/output/")) {
      serveOutput(res, url.pathname);
      return;
    }
    serveStatic(req, res, decodeURIComponent(url.pathname));
  });
}

const server = createServer();

function startServer() {
  server.listen(defaultPort, host, () => {
    const url = `http://${host}:${defaultPort}/`;
    console.log(`TransComparator console: ${url}`);
    console.log("Press Ctrl+C to stop.");
  });
}

if (require.main === module) startServer();

module.exports = {
  createServer,
  defaultPort,
  host,
  startServer,
};
