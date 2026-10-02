# AI Review System History

本文保存设计演化和历史交付记录，不作为当前实现契约。当前实现见 [CURRENT_SYSTEM.md](CURRENT_SYSTEM.md)，架构取舍的原因统一见 [DECISIONS.md](DECISIONS.md)。

## 第一阶段

单模型校对器。

流程：

规则
→ AI
→ 结果

问题：

- 挑刺过多
- 翻译腔误判
- 单模型偏见
- 无法利用不同模型优势

## 第二阶段讨论

曾考虑：

### 多模型投票

放弃。

原因：成本过高。

### 纯串联审核

放弃。

原因：锚定效应明显。

### 阶梯漏斗体系

采纳。

原因：可早停、可扩展、成本可控。

## 第三阶段

形成认知分层架构：

Gatekeeper
→ Stylist
→ Arbiter

并兼容单模型人格分化。

## 历史交付记录

原 ROADMAP 的五个 Sprint 已标记完成，归档如下。这里记录曾经交付的能力，不据此推断今天仍按旧配置或旧执行顺序运行：

| 原阶段 | 交付记录 |
|---|---|
| Sprint 1 | CritiqueResult、StageMetrics、ReviewStageResult 与 Fast Pass |
| Sprint 2 | Persona 角色消息与双模型复审 |
| Sprint 3 | 模型画像/角色选择函数与独立阶段预设绑定 |
| Sprint 4 | 仲裁触发、ArbitrationResult 与终审执行 |
| Sprint 5 | 人工反馈记录与统计、页面阶段指标 |

历史设计稿保存在 [ai-review/](ai-review/)，按 `01` 至 `04` 的编号回看即可。设计稿里的模型自动绑定、角色推理阶梯、反馈学习等设想应与当前实现分别核对，不由交付清单替代验证。
