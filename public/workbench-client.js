    const pageLabels = pageMeta.pageLabels;
    const bilingualMode = pageMeta.comparisonMode === "bilingual";
    const aiConfigStorageKey = "translation-compare-ai-config-v1";
    const projectAiConfigStorageKey = "translation-compare-ai-project-config-v1:" + (pageMeta.projectKey || "unscoped");
    const aiPromptStorageKey = "translation-compare-ai-prompt-v1:" + (pageMeta.projectKey || "unscoped");
    const writebackBackupStorageKey = "translation-compare-writeback-backup-v1:" + (pageMeta.projectKey || "unscoped");

    function getWritebackBackupSetting() {
      try {
        const stored = localStorage.getItem(writebackBackupStorageKey);
        if (stored !== null) return stored === "true";
      } catch {}
      return Boolean(pageMeta.writebackBackup);
    }

    function setWritebackBackupSetting(enabled) {
      try {
        localStorage.setItem(writebackBackupStorageKey, String(enabled));
      } catch {}
      if (pageMeta.projectKey) {
        apiFetch("/api/projects/" + encodeURIComponent(pageMeta.projectKey) + "/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ writebackBackup: enabled }),
        }).catch(() => {});
      }
    }

    const gptReasoningOptions = [
      ["", "模型默认"],
      ["none", "无"],
      ["minimal", "最小"],
      ["low", "低"],
      ["medium", "中"],
      ["high", "高"],
      ["xhigh", "极高"],
      ["max", "最大"],
    ];
    // 旧版（inferenceSettingVersion 2）保存的是数值 temperature；迁移到语义档位时按共享映射取整
    const legacyTemperatureToIntensity = {
      "0": "low",
      "0.0": "low",
      "0.2": "low",
      "0.5": "medium",
      "0.7": "high",
      "0.85": "xhigh",
      "0.95": "ultra",
      "0.1": "low",
      "0.3": "low",
      "0.4": "medium",
      "0.6": "medium",
      "0.8": "high",
      "0.9": "ultra",
    };
    let savedGptReasoningEffort = "";
    let savedNonGptIntensity = "";
    const automatedNoteMarkers = ["[AI校对]", "[规则预筛]", "[相似度预筛]", "[对照表]"];
    const parsedAutomatedNoteCache = new Map();
    const MAX_PARSED_NOTE_CACHE = 5000;
    let cachedStageMetrics = null;
    let notesMetricsVersion = 0;
    let lastComputedMetricsVersion = -1;

    function markNotesDirtyForMetrics() {
      notesMetricsVersion += 1;
    }

    let notesPersistFailed = false;
    const allRows = JSON.parse(document.getElementById("rowData").textContent);
    const rowsById = new Map(allRows.map((row) => [String(row.index), row]));
    const renderedRowsById = new Map();
    const notesTools = createNotesTools(alignLegacyNotes);
    const presetTools = createPresetTools();
    let currentPresetId = "";
    const notes = {};
    const initialRaw = localStorage.getItem(storageKey);
    const initialData = initialRaw === null ? {} : notesTools.parse(initialRaw);
    // 无法解析的当前空间保留原样，防止下一次自动保存抹掉原始数据。
    let notesStorageBlocked = initialData === null;
    let lastPersistedNotesRaw = initialRaw;
    for (const [id, value] of notesTools.entries(initialData)) notes[id] = normalizeStoredNote(value);
    // 恢复通告：{ message, tone }——找回成功与「一条都对不上」是两种语气，写在赋值处而不是猜文案。
    let notesRecovery = null;

    /**
     * 内容确实变过、当初只能按文本锚点搬来的行（旧规则会把这类行标成「需逐行核验」并清掉人工确认）：
     * 旧记录里的「修改结果」与这一行现在的正文逐字相同，说明这一行现在的正文就是人工批准并写回的成品。
     * 只有旧记录本来就带人工确认时才还回去；来源空间里没确认过的记录不受影响。
     */
    function healApprovedRows(space, plan) {
      let healed = 0;
      for (const pair of plan.approved || []) {
        const current = notes[String(pair.to)];
        const source = space.data[String(pair.from)];
        if (!current || !current.recoveredUnverified || !source?.manualDone) continue;
        delete current.recoveredUnverified;
        current.manualDone = true;
        current.done = true;
        const signature = rowsById.get(String(pair.to))?.signature;
        if (signature) current.rowSig = String(signature);
        healed += 1;
      }
      return healed;
    }

    /**
     * 旧版找回规则漏掉的两类行在这里自愈：内容在书里重复的短行整条搬不过来，
     * 写回后内容变过的行被清掉人工确认。挨过这一轮损伤的空间会留下未校验记录，
     * 所以本页空间只要还有这种记录，就按同一套内容证据把缺的记录补回、把能证明的人工确认还回去。
     * 只补本页没有的行，不动本页已有记录；补完就是正常状态，不需要用户再想起「找回」这件事。
     */
    function selfHealDamagedSpace() {
      const spaces = notesTools.inventory(localStorage, storageKey, notes)
        .filter((item) => !item.current && item.sameProject && item.entries && !item.parseFailed);
      let restored = 0;
      let healed = 0;
      for (const space of spaces) {
        const plan = notesTools.plan(space.data, allRows, notes, { sameSnapshot: space.sameSnapshot, revisionTextFor });
        healed += healApprovedRows(space, plan);
        for (const pair of plan.pairs) {
          if (!pair.verified) continue;
          notes[String(pair.to)] = normalizeStoredNote(space.data[String(pair.from)]);
          restored += 1;
        }
      }
      if (restored || healed) {
        // 与自动找回同一条落盘通道：这一步发生在脚本求值期，saveNotes 的防抖句柄还没就绪。
        const saved = persistNotes();
        notesRecovery = {
          tone: "success",
          message: `已修复旧版找回规则漏掉的记录：补回 ${restored} 条、恢复人工确认 ${healed} 条`
            + (saved === false ? "（尚未写入浏览器存储，请先导出本页记录）" : "。"),
        };
      }
    }

    function recoveryPlan(space, byIndex = false) {
      const plan = notesTools.plan(space.data, allRows, notes, {
        sameSnapshot: space.sameSnapshot, byIndex, revisionTextFor,
      });
      // 找回只在「本页没有这一行记录」时才搬运，所以 plan.pairs 里看不到已被本页占用的行——
      // 而本页记录与历史记录常常只是内容不同（AI 结论 ↔ 预筛结论），
      // 直接跳过就会连带丢掉历史空间里的「人工确认」。这里对签名能对上同一行的条目逐字段合并。
      if (!byIndex) {
        let merged = 0;
        for (const [id, raw] of notesTools.entries(space.data)) {
          const row = rowsById.get(String(id));
          const targetSignature = String(row?.signature || "");
          const sourceSignature = String(raw?.rowSig || "");
          if (!targetSignature || !sourceSignature || sourceSignature !== targetSignature) continue;
          const existing = notes[String(id)];
          if (!existing) continue;
          if (String(existing.rowSig || "") && String(existing.rowSig) !== targetSignature) continue;
          const keptManual = Boolean(existing.manualDone) || Boolean(raw.manualDone);
          existing.manualDone = keptManual;
          existing.done = Boolean(existing.manualDone);
          existing.aiDone = Boolean(existing.aiDone || raw.aiDone);
          mergeNotes(existing, normalizeStoredNote(raw));
          if (keptManual) existing.mergedFromSpaces = true;
          merged += 1;
        }
        // 合并结果照常按防抖落盘：这一步不经过「应用找回」，用户取消预览也不该丢掉刚保住的人工确认。
        const healed = healApprovedRows(space, plan);
        if (merged || healed) {
          saveNotes();
          if (merged) plan.merged = merged;
          if (healed) plan.approvedRestored = healed;
        }
      }
      return plan;
    }

    function applyRecovery(space, plan) {
      for (const pair of plan.pairs) {
        const item = normalizeStoredNote(space.data[String(pair.from)]);
        if (!pair.verified) {
          item.recoveredUnverified = true;
          item.manualDone = false;
          item.done = false;
          delete item.rowSig;
        }
        notes[String(pair.to)] = item;
      }
    }

    /**
     * 多个历史空间对同一行有不同记录时，逐字段合并，而不是把这一行整条丢掉。
     * 依据是行内容签名（pair.verified）：各空间的签名都对上同一行，说明它们说的是同一行文本，
     * 只是记录的内容不同——「确认预筛」写的是 [规则预筛]/[对照表] 结论且没有修改结果，
     * 同一个备注对象后来被 AI 结论替换（或反过来）就会造成这种差异，丢掉它等于把人工确认一起丢了。
     * 「人工确认」是布尔判定，任一空间确认过、且该行签名匹配，就应当保留；没有签名证据的行不会走到这里
     * （未校验的条目仍按 applyRecovery 的约定清除人工确认）。
     */
    function mergeNotes(canonical, other) {
      const note = String(other.note || "");
      const current = String(canonical.note || "");
      // 两份记录直接拼接会让解析层把后一份的字段覆盖前一份（备注是按行取值的）。
      // 所以只搬「另一份记录独有」的分析内容：结论字段取基准记录，「分析：」各自只有一行时合并成一行
      // （解析层遇到第二个「分析：」会覆盖前一个，那会丢掉基准记录的结论依据），
      // 段首标记与结论字段行留在各自记录里，既不丢证据，也不会拼出一份自相矛盾的备注。
      const analysis = [];
      const others = [];
      for (const line of note.split(/\n+/).map((item) => item.trim())) {
        if (!line || automatedNoteMarker(line)) continue;
        if (/^分析：/.test(line)) { analysis.push(line.slice("分析：".length).trim()); continue; }
        if (/^(语义是否相同|是否需要修改|质量评分|评分|翻译得分|质量分级|质量等级|分级|严重程度|问题严重程度|修改结果|修改后|修改后文本)：/.test(line)) continue;
        others.push(line);
      }
      const additions = [...others, analysis.length ? "分析：" + analysis.join("；") : ""].filter(Boolean)
        .filter((line) => !current.includes(line));
      if (additions.length) {
        // 补充行必须落在「修改结果：」之前——那是分析栏的边界，跟在它后面会被解析层并进
        // 可供写回的成品文本（备注是按行取值的，这一段就是人工点「写回」会送出的内容）。
        const lines = current.split("\n");
        const revisionAt = lines.findIndex((line) => /^(修改结果|修改后|修改后文本)：/.test(line.trim()));
        const insertAt = revisionAt < 0 ? lines.length : revisionAt;
        lines.splice(insertAt, 0, ...additions);
        canonical.note = lines.join("\n");
      }
      if (!String(canonical.revisionText || "").trim() && String(other.revisionText || "").trim()) {
        canonical.revisionText = other.revisionText;
      }
      if (!canonical.revisionTarget && other.revisionTarget) canonical.revisionTarget = other.revisionTarget;
    }

    function mergeRecoveredVariants(entries) {
      // 先选基准：有修改结果的优先（内容最全），其次记录更长的。
      const ranked = entries.slice().sort((a, b) => Number(Boolean(String(b.revisionText || "").trim())) - Number(Boolean(String(a.revisionText || "").trim()))
        || String(b.note || "").length - String(a.note || "").length);
      const canonical = { ...ranked[0] };
      for (const other of ranked.slice(1)) {
        canonical.manualDone = Boolean(canonical.manualDone || other.manualDone);
        canonical.aiDone = Boolean(canonical.aiDone || other.aiDone);
        mergeNotes(canonical, other);
      }
      canonical.done = Boolean(canonical.manualDone);
      // 人工确认来自多份历史记录时留个标记：预览面板据此显示「已合并」，也便于事后核查。
      if (ranked.slice(1).some((other) => other.manualDone)) canonical.mergedFromSpaces = true;
      return canonical;
    }

    // 只在从未保存过、且属于同一输入项目的空间自动恢复；其他项目只进入手动预览列表。
    // 已有备注（包括刻意清空的空间）同样由用户预览后合并。
    if (initialRaw === null) {
      const candidates = notesTools.inventory(localStorage, storageKey, notes)
        .filter((space) => !space.current && space.sameProject && space.entries && !space.parseFailed)
        .map((space) => ({ space, plan: recoveryPlan(space) }))
        .sort((a, b) => b.plan.verified - a.plan.verified);
      const best = candidates.find(({ plan }) => plan.verified);
      if (best) {
        // 逐「目标行」收集各历史空间的版本：只有全部历史空间的并集才是完整的候选集，
        // 只看基准空间（verified 最多的那份）会漏掉「只出现在别处的记录」——那种记录同样带人工确认。
        const variants = new Map();
        for (const candidate of candidates) {
          for (const pair of candidate.plan.pairs.filter((pair) => pair.verified)) {
            const note = normalizeStoredNote(candidate.space.data[String(pair.from)]);
            delete note.rowSig;
            if (!variants.has(pair.to)) variants.set(pair.to, new Map());
            variants.get(pair.to).set(JSON.stringify(note), note);
          }
        }
        // 同一行只有一个版本的直接找回；多个版本（同一行在两份历史空间里记录不同）逐字段合并，
        // 而不是像以前那样整条丢弃——那会把「确认预筛」的人工确认一并丢掉。
        let mergedVariants = 0;
        const pairs = [];
        for (const [to, byVariant] of variants) {
          const entries = [...byVariant.values()];
          if (!entries.length) continue;
          if (entries.length === 1) {
            pairs.push({ from: to, to, verified: true, item: entries[0] });
            continue;
          }
          const item = mergeRecoveredVariants(entries);
          if (item.mergedFromSpaces) mergedVariants += 1;
          pairs.push({ from: to, to, verified: true, item });
        }
        if (pairs.length) {
          for (const pair of pairs) notes[String(pair.to)] = pair.item;
          persistNotes();
          const mergedNote = mergedVariants ? `，其中 ${mergedVariants} 条合并了多个历史版本的记录（人工确认已保留）` : "";
          notesRecovery = { tone: "success", message: `已按行内容找回 ${pairs.length} 条记录${mergedNote}；其余或相互冲突的历史记录可在「备注空间与找回」中预览。` };
        }
      } else if (candidates.length) {
        notesRecovery = { tone: "watch", message: "发现历史备注，但没有任何一条能按行内容对上本页——历史记录仍保留在「备注空间与找回」中，可用「按行号找回」逐行核验。" };
      }
    }

    // 旧版规则造成的损失已经落在浏览器存储里：本页空间少了记录、人工确认被清成未校验，
    // 光修匹配规则救不回已经生成的这一页。只要本页还留着未校验记录，就说明它挨过这一轮损伤，
    // 载入时按同一套内容证据自愈一次；正常的空间（没有未校验记录）不受任何影响。
    if (initialRaw !== null && Object.values(notes).some((item) => item.recoveredUnverified)) selfHealDamagedSpace();

    function announceNotesRecovery() {
      if (notesRecovery) showToast(notesRecovery.message, { tone: notesRecovery.tone, durationMs: 12000 });
      updateNotesSaveState();
    }
    const tbody = document.querySelector("tbody");
    const wrap = document.querySelector(".wrap");
    const tableFrame = document.querySelector(".table-frame");
    const keyboardScrollSpacer = document.getElementById("keyboardScrollSpacer");
    const query = document.getElementById("query");
    const severityButtons = Array.from(document.querySelectorAll("[data-severity]"));
    const aiResultButtons = Array.from(document.querySelectorAll("[data-ai-result]"));
    const issueSeverityButtons = Array.from(document.querySelectorAll("[data-issue-severity]"));
    const noteFilter = document.getElementById("noteFilter");
    const doneFilter = document.getElementById("doneFilter");
    const prefilterResultFilter = document.getElementById("prefilterResultFilter");
    const showSource = document.getElementById("showSource");
    const showTranslationDiff = document.getElementById("showTranslationDiff");
    const showRevisionDiff = document.getElementById("showRevisionDiff");
    const emptyState = document.getElementById("emptyState");
    const paginationBar = document.getElementById("paginationBar");
    const paginationStatus = document.getElementById("paginationStatus");
    const pageInput = document.getElementById("pageInput");
    const pageTotal = document.getElementById("pageTotal");
    const pageSize = document.getElementById("pageSize");
    const firstPage = document.getElementById("firstPage");
    const prevPage = document.getElementById("prevPage");
    const nextPage = document.getElementById("nextPage");
    const lastPage = document.getElementById("lastPage");
    const doneCount = document.getElementById("doneCount");
    const aiDoneCount = document.getElementById("aiDoneCount");
    const aiIds = {
      presetSelect: document.getElementById("aiPresetSelect"),
      presetSave: document.getElementById("aiPresetSave"),
      presetSaveAs: document.getElementById("aiPresetSaveAs"),
      presetDelete: document.getElementById("aiPresetDelete"),
      provider: document.getElementById("aiProvider"),
      panel: document.getElementById("aiPanel"),
      promptSection: document.getElementById("aiPromptSection"),
      serviceFields: document.getElementById("aiServiceFields"),
      baseUrl: document.getElementById("aiBaseUrl"),
      model: document.getElementById("aiModel"),
      reasoningField: document.getElementById("aiReasoningField"),
      reasoningEffort: document.getElementById("aiReasoningEffort"),
      testModel: document.getElementById("aiTestModel"),
      refreshModels: document.getElementById("aiRefreshModels"),
      apiKey: document.getElementById("aiApiKey"),
      proofreadMode: document.getElementById("aiProofreadMode"),
      target: document.getElementById("aiTarget"),
      profile: document.getElementById("aiProfile"),
      termTableHint: document.getElementById("aiTermTableHint"),
      speechHabitHint: document.getElementById("aiSpeechHabitHint"),
      concurrency: document.getElementById("aiConcurrency"),
      concurrencyLabel: document.getElementById("aiConcurrencyLabel"),
      smartConcurrency: document.getElementById("aiSmartConcurrency"),
      concurrencyMax: document.getElementById("aiConcurrencyMax"),
      concurrencyMaxWrap: document.getElementById("aiConcurrencyMaxWrap"),
      breakerThreshold: document.getElementById("aiBreakerThreshold"),
      breakerDisabled: document.getElementById("aiBreakerDisabled"),
      promptVisible: document.getElementById("aiPromptVisible"),
      stage1Preset: document.getElementById("stage1PresetSelect"),
      stage2Preset: document.getElementById("stage2PresetSelect"),
      stage3Preset: document.getElementById("stage3PresetSelect"),
      stage2Card: document.getElementById("stage2Card"),
      stage3Card: document.getElementById("stage3Card"),
      start: document.getElementById("stage1Start") || document.getElementById("aiStart"),
      stop: document.getElementById("stage1Stop") || document.getElementById("aiStop"),
      stage1Start: document.getElementById("stage1Start") || document.getElementById("aiStart"),
      stage1Stop: document.getElementById("stage1Stop") || document.getElementById("aiStop"),
      stage2Start: document.getElementById("stage2Start"),
      stage2Stop: document.getElementById("stage2Stop"),
      stage3Start: document.getElementById("stage3Start"),
      stage3Stop: document.getElementById("stage3Stop"),
      clearCache: document.getElementById("clearAiLog"),
      status: document.getElementById("aiStatus"),
      panelState: document.getElementById("aiPanelState"),
      progressWrap: document.getElementById("aiProgressWrap"),
      progress: document.getElementById("aiProgress"),
      prompt: document.getElementById("aiPrompt"),
      promptReset: document.getElementById("aiPromptReset"),
    };
    const prefilterIds = {
      panel: document.getElementById("prefilterPanel"),
      panelState: document.getElementById("prefilterPanelState"),
      similarity: document.getElementById("prefilterSimilarity"),
      stats: document.getElementById("prefilterStats"),
      start: document.getElementById("prefilterStart"),
      confirm: document.getElementById("prefilterConfirm"),
      stop: document.getElementById("prefilterStop"),
    };
    const aiConfirmIds = {
      dialog: document.getElementById("aiConfirmDialog"),
      message: document.getElementById("aiConfirmMessage"),
      cancel: document.getElementById("aiConfirmCancel"),
      keep: document.getElementById("aiConfirmKeep"),
      clear: document.getElementById("aiConfirmClear"),
    };
    const appliedAiResults = new Set();
    const aiActiveIds = new Set();
    const clearedAiRunIds = new Set();
    const prefilterResultIds = new Set();
    const diffHtmlCache = new Map();
    let filteredRows = allRows;
    let currentPage = 1;
    let activeRowId = "";
    let lastAiRunId = "";
    let currentAiRunning = false;
    // 本页「预筛结果集」对应的运行号：不只由本页启动的那一轮设置，页面重开后由状态轮询
    // 从服务端上一轮预筛结果里认领（服务端会整轮返回结果），否则 resultIds 为空、
    // 「确认预筛」永久锁死，用户点「开始预筛」就会把同一批行重新筛一遍。
    let prefilterRunId = "";
    let prefilterResultFilterActive = false;
    let prefilterResultsCatchingUp = false;
    let lastAiResultRevision = 0;
    let aiStatusRefreshInFlight = false;
    let aiCatchupTimer = 0;
    let notesSavePending = false;
    let notesSaveHandle = 0;
    let notesSaveHandleType = "";
    let filterTimer = 0;
    let severityFilter = "all";
    let aiResultFilter = "all";
    let issueSeverityFilter = "all";
    let notesOnly = false;
    let doneMode = "all";
    let providerDefaults = pageMeta.providerDefaults || {};
    let defaultProofreadPrompt = pageMeta.proofreadPrompt?.system || "";
    // 构建期算好的说话习惯层：本卷命中概览 + 疑似流失行集合（用于行标记与状态行）。
    const speechHabitLayer = pageMeta.speechHabits || null;
    const speechHabitMissIndexes = new Set(
      Object.values(speechHabitLayer?.byProfile || {})
        .flatMap((entry) => entry.missIndexes || [])
        .map(String),
    );
    function speechHabitLayerSummary() {
      const entries = Object.values(speechHabitLayer?.byProfile || {});
      if (!entries.length) return "";
      return entries.map((entry) => `${entry.summary.activatedChapters}/${entry.summary.chapters} 章命中、${entry.summary.missRows} 行疑似流失`).join("；");
    }
    // 构建期算好的对照表判定：跑任务之前就能看到哪些行会被对照表处理（一致的行不调用模型）。
    // 判定与「校对模式 + 目标列」绑定，切换后重新取用；跑过 AI/预筛的行以真实备注为准，不再叠徽标。
    const termLayer = pageMeta.termPrefilter || null;
    let termVerdicts = new Map();
    // 行号 → 构建期算出的命中术语对（「原文 → 译名（类型）」）：页面在跑任务之前就能显示命中了什么。
    // 只存文案，判定与备注仍以运行期为准。
    let termEntries = new Map();
    function termVariantKeyForPage() {
      const mode = aiIds.proofreadMode?.value === "bilingual" ? "bilingual" : "trilingual";
      return mode + ":" + (mode === "bilingual" ? "cn" : (aiIds.target?.value === "tw" ? "tw" : "cn"));
    }
    // 当前档案 + 当前变体的落盘判定；该变体没算过时回落到档案的默认变体。
    function currentTermVariant() {
      const entry = termLayer?.byProfile?.[aiIds.profile?.value || ""] || null;
      const variants = entry?.variants || {};
      return { entry, variant: variants[termVariantKeyForPage()] || variants[entry?.defaultVariant] || null };
    }
    function refreshTermVerdicts() {
      termVerdicts = new Map();
      termEntries = new Map();
      const { variant } = currentTermVariant();
      if (!variant) return;
      // 旧快照没有 termOnly：那时命中一致的行一律跳过模型，按同一语义回落到 termOnly。
      const termOnly = new Set(variant.termOnly || variant.consistent || []);
      for (const index of variant.consistent || []) {
        termVerdicts.set(String(index), termOnly.has(index) ? "term-only" : "injected");
      }
      for (const index of variant.conflicts || []) termVerdicts.set(String(index), "conflict");
      for (const [index, list] of Object.entries(variant.terms || {})) {
        if (Array.isArray(list) && list.length) termEntries.set(String(index), list);
      }
    }
    function termLayerSummary() {
      const { variant } = currentTermVariant();
      if (!variant) return "";
      const summary = variant.summary || {};
      const consistent = summary.consistent || 0;
      const termOnly = summary.termOnly === undefined ? consistent : summary.termOnly;
      const conflicts = summary.conflicts || 0;
      // 冲突行同样注入术语后交给模型，所以它们算在「其余交模型」里，单独再点出条数。
      const injected = Math.max(0, consistent - termOnly) + conflicts;
      return `构建期预筛 ${variant.hits} 行命中（整行只有术语、跳过模型 ${termOnly}；其余 ${injected} 行注入术语后交给模型，其中术语冲突 ${conflicts} 行），预计 ${summary.aiRows} 行仍需 AI 判定`;
    }
    // 每个特化档案在页面里自带默认提示词：切换下拉时不必等状态轮询就能替换未手改的提示词。
    function defaultPromptForProfile(profileId) {
      const entry = (pageMeta.profiles || []).find((profile) => profile.id === profileId);
      return (entry && entry.prompt) || "";
    }
    let aiModelOptions = [];
    if (aiIds.promptVisible) aiIds.promptSection.hidden = !aiIds.promptVisible.checked;

    function serializeNotes() {
      for (const [id, item] of Object.entries(notes)) {
        const signature = rowsById.get(id)?.signature;
        // 未校验条目不能盖上新行签名，否则下次迁移会被误当作内容证据。
        if (item.recoveredUnverified) {
          delete item.rowSig;
          item.manualDone = false;
          item.done = false;
        }
        else if (signature) item.rowSig = String(signature);
      }
      return JSON.stringify(notes);
    }

    function updateNotesSaveState() {
      const banner = document.getElementById("notesSaveWarning");
      const badge = document.getElementById("notesSaveState");
      const failed = notesStorageBlocked || notesPersistFailed;
      if (badge) {
        badge.textContent = failed ? "尚未保存 · 请展开处理" : "保存在此浏览器";
        badge.classList.toggle("is-warn", failed);
      }
      if (!banner) return;
      banner.hidden = !failed;
      banner.textContent = notesStorageBlocked
        ? "本页空间无法解析或已被其他页面修改，已暂停保存。请先导出本页记录，再刷新页面核对；本地原始数据仍保留。"
        : "本地存储写入失败，本次修改仅在页面内存中。请先导出本页记录，清理已备份的历史空间后点击「重试保存」。";
      const retry = document.getElementById("retryNotesSave");
      if (retry) retry.hidden = !notesPersistFailed || notesStorageBlocked;
    }

    function persistNotes() {
      try {
        if (notesStorageBlocked || localStorage.getItem(storageKey) !== lastPersistedNotesRaw) {
          notesStorageBlocked = true;
          return false;
        }
        const raw = serializeNotes();
        localStorage.setItem(storageKey, raw);
        lastPersistedNotesRaw = raw;
        notesPersistFailed = false;
        return true;
      } catch {
        // 浏览器本地存储已满：本次改动只在当前页面生效，不能让它中断整页渲染。
        notesPersistFailed = true;
        return false;
      } finally {
        updateNotesSaveState();
      }
    }

    function cancelScheduledNotesSave() {
      if (!notesSavePending) return;
      if (notesSaveHandleType === "idle" && window.cancelIdleCallback) {
        window.cancelIdleCallback(notesSaveHandle);
      } else {
        window.clearTimeout(notesSaveHandle);
      }
      notesSavePending = false;
      notesSaveHandle = 0;
      notesSaveHandleType = "";
    }

    function flushNotes() {
      if (!notesSavePending) return;
      cancelScheduledNotesSave();
      persistNotes();
    }

    function saveNotes({ immediate = false } = {}) {
      markNotesDirtyForMetrics();
      if (immediate) {
        cancelScheduledNotesSave();
        persistNotes();
        return;
      }
      if (notesSavePending) return;
      notesSavePending = true;
      const commit = () => {
        notesSavePending = false;
        notesSaveHandle = 0;
        notesSaveHandleType = "";
        persistNotes();
      };
      if (window.requestIdleCallback) {
        notesSaveHandleType = "idle";
        notesSaveHandle = window.requestIdleCallback(commit, { timeout: 2000 });
      } else {
        notesSaveHandleType = "timeout";
        notesSaveHandle = window.setTimeout(commit, 250);
      }
    }

    function parsePercentRatio(value, fallback = 0.92, min = 0.5) {
      const raw = String(value ?? "").trim();
      if (!raw) return fallback;
      const numeric = Number(raw.replace("%", "").trim());
      if (!Number.isFinite(numeric)) return fallback;
      const ratio = raw.includes("%") || numeric > 1 ? numeric / 100 : numeric;
      return Math.min(1, Math.max(min, ratio));
    }

    function formatPercentRatio(value, fallback = 0.92, min = 0.5) {
      const ratio = parsePercentRatio(value, fallback, min);
      const percent = ratio * 100;
      const text = Number.isInteger(percent) ? String(percent) : percent.toFixed(1).replace(/\.0$/, "");
      return text + "%";
    }

    function normalizeSimilarityInput() {
      prefilterIds.similarity.value = formatPercentRatio(prefilterIds.similarity.value);
    }

    function normalizeBreakerInput() {
      aiIds.breakerThreshold.value = formatPercentRatio(aiIds.breakerThreshold.value, 0.5, 0.1);
    }

    function updateBreakerControls() {
      aiIds.breakerThreshold.disabled = aiIds.breakerDisabled.checked;
    }

    function updateConcurrencyControls() {
      const isSmart = Boolean(aiIds.smartConcurrency?.checked);
      if (aiIds.concurrencyMaxWrap) {
        aiIds.concurrencyMaxWrap.hidden = !isSmart;
      }
      if (aiIds.concurrencyLabel) {
        aiIds.concurrencyLabel.textContent = isSmart ? "初始并发" : "并发";
      }
      if (aiIds.concurrency) {
        // 上限跟着页面上的 max 属性走，避免文案与实际边界各写一份数字后漂移。
        const cap = String(aiIds.concurrency.max || "").trim();
        aiIds.concurrency.title = isSmart
          ? "初始并发数（默认 3，遇到频控可退避至 1）"
          : (cap ? `并发数（1~${cap}）` : "并发数");
      }
    }

    function updateProofreadModeHint() {
      aiIds.proofreadMode.value = bilingualMode ? "bilingual" : "trilingual";
      const hint = bilingualMode
        ? "目标固定为译文 B，参考原文 A；原文只作语义边界和上下文。"
        : "目标可选非原文 B 或 C，同时参考原文 A 和另一版本。";
      aiIds.proofreadMode.title = hint;
      aiIds.target.title = hint;
    }

    function automatedNoteMarker(value) {
      const text = String(value || "").trimStart();
      return automatedNoteMarkers.find((marker) => text.startsWith(marker)) || "";
    }

    function latestAiNotePart(value) {
      const parts = String(value || "").split(/\n\n+/).map((part) => part.trim()).filter(Boolean);
      const aiParts = parts.filter((part) => part.startsWith("[AI校对]"));
      return aiParts.length ? aiParts[aiParts.length - 1] : String(value || "");
    }

    function isAutomatedNoteText(value) {
      return Boolean(automatedNoteMarker(value));
    }

    function hasAutomatedDecisionNote(note) {
      return !isAiFailureNote(note) && Boolean(parseAutomatedNote(note));
    }

    function isAiFailureNote(note) {
      const lines = latestAiNotePart(note).split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (!lines[0]?.startsWith("[AI校对]")) return false;
      return lines.slice(1).some((line) =>
        line.startsWith("调用失败") ||
        line.startsWith("调用异常") ||
        line.includes("调用失败") ||
        line.includes("调用异常") ||
        line === "校对已终止。" ||
        line.startsWith("校对已终止：")
      );
    }

    function cleanAiFailureState(item) {
      if (!item || !isAiFailureNote(item.note)) return false;
      const changed = Boolean(item.manualDone || item.done || item.aiDone);
      item.manualDone = false;
      item.done = false;
      item.aiDone = false;
      return changed;
    }

    /**
     * 备注里“只作说明、不是成品文本”的行（格式自动规范化、标点自动规范化、低分归因、线上查证）：它们属于分析栏。
     * 备注是按行取值的，认不出的行会并进上一段字段——跟在「修改结果：」后面时，
     * 那等于把说明当成译文，页面会把它当可写回文本，甚至写进成品。
     */
    function isNoteProseLine(line) {
      const text = String(line || "").trim();
      return text.startsWith("格式自动规范化：")
        || text.startsWith("低分归因：")
        || text.startsWith("线上查证：")
        || text.startsWith("标点自动规范化：")
        || text.startsWith("Gatekeeper初审：")
        || text.startsWith("初审改案：")
        || text.startsWith("初审建议：")
        || text.startsWith("Stylist复审")
        || text.startsWith("复审改案：")
        || text.startsWith("复审建议：")
        || text.startsWith("Arbiter仲裁")
        || text.startsWith("仲裁改案：")
        || text.startsWith("仲裁建议：");
    }

    function normalizeStoredNote(value) {
      const note = String(value?.note || "");
      const manualDone = !value?.recoveredUnverified && Boolean(value?.manualDone);
      const item = {
        note,
        done: manualDone,
        manualDone,
        aiDone: Boolean(value?.aiDone || hasAutomatedDecisionNote(note)),
      };
      const parsedRevision = parseAutomatedNote(item.note)?.revision || "";
      // 修复前的备注把归因/查证说明写在了「修改结果：」后面，解析时会并进修改结果；
      // 载入时按行剥掉，避免人工点「写回」把说明写进成品。
      item.revisionText = (Object.prototype.hasOwnProperty.call(value || {}, "revisionText")
        ? String(value.revisionText || "")
        : parsedRevision)
        .split("\n")
        .filter((line) => !isNoteProseLine(line))
        .join("\n")
        .replace(/\s+$/, "");
      item.revisionTarget = normalizeRevisionTarget(value?.revisionTarget);
      if (value?.recoveredUnverified) item.recoveredUnverified = true;
      else if (value?.rowSig) item.rowSig = String(value.rowSig);
      cleanAiFailureState(item);
      return item;
    }

    function normalizeRevisionTarget(value) {
      return value === "tw" || value === "cn" ? value : "";
    }

    function countNoterefs(text) {
      return (String(text || "").match(/<a\b[^>]*\bnoteref\b[^>]*>/gi) || []).length;
    }

    function isPartialProposal(candidate, targetText = "", noteText = "", { isInitialProposal = false } = {}) {
      const cand = String(candidate || "").trim();
      const target = String(targetText || "").trim();
      if (!cand) return false;

      // 1. 若 note 文本中明确记载了 noteref 丢失、段落结构不一致或格式门禁作废，
      // 说明原本完整的修订文本已被作废，此时残存的短文本或初审文本绝不是合格全量改案
      const hasVoidMarker = noteText && (
        noteText.includes("丢失了目标列的 EPUB noteref 注释标记") ||
        noteText.includes("补入了目标列没有的 EPUB noteref 注释标记") ||
        noteText.includes("段落结构与目标列不一致") ||
        (noteText.includes("格式自动规范化") && noteText.includes("已作废"))
      );
      if (hasVoidMarker) {
        if (target && countNoterefs(target) > 0 && countNoterefs(cand) < countNoterefs(target)) {
          return true;
        }
        if (target && target.includes("\n\n") && !cand.includes("\n\n")) {
          return true;
        }
        if (cand.length <= 20) {
          return true;
        }
      }

      // 2. 结构完整性校验：目标列有 noteref 标记，而候选改案缺失 noteref 标记
      if (target) {
        const targetNoterefs = countNoterefs(target);
        const candNoterefs = countNoterefs(cand);
        if (targetNoterefs > 0 && candNoterefs < targetNoterefs) {
          return true;
        }
        // 目标列包含多段（\n\n），而候选改案仅为单段且长度明显缩水
        if (target.includes("\n\n") && !cand.includes("\n\n") && cand.length < target.length * 0.6) {
          return true;
        }
        // 初审提议（stage1Revision / p1）或明确标记作废时的局部短语比例校验
        if ((isInitialProposal || hasVoidMarker) && target.length >= 15 && cand.length < target.length * 0.45) {
          return true;
        }
      } else if (noteText) {
        // targetText 未传入时的兜底特征识别
        if ((noteText.includes("已作废") || noteText.includes("待人工确认")) && cand.length <= 12) {
          return true;
        }
      }

      return false;
    }

    function revisionTextFor(item) {
      const targetTextOrRow = arguments[1];
      if (!item) return "";
      let targetText = "";
      if (typeof targetTextOrRow === "string") {
        targetText = targetTextOrRow;
      } else if (targetTextOrRow && typeof targetTextOrRow === "object") {
        const targetKey = revisionTargetFor(item);
        targetText = String(targetTextOrRow[targetKey] || targetTextOrRow.cn || "");
      }
      if (!targetText && typeof rowsById !== "undefined" && rowsById) {
        for (const [id, n] of Object.entries(typeof notes !== "undefined" ? notes : {})) {
          if (n === item) {
            const r = rowsById.get(String(id));
            if (r) {
              const targetKey = revisionTargetFor(item);
              targetText = String(r[targetKey] || r.cn || "");
            }
            break;
          }
        }
      }

      // 1. 若用户曾通过版本切换按钮手动切换了版本，尊重用户的显式选择（非局部短语时）
      if (item.revisionStageActive && Object.prototype.hasOwnProperty.call(item, "revisionText")) {
        const explicit = String(item.revisionText || "");
        if (!isPartialProposal(explicit, targetText, item.note)) {
          return explicit;
        }
      }
      // 2. 对于多阶段校对行：无关当前筛选，默认显示最后的合格全量版本（仲裁 ＞ 复审 ＞ 初审）
      const noteData = parseAutomatedNote(item.note || "", targetText);
      if (noteData && (noteData.stage2 || noteData.stage3)) {
        if (noteData.stage3) {
          const s3 = noteData.stage3Revision || noteData.revision || noteData.stage2Revision || noteData.stage1Revision;
          if (s3 && !isPartialProposal(s3, targetText, item.note)) return s3;
        }
        if (noteData.stage2) {
          const s2 = noteData.stage2Revision || (!noteData.stage3 ? noteData.revision : "") || noteData.stage1Revision;
          if (s2 && !isPartialProposal(s2, targetText, item.note)) return s2;
        }
        if (noteData.stage1Revision && !isPartialProposal(noteData.stage1Revision, targetText, item.note)) {
          return noteData.stage1Revision;
        }
      }
      // 3. 普通单阶段行或已明确指定 revisionText 的行：优先遵循 item.revisionText
      if (Object.prototype.hasOwnProperty.call(item, "revisionText")) {
        const direct = String(item.revisionText || "");
        if (!isPartialProposal(direct, targetText, item.note)) return direct;
      }
      const finalRev = noteData?.revision || "";
      return isPartialProposal(finalRev, targetText, item.note) ? "" : finalRev;
    }

    function revisionTargetFor(item) {
      return normalizeRevisionTarget(item?.revisionTarget) || "cn";
    }

    function hasStoredNote(item) {
      return Boolean(item?.note);
    }

    function combinedNoteText(item) {
      return item?.note || "";
    }

    function pruneEmptyNote(id) {
      const item = notes[id];
      if (item && !hasStoredNote(item) && !revisionTextFor(item) && !item.done && !item.manualDone && !item.aiDone && !item.recoveredUnverified) delete notes[id];
    }

    function loadSavedAiConfig() {
      let globalConfig = {};
      try {
        globalConfig = JSON.parse(localStorage.getItem(aiConfigStorageKey) || "{}");
      } catch {
        globalConfig = {};
      }
      let projectConfig = {};
      try {
        if (projectAiConfigStorageKey) {
          projectConfig = JSON.parse(localStorage.getItem(projectAiConfigStorageKey) || "{}");
        }
      } catch {
        projectConfig = {};
      }
      if (!globalConfig || typeof globalConfig !== "object" || Array.isArray(globalConfig)) globalConfig = {};
      if (!projectConfig || typeof projectConfig !== "object" || Array.isArray(projectConfig)) projectConfig = {};
      return { ...globalConfig, ...projectConfig };
    }

    function isReasoningModelName(model) {
      return Boolean(getClientModelCapabilities(model).reasoning);
    }

    function isGptModelName(model) {
      return isReasoningModelName(model) || /(?:^|\/)gpt(?:-|$)/i.test(String(model || "").trim());
    }

    function rememberInferenceSetting() {
      const value = aiIds.reasoningEffort.value;
      if (aiIds.reasoningEffort.dataset.mode === "gpt" || aiIds.reasoningEffort.dataset.mode === "reasoning") {
        savedGptReasoningEffort = value;
      } else if (aiIds.reasoningEffort.dataset.mode === "intensity") {
        if (nonGptIntensityOptions.some(([optionValue]) => optionValue === value)) savedNonGptIntensity = value;
      }
    }

    function updateInferenceSettingOptions() {
      const model = aiIds.model.value;
      const caps = getClientModelCapabilities(model);
      const isReasoning = Boolean(caps.reasoning);
      const mode = isReasoning ? "reasoning" : "temperature";
      const reasoningEfforts = Array.isArray(caps.reasoningEfforts) && caps.reasoningEfforts.length > 0
        ? caps.reasoningEfforts
        : ["low", "medium", "high"];

      const reasoningOptions = buildReasoningOptions(caps);

      const currentEffortsKey = isReasoning ? reasoningEfforts.join(",") : "intensity";
      if (aiIds.reasoningEffort.dataset.effortsKey !== currentEffortsKey) {
        rememberInferenceSetting();
        const options = isReasoning ? reasoningOptions : nonGptIntensityOptions;
        aiIds.reasoningEffort.replaceChildren(...options.map(([value, label]) => {
          const option = document.createElement("option");
          option.value = value;
          option.textContent = label;
          return option;
        }));
        aiIds.reasoningEffort.dataset.mode = mode;
        aiIds.reasoningEffort.dataset.effortsKey = currentEffortsKey;
      }

      const validValues = (isReasoning ? reasoningOptions : nonGptIntensityOptions).map(([v]) => v);
      let targetValue = isReasoning ? savedGptReasoningEffort : savedNonGptIntensity;
      if (!validValues.includes(targetValue)) {
        targetValue = "";
      }
      aiIds.reasoningEffort.value = targetValue;
      aiIds.reasoningEffort.title = isReasoning
        ? ("该推理模型专属的推理强度档位（数据源：" + (caps.source || "检测") + "，绝不套用统一档位）")
        : "常规非推理模型文本化强度档位（低~最大，模型默认时不发送采样参数）";
      aiIds.reasoningField.hidden = false;
      aiIds.reasoningEffort.disabled = false;
      aiIds.serviceFields.classList.add("has-reasoning");
      syncEnhancedSelect(aiIds.reasoningEffort);
    }

    function loadSavedAiPrompt() {
      try {
        return JSON.parse(localStorage.getItem(aiPromptStorageKey) || "{}");
      } catch {
        return {};
      }
    }

    function updatePresetActionButtons() {
      const hasSelected = Boolean(currentPresetId && presetTools.getPreset(localStorage, currentPresetId));
      if (aiIds.presetSave) aiIds.presetSave.disabled = !hasSelected;
      if (aiIds.presetDelete) aiIds.presetDelete.disabled = !hasSelected;
    }

    function renderPresetOptions(selectedId = currentPresetId) {
      if (!aiIds.presetSelect) return;
      const presets = presetTools.listPresets(localStorage);
      const options = [
        { id: "", name: "-- 自定义 / 未选择预设 --" },
        ...presets.map((p) => ({ id: p.id, name: p.name })),
      ];
      aiIds.presetSelect.replaceChildren(...options.map((opt) => {
        const option = document.createElement("option");
        option.value = opt.id;
        option.textContent = opt.name;
        if (opt.id === selectedId) option.selected = true;
        return option;
      }));
      aiIds.presetSelect.value = selectedId || "";
      currentPresetId = aiIds.presetSelect.value;
      syncEnhancedSelect(aiIds.presetSelect);
      updatePresetActionButtons();

      if (aiIds.stage1Preset) {
        const currentStage1 = aiIds.stage1Preset.value;
        const s1Options = [
          { id: "", name: "使用主配置", title: "使用顶部 AI 服务填写的配置与并发" },
          ...presets.map((p) => {
            const conc = p.concurrency || 3;
            const concDetail = p.smartConcurrency ? conc + "~" + (p.concurrencyMax || 10) + "智能并发" : conc + "并发";
            return { id: p.id, name: p.name, title: p.name + "（" + (p.model || p.provider) + "，" + concDetail + "）" };
          }),
        ];
        aiIds.stage1Preset.replaceChildren(...s1Options.map((opt) => {
          const option = document.createElement("option");
          option.value = opt.id;
          option.textContent = opt.name;
          if (opt.title) option.title = opt.title;
          if (opt.id === currentStage1) option.selected = true;
          return option;
        }));
        if (currentStage1) aiIds.stage1Preset.value = currentStage1;
      }

      if (aiIds.stage2Preset) {
        const currentStage2 = aiIds.stage2Preset.value;
        const s2Options = [
          { id: "", name: "未启用", title: "未启用文学复审" },
          ...presets.map((p) => {
            const conc = p.concurrency || 3;
            const concDetail = p.smartConcurrency ? conc + "~" + (p.concurrencyMax || 10) + "智能并发" : conc + "并发";
            return { id: p.id, name: p.name, title: p.name + "（" + (p.model || p.provider) + "，" + concDetail + "）" };
          }),
        ];
        aiIds.stage2Preset.replaceChildren(...s2Options.map((opt) => {
          const option = document.createElement("option");
          option.value = opt.id;
          option.textContent = opt.name;
          if (opt.title) option.title = opt.title;
          if (opt.id === currentStage2) option.selected = true;
          return option;
        }));
        if (currentStage2) aiIds.stage2Preset.value = currentStage2;
      }

      if (aiIds.stage3Preset) {
        const currentStage3 = aiIds.stage3Preset.value;
        const s3Options = [
          { id: "", name: "未启用", title: "未启用终审仲裁" },
          ...presets.map((p) => {
            const conc = p.concurrency || 2;
            const concDetail = p.smartConcurrency ? conc + "~" + (p.concurrencyMax || 5) + "智能并发" : conc + "并发";
            return { id: p.id, name: p.name, title: p.name + "（" + (p.model || p.provider) + "，" + concDetail + "）" };
          }),
        ];
        aiIds.stage3Preset.replaceChildren(...s3Options.map((opt) => {
          const option = document.createElement("option");
          option.value = opt.id;
          option.textContent = opt.name;
          if (opt.title) option.title = opt.title;
          if (opt.id === currentStage3) option.selected = true;
          return option;
        }));
        if (currentStage3) aiIds.stage3Preset.value = currentStage3;
      }

      updateStagePresetDependencies();
    }

    function updateStagePresetDependencies() {
      const hasStage2 = Boolean(aiIds.stage2Preset?.value);
      if (aiIds.stage3Preset) {
        if (!hasStage2) {
          aiIds.stage3Preset.value = "";
          aiIds.stage3Preset.disabled = true;
          aiIds.stage3Preset.title = "需先在阶段二选择预设启用后，方可配置阶段三";
          aiIds.stage3Card?.classList.add("is-disabled");
        } else {
          aiIds.stage3Preset.disabled = false;
          aiIds.stage3Preset.title = "选择阶段三模型预设（不填代表不启用）";
          aiIds.stage3Card?.classList.remove("is-disabled");
        }
      }
      const pill2 = document.getElementById("stage2StatusPill");
      if (pill2 && pill2.dataset.state !== "running") {
        pill2.dataset.state = hasStage2 ? "idle" : "disabled";
        pill2.textContent = hasStage2 ? "待命" : "未启用";
      }
      const pill3 = document.getElementById("stage3StatusPill");
      if (pill3 && pill3.dataset.state !== "running") {
        const hasStage3 = hasStage2 && Boolean(aiIds.stage3Preset?.value);
        pill3.dataset.state = hasStage3 ? "idle" : "disabled";
        pill3.textContent = hasStage3 ? "待命" : "未启用";
      }
    }

    function applyPreset(preset) {
      if (!preset) return;
      if (preset.provider && ["local", "claude", "compatible"].includes(preset.provider)) {
        aiIds.provider.value = preset.provider;
        syncEnhancedSelect(aiIds.provider);
      }
      if (typeof preset.baseUrl === "string") {
        aiIds.baseUrl.value = preset.baseUrl;
        aiIds.baseUrl.dataset.touched = "1";
      }
      if (typeof preset.apiKey === "string") {
        aiIds.apiKey.value = preset.apiKey;
      }
      const options = Array.isArray(preset.modelOptions) && preset.modelOptions.length
        ? preset.modelOptions
        : (preset.model ? [preset.model] : []);
      setModelOptions(options, { selected: preset.model || "" });
      aiIds.model.dataset.touched = "1";

      const validGptValues = gptReasoningOptions.map(([value]) => value);
      const validIntensityValues = nonGptIntensityOptions.map(([value]) => value);
      if (preset.gptReasoningEffort && validGptValues.includes(preset.gptReasoningEffort)) {
        savedGptReasoningEffort = preset.gptReasoningEffort;
      }
      if (preset.nonGptIntensity && validIntensityValues.includes(preset.nonGptIntensity)) {
        savedNonGptIntensity = preset.nonGptIntensity;
      }
      updateInferenceSettingOptions();
      if (preset.reasoningEffort) {
        aiIds.reasoningEffort.value = preset.reasoningEffort;
        rememberInferenceSetting();
        syncEnhancedSelect(aiIds.reasoningEffort);
      }
      if (preset.concurrency != null) {
        aiIds.concurrency.value = preset.concurrency;
      }
      if (preset.smartConcurrency != null && aiIds.smartConcurrency) {
        aiIds.smartConcurrency.checked = Boolean(preset.smartConcurrency);
      }
      if (preset.concurrencyMax != null && aiIds.concurrencyMax) {
        aiIds.concurrencyMax.value = preset.concurrencyMax;
      }
      updateConcurrencyControls();
      if (preset.breakerThreshold != null) {
        aiIds.breakerThreshold.value = formatPercentRatio(preset.breakerThreshold, 0.5, 0.1);
      }
      if (preset.breakerDisabled != null) {
        aiIds.breakerDisabled.checked = Boolean(preset.breakerDisabled);
      }
      updateBreakerControls();
      currentPresetId = preset.id;
      if (aiIds.presetSelect) aiIds.presetSelect.value = preset.id;
      syncEnhancedSelect(aiIds.presetSelect);
      updatePresetActionButtons();
      saveAiConfig();
    }

    function saveAiConfig() {
      rememberInferenceSetting();
      const prevSaved = loadSavedAiConfig();
      const smartConcurrency = aiIds.smartConcurrency
        ? Boolean(aiIds.smartConcurrency.checked)
        : Boolean(prevSaved.smartConcurrency);
      const concurrencyMax = aiIds.concurrencyMax
        ? aiIds.concurrencyMax.value
        : (prevSaved.concurrencyMax != null ? prevSaved.concurrencyMax : 10);
      const config = {
        provider: aiIds.provider ? aiIds.provider.value : (prevSaved.provider || ""),
        baseUrl: aiIds.baseUrl ? aiIds.baseUrl.value : (prevSaved.baseUrl || ""),
        model: aiIds.model ? aiIds.model.value : (prevSaved.model || ""),
        reasoningEffort: aiIds.reasoningEffort ? aiIds.reasoningEffort.value : (prevSaved.reasoningEffort || ""),
        inferenceSettingVersion: 3,
        gptReasoningEffort: savedGptReasoningEffort,
        nonGptIntensity: savedNonGptIntensity,
        modelOptions: aiModelOptions,
        modelOptionsBaseUrl: aiModelOptions.length && aiIds.baseUrl ? normalizeApiBaseUrl(aiIds.baseUrl.value) : (prevSaved.modelOptionsBaseUrl || ""),
        apiKey: aiIds.apiKey ? aiIds.apiKey.value : (prevSaved.apiKey || ""),
        proofreadMode: aiIds.proofreadMode ? aiIds.proofreadMode.value : (prevSaved.proofreadMode || ""),
        target: aiIds.target ? aiIds.target.value : (prevSaved.target || ""),
        profileId: aiIds.profile ? aiIds.profile.value : (prevSaved.profileId || ""),
        concurrency: aiIds.concurrency ? aiIds.concurrency.value : (prevSaved.concurrency != null ? prevSaved.concurrency : "3"),
        smartConcurrency,
        concurrencyMax,
        breakerThreshold: aiIds.breakerThreshold ? formatPercentRatio(aiIds.breakerThreshold.value, 0.5, 0.1) : (prevSaved.breakerThreshold || "50%"),
        breakerDisabled: aiIds.breakerDisabled ? aiIds.breakerDisabled.checked : Boolean(prevSaved.breakerDisabled),
        similarity: prefilterIds.similarity ? formatPercentRatio(prefilterIds.similarity.value) : (prevSaved.similarity || "92%"),
        promptVisible: Boolean(aiIds.promptVisible?.checked),
        currentPresetId: currentPresetId || "",
        stage1PresetId: aiIds.stage1Preset?.value || "",
        stage2PresetId: aiIds.stage2Preset?.value || "",
        stage3PresetId: aiIds.stage3Preset?.value || "",
      };
      localStorage.setItem(aiConfigStorageKey, JSON.stringify(config));
      if (projectAiConfigStorageKey) {
        localStorage.setItem(projectAiConfigStorageKey, JSON.stringify(config));
      }
    }

    function saveAiPrompt() {
      if (!aiIds.prompt) return;
      localStorage.setItem(aiPromptStorageKey, JSON.stringify({
        systemPrompt: aiIds.prompt.value,
        promptTouched: Boolean(aiIds.prompt.dataset.touched),
      }));
    }

    function restoreAiConfig() {
      renderPresetOptions();
      const saved = loadSavedAiConfig();
      const savedPrompt = loadSavedAiPrompt();
      if (saved && saved.currentPresetId && presetTools.getPreset(localStorage, saved.currentPresetId)) {
        currentPresetId = saved.currentPresetId;
        if (aiIds.presetSelect) aiIds.presetSelect.value = currentPresetId;
        syncEnhancedSelect(aiIds.presetSelect);
        updatePresetActionButtons();
      }
      if (!saved || typeof saved !== "object") return;
      if (saved.provider && providerDefaults[saved.provider]) aiIds.provider.value = saved.provider;
      if (typeof saved.baseUrl === "string") {
        aiIds.baseUrl.value = saved.baseUrl;
        aiIds.baseUrl.dataset.touched = "1";
      }
      const savedModelOptions = restorableModelOptions(saved);
      if (savedModelOptions.length) {
        setModelOptions(savedModelOptions, { selected: saved.model });
        aiIds.model.dataset.touched = "1";
      } else if (typeof saved.model === "string" && saved.model) {
        setModelOptions([saved.model], { selected: saved.model });
        aiIds.model.dataset.touched = "1";
      }
      if (typeof saved.apiKey === "string") aiIds.apiKey.value = saved.apiKey;
      const validGptValues = gptReasoningOptions.map(([value]) => value);
      const validIntensityValues = nonGptIntensityOptions.map(([value]) => value);
      if (validGptValues.includes(saved.gptReasoningEffort)) savedGptReasoningEffort = saved.gptReasoningEffort;
      if (saved.inferenceSettingVersion === 3 && validIntensityValues.includes(String(saved.nonGptIntensity))) {
        savedNonGptIntensity = String(saved.nonGptIntensity);
      } else if (saved.inferenceSettingVersion === 2) {
        // 旧版数值 temperature 迁移到语义档位
        const legacy = legacyTemperatureToIntensity[String(saved.nonGptTemperature)];
        if (legacy) savedNonGptIntensity = legacy;
      }
      if (isGptModelName(aiIds.model.value) && validGptValues.includes(saved.reasoningEffort)) {
        savedGptReasoningEffort = saved.reasoningEffort;
      }
      if (saved.target === "cn" || saved.target === "tw") aiIds.target.value = saved.target;
      if (bilingualMode) aiIds.target.value = "cn";
      if (typeof saved.profileId === "string"
        && Array.from(aiIds.profile.options).some((option) => option.value === saved.profileId)) {
        aiIds.profile.value = saved.profileId;
      }
      if (saved.concurrency != null) aiIds.concurrency.value = saved.concurrency;
      if (saved.smartConcurrency != null && aiIds.smartConcurrency) {
        aiIds.smartConcurrency.checked = Boolean(saved.smartConcurrency);
      }
      if (saved.concurrencyMax != null && aiIds.concurrencyMax) {
        aiIds.concurrencyMax.value = saved.concurrencyMax;
      }
      updateConcurrencyControls();
      if (saved.breakerThreshold != null) aiIds.breakerThreshold.value = formatPercentRatio(saved.breakerThreshold, 0.5, 0.1);
      aiIds.breakerDisabled.checked = Boolean(saved.breakerDisabled);
      updateBreakerControls();
      if (saved.similarity != null) prefilterIds.similarity.value = formatPercentRatio(saved.similarity);
      if (aiIds.promptVisible) aiIds.promptVisible.checked = Boolean(saved.promptVisible);
      if (typeof savedPrompt.systemPrompt === "string" && savedPrompt.systemPrompt) {
        if (savedPrompt.promptTouched && aiIds.prompt) {
          aiIds.prompt.value = savedPrompt.systemPrompt;
          aiIds.prompt.dataset.touched = "1";
        } else {
          defaultProofreadPrompt = defaultPromptForProfile(aiIds.profile.value) || defaultProofreadPrompt;
          if (aiIds.prompt) {
            aiIds.prompt.value = defaultProofreadPrompt;
            aiIds.prompt.dataset.touched = "";
          }
        }
      }
      if (aiIds.promptVisible && aiIds.promptSection) aiIds.promptSection.hidden = !aiIds.promptVisible.checked;
      normalizeSimilarityInput();
      updateProofreadModeHint();
      updateInferenceSettingOptions();
      if (saved.stage1PresetId && aiIds.stage1Preset) {
        aiIds.stage1Preset.value = saved.stage1PresetId;
      }
      if (saved.stage2PresetId && aiIds.stage2Preset) {
        aiIds.stage2Preset.value = saved.stage2PresetId;
      }
      if (saved.stage3PresetId && aiIds.stage3Preset) {
        aiIds.stage3Preset.value = saved.stage3PresetId;
      }
      updateStagePresetDependencies();
    }

    function bindDetailsToggle(scope = document) {
      scope.querySelectorAll("summary").forEach((summary) => {
        if (summary.closest(".notes-space-details")) return;
        if (summary.dataset.toggleBound) return;
        summary.dataset.toggleBound = "1";
        summary.addEventListener("click", (event) => {
          const button = event.target.closest("[data-details-toggle]");
          if (!button) {
            event.preventDefault();
            return;
          }
          event.preventDefault();
          const details = summary.closest("details");
          if (details) {
            details.open = !details.open;
            // 抽屉开合会把下方表格推上推下：位置真的变了才重算可用高度。
            scheduleVisibleRowLayoutSync({ ifFrameMoved: true });
          }
        });
        summary.addEventListener("keydown", (event) => {
          if (event.target.closest("[data-details-toggle]")) return;
          if (event.key === "Enter" || event.key === " ") event.preventDefault();
        });
      });
    }

    function syncPanelGroupState(group) {
      const items = Array.from(group.querySelectorAll("details.panel-details"));
      const state = group.querySelector("[data-panel-group-state]");
      if (!state) return;
      const openCount = items.filter((item) => item.open).length;
      state.textContent = openCount === 0
        ? items.length + " 项全部收起"
        : "已展开 " + openCount + "/" + items.length + " 项";
    }

    function bindPanelGroups(scope = document) {
      scope.querySelectorAll("[data-panel-group]").forEach((group) => {
        if (group.dataset.panelGroupBound) return;
        group.dataset.panelGroupBound = "1";
        // toggle 事件不冒泡，用捕获阶段同步组内任意抽屉的展开状态
        group.addEventListener("toggle", () => syncPanelGroupState(group), true);
        syncPanelGroupState(group);
      });
    }

    // ---- 浏览器标签页式控制栈 (Browser Tab Bar) ----
    function initWorkbenchTabs() {
      if (typeof HTMLElement === "undefined" || typeof document === "undefined" || !document.querySelector || !document.createElement) return;
      const panelGroup = document.getElementById("controlStackPanel");
      const groupBody = document.querySelector(".panel-group-body");
      if (!groupBody || groupBody.dataset.tabsInitialized) return;
      groupBody.dataset.tabsInitialized = "1";

      const tabConfigs = [
        { id: "prefilterPanel", title: "预筛选", icon: "🔍", stateId: "prefilterPanelState" },
        { id: "aiPanel", title: "AI 辅助校对", icon: "🤖", stateId: "aiPanelState" },
        { id: "filterPanel", title: "筛选与批处理", icon: "⚡", stateId: "filterPanelState" },
        { id: "notesPanel", title: "备注空间与找回", icon: "💾", stateId: "notesSaveState" },
      ];

      const panels = tabConfigs
        .map((cfg) => ({ ...cfg, el: document.getElementById(cfg.id) }))
        .filter((item) => item.el);
      if (panels.length === 0) return;

      function appendChildSafe(parent, child) {
        if (typeof parent.appendChild === "function") {
          parent.appendChild(child);
        } else if (typeof parent.append === "function") {
          parent.append(child);
        }
      }

      const tabsBar = document.createElement("div");
      tabsBar.className = "workbench-tabs-bar";
      tabsBar.setAttribute("role", "tablist");
      tabsBar.setAttribute("aria-label", "控制面板标签页");

      const tabsList = document.createElement("div");
      tabsList.className = "workbench-tabs-list";

      const tabMap = new Map();

      panels.forEach(({ id, title, icon, stateId, el }) => {
        const tabBtn = document.createElement("button");
        tabBtn.type = "button";
        tabBtn.className = "workbench-tab";
        tabBtn.setAttribute("role", "tab");
        tabBtn.setAttribute("aria-controls", id);
        tabBtn.setAttribute("aria-selected", el.open ? "true" : "false");
        if (el.open) tabBtn.classList.add("is-active");

        const iconSpan = document.createElement("span");
        iconSpan.className = "workbench-tab-icon";
        iconSpan.textContent = icon;

        const titleSpan = document.createElement("span");
        titleSpan.className = "workbench-tab-title";
        titleSpan.textContent = title;

        const badgeSpan = document.createElement("span");
        badgeSpan.className = "workbench-tab-badge";
        const stateEl = document.getElementById(stateId);
        badgeSpan.textContent = stateEl ? stateEl.textContent.trim() : "";

        appendChildSafe(tabBtn, iconSpan);
        appendChildSafe(tabBtn, titleSpan);
        appendChildSafe(tabBtn, badgeSpan);

        tabBtn.addEventListener("click", (e) => {
          e.preventDefault();
          const wasOpen = el.open;
          if (wasOpen) {
            // 点击已展开的活跃标签：直接收起当前面板
            el.open = false;
          } else {
            // 点击其他标签：展开目标面板，并互斥收起所有其他面板
            panels.forEach((p) => {
              p.el.open = p.id === id;
            });
          }
          updateTabsActiveState();
          // 标签页互斥展开会把表格推上推下：位置真的变了才重算可用高度。
          scheduleVisibleRowLayoutSync({ ifFrameMoved: true });
        });

        appendChildSafe(tabsList, tabBtn);
        tabMap.set(id, { btn: tabBtn, badge: badgeSpan, stateId, el });
      });

      appendChildSafe(tabsBar, tabsList);

      if (typeof groupBody.insertBefore === "function") {
        groupBody.insertBefore(tabsBar, groupBody.firstChild);
      } else if (typeof groupBody.append === "function") {
        groupBody.append(tabsBar);
      }
      groupBody.classList.add("has-workbench-tabs");
      if (panelGroup) panelGroup.classList.add("tabs-mode");

      function updateTabsActiveState() {
        panels.forEach(({ id, el }) => {
          const entry = tabMap.get(id);
          if (!entry) return;
          if (el.open) {
            entry.btn.classList.add("is-active");
            entry.btn.setAttribute("aria-selected", "true");
          } else {
            entry.btn.classList.remove("is-active");
            entry.btn.setAttribute("aria-selected", "false");
          }
        });
      }

      // 监听原生 details 的 toggle 事件，保持与外部脚本控制双向同步
      panels.forEach(({ id, el }) => {
        el.addEventListener("toggle", () => {
          if (el.open) {
            // 互斥打开：确保只有一个面板处于展开状态
            panels.forEach((other) => {
              if (other.id !== id && other.el.open) {
                other.el.open = false;
              }
            });
          }
          updateTabsActiveState();
        });
      });

      // 同步标签徽章文字与运行状态
      function syncTabBadges() {
        tabMap.forEach(({ badge, stateId }) => {
          const src = document.getElementById(stateId);
          if (src) {
            badge.textContent = src.textContent.trim();
            if (src.classList.contains("is-running")) {
              badge.classList.add("is-running");
            } else {
              badge.classList.remove("is-running");
            }
            if (src.classList.contains("is-warn")) {
              badge.classList.add("is-warn");
            } else {
              badge.classList.remove("is-warn");
            }
          }
        });
      }

      setInterval(syncTabBadges, 800);
      syncTabBadges();
      updateTabsActiveState();
    }

    function setRuntimeStatus(message) {
      aiIds.status.dataset.runtimeMessage = "1";
      aiIds.status.textContent = message;
      aiIds.status.title = message;
    }

    // ---- 浮动提示（Toast）----
    // 按钮与控件的一次性回执走这里。这类消息原先写进 AI 抽屉里的固定状态行，而五个抽屉默认全部折叠，
    // 用户在「筛选与批处理」里点批量按钮、在行内点「写回」时，回执被写进一个看不见的位置。固定状态行只留
    // 「机器任务的持续状态」（正在跑什么、跑完的统计、未连接本地服务、被跳过/忽略的结果汇总），
    // 一次性回执一律浮动提示。
    const toastMaxVisible = 4;
    const toastDurationScale = 0.5;
    const toastFadeMs = 180;
    const toasts = [];
    let toastSeq = 0;
    // 本页亲眼看到「正在运行」的那一轮：只有它跑完才弹结束提示。页面刚打开时从服务端认领到的
    // 历史轮次（没看到运行中）不弹，否则每次重新生成工作台都会收到一条过期回执。
    let observedRunningRunId = "";
    let notifiedFinishedRunId = "";

    // tone 表示结果的语气：info 中性、success 成功、watch 需要留意但没失败、error 失败。
    // durationMs <= 0 表示不自动消失（等下一步结果替换它，或人工关闭）。
    function showToast(message, { tone = "info", durationMs = 6000 } = {}) {
      const text = String(message ?? "").trim();
      if (!text) return "";
      const stack = document.getElementById("toastStack");
      if (!stack) return "";
      // 同一条消息连续出现（例如地址输入框每敲一个字符就提示一次）只保留一条，并顺延它的存活时间。
      const last = toasts[toasts.length - 1];
      if (last && last.message === text && last.tone === tone) {
        if (last.timer) window.clearTimeout(last.timer);
        last.timer = toastTimer(last, durationMs);
        return last.id;
      }
      const node = document.createElement("div");
      node.className = "toast toast--" + tone;
      node.setAttribute("role", tone === "error" ? "alert" : "status");
      node.dataset.toastId = String(++toastSeq);
      const line = document.createElement("span");
      line.className = "toast-text";
      line.textContent = text;
      const close = document.createElement("button");
      close.type = "button";
      close.className = "toast-dismiss";
      close.textContent = "×";
      close.setAttribute("aria-label", "关闭提示");
      close.addEventListener("click", () => dismissToast(node.dataset.toastId));
      node.append(line, close);
      stack.append(node);
      const toast = { id: node.dataset.toastId, message: text, tone, node, timer: 0 };
      toasts.push(toast);
      toast.timer = toastTimer(toast, durationMs);
      while (toasts.length > toastMaxVisible) dismissToast(toasts[0].id);
      return toast.id;
    }

    function toastTimer(toast, durationMs) {
      const visibleMs = durationMs > 0 ? Math.max(1, Math.round(durationMs * toastDurationScale)) : 0;
      return visibleMs > 0 ? window.setTimeout(() => dismissToast(toast.id), visibleMs) : 0;
    }

    function dismissToast(id) {
      const index = toasts.findIndex((toast) => toast.id === String(id ?? ""));
      if (index < 0) return false;
      const [toast] = toasts.splice(index, 1);
      if (toast.timer) window.clearTimeout(toast.timer);
      const node = toast.node;
      if (!node) return true;
      if (typeof node.classList?.add === "function") node.classList.add("toast--leaving");
      let removed = false;
      const remove = () => {
        if (removed) return;
        removed = true;
        if (typeof node.remove === "function") node.remove();
      };
      if (typeof node.addEventListener === "function") node.addEventListener("animationend", remove, { once: true });
      window.setTimeout(remove, toastFadeMs + 80);
      return true;
    }

    function clearLocalAiCache() {
      appliedAiResults.clear();
      aiActiveIds.clear();
      activeRowId = "";
      lastAiRunId = "";
      lastAiResultRevision = 0;
      aiIds.progress.style.width = "0%";
      aiIds.progressWrap.hidden = true;
      updateRenderedAiActive();
    }

    function renderClearedAiStatus(message = "已清除 AI 运行记录；备注与人工确认已保留。") {
      aiIds.start.disabled = false;
      aiIds.stop.disabled = true;
      prefilterIds.start.disabled = false;
      prefilterIds.confirm.disabled = true;
      prefilterIds.stop.disabled = true;
      prefilterIds.stats.textContent = "尚未运行预筛选。";
      if (prefilterIds.panelState) prefilterIds.panelState.textContent = "尚未运行";
      if (aiIds.panelState) {
        aiIds.panelState.textContent = "就绪";
        aiIds.panelState.className = "ai-status-badge";
      }
      aiIds.status.dataset.cacheCleared = "1";
      setRuntimeStatus(message);
      aiIds.progress.style.width = "0%";
      aiIds.progressWrap.hidden = true;
      aiActiveIds.clear();
      prefilterResultIds.clear();
      prefilterRunId = "";
      prefilterResultFilterActive = false;
      prefilterResultsCatchingUp = false;
      prefilterResultFilter.disabled = true;
      prefilterResultFilter.classList.remove("is-active");
      prefilterResultFilter.setAttribute("aria-pressed", "false");
      updateRenderedAiActive();
      applyFilters({ reset: false });
    }

    function enhanceSelect(select) {
      if (!select || select.dataset.enhanced) return;
      select.dataset.enhanced = "1";
      select.classList.add("enhanced-select");

      const wrapper = document.createElement("div");
      wrapper.className = "select-combobox";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "select-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      const value = document.createElement("span");
      value.className = "select-value";
      const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      icon.setAttribute("class", "select-icon");
      icon.setAttribute("viewBox", "0 0 16 16");
      icon.setAttribute("fill", "none");
      icon.setAttribute("aria-hidden", "true");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M4.75 6.25L8 9.5L11.25 6.25");
      path.setAttribute("stroke", "currentColor");
      path.setAttribute("stroke-width", "1.75");
      path.setAttribute("stroke-linecap", "round");
      path.setAttribute("stroke-linejoin", "round");
      icon.append(path);
      trigger.append(value, icon);

      const menu = document.createElement("div");
      menu.className = "select-menu";
      menu.setAttribute("role", "listbox");
      menu.hidden = true;

      select.parentNode.insertBefore(wrapper, select);
      wrapper.append(select, trigger, menu);

      function selectedOption() {
        return select.options[select.selectedIndex] || select.options[0];
      }

      function sync() {
        const selected = selectedOption();
        value.textContent = selected?.textContent || "";
        trigger.title = selected?.textContent || "";
        trigger.disabled = Boolean(select.disabled);
        menu.replaceChildren(...Array.from(select.options).map((option) => {
          const item = document.createElement("button");
          item.type = "button";
          item.className = "select-option";
          item.setAttribute("role", "option");
          item.dataset.value = option.value;
          item.textContent = option.textContent;
          if (option.value === select.value) {
            item.classList.add("is-selected");
            item.setAttribute("aria-selected", "true");
          } else {
            item.setAttribute("aria-selected", "false");
          }
          item.disabled = option.disabled;
          return item;
        }));
      }

      function close() {
        wrapper.classList.remove("is-open", "drop-up");
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }

      function open() {
        if (select.disabled || trigger.disabled) return;
        closeAllSelects(wrapper);
        sync();
        wrapper.classList.add("is-open");
        const rect = trigger.getBoundingClientRect();
        const spaceBelow = window.innerHeight - rect.bottom;
        const spaceAbove = rect.top;
        if (spaceBelow < 160 && spaceAbove > spaceBelow) {
          wrapper.classList.add("drop-up");
        } else {
          wrapper.classList.remove("drop-up");
        }
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
      }

      trigger.addEventListener("click", () => {
        if (menu.hidden) open();
        else close();
      });

      menu.addEventListener("click", (event) => {
        const item = event.target.closest(".select-option");
        if (!item || item.disabled) return;
        select.value = item.dataset.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        close();
        trigger.focus();
      });

      trigger.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          close();
          return;
        }
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp" && event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (menu.hidden) {
          open();
          return;
        }
        const options = Array.from(menu.querySelectorAll(".select-option:not(:disabled)"));
        if (!options.length) return;
        const selectedIndex = Math.max(0, options.findIndex((item) => item.dataset.value === select.value));
        const nextIndex = event.key === "ArrowUp"
          ? Math.max(0, selectedIndex - 1)
          : Math.min(options.length - 1, selectedIndex + 1);
        if (event.key === "Enter" || event.key === " ") {
          options[selectedIndex].click();
          return;
        }
        for (const option of options) option.classList.remove("is-active");
        const next = options[nextIndex];
        next.classList.add("is-active");
        const nextTop = next.offsetTop;
        const nextBottom = nextTop + next.offsetHeight;
        if (nextTop < menu.scrollTop) menu.scrollTop = nextTop;
        if (nextBottom > menu.scrollTop + menu.clientHeight) {
          menu.scrollTop = nextBottom - menu.clientHeight;
        }
      });

      select.addEventListener("change", sync);
      select._syncEnhancedSelect = sync;
      sync();
    }

    function closeAllSelects(except) {
      for (const wrapper of document.querySelectorAll(".select-combobox")) {
        if (wrapper === except) continue;
        wrapper.classList.remove("is-open", "drop-up");
        const menu = wrapper.querySelector(".select-menu");
        const trigger = wrapper.querySelector(".select-trigger");
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
      }
    }

    document.addEventListener("click", (event) => {
      if (!event.target.closest(".select-combobox")) closeAllSelects();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeAllSelects();
    });

    function syncEnhancedSelect(select) {
      select?._syncEnhancedSelect?.();
    }

    function diffCacheKey(row) {
      return row.signature || String(row.index);
    }

    function renderRowDiffHtml(row) {
      if (!row.cn || !row.twCn) return "";
      const key = diffCacheKey(row);
      if (diffHtmlCache.has(key)) return diffHtmlCache.get(key);
      const html = inlineDiffHtml(row.cn, row.twCn);
      diffHtmlCache.set(key, html);
      return html;
    }

    function renderDiffBlock(row, item) {
      const twDiffHtml = renderRowDiffHtml(row);
      const revision = revisionTextFor(item, row);
      const targetKey = revisionTargetFor(item);
      const targetText = targetKey === "tw" ? row.tw : row.cn;
      const revisionDiffHtml = targetText && revision ? inlineDiffHtml(targetText, revision) : "";
      const revisionMatchesTw = targetKey === "cn" && Boolean(twDiffHtml && revisionDiffHtml && twDiffHtml === revisionDiffHtml);
      const comparisons = [];
      if (twDiffHtml && !revisionMatchesTw) {
        comparisons.push({
          kind: "translation",
          html: '<div class="diff-comparison" data-diff-kind="translation">' +
          '<div class="version-label"><span>' + escapeHtml(pageLabels.cn) + ' → ' + escapeHtml(pageLabels.tw) + '简体化</span></div>' +
          '<div lang="zh-Hans">' + twDiffHtml + '</div>' +
          '</div>',
        });
      }
      if (revisionDiffHtml) {
        const matchBadge = revisionMatchesTw
          ? '<span class="diff-match-badge" title="与' + escapeHtml(pageLabels.tw) + '简体化的差异完全相同">同' + escapeHtml(pageLabels.tw) + '简体化</span>'
          : "";

        const noteData = parseAutomatedNote(item?.note, targetText);
        const s1Rev = noteData?.stage1Revision;
        const hasStage2 = Boolean(noteData && (noteData.stage2 || String(item?.note || "").includes("Stylist复审")));
        const hasStage3 = Boolean(noteData && (noteData.stage3 || String(item?.note || "").includes("Arbiter仲裁")));
        const hasStepProgression = Boolean(hasStage2 || hasStage3);

        const lang = targetKey === "tw" ? "zh-Hant" : "zh-Hans";
        let stepProgressionHtml = "";

        if (hasStepProgression) {
          // 防呆校验：若 s1Rev 包含日文假名，或初审意图为删除/增译且 s1Rev 恰为被指出待删除的缺陷短语，不能作为初审改案展示
          const isDeleteWord = Boolean(
            s1Rev &&
            noteData?.stage1 &&
            /(?:删除|删去|删掉|去除|去掉|增译|无中生有|多余|不应有)/.test(noteData.stage1) &&
            (noteData.stage1.includes("「" + s1Rev + "」") ||
             noteData.stage1.includes("“" + s1Rev + "”") ||
             noteData.stage1.includes("‘" + s1Rev + "’") ||
             (s1Rev.length <= 12 && noteData.stage1.includes(s1Rev)) ||
             targetText.includes(s1Rev))
          );
          const hasKana = Boolean(s1Rev && /[\u3040-\u309F\u30A0-\u30FF]/.test(s1Rev));
          const p1 = (isDeleteWord || hasKana) ? "" : s1Rev;
          const p1IsPartial = isPartialProposal(p1, targetText, item?.note);

          // p2: 复审改案
          let p2 = String(noteData?.stage2Revision || "").trim();
          if (!p2 && hasStage2) {
            if (noteData.stage2?.attitude?.includes("采纳")) {
              p2 = p1IsPartial ? "" : (p1 || targetText);
            } else if (!hasStage3 && noteData.revision) {
              p2 = String(noteData.revision || "").trim();
            }
          }

          // p3: 仲裁定案
          let p3 = String(noteData?.stage3Revision || "").trim();
          if (!p3 && hasStage3) {
            if (noteData.stage3 && noteData.revision && !isPartialProposal(noteData.revision, targetText, item?.note)) {
              p3 = String(noteData.revision || "").trim();
            }
          }

          // 步骤 1：事实初审 (p0 -> p1)
          let s1StepLabel = "步骤 1：事实初审";
          let s1StepSubLabel = "初审改案";
          let s1DiffHtml = "";
          if (p1) {
            const isPartialPhrase = p1IsPartial;
            s1StepSubLabel = isPartialPhrase ? "局部修正提议" : (escapeHtml(pageLabels[targetKey] || targetKey) + " → 初审改案");
            s1DiffHtml = isPartialPhrase
              ? '<div class="diff-partial-phrase"><span>建议替换为：</span><ins>' + escapeHtml(p1) + '</ins></div>'
              : inlineDiffHtml(targetText, p1);
          } else {
            s1StepSubLabel = "事实审查重点";
            s1DiffHtml = '<div class="diff-partial-phrase"><span>审查要点：</span><span class="diff-step-audit-point">' + escapeHtml(noteData.stage1 || "指出事实性硬伤") + '</span></div>';
          }

          // p2 diff: p1 -> p2
          const baseForP2 = p1IsPartial ? targetText : (p1 || targetText);
          let s2StepSubLabel = p1 ? (p1IsPartial ? "复审审查初审局部提议" : "初审改案 → 复审改案") : "全句文学润色";
          if (p2 && p2 === p1 && !p1IsPartial) {
            s2DiffHtml = '<div class="diff-partial-phrase"><span>复审采纳初审方案，无进一步文字调整</span></div>';
          } else if (p1IsPartial && noteData.stage2?.attitude?.includes("采纳") && !p2) {
            s2DiffHtml = '<div class="diff-partial-phrase"><span>复审采纳初审局部提议，无进一步全句重写</span></div>';
          } else if (p2) {
            s2DiffHtml = inlineDiffHtml(baseForP2, p2);
          } else {
            s2DiffHtml = inlineDiffHtml(baseForP2, revision || targetText);
          }

          // 步骤 3：终审仲裁 (p2 -> p3，若有仲裁)
          let stage3StepBlock = "";
          if (hasStage3) {
            const baseForP3 = p2 || baseForP2;
            let s3DiffHtml = "";
            if (p3 && p3 === p2 && p2) {
              s3DiffHtml = '<div class="diff-partial-phrase"><span>终审裁定采纳复审方案</span></div>';
            } else if (p3 && p3 === p1 && p1 && !p1IsPartial) {
              s3DiffHtml = '<div class="diff-partial-phrase"><span>终审裁定采纳初审方案</span></div>';
            } else if (p1IsPartial && (!p3 || p3 === p1)) {
              s3DiffHtml = '<div class="diff-partial-phrase"><span>终审裁定采纳复审建议（维持原译主结构，局部修正见初审）</span></div>';
            } else if (p3 && p3 === targetText) {
              s3DiffHtml = '<div class="diff-partial-phrase"><span>终审裁定维持原译</span></div>';
            } else if (p3) {
              s3DiffHtml = inlineDiffHtml(baseForP3, p3);
            } else {
              s3DiffHtml = inlineDiffHtml(baseForP3, revision || targetText);
            }
            stage3StepBlock = '<div class="diff-comparison is-stage-step is-arbiter" data-diff-kind="stage3-step">' +
              '<div class="version-label"><span class="diff-step-pill is-arbiter">步骤 3：终审仲裁</span><span>' + (p2 ? '复审改案 → 仲裁定案' : '初审改案 → 仲裁定案') + '</span></div>' +
              '<div lang="' + (targetKey === "tw" ? "zh-Hant" : "zh-Hans") + '">' + s3DiffHtml + '</div>' +
            '</div>';
          }

          stepProgressionHtml = '<details open class="diff-step-details">' +
            '<summary class="diff-step-summary">分步演进明细（' + (hasStage3 ? '初审 ➔ 复审 ➔ 仲裁' : '初审 ➔ 复审') + '）▾</summary>' +
            '<div class="diff-step-content">' +
              '<div class="diff-comparison is-stage-step is-gk" data-diff-kind="stage1-step">' +
                '<div class="version-label"><span class="diff-step-pill is-gk">' + s1StepLabel + '</span><span>' + s1StepSubLabel + '</span></div>' +
                '<div lang="' + (targetKey === "tw" ? "zh-Hant" : "zh-Hans") + '">' + s1DiffHtml + '</div>' +
              '</div>' +
              '<div class="diff-comparison is-stage-step is-stylist" data-diff-kind="stage2-step">' +
                '<div class="version-label"><span class="diff-step-pill is-stylist">步骤 2：文学复审</span><span>' + s2StepSubLabel + '</span></div>' +
                '<div lang="' + (targetKey === "tw" ? "zh-Hant" : "zh-Hans") + '">' + s2DiffHtml + '</div>' +
              '</div>' +
              stage3StepBlock +
            '</div>' +
          '</details>';
        }

        comparisons.push({
          kind: "revision",
          html: '<div class="diff-comparison" data-diff-kind="revision">' +
          '<div class="version-label"><span>' + escapeHtml(pageLabels[targetKey] || targetKey) + ' → 修改结果</span>' + matchBadge + '</div>' +
          '<div lang="' + (targetKey === "tw" ? "zh-Hant" : "zh-Hans") + '">' + revisionDiffHtml + '</div>' +
          stepProgressionHtml +
          '</div>',
        });
      }
      const hasTranslation = comparisons.some((item) => item.kind === "translation");
      const hasRevision = comparisons.some((item) => item.kind.startsWith("revision") || item.kind.includes("step"));
      return comparisons.length
        ? '<section class="diff-block" data-diff data-has-translation="' + (hasTranslation ? "1" : "0") + '" data-has-revision="' + (hasRevision ? "1" : "0") + '">' +
          '<div class="diff-title">差异辅助</div>' +
          comparisons.map((item) => item.html).join("") +
          '</section>'
        : "";
    }

    const inlineDiffHtml = WorkbenchDiff.createDiffRenderer({ escapeHtml, maxCacheSize: 3000 });

    function parseAutomatedNote(note, targetText = "") {
      if (!note) return null;
      const str = String(note);
      const cacheKey = targetText ? (str + "\u0000" + String(targetText)) : str;
      if (parsedAutomatedNoteCache.has(cacheKey)) {
        return parsedAutomatedNoteCache.get(cacheKey);
      }
      const data = parseAutomatedNoteUncached(str, targetText);
      if (parsedAutomatedNoteCache.size >= MAX_PARSED_NOTE_CACHE) {
        const oldestKey = parsedAutomatedNoteCache.keys().next().value;
        parsedAutomatedNoteCache.delete(oldestKey);
      }
      parsedAutomatedNoteCache.set(cacheKey, data);
      return data;
    }

    function parseAutomatedNoteUncached(note, targetText = "") {
      const lines = String(note || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (!automatedNoteMarker(lines[0])) return null;
      if (isAiFailureNote(note)) return null;
      const data = {
        semantic: "",
        modify: "",
        severity: "",
        grade: "",
        score: null,
        penalty: null,
        revision: "",
        analysis: "",
        stage1: "",
        stage1Revision: "",
        stage2: null,
        stage2Revision: "",
        stage3: null,
        stage3Revision: "",
      };
      let currentField = "";
      for (const line of lines.slice(1)) {
        if (line.startsWith("语义是否相同：")) {
          data.semantic = line.slice("语义是否相同：".length).trim();
          currentField = "";
        } else if (line.startsWith("是否需要修改：")) {
          data.modify = line.slice("是否需要修改：".length).trim();
          currentField = "";
        } else if (line.startsWith("Gatekeeper初审：")) {
          data.stage1 = line.slice("Gatekeeper初审：".length).trim();
          currentField = "";
        } else if (line.startsWith("初审改案：") || line.startsWith("初审建议：")) {
          data.stage1Revision = line.replace(/^(初审改案|初审建议)：/, "").trim();
          currentField = "";
        } else if (line.startsWith("Stylist复审")) {
          const match = line.match(/^Stylist复审(?:\[(.*?)\])?：(.*)$/);
          if (match) {
            data.stage2 = {
              attitude: match[1] || "复审",
              text: match[2]?.trim() || "",
            };
          }
          currentField = "";
        } else if (line.startsWith("复审改案：") || line.startsWith("复审建议：")) {
          data.stage2Revision = line.replace(/^(复审改案|复审建议)：/, "").trim();
          currentField = "";
        } else if (line.startsWith("Arbiter仲裁")) {
          const match = line.match(/^Arbiter仲裁(?:\[(.*?)\])?：(.*)$/);
          if (match) {
            data.stage3 = {
              winner: match[1] || "裁决",
              text: match[2]?.trim() || "",
            };
          }
          currentField = "";
        } else if (line.startsWith("仲裁改案：") || line.startsWith("仲裁建议：")) {
          data.stage3Revision = line.replace(/^(仲裁改案|仲裁建议)：/, "").trim();
          currentField = "";
        } else if (line.startsWith("质量评分：") || line.startsWith("评分：") || line.startsWith("翻译得分：")) {
          const match = line.match(/(\d+)\s*分?(?:（扣\s*(\d+)\s*分?）|\(扣\s*(\d+)\s*分?\))?/);
          if (match) {
            data.score = Number(match[1]);
            data.penalty = match[2] ? Number(match[2]) : (match[3] ? Number(match[3]) : 100 - data.score);
          }
          currentField = "";
        } else if (line.startsWith("质量分级：") || line.startsWith("质量等级：") || line.startsWith("分级：")) {
          data.grade = normalizeGrade(line.replace(/^(质量分级|质量等级|分级)：/, "").trim());
          currentField = "";
        } else if (line.startsWith("严重程度：") || line.startsWith("问题严重程度：")) {
          data.severity = normalizeIssueSeverity(line.replace(/^(问题)?严重程度：/, "").trim());
          currentField = "";
        } else if (line.startsWith("修改结果：") || line.startsWith("修改后：") || line.startsWith("修改后文本：")) {
          data.revision = line.replace(/^(修改结果|修改后|修改后文本)：/, "").trim();
          currentField = "revision";
        } else if (isNoteProseLine(line)) {
          // 标点自动规范化、低分归因、线上查证都写在分析栏里：它们不是成品文本，
          // 绝不能并进修改结果（旧备注就是这么被污染的，normalizeStoredNote 载入时会把它们剥出来）。
          data.analysis = [data.analysis, line].filter(Boolean).join("\n");
          currentField = "analysis";
        } else if (line.startsWith("建议改法：")) {
          data.analysis = [data.analysis, "建议改法：" + line.slice("建议改法：".length).trim()].filter(Boolean).join("\n");
          currentField = "analysis";
        } else if (line.startsWith("分析：") || line.startsWith("原因：") || line.startsWith("问题：")) {
          data.analysis = line.replace(/^(分析|原因|问题)：/, "").trim();
          currentField = "analysis";
        } else if (line.startsWith("分析过程：")) {
          data.analysis = line.slice("分析过程：".length).trim();
          currentField = "analysis";
        } else if (currentField === "revision") {
          data.revision = [data.revision, line].filter(Boolean).join("\n");
        } else {
          data.analysis = [data.analysis, line].filter(Boolean).join("\n");
          currentField = "analysis";
        }
      }

      if (data.score !== null && !data.grade) {
        if (data.score >= 90) data.grade = "excellent";
        else if (data.score >= 75) data.grade = "good";
        else if (data.score >= 60) data.grade = "fair";
        else data.grade = "poor";
      }
      if (!data.grade && data.severity) {
        if (data.severity === "critical") data.grade = "poor";
        else if (data.severity === "major") data.grade = "fair";
        else if (data.severity === "minor") data.grade = "good";
        else if (data.severity === "none") data.grade = "excellent";
      }
      if (!data.severity && data.grade) {
        if (data.grade === "poor") data.severity = "critical";
        else if (data.grade === "fair") data.severity = "major";
        else if (data.grade === "good") data.severity = "minor";
        else if (data.grade === "excellent") data.severity = "none";
      }

      // 容错与向后兼容：如果未显式解析出 stage1，但存在 analysis 且判定为「待人工确认」（或明确有审核痕迹），
      // 将其作为初审事实意见保留，确保在卡片中能完整回溯各阶段审查记录
      if (!data.stage1 && data.analysis && (data.modify === "待人工确认" || data.modify === "人工确认" || data.stage2 || data.stage3)) {
        data.stage1 = data.analysis;
      }

      // 兼容历史数据：若无独立改案行，从 Stylist 分析与 Gatekeeper 评语中推断阶段改案
      if (data.stage2 && !data.stage1Revision) {
        if (data.stage2.text) {
          const legacyGkMatch = data.stage2.text.match(/(?:Gatekeeper|初审(?:员)?|初审修改稿?)\s*(?:处理为|建议为|改为|提出|译为|修正为|写作|方案为|采用)[‘“「](.*?)[’”」]/)
            || data.stage2.text.match(/(?:建议(?:为)?|应为|修正为)[‘“「](.*?)[’”」]/);
          if (legacyGkMatch && legacyGkMatch[1]?.trim()) {
            const cand = legacyGkMatch[1].trim();
            if (!/[\u3040-\u309F\u30A0-\u30FF]/.test(cand)) {
              data.stage1Revision = cand;
            }
          }
        }
        if (!data.stage1Revision && data.stage1) {
          // 仅当包含明确的修改/改译动词，且不是删除/增译/漏译语境时才推断
          const isDeleteOrOmission = /(?:删除|删去|删掉|去除|去掉|增译|无中生有|多余|不应有|漏译)/.test(data.stage1);
          if (!isDeleteOrOmission) {
            const gkMatch = data.stage1.match(/(?:建议(?:改为|改写为|为)?|处理为|改为|修正为|译为)[：:‘“「](.*?)[’”」]/);
            if (gkMatch && gkMatch[1]?.trim()) {
              const cand = gkMatch[1].trim();
              if (!/[\u3040-\u309F\u30A0-\u30FF]/.test(cand)) {
                data.stage1Revision = cand;
              }
            }
          }
        }
      }

      // 防呆清洗：无论 stage1Revision 来自何处（显式行或历史推断），
      // 若初审意图是指出删除/增译，而 stage1Revision 恰是被指出的待删除缺陷短语，或者包含日文假名，绝不能当作初审改案
      if (data.stage1Revision) {
        const isDeleteWord = Boolean(
          data.stage1 &&
          /(?:删除|删去|删掉|去除|去掉|增译|无中生有|多余|不应有)/.test(data.stage1) &&
          (data.stage1.includes("「" + data.stage1Revision + "」") ||
           data.stage1.includes("“" + data.stage1Revision + "”") ||
           data.stage1.includes("‘" + data.stage1Revision + "’") ||
           (data.stage1Revision.length <= 12 && data.stage1.includes(data.stage1Revision)))
        );
        const hasKana = /[\u3040-\u309F\u30A0-\u30FF]/.test(data.stage1Revision);
        if (isDeleteWord || hasKana) {
          data.stage1Revision = "";
        }
      }

      // 阶段改案安全回退：检查各个候选改案是否属于局部修正提议（非整段改案）
      const isS1Partial = isPartialProposal(data.stage1Revision, targetText, note, { isInitialProposal: true });
      const isS2Partial = isPartialProposal(data.stage2Revision, targetText, note);
      const isS3Partial = isPartialProposal(data.stage3Revision, targetText, note);
      const isRevPartial = isPartialProposal(data.revision, targetText, note);

      // 若 revision 本身就是局部提议或已被门禁作废，置为空避免被当作整段修改写回
      if (isRevPartial) {
        data.revision = "";
      }

      // 只有非局部提议的完整全量改案，才允许在采纳/维持时向下游阶段传播
      if (data.stage2 && !data.stage2Revision) {
        if (data.stage2.attitude.includes("采纳") && data.stage1Revision && !isS1Partial) {
          data.stage2Revision = data.stage1Revision;
        } else if (!data.stage3 && data.revision && !isRevPartial) {
          data.stage2Revision = data.revision;
        } else if (data.stage1Revision && !isS1Partial) {
          data.stage2Revision = data.stage1Revision;
        }
      }
      if (data.stage3 && !data.stage3Revision) {
        if (data.revision && !isRevPartial) {
          data.stage3Revision = data.revision;
        } else if (data.stage2Revision && !isS2Partial) {
          data.stage3Revision = data.stage2Revision;
        } else if (data.stage1Revision && !isS1Partial) {
          data.stage3Revision = data.stage1Revision;
        }
      }

      // 默认版本显示逻辑：最后阶段的版本优先（仲裁 ＞ 复审 ＞ 初审）
      // 安全红线：局部提议（isPartialProposal）绝不能直接作为全量成品文本覆盖 data.revision！
      if (data.stage3 && (data.stage3Revision || data.revision)) {
        if (data.stage3Revision && !isPartialProposal(data.stage3Revision, targetText, note)) {
          data.revision = data.stage3Revision;
        } else if (isPartialProposal(data.stage3Revision, targetText, note) && data.revision === data.stage3Revision) {
          data.revision = "";
        }
      } else if (data.stage2 && (data.stage2Revision || data.revision)) {
        if (data.stage2Revision && !isPartialProposal(data.stage2Revision, targetText, note)) {
          data.revision = data.stage2Revision;
        } else if (isPartialProposal(data.stage2Revision, targetText, note) && data.revision === data.stage2Revision) {
          data.revision = "";
        }
      } else if (data.stage1Revision && !isPartialProposal(data.stage1Revision, targetText, note)) {
        data.revision = data.stage1Revision;
      }

      return data.semantic || data.modify || data.severity || data.grade || data.score !== null || data.revision || data.analysis ? data : null;
    }

    function getStage3RowStatus(item) {
      if (!item || item.manualDone) return { isArbitrated: false, isPending: false, isRelevant: false };
      const text = String(item.note || "").trim();
      if (!text || !hasAutomatedDecisionNote(text)) return { isArbitrated: false, isPending: false, isRelevant: false };
      const p = parseAutomatedNote(text);
      if (!p) return { isArbitrated: false, isPending: false, isRelevant: false };

      const hasS3 = Boolean(p.stage3 || text.includes("Arbiter仲裁"));
      if (hasS3) {
        return { isArbitrated: true, isPending: false, isRelevant: true };
      }

      const hasS2 = Boolean(p.stage2 || text.includes("Stylist复审"));
      const att = String(p.stage2?.attitude || "");
      const isDiverged = att.includes("调整") || att.includes("驳回") || att.includes("仲裁") ||
        att === "modify" || att === "reject" || att === "escalate" ||
        text.includes("提交仲裁") || text.includes("分歧") || text.includes("escalate") ||
        Boolean(p.stage1Revision && p.stage2Revision && p.stage1Revision !== p.stage2Revision);

      if (hasS2 && isDiverged) {
        return { isArbitrated: false, isPending: true, isRelevant: true };
      }

      return { isArbitrated: false, isPending: false, isRelevant: false };
    }

    function gradeLabel(grade) {
      return { excellent: "优等", good: "良好", fair: "一般", poor: "较差" }[grade] || "";
    }

    function normalizeIssueSeverity(value) {
      const text = String(value || "").trim().toLowerCase();
      if (["critical", "致命", "高", "high", "poor", "较差"].includes(text)) return "critical";
      if (["major", "严重", "重大", "主要", "中", "medium", "fair", "一般", "待改"].includes(text)) return "major";
      if (["minor", "轻微", "次要", "低", "low", "good", "良好"].includes(text)) return "minor";
      if (["none", "无", "excellent", "优等"].includes(text)) return "none";
      return "";
    }

    function issueSeverityLabel(severity) {
      return { critical: "致命", major: "严重", minor: "轻微", none: "无" }[severity] || "";
    }

    function formatWinnerLabel(rawWinner = "") {
      const text = String(rawWinner || "").trim();
      if (!text) return "裁决";
      const map = {
        stylist: "复审方案",
        "stylist方案": "复审方案",
        "Stylist方案": "复审方案",
        gatekeeper: "初审方案",
        "gatekeeper方案": "初审方案",
        "Gatekeeper方案": "初审方案",
        synthesis: "结合方案",
        "synthesis方案": "结合方案",
        "Synthesis方案": "结合方案",
        combined: "结合方案",
        "combined方案": "结合方案",
        "Combined方案": "结合方案",
        combination: "结合方案",
        hybrid: "结合方案",
        both: "结合方案",
        "结合方案": "结合方案",
        "综合方案": "结合方案",
        "结合": "结合方案",
        "综合": "结合方案",
        original: "维持原译",
        target: "维持原译",
        neither: "折中方案",
        compromise: "结合方案",
        "折中方案": "结合方案",
      };
      if (map[text]) return map[text];
      return text.replace(/Stylist/gi, "复审").replace(/Gatekeeper/gi, "初审");
    }

    // 审核轨迹的展开/收起是用户当下的阅读选择，不属于备注数据，不能落盘；但整页重渲染
    // （筛选 / 翻页 / 改每页行数 / AI 结果到达）会重建全部行节点，只靠 DOM 的 hidden
    // 会被冲回默认态——用户收起的行又弹开，只能反复点，每次都吃一整次重渲染。
    // 这里按行号记一份会话内覆盖值，重渲染时优先用它（没有覆盖就用默认：待判行展开）。
    const pipelineOpenOverrides = new Map();

    function pipelineDefaultOpen(id, isNeedsCheck) {
      const key = String(id || "");
      if (key && pipelineOpenOverrides.has(key)) return pipelineOpenOverrides.get(key);
      return isNeedsCheck;
    }

    function setPipelineOpen(id, open) {
      pipelineOpenOverrides.set(String(id), Boolean(open));
    }

    function renderNoteSummary(item, id) {
      const noteText = item?.note || "";
      const row = typeof rowsById !== "undefined" && rowsById ? rowsById.get(String(id || "")) : null;
      const targetKey = revisionTargetFor(item);
      const rowTargetText = row ? String(row[targetKey] || row.cn || "") : "";
      const note = parseAutomatedNote(noteText, rowTargetText);
      if (!note) return '<div class="note-summary" hidden></div>';

      const revisionText = revisionTextFor(item, row || rowTargetText);
      const revisionTarget = targetKey;
      const revisionLabel = pageLabels[revisionTarget] || (revisionTarget === "tw" ? "非原文 C" : "非原文 B");

      let pipelineHtml = "";
      const hasStageTraces = Boolean(note.stage1 || note.stage2 || note.stage3);
      if (hasStageTraces) {
        const isNeedsCheck = note.modify === "待人工确认" || note.modify === "人工确认";
        const s2Attitude = note.stage2?.attitude || (isNeedsCheck && !note.stage2 ? "待定" : "复审");
        let attCls = "is-stylist";
        if (s2Attitude.includes("采纳") || s2Attitude === "accept") attCls = "is-accept";
        else if (s2Attitude.includes("调整") || s2Attitude === "modify") attCls = "is-modify";
        else if (s2Attitude.includes("驳回") || s2Attitude === "reject") attCls = "is-reject";
        else if (s2Attitude.includes("仲裁") || s2Attitude.includes("escalate")) attCls = "is-arbiter";

        const rawWinner = note.stage3?.winner || (isNeedsCheck && note.stage3 ? "存疑待定" : "仲裁");
        const s3Winner = formatWinnerLabel(rawWinner);

        // 核心体验契约：待判行是需要人工定夺的焦点，各阶段审查记录默认直接展开呈现！
        // 去重契约：阶段卡片只承载「审查意见」，各阶段改案全文只在左侧差异辅助（修改结果对比 +
        // 分步演进明细）与「修改结果」区呈现一次；卡片里再打印一遍是纯粹的重复噪音。
        // 用户手动开合过这一行就以他的选择为准，否则沿用"待判行默认展开"。
        const defaultOpen = pipelineDefaultOpen(id, isNeedsCheck);
        const expandHintText = defaultOpen ? "审核轨迹 ▴" : "审核轨迹 ▾";

        let stepsHtml = '<span class="pipeline-step is-gk">初审</span>';
        if (note.stage2) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step ' + attCls + '">复审·' + escapeHtml(s2Attitude) + '</span>';
        } else if (isNeedsCheck && !note.stage3) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step is-pending-step" title="初审存疑，等待文学复审接力">待复审</span>';
        }
        if (note.stage3) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step is-arbiter">仲裁·' + escapeHtml(s3Winner) + '</span>';
        }
        if (isNeedsCheck) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step is-final-check" title="经审查仍难以断定，终审定案为待人工确认">待人工确认</span>';
        }

        pipelineHtml = '<div class="stage-pipeline-badge" data-pipeline-toggle="' + escapeHtml(id || "") + '" title="点击展开/收起多阶段审核轨迹">' +
          stepsHtml +
          '<span class="pipeline-expand-hint">' + expandHintText + '</span>' +
        '</div>' +
        '<div class="stage-pipeline-details" id="pipelineDetails_' + escapeHtml(id || "") + '"' + (defaultOpen ? '' : ' hidden') + '>' +
          (note.stage1 ? ('<div class="stage-report-card is-gk"><div class="stage-report-header"><span>🛡️ 阶段一：事实初审</span>' + (note.stage1Revision ? '<span class="stage-report-tag is-modify">提改</span>' : (isNeedsCheck && !note.stage2 ? '<span class="stage-report-tag is-unclear">存疑</span>' : '')) + '</div><div class="stage-report-body">' + escapeHtml(note.stage1) + '</div></div>') : '') +
          (note.stage2 ? ('<div class="stage-report-card is-stylist"><div class="stage-report-header"><span>✍️ 阶段二：文学复审</span><span class="stage-report-tag ' + attCls + '">' + escapeHtml(s2Attitude) + '</span></div><div class="stage-report-body">' + escapeHtml(note.stage2.text) + '</div></div>') : '') +
          (note.stage3 ? ('<div class="stage-report-card is-arbiter"><div class="stage-report-header"><span>⚖️ 阶段三：终审仲裁</span><span class="stage-report-tag is-arbiter">' + escapeHtml(s3Winner) + '</span></div><div class="stage-report-body">' + escapeHtml(note.stage3.text) + '</div></div>') : '') +
        '</div>';
      }

      let displayAnalysis = String(note.analysis || "").trim();
      if (note.stage1 || note.stage2) {
        const s1 = String(note.stage1 || "").trim();
        const s2 = String(note.stage2?.text || "").trim();
        if (s1 && displayAnalysis === s1) {
          displayAnalysis = "";
        } else if (s1 && displayAnalysis.startsWith(s1)) {
          displayAnalysis = displayAnalysis.slice(s1.length).trim();
        } else if (s2 && displayAnalysis === s2) {
          displayAnalysis = "";
        }
      }
      const analysis = displayAnalysis
        ? '<div class="note-detail note-reason"><div class="note-detail-head"><span class="note-summary-key">分析</span></div><div class="note-summary-value">' + escapeHtml(displayAnalysis) + '</div></div>'
        : "";

      let stagePillsHtml = "";
      const hasMultipleStages = Boolean(
        note.stage2 || note.stage3 ||
        (note.stage1Revision && (note.stage2Revision || note.revision))
      );
      if (hasMultipleStages) {
        const currentRev = String(revisionText || "").trim();
        const s1Rev = String(note.stage1Revision || "").trim();
        const s2Rev = String(note.stage2Revision || (!note.stage3 ? note.revision : "") || "").trim();
        const s3Rev = String(note.stage3Revision || (note.stage3 ? note.revision : "") || "").trim();

        const s1IsPartial = isPartialProposal(s1Rev, rowTargetText, noteText);
        const s2IsPartial = isPartialProposal(s2Rev, rowTargetText, noteText);
        const s3IsPartial = isPartialProposal(s3Rev, rowTargetText, noteText);

        const s1Title = s1IsPartial ? "阶段一事实初审提议（局部修正）" : "切换为阶段一事实初审文本";
        const s2Title = s2IsPartial ? "阶段二文学复审提议（局部修正）" : "切换为阶段二文学复审文本";
        const s3Title = s3IsPartial ? "阶段三终审仲裁提议（局部修正）" : "切换为阶段三终审仲裁文本";

        // 默认显示最后的合法全量版本：仲裁 ＞ 复审 ＞ 初审
        let activeStage = note.stage3 ? "3" : (note.stage2 ? "2" : "1");
        if (item?.revisionStageActive) {
          activeStage = String(item.revisionStageActive);
        } else if (note.stage3 && s3Rev && currentRev === s3Rev) {
          activeStage = "3";
        } else if (note.stage2 && s2Rev && currentRev === s2Rev) {
          activeStage = "2";
        } else if (s1Rev && currentRev === s1Rev) {
          activeStage = "1";
        }

        const isS1Active = activeStage === "1";
        const isS2Active = activeStage === "2";
        const isS3Active = activeStage === "3";

        stagePillsHtml = '<div class="revision-stage-pills" data-row-id="' + escapeHtml(id || "") + '" title="在不同阶段的修改版本间快速切换">' +
          '<span class="stage-pills-label">版本:</span>' +
          '<button type="button" class="stage-pill-btn is-gk ' + (isS1Active ? 'is-active' : '') + '" data-apply-stage="1" data-row-id="' + escapeHtml(id || "") + '" title="' + escapeHtml(s1Title) + '">初审</button>' +
          '<button type="button" class="stage-pill-btn is-stylist ' + (isS2Active ? 'is-active' : '') + '" data-apply-stage="2" data-row-id="' + escapeHtml(id || "") + '" title="' + escapeHtml(s2Title) + '">复审</button>' +
          (note.stage3 ? '<button type="button" class="stage-pill-btn is-arbiter ' + (isS3Active ? 'is-active' : '') + '" data-apply-stage="3" data-row-id="' + escapeHtml(id || "") + '" title="' + escapeHtml(s3Title) + '">仲裁</button>' : '') +
        '</div>';
      }

      const cleanTargetLabel = String(revisionLabel || "").replace(/[（(][^）)]*[）)]/g, "").trim() || String(revisionLabel || "").trim();
      const shortTargetLabel = cleanTargetLabel.length > 6 ? cleanTargetLabel.slice(0, 5) + "…" : cleanTargetLabel;
      const targetBadgeHtml = (!bilingualMode || (shortTargetLabel && shortTargetLabel !== "译文" && shortTargetLabel !== "修改结果"))
        ? '<span class="revision-target-badge" title="修改目标：' + escapeHtml(revisionLabel) + '">' + escapeHtml(shortTargetLabel) + '</span>'
        : "";

      const revision = revisionText
        ? '<div class="note-detail note-revision">' +
            '<div class="note-detail-head">' +
              '<div class="revision-title-wrap">' +
                '<span class="note-summary-key">修改结果</span>' +
                targetBadgeHtml +
              '</div>' +
              '<div class="revision-head-actions">' +
                '<button type="button" class="writeback-revision" data-writeback-revision="' + escapeHtml(id || "") + '" title="将修改结果直接写回原文件">写回</button>' +
                '<button type="button" class="copy-revision" data-copy-text="' + escapeHtml(revisionText) + '" title="复制修改结果">复制</button>' +
              '</div>' +
            '</div>' +
            stagePillsHtml +
            '<textarea class="revision-editor" data-revision="' + escapeHtml(id || "") + '" aria-label="第 ' + escapeHtml(id || "") + ' 行 AI 修改结果">' + escapeHtml(revisionText) + '</textarea>' +
          '</div>'
        : "";
      
      let ratingBadges = "";
      if (note.score !== null && note.score !== undefined) {
        const pText = note.penalty ? ' (-' + escapeHtml(String(note.penalty)) + ')' : '';
        ratingBadges += '<span class="score-badge is-' + escapeHtml(note.grade || "fair") + '">' + escapeHtml(String(note.score)) + '分' + pText + '</span>';
      }
      if (note.grade) {
        ratingBadges += '<span class="issue-severity-badge is-' + escapeHtml(note.grade) + '">' + escapeHtml(gradeLabel(note.grade)) + '</span>';
      } else if (note.severity && note.severity !== "none") {
        ratingBadges += '<span class="issue-severity-badge is-' + escapeHtml(note.severity) + '">' + escapeHtml(issueSeverityLabel(note.severity)) + '</span>';
      }
      const ratingLine = ratingBadges
        ? '<div class="note-summary-line"><span class="note-summary-key">质量评分</span>' + ratingBadges + '</div>'
        : "";

      return '<div class="note-summary">' +
        pipelineHtml +
        '<div class="note-summary-line"><span class="note-summary-key">语义</span><span class="note-summary-value">' + escapeHtml(note.semantic || "待人工判定") + '</span></div>' +
        '<div class="note-summary-line"><span class="note-summary-key">修改</span><span class="note-summary-value">' + escapeHtml(note.modify || "待人工判定") + '</span></div>' +
        ratingLine +
        analysis +
        revision +
      '</div>';
    }

    function aiBadgeState(item) {
      if (isAiFailureNote(item?.note)) return { cls: "is-failure", text: "AI失败" };
      const marker = automatedNoteMarker(item?.note || "");
      const note = parseAutomatedNote(item?.note || "");
      if (!note) return { cls: "is-off", text: "AI未跑" };
      if (marker === "[规则预筛]") {
        return note.modify === "待人工确认"
          ? { cls: "is-unclear", text: "规则冲突" }
          : { cls: "is-same", text: "规则通过" };
      }
      if (marker === "[相似度预筛]") return { cls: "is-same", text: "相似跳过" };
      if (marker === "[对照表]") {
        if (note.modify === "是") return { cls: "is-modify", text: "术语需改" };
        if (note.modify === "否") return { cls: "is-same", text: "术语一致" };
        return { cls: "is-unclear", text: "术语待判" };
      }
      if (note.modify === "是") return { cls: "is-modify", text: "AI需改" };
      if (note.modify === "否") return { cls: "is-same", text: "AI不改" };
      return { cls: "is-unclear", text: "AI待判" };
    }

    function rowText(row) {
      const note = combinedNoteText(notes[row.index]);
      return [
        row.index,
        row.chapter,
        row.relation,
        row.jp,
        row.cn,
        row.tw,
        row.twCn,
        revisionTextFor(notes[row.index]),
        note,
      ].join(" ").toLowerCase();
    }

    // 本行命中了哪些术语：构建期随页面下发的行级术语对（只由原文 + 对照表决定，与模型无关）。
    // 有备注时以备注里的结论为准（那是当次任务的判定），这里退回构建期判定并说明出处。
    function renderTermChipHtml(id, noteText) {
      const pairs = termEntries.get(id);
      if (!pairs || !pairs.length) return "";
      const fromNote = Boolean(noteText);
      const cap = 8;
      const lines = pairs.slice(0, cap).map((pair) => "- " + pair);
      if (pairs.length > cap) lines.push("- …（其余 " + (pairs.length - cap) + " 条见对照表）");
      const source = fromNote
        ? "备注已出（术语清单来自对照表）：命中 " + pairs.length + " 条术语"
        : "构建期判定：本行原文命中对照表 " + pairs.length + " 条术语";
      const title = [source, ...lines].join("\n");
      return '<details class="term-chip" data-term-chip="' + id + '" title="' + escapeHtml(title) + '">' +
        '<summary><span class="term-chip-count">术语 ' + pairs.length + '</span><span class="term-chip-state">' + (fromNote ? "结论" : "预判") + '</span></summary>' +
        '<ul class="term-chip-list">' + pairs.map((pair) => '<li>' + escapeHtml(pair) + '</li>').join("") + '</ul>' +
        '</details>';
    }

    function renderRow(row) {
      const id = String(row.index);
      const note = notes[id] || { note: "", done: false, manualDone: false, aiDone: false };
      const done = Boolean(note.manualDone);
      const aiBadgeStateValue = aiBadgeState(note);
      const aiBadge = '<span class="ai-confirm-badge ' + aiBadgeStateValue.cls + '" data-ai-done="' + id + '">' + aiBadgeStateValue.text + '</span>';
      // 构建期判定“疑似说话特色流失”的行：给一个可点开的标记，提示人工核对口癖是否漏译。
      const habitBadge = speechHabitMissIndexes.has(id)
        ? '<span class="ai-confirm-badge is-habit-miss" title="构建期判定：本行原文有说话习惯特征，译文里没有体现；可在 AI 校对时按说话人习惯补回">特色流失</span>'
        : "";
      // 对照表的构建期判定只在「这一行还没跑过」时显示：跑过之后以备注里的真实结论为准。
      const termVerdict = note.note ? "" : (termVerdicts.get(id) || "");
      const termBadge = termVerdict === "conflict"
        ? '<span class="ai-confirm-badge is-modify" title="构建期判定：本行原文命中的术语与译文写法不一致（或整条没译出来）。这一行照常交给 AI，术语冲突作为提示词注入，由模型结合整句判断并在结论里写明依据——术语判断是 AI 分析的一环，不直接转人工">术语冲突</span>'
        : (termVerdict === "term-only"
          // 只有整行有效内容都是术语时才跳过模型：这一行没有术语之外的内容可校。
          ? '<span class="ai-confirm-badge is-same" title="构建期判定：本行原文的有效内容全部是项目术语，对照表能给出完整结论；跑预筛选时这行不会调用模型">纯术语</span>'
          : (termVerdict === "injected"
            ? '<span class="ai-confirm-badge is-unclear" title="构建期判定：本行原文命中对照表但句中还有术语之外的内容；术语一致只能证明术语用对了，整句仍会交给模型判定（术语以提示词注入）">术语注入</span>'
            : ""));
      // 备注列首行分两组：左侧「人工确认」勾选，右侧状态徽标（AI 结论 + 术语/特色提示）。
      // 徽标必须聚成一组，否则 space-between 会把它们拉到备注列两端，中间空出一大片。
      const rowBadges = aiBadge + habitBadge;
      const verifyBadge = note.recoveredUnverified
        ? '<button type="button" class="ai-confirm-badge is-unverified" data-verify="' + id + '" title="找回记录缺少完整内容证据；点击只解除写回隔离，不会标记人工确认">未校验</button>'
        : "";
      const termChip = renderTermChipHtml(id, note.note || "");
      const classes = [row.cls, done ? "done" : "", activeRowId === id ? "active-row" : "", aiActiveIds.has(id) ? "ai-active" : ""]
        .filter(Boolean)
        .join(" ");
      const cnCopyButton = '<button type="button" class="copy-version" data-copy-text="' + escapeHtml(row.cn || "") + '" title="复制' + escapeHtml(pageLabels.cn) + '">复制</button>';
      const twCopyButton = '<button type="button" class="copy-version" data-copy-text="' + escapeHtml(row.tw || "") + '" title="复制' + escapeHtml(pageLabels.tw) + '">复制</button>';
      const diffBlock = renderDiffBlock(row, note);
      const twPanel = bilingualMode ? "" : '<section class="version-panel"><div class="version-label"><span>' + escapeHtml(pageLabels.tw) + '</span>' + twCopyButton + '</div><div lang="zh-Hant">' + escapeHtml(row.tw) + '</div></section>';
      const twChars = bilingualMode ? "" : ' / ' + escapeHtml(pageLabels.tw) + ' ' + (row.twChars || 0);
      const semanticLine = !bilingualMode && row.jpAlignScoreText
        ? '<div><dt>' + escapeHtml(pageMeta.semanticLabel) + ' 语义</dt><dd>' + escapeHtml(row.jpAlignScoreText) + '</dd></div>'
        : "";
      return [
        '<tr class="' + classes + '" data-score="' + Number(row.score || 0).toFixed(4) + '" data-index="' + id + '">',
        '<td class="meta-cell">',
        '<div class="row-head"><span class="idx">#' + id + '</span><span class="status-dot" aria-label="' + escapeHtml(row.cls) + '"></span></div>',
        '<div class="chapter">' + escapeHtml(row.chapter || "未分章") + '</div>',
        '<dl>',
        '<div><dt>关系</dt><dd>' + escapeHtml(row.relation || "") + '</dd></div>',
        '<div><dt>' + escapeHtml(pageMeta.similarityLabel) + ' 相似</dt><dd>' + escapeHtml(row.scoreText || "") + '</dd></div>',
        semanticLine,
        '<div><dt>字数</dt><dd>' + escapeHtml(pageLabels.jp) + ' ' + (row.jpChars || 0) + ' / ' + escapeHtml(pageLabels.cn) + ' ' + (row.cnChars || 0) + twChars + '</dd></div>',
        '</dl>',
        '</td>',
        '<td class="source-cell" lang="ja">' + escapeHtml(row.jp) + '</td>',
        '<td class="translation-cell">',
        '<div class="version-grid">',
        '<section class="version-panel"><div class="version-label"><span>' + escapeHtml(pageLabels.cn) + '</span>' + cnCopyButton + '</div><div lang="zh-Hans">' + escapeHtml(row.cn) + '</div></section>',
        twPanel,
        '</div>',
        '<div data-diff-slot="' + id + '">' + diffBlock + '</div>',
        '</td>',
        '<td class="note-cell">',
        '<div class="confirm-row">',
        '<label class="done-line"><input type="checkbox" data-done="' + id + '"' + (done ? " checked" : "") + '><span>人工确认</span></label>',
        '<div class="confirm-status">',
        rowBadges,
        termBadge,
        verifyBadge,
        '<span class="term-chip-slot" data-term-chip-slot="' + id + '">' + termChip + '</span>',
        '</div>',
        '</div>',
        renderNoteSummary(note, id),
        '</td>',
        '</tr>',
      ].join("");
    }

    // 行内输入框高度缓存。量高必须走"读 scrollHeight"，而读它会先把待处理的样式与布局
    // 全部算完——逐行读一次就是一次整表强制重排。实测 500 行页面单次全量同步 =
    // 533 次强制布局、245ms 布局、311ms 主线程占用；抽屉开合、窗口 resize、显示开关
    // 都会触发同步，于是开关几下就把主线程占满，表现就是鼠标移动变慢、输入出现延迟。
    // 因此缓存"上一次量出的像素高度"，只有下面四种情况才重新量：
    //   ① 节点是新的（整页重渲染后是全新节点，缓存自然未命中）
    //   ② 该行内容被改写（切版本、手动输入 → invalidateRevisionEditorHeight）
    //   ③ 视口高度变化（40vh 上限随之变化 → 整批失效）
    //   ④ 列宽变化（显示开关隐藏/恢复整列 → remeasureEditors 整批失效）
    // 真的要量一批时也必须批量读写分离（见 measureRevisionEditors）：逐行"写 auto → 读
    // scrollHeight"交错是每行一次整表重排，实测 500 个输入框 = 287ms；改成先整批写 auto、
    // 再连续读（只强制布局一次）、最后统一写回，实测 20ms（提速 14.3×）。
    let editorHeightsViewport = 0;
    const revisionEditorHeights = new WeakMap();
    // 表格容器位置缓存：getBoundingClientRect 同样会强制布局，位置没变就不重做整表同步。
    let frameTopCache = null;
    // 上次写入的可用高度：值没变就不写。往 .wrap 上写 CSS 变量会让整棵表格子树重算样式
    // （实测 500 行页面写 20 次不同值 = 40.8ms 样式重算），写同一个值是免费的。
    let lastMaxHeight = "";

    function invalidateRevisionEditorHeight(editor) {
      if (editor) revisionEditorHeights.delete(editor);
    }

    // 整批失效：视口高度或列宽变化时，所有缓存的高度都作废（按节点删，不触发任何布局）。
    // 传入已查好的列表可避免重复查 DOM——整表 querySelectorAll 在 500 行页面上是
    // 一次实打实的强制布局（实测 239ms），一次同步里只允许查一次。
    function invalidateRevisionEditorHeights(editors = null) {
      for (const editor of editors || tbody.querySelectorAll(".revision-editor")) {
        revisionEditorHeights.delete(editor);
      }
    }

    function syncRevisionEditorHeight(editor) {
      if (!editor) return;
      editor.classList.remove("is-overflowing");
      editor.style.height = "auto";
      // scrollHeight 只读一次：读它是"先把待处理的样式与布局算完"的强制布局，
      // 读两次就是同一行白付一次整表重排。先写 auto 再读，拿到的是内容自然高度，
      // 溢出判定用同一个值即可（写回高度不会让内容变高）。
      const contentHeight = editor.scrollHeight;
      const nextHeight = Math.min(contentHeight + 2, editorMaxHeight());
      editor.style.height = nextHeight + "px";
      editor.classList.toggle("is-overflowing", contentHeight > editorMaxHeight());
      revisionEditorHeights.set(editor, nextHeight);
    }

    function editorMaxHeight() {
      return Math.max(120, Math.round(window.innerHeight * 0.4));
    }

    /**
     * 一批输入框的批量量高：写、读、写三段分离。
     * 交错写读会让每个 scrollHeight 都成为一次整表强制重排（实测 500 个 = 287ms）；
     * 这里先把整批写 auto，再连续读（整批只触发一次布局），最后统一写回，
     * 实测同样 500 个 = 20ms。正确性不变：auto 之后读到的就是内容自然高度。
     */
    function measureRevisionEditors(editors) {
      const pending = Array.from(editors).filter((editor) => !revisionEditorHeights.has(editor));
      if (!pending.length) return 0;
      for (const editor of pending) {
        editor.classList.remove("is-overflowing");
        editor.style.height = "auto";
      }
      const maxHeight = editorMaxHeight();
      // 连续读：第一次读强制布局一次，后续读都命中同一次布局结果。
      const contentHeights = pending.map((editor) => editor.scrollHeight);
      for (let i = 0; i < pending.length; i += 1) {
        const editor = pending[i];
        const contentHeight = contentHeights[i];
        const nextHeight = Math.min(contentHeight + 2, maxHeight);
        editor.style.height = nextHeight + "px";
        editor.classList.toggle("is-overflowing", contentHeight > maxHeight);
        revisionEditorHeights.set(editor, nextHeight);
      }
      return pending.length;
    }

    /**
     * 重算表格可用高度（写 --results-max-height）。只读一次容器位置；容器没位移且
     * ifFrameMoved 为真时直接收工。写值前先比对：值没变就不写——往 .wrap 上写 CSS 变量
     * 会让整棵表格子树重算样式（实测 500 行页面写 20 次不同值 = 40.8ms 样式重算）。
     * 可见行数取渲染时算好的切片长度，绝不查 DOM：整页重渲染后 querySelectorAll 会带动
     * 一次整表强制布局（实测 500 行 = 239ms），是重渲染里最贵的一笔。
     */
    function updateResultsMaxHeight({ ifFrameMoved = false, visibleRows = null } = {}) {
      const tableTop = tableFrame.getBoundingClientRect().top;
      if (ifFrameMoved && tableTop === frameTopCache) return;
      frameTopCache = tableTop;

      const rows = visibleRows == null ? renderedRowsById.size : visibleRows;
      const fitContent = rows <= 3;
      tableFrame.classList.toggle("is-fit-content", fitContent);
      const nextMaxHeight = fitContent
        ? "none"
        : Math.max(320, window.innerHeight - tableTop - 88) + "px";
      if (nextMaxHeight !== lastMaxHeight) {
        lastMaxHeight = nextMaxHeight;
        wrap.style.setProperty("--results-max-height", nextMaxHeight);
      }
    }

    /**
     * 整表布局同步：可用高度 + 逐行输入框高度（高度缓存仍然成立的直接跳过）。
     * @param {{ ifFrameMoved?: boolean, remeasureEditors?: boolean }} [options]
     *   ifFrameMoved：只更新可用高度，且容器没位移就整段收工。面板/抽屉开合用——它们会把
     *                 表格往下推，推了才需要重算；行宽没变，逐行高度一律不必重量。
     *   remeasureEditors：列宽变了（显示开关隐藏/恢复整列、窗口尺寸稳定后），整批高度作废。
     */
    function syncVisibleRowLayout({ ifFrameMoved = false, remeasureEditors = false, visibleRows = null } = {}) {
      if (ifFrameMoved && !remeasureEditors) {
        updateResultsMaxHeight({ ifFrameMoved: true, visibleRows });
        return;
      }

      // 整表 querySelectorAll 是一次实打实的强制布局（500 行实测 239ms），
      // 所以整段同步只查一次编辑器列表，失效与量高都复用它。
      const editors = tbody.querySelectorAll(".revision-editor");

      // 视口高度决定 40vh 上限：变了就整批失效（缓存的是像素高度，上限一变全部作废）。
      const viewportHeight = window.innerHeight;
      if (viewportHeight !== editorHeightsViewport || remeasureEditors) {
        editorHeightsViewport = viewportHeight;
        invalidateRevisionEditorHeights(editors);
      }

      updateResultsMaxHeight({ visibleRows });

      // 缓存仍然成立的行直接跳过：跳过的是强制布局，不是正确性。
      // 新渲染的行是缓存未命中的新节点，切版本/输入走 invalidateRevisionEditorHeight。
      measureRevisionEditors(editors);
    }

    function renderedRow(id) {
      return renderedRowsById.get(String(id)) || null;
    }

    // 同一帧内的多次请求合并成一次，取"要求更高"的那个（remeasureEditors 蕴含整段同步）。
    let layoutSyncFrame = 0;
    let pendingLayoutSync = null;
    function scheduleVisibleRowLayoutSync(options = {}) {
      const pending = pendingLayoutSync || { ifFrameMoved: false, remeasureEditors: false };
      pendingLayoutSync = {
        ifFrameMoved: pending.ifFrameMoved || Boolean(options.ifFrameMoved),
        remeasureEditors: pending.remeasureEditors || Boolean(options.remeasureEditors),
      };
      if (layoutSyncFrame) return;
      const requestFrame = typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback) => window.setTimeout(callback, 16);
      layoutSyncFrame = requestFrame(() => {
        layoutSyncFrame = 0;
        const task = pendingLayoutSync || {};
        pendingLayoutSync = null;
        syncVisibleRowLayout(task);
      });
    }

    function updateDoneCount() {
      let done = 0;
      let aiDone = 0;
      for (const item of Object.values(notes)) {
        if (item?.manualDone) done += 1;
        if (item?.aiDone) aiDone += 1;
      }
      doneCount.textContent = String(done);
      aiDoneCount.textContent = String(aiDone);
      if (!currentAiRunning) {
        updateStageMetricsDashboard();
      }
    }

    function totalPages() {
      return calculateTotalPages(filteredRows.length, pageSize.value, 100);
    }

    function updatePaginationStatus() {
      const visible = filteredRows.length;
      const size = Number(pageSize.value || 100);
      const total = totalPages();
      currentPage = Math.max(1, Math.min(currentPage, total));
      const start = visible ? ((currentPage - 1) * size) + 1 : 0;
      const end = visible ? Math.min(currentPage * size, visible) : 0;
      emptyState.classList.toggle("visible", visible === 0);
      paginationBar.classList.toggle("hidden", visible === 0);
      pageInput.value = String(currentPage);
      pageInput.max = String(total);
      pageTotal.textContent = "/ " + total + " 页";
      paginationStatus.textContent = visible
        ? "第 " + start + "-" + end + " 行，共 " + visible + " 行"
        : "没有匹配的行";
      firstPage.disabled = currentPage <= 1;
      prevPage.disabled = currentPage <= 1;
      nextPage.disabled = currentPage >= total;
      lastPage.disabled = currentPage >= total;
    }

    function renderVisibleRows({ reset = false } = {}) {
      if (reset) currentPage = 1;
      keyboardScrollSpacer.style.height = "0px";
      const size = Number(pageSize.value || 100);
      const total = totalPages();
      currentPage = Math.max(1, Math.min(currentPage, total));
      const start = (currentPage - 1) * size;
      const slice = filteredRows.slice(start, start + size);
      tbody.innerHTML = slice.map(renderRow).join("");
      renderedRowsById.clear();
      for (const row of tbody.querySelectorAll("tr[data-index]")) renderedRowsById.set(row.dataset.index, row);
      // 整页行都是新节点：高度缓存按节点存，新节点缓存未命中，会按内容量一次高。
      // 行数顺手传下去，省掉一次整表 querySelectorAll（500 行实测 239ms 的强制布局）。
      syncVisibleRowLayout({ visibleRows: slice.length });
      updateDoneCount();
      updatePaginationStatus();
    }

    function updateRenderedAiActive() {
      for (const row of renderedRowsById.values()) {
        row.classList.toggle("ai-active", aiActiveIds.has(row.dataset.index));
      }
    }

    function writeNote(id, note, aiDone, { deferCommit = false } = {}, revisionTarget = "") {
      const current = notes[id] || { note: "", done: false };
      const previousNote = current.note || "";
      current.aiDone = Boolean(aiDone || current.aiDone || hasAutomatedDecisionNote(note));
      current.done = Boolean(current.manualDone);
      if (!current.note || isAutomatedNoteText(current.note)) {
        current.note = note || current.note;
      } else if (note && !current.note.includes(note)) {
        current.note = current.note + "\n\n" + note;
      }
      const parsedRevision = parseAutomatedNote(current.note)?.revision || "";
      if (parsedRevision) {
        const sameAutomatedNote = isAutomatedNoteText(note) && note === previousNote;
        if (!sameAutomatedNote || !Object.prototype.hasOwnProperty.call(current, "revisionText")) {
          current.revisionText = parsedRevision;
        }
        current.revisionTarget = normalizeRevisionTarget(revisionTarget) || current.revisionTarget || "cn";
      } else if (isAutomatedNoteText(note)) {
        current.revisionText = "";
        current.revisionTarget = "";
      }
      cleanAiFailureState(current);
      notes[id] = current;
      pruneEmptyNote(id);
      markNotesDirtyForMetrics();
      const rendered = renderedRow(id);
      const summary = rendered?.querySelector(".note-summary");
      if (summary) {
        const wrapper = document.createElement("div");
        wrapper.innerHTML = renderNoteSummary(notes[id], id);
        summary.replaceWith(wrapper.firstElementChild);
      }
      const checkbox = rendered?.querySelector('[data-done]');
      if (checkbox) {
        checkbox.checked = Boolean(notes[id]?.manualDone);
        checkbox.closest("tr").classList.toggle("done", checkbox.checked);
      }
      const aiBadge = rendered?.querySelector('[data-ai-done]');
      if (aiBadge) {
        const state = aiBadgeState(notes[id]);
        aiBadge.className = "ai-confirm-badge " + state.cls;
        aiBadge.textContent = state.text;
      }
      // 术语块只在「跑过对照表/AI」前后切换出处说明（构建期预判 ↔ 备注结论），内容不变就不重建。
      const termChipSlot = rendered?.querySelector('[data-term-chip-slot]');
      if (termChipSlot) {
        const html = renderTermChipHtml(id, notes[id]?.note || "");
        if (termChipSlot.innerHTML !== html) termChipSlot.innerHTML = html;
      }
      const diffSlot = rendered?.querySelector('[data-diff-slot]');
      const row = rowsById.get(id);
      if (diffSlot && row) diffSlot.innerHTML = renderDiffBlock(row, notes[id]);
      if (!deferCommit) {
        saveNotes();
        updateDoneCount();
      }
    }

    function aiResultState(row) {
      const note = parseAutomatedNote(notes[String(row.index)]?.note || "");
      if (!note) return "none";
      if (note.modify === "是") return "modify";
      if (note.modify === "否") return "same";
      return "unclear";
    }

    function issueSeverityState(row) {
      const note = parseAutomatedNote(notes[String(row.index)]?.note || "");
      if (!note) return "unrated";
      return note.grade || note.severity || "unrated";
    }

    function allAiSameRows() {
      return allRows.filter((row) => {
        const item = notes[String(row.index)];
        return aiResultState(row) === "same" && !item?.manualDone && !item?.recoveredUnverified;
      });
    }
    const currentAiSameRows = allAiSameRows;

    function prefilterResultKind(row) {
      const marker = automatedNoteMarker(notes[String(row.index)]?.note || "");
      if (marker === "[规则预筛]") return "rule";
      if (marker === "[相似度预筛]") return "similarity";
      if (marker === "[对照表]") return "term";
      return "";
    }

    function currentPrefilterRows() {
      if (!prefilterResultFilterActive) return [];
      return filteredRows.filter((row) => {
        const id = String(row.index);
        return prefilterResultIds.has(id) && prefilterResultKind(row) && !notes[id]?.manualDone && !notes[id]?.recoveredUnverified;
      });
    }

    function updatePrefilterConfirmButton(ai = null) {
      if (
        ai &&
        ai.kind === "prefilter" &&
        ai.runId === prefilterRunId
      ) {
        prefilterResultsCatchingUp = Boolean(ai.running || ai.hasMoreResults);
      }
      prefilterIds.confirm.disabled = !prefilterResultFilterActive || prefilterResultsCatchingUp || currentPrefilterRows().length === 0;
    }

    function matchesFilter(row, q) {
      const id = String(row.index);
      const hasNote = hasStoredNote(notes[id]);
      const isDone = Boolean(notes[id]?.manualDone);
      const matchesQuery = !q || rowText(row).includes(q);
      const matchesSeverity = severityFilter === "all" || row.cls === severityFilter;
      const matchesAiResult = aiResultFilter === "all" || aiResultState(row) === aiResultFilter;
      const itemGrade = issueSeverityState(row);
      const matchesIssueSeverity = issueSeverityFilter === "all" ||
        itemGrade === issueSeverityFilter ||
        (issueSeverityFilter === "poor" && itemGrade === "critical") ||
        (issueSeverityFilter === "fair" && itemGrade === "major") ||
        (issueSeverityFilter === "good" && itemGrade === "minor") ||
        (issueSeverityFilter === "excellent" && itemGrade === "none") ||
        (issueSeverityFilter === "critical" && itemGrade === "poor") ||
        (issueSeverityFilter === "major" && itemGrade === "fair") ||
        (issueSeverityFilter === "minor" && itemGrade === "good");
      const matchesNotes = !notesOnly || hasNote;
      const matchesDone =
        doneMode === "all" ||
        (doneMode === "open" && !isDone) ||
        (doneMode === "done" && isDone);
      const rawNote = notes[id]?.note || "";
      const matchesStage = !activeStageFilter ||
        (activeStageFilter === "1" && (rawNote.includes("是否需要修改：否") || (rawNote.includes("调用失败") && !rawNote.includes("Stylist") && !rawNote.includes("Arbiter")))) ||
        (activeStageFilter === "2" && (rawNote.includes("Stylist复审") || (rawNote.includes("调用失败") && rawNote.includes("Stylist")))) ||
        (activeStageFilter === "3" && (rawNote.includes("Arbiter仲裁") || (rawNote.includes("调用失败") && rawNote.includes("Arbiter"))));
      const isStage2PendingRow = (r) => {
        const rowId = String(r.index);
        const text = String(notes[rowId]?.note || "");
        if (!text) return false;
        const p = parseAutomatedNote(text);
        if (!p) return false;
        const hasS2 = Boolean(p.stage2 || text.includes("Stylist复审"));
        return isStage2CandidateNote(p, text) && !hasS2;
      };
      const isStage1UnclearRow = (r) => {
        const rowId = String(r.index);
        const text = String(notes[rowId]?.note || "");
        if (!text) return false;
        const p = parseAutomatedNote(text);
        if (!p) return false;
        const hasS2 = Boolean(p.stage2 || text.includes("Stylist复审"));
        const isGkUnclear = p.stage1?.includes("存疑") || (!hasS2 && (p.modify === "待人工确认" || p.modify === "人工确认")) || text.includes("存疑转人工") || text.includes("初审存疑");
        return Boolean(isGkUnclear);
      };
      const isStage3PendingRow = (r) => {
        const rowId = String(r.index);
        return getStage3RowStatus(notes[rowId]).isPending;
      };
      const matchesSummary = !activeSummaryFilter ||
        (activeSummaryFilter === "needsEdit" && aiResultState(row) === "modify") ||
        (activeSummaryFilter === "unchanged" && aiResultState(row) === "same") ||
        (activeSummaryFilter === "needsCheck" && aiResultState(row) === "unclear") ||
        (activeSummaryFilter === "stage1Unclear" && isStage1UnclearRow(row)) ||
        (activeSummaryFilter === "stage2Pending" && isStage2PendingRow(row)) ||
        (activeSummaryFilter === "stage3Pending" && isStage3PendingRow(row));
      const matchesPrefilterResult = !prefilterResultFilterActive || prefilterResultIds.has(id);
      return matchesQuery && matchesSeverity && matchesAiResult && matchesIssueSeverity && matchesNotes && matchesDone && matchesPrefilterResult && matchesStage && matchesSummary;
    }

    function applyFilters({ reset = true } = {}) {
      const q = query.value.trim().toLowerCase();
      filteredRows = allRows.filter((row) => matchesFilter(row, q));
      renderVisibleRows({ reset });
      updatePrefilterConfirmButton();
      const filterPanelState = document.getElementById("filterPanelState");
      if (filterPanelState) {
        filterPanelState.textContent = filteredRows.length === allRows.length
          ? "未筛选"
          : "筛选 " + filteredRows.length + "/" + allRows.length + " 行";
      }
    }

    let throttledApplyFiltersTimer = 0;
    function scheduleThrottledApplyFilters() {
      if (throttledApplyFiltersTimer) return;
      if (typeof window !== "undefined" && window.requestAnimationFrame) {
        throttledApplyFiltersTimer = window.requestAnimationFrame(() => {
          throttledApplyFiltersTimer = 0;
          applyFilters({ reset: false });
        });
      } else {
        throttledApplyFiltersTimer = window.setTimeout(() => {
          throttledApplyFiltersTimer = 0;
          applyFilters({ reset: false });
        }, 16);
      }
    }

    function scheduleFilter() {
      window.clearTimeout(filterTimer);
      filterTimer = window.setTimeout(() => applyFilters(), 120);
    }

    tbody.addEventListener("input", (event) => {
      const revisionEditor = event.target.closest("[data-revision]");
      if (revisionEditor) {
        // 内容变了：先失效该编辑器的旧高度缓存，再按新内容量一次。
        invalidateRevisionEditorHeight(revisionEditor);
        syncRevisionEditorHeight(revisionEditor);
        const id = revisionEditor.dataset.revision;
        const current = notes[id] || { note: "", done: false, manualDone: false, aiDone: false };
        current.revisionText = revisionEditor.value;
        current.revisionTarget = revisionTargetFor(current);
        notes[id] = current;
        const copyButton = revisionEditor.closest(".note-revision")?.querySelector(".copy-revision");
        if (copyButton) copyButton.dataset.copyText = revisionEditor.value;
        const row = rowsById.get(id);
        const diffSlot = renderedRow(id)?.querySelector('[data-diff-slot]');
        if (diffSlot && row) diffSlot.innerHTML = renderDiffBlock(row, current);
        saveNotes();
        updateDoneCount();
        return;
      }
    });

    tbody.addEventListener("blur", (event) => {
      if (event.target.closest("[data-revision]")) scheduleFilter();
    }, true);

    tbody.addEventListener("change", (event) => {
      const box = event.target.closest("[data-done]");
      if (box) {
        const id = box.dataset.done;
        const current = notes[id] || { note: "", done: false };
        const wasUnverified = Boolean(current.recoveredUnverified);
        if (box.checked) delete current.recoveredUnverified;
        current.manualDone = box.checked;
        current.done = Boolean(current.manualDone);
        notes[id] = current;
        pruneEmptyNote(id);
        box.closest("tr").classList.toggle("done", box.checked);
        saveNotes();
        updateDoneCount();
        if (doneMode !== "all" || wasUnverified) applyFilters({ reset: false });
        return;
      }
    });

    tbody.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-copy-text]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const originalText = button.textContent;
      button.disabled = true;
      try {
        await copyText(button.dataset.copyText || "");
        button.textContent = "已复制";
      } catch {
        button.textContent = "复制失败";
      } finally {
        window.setTimeout(() => {
          button.textContent = originalText || "复制";
          button.disabled = false;
        }, 1200);
      }
    });

    tbody.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-writeback-revision]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.writebackRevision;
      await writebackSingleRevision(id, button);
    });

    tbody.addEventListener("click", (event) => {
      const applyStageBtn = event.target.closest("[data-apply-stage]");
      if (applyStageBtn) {
        event.preventDefault();
        event.stopPropagation();
        const rowId = applyStageBtn.dataset.rowId;
        const stage = applyStageBtn.dataset.applyStage;
        applyStageRevision(rowId, stage);
        return;
      }
      const pipelineBtn = event.target.closest("[data-pipeline-toggle]");
      if (pipelineBtn) {
        event.preventDefault();
        event.stopPropagation();
        const rowId = pipelineBtn.dataset.pipelineToggle;
        const details = document.getElementById("pipelineDetails_" + rowId);
        if (details) {
          details.hidden = !details.hidden;
          // 记住用户这一行的开合选择：重渲染会重建行节点，不记就会弹回默认态。
          setPipelineOpen(rowId, !details.hidden);
          const hint = pipelineBtn.querySelector(".pipeline-expand-hint");
          if (hint) hint.textContent = details.hidden ? "审核轨迹 ▾" : "收起 ▴";
          // 这里刻意不做任何布局同步：展开/收起只改本行行高，既不移动表格容器
          // （可用高度不用重算），也不改输入框宽度（行高缓存仍然成立）。
          // 整表同步很贵（500 行页面一次 311ms），能不做就不做。
        }
        return;
      }
      const row = event.target.closest("tbody tr");
      if (!row) return;
      const previous = activeRowId ? renderedRow(activeRowId) : null;
      if (previous) previous.classList.remove("active-row");
      activeRowId = row.dataset.index;
      row.classList.add("active-row");
    });

    query.addEventListener("input", scheduleFilter);
    for (const button of severityButtons) {
      button.addEventListener("click", () => {
        severityFilter = button.dataset.severity;
        for (const item of severityButtons) item.classList.toggle("is-active", item === button);
        applyFilters();
      });
    }
    for (const button of aiResultButtons) {
      button.addEventListener("click", () => {
        aiResultFilter = button.dataset.aiResult;
        for (const item of aiResultButtons) item.classList.toggle("is-active", item === button);
        applyFilters();
      });
    }
    for (const button of issueSeverityButtons) {
      button.addEventListener("click", () => {
        issueSeverityFilter = button.dataset.issueSeverity;
        for (const item of issueSeverityButtons) item.classList.toggle("is-active", item === button);
        applyFilters();
      });
    }
    noteFilter.addEventListener("click", () => {
      notesOnly = !notesOnly;
      noteFilter.classList.toggle("is-active", notesOnly);
      noteFilter.setAttribute("aria-pressed", String(notesOnly));
      applyFilters();
    });
    prefilterResultFilter.addEventListener("click", () => {
      prefilterResultFilterActive = !prefilterResultFilterActive;
      prefilterResultFilter.classList.toggle("is-active", prefilterResultFilterActive);
      prefilterResultFilter.setAttribute("aria-pressed", String(prefilterResultFilterActive));
      applyFilters();
    });
    doneFilter.addEventListener("click", () => {
      doneMode = doneMode === "open" ? "all" : "open";
      const active = doneMode === "open";
      doneFilter.classList.toggle("is-active", active);
      doneFilter.setAttribute("aria-pressed", String(active));
      doneFilter.textContent = "未人工确认";
      applyFilters();
    });

    let activeStageFilter = null;
    let activeSummaryFilter = null;
    let suppressStageCardFilterUntil = 0;

    function suppressStageCardFilter(durationMs = 600) {
      suppressStageCardFilterUntil = Math.max(suppressStageCardFilterUntil, Date.now() + durationMs);
    }

    function bindStageCardFilters() {
      const cards = ["stage1Card", "stage2Card", "stage3Card"]
        .map((id) => document.getElementById(id))
        .filter(Boolean);

      // 为阶段预设下拉选择框绑定完整的事件隔离与抑制锁，杜绝任何冒泡或 Chromium 原生下拉穿透点击
      const presetSelects = [aiIds.stage1Preset, aiIds.stage2Preset, aiIds.stage3Preset].filter(Boolean);
      presetSelects.forEach((selectEl) => {
        const suppressHandler = (e) => {
          suppressStageCardFilter(600);
          if (e && (e.type === "click" || e.type === "mousedown" || e.type === "pointerdown")) {
            e.stopPropagation();
          }
        };
        ["mousedown", "mouseup", "click", "pointerdown", "pointerup", "focus", "blur", "input", "change"].forEach((ev) => {
          selectEl.addEventListener(ev, suppressHandler);
        });
      });

      cards.forEach((card) => {
        card.addEventListener("click", (event) => {
          // 1. 若处于预设选择器的交互抑制窗口内（防原生 select 关闭时的合成穿透点击），忽略
          if (Date.now() < suppressStageCardFilterUntil) {
            return;
          }
          // 2. 若点击目标位于卡片头部（标题区、下拉框、或任何表单控件），忽略
          if (event?.target?.closest && event.target.closest(".ai-stage-card-head, .ai-stage-preset-select, select, option, label, button, input")) {
            return;
          }

          const stage = card.dataset.filterStage;
          if (activeStageFilter === stage) {
            activeStageFilter = null;
            card.classList.remove("is-active-filter");
            showToast("已取消阶段筛选，展示全部行", { tone: "info", durationMs: 2500 });
          } else {
            cards.forEach((c) => c.classList.remove("is-active-filter"));
            activeStageFilter = stage;
            card.classList.add("is-active-filter");
            const names = { "1": "阶段一 事实初审", "2": "阶段二 文学复审", "3": "阶段三 终审仲裁" };
            showToast("已筛选 " + names[stage] + " 相关行（再次点击指标可取消）", { tone: "info", durationMs: 3000 });
          }
          applyFilters({ reset: true });
        });
      });

      // 顶部全局审核结论指标筛选与待复审/待仲裁筛选
      const summaryItems = [
        { id: "aiStageSummaryNeedsEdit", filter: "needsEdit", name: "最终建议修改" },
        { id: "aiStageSummaryUnchanged", filter: "unchanged", name: "无需修改" },
        { id: "aiStageSummaryNeedsCheck", filter: "needsCheck", name: "待人工确认" },
        { id: "stage1UnclearPill", filter: "stage1Unclear", name: "初审存疑" },
        { id: "stage2PendingItem", filter: "stage2Pending", name: "待文学复审" },
        { id: "stage3PendingItem", filter: "stage3Pending", name: "待终审仲裁" },
      ];
      summaryItems.forEach(({ id, filter, name }) => {
        const el = document.getElementById(id);
        if (!el) return;
        const trigger = () => {
          if (activeSummaryFilter === filter) {
            activeSummaryFilter = null;
            el.classList.remove("is-active");
            showToast("已取消" + name + "筛选，展示全部行", { tone: "info", durationMs: 2500 });
          } else {
            summaryItems.forEach((item) => document.getElementById(item.id)?.classList.remove("is-active"));
            activeSummaryFilter = filter;
            el.classList.add("is-active");
            showToast("已筛选" + name + "行（再次点击可取消）", { tone: "info", durationMs: 3000 });
          }
          applyFilters({ reset: true });
        };
        el.addEventListener("click", trigger);
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            trigger();
          }
        });
      });
    }
    bindStageCardFilters();
    showSource.addEventListener("change", () => {
      document.documentElement.classList.toggle("hide-source", !showSource.checked);
      // 隐藏/恢复整列会改变输入框宽度（实测 412px → 579px），行高缓存必须整批作废。
      scheduleVisibleRowLayoutSync({ remeasureEditors: true });
    });
    if (showTranslationDiff) {
      showTranslationDiff.addEventListener("change", () => {
        document.documentElement.classList.toggle("hide-translation-diff", !showTranslationDiff.checked);
        scheduleVisibleRowLayoutSync({ remeasureEditors: true });
      });
    }
    showRevisionDiff.addEventListener("change", () => {
      document.documentElement.classList.toggle("hide-revision-diff", !showRevisionDiff.checked);
      scheduleVisibleRowLayoutSync({ remeasureEditors: true });
    });
    const writebackBackupToggle = document.getElementById("writebackBackupToggle");
    if (writebackBackupToggle) {
      writebackBackupToggle.checked = getWritebackBackupSetting();
      writebackBackupToggle.addEventListener("change", () => {
        setWritebackBackupSetting(writebackBackupToggle.checked);
      });
    }
    if (aiIds.promptVisible) {
      aiIds.promptVisible.addEventListener("change", () => {
        aiIds.promptSection.hidden = !aiIds.promptVisible.checked;
        if (aiIds.promptVisible.checked) aiIds.promptSection.open = true;
        saveAiConfig();
        // 提示词区在表格上方，开合会把表格推上推下：位置变了才重算可用高度。
        scheduleVisibleRowLayoutSync({ ifFrameMoved: true });
      });
    }

    function setPage(page) {
      currentPage = Math.max(1, Math.min(Number(page) || 1, totalPages()));
      renderVisibleRows();
      const tableTop = document.querySelector(".table-frame").offsetTop - 12;
      window.scrollTo({ top: tableTop, behavior: "auto" });
    }

    function visibleRevisionWriteButtons() {
      return Array.from(tbody.querySelectorAll("[data-writeback-revision]"))
        .filter((button) => !button.disabled && button.getClientRects().length > 0);
    }

    function focusRevisionControl(control) {
      if (!control) return false;
      const row = control.closest("tr[data-index]");
      const previous = activeRowId ? renderedRow(activeRowId) : null;
      if (previous && previous !== row) previous.classList.remove("active-row");
      activeRowId = row?.dataset.index || "";
      if (row) row.classList.add("active-row");
      control.focus({ preventScroll: true });
      if (row && !tableFrame.classList.contains("is-fit-content")) {
        const frameRect = tableFrame.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const headerHeight = tableFrame.querySelector("thead")?.getBoundingClientRect().height || 0;
        const preferredTop = Math.max(headerHeight + 16, Math.round(tableFrame.clientHeight * 0.18));
        keyboardScrollSpacer.style.height = Math.max(0, tableFrame.clientHeight - preferredTop) + "px";
        const rowTop = tableFrame.scrollTop + rowRect.top - frameRect.top;
        const maxScrollTop = Math.max(0, tableFrame.scrollHeight - tableFrame.clientHeight);
        tableFrame.scrollTop = Math.max(0, Math.min(rowTop - preferredTop, maxScrollTop));
      }
      return true;
    }

    function revisionNavigationTargets() {
      const targets = [];
      filteredRows.forEach((row, filteredIndex) => {
        const id = String(row.index);
        const item = notes[id];
        const targetKey = revisionTargetFor(item);
        const revision = revisionTextFor(item);
        if (row[targetKey] && revision) targets.push({ id, filteredIndex });
      });
      return targets;
    }

    function focusRevisionTarget(target) {
      if (!target) return false;
      const size = Number(pageSize.value || 100);
      const targetPage = Math.floor(target.filteredIndex / size) + 1;
      if (targetPage !== currentPage) {
        currentPage = targetPage;
        renderVisibleRows();
      }
      const button = tbody.querySelector('[data-writeback-revision="' + CSS.escape(target.id) + '"]');
      return visibleRevisionWriteButtons().includes(button) && focusRevisionControl(button);
    }

    function focusAdjacentRevision(direction, currentButton = null) {
      const buttons = visibleRevisionWriteButtons();
      const currentIndex = currentButton ? buttons.indexOf(currentButton) : -1;
      if (currentIndex >= 0) {
        const adjacent = buttons[currentIndex + direction];
        if (adjacent) return focusRevisionControl(adjacent);
        const targets = revisionNavigationTargets();
        const targetIndex = targets.findIndex((target) => target.id === currentButton.dataset.writebackRevision);
        const target = targets[targetIndex + direction];
        return target ? focusRevisionTarget(target) : true;
      }

      const targets = revisionNavigationTargets();
      if (activeRowId) {
        const activeButton = activeRowId
          ? buttons.find((button) => button.dataset.writebackRevision === activeRowId)
          : null;
        if (activeButton) return focusRevisionControl(activeButton);
        const activeIndex = filteredRows.findIndex((row) => String(row.index) === activeRowId);
        const target = direction > 0
          ? targets.find((item) => item.filteredIndex > activeIndex)
          : targets.filter((item) => item.filteredIndex < activeIndex).at(-1);
        if (target) return focusRevisionTarget(target);
      }

      const edge = direction > 0 ? buttons[0] : buttons.at(-1);
      if (edge) return focusRevisionControl(edge);
      const size = Number(pageSize.value || 100);
      const pageStart = (currentPage - 1) * size;
      const pageEnd = currentPage * size;
      const target = direction > 0
        ? targets.find((item) => item.filteredIndex >= pageEnd)
        : targets.filter((item) => item.filteredIndex < pageStart).at(-1);
      return focusRevisionTarget(target);
    }

    function isKeyboardEditingTarget(target) {
      return Boolean(target.closest('input:not([type="checkbox"]), textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"]'));
    }

    document.addEventListener("keydown", (event) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (isKeyboardEditingTarget(event.target)) return;
      const currentButton = event.target.closest("[data-writeback-revision]");
      const direction = event.key === "ArrowDown" ? 1 : -1;
      if (!focusAdjacentRevision(direction, currentButton)) return;
      event.preventDefault();
    });

    firstPage.addEventListener("click", () => setPage(1));
    prevPage.addEventListener("click", () => setPage(currentPage - 1));
    nextPage.addEventListener("click", () => setPage(currentPage + 1));
    lastPage.addEventListener("click", () => setPage(totalPages()));
    pageInput.addEventListener("change", () => setPage(pageInput.value));
    pageInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") setPage(pageInput.value);
    });
    pageSize.addEventListener("change", () => renderVisibleRows({ reset: true }));

    document.getElementById("clearFilter").addEventListener("click", () => {
      query.value = "";
      severityFilter = "all";
      aiResultFilter = "all";
      issueSeverityFilter = "all";
      notesOnly = false;
      doneMode = "all";
      prefilterResultFilterActive = false;
      for (const button of severityButtons) button.classList.toggle("is-active", button.dataset.severity === "all");
      for (const button of aiResultButtons) button.classList.toggle("is-active", button.dataset.aiResult === "all");
      for (const button of issueSeverityButtons) button.classList.toggle("is-active", button.dataset.issueSeverity === "all");
      noteFilter.classList.remove("is-active");
      noteFilter.setAttribute("aria-pressed", "false");
      prefilterResultFilter.classList.remove("is-active");
      prefilterResultFilter.setAttribute("aria-pressed", "false");
      doneFilter.classList.remove("is-active");
      doneFilter.setAttribute("aria-pressed", "false");
      doneFilter.textContent = "未人工确认";
      if (activeStageFilter) {
        activeStageFilter = null;
        ["stage1Card", "stage2Card", "stage3Card"].forEach((id) => {
          document.getElementById(id)?.classList.remove("is-active-filter");
        });
      }
      if (activeSummaryFilter) {
        activeSummaryFilter = null;
        ["aiStageSummaryNeedsEdit", "aiStageSummaryUnchanged", "aiStageSummaryNeedsCheck", "stage1UnclearPill", "stage2PendingItem", "stage3PendingItem"].forEach((id) => {
          document.getElementById(id)?.classList.remove("is-active");
        });
      }
      showSource.checked = true;
      if (showTranslationDiff) showTranslationDiff.checked = true;
      showRevisionDiff.checked = true;
      document.documentElement.classList.remove("hide-source", "hide-translation-diff", "hide-revision-diff");
      applyFilters();
    });

    // 当前筛选结果中所有带修改结果、且修改内容与原文不同的行。
    function currentRevisionEntries() {
      const entries = [];
      for (const row of filteredRows) {
        const id = String(row.index);
        const item = notes[id];
        if (item?.recoveredUnverified) continue;
        const revision = revisionTextFor(item).trim();
        const targetKey = revisionTargetFor(item);
        const searchText = String(row[targetKey] || "");
        if (!searchText || !revision || searchText === revision) continue;
        entries.push({ id, targetKey, searchText, replaceText: revision });
      }
      return entries;
    }

    // 未校验找回行有多少条带修改结果，用于在写回提示里说明被跳过的数量。
    function countSkippedUnverifiedRevisions() {
      let count = 0;
      for (const row of filteredRows) {
        const item = notes[String(row.index)];
        if (item?.recoveredUnverified && revisionTextFor(item).trim()) count += 1;
      }
      return count;
    }

    function markEntriesConfirmed(ids) {
      for (const id of ids) {
        const current = notes[id] || { note: "", done: false, manualDone: false, aiDone: false };
        current.manualDone = true;
        current.done = true;
        notes[id] = current;
      }
      saveNotes();
    }

    function importedCopyHint(result) {
      return result.importedCopy
        ? " 注意：写入的是导入副本——要写回本地原始文件，请在控制台用「本地路径」导入后重新生成。"
        : "";
    }

    function writebackTargetNames(targets) {
      return (Array.isArray(targets) ? targets : [])
        .map((target) => String(target || "").replace(/\\/g, "/").split("/").filter(Boolean).pop())
        .filter(Boolean)
        .join("、");
    }

    // 写回要带上目标列的**整卷行序**（第 i 行对应下标 i-1）：写回定位按行序推进锚点，
    // 未改动的行也要按自己的文本先占住位置，同一段文字在别处先出现的行才不会被本行改掉
    // （真实回归：一卷里两处独立成行的 <p>尽管如此。</p>，写回第 2 处却落到第 1 处）。
    // 只发到要写的最后一行为止——更靠后的行不参与锚点。缺行号的行不生成清单，服务端按旧行为处理。
    function writebackRowTexts(entries) {
      const limit = entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0);
      const columns = new Set(entries.map((entry) => entry.targetKey));
      const rowTexts = {};
      for (const key of columns) {
        const list = new Array(limit).fill("");
        for (const row of allRows) {
          const index = Number(row.index);
          if (!Number.isInteger(index) || index < 1 || index > limit) continue;
          list[index - 1] = String(row[key] || "");
        }
        rowTexts[key] = list;
      }
      return rowTexts;
    }

    function applyStageRevision(id, stage) {
      const rowId = String(id || "");
      if (!rowId || !notes[rowId]) return;
      const row = typeof rowsById !== "undefined" && rowsById ? rowsById.get(rowId) : null;
      const current = notes[rowId] || { note: "", done: false };
      const targetKey = revisionTargetFor(current);
      const rowTargetText = row ? String(row[targetKey] || row.cn || "") : "";
      const noteData = parseAutomatedNote(notes[rowId].note, rowTargetText);
      if (!noteData) return;

      let targetText = "";
      let stageName = "";
      if (String(stage) === "1") {
        targetText = noteData.stage1Revision || "";
        stageName = "阶段一初审方案";
      } else if (String(stage) === "2") {
        targetText = noteData.stage2Revision || noteData.revision || "";
        stageName = "阶段二复审方案";
      } else if (String(stage) === "3") {
        targetText = noteData.stage3Revision || noteData.revision || "";
        stageName = "阶段三仲裁方案";
      }

      if (!targetText) {
        const fallbackMsg = noteData.stage1
          ? ("第 " + rowId + " 行初审要点：" + noteData.stage1.slice(0, 80) + "…")
          : "该阶段未提供独立修改文本";
        showToast(fallbackMsg, { tone: "watch", durationMs: 7000 });
        return;
      }

      // 核心安全防线：若该阶段提供的内容是局部修正提议（非整段改案），
      // 绝不能直接作为整行 revisionText 覆盖输入框（否则会导致整段正文被砍掉）！
      if (isPartialProposal(targetText, rowTargetText, current.note)) {
        showToast("第 " + rowId + " 行" + stageName + "为局部修正提议「" + targetText + "」（非整段改案），已在下方演进对比中展示；请在输入框中针对对应语句进行修改，避免覆盖整行。", { tone: "watch", durationMs: 8000 });
        return;
      }

      current.revisionText = targetText;
      current.revisionStageActive = String(stage);
      current.revisionTarget = revisionTargetFor(current);
      notes[rowId] = current;
      saveNotes();

      const rowElem = renderedRow(rowId);
      if (rowElem) {
        const editor = rowElem.querySelector('.revision-editor[data-revision="' + CSS.escape(rowId) + '"]');
        if (editor) {
          editor.value = targetText;
          invalidateRevisionEditorHeight(editor);
          syncRevisionEditorHeight(editor);
        }
        const copyButton = rowElem.querySelector(".copy-revision");
        if (copyButton) copyButton.dataset.copyText = targetText;

        const pills = rowElem.querySelectorAll(".stage-pill-btn[data-row-id='" + CSS.escape(rowId) + "']");
        for (const pill of pills) {
          pill.classList.toggle("is-active", pill.dataset.applyStage === String(stage));
        }
      }

      showToast("已切换为" + stageName, { tone: "success" });
    }

    async function writebackSingleRevision(id, button) {
      const row = rowsById.get(String(id));
      const item = notes[String(id)];
      if (item?.recoveredUnverified) {
        showToast("第 " + id + " 行是按行号找回的未校验记录，写回前请先点「未校验」徽标确认无误。", { tone: "watch", durationMs: 9000 });
        return;
      }
      const revision = revisionTextFor(item).trim();
      const targetKey = revisionTargetFor(item);
      const searchText = String(row?.[targetKey] || "");
      if (!row || !searchText || !revision) {
        showToast("第 " + id + " 行没有可写回的修改结果。", { tone: "watch", durationMs: 6000 });
        return;
      }
      button.disabled = true;
      button.textContent = "写回中...";
      const backup = getWritebackBackupSetting();
      try {
        const entries = [{ id: String(id), targetKey, searchText, replaceText: revision }];
        const response = await apiFetch("/api/translation-export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectKey: pageMeta.projectKey,
            rowsSignature: pageMeta.rowsSignature,
            entries,
            rowTexts: writebackRowTexts(entries),
            writebackBackup: backup,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "写回失败");
        if (result.updated !== 1) {
          const detail = (Array.isArray(result.ambiguous) && result.ambiguous[0]) || (Array.isArray(result.missed) && result.missed[0]);
          const reason = detail && detail.reason ? detail.reason : "原文件中没有匹配的段落。";
          throw new Error("写回未生效：" + reason);
        }
        const current = notes[String(id)] || { note: "", done: false };
        current.manualDone = true;
        current.done = true;
        notes[String(id)] = current;
        saveNotes();
        applyFilters({ reset: false });
        const writtenTo = writebackTargetNames(result.targets || (result.target ? [result.target] : []));
        const backupNote = result.backup ? "（已生成 .bak 备份）" : "";
        showToast("已写回第 " + id + " 行修改结果" + (writtenTo ? "（" + writtenTo + "）" : "") + backupNote + "，并标记为人工确认。" + importedCopyHint(result), { tone: result.importedCopy ? "watch" : "success", durationMs: 12000 });
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
        button.disabled = false;
        button.textContent = "写回";
      }
    }

    document.getElementById("acceptAiSame").addEventListener("click", () => {
      const rows = allAiSameRows();
      if (!rows.length) {
        showToast("没有待确认的自动不改行。", { tone: "watch", durationMs: 6000 });
        return;
      }
      if (!confirm("将全部 " + rows.length + " 条自动不改行标记为人工确认（无视当前筛选）？")) return;
      for (const row of rows) {
        const id = String(row.index);
        const current = notes[id] || { note: "", done: false, manualDone: false, aiDone: false };
        current.manualDone = true;
        current.done = true;
        notes[id] = current;
      }
      saveNotes();
      updateDoneCount();
      showToast("已将 " + rows.length + " 条自动不改行标记为人工确认。", { tone: "success", durationMs: 7000 });
      applyFilters({ reset: false });
    });

    document.getElementById("exportNotes").addEventListener("click", async () => {
      const skippedUnverified = countSkippedUnverifiedRevisions();
      const entries = currentRevisionEntries();
      if (!entries.length) {
        showToast(skippedUnverified
          ? "当前筛选结果没有可写回的修改结果；" + skippedUnverified + " 条未校验找回行已跳过。"
          : "当前筛选结果中没有待写回的修改结果。", { tone: "watch", durationMs: 9000 });
        return;
      }
      const skipNote = skippedUnverified ? "（另有 " + skippedUnverified + " 条未校验找回行被跳过）" : "";
      const backup = getWritebackBackupSetting();
      const backupTip = backup ? "（已开启自动备份，写回前将生成 .bak 备份副本）" : "（未开启自动备份）";
      if (!confirm("将当前筛选结果中的 " + entries.length + " 处修改结果写回原文件？定位失败或有多处同段的段落不会写入。" + skipNote + "\n" + backupTip)) return;
      try {
        const response = await apiFetch("/api/translation-export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            projectKey: pageMeta.projectKey,
            rowsSignature: pageMeta.rowsSignature,
            entries,
            rowTexts: writebackRowTexts(entries),
            writebackBackup: backup,
          }),
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || "写回失败");
        // 只有真正写入的行才算人工确认：定位失败与「有多处同段」的行没有落到文件上，
        // 标成已确认会让它们从复核视野里消失。
        const unwrittenIds = new Set([...(Array.isArray(result.missed) ? result.missed : []), ...(Array.isArray(result.ambiguous) ? result.ambiguous : [])]
          .map((item) => String(item?.index)));
        const confirmed = entries.filter((entry) => !unwrittenIds.has(String(entry.id))).map((entry) => String(entry.id));
        markEntriesConfirmed(confirmed);
        applyFilters({ reset: false });
        const missedCount = (Array.isArray(result.missed) ? result.missed.length : 0);
        const ambiguousCount = (Array.isArray(result.ambiguous) ? result.ambiguous.length : 0);
        const writtenTo = writebackTargetNames(result.targets || (result.target ? [result.target] : []));
        const unwrittenNote = [
          missedCount ? missedCount + " 处未能在原文件中定位" : "",
          ambiguousCount ? ambiguousCount + " 处在原文件中有多处同段、未写入" : "",
        ].filter(Boolean).join("；");
        const tone = (unwrittenNote || result.importedCopy) ? "watch" : "success";
        const backupNote = result.backup ? " 已生成 .bak 备份。" : "";
        showToast((unwrittenNote
          ? "已写回 " + result.updated + " 处修改；" + unwrittenNote + "，这些行未标记为已确认。"
          : "已写回 " + result.updated + " 处修改。") + (writtenTo ? " 写入：" + writtenTo : "") + backupNote + importedCopyHint(result), { tone, durationMs: 15000 });
      } catch (error) { showToast(error.message, { tone: "error", durationMs: 12000 }); }
    });

    document.getElementById("confirmRevisions").addEventListener("click", () => {
      const entries = currentRevisionEntries();
      const pending = entries.filter((entry) => !notes[entry.id]?.manualDone);
      if (!pending.length) {
        showToast("当前筛选结果中没有待确认的修改结果。", { tone: "watch", durationMs: 6000 });
        return;
      }
      if (!confirm("将当前筛选结果中的 " + pending.length + " 处修改结果标记为人工确认？")) return;
      markEntriesConfirmed(pending.map((entry) => entry.id));
      applyFilters({ reset: false });
      showToast("已将 " + pending.length + " 处修改结果标记为人工确认。", { tone: "success", durationMs: 6000 });
      tableFrame.scrollTop = 0;
    });

    prefilterIds.confirm.addEventListener("click", () => {
      const rows = currentPrefilterRows();
      if (!rows.length) {
        showToast("当前筛选结果中没有待确认的预筛通过行。", { tone: "watch", durationMs: 6000 });
        updatePrefilterConfirmButton();
        return;
      }
      const counts = rows.reduce((result, row) => {
        const kind = prefilterResultKind(row);
        if (kind) result[kind] += 1;
        return result;
      }, { rule: 0, similarity: 0, term: 0 });
      const message = "当前预筛结果共 " + rows.length + " 条：规则通过 " + counts.rule + " 条，相似度通过 " + counts.similarity + " 条，对照表命中 " + counts.term + " 条。\n\n确认后将为这些行勾选“人工确认”。是否继续？";
      if (!confirm(message)) return;
      for (const row of rows) {
        const id = String(row.index);
        const current = notes[id] || { note: "", done: false, manualDone: false, aiDone: false };
        current.manualDone = true;
        current.done = true;
        notes[id] = current;
      }
      saveNotes();
      updateDoneCount();
      applyFilters({ reset: false });
      showToast("已将 " + rows.length + " 条预筛结果标记为人工确认。", { tone: "success", durationMs: 7000 });
      tableFrame.scrollTop = 0;
    });

    function aiConfig() {
      const s1PresetId = aiIds.stage1Preset?.value || "";
      const s2PresetId = aiIds.stage2Preset?.value || "";
      const s3PresetId = aiIds.stage3Preset?.value || "";

      let mainProvider = aiIds.provider.value;
      let mainBaseUrl = aiIds.baseUrl.value;
      let mainModel = aiIds.model.value;
      let mainReasoningEffort = aiIds.reasoningEffort.value;
      let mainApiKey = aiIds.apiKey.value;

      let mainConcurrency = Number(aiIds.concurrency.value);
      let mainSmartConcurrency = Boolean(aiIds.smartConcurrency?.checked);
      let mainConcurrencyMax = aiIds.concurrencyMax ? Number(aiIds.concurrencyMax.value) : 10;

      if (s1PresetId) {
        const s1Preset = presetTools.getPreset(localStorage, s1PresetId);
        if (s1Preset) {
          mainProvider = s1Preset.provider || mainProvider;
          mainBaseUrl = s1Preset.baseUrl || mainBaseUrl;
          mainModel = s1Preset.model || mainModel;
          mainReasoningEffort = s1Preset.reasoningEffort || mainReasoningEffort;
          mainApiKey = s1Preset.apiKey || mainApiKey;
          if (s1Preset.concurrency != null) mainConcurrency = Number(s1Preset.concurrency);
          if (s1Preset.smartConcurrency != null) mainSmartConcurrency = Boolean(s1Preset.smartConcurrency);
          if (s1Preset.concurrencyMax != null) mainConcurrencyMax = Number(s1Preset.concurrencyMax);
        }
      }

      // 不填代表不启用；启用前阶段才能启动后阶段
      const multiStageEnabled = Boolean(s2PresetId);
      const challengerEnabled = Boolean(s2PresetId);
      const stylistConfig = s2PresetId ? presetTools.getPreset(localStorage, s2PresetId) : null;
      const arbiterEnabled = Boolean(s2PresetId && s3PresetId);
      const arbiterConfig = (s2PresetId && s3PresetId) ? presetTools.getPreset(localStorage, s3PresetId) : null;

      return {
        provider: mainProvider,
        baseUrl: mainBaseUrl,
        model: mainModel,
        reasoningEffort: mainReasoningEffort,
        apiKey: mainApiKey,
        proofreadMode: aiIds.proofreadMode.value,
        target: aiIds.target.value,
        profileId: aiIds.profile.value,
        multiStageEnabled,
        singleModelPersona: false,
        challengerEnabled,
        arbiterEnabled,
        stylistConfig,
        arbiterConfig,
        concurrency: mainConcurrency,
        smartConcurrency: mainSmartConcurrency,
        concurrencyMax: mainConcurrencyMax,
        circuitBreakerErrorRate: parsePercentRatio(aiIds.breakerThreshold.value, 0.5, 0.1),
        circuitBreakerEnabled: !aiIds.breakerDisabled.checked,
        similarityThreshold: parsePercentRatio(prefilterIds.similarity.value),
        systemPrompt: aiIds.prompt?.value || defaultProofreadPrompt || "",
        labels: pageLabels,
        projectKey: pageMeta.projectKey || "",
        rowsSignature: pageMeta.rowsSignature || "",
        glossaryFile: pageMeta.glossaryFile || "",
        completedIndexes: [...new Set(Object.entries(notes)
          .filter(([, item]) => item?.manualDone)
          .map(([id]) => Number(id))
          .filter((id) => Number.isInteger(id) && id > 0))],
      };
    }

    function setProviderHint(defaults) {
      if (!defaults) return;
      aiIds.apiKey.placeholder = defaults.apiKeyPlaceholder || "";
      aiIds.provider.title = defaults.note || "";
      if (!aiIds.status.dataset.runtimeMessage) {
        aiIds.status.textContent = "就绪";
        aiIds.status.title = defaults.note || "就绪";
      }
    }

    function applyProviderDefaults(defaults, { force = false } = {}) {
      if (!defaults) return;
      if (force || !aiIds.baseUrl.dataset.touched) {
        aiIds.baseUrl.value = defaults.baseUrl || "";
      }
      if ((force || !aiIds.model.dataset.touched) && !aiModelOptions.length) {
        setModelOptions([defaults.model], { selected: defaults.model || "" });
      }
      setProviderHint(defaults);
    }

    // 说话习惯层：按章/按卷命中人名后启用该角色的说话特色规则，防止刻意口癖被判成翻译错误。
    function setSpeechHabitHint(status) {
      const hint = aiIds.speechHabitHint;
      if (!hint) return;
      const builtSummary = speechHabitLayerSummary();
      if (!status) {
        hint.dataset.state = builtSummary ? "ok" : "pending";
        hint.textContent = builtSummary ? "说话习惯：构建期 " + builtSummary : "说话习惯：检测中…";
        hint.title = "特化规范里声明的说话习惯表：按章/按卷命中人名后，该角色的说话特色不会被判为翻译错误。";
        return;
      }
      const files = status.files || [];
      const errors = status.errors || [];
      const names = files.map((file) => String(file).split(/[\\/]/).pop()).join("、");
      const scopeLabel = status.scope === "volume" ? "按卷" : "按章";
      if (!files.length) {
        hint.dataset.state = "off";
        hint.textContent = "说话习惯：未声明";
        hint.title = "当前特化规范没有声明 speechTables。可在该档案里加 speechTables 路径，或用环境变量 TRANSCOMPARATOR_SPEECH_TABLES 指向表格文件。";
        return;
      }
      if (!status.entries) {
        hint.dataset.state = "warning";
        hint.textContent = "说话习惯：加载失败";
        hint.title = errors.length ? errors.join("\n") : files.join("\n");
        return;
      }
      const ok = errors.length === 0;
      hint.dataset.state = ok ? "ok" : "warning";
      hint.textContent = "说话习惯：" + names + "（" + status.entries + " 条，" + scopeLabel + "命中人名" + (ok ? "" : "，" + errors.length + " 个文件失败") + "）" + (builtSummary ? "；构建期：" + builtSummary : "");
      hint.title = [files.join("\n"), ...errors].join("\n");
    }
    function setTermTableHint(status) {
      const hint = aiIds.termTableHint;
      if (!hint) return;
      const built = termLayerSummary();
      if (!status) {
        // 状态还没回来（或本地服务是旧版本）时，至少把构建期结论显示出来。
        hint.dataset.state = built ? "ok" : "pending";
        hint.textContent = built ? "对照表：" + built : "对照表：检测中…";
        hint.title = "特化规范里声明的译名对照表：只有整行有效内容都是术语时才跳过模型；其余命中行（含术语冲突、假名存疑）都把术语作为提示词注入，整句由模型判定，术语判断是模型分析里的一环。";
        return;
      }
      const files = status.files || [];
      const errors = status.errors || [];
      const names = files.map((file) => String(file).split(/[\\/]/).pop()).join("、");
      if (!files.length) {
        hint.dataset.state = "off";
        hint.textContent = "对照表：未声明";
        hint.title = "当前特化规范没有声明 termTables。可在该档案里加 termTables 路径，或用环境变量 TRANSCOMPARATOR_TERM_TABLES 指向表格文件。";
        return;
      }
      if (!status.entries) {
        hint.dataset.state = "warning";
        hint.textContent = "对照表：加载失败";
        hint.title = errors.length ? errors.join("\n") : files.join("\n");
        return;
      }
      const ok = errors.length === 0;
      hint.dataset.state = ok ? "ok" : "warning";
      hint.textContent = "对照表：" + names + "（" + status.entries + " 条术语" + (ok ? "" : "，" + errors.length + " 个文件失败") + "）" + (built ? "；" + built : "");
      hint.title = [files.join("\n"), ...errors].join("\n");
    }

    function renderStageMetricsDashboard(stageMetrics = {}, stagePipelines = {}, aiRunning = false) {
      const s1Passed = Math.max(0, Number(stageMetrics.stage1Passed) || 0);
      const s1NeedsEdit = Math.max(0, Number(stageMetrics.stage1NeedsEdit) || 0);
      const s1Unclear = Math.max(0, Number(stageMetrics.stage1Unclear) || 0);
      const s1Total = Math.max(s1Passed + s1NeedsEdit + s1Unclear, Number(stageMetrics.stage1Total) || 0);
      const s1Errors = Math.max(0, Number(stageMetrics.stage1Errors) || 0);
      const fpHits = Math.max(0, Number(stageMetrics.fastPassHits) || 0);
      // 复审完成的行如果触发仲裁，要等仲裁结束才 finalize，stageMetrics 到那一刻才 +1。
      // 运行中改用流水线回报的实时复审计数，否则会出现「阶段二只复审 1 行、阶段三却在仲裁 4 行」的假象。
      const p2Live = aiRunning ? (stagePipelines?.stage2 || null) : null;
      const p3Live = aiRunning ? (stagePipelines?.stage3 || null) : null;
      const liveAttitudes = p2Live?.attitudes || {};
      const liveReviewed = Math.max(0, Number(p2Live?.reviewed) || 0);
      const s2Reviewed = Math.max(Math.max(0, Number(stageMetrics.stage2Reviewed) || 0), liveReviewed);
      // 已经产生分歧、正卡在仲裁队列里的行也算分歧：它们的分歧已经成立，只是还没定案。
      const arbiterBacklog = Math.max(0, Number(p3Live?.pending) || 0) + Math.max(0, Number(p3Live?.inFlight) || 0);
      const s2Diverged = Math.max(0, Number(stageMetrics.stage2Diverged) || Number(stageMetrics.stage3Arbitrated) || 0) + arbiterBacklog;
      const s2Errors = Math.max(0, Number(stageMetrics.stage2Errors) || 0);
      const cAccept = Math.max(Math.max(0, Number(stageMetrics.critiqueAccept) || 0), Math.max(0, Number(liveAttitudes.accept) || 0));
      const cModify = Math.max(Math.max(0, Number(stageMetrics.critiqueModify) || 0), Math.max(0, Number(liveAttitudes.modify) || 0));
      const cReject = Math.max(Math.max(0, Number(stageMetrics.critiqueReject) || 0), Math.max(0, Number(liveAttitudes.reject) || 0));
      const cEscalate = Math.max(Math.max(0, Number(stageMetrics.critiqueEscalate) || 0), Math.max(0, Number(liveAttitudes.escalate) || 0));
      const s3Arbitrated = Math.max(0, Number(stageMetrics.stage3Arbitrated) || 0);
      const arbGK = Math.max(0, Number(stageMetrics.arbitrationGatekeeper) || 0);
      const arbStylist = Math.max(0, Number(stageMetrics.arbitrationStylist) || 0);
      const arbSynth = Math.max(0, Number(stageMetrics.arbitrationSynthesis) || 0);
      const arbOrig = Math.max(0, Number(stageMetrics.arbitrationOriginal) || 0);
      const s3Settled = Math.max(s3Arbitrated, Number(stageMetrics.stage3Settled) || (arbGK + arbStylist + arbSynth + arbOrig));
      const s3Errors = Math.max(0, Number(stageMetrics.stage3Errors) || 0);
      const finalNeedsEdit = Math.max(0, Number(stageMetrics.finalNeedsEdit) || 0);
      const finalUnchanged = Math.max(0, Number(stageMetrics.finalUnchanged) || 0);
      const finalNeedsCheck = Math.max(0, Number(stageMetrics.finalNeedsCheck) || 0);
      const totalAudited = Math.max(s1Total, finalNeedsEdit + finalUnchanged + finalNeedsCheck, Number(stageMetrics.totalAudited) || 0);

      // 全局最终修改结论摘要
      const elFinalNeedsEdit = document.getElementById("metricFinalNeedsEdit");
      if (elFinalNeedsEdit) elFinalNeedsEdit.textContent = finalNeedsEdit;
      const elFinalUnchanged = document.getElementById("metricFinalUnchanged");
      if (elFinalUnchanged) elFinalUnchanged.textContent = finalUnchanged;
      const elFinalNeedsCheck = document.getElementById("metricFinalNeedsCheck");
      if (elFinalNeedsCheck) elFinalNeedsCheck.textContent = finalNeedsCheck;
      const badgeNeedsCheck = document.getElementById("aiStageSummaryNeedsCheck");
      if (badgeNeedsCheck) badgeNeedsCheck.hidden = finalNeedsCheck === 0;

      // 阶段一
      const elS1 = document.getElementById("metricStage1Passed");
      if (elS1) elS1.textContent = s1Passed;
      const elS1NeedsEdit = document.getElementById("metricStage1NeedsEdit");
      if (elS1NeedsEdit) elS1NeedsEdit.textContent = s1NeedsEdit;
      const elS1Unclear = document.getElementById("metricStage1Unclear");
      if (elS1Unclear) elS1Unclear.textContent = s1Unclear;
      const pillS1Unclear = document.getElementById("stage1UnclearPill");
      if (pillS1Unclear) {
        pillS1Unclear.hidden = s1Unclear === 0;
        pillS1Unclear.title = "初审存疑待定 " + s1Unclear + " 行，流入阶段二文学复审（点击可筛选）";
      }
      const elS1Total = document.getElementById("metricStage1Total");
      if (elS1Total) elS1Total.textContent = s1Total;
      const elS1Err = document.getElementById("metricStage1Errors");
      if (elS1Err) {
        elS1Err.textContent = s1Errors;
        const item = document.getElementById("stage1ErrorItem");
        if (item) item.classList.toggle("has-errors", s1Errors > 0);
      }
      const elFp = document.getElementById("metricFastPassHits");
      if (elFp) elFp.textContent = fpHits;

      // 阶段二
      const elS2 = document.getElementById("metricStage2Reviewed");
      if (elS2) elS2.textContent = s2Reviewed;
      const elS2Diverged = document.getElementById("metricStage2Diverged");
      if (elS2Diverged) elS2Diverged.textContent = s2Diverged;
      const elS2Err = document.getElementById("metricStage2Errors");
      if (elS2Err) {
        elS2Err.textContent = s2Errors;
        const item = document.getElementById("stage2ErrorItem");
        if (item) item.classList.toggle("has-errors", s2Errors > 0);
      }
      const s1PendingTotal = s1NeedsEdit + s1Unclear;
      const s2Pending = Math.max(0, s1PendingTotal - s2Reviewed);
      const elS2Pending = document.getElementById("metricStage2Pending");
      const itemS2Pending = document.getElementById("stage2PendingItem");
      const sepS2Pending = document.getElementById("stage2PendingSep");
      if (elS2Pending) elS2Pending.textContent = s2Pending;
      if (itemS2Pending) {
        itemS2Pending.hidden = s2Pending === 0;
        itemS2Pending.title = "初审提改与存疑共 " + s1PendingTotal + " 行（提改 " + s1NeedsEdit + " + 存疑 " + s1Unclear + "），已复审 " + s2Reviewed + " 行，" + s2Pending + " 行尚未执行文学复审（点击可筛选）";
      }
      if (sepS2Pending) sepS2Pending.hidden = s2Pending === 0;

      const elCAccept = document.getElementById("metricCritiqueAccept");
      if (elCAccept) elCAccept.textContent = cAccept;
      const elCModify = document.getElementById("metricCritiqueModify");
      if (elCModify) elCModify.textContent = cModify;
      const elCReject = document.getElementById("metricCritiqueReject");
      if (elCReject) elCReject.textContent = cReject;
      const elCEscalate = document.getElementById("metricCritiqueEscalate");
      if (elCEscalate) elCEscalate.textContent = cEscalate;

      // 阶段三
      const elS3 = document.getElementById("metricStage3Arbitrated");
      if (elS3) elS3.textContent = s3Arbitrated;
      const elS3Settled = document.getElementById("metricStage3Settled");
      if (elS3Settled) elS3Settled.textContent = s3Settled;
      const s3Pending = Math.max(0, s2Diverged - s3Arbitrated);
      const elS3Pending = document.getElementById("metricStage3Pending");
      const itemS3Pending = document.getElementById("stage3PendingItem");
      const sepS3Pending = document.getElementById("stage3PendingSep");
      if (elS3Pending) elS3Pending.textContent = s3Pending;
      if (itemS3Pending) {
        itemS3Pending.hidden = s3Pending === 0;
        itemS3Pending.title = "复审产生分歧 " + s2Diverged + " 行，已仲裁定案 " + s3Arbitrated + " 行，" + s3Pending + " 行尚未仲裁定案（含正在仲裁的行，点击可筛选）";
      }
      if (sepS3Pending) sepS3Pending.hidden = s3Pending === 0;
      const elArbGK = document.getElementById("metricArbGatekeeper");
      if (elArbGK) elArbGK.textContent = arbGK;
      const elArbStylist = document.getElementById("metricArbStylist");
      if (elArbStylist) elArbStylist.textContent = arbStylist;
      const elArbSynth = document.getElementById("metricArbSynthesis");
      if (elArbSynth) elArbSynth.textContent = arbSynth;
      const elArbOrig = document.getElementById("metricArbOriginal");
      if (elArbOrig) elArbOrig.textContent = arbOrig;
      const elS3Err = document.getElementById("metricStage3Errors");
      if (elS3Err) {
        elS3Err.textContent = s3Errors;
        const item = document.getElementById("stage3ErrorItem");
        if (item) item.classList.toggle("has-errors", s3Errors > 0);
      }

      const elRate = document.getElementById("aiStageFastPassRate");
      if (elRate) {
        const rate = s1Passed > 0 ? Math.round((fpHits / s1Passed) * 100) : 0;
        elRate.textContent = "快速直通: " + rate + "%";
        if (totalAudited > 0) {
          const overallRate = Math.round((fpHits / totalAudited) * 100);
          elRate.title = "初审放行 " + s1Passed + " 行中 " + fpHits + " 行快速直通 (" + rate + "%)\n审核总量 " + totalAudited + " 行（总直通占比 " + overallRate + "%）";
        }
      }

      // 实时阶段状态指示（动态胶囊与活跃行提示）
      const p1 = stagePipelines?.stage1 || { inFlight: 0, pending: 0, activeRows: [] };
      const p2 = stagePipelines?.stage2 || { inFlight: 0, pending: 0, activeRows: [] };
      const p3 = stagePipelines?.stage3 || { inFlight: 0, pending: 0, activeRows: [] };

      // Stage 1
      const pill1 = document.getElementById("stage1StatusPill");
      const active1 = document.getElementById("stage1ActiveInfo");
      const activeText1 = document.getElementById("stage1ActiveRowsText");
      if (pill1) {
        if (aiRunning) {
          if (p1.inFlight > 0) {
            pill1.dataset.state = "running";
            pill1.textContent = p1.inFlight + "处理中" + (p1.pending > 0 ? " · " + p1.pending + "待审" : "");
          } else if (p1.pending > 0) {
            pill1.dataset.state = "queued";
            pill1.textContent = p1.pending + "排队";
          } else {
            pill1.dataset.state = "idle";
            pill1.textContent = "初审完毕";
          }
        } else {
          pill1.dataset.state = (s1Passed > 0 || s1Errors > 0) ? "done" : "idle";
          pill1.textContent = (s1Passed > 0 || s1Errors > 0) ? "就绪" : "待命";
        }
      }
      if (active1 && activeText1) {
        if (aiRunning && p1.activeRows && p1.activeRows.length > 0) {
          active1.hidden = false;
          const concText = p1.concurrency ? "（并发 " + p1.concurrency + (p1.smartConcurrency && p1.concurrencyMax ? "/" + p1.concurrencyMax : "") + "）" : "";
          activeText1.textContent = p1.activeRows.slice(0, 3).join(", ") + (p1.activeRows.length > 3 ? "..." : "") + (concText ? " · " + concText : "");
        } else {
          active1.hidden = true;
          activeText1.textContent = "";
        }
      }

      // Stage 2
      const s2Enabled = Boolean(aiIds.stage2Preset?.value || s2Reviewed > 0 || s2Errors > 0 || p2.inFlight > 0 || p2.pending > 0 || stage2WaitingForStage1);
      const pill2 = document.getElementById("stage2StatusPill");
      const active2 = document.getElementById("stage2ActiveInfo");
      const activeText2 = document.getElementById("stage2ActiveRowsText");
      if (pill2) {
        if (!s2Enabled) {
          pill2.dataset.state = "disabled";
          pill2.textContent = "未启用";
        } else if (stage2WaitingForStage1) {
          pill2.dataset.state = "queued";
          pill2.textContent = "等待阶段一";
        } else if (aiRunning) {
          if (p2.inFlight > 0) {
            pill2.dataset.state = "running";
            pill2.textContent = p2.inFlight + "处理中" + (p2.pending > 0 ? " · " + p2.pending + "排队" : "");
          } else if (p2.pending > 0) {
            pill2.dataset.state = "queued";
            pill2.textContent = p2.pending + "排队";
          } else {
            pill2.dataset.state = "idle";
            pill2.textContent = "待命";
          }
        } else {
          pill2.dataset.state = (s2Reviewed > 0 || s2Errors > 0) ? "done" : "idle";
          pill2.textContent = (s2Reviewed > 0 || s2Errors > 0) ? "就绪" : "待命";
        }
      }
      if (active2 && activeText2) {
        if (aiRunning && p2.activeRows && p2.activeRows.length > 0) {
          active2.hidden = false;
          const concText = p2.concurrency ? "（并发 " + p2.concurrency + (p2.smartConcurrency && p2.concurrencyMax ? "/" + p2.concurrencyMax : "") + "）" : "";
          activeText2.textContent = p2.activeRows.slice(0, 3).join(", ") + (p2.activeRows.length > 3 ? "..." : "") + (concText ? " · " + concText : "");
        } else {
          active2.hidden = true;
          activeText2.textContent = "";
        }
      }

      // Stage 3
      const s3Enabled = Boolean((aiIds.stage3Preset?.value && s2Enabled) || s3Arbitrated > 0 || s3Errors > 0 || p3.inFlight > 0 || p3.pending > 0 || stage3WaitingForStage2);
      const pill3 = document.getElementById("stage3StatusPill");
      const active3 = document.getElementById("stage3ActiveInfo");
      const activeText3 = document.getElementById("stage3ActiveRowsText");
      if (pill3) {
        if (!s3Enabled) {
          pill3.dataset.state = "disabled";
          pill3.textContent = "未启用";
        } else if (stage3WaitingForStage2) {
          pill3.dataset.state = "queued";
          pill3.textContent = "等待阶段二";
        } else if (aiRunning) {
          if (p3.inFlight > 0) {
            pill3.dataset.state = "running";
            pill3.textContent = p3.inFlight + "处理中" + (p3.pending > 0 ? " · " + p3.pending + "排队" : "");
          } else if (p3.pending > 0) {
            pill3.dataset.state = "queued";
            pill3.textContent = p3.pending + "排队";
          } else {
            pill3.dataset.state = "idle";
            pill3.textContent = "待命";
          }
        } else {
          pill3.dataset.state = (s3Arbitrated > 0 || s3Errors > 0) ? "done" : "idle";
          pill3.textContent = (s3Arbitrated > 0 || s3Errors > 0) ? "就绪" : "待命";
        }
      }
      if (active3 && activeText3) {
        if (aiRunning && p3.activeRows && p3.activeRows.length > 0) {
          active3.hidden = false;
          const concText = p3.concurrency ? "（并发 " + p3.concurrency + (p3.smartConcurrency && p3.concurrencyMax ? "/" + p3.concurrencyMax : "") + "）" : "";
          activeText3.textContent = p3.activeRows.slice(0, 3).join(", ") + (p3.activeRows.length > 3 ? "..." : "") + (concText ? " · " + concText : "");
        } else {
          active3.hidden = true;
          activeText3.textContent = "";
        }
      }
    }

    function computeStageMetricsFromNotes(sourceNotes = notes) {
      if (sourceNotes === notes && cachedStageMetrics && notesMetricsVersion === lastComputedMetricsVersion) {
        return cachedStageMetrics;
      }

      let stage1Passed = 0;
      let stage1NeedsEdit = 0;
      let stage1Unclear = 0;
      let stage1Errors = 0;
      let fastPassHits = 0;
      let stage2Reviewed = 0;
      let stage2Diverged = 0;
      let stage2Errors = 0;
      let critiqueAccept = 0;
      let critiqueModify = 0;
      let critiqueReject = 0;
      let critiqueEscalate = 0;
      let stage3Arbitrated = 0;
      let stage3Settled = 0;
      let stage3Errors = 0;
      let arbitrationGatekeeper = 0;
      let arbitrationStylist = 0;
      let arbitrationSynthesis = 0;
      let arbitrationOriginal = 0;
      let finalNeedsEdit = 0;
      let finalUnchanged = 0;
      let finalNeedsCheck = 0;
      let totalAudited = 0;
      let lowScoreHits = 0;
      let webLookupHits = 0;

      for (const item of Object.values(sourceNotes || {})) {
        if (!item) continue;
        const noteText = latestAiNotePart(item.note || "").trim();
        if (!noteText) continue;

        if (isAiFailureNote(noteText)) {
          totalAudited += 1;
          if (noteText.includes("Arbiter") || noteText.includes("终审仲裁")) {
            stage3Errors += 1;
          } else if (noteText.includes("Stylist") || noteText.includes("文学复审")) {
            stage2Errors += 1;
          } else {
            stage1Errors += 1;
          }
          continue;
        }

        const parsed = parseAutomatedNote(noteText);
        if (!parsed) continue;

        totalAudited += 1;

        // 全局最终修改结论
        if (parsed.modify === "是") {
          finalNeedsEdit += 1;
        } else if (parsed.modify === "否") {
          finalUnchanged += 1;
        } else {
          finalNeedsCheck += 1;
        }

        const hasStage2 = Boolean(parsed.stage2 || noteText.includes("Stylist复审"));
        const hasStage3 = Boolean(parsed.stage3 || noteText.includes("Arbiter仲裁"));
        const hasStage1Revision = Boolean(parsed.stage1Revision || (parsed.stage1 && !parsed.stage1.includes("无需修改") && (parsed.stage1.includes("修改") || parsed.stage1.includes("建议"))));

        // 阶段一事实初审指标：
        let isS1Passed = false;
        let isS1NeedsEdit = false;
        let isS1Unclear = false;

        const isGkUnclear = Boolean(parsed.stage1?.includes("存疑") || noteText.includes("存疑转人工") || noteText.includes("初审存疑") || noteText.includes("待定"));
        const isGkEdit = Boolean(hasStage1Revision || (parsed.stage1 && !parsed.stage1.includes("无需修改") && (parsed.stage1.includes("修改") || parsed.stage1.includes("建议"))));

        if (!hasStage2) {
          // 未进入阶段二：按初审结论划分产出
          if (parsed.modify === "否") {
            isS1Passed = true;
            fastPassHits += 1;
          } else if (parsed.modify === "是") {
            isS1NeedsEdit = true;
          } else {
            isS1Unclear = true;
          }
        } else {
          // 已进入后续阶段（文学复审 / 终审仲裁）：依据初审痕迹还原初审性质
          if (isGkUnclear) {
            isS1Unclear = true;
          } else if (isGkEdit) {
            isS1NeedsEdit = true;
          } else {
            isS1Passed = true;
          }
        }

        if (isS1Passed) {
          stage1Passed += 1;
        } else if (isS1NeedsEdit) {
          stage1NeedsEdit += 1;
        } else if (isS1Unclear) {
          stage1Unclear += 1;
        }

        // 阶段二文学复审指标
        if (hasStage2) {
          stage2Reviewed += 1;
          const attitude = String(parsed.stage2?.attitude || "");
          if (attitude.includes("采纳") || attitude === "accept") {
            critiqueAccept += 1;
          } else if (attitude.includes("调整") || attitude === "modify") {
            critiqueModify += 1;
          } else if (attitude.includes("驳回") || attitude === "reject") {
            critiqueReject += 1;
          } else if (attitude.includes("仲裁") || attitude === "escalate") {
            critiqueEscalate += 1;
          }
        }

        // 阶段三终审仲裁指标
        if (hasStage3) {
          stage3Arbitrated += 1;
          stage2Diverged += 1;
          const winner = String(parsed.stage3?.winner || "").toLowerCase();
          if (winner.includes("初审") || winner.includes("gatekeeper") || winner.includes("gk")) {
            arbitrationGatekeeper += 1;
          } else if (winner.includes("复审") || winner.includes("stylist")) {
            arbitrationStylist += 1;
          } else if (winner.includes("结合") || winner.includes("综合") || winner.includes("折中") || winner.includes("synthesis") || winner.includes("combined") || winner.includes("compromise")) {
            arbitrationSynthesis += 1;
          } else if (winner.includes("维持") || winner.includes("原译") || winner.includes("original") || winner.includes("target")) {
            arbitrationOriginal += 1;
          }
        }

        if (noteText.includes("低分归因：")) {
          lowScoreHits += 1;
        }
        if (noteText.includes("线上查证：")) {
          webLookupHits += 1;
        }
      }

      stage3Settled = Math.max(stage3Arbitrated, arbitrationGatekeeper + arbitrationStylist + arbitrationSynthesis + arbitrationOriginal);
      const stage1Total = stage1Passed + stage1NeedsEdit + stage1Unclear;
      // The visible count follows the same note-level predicate as the filter,
      // so incomplete/failed Stylist rows remain actionable instead of being
      // hidden by subtracting aggregate counts from unrelated stages.
      const stage2Pending = Object.values(sourceNotes || {}).filter((item) => {
        if (!item || item.manualDone) return false;
        const noteText = latestAiNotePart(item.note || "").trim();
        if (!noteText || isAiFailureNote(noteText)) return false;
        const parsed = parseAutomatedNote(noteText);
        if (!parsed) return false;
        const hasStage2 = Boolean(parsed.stage2 || noteText.includes("Stylist复审"));
        return isStage2CandidateNote(parsed, noteText) && !hasStage2;
      }).length;
      const stage3Pending = Math.max(0, stage2Diverged - stage3Arbitrated);

      const resultMetrics = {
        stage1Passed,
        stage1NeedsEdit,
        stage1Unclear,
        stage1Total,
        stage1Errors,
        fastPassHits,
        stage2Reviewed,
        stage2Diverged,
        stage2Pending,
        stage2Errors,
        critiqueAccept,
        critiqueModify,
        critiqueReject,
        critiqueEscalate,
        stage3Arbitrated,
        stage3Settled,
        stage3Pending,
        stage3Errors,
        arbitrationGatekeeper,
        arbitrationStylist,
        arbitrationSynthesis,
        arbitrationOriginal,
        finalNeedsEdit,
        finalUnchanged,
        finalNeedsCheck,
        totalAudited,
        lowScoreHits,
        webLookupHits,
      };

      if (sourceNotes === notes) {
        cachedStageMetrics = resultMetrics;
        lastComputedMetricsVersion = notesMetricsVersion;
      }
      return resultMetrics;
    }

    function updateStageMetricsDashboard(overrideMetrics = null, stagePipelines = {}, aiRunning = false) {
      const localMetrics = computeStageMetricsFromNotes(notes);
      let stageMetrics = localMetrics;
      const hasOverride = overrideMetrics && Object.values(overrideMetrics).some((v) => Number(v) > 0);
      const hasLocal = Object.values(localMetrics).some((v) => Number(v) > 0);

      if (hasLocal) {
        // 当前工作台 notes 中存在审核指标：以当前工作台已加载/找回的 notes 为真理源，
        // 增量运行期间（例如只复审待处理行），绝不让单次任务从 0 开始的指标冲掉本地累积数据！
        stageMetrics = localMetrics;
        if (overrideMetrics) {
          if (overrideMetrics.stage1Errors > stageMetrics.stage1Errors) stageMetrics.stage1Errors = overrideMetrics.stage1Errors;
          if (overrideMetrics.stage2Errors > stageMetrics.stage2Errors) stageMetrics.stage2Errors = overrideMetrics.stage2Errors;
          if (overrideMetrics.stage3Errors > stageMetrics.stage3Errors) stageMetrics.stage3Errors = overrideMetrics.stage3Errors;
        }
      } else if (hasOverride) {
        // 本地没有自动化备注（例如在无 notes 的测试夹具中直接模拟状态响应），使用显式提供的指标
        stageMetrics = overrideMetrics;
      } else {
        stageMetrics = localMetrics;
      }

      const stageMetricsSummary = [
        ["finalNeedsEdit", "最终建议修改"],
        ["finalUnchanged", "无需修改"],
        ["stage1Passed", "初审通过"],
        ["stage1NeedsEdit", "初审提改"],
        ["stage1Unclear", "初审存疑"],
        ["stage1Total", "初审总检"],
        ["stage1Errors", "初审异常"],
        ["stage2Reviewed", "文学复审"],
        ["stage2Diverged", "复审分歧"],
        ["stage2Errors", "复审异常"],
        ["stage3Arbitrated", "终审仲裁"],
        ["stage3Settled", "仲裁定案"],
        ["stage3Errors", "仲裁异常"],
        ["fastPassHits", "快速直通"],
        ["lowScoreHits", "低分归因"],
        ["webLookupHits", "线上查证"],
      ].map(([key, label]) => label + " " + Math.max(0, Number(stageMetrics[key]) || 0)).join("，");

      if (aiIds.status) aiIds.status.dataset.stageMetrics = stageMetricsSummary;
      if (aiIds.panelState) aiIds.panelState.title = stageMetricsSummary;

      renderStageMetricsDashboard(stageMetrics, stagePipelines, aiRunning);
      return stageMetrics;
    }

    function renderAiStatus(ai) {
      if (!ai) return;
      const previousRunning = currentAiRunning;
      currentAiRunning = Boolean(ai.running);
      const isRunning = Boolean(ai.running);
      // 刷新页面后本地 runningAiStage 会丢：用服务端回报的起点与级联范围恢复按钮态，
      // 否则级联运行中三个「开始」按钮会退回到可点状态。
      if (isRunning && !runningAiStage && ai.stageMode) {
        runningAiStage = ai.stageMode;
      }
      const reportedCascade = {
        toStylist: Boolean(ai.stageCascade?.toStylist),
        toArbiter: Boolean(ai.stageCascade?.toArbiter),
      };

      if (!isRunning && (previousRunning || runningAiStage)) {
        const finishedStage = runningAiStage;
        const finishedCascade = currentStageCascade;
        runningAiStage = null;
        currentStageCascade = { toStylist: false, toArbiter: false };
        if (finishedCascade.toStylist || finishedCascade.toArbiter) {
          // 级联任务在一次运行里自己跑完下游，不需要任何排队接力。
          stage2WaitingForStage1 = false;
          stage3WaitingForStage2 = false;
          const tail = finishedCascade.toStylist
            ? (finishedCascade.toArbiter ? "初审 → 复审 → 仲裁" : "初审 → 复审")
            : "复审 → 仲裁";
          showToast(ai.stopRequested
            ? `流水线已终止（${tail}）。`
            : `流水线已完成：${tail} 全部收尾。`,
          { tone: ai.stopRequested ? "info" : "success", durationMs: 7000 });
        } else if (finishedStage === "stage1" && stage2WaitingForStage1) {
          stage2WaitingForStage1 = false;
          const hasStage1Suggestions = Object.values(notes).some((item) => {
            const text = String(item?.note || "");
            return !item.manualDone && (text.includes("是否需要修改：是") || text.includes("初审改案") || text.includes("Gatekeeper初审：建议修改"));
          });
          if (hasStage1Suggestions) {
            showToast("阶段一初审已完成，自动接力启动阶段二文学复审...", { tone: "info", durationMs: 4000 });
            setTimeout(() => { promptAndStartAi("stage2"); }, 300);
          } else {
            showToast("阶段一事实初审全部通过，无需要文学复审的行。", { tone: "success", durationMs: 6000 });
            if (stage3WaitingForStage2) {
              stage3WaitingForStage2 = false;
              showToast("无需要终审仲裁的行。", { tone: "info", durationMs: 5000 });
            }
          }
        } else if (finishedStage === "stage2" && stage3WaitingForStage2) {
          stage3WaitingForStage2 = false;
          const hasDisputes = Object.values(notes).some((item) => {
            const s = getStage3RowStatus(item);
            return s.isPending || s.isArbitrated;
          });
          if (hasDisputes) {
            showToast("阶段二复审已完成，自动接力启动阶段三终审仲裁...", { tone: "info", durationMs: 4000 });
            setTimeout(() => { promptAndStartAi("stage3"); }, 300);
          } else {
            showToast("阶段二文学复审已定案，无需要终审仲裁的分歧行。", { tone: "success", durationMs: 6000 });
          }
        }
      } else if (isRunning) {
        // 运行中一律以服务端回报的级联范围为准：刷新页面后本地状态已丢，只有它知道这条流水线覆盖到哪。
        currentStageCascade = reportedCascade;
      }

      const stageMetrics = updateStageMetricsDashboard(ai.stageMetrics, ai.stagePipelines, isRunning);
      const stageMetricsSummary = aiIds.status?.dataset.stageMetrics || "";
      const aiRunId = ai.runId || "";
      if (aiRunId && lastAiRunId && aiRunId !== lastAiRunId) {
        appliedAiResults.clear();
        lastAiResultRevision = 0;
      }
      if (aiRunId) lastAiRunId = aiRunId;
      const sameAiScope = Boolean(
        ai.projectKey &&
        ai.rowsSignature &&
        ai.projectKey === pageMeta.projectKey &&
        ai.rowsSignature === pageMeta.rowsSignature
      );
      if (aiRunId && clearedAiRunIds.has(aiRunId) && !ai.running) {
        renderClearedAiStatus();
        return;
      }
      if (ai.running) {
        aiIds.status.dataset.cacheCleared = "";
      }
      if (ai.providerDefaults) {
        providerDefaults = ai.providerDefaults;
        applyProviderDefaults(providerDefaults[aiIds.provider.value]);
      }
      if (sameAiScope && ai.proofreadPrompt?.system && (!ai.profileId || ai.profileId === aiIds.profile.value)) {
        const previousDefault = defaultProofreadPrompt;
        defaultProofreadPrompt = ai.proofreadPrompt.system;
        if (aiIds.prompt && (!aiIds.prompt.dataset.touched || aiIds.prompt.value === previousDefault)) {
          aiIds.prompt.value = defaultProofreadPrompt;
        }
      }
      if (ai.termTableStatus) setTermTableHint(ai.termTableStatus);
      if (ai.speechHabitStatus) setSpeechHabitHint(ai.speechHabitStatus);
      setAllStageButtonsRunning(Boolean(ai.running), ai.stagePipelines);
      prefilterIds.start.disabled = Boolean(ai.running);
      prefilterIds.stop.disabled = !ai.running;
      const aiTotal = Math.max(0, ai.queued || 0);
      const done = ai.modelProcessed || 0;
      const total = Math.max(1, aiTotal);
      const rowTotal = Math.max(0, ai.total || 0);
      const skippedDone = Math.min(rowTotal || Infinity, Math.max(0, ai.skippedDone || 0));
      const prefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.prefiltered || 0));
      const rulePrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.rulePrefiltered || 0));
      const similarityPrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.similarityPrefiltered || 0));
      const structuredConflicts = Math.min(rowTotal || Infinity, Math.max(0, ai.structuredConflicts || 0));
      const termPrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.termPrefiltered || 0));
      const termInjected = Math.min(rowTotal || Infinity, Math.max(0, ai.termInjected || 0));
      aiIds.progress.style.width = Math.min(100, Math.round((done / total) * 100)) + "%";
      aiIds.progressWrap.hidden = !ai.running && done === 0 && !prefiltered;
      const isPrefilter = ai.kind === "prefilter";
      const queueText = done + "/" + aiTotal;
      const skipText = "人工确认跳过 " + skippedDone;
      const prefilterText = "规则跳过 " + rulePrefiltered + "，结构化冲突 " + structuredConflicts + "，相似度跳过 " + similarityPrefiltered + (termPrefiltered ? "，对照表跳过 " + termPrefiltered : "") + (termInjected ? "，对照表注入术语 " + termInjected : "");
      const pendingText = "待 AI 校对 " + aiTotal;
      prefilterIds.stats.textContent = aiRunId
        ? (ai.running ? "预筛选中：" : (ai.stopRequested ? "预筛选已终止：" : "预筛选完成：")) + prefilterText + "，" + skipText + "，" + pendingText
        : "尚未运行预筛选。";
      const isMultiStage = Boolean(
        (ai.stagePipelines && (
          (ai.stagePipelines.stage2 && (ai.stagePipelines.stage2.inFlight > 0 || ai.stagePipelines.stage2.pending > 0)) ||
          (ai.stagePipelines.stage3 && (ai.stagePipelines.stage3.inFlight > 0 || ai.stagePipelines.stage3.pending > 0))
        )) ||
        (stageMetrics && (stageMetrics.stage2Reviewed > 0 || stageMetrics.stage3Arbitrated > 0)) ||
        aiIds.stage2Preset?.value
      );
      const concurrencyInfo = ai.smartConcurrency && ai.currentConcurrency
        ? "（动态并发 " + ai.currentConcurrency + "/" + (ai.concurrencyMax || 10) + "）"
        : "";

      let pipelineText = "";
      if (isMultiStage && ai.stagePipelines) {
        const p1 = ai.stagePipelines.stage1 || {};
        const p2 = ai.stagePipelines.stage2 || {};
        const p3 = ai.stagePipelines.stage3 || {};
        const s1Part = "S1初审 " + (p1.inFlight > 0 ? p1.inFlight + "处理中" : (p1.pending > 0 ? p1.pending + "排队" : "完毕"));
        const s2Part = "S2复审 " + (p2.inFlight > 0 ? p2.inFlight + "处理中" + (p2.pending > 0 ? "(" + p2.pending + "排队)" : "") : (p2.pending > 0 ? p2.pending + "排队" : "空闲"));
        const s3Part = "S3仲裁 " + (p3.inFlight > 0 ? p3.inFlight + "处理中" : (p3.pending > 0 ? p3.pending + "排队" : "空闲"));
        pipelineText = " ｜ " + s1Part + " ➔ " + s2Part + " ➔ " + s3Part;
      }

      let pipelineDoneText = "";
      if (isMultiStage && stageMetrics) {
        const s1Passed = Math.max(0, Number(stageMetrics.stage1Passed) || 0);
        const s1NeedsEdit = Math.max(0, Number(stageMetrics.stage1NeedsEdit) || 0);
        const fpHits = Math.max(0, Number(stageMetrics.fastPassHits) || 0);
        const s2Reviewed = Math.max(0, Number(stageMetrics.stage2Reviewed) || 0);
        const s2Diverged = Math.max(0, Number(stageMetrics.stage2Diverged) || Number(stageMetrics.stage3Arbitrated) || 0);
        const s3Arbitrated = Math.max(0, Number(stageMetrics.stage3Arbitrated) || 0);
        const s1Part = "初审 " + s1Passed + (fpHits ? "(直通 " + fpHits + ")" : "") + (s1NeedsEdit ? "➔提改 " + s1NeedsEdit : "");
        const s2Part = "复审 " + s2Reviewed + (s2Diverged ? "(分歧 " + s2Diverged + ")" : "");
        const s3Part = "仲裁 " + s3Arbitrated;
        pipelineDoneText = " ｜ " + s1Part + " ➔ " + s2Part + " ➔ " + s3Part;
      }

      const runningStatus = (isPrefilter ? "预筛选中：" : "AI 校对中" + concurrencyInfo + "：实际调用 " + queueText + "，") +
        (isPrefilter ? "" : (isMultiStage ? "" : skipText + "，")) +
        (isMultiStage
          ? "建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0) + pipelineText
          : prefilterText + (isPrefilter ? "，" + pendingText : "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0)));

      const finishedStatus = (isPrefilter ? (ai.stopRequested ? "预筛选已终止：" : "预筛选完成：") : (ai.stopRequested ? "AI 校对已终止：" : "AI 校对完成：") + "实际调用 " + queueText + "，") +
        (isPrefilter ? "" : (isMultiStage ? "" : skipText + "，")) +
        (isMultiStage
          ? "建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0) + pipelineDoneText
          : prefilterText + (isPrefilter ? "，" + pendingText : "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0)));

      if (aiIds.status) {
        aiIds.status.title = "调用进度 " + queueText + "；" + skipText + "；" + prefilterText + (stageMetricsSummary ? "\n阶段指标：" + stageMetricsSummary : "");
      }
      if (ai.running) {
        setRuntimeStatus(runningStatus);
      } else if (ai.finishedAt) {
        setRuntimeStatus(finishedStatus);
      } else if (ai.error) {
        setRuntimeStatus(ai.error);
      }
      if (aiIds.panelState) {
        aiIds.panelState.title = stageMetricsSummary;
        if (ai.running) {
          aiIds.panelState.textContent = isPrefilter
            ? "预筛选中..."
            : ("校对中" + (ai.smartConcurrency && ai.currentConcurrency ? " (" + ai.currentConcurrency + ")" : "") + "...");
          aiIds.panelState.className = "ai-status-badge is-running";
        } else if (ai.finishedAt) {
          aiIds.panelState.textContent = isPrefilter
            ? (ai.stopRequested ? "预筛选已终止" : "预筛选完成")
            : (ai.stopRequested ? "已终止" : "校对完成");
          aiIds.panelState.className = "ai-status-badge";
        } else if (ai.error) {
          aiIds.panelState.textContent = "调用异常";
          aiIds.panelState.className = "ai-status-badge";
        } else {
          aiIds.panelState.textContent = "就绪";
          aiIds.panelState.className = "ai-status-badge";
        }
      }
      if (prefilterIds.panelState && isPrefilter) {
        if (ai.running) {
          prefilterIds.panelState.textContent = "预筛选中...";
        } else if (ai.finishedAt) {
          prefilterIds.panelState.textContent = ai.stopRequested ? "预筛选已终止" : "预筛选完成";
        }
      }
      // 抽屉默认折叠：一轮跑完时固定状态行可能根本没进过视野，所以同一轮结束再补一次浮动提示。
      // 只提示「本页看着它跑起来」的那一轮——打开页面时从服务端认领到的历史轮次不弹。
      if (aiRunId && ai.running) observedRunningRunId = aiRunId;
      const finishedRunId = aiRunId && !ai.running && ai.finishedAt ? aiRunId : "";
      if (finishedRunId && finishedRunId === observedRunningRunId && notifiedFinishedRunId !== finishedRunId) {
        notifiedFinishedRunId = finishedRunId;
        // 失败轮次优先报错因（固定状态行只给统计数字），原因比数字更可行动。
        showToast(ai.error || finishedStatus, {
          tone: ai.error ? "error" : (ai.stopRequested ? "watch" : "success"),
          durationMs: ai.error ? 15000 : 12000,
        });
      }
      const previousActive = Array.from(aiActiveIds).join(",");
      aiActiveIds.clear();
      for (const id of (ai.active || []).map(String)) aiActiveIds.add(id);
      const nextActive = Array.from(aiActiveIds).join(",");
      if (previousActive !== nextActive) updateRenderedAiActive();
      let appliedResult = false;
      let skippedStaleResults = 0;
      const pendingResults = [];
      if (sameAiScope) {
        for (const result of ai.results || []) {
          const key = result.runId + ":" + result.index + ":" + (result.resultRevision || result.status);
          if (appliedAiResults.has(key)) continue;
          appliedAiResults.add(key);
          const currentRow = rowsById.get(String(result.index));
          if (currentRow?.signature && result.signature !== currentRow.signature) {
            skippedStaleResults += 1;
            continue;
          }
          appliedResult = true;
          pendingResults.push(result);
          const isRuleOrSimilarityPrefilter = result.status === "rule-prefilter" || result.status === "similarity-prefilter";
          // 预筛结果集不只是「本次运行」的状态：它是重新打开页面后「哪些行已经筛过」的依据。
          // 服务端会整轮返回上一轮预筛的结果，所以这里以运行号为准登记（不要求本页启动过这一轮）——
          // 否则重开后 resultIds 为空、「确认预筛」永久锁死，用户一点「开始预筛」就会重新筛出同一批行。
          if (isPrefilter && aiRunId && (isRuleOrSimilarityPrefilter || result.status === "term-prefilter")) {
            if (prefilterRunId !== aiRunId) {
              // 首次认领或换了新一轮预筛：旧一轮的结果不再代表「已经筛过什么」，整体替换。
              prefilterResultIds.clear();
              prefilterRunId = aiRunId;
            }
            prefilterResultIds.add(String(result.index));
          }
        }
        for (const result of pendingResults) {
          writeNote(String(result.index), result.note || "", Boolean(result.done), { deferCommit: true }, result.targetKey || "");
        }
        if (pendingResults.length) {
          saveNotes();
          updateDoneCount();
        }
        if (skippedStaleResults) {
          setRuntimeStatus("已跳过 " + skippedStaleResults + " 条与当前工作台行内容不匹配的自动结果。");
        }
      } else if ((ai.results || []).length && !ai.running) {
        setRuntimeStatus("已忽略非当前项目快照的自动结果；当前项目备注保持独立。");
      }
      lastAiResultRevision = Math.max(lastAiResultRevision, Number(ai.resultRevision) || 0);
      if (appliedResult && (prefilterResultFilterActive || query.value.trim() || notesOnly || doneMode !== "all" || aiResultFilter !== "all" || issueSeverityFilter !== "all")) {
        if (ai.running) {
          scheduleThrottledApplyFilters();
        } else {
          applyFilters({ reset: false });
        }
      }
      updatePrefilterConfirmButton(ai);
    }

    async function refreshAiStatus() {
      if (aiStatusRefreshInFlight) return;
      aiStatusRefreshInFlight = true;
      let hasMoreResults = false;
      try {
        const params = new URLSearchParams({ compact: "1", resultLimit: "64" });
        if (aiIds.profile) params.set("profileId", aiIds.profile.value);
        if (lastAiRunId) {
          params.set("runId", lastAiRunId);
          params.set("afterRevision", String(lastAiResultRevision));
        }
        const response = await apiFetch("/api/ai-proofread/status?" + params);
        const data = await response.json();
        if (data.ok) {
          renderAiStatus(data.ai);
          hasMoreResults = Boolean(data.ai?.hasMoreResults);
        }
      } catch {
        if (aiIds.status.dataset.cacheCleared) return;
        setRuntimeStatus("未连接到本地控制台服务，AI 校对需要通过 npm run setup 打开工作台。");
      } finally {
        aiStatusRefreshInFlight = false;
        if (hasMoreResults && !aiCatchupTimer) {
          aiCatchupTimer = window.setTimeout(() => {
            aiCatchupTimer = 0;
            refreshAiStatus();
          }, 16);
        }
      }
    }

    function setModelOptions(models, { selected = aiIds.model.value } = {}) {
      const resolved = resolveModelOptions(models, selected);
      aiModelOptions = resolved.models;
      if (Array.isArray(models)) {
        for (const item of models) {
          if (item && typeof item === "object" && item.id) {
            aiModelMetadataMap.set(item.id, item);
          }
        }
      }
      aiIds.model.replaceChildren(...resolved.options.map((value) => {
        const item = document.createElement("option");
        item.value = value;
        item.textContent = value === "custom" ? "自定义..." : value;
        return item;
      }));
      aiIds.model.value = resolved.selected;
      syncEnhancedSelect(aiIds.model);
      updateInferenceSettingOptions();
    }

    async function testAiModel() {
      if (!aiIds.testModel) return;
      aiIds.testModel.disabled = true;
      const modelVal = String(aiIds.model?.value || "").trim();
      const requestedProvider = aiIds.provider?.value || "";
      const requestedBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl?.value || "");
      const pendingToast = showToast("正在测试模型连通性...", { durationMs: 0 });
      const finishTestHint = (message, options) => {
        dismissToast(pendingToast);
        showToast(message, options);
      };
      try {
        const response = await apiFetch("/api/ai-proofread/test", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: aiIds.provider?.value || "local",
            baseUrl: aiIds.baseUrl?.value || "",
            apiKey: aiIds.apiKey?.value || "",
            model: modelVal,
            reasoningEffort: aiIds.reasoningEffort?.value || "",
          }),
        });
        const data = await response.json();
        const currentBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl?.value || "");
        if (aiIds.provider?.value !== requestedProvider || currentBaseUrl !== requestedBaseUrl) {
          finishTestHint("接口配置已变更，已忽略旧配置的连通性测试结果。", { tone: "watch", durationMs: 8000 });
          return;
        }
        if (data.ok) {
          const detail = data.replyPreview ? ` 回复：「${data.replyPreview.slice(0, 24)}」` : "";
          finishTestHint(`模型连通成功（${data.latencyMs}ms）：${data.model || modelVal} 响应正常。${detail}`, {
            tone: "success",
            durationMs: 8000,
          });
        } else {
          const latencyMsg = data.latencyMs ? `耗时 ${data.latencyMs}ms，` : "";
          finishTestHint(`模型连通失败（${latencyMsg}${data.error || "无法连通"}）`, {
            tone: "error",
            durationMs: 12000,
          });
        }
      } catch (error) {
        finishTestHint("测试连通性请求异常：" + error.message, { tone: "error", durationMs: 12000 });
      } finally {
        if (aiIds.testModel) aiIds.testModel.disabled = false;
      }
    }

    async function refreshAiModels() {
      aiIds.refreshModels.disabled = true;
      const requestedProvider = aiIds.provider.value;
      const requestedBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl.value);
      // 「正在获取」占住一条不自动消失的提示，结果回来时换成结论：整场只留一条回执。
      const pendingToast = showToast("正在获取可用模型...", { durationMs: 0 });
      const finishModelHint = (message, options) => {
        dismissToast(pendingToast);
        showToast(message, options);
      };
      try {
        const response = await apiFetch("/api/ai-proofread/models", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: aiIds.provider.value,
            baseUrl: aiIds.baseUrl.value,
            apiKey: aiIds.apiKey.value,
          }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        const currentBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl.value);
        if (aiIds.provider.value !== requestedProvider || currentBaseUrl !== requestedBaseUrl) {
          finishModelHint("接口地址已变更，已忽略旧地址返回的模型列表。", { tone: "watch", durationMs: 9000 });
          return;
        }
        const models = data.models?.models || data.models || [];
        const defaultModel = providerDefaults[aiIds.provider.value]?.model || "";
        const wasDefault = !aiIds.model.dataset.touched || aiIds.model.value === defaultModel;
        const selectedModel = wasDefault && models[0]?.id ? models[0].id : aiIds.model.value;
        setModelOptions(models, { selected: selectedModel });
        aiIds.model.dataset.touched = "1";
        if (data.models?.warning) {
          finishModelHint("已使用内置模型列表：" + models.length + " 个模型。", { tone: "info", durationMs: 9000 });
        } else {
          finishModelHint(models.length
          ? "已获取 " + models.length + " 个模型，可在模型下拉框中选择。"
          : "没有从接口返回模型列表，可手动输入模型名。", { tone: models.length ? "success" : "watch", durationMs: 9000 });
        }
      } catch (error) {
        finishModelHint("获取模型失败：" + error.message + "。可手动输入模型名。", { tone: "error", durationMs: 12000 });
      } finally {
        aiIds.refreshModels.disabled = false;
        saveAiConfig();
      }
    }

    aiIds.provider.addEventListener("change", async () => {
      aiIds.baseUrl.dataset.touched = "";
      aiIds.model.dataset.touched = "";
      aiModelOptions = [];
      aiIds.status.dataset.runtimeMessage = "";
      if (providerDefaults[aiIds.provider.value]) {
        applyProviderDefaults(providerDefaults[aiIds.provider.value], { force: true });
        saveAiConfig();
        return;
      }
      try {
        const response = await apiFetch("/api/ai-proofread/status");
        const data = await response.json();
        providerDefaults = data.ai?.providerDefaults || providerDefaults;
        applyProviderDefaults(providerDefaults[aiIds.provider.value], { force: true });
      } catch {
        setProviderHint(null);
      }
      saveAiConfig();
    });
    aiIds.baseUrl.addEventListener("input", () => {
      aiIds.baseUrl.dataset.touched = "1";
      aiIds.model.dataset.touched = "";
      setModelOptions([], { selected: "" });
      showToast("地址已修改，可点击刷新获取模型列表。", { tone: "info", durationMs: 6000 });
      saveAiConfig();
    });
    aiIds.baseUrl.addEventListener("change", () => {
      showToast("地址已更新，可点击刷新获取模型列表。", { tone: "info", durationMs: 9000 });
      saveAiConfig();
    });
    aiIds.model.addEventListener("input", () => {
      aiIds.model.dataset.touched = "1";
      updateInferenceSettingOptions();
      saveAiConfig();
    });
    aiIds.model.addEventListener("change", () => {
      aiIds.model.dataset.touched = "1";
      if (aiIds.model.value === "custom") {
        const value = prompt("输入模型名", "") || "";
        if (value.trim()) {
          setModelOptions([...aiModelOptions, value.trim()], { selected: value.trim() });
          aiIds.model.value = value.trim();
        }
      }
      updateInferenceSettingOptions();
      saveAiConfig();
    });
    if (aiIds.presetSelect) {
      aiIds.presetSelect.addEventListener("change", () => {
        const selectedId = aiIds.presetSelect.value;
        if (!selectedId) {
          currentPresetId = "";
          updatePresetActionButtons();
          saveAiConfig();
          showToast("已切换到自定义配置", { tone: "info", durationMs: 3000 });
          return;
        }
        const preset = presetTools.getPreset(localStorage, selectedId);
        if (preset) {
          applyPreset(preset);
          showToast("已应用模型预设「" + preset.name + "」", { tone: "success", durationMs: 4000 });
        }
      });
    }
    if (aiIds.presetSaveAs) {
      aiIds.presetSaveAs.addEventListener("click", () => {
        const defaultName = (aiIds.model.value || aiIds.provider.value || "新模型预设").trim();
        const promptFn = typeof window !== "undefined" && typeof window.prompt === "function"
          ? window.prompt.bind(window)
          : (typeof prompt === "function" ? prompt : null);
        const confirmFn = typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm.bind(window)
          : (typeof confirm === "function" ? confirm : () => true);

        const name = promptFn ? (promptFn("请输入模型预设名称：", defaultName) || "").trim() : defaultName;
        if (!name) return;

        const presets = presetTools.listPresets(localStorage);
        const existing = presets.find((p) => p.name === name);
        if (existing) {
          if (!confirmFn("已存在名为「" + name + "」的预设，是否覆盖更新？")) {
            return;
          }
        }

        const presetData = {
          id: existing ? existing.id : undefined,
          name,
          provider: aiIds.provider.value,
          baseUrl: aiIds.baseUrl.value,
          apiKey: aiIds.apiKey.value,
          model: aiIds.model.value,
          modelOptions: aiModelOptions,
          reasoningEffort: aiIds.reasoningEffort.value,
          gptReasoningEffort: savedGptReasoningEffort,
          nonGptIntensity: savedNonGptIntensity,
          concurrency: aiIds.concurrency.value,
          smartConcurrency: Boolean(aiIds.smartConcurrency?.checked),
          concurrencyMax: aiIds.concurrencyMax?.value || 10,
          breakerThreshold: aiIds.breakerThreshold.value,
          breakerDisabled: aiIds.breakerDisabled.checked,
        };

        const saved = presetTools.savePreset(localStorage, presetData);
        if (saved) {
          currentPresetId = saved.id;
          renderPresetOptions(saved.id);
          saveAiConfig();
          showToast("已保存模型预设「" + saved.name + "」", { tone: "success", durationMs: 5000 });
        } else {
          showToast("保存模型预设失败", { tone: "error", durationMs: 5000 });
        }
      });
    }
    if (aiIds.presetSave) {
      aiIds.presetSave.addEventListener("click", () => {
        if (!currentPresetId) return;
        const current = presetTools.getPreset(localStorage, currentPresetId);
        if (!current) return;

        const confirmFn = typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm.bind(window)
          : (typeof confirm === "function" ? confirm : () => true);

        if (!confirmFn("确定要将当前修改保存到预设「" + current.name + "」吗？")) {
          return;
        }

        const presetData = {
          id: current.id,
          name: current.name,
          provider: aiIds.provider.value,
          baseUrl: aiIds.baseUrl.value,
          apiKey: aiIds.apiKey.value,
          model: aiIds.model.value,
          modelOptions: aiModelOptions.length ? aiModelOptions : current.modelOptions,
          reasoningEffort: aiIds.reasoningEffort.value,
          gptReasoningEffort: savedGptReasoningEffort,
          nonGptIntensity: savedNonGptIntensity,
          concurrency: aiIds.concurrency.value,
          smartConcurrency: Boolean(aiIds.smartConcurrency?.checked),
          concurrencyMax: aiIds.concurrencyMax?.value || 10,
          breakerThreshold: aiIds.breakerThreshold.value,
          breakerDisabled: aiIds.breakerDisabled.checked,
        };

        const saved = presetTools.savePreset(localStorage, presetData);
        if (saved) {
          // 覆盖保存后必须重渲染下拉：阶段卡片的选项 title 里带着模型名与并发提示，
          // 不重建就会一直显示旧值，与 localStorage 里已生效的新预设不一致。
          renderPresetOptions(saved.id);
          showToast("已更新模型预设「" + saved.name + "」", { tone: "success", durationMs: 5000 });
        } else {
          showToast("更新模型预设失败", { tone: "error", durationMs: 5000 });
        }
      });
    }
    if (aiIds.presetDelete) {
      aiIds.presetDelete.addEventListener("click", () => {
        if (!currentPresetId) return;
        const current = presetTools.getPreset(localStorage, currentPresetId);
        if (!current) return;

        const confirmFn = typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm.bind(window)
          : (typeof confirm === "function" ? confirm : () => true);

        if (!confirmFn("确定要删除模型预设「" + current.name + "」吗？")) {
          return;
        }

        const deleted = presetTools.deletePreset(localStorage, current.id);
        if (deleted) {
          const deletedName = current.name;
          currentPresetId = "";
          renderPresetOptions("");
          saveAiConfig();
          showToast("已删除模型预设「" + deletedName + "」", { tone: "watch", durationMs: 5000 });
        } else {
          showToast("删除模型预设失败", { tone: "error", durationMs: 5000 });
        }
      });
    }
    [aiIds.apiKey, aiIds.target, aiIds.concurrency, aiIds.concurrencyMax, aiIds.proofreadMode, aiIds.reasoningEffort].filter(Boolean).forEach((input) => {
      input.addEventListener("input", saveAiConfig);
      input.addEventListener("change", () => {
        saveAiConfig();
        // 目标列/校对模式决定对照表的哪个变体生效：重取构建期判定并重绘徽标。
        if (input === aiIds.target || input === aiIds.proofreadMode) {
          refreshTermVerdicts();
          setTermTableHint(null);
          renderVisibleRows();
        }
      });
    });
    if (aiIds.stage1Preset) {
      aiIds.stage1Preset.addEventListener("change", () => {
        suppressStageCardFilter(600);
        saveAiConfig();
      });
    }
    if (aiIds.stage2Preset) {
      aiIds.stage2Preset.addEventListener("change", () => {
        suppressStageCardFilter(600);
        updateStagePresetDependencies();
        saveAiConfig();
      });
    }
    if (aiIds.stage3Preset) {
      aiIds.stage3Preset.addEventListener("change", () => {
        suppressStageCardFilter(600);
        saveAiConfig();
      });
    }
    if (aiIds.smartConcurrency) {
      aiIds.smartConcurrency.addEventListener("change", () => {
        updateConcurrencyControls();
        saveAiConfig();
      });
    }
    aiIds.proofreadMode.addEventListener("change", updateProofreadModeHint);
    prefilterIds.similarity.addEventListener("input", saveAiConfig);
    prefilterIds.similarity.addEventListener("change", () => {
      normalizeSimilarityInput();
      saveAiConfig();
    });
    aiIds.breakerThreshold.addEventListener("input", saveAiConfig);
    aiIds.breakerThreshold.addEventListener("change", () => {
      normalizeBreakerInput();
      saveAiConfig();
    });
    aiIds.breakerDisabled.addEventListener("change", () => {
      updateBreakerControls();
      saveAiConfig();
    });
    if (aiIds.prompt) {
      aiIds.prompt.addEventListener("input", () => {
        aiIds.prompt.dataset.touched = "1";
        saveAiPrompt();
      });
    }
    if (aiIds.promptReset) {
      aiIds.promptReset.addEventListener("click", () => {
        defaultProofreadPrompt = defaultPromptForProfile(aiIds.profile.value) || defaultProofreadPrompt;
        if (aiIds.prompt) {
          aiIds.prompt.value = defaultProofreadPrompt;
          aiIds.prompt.dataset.touched = "";
          aiIds.prompt.focus();
        }
        saveAiPrompt();
        showToast("已恢复当前特化规范的默认提示词。", { tone: "success", durationMs: 6000 });
      });
    }

    function bindPromptTabs() {
      const tabs = document.querySelectorAll(".ai-prompt-tab");
      tabs.forEach((tab) => {
        tab.addEventListener("click", () => {
          tabs.forEach((t) => t.classList.remove("is-active"));
          tab.classList.add("is-active");
          const targetTab = tab.dataset.promptTab;
          const panes = {
            stage1: document.getElementById("promptTabStage1"),
            stage2: document.getElementById("promptTabStage2"),
            stage3: document.getElementById("promptTabStage3"),
          };
          Object.entries(panes).forEach(([key, pane]) => {
            if (!pane) return;
            pane.hidden = key !== targetTab;
            pane.classList.toggle("is-active", key === targetTab);
          });
        });
      });
    }
    bindPromptTabs();
    aiIds.profile.addEventListener("change", () => {
      // 换特化规范：只替换没有手改过的提示词，手改过的提示词由服务端按“是否已带该档案”决定补不补。
      const nextDefault = defaultPromptForProfile(aiIds.profile.value);
      if (nextDefault) {
        defaultProofreadPrompt = nextDefault;
        if (aiIds.prompt && (!aiIds.prompt.dataset.touched || aiIds.prompt.value === defaultProofreadPrompt)) {
          aiIds.prompt.value = nextDefault;
        }
      }
      if (aiIds.prompt) {
        aiIds.prompt.dataset.touched = aiIds.prompt.dataset.touched ? "1" : "";
      }
      refreshTermVerdicts();
      setTermTableHint(null);
      setSpeechHabitHint(null);
      refreshAiStatus();
      saveAiPrompt();
      saveAiConfig();
      renderVisibleRows();
      const selected = aiIds.profile.selectedOptions[0];
      showToast("特化规范：" + ((selected && selected.textContent) || aiIds.profile.value), { tone: "info", durationMs: 6000 });
    });
    if (aiIds.testModel) aiIds.testModel.addEventListener("click", testAiModel);
    aiIds.refreshModels.addEventListener("click", refreshAiModels);
    prefilterIds.start.addEventListener("click", async () => {
      prefilterIds.start.disabled = true;
      prefilterIds.confirm.disabled = true;
      prefilterIds.panel.open = true;
      setRuntimeStatus("正在运行预筛选...");
      try {
        const response = await apiFetch("/api/prefilter/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            similarityThreshold: parsePercentRatio(prefilterIds.similarity.value),
            projectKey: pageMeta.projectKey || "",
            rowsSignature: pageMeta.rowsSignature || "",
            completedIndexes: [...new Set(Object.entries(notes)
              .filter(([, item]) => item?.manualDone)
              .map(([id]) => Number(id))
              .filter((id) => Number.isInteger(id) && id > 0))],
            labels: pageLabels,
          }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        prefilterRunId = data.ai?.runId || "";
        prefilterResultIds.clear();
        prefilterResultFilterActive = true;
        prefilterResultsCatchingUp = true;
        prefilterResultFilter.disabled = false;
        prefilterResultFilter.classList.add("is-active");
        prefilterResultFilter.setAttribute("aria-pressed", "true");
        renderAiStatus(data.ai);
        applyFilters();
        refreshAiStatus();
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
        prefilterIds.start.disabled = false;
        updatePrefilterConfirmButton();
      }
    });
    prefilterIds.stop.addEventListener("click", async () => {
      prefilterIds.stop.disabled = true;
      setRuntimeStatus("正在终止预筛选...");
      try {
        const response = await apiFetch("/api/prefilter/stop", { method: "POST" });
        const data = await response.json();
        if (data.ok) {
          renderAiStatus(data.ai);
          refreshAiStatus();
        }
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
      }
    });
    // resize 会成串触发。原来每个 resize 事件都做一次全量同步，等于每帧一次 O(行数)
    // 强制重排（500 行页面 311ms/次），拖窗口边缘时主线程被占满、鼠标跟着变慢。
    // 现在：立刻只更新可用高度（便宜，视觉不跳），逐行高度等尺寸稳定后再整批重量一次。
    let resizeRemeasureTimer = 0;
    window.addEventListener("resize", () => {
      scheduleVisibleRowLayoutSync({ ifFrameMoved: true });
      window.clearTimeout(resizeRemeasureTimer);
      resizeRemeasureTimer = window.setTimeout(() => {
        resizeRemeasureTimer = 0;
        scheduleVisibleRowLayoutSync({ remeasureEditors: true });
      }, 200);
    });
    window.addEventListener("pagehide", flushNotes);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushNotes();
    });
    function hasUnconfirmedAiProofreadNote(item) {
      if (!item || item.manualDone) return false;
      const note = String(item.note || "").trim();
      if (!note) return false;
      if (automatedNoteMarker(note) === "[AI校对]" || isAiFailureNote(note)) return true;
      return note.split(/\n\n+/).some((part) => part.trim().startsWith("[AI校对]"));
    }

    function countUnconfirmedAiProofreadNotes() {
      let count = 0;
      for (const [, item] of Object.entries(notes)) {
        if (hasUnconfirmedAiProofreadNote(item)) count += 1;
      }
      return count;
    }

    function clearUnconfirmedStageNotes(targetStage = "stage1") {
      if (targetStage === "stage1") {
        return clearUnconfirmedAiProofreadNotes();
      }
      let clearedCount = 0;
      for (const [id, item] of Object.entries(notes)) {
        if (!item || item.manualDone) continue;
        const note = String(item.note || "").trim();
        if (!note || !hasAutomatedDecisionNote(note)) continue;
        const p = parseAutomatedNote(note);
        if (!p) continue;

        if (targetStage === "stage2") {
          if (!p.stage2 && !note.includes("Stylist复审")) continue;
          // 清理 Stylist 复审及后续仲裁，保留初审改案
          const lines = note.split("\n").filter((line) => {
            return !line.startsWith("Stylist复审") &&
              !line.startsWith("复审改案：") &&
              !line.startsWith("复审建议：") &&
              !line.startsWith("Arbiter仲裁") &&
              !line.startsWith("仲裁改案：") &&
              !line.startsWith("仲裁建议：");
          });
          const revIdx = lines.findIndex((l) => l.startsWith("修改结果："));
          if (p.stage1Revision) {
            if (revIdx >= 0) {
              lines[revIdx] = `修改结果：${p.stage1Revision}`;
            } else {
              lines.push(`修改结果：${p.stage1Revision}`);
            }
            item.revisionText = p.stage1Revision;
          }
          item.note = lines.join("\n");
          clearedCount += 1;
        } else if (targetStage === "stage3") {
          if (!p.stage3 && !note.includes("Arbiter仲裁")) continue;
          // 清理 Arbiter 仲裁，保留复审方案
          const lines = note.split("\n").filter((line) => {
            return !line.startsWith("Arbiter仲裁") &&
              !line.startsWith("仲裁改案：") &&
              !line.startsWith("仲裁建议：");
          });
          const revIdx = lines.findIndex((l) => l.startsWith("修改结果："));
          const fallbackRev = p.stage2Revision || p.stage1Revision;
          if (fallbackRev) {
            if (revIdx >= 0) {
              lines[revIdx] = `修改结果：${fallbackRev}`;
            } else {
              lines.push(`修改结果：${fallbackRev}`);
            }
            item.revisionText = fallbackRev;
          }
          item.note = lines.join("\n");
          clearedCount += 1;
        }
      }
      if (clearedCount > 0) {
        saveNotes();
        applyFilters({ reset: false });
        updateStageMetricsDashboard();
      }
      return clearedCount;
    }

    function clearUnconfirmedAiProofreadNotes() {
      let clearedCount = 0;
      for (const [id, item] of Object.entries(notes)) {
        if (!item || item.manualDone) continue;
        const note = String(item.note || "").trim();
        if (!note) continue;
        const isFullAiNote = automatedNoteMarker(note) === "[AI校对]" || isAiFailureNote(note);
        if (isFullAiNote) {
          item.note = "";
          item.revisionText = "";
          item.revisionTarget = "";
          item.aiDone = false;
          cleanAiFailureState(item);
          pruneEmptyNote(id);
          clearedCount += 1;
        } else if (note.split(/\n\n+/).some((part) => part.trim().startsWith("[AI校对]"))) {
          const remainingParts = note.split(/\n\n+/).filter((part) => !part.trim().startsWith("[AI校对]"));
          item.note = remainingParts.join("\n\n").trim();
          const remainingAutomated = parseAutomatedNote(item.note);
          if (remainingAutomated?.revision) {
            item.revisionText = remainingAutomated.revision;
          } else {
            item.revisionText = "";
            item.revisionTarget = "";
          }
          item.aiDone = Boolean(hasAutomatedDecisionNote(item.note));
          cleanAiFailureState(item);
          pruneEmptyNote(id);
          clearedCount += 1;
        }
      }
      if (clearedCount > 0) {
        if (lastAiRunId) clearedAiRunIds.add(lastAiRunId);
        appliedAiResults.clear();
        aiActiveIds.clear();
        updateRenderedAiActive();
        saveNotes();
        applyFilters({ reset: false });
        updateDoneCount();
      }
      return clearedCount;
    }

    let latestStagePipelines = null;
    let runningAiStage = null;
    let stage2WaitingForStage1 = false;
    let stage3WaitingForStage2 = false;
    // 当前这条流水线会不会往下游走：由服务端如实回报（起点 + 下游配没配模型），客户端不自己猜。
    // 三个「开始」按钮只表示起点，行为统一是「从起点一路推进到已启用的尽头」。
    let currentStageCascade = { toStylist: false, toArbiter: false };

    // 启动前自己算一份同样的判定，用来把「这次会跑到哪」告诉用户——它不参与调度决策。
    // 预设被删掉时下拉框里可能还残留旧 id，取不到预设就等于那一段没启用。
    function downstreamPlan() {
      const stylistId = aiIds.stage2Preset?.value || "";
      const arbiterId = aiIds.stage3Preset?.value || "";
      const hasStylist = Boolean(stylistId) && Boolean(presetTools.getPreset(localStorage, stylistId));
      const hasArbiter = hasStylist && Boolean(arbiterId) && Boolean(presetTools.getPreset(localStorage, arbiterId));
      return { hasStylist, hasArbiter };
    }

    // 从某个起点出发，这条流水线覆盖到哪一段。
    function cascadeFromStage(stage) {
      const plan = downstreamPlan();
      if (stage === "stage1") return { toStylist: plan.hasStylist, toArbiter: plan.hasStylist && plan.hasArbiter };
      if (stage === "stage2") return { toStylist: false, toArbiter: plan.hasArbiter };
      return { toStylist: false, toArbiter: false };
    }

    function getStageActiveStates(running, stagePipelines = null) {
      const isRunning = running != null ? Boolean(running) : currentAiRunning;
      if (!isRunning) {
        return { stage1: false, stage2: false, stage3: false };
      }
      const pipelines = (stagePipelines && typeof stagePipelines === "object" && Object.keys(stagePipelines).length > 0)
        ? stagePipelines
        : (latestStagePipelines || {});
      const p1 = pipelines.stage1 || {};
      const p2 = pipelines.stage2 || {};
      const p3 = pipelines.stage3 || {};

      const p1HasWork = Boolean((Number(p1.inFlight) || 0) > 0 || (Number(p1.pending) || 0) > 0);
      const p2HasWork = Boolean((Number(p2.inFlight) || 0) > 0 || (Number(p2.pending) || 0) > 0);
      const p3HasWork = Boolean((Number(p3.inFlight) || 0) > 0 || (Number(p3.pending) || 0) > 0);
      const hasPipelineInfo = p1HasWork || p2HasWork || p3HasWork;

      let s1Active = false;
      let s2Active = false;
      let s3Active = false;

      if (runningAiStage === "stage1") {
        s1Active = true;
      } else if (runningAiStage === "stage2") {
        s2Active = true;
      } else if (runningAiStage === "stage3") {
        s3Active = true;
      } else if (hasPipelineInfo) {
        s1Active = p1HasWork;
        s2Active = p2HasWork;
        s3Active = p3HasWork;
      } else {
        s1Active = true;
      }

      return { stage1: s1Active, stage2: s2Active, stage3: s3Active };
    }

    function setAllStageButtonsRunning(running = null, stagePipelines = null) {
      if (stagePipelines && typeof stagePipelines === "object" && Object.keys(stagePipelines).length > 0) {
        latestStagePipelines = stagePipelines;
      }
      const isRunning = running != null ? Boolean(running) : currentAiRunning;
      const active = getStageActiveStates(isRunning, stagePipelines || latestStagePipelines);
      // 级联流水线是一个整体任务：三个「开始」一律禁用（无法中途插入单阶段），
      // 三个「停止」一律可用（任意一个停的都是这条流水线），避免出现停不掉的死角。
      const cascading = isRunning && (currentStageCascade.toStylist || currentStageCascade.toArbiter);

      const s1Start = document.getElementById("stage1Start") || aiIds.start;
      const s1Stop = document.getElementById("stage1Stop") || aiIds.stop;
      const s2Start = document.getElementById("stage2Start");
      const s2Stop = document.getElementById("stage2Stop");
      const s3Start = document.getElementById("stage3Start");
      const s3Stop = document.getElementById("stage3Stop");

      if (s1Start) s1Start.disabled = active.stage1 || cascading;
      if (s1Stop) s1Stop.disabled = !active.stage1 && !cascading;

      if (s2Start) s2Start.disabled = active.stage2 || stage2WaitingForStage1 || cascading;
      if (s2Stop) s2Stop.disabled = !active.stage2 && !stage2WaitingForStage1 && !cascading;

      if (s3Start) s3Start.disabled = active.stage3 || stage3WaitingForStage2 || cascading;
      if (s3Stop) s3Stop.disabled = !active.stage3 && !stage3WaitingForStage2 && !cascading;
    }
    setAllStageButtonsRunning(false);

    let pendingStartStage = "stage1";

    async function promptAndStartAi(stage = "stage1") {
      pendingStartStage = stage;

      if (stage === "stage2") {
        if (!aiIds.stage2Preset?.value) {
          showToast("请先在阶段二选择模型预设以启用文学复审。", { tone: "watch", durationMs: 6000 });
          return;
        }
        // 当前这条流水线本来就会走到复审（从阶段一起步且配了复审），再点阶段二是多余的：
        // 它已经在自动推进，不需要排队等一次。
        const stage2AlreadyCovered = currentAiRunning
          && (runningAiStage === "stage2" || (runningAiStage === "stage1" && currentStageCascade.toStylist));
        if (stage2AlreadyCovered) {
          showToast("阶段二已包含在当前流水线中：初审产出的行会立即自动移交复审，无需单独启动。", { tone: "info", durationMs: 6000 });
          return;
        }
        if (currentAiRunning || runningAiStage === "stage1") {
          stage2WaitingForStage1 = true;
          setAllStageButtonsRunning(currentAiRunning);
          updateStageMetricsDashboard();
          const hasSuggestionsNow = Object.values(notes).some((item) => {
            const text = String(item?.note || "");
            return !item.manualDone && isStage2CandidateNote(parseAutomatedNote(text), text);
          });
          showToast(hasSuggestionsNow
            ? "已排队：当前已有初审建议，等待阶段一全部完成后自动启动文学复审。"
            : "已排队：当前暂无初审修改建议，等待阶段一产出建议后自动启动文学复审。", { tone: "info", durationMs: 5000 });
          return;
        }
        const hasStage1Suggestions = Object.values(notes).some((item) => {
          const text = String(item?.note || "");
          return !item.manualDone && isStage2CandidateNote(parseAutomatedNote(text), text);
        });
        if (!hasStage1Suggestions) {
          showToast("当前没有未人工确认的初审修改建议行，请先运行阶段一事实初审。", { tone: "watch", durationMs: 6000 });
          return;
        }

        let reviewedCount = 0;
        let pendingCount = 0;
        for (const [id, item] of Object.entries(notes)) {
          if (!item || item.manualDone) continue;
          const text = String(item.note || "");
          const p = parseAutomatedNote(text);
          if (!p) continue;
          const hasS2 = Boolean(p.stage2 || text.includes("Stylist复审"));
          if (hasS2) reviewedCount += 1;
          else if (isStage2CandidateNote(p, text)) pendingCount += 1;
        }

        if (reviewedCount > 0) {
          if (aiConfirmIds.dialog && typeof aiConfirmIds.dialog.showModal === "function") {
            if (aiConfirmIds.message) {
              aiConfirmIds.message.innerHTML = `检测到当前已有 <strong>${reviewedCount}</strong> 条文学复审方案${pendingCount > 0 ? `，<strong>${pendingCount}</strong> 条初审建议待复审` : ""}。<br>请选择本次启动方式：`;
            }
            aiConfirmIds.dialog.showModal();
            return;
          }
          if (confirm(`检测到已有 ${reviewedCount} 条文学复审方案${pendingCount > 0 ? `，${pendingCount} 条待复审` : ""}。\n\n点击「确定」：继续复审剩余待处理行（保留已有 ${reviewedCount} 条方案，推荐）\n点击「取消」：全部重新复审（清空已有复审方案重新执行）`)) {
            await startAiProofread({ continueOnly: true, stage: "stage2" });
          } else {
            const cleared = clearUnconfirmedStageNotes("stage2");
            if (cleared > 0) {
              showToast(`已清空 ${cleared} 条未人工确认的文学复审方案。`, { tone: "info", durationMs: 6000 });
            }
            await startAiProofread({ continueOnly: false, stage: "stage2" });
          }
          return;
        }
        await startAiProofread({ continueOnly: true, stage: "stage2" });
        return;
      } else if (stage === "stage3") {
        if (!aiIds.stage3Preset?.value) {
          showToast("请先在阶段三选择模型预设以启用终审仲裁。", { tone: "watch", durationMs: 6000 });
          return;
        }
        // 当前这条流水线本来就会走到仲裁时，再点阶段三同样是多余的。
        const stage3AlreadyCovered = currentAiRunning && (
          runningAiStage === "stage3"
          || ((runningAiStage === "stage1" || runningAiStage === "stage2") && currentStageCascade.toArbiter)
        );
        if (stage3AlreadyCovered) {
          showToast("阶段三已包含在当前流水线中：复审产生分歧的行会立即自动移交仲裁，无需单独启动。", { tone: "info", durationMs: 6000 });
          return;
        }

        let arbitratedCount = 0;
        let pendingArbCount = 0;
        for (const [id, item] of Object.entries(notes)) {
          const s = getStage3RowStatus(item);
          if (s.isArbitrated) arbitratedCount += 1;
          else if (s.isPending) pendingArbCount += 1;
        }

        if (currentAiRunning || stage2WaitingForStage1 || runningAiStage === "stage1" || runningAiStage === "stage2") {
          stage3WaitingForStage2 = true;
          setAllStageButtonsRunning(currentAiRunning);
          updateStageMetricsDashboard();
          const hasDisputesNow = (arbitratedCount > 0 || pendingArbCount > 0);
          showToast(hasDisputesNow
            ? "已排队：当前已有分歧行，等待前序阶段全部完成后自动启动终审仲裁。"
            : "已排队：当前暂无分歧行，等待阶段二复审产生分歧后自动启动终审仲裁。", { tone: "info", durationMs: 5000 });
          return;
        }

        if (arbitratedCount === 0 && pendingArbCount === 0) {
          showToast("当前没有需要终审仲裁的分歧行。", { tone: "info", durationMs: 5000 });
          return;
        }

        if (arbitratedCount > 0) {
          if (aiConfirmIds.dialog && typeof aiConfirmIds.dialog.showModal === "function") {
            if (aiConfirmIds.message) {
              const statusDesc = pendingArbCount > 0
                ? `<strong>${arbitratedCount}</strong> 条终审仲裁方案${pendingArbCount > 0 ? `，<strong>${pendingArbCount}</strong> 条分歧行待仲裁` : ""}`
                : `<strong>${arbitratedCount}</strong> 条终审仲裁方案（已全部完成仲裁）`;
              aiConfirmIds.message.innerHTML = `检测到当前已有 ${statusDesc}。<br>请选择本次启动方式：`;
            }
            aiConfirmIds.dialog.showModal();
            return;
          }
          const promptDesc = pendingArbCount > 0
            ? `检测到已有 ${arbitratedCount} 条终审仲裁方案，${pendingArbCount} 条待仲裁。\n\n点击「确定」：继续仲裁剩余待处理分歧行（保留已有 ${arbitratedCount} 条方案，推荐）\n点击「取消」：全部重新仲裁（清空已有仲裁重新执行）`
            : `检测到所有 ${arbitratedCount} 条分歧行均已完成终审仲裁。\n\n点击「确定」：保留已有仲裁方案\n点击「取消」：全部重新仲裁（清空未人工确认的仲裁重新执行）`;
          if (confirm(promptDesc)) {
            if (pendingArbCount === 0) {
              showToast("所有分歧行均已完成终审仲裁；如需重跑请点击「全部重新仲裁」。", { tone: "info", durationMs: 5000 });
              return;
            }
            await startAiProofread({ continueOnly: true, stage: "stage3" });
          } else {
            const cleared = clearUnconfirmedStageNotes("stage3");
            if (cleared > 0) {
              showToast(`已清空 ${cleared} 条未人工确认的终审仲裁方案。`, { tone: "info", durationMs: 6000 });
            }
            await startAiProofread({ continueOnly: false, stage: "stage3" });
          }
          return;
        }
        await startAiProofread({ continueOnly: true, stage: "stage3" });
        return;
      }

      if (stage === "stage1") {
        // 按钮只表示起点；这条流水线往下走到哪，由阶段二/三配没配预设决定。
        // 走到下游在同一个任务里完成，客户端不再排队等阶段一收尾。
        const plan = cascadeFromStage("stage1");
        const tailText = plan.toStylist
          ? (plan.toArbiter ? "初审 → 复审 → 仲裁" : "初审 → 复审")
          : "";
        const cascadeNote = tailText ? `\n\n本次会一路推进：${tailText}。` : "";
        const unconfirmedCount = countUnconfirmedAiProofreadNotes();
        if (unconfirmedCount > 0) {
          if (aiConfirmIds.dialog && typeof aiConfirmIds.dialog.showModal === "function") {
            if (aiConfirmIds.message) {
              aiConfirmIds.message.innerHTML = `检测到当前有 <strong>${unconfirmedCount}</strong> 条未人工确认的 AI 校对信息。`
                + (tailText ? `<br>本次会一路推进：<strong>${tailText}</strong>。` : "")
                + "<br>请选择本次启动方式：";
            }
            aiConfirmIds.dialog.showModal();
            return;
          }
          // 「继续剩下的」在级联时会续跑：已有初审结论、只差复审的行直接进复审队列，不重跑初审。
          const resumeHint = plan.toStylist
            ? "\n点击「取消」：继续剩下的（保留已有方案；已有初审结论、只差复审的行直接进复审，其余行继续校对）"
            : "\n点击「取消」：继续剩下的（保留已有方案，仅校对未处理的空白行）";
          if (confirm(`检测到之前有 ${unconfirmedCount} 条未人工确认的 AI 校对信息。\n\n点击「确定」：从未人工确认处开始（清空未确认的 AI 方案并重新校对）${resumeHint}${cascadeNote}`)) {
            const cleared = clearUnconfirmedAiProofreadNotes();
            if (cleared > 0) {
              showToast(`已清空 ${cleared} 条未人工确认的 AI 校对信息。`, { tone: "info", durationMs: 6000 });
            }
            await startAiProofread({ continueOnly: false, stage: "stage1" });
          } else {
            await startAiProofread({ continueOnly: true, stage: "stage1" });
          }
          return;
        }
        await startAiProofread({ continueOnly: false, stage: "stage1" });
      } else {
        await startAiProofread({ continueOnly: false, stage });
      }
    }

    async function startAiProofread({ continueOnly = false, stage = "stage1" } = {}) {
      runningAiStage = stage;
      setAllStageButtonsRunning(true);
      if (aiIds.status) aiIds.status.dataset.cacheCleared = "";
      if (aiIds.panel) aiIds.panel.open = true;
      const stageNames = { stage1: "阶段一 事实初审", stage2: "阶段二 文学复审", stage3: "阶段三 终审仲裁" };
      setRuntimeStatus("正在启动 " + (stageNames[stage] || "AI 校对") + "...");

      const baseConfig = aiConfig();
      baseConfig.stage = stage;
      baseConfig.continueOnly = Boolean(continueOnly);

      const rowNotes = {};
      for (const [id, item] of Object.entries(notes)) {
        if (item && item.note) rowNotes[id] = item.note;
      }
      baseConfig.rowNotes = rowNotes;

      if (continueOnly) {
        // 跳过口径取决于本次是「从起点一路推进到尽头」还是「只跑这一段」：
        // 级联时整行必须走完从起点往下的所有阶段才算处理过，单阶段时只看本阶段有没有结论。
        const cascadeToStylist = stage === "stage1"
          && Boolean(baseConfig.stylistConfig || baseConfig.singleModelPersona);
        const cascadeToArbiter = (cascadeToStylist || stage === "stage2")
          && Boolean(baseConfig.arbiterConfig || baseConfig.singleModelPersona)
          && baseConfig.arbiterEnabled !== false;
        const completedSet = new Set(baseConfig.completedIndexes || []);
        for (const [id, item] of Object.entries(notes)) {
          if (!item) continue;
          const num = Number(id);
          if (!Number.isInteger(num) || num <= 0) continue;
          if (item.manualDone) {
            completedSet.add(num);
            continue;
          }
          const noteText = String(item.note || "").trim();
          const p = parseAutomatedNote(noteText);
          if (cascadeToStylist || cascadeToArbiter) {
            // 整行口径：已终审、复审已定案、初审明确通过且非复审候选，都算走完。
            // 「提交仲裁/升级仲裁」是复审的中途态不是结论——有分歧却还没仲裁的行必须留在流水线里，
            // 初审提改却还没复审的行同理，都不能被当成已完成跳过。
            const hasPendingArbitration = /提交仲裁|升级仲裁/.test(String(p?.stage2?.attitude || ""))
              || /Stylist复审\[(?:提交仲裁|升级仲裁)\]/.test(noteText);
            const stage3Done = Boolean(p?.stage3 || noteText.includes("Arbiter仲裁"));
            const stage2Settled = !hasPendingArbitration
              && (hasCompletedStage2Note(p, noteText) || !isStage2CandidateNote(p, noteText));
            const stage1Clear = p?.modify === "否" && !isStage2CandidateNote(p, noteText);
            const settled = cascadeToArbiter
              ? (stage3Done || stage2Settled || stage1Clear)
              : (stage2Settled || stage1Clear);
            if (settled) completedSet.add(num);
          } else if (stage === "stage1") {
            if (item.aiDone || hasAutomatedDecisionNote(noteText)) completedSet.add(num);
          } else if (stage === "stage2") {
            const hasS2 = hasCompletedStage2Note(p, noteText);
            if (hasS2 || !isStage2CandidateNote(p, noteText)) {
              completedSet.add(num);
            }
          } else if (stage === "stage3") {
            const hasS3 = Boolean(p?.stage3 || noteText.includes("Arbiter仲裁"));
            if (hasS3) {
              completedSet.add(num);
            }
          }
        }
        baseConfig.completedIndexes = [...completedSet];
      }

      try {
        const response = await apiFetch("/api/ai-proofread/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(baseConfig),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        renderAiStatus(data.ai);
        refreshAiStatus();
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
        runningAiStage = null;
        setAllStageButtonsRunning(false);
      }
    }

    function hasCompletedStage2Note(parsed, noteText = "") {
      if (!parsed?.stage2 && !String(noteText).includes("Stylist复审")) return false;
      if (isAiFailureNote(noteText)) return false;
      const text = String(noteText);
      // A review marker without a conclusion is an interrupted/incomplete run.
      return Boolean(parsed?.stage2 && (parsed.stage2Revision || parsed.revision || parsed.stage3)) ||
        /Stylist复审\[(?:采纳|调整|驳回|提交仲裁|升级仲裁|保留原译|复审方案)\]/.test(text);
    }

    function isStage2CandidateNote(parsed, noteText = "") {
      const text = String(noteText || "");
      if (!parsed) return false;
      const hasEdit = parsed.modify === "是" || Boolean(
        parsed.stage1Revision ||
        (parsed.stage1 && !parsed.stage1.includes("无需修改") && (parsed.stage1.includes("修改") || parsed.stage1.includes("建议")))
      );
      const isUnclear = parsed.stage1?.includes("存疑") ||
        parsed.modify === "待人工确认" ||
        parsed.modify === "人工确认" ||
        text.includes("存疑转人工") ||
        text.includes("初审存疑");
      return hasEdit || isUnclear;
    }

    async function stopAiProofread(targetBtnStage = "") {
      if (targetBtnStage === "stage2" && stage2WaitingForStage1) {
        stage2WaitingForStage1 = false;
        setAllStageButtonsRunning(currentAiRunning);
        updateStageMetricsDashboard();
        showToast("已取消阶段二文学复审的排队等待。", { tone: "info", durationMs: 4000 });
        return;
      }
      if (targetBtnStage === "stage3" && stage3WaitingForStage2) {
        stage3WaitingForStage2 = false;
        setAllStageButtonsRunning(currentAiRunning);
        updateStageMetricsDashboard();
        showToast("已取消阶段三终审仲裁的排队等待。", { tone: "info", durationMs: 4000 });
        return;
      }

      stage2WaitingForStage1 = false;
      stage3WaitingForStage2 = false;
      const stopButtons = [
        document.getElementById("stage1Stop"),
        document.getElementById("stage2Stop"),
        document.getElementById("stage3Stop"),
        aiIds.stop,
      ].filter(Boolean);
      stopButtons.forEach((btn) => { btn.disabled = true; });
      setRuntimeStatus("正在终止 AI 校对...");
      try {
        const response = await apiFetch("/api/ai-proofread/stop", { method: "POST" });
        const data = await response.json();
        if (data.ok) {
          renderAiStatus(data.ai);
          refreshAiStatus();
        }
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
      }
    }

    if (aiConfirmIds.dialog) {
      if (aiConfirmIds.clear) {
        aiConfirmIds.clear.addEventListener("click", async () => {
          aiConfirmIds.dialog.close();
          const cleared = clearUnconfirmedStageNotes(pendingStartStage);
          if (cleared > 0) {
            const msg = pendingStartStage === "stage1"
              ? `已清空 ${cleared} 条未人工确认的 AI 校对信息。`
              : (pendingStartStage === "stage3"
                ? `已清空 ${cleared} 条未人工确认的终审仲裁方案。`
                : (pendingStartStage === "stage2"
                  ? `已清空 ${cleared} 条未人工确认的文学复审方案。`
                  : `已清空 ${cleared} 条未人工确认的方案。`));
            showToast(msg, { tone: "info", durationMs: 6000 });
          }
          // 清空的是哪个阶段的记录，和本次从哪里起步是两件事：这里只传起点，
          // 往下走到哪一段由服务端按「下游配没配模型」决定，弹窗不会改变它。
          await startAiProofread({ continueOnly: false, stage: pendingStartStage });
        });
      }
      if (aiConfirmIds.keep) {
        aiConfirmIds.keep.addEventListener("click", async () => {
          aiConfirmIds.dialog.close();
          if (pendingStartStage === "stage3") {
            let pendingArb = 0;
            for (const [, item] of Object.entries(notes)) {
              if (getStage3RowStatus(item).isPending) pendingArb += 1;
            }
            if (pendingArb === 0) {
              showToast("所有分歧行均已完成终审仲裁；如需重跑请选择「从未人工确认处开始」。", { tone: "info", durationMs: 5000 });
              return;
            }
          }
          const plan = cascadeFromStage(pendingStartStage);
          const tailText = plan.toStylist
            ? (plan.toArbiter ? "初审 → 复审 → 仲裁" : "初审 → 复审")
            : (plan.toArbiter ? "复审 → 仲裁" : "");
          const resumeText = plan.toStylist
            ? "已有初审结论、只差复审的行直接进复审，其余行继续校对。"
            : "仅校对剩余未处理行。";
          showToast(`保留已有方案；${resumeText}${tailText ? `本次会一路推进：${tailText}。` : ""}`, { tone: "info", durationMs: 4000 });
          await startAiProofread({ continueOnly: true, stage: pendingStartStage });
        });
      }
      if (aiConfirmIds.cancel) {
        aiConfirmIds.cancel.addEventListener("click", () => {
          aiConfirmIds.dialog.close();
        });
      }
    }

    const boundStartButtons = new Set();
    const stage1StartEl = document.getElementById("stage1Start") || aiIds.start;
    if (stage1StartEl) {
      stage1StartEl.addEventListener("click", async () => { await promptAndStartAi("stage1"); });
      boundStartButtons.add(stage1StartEl);
    }
    const stage2StartEl = document.getElementById("stage2Start");
    if (stage2StartEl && !boundStartButtons.has(stage2StartEl)) {
      stage2StartEl.addEventListener("click", async () => { await promptAndStartAi("stage2"); });
      boundStartButtons.add(stage2StartEl);
    }
    const stage3StartEl = document.getElementById("stage3Start");
    if (stage3StartEl && !boundStartButtons.has(stage3StartEl)) {
      stage3StartEl.addEventListener("click", async () => { await promptAndStartAi("stage3"); });
      boundStartButtons.add(stage3StartEl);
    }
    if (aiIds.start && !boundStartButtons.has(aiIds.start)) {
      aiIds.start.addEventListener("click", async () => { await promptAndStartAi("stage1"); });
    }

    const stage1StopEl = document.getElementById("stage1Stop");
    if (stage1StopEl) stage1StopEl.addEventListener("click", () => stopAiProofread("stage1"));
    const stage2StopEl = document.getElementById("stage2Stop");
    if (stage2StopEl) stage2StopEl.addEventListener("click", () => stopAiProofread("stage2"));
    const stage3StopEl = document.getElementById("stage3Stop");
    if (stage3StopEl) stage3StopEl.addEventListener("click", () => stopAiProofread("stage3"));
    if (aiIds.stop && aiIds.stop !== stage1StopEl) {
      aiIds.stop.addEventListener("click", () => stopAiProofread(""));
    }

    if (aiIds.clearCache) {
      aiIds.clearCache.addEventListener("click", async () => {
        if (aiIds.stop && aiIds.stop.disabled === false) {
          showToast("AI 校对仍在运行，请先停止任务再清除 AI 记录。", { tone: "watch", durationMs: 8000 });
          return;
        }
        if (!confirm("清除 AI 运行记录？备注与人工确认不会被清除。")) return;
        aiIds.clearCache.disabled = true;
        setRuntimeStatus("正在清除 AI 记录...");
        if (lastAiRunId) clearedAiRunIds.add(lastAiRunId);
        clearLocalAiCache();
        renderClearedAiStatus();
        try {
          const response = await apiFetch("/api/ai-proofread/cache/clear", { method: "POST" });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || "清除失败。");
          if (data.ai?.runId) clearedAiRunIds.add(data.ai.runId);
          renderClearedAiStatus();
          showToast("已清除 AI 运行记录；备注与人工确认已保留。", { tone: "success", durationMs: 9000 });
        } catch (error) {
          if (error instanceof TypeError || /Unknown local API endpoint|清除失败/.test(error.message || "")) {
            const fallback = "已清除本页 AI 运行记录；备注与人工确认已保留。本地服务重启后可同步清除后台记录。";
            renderClearedAiStatus(fallback);
            showToast(fallback, { tone: "watch", durationMs: 12000 });
          } else {
            showToast(error.message, { tone: "error", durationMs: 12000 });
          }
        } finally {
          aiIds.clearCache.disabled = false;
        }
      });
    }
    tbody.addEventListener("click", (event) => {
      const button = event.target.closest("[data-verify]");
      if (!button) return;
      event.preventDefault();
      event.stopPropagation();
      const id = button.dataset.verify;
      const current = notes[id];
      if (!current) return;
      delete current.recoveredUnverified;
      // 「核验内容」只解除该行的写回隔离；人工确认必须由用户单独勾选，或在写回成功后自动完成。
      // 这里不能顺带设为已确认，否则“未人工确认”筛选会立刻把行移走，用户无法接着写回。
      current.manualDone = false;
      current.done = false;
      saveNotes({ immediate: true });
      updateDoneCount();
      applyFilters({ reset: false });
      showToast("已核验第 " + id + " 行的找回记录，现在可以写回；尚未标记人工确认。", { tone: "success", durationMs: 8000 });
    });

    const notesPanelIds = {
      panel: document.getElementById("notesPanel"),
      current: document.getElementById("notesCurrentSpace"),
      summary: document.getElementById("notesSpaceSummary"),
      list: document.getElementById("notesSpaceList"),
      exportAll: document.getElementById("exportAllNotes"),
      clearCurrent: document.getElementById("clearCurrentNotes"),
      clearHistory: document.getElementById("clearHistoryNotes"),
      file: document.getElementById("importNotesFile"),
      refresh: document.getElementById("refreshNotesSpaces"),
      status: document.getElementById("notesPanelStatus"),
      dialog: document.getElementById("notesRecoveryDialog"),
      preview: document.getElementById("notesRecoveryPreview"),
      apply: document.getElementById("applyNotesRecovery"),
    };
    let notesSpaceInventory = [];
    let pendingNotesRecovery = null;

    // 备注面板的按钮既要就地回执（固定状态行就在按钮旁边，与空间列表一起读），也要跨面板可见：
    // 面板可能收起、也可能滚出视野，所以同一句话再弹一条浮动提示。
    function notesPanelStatus(message, { tone = "info" } = {}) {
      notesPanelIds.status.textContent = message;
      showToast(message, { tone, durationMs: 12000 });
    }

    function collectNotesSpaces() {
      serializeNotes(); // Export also includes fresh signatures before a deferred save.
      return notesTools.inventory(localStorage, storageKey, notes);
    }

    function notesBackup(spaces) {
      const exported = spaces.slice();
      // 当前损坏/冲突的磁盘版本也随备份保留，不能用空的内存记录替代它。
      if (notesStorageBlocked && spaces.some((space) => space.current)) {
        const raw = localStorage.getItem(storageKey);
        if (raw !== null) {
          let key = storageKey + ":import-" + Date.now();
          while (exported.some((space) => space.key === key)) key += "-1";
          exported.push({ key, raw });
        }
      }
      return notesTools.backup(exported);
    }

    function notesSpaceTitle(space) {
      if (space.current) return "本页记录";
      if (space.key.includes("legacy-file")) return "旧版文件备份";
      const legacy = space.project.includes("|");
      const file = legacy ? space.project.split("|")[0].replace(/\\/g, "/").split("/").pop() : "";
      return file || (space.sameProject ? "本项目的历史记录" : space.sameSnapshot ? "同一行集的历史记录" : "历史记录 · " + (space.project || "文件备份"));
    }

    function downloadNotesJson(filename, payload) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    function notesSpaceMarkup(space, index) {
      const stats = space.entries + " 条记录 · 人工确认 " + space.confirmed
        + (space.unverified ? " · 待核验 " + space.unverified : "")
        + " · 约 " + (space.bytes / 1024).toFixed(1) + " KB";
      const canRecover = !space.current && space.entries && !space.parseFailed;
      return [
        '<article class="notes-space-row' + (space.current ? " is-current" : "") + '">',
        '<div class="notes-space-main"><div class="notes-space-heading"><strong>' + escapeHtml(notesSpaceTitle(space)) + '</strong>',
        space.current ? '<span class="notes-space-tag">正在使用</span>' : '',
        space.parseFailed ? '<span class="notes-space-tag is-warn">无法解析</span>' : '',
        !space.current && space.sameSnapshot ? '<span class="notes-space-tag">同一行集</span>' : '',
        '</div><div class="notes-space-meta">' + stats + '</div>',
        '<details class="notes-space-details"><summary>空间详情' + (space.version ? " · " + escapeHtml(space.version) : "") + '</summary>',
        '<code>' + escapeHtml(space.key) + '</code>',
        '<p>' + (space.minIndex == null ? "没有有效行记录。" : "行号范围 " + space.minIndex + "–" + space.maxIndex) + '</p>',
        canRecover ? '<button type="button" class="btn btn--ghost" data-notes-index="' + index + '">按行号找回（需核验）</button>' : '',
        space.current ? '' : '<button type="button" class="btn btn--ghost notes-delete" data-notes-drop="' + index + '">删除此空间</button>',
        '</details></div><div class="notes-space-actions">',
        canRecover ? '<button type="button" class="btn btn--primary" data-notes-restore="' + index + '">预览找回</button>' : '',
        '<button type="button" class="btn btn--ghost" data-notes-export="' + index + '">' + (space.current ? "导出本页" : "导出") + '</button>',
        '</div></article>',
      ].join('');
    }

    function renderNotesSpaces() {
      notesSpaceInventory = collectNotesSpaces();
      const current = notesSpaceInventory.find((space) => space.current);
      const history = notesSpaceInventory.filter((space) => !space.current);
      const totalKb = (notesSpaceInventory.reduce((total, space) => total + space.bytes, 0) / 1024).toFixed(1);
      notesPanelIds.current.innerHTML = notesSpaceMarkup(current, notesSpaceInventory.indexOf(current));
      notesPanelIds.summary.textContent = history.length + " 个历史空间 · 本地备注约 " + totalKb + " KB";
      notesPanelIds.list.innerHTML = history.length
        ? history.map((space) => notesSpaceMarkup(space, notesSpaceInventory.indexOf(space))).join('')
        : '<div class="notes-space-empty">暂无历史记录。可导入之前导出的 JSON 备份。</div>';
      updateNotesSaveState();
    }

    function freshNotesSpace(key) {
      return collectNotesSpaces().find((space) => space.key === key);
    }

    function previewNotesRecovery(space, byIndex = false) {
      const plan = recoveryPlan(space, byIndex);
      pendingNotesRecovery = { key: space.key, raw: space.raw, byIndex, plan };
      const action = byIndex ? "按行号找回" : "按内容找回";
      notesPanelIds.apply.disabled = !plan.pairs.length || notesStorageBlocked;
      notesPanelIds.apply.textContent = "找回 " + plan.pairs.length + " 条";
      const samples = plan.pairs.slice(0, 5).map((pair) => {
        const item = space.data[String(pair.from)];
        const row = rowsById.get(String(pair.to));
        return '<li><strong>原第 ' + pair.from + ' 行 → 本页第 ' + pair.to + ' 行</strong>'
          + '<span>' + (pair.verified ? '内容已匹配' : '需逐行核验') + '</span>'
          + '<p>旧记录：' + escapeHtml((item.note || revisionTextFor(item) || '人工确认记录').slice(0, 180)) + '</p>'
          + '<p>本页文本：' + escapeHtml(String(row?.cn || row?.jp || '').slice(0, 180)) + '</p></li>';
      }).join('');
      notesPanelIds.preview.innerHTML = '<p class="notes-preview-source">' + escapeHtml(notesSpaceTitle(space)) + ' · ' + action + '</p>'
        + '<div class="notes-preview-stats"><span><strong>' + plan.verified + '</strong>内容匹配</span><span><strong>' + plan.unverified
        + '</strong>需核验</span><span><strong>' + plan.occupied + '</strong>本页已有</span><span><strong>' + plan.unmatched + '</strong>未匹配</span>'
        + (plan.merged ? '<span><strong>' + plan.merged + '</strong>已合并</span>' : '')
        + (plan.approvedRestored ? '<span><strong>' + plan.approvedRestored + '</strong>恢复确认</span>' : '') + '</div>'
        + (plan.merged ? '<p>其中 ' + plan.merged + ' 条本页已有记录、但历史记录里带人工确认：已按行内容签名逐字段合并（人工确认保留），不需要再点找回。</p>' : '')
        + (plan.approvedRestored ? '<p>其中 ' + plan.approvedRestored + ' 条本页记录当初只能按文本锚点搬来（这一行内容被改动过）：旧记录里的「修改结果」与这一行现在的正文逐字相同，已恢复人工确认，不需要再逐行核验。</p>' : '')
        + '<p>' + (byIndex ? '仅将旧第 N 行对应到当前第 N 行，行内容可能已经变化。所有条目都需核验。'
          : '优先按行内容匹配：行签名对得上，或记录里的「修改结果」与这一行现在的正文逐字相同。仅靠文本锚点推断行序的条目仍需核验。') + '</p>'
        + '<p>保留本页已有记录。需核验的条目会清除人工确认状态，逐行确认后才能写回。来源空间始终保留。</p>'
        + (samples ? '<ol class="notes-preview-samples">' + samples + '</ol>' : '<p class="notes-space-empty">没有可新增的匹配记录。按行号找回可从空间详情单独选择。</p>');
      notesPanelIds.dialog.showModal();
    }

    notesPanelIds.panel.addEventListener("click", (event) => {
      const button = event.target.closest("[data-notes-export], [data-notes-restore], [data-notes-index], [data-notes-drop]");
      if (!button) return;
      const action = ["notesExport", "notesRestore", "notesIndex", "notesDrop"].find((key) => key in button.dataset);
      const cached = notesSpaceInventory[Number(button.dataset[action])];
      const space = cached && freshNotesSpace(cached.key);
      if (!space) { renderNotesSpaces(); notesPanelStatus("该空间已发生变化，请重新选择。", { tone: "watch" }); return; }
      if (action === "notesExport") {
        downloadNotesJson("betweenlines-notes-" + (space.rows || "space") + ".json", notesBackup([space]));
      } else if (action === "notesRestore" || action === "notesIndex") {
        if (!space.current && space.data) previewNotesRecovery(space, action === "notesIndex");
      } else if (!space.current) {
        if (!confirm("删除「" + notesSpaceTitle(space) + "」的 " + space.entries + " 条记录？\n删除不可撤销，请确认已经导出备份。")) return;
        try {
          localStorage.removeItem(space.key);
          renderNotesSpaces();
          notesPanelStatus("已删除所选历史空间。", { tone: "success" });
        } catch { notesPanelStatus("删除失败，浏览器未允许修改本地存储。", { tone: "error" }); }
      }
    });
    notesPanelIds.apply.addEventListener("click", () => {
      const pending = pendingNotesRecovery;
      if (!pending) return;
      const space = freshNotesSpace(pending.key);
      if (!space || space.raw !== pending.raw) {
        notesPanelIds.dialog.close();
        notesPanelStatus("来源空间已变化，请重新预览。", { tone: "watch" });
        renderNotesSpaces();
        return;
      }
      // 预览期间本页仍可能收到 AI 结果；重新排除已占用的目标行。
      const plan = recoveryPlan(space, pending.byIndex);
      if (notesStorageBlocked) { notesPanelStatus("请先解决保存冲突，再找回记录。", { tone: "watch" }); return; }
      applyRecovery(space, plan);
      saveNotes({ immediate: true });
      markNotesDirtyForMetrics();
      updateStageMetricsDashboard(null, {}, false);
      updateDoneCount();
      applyFilters({ reset: false });
      notesPanelIds.dialog.close();
      renderNotesSpaces();
      notesPanelStatus("已找回 " + plan.pairs.length + " 条，其中 " + plan.unverified + " 条需逐行核验。"
        + (notesPersistFailed || notesStorageBlocked ? "本次尚未保存，请先导出本页记录。" : "已保存到本页空间。"),
        { tone: notesPersistFailed || notesStorageBlocked ? "watch" : "success" });
    });
    document.getElementById("cancelNotesRecovery").addEventListener("click", () => notesPanelIds.dialog.close());
    notesPanelIds.dialog.addEventListener("close", () => { pendingNotesRecovery = null; });
    notesPanelIds.exportAll.addEventListener("click", () => {
      downloadNotesJson("betweenlines-notes-backup.json", notesBackup(collectNotesSpaces()));
      notesPanelStatus("已导出本页和全部历史空间。", { tone: "success" });
    });
    notesPanelIds.clearCurrent.addEventListener("click", () => {
      const current = collectNotesSpaces().find((space) => space.current);
      if (!current?.entries) { notesPanelStatus("本页没有可清空的备注记录。", { tone: "watch" }); return; }
      if (!confirm("清空本页备注空间中的 " + current.entries + " 条记录？\n这会同时清除人工确认和修改结果，历史空间不会受影响。\n\n建议先备份，再确认清空。")) return;
      try {
        localStorage.setItem(storageKey, "{}");
        for (const id of Object.keys(notes)) delete notes[id];
        markNotesDirtyForMetrics();
        updateStageMetricsDashboard(null, {}, false);
        lastPersistedNotesRaw = "{}";
        notesPersistFailed = false;
        notesStorageBlocked = false;
        updateDoneCount();
        applyFilters({ reset: false });
        renderNotesSpaces();
        notesPanelStatus("已清空本页备注空间；历史空间仍保留。", { tone: "success" });
      } catch { notesPanelStatus("清空失败：浏览器未允许修改本地存储。", { tone: "error" }); }
    });
    notesPanelIds.clearHistory.addEventListener("click", () => {
      const history = collectNotesSpaces().filter((space) => !space.current && space.entries);
      if (!history.length) { notesPanelStatus("没有可清空的历史备注空间。", { tone: "watch" }); return; }
      const count = history.reduce((total, space) => total + space.entries, 0);
      if (!confirm("清空 " + history.length + " 个历史空间中的 " + count + " 条记录？\n此操作不可撤销，请先点击「备份全部」。")) return;
      try {
        for (const space of history) localStorage.removeItem(space.key);
        renderNotesSpaces();
        notesPanelStatus("已清空历史备注空间；本页记录保持不变。", { tone: "success" });
      } catch { notesPanelStatus("清空历史失败：浏览器未允许修改本地存储。", { tone: "error" }); }
    });
    notesPanelIds.file.addEventListener("change", async () => {
      const [file] = notesPanelIds.file.files || [];
      notesPanelIds.file.value = "";
      if (!file) return;
      try {
        const spaces = notesTools.decodeBackup(JSON.parse(await file.text()));
        if (!confirm("从备份登记 " + spaces.length + " 个空间？\n相同内容跳过；同名且内容不同会保留为副本。导入后可在列表预览找回。")) return;
        const result = notesTools.importBackup(localStorage, spaces, storageKey);
        renderNotesSpaces();
        notesPanelStatus("已导入 " + result.imported.length + " 个空间，跳过 " + result.skipped + " 个相同空间。"
          + (result.error ? "另有 " + result.failed + " 个未能保存，请先导出并清理空间后重试。" : "可在历史列表预览找回。"),
          { tone: result.error ? "watch" : "success" });
      } catch (error) { notesPanelStatus("导入失败：" + error.message, { tone: "error" }); }
    });
    notesPanelIds.refresh.addEventListener("click", renderNotesSpaces);
    document.getElementById("retryNotesSave").addEventListener("click", () => {
      saveNotes({ immediate: true });
      renderNotesSpaces();
      if (!notesPersistFailed && !notesStorageBlocked) notesPanelStatus("本页记录已保存。", { tone: "success" });
    });
    notesPanelIds.panel.addEventListener("toggle", () => {
      if (notesPanelIds.panel.open) renderNotesSpaces();
    });
    window.addEventListener("storage", (event) => {
      if (event.key === storageKey || event.key === null) {
        notesStorageBlocked = localStorage.getItem(storageKey) !== lastPersistedNotesRaw;
        updateNotesSaveState();
      }
      if (notesPanelIds.panel.open) renderNotesSpaces();
    });
    renderNotesSpaces();

    bindDetailsToggle();
    bindPanelGroups();
    initWorkbenchTabs();
    document.querySelectorAll("select").forEach(enhanceSelect);
    restoreAiConfig();
    document.querySelectorAll("select").forEach(syncEnhancedSelect);
    // 特化规范 / 目标列都恢复后才有确定的对照表变体：这时再取构建期判定。
    refreshTermVerdicts();
    updateStageMetricsDashboard();
    refreshAiStatus();
    setInterval(refreshAiStatus, 1500);
    applyFilters();
    announceNotesRecovery();
