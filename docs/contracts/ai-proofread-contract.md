# AI 辅助校对与提示词分层契约

本文档是 `AGENTS.md` 中关于 AI 辅助校对系统（`src/workbenches/translation-compare/ai/`）及相关处理逻辑的详细领域契约。

## 模块定位与职责划分

- `src/workbenches/translation-compare/ai/` 的预筛选、提示词和校对结果属于翻译工作台；未来共享 AI 传输能力放在 `src/ai/`，不要反向污染领域模型。
- 共享 LLM 传输层只能请求 `http:`/`https:`，不得接受带用户名/密码的 URL，必须拒绝云元数据、link-local、多播和未指定地址，并禁止自动跟随重定向；本机 Ollama 的回环地址仍属于允许范围。
- 模式契约按 `proofread-contract.js` 的 `modeSchemas` 裁剪：双语对外只用 `decision=keep|replace|unclear` 表达结论、不出现 `better`/`counterpart`，三语保留 `better=target|counterpart|neither|unclear`；解析层把 `keep`/`replace` 归一为内部 `target`/`neither`，双语下 `counterpart` 也归一到 `neither`，旧提示词里的 `better` 必须继续可用。

---

## 提示词五层组装体系

提示词按**五层**组装，权威定义写在 `proofread-contract.js` 顶部（改分层前先读那段），任何模块都不得另立一套口径：

1. **① 通用侧**（`sharedInstructions`，标 `【通用校对规则】`）＝与作品/模式无关的任务契约；其中片段、noteref 语义与原文外内容分别按 `fragment`/`noteref`/`outOfScope` 现象命中，其余核心契约每行常驻。
2. **② 模式层**（`modeContracts`）＝当前模式的列语义与结论字段。
3. **③ 特化侧**（`ai/profiles/` 档案，标 `【成品校对规范：<name>】`）＝工作阶段规范。
4. **④ 动态上下文**＝**五个段**（对照表命中段、说话习惯段、说话人判断段、低分归因段、线上查证段），命中该行/该章/该轮才注入。
5. **⑤ 固定尾巴**＝noteref 硬性约束、术语表、JSON 输出约定，每行全量。

合并顺序固定为 **①②③④⑤**，测试按分区顺序断言。

### 「提示词分层」与「判定链」两个视角

- **分层回答“这一次请求里注入了什么”**（①②③④⑤）。
- **判定链回答“结论怎么一步步来的”**：
  对照表预处理（只有纯术语行直接出结论，其余命中行——含术语冲突——把术语与冲突线索注入提示词）
  → 模型基础轮 + 上下文轮
  → 低分归因与修复（极低分行按相邻行解释原因再修）
  → 线上查证（按站点顺序 + 自行检索）
  → 输出侧确定性工序（成品格式门禁 → 标点规范化 → 语言护栏）
  → 待人工。
- **两者的对应关系**：
  - 对照表对应第 ④ 层的术语段；
  - 模型基础轮与上下文轮对应第 ①②③⑤ 层加相邻行；
  - 极低分复核对应第 ④ 层的低分归因段；
  - 线上查证对应第 ④ 层的线上查证段；
  - 输出侧三步（成品格式门禁、标点规范化、语言护栏）都是结论产出**之后**的确定性工序、不读提示词，不对应任何一层；终局为待人工时不注入任何新层。
- 新增任何一层/一段时，必须同时更新三处（代码顶部注释、`AGENTS.md`、README 的分层说明），避免两套顺序混淆。

### 分层纪律与前缀表

- 第 ④ 层的段一律经 `proofread-contract.js` 的 `dynamicBlockPrefixes` 剥离后再注入，段首标记由各自的注入层定义并导出（`TERM_BLOCK_PREFIX`、`speechHabitPrefix`、`【说话人判断（`、`LOW_SCORE_PREFIX`、`WEB_LOOKUP_PREFIX`），**新增动态段必须同时登记到那张前缀表**，否则自定义提示词里的旧段会残留成两份。
- 段内顺序按“由内到外补充资料”排列：术语命中 → 说话习惯 → 低分归因（相邻行）→ 线上查证。
- **同一条判据只写一层**：字段默认值、档位定义、needsContext 口径、片段处理只写在通用侧；`modeSchemas` 只负责“键名 + 类型/枚举”（不重复定义档位，也不用分数区间描述 grade）；特化档案不复述任务契约；说话人判断口径只由动态段 `speakerCheckBlock` 自己带。
- **不要在别的层里复述固定尾巴的段首标记**：`硬性格式约束`、JSON 约定行这些字面量在最终提示词里必须唯一。
- **不要引用动态段**：`【说话习惯】`/`【说话人判断】` 这两段只在命中该章/该行时才存在，档案里不要写“判断依据见【说话习惯】段落”。
- `modeSchemas` 是每一行都要重发一份的对象（在 user 载荷里），它只留键名与类型/枚举，把含义留在系统提示词或命中的动态段里。

