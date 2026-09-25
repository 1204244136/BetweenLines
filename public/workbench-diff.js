// 与页面状态无关的文本差异渲染。工作台只负责缓存结果和决定展示位置。
(function attachWorkbenchDiff(root) {
  function prefixSuffixDiffHtml(oldChars, newChars, escapeHtml) {
    let prefix = 0;
    while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) prefix += 1;
    let oldEnd = oldChars.length;
    let newEnd = newChars.length;
    while (oldEnd > prefix && newEnd > prefix && oldChars[oldEnd - 1] === newChars[newEnd - 1]) {
      oldEnd -= 1;
      newEnd -= 1;
    }
    return [
      escapeHtml(oldChars.slice(0, prefix).join("")),
      oldEnd > prefix ? "<del>" + escapeHtml(oldChars.slice(prefix, oldEnd).join("")) + "</del>" : "",
      newEnd > prefix ? "<ins>" + escapeHtml(newChars.slice(prefix, newEnd).join("")) + "</ins>" : "",
      escapeHtml(oldChars.slice(oldEnd).join("")),
    ].join("");
  }

  function compactDiffParts(parts, escapeHtml) {
    const chunks = [];
    for (const part of parts) {
      const last = chunks[chunks.length - 1];
      if (last && last.type === part.type) last.value += part.value;
      else chunks.push({ ...part });
    }
    return chunks.map((part) => {
      const value = escapeHtml(part.value);
      if (part.type === "ins") return "<ins>" + value + "</ins>";
      if (part.type === "del") return "<del>" + value + "</del>";
      return value;
    }).join("");
  }

  function computeInlineDiffHtml(oldValue, newValue, escapeHtml) {
    const oldChars = Array.from(oldValue);
    const newChars = Array.from(newValue);
    if (oldChars.length * newChars.length > 50000) return prefixSuffixDiffHtml(oldChars, newChars, escapeHtml);
    const width = newChars.length + 1;
    const dp = new Uint16Array((oldChars.length + 1) * width);
    for (let i = 1; i <= oldChars.length; i += 1) {
      for (let j = 1; j <= newChars.length; j += 1) {
        const index = i * width + j;
        dp[index] = oldChars[i - 1] === newChars[j - 1]
          ? dp[(i - 1) * width + j - 1] + 1
          : Math.max(dp[(i - 1) * width + j], dp[i * width + j - 1]);
      }
    }
    const parts = [];
    let i = oldChars.length;
    let j = newChars.length;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && oldChars[i - 1] === newChars[j - 1]) {
        parts.push({ type: "same", value: oldChars[i - 1] }); i -= 1; j -= 1;
      } else if (j > 0 && (i === 0 || dp[i * width + j - 1] >= dp[(i - 1) * width + j])) {
        parts.push({ type: "ins", value: newChars[j - 1] }); j -= 1;
      } else {
        parts.push({ type: "del", value: oldChars[i - 1] }); i -= 1;
      }
    }
    return compactDiffParts(parts.reverse(), escapeHtml);
  }

  function createDiffRenderer({ escapeHtml, maxCacheSize = 3000 } = {}) {
    const cache = new Map();
    return function inlineDiffHtml(oldText, newText) {
      const oldValue = String(oldText || "");
      const newValue = String(newText || "");
      if (!oldValue && !newValue) return "";
      if (oldValue === newValue) return escapeHtml(newValue);
      const key = oldValue + "\0" + newValue;
      if (cache.has(key)) return cache.get(key);
      const html = computeInlineDiffHtml(oldValue, newValue, escapeHtml);
      if (cache.size >= maxCacheSize) cache.delete(cache.keys().next().value);
      cache.set(key, html);
      return html;
    };
  }

  root.WorkbenchDiff = { compactDiffParts, computeInlineDiffHtml, createDiffRenderer, prefixSuffixDiffHtml };
})(typeof globalThis === "undefined" ? this : globalThis);
