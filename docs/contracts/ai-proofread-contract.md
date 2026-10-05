# AI 辅助校对与提示词分层契约

本文档是 `AGENTS.md` 中关于 AI 辅助校对系统（`src/workbenches/translation-compare/ai/`）及相关处理逻辑的详细领域契约。

## 模块定位与职责划分

- `src/workbenches/translation-compare/ai/` 的预筛选、提示词和校对结果属于翻译工作台；共享 AI 传输、连接配置、任务队列与基础 JSON 提示契约已位于 `src/ai/`。目录所有权与跨工作台依赖见 [module-boundaries.md](module-boundaries.md)，共享层不得引入领域 rows、notes 或任务运行状态。
- 共享 LLM 传输层只能请求 `http:`/`https:`，不得接受带用户名/密码的 URL，必须拒绝云元数据、link-local、多播和未指定地址，并禁止自动跟随重定向；本机 Ollama 的回环地址仍属于允许范围。HTTP 200 后读取响应体若发生 `terminated`、`socket hang up`、`UND_ERR_SOCKET` 等流中断，只在传输层对完整请求做最多两次短退避重试；HTTP 错误、超时、JSON 格式错误和调用方取消不得走这条重试。重试成功的断流不进入阶段错误、熔断或并发下调；重试耗尽才交给既有网络异常与并发调度口径。
- 模式契约按 `proofread-contract.js` 的 `modeSchemas` 裁剪：双语对外只用 `decision=keep|replace|unclear` 表达结论、不出现 `better`/`counterpart`，三语保留 `better=target|counterpart|neither|unclear`；解析层把 `keep`/`replace` 归一为内部 `target`/`neither`，双语下 `counterpart` 也归一到 `neither`，旧提示词里的 `better` 必须继续可用。

---

## 共享传输层的等待预算与错误证据

- 非流式模型生成共用 `src/ai/llm-client.js` 导出的 `MODEL_RESPONSE_TIMEOUT_MS`，默认 5 分钟；翻译校对包装层与其他模型调用方不得各自硬编码另一份默认值。计时从发起 HTTP 请求开始，到响应体完整读完为止，包含等待响应头和读取正文；出站地址安全校验不占这段预算。模型列表与连通性测试继续显式使用各自的短超时。
- 本机计时器主动截止时，错误码为 `REQUEST_TIMEOUT`，错误对象携带 `timeoutPhase`（`waiting_response` / `reading_body`）、`timeoutMs`、`elapsedMs`、`receivedHeaders` 与 `httpStatus`，诊断文案必须保留所处阶段及已收到的 HTTP 状态。`waiting_response` 只表示本机尚未收到响应头，不能据此断言请求未到达提供商；`reading_body` 表示已收到响应头、完整正文仍未读完。
- 本地超时与调用方取消必须区分，取消优先按 `ABORTED` 收尾。超时不得走响应流中断重试或阶段自动重试：中止本机等待不能证明上游停止生成，重发可能产生重复计费；失败行由用户选择继续处理。
- 收到非成功 HTTP 状态后，即使读取错误正文发生超时或断流，也必须保留 `HTTP_ERROR`、`httpStatus` 和响应头中的 `Retry-After`，不得改报 `REQUEST_TIMEOUT` 或进入成功响应的断流重试。尤其是 429/503 的限流证据和 401 的认证证据必须继续交给既有分类、退避及致命错误门禁。

验证：`node --test scripts/ai-connectivity.test.js scripts/ai-model-timeout.test.js scripts/ai-error-kinds.test.js scripts/ai-smart-concurrency.test.js`。

## 模型能力与思考档位

- `ai/model-capabilities.js` 是两端能力识别的唯一实现；`browserModelCapabilitiesSource()` 将清单与纯解析函数、显式依赖注入翻译比较和说话人工作台，不带网络调用或服务端缓存。`workbench-shared.js` 不得另写一套模型正则。
- 能力优先级为内置人工清单、端点声明、models.dev、名称启发式、保守默认。端点读取 `reasoning_supported_efforts` / `reasoningSupportedEfforts` / `reasoning_efforts` / `reasoningEfforts` 及 `reasoning_options` 中 effort 类型的 values；没有声明档位的推理模型只允许模型默认，不臆造 low/medium/high。
- 名字匹配可剥显式区域前缀、vendor 前缀及档位变体后缀，但请求与显示 ID 不变。`max` 模型档和 Ollama 冒号标签不得误剥。网关在 models.dev 未注册时先查可识别的上游厂商，再跨提供方查找。
- Gemini 3.8 Flash 路由清单限定 low/medium/high；客户端、配置清洗、子阶段、角色上下文及请求体均遵守该档位集，思考参数不能错误映射成 temperature。
- 预设与全局/项目配置通过 `modelMetadata` 保存能力白名单；浏览器恢复时继续核对模型列表的接口地址，并在切换连接后清除旧能力。请求携带的 `modelMeta` 必须与当前模型 ID 完全相同才参与解析；各阶段从自己的预设选择能力，禁止借用主配置的同名模型能力。
- 回归：`node --test scripts/ai-model-capabilities.test.js scripts/ai-provider-config.test.js scripts/translation-module-boundaries.test.js`，修改共享浏览器规则后还须运行 `npm test`。

