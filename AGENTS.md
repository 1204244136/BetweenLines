# AGENTS.md

本文档面向在 BetweenLines 仓库中读代码、改代码和运行验证的编码代理与维护者。当前翻译比较工作台称为 TransComparator。

## 文档职责

`README.md` 是对外文档，面向使用者、协作者和首次运行项目的人，说明产品意义、当前工作台、环境安装、命令和输出位置。它不规定内部实现，也不替代本文件的验证清单。

`AGENTS.md` 是仓库内的实现契约，面向需要修改代码的 agent 和维护者，规定模块归属、数据不变量、生成物边界、修改纪律和验证方式。它不是用户手册；用户操作说明、功能介绍和公开限制应写在 `README.md`。

两份文档都描述同一个项目，但职责不同：公共行为变化需要同步更新 README，内部路径或验证规则变化只更新 AGENTS；如果一个改动同时影响两者，应分别从各自读者的角度记录一次，不要整段复制。

判断一条信息该放哪里：读者需要据此操作或评估项目，放 README；只有改代码的人需要据此保证正确性（字段键名、模式裁剪、存储边界、定位规则、验证命令、故障根因），放 AGENTS。产物字段清单、快照保留策略、写回定位规则和内部故障处置都属于后者，README 只描述用户可观察到的结果。

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

- 原文段落不可拆分。原文只能以完整段落为单位参与 `1:1`、`1:2`、`2:1`、`2:2` 或更大合并组。
- 非原文段落可以为对齐、diff 和展示进行拆分或合并。
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
   - `src/ingest/input-selection.js` 的 `validateSelection` 只保留该模式的列：双语模式的 `files`/`labels`/`startMarkers` 里不出现 `tw` 键（不是空串、不是默认标签）。
   - `src/ingest/text-utils.js` 的 `loadParagraphs` 双语模式只返回 `cn`/`jp`，不写空 `tw` 数组；控制台也只按 `activeLangs()` 打印段落计数。
   - 被 `npm run align:jp` 自动调用。

5. `src/workbenches/translation-compare/align_jp.py`（`scripts/align_jp.py` 为兼容 CLI 入口）
   - 使用 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 做跨语言语义对齐。
   - 当 `torch.cuda.is_available()` 为 true 时使用 CUDA/ROCm 暴露的加速后端，否则使用 CPU，除非 accelerator guard 阻止。
   - 写入当前构建目录的 `jp-align.json`，其中 `groups` 是唯一对齐数据；组内区间只用 `pivotStart`/`pivotEnd` 命名（不再有 `tw*` 别名，也不再写无消费方的段落级 `mapping`）。
   - 双语模式 pivot 固定为 `cn`，日志按模式称呼该列（译文 / 非原文）。

6. `src/workbenches/translation-compare/build-compare.js`
   - 三语模式对齐两份非原文文本；双语模式不做该步，直接把主文本段落作为技术 pivot 单元。
   - 读取跨语言 `groups`（`pivotStart`/`pivotEnd`，兼容旧快照的 `twStart`/`twEnd`）。
   - 按技术 pivot interval 合并不同方向的对齐组。
   - 行字段、`counts`、CSV 列、页面标签和内嵌行数据都由 `rowFieldsFor(mode)` 决定：双语行不携带 `tw`/`twCn`/`twChars`/`refinedScore`，页面也不渲染不属于该模式的控件（不是 `hidden`）。裁剪只删字段，不改变 `signature`/`rowsSignature` 的取值。
   - 输出 HTML、CSV、JSON。
   - 生成页面的控制栈是五个 `<details class="panel-details">` 抽屉：预筛选、AI 辅助校对、筛选与显示、批量操作、备注空间与找回；按数据流方向自上而下排列（机器加工→人工检索→批量落盘→数据保全）。每个抽屉的 `<summary>` 含 `.panel-summary-state` 摘要行展示实时状态。`筛选与显示` 收纳原 filter-bar 与显示开关；`批量操作` 只放会改源文件的批量按钮。默认全部折叠（不带 `open` 属性），避免机器任务被覆盖式展开。`rowFieldsFor(mode)` 等模式裁剪规则不受重排影响。
   - 这五个抽屉统一放在父抽屉 `#controlStackPanel`（`.panel-group`，带 `data-panel-group`）的 `.panel-group-body` 内，用于整组折叠/展开；父抽屉默认带 `open`，不改变子抽屉的默认折叠状态。父摘要的 `[data-panel-group-state]` 由客户端 `bindPanelGroups()` 按组内 `details.panel-details` 的展开数同步（`toggle` 事件不冒泡，必须在捕获阶段监听）。`notesRecoveryDialog` 与其它非面板节点留在父抽屉之外。新增或移动面板时保持这一层级，客户端状态同步依赖 `details.panel-details` 后代查询。
   - `notes-spaces.js` 为翻译备注的纯函数辅助模块，注入生成页面并由 Node 测试复用；备注空间键与行内容签名保持原契约。备份保留原始数据，导入同名空间只创建副本；找回保留当前行已有记录，不能通过释放来源空间应对配额不足。
   - `recoveredUnverified` 记录不能携带当前行的 `rowSig` 或计入人工确认；文本锚点与按行号找回都必须保持此标记，只有逐行核验可解除。页面必须提供清空当前空间和清空历史空间的显式操作，均需确认且不能误删另一类空间。验证执行 `node --test scripts/notes-spaces.test.js scripts/build-compare.test.js`，其中使用生成页面的 VM 交互回归，不使用浏览器截图。

