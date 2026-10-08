# AGENTS.md

本文档面向在 BetweenLines 仓库中读代码、改代码和运行验证的编码代理与维护者。当前翻译比较工作台称为 TransComparator。

## 文档职责

`README.md` 是对外文档，面向使用者、协作者和首次运行项目的人，说明产品意义、当前工作台、环境安装、命令和输出位置。它不规定内部实现，也不替代本文件的验证清单。

`AGENTS.md` 是仓库内的实现契约，面向需要修改代码的 agent 和维护者，规定跨工作台模块归属、数据不变量、生成物边界、修改纪律和验证方式；领域细则由下文链接的契约各自拥有。它不是用户手册；用户操作说明、功能介绍和公开限制应写在 `README.md`。

两份文档都描述同一个项目，但职责不同：公共行为变化需要同步更新 README，内部路径或验证规则变化只更新其所属契约（本文件或对应 `docs/contracts/`）；如果一个改动同时影响两者，应分别从各自读者的角度记录一次，不要整段复制。

判断一条信息该放哪里：读者需要据此操作或评估项目，放 README；只有改代码的人需要据此保证正确性（字段键名、模式裁剪、存储边界、定位规则、验证命令、故障根因），放 AGENTS。产物字段清单、快照保留策略、写回定位规则和内部故障处置都属于本文件及其领域契约，README 只描述用户可观察到的结果。

完整文档与工具登记见 [docs/contracts/documentation-tools.md](docs/contracts/documentation-tools.md)。当前实现概览归 `CURRENT_SYSTEM.md`，领域规范归 `docs/contracts/`；架构入口和模块 README 只导航，历史方案不得作为现行配置或实施依据。新增文档先确定独立职责，已有职责通过链接复用；新增工具登记调用入口、实现来源与副作用，兼容桥不得复制实现。

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
  | 翻译页面的 `public/workbench-client.js`、`workbench-style.css` 与翻译渲染/纯计算模块 | 「应用新布局」（或 `npm run layout`）→ F5 |
  | 说话人页面的 `public/speaker-workbench-*.js` / `*.css` | 重新生成说话人工作台 → F5 |
  | 跨工作台共享浏览器资源（`workbench-shared.js`、`workbench-diff.js`、`toast.css`、`workbench-dialog.css`、`ai-panel.css`） | 翻译页面：应用新布局 → F5；说话人页面：重新生成 → F5 |
  | 翻译 `ai/**`、`src/ai/**`、`src/runtime/**`、`src/storage/**`、`src/core/{atomic-fs,storage-layout,progress}.js` | 重启控制台服务（`start-setup.bat` / `npm run setup`）；若同时改变页面注入的规则，另按所属工作台重新渲染或生成 |
  | `src/workbenches/speaker-attribution/**` | 重启服务 + 重新生成说话人工作台；其输出不在翻译项目快照中 |
  | 仅由翻译生成子进程读取的正文提取代码、`align_jp.py`，或行集/签名算法 | 重新生成（控制台「开始生成」，或 `npm run align:jp && npm run build`） |
  | 由常驻服务导入的 `src/ingest/**`（输入登记、EPUB 容器、写回等） | 重启服务；若还改变正文提取/派生行，再重新生成受影响工作台 |

  路径不能代替调用链：共享模块同时被子进程与常驻服务使用时，两种生效操作分别必要；签名或行数据变化不能靠应用布局修复。

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
- 简中文本来自 `index-X` 版本化的解压归档 `EPUB/`，或由它的 `tools/package_cache_epubs.py` 打包出的 `output/epubs/*.epub`（目录与文件名形如 `[S1_01]某魔法的禁书目录 01X`）。`output/` 是构建产物目录，不存在时按 `EPUB/` 取用。
- 日文原文来自 `index-X` 的对齐工作源 `.cache/epub-work/japanese-text/`（或同步镜像）。它是 `bw_preprocess.py` 的**预处理产物**：只保留特殊注音（当て字、外来语），普通读音已被合并丢弃。因此「原文没写某标记」不等于「原版没有」，判注音、傍点、引号一类标记时必须按缺失证据处理，不得反过来当作译文多写的依据。
- 台版文本作为同级的非原文对照材料，来自独立的台版出版物。

