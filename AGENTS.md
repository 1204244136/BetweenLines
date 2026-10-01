# AGENTS.md

本文档面向在 BetweenLines 仓库中读代码、改代码和运行验证的编码代理与维护者。当前翻译比较工作台称为 TransComparator。

## 文档职责

`README.md` 是对外文档，面向使用者、协作者和首次运行项目的人，说明产品意义、当前工作台、环境安装、命令和输出位置。它不规定内部实现，也不替代本文件的验证清单。

`AGENTS.md` 是仓库内的实现契约，面向需要修改代码的 agent 和维护者，规定模块归属、数据不变量、生成物边界、修改纪律和验证方式。它不是用户手册；用户操作说明、功能介绍和公开限制应写在 `README.md`。

两份文档都描述同一个项目，但职责不同：公共行为变化需要同步更新 README，内部路径或验证规则变化只更新 AGENTS；如果一个改动同时影响两者，应分别从各自读者的角度记录一次，不要整段复制。

判断一条信息该放哪里：读者需要据此操作或评估项目，放 README；只有改代码的人需要据此保证正确性（字段键名、模式裁剪、存储边界、定位规则、验证命令、故障根因），放 AGENTS。产物字段清单、快照保留策略、写回定位规则和内部故障处置都属于后者，README 只描述用户可观察到的结果。

## 修改纪律与任务完成定义（Definition of Done）

任何修改代码的 Agent 或维护者必须严格遵守以下执行纪律：

- **任务完成硬性门槛（Definition of Done）**：
  **任何代码修改任务，在执行本地 `git commit` 之前均视为未完成。** 严禁在代码改完但未提交的情况下直接向用户交卷回复。
- **每次改动后自动 commit**：
  - 每完成一处改动就自动生成本地 commit，不再逐次向用户索要确认。
  - 按改动单元拆分，互不相关的改动不混进同一个 commit。
  - commit 信息应使用中文并遵守 Conventional Commits 风格（如 `feat: ...`、`fix: ...`、`refactor: ...`）。
  - **提交前必须跑相关测试与 `git diff --check`**，并把**实际跑过**的命令与测试结果写进 commit 正文的 `验证：` 一行。
  - **只做本地提交，严禁 `git push`**（除非用户明确要求，本仓库 remote 为公开仓库）。
  - `out/`（生成物、已发布快照）与仓库外的源文本严禁进入提交，`.gitignore` 已覆盖的文件不要用 `-f` 强加。
- **否定意见与提交撤回**：
  - 若用户对最近一次的 commit 表达了否定意见（如明确指出改动不符合预期、方向错误或要求重做），接下来的改动必须**先撤回被否定的 commit**（优先通过 `git revert` 撤销该提交，确保回退到该 commit 之前的干净基线）。
  - 严禁在已被否定的错误提交上直接叠加修改；撤回后再展开新的实现与改动。
- **改动层级与刷新提示契约**：
  完成修改后，必须在回复里给出与本次改动对应的**最小必要操作**。生效路径只有两条且**互不包含**：**常驻进程加载的代码**（不重启不换）与**已发布快照里的页面内容**（不重新渲染不换）。不要逐级累加，也别指望「做了底层，表层自动就好了」：

  | 改了什么 | 最小必要操作 |
  |---|---|
  | `public/setup.html` | 控制台 F5（静态文件按 `no-store` 每次重读） |
  | `public/*.js`、`public/*.css`、`src/workbenches/translation-compare/**`（`ai/**` 见下行）、`src/core/**`（除下行列出的三个） | 控制台点「应用新布局」（或 `npm run layout`）→ F5；**不用重启** |
  | `src/workbenches/translation-compare/ai/**`（AI 校对与预筛任务的执行体，被 `src/runtime/routes/ai.js` 顶层 require） | **重启控制台服务**（`start-setup.bat` / `npm run setup`）；同时改了构建器或 `public/*.js` 时，重启后仍要点一次「应用新布局」 |
  | `src/runtime/**`、`src/storage/**`、`src/core/{atomic-fs,storage-layout,progress}.js` | **重启控制台服务**（`start-setup.bat` / `npm run setup`） |
  | `src/workbenches/speaker-attribution/**` | **重启服务 + 重新生成说话人工作台**：它的页面输出到 `out/runtime/speaker-attribution/`、不在项目快照里，「应用新布局」碰不到它 |
  | `src/ingest/**`、`align_jp.py`（行集与对齐口径） | **重新生成**（控制台「开始生成」，或 `npm run align:jp && npm run build`）；生成走 npm 子进程，读到的都是最新代码，**不用重启** |

  - 重启只换常驻进程的代码，**不会**重渲染已发布的快照：同时改了服务端与 `public/*.js` 时，重启后仍要点一次「应用新布局」，F5 才看得到新客户端脚本（脚本是内联在快照 HTML 里的）。同样严禁把「下一次请求会自动生效」当作常驻进程代码的生效方式。
  - **重新生成包含「应用新布局」的效果**（都会重渲染并发布新快照）——这是唯一的包含关系，重跑对齐时不必再点布局按钮。
  - 回复里必须写成「哪部分改动 → 对应什么操作」。多处改动各自对应不同动作时逐条标明，不要丢给用户一串没有主语的步骤，否则会被读成「这些都得按顺序做一遍」。