7. `src/core/storage-layout.js`、`src/storage/project-store.js`、`src/runtime/generation-pipeline.js`
   - 将运行时输入、隔离 staging 和不可变项目快照划分到不同目录。
   - 控制台生成成功后以目录 rename 发布快照，再原子更新 `out/active-project.json`。
   - 项目切换只更新活动指针和小型输入选择，不复制大型生成物。
   - `out/projects/<projectKey>/snapshots/<snapshotId>/` 是已发布生成物的唯一事实来源。

8. `src/ingest/line-units.js`、`src/workbenches/`
   - 完整段落是共享的稳定源索引。
   - 句子/对话行只能作为带 `parentParagraphId` 和源文本偏移的派生单元。
   - 说话人归属的待判断行只抽取完整的 `「…」`、`『…』` 发话；不得按引号内部的句末标点拆行。叙述句仅用于上下文，不得生成说话人判断行。
   - 翻译比较与说话人推断必须使用独立的工作台数据模型、结果和备注空间。
   - `src/workbenches/translation-compare/ai/` 的预筛选、提示词和校对结果属于翻译工作台；未来共享 AI 传输能力放在 `src/ai/`，不要反向污染领域模型。
   - 模式契约按 `proofread-contract.js` 的 `modeSchemas` 裁剪：双语对外只用 `decision=keep|replace|unclear` 表达结论、不出现 `better`/`counterpart`，三语保留 `better=target|counterpart|neither|unclear`；解析层把 `keep`/`replace` 归一为内部 `target`/`neither`，双语下 `counterpart` 也归一到 `neither`，旧提示词里的 `better` 必须继续可用。
   - 提示词分两层并在组装时合并注入：通用侧（`proofread-contract.js` 的 `sharedInstructions`、模式契约、schema，标 `【通用校对规则】`）只放与作品无关的任务契约；特化侧是 `ai/profiles/` 下的可替换档案（每项 `{ id, name, summary, sections }`，标 `【成品校对规范：<name>】`），只放工作阶段规范（什么不算缺陷、什么才算缺陷、证据边界）。合并顺序固定为通用侧 → 当前模式 → 特化侧 → noteref 硬性约束 → 术语表 → JSON 输出约定。
   - 特化档案通过 `profiles/index.js` 注册（`listProfiles`/`resolveProfile`，未注册的 `profileId` 一律回落 `DEFAULT_PROFILE_ID`），可选值随配置 `profileId` 下发，界面「校对设置 → 特化规范」按注册表渲染并嵌每个档案的默认提示词。仓库内档案为 `profiles/novel.js`（与作品无关的通用规范）与 `profiles/demo.js`（作品专有档案，兼公开示范）；用户自己的档案走被忽略的 `profiles/local/*.js` 或环境变量 `TRANSCOMPARATOR_PROFILE_FILES` 指向的仓库外文件，加载失败只告警并跳过，不得让坏档案拖垮服务。
   - 本机档案要的是「某份既有档案 + 本机专有的名字/表/补充规则」，所以走**叠加**而不是再写一份：文件只写 `{ extends: "<既有 id>", ...差异字段 }`，注册表合并后**沿用基底 id**（`name`/`summary`/`speechHabitScope` 声明即覆盖，`sections` 按小节标题追加、同名小节替换，`termTables`/`speechTables` 与基底合并去重），于是下拉里不会出现两份逐字相同的档案，也不会因为选错而静默丢掉本机的表，基底改了规范本机副本自动跟上。`extends` 只能指向已注册的档案（含先加载的仓库外档案），指向不存在的 id 时只告警并跳过。不写 `extends` 时仍是「新档案」语义，此时与内置档案撞 id 才告警覆盖并提示改用 `extends`。叠加契约见 `scripts/ai-profile-overlay.test.js`，改 `applyOverlay` 前先跑它。
   - 档案 id 是稳定槽位：本机用 `extends` 叠加 `demo` 后它只是换了名字（如「某系列成品（本机档案）」），所以文档、脚本示例与测试一律按 id 引用档案，不要拿 name 去认定某条档案。
   - 作品相关的具体内容集中在 `profiles/demo.js` 一处（示范档案）与 `src/ingest/text-utils.js` 的正文边界清单；文档、测试与其它模块不必重复展开作品名，测试夹具优先使用中性人名（山田太郎/佐藤花子…）。
   - 特化侧不只放提示词，也可以声明**辅助判断数据**：档案的 `termTables`（译名对照表路径，本机路径只写在被忽略的 `profiles/local/` 或环境变量 `TRANSCOMPARATOR_TERM_TABLES`）。对照表由 `ai/term-table.js` 在确定性预处理阶段查表，分两条出口（`applyTermTable`，AI 校对与预筛选共用）：**只有整行有效内容本身就是术语**的行才直接出结果、不调用模型；句中还有术语之外的内容时，一致性只覆盖术语、证明不了整句翻译没问题，这些行照常交给模型，对照表按行**作为提示词注入**（`termGuidanceFor` → `termBlock` → `buildProofreadSystemPrompt` 的 `termBlock` 参数，用户载荷里同步给 `terms` 字段），与 `glossaryFile` 的整卷术语表是两回事。
   - 表里原文列的 `【】` 只是**给注音标记位置**（注音按逗号顺序加进各个方括号里的文本），正文与成品里几乎不出现方括号：匹配与展示一律用去括号的 `plainSource`/`plainTarget`（`displayTermPair`），带括号的写法不作为别名，否则「原文里带方括号才命中」和备注里显示「【山田】【太郎】」都是错的。`ruby_ori` 的逗号分段与原文的方括号分段**按顺序一一对应**，不能把各段读音当成互相独立的别名（那会把「太郎」的读音挂到别的名字上）。
   - 跳过模型的判定由 `measureTermCoverage`（`ai/term-table.js`）给出：把命中的术语别名（长别名优先、互不重叠，**不含分段别名**）从原文划掉，剩下的有效字符（既非空白也非标点符号）不超过 `TERM_ONLY_FREE_CHARS` 且占比不超过 `TERM_ONLY_FREE_RATIO` 才算「整行只有术语」；`evaluateTermRow` 据此返回 `kind: "term-only"`（可跳过）或 `"consistent"`（必须交给模型），`coverage` 随结果带出便于审计。覆盖率只按“整条术语/整串读音”算，所以「术语 + 大量正文」的行永远不会被判成 term-only（实测整卷 3119 行：命中 669 行、一致 629 行，其中只有 17 行是纯术语行、612 行需注入后交模型，另有 40 行冲突）。
   - 对照表判定的保守规则（改动前先看 `scripts/term-table.test.js`）：只有 3 字及以上的基文别名可以判“译名不一致”（strong）；2 字词、读音别名、分段别名只能确认一致，不能指控译名错误；译文已使用译名（含只写姓或名的分段写法、括号与字形差异）判一致；命中其他译法/英文写法/字形差异时只给“替换术语”的最小修改；定位不到可替换旧译名时不编造 `revisedText`，转人工确认；一行若没有任何确认一致或强证据不一致，就不由对照表处理，继续走 AI。匹配前必须剥掉内联标记与 `<rt>` 注音内容，片假名别名不得落在更长片假名词内部。
   - **分段命中（只写姓或名）与读音命中各有口径，别混用**：分段别名能“确认一致”（译名判定里的 `via=part`），但**不能反过来证明本行用的是这个整条术语**——同姓的其他角色都会被它命中（实测单独一个「御坂」能带出御坂美琴、御坂美鈴、御坂旅挂三条）。因此：判定上只有 `scope !== "part"` 的一致才算确认（只命中分段的行交回后续流程）；覆盖率也不把分段别名计入（否则「「御坂……？」」这种只出现姓的行会被判成“整行只有术语”而跳过模型）。整条术语与整串读音的别名照旧参与两者。
   - 「本行用到了哪些术语」由 `hitsUsedInRow`（`ai/term-prefilter.js`）唯一判定，**注入给模型的与页面显示的必须是同一批**：只认 `scope === "term"`，以及 `scope === "ruby"` 且译名一致（原文写读音、译文确实用了该译名）；分段命中一律不算，且要用 `markUsedTermAliases(..., { includeParts: false })` 判断别名是否真的被占用（同一姓氏下靠共用读音集体命中的条目要挡掉）。改这个函数等于同时改提示词与页面芯片，先跑 `scripts/term-table.test.js` 与 `scripts/term-layer.test.js`。
   - 对照表结果用备注标记 `[对照表]`（与 `[AI校对]`/`[规则预筛]`/`[相似度预筛]` 同级，客户端 `automatedNoteMarkers`、`prefilterResultKind`、徽标与统计都要同步），`status` 用 `term-prefilter`（纯术语行、done）或 `suggestion`（需确认）；`makeTermResult` 只接受这两种结论，收到 `consistent` 直接报错（那一行不该由对照表出结论）。计数走 `status.termPrefiltered`（跳过模型的行）/`termConflicts`/`termInjected`（注入术语后仍交给模型的行）/`termTables`，不要另开数据通道。
   - 界面上要能看到对照表是否生效：`clientStatus()` 返回 `termTableStatus`（`{files, sheets, entries, errors}`，按 `<profileId>` 解析档案 + 环境变量声明，走 `loadTermTablesCached` 的 mtime 缓存，不写日志）；状态接口接受 `profileId` 查询参数，客户端「校对设置 → 特化规范」下方的 `#aiTermTableHint` 按 `entries`/`errors` 显示“未声明 / N 条术语 / 加载失败”，并追加构建期预筛数字。路径必须先经 `normalizeTermTablePaths` 归一（相对路径、重复分隔符、大小写差异只算一张表），否则同一张表会被重复加载。
   - 对照表层的**分工**（`term-layer.js`）与说话习惯层不同，原因是它产出的是**行级结果**而不是提示词上下文：结果（备注文本、`status`、跳过模型的依据）必须由运行期生成——它要带当次任务的标签、目标列与「已人工确认」过滤，构建期不能替用户写备注空间。但「哪些行会被命中、命中是一致还是冲突、哪些行整行只有术语」只依赖「整卷行数据 + 对照表」，与模型无关，因此**构建期算一次并落盘**到 `translation-compare.json` 顶层 `termPrefilter`，同时嵌进 `pageMeta.termPrefilter`：页面在跑任务之前就能标出「术语需改」「纯术语（跳过模型）」「术语注入（仍交模型）」三类行并给出预筛数字，离线脚本与 AI 拿同一份结论对照。块同样写在行数据之外，不得给行加字段。
   - 落盘块结构：`{ version, generatedAt, byProfile: { <profileId>: { files, fingerprint, entries, defaultVariant, variants: { "<mode>:<targetKey>": { proofreadMode, targetKey, hits, consistent[], termOnly[], injected[], conflicts[], terms{ <rowIndex>: string[] }, chapters[{chapter,hits}], summary } }, summary } }, errors[] }`。`consistent` 是「译名一致」的合并集合（页面徽标按它渲染），`termOnly`/`injected` 是其中「跳过模型」与「注入术语后仍交模型」的两半；`terms` 是行号 → 本行**用到的**术语对（去方括号的 `displayTermPair`，经 `hitsUsedInRow` 过滤、每行最多 `TERMS_PER_ROW_CAP` 条），页面用它显示「本行命中了哪些术语」——它只由「原文 + 对照表」决定，与模型无关，所以可以随页面下发（行文本与备注仍不进产物，实测整卷 669 行约 19 KB）；判定与「校对模式 + 目标列」绑定，构建期按项目模式把该模式可能用到的变体都算好（双语只有 `bilingual:cn`，三语是 `trilingual:cn` 与 `trilingual:tw`），运行期无论用户选哪一列都能命中同一份结论。`files` 经 `tableFileNames()` 只留**文件名**（快照与页面都可能被分享，本机完整路径不进产物），完整路径只出现在运行期状态接口与日志里。
   - 运行期不重复「复用判定」而是做**交叉校验**：`applyTermTable` 仍逐行判定（实测整卷 3119 行约 190ms，且结果必须带当次标签），算完用 `termLayerFor` 取构建期结论比对**命中行集合与跳过模型的行集合**（注入行与冲突行都算命中），一致就 `pushLog`「与构建期预筛一致」，指纹过期就提示对照表被改过、需重新构建工作台，集合不一致则如实报告分叉（页面徽标可能过期；旧版本生成的快照会在这里报「跳过模型的行集合不同」）。判定函数是唯一的，两条路径不一致只可能是表改了或页面过期。
   - 「译名一致」的行不需要任何操作却常命中多条术语，备注按**分组摘要**写（`formatTermHitGroups`：按证据类型分组列出 `原文→译名（类型）`，原文与译名都用去方括号的 `displayTermPair`），冲突行保留逐条 `describeTermHit` 说明（要指出该改哪一处）。分组只压缩措辞、不丢信息，改前先看 `scripts/term-table.test.js` 的备注断言。
   - 指纹口径由 `src/core/table-fingerprint.js` 统一提供（`<版本>|文件名:mtime:size#条目数`，多张表以 `|` 连接），说话习惯层与对照表层共用，避免两处口径漂移；文件名只取 basename，完整本机路径不进产物。
   - 说话习惯层的**分工**（`speech-habit-layer.js`）：章级判定（本章命中哪些角色、哪些行疑似特色流失）与模型无关，因此**构建期算一次并落盘**到 `translation-compare.json` 的顶层 `speechHabits` 块，同时嵌进 `pageMeta.speechHabits` 供页面显示概览与「特色流失」行标记；运行期（AI 校对）优先复用该块，指纹过期才回退现算。块必须写在**行数据之外**（顶层 + 按章引用），不得给行加字段：行已带显式 `signature`，但保持"只加顶层结构"这条纪律可以避免任何签名/写回定位风险。
   - 落盘块结构：`{ version, generatedAt, byProfile: { <profileId>: { files, fingerprint, entries, volume, scope, characterRecords[], chapters[{chapter,rowCount,indexRange,characters[{ref,character,activated,detectedBy,strongRows,weakRows}],misses[{index,items}]}], volumeCharacters[], missIndexes[], summary } } }`。角色条目按「条目签名」索引（同一角色可能有多条习惯，如「力」与「ダゾ」），章级只存 `ref` 下标；运行期用 `characterDescriptor(item, records)` 还原出与现算完全一致的 `versions{x,net,tw}` 与 `memo`，再交给 `chapterHabitBlock`/`volumeHabitBlock` 拼块——**两条路径产出的提示词必须逐字相同**（`scripts/speech-habit-layer.test.js` 有等价性断言，改任一侧都要先跑它）。
   - 指纹由 `speechTablesFingerprint(files)` 生成（`LAYER_VERSION|文件名:mtime:size#条目数`，多张表以 `|` 连接）：不一致时运行期重算并 `pushLog` 提示重新构建工作台；脚本 `scripts/speech-habit.js` 默认消费落盘结果（与页面/AI 同源），`--live` 才现算。
   - 两个层的**运行期指纹口径**（`termLayerFor` / `speechHabitLayerFor`）：落盘块只有文件名，指纹要 stat 真实文件，所以运行期必须**重新解析「当前用哪些表」**——调用方传本次实际加载的表路径（`config.termTables` / `config.speechTables` / 脚本的 `loaded.files`），不传时按 `tableFilesForProfile(resolveProfile(profileId), ...)` 解析（与构建期 `tableSourceCandidates` 同一实现、同一归一化顺序，含环境变量）。解析不出表时 `stale: true`、`currentFingerprint: ""`——**宁可判过期也不静默复用旧结论**；条目数取落盘的 `entry.entries`，避免为了校验指纹而重新解析整张表。新增调用点必须传表路径，并跑 `scripts/term-layer.test.js` / `scripts/speech-habit-layer.test.js`（都有「未传 files → stale」断言）。
   - 行级只有两种情况要处理：本行原文命中说话习惯特征时，注入 `【说话人判断（本章）】` 段并要求模型先判断说话人（结果填 `speaker` 字段、写进备注的「说话人：」行），确认是候选角色才按他的习惯判断；原文有口癖而译文没体现时，判为说话特色流失并给最小补回。补回检测只在类型可靠（`DETECTABLE_TYPES`）且位置正确（句末语气词/谓语形式必须落在句末，其他类型前面不能是假名）时提示，单字口癖与中译同形的条目不参与。
   - 说话习惯段与说话人判断段都是按章/按行动态生成的：`stripSpeechHabitBlock` 会反复剥掉自定义提示词里的旧段（`【说话习惯（`、`【说话人判断（` 前缀），与档案正文里提到的「【说话习惯】」不冲突；任何路径都不得出现两段习惯规则或两段说话人判断。
   - 对齐产物可用 index-X 缓存的日文原文校验（`verify-source.js`，`scripts/speech-habit.js --verify-source`）：卷目录与正文文件、章节结构标记（中日章名是翻译关系，只对比「序章/行间N/第N章/终章」这类标记，`chapterMarkerKey`）、角色口癖在原文与快照 `jp` 列的出现次数（`countInSource` 只在简繁写法不同时才各数一次，避免重复计数）。正文 XHTML 可能在包根、`item/` 或 `item/xhtml/` 下，三种布局都要支持；目录缺省按同级 `../index-X` 探测，可用 `INDEX_X_DIR` 覆盖。
   - 表格读取统一走 `src/core/spreadsheet.js`（xlsx/csv/tsv/json，纯 Node、无外部命令）：xlsx 必须按单元格引用 `r="D2"` 定位列，xlsx 会省略空单元格，按出现顺序取值会让稀疏行错位。术语表、说话习惯表与术语表加载都复用同一读取器。
   - 组装（`buildProofreadSystemPrompt`）必须先剥离自定义提示词里已有的 JSON 约定行（`stripJsonContract`，按行剥离以免删掉用户写在后面的补充规则）、noteref 硬性约束行（`stripNoterefConstraint`）与上一次的特化档案块（`stripProfileBlock`，从 `【成品校对规范：` 到下一个顶层小节或硬性约束为止），再统一追加一次，任何路径都不得出现两份 JSON 约定、两份硬性约束或两套档案规范。
   - AI 校对的重试与终局：模型返回 `needsContext`/`unclear` 时按轮补充相邻行；对齐片段行（原文或译文以续接标点 `、，,：；` 结尾，或结尾本身是接续词）直接终局为待人工确认，不再扩展上下文——行边界属于对齐问题，补上下文解决不了它，也不得据此判定翻译缺陷。

