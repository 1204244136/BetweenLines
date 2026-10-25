# 文档与工具职责登记

本表登记每个文档和工具的唯一职责，不复制其业务规则。新增、删除或改名时同步登记；公开操作由根 README 维护，实现约束由 AGENTS 与领域契约维护，现状、历史与计划不得互相充当事实来源。

`npm run check:docs` 是只读结构门禁：从 `git ls-files --cached --others --exclude-standard` 取得纳管及未忽略的新文件，检查漏登记、重复登记、不存在的路径、失效或越界的本地 Markdown 链接、未知 npm 命令、失效的 npm 文件入口、缺失或循环的 npm 转发目标，以及遗漏的 npm 用法。它只读取仓库文档与 package.json，不执行登记的工具、不读取 out，也不调用模型。失败退出码为 1；成功为 0。

登记表以 `路径` 为第一列，文档表固定使用 `类别`、`唯一职责 / 边界`；工具表固定使用 `角色`、`实现 / 下游入口`、`输入与副作用边界`。路径是仓库相对路径，逐文件登记，禁止通配符。文档类别限于操作、导航、现状、契约、历史、计划；工具角色限于 CLI、兼容桥、内部辅助、测试夹具。npm 别名另用 `npm script` 与 `兼容别名目标` 两列登记，必须与 package.json 的转发命令一致。

门禁验证结构覆盖。职责是否足够原子化、规则是否语义重复、实现是否符合契约，仍须人工结合代码与调用链审查；通过门禁不等于业务验证通过。Markdown 链接按文档相对路径检查；外链、纯片段与代码块里的链接示例不检查，代码块里的 npm 用法仍检查。当前仅验证文件目标，不验证标题片段。

## 文档

| 路径 | 类别 | 唯一职责 / 边界 |
| --- | --- | --- |
| README.md | 操作 | 产品行为、安装运行、用户操作与输出位置；内部规则指向契约 |
| AGENTS.md | 契约 | 修改纪律、共享不变量、模块所有权、验证与生效操作总入口 |
| docs/agents/issue-tracker.md | 契约 | GitHub issue 入口、读写命令与 PR 作为请求入口的开关 |
| docs/agents/triage-labels.md | 契约 | 五个 triage 角色到本仓库实际标签字符串的映射 |
| docs/agents/domain.md | 契约 | 领域文档布局（单上下文 CONTEXT.md 与 docs/adr/）及工程 skill 的消费规则 |
| docs/contracts/documentation-tools.md | 契约 | 文档与工具唯一登记、结构门禁范围与兼容入口身份 |
| docs/contracts/ai-proofread-contract.md | 契约 | 翻译 AI 提示词、判定链、输出门禁与三阶段调度约束 |
| docs/contracts/workbench-notes-spaces.md | 契约 | 翻译工作台控制栈、备注空间与客户端状态约束 |
| docs/contracts/troubleshooting.md | 契约 | 现有失败的证据定位与处置步骤 |
| docs/contracts/module-boundaries.md | 契约 | 当前模块所有权与依赖方向，附已完成拆分的验证证据 |
| docs/architecture/README.md | 导航 | 架构文档阅读顺序、各文件角色与事实来源指引 |
| docs/architecture/CURRENT_SYSTEM.md | 现状 | 当前已实现系统的简要架构事实 |
| docs/architecture/AI_REVIEW_SYSTEM_MAP.md | 导航 | 当前翻译 AI 流程的兼容阅读入口，指向事实与契约 |
| docs/architecture/PROJECT_HANDOVER.md | 导航 | 项目交接阅读入口与当前事实、历史、计划的跳转 |
| docs/architecture/DECISIONS.md | 历史 | 已作架构决策及其原因 |
| docs/architecture/AI_REVIEW_HISTORY.md | 历史 | AI 审核方案演变、被否决路线与旧交付归档 |
| docs/architecture/ROADMAP.md | 计划 | 尚待实现的后续工作及优先级 |
| docs/architecture/ai-review/01-v2.4-修订要点.md | 历史 | 保留 v2.4 修订讨论快照，不规定当前行为 |
| docs/architecture/ai-review/02-v2.4-重构版.md | 历史 | 保留 v2.4 完整设计快照，不规定当前行为 |
| docs/architecture/ai-review/03-v3.0-架构设计.md | 历史 | 保留 v3.0 设计快照，不规定当前行为 |
| docs/architecture/ai-review/04-v3.1-工程蓝图.md | 历史 | 保留 v3.1 工程蓝图快照，不规定当前行为 |
| src/ai/README.md | 导航 | 共享 AI 职责摘要与现行传输、提示词及队列契约链接 |
| src/workbenches/README.md | 导航 | 工作台职责摘要与共享能力、隔离约束的契约链接 |
| src/workbenches/translation-compare/README.md | 导航 | 翻译比较模块入口与对应契约导航 |
| src/workbenches/speaker-attribution/README.md | 导航 | 说话人归属职责摘要与输入、预对齐、证据契约链接 |

## 工具

`scripts/*.test.js` 由 `npm test` 自动发现，不逐个登记。夹具与内部辅助文件登记角色，但不作为用户命令运行。兼容桥只转发到一个实现来源，禁止在桥内另写业务规则；Python 辅助模块的设备检测只供 Python 环境核验，Node 检测用于安装前探测。