- **通用约束与协作**：
  - 优先使用确定性的本地 scripts，不要手工改 spreadsheet。
  - 变更输入格式、正文过滤、heading detection 或段落切分后，必须重新运行导出和对齐。
  - 修改 alignment 后，必须验证空原文、重复长原文和行数异常。
  - 不要把技术 pivot 描述成主从关系。
  - 不要使用破坏性 git 命令，除非用户明确要求。
  - 如果工作树已有用户或其他 agent 的改动，必须保留并与之协作。
  - 修改后不要进行浏览器截图验证，因为本地 Playwright 运行时缺少 `playwright-core`。

## 实现所依赖的领域契约

BetweenLines 共享本地、文件型文本处理和分析能力；当前的 TransComparator 翻译比较工作台可以处理最多三份文本：

- 一份原文，通常是源语言文本（日文）。
- 一到两份非原文文本，可以是不同译本、校订本或地区版本。

上游材料对齐约定：
本项目使用的源文件（除台版外）均来自 `index-X` 项目（同级目录 `../index-X` 或环境变量 `INDEX_X_DIR`）的相关产物：
- 简中文本来自 `index-X` 构建生成的 EPUB 档案或解压工作区（`output/epubs/` 或 `EPUB/` 目录，文件名形如 `[S1_01]...01X.epub`）。
- 日文原文来自 `index-X` 维护的对齐工作源（`.cache/epub-work/japanese-text/` 或同步镜像）。
- 台版文本作为同级的非原文对照材料，来自独立的台版出版物。

index-X 结构与命名规范契约：
- 作品编号：`S1`（旧约）、`S2`（新约，含 `S2_22r`）、`S3`（创约）、`S4`（少女共栖）、`S5`（外典三段式 `S5_AA_BB`）、`S6`（日期短篇 `S6_YY.MM.DD`）。
- 正文文档命名：`<表头>_<语义后缀>.xhtml`，内容序从 `-01` 开始。
- 章节结构：序章前无标题正文聚合为内容序 `01` 的 `Before_the_Prologue`（引子）；后记作者署名后的正文聚合为 `After_the_Epilogue`（尾声）。
- 准入与边界：`Afterwords`（后记/あとがき）不进入翻译比较与说话人推断；紧接后记的 `After_the_Epilogue`（尾声）属于正文故事叙述，必须进入比较与推断。附录/版权页/介绍页为硬性截止边界。
- 格式契约：正文套用统一固定行模板（L1-L6），支持 `heading-lines` 多层标题、`<ruby>` 注音、以及 `<a epub:type="noteref"><sup>㊟</sup></a>` 译注标记。

非原文文本在产品语义上是同级材料。可以为了实现选择其中一份作为技术 pivot，但不要在 UI、文档或变量说明中暗示它比另一份更权威。

原文是准入边界：如果某段内容不存在于原文，哪怕某个译本或地区版本收录了它，也不应进入最终比较。典型例子是特典、电子书附录、版权页、后记、译注和制作信息。

## 不变量

- 表格行与原文段落保持 `1:1`：一张表格行只允许包含一个原文段落，原文不得拆分、合并或跨行复用。
- 非原文段落可以为对齐、diff 和展示进行拆分或合并，因此一份原文段落仍可对应多段译文。
- 产物必须按比较模式生成：双语模式的 `input-selection.json`、`paragraphs.json`、`jp-align.json`、`translation-compare.{json,csv,html}`、AI 提示词和控制台日志里都不允许出现第三列（`tw`、`台版`、`参考文本`、`非原文 C`）的键、标签、空占位或 hidden 控件；三语模式则必须完整保留三列。判断依据是"该模式是否真的有这一列"，不是"有没有值"。
- 上述模式裁剪不得改变 `projectKey`、`rowsSignature` 或 `signature`：它们是浏览器备注与写回定位的键，只能因源文本或对齐结果真实变化而变化。
- 不要重新引入没有 reuse tracking 的 naive paragraph-number fallback。
- 不要让同一个原文长段落被 semantic groups 和 fallback 重复使用。
- 修改 text cleaning、heading detection 或正文过滤后，必须重新生成 `paragraphs.json`、`jp-align.json` 和最终工作台。
- 源文本文件和生成物不应提交到仓库，除非用户明确要求。