9. `src/workbenches/speaker-attribution/`
   - `speaker-selection.js` 支持单语 `--source` 和双语 `--source` + `--parallel` 输入。
   - 双语 TXT/文档模式使用 `prealign.js` 的整篇单调预对齐；双 EPUB 模式必须先按 XHTML 文件名中的完整稳定表头分段，再在同表头正文块内运行 `prealign.js`。没有共同表头时才允许整篇 fallback；未匹配行必须保留并标记状态。
   - `build-workbench.js` 只生成说话人专属 JSON/HTML 和浏览器本地确认空间，不复用翻译比较的 rows 或 notes；双语对比时以原文为准入边界，无原文行的主文本发话（`source: null`）直接剔除，不进入工作台行与归属确认流程。
   - 持久化的 `alignment` 只保留摘要（版本、计数、`headerAnchors`）；预对齐中间 `rows` 不落盘——每行的 source/parallel/comparison 已经在 `rows` 里带上下文保存一次，重复保存会让工作台 JSON 成倍膨胀。裁剪不得改变 `analysisKey`，否则浏览器确认结果会失去对应关系。
   - 单语模式不生成 `parallel`/`parallelText`/`comparison` 行字段、`parallel*Count` 统计与 `files.parallel`，页面也不渲染"主文本对照"开关和对齐版本概览；双语模式保留全部对照证据。
   - `attention.js` 是说话人专属的确定性证据注意力层：上下文必须保留完整引号发话，只对引号外叙述做句子切分；按邻近度、说话动作词、疑似称谓和对齐信号压缩 prompt 输入。注意力权重是排序依据，不得当作模型事实；候选不足时必须允许 `unknown` / `needsContext`。

