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
- 备注空间键必须包含当前工作台的 `projectKey`（`translation-compare-notes-v7:<projectKey>:<rowsSignature>`）；`rowsSignature` 只区分同一项目的不同输入快照。磁盘存储与旧浏览器存储沿用同一空间键，项目之间逻辑隔离。
- 工作台的历史列表、`备份全部`、`清空历史`、历史找回和载入自愈只读取当前 `projectKey` 的空间（当前空间也必须保留）。其他项目的空间不得混入当前项目的历史列表、备份结果或批量清理范围；切换到对应项目后由其工作台读取。
- 跨项目的 JSON 导入必须经过当前项目命名空间校验；导入结果不得让当前工作台直接看到或操作另一个项目的历史空间。若备份包含多个项目，导入器应逐空间保留其项目归属，交由对应项目页面处理，不能把空间改写成当前项目的 key。
- **其他项目/旧版空间的归档出口**：页面在本项目历史列表之外单独一区列出它们（`notesForeignList` / `collectForeignNotesSpaces()`），只提供导出与删除，不渲染找回入口，也不进入 `notesSpaceInventory`、`备份全部` 与 `清空历史`。磁盘模式无需删除其他项目的记录为本页腾出浏览器容量；删除必须二次确认并点名所属项目。回归：`node --test scripts/notes-foreign-spaces.test.js scripts/notes-spaces.test.js scripts/notes-recovery-merge.test.js`。
- 备份保留原始数据，导入同名但不同内容的空间只创建副本；找回保留当前行已有记录与来源磁盘空间。
- **未校验记录隔离**：`recoveredUnverified` 记录不能携带当前行的 `rowSig` 或计入人工确认。**按行号找回**与**只剩行序推断的锚点配对**必须保持此标记。
- **文本证据例外**：配对自带文本证据——记录里的「修改结果」与目标行现在的正文逐字相同（`pair.textConfirmed`）——按 `verified` 处理并保留人工确认。
- **行内核验徽标**：行内「未校验」徽标只解除该行的写回隔离，必须保持 `manualDone=false`/`done=false`，让它继续留在「未人工确认」筛选与当前写回候选集里；**不得顺带人工确认**。
- 清空操作：页面必须提供清空当前空间和清空历史空间的显式操作，均需二次确认且不能误删另一类空间。
- `notes-storage.js` 提供旧浏览器同步压缩适配器，用于迁移和直接打开 HTML 的兼容模式。写入用 `lz-string` 无损压缩，封装包含版本、原串长度和完整性校验；编码更长时保留原 JSON。控制台页面的备注读写与枚举由 `notes-disk-storage.js` 提供会话镜像；配置、预设、说话人数据和迁移辅助键仍使用原存储。
- 适配器读取返回逐字一致的原 JSON，重复导入与跨页比较仍按逻辑内容判断。损坏或未知版本的压缩包返回原始存储串，使严格解析暂停保存，不能返回 `null` 或空对象。普通 JSON 备份格式和空间键保持不变；损坏包仍可原样备份。
- 历史为空时禁用清理；显式清理包含空和损坏的本项目空间。磁盘模式显示存储目录和迁移清理状态；旧浏览器模式按底层存储串估算占用并区分配额、权限和未知异常，UTF-16 估算不是浏览器配额判据。
- **明确授权的定向恢复**：渲染期可通过 `notesRecovery` 参数临时注入备份，发布前和浏览器载入时均验证空间键及每条行签名。只补缺失或阶段更完整的记录，保护人工备注、修订编辑、人工确认和更完整的现存结论。恢复参数可列出已知不完整的 `ignoredRunIds`，防止其回包降级已恢复成果；新任务仍正常应用。恢复成功后写入按项目和备份摘要隔离的一次性标记，重复刷新不重做、显式清空不自动找回；保存失败时恢复内容保留在内存并允许导出，标记单独写失败不得误报备注尚未保存。普通构建不携带备份，不将恢复数据写入比较 JSON。

## 长期磁盘存储与旧空间迁移