---

## 特化档案与按行裁剪（Row Features & Entity Gating）

第 ③ 层分**三种**条目形态（写法与选择标准写在 `profiles/novel.js` 文件头）：
1. **字符串**＝常驻（语义判断类：遗漏信息、否定时态、译名一致性、作品专有写法、证据边界）。
2. **`{ text, features: [...] }`**＝按行条目（离开特定版式/文字现象就无从谈起的规范：注音、傍点加粗、译注标记、分页图片、空行、省略号、「！？」、引号用途、括号与成对标记内侧的句末点号、连接词衔接、拟声词语气词、数字单位）。拿不准就写常驻。
3. **`{ text, characters: [...] }`**＝第三形态（实体条目），只在「这条规则离开那个名字就无从谈起」时使用。

### 裁剪规则与纪律

- 角色口癖与说话特色**不写常驻档案**：只在动态说话块真正注入时随块出现，避免每条普通叙述都背负一套说话规范。
- 排版层里只有**标点全角化**破例常驻；它和省略号条目都必须正面约束模型**自己写出**的 `revisedText`。`ellipsis` 特征的门槛是**两个**连续半角点（`\.{2,}`）。
- 按行裁剪的依据是 `ai/row-features.js`（`detectRowFeatures({ source, target })`）：
  - **探测不出/行数据缺失一律按命中处理**（`detectRowFeatures({})` 返回全部特征，宁可多花 token 也不丢规范）；
  - **特征只描述现象不描述结论**；
  - **不猜语义**；
  - `FEATURE_RULES` 与 `FEATURE_IDS` 必须一一对应。
  - **注音特征两侧同权**：`ruby` 在原文侧的 `<ruby>基文<rt>注文</rt></ruby>` 形态同样算命中。
  - `fragment` 是保守现象探测：缺句末标点、以接续词/助词或逗号收尾均算命中。
  - `outOfScope` 只在目标文本出现特典、后记、译注、制作信息等类别词时命中。
  - `directionalSymbol` 负责通信标识等方向敏感符号（如 `∨` 与 `＞`）。
- **实体闸门**（`ai/name-entities.js`）：档案用 `characters: ["甲野一郎"]` 声明适用范围，`detectRowEntities({ source, target, entities })` 命中才注入。
  - 声明名单只能由档案给出；
  - 探测不出按命中；
  - 长别名优先；
  - 必须能审计（走 `profileLineStats().entityGated/entitySkipped`、`promptLayerReport().entities` 与 `promptTrimSummary()`）。
- `profiles/index.js` 的 `normalizeLine` 必须保留对象形态；声明了未注册特征的条目按常驻处理并告警一次。页面预填和审计用全量（`proofreadPromptFor(...).system`）；只有发请求时才按行裁剪，`TRANSCOMPARATOR_FULL_PROMPT=1` 可退回全量。

---

## 输出侧确定性三大门禁（漏斗模型）

「提示词只能要求，确定性闸门才能保证」。结论产出之后的工序是漏斗顺序：
`ensureRevisedText` → `applyFormatGuard` → `normalizeDecisionPunctuation` → `guardTargetScript` → `decisionToResult`。

### 1. 成品格式门禁（`ai/format-guard.js`，`applyFormatGuard`）

`revisedText` 会被人工直接写回成品，结构必须严格保证：
- 一行就是一个成品段落，段数由目标列当前行给定（按 `\n{2,}` 切出的片段）。
- **三档处置**：
  1. 能确定性还原就修：并回模型插入的换行/空行/`<br>`、去掉首尾空白；目标列单段时段落分隔一并并回（中日文之间不加分隔符、两侧 ASCII 补空格）。
  2. 结构性事实对不上就作废转人工：目标列 ≥2 段而段数不一致，或 noteref 标记增减，作废 `revisedText`、置 `needsContext=true`，原因并入 `summary`。
  3. 防呆：`summary`/`suggestion` 里的换行折叠成空格，防止破坏按行解析层。