## 文件归属与扩展规则

- `src/core/`、`src/storage/`、`src/ingest/`：共享能力。修改时必须检查所有工作台和项目快照调用方。
- `src/workbenches/<name>/`：领域工作台。工作台拥有自己的结果模型、构建器、提示词、缓存和备注空间，不得复用另一工作台的 rows 或 notes 作为数据模型。
- `src/ai/`：未来可复用的 AI 传输、队列、取消和缓存原语；翻译专属逻辑留在 `src/workbenches/translation-compare/ai/`。
- `src/runtime/`：本地服务和生成编排，只负责连接输入、共享能力和工作台，不在这里堆积领域判断。
- `scripts/`：命令行、Python/PowerShell 工具和旧路径兼容入口。兼容入口只转发，不复制业务实现。
- `public/`：浏览器资源。不要把服务端存储、对齐或 AI 领域逻辑移入前端文件。

README 中的目录树用于帮助外部读者建立概念；本节才是新增或移动实现时的路径依据。

## 正文过滤原则

Pandoc 会忠实输出完整 linear text；过滤职责属于共享 ingest 层，当前实现位于 TransComparator 使用的 `src/ingest/`。

正文过滤应优先使用块级边界，而不是全文关键词扫描。正文中可能自然出现“版权”“特典”“图片”等词，不能因此截断。