- **所有权与保留**：`notes-file-store.js` 管理 `storageLayout().notesDir/translation-compare/`，默认是 `out/notes/translation-compare/`。它属于长期用户数据，独立于 `projects/` 快照、staging 和 AI 运行缓存。重新生成、应用布局、旧快照淘汰、清除 AI 运行记录及删除工作台项目均保留全部空间；仅显式清空或删除备注空间可移除内容。数据目录仍受 `TRANSCOMPARATOR_DATA_DIR` 控制。
- **文件与版本**：文件名为完整空间键的 SHA-256，文件保存 `schemaVersion`、原空间 `key`、逻辑 JSON 串 `raw`、随机 `version`、内容校验和、`completedRecoveries` 与更新时间。普通更新必须严格解析备注结构；备份登记允许原样归档损坏或未知编码的旧串。写入使用原子文件能力并回读核验；版本不符返回 409，保留磁盘原记录。删除保留不带内容的版本标记，迟到的旧页面不能复活记录。
- **运行入口**：`src/runtime/routes/notes.js` 提供 `GET /api/notes/spaces` 和 `POST /api/notes/spaces/{write,import,delete,recovery}`，沿用本机同源鉴权、CSRF token 和 JSON 门禁。接口与页面响应只读注入的内容来自同一文件存储。服务在响应期替换 `notesDiskData` 占位，JSON 做脚本安全转义；生成快照 HTML/比较 JSON 不携带备注内容，也不被原地修改。磁盘文件损坏时注入错误并暂停提交，不能当作空空间覆盖。
- **迁移范围与核验**：控制台页面扫描当前浏览器来源下的全部翻译备注空间，包含其他项目、旧版、压缩和损坏串；辅助迁移标记不属于空间。逻辑内容相同跳过，同名不同内容登记独立副本。服务端原子写入并回读后，客户端核对回执内容逐字相同，再仅删除浏览器中仍等于迁移原串的副本。写入/核验失败保留浏览器原数据，迁移期间变化或清理失败也保留副本并提示；磁盘记录不自动删除。不同浏览器或旧端口的存量需分别打开更新后的控制台页面迁移，或通过 JSON 导入。
- **会话与提交**：`notes-disk-storage.js` 同步读取会话镜像，异步串行提交磁盘版本。每次提交捕获本次内容，等待期间的新编辑合并到待写队列，成功后继续提交最新内容；磁盘失败保留草稿和队列，显式重试后续写。多页面更新与删除经版本检查阻止覆盖；刷新列表先收尾本页待保存内容，再核对当前空间版本，冲突时保留草稿并要求导出后重新加载。
- **保存状态与关闭**：页面同时读取保存会话与磁盘提交状态。排队/迁移中显示「正在保存」，只有提交成功并回读核验后显示「已保存到电脑」。失败或冲突显示持续警告；有待写、失败或冲突时离页提示保留页面或导出。磁盘清理浏览器副本失败不误报已落盘内容尚未保存。定向恢复标记同样等待磁盘保存成功才写。
- **兼容模式**：直接打开 `file://` HTML 仍使用旧浏览器适配器并明确显示「保存在此浏览器」；需从控制台打开才能写入电脑。HTTP 页面缺少磁盘接口/引导数据时暂停保存并提示重启服务和应用布局，不静默降级成浏览器保存。新服务遇到没有磁盘占位的旧翻译快照时，响应升级引导页并暂停其旧脚本，避免迁移清理副本后误显示为空；使用已有项目前须应用新布局，生成快照源文件不改写。
- **验证**：`node --test scripts/notes-disk.test.js scripts/notes-routes.test.js`，覆盖清空浏览器与重建会话、旧快照淘汰/项目删除保留记录、全部旧空间迁移、同名副本、损坏串、回读、写入失败重试、编辑与提交交错、多页面冲突、删除后迟到写入、接口鉴权与响应期注入。模块与页面变更还须执行 `npm test`。

## 备注保存会话（`notes-persistence.js`）

