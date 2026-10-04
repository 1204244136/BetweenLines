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
- `预筛选`（`#prefilterPanel`）内的 `.prefilter-runbar` 持有阈值与开始/停止，`.prefilter-results` 持有统计、原生复选开关 `#prefilterResultFilter` 与确认预筛；结果查看入口不再放入 `#filterPanel`。结果栏允许统计换行与操作组折行，不能用 `white-space: nowrap` 锁住整条统计。
- `筛选与批处理`（`#filterPanel`，原「筛选与显示」与「批量操作」合并）收纳 filter-bar、显示开关与会改源文件的批量按钮。单个 `.action-bar` 内 `显示设置` 组在前、`修改结果操作` 组在后，靠 `.action-group + .action-group` 的分隔线区隔，批量按钮必须保持最后一组。默认全部折叠（不带 `open` 属性），避免机器任务被覆盖式展开。
- 四个抽屉统一置于父抽屉 `#controlStackPanel`（`.panel-group`，带 `data-panel-group`）的 `.panel-group-body` 内用于整组折叠/展开；父抽屉默认带 `open`。父摘要由客户端 `bindPanelGroups()` 在捕获阶段监听 `toggle` 事件同步展开数。

---

## 备注空间基本契约（Notes Spaces）

- `notes-spaces.js` 为纯函数辅助模块，注入生成页面并由 Node 测试复用；备注空间键与行内容签名保持原契约。
- 备注空间键必须包含当前工作台的 `projectKey`（`translation-compare-notes-v7:<projectKey>:<rowsSignature>`）；`rowsSignature` 只区分同一项目的不同输入快照。浏览器 `localStorage` 虽由多个项目共用，但项目之间的空间必须逻辑隔离。
- 工作台的历史列表、`备份全部`、`清空历史`、历史找回和载入自愈只读取当前 `projectKey` 的空间（当前空间也必须保留）。其他项目的空间不得出现在当前页面的历史列表、备份结果或批量清理范围内；它们留在浏览器中，用户切换到对应项目后再由对应工作台读取。
- 跨项目的 JSON 导入必须经过当前项目命名空间校验；导入结果不得让当前工作台直接看到或操作另一个项目的历史空间。若备份包含多个项目，导入器应逐空间保留其项目归属，交由对应项目页面处理，不能把空间改写成当前项目的 key。
- 备份保留原始数据，导入同名空间只创建副本；找回保留当前行已有记录，不能通过释放来源空间应对配额不足。
- **未校验记录隔离**：`recoveredUnverified` 记录不能携带当前行的 `rowSig` 或计入人工确认。**按行号找回**与**只剩行序推断的锚点配对**必须保持此标记。
- **文本证据例外**：配对自带文本证据——记录里的「修改结果」与目标行现在的正文逐字相同（`pair.textConfirmed`）——按 `verified` 处理并保留人工确认。
- **行内核验徽标**：行内「未校验」徽标只解除该行的写回隔离，必须保持 `manualDone=false`/`done=false`，让它继续留在「未人工确认」筛选与当前写回候选集里；**不得顺带人工确认**。
- 清空操作：页面必须提供清空当前空间和清空历史空间的显式操作，均需二次确认且不能误删另一类空间。

---

## 多历史空间逐字段合并规则（Recovery Merge）

同一行在多份历史空间里记录不同时**必须逐字段合并，不得整条丢弃**：
- `rowsSignature` 是整张行集内容的哈希，只有源文本或对齐结果真实变化才换键；应用布局、重新发布相同行集和按模式裁剪字段不得改变它。换键后的旧记录通过「按内容找回」搬入新空间。
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
- 作用域限制在 `sameAiScope`（`projectKey` + `rowsSignature`）；项目或行集签名变化时不认领旧结果，仅重新发布相同行集不改变这一作用域。
- `updatePrefilterConfirmButton` 统一同步结果开关的 `disabled` / `checked`：认领运行号后即可查看，启动预筛自动勾选；清筛选只取消勾选，清运行记录同时清空运行号并禁用。确认仍仅作用于当前筛选范围内尚未人工确认且不需重新核验的预筛通过行，运行中或分页结果未收齐时禁用。

---

## 浮动提示（Toast）与进度承载分工

