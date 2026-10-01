# 翻译比较工作台

该工作台包含当前的 TransComparator 工作流：EPUB/Pandoc 输入、段落过滤、跨语言对齐（`align_jp.py`）、同级译文比较以及校对输出。其 `ai/` 目录拥有翻译专属的预筛选规则、提示词、目标列语义以及备注格式。

输入材料约定与 index-X 项目深度对齐：
- 简中与日文源文件优先适配 `index-X` 项目规范（EPUB 统一固定行模板 L1-L6、`heading-lines` 多层标题、`<ruby>` 注音、`<a epub:type="noteref"><sup>㊟</sup></a>` 译注标记）。
- 台版作为同级非原文对照材料，不作为权威主导。
- 正文准入规则：后记（`Afterwords`）排除在比较之外；但后记之后故事叙述性质的尾声（`After_the_Epilogue`）以及序章之前的引子（`Before_the_Prologue`）完整纳入正文比较。

翻译规范约定与 index-X 项目深度对齐：
- **规范正文在上游**：译文该写成什么样以 `index-X/docs/translation-spec.md` 为准（`tools/check_translation_spec.py` 的 `P1`–`P15` 是同一规范的机器检查实现）；译名在候选之间怎么取舍见 `translation-name-selection-spec.md`，已生效的裁定见 `translation-name-rulings.md`，与维基译名表的人为固有差异见 `x-translation-differences.md`（属取舍，不得按表回改）。
- `ai/profiles/novel.js`（通用成品规范）与 `demo.js`（作品取值）是同一套规范在 AI 校对层的实现，属上游声明的「规范正文 → 机器检查 → AI 档案」三处同步之一：两边改动要互相同步，口径不一致时以上游规范正文为准。
- 日文原文取自 `index-X/.cache/epub-work/japanese-text/`，那是 `bw_preprocess.py` 的预处理产物：普通读音与部分版式信息已被丢弃，「原文没写某标记」不能当作「原版没有」的证据（判注音要回上游的 BookWalker 分页源）。

它的行属于翻译比较模型。它们不是说话人归属、角色元数据或其他未来分析的通用容器。原文段落的准入边界和完整原文段落不变量在此处始终具有最高约束力。
