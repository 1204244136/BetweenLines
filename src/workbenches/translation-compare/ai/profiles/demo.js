/**
 * 特化侧示范档案：某系列（魔禁/超炮）成品。
 *
 * 作用有两个：一是本项目实际使用的作品档案，二是公开示范——演示怎么为一个具体作品写特化侧：
 * 通用的成品校对规范继续由 `./novel.js` 提供，任务契约与输出约定由通用侧
 * `../proofread-contract.js` 提供，不要在档案里重复它们。
 *
 * 「不要重复」这条对本档案尤其重要：通用规范里已经写过的规则（旧译名不要回改、刻意书写特征
 * 不得判为病句、编号数字写法、咒语咏唱可调整句式）在这里只写**本作品的取值与举例**，不再抄一遍
 * 规则本身——同一句话发两遍不会让模型更听话，只会挤占前缀。
 *
 * 三块本机数据/规范都收在这一个文件里，不再另开数据文件：
 * 1. `speechTables`：本作品的说话习惯表**已内化**（外部 `某系列角色说话习惯汇总.xlsx` 转成
 *    下面的 `entries`，51 条），档案声明自己这个文件即可——运行时不挂外部表格，改条目直接改
 *    `entries`（构建后生效；运行期按本文件 mtime 校验，被改过会提示重新构建工作台）。
 *    加载器按扩展名分派：`.js` 走 `require` 读 `entries`，表格文件走 `readRecords`，
 *    归一化只有一份实现（见 `../speech-habit.js`）。
 * 2. `wikiSites`：线上查证用的官方站点入口（有序）。
 * 3. `sections`：本作品专有的**规范正文**（与作品设定无关的规则继续在 `./novel.js`）。
 *
 * 接自己的作品分两种写法：
 * - 是**另一个作品**（规范正文不同）：复制本文件改掉 id/name、`entries` 与最后那一节。
 * - 只是**本项目换台机器/换个人**（规范一样，只是名字或本机的表不同）：不要复制，
 *   用 `{ extends: "demo", ...差异字段 }` 叠加，注册表会沿用本档案的 id，下拉里不会多出一份
 *   内容相同的档案。见 `./local/work-profile.js`。
 *
 * 不想公开的档案可以放到被忽略的 `./local/` 目录，或用环境变量
 * `TRANSCOMPARATOR_PROFILE_FILES` 指向仓库外的文件。
 */
const novel = require("./novel");

