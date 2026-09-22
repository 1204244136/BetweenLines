/**
 * Model profiling and auto-scheduling system for staged review pipeline.
 *
 * Provides capability-driven profiling across six dimensions:
 * - strictness: adherence to source facts, grammar, and omission detection (1-10)
 * - literary: fluency, prose elegance, cadence, and tone modulation (1-10)
 * - reasoning: multi-step logical deduction, conflict arbitration, edge-case resolution (1-10)
 * - cost: relative token pricing (1=very cheap, 10=expensive)
 * - context: long-range narrative tracking and window capability (1-10)
 * - latency: speed of response (1=fastest, 10=slowest)
 *
 * Selection priorities:
 * - Gatekeeper: prioritizes strictness and cost (fast, accurate factual verification)
 * - Stylist: prioritizes literary and context (literary polishing and critique)
 * - Arbiter: prioritizes reasoning and strictness (authoritative resolution)
 */

const { detectModelCapabilities } = require("./model-capabilities");

/**
 * Curated baseline profiles for well-known models.
 */
const CURATED_PROFILES = {
  // DeepSeek series
  "deepseek-reasoner": { strictness: 9.2, literary: 7.0, reasoning: 9.5, cost: 2.0, context: 8.5, latency: 6.0 },
  "deepseek-r1": { strictness: 9.2, literary: 7.0, reasoning: 9.5, cost: 2.0, context: 8.5, latency: 6.0 },
  "deepseek-chat": { strictness: 8.0, literary: 8.6, reasoning: 7.5, cost: 1.5, context: 8.0, latency: 2.5 },
  "deepseek-v3": { strictness: 8.2, literary: 8.7, reasoning: 7.8, cost: 1.5, context: 8.5, latency: 2.8 },
  "deepseek-v4-flash": { strictness: 8.0, literary: 7.5, reasoning: 8.5, cost: 1.0, context: 8.0, latency: 2.0 },
  "deepseek-v4-pro": { strictness: 9.0, literary: 8.2, reasoning: 9.2, cost: 2.5, context: 9.0, latency: 4.5 },

  // Anthropic Claude series
  "claude-3-7-sonnet": { strictness: 8.8, literary: 9.6, reasoning: 9.2, cost: 6.0, context: 9.8, latency: 4.5 },
  "claude-3-5-sonnet": { strictness: 8.7, literary: 9.5, reasoning: 8.9, cost: 5.5, context: 9.5, latency: 4.0 },
  "claude-3-5-haiku": { strictness: 7.8, literary: 8.2, reasoning: 7.2, cost: 2.0, context: 8.5, latency: 1.8 },
  "claude-sonnet-4": { strictness: 9.0, literary: 9.7, reasoning: 9.5, cost: 6.5, context: 10.0, latency: 4.5 },

  // OpenAI series
  "o1": { strictness: 9.5, literary: 7.5, reasoning: 9.8, cost: 8.0, context: 9.0, latency: 7.0 },
  "o1-mini": { strictness: 8.8, literary: 7.0, reasoning: 9.0, cost: 3.5, context: 8.0, latency: 4.0 },
  "o3": { strictness: 9.6, literary: 8.0, reasoning: 9.9, cost: 8.5, context: 9.5, latency: 6.5 },
  "o3-mini": { strictness: 9.0, literary: 7.2, reasoning: 9.2, cost: 3.0, context: 8.5, latency: 3.5 },
  "gpt-4o": { strictness: 8.2, literary: 8.6, reasoning: 8.0, cost: 5.0, context: 8.5, latency: 3.0 },
  "gpt-4o-mini": { strictness: 7.5, literary: 7.5, reasoning: 6.8, cost: 1.2, context: 7.5, latency: 1.8 },
  "gpt-5": { strictness: 9.5, literary: 9.5, reasoning: 9.7, cost: 7.5, context: 9.8, latency: 4.5 },

  // Qwen series
  "qwen-max": { strictness: 8.4, literary: 8.9, reasoning: 8.5, cost: 3.0, context: 8.5, latency: 3.5 },
  "qwen-plus": { strictness: 7.9, literary: 8.3, reasoning: 7.6, cost: 1.8, context: 8.0, latency: 2.5 },
  "qwen-turbo": { strictness: 7.2, literary: 7.4, reasoning: 6.5, cost: 1.0, context: 7.5, latency: 1.5 },
  "qwq-32b": { strictness: 8.8, literary: 7.0, reasoning: 9.0, cost: 2.0, context: 8.0, latency: 5.5 },

  // Gemini series
  "gemini-2.5-pro": { strictness: 8.6, literary: 8.8, reasoning: 9.0, cost: 4.0, context: 10.0, latency: 3.8 },
  "gemini-2.0-flash": { strictness: 7.8, literary: 8.0, reasoning: 7.8, cost: 1.2, context: 9.5, latency: 1.6 },
};