## 提示词五层组装体系

本文规定提示词的**五层**组装契约，`proofread-contract.js` 顶部保留与实现同步的摘要，任何模块都不得另立一套口径：

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
  → 阶段结论分发（尚未终审的存疑行待终审；终审仍存疑才待人工）。
- **两者的对应关系**：
  - 对照表对应第 ④ 层的术语段；
  - 模型基础轮与上下文轮对应第 ①②③⑤ 层加相邻行；
  - 极低分复核对应第 ④ 层的低分归因段；
  - 线上查证对应第 ④ 层的线上查证段；
  - 输出侧三步（成品格式门禁、标点规范化、语言护栏）都是结论产出**之后**的确定性工序、不读提示词，不对应任何一层；终局为待人工时不注入任何新层。
- 新增任何一层/一段时，更新本文及代码顶部摘要；`AGENTS.md` 只维护契约入口，用户可观察行为改变时才更新 README 的功能说明，避免复制一套分层细则。

### 分层纪律与前缀表

- 第 ④ 层的段一律经 `proofread-contract.js` 的 `dynamicBlockPrefixes` 剥离后再注入，段首标记由各自的注入层定义并导出（`TERM_BLOCK_PREFIX`、`speechHabitPrefix`、`【说话人判断（`、`LOW_SCORE_PREFIX`、`WEB_LOOKUP_PREFIX`），**新增动态段必须同时登记到那张前缀表**，否则自定义提示词里的旧段会残留成两份。
- 段内顺序按“由内到外补充资料”排列：术语命中 → 说话习惯 → 说话人判断 → 低分归因（相邻行）→ 线上查证。实现将说话习惯与说话人判断合成一个 `speechHabitBlock` 参数，二者仍是独立的动态段。
- **同一条判据只写一层**：字段默认值、档位定义、needsContext 口径、片段处理只写在通用侧；`modeSchemas` 只负责“键名 + 类型/枚举”（不重复定义档位，也不用分数区间描述 grade）；特化档案不复述任务契约；说话人判断口径只由动态段 `speakerCheckBlock` 自己带。
- **不要在别的层里复述固定尾巴的段首标记**：`硬性格式约束`、JSON 约定行这些字面量在最终提示词里必须唯一。
- **不要引用动态段**：`【说话习惯】`/`【说话人判断】` 这两段只在命中该章/该行时才存在，档案里不要写“判断依据见【说话习惯】段落”。
- `modeSchemas` 是每一行都要重发一份的对象（在 user 载荷里），它只留键名与类型/枚举，把含义留在系统提示词或命中的动态段里。

---

## 特化档案与按行裁剪（Row Features & Entity Gating）

### 规范来源与同步义务

第 ③ 层的规范正文**不在本仓库**：上游 index-X 的 `docs/translation-spec.md` 是成品层的翻译与语言规范正文（标点与字形、成对标记与句末点号、注音与译注、语气词与拟声词、语义、译名、证据边界），`tools/check_translation_spec.py` 的 `P1`–`P15` 是同一规范的机器检查实现；`translation-name-selection-spec.md` 管译名在候选之间怎么取舍，`translation-name-rulings.md` 是已生效裁定的总表，`x-translation-differences.md` 是与维基译名表的人为固有差异（属取舍，不得按表回改）。

`profiles/novel.js`（通用成品规范）与 `profiles/demo.js`（作品取值）是同一规范在 AI 校对层的实现，属上游声明的「规范正文 → 机器检查 → AI 档案」三处同步之一：上游改规范要同步这里的条目，这里补条目也要回头校准 `translation-spec.md` §七 的「AI 档案」列。三处口径不一致时以上游规范正文为准。逐条对应关系见 `translation-spec.md` §七；其中 `P12`（单个省略号）与 `P15`（异形词）有意不在 AI 档案里单列。

第 ③ 层分**三种**条目形态（写法与选择标准写在 `profiles/novel.js` 文件头）：
1. **字符串**＝常驻（语义判断类：遗漏信息、否定时态、译名一致性、作品专有写法、证据边界）。
2. **`{ text, features: [...] }`**＝按行条目（离开特定版式/文字现象就无从谈起的规范：注音、傍点加粗、译注标记、分页图片、空行、省略号、「！？」、引号用途、括号与成对标记内侧的句末点号、间隔号与西文缩写、连接词衔接、拟声词语气词、数字单位）。拿不准就写常驻。
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
  - `middleDot` 只探测**目标列**的间隔号与西文缩写（中文间隔号 `·`、日文点号 `・`、字母后的下脚点）：原文（日文）里的 `・` 本来就是日文点号，拿它触发会把整卷人名行都算进来，而这条规范管的是中文成品怎么写。
- **实体闸门**（`ai/name-entities.js`）：档案用 `characters: ["甲野一郎"]` 声明适用范围，`detectRowEntities({ source, target, entities })` 命中才注入。
  - 声明名单只能由档案给出；
  - 探测不出按命中；
  - 长别名优先；
  - 必须能审计（走 `profileLineStats().entityGated/entitySkipped`、`promptLayerReport().entities` 与 `promptTrimSummary()`）。