常见应过滤内容：

- 后记、あとがき、後記。
- 特典、番外、电子书限定附录。
- 版权页、colophon、copyright、出版/发行信息。
- Pandoc 产生的媒体占位，例如 `[]`、`[图片]`、`[p051]`。
- 目录、封面、制作信息、译注等非正文块。

如果过滤规则不确定，宁可保留内容并让后续原文准入和 alignment 排除，也不要过早删除可能是真正文段的文本。

## 对齐标签

类似 `A-B 1:2 / C-B 2:2` 的标签含义：

- `A-B`：文本 A 到文本 B 的对齐。
- `C-B`：文本 C 到文本 B 的对齐。
- `1:2`：左侧 1 个段落对应右侧 2 个段落。
- `2:3` 等更大组表示相邻冲突被合并为稳定区间。

涉及原文时，任何组合都必须保留完整原文段落。

## 写回契约

写回实现位于 `src/ingest/writeback.js`，由 `src/runtime/input-server.js` 调用；它把工作台行文本或说话人标记写回输入选择登记的原文件。

- 目标类型只有四种常量：`text`、`html`、`epub-archive`、`epub-directory`，对应 TXT、XHTML/HTML、EPUB 文件和单本解压的 EPUB 目录。
- 定位方式按行文本匹配：纯文本段落直接替换；含内联标记的段落按块级元素（`p`/`h1-6`/`blockquote`/`li`/`dd`/`dt`）文本匹配后整段替换，替换文本中的 `ruby`/`rt`/`b`/`sup`/`a noteref` 等内联标记原样保留。
- 多段合并行按空行拆分后逐段写回，允许跨 XHTML 文档；定位失败的行必须留空不写，并在返回结果中单独报告，不得静默跳过或模糊匹配兜底。
- EPUB 写回重新打包时必须保持 `mimetype` 条目规范；写入使用本地原子写，避免半途失败留下损坏文件。
- 写回目标始终是登记的原始路径。遗留的浏览器上传导入副本（`out/runtime/imported-inputs/`）仍可读写，但返回结果必须如实标注目标类型是导入副本。