## 当前 Pipeline

1. `src/ingest/text-utils.js`
   - 集中配置输入文件路径和输入模式。
   - TXT 以 UTF-8 直接读取。
   - 非 TXT 优先通过 Pandoc 转成完整 linear plain text。
   - 对 Pandoc 输出执行正文范围过滤、媒体占位过滤和段落切分。
   - 识别章节/行间标题，并将其排除在正文段落之外。
   - 通过 OpenCC 在需要时做中文简繁归一化。

2. `src/ingest/pandoc-utils.js`
   - 封装 Pandoc 调用。
   - 将 EPUB、DOCX、HTML、ODT、Markdown、RTF 等 Pandoc 支持格式转为 plain text。
   - 只负责格式转换，不负责判断哪些内容应进入比较。

3. `src/ingest/epub-utils.js`
   - EPUB 默认走 Pandoc。
   - 内置 OPF/nav/spine reader 保留为诊断和 fallback 路径。
   - 不要把 EPUB 专用逻辑扩展成所有格式的主路径。

4. `scripts/export-paragraphs.js`（兼容 CLI；实际输入逻辑在 `src/ingest/`）
   - 加载最多三份源文件。
   - 写入当前构建目录的 `paragraphs.json` 和输入选择快照。
   - `src/ingest/input-selection.js` 的 `validateSelection` 只保留该模式的列：双语模式的 `files`/`labels`/`startMarkers` 里不出现 `tw` 键。
   - `src/ingest/text-utils.js` 的 `loadParagraphs` 双语模式只返回 `cn`/`jp`，不写空 `tw` 数组；控制台也只按 `activeLangs()` 打印段落计数。
   - 被 `npm run align:jp` 自动调用。

5. `src/workbenches/translation-compare/align_jp.py`
   - 使用 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 做跨语言语义对齐。
   - 对齐移动只允许 `1:1`、`1:2`、`1:0`、`0:1`：每张表格行最多包含一个原文段落；译文侧仍可一段拆成多段。
   - 当 `torch.cuda.is_available()` 为 true 时使用加速后端，否则使用 CPU。
   - 写入当前构建目录的 `jp-align.json`，其中 `groups` 是唯一对齐数据；组内区间只用 `pivotStart`/`pivotEnd` 命名。
   - 双语模式 pivot 固定为 `cn`，日志按模式称呼该列（译文 / 非原文）。

6. `src/workbenches/translation-compare/build-compare.js`
   - 三语模式对齐两份非原文文本；双语模式不做该步，直接把主文本段落作为技术 pivot 单元。
   - 读取跨语言 `groups`（`pivotStart`/`pivotEnd`）。旧快照里的同数量多段原文组拆成 `1:1`；原文段数多于目标段数时拒绝构建并提示重新运行 `npm run align:jp`。
   - 行字段、`counts`、CSV 列、页面标签和内嵌行数据都由 `rowFieldsFor(mode)` 决定：双语行不携带 `tw`/`twCn`/`twChars`/`refinedScore`。裁剪只删字段，不改变 `signature`/`rowsSignature` 取值。
   - 输出 HTML、CSV、JSON。
   - 生成页面的控制栈是四个 `<details class="panel-details">` 抽屉：预筛选、AI 辅助校对、筛选与批处理、备注空间与找回；按数据流方向自上而下排列。统一置于父抽屉 `#controlStackPanel`（`.panel-group`）内。
   - 备注空间辅助模块为 `notes-spaces.js`，支持备份、找回、多历史空间合并与载入自愈；一次性回执由 Toast 弹出（实现与样式为两个工作台共享：`public/workbench-shared.js` 的 `createToastCenter()` + `public/toast.css`），持续状态由固定状态行承载；不可逆操作（写回原文件、清空/删除备注空间、从备份登记）一律经页内确认弹窗 `askConfirm()`；AI 预设管理与并发上限（内部自适应调度、与熔断联动）完整集成。
   - 验证执行 `node --test scripts/notes-spaces.test.js scripts/build-compare.test.js scripts/notes-recovery-merge.test.js scripts/toast.test.js`。
   - **详细规范**：前端控制栈结构、多历史空间合并算法（`mergeNotes`）、确定性匹配证据通道、载入自愈、Toast 提示设计、预设管理与并发调度契约详见 **[docs/contracts/workbench-notes-spaces.md](docs/contracts/workbench-notes-spaces.md)**。