| 路径 | 角色 | 实现 / 下游入口 | 输入与副作用边界 |
| --- | --- | --- | --- |
| scripts/check-docs.js | CLI | 本表与 package.json | 只读仓库登记、链接与命令覆盖，失败退出非 0 |
| scripts/check-pandoc.js | CLI | Pandoc --version | 只探测 Pandoc，缺失也退出 0；信息提示，不是安装门禁 |
| scripts/detect-accelerator.js | CLI | 系统 GPU、驱动及 HIP 探测 | 安装前只读硬件候选，输出 JSON 后附人类提示 |
| scripts/check-accelerator.py | CLI | scripts/accelerator_detect.py | 检查当前 PyTorch 能否用设备并报告 torchvision 可用性；拒绝未授权的 CPU 回退，损坏的 torchvision 只告警不拦截 |
| scripts/setup-env.ps1 | CLI | npm、Python、pip、Pandoc、winget | 安装基础依赖、创建虚拟环境；重建选项会替换 .venv |
| scripts/setup-accelerator.ps1 | CLI | scripts/detect-accelerator.js、pip | 选择并替换 .venv 中的 PyTorch 后端；支持 DryRun |
| scripts/export-paragraphs.js | CLI | src/ingest/input-selection.js、text-utils.js | 输入选择与源文本，保存选择并写工作目录段落产物 |
| src/workbenches/translation-compare/align_jp.py | CLI | scripts/accelerator_detect.py、语义模型 | 工作目录 paragraphs.json，加载或下载模型并写 jp-align.json；torchvision 不可用时按缺失屏蔽 |
| src/workbenches/translation-compare/build-compare.js | CLI | 行组装、输出与渲染模块、project-store | 源文本与对齐产物，写 HTML/CSV/JSON 并发布翻译快照 |
| scripts/rebuild-layout.js | CLI | src/storage/project-store.js | 指定或活动翻译项目，重渲染并发布新快照、切换活动指针 |
| scripts/term-prefilter.js | CLI | term-table.js、term-layer.js、offline-cli.js | 活动翻译快照与译名表，离线审计；仅 --out 写报告；--from-snapshot 只读文本汇总，禁止 JSON/报告/明细选项组合 |
| scripts/speech-habit.js | CLI | speech-habit-layer.js、verify-source.js、offline-cli.js | 活动翻译快照与习惯表，离线审计；仅 --out 写指定报告 |
| src/workbenches/speaker-attribution/build-workbench.js | CLI | speaker-selection.js、预对齐、attention、speaker-inference | 单语或双语源文本，写独立运行时工作台；启用 AI 才调用模型 |
| src/runtime/input-server.js | CLI | runtime 路由与生命周期模块 | 启动本机服务；用户请求可保存输入、长期备注、生成、写回及调用 AI；备注路由调用翻译工作台文件存储，工作台响应动态注入磁盘记录 |
| start-setup.bat | 兼容桥 | npm run setup | 固定启动目录与端口；服务监听后由服务打开控制台 |
| scripts/build-compare.js | 兼容桥 | src/workbenches/translation-compare/build-compare.js | 旧 require/CLI 入口，副作用由唯一构建实现拥有 |
| scripts/input-server.js | 兼容桥 | src/runtime/input-server.js | 旧 require/CLI 入口，服务启动由唯一运行时实现拥有 |
| scripts/ai-prefilter.js | 兼容桥 | src/workbenches/translation-compare/ai/ai-prefilter.js | 只转发 require，不启动预筛任务 |
| scripts/ai-proofread.js | 兼容桥 | src/workbenches/translation-compare/ai/ai-proofread.js | 只转发 require，任务状态由唯一 AI 服务模块拥有 |
| scripts/epub-utils.js | 兼容桥 | src/ingest/epub-utils.js | 只转发 require，不转换或写入输入文件 |
| scripts/generation-pipeline.js | 兼容桥 | src/runtime/generation-pipeline.js | 只转发 require，生成事务由运行时实现拥有 |
| scripts/input-selection.js | 兼容桥 | src/ingest/input-selection.js | 只转发 require，选择规则及保存由 ingest 实现拥有 |
| scripts/line-units.js | 兼容桥 | src/ingest/line-units.js | 只转发 require，不替换完整段落索引 |
| scripts/project-context.js | 兼容桥 | src/core/project-context.js | 只转发 require，项目身份与签名由 core 实现拥有 |
| scripts/project-store.js | 兼容桥 | src/storage/project-store.js | 只转发 require，快照与指针由 storage 实现拥有 |
| scripts/text-utils.js | 兼容桥 | src/ingest/text-utils.js | 只转发 require，清理与段落规则由 ingest 实现拥有 |
| scripts/accelerator_detect.py | 内部辅助 | check-accelerator.py、align_jp.py | Python 内只读硬件、PyTorch 后端与 torchvision 原生扩展可用性；不是安装入口 |
| scripts/lib/offline-cli.js | 内部辅助 | src/storage/project-store.js、atomic-fs.js | 离线审计共用活动翻译快照读取，不启动模型或写回 |
| scripts/windows-path-picker.ps1 | 内部辅助 | src/runtime/input-files.js | 打开系统文件选择窗口，只返回选择路径，不导入或写回 |
| scripts/workbench-fixture.js | 测试夹具 | 工作台生成器与 VM 假 DOM | 合成行、假存储及真实内联脚本交互测试，无真实输入 |
| scripts/setup-console-fixture.js | 测试夹具 | public/setup.html 与 VM 假 DOM | 控制台状态测试，共享假 DOM，不启动本机服务 |

## npm 兼容别名

普通 npm scripts 的用法只在根 README 维护；下表仅登记不需要重复用户说明的兼容别名。

| npm script | 兼容别名目标 |
| --- | --- |
| check:gpu | check:accelerator |
