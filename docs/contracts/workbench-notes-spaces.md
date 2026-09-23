# 工作台、备注空间与客户端状态契约

本文档是 `AGENTS.md` 中关于前端工作台生成（`build-compare.js`）、备注空间管理（`notes-spaces.js`）、历史找回合并与客户端状态交互的详细领域契约。

## 控制栈抽屉结构（UI Panels）

- 生成页面的控制栈是四个 `<details class="panel-details">` 抽屉：
  1. 预筛选
  2. AI 辅助校对
  3. 筛选与批处理
  4. 备注空间与找回
  按数据流方向自上而下排列（机器加工 → 人工检索与批量落盘 → 数据保全）。
- 每个抽屉的 `<summary>` 含 `.panel-summary-state` 摘要行展示实时状态。
- `筛选与批处理`（`#filterPanel`，原「筛选与显示」与「批量操作」合并）收纳 filter-bar、显示开关与会改源文件的批量按钮。单个 `.action-bar` 内 `显示设置` 组在前、`修改结果操作` 组在后，靠 `.action-group + .action-group` 的分隔线区隔，批量按钮必须保持最后一组。默认全部折叠（不带 `open` 属性），避免机器任务被覆盖式展开。
- 四个抽屉统一置于父抽屉 `#controlStackPanel`（`.panel-group`，带 `data-panel-group`）的 `.panel-group-body` 内用于整组折叠/展开；父抽屉默认带 `open`。父摘要由客户端 `bindPanelGroups()` 在捕获阶段监听 `toggle` 事件同步展开数。

---

## 备注空间基本契约（Notes Spaces）

- `notes-spaces.js` 为纯函数辅助模块，注入生成页面并由 Node 测试复用；备注空间键与行内容签名保持原契约。
- 备份保留原始数据，导入同名空间只创建副本；找回保留当前行已有记录，不能通过释放来源空间应对配额不足。
- **未校验记录隔离**：`recoveredUnverified` 记录不能携带当前行的 `rowSig` 或计入人工确认。**按行号找回**与**只剩行序推断的锚点配对**必须保持此标记。
- **文本证据例外**：配对自带文本证据——记录里的「修改结果」与目标行现在的正文逐字相同（`pair.textConfirmed`）——按 `verified` 处理并保留人工确认。
- **行内核验徽标**：行内「未校验」徽标只解除该行的写回隔离，必须保持 `manualDone=false`/`done=false`，让它继续留在「未人工确认」筛选与当前写回候选集里；**不得顺带人工确认**。
- 清空操作：页面必须提供清空当前空间和清空历史空间的显式操作，均需二次确认且不能误删另一类空间。

---

## 多历史空间逐字段合并规则（Recovery Merge）

同一行在多份历史空间里记录不同时**必须逐字段合并，不得整条丢弃**：
- `rowsSignature` 是整张行集内容的哈希，重新生成工作台就会换键，旧记录只能靠「按内容找回」搬过来。
- **合并规则**（`mergeNotes`/`mergeRecoveredVariants`）：
  - 基准记录优先取有修改结果（`revisionText` 非空）的那份；
  - `manualDone`/`aiDone` 取任一为真；
  - 另一份记录的**分析内容**作为补充并**插到「修改结果：」之前**；
  - 合并**只对能证明属于同一行的条目**生效（`pair.verified`：行签名对得上，或「修改结果＝这一行现在的正文」的文本证据；或 `space.sameSnapshot` 下 `rowSig` 等于目标行签名）。
  - 合并涉及多个历史记录时打上 `mergedFromSpaces: true` 标记。
- **自动找回候选范围**：必须先限制为**同一 `projectKey` 的历史空间**；在此范围内取**全部历史空间的并集**；一条都对不上时提示「没有任何一条能按行内容对上本页」，并指向按行号找回。

---

## 确定性匹配通道与载入自愈

### 匹配层两条确定性通道（`alignLegacyNotes`）