7. `src/core/storage-layout.js`、`src/storage/project-store.js`、`src/runtime/generation-pipeline.js`
   - 将运行时输入、隔离 staging 和不可变项目快照划分到不同目录。
   - 控制台生成成功后以目录 rename 发布快照，再原子更新 `out/active-project.json`。
   - 项目切换只更新活动指针和小型输入选择，不复制大型生成物。
   - `out/projects/<projectKey>/snapshots/<snapshotId>/` 是已发布生成物的唯一事实来源。
   - `rebuildProjectHtml` 不得原地覆盖已发布快照：必须复制到 staging、重新渲染后发布新快照并切换活动指针。
   - `active-project.json` 原子写失败时保留旧副本。服务端入口校验 Host/Origin/Sec-Fetch-Site 与 CSRF token。

8. `src/ingest/line-units.js`、`src/workbenches/`
   - 完整段落是共享的稳定源索引；句子/对话行只能作为带 `parentParagraphId` 的派生单元。
   - 说话人归属待判断行只抽取完整发话（`「…」`、`『…』`），不按引号内部标点拆行；叙述句仅用于上下文。
   - 翻译比较与说话人推断使用独立的工作台数据模型、结果和备注空间。
   - 共享 LLM 传输层只请求 `http:`/`https:`，拒绝云元数据、link-local、多播与自动重定向。
   - 模式契约按 `proofread-contract.js` 的 `modeSchemas` 裁剪。
   - 熔断（`ai/circuit-breaker.js`）由服务端内部决策，页面、预设与请求体都不得再携带熔断开关或阈值；失败轨终止任务，限流轨先冷却探测再终止。
   - 提示词按五层组装（①通用侧 ②模式层 ③特化侧 ④动态上下文 ⑤固定尾巴），合并顺序固定。
   - 输出侧三大确定性门禁漏斗：`ensureRevisedText` → 成品格式门禁（`format-guard.js`）→ 标点规范化（`punctuation.js`）→ 语言护栏（`guardTargetScript`）→ `decisionToResult`。
   - 验证执行 `node --test scripts/proofread-prompt-layers.test.js scripts/format-guard.test.js scripts/punctuation.test.js scripts/term-table.test.js scripts/low-score.test.js scripts/web-lookup.test.js scripts/ai-smart-concurrency.test.js scripts/ai-error-kinds.test.js scripts/ai-stage-metrics.test.js scripts/circuit-breaker.test.js`。
   - **详细规范**：五层提示词规范、判定链流程、按行特征裁剪、实体闸门、输出格式门禁/标点规范化/语言护栏、译名对照表与注音口径、低分归因、线上查证与说话习惯契约详见 **[docs/contracts/ai-proofread-contract.md](docs/contracts/ai-proofread-contract.md)**。

9. `src/workbenches/speaker-attribution/`
   - `speaker-selection.js` 支持单语 `--source` 和双语 `--source` + `--parallel` 输入。
   - 双语 TXT/文档模式使用 `prealign.js` 的整篇单调预对齐；双 EPUB 模式先按 XHTML 文件名完整表头分段再预对齐。
   - `build-workbench.js` 只生成说话人专属产物，不复用翻译比较的 rows 或 notes；双语对比以原文为准入边界。
   - 持久化的 `alignment` 只保留摘要，预对齐中间行不落盘。
   - `attention.js` 为确定性证据注意力层，按邻近度、动作词、疑似称谓和对齐信号压缩 prompt 输入。

## 文件归属与扩展规则

- `src/core/`、`src/storage/`、`src/ingest/`：共享能力。修改时必须检查所有工作台和项目快照调用方。
- `src/workbenches/<name>/`：领域工作台。工作台拥有自己的结果模型、构建器、提示词、缓存和备注空间，不得复用另一工作台的 rows 或 notes 作为数据模型。
- `src/workbenches/<name>/client/` 或 `public/`：浏览器端交互逻辑与表现层代码。
- `public/` 下跨工作台共享的浏览器资源（`workbench-shared.js`、`toast.css`、`workbench-diff.js`）由两个构建器各自读取并内联注入页面：改一处必须同时核对翻译比较与说话人归属两个工作台，并跑 `npm test`。**不要把它们复制成各工作台自己的副本**——两份实现会各自漂移（说话人工作台原先就是各写一套 `window.alert`，与翻译比较的 Toast 体系长期不一致）。
- `docs/contracts/`：面向代理与维护者的详细领域契约、算法规格与故障排查手册。
- 新增通用格式转换优先扩展 `pandoc-utils.js`；新增特定格式的业务准入与提取逻辑在 `src/ingest/` 中独立实现。