- `profiles/index.js` 的 `normalizeLine` 必须保留对象形态；声明了未注册特征的条目按常驻处理并告警一次。页面预填和审计用全量（`proofreadPromptFor(...).system`）；只有发请求时才按行裁剪，`TRANSCOMPARATOR_FULL_PROMPT=1` 可退回全量。
- **常驻条目直接抬高每一行的成本**：`scripts/proofread-prompt-layers.test.js` 的「真实行样本保持压缩后的请求预算」用实测最坏行（带成对标记的 demo 行）锁定 system ≤ 4400、单行请求 ≤ 5300。新增规范时优先挂到按行特征上；确实要常驻的按实测值同步改基线，并在测试注释里写明本次新增了哪几条。

---

## 输出侧确定性三大门禁（漏斗模型）

「提示词只能要求，确定性闸门才能保证」。结论产出之后的工序是漏斗顺序：
`ensureRevisedText` → `applyFormatGuard` → `normalizeDecisionPunctuation` → `guardTargetScript` → `decisionToResult`。

### 1. 成品格式门禁（`ai/format-guard.js`，`applyFormatGuard`）

`revisedText` 会被人工直接写回成品，结构必须严格保证：
- 一行就是一个成品段落，段数由目标列当前行给定（按 `\n{2,}` 切出的片段）。
- **三档处置**：
  1. 能确定性还原就修：并回模型插入的换行/空行/`<br>`、去掉首尾空白；目标列单段时段落分隔一并并回（中日文之间不加分隔符、两侧 ASCII 补空格）。
  2. 结构性事实对不上就作废转终审：目标列 ≥2 段而段数不一致，或 noteref 标记增减，作废 `revisedText`、置 `needsContext=true`，原因并入 `summary`；最终状态按「待人工确认只能由终审分发」一节决定。
  3. 防呆：`summary`/`suggestion` 里的换行折叠成空格，防止破坏按行解析层。
- **三条纪律**：只动结构与内联标记不动文字；修不了就转终审不猜；改动必须留痕（备注分析栏写「格式自动规范化：…」）。
- 计数走 `status.formatFixes`/`formatLineBreaks`/`formatParagraphs`/`formatNoteFields`/`formatVoids`，开关为 `formatGuard:false` / `TRANSCOMPARATOR_FORMAT=0`。

### 2. 输出侧标点规范化（`ai/punctuation.js`，`normalizeDecisionPunctuation`）

- **宽度与体例**：
  - 中文语境（标点最近的左右非空白字符里有中日文）的半角标点转全角（`，。？！；：（）`，省略号统一成 `……`）。
  - **英文句子保持半角**：反向还原要求**正向 ASCII 证据**（标点紧邻的左右字符都是字母/数字，或一侧是、另一侧是行边界且整段无汉字/假名）。纯标点行或拟声行不会被误判为英文。
  - 中文语境可配对双引号转直角引号：`“…”` 与 `"…"` → `「…」`；无法配对或英文语境弯引号作废整条修订转终审（`status.punctQuoteVoids`）。
  - 紧贴 ASCII 字母/数字的点豁免（`3.5`、`e.g.`、`S1_01`）。
  - 内联标记（`<ruby>`/`<rt>`/`<a epub:type="noteref">`）先摘后还原。
- **成对标记内侧句末点号还原**（`restoreTerminalPunctuation`）：
  - 中文规范要求完整句末点号在收尾标记内侧，日文常在收尾前省略。若模型误删，确定性补回。
  - 判据四条同时成立：被删段是单独一个 `。！？`；目标列里紧跟收尾符号（`」』）】〕`）；该收尾符号在修订结果仍在原位；补回后不连成「。。」。
- 留痕与计数：备注分析栏写「标点自动规范化：…」，计数走 `status.punctFixes`/`punctToFull`/`punctToHalf`/`punctQuotes`/`punctQuoteVoids`/`punctRestored`，开关 `punctNormalize:false` / `TRANSCOMPARATOR_PUNCT=0`。

### 3. 输出侧语言护栏（`ai/ai-proofread.js`，`guardTargetScript`）

- 目标列当前行**本来不含假名**而 `revisedText` 含假名时，作废修订结果、置 `needsContext=true`、备注写明原因；最终状态按终审是否已执行分流。
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

排在模型轮之后、线上查证之前：对照表 → 模型 → **低分归因与修复** → 线上查证 → 输出门禁与阶段结论分发。
- 解决极低分在逐行视角下原因不同的问题（整行错位、互换、残片、代词省略等）。
- **触发条件**：`needsEdit=true`、非 `needsContext`/`unclear`、扣分达 `lowScorePenalty`（默认 60，score ≤ 40）、前后至少有一行可供复核。不用档位兜底。
- **纪律**：错位必查（核对相邻行配对）；**原文行序不动**（禁止建议对调两行译文）；上下文优先（归因不了继续补行）。
- 归因结论写在备注分析栏（`分析：` 之后、「修改结果：」之前）。开关 `lowScoreCheck:false` / `TRANSCOMPARATOR_LOW_SCORE=0`，窗口 `lowScoreRows`（1–4）。

---

## 线上查证层（`ai/web-lookup.js`）

排在低分归因之后、输出门禁与阶段结论分发之前：
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

