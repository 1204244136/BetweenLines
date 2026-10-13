// index-X 当前使用全角定界符；历史输入仍接受半角定界符。
const WORK_ID_SOURCE = String.raw`S\d+_\d+[a-z]?(?:_\d+|\.\d+\.\d+)?`;

function workIdFromPath(value) {
  const match = String(value || "").match(new RegExp(`(?:【(${WORK_ID_SOURCE})】|\\[(${WORK_ID_SOURCE})\\])`, "i"));
  return (match?.[1] || match?.[2] || "").toUpperCase();
}

function workIdPattern(workId) {
  const escaped = String(workId).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:【${escaped}】|\\[${escaped}\\]|(?:^|\\b)${escaped}(?=$|\\s|\\.(?:epub|docx|txt)$))`, "i");
}

module.exports = { workIdFromPath, workIdPattern };
