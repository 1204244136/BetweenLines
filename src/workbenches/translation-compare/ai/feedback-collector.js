/**
 * Human Feedback Loop & Quality Calibration Collector.
 *
 * Tracks human editor actions on AI suggestions:
 * - accepted_ai: User accepted AI suggestion as-is and wrote back
 * - modified_ai: User edited AI suggestion before writing back
 * - rejected_ai: User confirmed the row keeping the original translation (rejected AI)
 * - manual_override: User provided a completely different translation
 *
 * Provides analytical aggregations to evaluate Gatekeeper, Stylist, and Arbiter
 * accuracy, feeding quality data back into the scheduler profile.
 */

const FEEDBACK_ACTIONS = Object.freeze(["accepted_ai", "modified_ai", "rejected_ai", "manual_override"]);

function normalizeFeedbackEvent(event = {}) {
  const action = FEEDBACK_ACTIONS.includes(event.action) ? event.action : "accepted_ai";
  const index = Math.max(0, Number(event.index) || 0);
  const rowSignature = String(event.rowSignature || "").trim();
  const originalText = String(event.originalText || "").trim();
  const aiRevisedText = String(event.aiRevisedText || "").trim();
  const userFinalText = String(event.userFinalText || "").trim();
  const stage = String(event.stage || "gatekeeper").trim();
  const modelId = String(event.modelId || "").trim();
  const timestamp = Number.isSafeInteger(Number(event.timestamp)) && Number(event.timestamp) > 0
    ? Number(event.timestamp)
    : Date.now();

  return {
    action,
    index,
    rowSignature,
    originalText,
    aiRevisedText,
    userFinalText,
    stage,
    modelId,
    timestamp,
    critiqueAttitude: event.critiqueAttitude ? String(event.critiqueAttitude) : null,
    arbitrationWinner: event.arbitrationWinner ? String(event.arbitrationWinner) : null,
  };
}

class FeedbackCollector {
  constructor(options = {}) {
    this.events = [];
    this.maxEvents = options.maxEvents || 5000;
  }

  record(event) {
    const normalized = normalizeFeedbackEvent(event);
    this.events.push(normalized);
    if (this.events.length > this.maxEvents) {
      this.events.splice(0, this.events.length - this.maxEvents);
    }
    return normalized;
  }

  list(filter = {}) {
    let list = this.events;
    if (filter.stage) {
      list = list.filter((e) => e.stage === filter.stage);
    }
    if (filter.modelId) {
      list = list.filter((e) => e.modelId === filter.modelId);
    }
    if (filter.action) {
      list = list.filter((e) => e.action === filter.action);
    }
    if (filter.limit && filter.limit > 0) {
      list = list.slice(-filter.limit);
    }
    return list;
  }

  clear() {
    this.events = [];
  }

  getStatistics() {
    const total = this.events.length;
    if (total === 0) {
      return {
        total: 0,
        accepted: 0,
        modified: 0,
        rejected: 0,
        manualOverride: 0,
        acceptanceRate: 0,
        rejectionRate: 0,
        modificationRate: 0,
        byStage: {},
        byModel: {},
      };
    }

    let accepted = 0;
    let modified = 0;
    let rejected = 0;
    let manualOverride = 0;

    const byStage = {};
    const byModel = {};

    for (const e of this.events) {
      if (e.action === "accepted_ai") accepted += 1;
      else if (e.action === "modified_ai") modified += 1;
      else if (e.action === "rejected_ai") rejected += 1;
      else if (e.action === "manual_override") manualOverride += 1;

      // By stage
      if (!byStage[e.stage]) byStage[e.stage] = { total: 0, accepted: 0, rejected: 0, modified: 0 };
      byStage[e.stage].total += 1;
      if (e.action === "accepted_ai") byStage[e.stage].accepted += 1;
      if (e.action === "rejected_ai") byStage[e.stage].rejected += 1;
      if (e.action === "modified_ai") byStage[e.stage].modified += 1;

      // By model
      const m = e.modelId || "unknown";
      if (!byModel[m]) byModel[m] = { total: 0, accepted: 0, rejected: 0, modified: 0 };
      byModel[m].total += 1;
      if (e.action === "accepted_ai") byModel[m].accepted += 1;
      if (e.action === "rejected_ai") byModel[m].rejected += 1;
      if (e.action === "modified_ai") byModel[m].modified += 1;
    }

    return {
      total,
      accepted,
      modified,
      rejected,
      manualOverride,
      acceptanceRate: Math.round((accepted / total) * 1000) / 10,
      rejectionRate: Math.round((rejected / total) * 1000) / 10,
      modificationRate: Math.round((modified / total) * 1000) / 10,
      byStage,
      byModel,
    };
  }

  toJSON() {
    return {
      version: 1,
      savedAt: Date.now(),
      events: this.events,
    };
  }

  fromJSON(data = {}) {
    if (data && Array.isArray(data.events)) {
      this.events = data.events.map(normalizeFeedbackEvent);
    }
  }
}

// Global default singleton for process lifetime
const globalFeedbackCollector = new FeedbackCollector();

module.exports = {
  FEEDBACK_ACTIONS,
  normalizeFeedbackEvent,
  FeedbackCollector,
  globalFeedbackCollector,
};
