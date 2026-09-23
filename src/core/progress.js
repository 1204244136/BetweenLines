/**
 * 跨子进程的机器进度协议（src/core/progress.js）。
 *
 * 供 export-paragraphs、align_jp、build-compare 报告进度，
 * generation-pipeline / input-server 负责解析并映射至全局进度区间。
 */

const PROGRESS_PREFIX = "@@transcomparator-progress@@";

function reportProgress(percent, label, current = 0, total = 0) {
  if (process.env.TRANS_COMPARATOR_MACHINE_PROGRESS !== "1") return;
  console.log(`${PROGRESS_PREFIX}${JSON.stringify({ percent, label, current, total })}`);
}

function parseProgressMessage(line) {
  const text = String(line || "").trim();
  if (!text.startsWith(PROGRESS_PREFIX)) return null;
  try {
    const message = JSON.parse(text.slice(PROGRESS_PREFIX.length));
    const percent = Number(message.percent);
    if (!Number.isFinite(percent)) return null;
    return {
      ...message,
      percent: Math.max(0, Math.min(100, percent)),
    };
  } catch {
    return null;
  }
}

module.exports = {
  PROGRESS_PREFIX,
  progressPrefix: PROGRESS_PREFIX,
  parseProgressMessage,
  reportProgress,
};