阶段之间靠内存队列衔接，谁都不等前一阶段整体收尾：`executeStage1` 每完成一行，判定 `isNeedsEdit || isUnclearOrNeedsContext` 即把 `s1` 对象**直接**推入 `stage2Pending`（无损，保留 `lowScore` 与完整 decision）；`executeStage2` 判定 `arbCheck.triggered` 即把 `s2` 推入 `stage3Pending`。每个阶段配多个预设时，**每个预设是一条独立并发通道**（`ai/preset-pool.js` 为每条通道读取 `channel.currentConcurrency` 作为配额），阶段可派发量 = 各通道当前允许并发之和，`cleanConfig` 必须原样保住 `presetPool`/`stylistPresets`/`arbiterPresets` 里的连接参数与 `presetId`/`name`；单预设时退化回那一条通道。**运行中增删预设**经 `POST /api/ai-proofread/presets` 进入 `updateStagePresets`：池的版本变化触发整队重算绑定，新预设立刻派活、被删预设的待审行立刻改派，在飞请求不打断；删空回落到该阶段配置。阶段控制器（`s1Ctrl`/`s2Ctrl`/`s3Ctrl`）只保留阶段级退避窗口、单行重试计数与断路器，各阶段的并发上探与下调落在行所属的通道上（自适应调度与热更新的细则见 [workbench-notes-spaces.md](workbench-notes-spaces.md)「并发上限与内部自适应调度」，与熔断的联动也在那里）；`dispatch()` 每轮按 **stage3 → stage2 → stage1** 的顺序排空，让已经产生的分歧行尽快收口。

### 「待人工确认」只能由终审分发

`decisionToResult` 里 `needsContext || better === "unclear"` 的出口**区分两种结论**，判据是这一行有没有走到终审（`decision.arbitration` 存在，或 `decision.stage === "arbiter"`）：

- **走过终审** → `是否需要修改：待人工确认`。终审是唯一有资格把一行判给人工的阶段。
- **没走到终审** → `是否需要修改：待终审`。它既不是终局结论，也不该冒充终审的判决。前端把它单独计成 `finalPendingArbiter`（徽章「待终审」），**不混进** `finalNeedsCheck`（徽章「待确认」）；行内审核轨迹显示「待终审」，不再说「终审定案为待人工确认」。服务端同一口径见 `ai/stage-results.js` 的 `isPendingArbiterResult` / `computeResultMetricsDelta`。

配套两条纪律，缺一条这个口径就会被绕过：

1. **复审「采纳」必须定案**：`runStage2Stylist` 在 `attitude === "accept" && decision.stage1RevisedText` 时要把 `better` 一并改成定案值（双语 `neither`、三语 `counterpart`）。初审判「存疑」时 `better` 是 `unclear`（`normalizeDecision` 对「结论说不用改、分析里却说要改」的保守归类），只清 `needsContext` 会让这个残留值把已经定案的行写成「待人工确认」——而它根本没走到终审。
2. **存疑未解除必须升级终审**：`shouldTriggerArbitration` 的第 5 条判据是「初审存疑（`needsContext` / `better === "unclear"`）且复审没能解除它」。复审「采纳初审改案 / 给出自己的改案 / 驳回」都算解除；只表态采纳、手里却没有任何可用改案的行不算——那种行既没有定案依据，也不该由复审直接甩给人工。

**措辞纪律**：程序写进备注分析栏的兜底文案（格式门禁作废、语言护栏作废、标点作废、模型拒答、低分归因与线上查证兜底）一律说「转终审确认」「已作废，等待终审裁决」「已自动跳过并标记待终审」，不再说「转人工确认」——后者只属于终审自己的 unclear 判决（`ai/arbiter.js` 里终审判定 unclear 的说明文案，以及终审提示词里 `finalDecision=unclear` 的定义）。

### 独立阶段二/三的队列来源

`stage2`/`stage3` 起点的队列在 `startProofread` 里按行筛选（`isStage2Candidate` / `isStage3DisputeRow`），行的上一阶段结论有两个来源，**优先内存**：

1. **复用上一轮的内存结论**（`reusePreviousResults`）：要求 `targetStage` 是 stage2/stage3、`status.results` 非空、且上一轮的 `projectKey` 与 `rowsSignature` 与本次完全相同；项目或真实行集变化后不得复用，重新发布相同行集不因此失效。逐行还须满足下节的备注快照约束。
2. **从备注文本反推**（`reconstructStage1Result`/`reconstructStage2Result`）：有损路径——`lowScore` 恒为 `null`、`score` 用 `80` 兜底、`better` 靠「参考/对照」字样反推。服务重启或缺少满足作用域与备注约束的内存结论时走这条。

### 当前轮次备注与待办的唯一判据

