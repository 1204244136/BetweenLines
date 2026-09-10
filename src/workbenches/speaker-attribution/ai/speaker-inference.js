/**
 * 说话人归属模型推断执行器 (src/workbenches/speaker-attribution/ai/speaker-inference.js)
 *
 * 遵循 AGENTS.md 契约：
 * 说话人专属的领域推断模块。通过 attention.js 组装结构化 Prompt，
 * 借助底层通用传输层 (src/ai/llm-client.js) 与并发控制器 (src/ai/task-queue.js)
 * 执行确定性的模型推断与 Schema 校验。
 * 绝不混入翻译比较工作台的校对列、MQM 等级或 notes 模型。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildSpeakerPrompt } = require("../attention");
const { callChatCompletions, cleanJsonPayload } = require("../../../ai/llm-client");
const { TaskQueue } = require("../../../ai/task-queue");
const {
  VALID_STATUSES,
  normalizeStatus,
  validateSpeakerOutput,
} = require("./speaker-contract");

function makeCacheKey(row = {}, prompt = {}, model = "") {
  const content = [
    prompt.version || "v1",
    model || "default",
    row.index ?? "",
    row.sourceText || "",
    row.parallelText || "",
  ].join("::");
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

function loadCache(cacheFile) {
  if (!cacheFile) return new Map();
  try {
    if (fs.existsSync(cacheFile)) {
      const data = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      return new Map(Object.entries(data));
    }
  } catch {}
  return new Map();
}

function saveCache(cacheFile, cacheMap) {
  if (!cacheFile || !cacheMap) return;
  try {
    const dir = path.dirname(cacheFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const obj = Object.fromEntries(cacheMap.entries());
    fs.writeFileSync(cacheFile, JSON.stringify(obj, null, 2), "utf8");
  } catch {}
}

async function inferSpeakerRow(row, config = {}, options = {}) {
  const prompt = options.prompt || buildSpeakerPrompt(row, { attention: row.attention });
  const rawContent = await callChatCompletions(prompt.messages, config, options);
  const parsed = cleanJsonPayload(rawContent);
  const validated = validateSpeakerOutput(parsed);
  return {
    ...validated,
    raw: rawContent,
    promptVersion: prompt.version,
    model: config.model || "default",
  };
}

async function inferSpeakerBatch(rows, config = {}, {
  concurrency = 3,
  retryCount = 1,
  cacheFile = null,
  onProgress = null,
  signal = null,
} = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const cacheMap = loadCache(cacheFile);
  let cachedCount = 0;
  let inferredCount = 0;
  let failedCount = 0;

  const queue = new TaskQueue({
    concurrency,
    retryCount,
    signal,
    onProgress: (info) => {
      if (onProgress) {
        onProgress({
          ...info,
          cached: cachedCount,
          inferred: inferredCount,
        });
      }
    },
  });

  const processor = async (row) => {
    const prompt = buildSpeakerPrompt(row, { attention: row.attention });
    const cacheKey = makeCacheKey(row, prompt, config.model);

    if (cacheMap.has(cacheKey)) {
      cachedCount += 1;
      const cachedResult = cacheMap.get(cacheKey);
      row.prediction = cachedResult;
      return cachedResult;
    }

    try {
      const result = await inferSpeakerRow(row, config, { prompt, signal });
      cacheMap.set(cacheKey, result);
      inferredCount += 1;
      row.prediction = result;
      return result;
    } catch (err) {
      failedCount += 1;
      row.prediction = {
        speaker: "",
        status: "needs-review",
        confidence: 0,
        evidence: `推断失败: ${err.message || String(err)}`,
        needsContext: true,
        error: true,
      };
      return row.prediction;
    }
  };

  const results = await queue.runAll(list, processor);
  if (cacheFile) {
    saveCache(cacheFile, cacheMap);
  }

  return {
    rows: list,
    results,
    stats: {
      total: list.length,
      cached: cachedCount,
      inferred: inferredCount,
      failed: failedCount,
    },
  };
}

module.exports = {
  VALID_STATUSES,
  normalizeStatus,
  validateSpeakerOutput,
  makeCacheKey,
  loadCache,
  saveCache,
  inferSpeakerRow,
  inferSpeakerBatch,
};