- **三条纪律**：只动结构与内联标记不动文字；修不了就转人工不猜；改动必须留痕（备注分析栏写「格式自动规范化：…」）。
- 计数走 `status.formatFixes`/`formatLineBreaks`/`formatParagraphs`/`formatNoteFields`/`formatVoids`，开关为 `formatGuard:false` / `TRANSCOMPARATOR_FORMAT=0`。

### 2. 输出侧标点规范化（`ai/punctuation.js`，`normalizeDecisionPunctuation`）

- **宽度与体例**：
  - 中文语境（标点最近的左右非空白字符里有中日文）的半角标点转全角（`，。？！；：（）`，省略号统一成 `……`）。
  - **英文句子保持半角**：反向还原要求**正向 ASCII 证据**（标点紧邻的左右字符都是字母/数字，或一侧是、另一侧是行边界且整段无汉字/假名）。纯标点行或拟声行不会被误判为英文。
  - 中文语境可配对双引号转直角引号：`“…”` 与 `"…"` → `「…」`；无法配对或英文语境弯引号作废整条修订转人工（`status.punctQuoteVoids`）。
  - 紧贴 ASCII 字母/数字的点豁免（`3.5`、`e.g.`、`S1_01`）。
  - 内联标记（`<ruby>`/`<rt>`/`<a epub:type="noteref">`）先摘后还原。
- **成对标记内侧句末点号还原**（`restoreTerminalPunctuation`）：
  - 中文规范要求完整句末点号在收尾标记内侧，日文常在收尾前省略。若模型误删，确定性补回。
  - 判据四条同时成立：被删段是单独一个 `。！？`；目标列里紧跟收尾符号（`」』）】〕`）；该收尾符号在修订结果仍在原位；补回后不连成「。。」。
- 留痕与计数：备注分析栏写「标点自动规范化：…」，计数走 `status.punctFixes`/`punctToFull`/`punctToHalf`/`punctQuotes`/`punctQuoteVoids`/`punctRestored`，开关 `punctNormalize:false` / `TRANSCOMPARATOR_PUNCT=0`。

### 3. 输出侧语言护栏（`ai/ai-proofread.js`，`guardTargetScript`）

- 目标列当前行**本来不含假名**而 `revisedText` 含假名时，作废修订结果、置 `needsContext=true`（待人工确认）、备注写明原因。
- 拦截诱因：原文有注音而目标列没有时模型照抄读音，或上下文轮把相邻行原文当成可复制文本。
- 计数走 `status.scriptLeaks`。

---

## 档案注册与叠加规范

- 档案通过 `profiles/index.js` 注册（`listProfiles`/`resolveProfile`，未注册回落 `DEFAULT_PROFILE_ID`）。内置档案为 `profiles/novel.js` 与 `profiles/demo.js`；用户档案走 `profiles/local/*.js` 或环境变量 `TRANSCOMPARATOR_PROFILE_FILES`。
- 本机档案走**叠加**：文件写 `{ extends: "<既有 id>", ...差异字段 }`，合并后沿用基底 id（`name`/`summary`/`speechHabitScope` 覆盖，`sections` 按标题追加/替换，`termTables`/`speechTables` 合并去重）。
- 档案 id 是稳定槽位，文档与测试一律按 id 引用档案。
- 作品相关具体内容集中在 `profiles/demo.js` 与 `text-utils.js` 正文边界清单；测试夹具优先使用中性人名。

---

## 译名对照表与注音口径（`ai/term-table.js`）

对照表由 `ai/term-table.js` 在预处理阶段查表，按 `evaluateTermRow` 四类结论分流：
1. **`term-only`**：整行只有术语，直接出结果，**跳过模型**。
2. **`consistent`**：术语一致但整行不止术语，注入术语后交模型。
3. **`advisory`**（存疑）：命中基文全是假名，可能为普通词，注入术语交模型结合上下文判断。
4. **`conflict`**：强证据差异，注入冲突线索后照常交模型；并在预筛阶段豁免规则/相似度预筛。

### 判定口径与注音规则