- **阶段指标筛选**：每项阶段数字使用独立的原生 `button`，选中状态同步到 `is-active` 与 `aria-pressed`；原生 Enter/Space 激活只走一次 `click`，不得额外绑定等价键盘事件。卡片正文不再拥有阶段总筛选、按钮角色或 Tab 停靠点。指标与顶部结论摘要共用一个可切换/取消的筛选状态，「清筛选」清除全部指标选中态。`computeStageMetricsFromNotes` 在原统计遍历中记录 `metricRowIds`，非待办指标直接读取该缓存，禁止另写备注分类规则；待复审/待仲裁继续使用共享当前轮次判据。分歧统计保留全部已仲裁记录，人工确认只移除尚待仲裁的待办。回归：`node --test scripts/stage-review-reports.test.js scripts/ai-stage-metrics.test.js scripts/build-compare.test.js`。
- **一次性回执走 Toast**：按钮与控件结果（批量确认/写回、预筛/校对完成、模型刷新、空间备份找回删除等）渲染到 `#toastStack`（页面唯一浮动容器，在 `.app-shell` 之外）。
- **两个工作台共享同一份实现与样式**：实现是 `public/workbench-shared.js` 的 `createToastCenter()`，样式是 `public/toast.css`（在 `.toast-stack` 上把 `--line/--focus…` 与 `--speaker-*` 两套 token 映射成 `--toast-*`）。翻译比较与说话人归属各自在页面里建一个中心并注入同一份样式——**不要把实现或样式复制回任一侧**，否则两边行为会各自漂移。
- **禁止阻塞式 `window.alert`**：说话人归属工作台原先所有一次性回执都走 alert，会打断校对流程且无法区分语气；一次性回执一律走 Toast，`scripts/speaker-attribution.test.js` 锁住这条边界。
- 语气包含 `info`、`success`、`watch`、`error`；同一消息连续出现只保留一条并顺延存活时间；最多同时显示 4 条。
- **停留时长口径**：`durationMs` 是基准时长，实际停留 = 基准 × `durationScale`（0.5）。**`error` 不参与缩放**——出错提示往往最长（定位失败原因、未写入行数、接口报错原文），折半会让用户读不完就被关掉。
- **AI 进度不再有全局状态行**：右上角的 `#aiStatus` 固定状态行与全局进度条 `#aiProgressWrap` 已整体移除，阶段进度改由每张阶段卡片自己的 `.ai-stage-card-progress`（`stageNProgressWrap` / `stageNProgress`）承载。阶段一的 `stage1Total` 只含通过、提改、存疑结论，不含调用失败；进度分母另包含队列与失败行，失败不计入完成数，未完成时百分比不得四舍五入到 100%。队列空但有失败时，无论流水线仍在跑还是已结束，初审胶囊均显示异常待重试。阶段一起步续跑的跳过名单须先验证最新备注有可用结论，失败、终止、空备注不能因非复审候选而被当成已完成。回归见 `scripts/ai-stage-metrics-regression.test.js`、`scripts/stage-note-state.test.js`。原来那条全局进度条按「模型实际调用数 / 总调用数」走，级联流水线在它上面看不出卡在哪个阶段。
- **`reportRuntimeNotice` 只报用户不知道的事**：它等价于 `showToast`，只承载「未连接到本地控制台服务」「已跳过 N 条与当前工作台行内容不匹配的结果」「已忽略非当前项目快照的结果」这类异常与副产物。用户自己刚点的动作（正在启动/终止/清除）不播报——它们完成时都有结果提示；每轮都在变的运行统计也不播报——调用数一直在涨，走 Toast 会持续刷屏，阶段卡片已经完整表达了同一件事。回归见 `scripts/ai-stage-metrics.test.js`、`scripts/toast.test.js`、`scripts/build-compare.test.js`。
- 备注面板为唯一双写区域：`notesPanelStatus` 既写面板内就地状态行，也弹浮动提示。
- **不可逆操作走页内确认弹窗**：写回原文件、清空本页/历史空间、删除历史空间、从备份登记一律经 `askConfirm()`（`#genericConfirmDialog`）二次确认，不再用 `window.confirm`；`askConfirm` 必须把 Esc 关闭（`close` 事件）也当作取消，否则 Promise 不 settle，调用方流程会静默卡住。写回类确认发生在按钮切到「写回中」之前，取消时按钮不会卡在禁用态。
- **确认只有一份实现与 DOM**：两个工作台都使用 `public/workbench-shared.js` 的 `createConfirmDialog().askConfirm()`，首次调用创建 `#genericConfirmDialog`，样式归 `public/workbench-dialog.css` 并由两个构建器内联。标题和文案只写 `textContent`；默认焦点落在取消按钮，取消、Esc 与程序关闭均返回 `false`。不支持 `dialog.showModal()` 或打开失败时取消操作并提示，禁止回退原生 `confirm` 或跳过确认。
- **关闭与队列**：确定/取消调用 `dialog.close()`，等待原生 `close` 事件后清理监听器并落定 Promise，再打开队列中的下一条，防止前一条延迟关闭事件误取消后一条。两个工作台各自的写回锁从确认前持续到请求结束，重复单行/批量点击不能再次提交；按钮只在批准后切为写回中。
- **批准版本与结果状态**：确认前固定行内容、目标列、行序锚点和备份设置，请求使用同一份快照。异步等待期间若 AI 或编辑更新了当前修改结果/说话人，成功回包只把与批准版本一致的记录标记为已确认/已写回；后来更新的版本保持原状态并提示另行处理。取消无请求、无备注修改，失败恢复按钮并释放写回锁。

