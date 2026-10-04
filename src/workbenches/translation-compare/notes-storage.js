// Synchronous, lossless storage keeps the existing save/conflict checks intact.
function createNotesStorage(storage, codec) {
  const prefix = "betweenlines-notes-lz-v1:";
  const isNotesKey = (key) => String(key).startsWith("translation-compare-notes-")
    && !/:previous-notes-migration-|:manual-done-prefix-/.test(key);
  const cache = new Map();

  function checksum(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function encode(raw) {
    const packed = prefix + JSON.stringify([raw.length, checksum(raw), codec.compressToUTF16(raw)]);
    return packed.length < raw.length ? packed : raw;
  }

  function decode(stored) {
    if (stored === null || !stored.startsWith(prefix)) return stored;
    try {
      const packed = JSON.parse(stored.slice(prefix.length));
      if (!Array.isArray(packed) || packed.length !== 3 || !Number.isSafeInteger(packed[0])
        || packed[0] < 0 || typeof packed[1] !== "string" || typeof packed[2] !== "string") return stored;
      const raw = codec.decompressFromUTF16(packed[2]);
      if (typeof raw === "string" && raw.length === packed[0] && checksum(raw) === packed[1]) return raw;
    } catch {}
    // A broken payload must reach the strict notes parser and remain exportable.
    return stored;
  }

  return {
    rawStorage: storage, encode, decode,
    get length() { return storage.length; },
    key(index) { return storage.key(index); },
    getItem(key) {
      const stored = storage.getItem(key);
      if (!isNotesKey(key)) return stored;
      const cached = cache.get(key);
      if (cached && cached.stored === stored) return cached.raw;
      const raw = decode(stored);
      cache.set(key, { stored, raw });
      return raw;
    },
    setItem(key, value) {
      const raw = String(value);
      const stored = isNotesKey(key) ? encode(raw) : raw;
      storage.setItem(key, stored);
      if (isNotesKey(key)) cache.set(key, { stored, raw });
    },
    removeItem(key) {
      storage.removeItem(key);
      cache.delete(key);
    },
  };
}

module.exports = { createNotesStorage };