- 判定门槛为 `TERM_STRONG_MIN_LENGTH`（3 字）。2 字词、读音别名、分段别名只能确认一致，不能指控译名错误。
- 表里原文列的 `【】` 仅用于注音定位，匹配与展示一律用去括号的 `plainSource`/`plainTarget`。
- **注音条目双侧证据**：非人名条目声明注音时，原文侧需有注音对或正文出现注文，译文侧需注在中文译名上或注音内容为该读音。两侧同时成立为 `full`，仅一侧或无证据则降级为 `demoted`（只作一致性证据，不指控、不计入覆盖率）。人名条目（`PERSON_TYPE`）豁免双侧注音要求。
- 口径变化必须递增 `TERM_LAYER_VERSION`（当前为 **8**）。
- 判定分工：构建期算一次落盘到 `translation-compare.json` 顶层 `termPrefilter`；运行期交叉校验命中集合与跳过集合。

---

## 低分归因层（`ai/low-score.js`）

排在模型轮之后、线上查证之前：对照表 → 模型 → **低分归因与修复** → 线上查证 → 待人工。
- 解决极低分在逐行视角下原因不同的问题（整行错位、互换、残片、代词省略等）。
- **触发条件**：`needsEdit=true`、非 `needsContext`/`unclear`、扣分达 `lowScorePenalty`（默认 60，score ≤ 40）、前后至少有一行可供复核。不用档位兜底。
- **纪律**：错位必查（核对相邻行配对）；**原文行序不动**（禁止建议对调两行译文）；上下文优先（归因不了继续补行）。
- 归因结论写在备注分析栏（`分析：` 之后、「修改结果：」之前）。开关 `lowScoreCheck:false` / `TRANSCOMPARATOR_LOW_SCORE=0`，窗口 `lowScoreRows`（1–4）。

---

## 线上查证层（`ai/web-lookup.js`）

排在低分归因之后、转人工之前：
- 档案声明 `wikiSites`（有序：声明顺序即查询顺序）。
- **触发条件**：本行有 `advisory` 命中（假名写法存疑），且模型返回 `needsContext`/`unclear` 且已补过相邻行。
- **执行方式**：程序分轮驱动，一轮只给一个站点，最后一轮为自行检索，最多 4 轮。模型定论后立即 break。
- **纪律**：不给直达链接，只给站点入口与词条名；本机不抓网页；不许凭记忆猜；只发术语名与片段。开关 `webLookup:false` / `TRANSCOMPARATOR_WEB_LOOKUP=0`。

---

## 说话习惯与说话人判断层

- 章级判定与模型无关，构建期算一次落盘到 `translation-compare.json` 顶层 `speechHabits` 块；指纹过期才回退现算。改动判定语义递增 `LAYER_VERSION`（当前为 **5**）。
- **按角色收窄**（`speechHabitBlockForRow`）：单行提示词只带“本行提到了该角色”或“本行原文出现了其任一口癖”的角色规则。收窄单位为角色而非单条口癖。
- **口癖位置判据**（`hasHabitOccurrence`）：句末语气词必须落在句末；单字汉字口癖必须落在词首；判定前先剥掉注音标记。
- 说话习惯表支持表格文件与内化模块两种形态，示范档案内化在 `profiles/demo.js` 中。`-` 是明确不作特殊处理，保留为 `noSpecialHandling`。
- 说话人判断段里“只作线索”的候选按真实原因（`clue-only`、`none`、`locked`）分组说明。

---

## 上下文主动补充机制（请求级优化）

为避免单行孤立输入造成模型误判，基础轮在以下形态下主动补充相邻行：
1. **引语跨行合并前置**（`findSpeechMergeContext`）：日文原文为未终结接续片段，中文译文末尾引入言语动词（如“叹了口气问道”），主动补同章下一行，避免误判增译。
2. **承接重复开头**（`findContinuationContext`）：短行是下一行开头的先现（如 `それは。` → `それはとても…`），主动补下一行，禁止当独立句另译。
3. **零主语代词承接**（`findInferredSubjectContext`）：日文省略主语而中文依前文补出第三人称代词，主动补前序 1~2 行，避免臆测主体或误判擅改。

---

## 阶段编排：起点 + 下游配置（`stagePlan` / `runQueue`）

三阶段（Gatekeeper 初审 → Stylist 文学复审 → Arbiter 终审仲裁）的编排只有两个输入，都由 `stagePlan` 归一：

- **起点**：`targetStage` = `stage1`/`stage2`/`stage3`。`all` 是旧客户端的兼容别名，等同 `stage1`。
- **这条流水线有几段**：配了 `stylistConfig`（或 `singleModelPersona`）才有复审段；配了 `arbiterConfig`（或 `singleModelPersona`）且 `arbiterEnabled !== false` 才有仲裁段。仲裁只能接在复审后面，所以从阶段一起步时必须先有复审，才谈得上仲裁。

