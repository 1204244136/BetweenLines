// Pure helpers shared by the generated browser page and Node regression tests.
function createNotesTools(alignLegacyNotes) {
  const prefix = "translation-compare-notes-";
  const auxiliary = (key) => /:previous-notes-migration-|:manual-done-prefix-/.test(key);
  const record = (value) => value && typeof value === "object" && !Array.isArray(value);
  const isNote = (value) => record(value) && (
    typeof value.note === "string" || typeof value.revisionText === "string"
    || typeof value.manualDone === "boolean" || typeof value.done === "boolean" || typeof value.aiDone === "boolean"
  );
  const entries = (data) => Object.entries(record(data) ? data : {}).filter(([id, value]) =>
    /^[1-9]\d*$/.test(id) && Number.isSafeInteger(Number(id)) && isNote(value));

  function parse(raw) {
    try {
      const data = JSON.parse(raw);
      if (!record(data) || Object.keys(data).length !== entries(data).length) return null;
      return data;
    } catch { return null; }
  }

  function identity(key) {
    const base = key.replace(/:import-\d+(?:-\d+)?$/, "");
    const match = base.match(/^translation-compare-notes-(v\d+):(.+):([^:]+)$/);
    return match ? { version: match[1], project: match[2], rows: match[3] } : { version: "", project: "", rows: "" };
  }

  function storageFailureKind(error) {
    if (error?.name === "QuotaExceededError" || error?.name === "NS_ERROR_DOM_QUOTA_REACHED"
      || error?.code === 22 || error?.code === 1014) return "quota";
    if (error?.name === "SecurityError" || error?.name === "NotAllowedError") return "denied";
    return "unknown";
  }

  // UTF-16 estimates describe stored strings, not the browser's actual quota accounting.
  function storageUsage(storage, currentKey, currentRaw) {
    const usage = { available: true, totalBytes: 0, currentBytes: 0,
      historyCount: 0, historyBytes: 0, otherNotesCount: 0, otherNotesBytes: 0, otherBytes: 0 };
    const project = identity(currentKey).project;
    const bytes = (key, raw) => raw === null ? 0 : 2 * (key.length + raw.length);
    try {
      for (let index = 0; index < storage.length; index += 1) {
        const key = storage.key(index);
        if (key === null) continue;
        const raw = storage.getItem(key);
        if (raw === null) continue;
        const size = bytes(key, raw);
        usage.totalBytes += size;
        if (key === currentKey) usage.currentBytes += size;
        else if (key.startsWith(prefix) && !auxiliary(key)) {
          if (project && identity(key).project === project) {
            usage.historyCount += 1;
            usage.historyBytes += size;
          } else {
            usage.otherNotesCount += 1;
            usage.otherNotesBytes += size;
          }
        } else usage.otherBytes += size;
      }
    } catch { usage.available = false; }
    usage.pendingBytes = bytes(currentKey, currentRaw);
    usage.projectedBytes = usage.totalBytes - usage.currentBytes + usage.pendingBytes;
    return usage;
  }

  function inventory(storage, currentKey, currentNotes) {
    const keys = new Set([currentKey]);
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix) && !auxiliary(key)) keys.add(key);
    }
    const currentIdentity = identity(currentKey);
    return [...keys].map((key) => {
      const storedRaw = storage.getItem(key);
      const current = key === currentKey;
      const raw = current ? JSON.stringify(currentNotes) : storedRaw;
      const data = current ? currentNotes : parse(raw);
      const items = entries(data);
      const numbers = items.map(([id]) => Number(id));
      const info = identity(key);
      return {
        key, raw, data, current, ...info,
        sameProject: Boolean(info.project && info.project === currentIdentity.project),
        sameSnapshot: Boolean(info.rows && info.rows === currentIdentity.rows),
        entries: items.length,
        confirmed: items.filter(([, item]) => !item.recoveredUnverified && Boolean(item.manualDone)).length,
        unverified: items.filter(([, item]) => item.recoveredUnverified).length,
        bytes: 2 * (key.length + ((current ? raw : storedRaw)?.length || 0)),
        minIndex: numbers.length ? Math.min(...numbers) : null,
        maxIndex: numbers.length ? Math.max(...numbers) : null,
        parseFailed: data === null,
      };
    }).sort((a, b) => Number(b.current) - Number(a.current)
      || Number(b.sameSnapshot) - Number(a.sameSnapshot)
      || Number(b.sameProject) - Number(a.sameProject)
      || b.entries - a.entries || a.key.localeCompare(b.key));
  }

  function plan(data, rows, currentNotes, { sameSnapshot = false, byIndex = false, revisionTextFor = (item) => item.revisionText || "" } = {}) {
    const items = entries(data);
    const rowMap = new Map(rows.map((row) => [row.index, row]));
    const sourceMap = new Map(items.map(([id, item]) => [Number(id), item]));
    let pairs;
    if (sameSnapshot || byIndex) {
      pairs = items.filter(([id]) => rowMap.has(Number(id))).map(([id, item]) => ({
        from: Number(id), to: Number(id),
        verified: !byIndex && !item.recoveredUnverified
          && (!item.rowSig || item.rowSig === rowMap.get(Number(id)).signature),
      }));
    } else {
      const result = alignLegacyNotes(items.map(([id, item]) => ({
        from: Number(id), signature: item.recoveredUnverified ? "" : String(item.rowSig || ""), text: revisionTextFor(item),
      })), rows);
      pairs = result.pairs.map((pair) => {
        const item = sourceMap.get(pair.from);
        // 两条都是确定性证据：行签名对得上，或记录里的「修改结果」与目标行正文逐字相同
        // （那一行现在的正文就是人工批准并写回的成品）。证据成立就不该退回「需逐行核验」。
        return { ...pair, verified: !item.recoveredUnverified && (Boolean(pair.textConfirmed)
          || (Boolean(item.rowSig) && item.rowSig === rowMap.get(pair.to)?.signature)) };
      });
    }
    const occupiedPairs = pairs.filter((pair) => Object.hasOwn(currentNotes, String(pair.to)));
    const available = pairs.filter((pair) => !Object.hasOwn(currentNotes, String(pair.to)));
    return {
      pairs: available, occupied: occupiedPairs.length, unmatched: items.length - pairs.length,
      verified: available.filter((pair) => pair.verified).length,
      unverified: available.filter((pair) => !pair.verified).length,
      // 本页已有记录、但旧记录里的「修改结果」就是这一行现在的正文：可证明的人工确认由调用方还回去。
      approved: occupiedPairs.filter((pair) => pair.verified && pair.textConfirmed)
        .map((pair) => ({ from: pair.from, to: pair.to })),
    };
  }

  function backup(spaces) {
    return { format: "betweenlines-notes", version: 1, spaces: spaces.map(({ key, raw }) => ({ key, raw })) };
  }

  function decodeBackup(payload) {
    if (!record(payload)) throw new Error("文件不是备注备份对象。");
    if (payload.format === "betweenlines-notes") {
      if (payload.version !== 1 || !Array.isArray(payload.spaces) || !payload.spaces.length) throw new Error("不支持这个备注备份版本或备份为空。");
      const seen = new Set();
      return payload.spaces.map((space) => {
        if (!record(space) || typeof space.key !== "string" || !space.key.startsWith(prefix)
          || auxiliary(space.key) || typeof space.raw !== "string" || seen.has(space.key)) throw new Error("备份中含无效或重复的空间。");
        seen.add(space.key);
        return { key: space.key, raw: space.raw };
      });
    }
    // 兼容旧的全空间备份，以及旧版单空间导出的裸备注对象。
    if (Object.keys(payload).length && Object.keys(payload).every((key) => key.startsWith(prefix))) {
      const spaces = Object.entries(payload).filter(([key]) => !auxiliary(key)).map(([key, data]) => {
        const raw = JSON.stringify(data);
        if (!parse(raw)) throw new Error("旧备份中含无法识别的备注数据。");
        return { key, raw };
      });
      if (spaces.length) return spaces;
    }
    const raw = JSON.stringify(payload);
    if (entries(payload).length && parse(raw)) return [{ key: prefix + "legacy-file", raw }];
    throw new Error("文件里没有识别到备注空间，请选择本面板导出的 JSON。");
  }

  // 文件备份只登记独立空间；同名数据不会覆盖正在使用的页面或任何历史空间。
  function importBackup(storage, spaces, currentKey, now = Date.now()) {
    const imported = [];
    let skipped = 0;
    let error = null;
    const currentInfo = identity(currentKey);
    for (const space of spaces) {
      let key = space.key;
      try {
        // 裸备注对象没有来源项目。导入到具体工作台时把它归入当前项目的
        // 命名空间；带有明确空间键的备份保留来源项目，避免跨项目记录混入当前历史。
        if (key === prefix + "legacy-file" && currentInfo.project) {
          key = `${prefix}${currentInfo.version || "v7"}:${currentInfo.project}:legacy-file`;
        }
        const base = key.replace(/:import-\d+(?:-\d+)?$/, "");
        let duplicate = storage.getItem(key) === space.raw;
        for (let index = 0; !duplicate && index < storage.length; index += 1) {
          const existing = storage.key(index);
          if (existing && (existing === base || existing.startsWith(base + ":import-"))) {
            duplicate = storage.getItem(existing) === space.raw;
          }
        }
        if (duplicate) { skipped += 1; continue; }
        if (key === currentKey || storage.getItem(key) !== null || key === prefix + "legacy-file") {
          key = base + ":import-" + now;
          let counter = 1;
          while (storage.getItem(key) !== null) key = base + ":import-" + now + "-" + counter++;
        }
        storage.setItem(key, space.raw);
        imported.push(key);
      } catch (failure) { error = failure; break; }
    }
    return { imported, skipped, failed: spaces.length - imported.length - skipped, error };
  }

  return { prefix, auxiliary, entries, parse, identity, storageFailureKind, storageUsage,
    inventory, plan, backup, decodeBackup, importBackup };
}

module.exports = { createNotesTools };