index-X 结构与命名规范契约（正文规范以 index-X 的 `AGENTS.md` 为唯一来源，此处只列本项目依赖的部分）：
- 作品编号：`S0`（阅读说明等非正文内容）、`S1`（旧约）、`S2`（新约，含 `S2_22r`）、`S3`（创约）、`S4`（某暗部的少女共栖）、`S5`（外典）、`S6`（日期短篇）。SS、SP 也占用顺序号，编号不一定等于原作单行本卷号。
- `S5_AA_BB` 中 `AA` 是日文外典书库卷号、`BB` 是该合订卷内的独立作品号，中间缺号必须保留、不得重排；`S6_YY.MM.DD` 里点分隔的日期整体是一个作品标识，不是卷号或多级后缀。
- 正文文档命名：`<表头>_<语义后缀>.xhtml`，内容序从 `-01` 开始（`-00` 是非法内容序）。表头是中日配对的稳定内容标识（`S1_03-05`、`S5_01_03-02`、`S6_24.06.07-02`，SP 等用稳定名称如 `S1_25-Uiharu_Kazari`）；`_p-004`、`_Chapter2`、`_Afterwords` 之类是页码、章节语义或语言侧包装后缀，不属于表头。配对与排序必须用表头内容序，不得用 `ChapterN` 反推顺序，也不得用只能识别两段数字的正则匹配外典表头。
- 章节结构：序章（`Prologue`）之前的内容聚合为内容序 `01` 的 `Before_the_Prologue`（引子）；后记（`Afterwords`）之后**紧接的连续正文文本页**聚合为 `After_the_Epilogue`（尾声）。后记之后一旦遇到非正文页（纯插图页、封底、著者介绍或版权页），即从该页起进入书末附录，其后的页不并入尾声、也不分配内容序。
- 准入与边界：`Afterwords`（后记/あとがき）不进入翻译比较与说话人推断；紧接后记的 `After_the_Epilogue`（尾声）属于正文故事叙述，必须进入比较与推断。附录、版权页、介绍页为硬性截止边界。
- 格式契约：中日两侧带正文的 XHTML 套用统一固定行模板（L1-L6，正文首行 `<p>` 永远在第 6 行）；无 h1/h2 时用**空行**占位，中文列表型包装页允许 `<ul>`/`<ol>` 开标签占 L5。标题块独占一个物理行，多层标题重建为 `heading-lines` 的行内 span；支持 `<ruby>` 注音与 `<a epub:type="noteref"><sup>㊟</sup></a>` 译注标记。正文区以顶层块为行对齐原子：一条物理行只承载一个同级正文块。标题与 NCX/nav 不进入正文段落，因此不参与翻译比较；上游规范「标题原本是英文的不得汉化」也就不在 AI 校对层生效，由上游的结构门禁与人工保证。

翻译规范来源与同步义务：
AI 校对判「译文该写成什么样」的规范正文**不在本仓库**，而在 index-X 的 `docs/`：
- `translation-spec.md`：成品层的翻译与语言规范正文（标点与字形、成对标记与句末点号、注音与译注、语气词与拟声词、语义、译名、证据边界），判定译文是否合规以它为准；`tools/check_translation_spec.py` 的 `P1`–`P16` 是同一规范的机器检查实现。
- `translation-name-selection-spec.md`：译名在多个候选之间如何取舍（从俗 → 从官 → 自拟，以及外国人名与专名的原语还原、防日语中转）。
- `translation-name-rulings.md`：已生效译名裁定的总表，动任何译名前先查它。
- `x-translation-differences.md`：X 版与灰机 Wiki 译名表的人为固有差异，属取舍而非缺陷，不得按表回改。

`src/workbenches/translation-compare/ai/profiles/novel.js`（通用成品规范）与 `demo.js`（作品取值）是**同一规范在 AI 校对层的实现**，也是上游声明的「规范正文 → 机器检查 → AI 档案」三处同步中的一处：上游改动规范后必须同步这里的提示词条目，这里补条目时也要回头校准 `translation-spec.md` §七 的「AI 档案」列。三处口径不一致时以上游规范正文为准。条目、触发特征与成本预算见 `docs/contracts/ai-proofread-contract.md`。

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
   - 页面、备注恢复与客户端状态细则及定向测试见 [工作台与备注契约](docs/contracts/workbench-notes-spaces.md)。

7. `src/core/storage-layout.js`、`src/storage/project-store.js`、`src/runtime/generation-pipeline.js`
   - 将运行时输入、隔离 staging 和不可变项目快照划分到不同目录。
   - 控制台生成成功后以目录 rename 发布快照，再原子更新 `out/active-project.json`。
   - 项目切换只更新活动指针和小型输入选择，不复制大型生成物。
   - 发布后默认保留最新两个快照，并额外保护当前活动快照；活动快照不能因清理历史而被删除。
   - `out/projects/<projectKey>/snapshots/<snapshotId>/` 是已发布生成物的唯一事实来源。
   - `rebuildProjectHtml` 不得原地覆盖已发布快照：必须复制到 staging、重新渲染后发布新快照并切换活动指针。
   - `active-project.json` 原子写失败时保留旧副本。服务端入口校验 Host/Origin/Sec-Fetch-Site 与 CSRF token。

8. `src/ingest/line-units.js`、`src/workbenches/`、`src/ai/`
   - 完整段落是共享稳定源索引；派生句子/完整发话必须带 `parentParagraphId`，不得替换段落索引。
   - 两个工作台独立持有结果模型、缓存与备注空间；共享传输与纯能力规则不得引入领域结果字段。
   - AI 提示词、输出门禁、阶段编排与异常状态细则及验证见 [AI 校对契约](docs/contracts/ai-proofread-contract.md)。

