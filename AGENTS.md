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
   - `recoveredUnverified` 记录不能携带当前行的 `rowSig` 或计入人工确认；文本锚点与按行号找回都必须保持此标记，只有逐行核验可解除。页面必须提供清空当前空间和清空历史空间的显式操作，均需确认且不能误删另一类空间。验证执行 `node --test scripts/notes-spaces.test.js scripts/build-compare.test.js scripts/notes-recovery-merge.test.js`，其中使用生成页面的 VM 交互回归，不使用浏览器截图。
   - **同一行在多份历史空间里记录不同时必须逐字段合并，不得整条丢弃**。`rowsSignature` 是整张行集内容的哈希，重新生成工作台（重跑 `align:jp`/`export:paragraphs`、或写回改变正文后重建）就会换键，旧记录只能靠「按内容找回」搬过来；而「确认预筛」写入的记录是 `[规则预筛]`/`[对照表]` 结论且**没有修改结果文本**，同一行后来挨过 AI 校对后两边记录必然不同——按「记录必须逐字相同」处理会把人工确认整批丢掉（真实回归：同一行在两份历史空间记录不同时，旧实现丢弃率 100%，表现为「重新生成工作台后确认预筛的行还原为未人工确认」）。合并规则（`mergeNotes`/`mergeRecoveredVariants`，自动找回与预览找回共用）：基准记录优先取有修改结果（`revisionText` 非空）的那份，`manualDone`/`aiDone` 取任一为真，另一份记录的**分析内容**作为补充并**插到「修改结果：」之前**（跟在它后面会被解析层并进可写回的成品文本；解析层遇到第二个「分析：」会覆盖前一个，所以补充分析合并成一行）。合并**只对行签名能对上同一行的条目**生效（`pair.verified`，或 `space.sameSnapshot` 下 `rowSig` 等于目标行签名）；文本锚点推断与按行号找回一律仍标 `recoveredUnverified` 并清人工确认——合并保住的是"这一行人工确认过"，不是"这一行现在长什么样"。合并涉及多个历史记录时给记录加 `mergedFromSpaces: true` 标记（自动找回的提示语与预览面板的「已合并」计数据此显示），预览找回路径合并后立即按防抖落盘（该路径不经过「应用找回」，用户取消预览也不能丢）。契约见 `scripts/notes-recovery-merge.test.js` 与 `scripts/notes-spaces.test.js` 的自动找回用例。

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
   - 提示词按**五层**组装，权威定义写在 `proofread-contract.js` 顶部（改分层前先读那段），任何模块都不得另立一套口径：① 通用侧（`sharedInstructions`，标 `【通用校对规则】`）＝与作品/模式无关的任务契约；② 模式层（`modeContracts`）＝当前模式的列语义与结论字段；③ 特化侧（`ai/profiles/` 档案，标 `【成品校对规范：<name>】`）＝工作阶段规范；④ 动态上下文＝**五个段**（对照表命中段、说话习惯段、说话人判断段、低分归因段、线上查证段），命中该行/该章/该轮才注入；⑤ 固定尾巴＝noteref 硬性约束、术语表、JSON 输出约定，每行全量。合并顺序固定为 ①②③④⑤，测试按分区顺序断言。
   - **「提示词分层」与「判定链」是两个视角，文档与代码注释都要分开说**：分层回答“这一次请求里注入了什么”（①②③④⑤）；判定链回答“结论怎么一步步来的”（对照表预处理：只有纯术语行直接出结论，其余命中行——含术语冲突——把术语与冲突线索注入提示词 → 模型基础轮 + 上下文轮 → 低分归因与修复（极低分行按相邻行解释原因再修）→ 线上查证按站点顺序 + 自行检索 → 输出侧确定性工序（标点规范化与成对标记内的句末点号还原 → 修订结果混入原文文字就作废转人工）→ 待人工）。两者的对应关系是：对照表对应第④层的术语段；模型那几轮对应第①②③⑤层加相邻行；极低分复核对应第④层的低分归因段；线上查证对应第④层的线上查证段；输出侧护栏与标点规范化都是结论产出**之后**的确定性工序、不读提示词，因此不对应任何一层；终局为待人工时不注入任何新层。新增任何一层/一段时，必须同时更新这三处（代码顶部注释、本条、README 的分层说明），否则读者会把两套顺序混起来。
   - 第④层的段一律经 `proofread-contract.js` 的 `dynamicBlockPrefixes` 剥离后再注入，段首标记由各自的注入层定义并导出（`TERM_BLOCK_PREFIX`、`speechHabitPrefix`、`【说话人判断（`、`LOW_SCORE_PREFIX`、`WEB_LOOKUP_PREFIX`），**新增动态段必须同时登记到那张前缀表**，否则自定义提示词里的旧段会残留成两份；段内顺序按“由内到外补充资料”排列：术语命中 → 说话习惯 → 低分归因（相邻行）→ 线上查证。
   - **分层纪律：同一条判据只写一层**。字段默认值、档位定义、needsContext 口径、片段处理只写在通用侧；`modeSchemas` 只负责“键名 + 取值”（不重复定义档位，也不再用分数区间描述 grade，那会与“只判档位、不自己算分”冲突）；特化档案不复述任务契约；说话人判断口径只由动态段 `speakerCheckBlock` 自己带（它只在原文命中口癖时出现，正是需要该规则的唯一场景）。**也不要在别的层里复述固定尾巴的段首标记**：`硬性格式约束`、JSON 约定行这些字面量在最终提示词里必须唯一，契约测试按出现次数断言——需要指向那一段时，正面写出规则本身或干脆不写，别把标记名当锚点引用。
   - 第 ③ 层分两种条目形态，写法与选择标准写在 `profiles/novel.js` 文件头：**字符串**＝常驻（语义判断类：遗漏信息、否定时态、译名一致性、作品专有写法、说话特色、证据边界）；**`{ text, features: [...] }`**＝按行条目（离开特定版式/文字现象就无从谈起的规范：注音、傍点加粗、译注标记、分页图片、空行、省略号、「！？」、引号用途、括号与成对标记内侧的句末点号、连接词衔接、拟声词语气词、数字单位）。拿不准就写常驻。排版层里只有**标点全角化**破例常驻（任何一行都可能被改写，漏注入等于这一行写出的 revisedText 不受写法约束）；它和省略号条目都必须正面约束模型**自己写出**的 `revisedText`——判定与改写共用同一套规范，规范只写成“判 B 的缺陷”时，模型照样会照抄 B 的半角标点、或在自己的改写里打出连续半角点（真实回归见 `scripts/proofread-prompt-layers.test.js` 的「半角标点」用例）。`ellipsis` 特征的门槛是**两个**连续半角点（`\.{2,}`）而不是四个：两个点与三个点是同一类缺陷，探测口径必须与规范化层（`ai/punctuation.js` 的 `\.{2,}` → 「……」）保持一致，否则「..」这种写法既拿不到规范、也不会被规范化。
   - 按行裁剪的依据是 `ai/row-features.js`（特征注册表 + 探测器，唯一权威）：`detectRowFeatures({ source, target })` 只看本行文本，命中哪些特征就注入哪些按行条目。三条纪律：**探测不出/行数据缺失一律按命中处理**（`detectRowFeatures({})` 返回全部特征，宁可多花 token 也不丢规范）；**特征只描述现象不描述结论**；**不猜语义**（语义类规则不得声明 `features`）。`FEATURE_RULES` 与 `FEATURE_IDS` 必须一一对应。**注音特征两侧同权**：`ruby` 在原文侧的 `<ruby>基文<rt>注文</rt></ruby>` 形态同样算命中（本工作台的日文原文列就是这个形态，稿件形态 `|基文[注文]` 只是另一种写法）——只认目标列会让「原文有注音、译文没有」的行整条拿不到注音规范（实测整卷 3119 行里 923 行），模型没有口径可依就只剩“照抄日文读音”一条路。
   - `profiles/index.js` 的 `normalizeLine` 必须**保留对象形态**（旧版 `String(line)` 会把 `{ text, features }` 压成 `[object Object]`，让裁剪静默失效）；声明了未注册特征的条目按常驻处理并告警一次，不得静默丢弃。页面预填、`clientStatus().proofreadPrompt`、脚本审计用的都是**全量**（`proofreadPromptFor(...).system`）；只有 `buildMessages` 发出的请求才按行裁剪，`TRANSCOMPARATOR_FULL_PROMPT=1` 可退回全量做对比排查。审计数字走 `profileLineStats`/`promptLayerReport`（各层长度、省略条数与字符数），任务结束时由 `promptTrimSummary()` 汇报一次。契约见 `scripts/proofread-prompt-layers.test.js`，改分层、改特征、改档案条目形态前先跑它。
   - **输出侧护栏（目标列语言）**：提示词只能“要求”模型，做不到“保证”，所以修订结果还要过一道确定性闸门——`ai-proofread.js` 的 `guardTargetScript`（判据函数 `hasTargetScriptLeak`）在 `ensureRevisedText` 之后检查：目标列当前行**本来不含假名**（含则说明该列有刻意的假名写法，例如作品允许的片假名口癖，不拦）而 `revisedText` 含假名时，作废修订结果、置 `needsContext=true`（终局为待人工确认）、备注写明原因，计数走 `status.scriptLeaks`，任务结束由 `finish()` 汇报一次。它治的是两条真实通路：**原文有注音而目标列没有时模型照抄日文读音**、**上下文轮/低分归因轮把相邻行的原文当成可复制文本**。配套的提示词侧约束写在通用侧（“revisedText 只能是目标列语言的文字”）与收窄后的 noteref 硬性约束（只保留目标列自身已有的内联标记，不得从原文补入）里，三者缺一不可；`summary` 里的原文引用不受影响（只进备注，不进成品）。契约见 `scripts/proofread-prompt-layers.test.js` 与 `scripts/ai-proofread-status.test.js`。
   - **输出侧标点规范化**（`ai/punctuation.js`，`normalizeDecisionPunctuation`）：提示词侧的“标点全角化”只能要求，所以修订结果要再过一道**确定性宽度统一**——中文语境（标点最近的左右非空白字符里有中日文）的半角标点转全角（`，。？！；：（）`，省略号 `...`/`......`/`。。。` 统一成 `……`），**英文句子保持半角**（反向还原要求**正向 ASCII 证据**：标点紧邻的左右字符都是字母/数字，或只有一侧是、另一侧是行边界且整段没有汉字/假名——`This is a test， isn't it？` 会还原，`他说 ABC。` 保持全角；只用“附近没有汉字”当判据会把 `「……」`、`「～～～！！！」`、整行的 `……` 这类纯标点/拟声行当成英文，实测整卷 3119 行里 50 行误判，改成正向证据后同一整卷改动为 0 行）。三条纪律：**只动标点**（不改其他字符、不重排语序，引号不在这一层处理——配对与撇号判断交给提示词）；**不做词语级判断**（`3.5`、`1,000`、`e.g.`、`Mr.`、URL、`S1_01` 之所以安全，是因为它们的标点两侧都是 ASCII，紧贴字母/数字的 `.` 直接豁免）；**内联标记先摘后还原**（`<ruby>`/`<rt>`/`<a epub:type="noteref">` 内部不参与规范化）。放在 `ensureRevisedText` 之后、`guardTargetScript` 之前。改动必须留痕：备注的分析栏里写一行「标点自动规范化：半角→全角 N 处…」（说明行必须在「修改结果：」之前——它是解析层认得的说明行，已登记在客户端 `isNoteProseLine`），计数走 `status.punctFixes`/`punctToFull`/`punctToHalf`（`status.punctEnabled` 表示这一层是否启用），`finish()` 汇报一次。开关 `punctNormalize:false` / `TRANSCOMPARATOR_PUNCT=0`。契约见 `scripts/punctuation.test.js`（纯函数：中文语境、英文句子、数字与缩写、内联标记、空值）与 `scripts/ai-proofread-status.test.js` 的端到端用例。
   - **同一层里的第二件事：成对标记内侧的句末点号还原**（`punctuation.js` 的 `restoreTerminalPunctuation`，由 `normalizeDecisionPunctuation` 在宽度统一之后调用，因此它多收一个 `targetText`）。中文规范要求完整句的句末点号落在引号/括号**内侧**，而原文（日文）常在这个收尾符号前省略它——模型据此把目标列本来就合规的点号判成「多出句号」并删掉（真实回归：第 898 行 `…报告道。」`、第 1087 行 `（……变成那样。）`；同一个形状出现两次，第二次的收尾符号是**括号**，所以提示词侧的覆盖面也从 `quote` 扩到了 `parenthesis` 特征）。提示词只能“要求”，而「修改结果：」会被人工直接写回成品，所以这里必须确定性补回。**判据四条同时成立**（宁可漏补也不误补）：被删的那一段**整体是单独一个** `。！？`（`「。。」` 这种成对多余点号本身就是缺陷，删掉它属于修正，不能补回来）；该点号在目标列里紧跟成对标记的收尾符号（`」』）】〕`）；同一个收尾符号在修订结果里**仍在原位**；补回去之后不会与前一个字符连成「。。」。**省略号不在其中**（`……` 带语气与信息内容，删它属于语义判断）；行尾或句中的点号也不在（同一批模型输出里删行尾句号的行按原样保留）。计数走 `status.punctRestored`（处），备注仍写进那一行「标点自动规范化：…」（只补点号时不带宽度口径的括注），`finish()` 单独汇报一次；契约见 `scripts/punctuation.test.js` 的三条补回用例与 `scripts/ai-proofread-status.test.js` 的端到端用例。
   - 特化档案通过 `profiles/index.js` 注册（`listProfiles`/`resolveProfile`，未注册的 `profileId` 一律回落 `DEFAULT_PROFILE_ID`），可选值随配置 `profileId` 下发，界面「校对设置 → 特化规范」按注册表渲染并嵌每个档案的默认提示词。仓库内档案为 `profiles/novel.js`（与作品无关的通用规范）与 `profiles/demo.js`（作品专有档案，兼公开示范）；用户自己的档案走被忽略的 `profiles/local/*.js` 或环境变量 `TRANSCOMPARATOR_PROFILE_FILES` 指向的仓库外文件，加载失败只告警并跳过，不得让坏档案拖垮服务。
   - 本机档案要的是「某份既有档案 + 本机专有的名字/表/补充规则」，所以走**叠加**而不是再写一份：文件只写 `{ extends: "<既有 id>", ...差异字段 }`，注册表合并后**沿用基底 id**（`name`/`summary`/`speechHabitScope` 声明即覆盖，`sections` 按小节标题追加、同名小节替换，`termTables`/`speechTables` 与基底合并去重），于是下拉里不会出现两份逐字相同的档案，也不会因为选错而静默丢掉本机的表，基底改了规范本机副本自动跟上。`extends` 只能指向已注册的档案（含先加载的仓库外档案），指向不存在的 id 时只告警并跳过。不写 `extends` 时仍是「新档案」语义，此时与内置档案撞 id 才告警覆盖并提示改用 `extends`。叠加契约见 `scripts/ai-profile-overlay.test.js`，改 `applyOverlay` 前先跑它。
   - 档案 id 是稳定槽位：本机用 `extends` 叠加 `demo` 后它只是换了名字（如「某系列成品（本机档案）」），所以文档、脚本示例与测试一律按 id 引用档案，不要拿 name 去认定某条档案。
   - 作品相关的具体内容集中在 `profiles/demo.js` 一处（示范档案）与 `src/ingest/text-utils.js` 的正文边界清单；文档、测试与其它模块不必重复展开作品名，测试夹具优先使用中性人名（山田太郎/佐藤花子…）。
   - 特化侧不只放提示词，也可以声明**辅助判断数据**：档案的 `termTables`（译名对照表路径，本机路径只写在被忽略的 `profiles/local/` 或环境变量 `TRANSCOMPARATOR_TERM_TABLES`）。对照表由 `ai/term-table.js` 在确定性预处理阶段查表，由 `applyTermTable`（AI 校对与预筛选共用）按 `evaluateTermRow` 的四类结论分流：**只有 `term-only` 直接出结果、不调用模型**；`consistent`、`advisory`、`conflict` 一律**不写结论**，只把命中的术语按行**作为提示词注入**（`termGuidanceFor` → `termBlock` → `buildProofreadSystemPrompt` 的 `termBlock` 参数，用户载荷里同步给 `terms` 字段），整行照常交给模型。`conflict` 额外做两件事：注入**冲突线索**（译文现用哪种写法、或整条没译出来，措辞面向模型而非“请人工确认”），并登记进 `config.termConflictIndexes` —— 这些行在预筛阶段**豁免**（不吃规则/相似度预筛），因为「看起来差不多」很容易把术语问题一起放过，而术语判断必须由模型给出。与 `glossaryFile` 的整卷术语表是两回事。
   - **低分归因层**（`ai/low-score.js`）：排在模型轮之后、线上查证之前，顺序为 对照表 → 模型（基础轮 + 上下文轮）→ **低分归因与修复** → 线上查证 → 待人工。解决的问题是“极低分在逐行视角下长得都一样”：整行与相邻行**互换**、本行只是上下句的一半、代词与省略主语依赖上下文、真的把否定/时态/因果弄错、译文自己加了原文没有的话、原文本身晦涩被误判——现象相同而修法不同，所以低分不能直接当“逐句误译”处理，必须先归因、再动手。触发条件四条同时成立：`needsEdit=true`、不是 `needsContext`/`unclear`、**扣分达到 `lowScorePenalty`**（默认 60，等价 score ≤ 40）、本行前后至少还有一行（首末行无从复核）。**不用档位兜底**：`computeScoreAndGrade` 会把「只给 poor 档、不给分数」的行折算成 penalty=45，用档位兜底就等于把整个 poor 档拉进来、阈值参数形同虚设；要让整档都归因就把阈值调到 45（`TRANSCOMPARATOR_LOW_SCORE_PENALTY`）。触发判断必须在**拿到结论之后**（`entersLowScore`）——模型给出定论时主循环本来就要 break；一旦触发该行后续所有轮次都保持归因口径（`lowScore.active`），窗口先一次补到前后各 `lowScoreRows` 行（默认 2，`ensureContextRadius`，一侧行不足时由另一侧补上），再按 `needsContext` 一轮一轮继续扩，仍受 `contextBudget` 的行数/字符上限约束。四条纪律：**判据窄**（普通缺陷不进这一层，否则每行都要多发一次请求）；**错位必查**（这类缺陷在逐行视角下必然表现为“整行重译”，归因段强制先核对相邻行的原文/译文配对，两个方向都看）；**原文行序不动**（错位只能按“本行原文该译成什么”来修，禁止建议对调相邻两行的译文、禁止把邻行译文或两行内容塞进一条 `revisedText`）；**上下文优先**（归因不了就返回 `needsContext=true` 继续补行，不许凭猜测产出 `revisedText`）。归因取值字段 `cause` 由 `modeSchemas` 定义（两个模式都有）并经 `normalizeCause` 归一——认不出的取值按“未归因”处理，不得静默塞进某一类；取值的含义与各类对应的修法只写在动态段 `lowScoreBlock` 里（分层纪律：判据只写一层），通用侧只保留一条契约「行序与行边界由对齐决定，不属于语言质量问题」，避免模型被“译文与原文无关”骗去建议调换行序。结果写进备注（`lowScoreNote`：错位写明方向与“已保持原文行序”，其余写类别标签加实际核对到的邻行数，判不了写转人工），统计走 `status.lowScoreChecks`（复核行数）/`lowScoreShifted`（确认错位行数）/`lowScoreCauses`（原因分布）/`lowScoreEnabled`/`lowScorePenalty`/`lowScoreRows` 与任务结束的 `lowScoreSummary()` 日志，不要另开数据通道。开关 `lowScoreCheck:false` / `TRANSCOMPARATOR_LOW_SCORE=0`，窗口 `lowScoreRows`（1–4）。契约见 `scripts/low-score.test.js`（纯函数 + 端到端：触发边界与阈值可调、窗口逐轮变宽、备注与统计、模型未给原因时如实标注、首末行跳过）。**归因写在备注的分析栏里**（`分析：` 之后、「修改结果：」之前，与标点自动规范化、线上查证同由 `decisionToResult` 的 `analysisLines` 组合）：备注是按行取值的（客户端 `parseAutomatedNote`），「修改结果：」必须是最后一段且只放本行成品文本——跟在它后面的说明行会被并进修改结果，而修改结果就是页面上的可写回文本，等于把归因说明写进成品；旧备注里已经被并进去的说明行由 `normalizeStoredNote` 载入时按行剥掉。
   - 档案还可以声明 **`wikiSites`**（线上查证用的官方站点入口，**有序：声明顺序就是查询顺序**；作品专有信息 → 只写在档案里，未声明时这一层不启用；`normalizeProfile` 归一化（字符串/对象都接受、去重、保序），`extends` 叠加时声明即覆盖，也可用 `TRANSCOMPARATOR_WIKI_SITES` 或 `startProofread({ wikiSites })` 覆盖，优先级 显式传入 > 环境变量 > 档案）。它是**线上查询层**（`ai/web-lookup.js`）的入口表：这一层排在“转人工”之前、低分归因层之后，顺序为 对照表 → 模型 → 低分归因 → **线上查证** → 待人工，触发条件很窄——① 本行有 `advisory` 命中（假名写法存疑；`conflict`/`consistent`/`term-only` 都不会进来），② 模型自己返回 `needsContext`/`unclear` 且相邻行也补过。执行方式是**程序分轮驱动**（`proofreadRow` 里的 round 循环）：`round 0..sites.length-1` 一轮只给**一个**站点，`round === sites.length` 是“自行检索”那一轮，最多 4 轮；**模型一旦给出能定论的结论立即 break**，后面的站点与自行检索都不再发（这就是“按顺序、拿到关键信息就停”的落点），仍判不了则转人工并在备注写明完整尝试轨迹。**不给直达词条链接**：只给站点入口 + 要查的词条（译名优先、原文备选），条目名猜错就是个打不开的地址，让模型站内自己找才有依据。**本机完全不抓网页**：实测这些站点对本机一律返回 403 风控挑战页（`<title>请稍候…</title>`，换 UA、换客户端都一样），绕过需要 clearance cookie 或浏览器引擎，本机只负责“顺序、入口、问什么、何时停”。三条纪律：**不许凭记忆猜**（每轮都要求“只依据实际查到的内容；打不开/搜不到/内容无关就返回 unclear”，最坏结果是多问几轮后转人工，而不是多一个编造的结论）；**只发术语名与该行片段**（不含整卷文本与本机路径）；提示词里的站序口径与日志一致（“第 N/M 站”，自行检索单独措辞，不混进分母）。开关 `webLookup:false` / `TRANSCOMPARATOR_WEB_LOOKUP=0`；审计走 `status.webLookups`/`webLookupResolved`/`webLookupAttempts`/`webLookupSites` 与任务结束的 `webLookupSummary()` 日志。契约见 `scripts/web-lookup.test.js`。
   - 表里原文列的 `【】` 只是**给注音标记位置**（注音按逗号顺序加进各个方括号里的文本），正文与成品里几乎不出现方括号：匹配与展示一律用去括号的 `plainSource`/`plainTarget`（`displayTermPair`），带括号的写法不作为别名，否则「原文里带方括号才命中」和备注里显示「【山田】【太郎】」都是错的。`ruby_ori` 的逗号分段与原文的方括号分段**按顺序一一对应**，不能把各段读音当成互相独立的别名（那会把「太郎」的读音挂到别的名字上）。
   - 跳过模型的判定由 `measureTermCoverage`（`ai/term-table.js`）给出：把命中的术语别名（长别名优先、互不重叠，**不含分段别名**）从原文划掉，剩下的有效字符（既非空白也非标点符号）不超过 `TERM_ONLY_FREE_CHARS` 且占比不超过 `TERM_ONLY_FREE_RATIO` 才算「整行只有术语」。`evaluateTermRow` 因此有四类结论，**每一类对应一种处置**：`term-only`（对照表出完整结论、跳过模型）、`consistent`（术语一致但整行不止术语 → 注入术语后交模型）、`advisory`（**存疑**：命中的是假名写法、可能只是普通词 → 不由对照表定论，注入术语后交模型判断）、`conflict`（强证据差异且非假名写法 → **注入冲突线索后照常交模型**：术语判断是模型分析的一环，结论由模型结合整句给出，对照表只给证据）。`coverage` 随结果带出便于审计；覆盖率只按“整条术语/整串读音”算，所以「术语 + 大量正文」的行永远不会被判成 term-only（实测整卷 3119 行：命中 678 行，其中纯术语 17、注入后交模型 631、冲突 30、存疑交模型 10）。
   - 对照表判定的保守规则（改动前先看 `scripts/term-table.test.js`）：只有 3 字及以上的基文别名可以判“译名不一致”（strong）；2 字词、读音别名、分段别名只能确认一致，不能指控译名错误；译文已使用译名（含只写姓或名的分段写法、括号与字形差异）判一致；命中其他译法/英文写法/字形差异、或整条术语没在译文里出现时，把这些线索写进提示词交给模型判断（`evaluation.revisedText` 只是“若只替换术语会是什么样”的审计参考，不再是结论）；定位不到可替换旧译名时不编造 `revisedText`；一行若没有任何确认一致或强证据不一致，就不由对照表处理，继续走 AI。
   - **注音条目：中日两侧都注音才算「表里那个专有名词」**（`rubyEvidenceMatches` 原文侧 + `targetRubyEvidenceMatches` 译文侧）：`Ruby_Ori` 这一列混着两类写法，改动前必须先分清——① **特殊别名读音**（`【発信機】` 注 `ナノデバイス`、`【表層融解】` 注 `フラックスコート`）：只对基文命中会把普通词义算成术语，正文里的「ＧＰＳ発信機」是发射机，与表里那件装备无关；② **这个词本身的普通读音**（`【魔術】` 注 `まじゅつ`、`【学園都市】` 注 `がくえんとし`）：这类词在正文里**永远不会带注音**，所以“基文 + 注文必须一起在原文里对上”会把它们整体排除（实测整卷里光「魔術」就有 42 处候选被挡掉，那些行被裸着交给模型，模型只能按通用词典把 魔術 判成「魔术」——而 `【魔術】→魔法` 本来就写在表里）。真正的注音专有名词在中日两侧**都会**注音（`<ruby>心理掌握<rt>メンタルアウト</rt></ruby>` ↔ `<ruby>心理掌握<rt>Mental Out</rt></ruby>`），于是用译文侧证据把两类分开。**非人名**条目一旦声明了注音，候选别名（`term`/`part`）必须满足「本行存在注音对：基文与该条目写法互相包含 + 读音等于该条目的注文（整串或其中一段）」，或「注文直接以正文形式出现在本行（剥掉 `<rt>` 之后）」——这两条构成**原文侧证据**。**译文侧证据**要求译文里出现该条目的中文注音形态，满足任一条即可：① **注音落在该条目的中文译名上**（基文互相包含）；② **注音内容就是表里那条读音**（`ruby_ori` 归一后的假名，或 `ruby_trans` 英文列）。两条译文侧证据都不能省：只认 ① 的话，「译文没按表里译名写」这件事本身就会让证据消失、指控永远无从谈起（`full` 会退化成只可能一致）；实测正是 ② 把 `【念動能力】/テレキネシス → 念动能力` 而译文写「念动力`<Telekinesis>`」这类真差异救回来（整卷 4 行）。两侧同时成立即 `full`（完整口径：可确认一致、可指控译名差异、可计入覆盖率）；**只有一侧成立、或两侧都不成立时降级为「只作一致性证据」（`demoted`）**：译文确实用了该译名才算命中（一致 → 可注入提示词、可判「整行只有术语」并跳过模型），译文没用该译名时**不算命中**（不判定、不计入覆盖率、不进提示词）——宁可不判，也不凭一次字面命中去指控译名错误。`ruby` 别名（原文只写了读音）不走这道门槛：它本来就只能确认一致、不能指控，与降级后的效果一致。人名豁免（`PERSON_TYPE`：`type` 含人名/角色/姓名/名字/character/person 等），因为原文里的人名只在首次出现时注音，若也要求注音对上，人名条目会在绝大多数行里失效；`type` 为空按非人名处理（保守：宁可不判）。读音比对先做归一（`normalizeRubyText`：NFKC + 折叠小写假名 + 去装饰），实测原文把「しょ」写成全尺寸的「しよ」（`しよくほう`），不折叠就对不上。注音对由 `rubyPairs` 解析（`<ruby>基文<rt>读音</rt></ruby>` 与稿件 `|基文[读音]` 两种形态），因此 `findTermHits` 必须同时收到**带内联标记的原始原文与原始译文**（内部自己剥标记做字面匹配，再单独解析注音对）；调用方没给译文时退回只看原文侧口径（只做原文侧的离线排查用）。开关 `TRANSCOMPARATOR_TERM_RUBY=0` 可退回“完全不做注音要求”的旧口径（仅用于对比排查）。
   - 注音口径挡下的候选要**如实报数**：`findTermHits(..., { rejected, demoted })` / `evaluateTermRow({ rejected, demoted })` 回传两类候选，`evaluation.rubySkipped`（证据不足且译文未用该译名，因而未参与判定）/`evaluation.rubyDemoted`（降级命中，只作一致性证据）给出本行条数，运行期走 `status.termRubySkipped`/`status.termRubyDemoted`，落盘 `summary.rubySkipped`/`summary.rubyDemoted`，离线脚本报告与两处日志各记一处（它们回答“表里有这条、本行为什么没算命中 / 为什么只作证据”，用于判断规则是否过严，不参与结论）。实测整卷 3119 行（重建后的活动快照）：命中 678 行（术语一致 648：纯术语 17 / 注入 631；术语冲突 30），降级为只作一致性证据的候选 417 条，因证据不足且译文未用该译名而排除的候选 117 条；同一整卷旧口径是命中 532 行、排除 512 条——可见“读音类条目”此前基本没参与判定。口径变化必须递增 `TERM_LAYER_VERSION`（现为 5），否则旧快照会拿新口径去对旧结论、报出一堆假分叉。
   - **强证据还要再分一层**：命中的基文别名全是假名时（`KANA_ONLY_BASE`，如グループ/メンバー/トリック）判为 `advisory` 而不是 `conflict`——这类写法在正文里常常就是普通词，而表里它可能只是某个组织名/招式名的写法之一（「まさに頂点グループ」的グループ是普通名词，「暗部のグループ」才指那个组织），**删条目会丢掉真实场景，由对照表定论会误报**，所以把判断权交给模型（`termGuidanceFor` 的 note 明确要求「确指该术语时改用该译名，只是普通词义时按普通词处理，不要强改」，`line.advisory=true`），人工核对模型结论。匹配前必须剥掉内联标记与 `<rt>` 注音内容（注音内容不参与字面匹配，但注音对要单独解析出来供注音校验用），片假名别名不得落在更长片假名词内部。
   - **分段命中（只写姓或名）与读音命中各有口径，别混用**：分段别名能“确认一致”（译名判定里的 `via=part`），但**不能反过来证明本行用的是这个整条术语**——同姓的其他角色都会被它命中（实测单独一个「御坂」能带出御坂美琴、御坂美鈴、御坂旅挂三条）。因此：判定上只有 `scope !== "part"` 的一致才算确认（只命中分段的行交回后续流程）；覆盖率也不把分段别名计入（否则「「御坂……？」」这种只出现姓的行会被判成“整行只有术语”而跳过模型）。整条术语与整串读音的别名照旧参与两者。
   - 「本行用到了哪些术语」由 `hitsUsedInRow`（`ai/term-prefilter.js`）唯一判定，**注入给模型的与页面显示的必须是同一批**：只认 `scope === "term"`，以及 `scope === "ruby"` 且译名一致（原文写读音、译文确实用了该译名）；分段命中一律不算，且要用 `markUsedTermAliases(..., { includeParts: false })` 判断别名是否真的被占用（同一姓氏下靠共用读音集体命中的条目要挡掉）。改这个函数等于同时改提示词与页面芯片，先跑 `scripts/term-table.test.js` 与 `scripts/term-layer.test.js`。
   - 对照表结果用备注标记 `[对照表]`（与 `[AI校对]`/`[规则预筛]`/`[相似度预筛]` 同级，客户端 `automatedNoteMarkers`、`prefilterResultKind`、徽标与统计都要同步），`status` 用 `term-prefilter`（纯术语行、done）或 `suggestion`（需确认）；`makeTermResult` 只接受 `term-only` 这一种结论——`consistent`/`advisory`/`conflict` 传进来直接报错（对照表不再替模型出结论，冲突行也不例外）。计数走 `status.termPrefiltered`（跳过模型的行，只有纯术语行）/`termConflicts`（术语冲突行数，它们**照常交给模型**，不再表示“需人工确认”）/`termInjected`（注入术语后仍交给模型的行，含术语冲突与存疑行）/`termRubySkipped`（注音证据不足、且译文未出现该译名，因而未参与判定的候选条数）/`termRubyDemoted`（同样没有双侧注音、但译文确实用了该译名，因而降级为「只作一致性证据」的候选条数）/`termTables`，不要另开数据通道。
   - 界面上要能看到对照表是否生效：`clientStatus()` 返回 `termTableStatus`（`{files, sheets, entries, errors}`，按 `<profileId>` 解析档案 + 环境变量声明，走 `loadTermTablesCached` 的 mtime 缓存，不写日志）；状态接口接受 `profileId` 查询参数，客户端「校对设置 → 特化规范」下方的 `#aiTermTableHint` 按 `entries`/`errors` 显示“未声明 / N 条术语 / 加载失败”，并追加构建期预筛数字。路径必须先经 `normalizeTermTablePaths` 归一（相对路径、重复分隔符、大小写差异只算一张表），否则同一张表会被重复加载。
   - 对照表层的**分工**（`term-layer.js`）与说话习惯层不同，原因是它产出的是**行级结果**而不是提示词上下文：结果（备注文本、`status`、跳过模型的依据）必须由运行期生成——它要带当次任务的标签、目标列与「已人工确认」过滤，构建期不能替用户写备注空间。但「哪些行会被命中、命中是一致、存疑还是冲突、哪些行整行只有术语」只依赖「整卷行数据 + 对照表」，与模型无关，因此**构建期算一次并落盘**到 `translation-compare.json` 顶层 `termPrefilter`，同时嵌进 `pageMeta.termPrefilter`：页面在跑任务之前就能标出「术语冲突（交 AI 判断）」（`conflicts`）「纯术语（跳过模型）」（`termOnly`）「术语注入（仍交模型）」（`injected`，含假名存疑行）三类行并给出预筛数字，离线脚本与 AI 拿同一份结论对照。块同样写在行数据之外，不得给行加字段。
   - 落盘块结构：`{ version, generatedAt, byProfile: { <profileId>: { files, fingerprint, entries, defaultVariant, variants: { "<mode>:<targetKey>": { proofreadMode, targetKey, hits, consistent[], termOnly[], injected[], conflicts[], terms{ <rowIndex>: string[] }, chapters[{chapter,hits}], summary } }, summary } }, errors[] }`。`consistent` 是「译名一致」的合并集合（页面徽标按它渲染），`termOnly`/`injected` 是其中「跳过模型」与「注入术语后仍交模型」的两半（存疑行归 `injected`，`summary.advisory` 单独给它的条数）；`terms` 是行号 → 本行**用到的**术语对（去方括号的 `displayTermPair`，经 `hitsUsedInRow` 过滤、每行最多 `TERMS_PER_ROW_CAP` 条），页面用它显示「本行命中了哪些术语」——它只由「原文 + 对照表」决定，与模型无关，所以可以随页面下发（行文本与备注仍不进产物，实测整卷命中 678 行时约 24.5 千字符、UTF-8 约 50 KB）；判定与「校对模式 + 目标列」绑定，构建期按项目模式把该模式可能用到的变体都算好（双语只有 `bilingual:cn`，三语是 `trilingual:cn` 与 `trilingual:tw`），运行期无论用户选哪一列都能命中同一份结论。`files` 经 `tableFileNames()` 只留**文件名**（快照与页面都可能被分享，本机完整路径不进产物），完整路径只出现在运行期状态接口与日志里。
   - 运行期不重复「复用判定」而是做**交叉校验**：`applyTermTable` 仍逐行判定（实测整卷 3119 行约 190ms，且结果必须带当次标签），算完用 `termLayerFor` 取构建期结论比对**命中行集合与跳过模型的行集合**（注入行与冲突行都算命中），一致就 `pushLog`「与构建期预筛一致」，指纹过期就提示对照表被改过、需重新构建工作台，集合不一致则如实报告分叉（页面徽标可能过期；旧版本生成的快照会在这里报「跳过模型的行集合不同」）。判定函数是唯一的，两条路径不一致只可能是表改了或页面过期。
   - 「译名一致」的行不需要任何操作却常命中多条术语，备注按**分组摘要**写（`formatTermHitGroups`：按证据类型分组列出 `原文→译名（类型）`，原文与译名都用去方括号的 `displayTermPair`）。冲突行的分析段由 `conflictAnalysisHead`（`term-prefilter.js`）生成：**明细只列 `consistent === false` 的真差异项**，已确认一致的条目与只命中分段/读音写法因而未参与判定的条目**只给计数**。原因是 `evaluation.hits` 是「对照表在本行匹配到的全部条目」，把它们一并挂在「存在译名差异 N 条」标题下会让同一句话自相矛盾（既写「译文已使用该译名」又写「原文只出现了分段写法，未参与译名一致性判定」），同姓角色的分段命中（原文一个「上条」带出上条当麻/刀夜/诗菜）还会成串混进来；实测整卷 40 个冲突行里 28 行被这样污染（额外列出 50 条分段命中、43 条已一致项），改成「差异明细 + 其余计数」后为 0。基文别名全是假名时（グループ/メンバー/トリック…）走的是 `advisory` 那条路（见上）：**不由对照表出结论**，分析段里只留一句计数（「N 条命中的是假名写法、可能为普通词，需结合上下文判断」），`describeTermHit` 也不写「请人工确认是否需要替换」，而是要求「确指该术语时改用该译名，只是普通词义时按普通词处理，不要强改」。改前先看 `scripts/term-table.test.js`（含这两条新契约的断言）。
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
   - AI 校对的重试与终局：模型返回 `needsContext`/`unclear` 时按轮补充相邻行；对齐片段行（原文或译文以续接标点 `、，,：；` 结尾，或结尾本身是接续词）直接终局为待人工确认，不再扩展上下文——行边界属于对齐问题，补上下文解决不了它，也不得据此判定翻译缺陷。例外只有一个：片段行**同时被判为极低分**时仍进低分归因层（那一层正是要区分“本行只是上下句的一半”和“本行写的是邻行的内容”，`cause=boundary` 与 `cause=order-shift-*` 的修法完全不同），只是不再按 `needsContext` 扩上下文；判据顺序上 `entersLowScore` 优先于片段行检查。

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
- 写回文本的来源是备注里解析出的「修改结果：」：备注按行取值，「修改结果：」必须是最后一段、只放本行成品文本；低分归因、线上查证、标点自动规范化这类说明写在分析栏里（`分析：` 之后，见 AI 校对条目的 `analysisLines`；这三类前缀同时登记在客户端 `isNoteProseLine`），不得跟在它后面。

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

