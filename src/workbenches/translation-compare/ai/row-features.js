/**
 * 行特征探测：按行裁剪提示词的**唯一依据**。
 *
 * 为什么需要它：特化档案里有一批“只在特定版式或文字现象上才有意义”的规范——注音、
 * 傍点加粗、译注标记、分页与图片、省略号写法、「！？」顺序、引号用途与成对标记内的句末点号、间隔号与西文缩写、
 * 方向敏感的通信标识、连接词衔接、拟声词与语气词选词、数字与单位、片段与原文外内容。每行都注入它们既贵（占前缀的一半以上），
 * 又会把注意力从“这一行到底哪里有问题”上稀释掉；只有当前行真的出现对应现象时才需要。
 *
 * 三条纪律（改这个文件前先读）：
 * 1. **宁可多注入**：探测不出、看不出来、行文本缺失时一律算命中——漏注入等于模型看不到
 *    这条规范，会产出“不知道规范就判违规”的结果，比多花几十个 token 严重得多。
 * 2. **只描述现象，不描述结论**：特征名说的是“这一行出现了 ruby/加粗/引号/数字……”，
 *    不是“这一行有缺陷”。判定永远留给模型与人工。
 * 3. **不猜语义**：语义类规则（遗漏信息、否定时态、译名一致性）不属于可裁剪项，
 *    它们必须每行都在——档案里不声明 `features` 的条目永远注入。
 *
 * 换了作品/阶段的自定义档案可以完全不使用特征（条目写成字符串即可），
 * 这样档案不需要跟着这里改；只有想省 token 的条目才声明 `features`。
 */

// 注册表：档案条目只能声明这里列出的特征；声明了未注册的 id 时该条目按“常驻”处理并告警，
// 避免一个笔误让某条规范永远不注入。
const FEATURE_IDS = Object.freeze([
  "ruby",          // 注音（原文 ruby/rt 或稿件 |基文[注文]、成品 ruby/rt）
  "emphasis",      // 傍点 → 加粗（原文着重号、成品 b/strong）
  "noteref",       // 译注标记（EPUB noteref、㊟）
  "page",          // 分页换页与版式（pb class、图片占位、插图行）
  "blank",         // 空行折叠
  "ellipsis",      // 省略号写法
  "interrobang",   // 「！？」顺序与数量
  "quote",         // 引号层级与用途、引号内句末点号（「」/『』/书名号）
  "parenthesis",   // 括号（括注与心声的成对标记，句末点号位置规范要它）
  "middleDot",     // 间隔号与西文缩写（中文「·」/日文点号「・」、字母后的下脚点）
  "directionalSymbol", // 通信标识符、箭头与方向标记（竖排/横排的旋转变体）
  "conjunction",   // 连接词独立成段与衔接
  "repeat",        // 重复字/符号、长串假名
  "speechEffect",  // 拟声词、被打断、异口同声、断续
  "particle",      // 语气词与拟声词选词
  "numeric",       // 数字与单位、儿化音
  "fragment",      // 不完整片段（接续词/助词/标点收尾或缺少句末标点）
  "outOfScope",    // 目标列出现特典、后记、译注、制作信息等原文外内容
]);

const KATAKANA_RUN = /[\u30a1-\u30f6\u30fc]{3,}/u;
// 语气词/拟声词：原文侧常见写法（成品选词规则要用的那批）。
const PARTICLE_WORDS = /チッ|ちっ|まあ|やれやれ|あら|おや|ふむ|へえ|はあ|こら|そら|ほら/u;
const PARTICLE_TARGETS = /啧|呀嘞|啊啦|嘛|嘞/u;
const TERMINAL_PUNCTUATION = /[。！？…」』）)\]】]$/u;
const FRAGMENT_ENDING = /(?:しかし|だが|でも|そして|また|つまり|ただし|だから|そこで|すると|ゆえに|なぜなら|けれども|けれど|けど|なお)[、,，]?\s*$/u;
// 方向敏感的符号：竖排原文中的旋转形态与横排成品的旋转形态都算命中。
// 半角 <> 只在左右紧邻中日文时命中，避免把 HTML 标签或普通比较符误当成通信标识。
const DIRECTIONAL_SYMBOL = /[∨∧﹀︿＞＜«»‹›≪≫←↑→↓↔↕↖↗↘↙]/u;
const ASCII_DIRECTIONAL_SYMBOL = /(?:[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}）】」』])\s*[<>]\s*(?=[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}（【「『])/u;

