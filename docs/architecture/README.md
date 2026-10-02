# 架构文档导航

本目录保存技术现状、架构决策和设计演化记录。操作说明由仓库根 [README.md](../../README.md) 维护；实现约束由 [AGENTS.md](../../AGENTS.md) 及其引用的 [领域契约](../contracts/) 维护。

## 推荐入口

| 要解决的问题 | 阅读位置 | 职责 |
|---|---|---|
| 当前实现了什么、执行链如何连接 | [CURRENT_SYSTEM.md](CURRENT_SYSTEM.md) | 当前技术现状与流程的唯一汇总 |
| 接手项目从哪里开始 | [PROJECT_HANDOVER.md](PROJECT_HANDOVER.md) | 阅读与验证入口，不复制现状和优先级 |
| 为什么采用或放弃某种方案 | [DECISIONS.md](DECISIONS.md) | 架构决策及其原因 |
| AI 校对体系如何演化 | [AI_REVIEW_HISTORY.md](AI_REVIEW_HISTORY.md) | 历史阶段与交付记录 |
| 尚有哪些已确认的未来计划 | [ROADMAP.md](ROADMAP.md) | 尚未交付的计划，不收纳已交付清单 |
| 查旧版设计的背景 | [ai-review/](ai-review/) | 历史设计稿，不作为当前实施契约 |

[AI_REVIEW_SYSTEM_MAP.md](AI_REVIEW_SYSTEM_MAP.md) 保留为现有链接的兼容入口，流程图统一维护在 `CURRENT_SYSTEM.md`，避免两份执行顺序漂移。

## 维护边界

当前实现发生变化时更新 `CURRENT_SYSTEM.md`；用户可观察的行为同步更新根 README；约束、字段或验证方式变化更新 AGENTS 或对应领域契约。入口文档只更新链接，历史设计稿不追写当前状态。

`ai-review/` 的四份版本稿按编号保存当时的讨论与蓝图。它们可能包含已经交付、调整或放弃的方案；遇到现状、配置或数据结构冲突时，按当前实现与有效契约核对，不照旧蓝图重新实现。