写回后成品里混进「低分归因：」「线上查证：」这类备注说明：说明行原本跟在「修改结果：」后面，被客户端的按行解析并进了修改结果（`public/workbench-client.js` 的 `parseAutomatedNote`），而修改结果正是人工点「写回」送出的文本。新备注已把这两类说明写进分析栏（`decisionToResult` 的 `analysisLines`，排在「修改结果：」之前），旧备注在页面载入时由 `normalizeStoredNote` 按行剥掉；仍复现就先确认页面是重新 `npm run build` 之后打开的（旧页面脚本没有识别与剥离），再看备注里的「修改结果：」是不是最后一段。

修订结果里的标点被改坏（英文句子被全角化、`3.5`/`e.g.`/URL 里的点被换成 `。`）：先看 `ai/punctuation.js` 的语境判据——半角→全角只在标点两侧（跳过空白与引号）出现中日文时生效；全角→半角要求**正向 ASCII 证据**（两侧都是字母/数字，或一侧是字母/数字、另一侧是行边界且整段没有汉字/假名），所以纯标点行与中文句子不会被误还原；紧贴 ASCII 字母/数字的 `.` 有豁免；内联标记整段先摘后还原，所以 `<rt>` 内容与标签属性里的标点不会被碰（改判据后请按 `AGENTS` 验证清单跑一次整卷 dry-run：把 `normalizeTargetPunctuation` 逐行套在活动快照的 `cn`/`tw` 列上，已发布成品应当改动为 0 行）。若某一行的标点确实不该动，先确认它是不是被标签外的语境带偏（例如中文句子里的英文引文），再考虑用 `punctNormalize:false` / `TRANSCOMPARATOR_PUNCT=0` 关掉这一层（关掉后 `status.punctEnabled` 为 false，日志会写「标点规范化：已关闭」）。