module.exports = {
  ...novel,
  id: "demo",
  name: "某系列成品（示范档案）",
  summary: "示范作品专有档案的写法：在通用小说成品规范之上，只补本作品的译名口径与语言特征。",
  // 说话习惯表就是本文件：内化表只要导出 `entries` 数组，加载器就按内化表处理（见文件头）。
  // 想临时叠加自己的表（不改进仓库数据）：在数组里再加路径，或用 `TRANSCOMPARATOR_SPEECH_TABLES`；
  // 同一角色在两处都登记会各出一条规则，实验完记得删掉叠加的那条。
  speechTables: [require.resolve(__filename)],
  // 说话习惯的作用范围：chapter（按章命中人名，本作品用这个）；volume（整卷口径，规则集更宽、提示词更长）。
  speechHabitScope: "chapter",
  // 线上查证用的官方站点入口，**按声明顺序**依次查（拿到关键信息就停），都不行才让模型自行检索。
  // 只给站点入口、不给直达词条链接：条目名一旦猜错就是打不开的地址，模型只会照着瞎猜；
  // 给入口 + 要查的词条，让它站内搜索，找得到才有依据。未声明该字段的档案这一层不启用。
  wikiSites: [
    { label: "中文（灰机）", url: "https://toaru.huijiwiki.com/wiki/%E9%A6%96%E9%A1%B5" },
    { label: "日文（atwiki）", url: "https://w.atwiki.jp/index-index" },
    { label: "英文（Fandom）", url: "https://toarumajutsunoindex.fandom.com/wiki/Toaru_Majutsu_no_Index_Wiki" },
  ],
  // 说话习惯表的条目（内化数据）。字段与表格列一一对应，语义与列名候选表（`../speech-habit.js`
  // 的 `COLUMN_CANDIDATES`）一致：
  // - `character` ← 角色；`habit` ← 口癖（日文原词，可为空）；`type` ← 类型；
  // - `versions.x/net/tw` ← x版（本项目成品写法，"补回"的标准）/ 网翻 / 台版（转简中）；
  // - `memo` ← 备注；`firstWork` ← 小说首次出现（按卷过滤不可能登场的角色）。
  // 表格里写作「-」的占位符在转换时已归一成空字符串（与表格加载路径同一口径）。
  // 只有登记了 `versions.x` 且类型可靠（第一人称/接续词/句首句末语气词/谓语形式）的条目才参与
  // "特色流失"判定；其余条目仍会进提示词，但只作"这句可能是谁在说"的线索，不能据此判译文缺漏。
  // 表格若原样导出，写 `sheet` 表明来源工作表；内化在本文件里时不需要 id/name（返回值是档案对象）。
  sheet: "工作表1",
entries: [
  {
    character: "凯兹·诺克莱本",
    habit: "",
    type: "句式",
    versions: { x: "", net: "", tw: "" },
    memo: "句尾最后一个假名变为片假名",
    firstWork: "",
  },
  {
    character: "春暖嬉美",
    habit: "オレ",
    type: "第一人称",
    versions: { x: "", net: "", tw: "" },
    memo: "男性化自称，被白绢仄火传染",
    firstWork: "",
  },
  {
    character: "白绢仄火",
    habit: "オレ",
    type: "第一人称",
    versions: { x: "", net: "", tw: "" },
    memo: "男性化自称",
    firstWork: "",
  },
  {
    character: "春上衿衣",
    habit: "なの",
    type: "句末语气词",
    versions: { x: "", net: "", tw: "" },
    memo: "通常放在句尾",
    firstWork: "",
  },
  {
    character: "月咏小萌",
    habit: "小萌先生",
    type: "第一人称",
    versions: { x: "小萌老师", net: "小萌老师", tw: "" },
    memo: "",
    firstWork: "S1_01",
  },
  {
    character: "土御门元春",
    habit: "にゃー",
    type: "句末语气词",
    versions: { x: "喵", net: "喵", tw: "喵" },
    memo: "通常放在句尾",
    firstWork: "S1_01",
  },
  {
    character: "妹妹们",
    habit: "ミサカ",
    type: "句式",
    versions: { x: "御坂", net: "御坂", tw: "御坂" },
    memo: "全员自称「御坂」，在和其他个体交流时会报上编号「御坂XXXXX号」以作区别，称美琴为「姐姐大人」",
    firstWork: "S1_01",
  },
  {
    character: "奥雷欧斯·伊萨德",
    habit: "〜然",
    type: "接续词",
    versions: { x: "", net: "", tw: "" },
    memo: "多作为接续词使用，自然/当然/現然/全然/厳然/俄然/必然/愕然/断然/悄然/啞然/判然/間然/寛然/憮然/偶然",
    firstWork: "S1_02",
  },
  {
    character: "白井黑子",
    habit: "ですの",
    type: "谓语形式",
    versions: { x: "", net: "", tw: "" },
    memo: "通常放在句尾",
    firstWork: "S1_03",
  },
  {
    character: "莎夏·克洛伊洁芙",
    habit: "",
    type: "句式",
    versions: { x: "", net: "", tw: "" },
    memo: "对话时喜欢用「第一个问题」（第一の質問ですが）、「第一个解答」（第一の解答ですが）作为开头",
    firstWork: "S1_04",
  },
  {
    character: "上条诗菜",
    habit: "あらあら",
    type: "句首语气词",
    versions: { x: "哎呀呀/哎呀哎呀", net: "", tw: "哎呀呀/哎呀哎呀" },
    memo: "通常放在句首",
    firstWork: "S1_04",
  },
  {
    character: "米夏·克洛伊洁芙",
    habit: "",
    type: "句式",
    versions: { x: "", net: "", tw: "" },
    memo: "对话时喜欢用「问题一」（問一）、「解答一」（解答一）作为开头，有时也会以「私人看法一」（私見一）为开头",
    firstWork: "S1_04",
  },
  {
    character: "黄泉川爱穗",
    habit: "じゃん",
    type: "谓语形式",
    versions: { x: "", net: "", tw: "" },
    memo: "通常放在句尾",
    firstWork: "S1_06",
  },
  {
    character: "萝拉·斯图亚特",
    habit: "",
    type: "句式",
    versions: { x: "", net: "", tw: "" },
    memo: "遣词非常古代，拿中文参考类似文言文",
    firstWork: "S1_07",
  },
  {
    character: "欧莉安娜·汤姆森",
    habit: "お姉さん",
    type: "第一人称",
    versions: { x: "姐姐", net: "姐姐", tw: "姐姐" },
    memo: "",
    firstWork: "S1_09",
  },
  {
    character: "前方之风",
    habit: "この私に××形はない",
    type: "短句",
    versions: { x: "我没有××式", net: "", tw: "" },
    memo: "中间取决于自己当时心情",
    firstWork: "S1_11",
  },
  {
    character: "泷壶理后",
    habit: "",
    type: "称谓",
    versions: { x: "", net: "", tw: "" },
    memo: "叫别人的名字时用的都是平假名",
    firstWork: "S1_16",
  },
  {
    character: "绢旗最爱",
    habit: "超",
    type: "名词前缀",
    versions: { x: "超", net: "超", tw: "超" },
    memo: "多用于形容、评价或者表达情绪",
    firstWork: "S1_16",
  },
  {
    character: "芙兰达·塞维伦",
    habit: "結局",
    type: "接续词",
    versions: { x: "说到底", net: "说到底", tw: "结果" },
    memo: "通常放在句首",
    firstWork: "S1_16",
  },
  {
    character: "芙兰达·塞维伦",
    habit: "訳",
    type: "名词后缀",
    versions: { x: "", net: "", tw: "" },
    memo: "通常放在句尾",
    firstWork: "S1_16",
  },
  {
    character: "手盐惠未",
    habit: "",
    type: "句式",
    versions: { x: "", net: "", tw: "" },
    memo: "说话一字一句，会停顿",
    firstWork: "S1_16",
  },
  {
    character: "右方之火",
    habit: "俺様",
    type: "第一人称",
    versions: { x: "本大爷", net: "本大爷", tw: "本大爷" },
    memo: "",
    firstWork: "S1_17",
  },
  {
    character: "芙蕾梅亚·塞维伦",
    habit: "大体",
    type: "接续词",
    versions: { x: "说起来", net: "基本上", tw: "大概" },
    memo: "通常放在句首",
    firstWork: "S2_01",
  },
  {
    character: "芙蕾梅亚·塞维伦",
    habit: "にゃー",
    type: "句末语气词",
    versions: { x: "喵", net: "喵", tw: "喵" },
    memo: "通常放在句尾",
    firstWork: "S2_01",
  },
  {
    character: "莎洛妮亚·A.以黎维卡",
    habit: "ちゃん",
    type: "称谓",
    versions: { x: "酱", net: "", tw: "宝贝" },
    memo: "XX酱",
    firstWork: "S2_03",
  },
  {
    character: "云川鞠亚",
    habit: "プライド",
    type: "",
    versions: { x: "自尊", net: "自尊", tw: "自尊" },
    memo: "",
    firstWork: "S2_04",
  },
  {
    character: "食蜂操祈",
    habit: "力",
    type: "名词后缀",
    versions: { x: "力", net: "力", tw: "力" },
    memo: "XX力",
    firstWork: "S2_06",
  },
  {
    character: "食蜂操祈",
    habit: "ダゾ",
    type: "谓语形式",
    versions: { x: "", net: "", tw: "" },
    memo: "",
    firstWork: "S2_07",
  },
  {
    character: "去鸣",
    habit: "っしょ",
    type: "谓语形式",
    versions: { x: "", net: "", tw: "" },
    memo: "通常放在句尾",
    firstWork: "S2_15",
  },
  {
    character: "佐天泪子",
    habit: "あたし",
    type: "第一人称",
    versions: { x: "", net: "", tw: "" },
    memo: "",
    firstWork: "S2_17",
  },
  {
    character: "安娜·施普伦格尔",
    habit: "わらわ",
    type: "第一人称",
    versions: { x: "", net: "妾身", tw: "" },
    memo: "古风化自称",
    firstWork: "S2_21",
  },
  {
    character: "安娜·施普伦格尔",
    habit: "",
    type: "称谓",
    versions: { x: "", net: "", tw: "" },
    memo: "称上条当麻为蠢货（愚鈍）",
    firstWork: "S2_21",
  },
  {
    character: "约翰·瓦伦汀·安德烈",
    habit: "老骨",
    type: "第一人称",
    versions: { x: "老夫", net: "老夫", tw: "" },
    memo: "",
    firstWork: "S2_22",
  },
  {
    character: "安娜·金斯福德",
    habit: "",
    type: "句式",
    versions: { x: "", net: "", tw: "" },
    memo: "使用符号表意（原假名变为振假名），且格助词使用片假名书写。",
    firstWork: "S2_22",
  },
  {
    character: "维瓦娜·鬼熊",
    habit: "あたし",
    type: "第一人称",
    versions: { x: "", net: "", tw: "" },
    memo: "",
    firstWork: "S3_03",
  },
  {
    character: "爱丽丝·异典",
    habit: "少女",
    type: "第一人称",
    versions: { x: "少女", net: "少女", tw: "" },
    memo: "",
    firstWork: "S3_04",
  },
  {
    character: "爱丽丝·异典",
    habit: "",
    type: "称谓",
    versions: { x: "", net: "", tw: "" },
    memo: "称上条当麻为老师（先生）",
    firstWork: "S3_04",
  },
  {
    character: "古老善良的玛利亚",
    habit: "ママ様",
    type: "第一人称",
    versions: { x: "母亲大人", net: "母亲大人", tw: "" },
    memo: "",
    firstWork: "S3_05",
  },
  {
    character: "H.T.特利斯墨吉斯忒斯",
    habit: "一般的に考えて",
    type: "接续词",
    versions: { x: "一般来说", net: "一般来说", tw: "" },
    memo: "",
    firstWork: "S3_07",
  },
  {
    character: "木原合计",
    habit: "自分",
    type: "第一人称",
    versions: { x: "自己", net: "自己", tw: "" },
    memo: "",
    firstWork: "S3_12",
  },
  {
    character: "木原合计",
    habit: "でやんす",
    type: "谓语形式",
    versions: { x: "", net: "", tw: "" },
    memo: "",
    firstWork: "S3_12",
  },
  {
    character: "女贞木小路枫",
    habit: "アナタ",
    type: "接续词",
    versions: { x: "你啊", net: "你啊", tw: "你啊" },
    memo: "通常放在句首，有变体：あらアナタ、はいはいアナタ等",
    firstWork: "S4_01",
  },
  {
    character: "华野超美",
    habit: "こいつときたら",
    type: "",
    versions: { x: "你这家伙", net: "你这家伙", tw: "说到这家伙啊" },
    memo: "",
    firstWork: "S4_01",
  },
  {
    character: "警策看取",
    habit: "おねーさん",
    type: "第一人称",
    versions: { x: "姐姐", net: "姐姐", tw: "" },
    memo: "",
    firstWork: "S4_01",
  },
  {
    character: "警策看取",
    habit: "",
    type: "称谓",
    versions: { x: "", net: "", tw: "" },
    memo: "称呼别人时使用「名字+ちゃん」",
    firstWork: "S4_01",
  },
  {
    character: "鲇鱼女卡罗琳",
    habit: "だっさ",
    type: "",
    versions: { x: "真逊", net: "真逊", tw: "真逊" },
    memo: "通常放在句首，有变体：マジだっさ、うわだっさ，长音：だっさー等",
    firstWork: "S4_02",
  },
  {
    character: "鲇鱼女卡罗琳",
    habit: "エモい",
    type: "",
    versions: { x: "够劲", net: "【不固定】", tw: "有感觉" },
    memo: "",
    firstWork: "S4_02",
  },
  {
    character: "白鸟炽媚",
    habit: "当方",
    type: "第一人称",
    versions: { x: "", net: "", tw: "本人" },
    memo: "",
    firstWork: "S4_03",
  },
  {
    character: "菱形干比古",
    habit: "うん",
    type: "句首语气词",
    versions: { x: "", net: "嗯", tw: "" },
    memo: "",
    firstWork: "",
  },
  {
    character: "钓钟茶寮",
    habit: "",
    type: "第一人称",
    versions: { x: "", net: "", tw: "" },
    memo: "与近江手里在一起或说漏嘴时自称（オラ），其他时候故意自称（私）",
    firstWork: "",
  },
  {
    character: "美山写影",
    habit: "",
    type: "称谓",
    versions: { x: "", net: "", tw: "" },
    memo: "叫人会直接喊姓氏，熟悉后会直接喊名字",
    firstWork: "",
  },
  ],
  sections: [
    ...novel.sections,
    {
      title: "本作品专有事实",
      lines: [
        "系列名写作「某魔法的禁书目录」。",
      ],
    },
  ],
};