- `ai/stage-note-state.js` 是当前轮次备注与阶段待办判定的共享实现，由构建器序列化到页面。统计、点击筛选、启动弹窗、续跑跳过和服务端队列都读取最新 `[AI校对]` 块，历史块不参与本轮完成判断；人工确认行不计待办。
- 请求携带备注快照时，内存结论还须与该行最新块一致才可复用；已清空或不在备注快照里的行不得借旧内存重新入队。
- 阶段二/三清空重跑只修改最新块，保留历史块与人工备注。复审完成读 `.reviewed`，仲裁完成读 `.arbitrated`；阶段名、调用异常行或历史结论都不是本轮完成证据。
- `splitAiNoteParts` 按轮次标记与结构化字段收齐记录，字段内部空行不得截断本轮复审或仲裁。备注没有结束标记，末尾「修改结果」续段仅在与独立阶段改案完整匹配时纳入；无匹配证据的人工尾注仍隔离。`splitNoteFields` 为客户端显示、服务端重建和阶段清空提供完整字段，保留多段改案的换行与空行，清空时不得留下下游字段续文。
- 旧空行截断导致 `revisionText` 与 `revisionTarget` 均为空的未人工确认记录，载入时可从完整最新块恢复改案；有目标列的人工清空、非空人工改案与人工确认记录不得被此恢复覆盖。

验证：`node --test scripts/stage-note-state.test.js scripts/multiline-stage-notes.test.js scripts/ai-smart-concurrency.test.js`。

### 级联续跑（`collectResumedStage2`）

从阶段一起步、配了复审、且本次是「继续剩下的」（`continueOnly`）时，**已经有初审结论、只差复审的行直接进复审队列**，不再重跑初审：

- 判据是 `isStage2Candidate(noteText, memoryResult)` 成立、且 `stageNoteState(noteText).reviewed`、`.arbitrated` 与 `memoryResult?.stylistReview` 均不成立；不能用 `includes("Stylist复审")` 把异常留证或历史块当成已完成。
- 这些行从初审队列里摘掉（`resumedStage2.indexes`），与初审刚产出的行走**同一个** `stage2Pending`、同一套并发控制器与退避窗口。
- 对照表已经直接定案的行（`resolvedByTermTable`）不续跑，否则会白花一次调用。
- **没有这一步**，界面上「待复审 N 行」只能等初审把它们重新产出一遍，复审并发配得再高也派不出活来（现象：并发 20、实际只有 1 处理中，一行一行慢慢审）。
- 「从未人工确认处开始」（`continueOnly: false`）不走续跑：前端已经把这些行的备注清掉了，本来就没东西可续。

### 阶段异常不得静默吞掉

级联续跑时，`collectResumedStage3` 把已有复审结论、仍待仲裁的行直接交给 `stageItems.stage3`，从阶段一或二起步都不得重复上游或跳过它们；初始仲裁队列与其它初始队列一并计入 `status.queued`。仲裁条目优先复用带完整 `decision.stylistReview` 的内存结论；内存只留汇总 `stageResult` 时必须从最新备注重建复审意见与方案，不能把初审方案误当复审稿。`stageNoteState` 的复审候选包括「待终审」，即使初审没有提出改案、摘要也不含「存疑」字样。

`runStage2Stylist` / `runStage3Arbiter` **不在自己内部吞异常**：它们把错误挂在返回值的 `stageError` 上，由 `executeStage2` / `executeStage3` 统一 `throw`，再走那两处的标准错误处理——频控时重试、其余计入 `stage2Errors`/`stage3Errors` 并回退到上一阶段的方案。

- 反过来做（内部 `catch` 后只 `pushLog` 就回退）会让这一行**在指标上凭空消失**：既不算复审/仲裁，也不算异常。用户看到的就是「阶段三处理了很多行，定案数却一直不动、异常还是 0」。
- `proofreadRow` 的单行路径仍会拿到带 `stageError` 的返回值，调用方自行决定处置。

### 异常分类明细（悬停展开）

卡片上的「异常」只是数字，用户还需要知道**到底出了哪些问题**。因此异常在计数之外另存一份明细：