修订结果里唐突出现日文（`revisedText`、备注的「修改结果：」或写回后的成品里混进假名/日文标记）：先看那一行的原文是否带注音标记（`<ruby>基文<rt>注文</rt></ruby>`）而目标列没有——这是最常见的诱因，模型判定“译文漏了注音”却没有目标列读音可写，只能照抄日文。`status.scriptLeaks`（护栏作废了多少行）与任务结束的「输出语言护栏」日志给出拦截情况；计数为 0 却仍然看到日文时按两条查：`ai/row-features.js` 的 `ruby` 规则是否覆盖了**原文侧** HTML 形态（漏检等于该行拿不到注音规范）、以及用户自定义提示词里是否残留着旧版通用侧整段（旧文本不会被自动剥离，需要点「恢复默认」，且必须先 `npm run build` 再打开新页面）。

AI 判「对话尾部引号前多出句号」，并在 `revisedText` 里删掉成对标记内侧的句末点号：先确认目标列（中文）那一句是不是完整引述——独立引用整句时句末点号本来就在引号内（「……，某某报告道。」这类把报告句一起包进引号的写法同理），**整行就是一段括注（`（……这样。）`）时同理，点号在括号内**；而原文（日文）常在这个收尾符号前省略句末点号，所以「B 比 A 多一个句号」不是缺陷、更不是增译。这条口径写在 `profiles/novel.js` 的按行条目里（与「引号用途」同命中 `quote` 特征、与括号同命中 `parenthesis` 特征，各自独立注入），契约见 `scripts/proofread-prompt-layers.test.js` 的成对标记点号回归。**同一个形状出现过两次**：第 898 行是引号、第 1087 行是**全角括号**——只认引号的 `quote` 特征覆盖不到后者（那一行只命中 `ellipsis`），所以补特征时要一并检查别的成对标记。**真实请求立刻生效**：`buildProofreadSystemPrompt` 总是用源码里的档案重新注入特化侧（并剥掉自定义提示词里的旧档案块），不依赖页面里的旧文本；只是页面文本框要看到新文本、或要点「恢复默认」，仍需先 `npm run build` 再打开新页面。若模型仍按 A 的标点改写 B 的句末点号，先确认那一行的 `detectRowFeatures` 是否命中 `quote`/`parenthesis`；即使模型照删，输出侧的 `restoreTerminalPunctuation` 也会把单独一个、后面紧跟成对标记收尾符号的句末点号补回来（`status.punctRestored`，备注同写「标点自动规范化：…」），此时要看的是模型有没有继续给出错误的 summary 与扣分。同源的假阳性还有「普通词（如律儀）的假名读音不必在译文保留注音」——目标列压根没有那处注音时不得据此扣分，注音条目的证据边界（只评价 B 里实际出现的注音）已补明，回归断言在 `scripts/ai-proofread-profile.test.js` 的「规范要点确实进入了特化侧提示词」。