行为统一为**「从起点一路推进到已启用的尽头」**，没有「级联 / 不级联」的模式开关：

| 起点 | 配了复审 | 配了仲裁 | 实际行为 |
| --- | --- | --- | --- |
| stage1 | 否 | — | 只跑初审 |
| stage1 | 是 | 否 | 初审 → 复审 |
| stage1 | 是 | 是 | 初审 → 复审 → 仲裁 |
| stage2 | — | 否 | 只跑复审 |
| stage2 | — | 是 | 复审 → 仲裁 |
| stage3 | — | — | 只跑仲裁 |

阶段之间靠内存队列衔接，谁都不等前一阶段整体收尾：`executeStage1` 每完成一行，判定 `isNeedsEdit || isUnclearOrNeedsContext` 即把 `s1` 对象**直接**推入 `stage2Pending`（无损，保留 `lowScore` 与完整 decision）；`executeStage2` 判定 `arbCheck.triggered` 即把 `s2` 推入 `stage3Pending`。三个阶段各有独立的并发控制器（`s1Ctrl`/`s2Ctrl`/`s3Ctrl`）、独立的退避窗口与智能并发上探；`dispatch()` 每轮按 **stage3 → stage2 → stage1** 的顺序排空，让已经产生的分歧行尽快收口。

### 独立阶段二/三的队列来源

`stage2`/`stage3` 起点的队列在 `startProofread` 里按行筛选（`isStage2Candidate` / `isStage3DisputeRow`），行的上一阶段结论有两个来源，**优先内存**：

1. **复用上一轮的内存结论**（`reusePreviousResults`）：要求 `targetStage` 是 stage2/stage3、`status.results` 非空、且上一轮的 `projectKey` 与 `rowsSignature` 与本次完全相同。跨项目或重新对齐后行号对不上，绝不复用。
2. **从备注文本反推**（`reconstructStage1Result`/`reconstructStage2Result`）：有损路径——`lowScore` 恒为 `null`、`score` 用 `80` 兜底、`better` 靠「参考/对照」字样反推。服务重启、切换项目、重新对齐后只能走这条。

### 单任务互斥与客户端契约

- **服务端同一时刻只允许一个 AI 任务**：`startProofread` 遇到 `status.running` 直接抛 `RUNNING`（HTTP 409）。所以「阶段二不必等阶段一整体结束」只能靠**同一个任务内的队列级联**实现，无法在中途把阶段二追加到正在跑的初审任务上；客户端也不得退回到「排队等前一阶段收尾、再起第二个任务」的默认路径。
- **客户端三个「开始」按钮只报起点**，级联范围由服务端算。`clientStatus()` 如实回报 `stageMode`（起点）与 `stageCascade`（`{ toStylist, toArbiter }`）；客户端刷新页面后本地状态会丢，按钮态一律以这两个字段为准——级联运行中三个「开始」全禁用、三个「停止」全可用（停的都是同一条流水线）。
- 当前流水线已经覆盖某个下游时，客户端再点那一段只提示「已包含在当前流水线中」，不进入排队。
- `continueOnly` 的跳过口径随覆盖范围变化：**一路推进时**整行必须走完从起点往下的所有阶段才算处理过——已终审、复审已定案、初审明确通过且非复审候选都算走完；`提交仲裁`/`升级仲裁` 是复审的**中途态不是结论**，有分歧却还没仲裁的行、初审提改却还没复审的行都必须留在流水线里。只跑单阶段时才用「本阶段已处理」的宽松口径。
- 运行中的「复审数 / 立场分布」用 `stagePipelines.stage2.reviewed` 与 `.attitudes` 的**实时计数**显示（复审一结束就 +1，不等仲裁定案），否则会出现「阶段二只复审 1 行、阶段三却在仲裁 4 行」的假象；任务结束后流水线重置，自动回落到 `stageMetrics` 的最终值。

---

## 相关测试集

修改 AI 校对与提示词逻辑必须执行：
```powershell
node --test scripts/proofread-prompt-layers.test.js scripts/format-guard.test.js scripts/punctuation.test.js scripts/term-table.test.js scripts/low-score.test.js scripts/web-lookup.test.js scripts/ai-smart-concurrency.test.js scripts/speech-habit-layer.test.js scripts/speech-habit-source.test.js
```