- **状态归属**：`createNotesPersistence` 独占同步会话镜像的逻辑内容基线、冲突拦截、写入失败及分类、保存 timer；这份基线不是磁盘保存成功的证明。页面持有备注、行签名序列化、恢复合并规则及文案，并组合磁盘提交状态。页面只通过 `persist` / `save` / `flush` / `clearCurrent` / `observeStorageChange` / `snapshot` 协作，不直接修改保存基线或标志。
- **初始化与写入**：实例在解析初始空间之后、自动恢复之前建立，不在 constructor 通知 UI。初始化恢复可直接 `persist`，它先检查冲突与逻辑内容基线，再序列化补签名；冲突时不得触发序列化。成功才更新基线并清失败状态；异常沿用 `notes-spaces.storageFailureKind` 分类，所有保存尝试均按原时序通知 UI，通知异常不额外吞掉。
- **保存调度**：`persist` 不取消 timer；`save` 合并为首个尚未执行的保存，优先 idle callback（timeout 2000ms），否则等待 250ms，后续请求不延长期限。页面每次请求保存仍使指标失效。立即保存先取消 timer 再写；`flush` 只处理已排队的保存，无 pending 时不重试。页面隐藏或离开调用同一 flush，保存失败的离开提示仍由页面根据快照生成。
- **清空时序**：显式授权的 `clearCurrent(onClear)` 先向同步适配器写 `{}`，再调用页面清备注与指标，最后认领空基线并复位会话冲突/失败状态；保留既有 timer，不新增 UI 通知。磁盘模式的成功回执等待异步提交，写盘失败保留磁盘旧内容、待写队列与失败提示。同步写入或页面回调抛错原样交给页面处理，失败前已发生的副作用不回滚。
- **跨页变化**：`observeStorageChange` 按当前逻辑内容与基线是否一致重新赋值拦截状态，可因内容回到基线而解除，不能改成永久拦截。它不自动保存、合并或重试；读取失败沿用原传播方式。`snapshot` 只读回报 `blocked`、`failed`、`failureKind`、`pending`，不暴露基线或 timer 句柄。
- **恢复标记**：恢复规则由页面管理，只在保存成功后写标记。磁盘模式把备份摘要登记到空间的 `completedRecoveries`，更新、清空和删除均保留此元数据；换浏览器或清空浏览器后也不能重复恢复已完成或明确清空的备份。旧浏览器标记可在磁盘内容保存后登记。标记提交与内容写入串行，标记单独失败只提示，不把已经保存的备注误报成未保存；显式清空备份恢复空间前须先成功登记标记，失败则保留原内容。未保存成果保留在页面内存，重试与导出继续走既有入口。
- **验证**：`node --test scripts/notes-persistence.test.js scripts/notes-persistence-client.test.js scripts/notes-storage.test.js scripts/notes-spaces.test.js scripts/notes-recovery-seed.test.js scripts/notes-recovery-merge.test.js scripts/notes-foreign-spaces.test.js scripts/ai-result-reception-client.test.js`。module 测试使用可控 scheduler 与真实压缩 adapter；生成页面回归执行 storage、pagehide、visibilitychange 与 beforeunload 事件，覆盖 timer、跨页冲突、显式清空及重试。

## 浏览器 AI 结果接收（`ai-result-reception.js`）

- **状态所有权**：`createAiResultReception` 独占当前运行号、修订游标、去重集合、已清除运行、待遗忘行、状态请求互斥与追赶 timer。预筛结果集合、筛选、阶段看板、Toast、备注内容与合并仍由页面持有，保存会话归上节；不向接收实例传整个可变页面状态。
- **启停与轮询时序**：阶段启停请求前及成功回包后调用 `invalidateStatusRequests`；此前发出的状态查询不得覆盖新的控制状态，也不消费旧回包的结果或推进游标。接收模块在该查询收尾后补取状态，仍按原游标交付结果。启动应答前禁用总停止，总停止应答前禁止加入新阶段，避免交叉请求使停止后又出现新运行。
- **两阶段交付**：`begin(ai)` 在原状态渲染位置观察换轮，返回项目身份与清除拦截的只读 receipt，不提前推进游标。`commit(receipt, applyBatch)` 按待遗忘行、恢复忽略运行、去重键及当前行签名准入；页面 adapter 先登记预筛集合，再批量写备注、安排保存并报告拒绝，全部完成后消费游标。去重仍在签名检查前登记，版本键保留 `result.runId + index + (resultRevision || status)` 的口径。
- **异常时序**：应用或提示抛错时不推进游标，已登记的去重状态保留；存储保存失败不回滚内存成果，也不阻止游标推进。无当前行签名时不新增拒绝条件；错误签名的重复回包只提示一次。
- **请求 adapter**：`refresh()` 自报项目与行集身份、当前档案、运行号及游标，每批 64 条，一次只允许一个状态请求；结果未收齐时按 16ms 追赶。页面继续每 1.5 秒触发刷新。状态请求沿用 `data.ok` 判据；结果清除同时检查 HTTP 与 `data.ok`，不因共用 adapter 统一成新的错误口径。
- **清除与迟到回包**：`resetReception()` 只清运行号、游标与去重，不取消在途请求或追赶 timer，不清运行/行拦截。`discardCurrentRun()` 记当前运行并清去重，保留游标；`ignoreRun(runId)` 只记运行。已清除运行只拦静止回包，运行中的旧回包仍按原规则接收；换轮观察先于项目及清除检查，跨项目状态也沿用原来的运行号/游标观察口径。
- **遗忘行**：`forgetRows()` 先登记行再请求服务端清除，失败保留；`snapshot()` 提供独立的待遗忘行清单供启动请求携带，成功后 `acknowledgeForgotten()` 仅确认该次携带的行，等待期间新登记的其他行继续隔离。
- **生成与验证**：渲染器注入同一 factory，不能复制接收实现或加载常驻 AI 任务状态。`refreshAiStatus()` 保留为页面触发入口。定向验证：`node --test scripts/ai-result-reception.test.js scripts/ai-result-reception-client.test.js scripts/prefilter-restore.test.js scripts/notes-recovery-seed.test.js scripts/ai-proofread-clear-dialog.test.js`；module 测试使用可控请求/时钟，生成页面测试执行真实内联脚本，覆盖在途清除、迟到回包、分页与存储失败。

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
- `updatePrefilterConfirmButton` 统一同步结果开关的 `disabled` / `checked`：认领运行号后即可查看，启动预筛自动勾选；清筛选只取消勾选，清运行记录同时清空运行号并禁用。确认仍仅作用于当前筛选范围内尚未人工确认且不需重新核验的预筛通过行，运行中或分页结果未收齐时禁用。确认完成后关闭预筛结果筛选并重新应用其他筛选条件，保留本轮结果集；取消确认不改变筛选状态。