- **服务端**：`status.stageErrors`（阶段 → 行号 → `{ kind, message }`），随 `clientStatus().stageErrors` 回报聚合后的 `{ [kind]: { count, rows, sample } }`。记录点与计数同源：初审在两条失败 `addResult` 之前，复审/仲裁在 `stageNErrors += 1` 的同一处。
- **重跑要撤旧账**：`executeStage1/2/3` 进入时先 `clearStageError(阶段, 行号)`，成功即不再补记。只在失败处新增而不清除的话，一行重跑成功后旧明细会一直挂在悬停提示里。
- **三阶段统一保留未解决异常**：初审失败仍写独立失败备注；复审/仲裁失败在回退方案的当前 `[AI校对]` 块内写 `Stylist复审调用异常：…` / `Arbiter仲裁调用异常：…`，消息压成一行、置于「修改结果」之前，保留上游结论与成品正文。`stageNoteState().errors` 为统计与分类提供共享证据；下游失败不等于整行初审失败，继续留在对应待办队列。成功的新块不带失败标记，旧块退出本轮统计；清空重跑移除对应阶段及下游的失败标记，人工确认行与历史块保留。下游取消与初审一致记作 `stopped`，备注包含「校对已终止」。
- **分类规则只有一份**：`ai/error-kinds.js` 是纯函数模块，服务端直接 `require`，构建器把常量与函数 `.toString()` 注入页面（见 `render-workbench.js`）。判定顺序有语义：拒答不算接口故障、503/529 算频控而非 5xx、非 JSON 响应优先于网络故障；客户端拿不到 `httpStatus`，用消息里的三位状态码兜底（`域名解析失败` 与 `JSON 解析失败` 都含「解析失败」，所以 bad_response 只认限定说法）。
- **两端口径合并**：`computeStageMetricsFromNotes` 从失败备注得到本地分类（备注口径把「校对已终止。」也算失败行），`updateStageMetricsDashboard` 用 `mergeAiErrorKinds` 与服务端明细合并——**按行号去重、同一行以服务端为准**。两端观察的常是同一批行，但对同一行的归类可能不同（服务端看得到 `code`，备注只有文本），按类别取 max 会让这一行同时出现在两类里。服务端已登记的行号从本地各类里剔除，行号不重叠时取并集；行号样本有上限（`AI_ERROR_ROW_SAMPLE_LIMIT`），超出部分只有计数、无法逐行去重，同类里按 max 处理，宁可低估也不重复累加。
- **渲染**：`renderStageMetricsDashboard` 把明细写进 `stage{1,2,3}ErrorItem.title`——逐类只给「类别：N 行」，**不列行号、不带代表性消息**：悬停文本是给人看的摘要，异常定位靠失败备注与 AI 日志，把行号列进去只会把它撑成一份台账。无异常时恢复构建器写在 HTML 上的静态 title。明细里的 `rows` 只服务于上面的两端口径合并（去重键），`sample` 只随状态接口回报供排查；两者都不进悬停文本。
- **生命周期**：服务端 `stageMetrics` / `stageErrors` 仍只表示本次任务，启动新任务、清除运行记录、重启服务时清空；页面的三个阶段均从最新备注恢复仍未解决的异常，计数和分类按本地与服务端行号的并集显示。续跑不提前抹掉旧失败，成功结论到达后才解除；刷新与服务重启也遵守相同口径。旧版阶段二/三未写进备注的失败无法事后重建。
- 页面里不带服务端明细的 `updateStageMetricsDashboard()` 调用（如手动确认一行后的 `updateDoneCount`）会让数字与悬停最多失效到下一次轮询（≤1.5 秒），**不要为此在客户端另缓存一份服务端明细**：多出的状态要处理切项目、清空、换任务的失效，而收益只是一个自愈的闪动。

验证：`node --test scripts/ai-error-kinds.test.js scripts/ai-stage-metrics.test.js scripts/ai-smart-concurrency.test.js`。

### 阶段异常的三道闸门（与初审对称）

「计入异常」只解决了可见性，还必须有东西**拦住它**，否则一次配置错误就是一行行刷到队列尽头：

1. **致命请求错误当场终止**：`executeStage2` / `executeStage3` 与 `executeStage1` 一样判 `isFatalRequestError`（400/401/403/404/405/415/422 与非 JSON 响应），命中即 `stopForFatalRequestError`。缺这一条时，同一个配置错误在阶段一会立刻停下、在阶段二/三却会一直刷。
2. **非频控失败进熔断采样**：`recordStageFailure(stageKey)`；成功路径也必须 `recordStageSuccess(stageKey)`（经 `noteStageSuccess`），否则窗口里只剩失败样本，错误率虚高到 100%。限流耗尽的行不进这个窗口（见下节的限流轨）。
3. **熔断器按阶段隔离**（`stageBreakers`，每阶段一个 `createStageBreaker()`）：三个阶段各维护自己的成功/失败序列。共用一个窗口时，「初审成功 + 复审成功 + 仲裁全失败」的错误率只有约三分之一（实测 12 行里 40%），永远够不到 50% 阈值，单阶段塌方拦不住。

### 熔断是内部决策，不接受外部开关

熔断由 `ai/circuit-breaker.js`（纯函数模块，时钟可注入）裁决，策略是冻结常量 `BREAKER_POLICY`。**页面、预设、请求体都不得再携带熔断开关或阈值**：`cleanConfig` 不读 `circuitBreakerEnabled` / `circuitBreakerErrorRate`，预设的 `sanitizePreset` 会丢弃遗留的 `breakerThreshold` / `breakerDisabled`，页面里也没有对应控件（`build-compare.test.js` 断言页面不含 `aiBreaker`）。旧客户端仍带这两个字段时被静默忽略，`scripts/ai-proofread-status.test.js` 有回归。不要为了「某个场景想看完整失败」重新加开关；测试要观察大量失败，用样本数低于 10 行的场景，或用下面的时间缩放缝。

两类证据走两条独立的轨道，因为代价与可恢复性不同：

| 轨道 | 证据 | 决策 | 为什么 |
|---|---|---|---|
| 失败轨 | 非限流的真实失败（5xx、超时、断连、输出坏掉） | 最近 20 次里失败占比 ≥ 50% 且样本满 10 → **终止任务** | 每次调用都计费，且往往不会自愈 |
| 限流轨 | 429/503/529 且**单行重试已用尽**（`onStageRateLimit`） | 连续 3 行重试用尽且期间没有任何成功 → **打开断路器**：该阶段停止派发，按 30s → 90s → 4min → 10min 冷却（累计 16 分钟）；冷却后放行探测（半开），探测成功即恢复并把阶梯清零，探测再被限流进入下一档；三档用尽仍被限流 → **终止任务** | 被限流的请求会被上游直接拒掉、不计费，冷却后通常能恢复；一刀切终止会白丢进度，硬打则是无退避的死循环 |

