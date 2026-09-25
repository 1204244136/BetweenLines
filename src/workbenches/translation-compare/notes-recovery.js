// 仅根据内容证据匹配记录；持久化与 UI 由调用方负责。

// 备注空间键随 projectKey / rowsSignature 变化后，历史备注只能按内容重新对应到当前行。
function alignLegacyNotes(entries, rows) {
  const normalize = (value) => String(value ?? "").replace(/\s+/g, "");
  const signatureTargets = new Map();
  const textTargets = new Map();
  const rowIndexes = new Set();
  const rowByIndex = new Map();
  const addUnique = (map, key, index) => {
    if (!map.has(key)) map.set(key, index);
    else if (map.get(key) !== index) map.set(key, null);
  };
  for (const row of rows || []) {
    if (!Number.isInteger(row?.index)) continue;
    rowIndexes.add(row.index);
    rowByIndex.set(row.index, row);
    const signature = String(row.signature || "");
    if (signature) addUnique(signatureTargets, signature, row.index);
    for (const column of ["cn", "tw", "twCn"]) {
      const text = normalize(row[column]);
      if (!text) continue;
      addUnique(textTargets, text, row.index);
    }
  }

  const total = (entries || []).length;
  const sourceSignatures = new Map();
  for (const entry of entries || []) {
    if (entry?.signature) sourceSignatures.set(entry.signature, (sourceSignatures.get(entry.signature) || 0) + 1);
  }
  const used = new Set();
  const pairs = [];
  const remaining = [];
  for (const entry of entries || []) {
    const from = Number(entry?.from);
    if (!Number.isInteger(from)) continue;
    const signature = String(entry.signature || "");
    const target = signature ? signatureTargets.get(signature) : undefined;
    if (target != null && sourceSignatures.get(signature) === 1 && !used.has(target)) {
      used.add(target);
      pairs.push({ from, to: target });
      continue;
    }
    remaining.push({ from, text: normalize(entry.text), signature });
  }
  const signaturePairs = pairs.slice();
  const anchors = [];
  for (const item of remaining) {
    if (item.text.length < 12) continue;
    const to = textTargets.get(item.text);
    if (to != null && !used.has(to)) anchors.push({ from: item.from, to });
  }
  const monotonic = [];
  const anchorTargets = new Map();
  for (const anchor of anchors) anchorTargets.set(anchor.to, (anchorTargets.get(anchor.to) || 0) + 1);
  for (const anchor of anchors.sort((a, b) => a.from - b.from || a.to - b.to)) {
    if (anchorTargets.get(anchor.to) !== 1) continue;
    if (!monotonic.length || anchor.to > monotonic.at(-1).to) monotonic.push(anchor);
  }
  // 记录自带的「修改结果」与目标行正文逐字相同（且这段文本在当前行集里只属于那一行）时，
  // 那一行现在的正文就是人工批准并写回的成品——这是文本证据，不是行序推断。
  // 短文本只有在「本来就在这一行号上」时才够格：行号相同 + 正文逐字相同，两条独立证据互相钉住；
  // 换了行号的位置推断才需要长文本，免得一句「所有人。」把记录搬到别的行上。
  const textEvidence = (item, to) => item.text.length > 0 && textTargets.get(item.text) === to
    && (to === item.from || item.text.length >= 12);
  const aligned = [];
  // 少量长文本偶然相同不足以证明这份备注属于当前行集，宁可不找回。
  if (monotonic.length >= 3) {
    const offsetAt = (from) => {
      let before = null;
      let after = null;
      for (const anchor of monotonic) {
        if (anchor.from <= from) before = anchor;
        if (anchor.from >= from && !after) after = anchor;
      }
      if (!before || !after) return null;
      if (before === after) return before.to - before.from;
      const beforeOffset = before.to - before.from;
      return beforeOffset === after.to - after.from ? beforeOffset : null;
    };
    for (const item of remaining) {
      const offset = offsetAt(item.from);
      if (offset === null) continue;
      const to = item.from + offset;
      if (!rowIndexes.has(to) || used.has(to)) continue;
      used.add(to);
      aligned.push({ from: item.from, to, ...(textEvidence(item, to) ? { textConfirmed: true } : {}) });
    }
  }
  // 内容签名在整本书里重复的行（「……」这类短行反复出现）走不了签名通道，落在文本锚点覆盖范围之外时
  // 过去只能整条丢弃——重新生成工作台后少掉的人工确认主要出在这里。但「同一行号上的正文签名与旧记录一致」
  // 本身就是内容证据：这一行没有动过，记录就该搬回去。只在行集索引稳定（已匹配的记录绝大多数仍落在同一行号）
  // 时启用：插行/删行会让行号整体位移，那时同索引不再代表同一行。
  const settled = [...signaturePairs, ...aligned];
  const sameSeat = settled.filter((pair) => pair.to === pair.from).length;
  const sameIndexPairs = [];
  if (settled.length >= 10 && sameSeat / settled.length >= 0.9) {
    for (const item of remaining) {
      if (!item.signature || used.has(item.from)) continue;
      const row = rowByIndex.get(item.from);
      if (!row || String(row.signature || "") !== item.signature) continue;
      used.add(item.from);
      sameIndexPairs.push({ from: item.from, to: item.from, sameIndex: true, ...(textEvidence(item, item.from) ? { textConfirmed: true } : {}) });
    }
  }
  const merged = [...signaturePairs, ...aligned, ...sameIndexPairs];
  return {
    method: signaturePairs.length ? (aligned.length || sameIndexPairs.length ? "mixed" : "signature")
      : (sameIndexPairs.length && !aligned.length ? "sameIndex" : "anchors"),
    pairs: merged,
    unmatched: total - merged.length,
    anchors: monotonic.length,
    sameIndex: sameIndexPairs.length,
  };
}

// 按行号搬回：行号本身没有内容证据，所以只搬当前行集里仍存在的行，
// 且当前空间已有记录的行不被覆盖。
function alignNotesByIndex(entryIds, rows, occupiedIds) {
  const rowIndexes = new Set();
  for (const row of rows || []) {
    if (Number.isInteger(row?.index)) rowIndexes.add(row.index);
  }
  const occupied = new Set();
  for (const id of occupiedIds || []) occupied.add(String(id));
  const pairs = [];
  let missing = 0;
  let occupiedCount = 0;
  for (const rawId of entryIds || []) {
    const from = Number(rawId);
    if (!Number.isInteger(from)) continue;
    if (!rowIndexes.has(from)) { missing += 1; continue; }
    if (occupied.has(String(from))) { occupiedCount += 1; continue; }
    occupied.add(String(from));
    pairs.push({ from, to: from });
  }
  return { pairs, missing, occupied: occupiedCount };
}

module.exports = { alignLegacyNotes, alignNotesByIndex };