---

## 浮动提示（Toast）与进度承载分工

- **阶段看板位置职责**：顶部只汇总当前审核结论；卡片主指标统一为取得结论的行数（初审 `stage1Total`、复审 `stage2Reviewed`、仲裁 `stage3Arbitrated`），分类不使用流程箭头，重复累计的 `stage3Settled` 不再单独展示。结果分布、初审直通方式与复审分歧保留独立语义分组；`.ai-stage-runtime-summary` 位于主指标行最右侧，只保留一份可筛选的待办与非零异常。底部 `.ai-stage-runtime-line` 共用一行显示运行信息与进度范围，进度条和当前行号各占固定轨道；零异常隐藏，失败再次出现时恢复入口。直通占比为 `fastPassHits / stage1Passed`，空分母显示 `—`，不改变既有行分类、存储或统计字段。待仲裁包含本轮未定案且未人工确认的行（含在飞），不能等同于本次待派发队列。
- **可见进度范围**：`stageNProgressText` 与条形进度共用 `renderStageProgress` 的完成数、总数和百分比；可见文字只显示全页/当前候选及百分比，完整分子、分母保留在悬停与 ARIA 说明中。进度容器提供 `progressbar` 角色、明确的阶段范围与数值说明。未启用、空范围和重置同时隐藏文字/条形并清理文字提示与动态 ARIA 值，禁止保留上一轮百分比或单独计算显示分母。
- **紧凑布局占位**：预设选择与适用预设两个可见下拉使用相同的零基准弹性份额，按钮保留固有宽度。按卡片容器宽度统一选择固定的标题、指标和运行轨道行数，同宽卡片等高；状态文字、待办/异常及运行明细显隐不得改变卡片高度或进度条纵坐标。隐藏内容仍清空文字、提示与动态 ARIA，不用旧数据占位。运行详情以该阶段在飞/待派发为准，只有动态配额不算正在运行；初审尚未完成的行仍单独显示未审提示。
- **看板宽度与几何验证**：卡片正文使用显式 `minmax(0, 1fr)` 单列并拉伸内容。实际 DOM 验证必须检查正文、主指标、运行区和进度轨道均铺满卡片内容区，待办容器右边界贴合内容区右边界；这些边界与进度条纵坐标在空闲、运行、排队和停止之间保持不变。除窄窗口外，必须覆盖超宽窗口和各阶段计数差异悬殊的组合，不能只验证等高、无重叠或所有阶段使用相同计数。统计文字还须检查实际文本边界，不能只测可能被压缩的按钮外框。

