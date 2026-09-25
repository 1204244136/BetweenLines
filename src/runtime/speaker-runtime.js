const fs = require("fs");
const path = require("path");
const { normalizePath } = require("../ingest/input-selection");
const { readJsonFile, writeJsonAtomic } = require("../core/atomic-fs");
const { validateSpeakerSelection } = require("../workbenches/speaker-attribution/speaker-selection");
const {
  buildSpeakerWorkbench,
  writeSpeakerModel,
} = require("../workbenches/speaker-attribution/build-workbench");

// 每个实例拥有独立任务状态；所有持久化操作使用指定运行目录。
function createSpeakerRuntime({ runtimeDir, build = buildSpeakerWorkbench, write = writeSpeakerModel }) {
  const speakerRuntimeDir = runtimeDir;
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
    writeJsonAtomic(speakerSelectionFile, selection);
    return { selection, selectionFile: speakerSelectionFile };
  }

  function readSpeakerSelection() {
    if (!fs.existsSync(speakerSelectionFile)) return null;
    const stored = readJsonFile(speakerSelectionFile);
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

    return Promise.resolve().then(async () => {
      const selection = readSpeakerSelection();
      if (!selection) throw new Error("请先导入所需文件。");
      pushSpeakerLog(`Mode: ${selection.mode}`);
      const model = await build(selection);
      speakerPipeline.progress = { current: 1, total: 1, percent: 95, step: "writing", detail: "写入工作台" };
      write(model, speakerOutputDir);
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

  return {
    get running() { return speakerPipeline.running; },
    selectionFile: speakerSelectionFile,
    outputDir: speakerOutputDir,
    saveSelection: saveSpeakerInputSelection,
    readSelection: readSpeakerSelection,
    status: speakerStatus,
    run: runSpeakerPipeline,
  };
}

module.exports = { createSpeakerRuntime };