特化规范“没生效”或提示词突然变短：先看 `promptLayerReport()` 的 `profileLines`（注入了多少条、省了多少条、省了多少字符），再确认三件事——该条目是否被误写成按行条目（应当常驻的语义规则却声明了 `features`）、`features` 里的 id 是否在 `ai/row-features.js` 的注册表里（未注册的会告警并按常驻处理）、行的 `source`/`target` 是否真的包含触发该特征的现象（例如注音规则只在原文侧有 `<ruby>基文<rt>注文</rt></ruby>`／`|基文[注文]`，或译文侧有 `ruby`/`rt` 时注入）。排查对比用 `TRANSCOMPARATOR_FULL_PROMPT=1` 跑一次，它与裁剪前的提示词逐字一致；若怀疑是请求里少了内容，先确认自定义提示词不是“旧默认提示词整段”，旧文本里的通用侧不会被剥离，需要在界面上点「恢复默认」；**注意顺序**：该按钮（路径：「AI 辅助校对」抽屉 → 开始/停止那一行的「内置提示词」复选框 → 「AI 对话监控」下方的同名折叠项 → 文本框右上角）填回的是 `pageMeta.profiles[].prompt`，也就是**构建期嵌进页面的那份**提示词，所以必须先重新 `npm run build` 再打开新页面点它，否则恢复回来的还是旧文本；若从未手改过提示词（localStorage 无 `promptTouched`），新页面的文本框本身就是新文本，不必点任何按钮。

## 当前限制

- UI 是静态 HTML table，使用客户端分页切片（翻译比较默认 100 行/页，说话人默认 50 行/页），行数据仍随页面整体内嵌；未实现虚拟滚动，超大文本下页面体积增长仍受行数据量限制。
- 备注按 row index 存储，已核验记录同时带 `rowSig`；新空间只自动找回有行集或唯一行签名证据的记录。缺少签名的历史记录通过预览找回，行序推断必须逐行核验，不能当作可靠内容匹配。
- 跨语言 embeddings 只是校对辅助，不是最终权威 alignment。
- OpenCC 有助于比较中文变体，但无法归一化翻译风格差异。