## 生成文件与重型文件

`.codegraph/` 是 CodeGraph 目录索引插件的本地索引依赖，不属于可清理生成物。不要删除、移动或重建该目录，除非用户明确要求重新生成 CodeGraph 索引。

`out/` 的存储边界：

- `runtime/` 只保存当前输入、浏览器导入文件和命令行临时工作目录。
- `.staging/` 只保存尚未发布的控制台生成任务。
- `projects/` 只保存不可变项目快照。
- 顶层只允许 `active-project.json` 指针，不要重新引入顶层 `paragraphs.json`、`jp-align.json` 或 `translation-compare.*`。
- 快照保留由 `pruneProjectSnapshots` 控制：每次发布新快照后按 `keep: 2` 清理旧快照，当前活动快照额外保留，即使不在最近两个之内。
- `out/runtime/imported-inputs/` 是早期浏览器上传导入副本的遗留位置，仍可读写；新的输入选择应登记本机原始路径，不要再新增该目录的用途。

除非用户明确要求，不要提交或复制：

- `.venv/`
- `node_modules/`
- `out/`
- `*.txt`、`*.epub`、`*.docx` 等源文本文件
- 下载的 model caches
- 本机安装脚本或临时环境文件

源文件路径应集中维护在 `src/ingest/text-utils.js`。公开发布前不要写入个人目录、绝对路径或其他隐私信息；作品相关的具体内容允许出现在示范档案 `profiles/demo.js` 与 `text-utils.js` 的正文边界清单里，但不要在其他位置重复展开。

