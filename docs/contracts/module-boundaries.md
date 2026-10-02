# 模块所有权与依赖边界

本文规定当前模块归属、依赖方向与对应验证；`AGENTS.md` 负责仓库级不变量和修改纪律。算法、存储键、提示词与客户端状态的细则按下述契约入口维护，不在模块表中再定义一份。按变化原因、共享状态与可独立验证性划分职责，不按文件行数机械拆分。

## 跨目录所有权

| 范围 | 拥有的能力 | 扩展与调用边界 |
| --- | --- | --- |
| `src/core/` | 文本、表格、指纹、项目身份、原子文件与路径等基础能力 | 修改时检查所有工作台及快照调用方；不持有某工作台的 rows、notes 或任务状态 |
| `src/ingest/` | 输入选择、格式转换、正文准入、段落/派生行提取与源文件局部写回 | 通用转换扩展 `pandoc-utils.js`；格式专属业务准入独立实现；转换层不决定正文边界 |
| `src/storage/` | 项目 staging、快照发布/保留、活动指针和产物定位 | 发布与重渲染遵守 `AGENTS.md` 的快照不变量；不把浏览器备注空间纳入项目产物模型 |
| `src/runtime/` | 常驻服务、鉴权、HTTP 路由、任务生命周期与输入持久化 | 子模块不反向依赖服务入口；任务实现仍由各工作台拥有 |
| `src/ai/` | 共享连接配置、LLM 传输、通用任务队列与基础 JSON 提示契约 | 不引入领域结果模型或任务运行状态；传输安全、超时与重试细则见 [AI 契约](ai-proofread-contract.md#共享传输层的等待预算与错误证据) |
| `src/workbenches/<name>/` | 该工作台的结果模型、构建器、提示词、缓存与备注空间 | 不用另一工作台的 rows 或 notes 充当自己的数据模型 |
| `public/` 或工作台 `client/` | 浏览器交互与表现 | 共享脚本只能持有通用能力；两个构建器各自注入同一份资源 |
| `docs/contracts/` | 维护者使用的领域细则与故障定位 | 一个主题指定一处详细规范；其他文档保留入口或用户行为说明 |

`src/ai/task-queue.js` 是通用队列原语；翻译多阶段派发仍由翻译工作台的 `ai-proofread.js` 持有，说话人推断使用自己的任务状态。共享队列不统一两种任务的业务结论或并发策略。

## 控制台边界

| 模块（均相对 `src/runtime/`） | 唯一职责 |
| --- | --- |
| `input-server.js` | 依赖组装、统一鉴权、请求分派和监听生命周期 |
| `request-security.js` | Host、Origin、Sec-Fetch-Site、会话令牌校验与令牌注入；不发送响应 |
| `http-json.js` | JSON 请求解析、大小/类型边界与响应格式 |
| `artifact-response.js` | 静态文件及工作台产物响应 |
| `input-files.js` | 本机文件扫描/选择/校验与翻译输入选择 |
| `picker-paths.js` | 各导入入口的目录记忆与系统选择窗口身份 |
| `speaker-runtime.js` | 独立说话人输入持久化、构建与运行状态；构建和写入函数可注入 |
| `generation-pipeline.js` | 翻译生成子进程、进度与日志、隔离 staging 的生命周期 |
| `routes/` | 按输入、状态、项目、生成、写回、AI 分派业务请求；只接收所需实例与配置 |

- 鉴权发生在路由分派之前。路由命中返回 `true`，未命中返回 `false`；未命中不得读取请求体或发送响应。接口路径、响应形状、错误状态码、写回定位参数与任务互斥规则保持兼容。
- `createInputRoutes` 的 `pickPath` 可注入，让系统窗口在测试中被替代。
- 导入入口 `jp`/`cn`/`tw` 的起始目录按「当前卡片路径 → 该入口记忆 → 已登记选择」推导，记忆写在 `out/runtime/picker-paths.json`，入口不共用 ClientGuid 或目录记忆。系统窗口用 `IFileDialog::SetFolder` 强制定位，不能改回只在无系统记忆时生效的 `SetDefaultFolder`。
- 控制台不显示默认目录，服务端也不回报 `defaultDir`/`pickDefaults`。`scripts/windows-path-picker.ps1` 保持 UTF-8 BOM，避免 Windows PowerShell 5.1 按 ANSI 读中文标题。
- `public/setup.html` 的「已生成项目」下拉框按活动身份 `projectKey + snapshotId` 决定选中项：身份变化时跟随服务端，身份未变时保留用户选择。只比较 key 会漏掉同输入重新生成的快照变化；无条件跟随会让轮询覆盖用户浏览选择。

验证：

```powershell
node --test scripts/runtime-modules.test.js scripts/input-server.test.js scripts/writeback-export.test.js scripts/picker-paths.test.js scripts/setup-import.test.js scripts/setup-projects.test.js
```

## 翻译构建边界

| 模块（均相对 `src/workbenches/translation-compare/`） | 唯一职责 |
| --- | --- |
| `build-compare.js` | CLI、构建流程与快照重渲染入口；旧导出仅转发兼容调用 |
| `alignment-artifact.js` | 对齐产物读取、旧字段兼容与单原文段落校验 |
| `row-alignment.js` | 非原文对齐与比较行组装、对应算法和细分阈值 |
| `row-output.js` | 模式字段裁剪、CSV、导出行、客户端行与展示质量标签阈值；签名调用共享 `project-context.js` |
| `render-workbench.js` | HTML 渲染与渲染时读取静态资源 |
| `model-options.js`、`notes-recovery.js` | 不依赖 DOM、文件系统或任务状态的纯计算 |
| `ai/proofread-defaults.js`、`ai/decision-score.js` | AI 默认配置与纯评分规则 |

- 职责模块不得反向依赖 `build-compare.js`；新增领域调用直接引用职责模块，兼容入口只服务已有调用方。
- 渲染器从默认配置、评分与 `proofread-contract.js` 读取契约，不为配置加载 `ai-proofread.js` 的任务运行状态。
- 静态资源由 `readWorkbenchAssets()` 在 `makeHtml()` 内读取，不能改回导入模块时缓存；快照 HTML 内嵌资源，发布页面的更新动作按 `AGENTS.md` 的刷新契约执行。
- 序列化到浏览器的函数不得捕获模块私有依赖；必需常量和纯函数须显式注入。
- 跨语言语义对齐由 `align_jp.py` 持有；JS 对齐算法与展示标签分别归上表两模块。分数与标签来自算法或集中规则，不能手工覆盖；阈值改动要兼容旧快照展示。

修改这些边界执行 `npm test`，覆盖模式裁剪、备注恢复、快照重渲染与布局缓存。`scripts/translation-module-boundaries.test.js` 在独立进程检查渲染和纯计算模块不加载 AI 服务或构建入口；它不等于全仓库依赖图检查。纯结构移动不要求重跑语义对齐。

## 说话人工作台边界

- 待判断行只提取 `「…」` 或 `『…』` 中的完整发话，不按内部标点拆分；叙述仅供上下文。完整发话生产预对齐最多 `1:1`，同段落合并仅在显式启用 `allowMergedParallel` 的诊断中允许，生产构建不得开启。
- 单语/双语模式裁剪、原文准入与持久化对齐摘要遵守 `AGENTS.md` 的工作台不变量；对齐或注意力的启发式分数不能解释为判断正确率。

验证：`node --test scripts/speaker-attribution.test.js scripts/speaker-ai.test.js`。

## 共享浏览器与 AI 能力

- `public/workbench-shared.js`、`public/toast.css`、`public/workbench-diff.js` 由翻译比较和说话人两个构建器读取并内联。修改时检查两个调用方并执行 `npm test`，不能复制为各自的实现。Toast 与确认、备注空间、模型预设、布局缓存细则由 [工作台契约](workbench-notes-spaces.md) 持有。
- `workbench-diff.js` 只负责纯文本差异算法与 HTML 转义回调，不读取 DOM、备注、筛选或任务状态；`workbench-client.js` 持有差异缓存并决定插槽展示。验证见 `scripts/client-ai-boundaries.test.js`。
- `src/ai/connection-config.js` 统一规范化连接。`protocol` 决定接口类型，`provider` 仅为供应商身份；预设持久化细则见 [工作台契约](workbench-notes-spaces.md#ai-模型预设管理ai-presetsjs)。说话人请求、CLI `--protocol` 与 `BETWEENLINES_AI_PROTOCOL` 使用相同字段。
- 模型能力规则目前物理上位于 `translation-compare/ai/model-capabilities.js`，实际由共享传输与两个工作台使用。这是纯能力模块的现有共享入口，不能由此引入翻译领域结果或状态；职责及浏览器注入规则见 [AI 契约](ai-proofread-contract.md#模型能力与思考档位)。
- 评分、异常分类、当前轮次备注、并发策略和熔断均各有单一规则模块；其业务细则由 [AI 契约](ai-proofread-contract.md) 与 [工作台契约](workbench-notes-spaces.md#并发上限与内部自适应调度) 分别维护，服务端与浏览器复用纯函数，不另写规则副本。

## 历史拆分记录（2026-09-25）

以下是当次重构证据，不是当前行数或全仓库原子化保证：

- 控制台入口由 911 行拆为当时的 142 行，翻译构建入口由 1466 行拆为当时的 189 行；拆出的职责模块及兼容导出对应上文。
- `runtime-modules.test.js` 新增实际端口/来源校验、实例令牌隔离、分块 UTF-8 请求、请求体上限、任务重入、状态隔离、失败重试与未匹配路由验证；`translation-module-boundaries.test.js` 新增独立导入与评分边界验证。
- 固定时间和双语/三语合成输入与拆分前 `f9957de` 对比：HTML、CSV 逐字节一致，导出行及客户端行深度一致。移动函数源码后曾因 CRLF 不同失败，统一为原文件 LF 后通过；各本地提交正文记录当时的 `npm test` 与 `git diff --check` 结果。
- 当时未调整正文过滤、语义对齐算法或真实输入，也未重新处理真实语料或做浏览器截图验证。

仍需先明确状态所有权再拆分的热点包括 `public/workbench-client.js` 的页面状态、`ai/ai-proofread.js` 的调度与运行状态、`src/ingest/writeback.js` 的定位及写入事务。拆分必须保留整体行为验证，不能仅把脚本切成多份来宣称解耦。