function looksLikeFragment(value) {
  const text = String(value || "").trim();
  if (!text) return false;
  return !TERMINAL_PUNCTUATION.test(text)
    || FRAGMENT_ENDING.test(text)
    || /[、,，:：;；]$/u.test(text);
}

const RULES = {
  // 注音现象在原文与目标列**任一侧**出现都算命中。原文侧有两种形态：译者稿的 |基文[注文]，
  // 以及本工作台日文原文列的 <ruby>基文<rt>注文</rt></ruby>。只认稿件形态会让“原文有注音、
  // 译文没有”的行整条拿不到注音规范（实测整卷 3119 行里 923 行），而这类行恰恰最需要那条规范：
  // 模型不知道注音该怎么处理时，会照抄原文的日文读音（见 ai-proofread 的目标列语言护栏）。
  ruby: ({ source, target }) =>
    /<\s*(ruby|rt)[\s>/]/i.test(source)
    || /\|[^\s|\]]{0,30}\[[^\]\n]{1,40}\]/u.test(source)
    || /<\s*(ruby|rt)[\s>/]/i.test(target),
  emphasis: ({ source, target }) =>
    /[\uFE45\uFE46\uFF9E\uFF9F]/u.test(source) || /<\s*(b|strong)[\s>]/i.test(target),
  noteref: ({ source, target }) =>
    /noteref|epub:type|㊟/iu.test(`${source}\n${target}`),
  page: ({ source, target }) =>
    /class\s*=\s*["']?[^"'>]*\bpb\b|<img|\[图片\]|\[插图\]|\[p\d+\]|<!--\s*page/iu.test(`${source}\n${target}`),
  blank: ({ source, target }) => /(\n[ \t\r]*){2,}/u.test(source) || /(\n[ \t\r]*){2,}/u.test(target),
  // 省略号现象：原文的「…」「。。。」，以及**目标列里已经写歪的**连续英文句点（「..」「...」「......」）。
  // 门槛取**两个**点：与规范化层（`punctuation.js` 的 `\.{2,}` → 「……」）保持同一口径，
  // 否则「..」这种写法进不了这一层，模型拿不到省略号规范，规范化层也不会去动它。
  ellipsis: ({ source, target }) =>
    /。。。|\.{2,}|…|‥/u.test(`${source}\n${target}`),
  interrobang: ({ source, target }) =>
    /！？|？！|！\?|\?！|!\?|\?!/u.test(`${source}\n${target}`),
  quote: ({ source, target }) =>
    /[「」『』《》]|["“”‘’]/u.test(`${source}\n${target}`),
  // 括号是另一类成对标记（括注、心声）：句末点号该落在它内侧还是外侧由目标列规范决定，
  // 与引号同一条规范、但命中来源不同，所以单列一个特征——只认引号会让整行括注的行
  // 拿不到那条规范（真实回归：第 1087 行 `（……变成那样。）` 的句号被删）。
  // 只列全角形态：半角括号在中日文语境里属于标点宽度问题，由排版层常驻的「标点全角化」管。
  parenthesis: ({ source, target }) =>
    /[（）【】〔〕]/u.test(`${source}\n${target}`),
  // 间隔号与西文缩写只在**目标列**探测：原文（日文）里的「・」本来就是日文点号，拿它触发会把
  // 整卷人名行都算进来，而这条规范管的是中文成品怎么写——中文间隔号是 `·`（U+00B7），不要与
  // 日文点号 `・`（U+30FB）混用；外国人名的西文缩写写作「中文·字母.」，字母之后用下脚点。
  middleDot: ({ target }) =>
    /[·・]/u.test(target) || /[A-Za-z]\.[\u4e00-\u9fff]/u.test(target),
  directionalSymbol: ({ source, target }) => {
    const text = `${source}\n${target}`;
    return DIRECTIONAL_SYMBOL.test(text) || ASCII_DIRECTIONAL_SYMBOL.test(text);
  },
  conjunction: ({ source, target }) =>
    /(しかし|だが|でも|そして|また|つまり|ただし|だから|そこで|すると|ゆえに|なぜなら|けれども|けれど|けど|なお)[、,，]?\s*$/u.test(source)
    || /——|--/u.test(target),
  repeat: ({ source, target }) => /(.)\1{2,}/u.test(`${source}\n${target}`) || KATAKANA_RUN.test(source),
  speechEffect: ({ source, target }) =>
    KATAKANA_RUN.test(source) || /「「/u.test(target) || /[A-Za-z]\s*$/u.test(target),
  particle: ({ source, target }) => PARTICLE_WORDS.test(source) || PARTICLE_TARGETS.test(target),
  numeric: ({ source, target }) =>
    /[0-9０-９]|キロ|メートル|センチ|グラム|千克|千米|公里|公斤|儿/u.test(`${source}\n${target}`),
  // 片段口径只描述可观察的收尾形态：缺少句末标记或以接续词、逗号、助词性收束结尾。
  // 这是**保守命中**：完整但没有句末标点的行也会被算进来，宁可多注入也不误导模型把片段补成整句。
  fragment: ({ source, target }) => looksLikeFragment(source) || looksLikeFragment(target),
  // 原文外内容只在这一行真的出现相应类别时才有判断价值；命中后仍由规则要求模型不要据此增删。
  outOfScope: ({ source, target }) =>
    /特典|后记|後記|译注|譯注|制作信息|製作信息|版权|版權|附录|附錄|番外/u.test(`${source}\n${target}`),
};

/**
 * 本轮行数据给出的特征集合。
 *
 * @param {{source?: string, target?: string}} row 原文（A）与目标列（B）的当前行文本
 * @returns {Set<string>} 命中的特征 id
 */
function detectRowFeatures({ source = "", target = "" } = {}) {
  const text = { source: String(source || ""), target: String(target || "") };
  // 兜底：两侧都没有文本（行数据缺失/统计口径外的调用）时不做裁剪，全部按命中处理。
  if (!text.source && !text.target) return new Set(FEATURE_IDS);
  const hit = new Set();
  for (const id of FEATURE_IDS) {
    try {
      if (RULES[id](text)) hit.add(id);
    } catch {
      // 探测本身出错时按命中处理：裁剪是优化，不该成为丢规则的原因。
      hit.add(id);
    }
  }
  return hit;
}

/** 档案里声明了但未注册的特征 id（用于告警；这类条目按常驻处理）。 */
function unknownFeatureIds(profile) {
  const unknown = new Set();
  for (const section of profile?.sections || []) {
    for (const line of section.lines || []) {
      if (typeof line === "string") continue;
      for (const id of line?.features || []) {
        if (!FEATURE_IDS.includes(id)) unknown.add(id);
      }
    }
  }
  return [...unknown];
}

/** 档案里声明了 features 的条目总数与特征分布（审计/测试用）。 */
function featureUsage(profile) {
  const usage = new Map();
  let conditional = 0;
  let always = 0;
  for (const section of profile?.sections || []) {
    for (const line of section.lines || []) {
      if (typeof line === "string" || !line?.features?.length) {
        always += 1;
        continue;
      }
      conditional += 1;
      for (const id of line.features) usage.set(id, (usage.get(id) || 0) + 1);
    }
  }
  return { always, conditional, usage: Object.fromEntries([...usage].sort()) };
}

module.exports = {
  FEATURE_IDS,
  FEATURE_RULES: RULES,
  detectRowFeatures,
  featureUsage,
  unknownFeatureIds,
};