1. **同索引 + 同签名**（`pair.sameIndex`）：内容重复的短行（如独立感叹号、问号、数字行）若同一行号上的正文签名仍与旧记录一致，视为未变动；仅在行集索引稳定时启用（已匹配记录里 ≥90% 落在同一行号且不少于 10 条）。
2. **修改结果＝目标行现在的正文**（`pair.textConfirmed`）：该文本在行集里唯一即成立，短文本还要求本来就在同一行号上（`to === from`）。这类配对按 `verified` 处理并保留人工确认。

### 载入自愈（`selfHealDamagedSpace`）

- 旧规则造成的损失可能已写入浏览器存储。`selfHealDamagedSpace()` 在载入时若发现本页空间还留着未校验记录，即按确定性证据补回缺失行（只补缺失行，不动已有记录），并由 `healApprovedRows()` 恢复人工确认。
- 求值期结果立即用 `persistNotes()` 落盘。无未校验记录的空间原样不动。

---

## 预筛选结果认领机制（`prefilterRunId`）

- 服务端 `clientStatus` 返回上一轮预筛结果。
- `renderAiStatus` 登记结果时以**运行号**（`prefilterRunId`）为准：遇到 `kind === "prefilter"` 且 `runId` 变化就整体替换 `prefilterResultIds`，不再要求必须在本页启动。
- 作用域限制在 `sameAiScope`（`projectKey` + `rowsSignature`），换快照的预筛结果不认领。

---

## 浮动提示（Toast）与状态行分工

- **一次性回执走 Toast**：按钮与控件结果（批量确认/写回、预筛/校对完成、模型刷新、空间备份找回删除等）渲染到 `#toastStack`（页面唯一浮动容器，在 `.app-shell` 之外）。
- 语气包含 `info`、`success`、`watch`、`error`；同一消息连续出现只保留一条并顺延存活时间；最多同时显示 4 条。
- **固定状态行只留持续状态**：`setRuntimeStatus` 只承载 AI/预筛的运行进度、跑完统计、服务连接状态，不设时长、不自动消失。
- 备注面板为唯一双写区域：`notesPanelStatus` 既写面板内就地状态行，也弹浮动提示。

---

## AI 模型预设管理（`ai-presets.js`）

- 存储键：`translation-compare-ai-presets-v1`。
- 包含完整连接与模型参数（`provider`、`baseUrl`、`apiKey`、`model`、`modelOptions`、`reasoningEffort`、`gptReasoningEffort`、`nonGptIntensity`、`concurrency`、`smartConcurrency`、`concurrencyMax`、`breakerThreshold`、`breakerDisabled`）。
- 当前预设 ID 保存在 `translation-compare-ai-config-v1` 的 `currentPresetId` 中，页面刷新时由 `restoreAiConfig` 自动恢复。
- 支持下拉切换、覆盖保存、另存为和删除预设，操作回执均通过 Toast 提示。

---

## 智能并发自适应调度（AIMD）

- 调度器采用 AIMD（加法递增、乘法递减）机制：
  - **动态上探**：连续 5 次请求成功且与上次调整间隔 ≥3s 自动上探（并发 +1，最高至 `concurrencyMax`，默认上限 10）。
  - **遇限下调**：遭遇频控或并发限制（HTTP 429、503、529 或包含 rate limit/TPM/RPM/quota/overload 等报错）自动下调（>3 时降至 70%，≤3 时减 1，保底 1），进入指数抖动退避窗口或遵循 `Retry-After`。
  - **重试保障**：单行支持最多 3 次自动重试，重试期间不计入熔断错误统计，达到重试上限才终局报错。

---

## 相关测试集

修改工作台页面脚本、备注空间与并发控制必须执行：
```powershell
node --test scripts/notes-spaces.test.js scripts/build-compare.test.js scripts/notes-recovery-merge.test.js scripts/toast.test.js scripts/ai-model-presets.test.js scripts/ai-smart-concurrency.test.js scripts/prefilter-restore.test.js
```
