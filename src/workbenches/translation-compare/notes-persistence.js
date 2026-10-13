// 翻译备注的保存会话；factory 同时用于生成页面与 Node 测试。
// 备注及签名仍由页面序列化，Storage adapter 保留压缩与完整性职责。
function createNotesPersistence({
  storage, key, initialRaw = null, initialBlocked = false, serialize,
  classifyFailure, onStateChange = () => {}, scheduler = { setTimeout, clearTimeout },
} = {}) {
  let baseline = initialRaw;
  let blocked = initialBlocked;
  let failed = false;
  let failureKind = "";
  let pending = false;
  let saveHandle = 0;
  let saveHandleType = "";

  function persist() {
    try {
      // 冲突时不调用 serialize，避免给尚未保存的内容补上行签名。
      if (blocked || storage.getItem(key) !== baseline) {
        blocked = true;
        return false;
      }
      const raw = serialize();
      if (raw !== baseline) storage.setItem(key, raw);
      baseline = raw;
      failed = false;
      failureKind = "";
      return true;
    } catch (error) {
      failed = true;
      failureKind = classifyFailure(error);
      return false;
    } finally {
      onStateChange();
    }
  }

  function cancelScheduledSave() {
    if (!pending) return;
    if (saveHandleType === "idle" && scheduler.cancelIdleCallback) {
      scheduler.cancelIdleCallback(saveHandle);
    } else {
      scheduler.clearTimeout(saveHandle);
    }
    pending = false;
    saveHandle = 0;
    saveHandleType = "";
  }

  return {
    persist,
    save({ immediate = false } = {}) {
      if (immediate) {
        cancelScheduledSave();
        persist();
        return;
      }
      if (pending) return;
      pending = true;
      const commit = () => {
        pending = false;
        saveHandle = 0;
        saveHandleType = "";
        persist();
      };
      if (scheduler.requestIdleCallback) {
        saveHandleType = "idle";
        saveHandle = scheduler.requestIdleCallback(commit, { timeout: 2000 });
      } else {
        saveHandleType = "timeout";
        saveHandle = scheduler.setTimeout(commit, 250);
      }
    },
    flush() {
      if (!pending) return;
      cancelScheduledSave();
      persist();
    },
    clearCurrent(onClear = () => {}) {
      // 显式清空按原时序先写，再让页面清内容/指标，最后认领新基线。
      // 写入或页面处理失败直接交给调用方；不取消排队保存，也不新增 UI 通知。
      storage.setItem(key, "{}");
      onClear();
      baseline = "{}";
      failed = false;
      failureKind = "";
      blocked = false;
    },
    observeStorageChange() {
      blocked = storage.getItem(key) !== baseline;
      onStateChange();
    },
    snapshot() {
      return Object.freeze({ blocked, failed, failureKind, pending });
    },
  };
}

module.exports = { createNotesPersistence };
