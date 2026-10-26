# AGENTS.md

面向在 BetweenLines 中读代码、修改实现和验证结果的模型及维护者。当前翻译比较工作台称为 TransComparator。

## 与 README 的关系

- [README.md](README.md) 面向用户：项目用途、安装运行、可观察行为、操作入口和公开限制；详细操作按需链接到 `docs/usage/`。使用项目无需阅读本文件。
- 本文件面向模型：只保留跨任务规则与必读文档入口。实现字段、算法、状态、故障证据及验证细则分别由 `docs/contracts/`、`docs/agents/` 拥有；修改前按下表读取相关文档。
- 用户可观察行为变化，同时更新对应用户说明和实现契约；仅内部实现变化只更新所属契约。两类文档从各自读者角度记录，不整段复制，也不相互替代。
- 新增文档先确定唯一职责并登记。文档分类、引用和维护规则见 [文档与工具登记](docs/contracts/documentation-tools.md)；当前实现概览见 [CURRENT_SYSTEM.md](docs/architecture/CURRENT_SYSTEM.md)，历史设计稿不作为现行实施依据。

## 开始与完成

1. 检查当前 Git 状态，保留用户和其他 agent 的改动；先读 [修改流程](docs/agents/change-workflow.md)，再按任务读取下表的契约。
2. 仓库有 `.codegraph/` 时，理解、定位或修改代码前先用 `codegraph_explore`（或 `codegraph explore`）；无该目录时跳过，不自行索引。文档、配置和索引未覆盖的内容再直接读取或用 `rg` 搜索。
3. 每个改动单元完成后自动本地提交；提交前完成相关验证和 `git diff --check`，文档变更另跑 `npm run check:docs`。提交信息采用中文 Conventional Commits，正文以 `验证：` 记录实际命令和结果。完成前必须提交；仅用户明确要求时才可 `git push`。
4. 用户否定最近提交时，先按修改流程撤回被否定的提交，再实施新方案。未经明确授权不使用破坏性 Git 命令。
5. 交付时按「哪部分改动 → 对应什么操作」说明最小生效操作；重启、应用布局和重新生成的区别见修改流程。纯文档改动无需刷新或重启。

## 跨工作台不变量

- 原文是正文准入边界。每张翻译表格行只承载一个完整原文段落，原文不得拆分、合并或跨行复用；非原文侧可为对齐拆并，技术 pivot 不代表权威或主从关系。
- 产物只保留当前模式真实存在的列，双语模式无第三列的字段、标签、空占位或隐藏控件。模式裁剪不得改变 `projectKey`、`rowsSignature` 或 `signature`。
- 完整段落是共享稳定源索引；派生句子和完整发话必须带 `parentParagraphId`。工作台独立持有结果、缓存与备注空间，共享能力不引入领域结果字段。
- 翻译备注是独立于快照的长期用户数据；淘汰快照或删除项目仍须保留磁盘备注。
- 已发布快照不可原位覆盖；写回原文必须唯一定位、局部替换，无法确定时拒绝猜写。详细存储与写回规则见下表。
- 源文本、本机路径、私有配置、辅助表格和生成物留在忽略区域；不强加已忽略文件，不提交 `out/`。公开样例和真实样本使用边界见修改流程。

## 按任务读取

| 任务触发条件 | 必须读取的文档 |
| --- | --- |
| 修改模块归属、共享能力、构建入口或浏览器资源 | [模块边界](docs/contracts/module-boundaries.md) |
| 修改输入格式、上游 index-X 适配、正文过滤、标题、段落、对齐或模式输出 | [文本输入与对齐](docs/contracts/text-input-alignment.md) |
| 修改快照发布、项目切换、清理、输入选择持久化或源文件写回 | [项目存储与写回](docs/contracts/project-storage-writeback.md) |
| 修改 AI 提示词、翻译规范档案、模型传输、预筛或阶段编排 | [AI 校对契约](docs/contracts/ai-proofread-contract.md)；按通用规则、作品档案与输入适配分别维护规范 |
| 修改备注保存、迁移、恢复、删除、模型预设、Toast 或客户端状态 | [工作台与备注契约](docs/contracts/workbench-notes-spaces.md) |
| 定位运行异常，或修复已记录的故障规则 | [排查手册](docs/contracts/troubleshooting.md)，并同步相关故障条目 |
| 新增、移动、删除文档、工具或 npm 命令 | [文档与工具登记](docs/contracts/documentation-tools.md) |
| 处理 GitHub issue/spec、triage 或领域术语/ADR | [Issue tracker](docs/agents/issue-tracker.md)、[Triage 标签](docs/agents/triage-labels.md)、[领域文档](docs/agents/domain.md) 中与任务有关的部分 |

只加载当前任务需要的细则；新增细则优先写入已有职责文档，确需独立职责时再新建子路径文档并补上触发入口，不继续扩充根 AGENTS。
