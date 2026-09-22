(() => {
  const rowData = document.getElementById("rowData");
  const allRows = rowData ? JSON.parse(rowData.textContent || "[]") : [];
  const app = document.querySelector(".speaker-app");
  const tableFrame = document.getElementById("speakerTableFrame");
  const tbody = document.querySelector("#speakerTable tbody");
  const search = document.getElementById("speakerQuery");
  const emptyState = document.getElementById("speakerEmpty");
  const pagination = document.getElementById("speakerPagination");
  const paginationStatus = document.getElementById("speakerPaginationStatus");
  const pageInput = document.getElementById("speakerPageInput");
  const pageTotal = document.getElementById("speakerPageTotal");
  const pageSize = document.getElementById("speakerPageSize");
  const exportButton = document.getElementById("speakerExport");
  const storageKey = String(window.speakerStorageKey || "between-lines:speaker-attribution");
  const pageMeta = window.speakerPageMeta || {};
  const statusLabels = {
    "needs-review": "待确认",
    confirmed: "已确认",
    written: "已写回",
    unknown: "未知",
    narration: "旁白",
    multiple: "多人",
  };

  let notes = readNotes();
  let filteredRows = allRows;
  let currentPage = 1;
  let statusFilter = "all";
  let alignmentFilter = "all";
  let onlyPending = false;
  let saveTimer = 0;
  let filterTimer = 0;

  function readNotes() {
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey) || "{}");
      return saved && typeof saved === "object" ? saved : {};
    } catch (_) {
      return {};
    }
  }

  function flushNotes() {
    if (saveTimer) window.clearTimeout(saveTimer);
    saveTimer = 0;
    try { localStorage.setItem(storageKey, JSON.stringify(notes)); } catch (_) { /* 本地存储可能被禁用 */ }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = window.setTimeout(flushNotes, 180);
  }

  async function apiFetch(url, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    const isApiRequest = String(url).startsWith("/api/");
    if (!isApiRequest || ["GET", "HEAD", "OPTIONS"].includes(method)) {
      return fetch(url, options);
    }
    const meta = document.querySelector('meta[name="transcomparator-session-token"]');
    const token = meta?.getAttribute("content") || "";
    const headers = { ...(options.headers || {}) };
    if (token) headers["X-TransComparator-Token"] = token;
    if (options.body != null && !Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(url, { ...options, headers });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function languageTag(value, fallback = "") {
    return {
      jp: "ja",
      cn: "zh-Hans",
      tw: "zh-Hant",
      en: "en",
      ko: "ko",
    }[String(value || "").toLowerCase()] || fallback;
  }

  function recordFor(row) {
    const saved = notes[row.id];
    const isWritten = Boolean(row.isWritten || saved?.isWritten || saved?.status === "written");
    const hasManualContent = Boolean(saved && (saved.speaker?.trim() || saved.evidence?.trim()));
    const isManuallyEdited = Boolean(saved && (saved.reviewed || (saved.manual && hasManualContent)));
    if (isWritten && !isManuallyEdited) {
      return {
        speaker: String(saved?.speaker || row.speaker || ""),
        confidence: "1.0",
        status: "written",
        evidence: String(saved?.evidence || row.evidence || "原文件中已存在说话人写回标识"),
        reviewed: true,
        manual: false,
        isWritten: true,
        fromAi: false,
      };
    }
    if (isManuallyEdited) {
      return {
        speaker: String(saved.speaker ?? ""),
        confidence: String(saved.confidence ?? ""),
        status: Object.prototype.hasOwnProperty.call(statusLabels, saved.status) ? saved.status : "needs-review",
        evidence: String(saved.evidence ?? ""),
        reviewed: Boolean(saved.reviewed),
        manual: Boolean(saved.manual),
        isWritten: Boolean(saved.isWritten || saved.status === "written"),
        fromAi: Boolean(saved.fromAi),
      };
    }
    if (row.prediction && !row.prediction.error) {
      const p = row.prediction;
      // 无论 AI 模型自评置信度多高，未经人工确认前，状态一律为待确认 (needs-review)
      const currentStatus = saved?.status && Object.prototype.hasOwnProperty.call(statusLabels, saved.status)
        ? saved.status
        : "needs-review";
      return {
        speaker: String(p.speaker || saved?.speaker || ""),
        confidence: String(p.confidence != null ? p.confidence : (saved?.confidence || "")),
        status: currentStatus,
        evidence: String(p.evidence || saved?.evidence || ""),
        reviewed: false,
        manual: false,
        isWritten: false,
        fromAi: true,
        aiSuggestedStatus: p.status || "confirmed",
      };
    }
    const fallback = saved || {};
    return {
      speaker: String(fallback.speaker || ""),
      confidence: String(fallback.confidence || ""),
      status: Object.prototype.hasOwnProperty.call(statusLabels, fallback.status) ? fallback.status : "needs-review",
      evidence: String(fallback.evidence || ""),
      reviewed: false,
      manual: false,
      isWritten: Boolean(fallback.isWritten || fallback.status === "written"),
      fromAi: false,
    };
  }

  function writeRecord(rowId, field, value, { isManual = true } = {}) {
    notes[rowId] ||= {};
    notes[rowId][field] = String(value ?? "");
    if (isManual) {
      notes[rowId].manual = true;
      notes[rowId].reviewed = true;
    }
    scheduleSave();
  }

  function normalizedStatus(row) {
    return recordFor(row).status;
  }



  function rowText(row) {
    const record = recordFor(row);
    return [
      row.id,
      row.chapter,
      row.sourceText,
      row.parallelText,
      record.speaker,
      record.status,
      record.evidence,
      (row.comparison?.sharedTokens || []).join(" "),
    ].join(" ").toLowerCase();
  }

  function comparisonSignals(row) {
    const comparison = row.comparison;
    if (!comparison) return ["没有可供对照的主文本"];
    const signals = [];
    if (comparison.sharedTokens?.length) signals.push("共享片段 " + comparison.sharedTokens.slice(0, 3).join(" · "));
    if (comparison.numberScore === 1) signals.push("数字一致");
    if (comparison.numberScore === 0) signals.push("数字不同");
    if (comparison.punctuationScore >= 0.66) signals.push("句末结构接近");
    if (comparison.dialogueScore === 1 && comparison.dialogue) signals.push("对话标记一致");
    if (comparison.issues?.length) signals.push(...comparison.issues);
    if (!signals.length) signals.push("没有明显共享片段");
    return signals;
  }

  function comparisonSignalText(row) {
    return comparisonSignals(row)[0] || "没有明显共享片段";
  }

  function alignmentLabel(row) {
    const status = row.alignment?.status || "";
    return {
      "aligned": "已对齐",
      "aligned-low-confidence": "低置信对齐",
      "unmatched-parallel": "主文本未匹配",
      "unmatched-source": "原文未匹配",
      "source-only": "仅原文",
    }[status] || (status || "未对齐");
  }

  function renderComparison(row) {
    if (!pageMeta.bilingual || !row.parallelText) return "";
    const comparison = row.comparison || {};

    const signals = comparisonSignals(row)
      .map((signal) => '<span class="speaker-signal">' + escapeHtml(signal) + "</span>")
      .join("");
    return '<details class="speaker-comparison">'
      + '<summary><span>文本对照 · ' + escapeHtml(comparisonSignalText(row)) + '</span><span>' + escapeHtml(alignmentLabel(row)) + "</span></summary>"
      + '<div class="speaker-comparison-body">'
      + '<div class="speaker-signal-list">' + signals + "</div>"
      + '<div>对照分数 ' + escapeHtml(Math.round((comparison.score || 0) * 100) + "%")
      + ' · 对齐关系 ' + escapeHtml(row.alignment?.relation || "") + "</div>"
      + (comparison.issues?.length ? '<div>需要注意：' + escapeHtml(comparison.issues.join("、")) + "</div>" : "")
      + "</div></details>";
  }

  function renderContext(row) {
    if (!Array.isArray(row.context) || !row.context.length) return "";
    const items = row.context.map((item) => '<div class="speaker-context-item ' + (item.relation === "target" ? "is-target" : "") + '">' + escapeHtml(item.text) + "</div>").join("");
    return '<details class="speaker-context"><summary>上下文 ' + escapeHtml(String(row.context.length)) + " 行</summary><div class=\"speaker-context-list\">" + items + "</div></details>";
  }

  function promptTextFor(row) {
    const system = pageMeta.prompt?.system || "";
    const attention = row.attention || {};
    const user = JSON.stringify({
      task: "speaker-attribution",
      attentionVersion: attention.version || pageMeta.attentionVersion || "",
      target: {
        index: row.index,
        sourceText: row.sourceText || "",
        parallelText: row.parallelText || "",
      },
      attention: {
        level: attention.level || "low",
        score: attention.score || 0,
        candidates: attention.candidates || [],
        focusedContext: attention.focus || [],
        needsMoreContext: Boolean(attention.needsMoreContext),
      },
      alignment: {
        status: row.alignment?.status || "",
        relation: row.alignment?.relation || "",
        score: row.alignment?.score ?? null,
        comparison: row.comparison || null,
      },
      outputSchema: pageMeta.prompt?.outputSchema || {},
    }, null, 2);
    return [system, user].filter(Boolean).join("\n\n");
  }

  function attentionLevelLabel(level) {
    return { high: "强", medium: "中", low: "弱" }[level] || level || "低";
  }

  function renderAttention(row) {
    const attention = row.attention;
    if (!attention) return "";
    const candidates = (attention.candidates || [])
      .map((candidate) => escapeHtml(candidate.name) + " " + escapeHtml(Math.round((candidate.score || 0) * 100) + "%"))
      .join("、") || "暂无候选";
    const focus = (attention.focus || [])
      .map((item) => '<div class="speaker-attention-item"><span>' + escapeHtml(item.relation === "target" ? "目标" : "上下文") + " · " + escapeHtml(Math.round((item.weight || 0) * 100) + "%") + '</span><span>' + escapeHtml(item.reasons?.join("、") || "相邻线索") + "</span></div>")
      .join("");
    const copyButton = promptTextFor(row)
      ? '<button type="button" class="speaker-copy" data-copy-prompt="' + escapeHtml(row.id) + '" title="复制说话人判断提示词">复制提示词</button>'
      : "";
    const levelLabel = attentionLevelLabel(attention.level);
    return '<details class="speaker-attention"><summary><span>归属证据 · ' + escapeHtml(levelLabel) + " · " + escapeHtml(Math.round((attention.score || 0) * 100) + "%") + '</span><span>' + escapeHtml(String(attention.focus?.length || 0)) + " 条证据</span></summary>"
      + '<div class="speaker-attention-body"><div>候选：' + candidates + "</div>"
      + '<div class="speaker-attention-list">' + focus + "</div>"
      + '<div class="speaker-attention-footer"><span>提示词 ' + escapeHtml(row.prompt?.version || pageMeta.prompt?.version || "") + "</span>" + copyButton + "</div></div></details>";
  }

  function renderPrediction(row) {
    if (!row.prediction && !row.isWritten) return "";
    const p = row.prediction || {};
    if (p.error) {
      return '<div class="speaker-ai-suggestion is-error">'
        + '<div class="speaker-ai-header"><span class="speaker-ai-badge speaker-ai-badge--error">AI 推断异常</span></div>'
        + '<div class="speaker-ai-evidence">' + escapeHtml(p.evidence || "推断失败") + '</div>'
        + '</div>';
    }
    const record = recordFor(row);
    const isWritten = record.status === "written" || record.isWritten;
    const conf = Math.round((p.confidence || (isWritten ? 1 : 0)) * 100);
    const badgeText = isWritten
      ? '<span class="speaker-ai-badge speaker-ai-badge--written">✓ 原文已写回</span>'
      : '<span class="speaker-ai-badge">AI 建议 (' + conf + '%)</span>';
    const writebackBtn = isWritten
      ? '<button type="button" class="speaker-writeback-row-btn is-written" data-action="writeback-row" data-row-id="' + escapeHtml(row.id) + '" title="已写回原文件，点击可再次覆盖写回">✓ 已写回</button>'
      : '<button type="button" class="speaker-writeback-row-btn" data-action="writeback-row" data-row-id="' + escapeHtml(row.id) + '" title="仅写回该行说话人到原文件">写回原文件</button>';

    return '<div class="speaker-ai-suggestion' + (isWritten ? " is-written" : "") + '">'
      + '<div class="speaker-ai-header">' + badgeText + writebackBtn + '</div>'
      + '</div>';
  }

  function renderParallel(row) {
    if (!pageMeta.bilingual) return "";
    const text = row.parallelText || "";
    const copyButton = text
      ? '<button type="button" class="speaker-copy" data-copy-text="' + escapeHtml(text) + '" title="复制主文本">复制</button>'
      : "";
    return '<td class="speaker-version"><div class="speaker-version-label"><span>主文本</span>' + copyButton + "</div>"
      + (text ? '<div class="speaker-text" lang="' + escapeHtml(languageTag(pageMeta.parallelLang, "und")) + '">' + escapeHtml(text) + "</div>" : '<div class="speaker-missing">没有匹配的主文本</div>')
      + renderComparison(row) + "</td>";
  }

  function renderRow(row) {
    const record = recordFor(row);
    const sourceLabel = pageMeta.bilingual ? "原文（参考）" : "主文本";
    const sourceCopy = row.sourceText
      ? '<button type="button" class="speaker-copy" data-copy-text="' + escapeHtml(row.sourceText) + '" title="复制' + sourceLabel + '">复制</button>'
      : "";
    const status = record.status;
    const isWritten = status === "written" || record.isWritten;
    const statusClass = status === "confirmed" ? " is-confirmed" : (isWritten ? " is-written" : "");
    const alignmentEvidence = row.alignment?.confidence || "none";
    const sourceCell = '<td class="speaker-version"><div class="speaker-version-label"><span>' + sourceLabel + "</span>" + sourceCopy + "</div>"
      + (row.sourceText ? '<div class="speaker-text" lang="' + escapeHtml(languageTag(pageMeta.sourceLang, "und")) + '">' + escapeHtml(row.sourceText) + "</div>" : '<div class="speaker-missing">没有原文行</div>')
      + renderContext(row) + "</td>";
    const confidenceValue = record.confidence || "";
    return '<tr class="speaker-row' + statusClass + '" data-row-id="' + escapeHtml(row.id) + '">'
      + '<td class="speaker-meta"><div class="speaker-row-head"><span class="speaker-index">#' + escapeHtml(row.index) + '</span><span class="speaker-state' + (isWritten ? " is-written" : "") + '" data-state-label>' + escapeHtml(statusLabels[status] || statusLabels["needs-review"]) + "</span></div>"
      + '<div class="speaker-chapter">' + escapeHtml(row.chapter || "未分章") + "</div>"
      + '<dl><div><dt>关系</dt><dd>' + escapeHtml(row.alignment?.relation || "") + "</dd></div>"
      + '<div><dt>对齐</dt><dd>' + escapeHtml(alignmentLabel(row)) + "</dd></div>"
      + '<div><dt>参考分数</dt><dd>' + escapeHtml(Math.round((row.alignment?.score || 0) * 100) + "%") + "</dd></div>"
      + '<div><dt>对齐证据</dt><dd>' + escapeHtml(alignmentEvidence) + "</dd></div></dl>"
      + '<div class="speaker-evidence">' + (row.alignment?.status === "aligned-low-confidence" ? "对齐证据不足，建议人工复核。" : (row.alignment?.status === "unmatched-parallel" ? "主文本未找到原文对应行。" : "保留完整原文行，不拆分归属范围。")) + "</div>"
      + renderAttention(row) + "</td>"
      + sourceCell
      + renderParallel(row)
      + '<td class="speaker-decision">'
      + renderPrediction(row)
      + '<div class="speaker-field speaker-decision-grid"><div><label for="speaker-' + escapeHtml(row.id) + '">说话人</label><input id="speaker-' + escapeHtml(row.id) + '" data-field="speaker" data-row-id="' + escapeHtml(row.id) + '" value="' + escapeHtml(record.speaker) + '" placeholder="输入角色或人物"></div><div><label for="confidence-' + escapeHtml(row.id) + '">置信度</label><input id="confidence-' + escapeHtml(row.id) + '" data-field="confidence" data-row-id="' + escapeHtml(row.id) + '" type="number" min="0" max="1" step="0.01" value="' + escapeHtml(confidenceValue) + '" placeholder="0-1"></div></div>'
      + '<div class="speaker-field"><label for="status-' + escapeHtml(row.id) + '">判断状态</label><select id="status-' + escapeHtml(row.id) + '" data-field="status" data-row-id="' + escapeHtml(row.id) + '">' + Object.entries(statusLabels).map(([value, label]) => '<option value="' + value + '"' + (status === value ? " selected" : "") + ">" + label + "</option>").join("") + "</select></div>"
      + '<div class="speaker-field"><label for="evidence-' + escapeHtml(row.id) + '">判断依据</label><textarea id="evidence-' + escapeHtml(row.id) + '" data-field="evidence" data-row-id="' + escapeHtml(row.id) + '" placeholder="记录上下文、称谓或语气线索">' + escapeHtml(record.evidence) + "</textarea></div></td></tr>";
  }

  function totalPages() { return Math.max(1, Math.ceil(filteredRows.length / Number(pageSize.value || 50))); }

  function updateStats() {
    let aiProcessed = 0;
    let confirmed = 0;
    let pending = 0;
    for (const row of allRows) {
      const record = recordFor(row);
      if ((row.prediction && row.prediction.speaker && !row.prediction.error) || record.status === "written") aiProcessed += 1;
      if (record.reviewed || record.status === "confirmed" || record.status === "written") {
        confirmed += 1;
      } else {
        pending += 1;
      }
    }
    const aiStat = document.getElementById("speakerAiProcessedCount");
    if (aiStat) aiStat.textContent = String(aiProcessed);
    document.getElementById("speakerConfirmedCount").textContent = String(confirmed);
    document.getElementById("speakerPendingCount").textContent = String(pending);
    const assignedEl = document.getElementById("speakerAssignedCount");
    if (assignedEl) assignedEl.textContent = String(aiProcessed);
    document.getElementById("speakerVisibleCount").textContent = String(filteredRows.length);
  }

  function updatePagination() {
    const visible = filteredRows.length;
    const total = totalPages();
    const size = Number(pageSize.value || 50);
    currentPage = Math.max(1, Math.min(currentPage, total));
    const start = visible ? ((currentPage - 1) * size) + 1 : 0;
    const end = visible ? Math.min(currentPage * size, visible) : 0;
    pagination.hidden = visible === 0;
    emptyState.classList.toggle("is-visible", visible === 0);
    pageInput.value = String(currentPage);
    pageInput.max = String(total);
    pageTotal.textContent = "/ " + total + " 页";
    paginationStatus.textContent = visible ? "第 " + start + "-" + end + " 行，共 " + visible + " 行" : "没有匹配的行";
    document.getElementById("speakerFirstPage").disabled = currentPage <= 1;
    document.getElementById("speakerPrevPage").disabled = currentPage <= 1;
    document.getElementById("speakerNextPage").disabled = currentPage >= total;
    document.getElementById("speakerLastPage").disabled = currentPage >= total;
  }

  function syncLayout() {
    const visibleRows = tbody.querySelectorAll("tr[data-row-id]").length;
    tableFrame.classList.toggle("is-fit-content", visibleRows <= 3);
    if (visibleRows <= 3) {
      document.querySelector(".speaker-wrap").style.setProperty("--speaker-results-height", "none");
      return;
    }
    const available = Math.max(320, window.innerHeight - tableFrame.getBoundingClientRect().top - 86);
    document.querySelector(".speaker-wrap").style.setProperty("--speaker-results-height", available + "px");
  }

  function resizeTextareas() {
    for (const textarea of tbody.querySelectorAll("textarea[data-field=\"evidence\"]")) {
      textarea.style.height = "auto";
      textarea.style.height = Math.min(textarea.scrollHeight + 2, Math.max(120, Math.round(window.innerHeight * 0.4))) + "px";
    }
  }

  function renderVisibleRows(reset = false) {
    if (reset) currentPage = 1;
    const size = Number(pageSize.value || 50);
    const total = totalPages();
    currentPage = Math.max(1, Math.min(currentPage, total));
    const start = (currentPage - 1) * size;
    tbody.innerHTML = filteredRows.slice(start, start + size).map(renderRow).join("");
    resizeTextareas();
    syncLayout();
    updatePagination();
    updateStats();
    tableFrame.scrollTop = 0;
  }

  function matches(row) {
    const query = String(search.value || "").trim().toLowerCase();
    const status = normalizedStatus(row);
    const alignmentStatus = row.alignment?.status || "";
    if (query && !rowText(row).includes(query)) return false;
    if (statusFilter !== "all" && status !== statusFilter) return false;
    if (alignmentFilter === "low" && alignmentStatus !== "aligned-low-confidence") return false;
    if (alignmentFilter === "unmatched" && !alignmentStatus.startsWith("unmatched")) return false;
    if (onlyPending && status !== "needs-review") return false;
    return true;
  }

  function applyFilters(reset = true) {
    filteredRows = allRows.filter(matches);
    renderVisibleRows(reset);
  }

  function updateRowState(rowId, field, value) {
    const row = allRows.find((item) => item.id === rowId);
    if (!row) return;
    writeRecord(rowId, field, value);
    const tr = tbody.querySelector('tr[data-row-id="' + rowId + '"]');
    if (tr && field === "status") {
      tr.classList.toggle("is-confirmed", value === "confirmed");
      const label = tr.querySelector("[data-state-label]");
      if (label) label.textContent = statusLabels[value] || statusLabels["needs-review"];
      if (statusFilter !== "all" || onlyPending) applyFilters(false);
    }
    updateStats();
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function batchWriteback(minConfidence = 0) {
    const btn = minConfidence > 0 ? document.getElementById("speakerBatchAdopt") : exportButton;
    const rowsToWrite = allRows.filter((row) => {
      const record = recordFor(row);
      if (!record.speaker.trim()) return false;
      if (minConfidence > 0) {
        const conf = Number(record.confidence) || 0;
        return conf >= minConfidence;
      }
      return true;
    });

    if (!rowsToWrite.length) {
      window.alert(minConfidence > 0 ? "未找到置信度 ≥ 80% 且已指定说话人的行。" : "未找到已填写说话人的行。");
      return;
    }

    const originalText = btn?.textContent || "批量写回";
    if (btn) {
      btn.textContent = "写回中...";
      btn.disabled = true;
    }

    const rows = rowsToWrite.map((row) => {
      const record = recordFor(row);
      return {
        index: row.index,
        relation: row.alignment?.relation || "",
        alignment: alignmentLabel(row),
        source: row.sourceText,
        parallel: row.parallelText,
        speaker: record.speaker,
        confidence: record.confidence,
        status: statusLabels[record.status],
        evidence: record.evidence,
      };
    });
    const rowTexts = speakerRowTexts(rowsToWrite.reduce((max, row) => Math.max(max, Number(row.index) || 0), 0));

    try {
      const response = await apiFetch("/api/speaker-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, rowTexts }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "批量写回失败");

      // 定位失败与「有多处同段」都没落到文件上，都不能标记为已写回。
      const unwritten = [...(Array.isArray(result.missed) ? result.missed : []), ...(Array.isArray(result.ambiguous) ? result.ambiguous : [])];
      const missedIndexes = new Set(unwritten.map((item) => String(item?.index)));
      let written = 0;
      for (const row of rowsToWrite) {
        if (missedIndexes.has(String(row.index))) continue;
        updateRowState(row.id, "status", "written");
        notes[row.id] ||= {};
        notes[row.id].isWritten = true;
        written += 1;
      }
      scheduleSave();
      if (missedIndexes.size) {
        window.alert(`已写回 ${written} 行；${missedIndexes.size} 行未写入（原文件中定位不到或多处同段），仍留在复核视野里。`);
      }
      if (btn) {
        btn.textContent = `已写回 ${result.updated} 行`;
        window.setTimeout(() => {
          btn.textContent = originalText;
          btn.disabled = false;
        }, 3000);
      }
      renderVisibleRows(false);
    } catch (error) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = originalText;
      }
      window.alert(error.message || String(error));
    }
  }

  function updateStats() {
    let aiProcessed = 0;
    let confirmed = 0;
    let pending = 0;
    for (const row of allRows) {
      const record = recordFor(row);
      if (row.prediction && row.prediction.speaker && !row.prediction.error) aiProcessed += 1;
      if (record.status === "confirmed") {
        confirmed += 1;
      } else {
        pending += 1;
      }
    }
    const aiStat = document.getElementById("speakerAiProcessedCount");
    if (aiStat) aiStat.textContent = String(aiProcessed);
    document.getElementById("speakerConfirmedCount").textContent = String(confirmed);
    document.getElementById("speakerPendingCount").textContent = String(pending);
    document.getElementById("speakerVisibleCount").textContent = String(filteredRows.length);
  }

  function copyText(value) {
    const text = String(value || "");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
      return;
    }
    const helper = document.createElement("textarea");
    helper.value = text;
    document.body.appendChild(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }

  document.querySelectorAll("[data-status-filter]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-status-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
    statusFilter = button.dataset.statusFilter || "all";
    applyFilters(true);
  }));
  document.querySelectorAll("[data-alignment-filter]").forEach((button) => button.addEventListener("click", () => {
    document.querySelectorAll("[data-alignment-filter]").forEach((item) => item.classList.toggle("is-active", item === button));
    alignmentFilter = button.dataset.alignmentFilter || "all";
    applyFilters(true);
  }));
  document.getElementById("speakerPendingOnly").addEventListener("click", (event) => {
    onlyPending = !onlyPending;
    event.currentTarget.classList.toggle("is-active", onlyPending);
    event.currentTarget.setAttribute("aria-pressed", String(onlyPending));
    applyFilters(true);
  });
  document.getElementById("speakerClearFilters").addEventListener("click", () => {
    search.value = "";
    statusFilter = "all";
    alignmentFilter = "all";
    onlyPending = false;
    document.querySelectorAll("[data-status-filter]").forEach((item) => item.classList.toggle("is-active", item.dataset.statusFilter === "all"));
    document.querySelectorAll("[data-alignment-filter]").forEach((item) => item.classList.toggle("is-active", item.dataset.alignmentFilter === "all"));
    document.getElementById("speakerPendingOnly").classList.remove("is-active");
    document.getElementById("speakerPendingOnly").setAttribute("aria-pressed", "false");
    applyFilters(true);
  });
  search.addEventListener("input", () => {
    window.clearTimeout(filterTimer);
    filterTimer = window.setTimeout(() => applyFilters(true), 100);
  });
  // 单语工作台没有对照列，这个开关不会渲染；只在双语页面绑定。
  document.getElementById("speakerShowParallel")?.addEventListener("change", (event) => app.classList.toggle("hide-parallel", !event.currentTarget.checked));
  document.getElementById("speakerShowContext").addEventListener("change", (event) => app.classList.toggle("hide-context", !event.currentTarget.checked));
  if (exportButton) {
    exportButton.addEventListener("click", () => batchWriteback(0));
  }
  const batchAdoptBtn = document.getElementById("speakerBatchAdopt");
  if (batchAdoptBtn) {
    batchAdoptBtn.addEventListener("click", () => batchWriteback(0.8));
  }
  pageSize.addEventListener("change", () => renderVisibleRows(true));
  pageInput.addEventListener("change", () => {
    currentPage = Number(pageInput.value || 1);
    renderVisibleRows(false);
  });
  document.getElementById("speakerFirstPage").addEventListener("click", () => { currentPage = 1; renderVisibleRows(false); });
  document.getElementById("speakerPrevPage").addEventListener("click", () => { currentPage -= 1; renderVisibleRows(false); });
  document.getElementById("speakerNextPage").addEventListener("click", () => { currentPage += 1; renderVisibleRows(false); });
  document.getElementById("speakerLastPage").addEventListener("click", () => { currentPage = totalPages(); renderVisibleRows(false); });
  // 写回要带上目标列的**整卷行序**（第 i 行对应下标 i-1）：写回定位按行序推进锚点，
  // 未标注的行也要按自己的文本先占住位置，同一句发话在卷里出现多次时才不会把标记写到前一处。
  // 只发到要写的最后一行为止——更靠后的行不参与锚点。
  function speakerRowTexts(limit) {
    const list = new Array(Math.max(0, limit)).fill("");
    for (const row of allRows) {
      const index = Number(row.index);
      if (!Number.isInteger(index) || index < 1 || index > limit) continue;
      list[index - 1] = String(row.parallelText || row.sourceText || "");
    }
    return list;
  }

  async function writebackSingleRow(rowId, button) {
    const row = allRows.find((item) => item.id === rowId);
    if (!row) return;
    const record = recordFor(row);
    if (!record.speaker.trim()) {
      window.alert("该行尚未指定说话人，无法写回。");
      return;
    }
    const originalText = button.textContent;
    button.textContent = "写回中...";
    button.disabled = true;
    try {
      const response = await apiFetch("/api/speaker-export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          row: {
            index: row.index,
            relation: row.alignment?.relation || "",
            alignment: alignmentLabel(row),
            source: row.sourceText,
            parallel: row.parallelText,
            speaker: record.speaker,
            confidence: record.confidence,
            status: statusLabels[record.status],
            evidence: record.evidence,
          },
          rowTexts: speakerRowTexts(Number(row.index) || 0),
        }),
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || "写回失败");
      if (result.updated !== 1 && !result.skipped) {
        const detail = (Array.isArray(result.ambiguous) && result.ambiguous[0]) || (Array.isArray(result.missed) && result.missed[0]);
        const reason = detail && detail.reason ? detail.reason : "原文件中没有匹配的段落。";
        throw new Error("写回未生效：" + reason);
      }
      updateRowState(rowId, "status", "written");
      notes[rowId] ||= {};
      notes[rowId].isWritten = true;
      scheduleSave();
      button.textContent = "✓ 已写回";
      button.classList.add("is-written");
      window.setTimeout(() => {
        button.textContent = "写回原文件";
        button.disabled = false;
        button.classList.remove("is-written");
      }, 2500);
    } catch (error) {
      button.disabled = false;
      button.textContent = originalText;
      window.alert(error.message || String(error));
    }
  }

  tbody.addEventListener("click", (event) => {
    const writebackBtn = event.target.closest('button[data-action="writeback-row"]');
    if (writebackBtn) {
      const rowId = writebackBtn.dataset.rowId;
      writebackSingleRow(rowId, writebackBtn);
      return;
    }
    const copyButton = event.target.closest("[data-copy-text]");
    if (copyButton) copyText(copyButton.dataset.copyText || "");
    const promptButton = event.target.closest("[data-copy-prompt]");
    if (promptButton) {
      const row = allRows.find((item) => item.id === promptButton.dataset.copyPrompt);
      if (row) copyText(promptTextFor(row));
    }
  });
  tbody.addEventListener("focusin", (event) => {
    const row = event.target.closest("tr[data-row-id]");
    if (row) row.classList.add("is-editing");
  });
  tbody.addEventListener("focusout", (event) => {
    const row = event.target.closest("tr[data-row-id]");
    if (row) row.classList.remove("is-editing");
  });
  tbody.addEventListener("input", (event) => {
    const field = event.target.closest("[data-field]");
    if (!field) return;
    updateRowState(field.dataset.rowId, field.dataset.field, field.value);
    if (field.matches("textarea")) resizeTextareas();
  });
  tbody.addEventListener("change", (event) => {
    const field = event.target.closest("[data-field]");
    if (field) updateRowState(field.dataset.rowId, field.dataset.field, field.value);
  });
  window.addEventListener("resize", syncLayout);
  window.addEventListener("pagehide", flushNotes);

  // --- AI 说话人推断客户端引擎 ---
  const aiPanel = document.getElementById("speakerAiPanel");
  const aiProvider = document.getElementById("speakerAiProvider");
  const aiBaseUrl = document.getElementById("speakerAiBaseUrl");
  const aiApiKey = document.getElementById("speakerAiApiKey");
  const aiModel = document.getElementById("speakerAiModel");
  const aiRefreshModelsBtn = document.getElementById("speakerAiRefreshModels");
  const aiReasoningField = document.getElementById("speakerAiReasoningField");
  const aiReasoningEffort = document.getElementById("speakerAiReasoningEffort");
  const aiConcurrency = document.getElementById("speakerAiConcurrency");
  const aiStartBtn = document.getElementById("speakerAiStart");
  const aiStopBtn = document.getElementById("speakerAiStop");
  const aiClearCacheBtn = document.getElementById("speakerAiClearCache");
  const aiStatusText = document.getElementById("speakerAiStatusText");
  const aiProgressWrap = document.getElementById("speakerAiProgressWrap");
  const aiProgressBar = document.getElementById("speakerAiProgressBar");
  const aiSummaryBadge = document.getElementById("speakerAiSummaryBadge");
  const aiModelHint = document.getElementById("speakerAiModelHint");

  const AI_CONFIG_KEY = "between-lines:speaker-ai:config";
  const AI_PREDICTIONS_KEY = window.speakerStorageKey + ":predictions";

  let aiRunning = false;
  let aiAbortController = null;
  let aiRunSequence = 0;
  let aiActiveRunId = 0;

  const thinkingLevelLabels = {
    "": "模型默认",
    off: "关闭思考",
    none: "无",
    minimal: "最小",
    low: "低",
    medium: "中",
    high: "高",
    xhigh: "极高",
    max: "最大",
  };
  const nonReasoningIntensityOptions = [
    ["", "模型默认"],
    ["low", "低"],
    ["medium", "中"],
    ["high", "高"],
    ["xhigh", "极高"],
    ["ultra", "超高"],
    ["max", "最大"],
  ];
  const aiModelMetadataMap = new Map();

  function getClientModelCapabilities(modelName) {
    const id = String(modelName || "").trim();
    if (aiModelMetadataMap.has(id)) {
      return aiModelMetadataMap.get(id);
    }
    const lower = id.toLowerCase();
    if (/(?:^|\/)(?:o1|o3|o4)(?:-|$)/i.test(lower)) {
      return { reasoning: true, reasoningEfforts: ["low", "medium", "high"], supportsTemperature: false, source: "heuristic" };
    }
    if (/(?:^|\/)(?:deepseek-(?:r1|reasoner|v4)|r1\b)/i.test(lower)) {
      return { reasoning: true, reasoningEfforts: ["high", "max"], supportsTemperature: false, source: "heuristic" };
    }
    if (/(?:^|\/)(?:qwq|qvq)\b/i.test(lower)) {
      return { reasoning: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], supportsTemperature: false, source: "heuristic" };
    }
    if (/(?:^|\/)kimi-k3\b/i.test(lower)) {
      return { reasoning: true, reasoningEfforts: ["max"], supportsTemperature: false, source: "heuristic" };
    }
    if (/(?:^|\/)claude-(?:3-7|sonnet-4|sonnet-5|opus-4)/i.test(lower)) {
      return { reasoning: true, reasoningEfforts: ["low", "medium", "high", "max"], supportsTemperature: true, source: "heuristic" };
    }
    if (/(?:^|\/)gpt(?:-|$)/i.test(lower)) {
      return { reasoning: true, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], supportsTemperature: true, source: "heuristic" };
    }
    if (/(?:^|\/|-|_|\b)(?:thinking|reasoner|reasoning)\b/i.test(lower)) {
      return { reasoning: true, reasoningEfforts: ["low", "medium", "high"], supportsTemperature: false, source: "heuristic" };
    }
    return { reasoning: false, reasoningEfforts: [], supportsTemperature: true, source: "default" };
  }

  function updateInferenceSettingOptions() {
    if (!aiReasoningEffort || !aiReasoningField) return;
    const model = aiModel?.value || "";
    const caps = getClientModelCapabilities(model);
    const isReasoning = Boolean(caps.reasoning);
    const mode = isReasoning ? "reasoning" : "temperature";
    const reasoningEfforts = Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0
      ? caps.reasoningEfforts
      : ["low", "medium", "high"];

    const reasoningOptions = [
      ["", "模型默认"],
      ...reasoningEfforts.map((effort) => [effort, thinkingLevelLabels[effort] || effort]),
    ];

    const currentEffortsKey = isReasoning ? reasoningEfforts.join(",") : "text-intensity";
    if (aiReasoningEffort.dataset.effortsKey !== currentEffortsKey) {
      const options = isReasoning ? reasoningOptions : nonReasoningIntensityOptions;
      aiReasoningEffort.innerHTML = options.map(([val, label]) => `<option value="${escapeHtml(val)}">${escapeHtml(label)}</option>`).join("");
      aiReasoningEffort.dataset.mode = mode;
      aiReasoningEffort.dataset.effortsKey = currentEffortsKey;
    }

    const labelElem = aiReasoningField.querySelector("label");
    if (labelElem) {
      labelElem.textContent = isReasoning ? "推理强度" : "推理强度";
    }
    aiReasoningEffort.title = isReasoning
      ? ("该推理模型专属的推理强度档位（数据源：" + (caps.source || "检测") + "，绝不套用统一档位）")
      : "常规非推理模型文本化强度档位（低~最大，模型默认时不发送采样参数）";
  }

  function loadAiConfig() {
    try {
      const saved = JSON.parse(localStorage.getItem(AI_CONFIG_KEY) || "{}");
      if (saved.provider && aiProvider) aiProvider.value = saved.provider;
      if (saved.baseUrl && aiBaseUrl) aiBaseUrl.value = saved.baseUrl;
      if (saved.apiKey && aiApiKey) aiApiKey.value = saved.apiKey;
      if (saved.model && aiModel) aiModel.value = saved.model;
      if (saved.concurrency && aiConcurrency) aiConcurrency.value = saved.concurrency;
      if (saved.reasoningEffort != null && aiReasoningEffort) aiReasoningEffort.value = saved.reasoningEffort;
    } catch {}
    updateInferenceSettingOptions();
  }

  function saveAiConfig() {
    try {
      localStorage.setItem(AI_CONFIG_KEY, JSON.stringify({
        provider: aiProvider?.value || "local",
        baseUrl: aiBaseUrl?.value || "",
        apiKey: aiApiKey?.value || "",
        model: aiModel?.value || "",
        concurrency: aiConcurrency?.value || "3",
        reasoningEffort: aiReasoningEffort?.value || "",
      }));
    } catch {}
  }

  function loadSavedPredictions() {
    try {
      const stored = JSON.parse(localStorage.getItem(AI_PREDICTIONS_KEY) || "{}");
      let count = 0;
      for (const row of allRows) {
        if (!row.prediction && stored[row.id]) {
          row.prediction = stored[row.id];
          count += 1;
        }
      }
      if (count > 0) {
        updateAiBadge(count);
      }
    } catch {}
  }

  function savePrediction(rowId, prediction) {
    try {
      const stored = JSON.parse(localStorage.getItem(AI_PREDICTIONS_KEY) || "{}");
      stored[rowId] = prediction;
      localStorage.setItem(AI_PREDICTIONS_KEY, JSON.stringify(stored));
    } catch {}
  }

  function updateAiBadge(completedCount) {
    if (!aiSummaryBadge) return;
    if (aiRunning) {
      aiSummaryBadge.textContent = "推断中...";
      aiSummaryBadge.className = "ai-status-badge is-running";
    } else if (completedCount > 0) {
      aiSummaryBadge.textContent = "已推断 " + completedCount + " / " + allRows.length + " 行";
      aiSummaryBadge.className = "ai-status-badge";
    } else {
      aiSummaryBadge.textContent = "就绪";
      aiSummaryBadge.className = "ai-status-badge";
    }
  }

  function cleanClientJson(raw) {
    if (!raw || typeof raw !== "string") return {};
    let text = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
    const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (codeBlockMatch) text = codeBlockMatch[1].trim();
    try {
      return JSON.parse(text);
    } catch {}
    const firstOpen = text.indexOf("{");
    const lastClose = text.lastIndexOf("}");
    if (firstOpen >= 0 && lastClose > firstOpen) {
      try {
        return JSON.parse(text.slice(firstOpen, lastClose + 1));
      } catch {}
    }
    return { speaker: "", status: "needs-review", confidence: 0, evidence: text.slice(0, 120), needsContext: true };
  }

  async function callAiInfer(row, config, signal) {
    // 1. 优先尝试通过本地后端代理执行（彻底规避浏览器的第三方 CORS 限制）
    const proxyUrls = ["/api/speaker-ai/infer"];
    if (window.location.protocol === "file:" || !window.location.host) {
      proxyUrls.unshift("http://127.0.0.1:3000/api/speaker-ai/infer");
    }
    for (const url of proxyUrls) {
      try {
        const resp = await apiFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ row, config }),
          signal,
        });
        if (resp.ok) {
          const data = await resp.json();
          if (data.ok && data.prediction) return data.prediction;
        } else if (resp.status !== 404) {
          const errData = await resp.json().catch(() => ({}));
          if (errData.error) throw new Error(errData.error);
        }
      } catch (e) {
        if (e.name === "AbortError") throw e;
        if (e.message && !e.message.includes("Failed to fetch") && !e.message.includes("NetworkError")) {
          throw e;
        }
      }
    }

    // 2. 若无可用后端服务代理，则由前端直连并提供最多 2 次重试
    const endpoint = (config.baseUrl || "http://127.0.0.1:11434/v1").replace(/\/+$/, "") + "/chat/completions";
    const prompt = window.speakerPageMeta?.prompt;
    const userPayload = {
      task: "speaker-attribution",
      target: { index: row.index, sourceText: row.sourceText, parallelText: row.parallelText },
      attention: row.attention,
      alignment: row.alignment,
    };
    if (config.priorSpeaker) {
      userPayload.priorSpeaker = config.priorSpeaker;
      userPayload.progressiveContextNote = `前文邻近发话人为「${config.priorSpeaker}」。若本句属于无交谈对象的连贯独白、感叹自语或同一主体的承接动作，可据此判断是否同一人发话。`;
    }
    const body = {
      model: config.model || "qwen2.5:14b-instruct",
      messages: [
        { role: "system", content: prompt?.system || "你是严谨的说话人归属助手。" },
        { role: "user", content: JSON.stringify(userPayload, null, 2) },
      ],
      stream: false,
    };
    const headers = { "content-type": "application/json" };
    if (config.apiKey) headers.authorization = "Bearer " + config.apiKey;

    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const resp = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal,
        });
        if (!resp.ok) {
          const errText = await resp.text().catch(() => "");
          throw new Error(`HTTP ${resp.status}: ${errText.slice(0, 100)}`);
        }
        const data = await resp.json();
        const rawContent = data.choices?.[0]?.message?.content || "";
        const parsed = cleanClientJson(rawContent);
        if (parsed.status === "confirmed" && !parsed.speaker && row.attention?.candidates?.[0]?.name) {
          parsed.speaker = row.attention.candidates[0].name;
        }
        return parsed;
      } catch (e) {
        if (e.name === "AbortError") throw e;
        lastError = e;
        if (attempt < 2) {
          await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
        }
      }
    }

    const isCors = lastError?.message?.includes("Failed to fetch") || lastError?.message?.includes("NetworkError");
    const hint = isCors
      ? "网络或跨域限制 (Failed to fetch)。使用第三方云端 API 时，请启动本地服务 (npm run server) 以通过后端代理转发"
      : (lastError?.message || String(lastError));
    throw new Error(hint);
  }

  async function startAiInference() {
    if (aiRunning) return;
    saveAiConfig();

    const config = {
      provider: aiProvider?.value || "local",
      baseUrl: aiBaseUrl?.value || "",
      apiKey: aiApiKey?.value || "",
      model: aiModel?.value || "qwen2.5:14b-instruct",
      reasoningEffort: aiReasoningEffort?.value || "",
      concurrency: Math.max(1, Math.min(8, Number(aiConcurrency?.value || 3))),
    };

    const targetRows = allRows.filter((row) => {
      const record = recordFor(row);
      // 原文件中已存在写回标记，或已写回的行，AI 自动跳过！
      if (record.status === "written" || record.isWritten || row.isWritten) return false;
      return !row.prediction || row.prediction.error;
    });
    if (!targetRows.length) {
      if (aiStatusText) aiStatusText.textContent = "全部发话行已推断完毕。";
      return;
    }

    const runId = ++aiRunSequence;
    const controller = new AbortController();
    const isCurrentRun = () => aiActiveRunId === runId && aiAbortController === controller;
    aiRunning = true;
    aiActiveRunId = runId;
    aiAbortController = controller;
    if (aiStartBtn) aiStartBtn.disabled = true;
    if (aiStopBtn) aiStopBtn.disabled = false;
    if (aiProgressWrap) aiProgressWrap.hidden = false;
    updateAiBadge(allRows.length - targetRows.length);

    let completed = allRows.length - targetRows.length;
    const total = allRows.length;

    const updateProgress = () => {
      if (!isCurrentRun()) return;
      const pct = Math.round((completed / total) * 100);
      if (aiProgressBar) aiProgressBar.style.width = pct + "%";
      if (aiStatusText) aiStatusText.textContent = "已推断 " + completed + " / " + total + " (" + pct + "%)";
      updateAiBadge(completed);
    };
    updateProgress();

    let currentIndex = 0;
    const workerCount = Math.min(config.concurrency, targetRows.length);

    const worker = async () => {
      while (currentIndex < targetRows.length && isCurrentRun()) {
        const row = targetRows[currentIndex++];
        try {
          let prediction = await callAiInfer(row, config, controller.signal);
          if (!isCurrentRun()) break;
          // 渐进式披露闭环 (Progressive Disclosure Expansion Loop)
          if ((prediction.needsContext || (prediction.confidence <= 0.35 && !prediction.speaker)) && isCurrentRun()) {
            const prevRow = allRows[row.index - 2];
            const priorSpeaker = prevRow?.prediction?.speaker || recordFor(prevRow || {})?.speaker || "";
            if (priorSpeaker) {
              const progressiveConfig = {
                ...config,
                priorSpeaker,
                progressiveExpansion: true,
              };
              try {
                const expandedPrediction = await callAiInfer(row, progressiveConfig, controller.signal);
                if (!isCurrentRun()) break;
                if (expandedPrediction && (expandedPrediction.speaker || expandedPrediction.confidence > prediction.confidence)) {
                  prediction = expandedPrediction;
                }
              } catch (_) {}
            }
          }
          if (!isCurrentRun()) break;
          row.prediction = prediction;
          savePrediction(row.id, prediction);
        } catch (e) {
          if (e.name === "AbortError" || !isCurrentRun()) break;
          row.prediction = {
            speaker: "",
            status: "needs-review",
            confidence: 0,
            evidence: "推断失败: " + (e.message || String(e)),
            needsContext: true,
            error: true,
          };
        }
        completed += 1;
        updateProgress();
        // 实时刷新当前展示中受影响的行与表单字段
        const tr = tbody.querySelector('tr[data-row-id="' + row.id + '"]');
        if (tr) {
          if (!tr.classList.contains("is-editing")) {
            const temp = document.createElement("tbody");
            temp.innerHTML = renderRow(row);
            const newTr = temp.firstElementChild;
            if (newTr) {
              tr.replaceWith(newTr);
              const textarea = newTr.querySelector('textarea[data-field="evidence"]');
              if (textarea) {
                textarea.style.height = "auto";
                textarea.style.height = Math.min(textarea.scrollHeight + 2, Math.max(120, Math.round(window.innerHeight * 0.4))) + "px";
              }
            }
          } else {
            // 如果用户正聚焦在输入框，不强制替换正在输入的 DOM，但若输入框为空则自动回填 AI 结果
            const speakerInput = tr.querySelector('input[data-field="speaker"]');
            if (speakerInput && !speakerInput.value.trim() && row.prediction?.speaker) {
              speakerInput.value = row.prediction.speaker;
            }
            const confInput = tr.querySelector('input[data-field="confidence"]');
            if (confInput && !confInput.value.trim() && row.prediction?.confidence != null) {
              confInput.value = row.prediction.confidence;
            }
            const evTextarea = tr.querySelector('textarea[data-field="evidence"]');
            if (evTextarea && !evTextarea.value.trim() && row.prediction?.evidence) {
              evTextarea.value = row.prediction.evidence;
              evTextarea.style.height = "auto";
              evTextarea.style.height = Math.min(evTextarea.scrollHeight + 2, Math.max(120, Math.round(window.innerHeight * 0.4))) + "px";
            }
            const decisionTd = tr.querySelector(".speaker-decision");
            if (decisionTd) {
              const existingAi = decisionTd.querySelector(".speaker-ai-suggestion");
              if (existingAi) existingAi.remove();
              decisionTd.insertAdjacentHTML("afterbegin", renderPrediction(row));
            }
          }
        }
        updateStats();
      }
    };

    const workers = [];
    for (let i = 0; i < workerCount; i += 1) workers.push(worker());
    await Promise.all(workers);

    if (!isCurrentRun()) return;
    aiRunning = false;
    aiActiveRunId = 0;
    aiAbortController = null;
    if (aiStartBtn) aiStartBtn.disabled = false;
    if (aiStopBtn) aiStopBtn.disabled = true;
    updateAiBadge(completed);
    if (aiStatusText) aiStatusText.textContent = "推断完成，共 " + completed + " 行。";
    renderVisibleRows(false);
  }

  function stopAiInference() {
    if (!aiRunning) return;
    const controller = aiAbortController;
    aiRunning = false;
    aiActiveRunId = 0;
    aiAbortController = null;
    if (controller) controller.abort();
    if (aiStartBtn) aiStartBtn.disabled = false;
    if (aiStopBtn) aiStopBtn.disabled = true;
    if (aiStatusText) aiStatusText.textContent = "已停止推断。";
    updateAiBadge(allRows.filter((r) => r.prediction && !r.prediction.error).length);
  }

  function batchAdoptAi() {
    let approvedCount = 0;
    for (const row of allRows) {
      if (row.prediction && row.prediction.speaker && (row.prediction.confidence || 0) >= 0.8) {
        const record = recordFor(row);
        if (!record.reviewed && record.status !== "confirmed") {
          notes[row.id] ||= {};
          notes[row.id].speaker = String(row.prediction.speaker);
          notes[row.id].confidence = String(row.prediction.confidence != null ? row.prediction.confidence : "");
          notes[row.id].status = "confirmed";
          if (row.prediction.evidence) notes[row.id].evidence = String(row.prediction.evidence);
          notes[row.id].reviewed = true;
          notes[row.id].manual = true;
          approvedCount += 1;
        }
      }
    }
    scheduleSave();
    if (aiStatusText) aiStatusText.textContent = "已批量审核通过 " + approvedCount + " 个高置信度 (≥80%) AI 判断。";
    renderVisibleRows(false);
  }

  function populateModelOptions(models, selectedModel) {
    if (!aiModel) return;
    const list = Array.isArray(models) ? models : [];
    const currentVal = selectedModel || aiModel.value;

    for (const item of list) {
      if (item && typeof item === "object" && item.id) {
        aiModelMetadataMap.set(item.id, item);
      }
    }

    let html = list.map((m) => {
      const id = typeof m === "string" ? m : (m.id || "");
      const name = typeof m === "string" ? m : (m.name || id);
      return '<option value="' + escapeHtml(id) + '">' + escapeHtml(name) + '</option>';
    }).join("");

    html += '<option value="__custom__">➕ 自定义输入模型...</option>';
    aiModel.innerHTML = html;

    // 如果当前选中的模型在列表中，或者恢复旧值
    if (currentVal && list.some((m) => (typeof m === "string" ? m : m.id) === currentVal)) {
      aiModel.value = currentVal;
    } else if (list.length) {
      aiModel.value = typeof list[0] === "string" ? list[0] : list[0].id;
    }

    updateInferenceSettingOptions();
  }

  function loadCachedModelsForUrl(url) {
    if (!url) return;
    try {
      const key = "between-lines:speaker-ai:models:" + url.trim().replace(/\/+$/, "");
      const cached = JSON.parse(localStorage.getItem(key) || "[]");
      if (Array.isArray(cached) && cached.length) {
        populateModelOptions(cached);
      }
    } catch {}
  }

  let modelHintTimer = 0;
  function showModelHint(message, { isError = false, timeout = 6000 } = {}) {
    if (!aiModelHint) return;
    window.clearTimeout(modelHintTimer);
    aiModelHint.textContent = message;
    aiModelHint.title = message;
    aiModelHint.classList.toggle("is-error", isError);
    aiModelHint.hidden = false;
    if (timeout > 0) {
      modelHintTimer = window.setTimeout(() => { aiModelHint.hidden = true; }, timeout);
    }
  }

  async function refreshAiModels() {
    if (!aiBaseUrl || !aiBaseUrl.value.trim()) {
      showModelHint("请先填写 API 地址 (Base URL)。", { isError: true });
      return;
    }
    const requestedUrl = aiBaseUrl.value.trim();
    if (aiRefreshModelsBtn) aiRefreshModelsBtn.disabled = true;
    showModelHint("正在获取可用模型...", { timeout: 0 });

    try {
      // 优先尝试后端代理端点
      const resp = await apiFetch("/api/speaker-ai/models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: aiProvider?.value || "compatible",
          baseUrl: requestedUrl,
          apiKey: aiApiKey?.value || "",
        }),
      });

      let models = [];
      if (resp.ok) {
        const data = await resp.json();
        models = data.models || [];
      } else {
        // 若无后端服务，回退到直接调用远端 /models 接口
        const directUrl = requestedUrl.replace(/\/+$/, "") + "/models";
        const headers = {};
        if (aiApiKey?.value) headers.authorization = "Bearer " + aiApiKey.value;
        const directResp = await fetch(directUrl, { headers });
        const directData = await directResp.json();
        const items = Array.isArray(directData.data) ? directData.data : (Array.isArray(directData.models) ? directData.models : []);
        models = items.map((it) => ({ id: it.id || it.name, name: it.name || it.id }));
      }

      if (models && models.length) {
        populateModelOptions(models);
        // 保存至该 Base URL 对应的本地缓存
        try {
          const key = "between-lines:speaker-ai:models:" + requestedUrl.replace(/\/+$/, "");
          localStorage.setItem(key, JSON.stringify(models));
        } catch {}

        saveAiConfig();
        showModelHint("已获取 " + models.length + " 个模型，可在模型下拉框中选择。");
      } else {
        showModelHint("没有从接口返回模型列表，可手动输入模型名。");
      }
    } catch (err) {
      showModelHint("获取模型失败：" + (err.message || String(err)) + "。可手动输入模型名。", { isError: true, timeout: 10000 });
    } finally {
      if (aiRefreshModelsBtn) aiRefreshModelsBtn.disabled = false;
    }
  }

  function clearAiPredictions() {
    if (aiRunning) stopAiInference();
    localStorage.removeItem(AI_PREDICTIONS_KEY);
    for (const row of allRows) {
      delete row.prediction;
    }
    if (aiStatusText) aiStatusText.textContent = "推断记录已清除。";
    if (aiProgressWrap) aiProgressWrap.hidden = true;
    if (aiProgressBar) aiProgressBar.style.width = "0%";
    updateAiBadge(0);
    renderVisibleRows(false);
  }

  if (aiRefreshModelsBtn) aiRefreshModelsBtn.addEventListener("click", refreshAiModels);
  if (aiStartBtn) aiStartBtn.addEventListener("click", startAiInference);
  if (aiStopBtn) aiStopBtn.addEventListener("click", stopAiInference);
  if (aiClearCacheBtn) aiClearCacheBtn.addEventListener("click", clearAiPredictions);
  if (aiProvider) aiProvider.addEventListener("change", saveAiConfig);
  if (aiBaseUrl) {
    aiBaseUrl.addEventListener("change", () => {
      saveAiConfig();
      loadCachedModelsForUrl(aiBaseUrl.value);
    });
  }
  if (aiApiKey) aiApiKey.addEventListener("change", saveAiConfig);
  if (aiModel) {
    aiModel.addEventListener("change", () => {
      if (aiModel.value === "__custom__") {
        const custom = prompt("请输入自定义模型名称（如 gpt-4o 或 mistral-large）：");
        if (custom && custom.trim()) {
          const val = custom.trim();
          const opt = document.createElement("option");
          opt.value = val;
          opt.textContent = val;
          aiModel.insertBefore(opt, aiModel.lastElementChild);
          aiModel.value = val;
        } else {
          aiModel.selectedIndex = 0;
        }
      }
      updateInferenceSettingOptions();
      saveAiConfig();
    });
  }
  if (aiReasoningEffort) aiReasoningEffort.addEventListener("change", saveAiConfig);
  if (aiConcurrency) aiConcurrency.addEventListener("change", saveAiConfig);

  loadAiConfig();
  if (aiBaseUrl) loadCachedModelsForUrl(aiBaseUrl.value);
  loadSavedPredictions();
  // --- 结束 AI 说话人推断客户端引擎 ---

  renderVisibleRows(true);
})();