## 翻译构建模块边界

- src/workbenches/translation-compare/build-compare.js 是 CLI、构建流程与快照重渲染入口，保留原有导出供兼容调用。
- row-alignment.js 负责比较行组装与非原文对齐；alignment-artifact.js 负责读取已有对齐产物、兼容旧区间字段和校验单原文段落。算法与阈值保持原口径。
- row-output.js 统一模式字段裁剪、CSV、导出行及客户端行，必须保持原有签名。
- render-workbench.js 负责 HTML 与实时读取静态资源；model-options.js、notes-recovery.js 是不依赖 DOM、文件系统和任务状态的纯函数模块。序列化到浏览器的函数不得捕获模块私有依赖。
- ai/proofread-defaults.js 与 ai/decision-score.js 分别拥有共享默认配置和纯评分规则；渲染器从这些模块及 proofread-contract.js 读取契约，不得为了配置加载 ai-proofread.js 的运行状态。边界由 scripts/translation-module-boundaries.test.js 验证。
- 这些模块不得反向依赖 build-compare.js。新增领域调用优先直接引用职责模块，兼容入口只服务现有调用方。
- 修改边界需运行 npm test，覆盖模式裁剪、备注恢复、快照重渲染与布局缓存回归。纯结构移动不要求重新运行语义对齐。

## 客户端与 AI 调度边界

- `public/workbench-diff.js` 只负责纯文本差异算法和 HTML 转义回调，不读取 DOM、备注、筛选或任务状态。`public/workbench-client.js` 只持有缓存并决定差异插槽的展示。
- `ai/error-kinds.js` 是异常分类的唯一实现（服务端直接 require，构建器把常量与纯函数 `.toString()` 注入页面）。服务端 `clientStatus().stageErrors` 回报本次运行的失败明细，客户端从失败备注得到本地明细后与之合并；**两端不得各写一套分类规则**，否则「异常」悬停提示的分类口径会分叉。
- AI 调度的 `concurrency-controller.js` 只负责并发策略（起步、慢启动与加法上探、频控/过载下调、熔断塌缩与恢复）、退避时间和重试判定，并发上限只有一个输入（`concurrency`），**不得重新引入前端「智能并发」开关**——自适应由服务端强制开启，页面与请求体都不携带调度参数；与熔断的联动只读 `circuit-breaker.js` 的 `state`/`pressure`，两边互不读写对方状态；队列顺序、阶段业务和结果写入仍归 `ai-proofread.js`。
- 阶段编排只有两个输入，都由 `stagePlan` 归一：**起点**（`targetStage`；`all` 是旧客户端的兼容别名，等同 `stage1`）与**这条流水线有几段**（下游配没配模型）。行为统一为「从起点一路推进到已启用的尽头」：配了 `stylistConfig` 才从初审接到复审，配了 `arbiterConfig` 才从复审接到仲裁（仲裁只能接在复审后面，所以从阶段一起步时必须先有复审）。**不要重新引入「级联 / 不级联」的模式开关**——那会让「阶段一 开始」一个按钮同时表示两件事，而且状态会被持久化。
- 客户端三个「开始」按钮**只报起点**，级联范围由服务端算并在 `clientStatus().stageCascade` 里如实回报（`stageMode` 报起点）。刷新页面后本地状态会丢，按钮态一律以这两个字段为准；级联运行中三个「开始」全禁用、三个「停止」全可用（停的都是同一条流水线）。
- 服务端同一时刻只允许一个 AI 任务（`startProofread` 遇到 `status.running` 直接报 `RUNNING`），所以「阶段二不等阶段一」只能靠同一个任务内的队列级联实现，不能在中途追加阶段。客户端不得恢复成「排队等前一阶段整体结束再起第二个任务」的默认路径。
- 从阶段一起步且配了复审时，`collectResumedStage2` 会把「已有初审结论、只差复审」的行**直接放进** `stage2Pending`（并从初审队列里摘掉），只在 `continueOnly`（「继续剩下的」）时启用。缺了这一步，界面上「待复审 N 行」只能等初审把它们重新产出一遍，复审并发配得再高也派不出活来。
- `runStage2Stylist` / `runStage3Arbiter` **不得在自己内部吞掉异常**：错误必须挂在返回值的 `stageError` 上，由 `executeStage2` / `executeStage3` 统一 throw 后再走「频控重试 → 计入 stageNErrors → 回退上一阶段方案」。内部 catch 后只 pushLog 会让那一行在指标上凭空消失（既不算定案也不算异常）。
- 客户端在「任务在跑 + 服务端回报了 `stagePipelines` + 没有 `stageCascade`」时判定常驻服务是旧版，提示一次重启并让阶段三卡片显示「未接入」；判据必须同时要求 `stagePipelines`，否则会把精简的状态桩误判成旧服务。
- 独立阶段二/三的队列优先复用上一轮留在内存里的结论（`reusePreviousResults`，要求 `projectKey` 与 `rowsSignature` 都相同）；拿不到才退回从备注文本反推（`reconstructStage1Result`，有损：`lowScore` 丢失、`score` 用 80 兜底）。跨项目或重新对齐后一律走重建，绝不串行号。
- `ai/stage-note-state.js` 是当前轮次备注与阶段待办判定的共享实现，由构建器序列化到页面。统计、点击筛选、启动弹窗、续跑跳过和服务端队列必须使用最新 `[AI校对]` 块，历史块不得参与本轮完成判断；人工确认行不计待办。请求携带备注快照时，内存结论还须与该行最新块相同才可复用，已清空或不在备注快照里的行不得借旧内存重新入队。阶段二/三清空重跑只修改最新块，保留历史块与人工备注。回归运行 `node --test scripts/stage-note-state.test.js scripts/ai-smart-concurrency.test.js`。
- 调整客户端资源、构建器或服务端代码后的生效操作，按「改动层级与刷新提示契约」执行；这些调整都不需要重新对齐。
- 运行 `node --test scripts/client-ai-boundaries.test.js scripts/ai-smart-concurrency.test.js scripts/workbench-layout-sync.test.js`，并确认 `npm test` 全量通过。