---

## AI 模型预设管理（`ai-presets.js`）

- 存储键：`translation-compare-ai-presets-v2`。
- 包含完整连接与模型参数（`protocol`、`provider`、`baseUrl`、`apiKey`、`model`、`modelOptions`、`modelMetadata`、`reasoningEffort`、`gptReasoningEffort`、`nonGptIntensity`、`concurrency`，即「并发上限」）。`modelMetadata` 只保存能力白名单，恢复预设时与模型 ID 对应，避免丢失端点专属思考档位。`protocol` 只表示接口类型（`local` / `claude` / `compatible`）；`provider` 是可选的供应商名称，不参与传输协议选择。缺少 `protocol` 却携带 `provider` 的请求直接拒绝，运行路径不得将旧 `provider` 当接口类型。熔断与并发调度均由服务端内部决策，不再随预设保存；旧预设里遗留的 `breakerThreshold`、`breakerDisabled` 载入时被丢弃；遗留的 `smartConcurrency`、`concurrencyMax` 折算进 `concurrency` 后丢弃。
- 当前预设 ID 保存在 `translation-compare-ai-config-v2` 与 `translation-compare-ai-project-config-v2:<projectKey>` 的 `currentPresetId` 中，页面刷新时由 `restoreAiConfig` 自动恢复。共享传输层、模型列表、连通性测试、任务状态和子阶段配置均使用新字段，接口默认配置统一名为 `protocolDefaults`。
- 预设按「供应商身份 + 名称」判重：有名称时 trim 后忽略大小写；未命名时使用协议与规范化地址。展示地址不包含 URL 凭证、查询串或片段。不同供应商同名预设保持独立 ID；按 ID 修改供应商时遇到同名冲突必须拒绝，不得合并 ID 或改变已有阶段引用。
- 主预设与三个阶段使用同一分组及标签函数；增强下拉必须保留原生 `optgroup` 分组提示。阶段一读取预设时完整使用预设连接参数，空 API Key 与默认推理强度也不能借用主配置。切换预设时清空旧模型能力缓存，异步模型列表与测试回包须核对协议、供应商、地址和 Key，避免同名模型跨连接污染。
- 提供商名称使用可输入 combobox，复用工作台的 `select-menu` / `select-option` 与箭头样式；不得使用浏览器原生 `datalist` 弹层。支持输入筛选、鼠标选择、方向键和 Enter 确认、Escape/Tab/失焦关闭；公共下拉关闭逻辑须同步清理 `aria-expanded` 与 `aria-activedescendant`。
- 回归：`node --test scripts/ai-model-presets.test.js scripts/ai-provider-config.test.js scripts/stage-preset-binding.test.js scripts/ai-connectivity.test.js`。
- 支持下拉切换、覆盖保存、另存为和删除预设，操作回执均通过 Toast 提示。
- 下拉首项是空值的「新建预设」：切到该项按「从零建一条连接」处理，清空 AI 服务区域的连接与模型参数（提供商名称、地址、API Key、模型选择与模型能力缓存），并立即写入全局与项目配置，刷新页面不得把上一条连接的地址与 Key 带回来。没有空值语义的控件回落到默认档：接口类型 → `local`（同时刷新 API Key 占位与接口说明）、推理强度 → 模型默认、并发上限 → `ai/concurrency-limits.js` 的 `defaultConcurrency`（页面从构建期注入 `AI_CONCURRENCY_DEFAULT`，不得自带字面量；留空会被折算成 1，等于静默降速）。清空后的地址标记为已手改，状态轮询不得用协议默认地址把它填回来；模型下拉保留「自定义...」入口，接口没列出模型名时仍可手填。