## 修改纪律

- 优先使用确定性的本地 scripts，不要手工改 spreadsheet。
- 变更输入格式、正文过滤、heading detection 或段落切分后，必须重新运行导出和对齐。
- 修改 alignment 后，必须验证空原文、重复长原文和行数异常。
- 不要把技术 pivot 描述成主从关系。
- commit 信息应使用中文并遵守 Conventional Commits 风格。
- 不要使用破坏性 git 命令，除非用户明确要求。
- 如果工作树已有用户或其他 agent 的改动，必须保留并与之协作。
- 修改后不要进行浏览器截图验证，因为本地 Playwright 运行时缺少 `playwright-core`。

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

检查段落数量和末尾内容（按模式取列，双语快照没有 `tw` 键）：

```powershell
node -e "const fs=require('fs'); const {getActiveProject,resolveProjectArtifact}=require('./scripts/project-store'); const a=getActiveProject(); if(!a) throw Error('没有活动项目'); const p=JSON.parse(fs.readFileSync(resolveProjectArtifact(a.id,'paragraphs.json',{snapshotId:a.snapshotId}),'utf8')); const cols=['jp','cn','tw'].filter((l)=>Array.isArray(p[l])); console.log(JSON.stringify({mode:p.comparisonMode,cols,counts:Object.fromEntries(cols.map((l)=>[l,p[l].length])),last:Object.fromEntries(cols.map((l)=>[l,p[l].at(-1)?.text]))},null,2));"
```