## 控制台模块边界

- src/runtime/input-server.js 只组装依赖、执行统一鉴权、分派请求和管理监听生命周期。
- request-security.js 管理来源校验与会话令牌；http-json.js 负责 JSON 请求/响应；artifact-response.js 负责静态文件与产物响应。
- input-files.js 管理本机文件选择、扫描和翻译输入选择；speaker-runtime.js 封装说话人输入持久化及独立任务状态，并允许注入构建与写入函数进行隔离测试。
- picker-paths.js 拥有各导入入口（jp/cn/tw）的默认目录与 ClientGuid：起始目录按「当前卡片路径 → 该入口记忆 → 已登记选择」推导，记忆写在 `out/runtime/picker-paths.json`，三个入口互不共用。系统窗口用 `IFileDialog::SetFolder` 强制定位，**不得改回 `SetDefaultFolder`**（它只在没有系统记忆时才生效，达不到分入口的目的）。控制台不显示这个默认目录（曾把提示塞进「选择导入方式」标题行，长路径在 flex 下把标题挤成竖排，已整体移除，回归见 scripts/setup-import.test.js），因此服务端也不再回报 `defaultDir`/`pickDefaults`。`scripts/windows-path-picker.ps1` 必须保持 UTF-8 BOM，否则 Windows PowerShell 5.1 会按 ANSI 读中文标题并编译失败（回归见 scripts/picker-paths.test.js）。
- routes/ 按输入、状态、项目、生成、写回和 AI 划分。处理函数命中后返回 true，未命中返回 false；未命中不得读取请求体或发送响应。鉴权必须在路由分派之前完成，路由不得反向依赖服务入口。createInputRoutes 的 `pickPath` 可注入，让系统选择窗口在路由测试里被替掉。
- 修改这些边界需运行 node --test scripts/runtime-modules.test.js scripts/input-server.test.js scripts/writeback-export.test.js；接口路径、响应形状、错误状态码和写回定位参数必须兼容。

## 正文过滤原则

- 正文的起点和终点必须通过结构性标记确定（如 Heading、特定标签或语义标记）。
- 禁止使用基于字数、行数或纯文本正则猜测整书的正文起始位置。
- 特典、插画页、版权页、出版信息、目录页必须明确排除在比较范围之外。
- `src/ingest/text-utils.js` 统一管理章节探测（`chapterPatterns`）和边界裁剪逻辑。
- 过滤逻辑修改后必须运行基准测试以确保行索引稳定性。

## 对齐标签

- 对齐质量标签必须来自算法打分或规则推断，严禁人工硬编码。
- 标签定义与分数阈值必须集中定义在 `align_jp.py` 与 `build-compare.js` 共享常量中。
- 分数变化时必须保证向前兼容旧版快照中的标签显示。

## 写回契约

