# Issue tracker：GitHub

本仓库的 issue 与 spec 以 GitHub issue 形式存在。所有操作使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，并同时取 labels。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合适当的 `--label` 与 `--state` 过滤。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **加 / 去标签**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

仓库由 `git remote -v` 推断；在 clone 目录内运行时 `gh` 会自动识别。

## PR 作为 triage 入口

**PR 作为请求入口：否。**（若本仓库把外部 PR 当作 feature request 处理，改成 `yes`；`triage` 会读这个标记。）

置为 `yes` 时，PR 走与 issue 相同的标签与状态，使用对应的 `gh pr` 命令：

- **读取 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR`、`NONE` 的条目（丢弃 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 与 PR 共用一套编号，因此裸写的 `#42` 可能是任一种：先用 `gh pr view 42` 解析，再回退到 `gh issue view 42`。

## 当某个 skill 说「publish to the issue tracker」

创建一个 GitHub issue。

## 当某个 skill 说「fetch the relevant ticket」

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

由 `wayfinder` 使用。**map** 是单个 issue，**child** issue 是其下的 ticket。

- **Map**：一个带 `wayfinder:map` 标签的 issue，正文承载 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **Child ticket**：作为 map 的 GitHub sub-issue 关联（对 sub-issues 端点调 `gh api`）。未启用 sub-issue 时，把 child 加入 map 正文的任务列表，并在 child 正文顶部写 `Part of #<map>`。标签：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。一旦被认领，ticket 指派给驱动的开发者。
- **Blocking**：GitHub 原生的 **issue dependencies**，这是规范且 UI 可见的表示。加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是 blocker 的**数字 database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number` 也不是 `node_id`）。GitHub 以 `issue_dependencies_summary.blocked_by` 报告（只含未关闭的 blocker，是实时的门）。dependencies 不可用时，回退为 child 正文顶部的 `Blocked by: #<n>, #<n>` 行。所有 blocker 关闭时该 ticket 解除阻塞。
- **Frontier 查询**：列出 map 的未关闭 children（`gh issue list --state open`，范围限定在 map 的 sub-issue / 任务列表内），剔除任何有未关闭 blocker（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中仍有未关闭 issue）或已有 assignee 的条目；按 map 顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，这是该 session 的第一次写入。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（gist + 链接）追加到 map 的 Decisions-so-far。
