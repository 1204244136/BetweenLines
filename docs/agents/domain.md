# 领域文档

工程类 skill 在探索本仓库时，应如何消费这里的领域文档。

## 探索之前先读这些

- 仓库根的 **`CONTEXT.md`**；或
- 仓库根存在 **`CONTEXT-MAP.md`** 时读它：它指向每个上下文各一个 `CONTEXT.md`，逐个读与主题相关的那些。
- **`docs/adr/`**：读与即将改动的区域相关的 ADR。多上下文仓库还要检查 `src/<context>/docs/adr/` 下的上下文级决策。

如果这些文件不存在，**静默继续**。不要指出它们缺失，也不要主动建议创建。`domain-modeling` skill（经由 `grill-with-docs` 与 `improve-codebase-architecture` 触达）会在术语或决策真正被敲定时惰性创建它们。

## 文件结构

单上下文仓库（绝大多数仓库）：

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

多上下文仓库（根存在 `CONTEXT-MAP.md`）：

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← 系统级决策
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← 上下文级决策
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

## 使用术语表里的词汇

当你的产出要命名某个领域概念时（issue 标题、重构提案、假设、测试名），使用 `CONTEXT.md` 中定义的术语。不要漂移到术语表明确回避的同义词。

如果你需要的概念还不在术语表里，那是一个信号：要么你在发明项目不使用的语言（重新考虑），要么存在真实的缺口（记下来交给 `domain-modeling`）。

## 标记 ADR 冲突

如果你的产出与既有 ADR 矛盾，明确提出来，而不是静默覆盖：

> _与 ADR-0007（事件溯源订单）冲突，但值得重开讨论，因为……_