- 写回必须基于原始输入文件进行局部替换，严禁全量覆写造成格式或排版丢失。
- 替换目标段落必须通过多级定位（精确内容匹配 -> 上下文锚点 -> 索引范围校验）确保唯一性。
- 若无法唯一确定写回位置，必须放弃写入并报错提示人工介入，严禁猜写。
- 写回自动备份副本（`.bak`）为可选项，与项目绑定，默认关闭；开启时在写回原文件前创建备份以防意外覆盖。
- 涉及内联标签（如 `<ruby>`、`<a epub:type="noteref">`）时，修改文本必须保留原有内联标签结构，不得破坏标签对称性。

## 生成文件与重型文件

除非用户明确要求，不要提交或复制：

- `.venv/`
- `node_modules/`
- `out/`
- `*.txt`、`*.epub`、`*.docx` 等源文本文件
- 下载的 model caches
- 本机安装脚本或临时环境文件

源文件路径应集中维护在 `src/ingest/text-utils.js`。公开发布前不要写入个人目录、绝对路径或其他隐私信息；作品相关的具体内容允许出现在示范档案 `profiles/demo.js` 与 `text-utils.js` 的正文边界清单里，但不要在其他位置重复展开。

## 本地测试输入

如需使用真实样本进行本地验证，请在仓库之外自行准备三类测试输入，并把本机路径保存在忽略文件或环境变量中，不要写进仓库：

- EPUB：简中 EPUB 的单本解压目录或 `.epub` 文件。
- 日文原文：日文侧对齐工作源目录。
- 台版原文：台版出版物的单本解压目录。

这些路径仅供本机测试输入定位。不要把源文件、绝对路径、样本目录名或生成物复制或写入仓库，也不要写进代码默认配置。公开发布前应确认 README、AGENTS 和日志没有泄露本机路径；作品相关的具体内容只保留在示范档案与正文边界清单里，不散落到其它文档。

## 验证清单

基础导出：

```powershell
npm run check:pandoc
npm run export:paragraphs
```

完整生成：

```powershell
npm run align:jp
npm run build
```

自动化测试集：

```powershell
# 工作台、备注空间与 Toast 回归
node --test scripts/notes-spaces.test.js scripts/build-compare.test.js scripts/notes-recovery-merge.test.js scripts/toast.test.js scripts/ai-model-presets.test.js scripts/ai-smart-concurrency.test.js scripts/prefilter-restore.test.js

# AI 提示词分层、门禁、标点与对照表回归
node --test scripts/proofread-prompt-layers.test.js scripts/format-guard.test.js scripts/punctuation.test.js scripts/term-table.test.js scripts/low-score.test.js scripts/web-lookup.test.js scripts/speech-habit-layer.test.js scripts/speech-habit-source.test.js
```

验证原则：
- 表格行数必须与原文段落数严格一致。
- 同一长原文段落不应意外重复。
- Pandoc 媒体占位不应成为正文段落。
- 特典、后记、版权页不应进入最终比较。
- `bilingualLeakage` 必须为 `false`；双语快照的 `counts`/`rowKeys` 不应出现 `tw`、`twCn`、`twChars`、`refinedScore`。

## 常见故障定位

- **两种语言从不同情节开始**：先比较转换后的完整文本和过滤后的段落，不能仅凭行数或首个空对齐组判定成功。findBodyStart 的简介状态必须在独立彩页/插图标题处结束；图片已被移除时仍须保留随后的无标题引子。回归见 scripts/text-utils.test.js；修复后重新导出、对齐、构建，并核验真实首段对应内容。