实现要点：

- 成功样本也要重新评估窗口（成功把旧成功挤出、错误率抬到阈值时同样成立），不只看失败那一刻。
- 限流轨前两行按原逻辑记失败；第三行起进入冷却的行**不记失败**，回到队头，并把 `rowRetryCounts` 置满：再被限流就立即回报断路器，而不是再烧一轮退避。
- **与单行自动重试（`onStageRateLimit` 的 3 次退避重试）的分工**：单行重试处理「偶发限流」，用尽后才把证据交给断路器；断路器处理「持续限流」。两层不能互相绕过——重试用尽的行**必须**经 `recordLimitExhausted()` 裁决，不得直接记失败；冷却中的 `hold` 不得再触发新一轮退避重试。二者共用 `ctrl.backoffUntil` 做派发闸门（取较大值），不各自维护第二套计时。
- **半开只放行一个请求**：`dispatchLimit(ctrl)` 在断路器 `half-open` 时把该阶段派发并发压到 1。限流本身会把并发逐步下调，但下调有 800ms 间隔、每次只降一档（32 需要 7 步才到 1），断路器打开时并发往往仍很高，不设这一层冷却结束后会对着刚冷却完的上游一拥而上。
- **限流轨的解除条件是「拿到非限流的答复」**，不只是成功：探测得到普通失败（进失败窗口）或拒答（`recordNotLimited`，不进窗口）同样解除，否则半开会停在并发 1 上。恢复时经 `clearCooldownIf` 撤销 `backoffUntil` 并清零 `consecutiveLimits`（固定并发下它原本只增不减，恢复后的下一次 429 仍按最长退避）。
- 冷却期内到达的迟到结果（发出时断路器还没打开）只回队，不推进阶梯；冷却期内的迟到成功说明上游已放行，提前恢复并撤销 `backoffUntil`。
- 阶梯用尽时 `onStageRateLimit` 返回 false，让这一行沿用原有「记失败 / 回退上一阶段方案」的收尾，再由 `stopForBreakerTrip` 终止任务。
- 拒答与致命配置错误不进失败窗口：前者是上游的正常应答，后者当场终止。三个阶段一致：拒答走 `recordStageNotLimited`（只解除限流轨，不计成败）。阶段一标记待终审；阶段二/三回退到上一阶段方案，且仍如实计入 `stageNErrors`（指标口径不变，只是不再喂熔断——此前阶段二/三的拒答会被当成失败样本，一批敏感内容就能把整条流水线熔断掉）。
- `TRANSCOMPARATOR_BREAKER_TIME_SCALE` 只缩放冷却时长，供回归测试把分钟级冷却压到毫秒级，不是运行时开关。
- **冷却阶梯的取值依据**（`BREAKER_POLICY.limit.cooldownsMs`，只在这一处定义，测试与文案均从它推算）：被限流的请求由上游直接拒掉、不计费，等待只花时间不花钱，而过早放弃要人工点「继续剩下的」，所以整体宁长勿短。30s：单行退避重试用尽时已过去约 10~20 秒，再等 30 秒正好盖过常见的 1 分钟速率窗口；90s：覆盖一个完整分钟窗口再加抖动；4min、10min：中转渠道自动熔断与上游过载（503/529）常按分钟级恢复。累计约 16 分钟仍被限流，基本是额度耗尽或长时间故障，继续等没有意义。档间比约 3，探测频率随时间指数衰减。约束由 `scripts/circuit-breaker.test.js` 锁住：逐档变长、首档不低于 30s、末档不超过 10 分钟、累计不超过 20 分钟。
- 冷却时长文案统一走 `formatDuration`（不足 1 分钟按秒，整分钟按分钟，其余分秒并列），日志、终止原因与策略摘要口径一致。

终止消息带阶段名：

- 失败轨：`AI 请求错误率熔断（终审仲裁）：最近 N 次处理中有 M 次失败（X%，阈值 Y%），任务已自动终止。`
- 限流轨：`AI 上游持续限流熔断（初审）：已按 4 档冷却重试（累计等待约 16 分钟）仍被限流，任务已自动终止。……`

冷却与恢复会以 `[熔断] <阶段>：……` 写进日志。管家的「防放飞熔断」（`pipeline-butler.js`）是另一回事，只判断改稿是否偏离，与本节无关。

验证：`node --test scripts/circuit-breaker.test.js scripts/ai-smart-concurrency.test.js scripts/ai-proofread-status.test.js`。

### `stageCascade` 的语义：本次覆盖到仲裁，不是「有没有下游」

`stagePlan().cascadeToArbiter` 表示**本次流水线是否覆盖到仲裁**，客户端据此决定阶段三卡片显示「处理中」还是「未接入」：

- 从阶段一起步 = 配了复审且配了仲裁；从阶段二起步 = 配了仲裁；**从阶段三起步 = 本次跑的就是仲裁**（按 `hasArbiter` 判，与"有没有下游"无关）。
- 早期实现把「从阶段三起步」也算成 `false`，于是客户端会在**仲裁正在跑**的同时显示「未接入（本次不会执行仲裁）」——文案与事实相反。
- `runQueue` 在 `startsAt === "stage3"` 时直接按 `stageItems.stage3` 灌队列，不看这个标志，所以该字段只影响显示、不影响执行；两者必须一致。

