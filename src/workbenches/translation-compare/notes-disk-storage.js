// 浏览器同步读取会话镜像，磁盘写入按版本串行提交；不把提交排队误报为已保存。
function createDiskNotesStorage({ bootstrap, browserStorage, request, currentKey, onStateChange = () => {} }) {
  const values = new Map();
  const confirmed = new Map();
  const pending = new Map();
  const migrations = new Map();
  let running = null;
  let failure = bootstrap?.error ? new Error(bootstrap.error) : null;
  let blocked = Boolean(failure);
  let cleanupWarning = "";
  const isSpace = (key) => typeof key === "string" && key.startsWith("translation-compare-notes-")
    && !/:previous-notes-migration-|:manual-done-prefix-/.test(key);

  for (const space of bootstrap?.spaces || []) {
    confirmed.set(space.key, space);
    if (space.raw !== null) values.set(space.key, space.raw);
  }
  function collectBrowser() {
    try {
      for (let index = 0; index < browserStorage.length; index += 1) {
        const key = browserStorage.key(index);
        if (!isSpace(key)) continue;
        const raw = browserStorage.getItem(key);
        if (raw === null) continue;
        migrations.set(key, raw);
        if (!confirmed.has(key) && !values.has(key)) values.set(key, raw);
      }
    } catch { cleanupWarning = "无法读取旧浏览器记录；磁盘备注仍可使用，请保留原浏览器数据。"; }
  }
  collectBrowser();

  async function call(action, body) {
    const response = await request("/api/notes/spaces" + (action ? "/" + action : ""), action
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || "无法连接本地备注存储。");
      if (response.status === 409) error.name = "NotesConflictError";
      throw error;
    }
    return data;
  }
  function verify(space, raw) {
    if (!space || typeof space.key !== "string" || typeof space.version !== "string" || space.raw !== raw) {
      throw new Error("磁盘备注回读核验失败，浏览器原记录仍保留。");
    }
  }
  function accept(space) {
    confirmed.set(space.key, space);
  }
  function acceptImport(space, sourceKey) {
    const previous = confirmed.get(currentKey);
    if ((space.key === currentKey && previous && previous.raw !== space.raw)
      || (sourceKey === currentKey && !previous && space.key !== sourceKey)) {
      blocked = true;
      failure = new Error("当前空间在迁移或导入期间被其他页面修改；旧记录已归档，请导出本页后刷新核对。");
      return false;
    }
    accept(space);
    return true;
  }
  async function migrateBrowser() {
    for (const [key, raw] of migrations) {
      const { space } = await call("import", { key, raw });
      verify(space, raw);
      const accepted = acceptImport(space, key);
      if (accepted && (space.key !== key || (!values.has(space.key) && !pending.has(space.key)))) values.set(space.key, raw);
      try {
        if (browserStorage.getItem(key) === raw) browserStorage.removeItem(key);
        else cleanupWarning = "旧浏览器记录在迁移期间发生变化，已保留；请关闭旧页面后点击刷新重新迁移。";
      } catch { cleanupWarning = "备注已写入电脑，但浏览器副本未能清理；不会影响磁盘保存。"; }
      migrations.delete(key);
      onStateChange();
    }
  }
  function pump() {
    if (running || failure || blocked) return running;
    running = Promise.resolve().then(async () => {
      await migrateBrowser();
      while (pending.size && !blocked) {
        const [key, raw] = pending.entries().next().value;
        let space;
        try {
          ({ space } = await call(raw === null ? "delete" : "write", {
            key, ...(raw === null ? {} : { raw }), expectedVersion: confirmed.get(key)?.version ?? null,
          }));
        } catch (error) {
          if (raw === null && confirmed.get(key)?.raw != null && pending.get(key) === null) {
            values.set(key, confirmed.get(key).raw);
          }
          throw error;
        }
        verify(space, raw);
        if (space.key !== key) throw new Error("磁盘备注空间不匹配。");
        accept(space);
        if (pending.get(key) === raw) {
          if (raw === null) values.delete(key);
          pending.delete(key);
        }
        onStateChange();
      }
    }).catch((error) => {
      failure = error;
      if (error.name === "NotesConflictError") blocked = true;
    }).finally(() => {
      running = null;
      onStateChange();
      if (!failure && !blocked && (pending.size || migrations.size)) pump();
    });
    return running;
  }
  function ensureWritable() {
    if (blocked) throw failure || new Error("备注空间版本冲突，请导出后刷新页面。");
  }
  async function flush() {
    ensureWritable();
    failure = null; // 显式重试，保留此前未成功写入的队列。
    do { await (running || pump()); } while (!failure && !blocked && (pending.size || migrations.size));
    if (failure || blocked) throw failure || new Error("备注空间版本冲突，请导出后刷新页面。");
  }
  async function refresh() {
    // 先完成本页待保存内容，再读取别页更改；失败时不得覆盖本页草稿。
    await flush();
    const data = await call("", null);
    const incoming = new Map(data.spaces.map((space) => [space.key, space]));
    if ((incoming.get(currentKey)?.version ?? null) !== (confirmed.get(currentKey)?.version ?? null)) {
      blocked = true;
      failure = new Error("本页空间已被其他页面修改，请导出本页记录后重新加载页面。");
      onStateChange();
      throw failure;
    }
    values.clear();
    confirmed.clear();
    for (const space of incoming.values()) {
      accept(space);
      if (space.raw !== null) values.set(space.key, space.raw);
    }
    collectBrowser();
    await flush();
    onStateChange();
  }
  async function markRecovery(id) {
    try {
      await flush();
      const saved = confirmed.get(currentKey);
      if (saved?.completedRecoveries?.includes(id)) return true;
      running = Promise.resolve().then(async () => {
        const { space } = await call("recovery", { key: currentKey, id, expectedVersion: saved?.version ?? null });
        verify(space, saved?.raw);
        accept(space);
        return true;
      }).catch((error) => {
        cleanupWarning = "备注已保存，但恢复标记未保存：" + error.message;
        return false;
      }).finally(() => {
        running = null;
        onStateChange();
        if (pending.size) pump();
      });
      return await running;
    } catch { return false; }
  }
  return {
    disk: true,
    directory: bootstrap?.directory || "",
    get length() { return values.size; },
    key(index) { return [...values.keys()][index] ?? null; },
    getItem(key) { return values.get(key) ?? null; },
    encode(raw) { return raw; },
    setItem(key, raw) {
      ensureWritable();
      if (!isSpace(key)) throw new Error("备注空间标识无效。");
      raw = String(raw);
      values.set(key, raw);
      pending.set(key, raw);
      pump();
    },
    removeItem(key) {
      ensureWritable();
      values.delete(key);
      pending.set(key, null);
      pump();
    },
    async importSpaces(spaces) {
      await flush();
      const imported = [];
      let skipped = 0;
      for (const item of spaces) {
        const { space } = await call("import", item);
        verify(space, item.raw);
        if (!acceptImport(space, item.key)) { onStateChange(); throw failure; }
        if (space.key !== currentKey) values.set(space.key, space.raw);
        if (!space.skipped) { imported.push(space.key); }
        else skipped += 1;
      }
      onStateChange();
      return { imported, skipped, failed: 0, error: null };
    },
    start() { pump(); },
    flush,
    refresh,
    markRecovery,
    hasRecovery(id) { return Boolean(confirmed.get(currentKey)?.completedRecoveries?.includes(id)); },
    snapshot() {
      return { pending: Boolean(pending.size || migrations.size || running), failed: Boolean(failure),
        blocked, message: failure?.message || "", cleanupWarning };
    },
  };
}

module.exports = { createDiskNotesStorage };