---

## 并发上限与内部自适应调度

面板上只有一个「并发上限」输入。**没有「智能并发」开关**：自适应调度由服务端强制开启，实际并发在 1~上限 之间自动升降，用户填的数字只决定天花板。策略实现在纯函数模块 `ai/concurrency-controller.js`（不读 `status`、不碰网络，时钟可注入），阶段业务与状态写入仍归 `ai-proofread.js`。

- **起步**：`min(上限, 3)`。默认上限 3 时就是固定 3，与旧行为一致；上限更高时先用 3 探路，不上来就用满上限去打陌生的上游。
- **上探（两段式）**：
  - *慢启动*：一整轮请求（数量 = 当前并发）全部正常，并发翻倍，封顶到慢启动阈值。上限 32 时 3→6→12→24→32，不必等 29 个「连续 5 次」。
  - *加法上探*：到达阈值后，每连续 5 次正常应答 +1。要踏入「上次出事的水位」（`knownLimit`）及以上时，需要连续 15 次——上游天花板通常不变，反复撞同一堵墙只会多吃几次 429。
  - 两次上探之间至少间隔 3 秒。
- **下行**（只对「并发造成的压力」出手）：
  - *频控*（HTTP 429/503/529 或速率/过载类报错）：并发 >3 时 ×0.7，否则 -1，保底 1。一次拥塞里同时返回的一批 429 只算一次：下调之前就已发出的请求（`startedAt` 早于上次下调）不再触发第二次下调，两次下调至少隔 800ms。
  - *过载型失败*（`error-kinds.js` 归类为 `timeout` / `server_error` / `network`）：-1。这类失败未必是并发造成的，所以更温和；它们同时会进熔断的失败窗口，提前压并发是为了在错误率熔断终止任务之前先把失败率压回去。
  - *拒答、坏 JSON、认证/配置错误*对并发中性：既不算加速也不触发降速。
  - 连续下调属于同一段拥塞：`knownLimit` 取最高的那个水位，`slowStartThreshold` 只在首次出事时收紧，后续下调不再改它——否则连续限流会把阈值带到 1，恢复后没有慢启动可言。
- **与熔断的联动**（`circuit-breaker.js` 只提供只读读数，判定逻辑与并发状态互不读写）：
  - 断路器打开：并发塌到 1，慢启动阈值设为**出事水位的一半**（至少 2，只收紧不放宽）。冷却结束后半开只放行一个探测（`dispatchLimit`），探测通过后从 1 慢启动爬回阈值，再加法上探；不会一步跳回冷却前的水位去撞刚放行的上游。阈值取「出事水位」而不是塌缩那一刻的当前并发——断路器打开前的连续限流早已把并发压到 1，拿当前并发算一半只会得到 1。
  - 失败窗口逼近熔断线：`pressure`（当前错误率 ÷ 熔断阈值）≥ 0.5 时暂停上探，回落后立即恢复；样本不足 5 个时恒为 0，偶发一次失败不会卡住上探。状态翻转各记一行日志。
