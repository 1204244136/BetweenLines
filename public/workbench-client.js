    const pageLabels = pageMeta.pageLabels;
    const bilingualMode = pageMeta.comparisonMode === "bilingual";
    const aiConfigStorageKey = "translation-compare-ai-config-v2";
    const projectAiConfigStorageKey = "translation-compare-ai-project-config-v2:" + (pageMeta.projectKey || "unscoped");
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

    // 原生 title 在悬停期间被改写会反复消失、重现。当前停留只读移入时的快照，
    // 页面数字与 ARIA 继续更新；移开（或焦点离开）后再应用最新说明。
    const liveHoverTitles = new WeakMap();
    let liveHoverTitleScope = 0;
    function setLiveHoverTitle(element, value, { reset = false } = {}) {
      if (!element) return;
      let state = liveHoverTitles.get(element);
      if (!state) {
        state = { hovered: false, focused: false, latest: "", scope: liveHoverTitleScope };
        liveHoverTitles.set(element, state);
        const flush = () => {
          if (!state.hovered && !state.focused && element.title !== state.latest) element.title = state.latest;
        };
        element.addEventListener("mouseenter", () => {
          // 元素隐藏时浏览器可能没有派发离开事件，重新进入仍应取得最新快照。
          if (!state.focused && element.title !== state.latest) element.title = state.latest;
          state.hovered = true;
        });
        element.addEventListener("mouseleave", () => { state.hovered = false; flush(); });
        element.addEventListener("focusin", () => { state.focused = true; });
        element.addEventListener("focusout", (event) => {
          if (element.contains(event.relatedTarget)) return;
          state.focused = false;
          flush();
        });
      }
      const scopeChanged = state.scope !== liveHoverTitleScope;
      state.scope = liveHoverTitleScope;
      state.latest = String(value || "");
      if ((reset || scopeChanged || element.hidden || !state.latest || (!state.hovered && !state.focused))
        && element.title !== state.latest) element.title = state.latest;
    }

    function markNotesDirtyForMetrics() {
      notesMetricsVersion += 1;
    }

    const allRows = JSON.parse(document.getElementById("rowData").textContent);
    const rowsById = new Map(allRows.map((row) => [String(row.index), row]));
    const renderedRowsById = new Map();
    const notesTools = createNotesTools(alignLegacyNotes);
    const browserNotesStorage = createNotesStorage(localStorage, LZString);
    const diskNotesMode = /https?:/.test(window.location.protocol);
    let diskNotesBootstrap = null;
    try { diskNotesBootstrap = JSON.parse(document.getElementById("notesDiskData")?.textContent || "null"); }
    catch { diskNotesBootstrap = { error: "磁盘备注数据无法解析，请保留本页记录并重新打开工作台。" }; }
    const notesStorage = diskNotesMode ? createDiskNotesStorage({
      bootstrap: diskNotesBootstrap || { error: "磁盘备注接口尚未就绪，请重启控制台服务并应用新布局。" },
      browserStorage: browserNotesStorage, request: apiFetch, currentKey: storageKey,
      onStateChange: () => { updateNotesSaveState(); if (document.getElementById("notesPanel")?.open) renderNotesSpaces(); },
    }) : browserNotesStorage;
    const presetTools = createPresetTools();
    let currentPresetId = "";
    let latestPresetPipelines = {};
    const stagePresetSelections = { stage1: [], stage2: [], stage3: [] };
    const stagePresetControls = {
      stage1: {
        select: "stage1Preset",
        add: "stage1PresetAdd",
        tags: "stage1PresetTags",
        dropdown: "stage1AppliedDropdown",
        trigger: "stage1AppliedTrigger",
        value: "stage1AppliedValue",
        menu: "stage1AppliedMenu",
      },
      stage2: {
        select: "stage2Preset",
        add: "stage2PresetAdd",
        tags: "stage2PresetTags",
        dropdown: "stage2AppliedDropdown",
        trigger: "stage2AppliedTrigger",
        value: "stage2AppliedValue",
        menu: "stage2AppliedMenu",
      },
      stage3: {
        select: "stage3Preset",
        add: "stage3PresetAdd",
        tags: "stage3PresetTags",
        dropdown: "stage3AppliedDropdown",
        trigger: "stage3AppliedTrigger",
        value: "stage3AppliedValue",
        menu: "stage3AppliedMenu",
      },
    };

    function closeAllStageAppliedMenus() {
      for (const stage of ["stage1", "stage2", "stage3"]) {
        const controls = stagePresetControls[stage];
        const menu = aiIds[controls.menu];
        const trigger = aiIds[controls.trigger];
        const dropdown = aiIds[controls.dropdown];
        if (menu) menu.hidden = true;
        if (trigger) trigger.setAttribute("aria-expanded", "false");
        if (dropdown) dropdown.classList.remove("is-open");
      }
    }

    function toggleStageAppliedMenu(stage) {
      const controls = stagePresetControls[stage];
      const menu = aiIds[controls.menu];
      const trigger = aiIds[controls.trigger];
      const dropdown = aiIds[controls.dropdown];
      if (!menu || !trigger || trigger.disabled) return;
      const isOpen = !menu.hidden;
      closeAllStageAppliedMenus();
      if (!isOpen) {
        menu.hidden = false;
        trigger.setAttribute("aria-expanded", "true");
        if (dropdown) dropdown.classList.add("is-open");
      }
    }

    function committedStagePresetIds(stage) {
      // 候选选择器只用于「添加」；执行与保存都必须和适用预设列表一致。
      return [...(stagePresetSelections[stage] || [])];
    }

    // 该阶段当前选中的预设（含完整连接参数与 presetId）：启动时随请求体发送，
    // 运行中增删预设也用它同步给服务端。保留无效条目交由校验拒绝，不能悄悄回退到其它配置。
    function stagePresetsFor(stage) {
      return committedStagePresetIds(stage)
        .map((id) => ({ ...(presetTools.getPreset(localStorage, id) || {}), presetId: id }));
    }

    // 触顶 = 这条通道已经达到该预设自己配置的并发上限（不是「配额用满」——配额还会继续上调）。
    // 口径由服务端 presetPipelines[].topped 给出；旧服务端没有这个字段时按同一口径本地折算。
    function stagePresetTopped(row) {
      if (!row.runtime) return false;
      if (typeof row.runtime.topped === "boolean") return row.runtime.topped;
      return row.configuredConcurrency > 0 && row.inFlight >= row.configuredConcurrency;
    }

    function renderStagePresetSelection(stage) {
      const controls = stagePresetControls[stage];
      const tags = aiIds[controls.tags];
      const trigger = aiIds[controls.trigger];
      const valueEl = aiIds[controls.value];
      if (!tags) return;
      const ids = stagePresetSelections[stage] || [];
      const stagePipelines = Array.isArray(latestPresetPipelines[stage]) ? latestPresetPipelines[stage] : [];

      // 预设标签、下拉栏文本与悬停提示共用这一份运行数据，避免三处各算各的。
      const rows = ids.map((id) => {
        const preset = presetTools.getPreset(localStorage, id);
        const candidateRuntime = stagePipelines.find((item) => String(item.presetId) === String(id));
        const candidateActiveRows = Array.isArray(candidateRuntime?.activeRows) ? candidateRuntime.activeRows : [];
        const runtime = candidateRuntime && (currentAiRunning
          || Number(candidateRuntime.inFlight) > 0
          || Number(candidateRuntime.pending) > 0
          || candidateActiveRows.length > 0)
          ? candidateRuntime : null;
        const row = {
          id,
          preset,
          runtime,
          label: preset ? presetTools.presetLabel(preset) : id,
          configuredConcurrency: Math.max(1, Number(runtime?.configuredConcurrency) || Number(preset?.concurrency) || 3),
          inFlight: Math.max(0, Number(runtime?.inFlight) || 0),
          quota: Math.max(0, Number(runtime?.quota) || 0),
          pending: Math.max(0, Number(runtime?.pending) || 0),
          breakerTripped: runtime?.breakerTripped === true || runtime?.breakerState === "tripped",
        };
        row.topped = stagePresetTopped(row);
        return row;
      });

      const stageToppedCount = rows.filter((row) => row.topped).length;

      const existing = new Map(Array.from(tags.children)
        .filter((tag) => tag.dataset.presetId).map((tag) => [tag.dataset.presetId, tag]));
      const nextTags = rows.map((row) => {
        let tag = existing.get(String(row.id));
        if (!tag) {
          tag = document.createElement("div");
          tag.className = "ai-stage-preset-tag";
          tag.dataset.presetId = String(row.id);
          const label = document.createElement("span");
          label.className = "ai-stage-preset-tag-label";
          const runtimeLabel = document.createElement("span");
          runtimeLabel.className = "ai-stage-preset-runtime";
          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "ai-stage-preset-tag-remove";
          remove.textContent = "×";
          remove.title = "移除该预设";
          remove.addEventListener("click", (event) => {
            event?.stopPropagation?.();
            stagePresetSelections[stage] = stagePresetSelections[stage].filter((item) => item !== row.id);
            renderStagePresetSelection(stage);
            updateStagePresetDependencies();
            saveAiConfig();
            void syncRunningStagePresets(stage);
          });
          tag.append(label, runtimeLabel, remove);
        }
        const [label, runtimeLabel] = tag.children;
        if (label.textContent !== row.label) label.textContent = row.label;
        setLiveHoverTitle(label, row.label);
        let runtimeText = "";
        if (row.runtime) {
          runtimeText = `运行 ${row.inFlight} · 当前配额 ${row.quota} · 配置上限 ${row.configuredConcurrency}`
            + (row.topped ? " · 触顶" : "")
            + (row.breakerTripped ? " · 熔断" : "")
            + (row.pending > 0 ? ` · 排队 ${row.pending}` : "");
          const activeRows = Array.isArray(row.runtime.activeRows) ? row.runtime.activeRows : [];
          setLiveHoverTitle(runtimeLabel, `当前运行 ${row.inFlight} / 动态配额 ${row.quota} / 配置并发上限 ${row.configuredConcurrency} / 待派发 ${row.pending}`
            + (row.topped ? "（已触顶）" : "")
            + (row.breakerTripped ? "（该预设已熔断，后续行改派给其它预设）" : "")
            + (activeRows.length ? `\n当前行：${activeRows.join(", ")}` : ""),
          { reset: !currentAiRunning || Boolean(latestStageControls?.[stage]?.stopRequested && !row.inFlight) });
        } else {
          // 未运行时不显示无用且占位的「并发上限 XX」，仅在悬停中提示额定并发上限
          setLiveHoverTitle(runtimeLabel, `额定并发上限 ${row.configuredConcurrency}`, { reset: true });
        }
        if (runtimeLabel.textContent !== runtimeText) runtimeLabel.textContent = runtimeText;
        return tag;
      });

      if (ids.length === 0) {
        const emptyItem = tags.children[0]?.className === "ai-stage-applied-empty"
          ? tags.children[0] : document.createElement("div");
        emptyItem.className = "ai-stage-applied-empty";
        emptyItem.textContent = stage === "stage1" ? "当前使用主配置，未添加独立预设" : "当前未启用预设";
        nextTags.push(emptyItem);
      }
      // 状态轮询不替换悬停或聚焦的锚点；只有适用列表真正变化时才更新结构。
      if (tags.children.length !== nextTags.length || nextTags.some((tag, index) => tags.children[index] !== tag)) {
        tags.replaceChildren(...nextTags);
      }
      tags.hidden = false;

      // 更新适用预设下拉栏 Trigger 的文字与 title
      if (valueEl && trigger) {
        // 触顶是运行态：每次重渲染先清掉上一次的样式，否则任务停下后还留着醒目色。
        valueEl.classList.remove("is-part-topped", "is-all-topped");
        if (ids.length === 0) {
          if (stage === "stage1") {
            valueEl.textContent = "适用：主配置";
            setLiveHoverTitle(trigger, "阶段一当前未添加独立预设，默认使用主配置", { reset: true });
          } else {
            valueEl.textContent = "未启用";
            setLiveHoverTitle(trigger, stage === "stage2" ? "阶段二未启用预设" : "阶段三未启用预设", { reset: true });
          }
        } else {
          valueEl.textContent = ids.length === 1 ? "适用：" + rows[0].label : "适用 (" + rows.length + ")";
          const presetList = rows.map((row, index) => {
            const stateText = row.runtime
              ? "（运行 " + row.inFlight + "，当前配额 " + row.quota + "，配置上限 " + row.configuredConcurrency + (row.topped ? " · 已触顶" : "") + (row.breakerTripped ? " · 已熔断" : "") + "）"
              : "（配置上限 " + row.configuredConcurrency + "）";
            return (index + 1) + ". " + row.label + stateText;
          }).join("\n");
          setLiveHoverTitle(trigger, "当前阶段适用预设：\n" + presetList
            + (stageToppedCount > 0 ? "\n已触顶 " + stageToppedCount + "/" + rows.length + " 个预设" + (stageToppedCount >= rows.length ? "（全部触顶）" : "") + "。" : ""),
          { reset: !currentAiRunning || stagePipelines.length === 0 });
        }
      }
    }

    function addSelectedStagePreset(stage) {
      const controls = stagePresetControls[stage];
      const select = aiIds[controls.select];
      const id = select?.value || "";
      if (!id) return;
      if (!stagePresetSelections[stage].includes(id)) stagePresetSelections[stage].push(id);
      select.value = "";
      syncEnhancedSelect(select);
      renderStagePresetSelection(stage);
      updateStagePresetDependencies();
      saveAiConfig();
      void syncRunningStagePresets(stage);
    }

    // 运行中增删预设要立刻生效：删掉的预设，它的待审行马上改派给其余预设；新加的预设立即参与处理。
    // 任务没在跑时什么都不做——那种改动本来就会随下次启动的请求体生效。
    async function syncRunningStagePresets(stage) {
      if (!currentAiRunning) return;
      const stageLabel = stage === "stage1" ? "阶段一" : (stage === "stage2" ? "阶段二" : "阶段三");
      try {
        const response = await apiFetch("/api/ai-proofread/presets", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stage, presets: stagePresetsFor(stage) }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        const added = Array.isArray(data.added) ? data.added.length : 0;
        const removed = Array.isArray(data.removed) ? data.removed.length : 0;
        if (data.rejected) {
          showToast(`${stageLabel}没有可用的阶段模型配置，这次改动没有生效；请至少保留一个预设。`, { tone: "watch", durationMs: 10000 });
          return;
        }
        const parts = [];
        if (added) parts.push(`新增 ${added} 个预设，已立刻参与派发`);
        if (removed) parts.push(`移除 ${removed} 个预设，待审行已改派给其余预设`);
        if (data.fallback) parts.push("预设已全部移除，本阶段使用阶段配置继续处理剩余行");
        if (parts.length) {
          showToast(`${stageLabel}预设已即时生效：${parts.join("；")}。`, { tone: "success", durationMs: 7000 });
        }
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
      }
    }
    const notes = {};
    const initialRaw = notesStorage.getItem(storageKey);
    const initialData = initialRaw === null ? {} : notesTools.parse(initialRaw);
    // 无法解析的当前空间保留原样，防止下一次自动保存抹掉原始数据。
    const notesPersistence = createNotesPersistence({
      storage: notesStorage,
      key: storageKey,
      initialRaw,
      initialBlocked: initialData === null,
      serialize: serializeNotes,
      classifyFailure: notesTools.storageFailureKind,
      onStateChange: updateNotesSaveState,
      scheduler: {
        setTimeout: window.setTimeout.bind(window),
        clearTimeout: window.clearTimeout.bind(window),
        requestIdleCallback: window.requestIdleCallback?.bind(window),
        cancelIdleCallback: window.cancelIdleCallback?.bind(window),
      },
    });
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
      const spaces = notesTools.inventory(notesStorage, storageKey, notes)
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
        // 初始化恢复直接同步保存，不等待后续交互的延迟保存。
        const saved = persistNotes();
        notesRecovery = {
          tone: "success",
          message: `已修复旧版找回规则漏掉的记录：补回 ${restored} 条、恢复人工确认 ${healed} 条`
            + (saved === false ? (diskNotesMode ? "（正在保存到电脑，请留意保存状态）" : "（尚未写入浏览器存储，请先导出本页记录）") : "。"),
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

    // 只在从未保存过、且属于同一输入项目的空间自动恢复；其他项目不进入当前页，切换对应项目再处理。
    // 已有备注（包括刻意清空的空间）同样由用户预览后合并。
    if (initialRaw === null) {
      const candidates = notesTools.inventory(notesStorage, storageKey, notes)
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

    async function restorePageNotesSeed() {
      const seed = pageMeta.notesRecovery;
      if (!seed) return;
      const marker = "translation-compare-recovery-v1:" + (pageMeta.projectKey || "") + ":" + seed.id;
      try {
        if (notesStorage.disk && notesStorage.hasRecovery(seed.id)) return;
        let browserMarkerSaved = false;
        try { browserMarkerSaved = localStorage.getItem(marker) === "saved"; } catch {}
        if (browserMarkerSaved) {
          if (notesStorage.disk) { persistNotes(); await notesStorage.markRecovery(seed.id); }
          return;
        }
        if (notesPersistence.snapshot().blocked) throw new Error("本页现存记录无法解析，请先导出原始数据。");
        const result = notesTools.restoreSeed(seed, storageKey, allRows, notes, {
          stateFor: stageNoteState,
          userChanged: (item) => Boolean(item.manualDone || (item.note && !isAutomatedNoteText(item.note))
            || (item.revisionText && item.revisionText !== parseAutomatedNote(item.note)?.revision)),
        });
        for (const id of Object.keys(notes)) notes[id] = normalizeStoredNote(notes[id]);
        markNotesDirtyForMetrics();
        let saved = persistNotes();
        if (notesStorage.disk) {
          try { await notesStorage.flush(); saved = !notesPersistence.snapshot().failed && !notesPersistence.snapshot().blocked; }
          catch { saved = false; }
        }
        let markerSaved = false;
        if (saved) {
          if (notesStorage.disk) markerSaved = await notesStorage.markRecovery(seed.id);
          else { try { localStorage.setItem(marker, "saved"); markerSaved = true; } catch {} }
        }
        notesRecovery = {
          tone: saved && markerSaved ? "success" : "watch",
          message: "已从核验备份恢复 " + result.restored + " 条，保留本页 " + result.kept + " 条已有记录。"
            + (saved ? (diskNotesMode ? "已保存到电脑。" : "已无损压缩保存到此浏览器。") : "尚未保存，请保留本页并导出记录。")
            + (saved && !markerSaved ? "恢复标记未能保存，下次刷新会再次核对备份。" : ""),
        };
        if (notesStorage.disk) announceNotesRecovery();
      } catch (error) {
        notesRecovery = { tone: "watch", message: "备份恢复未完成：" + error.message + "请保留备份和当前页面。" };
      }
    }
    restorePageNotesSeed();

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
    const modifyRate = document.getElementById("modifyRate");
    const modifyRateStat = document.getElementById("modifyRateStat");
    const aiIds = {
      presetSelect: document.getElementById("aiPresetSelect"),
      presetSave: document.getElementById("aiPresetSave"),
      presetSaveAs: document.getElementById("aiPresetSaveAs"),
      presetDelete: document.getElementById("aiPresetDelete"),
      protocol: document.getElementById("aiProtocol"),
      provider: document.getElementById("aiProvider"),
      providerNames: document.getElementById("aiProviderNames"),
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
      promptVisible: document.getElementById("aiPromptVisible"),
      stage1Preset: document.getElementById("stage1PresetSelect"),
      stage2Preset: document.getElementById("stage2PresetSelect"),
      stage3Preset: document.getElementById("stage3PresetSelect"),
      stage1PresetAdd: document.getElementById("stage1PresetAdd"),
      stage2PresetAdd: document.getElementById("stage2PresetAdd"),
      stage3PresetAdd: document.getElementById("stage3PresetAdd"),
      stage1PresetTags: document.getElementById("stage1PresetTags"),
      stage2PresetTags: document.getElementById("stage2PresetTags"),
      stage3PresetTags: document.getElementById("stage3PresetTags"),
      stage1AppliedDropdown: document.getElementById("stage1AppliedDropdown"),
      stage2AppliedDropdown: document.getElementById("stage2AppliedDropdown"),
      stage3AppliedDropdown: document.getElementById("stage3AppliedDropdown"),
      stage1AppliedTrigger: document.getElementById("stage1AppliedTrigger"),
      stage2AppliedTrigger: document.getElementById("stage2AppliedTrigger"),
      stage3AppliedTrigger: document.getElementById("stage3AppliedTrigger"),
      stage1AppliedValue: document.getElementById("stage1AppliedValue"),
      stage2AppliedValue: document.getElementById("stage2AppliedValue"),
      stage3AppliedValue: document.getElementById("stage3AppliedValue"),
      stage1AppliedMenu: document.getElementById("stage1AppliedMenu"),
      stage2AppliedMenu: document.getElementById("stage2AppliedMenu"),
      stage3AppliedMenu: document.getElementById("stage3AppliedMenu"),
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
      panelState: document.getElementById("aiPanelState"),
      cacheHitRate: document.getElementById("aiCacheHitRate"),
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
    // 备注空间与写回共用跨工作台确认实现，不保留原生 confirm 回退。
    const { askConfirm } = createConfirmDialog({ showToast: (message, options) => showToast(message, options) });
    let writebackPending = false;
    async function withWritebackConfirmation(message, options, operation) {
      if (writebackPending) return;
      writebackPending = true;
      try {
        if (!await askConfirm(message, options)) return;
        return await operation();
      } finally {
        writebackPending = false;
      }
    }

    const aiActiveIds = new Set();
    const prefilterResultIds = new Set();
    const diffHtmlCache = new Map();
    let filteredRows = allRows;
    let currentPage = 1;
    let activeRowId = "";
    let currentAiRunning = false;
    // 本页「预筛结果集」对应的运行号：不只由本页启动的那一轮设置，页面重开后由状态轮询
    // 从服务端上一轮预筛结果里认领（服务端会整轮返回结果），否则 resultIds 为空、
    // 「确认预筛」永久锁死，用户点「开始预筛」就会把同一批行重新筛一遍。
    let prefilterRunId = "";
    let prefilterResultFilterActive = false;
    let prefilterResultsCatchingUp = false;
    const aiResultReception = createAiResultReception({
      projectKey: pageMeta.projectKey,
      rowsSignature: pageMeta.rowsSignature,
      signatureFor: (id) => rowsById.get(id)?.signature,
      ignoredRunIds: pageMeta.notesRecovery?.ignoredRunIds || [],
      getProfileId: () => aiIds.profile ? aiIds.profile.value : null,
      async requestStatus(params) {
        const response = await apiFetch("/api/ai-proofread/status?" + params);
        return response.json();
      },
      async clearResults(payload) {
        const response = await apiFetch("/api/ai-proofread/results/clear", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || "清除 AI 结果失败。");
      },
      onStatus: renderAiStatus,
      onUnavailable() {
        if (aiCacheCleared) return;
        reportRuntimeNotice("未连接到本地控制台服务，AI 校对需要通过 npm run setup 打开工作台。");
      },
      timers: { setTimeout: window.setTimeout.bind(window) },
    });
    let filterTimer = 0;
    let severityFilter = "all";
    let aiResultFilter = "all";
    let issueSeverityFilter = "all";
    let notesOnly = false;
    let doneMode = "all";
    let protocolDefaults = pageMeta.protocolDefaults || {};
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
    // 术语清单的开合属于页面会话，备注回包与分页重绘均保留用户选择。
    const termOpenRows = new Set();
    const termChipHtmlCache = new WeakMap();
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

    function notesSaveFailureMessage() {
      if (notesStorage.disk) return "尚未保存到电脑：" + (notesStorage.snapshot().message || "磁盘写入失败。")
        + "最新修改仍在本页，请保留页面或导出本页记录；恢复服务或磁盘写入权限后重试。";
      const { failureKind } = notesPersistence.snapshot();
      const protection = "这些修改只在当前页面内存里，刷新或关闭本页就会丢失。请先导出本页记录。";
      if (failureKind === "denied") return "浏览器禁止本地存储写入：" + protection + "请检查站点存储权限，允许存储后重试。";
      if (failureKind !== "quota") return "本地存储写入失败，原因未明：" + protection + "请点击「重试保存」。";
      const usage = notesTools.storageUsage(localStorage, storageKey, notesStorage.encode(JSON.stringify(notes)));
      return "备注无损压缩后仍超出浏览器容量：" + protection
        + (usage.available ? usage.historyCount ? "可清理本项目已备份的历史空间。" : "本项目没有历史空间可清理。" : "无法读取存储占用。")
        + (usage.available && usage.otherNotesCount ? "其他项目或旧版空间也占用容量：展开下方的「其他项目 / 旧版空间」，先导出再删除即可腾出空间。" : "")
        + "释放容量后点击「重试保存」。";
    }

    function updateNotesSaveState() {
      const state = notesPersistence.snapshot();
      const disk = notesStorage.disk ? notesStorage.snapshot() : {};
      const banner = document.getElementById("notesSaveWarning");
      const badge = document.getElementById("notesSaveState");
      const failed = Boolean(state.blocked || state.failed || disk.blocked || disk.failed);
      const pending = Boolean(state.pending || disk.pending);
      if (badge) {
        badge.textContent = failed ? "尚未保存 · 请展开处理" : pending ? "正在保存"
          : notesStorage.disk ? "已保存到电脑" : "保存在此浏览器";
        badge.classList.toggle("is-warn", failed);
      }
      if (!banner) return;
      banner.hidden = !failed;
      banner.textContent = state.blocked
        ? "本页空间无法解析或已被其他页面修改，已暂停保存。请先导出本页记录，再刷新页面核对；本地原始数据仍保留。"
        : notesSaveFailureMessage();
      const retry = document.getElementById("retryNotesSave");
      if (retry) retry.hidden = Boolean(!(state.failed || disk.failed) || state.blocked || disk.blocked);
    }

    function persistNotes() {
      const saved = notesPersistence.persist();
      const disk = notesStorage.disk ? notesStorage.snapshot() : {};
      return saved && !disk.pending && !disk.failed && !disk.blocked;
    }

    function flushNotes() {
      notesPersistence.flush();
    }

    function saveNotes({ immediate = false } = {}) {
      markNotesDirtyForMetrics();
      notesPersistence.save({ immediate });
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
      const state = stageNoteState(note);
      return state.text.startsWith("[AI校对]") && state.failed;
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
      const parsedNote = parseAutomatedNote(item.note);
      const parsedRevision = parsedNote?.revision || "";
      const latestNote = latestAiNotePart(item.note);
      const legacyNoteHead = latestNote.split(/\r?\n(?:[ \t]*\r?\n)+/, 1)[0];
      // 旧解析在首个空行截断后清空了这两个字段；手动清空编辑器会保留目标列。
      const recoverTruncatedRevision = parsedRevision && !manualDone
        && value?.revisionText === "" && value?.revisionTarget === ""
        && latestNote.startsWith("[AI校对]") && legacyNoteHead !== latestNote
        && !/(?:^|\r?\n)(修改结果|修改后|修改后文本)：/.test(legacyNoteHead);
      // 修复前的备注把归因/查证说明写在了「修改结果：」后面，解析时会并进修改结果；
      // 载入时按行剥掉，避免人工点「写回」把说明写进成品。
      item.revisionText = (Object.prototype.hasOwnProperty.call(value || {}, "revisionText") && !recoverTruncatedRevision
        ? String(value.revisionText || "")
        : parsedRevision)
        .split("\n")
        .filter((line) => !isNoteProseLine(line))
        .join("\n")
        .replace(/\s+$/, "");
      // 存量备注迁移：无需修改或仍待终审的行不该带着自动推导出来的修改结果。
      // 早期版本会把初审/复审的过程稿当成默认修改结果存下来，人工点「批量写回」就会把
      // 已经否掉的方案写进源文件（真实事件：某卷 14 行写回了终审明确「维持原译」的改案）。
      // 只清「正好等于某个阶段改案」的那种自动推导值：用户显式切过版本、或自己写过别的
      // 文本时照旧保留，不碰人工内容。
      const stageProposals = [parsedNote?.stage1Revision, parsedNote?.stage2Revision, parsedNote?.stage3Revision]
        .map((text) => String(text || "").trim())
        .filter(Boolean);
      if (!value?.revisionStageActive && item.revisionText
        && ["否", "待终审"].includes(String(parsedNote?.modify || "").trim())
        && stageProposals.includes(item.revisionText)) {
        item.revisionText = "";
      }
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
      // 终审结论是「不需要修改」的行没有默认修改结果：初审/复审改案只是过程稿，被判
      // 「维持原译」之后再当成待写回的成品，就会把已经否掉的方案写进源文件
      //（真实事件：某卷 14 行写回了被仲裁驳回的初审/复审改案）。用户显式切换过版本走上面第 1 条。
      // 待终审的过程稿也不能自动当作最终修改结果。
      const hasNoDefaultRevision = ["否", "待终审"].includes(String(noteData?.modify || "").trim());
      if (noteData && !hasNoDefaultRevision && (noteData.stage2 || noteData.stage3)) {
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

    // 旧版本存过 smartConcurrency + concurrencyMax：开启智能并发时有效上限是 max(concurrency, concurrencyMax)。
    // 现在只有一个「并发上限」，读到旧存档时折算成它，旧数据不用迁移；下一次保存就只剩 concurrency。
    // 必须对全局与项目两份存档各自折算后再合并：若合并后再折算，一份旧存档遗留的 concurrencyMax 会盖掉另一份新存档里用户刚改的值。
    function foldLegacyConcurrency(config) {
      const { smartConcurrency, concurrencyMax, ...rest } = config;
      if (smartConcurrency === true && concurrencyMax != null && rest.concurrency != null) {
        const merged = Math.max(Number(rest.concurrency) || 0, Number(concurrencyMax) || 0);
        if (merged > 0) rest.concurrency = String(merged);
      }
      return rest;
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
      return { ...foldLegacyConcurrency(globalConfig), ...foldLegacyConcurrency(projectConfig) };
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
        : [];

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
      const groups = presetTools.groupPresets(presets);
      function fillSelect(select, emptyLabel, id, emptyTitle = "") {
        if (!select) return;
        const empty = document.createElement("option");
        empty.value = "";
        empty.textContent = emptyLabel;
        // 空值项就是「新建预设」：它会清空下方配置，动作说明挂在选项提示里。
        if (emptyTitle) empty.title = emptyTitle;
        select.replaceChildren(empty, ...groups.map((group) => {
          const optgroup = document.createElement("optgroup");
          optgroup.label = group.label;
          optgroup.append(...group.presets.map((preset) => {
            const option = document.createElement("option");
            option.value = preset.id;
            option.textContent = presetTools.presetLabel(preset);
            option.title = option.textContent + "（并发上限 " + preset.concurrency + "）";
            return option;
          }));
          return optgroup;
        }));
        select.value = presets.some((preset) => preset.id === id) ? id : "";
        syncEnhancedSelect(select);
      }
      fillSelect(aiIds.presetSelect, "新建预设", selectedId, "清空下方 AI 服务配置，从零填写后点「另存为预设」保存");
      currentPresetId = aiIds.presetSelect.value;
      updatePresetActionButtons();
      fillSelect(aiIds.stage1Preset, "选择预设", stagePresetSelections.stage1[0] || aiIds.stage1Preset?.value || "");
      fillSelect(aiIds.stage2Preset, "选择预设", stagePresetSelections.stage2[0] || aiIds.stage2Preset?.value || "");
      fillSelect(aiIds.stage3Preset, "选择预设", stagePresetSelections.stage3[0] || aiIds.stage3Preset?.value || "");
      renderStagePresetSelection("stage1");
      renderStagePresetSelection("stage2");
      renderStagePresetSelection("stage3");
      const names = [...new Set(presets.map(presetTools.providerName).filter(Boolean))];
      aiIds.provider._syncProviderOptions?.(names);
      updateStagePresetDependencies();
    }

    function updateStagePresetDependencies() {
      const hasStage2 = committedStagePresetIds("stage2").length > 0;
      if (aiIds.stage3Preset) {
        aiIds.stage3Preset.disabled = false;
        if (aiIds.stage3PresetAdd) aiIds.stage3PresetAdd.disabled = false;
        if (aiIds.stage3AppliedTrigger) aiIds.stage3AppliedTrigger.disabled = false;
        aiIds.stage3Preset.title = "选择阶段三候选预设，点击添加后启用";
        aiIds.stage3Card?.classList.remove("is-disabled");
        syncEnhancedSelect(aiIds.stage3Preset);
      }
      const pill2 = document.getElementById("stage2StatusPill");
      if (pill2 && pill2.dataset.state !== "running") {
        pill2.dataset.state = hasStage2 ? "idle" : "disabled";
        pill2.textContent = hasStage2 ? "待命" : "未启用";
      }
      const pill3 = document.getElementById("stage3StatusPill");
      if (pill3 && pill3.dataset.state !== "running") {
        const hasStage3 = committedStagePresetIds("stage3").length > 0;
        pill3.dataset.state = hasStage3 ? "idle" : "disabled";
        pill3.textContent = hasStage3 ? "待命" : "未启用";
      }
      refreshRevisionStagePills();
      setAllStageButtonsRunning();
    }

    function applyPreset(preset) {
      if (!preset) return;
      aiIds.provider.value = presetTools.providerName(preset);
      if (preset.protocol && ["local", "claude", "compatible"].includes(preset.protocol)) {
        aiIds.protocol.value = preset.protocol;
        syncEnhancedSelect(aiIds.protocol);
      }
      if (typeof preset.baseUrl === "string") {
        aiIds.baseUrl.value = preset.baseUrl;
        aiIds.baseUrl.dataset.touched = "1";
      }
      if (typeof preset.apiKey === "string") {
        aiIds.apiKey.value = preset.apiKey;
      }
      const options = [...new Set([...(preset.modelOptions || []), preset.model].filter(Boolean))];
      const metadata = new Map((preset.modelMetadata || []).map((item) => [item.id, item]));
      setModelOptions(options.map((id) => metadata.get(id) || id), { selected: preset.model || "" });
      aiIds.model.dataset.touched = "1";

      const validGptValues = gptReasoningOptions.map(([value]) => value);
      const validIntensityValues = nonGptIntensityOptions.map(([value]) => value);
      savedGptReasoningEffort = validGptValues.includes(preset.gptReasoningEffort) ? preset.gptReasoningEffort : "";
      savedNonGptIntensity = validIntensityValues.includes(preset.nonGptIntensity) ? preset.nonGptIntensity : "";
      updateInferenceSettingOptions();
      const caps = getClientModelCapabilities(preset.model);
      const allowed = caps.reasoning ? buildReasoningOptions(caps) : nonGptIntensityOptions;
      aiIds.reasoningEffort.value = allowed.some(([value]) => value === preset.reasoningEffort) ? preset.reasoningEffort : "";
      rememberInferenceSetting();
      syncEnhancedSelect(aiIds.reasoningEffort);
      if (preset.concurrency != null) {
        aiIds.concurrency.value = preset.concurrency;
      }
      currentPresetId = preset.id;
      if (aiIds.presetSelect) aiIds.presetSelect.value = preset.id;
      syncEnhancedSelect(aiIds.presetSelect);
      updatePresetActionButtons();
      saveAiConfig();
    }

    // 地址被清空后旧模型列表与能力缓存一起作废，否则同名模型会带着上一条连接的思考档位。
    // 保留「自定义...」入口：接口没列出模型名时，用户仍能在这里手填。
    function clearModelOptions() {
      aiModelOptions = [];
      aiModelMetadataMap.clear();
      const blank = document.createElement("option");
      blank.value = "";
      blank.textContent = "";
      const custom = document.createElement("option");
      custom.value = "custom";
      custom.textContent = "自定义...";
      aiIds.model.replaceChildren(blank, custom);
      aiIds.model.value = "";
      aiIds.model.dataset.touched = "";
      syncEnhancedSelect(aiIds.model);
      updateInferenceSettingOptions();
    }

    // 「新建预设」：清空 AI 服务区域，让用户从零填写一条连接，再点「另存为预设」保存。
    // 没有空值语义的控件回落到各自默认档——接口类型 → 本地默认、推理强度 → 模型默认、
    // 并发上限 → 默认值（留空会被折算成 1，等于静默降速）。
    function clearPresetFields() {
      aiIds.provider.value = "";
      aiIds.protocol.value = "local";
      syncEnhancedSelect(aiIds.protocol);
      setProtocolHint(protocolDefaults.local);
      // 清空后的地址必须标记为已手改：否则状态轮询会用本地默认地址把它填回来。
      aiIds.baseUrl.value = "";
      aiIds.baseUrl.dataset.touched = "1";
      aiIds.apiKey.value = "";
      savedGptReasoningEffort = "";
      savedNonGptIntensity = "";
      clearModelOptions();
      aiIds.concurrency.value = String(AI_CONCURRENCY_DEFAULT);
      // 清空结果立即落盘：刷新页面不能把上一条连接的地址与 Key 悄悄带回来。
      saveAiConfig();
    }

    function saveAiConfig() {
      rememberInferenceSetting();
      const prevSaved = loadSavedAiConfig();
      const config = {
        protocol: aiIds.protocol ? aiIds.protocol.value : (prevSaved.protocol || ""),
        provider: String(aiIds.provider?.value || "").trim(),
        baseUrl: aiIds.baseUrl ? aiIds.baseUrl.value : (prevSaved.baseUrl || ""),
        model: aiIds.model ? aiIds.model.value : (prevSaved.model || ""),
        reasoningEffort: aiIds.reasoningEffort ? aiIds.reasoningEffort.value : (prevSaved.reasoningEffort || ""),
        inferenceSettingVersion: 3,
        gptReasoningEffort: savedGptReasoningEffort,
        nonGptIntensity: savedNonGptIntensity,
        modelOptions: aiModelOptions,
        modelMetadata: sanitizeModelMetadata([...aiModelMetadataMap.values()]),
        modelOptionsBaseUrl: aiModelOptions.length && aiIds.baseUrl ? normalizeApiBaseUrl(aiIds.baseUrl.value) : (prevSaved.modelOptionsBaseUrl || ""),
        apiKey: aiIds.apiKey ? aiIds.apiKey.value : (prevSaved.apiKey || ""),
        proofreadMode: aiIds.proofreadMode ? aiIds.proofreadMode.value : (prevSaved.proofreadMode || ""),
        target: aiIds.target ? aiIds.target.value : (prevSaved.target || ""),
        profileId: aiIds.profile ? aiIds.profile.value : (prevSaved.profileId || ""),
        concurrency: aiIds.concurrency ? aiIds.concurrency.value : (prevSaved.concurrency != null ? prevSaved.concurrency : "3"),
        similarity: prefilterIds.similarity ? formatPercentRatio(prefilterIds.similarity.value) : (prevSaved.similarity || "92%"),
        promptVisible: Boolean(aiIds.promptVisible?.checked),
        currentPresetId: currentPresetId || "",
        stage1PresetIds: committedStagePresetIds("stage1"),
        stage2PresetIds: committedStagePresetIds("stage2"),
        stage3PresetIds: committedStagePresetIds("stage3"),
      };
      localStorage.setItem(aiConfigStorageKey, JSON.stringify(config));
      if (projectAiConfigStorageKey) {
        localStorage.setItem(projectAiConfigStorageKey, JSON.stringify(config));
      }
      setAllStageButtonsRunning();
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
      if (saved.protocol && protocolDefaults[saved.protocol]) aiIds.protocol.value = saved.protocol;
      aiIds.provider.value = presetTools.providerName(saved);
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
      stagePresetSelections.stage1 = Array.isArray(saved.stage1PresetIds) ? saved.stage1PresetIds.filter((id) => presetTools.getPreset(localStorage, id)) : (saved.stage1PresetId && presetTools.getPreset(localStorage, saved.stage1PresetId) ? [saved.stage1PresetId] : []);
      stagePresetSelections.stage2 = Array.isArray(saved.stage2PresetIds) ? saved.stage2PresetIds.filter((id) => presetTools.getPreset(localStorage, id)) : (saved.stage2PresetId && presetTools.getPreset(localStorage, saved.stage2PresetId) ? [saved.stage2PresetId] : []);
      stagePresetSelections.stage3 = Array.isArray(saved.stage3PresetIds) ? saved.stage3PresetIds.filter((id) => presetTools.getPreset(localStorage, id)) : (saved.stage3PresetId && presetTools.getPreset(localStorage, saved.stage3PresetId) ? [saved.stage3PresetId] : []);
      if (aiIds.stage1Preset) aiIds.stage1Preset.value = stagePresetSelections.stage1[0] || "";
      if (aiIds.stage2Preset) aiIds.stage2Preset.value = stagePresetSelections.stage2[0] || "";
      if (aiIds.stage3Preset) aiIds.stage3Preset.value = stagePresetSelections.stage3[0] || "";
      renderStagePresetSelection("stage1");
      renderStagePresetSelection("stage2");
      renderStagePresetSelection("stage3");
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

    // 右上角的固定状态行已移除（连同那条全局进度条）：机器任务的持续状态改由阶段卡片承载——
    // 每阶段一条进度条 + 状态胶囊 + 指标行，按阶段推进的流水线在哪一环卡住一眼能看出来。
    // 这里只报「用户不知道的异常与副产物」（未连接服务、被跳过/忽略的结果）。用户自己刚点的动作
    // （正在启动/终止/清除）不播报——它们完成时都有结果提示；每轮都在变的运行统计也不播报——
    // 调用数一直在涨，走 Toast 会持续刷屏，而阶段卡片已经完整表达了同一件事。
    let aiCacheCleared = false;

    function reportRuntimeNotice(message) {
      showToast(message);
    }

    // ---- 浮动提示（Toast）----
    // 按钮与控件的一次性回执走这里。这类消息原先写进 AI 抽屉里的固定状态行，而五个抽屉默认全部折叠，
    // 用户在「筛选与批处理」里点批量按钮、在行内点「写回」时，回执被写进一个看不见的位置。
    // 一次性回执与异常说明一律浮动提示；持续状态由阶段卡片承载。
    // 实现抽到共享的 public/workbench-shared.js：说话人归属工作台用同一份，行为不会再各自漂移。
    const toastCenter = createToastCenter();
    const showToast = toastCenter.showToast;
    const dismissToast = toastCenter.dismissToast;
    const toasts = toastCenter.toasts;
    // 本页亲眼看到「正在运行」的那一轮：只有它跑完才弹结束提示。页面刚打开时从服务端认领到的
    // 历史轮次（没看到运行中）不弹，否则每次重新生成工作台都会收到一条过期回执。
    let observedRunningRunId = "";
    let notifiedFinishedRunId = "";

    function clearLocalAiCache() {
      renderAiCacheMetrics();
      aiResultReception.resetReception();
      aiActiveIds.clear();
      activeRowId = "";
      resetStageProgressBars();
      updateRenderedAiActive();
    }

    function renderClearedAiStatus(message = "已清除 AI 运行记录；备注与人工确认已保留。") {
      renderAiCacheMetrics();
      setAllStageButtonsRunning(false);
      prefilterIds.start.disabled = false;
      prefilterIds.confirm.disabled = true;
      prefilterIds.stop.disabled = true;
      prefilterIds.stats.textContent = "尚未运行预筛选。";
      if (prefilterIds.panelState) prefilterIds.panelState.textContent = "尚未运行";
      if (aiIds.panelState) {
        aiIds.panelState.textContent = "就绪";
        aiIds.panelState.className = "ai-status-badge";
      }
      aiCacheCleared = true;
      reportRuntimeNotice(message);
      resetStageProgressBars();
      aiActiveIds.clear();
      prefilterResultIds.clear();
      prefilterRunId = "";
      prefilterResultFilterActive = false;
      prefilterResultsCatchingUp = false;
      updateRenderedAiActive();
      applyFilters({ reset: false });
    }

    function initProviderCombobox() {
      const input = aiIds.provider;
      const wrapper = document.getElementById("aiProviderCombobox");
      const toggle = document.getElementById("aiProviderToggle");
      const menu = aiIds.providerNames;
      if (!input || !wrapper || !toggle || !menu) return;
      let names = [];
      let items = [];
      let activeIndex = -1;

      function close() {
        menu.hidden = true;
        wrapper.classList.remove("is-open", "drop-up");
        input.setAttribute("aria-expanded", "false");
        toggle.setAttribute("aria-expanded", "false");
        input.removeAttribute("aria-activedescendant");
        activeIndex = -1;
      }
      function render(filter = false) {
        const query = filter ? input.value.trim().toLocaleLowerCase() : "";
        items = names.filter((name) => name.toLocaleLowerCase().includes(query)).map((name, index) => {
          const option = document.createElement("button");
          option.type = "button";
          option.tabIndex = -1;
          option.id = "aiProviderOption-" + index;
          option.className = "select-option";
          option.value = name;
          option.textContent = name;
          option.setAttribute("role", "option");
          const selected = name === input.value.trim();
          option.classList.toggle("is-selected", selected);
          option.setAttribute("aria-selected", String(selected));
          option.addEventListener("click", () => {
            input.value = name;
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.dispatchEvent(new Event("change", { bubbles: true }));
            close();
            input.focus();
          });
          return option;
        });
        menu.replaceChildren(...items);
        if (!items.length) {
          const empty = document.createElement("div");
          empty.className = "provider-menu-empty";
          empty.textContent = query ? "无匹配项，可直接使用输入的名称。" : "尚无已保存的提供商，可直接输入名称。";
          menu.append(empty);
        }
        activeIndex = -1;
        input.removeAttribute("aria-activedescendant");
      }
      function open(filter = false) {
        if (input.disabled) return;
        closeAllSelects(wrapper);
        render(filter);
        const rect = input.getBoundingClientRect();
        wrapper.classList.toggle("drop-up", window.innerHeight - rect.bottom < 160 && rect.top > window.innerHeight - rect.bottom);
        wrapper.classList.add("is-open");
        menu.hidden = false;
        input.setAttribute("aria-expanded", "true");
        toggle.setAttribute("aria-expanded", "true");
      }
      function activate(index) {
        if (!items.length) return;
        activeIndex = Math.max(0, Math.min(items.length - 1, index));
        items.forEach((item, i) => item.classList.toggle("is-active", i === activeIndex));
        const active = items[activeIndex];
        input.setAttribute("aria-activedescendant", active.id);
        if (active.offsetTop < menu.scrollTop) menu.scrollTop = active.offsetTop;
        const bottom = active.offsetTop + active.offsetHeight;
        if (bottom > menu.scrollTop + menu.clientHeight) menu.scrollTop = bottom - menu.clientHeight;
      }
      input._syncProviderOptions = (values) => {
        names = values;
        render(!menu.hidden);
      };
      wrapper._closeSelect = close;
      toggle.addEventListener("click", () => {
        if (menu.hidden) open();
        else close();
        input.focus();
      });
      menu.addEventListener("mousedown", (event) => event.preventDefault());
      input.addEventListener("input", (event) => { if (!event.isComposing) open(true); });
      input.addEventListener("keydown", (event) => {
        if (event.isComposing) return;
        if (event.key === "Escape" || event.key === "Tab") {
          close();
          return;
        }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (menu.hidden) open();
          activate(activeIndex < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
            : activeIndex + (event.key === "ArrowDown" ? 1 : -1));
        } else if (event.key === "Enter" && !menu.hidden) {
          event.preventDefault();
          if (activeIndex >= 0) items[activeIndex].click();
          else close();
        }
      });
      wrapper.addEventListener("focusout", (event) => {
        if (!wrapper.contains(event.relatedTarget)) close();
      });
      close();
    }

    function enhanceSelect(select) {
      if (!select || select.dataset.enhanced) return;
      select.dataset.enhanced = "1";
      select.classList.add("enhanced-select");
      // 原生 select 已被视觉隐藏（1×1px、opacity:0），但它仍然留在 Tab 序列里：键盘用户会先
      // 聚焦到一个完全看不见的控件，再 Tab 一次才轮到真正可见的 trigger——每个下拉都是这样
      // 一个「看得见焦点却看不到控件」的停靠点。这里把它从 Tab 序列与可访问树里摘掉，
      // 只保留 trigger；程序化读写 select.value / 派发 change 都不受影响。
      select.tabIndex = -1;
      select.setAttribute("aria-hidden", "true");

      const wrapper = document.createElement("div");
      wrapper.className = "select-combobox";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "select-trigger";
      trigger.setAttribute("aria-haspopup", "listbox");
      trigger.setAttribute("aria-expanded", "false");
      // 原生 select 已从可访问树摘掉，它关联的 <label> 不会再被读到：把标签文本搬给 trigger，
      // 键盘与读屏用户仍然知道这个下拉在选什么。
      const triggerLabel = String(select.labels?.[0]?.textContent || "").trim();
      if (triggerLabel) trigger.setAttribute("aria-label", triggerLabel);
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
        let previousGroup = null;
        menu.replaceChildren(...Array.from(select.options).flatMap((option) => {
          const nodes = [];
          const group = option.parentNode?.tagName === "OPTGROUP" ? option.parentNode : null;
          if (group && group !== previousGroup) {
            const heading = document.createElement("div");
            heading.className = "select-option-group";
            heading.textContent = group.label;
            heading.setAttribute("role", "presentation");
            nodes.push(heading);
          }
          previousGroup = group;
          const item = document.createElement("button");
          item.type = "button";
          item.className = "select-option";
          item.setAttribute("role", "option");
          item.dataset.value = option.value;
          item.textContent = option.textContent;
          item.title = option.title || option.textContent;
          if (option.value === select.value) {
            item.classList.add("is-selected");
            item.setAttribute("aria-selected", "true");
          } else {
            item.setAttribute("aria-selected", "false");
          }
          item.disabled = option.disabled || Boolean(group?.disabled);
          return [...nodes, item];
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
        if (wrapper._closeSelect) { wrapper._closeSelect(); continue; }
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
        const hasStage2 = Boolean(noteData?.stage2);
        const hasStage3 = Boolean(noteData?.stage3);
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
      const str = latestAiNotePart(note);
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
      const lines = splitNoteFields(note);
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
      const failureLines = new Set(Object.values(stageNoteState(note).errors));
      for (const line of lines.slice(1)) {
        if (failureLines.has(line)) {
          data.analysis = [data.analysis, line].filter(Boolean).join("\n");
          currentField = "";
        } else if (line.startsWith("语义是否相同：")) {
          data.semantic = line.slice("语义是否相同：".length).trim();
          currentField = "";
        } else if (line.startsWith("是否需要修改：")) {
          data.modify = line.slice("是否需要修改：".length).trim();
          currentField = "";
        } else if (line === "快速直通：是") {
          data.fastPass = true;
          currentField = "";
        } else if (line.startsWith("Gatekeeper初审：")) {
          data.stage1 = line.slice("Gatekeeper初审：".length).trim();
          currentField = "";
        } else if (line.startsWith("初审改案：") || line.startsWith("初审建议：")) {
          data.stage1Revision = line.replace(/^(初审改案|初审建议)：/, "").trim();
          currentField = "";
        } else if (line.startsWith("Stylist复审")) {
          const match = line.match(/^Stylist复审(?:\[(.*?)\])?：([\s\S]*)$/);
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
          const match = line.match(/^Arbiter仲裁(?:\[(.*?)\])?：([\s\S]*)$/);
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

      // 只有非局部提议的完整全量改案，才允许在下游阶段**采纳**时向下游传播。
      // 明确驳回/维持原译/存疑时绝不回填：把被否掉的改案当成下游阶段的定案，既会让
      // 「分步演进明细」把否掉的方案画成终审定案，也会让它变成默认修改结果被写回成品
      //（真实事件：某卷 14 行写回了终审明确「维持原译」的初审/复审改案）。
      const stage2Rejected = /驳回|维持原译|无需修改|存疑/.test(String(data.stage2?.attitude || ""));
      if (data.stage2 && !data.stage2Revision) {
        if (data.stage2.attitude.includes("采纳") && data.stage1Revision && !isS1Partial) {
          data.stage2Revision = data.stage1Revision;
        } else if (!data.stage3 && data.revision && !isRevPartial) {
          data.stage2Revision = data.revision;
        } else if (!stage2Rejected && data.stage1Revision && !isS1Partial) {
          data.stage2Revision = data.stage1Revision;
        }
      }
      // 终审「维持原译」「驳回」「存疑待定」都表示它没有采纳任何上游改案。
      const stage3Rejected = /维持原译|驳回|存疑/.test(String(data.stage3?.winner || ""));
      if (data.stage3 && !data.stage3Revision) {
        if (data.revision && !isRevPartial) {
          data.stage3Revision = data.revision;
        } else if (!stage3Rejected && data.stage2Revision && !isS2Partial) {
          data.stage3Revision = data.stage2Revision;
        } else if (!stage3Rejected && data.stage1Revision && !isS1Partial) {
          data.stage3Revision = data.stage1Revision;
        }
      }

      // 默认版本显示逻辑：最后阶段的版本优先（仲裁 ＞ 复审 ＞ 初审）。
      // 安全红线：局部提议（isPartialProposal）绝不能直接作为全量成品文本覆盖 data.revision！
      // 无需修改或仍待终审的行都没有默认成品改案，过程稿不能自动成为修改结果。
      const hasNoDefaultRevision = ["否", "待终审"].includes(String(data.modify || "").trim());
      if (hasNoDefaultRevision) {
        data.revision = "";
      } else if (data.stage3 && (data.stage3Revision || data.revision)) {
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

    // 复审与初审产生立场或方案分歧的判据：阶段二卡片「分歧」、阶段三「待仲裁」、
    // 「待终审仲裁」筛选与「启动 AI 校对」弹窗共用这一份，避免同一批行各处各说各话。
    function isStage2DivergedNote(parsed, noteText = "") {
      return stageNoteState(noteText).diverged;
    }

    function getStage3RowStatus(item) {
      if (!item || item.manualDone) return { isArbitrated: false, isPending: false, isRelevant: false };
      const text = latestAiNotePart(item.note).trim();
      if (!text || !hasAutomatedDecisionNote(text)) return { isArbitrated: false, isPending: false, isRelevant: false };
      const p = parseAutomatedNote(text);
      if (!p) return { isArbitrated: false, isPending: false, isRelevant: false };

      const state = stageNoteState(text);
      const hasS3 = state.arbitrated;
      if (hasS3) {
        return { isArbitrated: true, isPending: false, isRelevant: true };
      }

      if (state.pendingArbitration) {
        return { isArbitrated: false, isPending: true, isRelevant: true };
      }

      return { isArbitrated: false, isPending: false, isRelevant: false };
    }

    function getStage2RowStatus(item) {
      if (!item || item.manualDone) return { isReviewed: false, isPending: false, isRelevant: false };
      const state = stageNoteState(item.note);
      return { isReviewed: state.reviewed, isPending: state.pendingReview,
        isRelevant: state.candidate || state.reviewed };
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

    // 版本切换与执行待办是两种状态：只有真实阶段稿能切换，待执行阶段只占位。
    // 渲染与点击共用此处，禁止拿通用「修改结果」冒充尚未执行的下游方案。
    function revisionStageChoices(item, note, targetText = "") {
      if (!note) return [];
      const state = stageNoteState(item?.note || "");
      const pendingReview = !item?.manualDone && state.pendingReview;
      const pendingArbitration = !item?.manualDone && state.pendingArbitration;
      const choices = [
        { stage: "1", label: "初审", cls: "is-gk", name: "阶段一事实初审", present: Boolean(note.stage1 || note.stage1Revision || (!note.stage2 && !note.stage3 && note.revision)),
          text: note.stage1Revision || (!note.stage2 && !note.stage3 ? note.revision : ""), pending: false },
        { stage: "2", label: "复审", cls: "is-stylist", name: "阶段二文学复审", present: Boolean(note.stage2),
          text: state.reviewed ? note.stage2Revision : "", pending: pendingReview && committedStagePresetIds("stage2").length > 0 },
        { stage: "3", label: "终审", cls: "is-arbiter", name: "阶段三终审仲裁", present: Boolean(note.stage3),
          text: state.arbitrated ? note.stage3Revision : "", pending: pendingArbitration && committedStagePresetIds("stage3").length > 0 },
      ];
      if (!choices.some((choice) => choice.text || choice.pending)) return [];
      return choices.filter((choice) => choice.present || choice.pending).map((choice) => {
        const text = String(choice.text || "").trim();
        const partial = isPartialProposal(text, targetText, item?.note || "", { isInitialProposal: choice.stage === "1" });
        const disabled = !text || partial;
        const title = choice.pending ? choice.name + "尚未完成，暂无可切换版本"
          : partial ? choice.name + "仅提供局部修正，请在差异辅助中查看"
          : !text ? choice.name + "未提供可用的完整修改文本"
          : "切换为" + choice.name + "文本";
        return { ...choice, text, disabled, title };
      });
    }

    function renderRevisionStagePills(item, id, note, targetText, revisionText) {
      const choices = revisionStageChoices(item, note, targetText);
      if (!choices.length) return "";
      const matching = choices.filter((choice) => !choice.disabled && choice.text === String(revisionText || "").trim());
      const active = matching.find((choice) => choice.stage === String(item?.revisionStageActive)) || matching.at(-1);
      return '<div class="revision-stage-pills" data-row-id="' + escapeHtml(id || "") + '" title="在不同阶段的修改版本间快速切换">' +
        '<span class="stage-pills-label">版本:</span>' + choices.map((choice) =>
          '<button type="button" class="stage-pill-btn ' + choice.cls + (active === choice ? ' is-active' : '') + '" data-apply-stage="' + choice.stage + '" data-row-id="' + escapeHtml(id || "") + '" title="' + escapeHtml(choice.title) + '"' +
          (choice.disabled ? ' disabled="" aria-disabled="true"' : '') + '>' + choice.label + '</button>'
        ).join("") + '</div>';
    }

    // 增删适用预设只更新版本栏，不重建编辑器、审核轨迹或整张表格。
    const revisionStagePillsCache = new WeakMap();
    function refreshRevisionStagePills() {
      for (const [id, row] of renderedRowsById) {
        const item = notes[id];
        const sourceRow = rowsById.get(id);
        const targetText = String(sourceRow?.[revisionTargetFor(item)] || sourceRow?.cn || "");
        const note = parseAutomatedNote(item?.note || "", targetText);
        const slot = row.querySelector("[data-revision-stage-slot]");
        if (slot) {
          const html = renderRevisionStagePills(item, id, note, targetText, revisionTextFor(item, sourceRow));
          if ((revisionStagePillsCache.get(slot) ?? slot.innerHTML) !== html) slot.innerHTML = html;
          revisionStagePillsCache.set(slot, html);
        }
      }
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
        // 兼容旧版存疑结论；当前终审成功后只会判断修改或不改。
        const isPendingArbiter = note.modify === "待终审";
        const isUnresolved = isNeedsCheck || isPendingArbiter;
        const s2Attitude = note.stage2?.attitude || (isUnresolved && !note.stage2 ? "待定" : "复审");
        let attCls = "is-stylist";
        if (s2Attitude.includes("采纳") || s2Attitude === "accept") attCls = "is-accept";
        else if (s2Attitude.includes("调整") || s2Attitude === "modify") attCls = "is-modify";
        else if (s2Attitude.includes("驳回") || s2Attitude === "reject") attCls = "is-reject";
        else if (s2Attitude.includes("仲裁") || s2Attitude.includes("escalate")) attCls = "is-arbiter";

        const rawWinner = note.stage3?.winner || (isUnresolved && note.stage3 ? "存疑待定" : "仲裁");
        const s3Winner = formatWinnerLabel(rawWinner);

        // 未定案记录默认展开各阶段审查记录，便于继续审核。
        // 去重契约：阶段卡片只承载「审查意见」，各阶段改案全文只在左侧差异辅助（修改结果对比 +
        // 分步演进明细）与「修改结果」区呈现一次；卡片里再打印一遍是纯粹的重复噪音。
        // 用户手动开合过这一行就以他的选择为准，否则沿用"待判行默认展开"。
        const defaultOpen = pipelineDefaultOpen(id, isUnresolved);
        const expandHintText = defaultOpen ? "审核轨迹 ▴" : "审核轨迹 ▾";

        let stepsHtml = '<span class="pipeline-step is-gk">初审</span>';
        if (note.stage2) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step ' + attCls + '">复审·' + escapeHtml(s2Attitude) + '</span>';
        } else if (isUnresolved && !note.stage3) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step is-pending-step" title="初审存疑，等待文学复审接力">待复审</span>';
        }
        if (note.stage3) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step is-arbiter">仲裁·' + escapeHtml(s3Winner) + '</span>';
        }
        if (isNeedsCheck) {
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step is-final-check" title="旧版存疑结果尚未定案，可重新运行审核，终审将判断修改或不改">未定案记录</span>';
        } else if (isPendingArbiter && note.stage2) {
          // 没走复审的行上面已经标了「待复审」——它还没到终审那一步，不必再叠一个「待终审」。
          stepsHtml += '<span class="pipeline-arrow">➔</span><span class="pipeline-step is-pending-step" title="流水线还没走到终审仲裁，这一行等着终审定案；当前未启用终审仲裁，或它没被送进终审">待终审</span>';
        }

        pipelineHtml = '<div class="stage-pipeline-badge" data-pipeline-toggle="' + escapeHtml(id || "") + '" role="button" tabindex="0" aria-expanded="' + (defaultOpen ? "true" : "false") + '" title="点击展开/收起多阶段审核轨迹（回车或空格同样有效）">' +
          stepsHtml +
          '<span class="pipeline-expand-hint">' + expandHintText + '</span>' +
        '</div>' +
        '<div class="stage-pipeline-details" id="pipelineDetails_' + escapeHtml(id || "") + '"' + (defaultOpen ? '' : ' hidden') + '>' +
          (note.stage1 ? ('<div class="stage-report-card is-gk"><div class="stage-report-header"><span>🛡️ 阶段一：事实初审</span>' + (note.stage1Revision ? '<span class="stage-report-tag is-modify">提改</span>' : (isUnresolved && !note.stage2 ? '<span class="stage-report-tag is-unclear">存疑</span>' : '')) + '</div><div class="stage-report-body">' + escapeHtml(note.stage1) + '</div></div>') : '') +
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

      const stagePillsHtml = '<div data-revision-stage-slot="' + escapeHtml(id || "") + '">' +
        renderRevisionStagePills(item, id, note, rowTargetText, revisionText) + '</div>';

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
        : stagePillsHtml;
      
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
        '<div class="note-summary-line"><span class="note-summary-key">修改</span><span class="note-summary-value">' + escapeHtml(["待人工确认", "人工确认"].includes(note.modify) ? "未定案记录" : (note.modify || "待判定")) + '</span></div>' +
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
      const fromNote = Boolean(noteText);
      const verdict = fromNote ? "" : (termVerdicts.get(id) || "");
      const states = {
        conflict: {
          label: "术语冲突", badgeClass: "is-modify",
          hint: "本行原文命中的术语与译文写法不一致（或整条没译出来）；冲突作为提示词注入，由模型结合整句判断。",
        },
        "term-only": {
          label: "纯术语", badgeClass: "is-same",
          hint: "本行有效内容全部是项目术语，对照表能给出完整结论；跑预筛选时不会调用模型。",
        },
        injected: {
          label: "术语注入", badgeClass: "is-unclear",
          hint: "术语一致但句中还有其他内容；命中术语会注入提示词，整句仍交给模型判定。",
        },
      };
      const state = states[verdict];
      const pairs = termEntries.get(id);
      // 旧快照可能只有判定而没有术语清单，保留状态但不提供空的展开入口。
      if (!pairs || !pairs.length) {
        return state ? '<span class="ai-confirm-badge ' + state.badgeClass + '" title="' + escapeHtml("构建期预判：" + state.hint) + '">' + state.label + '</span>' : "";
      }
      const cap = 8;
      const lines = pairs.slice(0, cap).map((pair) => "- " + pair);
      if (pairs.length > cap) lines.push("- …（其余 " + (pairs.length - cap) + " 条见对照表）");
      const source = fromNote
        ? "备注已出（术语清单来自对照表）：命中 " + pairs.length + " 条术语"
        : "构建期判定：本行原文命中对照表 " + pairs.length + " 条术语";
      const title = [source, state ? "构建期预判：" + state.hint : "", ...lines].filter(Boolean).join("\n");
      const open = termOpenRows.has(id);
      const listId = "term-list-" + id;
      return '<button type="button" class="term-chip' + (state ? " is-" + verdict : "") + '" data-term-chip="' + id + '" aria-expanded="' + open + '" aria-controls="' + listId + '" title="' + escapeHtml(title) + '">' +
        '<span class="term-chip-label">' + (state?.label || "术语") + '</span><span class="term-chip-count">' + pairs.length + '</span>' +
        (state ? "" : '<span class="term-chip-state">' + (fromNote ? "结论" : "预判") + '</span>') +
        '<span class="term-chip-chevron" aria-hidden="true"></span></button>' +
        '<ul id="' + listId + '" class="term-chip-list" data-term-list="' + id + '" aria-label="本行命中术语"' + (open ? "" : " hidden") + '>' + pairs.map((pair) => '<li>' + escapeHtml(pair) + '</li>').join("") + '</ul>';
    }

    function setTermOpen(id, open) {
      const row = renderedRow(id);
      const button = row?.querySelector('[data-term-chip]');
      const list = row?.querySelector('[data-term-list]');
      if (!button || !list) return;
      if (open) termOpenRows.add(id);
      else termOpenRows.delete(id);
      button.setAttribute("aria-expanded", String(open));
      list.hidden = !open;
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
      // 人工确认靠左，AI 与特色徽标聚组靠右；术语入口紧邻徽标，清单在组外占备注列整宽。
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
        verifyBadge,
        '</div>',
        '<div class="term-chip-slot" data-term-chip-slot="' + id + '">' + termChip + '</div>',
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
      // 判定、清单与开合统一渲染，备注回包后不会残留预判徽标或收起用户正在看的清单。
      const termChipSlot = rendered?.querySelector('[data-term-chip-slot]');
      if (termChipSlot) {
        const html = renderTermChipHtml(id, notes[id]?.note || "");
        if ((termChipHtmlCache.get(termChipSlot) ?? termChipSlot.innerHTML) !== html) {
          const hadFocus = termChipSlot.contains(document.activeElement);
          termChipSlot.innerHTML = html;
          if (hadFocus) termChipSlot.querySelector('[data-term-chip]')?.focus();
        }
        termChipHtmlCache.set(termChipSlot, html);
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

    // 待终审与兼容的未定案记录都进「待判」，顶部徽章仍各自筛选。
    function isPendingArbiterRow(row) {
      const note = parseAutomatedNote(notes[String(row.index)]?.note || "");
      return note?.modify === "待终审";
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
      prefilterResultFilter.disabled = !prefilterRunId;
      prefilterResultFilter.checked = prefilterResultFilterActive;
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
      const isStage2PendingRow = (r) => {
        return getStage2RowStatus(notes[String(r.index)]).isPending;
      };
      const isStage3PendingRow = (r) => {
        const rowId = String(r.index);
        return getStage3RowStatus(notes[rowId]).isPending;
      };
      const matchesSummary = !activeSummaryFilter ||
        (activeSummaryFilter === "needsEdit" && aiResultState(row) === "modify") ||
        (activeSummaryFilter === "unchanged" && aiResultState(row) === "same") ||
        (activeSummaryFilter === "needsCheck" && aiResultState(row) === "unclear" && !isPendingArbiterRow(row)) ||
        (activeSummaryFilter === "pendingArbiter" && isPendingArbiterRow(row)) ||
        (activeSummaryFilter === "stage2Pending" && isStage2PendingRow(row)) ||
        (activeSummaryFilter === "stage3Pending" && isStage3PendingRow(row)) ||
        Boolean(computeStageMetricsFromNotes().metricRowIds[activeSummaryFilter]?.has(id));
      const matchesPrefilterResult = !prefilterResultFilterActive || prefilterResultIds.has(id);
      return matchesQuery && matchesSeverity && matchesAiResult && matchesIssueSeverity && matchesNotes && matchesDone && matchesPrefilterResult && matchesSummary;
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
      const termButton = event.target.closest("[data-term-chip]");
      if (termButton) {
        event.preventDefault();
        event.stopPropagation();
        setTermOpen(termButton.dataset.termChip, termButton.getAttribute("aria-expanded") !== "true");
        return;
      }
      const applyStageBtn = event.target.closest("[data-apply-stage]");
      if (applyStageBtn) {
        event.preventDefault();
        event.stopPropagation();
        if (applyStageBtn.disabled) return;
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
          // 开合状态同步给辅助技术与键盘用户（徽标是 role="button" 的可聚焦元素）。
          pipelineBtn.setAttribute("aria-expanded", String(!details.hidden));
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

    // 行内「审核轨迹」徽标是 role="button" 的可聚焦元素：键盘要用 Enter/空格能打开，
    // 否则多阶段审核卡片只有鼠标用户看得到。这里直接复用 click 路径，避免两套逻辑漂移。
    tbody.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      const pipelineBtn = event.target.closest?.("[data-pipeline-toggle]");
      if (!pipelineBtn || typeof pipelineBtn.click !== "function") return;
      event.preventDefault();
      pipelineBtn.click();
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
    prefilterResultFilter.addEventListener("change", () => {
      prefilterResultFilterActive = prefilterResultFilter.checked;
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

    let activeSummaryFilter = null;
    const summaryFilterItems = [
        { id: "aiStageSummaryNeedsEdit", filter: "needsEdit", name: "最终建议修改" },
        { id: "aiStageSummaryUnchanged", filter: "unchanged", name: "无需修改" },
        { id: "aiStageSummaryNeedsCheck", filter: "needsCheck", name: "未定案记录" },
        { id: "aiStageSummaryPendingArbiter", filter: "pendingArbiter", name: "待终审" },
        { id: "stage1PassedItem", filter: "stage1Passed", name: "初审通过", nativeButton: true },
        { id: "stage1NeedsEditItem", filter: "stage1NeedsEdit", name: "初审提改", nativeButton: true },
        { id: "stage1UnclearPill", filter: "stage1Unclear", name: "初审存疑", nativeButton: true },
        { id: "stage1FastPassItem", filter: "fastPassHits", name: "快速直通", nativeButton: true },
        { id: "stage1TotalItem", filter: "stage1Total", name: "初审总检", nativeButton: true },
        { id: "stage1ErrorItem", filter: "stage1Errors", name: "初审异常", nativeButton: true },
        { id: "stage2ReviewedItem", filter: "stage2Reviewed", name: "文学复审", nativeButton: true },
        { id: "stage2DivergedItem", filter: "stage2Diverged", name: "复审分歧", nativeButton: true },
        { id: "stage2AcceptItem", filter: "critiqueAccept", name: "复审采纳", nativeButton: true },
        { id: "stage2ModifyItem", filter: "critiqueModify", name: "复审调整", nativeButton: true },
        { id: "stage2RejectItem", filter: "critiqueReject", name: "复审驳回", nativeButton: true },
        { id: "stage2EscalateItem", filter: "critiqueEscalate", name: "复审升级仲裁", nativeButton: true },
        { id: "stage2PendingItem", filter: "stage2Pending", name: "待文学复审", nativeButton: true },
        { id: "stage2ErrorItem", filter: "stage2Errors", name: "复审异常", nativeButton: true },
        { id: "stage3ArbitratedItem", filter: "stage3Arbitrated", name: "终审仲裁", nativeButton: true },
        { id: "stage3GatekeeperItem", filter: "arbitrationGatekeeper", name: "采用初审方案", nativeButton: true },
        { id: "stage3StylistItem", filter: "arbitrationStylist", name: "采用复审方案", nativeButton: true },
        { id: "stage3SynthesisItem", filter: "arbitrationSynthesis", name: "综合方案", nativeButton: true },
        { id: "stage3OriginalItem", filter: "arbitrationOriginal", name: "维持原译", nativeButton: true },
        { id: "stage3PendingItem", filter: "stage3Pending", name: "待终审仲裁", nativeButton: true },
        { id: "stage3ErrorItem", filter: "stage3Errors", name: "仲裁异常", nativeButton: true },
      ];

    function syncSummaryFilterButtons() {
      for (const { id, filter } of summaryFilterItems) {
        const el = document.getElementById(id);
        if (!el) continue;
        const active = activeSummaryFilter === filter;
        el.classList.toggle("is-active", active);
        el.setAttribute("aria-pressed", String(active));
      }
    }

    function bindSummaryFilters() {
      summaryFilterItems.forEach(({ id, filter, name, nativeButton }) => {
        const el = document.getElementById(id);
        if (!el) return;
        const trigger = () => {
          if (activeSummaryFilter === filter) {
            activeSummaryFilter = null;
            showToast("已取消" + name + "筛选", { tone: "info", durationMs: 2500 });
          } else {
            activeSummaryFilter = filter;
            showToast("已筛选" + name + "行（再次点击可取消）", { tone: "info", durationMs: 3000 });
          }
          syncSummaryFilterButtons();
          applyFilters({ reset: true });
        };
        el.addEventListener("click", trigger);
        if (nativeButton) return;
        el.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            trigger();
          }
        });
      });
    }
    bindSummaryFilters();
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
      doneFilter.classList.remove("is-active");
      doneFilter.setAttribute("aria-pressed", "false");
      doneFilter.textContent = "未人工确认";
      activeSummaryFilter = null;
      syncSummaryFilterButtons();
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

    // 弹窗和请求都是异步的；仅确认真正写回的版本，不把后来到达的改案算成已处理。
    function markMatchingWrittenEntries(entries) {
      const matching = entries.filter((entry) => {
        const current = notes[String(entry.id)];
        return current && revisionTargetFor(current) === entry.targetKey
          && revisionTextFor(current).trim() === entry.replaceText;
      });
      if (matching.length) markEntriesConfirmed(matching.map((entry) => entry.id));
      return entries.length - matching.length;
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
    // 最后一条之后附带最多 32 行上下文，供服务端用后文唯一段落界定重复句；这些行不参与写入。
    // 缺行号的条目不生成清单，服务端按旧行为处理。
    function writebackRowTexts(entries) {
      const lastEntry = entries.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0);
      if (!lastEntry) return {};
      const lastRow = allRows.reduce((max, row) => Math.max(max, Number(row.index) || 0), 0);
      const limit = Math.min(lastRow, lastEntry + 32);
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

      const choice = revisionStageChoices(current, noteData, rowTargetText).find((item) => item.stage === String(stage));
      if (!choice) return;
      if (choice.disabled) {
        showToast(choice.title, { tone: "watch", durationMs: 7000 });
        return;
      }
      const targetText = choice.text;
      const stageName = choice.name + "方案";

      current.revisionText = targetText;
      current.revisionStageActive = String(stage);
      current.revisionTarget = revisionTargetFor(current);
      notes[rowId] = current;
      saveNotes();

      const rowElem = renderedRow(rowId);
      if (rowElem) {
        let editor = rowElem.querySelector('.revision-editor[data-revision="' + CSS.escape(rowId) + '"]');
        // 待终审时只有版本栏，没有默认成品；显式选取已有过程稿后才创建编辑器与写回入口。
        if (!editor) {
          const summary = rowElem.querySelector(".note-summary");
          if (summary) {
            const wrapper = document.createElement("div");
            wrapper.innerHTML = renderNoteSummary(current, rowId);
            summary.replaceWith(wrapper.firstElementChild);
            editor = rowElem.querySelector('.revision-editor[data-revision="' + CSS.escape(rowId) + '"]');
          }
        }
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
        const diffSlot = rowElem.querySelector('[data-diff-slot]');
        if (diffSlot && row) diffSlot.innerHTML = renderDiffBlock(row, current);
      }

      showToast("已切换为" + stageName, { tone: "success" });
    }

    async function writebackSingleRevision(id, button) {
      if (writebackPending || button?.disabled) return;
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
      // 「写回原文件」是不可逆的破坏性操作：单行写回与批量写回必须走同一套确认口径。
      // 确认发生在按钮切到「写回中」之前，用户取消时按钮不会卡在禁用态。
      const backup = getWritebackBackupSetting();
      const backupTip = backup ? "（已开启自动备份，写回前将生成 .bak 备份副本）" : "（未开启自动备份）";
      const entries = [{ id: String(id), targetKey, searchText, replaceText: revision }];
      const rowTexts = writebackRowTexts(entries);
      const targetLabel = pageMeta.pageLabels?.[targetKey] || "待写回文本";
      return withWritebackConfirmation("将第 " + id + " 行的修改结果写回原文件？\n目标：" + targetLabel + "对应的原文件。\n定位失败或有多处同段的段落不会被写入。\n" + backupTip, {
        title: "确认单行写回", confirmText: "写回原文件",
      }, async () => {
        button.disabled = true;
        button.textContent = "写回中...";
        try {
          const response = await apiFetch("/api/translation-export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectKey: pageMeta.projectKey,
              rowsSignature: pageMeta.rowsSignature,
              entries,
              rowTexts,
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
          const changed = markMatchingWrittenEntries(entries);
          applyFilters({ reset: false });
          const writtenTo = writebackTargetNames(result.targets || (result.target ? [result.target] : []));
          const backupNote = result.backup ? "（已生成 .bak 备份）" : "";
          const confirmationNote = changed ? "；该行修改结果后来已更新，未自动确认当前版本。" : "，并标记为人工确认。";
          showToast("已写回第 " + id + " 行已批准的修改结果" + (writtenTo ? "（" + writtenTo + "）" : "") + backupNote + confirmationNote + importedCopyHint(result), { tone: (changed || result.importedCopy) ? "watch" : "success", durationMs: 12000 });
        } catch (error) {
          showToast(error.message, { tone: "error", durationMs: 12000 });
          button.disabled = false;
          button.textContent = "写回";
        }
      });
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
      const button = document.getElementById("exportNotes");
      if (writebackPending || button.disabled) return;
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
      const rowTexts = writebackRowTexts(entries);
      const targets = [...new Set(entries.map((entry) => pageMeta.pageLabels?.[entry.targetKey] || "待写回文本"))].join("、");
      return withWritebackConfirmation("将当前筛选结果中的 " + entries.length + " 处修改结果写回原文件？\n目标：" + targets + "对应的原文件。\n定位失败或有多处同段的段落不会写入。" + skipNote + "\n" + backupTip, {
        title: "确认批量写回", confirmText: "写回原文件",
      }, async () => {
        const originalText = button.textContent;
        button.disabled = true;
        button.textContent = "写回中...";
        try {
          const response = await apiFetch("/api/translation-export", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectKey: pageMeta.projectKey,
              rowsSignature: pageMeta.rowsSignature,
              entries,
              rowTexts,
              writebackBackup: backup,
            }),
          });
          const result = await response.json();
          if (!response.ok || !result.ok) throw new Error(result.error || "写回失败");
          // 只有真正写入的行才算人工确认：定位失败与「有多处同段」的行没有落到文件上，
          // 标成已确认会让它们从复核视野里消失。
          const unwrittenIds = new Set([...(Array.isArray(result.missed) ? result.missed : []), ...(Array.isArray(result.ambiguous) ? result.ambiguous : [])]
            .map((item) => String(item?.index)));
          const writtenEntries = entries.filter((entry) => !unwrittenIds.has(String(entry.id)));
          const changed = markMatchingWrittenEntries(writtenEntries);
          applyFilters({ reset: false });
          const missedCount = (Array.isArray(result.missed) ? result.missed.length : 0);
          const ambiguousCount = (Array.isArray(result.ambiguous) ? result.ambiguous.length : 0);
          const writtenTo = writebackTargetNames(result.targets || (result.target ? [result.target] : []));
          const unwrittenNote = [
            missedCount ? missedCount + " 处未能在原文件中定位" : "",
            ambiguousCount ? ambiguousCount + " 处在原文件中有多处同段、未写入" : "",
          ].filter(Boolean).join("；");
          const changedNote = changed ? " " + changed + " 行修改结果后来已更新，未自动确认当前版本。" : "";
          const tone = (changed || unwrittenNote || result.importedCopy) ? "watch" : "success";
          const backupNote = result.backup ? " 已生成 .bak 备份。" : "";
          showToast((unwrittenNote
            ? "已写回 " + result.updated + " 处修改；" + unwrittenNote + "，这些行未标记为已确认。"
            : "已写回 " + result.updated + " 处修改。") + (writtenTo ? " 写入：" + writtenTo : "") + backupNote + changedNote + importedCopyHint(result), { tone, durationMs: 15000 });
        } catch (error) { showToast(error.message, { tone: "error", durationMs: 12000 }); } finally {
          button.disabled = false;
          button.textContent = originalText;
        }
      });
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
      prefilterResultFilterActive = false;
      applyFilters({ reset: false });
      showToast("已将 " + rows.length + " 条预筛结果标记为人工确认。", { tone: "success", durationMs: 7000 });
      tableFrame.scrollTop = 0;
    });

    function aiConfig() {
      const s1PresetIds = committedStagePresetIds("stage1");
      const s2PresetIds = committedStagePresetIds("stage2");
      const s3PresetIds = committedStagePresetIds("stage3");
      const s1PresetId = s1PresetIds[0] || "";
      const s2PresetId = s2PresetIds[0] || "";
      const s3PresetId = s3PresetIds[0] || "";

      let mainProtocol = aiIds.protocol.value;
      let mainProvider = aiIds.provider.value.trim();
      let mainBaseUrl = aiIds.baseUrl.value;
      let mainModel = aiIds.model.value;
      let mainModelMeta = aiModelMetadataMap.get(mainModel);
      let mainReasoningEffort = aiIds.reasoningEffort.value;
      let mainApiKey = aiIds.apiKey.value;

      let mainConcurrency = Number(aiIds.concurrency.value);

      if (s1PresetId) {
        const s1Preset = presetTools.getPreset(localStorage, s1PresetId);
        if (s1Preset) {
          mainProtocol = s1Preset.protocol;
          mainProvider = s1Preset.provider;
          mainBaseUrl = s1Preset.baseUrl;
          mainModel = s1Preset.model;
          mainModelMeta = s1Preset.modelMetadata?.find((item) => item.id === mainModel);
          mainReasoningEffort = s1Preset.reasoningEffort;
          mainApiKey = s1Preset.apiKey;
          if (s1Preset.concurrency != null) mainConcurrency = Number(s1Preset.concurrency);
        }
      }

      // 预设只表示各阶段可用的配置；是否运行由独立启停或总控决定。
      const multiStageEnabled = Boolean(s2PresetId);
      const challengerEnabled = Boolean(s2PresetId);
      const stylistConfig = s2PresetId ? presetTools.getPreset(localStorage, s2PresetId) : null;
      const arbiterEnabled = Boolean(s3PresetId);
      const arbiterConfig = s3PresetId ? presetTools.getPreset(localStorage, s3PresetId) : null;
      const stage2Presets = stagePresetsFor("stage2");
      const stage3Presets = stagePresetsFor("stage3");

      return {
        protocol: mainProtocol,
        provider: mainProvider,
        baseUrl: mainBaseUrl,
        model: mainModel,
        modelMeta: mainModelMeta,
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
        stylistPresets: stage2Presets,
        arbiterPresets: stage3Presets,
        presetPool: stagePresetsFor("stage1"),
        concurrency: mainConcurrency,
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

    function setProtocolHint(defaults) {
      if (!defaults) return;
      aiIds.apiKey.placeholder = defaults.apiKeyPlaceholder || "";
      setLiveHoverTitle(aiIds.protocol, defaults.note || "");
    }

    function applyProtocolDefaults(defaults, { force = false } = {}) {
      if (!defaults) return;
      if (force || !aiIds.baseUrl.dataset.touched) {
        aiIds.baseUrl.value = defaults.baseUrl || "";
      }
      if ((force || !aiIds.model.dataset.touched) && !aiModelOptions.length) {
        setModelOptions([defaults.model], { selected: defaults.model || "" });
      }
      setProtocolHint(defaults);
    }

    // 说话习惯层：按章/按卷命中人名后启用该角色的说话特色规则，防止刻意口癖被判成翻译错误。
    function setSpeechHabitHint(status) {
      const hint = aiIds.speechHabitHint;
      if (!hint) return;
      const builtSummary = speechHabitLayerSummary();
      if (!status) {
        hint.dataset.state = builtSummary ? "ok" : "pending";
        hint.textContent = builtSummary ? "说话习惯：构建期 " + builtSummary : "说话习惯：检测中…";
        setLiveHoverTitle(hint, "控制台生成前选择的说话习惯表：按章/按卷命中人名后，该角色的说话特色不会被判为翻译错误。");
        return;
      }
      const files = status.files || [];
      const errors = status.errors || [];
      const names = files.map((file) => String(file).split(/[\\/]/).pop()).join("、");
      const scopeLabel = status.scope === "volume" ? "按卷" : "按章";
      if (!files.length) {
        hint.dataset.state = "off";
        hint.textContent = "说话习惯：未挂载";
        setLiveHoverTitle(hint, "本项目没有挂载说话习惯表。可在控制台选择辅助表格后重新生成。", { reset: true });
        return;
      }
      if (!status.entries) {
        hint.dataset.state = "warning";
        hint.textContent = "说话习惯：加载失败";
        setLiveHoverTitle(hint, errors.length ? errors.join("\n") : files.join("\n"));
        return;
      }
      const ok = errors.length === 0;
      hint.dataset.state = ok ? "ok" : "warning";
      hint.textContent = "说话习惯：" + names + "（" + status.entries + " 条，" + scopeLabel + "命中人名" + (ok ? "" : "，" + errors.length + " 个文件失败") + "）" + (builtSummary ? "；构建期：" + builtSummary : "");
      setLiveHoverTitle(hint, [files.join("\n"), ...errors].join("\n"));
    }
    function setTermTableHint(status) {
      const hint = aiIds.termTableHint;
      if (!hint) return;
      const built = termLayerSummary();
      if (!status) {
        // 状态还没回来（或本地服务是旧版本）时，至少把构建期结论显示出来。
        hint.dataset.state = built ? "ok" : "pending";
        hint.textContent = built ? "对照表：" + built : "对照表：检测中…";
        setLiveHoverTitle(hint, "控制台生成前选择的译名对照表：只有整行有效内容都是术语时才跳过模型；其余命中行（含术语冲突、假名存疑）都把术语作为提示词注入，整句由模型判定，术语判断是模型分析里的一环。");
        return;
      }
      const files = status.files || [];
      const errors = status.errors || [];
      const names = files.map((file) => String(file).split(/[\\/]/).pop()).join("、");
      if (!files.length) {
        hint.dataset.state = "off";
        hint.textContent = "对照表：未挂载";
        setLiveHoverTitle(hint, "本项目没有挂载对照表。可在控制台选择辅助表格后重新生成。", { reset: true });
        return;
      }
      if (!status.entries) {
        hint.dataset.state = "warning";
        hint.textContent = "对照表：加载失败";
        setLiveHoverTitle(hint, errors.length ? errors.join("\n") : files.join("\n"));
        return;
      }
      const ok = errors.length === 0;
      hint.dataset.state = ok ? "ok" : "warning";
      hint.textContent = "对照表：" + names + "（" + status.entries + " 条术语" + (ok ? "" : "，" + errors.length + " 个文件失败") + "）" + (built ? "；" + built : "");
      setLiveHoverTitle(hint, [files.join("\n"), ...errors].join("\n"));
    }

    /**
     * 「异常」指标：数字照旧，悬停时按分类展开「到底出了哪些问题、各多少行」。
     * 只给类别与数量，不列行号也不带代表性消息——异常定位靠失败备注与 AI 日志。
     * 无异常时恢复构建器写在 HTML 上的静态说明，避免上一轮的明细残留在 tooltip 里。
     * 明细总数与卡片计数不一致时取较大者：停止任务留下的「已终止」行在备注口径里算失败行，
     * 服务端计数却不算，两边都如实反映才不会让悬停明细看起来「比卡片少」。
     */
    function renderStageErrorItem(itemId, metricId, count, kinds, stageLabel) {
      const metric = document.getElementById(metricId);
      if (metric) metric.textContent = count;
      const item = document.getElementById(itemId);
      if (!item) return;
      item.classList.toggle("has-errors", count > 0);
      if (item.dataset.defaultTitle === undefined) item.dataset.defaultTitle = item.title || "";
      const entries = sortAiErrorKinds(kinds);
      const kindsTotal = entries.reduce((sum, entry) => sum + entry.count, 0);
      item.hidden = count <= 0 && kindsTotal <= 0;
      if (count > 0 || kindsTotal > 0) {
        setLiveHoverTitle(item, formatAiErrorHoverTitle(stageLabel, Math.max(count, kindsTotal), kinds));
      } else {
        setLiveHoverTitle(item, item.dataset.defaultTitle);
      }
    }

    // 阶段运行区分别标出正在处理的行数、队列、动态配额和配置上限。
    // 触顶仍以服务端通道反馈为准；旧服务端按正在处理的请求数与配置上限折算。
    function stageConcurrencyText(pipeline, activeInfoEl = null) {
      const inFlight = Math.max(0, Number(pipeline?.inFlight) || 0);
      const allowed = Math.max(0, Number(pipeline?.concurrency) || 0);
      const cap = Math.max(0, Number(pipeline?.concurrencyMax) || 0);
      const pending = Math.max(0, Number(pipeline?.pending) || 0);
      // 分母就是预设上限；旧服务端只回报许可值时退回用它，此时没有预设边界可比，不判触顶。
      const ceiling = cap || allowed;
      if (!ceiling) {
        if (activeInfoEl) { setLiveHoverTitle(activeInfoEl, ""); activeInfoEl.removeAttribute("title"); }
        return "";
      }
      // 触顶口径来自服务端的 presetCount/toppedCount；旧服务端没有这两个字段时，
      // 按「正在处理的请求数 ≥ 并发上限」判断；多预设下等价于全部通道都已达到各自上限。
      const presetCount = Math.max(0, Number(pipeline?.presetCount) || 0);
      const toppedCount = Math.max(0, Number(pipeline?.toppedCount) || 0);
      const allTopped = presetCount > 0 ? toppedCount >= presetCount : (cap > 0 && inFlight >= cap);
      const toppedText = allTopped ? (presetCount > 1 ? " · 全部触顶" : " · 触顶") : "";
      if (activeInfoEl) {
        const toppedDetail = presetCount > 1
          ? `已触顶 ${toppedCount}/${presetCount} 个预设${allTopped ? "（全部触顶）" : ""}。`
          : (allTopped ? "正在处理的请求数已达预设并发上限（触顶）。" : "");
        setLiveHoverTitle(activeInfoEl, "正在处理 " + inFlight + " 行；当前允许并发 " + allowed + (cap ? "，并发上限 " + cap : "")
          + "；队列待派发 " + pending + " 行。" + toppedDetail
          + "当前允许并发由调度器自动调整，队列不足时正在处理的行数会小于该值。");
      }
      return "运行 " + inFlight + " 行 · 排队 " + pending + " 行 · 当前配额 " + allowed + (cap ? " · 配置上限 " + cap : "") + toppedText;
    }

    function renderStageProgress(stageKey, done, total, { enabled = true, label = "", errors = 0, activeRows = [], resetHover = false } = {}) {
      const wrap = document.getElementById("stage" + stageKey + "ProgressWrap");
      const bar = document.getElementById("stage" + stageKey + "Progress");
      const text = document.getElementById("stage" + stageKey + "ProgressText");
      if (!wrap || !bar) return;
      const safeDone = Math.max(0, Number(done) || 0);
      const safeTotal = Math.max(safeDone, Number(total) || 0);
      if (!enabled || safeTotal <= 0) {
        wrap.hidden = true;
        bar.style.width = "0%";
        setLiveHoverTitle(wrap, "");
        wrap.removeAttribute("title");
        wrap.removeAttribute("aria-valuenow");
        wrap.removeAttribute("aria-valuemax");
        wrap.removeAttribute("aria-valuetext");
        if (text) { text.hidden = true; text.textContent = ""; setLiveHoverTitle(text, ""); }
        return;
      }
      // 仍有未完成行时，四舍五入也不能把进度画成 100%。
      const percent = Math.min(safeDone < safeTotal ? 99 : 100, Math.round((safeDone / safeTotal) * 100));
      wrap.hidden = false;
      bar.style.width = percent + "%";
      const action = { "1": "已初审", "2": "已复审", "3": "已仲裁" }[stageKey];
      const scope = String(stageKey) === "1" ? "全部" : "当前候选";
      const description = action + " " + safeDone + " / " + scope + " " + safeTotal + " 行 · " + percent + "%";
      const activeRowsText = Array.isArray(activeRows) && activeRows.length ? "\n当前行：" + activeRows.join(", ") : "";
      if (text) {
        text.hidden = false;
        const progressText = (scope === "全部" ? "全页" : "当前候选") + " " + percent + "%";
        if (text.textContent !== progressText) text.textContent = progressText;
        setLiveHoverTitle(text, description, { reset: resetHover });
      }
      wrap.setAttribute("role", "progressbar");
      wrap.setAttribute("aria-label", label + (scope === "全部" ? "全页覆盖进度" : "当前候选进度"));
      wrap.setAttribute("aria-valuemin", "0");
      wrap.setAttribute("aria-valuemax", String(safeTotal));
      wrap.setAttribute("aria-valuenow", String(safeDone));
      wrap.setAttribute("aria-valuetext", description + activeRowsText);
      setLiveHoverTitle(wrap, (label ? label + "进度：" : "进度：") + "已完成 " + safeDone + " / 共 " + safeTotal + " 行（" + percent + "%）"
        + (errors > 0 ? "；异常待重试 " + errors + " 行" : "") + activeRowsText, { reset: resetHover });
    }

    function resetStageProgressBars() {
      for (const stageKey of ["1", "2", "3"]) {
        renderStageProgress(stageKey, 0, 0, { enabled: false });
      }
    }

    /**
     * 右上角「修改率」：最终建议修改的行 ÷ 已有自动结果的行。
     * 分子分母直接复用阶段指标的最终结论口径（finalNeedsEdit / finalUnchanged /
     * finalNeedsCheck / finalPendingArbiter），不另写一套备注分类规则。
     * 还没有任何自动结果时显示「—」：0 行结果不等于 0% 修改率。
     */
    function updateModifyRateStat(metrics = {}) {
      if (!modifyRate) return;
      const needsEdit = Math.max(0, Number(metrics.finalNeedsEdit) || 0);
      const unchanged = Math.max(0, Number(metrics.finalUnchanged) || 0);
      const needsCheck = Math.max(0, Number(metrics.finalNeedsCheck) || 0);
      const pendingArbiter = Math.max(0, Number(metrics.finalPendingArbiter) || 0);
      const audited = needsEdit + unchanged + needsCheck + pendingArbiter;
      if (!audited) {
        modifyRate.textContent = "—";
        setLiveHoverTitle(modifyRateStat, "尚无自动校对结果：修改率 = 最终建议修改的行 ÷ 已有自动结果的行。", { reset: true });
        return;
      }
      const rounded = Math.round((needsEdit / audited) * 1000) / 10;
      modifyRate.textContent = (Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)) + "%";
      if (modifyRateStat) {
        const results = ["无需修改 " + unchanged];
        if (needsCheck) results.push("未定案记录 " + needsCheck);
        if (pendingArbiter) results.push("待终审 " + pendingArbiter);
        setLiveHoverTitle(modifyRateStat, "最终建议修改 " + needsEdit + " 行 / 已有自动结果 " + audited + " 行"
          + "（" + results.join("、") + "；调用失败的行不计入分母）。");
      }
    }

    function renderStageMetricsDashboard(stageMetrics = {}, stagePipelines = {}, aiRunning = false, stageErrorKinds = null) {
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
      // 备注里已落了复审结论的待仲裁行（上一轮遗留）已含在 stage2Diverged 中，再叠加队列会算两次：
      // 取「备注口径」与「已仲裁 + 队列积压」的较大者，而不是相加。
      const s2DivergedBase = Math.max(0, Number(stageMetrics.stage2Diverged) || Number(stageMetrics.stage3Arbitrated) || 0);
      const s2Diverged = Math.max(s2DivergedBase, Math.max(0, Number(stageMetrics.stage3Arbitrated) || 0) + arbiterBacklog);
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
      const s3Errors = Math.max(0, Number(stageMetrics.stage3Errors) || 0);
      const finalNeedsEdit = Math.max(0, Number(stageMetrics.finalNeedsEdit) || 0);
      const finalUnchanged = Math.max(0, Number(stageMetrics.finalUnchanged) || 0);
      const finalNeedsCheck = Math.max(0, Number(stageMetrics.finalNeedsCheck) || 0);
      const finalPendingArbiter = Math.max(0, Number(stageMetrics.finalPendingArbiter) || 0);
      const totalAudited = Math.max(s1Total, finalNeedsEdit + finalUnchanged + finalNeedsCheck + finalPendingArbiter, Number(stageMetrics.totalAudited) || 0);

      // 右上角「修改率」跟随同一份最终结论指标刷新：校对跑完后它就是全书的修改率。
      updateModifyRateStat({ finalNeedsEdit, finalUnchanged, finalNeedsCheck, finalPendingArbiter });

      // 全局最终修改结论摘要
      const elFinalNeedsEdit = document.getElementById("metricFinalNeedsEdit");
      if (elFinalNeedsEdit) elFinalNeedsEdit.textContent = finalNeedsEdit;
      const elFinalUnchanged = document.getElementById("metricFinalUnchanged");
      if (elFinalUnchanged) elFinalUnchanged.textContent = finalUnchanged;
      const elFinalNeedsCheck = document.getElementById("metricFinalNeedsCheck");
      if (elFinalNeedsCheck) elFinalNeedsCheck.textContent = finalNeedsCheck;
      const badgeNeedsCheck = document.getElementById("aiStageSummaryNeedsCheck");
      if (badgeNeedsCheck) badgeNeedsCheck.hidden = finalNeedsCheck === 0;
      // 运行中尚未完成终审的行单独展示，不混入兼容的未定案记录。
      const elFinalPendingArbiter = document.getElementById("metricFinalPendingArbiter");
      if (elFinalPendingArbiter) elFinalPendingArbiter.textContent = finalPendingArbiter;
      const badgePendingArbiter = document.getElementById("aiStageSummaryPendingArbiter");
      if (badgePendingArbiter) badgePendingArbiter.hidden = finalPendingArbiter === 0;

      // 阶段一
      const elS1 = document.getElementById("metricStage1Passed");
      if (elS1) elS1.textContent = s1Passed;
      const elS1NeedsEdit = document.getElementById("metricStage1NeedsEdit");
      if (elS1NeedsEdit) elS1NeedsEdit.textContent = s1NeedsEdit;
      const elS1Unclear = document.getElementById("metricStage1Unclear");
      if (elS1Unclear) elS1Unclear.textContent = s1Unclear;
      const pillS1Unclear = document.getElementById("stage1UnclearPill");
      if (pillS1Unclear) {
        pillS1Unclear.hidden = false;
        setLiveHoverTitle(pillS1Unclear, "初审存疑待定 " + s1Unclear + " 行，可交给阶段二文学复审（点击可筛选）");
      }
      const elS1Total = document.getElementById("metricStage1Total");
      if (elS1Total) elS1Total.textContent = s1Total;
      const elS1Err = document.getElementById("metricStage1Errors");
      if (elS1Err) {
        renderStageErrorItem("stage1ErrorItem", "metricStage1Errors", s1Errors, stageErrorKinds?.stage1, "阶段一 事实初审");
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
        renderStageErrorItem("stage2ErrorItem", "metricStage2Errors", s2Errors, stageErrorKinds?.stage2, "阶段二 文学复审");
      }
      const s1PendingTotal = s1NeedsEdit + s1Unclear;
      // 优先使用与筛选器同源的逐行谓词结果（stage2Pending），聚合相减只作缺省兜底。
      const s2Pending = Number.isFinite(Number(stageMetrics.stage2Pending)) && stageMetrics.stage2Pending !== undefined
        ? Math.max(0, Number(stageMetrics.stage2Pending))
        : Math.max(0, s1PendingTotal - s2Reviewed);
      const elS2Pending = document.getElementById("metricStage2Pending");
      const itemS2Pending = document.getElementById("stage2PendingItem");
      if (elS2Pending) elS2Pending.textContent = s2Pending;
      if (itemS2Pending) {
        itemS2Pending.hidden = s2Pending === 0;
        setLiveHoverTitle(itemS2Pending, "最新一轮初审提改或存疑、尚未完成复审且未人工确认：" + s2Pending + " 行（点击可筛选）。历史轮次不参与待办判断。");
      }

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
      const localS3Pending = Number.isFinite(Number(stageMetrics.stage3Pending)) && stageMetrics.stage3Pending !== undefined
        ? Math.max(0, Number(stageMetrics.stage3Pending))
        : Math.max(0, s2Diverged - s3Arbitrated);
      // 人工确认的已仲裁行不能抵扣其它待办；运行中仍补上尚未落备注的仲裁积压。
      const s3Pending = Math.max(localS3Pending, arbiterBacklog);
      const elS3Pending = document.getElementById("metricStage3Pending");
      const itemS3Pending = document.getElementById("stage3PendingItem");
      if (elS3Pending) elS3Pending.textContent = s3Pending;
      if (itemS3Pending) {
        itemS3Pending.hidden = s3Pending === 0;
        setLiveHoverTitle(itemS3Pending, "最新一轮复审产生分歧、尚未仲裁定案且未人工确认：" + s3Pending + " 行（含正在仲裁的行，点击可筛选）。历史轮次不参与待办判断。");
      }
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
        renderStageErrorItem("stage3ErrorItem", "metricStage3Errors", s3Errors, stageErrorKinds?.stage3, "阶段三 终审仲裁");
      }

      const elRate = document.getElementById("aiStageFastPassRate");
      if (elRate) {
        const rate = s1Passed > 0 ? Math.round((fpHits / s1Passed) * 100) + "%" : "—";
        elRate.textContent = "通过中: " + rate;
        let rateTitle = s1Passed > 0
          ? "初审放行 " + s1Passed + " 行中 " + fpHits + " 行快速直通 (" + rate + ")\n快速直通数 ÷ 初审通过数；不是全部审核行的通过率。"
          : "尚无初审通过行，直通占比暂不计算。";
        if (totalAudited > 0) {
          rateTitle += "\n审核总量 " + totalAudited + " 行（总直通占比 " + Math.round((fpHits / totalAudited) * 100) + "%）";
        }
        setLiveHoverTitle(elRate, rateTitle);
      }

      // 实时阶段状态指示（动态胶囊与活跃行提示）
      const p1 = stagePipelines?.stage1 || { inFlight: 0, pending: 0, activeRows: [] };
      const p2 = stagePipelines?.stage2 || { inFlight: 0, pending: 0, activeRows: [] };
      const p3 = stagePipelines?.stage3 || { inFlight: 0, pending: 0, activeRows: [] };
      const activeStages = getStageActiveStates(aiRunning, stagePipelines);
      for (const stage of ["stage1", "stage2", "stage3"]) renderStagePresetSelection(stage);
      const s1Done = s1Passed + s1NeedsEdit + s1Unclear;
      const s1Queue = Math.max(0, Number(p1.pending) || 0) + Math.max(0, Number(p1.inFlight) || 0);
      // 初审覆盖整张工作台；异常重试行也在队列中，不能再加一遍。
      const s1ScopeTotal = Math.max(allRows.length, s1Total, s1Done + Math.max(s1Queue, s1Errors));
      const s1Unreviewed = Math.max(0, s1ScopeTotal - s1Done - s1Errors);

      // Stage 1
      const pill1 = document.getElementById("stage1StatusPill");
      if (pill1) {
        let pillTitle = "";
        if (latestStageControls?.stage1?.stopRequested) {
          pill1.dataset.state = "queued";
          pill1.textContent = activeStages.stage1 ? "停止中" : "已停止";
        } else if (aiRunning && (p1.inFlight > 0 || p1.pending > 0)) {
          if (p1.inFlight > 0) {
            pill1.dataset.state = "running";
            pill1.textContent = "处理中";
          } else {
            pill1.dataset.state = "queued";
            pill1.textContent = "排队中";
          }
        } else if (s1Unreviewed > 0 && (s1Total > 0 || s1Errors > 0 || aiRunning)) {
          pill1.dataset.state = "queued";
          pill1.textContent = "待处理";
          pillTitle = "当前工作台还有 " + s1Unreviewed + " 行尚未取得初审结论"
            + (s1Errors > 0 ? "，另有 " + s1Errors + " 行异常待重试" : "")
            + "。点阶段一「开始」→「继续剩下的」处理；已有结论保持不变。";
        } else if (s1Errors > 0) {
          // 队列耗尽只代表本轮尝试结束，调用失败的行没有初审结论，仍需续跑。
          pill1.dataset.state = "queued";
          pill1.textContent = "异常待重试";
          pillTitle = "初审仍有 " + s1Errors + " 行未取得结论。悬停「异常」查看原因；任务结束后点阶段一「开始」→「继续剩下的」重试。";
        } else if (activeStages.stage1) {
          pill1.dataset.state = "idle";
          pill1.textContent = "已完成";
        } else {
          pill1.dataset.state = s1Total > 0 ? "done" : "idle";
          pill1.textContent = s1Total > 0 ? "已完成" : "待命";
        }
        setLiveHoverTitle(pill1, pillTitle);
      }
      // Stage 2
      const s2Enabled = Boolean(committedStagePresetIds("stage2").length || s2Reviewed > 0 || s2Errors > 0 || activeStages.stage2 || p2.inFlight > 0 || p2.pending > 0);
      const pill2 = document.getElementById("stage2StatusPill");
      if (pill2) {
        let pillTitle = "";
        if (!s2Enabled) {
          pill2.dataset.state = "disabled";
          pill2.textContent = "未启用";
        } else if (latestStageControls?.stage2?.stopRequested) {
          pill2.dataset.state = "queued";
          pill2.textContent = activeStages.stage2 ? "停止中" : "已停止";
        } else if (aiRunning && (p2.inFlight > 0 || p2.pending > 0)) {
          if (p2.inFlight > 0) {
            pill2.dataset.state = "running";
            pill2.textContent = "处理中";
          } else {
            pill2.dataset.state = "queued";
            pill2.textContent = "排队中";
          }
        } else if (s2Errors > 0) {
          pill2.dataset.state = "queued";
          pill2.textContent = "异常待重试";
          pillTitle = "复审仍有 " + s2Errors + " 行未取得结论。悬停「异常」查看原因；任务结束后点阶段二「开始」→「继续剩下的」重试。";
        } else if (s2Pending > 0) {
          pill2.dataset.state = "queued";
          pill2.textContent = "待处理";
        } else {
          pill2.dataset.state = s2Reviewed > 0 ? "done" : "idle";
          pill2.textContent = s2Reviewed > 0 ? (activeStages.stage2 ? "当前候选已完成" : "已完成") : (activeStages.stage2 ? "等待候选" : "待命");
        }
        setLiveHoverTitle(pill2, pillTitle);
      }
      // Stage 3
      const s3Enabled = Boolean(committedStagePresetIds("stage3").length || s3Arbitrated > 0 || s3Errors > 0 || activeStages.stage3 || p3.inFlight > 0 || p3.pending > 0);
      const pill3 = document.getElementById("stage3StatusPill");
      if (pill3) {
        let pillTitle = "";
        if (!s3Enabled) {
          pill3.dataset.state = "disabled";
          pill3.textContent = "未启用";
        } else if (latestStageControls?.stage3?.stopRequested) {
          pill3.dataset.state = "queued";
          pill3.textContent = activeStages.stage3 ? "停止中" : "已停止";
        } else if (aiRunning && (p3.inFlight > 0 || p3.pending > 0)) {
          if (p3.inFlight > 0) {
            pill3.dataset.state = "running";
            pill3.textContent = "处理中";
          } else {
            pill3.dataset.state = "queued";
            pill3.textContent = "排队中";
          }
        } else if (s3Errors > 0) {
          pill3.dataset.state = "queued";
          pill3.textContent = "异常待重试";
          pillTitle = "仲裁仍有 " + s3Errors + " 行未取得结论。悬停「异常」查看原因；任务结束后点阶段三「开始」→「继续剩下的」重试。";
        } else if (s3Pending > 0) {
          pill3.dataset.state = "queued";
          pill3.textContent = "待处理";
        } else {
          pill3.dataset.state = s3Arbitrated > 0 ? "done" : "idle";
          pill3.textContent = s3Arbitrated > 0 ? (activeStages.stage3 ? "当前候选已完成" : "已完成") : (activeStages.stage3 ? "等待候选" : "待命");
        }
        setLiveHoverTitle(pill3, pillTitle);
      }
      // 运行数字统一归卡片底部，队列没有活跃行时也如实展示。
      for (const [number, pipeline] of [[1, p1], [2, p2], [3, p3]]) {
        const info = document.getElementById("stage" + number + "RuntimeInfo");
        if (!info) continue;
        const hasRuntime = aiRunning && (pipeline.inFlight > 0 || pipeline.pending > 0);
        info.hidden = !hasRuntime && !(number === 1 && s1Unreviewed > 0 && (s1Total > 0 || s1Errors > 0));
        info.textContent = hasRuntime
          ? (stageConcurrencyText(pipeline, info) || "运行 " + (Number(pipeline.inFlight) || 0) + " 行 · 排队 " + (Number(pipeline.pending) || 0) + " 行")
          : (info.hidden ? "" : "未审 " + s1Unreviewed + " 行");
        if (!hasRuntime) { setLiveHoverTitle(info, ""); info.removeAttribute("title"); }
      }

      // 初审用同一覆盖范围表示累计进度；复审和仲裁只覆盖实际产生的候选行。
      renderStageProgress("1", s1Done, s1ScopeTotal, {
        enabled: aiRunning || s1Total > 0 || s1Errors > 0,
        resetHover: !aiRunning,
        label: "阶段一 事实初审",
        errors: s1Errors,
        activeRows: aiRunning ? p1.activeRows : [],
      });
      const s2Queue = Math.max(0, Number(p2.pending) || 0) + Math.max(0, Number(p2.inFlight) || 0);
      renderStageProgress("2", s2Reviewed, s2Reviewed + Math.max(s2Pending, s2Queue, s2Errors), {
        enabled: s2Enabled,
        resetHover: !aiRunning,
        label: "阶段二 文学复审",
        errors: s2Errors,
        activeRows: aiRunning ? p2.activeRows : [],
      });
      const s3Queue = Math.max(0, Number(p3.pending) || 0) + Math.max(0, Number(p3.inFlight) || 0);
      renderStageProgress("3", s3Arbitrated, s3Arbitrated + Math.max(s3Pending, s3Queue, s3Errors), {
        enabled: s3Enabled,
        resetHover: !aiRunning,
        label: "阶段三 终审仲裁",
        errors: s3Errors,
        activeRows: aiRunning ? p3.activeRows : [],
      });
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
      let finalPendingArbiter = 0;
      let totalAudited = 0;
      let lowScoreHits = 0;
      let webLookupHits = 0;
      // 失败行的分类明细：与「异常」计数同一轮遍历得出，用来回答悬停时的「到底出了哪些问题」。
      const stageErrorKinds = { stage1: {}, stage2: {}, stage3: {} };
      // 统计时同步保留命中的行号，指标筛选复用同一份分类与缓存。
      const metricRowIds = {};

      for (const [noteRowKey, item] of Object.entries(sourceNotes || {})) {
        if (!item) continue;
        const noteText = latestAiNotePart(item.note || "").trim();
        if (!noteText) continue;
        const recordMetricRow = (metric) => (metricRowIds[metric] ||= new Set()).add(String(noteRowKey));

        const state = stageNoteState(noteText);
        for (const [stage, failureLine] of Object.entries(state.errors)) {
          recordMetricRow(stage + "Errors");
          if (stage === "stage1") stage1Errors += 1;
          else if (stage === "stage2") stage2Errors += 1;
          else if (stage === "stage3") stage3Errors += 1;
          recordAiErrorKind(stageErrorKinds[stage], classifyAiError(failureLine), Number(noteRowKey), failureLine);
        }
        if (isAiFailureNote(noteText)) {
          totalAudited += 1;
          continue;
        }

        const parsed = parseAutomatedNote(noteText);
        if (!parsed) continue;
        recordMetricRow("stage1Total");

        totalAudited += 1;

        // 全局最终修改结论
        if (parsed.modify === "是") {
          finalNeedsEdit += 1;
        } else if (parsed.modify === "否") {
          finalUnchanged += 1;
        } else if (parsed.modify === "待终审") {
          // 尚未完成终审的行单独计；旧版存疑与预筛冲突保留在兼容指标中。
          finalPendingArbiter += 1;
        } else {
          finalNeedsCheck += 1;
        }

        const hasStage2 = state.reviewed;
        const hasStage3 = state.arbitrated;
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
            // 与服务端同口径：预筛放行，或模型显式回报快速直通，才算直通。
            if (parsed.fastPass || automatedNoteMarker(noteText) !== "[AI校对]") {
              fastPassHits += 1;
              recordMetricRow("fastPassHits");
            }
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
            // 只有提改或存疑的行才会流入复审；初审痕迹缺失（旧格式）时按提改归类，
            // 不能落到「通过」，否则「通过 + 提改 + 存疑 = 总检」的流向会被破坏。
            isS1NeedsEdit = true;
          }
        }

        if (isS1Passed) {
          stage1Passed += 1;
          recordMetricRow("stage1Passed");
        } else if (isS1NeedsEdit) {
          stage1NeedsEdit += 1;
          recordMetricRow("stage1NeedsEdit");
        } else if (isS1Unclear) {
          stage1Unclear += 1;
          recordMetricRow("stage1Unclear");
        }

        // 阶段二文学复审指标
        if (hasStage2) {
          stage2Reviewed += 1;
          recordMetricRow("stage2Reviewed");
          const attitude = String(parsed.stage2?.attitude || "");
          if (attitude.includes("采纳") || attitude === "accept") {
            critiqueAccept += 1;
            recordMetricRow("critiqueAccept");
          } else if (attitude.includes("调整") || attitude === "modify") {
            critiqueModify += 1;
            recordMetricRow("critiqueModify");
          } else if (attitude.includes("驳回") || attitude === "reject") {
            critiqueReject += 1;
            recordMetricRow("critiqueReject");
          } else if (attitude.includes("仲裁") || attitude === "escalate") {
            critiqueEscalate += 1;
            recordMetricRow("critiqueEscalate");
          }
        }

        // 「复审分歧」= 复审与初审产生立场或方案分歧的行数（含已仲裁与待仲裁）。
        // 判据必须与「待终审仲裁」筛选、启动弹窗同源（getStage3RowStatus）：
        // 只在拿到仲裁结论时才 +1 的话，仲裁队列跑空后分歧会塌回「已仲裁数」，
        // 于是卡片写「1 分歧」、弹窗写「1583 条分歧行待仲裁」，两边各说各话。
        const stage3RowStatus = getStage3RowStatus(item);
        if (stage3RowStatus.isArbitrated || stage3RowStatus.isPending) {
          stage2Diverged += 1;
          recordMetricRow("stage2Diverged");
        }

        // 阶段三终审仲裁指标
        if (hasStage3) {
          stage3Arbitrated += 1;
          recordMetricRow("stage3Arbitrated");
          recordMetricRow("stage3Settled");
          recordMetricRow("stage2Diverged");
          const winner = String(parsed.stage3?.winner || "").toLowerCase();
          if (winner.includes("结合") || winner.includes("综合") || winner.includes("折中") || winner.includes("融合") || winner.includes("synthesis") || winner.includes("combined") || winner.includes("compromise")) {
            arbitrationSynthesis += 1;
            recordMetricRow("arbitrationSynthesis");
          } else if (winner.includes("维持") || winner.includes("原译") || winner.includes("original") || winner.includes("target")) {
            arbitrationOriginal += 1;
            recordMetricRow("arbitrationOriginal");
          } else if (winner.includes("初审") || winner.includes("gatekeeper") || /\bgk\b/.test(winner)) {
            arbitrationGatekeeper += 1;
            recordMetricRow("arbitrationGatekeeper");
          } else if (winner.includes("复审") || winner.includes("stylist")) {
            arbitrationStylist += 1;
            recordMetricRow("arbitrationStylist");
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
      // 已仲裁记录保留在分歧统计内；人工确认只移除尚待仲裁的待办。
      stage2Diverged = metricRowIds.stage2Diverged?.size || 0;
      const stage1Total = stage1Passed + stage1NeedsEdit + stage1Unclear;
      // The visible count follows the same note-level predicate as the filter,
      // so incomplete/failed Stylist rows remain actionable instead of being
      // hidden by subtracting aggregate counts from unrelated stages.
      const stage2Pending = Object.values(sourceNotes || {}).filter((item) => getStage2RowStatus(item).isPending).length;
      const stage3Pending = Object.values(sourceNotes || {}).filter((item) => getStage3RowStatus(item).isPending).length;

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
        finalPendingArbiter,
        totalAudited,
        lowScoreHits,
        webLookupHits,
        stageErrorKinds,
        metricRowIds,
      };

      if (sourceNotes === notes) {
        cachedStageMetrics = resultMetrics;
        lastComputedMetricsVersion = notesMetricsVersion;
      }
      return resultMetrics;
    }

    // updateStageMetricsDashboard 与 renderAiStatus 共享的阶段指标摘要。原先借 #aiStatus 的
    // dataset 中转，右上角状态行移除后改成本地变量。
    let stageMetricsSummaryCache = "";

    function updateStageMetricsDashboard(overrideMetrics = null, stagePipelines = {}, aiRunning = false, serverStageErrors = null) {
      const localMetrics = computeStageMetricsFromNotes(notes);
      let stageMetrics = localMetrics;
      const hasOverride = overrideMetrics && Object.values(overrideMetrics).some((v) => Number(v) > 0);
      const hasLocal = Object.values(localMetrics).some((v) => Number(v) > 0);

      if (hasLocal) {
        // 当前工作台 notes 中存在审核指标：以当前工作台已加载/找回的 notes 为真理源，
        // 增量运行期间（例如只复审待处理行），绝不让单次任务从 0 开始的指标冲掉本地累积数据！
        // 必须浅拷贝：localMetrics 与 cachedStageMetrics 是同一个对象，直接改会污染缓存。
        stageMetrics = { ...localMetrics };
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

      // 异常按仍失败的行合并；新一轮只重试其中一部分时，计数也要反映两端行号的并集。
      const stageErrorKinds = {};
      stageMetrics = { ...stageMetrics };
      for (const stage of ["stage1", "stage2", "stage3"]) {
        stageErrorKinds[stage] = mergeAiErrorKinds(localMetrics.stageErrorKinds?.[stage], serverStageErrors?.[stage]);
        const classifiedCount = Object.values(stageErrorKinds[stage]).reduce((sum, item) => sum + (Number(item.count) || 0), 0);
        stageMetrics[stage + "Errors"] = Math.max(Number(stageMetrics[stage + "Errors"]) || 0, classifiedCount);
      }

      const stageMetricsSummary = [
        ["finalNeedsEdit", "最终建议修改"],
        ["finalUnchanged", "无需修改"],
        ["finalNeedsCheck", "未定案记录"],
        ["finalPendingArbiter", "待终审"],
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
      ].filter(([key]) => key !== "finalNeedsCheck" || Number(stageMetrics[key]) > 0)
        .map(([key, label]) => label + " " + Math.max(0, Number(stageMetrics[key]) || 0)).join("，");

      stageMetricsSummaryCache = stageMetricsSummary;
      setLiveHoverTitle(aiIds.panelState, stageMetricsSummary);

      renderStageMetricsDashboard(stageMetrics, stagePipelines, aiRunning, stageErrorKinds);
      return stageMetrics;
    }

    function renderAiCacheMetrics(metrics = {}, { resetHover = false } = {}) {
      const badge = aiIds.cacheHitRate;
      if (!badge) return;
      const count = (key) => {
        const value = Number(metrics?.[key]);
        return Number.isFinite(value) ? Math.max(0, value) : 0;
      };
      const calls = count("modelCalls");
      const reported = count("cacheReportedCalls");
      const input = count("cacheReportedPromptTokens");
      const cached = Math.min(input, count("cachedPromptTokens"));
      const partial = calls > reported;
      const rate = reported > 0 && input > 0 ? (cached / input * 100).toFixed(1) + "%" : "—";
      const text = "缓存命中: " + rate + (reported > 0 && partial ? "（部分）" : "");
      if (badge.textContent !== text) badge.textContent = text;
      const title = reported > 0
        ? [
          "本轮缓存命中率 = 缓存读取 token ÷ 已报告缓存用量的输入 token。",
          "缓存读取 " + cached.toLocaleString("zh-CN") + " / " + input.toLocaleString("zh-CN") + " token；未命中 " + count("cacheMissPromptTokens").toLocaleString("zh-CN") + " token。",
          ...(count("cacheWritePromptTokens") > 0 ? ["缓存写入 " + count("cacheWritePromptTokens").toLocaleString("zh-CN") + " token（包含在未命中输入中）。"] : []),
          "已报告缓存用量 " + reported + " / " + calls + " 次调用" + (partial ? "；未报告的调用不参与命中率计算。" : "。"),
        ].join("\n")
        : (calls > 0 ? "接口未返回缓存用量，无法计算命中率；未报告不等于未命中。" : "本轮模型输入的缓存命中占比；尚无接口返回的缓存用量。");
      setLiveHoverTitle(badge, title, { reset: resetHover || calls === 0 });
      badge.setAttribute("aria-label", badge.textContent + "。" + title);
    }

    function renderAiStatus(ai) {
      if (!ai) return;
      const receipt = aiResultReception.begin(ai);
      if (receipt.runChanged || !receipt.sameScope) liveHoverTitleScope += 1;
      currentAiRunning = Boolean(ai.running);
      const isRunning = currentAiRunning;
      runningAiStage = isRunning ? (ai.stageMode || runningAiStage) : null;
      latestStageControls = ai.stageControls || null;
      latestAiStopRequested = isRunning && Boolean(ai.stopRequested);
      latestStagePipelines = isRunning ? (ai.stagePipelines || null) : null;
      currentStageCascade = {
        toStylist: isRunning && Boolean(ai.stageCascade?.toStylist),
        toArbiter: isRunning && Boolean(ai.stageCascade?.toArbiter),
      };

      latestPresetPipelines = ai.presetPipelines || {};
      window.__transComparatorAiPresetPipelines = latestPresetPipelines;
      const stageMetrics = updateStageMetricsDashboard(ai.stageMetrics, ai.stagePipelines, isRunning, ai.stageErrors);
      const stageMetricsSummary = stageMetricsSummaryCache;
      const aiRunId = ai.runId || "";
      if (receipt.runChanged) {
        warnedLegacyService = false;
      }
      // 旧服务仍将单阶段按钮解释成整条流水线，提示用户更新常驻进程。
      if (isRunning && ai.stagePipelines && !ai.stageControls && !warnedLegacyService) {
        warnedLegacyService = true;
        showToast("控制台服务未更新（没有回报独立阶段启停信息），本次无法独立控制各阶段。请重启控制台服务（start-setup.bat）后重新启动任务。", { tone: "watch", durationMs: 20000 });
      }
      const sameAiScope = receipt.sameScope;
      if (receipt.cleared) {
        renderClearedAiStatus();
        return;
      }
      renderAiCacheMetrics(sameAiScope ? ai.metrics : null, { resetHover: receipt.runChanged || !sameAiScope });
      if (ai.running) {
        aiCacheCleared = false;
      }
      if (ai.protocolDefaults) {
        protocolDefaults = ai.protocolDefaults;
        applyProtocolDefaults(protocolDefaults[aiIds.protocol.value]);
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
      const rowTotal = Math.max(0, ai.total || 0);
      const skippedDone = Math.min(rowTotal || Infinity, Math.max(0, ai.skippedDone || 0));
      const rulePrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.rulePrefiltered || 0));
      const similarityPrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.similarityPrefiltered || 0));
      const structuredConflicts = Math.min(rowTotal || Infinity, Math.max(0, ai.structuredConflicts || 0));
      const termPrefiltered = Math.min(rowTotal || Infinity, Math.max(0, ai.termPrefiltered || 0));
      const termInjected = Math.min(rowTotal || Infinity, Math.max(0, ai.termInjected || 0));
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
        committedStagePresetIds("stage2").length > 0
      );
      const hasStoppedStage = Object.values(ai.stageControls || {}).some((control) => control.stopRequested);
      const finishedStatus = (isPrefilter ? (ai.stopRequested ? "预筛选已终止：" : "预筛选完成：") : (ai.stopRequested ? "AI 校对已终止：" : (hasStoppedStage ? "AI 校对已结束（含已停止阶段）：" : "AI 校对完成：")) + "实际调用 " + queueText + "，") +
        (isPrefilter ? "" : (isMultiStage ? "" : skipText + "，")) +
        (isMultiStage
          ? "建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0)
          : prefilterText + (isPrefilter ? "，" + pendingText : "，建议 " + (ai.suggested || 0) + "，错误 " + (ai.errors || 0)));

      if (aiIds.panelState) {
        setLiveHoverTitle(aiIds.panelState, stageMetricsSummary);
        if (ai.running) {
          aiIds.panelState.textContent = isPrefilter
            ? "预筛选中..."
            : ("校对中" + (ai.currentConcurrency ? " (" + ai.currentConcurrency + ")" : "") + "...");
          aiIds.panelState.className = "ai-status-badge is-running";
        } else if (ai.finishedAt) {
          aiIds.panelState.textContent = isPrefilter
            ? (ai.stopRequested ? "预筛选已终止" : "预筛选完成")
            : (ai.stopRequested ? "已终止" : (hasStoppedStage ? "校对已结束" : "校对完成"));
          aiIds.panelState.className = "ai-status-badge";
        } else if (ai.error && !ai.breakerWarning) {
          aiIds.panelState.textContent = "调用异常";
          aiIds.panelState.className = "ai-status-badge";
        } else if (ai.breakerWarning) {
          aiIds.panelState.textContent = "部分预设熔断";
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
        showToast(ai.error || ai.breakerWarning || finishedStatus, {
          tone: ai.error && !ai.breakerWarning ? "error" : (ai.breakerWarning || ai.stopRequested ? "watch" : (hasStoppedStage ? "info" : "success")),
          durationMs: ai.error ? 15000 : 12000,
        });
      }
      const previousActive = Array.from(aiActiveIds).join(",");
      aiActiveIds.clear();
      for (const id of (ai.active || []).map(String)) aiActiveIds.add(id);
      const nextActive = Array.from(aiActiveIds).join(",");
      if (previousActive !== nextActive) updateRenderedAiActive();
      const delivery = aiResultReception.commit(receipt, (pendingResults, summary) => {
        for (const result of pendingResults) {
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
        if (summary.skippedStale) {
          reportRuntimeNotice("已跳过 " + summary.skippedStale + " 条与当前工作台行内容不匹配的自动结果。");
        }
        if (summary.ignoredForeign) {
          reportRuntimeNotice("已忽略非当前项目快照的自动结果；当前项目备注保持独立。");
        }
      });
      if (delivery.applied && (prefilterResultFilterActive || query.value.trim() || notesOnly || doneMode !== "all" || aiResultFilter !== "all" || issueSeverityFilter !== "all")) {
        if (ai.running) {
          scheduleThrottledApplyFilters();
        } else {
          applyFilters({ reset: false });
        }
      }
      updatePrefilterConfirmButton(ai);
    }

    function refreshAiStatus() {
      return aiResultReception.refresh();
    }

    function setModelOptions(models, { selected = aiIds.model.value } = {}) {
      const resolved = resolveModelOptions(models, selected);
      aiModelOptions = resolved.models;
      aiModelMetadataMap.clear();
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
      const requestedProtocol = aiIds.protocol?.value || "";
      const requestedProvider = aiIds.provider.value;
      const requestedApiKey = aiIds.apiKey.value;
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
            protocol: aiIds.protocol?.value || "local",
            provider: aiIds.provider.value.trim(),
            baseUrl: aiIds.baseUrl?.value || "",
            apiKey: aiIds.apiKey?.value || "",
            model: modelVal,
            reasoningEffort: aiIds.reasoningEffort?.value || "",
          }),
        });
        const data = await response.json();
        const currentBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl?.value || "");
        if (aiIds.protocol?.value !== requestedProtocol || currentBaseUrl !== requestedBaseUrl
          || aiIds.provider.value !== requestedProvider || aiIds.apiKey.value !== requestedApiKey || aiIds.model.value !== modelVal) {
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
      const requestedProtocol = aiIds.protocol.value;
      const requestedProvider = aiIds.provider.value;
      const requestedApiKey = aiIds.apiKey.value;
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
            protocol: aiIds.protocol.value,
            provider: aiIds.provider.value.trim(),
            baseUrl: aiIds.baseUrl.value,
            apiKey: aiIds.apiKey.value,
          }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error);
        const currentBaseUrl = normalizeApiBaseUrl(aiIds.baseUrl.value);
        if (aiIds.protocol.value !== requestedProtocol || currentBaseUrl !== requestedBaseUrl
          || aiIds.provider.value !== requestedProvider || aiIds.apiKey.value !== requestedApiKey) {
          finishModelHint("接口地址已变更，已忽略旧地址返回的模型列表。", { tone: "watch", durationMs: 9000 });
          return;
        }
        const models = data.models?.models || data.models || [];
        const defaultModel = protocolDefaults[aiIds.protocol.value]?.model || "";
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

    aiIds.protocol.addEventListener("change", async () => {
      aiIds.baseUrl.dataset.touched = "";
      aiIds.model.dataset.touched = "";
      aiModelOptions = [];
      if (protocolDefaults[aiIds.protocol.value]) {
        applyProtocolDefaults(protocolDefaults[aiIds.protocol.value], { force: true });
        saveAiConfig();
        return;
      }
      try {
        const response = await apiFetch("/api/ai-proofread/status");
        const data = await response.json();
        protocolDefaults = data.ai?.protocolDefaults || protocolDefaults;
        applyProtocolDefaults(protocolDefaults[aiIds.protocol.value], { force: true });
      } catch {
        setProtocolHint(null);
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
          clearPresetFields();
          updatePresetActionButtons();
          showToast("已清空 AI 服务配置，填写后点「另存为预设」保存新预设", { tone: "info", durationMs: 6000 });
          return;
        }
        const preset = presetTools.getPreset(localStorage, selectedId);
        if (preset) {
          applyPreset(preset);
          showToast("已应用模型预设「" + presetTools.presetLabel(preset) + "」", { tone: "success", durationMs: 4000 });
        }
      });
    }
    if (aiIds.presetSaveAs) {
      aiIds.presetSaveAs.addEventListener("click", () => {
        const defaultName = (aiIds.model.value || aiIds.protocol.value || "新模型预设").trim();
        const promptFn = typeof window !== "undefined" && typeof window.prompt === "function"
          ? window.prompt.bind(window)
          : (typeof prompt === "function" ? prompt : null);
        const confirmFn = typeof window !== "undefined" && typeof window.confirm === "function"
          ? window.confirm.bind(window)
          : (typeof confirm === "function" ? confirm : () => true);

        const name = promptFn ? (promptFn("请输入模型预设名称：", defaultName) || "").trim() : defaultName;
        if (!name) return;

        const presets = presetTools.listPresets(localStorage);
        const existing = presetTools.findPresetByName(presets, {
          name, protocol: aiIds.protocol.value, provider: aiIds.provider.value, baseUrl: aiIds.baseUrl.value,
        });
        if (existing) {
          if (!confirmFn("已存在预设「" + presetTools.presetLabel(existing) + "」，是否覆盖更新？")) {
            return;
          }
        }

        const presetData = {
          id: existing ? existing.id : undefined,
          name,
          protocol: aiIds.protocol.value,
          provider: aiIds.provider.value.trim(),
          baseUrl: aiIds.baseUrl.value,
          apiKey: aiIds.apiKey.value,
          model: aiIds.model.value,
          modelOptions: aiModelOptions,
          modelMetadata: sanitizeModelMetadata([...aiModelMetadataMap.values()]),
          reasoningEffort: aiIds.reasoningEffort.value,
          gptReasoningEffort: savedGptReasoningEffort,
          nonGptIntensity: savedNonGptIntensity,
          concurrency: aiIds.concurrency.value,
        };

        const saved = presetTools.savePreset(localStorage, presetData);
        if (saved) {
          currentPresetId = saved.id;
          renderPresetOptions(saved.id);
          saveAiConfig();
          showToast("已保存模型预设「" + presetTools.presetLabel(saved) + "」", { tone: "success", durationMs: 5000 });
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

        if (!confirmFn("确定要将当前修改保存到预设「" + presetTools.presetLabel(current) + "」吗？")) {
          return;
        }

        const presetData = {
          id: current.id,
          name: current.name,
          protocol: aiIds.protocol.value,
          provider: aiIds.provider.value.trim(),
          baseUrl: aiIds.baseUrl.value,
          apiKey: aiIds.apiKey.value,
          model: aiIds.model.value,
          modelOptions: aiModelOptions.length ? aiModelOptions : current.modelOptions,
          modelMetadata: sanitizeModelMetadata([...aiModelMetadataMap.values()]),
          reasoningEffort: aiIds.reasoningEffort.value,
          gptReasoningEffort: savedGptReasoningEffort,
          nonGptIntensity: savedNonGptIntensity,
          concurrency: aiIds.concurrency.value,
        };

        const collision = presetTools.findPresetByName(presetTools.listPresets(localStorage), presetData);
        if (collision && collision.id !== current.id) {
          showToast("该提供商已有同名预设，请另存为其他名称。", { tone: "watch" });
          return;
        }
        const saved = presetTools.savePreset(localStorage, presetData);
        if (saved) {
          // 覆盖保存后必须重渲染下拉：阶段卡片的选项 title 里带着模型名与并发提示，
          // 不重建就会一直显示旧值，与 localStorage 里已生效的新预设不一致。
          renderPresetOptions(saved.id);
          saveAiConfig();
          showToast("已更新模型预设「" + presetTools.presetLabel(saved) + "」", { tone: "success", durationMs: 5000 });
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

        if (!confirmFn("确定要删除模型预设「" + presetTools.presetLabel(current) + "」吗？")) {
          return;
        }

        const deleted = presetTools.deletePreset(localStorage, current.id);
        if (deleted) {
          const deletedName = presetTools.presetLabel(current);
          currentPresetId = "";
          renderPresetOptions("");
          saveAiConfig();
          showToast("已删除模型预设「" + deletedName + "」", { tone: "watch", durationMs: 5000 });
        } else {
          showToast("删除模型预设失败", { tone: "error", durationMs: 5000 });
        }
      });
    }
    [aiIds.provider, aiIds.apiKey, aiIds.target, aiIds.concurrency, aiIds.proofreadMode, aiIds.reasoningEffort].filter(Boolean).forEach((input) => {
      function invalidateConnectionMetadata() {
        if (input === aiIds.provider || input === aiIds.apiKey) {
          aiModelMetadataMap.clear();
          updateInferenceSettingOptions();
        }
      }
      input.addEventListener("input", () => {
        invalidateConnectionMetadata();
        saveAiConfig();
      });
      input.addEventListener("change", () => {
        invalidateConnectionMetadata();
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
        saveAiConfig();
      });
    }
    if (aiIds.stage2Preset) {
      aiIds.stage2Preset.addEventListener("change", () => {
        updateStagePresetDependencies();
        saveAiConfig();
      });
    }
    if (aiIds.stage3Preset) {
      aiIds.stage3Preset.addEventListener("change", () => {
        saveAiConfig();
      });
    }
    [["stage1", aiIds.stage1PresetAdd], ["stage2", aiIds.stage2PresetAdd], ["stage3", aiIds.stage3PresetAdd]].forEach(([stage, button]) => {
      button?.addEventListener("click", () => addSelectedStagePreset(stage));
    });
    ["stage1", "stage2", "stage3"].forEach((stage) => {
      const controls = stagePresetControls[stage];
      const trigger = aiIds[controls.trigger];
      trigger?.addEventListener("click", (event) => {
        event?.stopPropagation?.();
        toggleStageAppliedMenu(stage);
      });
    });
    document.addEventListener("click", (event) => {
      if (!event.target.closest(".ai-stage-applied-dropdown")) {
        closeAllStageAppliedMenus();
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeAllStageAppliedMenus();
      }
    });
    closeAllStageAppliedMenus();
    aiIds.proofreadMode.addEventListener("change", updateProofreadModeHint);
    prefilterIds.similarity.addEventListener("input", saveAiConfig);
    prefilterIds.similarity.addEventListener("change", () => {
      normalizeSimilarityInput();
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
    // 保存没成功时，这批备注只活在当前页面内存里：刷新、关闭标签页或浏览器回收都会让它们消失。
    // 浏览器只在用户与页面交互过之后才显示这个原生确认框，正常浏览时不会被打扰。
    window.addEventListener("beforeunload", (event) => {
      if (notesStorage.disk) flushNotes();
      const state = notesPersistence.snapshot();
      const disk = notesStorage.disk ? notesStorage.snapshot() : {};
      if (!state.failed && !state.blocked && !disk.failed && !disk.blocked && !disk.pending) return;
      event.preventDefault();
      event.returnValue = "";
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) flushNotes();
    });
    function hasUnconfirmedAiProofreadNote(item) {
      if (!item || item.manualDone) return false;
      const note = String(item.note || "").trim();
      if (!note) return false;
      if (automatedNoteMarker(note) === "[AI校对]" || isAiFailureNote(note)) return true;
      return splitAiNoteParts(note).some((part) => part.startsWith("[AI校对]"));
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
      const clearedIndexes = [];
      for (const [id, item] of Object.entries(notes)) {
        if (!item || item.manualDone) continue;
        const fullNote = String(item.note || "");
        const note = latestAiNotePart(fullNote).trim();
        if (!note || !hasAutomatedDecisionNote(note)) continue;
        const p = parseAutomatedNote(note);
        if (!p) continue;
        const state = stageNoteState(note);
        const noteStart = fullNote.lastIndexOf(note);
        const replaceCurrentNote = (replacement) => fullNote.slice(0, noteStart) + replacement + fullNote.slice(noteStart + note.length);

        if (targetStage === "stage2") {
          if (!p.stage2 && !state.errors.stage2 && !state.errors.stage3) continue;
          // 清理 Stylist 复审及后续仲裁，保留初审改案
          const lines = splitNoteFields(note).filter((line) => {
            return line !== state.errors.stage2 && line !== state.errors.stage3 &&
              !line.startsWith("Stylist复审") &&
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
          item.note = replaceCurrentNote(lines.join("\n"));
          clearedIndexes.push(Number(id));
          clearedCount += 1;
        } else if (targetStage === "stage3") {
          if (!p.stage3 && !state.errors.stage3) continue;
          // 清理 Arbiter 仲裁，保留复审方案
          const lines = splitNoteFields(note).filter((line) => {
            return line !== state.errors.stage3 && !line.startsWith("Arbiter仲裁") &&
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
          item.note = replaceCurrentNote(lines.join("\n"));
          clearedIndexes.push(Number(id));
          clearedCount += 1;
        }
      }
      if (clearedCount > 0) {
        forgetPersistedAiResults(clearedIndexes);
        saveNotes();
        applyFilters({ reset: false });
        updateStageMetricsDashboard();
      }
      return clearedCount;
    }

    function clearUnconfirmedAiProofreadNotes() {
      let clearedCount = 0;
      const clearedIndexes = [];
      for (const [id, item] of Object.entries(notes)) {
        if (!item || item.manualDone) continue;
        const note = String(item.note || "").trim();
        if (!note) continue;
        const parts = splitAiNoteParts(note);
        const isFullAiNote = parts.length === 1 && (automatedNoteMarker(note) === "[AI校对]" || isAiFailureNote(note));
        if (isFullAiNote) {
          item.note = "";
          item.revisionText = "";
          item.revisionTarget = "";
          item.aiDone = false;
          cleanAiFailureState(item);
          pruneEmptyNote(id);
          clearedIndexes.push(Number(id));
          clearedCount += 1;
        } else if (parts.some((part) => part.startsWith("[AI校对]"))) {
          const remainingParts = parts.filter((part) => !part.startsWith("[AI校对]"));
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
          clearedIndexes.push(Number(id));
          clearedCount += 1;
        }
      }
      if (clearedCount > 0) {
        forgetPersistedAiResults(clearedIndexes);
        aiResultReception.discardCurrentRun();
        aiActiveIds.clear();
        updateRenderedAiActive();
        saveNotes();
        applyFilters({ reset: false });
        updateDoneCount();
      }
      return clearedCount;
    }

    function forgetPersistedAiResults(indexes) {
      return aiResultReception.forgetRows(indexes);
    }

    let latestStagePipelines = null;
    let latestStageControls = null;
    let runningAiStage = null;
    let currentStageCascade = { toStylist: false, toArbiter: false };
    let latestAiStopRequested = false;
    let pendingStopAll = false;
    let warnedLegacyService = false;
    const pendingStageStarts = new Set();
    const pendingStageStops = new Set();

    function aiStartConfigurationError(stage) {
      if (stage === "all") {
        for (const key of ["stage1", "stage2", "stage3"]) {
          if (key !== "stage1" && !committedStagePresetIds(key).length) continue;
          const error = aiStartConfigurationError(key);
          if (error) return error;
        }
        return "";
      }
      const label = { stage1: "阶段一", stage2: "阶段二", stage3: "阶段三" }[stage];
      const ids = committedStagePresetIds(stage);
      if (!ids.length && stage !== "stage1") return `请先为${label}添加适用的模型预设。`;
      const configs = ids.length
        ? ids.map((id) => ({ id, preset: presetTools.getPreset(localStorage, id) }))
        : [{ preset: { model: aiIds.model.value }, main: true }];
      for (const { id, preset, main } of configs) {
        if (!preset) return `${label}适用预设已失效，请移除后重新添加（${id}）。`;
        const model = String(preset.model || "").trim();
        if (!model || model === "custom") {
          const source = main ? "主配置" : `适用预设「${presetTools.presetLabel(preset)}」`;
          return `${label}${source}尚未选择模型，请先补全模型配置。`;
        }
      }
      return "";
    }

    function validateAiStart(stage) {
      const error = aiStartConfigurationError(stage);
      if (!error) return true;
      setAllStageButtonsRunning();
      showToast(error, { tone: "watch", durationMs: 8000 });
      return false;
    }

    function cascadeFromStage(stage) {
      if (stage !== "all") return { toStylist: false, toArbiter: false };
      return {
        toStylist: stagePresetsFor("stage2").length > 0,
        toArbiter: stagePresetsFor("stage3").length > 0,
      };
    }

    function getStageActiveStates(running, stagePipelines = null) {
      const isRunning = running != null ? Boolean(running) : currentAiRunning;
      const pipelines = stagePipelines || latestStagePipelines || {};
      const hasPipelineWork = Object.values(pipelines).some((pipeline) => Number(pipeline.inFlight) > 0 || Number(pipeline.pending) > 0);
      return Object.fromEntries(["stage1", "stage2", "stage3"].map((stage) => {
        const pipeline = pipelines[stage] || {};
        const legacyActive = runningAiStage === stage
          || Number(pipeline.inFlight) > 0 || Number(pipeline.pending) > 0
          || (stage === "stage2" && currentStageCascade.toStylist)
          || (stage === "stage3" && currentStageCascade.toArbiter);
        const active = isRunning && (latestStageControls
          ? Boolean(latestStageControls[stage]?.running)
          : legacyActive || (!runningAiStage && !hasPipelineWork && stage === "stage1"));
        return [stage, active || pendingStageStarts.has(stage)];
      }));
    }

    function setAllStageButtonsRunning(running = null, stagePipelines = null) {
      if (stagePipelines) latestStagePipelines = stagePipelines;
      const active = getStageActiveStates(running, stagePipelines);
      for (const stage of ["stage1", "stage2", "stage3"]) {
        const start = document.getElementById(stage + "Start") || (stage === "stage1" ? aiIds.start : null);
        const stop = document.getElementById(stage + "Stop") || (stage === "stage1" ? aiIds.stop : null);
        const stopping = pendingStageStops.has(stage) || latestStageControls?.[stage]?.stopRequested;
        if (start) {
          const error = aiStartConfigurationError(stage);
          start.disabled = Boolean(error) || active[stage] || pendingStageStops.has(stage) || pendingStopAll || latestAiStopRequested;
          start.title = error;
        }
        if (stop) stop.disabled = !active[stage] || Boolean(stopping) || pendingStageStarts.has(stage);
      }
      const anyRunning = (running ?? currentAiRunning) || Object.values(active).some(Boolean);
      const startAll = document.getElementById("aiStartAll");
      const stopAll = document.getElementById("aiStopAll");
      if (startAll) {
        const error = aiStartConfigurationError("all");
        startAll.disabled = Boolean(error) || Boolean(anyRunning) || pendingStageStops.size > 0 || pendingStopAll;
        startAll.title = error;
      }
      if (stopAll) stopAll.disabled = !anyRunning || pendingStageStarts.size > 0 || pendingStopAll || Object.entries(active).every(([stage, enabled]) =>
        !enabled || pendingStageStarts.has(stage) || pendingStageStops.has(stage) || latestStageControls?.[stage]?.stopRequested);
    }
    setAllStageButtonsRunning(false);

    let pendingStartStage = "stage1";

    function canClearStageForRestart() {
      if (!validateAiStart(pendingStartStage)) return false;
      if (!currentAiRunning && pendingStageStarts.size === 0) return true;
      showToast("仍有阶段正在运行，请先停止后再清空重跑；也可选择继续剩下的。", { tone: "watch", durationMs: 6000 });
      return false;
    }

    async function promptAndStartAi(stage = "stage1") {
      const active = getStageActiveStates(currentAiRunning);
      if (pendingStopAll || latestAiStopRequested || pendingStageStops.has(stage) || active[stage]
        || (stage === "all" && (currentAiRunning || pendingStageStarts.size || pendingStageStops.size))) return;
      if (!validateAiStart(stage)) return;
      pendingStartStage = stage;

      if (stage === "stage2") {
        const hasStage1Suggestions = Object.values(notes).some((item) => {
          return getStage2RowStatus(item).isRelevant;
        });
        if (!hasStage1Suggestions) {
          showToast("当前没有未人工确认的初审提改或存疑行，请先运行阶段一事实初审。", { tone: "watch", durationMs: 6000 });
          return;
        }

        let reviewedCount = 0;
        let pendingCount = 0;
        for (const [id, item] of Object.entries(notes)) {
          const state = getStage2RowStatus(item);
          if (state.isReviewed) reviewedCount += 1;
          else if (state.isPending) pendingCount += 1;
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
            if (!canClearStageForRestart()) return;
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
        let arbitratedCount = 0;
        let pendingArbCount = 0;
        for (const [id, item] of Object.entries(notes)) {
          const s = getStage3RowStatus(item);
          if (s.isArbitrated) arbitratedCount += 1;
          else if (s.isPending) pendingArbCount += 1;
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
            if (!canClearStageForRestart()) return;
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

      if (stage === "stage1" || stage === "all") {
        // 一键开始才推进配置好的下游，单独初审只消费初审队列。
        const plan = cascadeFromStage(stage);
        const tailText = plan.toStylist
          ? (plan.toArbiter ? "初审 → 复审 → 仲裁" : "初审 → 复审")
          : (plan.toArbiter ? "初审；仲裁处理已有分歧" : "");
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
            if (!canClearStageForRestart()) return;
            const cleared = clearUnconfirmedAiProofreadNotes();
            if (cleared > 0) {
              showToast(`已清空 ${cleared} 条未人工确认的 AI 校对信息。`, { tone: "info", durationMs: 6000 });
            }
            await startAiProofread({ continueOnly: false, stage });
          } else {
            await startAiProofread({ continueOnly: true, stage });
          }
          return;
        }
        await startAiProofread({ continueOnly: false, stage });
      } else {
        await startAiProofread({ continueOnly: false, stage });
      }
    }

    async function startAiProofread({ continueOnly = false, stage = "stage1" } = {}) {
      if (!validateAiStart(stage)) return;
      const plan = cascadeFromStage(stage);
      const startingStages = stage === "all"
        ? ["stage1", ...(plan.toStylist ? ["stage2"] : []), ...(plan.toArbiter ? ["stage3"] : [])]
        : [stage];
      if (pendingStopAll || latestAiStopRequested || startingStages.some((key) => pendingStageStarts.has(key) || pendingStageStops.has(key))) return;
      startingStages.forEach((key) => pendingStageStarts.add(key));
      aiResultReception.invalidateStatusRequests();
      setAllStageButtonsRunning();
      aiCacheCleared = false;
      if (aiIds.panel) aiIds.panel.open = true;

      const baseConfig = aiConfig();
      baseConfig.stage = stage;
      baseConfig.continueOnly = Boolean(continueOnly);

      const rowNotes = {};
      for (const [id, item] of Object.entries(notes)) {
        if (item && item.note) rowNotes[id] = item.note;
      }
      baseConfig.rowNotes = rowNotes;
      const forgetResultIndexes = aiResultReception.snapshot().forgottenIndexes;
      baseConfig.forgetResultIndexes = forgetResultIndexes;

      if (continueOnly) {
        // 跳过口径取决于本次是「从起点一路推进到尽头」还是「只跑这一段」：
        // 级联时整行必须走完从起点往下的所有阶段才算处理过，单阶段时只看本阶段有没有结论。
        const cascadeToStylist = stage === "all"
          && Boolean(baseConfig.stylistConfig || baseConfig.singleModelPersona);
        const cascadeToArbiter = stage === "all"
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
          const noteText = latestAiNotePart(item.note).trim();
          // 初审续跑必须先有可用结论才可跳过。失败/终止/空备注不属于复审候选，
          // 但不能因此被下面的「无需复审」分支误判为整行已经完成。
          if ((stage === "stage1" || stage === "all") && !hasAutomatedDecisionNote(noteText)) {
            completedSet.delete(num);
            continue;
          }
          const p = parseAutomatedNote(noteText);
          if (cascadeToStylist || cascadeToArbiter) {
            // 整行口径：已终审、复审已定案、初审明确通过且非复审候选，都算走完。
            // 「提交仲裁/升级仲裁」是复审的中途态不是结论——有分歧却还没仲裁的行必须留在流水线里，
            // 初审提改却还没复审的行同理，都不能被当成已完成跳过。
            const hasPendingArbitration = cascadeToArbiter && stageNoteState(noteText).pendingArbitration;
            const stage3Done = stageNoteState(noteText).arbitrated;
            const stage2Settled = !hasPendingArbitration
              && (hasCompletedStage2Note(p, noteText) || !isStage2CandidateNote(p, noteText));
            const stage1Clear = p?.modify === "否" && !isStage2CandidateNote(p, noteText);
            const settled = cascadeToArbiter
              ? (stage3Done || stage2Settled || stage1Clear)
              : (stage2Settled || stage1Clear);
            if (settled) completedSet.add(num);
          } else if (stage === "stage1" || stage === "all") {
            if (item.aiDone || hasAutomatedDecisionNote(noteText)) completedSet.add(num);
          } else if (stage === "stage2") {
            if (!getStage2RowStatus(item).isPending) {
              completedSet.add(num);
            }
          } else if (stage === "stage3") {
            const hasS3 = stageNoteState(noteText).arbitrated;
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
        aiResultReception.invalidateStatusRequests();
        aiResultReception.acknowledgeForgotten(forgetResultIndexes);
        renderAiStatus({ ...data.ai, stageMode: data.ai?.stageMode || (stage === "all" ? "stage1" : stage) });
        refreshAiStatus();
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
      } finally {
        startingStages.forEach((key) => pendingStageStarts.delete(key));
        setAllStageButtonsRunning();
      }
    }

    function hasCompletedStage2Note(parsed, noteText = "") {
      return stageNoteState(noteText).reviewed;
    }

    function isStage2CandidateNote(parsed, noteText = "") {
      return stageNoteState(noteText).candidate;
    }

    async function stopAiProofread(stage = "all") {
      if (pendingStopAll || (stage === "all" ? pendingStageStarts.size > 0 : pendingStageStarts.has(stage) || pendingStageStops.has(stage))) return;
      if (stage === "all") pendingStopAll = true;
      const stages = stage === "all" ? ["stage1", "stage2", "stage3"] : [stage];
      stages.forEach((key) => pendingStageStops.add(key));
      aiResultReception.invalidateStatusRequests();
      setAllStageButtonsRunning();
      try {
        const response = await apiFetch("/api/ai-proofread/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ stage: stage || "all" }),
        });
        const data = await response.json();
        if (!data.ok) throw new Error(data.error || "停止失败");
        aiResultReception.invalidateStatusRequests();
        renderAiStatus(data.ai);
        refreshAiStatus();
      } catch (error) {
        showToast(error.message, { tone: "error", durationMs: 12000 });
      } finally {
        if (stage === "all") pendingStopAll = false;
        stages.forEach((key) => pendingStageStops.delete(key));
        setAllStageButtonsRunning();
      }
    }

    if (aiConfirmIds.dialog) {
      if (aiConfirmIds.clear) {
        aiConfirmIds.clear.addEventListener("click", async () => {
          aiConfirmIds.dialog.close();
          if (!canClearStageForRestart()) return;
          const cleared = clearUnconfirmedStageNotes(pendingStartStage === "all" ? "stage1" : pendingStartStage);
          if (cleared > 0) {
            const msg = (pendingStartStage === "stage1" || pendingStartStage === "all")
              ? `已清空 ${cleared} 条未人工确认的 AI 校对信息。`
              : (pendingStartStage === "stage3"
                ? `已清空 ${cleared} 条未人工确认的终审仲裁方案。`
                : (pendingStartStage === "stage2"
                  ? `已清空 ${cleared} 条未人工确认的文学复审方案。`
                  : `已清空 ${cleared} 条未人工确认的方案。`));
            showToast(msg, { tone: "info", durationMs: 6000 });
          }
          // 弹窗只选择重跑方式，保留独立阶段或一键开始的范围。
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
            : (plan.toArbiter ? "初审；仲裁处理已有分歧" : "");
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

    document.getElementById("aiStartAll")?.addEventListener("click", () => promptAndStartAi("all"));
    document.getElementById("aiStopAll")?.addEventListener("click", () => stopAiProofread("all"));

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
        if (currentAiRunning || pendingStageStarts.size > 0 || pendingStageStops.size > 0) {
          showToast("AI 校对仍在运行，请先停止任务再清除 AI 记录。", { tone: "watch", durationMs: 8000 });
          return;
        }
        if (!confirm("清除 AI 运行记录？备注与人工确认不会被清除。")) return;
        aiIds.clearCache.disabled = true;
        aiResultReception.ignoreRun(aiResultReception.snapshot().runId);
        clearLocalAiCache();
        renderClearedAiStatus();
        try {
          const response = await apiFetch("/api/ai-proofread/cache/clear", { method: "POST" });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || "清除失败。");
          aiResultReception.ignoreRun(data.ai?.runId);
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

    function inventoryAllNotesSpaces() {
      serializeNotes(); // Export also includes fresh signatures before a deferred save.
      return notesTools.inventory(notesStorage, storageKey, notes);
    }

    // 备注空间按 projectKey 隔离；磁盘归档和旧浏览器存储遵循同一归属。
    // 当前工作台只对「本项目的空间」做找回，其他项目的历史仍保留，
    // 切换到对应项目后再由它自己的工作台读取，避免跨项目误找回或误清空。
    function collectNotesSpaces() {
      return inventoryAllNotesSpaces().filter((space) => space.current || space.sameProject);
    }

    // 其他项目/旧版空间提供独立的归档管理入口，不参与本项目找回。
    function collectForeignNotesSpaces() {
      return inventoryAllNotesSpaces().filter((space) => !space.current && !space.sameProject);
    }

    function notesBackup(spaces) {
      const exported = spaces.slice();
      // 当前损坏/冲突的磁盘版本也随备份保留，不能用空的内存记录替代它。
      if (notesPersistence.snapshot().blocked && spaces.some((space) => space.current)) {
        const raw = notesStorage.getItem(storageKey);
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

    // 其他项目/旧版空间只提供导出与删除：跨项目找回会把这些记录错嫁到当前行集上，必须挡住。
    // 按钮携带空间键而不是列表下标：当前项目空间与其他项目空间各自成表，用键回查不会串。
    function notesSpaceMarkup(space, { foreign = false } = {}) {
      const stats = space.entries + " 条记录 · 人工确认 " + space.confirmed
        + (space.unverified ? " · 待核验 " + space.unverified : "")
        + " · 约 " + (space.bytes / 1024).toFixed(1) + " KB";
      const canRecover = !foreign && !space.current && space.entries && !space.parseFailed;
      const spaceKey = escapeHtml(space.key);
      return [
        '<article class="notes-space-row' + (space.current ? " is-current" : "") + '">',
        '<div class="notes-space-main"><div class="notes-space-heading"><strong>' + escapeHtml(notesSpaceTitle(space)) + '</strong>',
        space.current ? '<span class="notes-space-tag">正在使用</span>' : '',
        space.parseFailed ? '<span class="notes-space-tag is-warn">无法解析</span>' : '',
        !space.current && space.sameSnapshot ? '<span class="notes-space-tag">同一行集</span>' : '',
        '</div><div class="notes-space-meta">' + stats + '</div>',
        '<details class="notes-space-details"><summary>空间详情' + (space.version ? " · " + escapeHtml(space.version) : "") + '</summary>',
        '<code>' + spaceKey + '</code>',
        '<p>' + (space.minIndex == null ? "没有有效行记录。" : "行号范围 " + space.minIndex + "–" + space.maxIndex) + '</p>',
        canRecover ? '<button type="button" class="btn btn--ghost" data-notes-index="' + spaceKey + '">按行号找回（需核验）</button>' : '',
        space.current ? '' : '<button type="button" class="btn btn--ghost notes-delete" data-notes-drop="' + spaceKey + '">删除此空间</button>',
        '</details></div><div class="notes-space-actions">',
        canRecover ? '<button type="button" class="btn btn--primary" data-notes-restore="' + spaceKey + '">预览找回</button>' : '',
        '<button type="button" class="btn btn--ghost" data-notes-export="' + spaceKey + '">' + (space.current ? "导出本页" : "导出") + '</button>',
        '</div></article>',
      ].join('');
    }

    // 其他项目/旧版空间单列一区，磁盘模式无需删除它们为本页腾出浏览器容量。
    // 这里只提供导出与删除，找回入口一律不给——跨项目找回会把别的书的记录错嫁到当前行集上。
    function renderForeignNotesSpaces(spaces) {
      const heading = document.getElementById("notesForeignHeading");
      const list = document.getElementById("notesForeignList");
      const summary = document.getElementById("notesForeignSummary");
      if (!heading || !list) return;
      heading.hidden = !spaces.length;
      list.hidden = !spaces.length;
      if (!spaces.length) {
        list.innerHTML = "";
        if (summary) summary.textContent = "";
        return;
      }
      const totalKb = (spaces.reduce((total, space) => total + space.bytes, 0) / 1024).toFixed(1);
      if (summary) summary.textContent = spaces.length + " 个空间 · 约 " + totalKb + " KB"
        + (notesStorage.disk ? "（长期保存在电脑，无需为本页保存腾出浏览器容量）" : "（删除前请先导出）");
      list.innerHTML = spaces.map((space) => notesSpaceMarkup(space, { foreign: true })).join("");
    }

    function renderNotesSpaces() {
      const all = inventoryAllNotesSpaces();
      // notesSpaceInventory 只装「本项目的空间」：它是找回入口的唯一来源，跨项目空间不得进入。
      notesSpaceInventory = all.filter((space) => space.current || space.sameProject);
      const foreignSpaces = all.filter((space) => !space.current && !space.sameProject);
      const current = notesSpaceInventory.find((space) => space.current);
      const history = notesSpaceInventory.filter((space) => !space.current);
      const totalKb = (notesSpaceInventory.reduce((total, space) => total + space.bytes, 0) / 1024).toFixed(1);
      notesPanelIds.current.innerHTML = notesSpaceMarkup(current);
      notesPanelIds.summary.textContent = history.length + " 个本项目历史空间 · 本项目内容约 " + totalKb + " KB（含未保存修改）";
      notesPanelIds.clearHistory.disabled = !history.length;
      const usageLabel = document.getElementById("notesStorageUsage");
      if (usageLabel && notesStorage.disk) {
        const disk = notesStorage.snapshot();
        usageLabel.textContent = "磁盘备注目录：" + notesStorage.directory
          + " · 所有空间长期保留，旧浏览器副本核验成功后自动清理。"
          + (disk.cleanupWarning ? " " + disk.cleanupWarning : "");
      } else if (usageLabel) {
        const usage = notesTools.storageUsage(localStorage, storageKey, notesStorage.encode(JSON.stringify(notes)));
        const kb = (bytes) => (bytes / 1024).toFixed(1) + " KB";
        usageLabel.textContent = usage.available
          ? "同源浏览器存储估算：已占用 " + kb(usage.totalBytes) + " · 本页已保存 " + kb(usage.currentBytes)
            + " · 本项目历史 " + kb(usage.historyBytes) + " · 其他项目或旧版备注 " + usage.otherNotesCount + " 个空间 / " + kb(usage.otherNotesBytes)
            + " · 其他本地数据 " + kb(usage.otherBytes) + " · 无损压缩保存本页后预计 " + kb(usage.projectedBytes)
          : "无法读取浏览器存储占用，请检查站点存储权限。";
      }
      notesPanelIds.list.innerHTML = history.length
        ? history.map((space) => notesSpaceMarkup(space)).join('')
        : '<div class="notes-space-empty">暂无历史记录。可导入之前导出的 JSON 备份。</div>';
      renderForeignNotesSpaces(foreignSpaces);
      updateNotesSaveState();
    }

    function freshNotesSpace(key) {
      return collectNotesSpaces().find((space) => space.key === key);
    }

    // 导出与删除要对其他项目/旧版空间同样生效，找回仍然只走 freshNotesSpace（本项目）。
    function freshAnyNotesSpace(key) {
      return inventoryAllNotesSpaces().find((space) => space.key === key) || null;
    }

    function previewNotesRecovery(space, byIndex = false) {
      const plan = recoveryPlan(space, byIndex);
      pendingNotesRecovery = { key: space.key, raw: space.raw, byIndex, plan };
      const action = byIndex ? "按行号找回" : "按内容找回";
      notesPanelIds.apply.disabled = !plan.pairs.length || notesPersistence.snapshot().blocked;
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

    notesPanelIds.panel.addEventListener("click", async (event) => {
      const button = event.target.closest("[data-notes-export], [data-notes-restore], [data-notes-index], [data-notes-drop]");
      if (!button) return;
      const action = ["notesExport", "notesRestore", "notesIndex", "notesDrop"].find((key) => key in button.dataset);
      // 按钮带的是空间键：当前项目与其他项目/旧版空间都能回查到，
      // 但「预览找回 / 按行号找回」只在本项目空间上渲染，所以找回入口仍然进不来。
      const space = freshAnyNotesSpace(button.dataset[action]);
      if (!space) { renderNotesSpaces(); notesPanelStatus("该空间已发生变化，请重新选择。", { tone: "watch" }); return; }
      if (action === "notesExport") {
        downloadNotesJson("betweenlines-notes-" + (space.rows || "space") + ".json", notesBackup([space]));
      } else if (action === "notesRestore" || action === "notesIndex") {
        if (!space.current && space.data) previewNotesRecovery(space, action === "notesIndex");
      } else if (!space.current) {
        // 删除会移除别的项目的长期记录，确认文案必须点名所属项目。
        const foreign = !space.sameProject;
        const foreignNote = foreign
          ? "\n注意：这个空间属于其他项目（" + (space.project || "旧版") + "），删除后那个项目的工作台也看不到这些记录了。"
          : "";
        if (!(await askConfirm("删除「" + notesSpaceTitle(space) + "」的 " + space.entries + " 条记录？" + foreignNote + "\n删除不可撤销，请确认已经导出备份。", { title: foreign ? "删除其他项目的空间" : "删除历史空间", confirmText: "删除" }))) return;
        try {
          notesStorage.removeItem(space.key);
          if (notesStorage.disk) await notesStorage.flush();
          renderNotesSpaces();
          notesPanelStatus("已删除所选历史空间。", { tone: "success" });
        } catch (error) { notesPanelStatus("删除未完成：" + error.message, { tone: "error" }); }
      }
    });
    notesPanelIds.apply.addEventListener("click", async () => {
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
      if (notesPersistence.snapshot().blocked) { notesPanelStatus("请先解决保存冲突，再找回记录。", { tone: "watch" }); return; }
      applyRecovery(space, plan);
      saveNotes({ immediate: true });
      if (notesStorage.disk) { try { await notesStorage.flush(); } catch {} }
      markNotesDirtyForMetrics();
      updateStageMetricsDashboard(null, {}, false);
      updateDoneCount();
      applyFilters({ reset: false });
      notesPanelIds.dialog.close();
      renderNotesSpaces();
      notesPanelStatus("已找回 " + plan.pairs.length + " 条，其中 " + plan.unverified + " 条需逐行核验。"
        + (notesPersistence.snapshot().failed || notesPersistence.snapshot().blocked || notesStorage.snapshot?.().failed || notesStorage.snapshot?.().blocked ? "本次尚未保存，请先导出本页记录。" : "已保存到本页空间。"),
        { tone: notesPersistence.snapshot().failed || notesPersistence.snapshot().blocked || notesStorage.snapshot?.().failed || notesStorage.snapshot?.().blocked ? "watch" : "success" });
    });
    document.getElementById("cancelNotesRecovery").addEventListener("click", () => notesPanelIds.dialog.close());
    notesPanelIds.dialog.addEventListener("close", () => { pendingNotesRecovery = null; });
    notesPanelIds.exportAll.addEventListener("click", () => {
      downloadNotesJson("betweenlines-notes-backup.json", notesBackup(collectNotesSpaces()));
      notesPanelStatus("已导出本页和全部历史空间。", { tone: "success" });
    });
    // 其他项目/旧版空间不进「备份全部」（当前项目备份不得带出别的项目记录），
    // 跨项目归档需要一个独立的备份出口。
    const exportForeignNotes = document.getElementById("exportForeignNotes");
    if (exportForeignNotes) {
      exportForeignNotes.addEventListener("click", () => {
        const spaces = collectForeignNotesSpaces();
        if (!spaces.length) { notesPanelStatus("没有其他项目或旧版空间。", { tone: "watch" }); return; }
        downloadNotesJson("betweenlines-notes-other-projects.json", notesBackup(spaces));
        notesPanelStatus("已导出 " + spaces.length + " 个其他项目/旧版空间；导入时会回到各自项目名下，不会串到当前项目。", { tone: "success" });
      });
    }
    notesPanelIds.clearCurrent.addEventListener("click", async () => {
      const current = collectNotesSpaces().find((space) => space.current);
      if (!current?.entries) { notesPanelStatus("本页没有可清空的备注记录。", { tone: "watch" }); return; }
      if (!(await askConfirm("清空本页备注空间中的 " + current.entries + " 条记录？\n这会同时清除人工确认和修改结果，历史空间不会受影响。\n\n建议先备份，再确认清空。", { title: "清空本页备注", confirmText: "清空" }))) return;
      try {
        if (pageMeta.notesRecovery) {
          if (notesStorage.disk) {
            if (!await notesStorage.markRecovery(pageMeta.notesRecovery.id)) throw new Error("恢复标记保存失败，清空未执行，请保留页面后重试。");
          } else localStorage.setItem("translation-compare-recovery-v1:"
            + (pageMeta.projectKey || "") + ":" + pageMeta.notesRecovery.id, "saved");
        }
        notesPersistence.clearCurrent(() => {
          for (const id of Object.keys(notes)) delete notes[id];
          markNotesDirtyForMetrics();
          updateStageMetricsDashboard(null, {}, false);
        });
        if (notesStorage.disk) await notesStorage.flush();
        updateDoneCount();
        applyFilters({ reset: false });
        renderNotesSpaces();
        notesPanelStatus("已清空本页备注空间；历史空间仍保留。", { tone: "success" });
      } catch (error) { notesPanelStatus("清空失败：" + error.message, { tone: "error" }); }
    });
    notesPanelIds.clearHistory.addEventListener("click", async () => {
      const history = collectNotesSpaces().filter((space) => !space.current);
      if (!history.length) { notesPanelStatus("没有可清空的历史备注空间。", { tone: "watch" }); return; }
      const count = history.reduce((total, space) => total + space.entries, 0);
      if (!(await askConfirm("清空 " + history.length + " 个历史空间中的 " + count + " 条记录？\n此操作不可撤销，请先点击「备份全部」。", { title: "清空历史空间", confirmText: "清空" }))) return;
      try {
        for (const space of history) notesStorage.removeItem(space.key);
        if (notesStorage.disk) await notesStorage.flush();
        renderNotesSpaces();
        notesPanelStatus("已清空历史备注空间；本页记录保持不变。", { tone: "success" });
      } catch (error) { notesPanelStatus("清空历史未完成：" + error.message, { tone: "error" }); }
    });
    notesPanelIds.file.addEventListener("change", async () => {
      const [file] = notesPanelIds.file.files || [];
      notesPanelIds.file.value = "";
      if (!file) return;
      try {
        const spaces = notesTools.decodeBackup(JSON.parse(await file.text()));
        if (!(await askConfirm("从备份登记 " + spaces.length + " 个空间？\n相同内容跳过；同名且内容不同会保留为副本。当前项目空间可在历史列表预览，其他项目空间会保留在对应项目中。", { title: "导入备份", confirmText: "导入", danger: false }))) return;
        const scopedSpaces = spaces.map((space) => space.key === notesTools.prefix + "legacy-file"
          ? { ...space, key: notesTools.prefix + "v7:" + pageMeta.projectKey + ":legacy-file" } : space);
        const result = notesStorage.disk ? await notesStorage.importSpaces(scopedSpaces)
          : notesTools.importBackup(notesStorage, spaces, storageKey);
        renderNotesSpaces();
        const currentProject = notesTools.identity(storageKey).project;
        const foreignImported = currentProject
          ? result.imported.filter((key) => notesTools.identity(key).project !== currentProject).length
          : 0;
        notesPanelStatus("已导入 " + result.imported.length + " 个空间，跳过 " + result.skipped + " 个相同空间。"
          + (result.error ? "另有 " + result.failed + " 个未能保存。"
            + (notesTools.storageFailureKind(result.error) === "quota" ? "无损压缩后仍超出浏览器容量，请保留备份并检查存储占用。"
              : notesTools.storageFailureKind(result.error) === "denied" ? "浏览器禁止写入，请检查站点存储权限。" : "写入原因未明，请保留备份后重试。")
            : foreignImported
              ? "其中 " + foreignImported + " 个属于其他项目，当前页面不会显示；切换到对应项目后可查看。"
              : "可在当前项目历史列表预览找回。"),
          { tone: result.error ? "watch" : "success" });
      } catch (error) { notesPanelStatus("导入失败：" + error.message, { tone: "error" }); }
    });
    notesPanelIds.refresh.addEventListener("click", async () => {
      if (notesStorage.disk) {
        flushNotes();
        try { await notesStorage.refresh(); }
        catch (error) { notesPanelStatus("刷新未完成：" + error.message, { tone: "error" }); }
      }
      renderNotesSpaces();
    });
    document.getElementById("retryNotesSave").addEventListener("click", async () => {
      saveNotes({ immediate: true });
      if (notesStorage.disk) { try { await notesStorage.flush(); } catch {} }
      renderNotesSpaces();
      const state = notesPersistence.snapshot();
      const disk = notesStorage.disk ? notesStorage.snapshot() : {};
      if (!state.failed && !state.blocked && !disk.failed && !disk.blocked && !disk.pending) {
        notesPanelStatus("本页记录已保存。", { tone: "success" });
        return;
      }
      // 重试仍然失败时必须明说：原来只在成功时给回执，失败时横幅虽然还在，但用户点完按钮
      // 看不出「这次到底成没成」，很容易以为已经存好、转头去刷新页面——那会把只存在内存里的
      // 这批 AI 结果直接丢掉。
      notesPanelStatus(
        state.blocked
          ? "仍然无法保存：本页空间已被其他页面修改或无法解析。请先导出本页记录，再刷新页面核对。"
          : "仍然保存失败：" + notesSaveFailureMessage(),
        { tone: "error" });
    });
    notesPanelIds.panel.addEventListener("toggle", () => {
      if (notesPanelIds.panel.open) renderNotesSpaces();
    });
    window.addEventListener("storage", (event) => {
      if (event.key === storageKey || event.key === null) {
        notesPersistence.observeStorageChange();
      }
      if (notesPanelIds.panel.open) renderNotesSpaces();
    });
    renderNotesSpaces();
    if (notesStorage.disk) notesStorage.start();

    bindDetailsToggle();
    bindPanelGroups();
    initWorkbenchTabs();
    document.querySelectorAll("select").forEach(enhanceSelect);
    initProviderCombobox();
    restoreAiConfig();
    document.querySelectorAll("select").forEach(syncEnhancedSelect);
    // 特化规范 / 目标列都恢复后才有确定的对照表变体：这时再取构建期判定。
    refreshTermVerdicts();
    updateStageMetricsDashboard();
    refreshAiStatus();
    setInterval(refreshAiStatus, 1500);
    applyFilters();
    announceNotesRecovery();
