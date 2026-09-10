const fs = require("fs");
const path = require("path");
const {
  inferInputMode,
  isSupportedInput,
  normalizePath,
} = require("../../ingest/input-selection");
const { HEADER_ANCHORED_ALIGNMENT_VERSION } = require("./epub-header-alignment");

function validLanguageCode(value) {
  return /^[a-z]{2,8}$/i.test(String(value || ""));
}

function countMatches(text, pattern) {
  return (String(text || "").match(pattern) || []).length;
}

function detectLanguage(text) {
  const value = String(text || "");
  const kana = countMatches(value, /[\u3040-\u309f\u30a0-\u30ff]/g);
  const hangul = countMatches(value, /[\uac00-\ud7af]/g);
  const han = countMatches(value, /[\u3400-\u4dbf\u4e00-\u9fff]/g);
  const latin = countMatches(value, /[A-Za-z]/g);

  if (kana > 0) return "jp";
  if (hangul > 0) return "ko";
  if (han > 0) {
    const traditional = countMatches(value, /[臺灣萬與專業體後發現說話對於這個來們國會學習書讀寫視聽]/g);
    return traditional > 0 ? "tw" : "cn";
  }
  if (latin > 0) return "en";
  return "und";
}

function parseArgs(argv = []) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = String(argv[index] || "");
    if (!argument.startsWith("--")) continue;
    const key = argument.slice(2);
    values[key] = argv[index + 1] && !String(argv[index + 1]).startsWith("--")
      ? argv[++index]
      : true;
  }
  return values;
}

function validateSpeakerSelection(selection = {}) {
  const source = normalizePath(selection.source);
  const parallel = normalizePath(selection.parallel);
  const sourceLang = String(selection.sourceLang || "auto").toLowerCase();
  const parallelLang = String(selection.parallelLang || "auto").toLowerCase();

  if (!source) throw new Error("说话人工作台需要 --source <file>。");
  if (!fs.existsSync(source)) throw new Error(`原文文件不存在：${source}`);
  if (!isSupportedInput(source)) throw new Error(`不支持的原文格式：${source}`);
  if (!validLanguageCode(sourceLang)) throw new Error(`不支持的原文语言：${sourceLang}`);

  if (parallel) {
    if (path.resolve(source) === path.resolve(parallel)) {
      throw new Error("原文文件和主文本不能使用同一个文件。");
    }
    if (!fs.existsSync(parallel)) throw new Error(`双语文件不存在：${parallel}`);
    if (!isSupportedInput(parallel)) throw new Error(`不支持的双语格式：${parallel}`);
    if (!validLanguageCode(parallelLang)) throw new Error(`不支持的双语语言：${parallelLang}`);
  }

  const files = { source, parallel };
  const usesEpubHeaders = parallel && /\.epub$/i.test(source) && /\.epub$/i.test(parallel);
  return {
    analysisType: "speaker-attribution",
    mode: parallel ? "bilingual" : "monolingual",
    inputMode: inferInputMode(files),
    files,
    sourceLang,
    parallelLang: parallel ? parallelLang : "",
    lineUnitVersion: "quoted-dialogue-v1",
    alignmentVersion: parallel
      ? (usesEpubHeaders ? HEADER_ANCHORED_ALIGNMENT_VERSION : "monotonic-evidence-v5")
      : "none",
  };
}

function selectionFromArgs(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const selection = validateSpeakerSelection({
    source: args.source || process.env.BETWEENLINES_SPEAKER_SOURCE,
    parallel: args.parallel || process.env.BETWEENLINES_SPEAKER_PARALLEL,
    sourceLang: args["source-lang"] || process.env.BETWEENLINES_SPEAKER_SOURCE_LANG,
    parallelLang: args["parallel-lang"] || process.env.BETWEENLINES_SPEAKER_PARALLEL_LANG,
  });
  if (args.ai) {
    selection.ai = {
      enabled: true,
      provider: args.provider || process.env.BETWEENLINES_AI_PROVIDER || "compatible",
      model: args.model || process.env.BETWEENLINES_AI_MODEL || "default",
      baseUrl: args["base-url"] || process.env.BETWEENLINES_AI_BASE_URL || "",
      apiKey: args["api-key"] || process.env.BETWEENLINES_AI_API_KEY || "",
      concurrency: Number(args.concurrency) || 3,
      cacheFile: args["cache-file"] || null,
    };
  }
  return selection;
}

module.exports = {
  detectLanguage,
  parseArgs,
  selectionFromArgs,
  validateSpeakerSelection,
};