- **日志**：调度相关日志前缀 `[并发调度]`，频控退避为 `[频控退避]`，熔断为 `[熔断]`；任务结束输出「并发调度统计」（起步、峰值、下调/上探次数、限流次数）。
- **状态接口**：`concurrency` 是起步并发，`concurrencyMax` 是并发上限，`currentConcurrency` 是初审当前放行的并发；`stagePipelines.stageN` 同样只有 `concurrency`（当前）与 `concurrencyMax`（上限）。不再回报 `smartConcurrency`。
- **并发边界**：并发上限共用 `ai/concurrency-limits.js` 的 `AI_CONCURRENCY_LIMITS`（当前 1–32），面板输入框 `max` 与 `cleanConfig`/`cleanSubStageConfig`/`createStageController` 均以该常量为准。**越界必须截断到边界，不得回落到默认值**——旧实现把超范围的 20 直接换成 3，用户选了 20 却静默跑成 3。`ai-presets.js` 的 `createPresetTools` 会被 `toString()` 注入页面、无法引用模块作用域，因此自带一份同值字面量，两边的边界行为由 `scripts/ai-smart-concurrency.test.js` 锁死，改一边必须同步另一边。
- **旧数据折算**：旧客户端、旧预设、旧本地存档还带着 `smartConcurrency` + `concurrencyMax`。开启智能并发的旧数据，有效上限是 `max(concurrency, concurrencyMax)`；关闭的，`concurrencyMax` 从不生效，上限就是 `concurrency`。服务端 `resolveConcurrencyCap`、预设 `sanitizePreset`、页面 `foldLegacyConcurrency` 三处按同一口径折算，读到旧数据即折成一个上限，下一次保存不再回写旧字段，无需迁移脚本。页面的折算必须对全局与项目两份存档**各自**折算后再合并；先合并再折算，会让一份旧存档遗留的 `concurrencyMax` 盖掉另一份存档里用户刚改的值。
- **项目级持久化**：并发上限随项目配置独立持久化，使用上节列出的 v2 全局与项目配置键；未独立配置的项目继承全局配置基线，跨项目切换时互不污染。
- **测试用环境变量**：`TRANSCOMPARATOR_CONCURRENCY_STEP_INTERVAL` 只缩短「两次上探之间的最短间隔」，供回归测试把秒级等待压到毫秒级；不是运行时开关，页面与请求体都不携带调度参数。

---

## 客户端布局缓存边界

- 术语判定与命中条数由 `renderTermChipHtml` 合成同一个原生按钮；有备注时移除构建期判定，清单仍来自当前对照表变体。旧快照缺少清单时保留静态判定，无命中则隐藏入口。`.term-chip-slot` 在 `.confirm-status` 外，按钮和整宽列表直接参与 `.confirm-row` 布局，展开不能改变顶部标签的位置。原生按钮仅走一次 `click`，同步 `aria-expanded` 与列表 `hidden`；`termOpenRows` 保留本页会话的开合选择，备注回包与分页重绘不得收起清单或触发整表量高。同内容回包复用 `termChipHtmlCache`，入口更新时保留键盘焦点。回归：`node --test scripts/term-layer.test.js`。
- `workbench-client.js` 的 `syncVisibleRowLayout` 只在四种情况下重新量输入框高度：新节点（整页重渲染）、该行内容改写（`invalidateRevisionEditorHeight`）、视口高度变化、列宽变化（`remeasureEditors`）。面板与抽屉开合只经 `ifFrameMoved` 重算可用高度；开关审核轨迹不触发布局同步。
- 批量量高由 `measureRevisionEditors` 执行「整批写 `height:auto` → 连续读 `scrollHeight` → 统一写回」。禁止逐行交错读写；单行量高仍走 `syncRevisionEditorHeight`。事件处理器不得逐行调用整批量高，`resize` 要合并到一帧并在尺寸稳定后重新测量。
- `updateResultsMaxHeight` 的行数来自 `renderVisibleRows` 传入的切片长度或 `renderedRowsById.size`，不能为数行数读取表格 DOM。一次同步只查询一次 `.revision-editor`，失效与量高复用同一份列表。
- 审核轨迹的用户开合状态由 `pipelineOpenOverrides` 持有：`setPipelineOpen` 写入，`pipelineDefaultOpen` 读取，重渲染时优先使用会话选择；未手动开合过的行仍走默认状态。它属于页面会话，不写入备注或持久化存储。
- 页面行数据仍整体内嵌，分页只控制本次渲染节点数量；当前未实现虚拟滚动。性能排查与历史测量见 [troubleshooting.md](troubleshooting.md#页面交互卡顿鼠标变慢--输入延迟--开关卡顿)。

验证：`node --test scripts/workbench-layout-sync.test.js scripts/build-compare.test.js`。

---

## 相关测试集

修改工作台页面脚本、备注空间与并发控制必须执行：
```powershell
node --test scripts/notes-spaces.test.js scripts/build-compare.test.js scripts/notes-recovery-merge.test.js scripts/toast.test.js scripts/ai-model-presets.test.js scripts/ai-smart-concurrency.test.js scripts/prefilter-restore.test.js scripts/confirm-dialog.test.js scripts/writeback-export.test.js scripts/speaker-attribution.test.js
```