function clampScore(val, min = 1.0, max = 10.0) {
  const num = Number(val);
  if (!Number.isFinite(num)) return min;
  return Math.max(min, Math.min(max, Math.round(num * 10) / 10));
}

/**
 * Heuristic profiling for models not present in CURATED_PROFILES.
 */
function heuristicProfile(modelId, caps) {
  const lower = String(modelId || "").toLowerCase();
  let strictness = 7.0;
  let literary = 7.0;
  let reasoning = caps.reasoning ? 8.5 : 6.5;
  let cost = 3.0;
  let context = 7.5;
  let latency = 4.0;

  if (caps.reasoning || /reasoner|r1|o1|o3|o4|qwq|thinking/i.test(lower)) {
    reasoning = Math.max(reasoning, 8.8);
    strictness = Math.max(strictness, 8.5);
    cost += 1.5;
    latency += 2.0;
  }

  if (/claude|sonnet/i.test(lower)) {
    literary = Math.max(literary, 9.0);
    context = Math.max(context, 9.0);
    cost += 2.0;
  }

  if (/chat|v3|gpt-4/i.test(lower) && !caps.reasoning) {
    literary = Math.max(literary, 8.2);
    latency = Math.min(latency, 3.0);
  }

  if (/flash|mini|turbo|haiku|nano|small|8b|7b/i.test(lower)) {
    cost = Math.min(cost, 1.8);
    latency = Math.min(latency, 2.0);
    strictness = Math.max(6.0, strictness - 0.5);
    reasoning = Math.max(6.0, reasoning - 0.5);
  }

  if (/pro|max|plus|large|70b|72b/i.test(lower)) {
    strictness = Math.min(10.0, strictness + 0.8);
    literary = Math.min(10.0, literary + 0.8);
    cost = Math.min(10.0, cost + 1.5);
  }

  return {
    strictness: clampScore(strictness),
    literary: clampScore(literary),
    reasoning: clampScore(reasoning),
    cost: clampScore(cost),
    context: clampScore(context),
    latency: clampScore(latency),
  };
}

/**
 * Retrieve the normalized profile for a given model ID.
 */
function getModelProfile(modelId, provider = "") {
  const rawId = String(modelId || "").trim();
  const lower = rawId.toLowerCase();
  const caps = detectModelCapabilities(rawId, provider);

  let profileData = null;
  let source = "curated";

  // Check exact or normalized curated match (exact matches first, then longer keys)
  if (CURATED_PROFILES[lower]) {
    profileData = CURATED_PROFILES[lower];
  } else {
    // Exact suffix matches like "provider/model"
    for (const [key, val] of Object.entries(CURATED_PROFILES)) {
      if (lower.endsWith("/" + key)) {
        profileData = val;
        break;
      }
    }
  }

  if (!profileData) {
    // Substring matches, longer keys first to prevent "gpt-4o" hijacking "gpt-4o-mini"
    const sortedKeys = Object.keys(CURATED_PROFILES).sort((a, b) => b.length - a.length);
    for (const key of sortedKeys) {
      if (lower.includes(key)) {
        profileData = CURATED_PROFILES[key];
        break;
      }
    }
  }

  if (!profileData) {
    profileData = heuristicProfile(rawId, caps);
    source = "heuristic";
  }

  return {
    modelId: rawId,
    name: caps.name || rawId,
    reasoning: caps.reasoning,
    strictness: clampScore(profileData.strictness),
    literary: clampScore(profileData.literary),
    reasoningScore: clampScore(profileData.reasoning),
    cost: clampScore(profileData.cost),
    context: clampScore(profileData.context),
    latency: clampScore(profileData.latency),
    source,
  };
}

/**
 * Score how well a model fits a specific role:
 * - gatekeeper: 50% strictness, 30% cost efficiency (inverted cost), 20% latency efficiency (inverted latency)
 * - stylist: 50% literary, 30% context, 20% reasoning
 * - arbiter: 50% reasoning, 30% strictness, 20% literary
 */
function calculateRoleSuitability(profile) {
  const costEfficiency = 11.0 - profile.cost;
  const speedEfficiency = 11.0 - profile.latency;

  const gatekeeperScore = (profile.strictness * 0.5) + (costEfficiency * 0.3) + (speedEfficiency * 0.2);
  const stylistScore = (profile.literary * 0.5) + (profile.context * 0.3) + (profile.reasoningScore * 0.2);
  const arbiterScore = (profile.reasoningScore * 0.5) + (profile.strictness * 0.3) + (profile.literary * 0.2);

  return {
    gatekeeper: Math.round(gatekeeperScore * 100) / 100,
    stylist: Math.round(stylistScore * 100) / 100,
    arbiter: Math.round(arbiterScore * 100) / 100,
  };
}

