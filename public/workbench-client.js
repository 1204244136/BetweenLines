    const pageLabels = pageMeta.pageLabels;
    const bilingualMode = pageMeta.comparisonMode === "bilingual";
    const aiConfigStorageKey = "translation-compare-ai-config-v1";
    const aiPromptStorageKey = "translation-compare-ai-prompt-v1:" + (pageMeta.projectKey || "unscoped");

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
    const gptReasoningOptions = [
      ["", "模型默认"],
      ["none", "无 (none)"],
      ["minimal", "最小 (minimal)"],
      ["low", "低 (low)"],
      ["medium", "中 (medium)"],
      ["high", "高 (high)"],
      ["xhigh", "极高 (xhigh)"],
      ["max", "最大 (max)"],
    ];
    const nonGptIntensityOptions = [
      ["", "模型默认"],
      ["low", "低 (low)"],
      ["medium", "中 (medium)"],
      ["high", "高 (high)"],
      ["xhigh", "极高 (xhigh)"],
      ["ultra", "超高 (ultra)"],
      ["max", "最大 (max)"],
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
      start: document.getElementById("aiStart"),
      stop: document.getElementById("aiStop"),
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
    aiIds.promptSection.hidden = !aiIds.promptVisible.checked;

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
        aiIds.concurrency.title = isSmart ? "初始并发数（默认 3，遇到频控可退避至 1）" : "并发数（1~12）";
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

    function isAutomatedNoteText(value) {
      return Boolean(automatedNoteMarker(value));
    }

    function hasAutomatedDecisionNote(note) {
      return !isAiFailureNote(note) && Boolean(parseAutomatedNote(note));
    }

    function isAiFailureNote(note) {
      const lines = String(note || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (!lines[0]?.startsWith("[AI校对]")) return false;
      return lines.slice(1).some((line) =>
        line.startsWith("调用失败：") ||
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
      return text.startsWith("格式自动规范化：") || text.startsWith("低分归因：") || text.startsWith("线上查证：") || text.startsWith("标点自动规范化：");
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

    function revisionTextFor(item) {
      if (!item) return "";
      if (Object.prototype.hasOwnProperty.call(item, "revisionText")) return String(item.revisionText || "");
      return parseAutomatedNote(item.note || "")?.revision || "";
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
      try {
        return JSON.parse(localStorage.getItem(aiConfigStorageKey) || "{}");
      } catch {
        return {};
      }
    }

    const thinkingLevelLabels = {
      "": "模型默认",
      off: "关闭思考 (off)",
      none: "无 (none)",
      minimal: "最小 (minimal)",
      low: "低 (low)",
      medium: "中 (medium)",
      high: "高 (high)",
      xhigh: "极高 (xhigh)",
      max: "最大 (max)",
    };
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

      const reasoningOptions = [
        ["", "模型默认"],
        ...reasoningEfforts.map((effort) => [effort, thinkingLevelLabels[effort] || effort]),
      ];

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
        : "常规非推理模型文本化强度档位（low~max，模型默认时不发送采样参数）";
      const labelElem = aiIds.reasoningField ? aiIds.reasoningField.querySelector("label") : null;
      if (labelElem) {
        labelElem.textContent = isReasoning ? "推理强度" : "推理强度";
      }
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
      const config = {
        provider: aiIds.provider.value,
        baseUrl: aiIds.baseUrl.value,
        model: aiIds.model.value,
        reasoningEffort: aiIds.reasoningEffort.value,
        inferenceSettingVersion: 3,
        gptReasoningEffort: savedGptReasoningEffort,
        nonGptIntensity: savedNonGptIntensity,
        modelOptions: aiModelOptions,
        modelOptionsBaseUrl: aiModelOptions.length ? normalizeApiBaseUrl(aiIds.baseUrl.value) : "",
        apiKey: aiIds.apiKey.value,
        proofreadMode: aiIds.proofreadMode.value,
        target: aiIds.target.value,
        profileId: aiIds.profile.value,
        concurrency: aiIds.concurrency.value,
        smartConcurrency: Boolean(aiIds.smartConcurrency?.checked),
        concurrencyMax: aiIds.concurrencyMax ? aiIds.concurrencyMax.value : 10,
        breakerThreshold: formatPercentRatio(aiIds.breakerThreshold.value, 0.5, 0.1),
        breakerDisabled: aiIds.breakerDisabled.checked,
        similarity: formatPercentRatio(prefilterIds.similarity.value),
        promptVisible: aiIds.promptVisible.checked,
        currentPresetId: currentPresetId || "",
      };
      localStorage.setItem(aiConfigStorageKey, JSON.stringify(config));
    }

    function saveAiPrompt() {
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
      aiIds.promptVisible.checked = Boolean(saved.promptVisible);
      if (typeof savedPrompt.systemPrompt === "string" && savedPrompt.systemPrompt) {
        if (savedPrompt.promptTouched) {
          aiIds.prompt.value = savedPrompt.systemPrompt;
          aiIds.prompt.dataset.touched = "1";
        } else {
          defaultProofreadPrompt = defaultPromptForProfile(aiIds.profile.value) || defaultProofreadPrompt;
          aiIds.prompt.value = defaultProofreadPrompt;
          aiIds.prompt.dataset.touched = "";
        }
      }
      aiIds.promptSection.hidden = !aiIds.promptVisible.checked;
      normalizeSimilarityInput();
      updateProofreadModeHint();
      updateInferenceSettingOptions();
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
            window.requestAnimationFrame(syncVisibleRowLayout);
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
        menu.hidden = true;
        trigger.setAttribute("aria-expanded", "false");
      }

      function open() {
        closeAllSelects(wrapper);
        sync();
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

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
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
      const revision = revisionTextFor(item);
      const targetKey = revisionTargetFor(item);
      const targetText = targetKey === "tw" ? row.tw : row.cn;
      const revisionDiffHtml = targetText && revision ? inlineDiffHtml(targetText, revision) : "";
      const revisionMatchesTw = targetKey === "cn" && Boolean(twDiffHtml && revisionDiffHtml && twDiffHtml === revisionDiffHtml);
      const comparisons = [];
      if (twDiffHtml && !revisionMatchesTw) {
        comparisons.push({
          kind: "translation",
          html: '<div class="diff-comparison" data-diff-kind="translation">' +
          '<div class="version-label"><span>' + escapeHtml(pageLabels.cn) + ' -> ' + escapeHtml(pageLabels.tw) + '简体化</span></div>' +
          '<div lang="zh-Hans">' + twDiffHtml + '</div>' +
          '</div>',
        });
      }
      if (revisionDiffHtml) {
        const matchBadge = revisionMatchesTw
          ? '<span class="diff-match-badge" title="与' + escapeHtml(pageLabels.tw) + '简体化的差异完全相同">同' + escapeHtml(pageLabels.tw) + '简体化</span>'
          : "";
        comparisons.push({
          kind: "revision",
          html: '<div class="diff-comparison" data-diff-kind="revision">' +
          '<div class="version-label"><span>' + escapeHtml(pageLabels[targetKey] || targetKey) + ' -> 修改结果</span>' + matchBadge + '</div>' +
          '<div lang="' + (targetKey === "tw" ? "zh-Hant" : "zh-Hans") + '">' + revisionDiffHtml + '</div>' +
          '</div>',
        });
      }
      const hasTranslation = comparisons.some((item) => item.kind === "translation");
      const hasRevision = comparisons.some((item) => item.kind === "revision");
      return comparisons.length
        ? '<section class="diff-block" data-diff data-has-translation="' + (hasTranslation ? "1" : "0") + '" data-has-revision="' + (hasRevision ? "1" : "0") + '">' +
          '<div class="diff-title">差异辅助</div>' +
          comparisons.map((item) => item.html).join("") +
          '</section>'
        : "";
    }

    function inlineDiffHtml(oldText, newText) {
      const oldValue = String(oldText || "");
      const newValue = String(newText || "");
      if (!oldValue && !newValue) return "";
      if (oldValue === newValue) return escapeHtml(newValue);
      const oldChars = Array.from(oldValue);
      const newChars = Array.from(newValue);
      if (oldChars.length * newChars.length > 50000) {
        return prefixSuffixDiffHtml(oldChars, newChars);
      }
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
          parts.push({ type: "same", value: oldChars[i - 1] });
          i -= 1;
          j -= 1;
        } else if (j > 0 && (i === 0 || dp[i * width + j - 1] >= dp[(i - 1) * width + j])) {
          parts.push({ type: "ins", value: newChars[j - 1] });
          j -= 1;
        } else {
          parts.push({ type: "del", value: oldChars[i - 1] });
          i -= 1;
        }
      }
      return compactDiffParts(parts.reverse());
    }

    function prefixSuffixDiffHtml(oldChars, newChars) {
      let prefix = 0;
      while (prefix < oldChars.length && prefix < newChars.length && oldChars[prefix] === newChars[prefix]) {
        prefix += 1;
      }
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

    function compactDiffParts(parts) {
      const chunks = [];
      for (const part of parts) {
        const last = chunks[chunks.length - 1];
        if (last && last.type === part.type) {
          last.value += part.value;
        } else {
          chunks.push({ ...part });
        }
      }
      return chunks.map((part) => {
        const value = escapeHtml(part.value);
        if (part.type === "ins") return "<ins>" + value + "</ins>";
        if (part.type === "del") return "<del>" + value + "</del>";
        return value;
      }).join("");
    }

    function parseAutomatedNote(note) {
      const lines = String(note || "").split(/\n+/).map((line) => line.trim()).filter(Boolean);
      if (!automatedNoteMarker(lines[0])) return null;
      if (isAiFailureNote(note)) return null;
      const data = { semantic: "", modify: "", severity: "", grade: "", score: null, penalty: null, revision: "", analysis: "" };
      let currentField = "";
      for (const line of lines.slice(1)) {
        if (line.startsWith("语义是否相同：")) {
          data.semantic = line.slice("语义是否相同：".length).trim();
          currentField = "";
        } else if (line.startsWith("是否需要修改：")) {
          data.modify = line.slice("是否需要修改：".length).trim();
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

      return data.semantic || data.modify || data.severity || data.grade || data.score !== null || data.revision || data.analysis ? data : null;
    }

    function normalizeGrade(value) {
      const text = String(value || "").trim().toLowerCase();
      if (["excellent", "优等", "优秀", "优", "a"].includes(text)) return "excellent";
      if (["good", "良好", "良", "b", "minor", "轻微"].includes(text)) return "good";
      if (["fair", "一般", "待改", "中等", "及格", "c", "major", "严重"].includes(text)) return "fair";
      if (["poor", "较差", "差", "不及格", "d", "critical", "致命"].includes(text)) return "poor";
      return "";
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

    function renderNoteSummary(item, id) {
      const noteText = item?.note || "";
      const note = parseAutomatedNote(noteText);
      if (!note) return '<div class="note-summary" hidden></div>';
      const analysis = note.analysis
        ? '<div class="note-detail note-reason"><div class="note-detail-head"><span class="note-summary-key">分析</span></div><div class="note-summary-value">' + escapeHtml(note.analysis) + '</div></div>'
        : "";
      const revisionText = revisionTextFor(item);
      const revisionTarget = revisionTargetFor(item);
      const revisionLabel = pageLabels[revisionTarget] || (revisionTarget === "tw" ? "非原文 C" : "非原文 B");
      const revision = revisionText
        ? '<div class="note-detail note-revision"><div class="note-detail-head"><span class="note-summary-key">' + escapeHtml(revisionLabel) + '修改结果</span><div class="revision-head-actions"><button type="button" class="writeback-revision" data-writeback-revision="' + escapeHtml(id || "") + '" title="将修改结果直接写回原文件">写回</button><button type="button" class="copy-revision" data-copy-text="' + escapeHtml(revisionText) + '" title="复制修改结果">复制</button></div></div><textarea class="revision-editor" data-revision="' + escapeHtml(id || "") + '" aria-label="第 ' + escapeHtml(id || "") + ' 行 AI 修改结果">' + escapeHtml(revisionText) + '</textarea></div>'
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

    function syncRevisionEditorHeight(editor) {
      if (!editor) return;
      editor.classList.remove("is-overflowing");
      editor.style.height = "auto";
      const maxHeight = Math.max(120, Math.round(window.innerHeight * 0.4));
      const nextHeight = Math.min(editor.scrollHeight + 2, maxHeight);
      editor.style.height = nextHeight + "px";
      editor.classList.toggle("is-overflowing", editor.scrollHeight > maxHeight);
    }

    function syncVisibleRowLayout() {
      for (const editor of tbody.querySelectorAll(".revision-editor")) syncRevisionEditorHeight(editor);

      const visibleRows = tbody.querySelectorAll("tr[data-index]").length;
      const fitContent = visibleRows <= 3;
      tableFrame.classList.toggle("is-fit-content", fitContent);
      if (fitContent) {
        wrap.style.setProperty("--results-max-height", "none");
        return;
      }

      const tableTop = tableFrame.getBoundingClientRect().top;
      const viewportGap = 88;
      const available = Math.max(320, window.innerHeight - tableTop - viewportGap);
      wrap.style.setProperty("--results-max-height", available + "px");
    }

    function renderedRow(id) {
      return renderedRowsById.get(String(id)) || null;
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
    }

    function totalPages() {
      return Math.max(1, Math.ceil(filteredRows.length / Number(pageSize.value || 100)));
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
      syncVisibleRowLayout();
      updateDoneCount();
      updatePaginationStatus();
    }

    function updateRenderedAiActive() {
      for (const row of tbody.querySelectorAll("tr[data-index]")) {
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

    async function copyText(text) {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return;
      }
      const helper = document.createElement("textarea");
      helper.value = text;
      helper.setAttribute("readonly", "");
      helper.style.position = "fixed";
      helper.style.left = "-9999px";
      helper.style.top = "0";
      document.body.appendChild(helper);
      helper.select();
      const ok = document.execCommand("copy");
      helper.remove();
      if (!ok) throw new Error("copy failed");
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
      const matchesPrefilterResult = !prefilterResultFilterActive || prefilterResultIds.has(id);
      return matchesQuery && matchesSeverity && matchesAiResult && matchesIssueSeverity && matchesNotes && matchesDone && matchesPrefilterResult;
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

    function scheduleFilter() {
      window.clearTimeout(filterTimer);
      filterTimer = window.setTimeout(() => applyFilters(), 120);
    }

    tbody.addEventListener("input", (event) => {
      const revisionEditor = event.target.closest("[data-revision]");
      if (revisionEditor) {
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
    showSource.addEventListener("change", () => {
      document.documentElement.classList.toggle("hide-source", !showSource.checked);
      syncVisibleRowLayout();
    });
    if (showTranslationDiff) {
      showTranslationDiff.addEventListener("change", () => {
        document.documentElement.classList.toggle("hide-translation-diff", !showTranslationDiff.checked);
        syncVisibleRowLayout();
      });
    }
    showRevisionDiff.addEventListener("change", () => {
      document.documentElement.classList.toggle("hide-revision-diff", !showRevisionDiff.checked);
      syncVisibleRowLayout();
    });
    aiIds.promptVisible.addEventListener("change", () => {
      aiIds.promptSection.hidden = !aiIds.promptVisible.checked;
      if (aiIds.promptVisible.checked) aiIds.promptSection.open = true;
      saveAiConfig();
      syncVisibleRowLayout();
    });

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
      try {
        const entries = [{ id: String(id), targetKey, searchText, replaceText: revision }];
        const response = await apiFetch("/api/translation-export", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries, rowTexts: writebackRowTexts(entries) }),
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
        showToast("已写回第 " + id + " 行修改结果" + (writtenTo ? "（" + writtenTo + "）" : "") + "，并标记为人工确认。" + importedCopyHint(result), { tone: result.importedCopy ? "watch" : "success", durationMs: 12000 });
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
      if (!confirm("将当前筛选结果中的 " + entries.length + " 处修改结果写回原文件？定位失败或有多处同段的段落不会写入。" + skipNote)) return;
      try {
        const response = await apiFetch("/api/translation-export", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries, rowTexts: writebackRowTexts(entries) }) });
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
        showToast((unwrittenNote
          ? "已写回 " + result.updated + " 处修改；" + unwrittenNote + "，这些行未标记为已确认。"
          : "已写回 " + result.updated + " 处修改。") + (writtenTo ? " 写入：" + writtenTo : "") + importedCopyHint(result), { tone, durationMs: 15000 });
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
      return {
        provider: aiIds.provider.value,
        baseUrl: aiIds.baseUrl.value,
        model: aiIds.model.value,
        reasoningEffort: aiIds.reasoningEffort.value,
        apiKey: aiIds.apiKey.value,
        proofreadMode: aiIds.proofreadMode.value,
        target: aiIds.target.value,
        profileId: aiIds.profile.value,
        concurrency: Number(aiIds.concurrency.value),
        smartConcurrency: Boolean(aiIds.smartConcurrency?.checked),
        concurrencyMax: aiIds.concurrencyMax ? Number(aiIds.concurrencyMax.value) : 10,
        circuitBreakerErrorRate: parsePercentRatio(aiIds.breakerThreshold.value, 0.5, 0.1),
        circuitBreakerEnabled: !aiIds.breakerDisabled.checked,
        similarityThreshold: parsePercentRatio(prefilterIds.similarity.value),
        systemPrompt: aiIds.prompt.value,
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

    function renderAiStatus(ai) {
      if (!ai) return;
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
        if (!aiIds.prompt.dataset.touched || aiIds.prompt.value === previousDefault) {
          aiIds.prompt.value = defaultProofreadPrompt;
        }
      }
      if (ai.termTableStatus) setTermTableHint(ai.termTableStatus);
      if (ai.speechHabitStatus) setSpeechHabitHint(ai.speechHabitStatus);
      aiIds.start.disabled = Boolean(ai.running);
      aiIds.stop.disabled = !ai.running;
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
      const concurrencyInfo = ai.smartConcurrency && ai.currentConcurrency
        ? "（动态并发 " + ai.currentConcurrency + "/" + (ai.concurrencyMax || 10) + "）"
        : "";
      const runningStatus = (isPrefilter ? "预筛选中：" : "AI 校对中" + concurrencyInfo + "：实际调用 " + queueText + "，") + (isPrefilter ? "" : skipText + "，") + prefilterText + (isPrefilter ? "，" + pendingText : "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0));
      const finishedStatus = (isPrefilter ? (ai.stopRequested ? "预筛选已终止：" : "预筛选完成：") : (ai.stopRequested ? "AI 校对已终止：" : "AI 校对完成：") + "实际调用 " + queueText + "，") + (isPrefilter ? "" : skipText + "，") + prefilterText + (isPrefilter ? "，" + pendingText : "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0));
      if (ai.running) {
        setRuntimeStatus(runningStatus);
      } else if (ai.finishedAt) {
        setRuntimeStatus(finishedStatus);
      } else if (ai.error) {
        setRuntimeStatus(ai.error);
      }
      if (aiIds.panelState) {
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
        applyFilters({ reset: false });
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
    aiIds.prompt.addEventListener("input", () => {
      aiIds.prompt.dataset.touched = "1";
      saveAiPrompt();
    });
    aiIds.promptReset.addEventListener("click", () => {
      defaultProofreadPrompt = defaultPromptForProfile(aiIds.profile.value) || defaultProofreadPrompt;
      aiIds.prompt.value = defaultProofreadPrompt;
      aiIds.prompt.dataset.touched = "";
      aiIds.prompt.focus();
      saveAiPrompt();
      showToast("已恢复当前特化规范的默认提示词。", { tone: "success", durationMs: 6000 });
    });
    aiIds.profile.addEventListener("change", () => {
      // 换特化规范：只替换没有手改过的提示词，手改过的提示词由服务端按“是否已带该档案”决定补不补。
      const nextDefault = defaultPromptForProfile(aiIds.profile.value);
      if (nextDefault && (!aiIds.prompt.dataset.touched || aiIds.prompt.value === defaultProofreadPrompt)) {
        defaultProofreadPrompt = nextDefault;
        aiIds.prompt.value = nextDefault;
      }
      aiIds.prompt.dataset.touched = aiIds.prompt.dataset.touched ? "1" : "";
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
    window.addEventListener("resize", syncVisibleRowLayout);
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

    async function startAiProofread() {
      aiIds.start.disabled = true;
      aiIds.status.dataset.cacheCleared = "";
      aiIds.panel.open = true;
      setRuntimeStatus("正在启动 AI 校对...");
      try {
        const response = await apiFetch("/api/ai-proofread/start", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(aiConfig()),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        renderAiStatus(data.ai);
        refreshAiStatus();
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
        aiIds.start.disabled = false;
      }
    }

    if (aiConfirmIds.dialog) {
      if (aiConfirmIds.clear) {
        aiConfirmIds.clear.addEventListener("click", async () => {
          aiConfirmIds.dialog.close();
          const cleared = clearUnconfirmedAiProofreadNotes();
          if (cleared > 0) {
            showToast(`已清空 ${cleared} 条未人工确认的 AI 校对信息。`, { tone: "info", durationMs: 6000 });
          }
          await startAiProofread();
        });
      }
      if (aiConfirmIds.keep) {
        aiConfirmIds.keep.addEventListener("click", async () => {
          aiConfirmIds.dialog.close();
          await startAiProofread();
        });
      }
      if (aiConfirmIds.cancel) {
        aiConfirmIds.cancel.addEventListener("click", () => {
          aiConfirmIds.dialog.close();
        });
      }
    }

    aiIds.start.addEventListener("click", async () => {
      const unconfirmedCount = countUnconfirmedAiProofreadNotes();
      if (unconfirmedCount > 0) {
        if (aiConfirmIds.dialog && typeof aiConfirmIds.dialog.showModal === "function") {
          if (aiConfirmIds.message) {
            aiConfirmIds.message.innerHTML = `检测到之前有 <strong>${unconfirmedCount}</strong> 条未人工确认的 AI 校对信息。<br>是否在开始本次校对前清空这些信息？`;
          }
          aiConfirmIds.dialog.showModal();
          return;
        }
        if (confirm(`是否清空之前未人工确认的 ${unconfirmedCount} 条 AI 校对信息？\n\n点击「确定」：清空未确认信息后开始校对\n点击「取消」：保留现有信息直接开始校对`)) {
          const cleared = clearUnconfirmedAiProofreadNotes();
          if (cleared > 0) {
            showToast(`已清空 ${cleared} 条未人工确认的 AI 校对信息。`, { tone: "info", durationMs: 6000 });
          }
        }
      }
      await startAiProofread();
    });
    aiIds.stop.addEventListener("click", async () => {
      aiIds.stop.disabled = true;
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
    });
    aiIds.clearCache.addEventListener("click", async () => {
      if (aiIds.stop.disabled === false) {
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
    document.querySelectorAll("select").forEach(enhanceSelect);
    restoreAiConfig();
    document.querySelectorAll("select").forEach(syncEnhancedSelect);
    // 特化规范 / 目标列都恢复后才有确定的对照表变体：这时再取构建期判定。
    refreshTermVerdicts();
    refreshAiStatus();
    setInterval(refreshAiStatus, 1500);
    applyFilters();
    announceNotesRecovery();