9. `src/workbenches/speaker-attribution/`
   - `speaker-selection.js` 支持单语 `--source` 和双语 `--source` + `--parallel` 输入。
   - 双语 TXT/文档模式使用 `prealign.js` 的整篇单调预对齐；双 EPUB 模式先按 XHTML 文件名完整表头分段再预对齐。
   - `build-workbench.js` 只生成说话人专属产物，不复用翻译比较的 rows 或 notes；双语对比以原文为准入边界。
   - 持久化的 `alignment` 只保留摘要，预对齐中间行不落盘。
   - `attention.js` 为确定性证据注意力层，按邻近度、动作词、疑似称谓和对齐信号压缩 prompt 输入。完整发话与生产预对齐边界见 [模块边界](docs/contracts/module-boundaries.md#说话人工作台边界)。

## 文件归属与扩展规则

共享层、工作台、浏览器资源与兼容入口的所有权和依赖方向统一维护在 [模块边界](docs/contracts/module-boundaries.md)。共享能力变更必须检查全部工作台调用方；具体格式转换与正文准入分别扩展对应 ingest 模块。

## 领域契约入口

下表是细则的唯一维护位置。本文件保留跨工作台不变量与修改纪律，各领域的字段、算法、状态转换和定向验证命令不再复制维护。

| 领域 | 契约与验证入口 |
|---|---|
| 控制台、共享模块、翻译构建依赖方向 | [模块边界](docs/contracts/module-boundaries.md) |
| AI 提示词、门禁、共享传输、阶段编排、最新备注状态与异常生命周期 | [AI 校对契约](docs/contracts/ai-proofread-contract.md) |
| 备注恢复、预设、Toast、布局缓存、客户端展示与并发策略 | [工作台与备注契约](docs/contracts/workbench-notes-spaces.md) |
| 故障定位与历史回归证据 | [排查手册](docs/contracts/troubleshooting.md) |
| 文档职责、工具输入/副作用、兼容入口与结构覆盖验证 | [文档与工具覆盖](docs/contracts/documentation-tools.md) |

`public/` 共享资源必须核对两个构建器并运行 `npm test`。纯模块不得反向加载构建入口或任务运行状态；客户端不得复制服务端已有的错误分类、模型能力或最新备注判定。

## 正文过滤原则

- 正文的起点和终点必须通过结构性标记确定（如 Heading、特定标签或语义标记）。
- 禁止使用基于字数、行数或纯文本正则猜测整书的正文起始位置。
- 正文起点是「最近一次结构性边界（简介范围、章节标题、媒体占位）之后的第一个非前置块」；`isLikelyBodyBlock` 一类正文判定只用于确认「已经进入正文」，不得反过来决定起点位置，否则被判为弱块的开篇段落会被整段丢弃。
- 特典、插画页、版权页、出版信息、目录页必须明确排除在比较范围之外。
- `src/ingest/text-utils.js` 统一管理章节探测（`chapterPatterns`）和边界裁剪逻辑。
- 过滤逻辑修改后必须运行基准测试以确保行索引稳定性。

## 对齐标签

- 对齐质量标签必须来自算法打分或规则推断，严禁人工硬编码。
- Python 跨语言对齐归 `align_jp.py`，非原文对齐与行组装归 `row-alignment.js`，展示标签归 `row-output.js`；职责与对应验证见 [模块边界](docs/contracts/module-boundaries.md)。
- 分数或阈值变化时必须检查跨层口径，并保持旧快照的标签显示兼容。

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

所有改动在提交前运行 `git diff --check`。文档、工具入口或 npm 命令变更还必须运行 `npm run check:docs`；它只验证登记、路径、链接与命令覆盖，不能证明行为或文字语义正确。

代码修改按 [领域契约入口](#领域契约入口) 运行定向测试；共享资源、模块边界、客户端/AI 调度改动必须运行 `npm test`。`scripts/*.test.js` 是自动发现入口，不在多份文档维护全量测试文件清单。

涉及输入格式、正文过滤、标题探测、段落切分或对齐时，除相关测试外必须对本机样本执行 `npm run align:jp && npm run build`，说话人受影响时另重新生成。验证：原文段落与表格行严格 1:1、空原文与异常行数被处理、长原文未复用、媒体占位/后记/附录未进入正文；双语产物 `bilingualLeakage` 为 `false`，`counts` / `rowKeys` 不出现第三列字段。

## 常见故障定位

故障现象、证据入口、历史根因与处置只维护在 [排查手册](docs/contracts/troubleshooting.md)。修改现行规则时同时校准对应故障条目，不把旧实现描述当作当前实现。

## 限制与客户端约束

公开支持范围与限制归 [README.md](README.md)。行内编辑器缓存、批量量高、可用高度计算和审核轨迹会话状态归 [工作台与备注契约](docs/contracts/workbench-notes-spaces.md)，不在此重复实现细节。

## Agent skills

### Issue tracker

Issue 与 spec 以 GitHub issue 形式记录在本仓库（`gh` CLI）。见 `docs/agents/issue-tracker.md`。

### Triage labels

沿用五个默认 triage 标签：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。见 `docs/agents/triage-labels.md`。

### Domain docs

单上下文布局：仓库根一个 `CONTEXT.md` + `docs/adr/`。见 `docs/agents/domain.md`。