检查最终行：

```powershell
node -e "const fs=require('fs'); const {getActiveProject,resolveProjectArtifact}=require('./scripts/project-store'); const a=getActiveProject(); if(!a) throw Error('没有活动项目'); const data=JSON.parse(fs.readFileSync(resolveProjectArtifact(a.id,'translation-compare.json',{snapshotId:a.snapshotId}),'utf8')); const map=new Map(); data.rows.forEach((r,i)=>{if([...r.jp].length>=18){if(!map.has(r.jp))map.set(r.jp,[]);map.get(r.jp).push(i+1)}}); const dup=[...map.entries()].filter(([,v])=>v.length>1).slice(0,5).map(([jp,rows])=>({rows,jp:jp.slice(0,80)})); const counts={}; for(const r of data.rows)counts[r.relation]=(counts[r.relation]||0)+1; const mode=data.project.comparisonMode; const thirdColumn=mode==="bilingual"&&data.rows.some((r)=>["tw","twCn","twChars","refinedScore"].some((k)=>k in r)); console.log(JSON.stringify({mode,rows:data.rows.length,counts:Object.keys(data.counts),rowKeys:Object.keys(data.rows[0]||{}),bilingualLeakage:thirdColumn,emptySource:data.rows.filter(r=>!r.jp).length,duplicateLongParagraphs:dup.length,relations:counts,dup},null,2));"
```

一般期望：

- 原文列不应大量为空。
- 同一长原文段落不应意外重复。
- Pandoc 媒体占位不应成为正文段落。
- 特典、后记、版权页不应进入最终比较。
- `bilingualLeakage` 必须为 `false`；双语快照的 `counts`/`rowKeys` 不应出现 `tw`、`twCn`、`twChars`、`refinedScore`。

## 常见故障定位

原文重复：检查是否重新引入了无 reuse tracking 的 fallback，或技术 pivot interval 合并是否漏掉重叠组。

原文为空：检查活动项目快照中的 `jp-align.json` 是否过期，或正文过滤是否改变了段落索引。

章节标题污染正文：补充 `chapterPatterns`，然后重新生成全部输出。

插图附近错位：先确认 `splitParagraphs` 是否过滤了 media-only blocks，再看 grouped moves 是否需要扩大或加局部重对齐。

Pandoc 输出混入非正文：优先调整转换后的块级正文边界规则，不要回退到按整篇文本关键词扫描。

双语产物出现第三列内容（`TW paragraphs: 0`、`counts.tw`、行里的 `tw`/`twCn`/`refinedScore`、页面上的"台版/参考文本"）：先确认活动快照是否由旧版本生成——模式裁剪只对新构建生效，重新运行 `npm run align:jp && npm run build` 即可；若重新生成后仍存在，检查是哪一层又把 `tw` 加了回来（`validateSelection`、`loadParagraphs`、`rowFieldsFor`/`exportRows`、`makeHtml` 的 `pageLabels`）。

输出混入后记、特典或版权页：调整 `src/ingest/text-utils.js` 的正文结束规则，然后重新运行 `npm run align:jp && npm run build`。

对齐发生连锁错位：检查快照中的 `paragraphs.json` 是否混入图片占位、页码、脚注或元信息，再重新运行对齐与构建。

写回定位失败或写错位置：先确认目标类型是否被正确识别（四种 `TARGET_*` 之一），再检查原文件块的文本是否与行文本一致；含内联标记的段落必须走块级匹配路径，不能回退到朴素字符串替换。定位失败的行不得写入。

## 当前限制

- UI 是静态 HTML table，使用客户端分页切片（翻译比较默认 100 行/页，说话人默认 50 行/页），行数据仍随页面整体内嵌；未实现虚拟滚动，超大文本下页面体积增长仍受行数据量限制。
- 备注按 row index 存储，已核验记录同时带 `rowSig`；新空间只自动找回有行集或唯一行签名证据的记录。缺少签名的历史记录通过预览找回，行序推断必须逐行核验，不能当作可靠内容匹配。
- 跨语言 embeddings 只是校对辅助，不是最终权威 alignment。
- OpenCC 有助于比较中文变体，但无法归一化翻译风格差异。
