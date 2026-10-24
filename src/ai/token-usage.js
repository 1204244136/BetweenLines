// 供应商用量口径归一化：这里只处理 token 计数，不持有工作台或任务状态。
function tokenCount(value) {
  if ((typeof value !== "number" && typeof value !== "string")
    || (typeof value === "string" && !value.trim())) return null;
  const count = Number(value);
  return Number.isFinite(count) && count >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count))
    : null;
}

function sumTokens(...counts) {
  return Math.min(Number.MAX_SAFE_INTEGER, counts.reduce((sum, count) => sum + (count || 0), 0));
}

function normalizeTokenUsage(raw = {}, protocol = "compatible") {
  const usage = raw && typeof raw === "object" ? raw : {};
  const completionTokens = tokenCount(usage.completion_tokens ?? usage.output_tokens) ?? 0;
  let promptTokens;
  let cachedPromptTokens = 0;
  let cacheWritePromptTokens = 0;
  let cacheReported = false;

  if (protocol === "claude") {
    // Anthropic 的 input_tokens 只含缓存断点之后的普通输入；读、写缓存须加回一次。
    const input = tokenCount(usage.input_tokens);
    const read = tokenCount(usage.cache_read_input_tokens);
    const write = tokenCount(usage.cache_creation_input_tokens);
    promptTokens = sumTokens(input, read, write);
    cacheReported = input != null && read != null
      && (!Object.hasOwn(usage, "cache_creation_input_tokens") || write != null);
    if (cacheReported) {
      cachedPromptTokens = read;
      cacheWritePromptTokens = write ?? 0;
    }
  } else {
    const input = tokenCount(usage.prompt_tokens ?? usage.input_tokens);
    const hit = tokenCount(usage.prompt_cache_hit_tokens);
    const miss = tokenCount(usage.prompt_cache_miss_tokens);
    const detail = tokenCount(usage.prompt_tokens_details?.cached_tokens)
      ?? tokenCount(usage.input_tokens_details?.cached_tokens);
    // DeepSeek 可用 hit + miss 恢复完整输入；不要把只有 hit 的残缺数据当成 100% 命中。
    promptTokens = input ?? (hit != null && miss != null ? sumTokens(hit, miss) : 0);
    cacheReported = input != null || (hit != null && miss != null);
    const read = hit ?? (miss != null && input != null ? input - miss : null) ?? detail;
    // 不一致的接口数据不能通过截断伪装成 100% 命中，也不能混入其它调用的缓存分母。
    cacheReported = cacheReported && read != null && read >= 0 && read <= promptTokens
      && (!Object.hasOwn(usage, "prompt_cache_hit_tokens") || hit != null)
      && (!Object.hasOwn(usage, "prompt_cache_miss_tokens") || miss != null)
      && (miss == null || miss <= promptTokens)
      && (hit == null || miss == null || hit + miss === promptTokens);
    if (cacheReported) cachedPromptTokens = read;
  }

  const cacheReportedPromptTokens = cacheReported ? promptTokens : 0;
  return {
    promptTokens,
    completionTokens,
    totalTokens: Math.max(tokenCount(usage.total_tokens) ?? 0, sumTokens(promptTokens, completionTokens)),
    cachedPromptTokens,
    cacheMissPromptTokens: cacheReported ? Math.max(0, promptTokens - cachedPromptTokens) : 0,
    cacheWritePromptTokens,
    cacheReportedPromptTokens,
    cacheReportedCalls: cacheReported ? 1 : 0,
  };
}

module.exports = { normalizeTokenUsage };
