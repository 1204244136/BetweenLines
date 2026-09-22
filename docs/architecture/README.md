# Architecture Documentation Index

本目录用于保存 BetweenLines 的架构设计、历史决策、交接资料与未来路线图。

新接手开发者请不要直接阅读全部文档。

按以下顺序阅读即可在最短时间建立完整认知。

---

# 推荐阅读顺序

## 第一步：了解现在是什么

阅读：

- CURRENT_SYSTEM.md
- AI_REVIEW_SYSTEM_MAP.md

回答：

- 当前系统已经实现了什么？
- 实际运行流程是什么？
- 哪些模块已经上线？

---

## 第二步：了解项目为什么会变成这样

阅读：

- AI_REVIEW_HISTORY.md
- DECISIONS.md

回答：

- 为什么放弃多模型投票？
- 为什么采用阶梯漏斗？
- 哪些设计方案被否决？
- 当前架构是如何演化出来的？

---

## 第三步：了解未来规划

阅读：

- ROADMAP.md

回答：

- 下一步做什么？
- 哪些功能尚未实现？
- 当前优先级是什么？

---

## 第四步：完成项目交接

阅读：

- PROJECT_HANDOVER.md

回答：

- 当前项目整体状态如何？
- 应从哪里开始开发？
- 哪些事情不要优先做？

---

## 第五步：深入理解 AI 校对体系

阅读：

ai-review/

顺序：

1. 01-v2.4-修订要点.md
2. 02-v2.4-重构版.md
3. 03-v3.0-架构设计.md
4. 04-v3.1-工程蓝图.md

这些文档保存了多 AI 校对体系从概念、规划到工程蓝图的完整演化过程。

---

# 文档职责划分

CURRENT_SYSTEM.md

只记录已经实现的事实。

不得写规划。

---

ROADMAP.md

只记录未来计划。

不得写现状。

---

DECISIONS.md

保存关键架构决策。

记录为什么采用或放弃某种方案。

---

AI_REVIEW_HISTORY.md

保存 AI 校对体系的演化历史。

---

AI_REVIEW_SYSTEM_MAP.md

保存系统级流程图。

用于快速建立全局认知。

---

PROJECT_HANDOVER.md

作为正式交接入口。

新成员优先阅读。

---

# 当前结论

截至目前：

已经完成：

- 多 AI 架构设计
- 工程蓝图设计
- 架构决策沉淀
- 项目交接体系建立

尚未开始：

- Challenger 模式实现
- Persona Runtime
- Auto Scheduler
- Arbiter

当前阶段属于：

设计冻结与交接准备阶段。

不是功能开发阶段。