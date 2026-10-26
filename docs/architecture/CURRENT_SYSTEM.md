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

## 当前输入与生成链

| 阶段 | 当前入口与连接 |
| --- | --- |
| 转换与正文提取 | `src/ingest/text-utils.js` 组织 TXT 读取、Pandoc 转换、正文过滤与必要的 OpenCC 归一化；`pandoc-utils.js` 封装转换，`epub-utils.js` 保留内置 EPUB reader 作为诊断与 fallback |
| 导出段落 | `scripts/export-paragraphs.js` 转发 ingest 输入逻辑，写入当前构建目录的 `paragraphs.json` 与输入选择快照；`npm run align:jp` 自动包含这一步 |
| 跨语言对齐 | 翻译工作台 `align_jp.py` 使用 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 生成 `jp-align.json`；运行后端由环境检查与 PyTorch 可用设备决定 |
| 翻译构建 | `build-compare.js` 读取段落与跨语言分组，三语时另对齐两份非原文，经行组装与渲染输出 HTML、CSV、JSON |
| 发布与切换 | 运行管线在 staging 构建，项目存储发布快照并切换活动指针；重新应用布局走新的快照发布 |
| 说话人构建 | `speaker-selection.js` 接收单语或双语输入，`prealign.js` 做双语预对齐，`attention.js` 压缩证据，`build-workbench.js` 生成独立结果 |

输入适配、正文边界、模式字段与行签名以 [文本输入与对齐契约](../contracts/text-input-alignment.md) 为准；快照、长期数据隔离及写回以 [项目存储与写回契约](../contracts/project-storage-writeback.md) 为准。模块所有权只在 [模块边界](../contracts/module-boundaries.md) 维护，本表只记录连接顺序。

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
           → 语言护栏 → decisionToResult → 备注会话 → 磁盘备注空间
人工确认或编辑 → 显式写回
```

低分归因和线上查证位于 `runStage1Gatekeeper` 内，在产生初审结果之后、提交复审队列之前执行。写回由用户显式操作触发；模型结论不会自动修改源文件。

三个审核阶段在同一项目与行集作用域内独立启停，单阶段只处理启动时已有候选；一键开始才将已配置阶段连成逐行流水线。阶段二与阶段三并非每行必经。终审成功后只定案为改或不改，「待终审」是中间态，旧版 AI 存疑与预筛结构冲突作为未定案记录兼容。具体续跑、早停与二元定案语义由 AI 校对契约维护。

## 当前 AI 模块

| 职责 | 实现位置与状态 |
|---|---|
| 提示词与目标列契约 | `proofread-contract.js`、`profiles/`、`term-table.js`、说话习惯与动态上下文模块 |
| 能力识别与请求适配 | `model-capabilities.js` 提供服务端识别与浏览器纯函数注入；传输使用 `src/ai/llm-client.js` |
| 三阶段执行 | `ai-proofread.js` 持有任务、跨阶段编排与指标；`arbiter.js` 判定仲裁触发，`stage-results.js` 归一阶段输出与指标 |
| 起始队列准备 | `stage-inputs.js` 依据最新备注与合格内存结果准备初审候选和完整复审/仲裁条目；任务入口继续预筛及执行 |
| AI 结果 | `proofread-results.js` 持有结果集合、修订交付、恢复与落盘时机；`result-store.js` 处理身份校验及原子文件读写 |
| 浏览器结果接收 | `ai-result-reception.js` 持有运行号、游标、去重、清除拦截与分页追赶；页面通过两阶段接收写入备注 |
| 角色消息 | `persona-runtime.js` 为 Gatekeeper、Stylist、Arbiter 构造独立角色消息；推理强度沿用各模型预设并进行合法性归一，不由角色自动覆写 |
| 模型画像 | `scheduler-profile.js` 提供六维画像与角色选择函数；此函数能力不等同于页面已自动绑定模型预设 |
| 并发与熔断 | `concurrency-controller.js` 和 `circuit-breaker.js` 提供各阶段的并发调节、退避、冷却探测与终止决策 |
| 阶段内派发 | `stage-dispatch.js` 持有待办、预设热更新与请求句柄，固定通道归属并管理反馈、正在处理的请求数及唤醒生命周期 |
| 低分与查证 | `low-score.js`、`web-lookup.js` 参与初审判定链 |
| 输出门禁 | `format-guard.js`、`punctuation.js` 与语言护栏在结论产出时约束修订文本 |
| 阶段状态 | `stage-note-state.js` 提供最新备注块的待办与异常语义；客户端阶段卡片显示状态与统计 |
| 人工反馈 | `feedback-collector.js` 记录进程内事件并汇总阶段/模型的采纳、修改与拒绝统计；统计本身不代表模型已自动训练或调度权重已更新 |
| 预设与备注 | `ai-presets.js`、`notes-spaces.js` 分别拥有模型预设与翻译备注空间 |
| 备注保存 | `notes-persistence.js` 持有保存会话及调度；`notes-disk-storage.js` 提交会话镜像并迁移旧浏览器空间，`notes-file-store.js` 持有独立长期磁盘记录；`notes-storage.js` 兼容旧浏览器压缩存储 |

历史实施阶段与旧版蓝图见 [AI_REVIEW_HISTORY.md](AI_REVIEW_HISTORY.md)，实现约束不从历史设计稿复制。