- **原文重复 / 为空**：检查是否重新引入了无 reuse tracking 的 fallback，或正文过滤是否改变了段落索引。
- **双语产物出现第三列内容**：确认活动快照是否由旧版本生成（重新运行 `npm run align:jp && npm run build`），若仍存在检查 `validateSelection`、`loadParagraphs`、`rowFieldsFor`、`pageLabels`。
- **写回定位失败或写错位置**：确认目标类型识别（四种 `TARGET_*` 之一），检查含内联标记段落是否走块级匹配路径；同一卷多处相同段落需携带 `rowTexts` 坐标。
- **修改结果出现换行/空行**：检查成品格式门禁（`ai/format-guard.js`）是否启用，单段目标列会并回换行，多段不一致会作废转人工。
- **标点被改坏 / 日文泄露**：检查标点规范化（`ai/punctuation.js`）语境判据与 `restoreTerminalPunctuation`；日文泄露检查注音 HTML 覆盖与输出语言护栏（`guardTargetScript`）。
- **特化规范未生效 / 提示词突然变短**：检查条目是否误加 `features` 或 `characters`，角色名是否与文本匹配，页面点「恢复默认」前需先重新 `npm run build`。
- **双击 bat 提示拒绝连接**：控制台页面需在 `server.listen` 回调中动态获取端口并打开，不要用固定 timeout。
- **开关审核轨迹 / 抽屉 / 拖窗口后鼠标变慢、输入延迟**：这是主线程被强制布局占满，不是渲染卡顿。排查三类源头，回归测试 `scripts/workbench-layout-sync.test.js` 锁住每一条边界：
  1. 事件处理器对整表逐行调用 `syncRevisionEditorHeight`（读 `scrollHeight` 一次就是一次整表重排），或 `resize` 每次事件都做全量同步。
  2. **整批量高的读写没分离**：逐行「写 `height:auto` → 读 `scrollHeight` → 写回」交错，每行一次整表重排（实测 500 个输入框 296ms）；必须先整批写 `auto`、再连续读、最后统一写回（实测 15.8ms，18.8×），见 `measureRevisionEditors`。
  3. **为取可见行数而查 DOM**：`updateResultsMaxHeight` 里 `tbody.querySelectorAll("tr[data-index]").length` 会带动一次整表强制布局（实测 500 行 233ms）。行数必须由 `renderVisibleRows` 传进来，或取自 `renderedRowsById.size`。
- **审核轨迹展开状态在筛选/翻页后回弹**：重渲染会重建全部行节点，只靠 DOM 的 `hidden` 会被冲回默认态，用户只能反复点击。用户开合选择记在 `pipelineOpenOverrides`（会话内，不落盘），`renderNoteSummary` 渲染时优先取它。
- **详细排查指引**：完整的常见故障定位手册、历史回归原因与处置方案详见 **[docs/contracts/troubleshooting.md](docs/contracts/troubleshooting.md)**。

## 当前限制

- UI 是静态 HTML table，使用客户端分页切片（翻译比较默认 100 行/页，说话人默认 50 行/页），行数据仍随页面整体内嵌；未实现虚拟滚动，超大文本下页面体积增长仍受行数据量限制。
- **行内输入框高度必须按缓存同步**：`workbench-client.js` 的 `syncVisibleRowLayout` 读 `scrollHeight` 就是一次整表强制布局，逐行读一遍即 O(行数) 次重排（实测 500 行页面单次全量同步 = 533 次布局、311ms 主线程）。因此它只在四种情况下重量：新节点（整页重渲染）、该行内容被改写（`invalidateRevisionEditorHeight`）、视口高度变化、列宽变化（`remeasureEditors`）。面板/抽屉开合只走 `ifFrameMoved` 的可用高度重算，**开关审核轨迹不做任何布局同步**。新增事件处理器时不要直接写 `for (const editor of ...) syncRevisionEditorHeight(editor)`，也不要让 `resize` 每次事件都做全量同步（会合并到一帧并在尺寸稳定后重量一次）。
- **真的要量一批时必须批量读写分离**：`measureRevisionEditors` 先整批写 `height:auto`、再连续读 `scrollHeight`、最后统一写回——连续读只会强制布局一次。写成「单行写→单行读→单行写回」的循环会让每行都付一次整表重排（实测 500 个输入框 296ms → 15.8ms）。单次量高仍走 `syncRevisionEditorHeight`。
- **可用高度不得为数行数而查 DOM**：`updateResultsMaxHeight` 的行数取自 `renderVisibleRows` 传入的切片长度或 `renderedRowsById.size`；`tbody.querySelectorAll("tr[data-index]").length` 在重渲染后是一次整表强制布局（实测 500 行 233ms）。整段同步里 `querySelectorAll(".revision-editor")` 也只允许查一次，失效与量高共用同一份列表。
- **重渲染残留的固有成本**：500 行/页时，换掉 `tbody.innerHTML` 后的首次布局约 173ms（CDP Tracing 实测 1 次 Layout + 3 次 UpdateLayoutTree），这是新建 500 行 DOM 的固有开销，优化不掉；可优化的是别让它发生第二次。改用 100 行/页（默认）即可大幅降低。
- 备注按 row index 存储，已核验记录同时带 `rowSig`；新空间只在同一输入项目的历史空间内自动找回有内容证据的记录，其他项目只允许手动预览找回；本页空间挨过旧版损伤时载入自愈一次。只剩行序推断的锚点配对、以及按行号找回，必须逐行核验，不能当作可靠内容匹配。
- 跨语言 embeddings 只是校对辅助，不是最终权威 alignment。
- OpenCC 有助于比较中文变体，但无法归一化翻译风格差异。