### 旧版常驻服务的可观测性

`clientStatus().stageCascade` 是 2bb3c69 之后才有的字段。客户端在「任务在跑 + 服务端回报了 `stagePipelines`（旧版一直有）+ 没有 `stageCascade`」时，判定常驻服务是旧版，**提示一次**重启控制台服务，并让阶段三卡片显示「未接入」而不是静默的「待命」——否则用户只会看到「配了阶段三却从来不仲裁」。判据要求同时看到 `stagePipelines`，避免把精简的状态桩误判成旧服务。

### 单任务互斥与客户端契约

- **服务端同一时刻只允许一个 AI 任务**：`startProofread` 遇到 `status.running` 直接抛 `RUNNING`（HTTP 409）。所以「阶段二不必等阶段一整体结束」只能靠**同一个任务内的队列级联**实现，无法在中途把阶段二追加到正在跑的初审任务上；客户端也不得退回到「排队等前一阶段收尾、再起第二个任务」的默认路径。
- **客户端三个「开始」按钮只报起点**，级联范围由服务端算。`clientStatus()` 如实回报 `stageMode`（起点）与 `stageCascade`（`{ toStylist, toArbiter }`）；客户端刷新页面后本地状态会丢，按钮态一律以这两个字段为准——级联运行中三个「开始」全禁用、三个「停止」全可用（停的都是同一条流水线）。
- 当前流水线已经覆盖某个下游时，客户端再点那一段只提示「已包含在当前流水线中」，不进入排队。
- `continueOnly` 的跳过口径随覆盖范围变化：**一路推进时**整行必须走完从起点往下的所有阶段才算处理过——已终审、复审已定案、初审明确通过且非复审候选都算走完；`提交仲裁`/`升级仲裁` 是复审的**中途态不是结论**，有分歧却还没仲裁的行、初审提改却还没复审的行都必须留在流水线里。只跑单阶段时才用「本阶段已处理」的宽松口径。
- 运行中的「复审数 / 立场分布」用 `stagePipelines.stage2.reviewed` 与 `.attitudes` 的**实时计数**显示（复审一结束就 +1，不等仲裁定案），否则会出现「阶段二只复审 1 行、阶段三却在仲裁 4 行」的假象；任务结束后流水线重置，自动回落到 `stageMetrics` 的最终值。

---

## 结果落盘与刷新恢复（`ai/result-store.js`）

浏览器 localStorage 只有约 10 MB、且同源下所有项目共用一份，写满之后页面上的备注就只活在内存里，刷新即丢。AI 结果是可重新交付的服务端产物，所以不把浏览器存储当作它唯一的落脚点。

- **落盘位置**：`out/runtime/ai-results/<projectKey>-<rowsSignature>.json`（`storageLayout().runtimeDir` 下）。项目键与行集签名都按文件名安全字符收口，避免路径穿越。
- **写入时机**：`addResult` 后累计脏行，攒够 200 行或距上次写盘满 30 秒写一次，`finish()` 收尾时立即写（不等阈值）。整份快照一次是几 MB，若按秒级节流会在 2000+ 行的任务里写成几个 GB 的写放大。代价是进程被强杀时最多丢这一批，而「页面刷新」不受影响——任务还在服务端跑，页面重新连上继续拉。
- **合并而非覆盖**：写盘时与盘上已有结果按行号 upsert 合并。新一轮可能只跑了少数行（其余被判定为「已完成」而跳过），整份覆盖会把上一轮的结论抹掉。
- **恢复路径**：`clientStatus({ projectKey, rowsSignature })` 在「没有运行中的任务、且内存里没有任何结果」时，把落盘结果装回 `status`，并重新编号 `resultRevision`，让页面照常按修订游标增量拉取。工作台在每次状态轮询时自报这两个身份（见 `public/workbench-client.js` 的 `refreshAiStatus`）。
- **身份校验**：读盘时校验文件里的 `projectKey` / `rowsSignature` 与请求方一致，对不上就当作没有——宁可让页面显示「无结果」，也不把别的项目的结论交付出去。
- **部分清除**：清空未人工确认的某个阶段时，页面把被清除的行号提交给 `/api/ai-proofread/results/clear`，服务端只从对应项目 + 行集的落盘结果移除这些行；下一轮启动也会携带待清除行号作为失败重试兜底，不会把用户刚清掉的旧结论重新合并回来。
- **清理**：`clearProofreadCache()`（页面的「清除 AI 运行记录」）连盘上那一份一起删，否则刷新页面又会把它装回来。删除项目时同路径一并清理。
- 回归：`node --test scripts/ai-results-persist.test.js`。

---

## 相关测试集

修改 AI 校对与提示词逻辑必须执行：
```powershell
node --test scripts/proofread-prompt-layers.test.js scripts/format-guard.test.js scripts/punctuation.test.js scripts/term-table.test.js scripts/low-score.test.js scripts/web-lookup.test.js scripts/ai-smart-concurrency.test.js scripts/speech-habit-layer.test.js scripts/speech-habit-source.test.js
```