/**
 * Recommend the most suitable single role for a model.
 */
function recommendRole(modelId, provider = "") {
  const profile = getModelProfile(modelId, provider);
  const scores = calculateRoleSuitability(profile);

  const entries = Object.entries(scores);
  entries.sort((a, b) => b[1] - a[1]);
  return {
    recommendedRole: entries[0][0],
    scores,
    profile,
  };
}

/**
 * Auto-scheduler: allocates available models to Gatekeeper, Stylist, and Arbiter roles.
 *
 * @param {Array<string|object>} models - List of model IDs or objects { id, model, provider, ... }
 * @param {object} [options]
 * @param {boolean} [options.preferDiverseModels=true]
 * @returns {object} Scheduled role assignments and reasoning.
 */
function scheduleModels(models = [], options = {}) {
  const normalizedList = (Array.isArray(models) ? models : [])
    .map((item) => {
      if (typeof item === "string") return { id: item.trim(), provider: "" };
      if (item && typeof item === "object") {
        return {
          id: String(item.id || item.model || "").trim(),
          provider: String(item.provider || "").trim(),
          presetId: item.presetId || item.id || "",
          name: item.name || item.id || "",
        };
      }
      return null;
    })
    .filter((item) => item && item.id);

  if (normalizedList.length === 0) {
    return {
      mode: "none",
      gatekeeper: null,
      stylist: null,
      arbiter: null,
      rationale: "未提供可调度的模型列表。",
    };
  }

  // Profile all models
  const candidates = normalizedList.map((item) => {
    const profile = getModelProfile(item.id, item.provider);
    const suitability = calculateRoleSuitability(profile);
    return {
      ...item,
      profile,
      suitability,
    };
  });

  // Single model scenario -> Persona Runtime candidate
  if (candidates.length === 1) {
    const single = candidates[0];
    return {
      mode: "single",
      gatekeeper: single,
      stylist: single,
      arbiter: single,
      recommendPersona: true,
      rationale: `仅有 1 个模型（${single.id}），建议启用单模型人格分化（Persona Runtime）。`,
    };
  }

  // Dual model scenario -> Challenger mode
  if (candidates.length === 2) {
    // Model A as Gatekeeper & Model B as Stylist VS vice versa
    const [m1, m2] = candidates;
    const option1Score = m1.suitability.gatekeeper + m2.suitability.stylist;
    const option2Score = m2.suitability.gatekeeper + m1.suitability.stylist;

    const [gk, sty] = option1Score >= option2Score ? [m1, m2] : [m2, m1];
    // Arbiter falls back to the higher reasoning model between the two
    const arb = gk.profile.reasoningScore >= sty.profile.reasoningScore ? gk : sty;

    return {
      mode: "dual",
      gatekeeper: gk,
      stylist: sty,
      arbiter: arb,
      recommendPersona: false,
      rationale: `双模型 Challenger 模式：${gk.id} 担任 Gatekeeper 事实质检；${sty.id} 担任 Stylist 文学审查；仲裁由推理分更高的 ${arb.id} 兼任。`,
    };
  }

  // 3+ models scenario -> Optimal matching across permutations
  let bestScore = -Infinity;
  let bestAssignment = null;

  for (let i = 0; i < candidates.length; i++) {
    for (let j = 0; j < candidates.length; j++) {
      if (i === j) continue;
      for (let k = 0; k < candidates.length; k++) {
        if (k === i || k === j) continue;
        const gk = candidates[i];
        const sty = candidates[j];
        const arb = candidates[k];
        const totalSuitability = gk.suitability.gatekeeper + sty.suitability.stylist + arb.suitability.arbiter;
        if (totalSuitability > bestScore) {
          bestScore = totalSuitability;
          bestAssignment = { gatekeeper: gk, stylist: sty, arbiter: arb };
        }
      }
    }
  }

  const { gatekeeper, stylist, arbiter } = bestAssignment || {
    gatekeeper: candidates[0],
    stylist: candidates[1] || candidates[0],
    arbiter: candidates[2] || candidates[0],
  };

  return {
    mode: "multi",
    gatekeeper,
    stylist,
    arbiter,
    recommendPersona: false,
    rationale: `三阶段完整流水线：${gatekeeper.id} 担任 Gatekeeper；${stylist.id} 担任 Stylist；${arbiter.id} 担任 Arbiter。`,
  };
}

module.exports = {
  CURATED_PROFILES,
  getModelProfile,
  calculateRoleSuitability,
  recommendRole,
  scheduleModels,
};
