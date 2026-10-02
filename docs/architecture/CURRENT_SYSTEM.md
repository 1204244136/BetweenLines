# 当前技术现状

本文汇总已经存在的实现及其连接方式。用户操作见根 [README.md](../../README.md)；字段、边界和验证要求见 [AGENTS.md](../../AGENTS.md) 与 [领域契约](../contracts/)。本文不安排未来工作。

## 工作台与共享能力

| 范围 | 当前实现 |
|---|---|
| 共享文本输入 | `src/ingest/` 提供输入选择、格式转换、正文过滤、完整段落及派生行单元 |
| 翻译比较 | `src/workbenches/translation-compare/` 构建双语或三语比较结果，使用跨语言对齐、独立翻译备注与项目快照 |
| 说话人归属 | `src/workbenches/speaker-attribution/` 构建单语或双语发话审阅结果，提供预对齐、证据注意力、模型推断与独立本地记录 |
| 共享 AI | `src/ai/` 提供连接规范化、LLM 传输、Prompt 公共原语和有界任务队列 |
| 运行与存储 | `src/runtime/` 组装本地服务与生成任务；`src/storage/` 管理翻译项目快照，说话人结果保存在独立 runtime 目录 |

## 当前翻译校对执行链

预筛选可独立运行；校对任务中的确定性术语/规则判定可直接产出结果。需模型判断的行进入以下链路：

```text
确定性术语/规则判定
  ├─ 可直接定案 → 输出与备注
  └─ 需模型判断 → Stage 1 Gatekeeper
                       ├─ 基础判断与上下文补充
                       ├─ 极低分触发时：低分归因与修复
                       └─ 仍存疑且配置允许时：线上查证
                     → Fast Pass / 下游配置判定
                       ├─ 早停或未配置复审 → 输出与备注
                       └─ Stage 2 Stylist / Peer Critique
                            ├─ 无需仲裁或未配置仲裁 → 输出与备注
                            └─ 分歧与存疑触发 → Stage 3 Arbiter
                                                   → 输出与备注

输出与备注：ensureRevisedText → 格式门禁 → 标点规范化
           → 语言护栏 → decisionToResult → 浏览器备注
人工确认或编辑 → 显式写回
```

低分归因和线上查证位于 `runStage1Gatekeeper` 内，在产生初审结果之后、提交复审队列之前执行。写回由用户显式操作触发；模型结论不会自动修改源文件。

三个审核阶段由同一任务的队列推进，可从已选起点补跑下游。启用范围由下游模型配置决定；阶段二与阶段三并非每行必经。具体续跑、早停与「待终审 / 待人工确认」语义由 AI 校对契约维护。

## 当前 AI 模块

| 职责 | 实现位置与状态 |
|---|---|
| 提示词与目标列契约 | `proofread-contract.js`、`profiles/`、`term-table.js`、说话习惯与动态上下文模块 |
| 能力识别与请求适配 | `model-capabilities.js` 提供服务端识别与浏览器纯函数注入；传输使用 `src/ai/llm-client.js` |
| 三阶段执行 | `ai-proofread.js` 持有任务、队列与结果；`arbiter.js` 判定仲裁触发，`stage-results.js` 归一阶段输出与指标 |
| 角色消息 | `persona-runtime.js` 为 Gatekeeper、Stylist、Arbiter 构造独立角色消息；推理强度沿用各模型预设并进行合法性归一，不由角色自动覆写 |
| 模型画像 | `scheduler-profile.js` 提供六维画像与角色选择函数；此函数能力不等同于页面已自动绑定模型预设 |
| 并发与熔断 | `concurrency-controller.js` 和 `circuit-breaker.js` 提供各阶段的并发调节、退避、冷却探测与终止决策 |
| 低分与查证 | `low-score.js`、`web-lookup.js` 参与初审判定链 |
| 输出门禁 | `format-guard.js`、`punctuation.js` 与语言护栏在结论产出时约束修订文本 |
| 阶段状态 | `stage-note-state.js` 提供最新备注块的待办与异常语义；客户端阶段卡片显示状态与统计 |
| 人工反馈 | `feedback-collector.js` 记录进程内事件并汇总阶段/模型的采纳、修改与拒绝统计；统计本身不代表模型已自动训练或调度权重已更新 |
| 预设与备注 | `ai-presets.js`、`notes-spaces.js` 分别拥有模型预设与翻译备注空间 |

历史实施阶段与旧版蓝图见 [AI_REVIEW_HISTORY.md](AI_REVIEW_HISTORY.md)，实现约束不从历史设计稿复制。