- **阶段指标筛选**：每项阶段数字使用独立的原生 `button`，选中状态同步到 `is-active` 与 `aria-pressed`；原生 Enter/Space 激活只走一次 `click`，不得额外绑定等价键盘事件。卡片正文不再拥有阶段总筛选、按钮角色或 Tab 停靠点。指标与顶部结论摘要共用一个可切换/取消的筛选状态，「清筛选」清除全部指标选中态。`computeStageMetricsFromNotes` 在原统计遍历中记录 `metricRowIds`，非待办指标直接读取该缓存，禁止另写备注分类规则；待复审/待仲裁继续使用共享当前轮次判据。分歧统计保留全部已仲裁记录，人工确认只移除尚待仲裁的待办。回归：`node --test scripts/stage-review-reports.test.js scripts/ai-stage-metrics.test.js scripts/build-compare.test.js`。
- **顶部统计栏的「修改率」**：分子分母直接复用 `computeStageMetricsFromNotes` 的最终结论指标（`finalNeedsEdit` ÷ `finalNeedsEdit + finalUnchanged + finalNeedsCheck + finalPendingArbiter`），由 `renderStageMetricsDashboard` 统一刷新，禁止另写一套备注分类规则；调用失败的行不进分母，没有任何自动结论时显示 `—`，不显示 `0%`。回归：`node --test scripts/modify-rate.test.js`。
- **一次性回执走 Toast**：按钮与控件结果（批量确认/写回、预筛/校对完成、模型刷新、空间备份找回删除等）渲染到 `#toastStack`（页面唯一浮动容器，在 `.app-shell` 之外）。
- **两个工作台共享同一份实现与样式**：实现是 `public/workbench-shared.js` 的 `createToastCenter()`，样式是 `public/toast.css`（在 `.toast-stack` 上把 `--line/--focus…` 与 `--speaker-*` 两套 token 映射成 `--toast-*`）。翻译比较与说话人归属各自在页面里建一个中心并注入同一份样式——**不要把实现或样式复制回任一侧**，否则两边行为会各自漂移。
- **禁止阻塞式 `window.alert`**：说话人归属工作台原先所有一次性回执都走 alert，会打断校对流程且无法区分语气；一次性回执一律走 Toast，`scripts/speaker-attribution.test.js` 锁住这条边界。
- 语气包含 `info`、`success`、`watch`、`error`；同一消息连续出现只保留一条并顺延存活时间；最多同时显示 4 条。
- **停留时长口径**：`durationMs` 是基准时长，实际停留 = 基准 × `durationScale`（0.5）。**`error` 不参与缩放**——出错提示往往最长（定位失败原因、未写入行数、接口报错原文），折半会让用户读不完就被关掉。
- **AI 进度不再有全局状态行**：右上角的 `#aiStatus` 固定状态行与全局进度条 `#aiProgressWrap` 已整体移除，阶段进度改由每张阶段卡片自己的 `.ai-stage-card-progress`（`stageNProgressWrap` / `stageNProgress`）承载。阶段一的 `stage1Total` 只含通过、提改、存疑结论，不含调用失败；进度表示当前工作台的初审覆盖，启动、停止和刷新使用同一全行范围，不能只在运行时加入未审行。队列已包含重试异常，禁止把队列与异常再次相加；缺少完整行范围的聚合兼容输入以 `已完成 + max(队列, 异常)` 为下界。失败不计入完成数，未完成时百分比不得四舍五入到 100%。静止时同时显示尚未取得初审结论的行与异常，不能只用异常数表示全部剩余工作。复审与仲裁继续按实际产生的候选范围取待办、队列和异常的最大值，不能锁定历史最高百分比掩盖新增候选。阶段一起步续跑的跳过名单须先验证最新备注有可用结论，失败、终止、空备注不能因非复审候选而被当成已完成。回归见 `scripts/ai-progress-resume.test.js`、`scripts/ai-stage-metrics-regression.test.js`、`scripts/stage-note-state.test.js`。
- **`reportRuntimeNotice` 只报用户不知道的事**：它等价于 `showToast`，只承载「未连接到本地控制台服务」「已跳过 N 条与当前工作台行内容不匹配的结果」「已忽略非当前项目快照的结果」这类异常与副产物。用户自己刚点的动作（正在启动/终止/清除）不播报——它们完成时都有结果提示；每轮都在变的运行统计也不播报——调用数一直在涨，走 Toast 会持续刷屏，阶段卡片已经完整表达了同一件事。回归见 `scripts/ai-stage-metrics.test.js`、`scripts/toast.test.js`、`scripts/build-compare.test.js`。
- 备注面板为唯一双写区域：`notesPanelStatus` 既写面板内就地状态行，也弹浮动提示。
- **不可逆操作走页内确认弹窗**：写回原文件、清空本页/历史空间、删除历史空间、从备份登记一律经 `askConfirm()`（`#genericConfirmDialog`）二次确认，不再用 `window.confirm`；`askConfirm` 必须把 Esc 关闭（`close` 事件）也当作取消，否则 Promise 不 settle，调用方流程会静默卡住。写回类确认发生在按钮切到「写回中」之前，取消时按钮不会卡在禁用态。
- **确认只有一份实现与 DOM**：两个工作台都使用 `public/workbench-shared.js` 的 `createConfirmDialog().askConfirm()`，首次调用创建 `#genericConfirmDialog`，样式归 `public/workbench-dialog.css` 并由两个构建器内联。标题和文案只写 `textContent`；默认焦点落在取消按钮，取消、Esc 与程序关闭均返回 `false`。不支持 `dialog.showModal()` 或打开失败时取消操作并提示，禁止回退原生 `confirm` 或跳过确认。
- **关闭与队列**：确定/取消调用 `dialog.close()`，等待原生 `close` 事件后清理监听器并落定 Promise，再打开队列中的下一条，防止前一条延迟关闭事件误取消后一条。两个工作台各自的写回锁从确认前持续到请求结束，重复单行/批量点击不能再次提交；按钮只在批准后切为写回中。
- **批准版本与结果状态**：确认前固定行内容、目标列、行序锚点和备份设置，请求使用同一份快照。异步等待期间若 AI 或编辑更新了当前修改结果/说话人，成功回包只把与批准版本一致的记录标记为已确认/已写回；后来更新的版本保持原状态并提示另行处理。取消无请求、无备注修改，失败恢复按钮并释放写回锁。
- **写回定位上下文**：两个客户端的行序清单都覆盖至最后一个待写条目后最多 32 行（不超过实际末行），只携带真实目标列；后方行只参与定位，不能增加待写条目或被自动确认。清单、修改结果与备份设置同时在确认前固定，服务端共享定位规则见 [排查手册](troubleshooting.md#4a-原句还在旧快照写回却报未能定位)。

---

## 修改结果的阶段版本

- 版本栏渲染与 `applyStageRevision` 共用同一版本状态，分别判断显示、禁用及可切换文本。待执行判据复用 `stageNoteState` 的最新轮次 `pendingReview` / `pendingArbitration`，人工已确认行不生成待执行占位；阶段启用读取 `committedStagePresetIds`，与已添加预设配置一致。未启用且没有对应审核记录的下游版本隐藏，启用且本行待审的版本显示并禁用；已有真实改案不随停用隐藏。已审核但缺少完整改案时禁用并说明原因，不将其标为尚未执行。
- 只有对应阶段实际产生的完整改案才能切换；通用 `revision` 兜底不得冒充尚未执行的复审或终审，局部提议保留禁用状态。没有默认成品时允许保留版本栏，但不得因此自动填入可写回文本；默认成品与人工选择边界见 [AI 契约](ai-proofread-contract.md#默认修改结果只认末阶段真正采纳的改案)。
- 阶段配置变化仅同步可见行的版本栏，不重建整页编辑器，不覆盖编辑内容或改动备注。

验证：`node --test scripts/stage-revision-buttons.test.js scripts/stage-review-reports.test.js`。

---

## AI 模型预设管理（`ai-presets.js`）

- 存储键：`translation-compare-ai-presets-v2`。
- 包含完整连接与模型参数（`protocol`、`provider`、`baseUrl`、`apiKey`、`model`、`modelOptions`、`modelMetadata`、`reasoningEffort`、`gptReasoningEffort`、`nonGptIntensity`、`concurrency`，即「并发上限」）。`modelMetadata` 只保存能力白名单，恢复预设时与模型 ID 对应，避免丢失端点专属思考档位。`protocol` 只表示接口类型（`local` / `claude` / `compatible`）；`provider` 是可选的供应商名称，不参与传输协议选择。缺少 `protocol` 却携带 `provider` 的请求直接拒绝，运行路径不得将旧 `provider` 当接口类型。熔断与并发调度均由服务端内部决策，不再随预设保存；旧预设里遗留的 `breakerThreshold`、`breakerDisabled` 载入时被丢弃；遗留的 `smartConcurrency`、`concurrencyMax` 折算进 `concurrency` 后丢弃。
- 当前预设 ID 保存在 `translation-compare-ai-config-v2` 与 `translation-compare-ai-project-config-v2:<projectKey>` 的 `currentPresetId` 中，页面刷新时由 `restoreAiConfig` 自动恢复。共享传输层、模型列表、连通性测试、任务状态和子阶段配置均使用新字段，接口默认配置统一名为 `protocolDefaults`。
- 阶段适用预设以 `stagePresetSelections` 为唯一配置来源；`committedStagePresetIds` 不得回退读取候选选择器。候选须经「添加」进入列表，显示、启动请求、热更新及 `stageNPresetIds` 持久化均读取同一列表。空列表表示阶段一用主配置、阶段二/三未启用；移除最后一项后，残留候选不得重新加入配置。阶段三的候选选择、添加与适用列表不依赖阶段二是否配置，执行仲裁仍要求已有复审分歧。旧 `stageNPresetId` 仅由恢复入口迁入列表，显式的空数组优先于旧字段。
- 三张阶段卡片的开始/停止只控制自身；单阶段启动以当次最新备注快照准备候选，不自动接收上游后续结果。不同阶段可以同时运行；有阶段运行或等待启动时，`canClearStageForRestart` 拒绝任何阶段清空重跑，不清备注也不擅自改选「继续剩下的」。统计标题右侧的 `#aiStartAll` / `#aiStopAll` 分别提供一键流水线启动与全部停止，总控开始仅在全部阶段空闲时可用。按钮态从服务端 `stageControls` 恢复，不能由本地最后点击的阶段推断；阶段编排与定向停止见 [AI 校对契约](ai-proofread-contract.md#阶段编排独立启停与一键流水线stageplan--runqueue)。
- 预设按「供应商身份 + 名称」判重：有名称时 trim 后忽略大小写；未命名时使用协议与规范化地址。展示地址不包含 URL 凭证、查询串或片段。不同供应商同名预设保持独立 ID；按 ID 修改供应商时遇到同名冲突必须拒绝，不得合并 ID 或改变已有阶段引用。
- 主预设与三个阶段使用同一分组及标签函数；增强下拉必须保留原生 `optgroup` 分组提示。阶段一读取预设时完整使用预设连接参数，空 API Key 与默认推理强度也不能借用主配置。切换预设时清空旧模型能力缓存，异步模型列表与测试回包须核对协议、供应商、地址和 Key，避免同名模型跨连接污染。
- 提供商名称使用可输入 combobox，复用工作台的 `select-menu` / `select-option` 与箭头样式；不得使用浏览器原生 `datalist` 弹层。支持输入筛选、鼠标选择、方向键和 Enter 确认、Escape/Tab/失焦关闭；公共下拉关闭逻辑须同步清理 `aria-expanded` 与 `aria-activedescendant`。
- 回归：`node --test scripts/ai-model-presets.test.js scripts/ai-provider-config.test.js scripts/stage-preset-binding.test.js scripts/ai-connectivity.test.js`。
- 支持下拉切换、覆盖保存、另存为和删除预设，操作回执均通过 Toast 提示。
- 下拉首项是空值的「新建预设」：切到该项按「从零建一条连接」处理，清空 AI 服务区域的连接与模型参数（提供商名称、地址、API Key、模型选择与模型能力缓存），并立即写入全局与项目配置，刷新页面不得把上一条连接的地址与 Key 带回来。没有空值语义的控件回落到默认档：接口类型 → `local`（同时刷新 API Key 占位与接口说明）、推理强度 → 模型默认、并发上限 → `ai/concurrency-limits.js` 的 `defaultConcurrency`（页面从构建期注入 `AI_CONCURRENCY_DEFAULT`，不得自带字面量；留空会被折算成 1，等于静默降速）。清空后的地址标记为已手改，状态轮询不得用协议默认地址把它填回来；模型下拉保留「自定义...」入口，接口没列出模型名时仍可手填。

---

## 并发上限与内部自适应调度

面板上只有一个「并发上限」输入。**没有「智能并发」开关**：自适应调度由服务端强制开启，实际并发在 1~上限 之间自动升降，用户填的数字只决定天花板。策略实现在纯函数模块 `ai/concurrency-controller.js`（不读 `status`、不碰网络，时钟可注入），阶段内派发归 `ai/stage-dispatch.js`，跨阶段业务与任务状态归 `ai-proofread.js`。

- **起步**：`min(上限, 3)`。默认上限 3 时就是固定 3，与旧行为一致；上限更高时先用 3 探路，不上来就用满上限去打陌生的上游。
- **阶段多预设（阶段一的「适用 (N)」、阶段二/三的预设列表）**：每个预设是一条**独立并发通道**（各自一个 `createStageController`，上限取该预设自己的 `concurrency`）。阶段可派发量 = 各通道当前允许并发之和，起步也是各通道起步值之和——3 个预设各配 3 并发，点「开始」就是 9 个请求同时在飞，而不是被「第一个预设/主配置」的上限卡在 3。配额由 `ai/preset-pool.js` 从通道读取（`quota` 字段就是 `channel.currentConcurrency`），池内不再另算一套 ±1 自适应，避免两套升降互相打架。`cleanConfig` 必须保住 `presetPool` 以及每个预设的 `presetId`/`name`：漏掉整池只剩主配置一条通道，剥掉身份则页面上的预设标签与运行数据对不上号。每条预设通道的退避窗口、单行重试计数与断路器由 `ai/stage-dispatch.js` 持有；断路器打开时只让该通道进入冷却并降到最低，其它预设继续派发，恢复后该通道从低位慢启动。阶段及整体任务的终止汇总见 [AI 校对契约](ai-proofread-contract.md#阶段派发状态与请求归属aistage-dispatchjs)。
- **上探（两段式）**：
  - *慢启动*：一整轮请求（数量 = 当前并发）全部正常，并发翻倍，封顶到慢启动阈值。没有硬顶之后这一段才是真正的安全网：上限 96 时 3→6→12→24→48→96，不必等 93 个「连续 5 次」；上限填得越高，越依赖它逐轮探路而不是一次性打满。
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
- **运行与触顶展示**：标题徽标只表示状态，适用预设摘要只表示配置；`stageNRuntimeInfo` 在卡片底部分别标出实际在飞、队列待派发、动态配额与配置上限，无活跃行号时仍显示队列与容量，停止后清除实时数字和提示。逐条预设详情同样使用明确标签，不混用分母。触顶以服务端 `presetPipelines.stageN[].topped` 为准，不是配额用满；阶段运行区只有全部预设触顶才标「全部触顶」（`stagePipelines.stageN.presetCount`/`toppedCount`），单预设显示「触顶」，部分触顶由预设详情与悬停逐条说明。
- **运行中增删预设（热更新）**：页面立刻 `POST /api/ai-proofread/presets`（body `{ stage, presets }`），由 `updateStagePresets` 清洗后交给对应阶段的 `stage-dispatch.updatePresets`。实例重分配待办，调度同步看板并唤醒派发；新预设立刻接活，已发出的请求照常完成。删空时回落到阶段配置，任务没在跑时返回 409（`NOT_RUNNING`）。请求归属、同 ID 重加隔离及退休通道清理归 [AI 校对契约](ai-proofread-contract.md#阶段派发状态与请求归属aistage-dispatchjs)。
- **状态接口**：`concurrency` 是起步并发，`concurrencyMax` 是并发上限，`currentConcurrency` 是初审当前放行的并发；多预设时这三个值都是各预设通道之和，`stagePipelines.stageN` 的 `concurrency`（当前）/`concurrencyMax`（上限）同理，并额外带 `presetCount`/`toppedCount`；`presetPipelines.stageN[]` 逐条给出每个预设自己的 `quota`/`inFlight`/`pending`/`configuredConcurrency`/`topped`。不再回报 `smartConcurrency`。
- **并发边界**：**只有下界 1 是硬约束，没有并发上限硬顶**——用户填多少就是多少（填 64 就跑 64）。安全网交给自适应调度（`min(上限, 3)` 起步后慢启动上探）与熔断（错误率 / 限流饱和即终止），配置层不再截断；32 那道旧硬顶在熔断完善后只拦得住用户主动选择的高并发，而且拦得没有提示（填 64 实际跑 32，页面上仍写着 64）。`ai/concurrency-limits.js` 的 `AI_CONCURRENCY_LIMITS` 仍是唯一权威来源，其中 `max` 已改为 `Number.MAX_SAFE_INTEGER`，只作为各 `clamp` 调用点挡 Infinity / NaN 的算术护栏，不是业务上限；面板输入框因此不再渲染 `max` 属性，`cleanConfig`/`cleanSubStageConfig`/`createStageController`/`preset-pool` 全部以该常量为准。**越界与非整数一律不得回落到默认值**——旧实现把超范围的 20 换成 3，也把非整数换成 3，用户静默降速而无提示；现在低于下界归 1，非整数四舍五入（与服务端 `clampCap` 同口径）。`ai-presets.js` 的 `createPresetTools` 会被 `toString()` 注入页面、无法引用模块作用域，因此自带一份同值口径，两边的边界行为由 `scripts/ai-smart-concurrency.test.js` 锁死，改一边必须同步另一边；共享队列 `src/ai/task-queue.js` 同口径（只保底 1，`workerCount` 另受 `items.length` 限制）。
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
