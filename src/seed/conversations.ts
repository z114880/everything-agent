import type { TurnScript } from "./fake-provider.ts";

/** 一轮对话：用户消息与该回合模型应当产生的行为。 */
export interface SeedTurn {
  prompt: string;
  script: TurnScript;
}

export interface SeedSession {
  title: string;
  turns: SeedTurn[];
}

/** 用户在对话中陈述的一条稳定事实，会经 manage_memory 进入 Semantic Memory。 */
interface SeedFact {
  attribute: string;
  fact: string;
  statement: string;
}

interface Topic {
  title: string;
  subject: string;
  /** 同一主题的多个不同侧面；重复出现的会话轮换使用，避免全部被前置去重拦成 duplicate。 */
  facts: SeedFact[];
  followUp: string;
  followUpReply: string;
  detailQuestion: string;
  detailReply: string;
}

const TOPICS: Topic[] = [
  {
    title: "咖啡与作息", subject: "用户",
    facts: [
      { attribute: "饮品偏好", fact: "用户只在上午喝手冲咖啡，下午改喝无咖啡因的茶", statement: "我只在上午喝手冲咖啡，下午会改喝无咖啡因的茶，不然晚上睡不着。" },
      { attribute: "咖啡豆偏好", fact: "用户偏好中浅烘的耶加雪菲，不接受深烘豆", statement: "买豆子的话我只要中浅烘的耶加雪菲，深烘的那种焦味我受不了。" },
      { attribute: "作息约束", fact: "用户固定在晚上十一点前睡觉，睡前两小时不摄入咖啡因", statement: "我固定十一点前睡，睡前两小时绝对不碰咖啡因。" },
    ],
    followUp: "帮我把下午的饮品也安排一下。",
    followUpReply: "下午我按无咖啡因安排：14 点前后一杯白茶，17 点换成大麦茶，都不影响你的睡眠。",
    detailQuestion: "手冲的豆子还剩多少？该补货了吗？",
    detailReply: "按你每天一杯的量，现在这包豆子还能撑九天左右，建议这周末补一包中浅烘的。",
  },
  {
    title: "季度述职材料", subject: "用户",
    facts: [
      { attribute: "进行中的项目", fact: "用户正在准备第三季度述职，重点是检索质量与成本下降的对比数据", statement: "我在准备第三季度述职，重点讲检索质量和成本下降的对比数据。" },
      { attribute: "汇报口径", fact: "用户的述职数据统一使用周维度中位数口径，原始分布放在附录", statement: "述职里的数据我统一用周维度中位数，原始分布放附录，别用均值。" },
      { attribute: "述职时间", fact: "用户的第三季度述职定在十月中旬，需要提前一周交初稿", statement: "述职定在十月中旬，初稿要提前一周交上去。" },
    ],
    followUp: "述职材料的结构先帮我列一版。",
    followUpReply: "我按三段列：先给质量指标的季度对比，再给成本下降的归因拆解，最后是下季度的两个待验证方向。",
    detailQuestion: "对比数据用哪个口径比较稳妥？",
    detailReply: "建议统一用周维度的中位数，避免个别大促日拉高均值，同时在附录保留原始分布。",
  },
  {
    title: "过敏与外出就餐", subject: "用户",
    facts: [
      { attribute: "饮食限制", fact: "用户对花生和坚果严重过敏，外出就餐必须提前确认", statement: "我对花生和坚果严重过敏，帮我订餐时一定要先确认厨房有没有交叉污染。" },
      { attribute: "就餐偏好", fact: "用户外出就餐偏好可以单独出餐的中餐馆，避免自助形式", statement: "外面吃饭我倾向能单独出餐的中餐馆，自助那种交叉污染风险太高。" },
      { attribute: "应急准备", fact: "用户随身携带肾上腺素笔，家人知道存放位置", statement: "我随身带肾上腺素笔，家里人也知道放在哪，这个你记一下。" },
    ],
    followUp: "下周三团建的餐厅帮我看一下。",
    followUpReply: "我会把坚果过敏写进备注并要求单独出餐；确认结果回来前，先不要点带酱料的凉菜。",
    detailQuestion: "如果对方说不能保证呢？",
    detailReply: "那就换一家。不能保证等于有风险，我会另外找两家可以做无坚果餐的备选。",
  },
  {
    title: "马拉松训练计划", subject: "用户",
    facts: [
      { attribute: "进行中的项目", fact: "用户在为十一月的半程马拉松训练，每周跑量控制在四十公里以内", statement: "我在为十一月的半马训练，每周跑量控制在四十公里以内，膝盖受过伤不能加太猛。" },
      { attribute: "伤病约束", fact: "用户右膝有旧伤，连续跑量增幅不得超过上周的一成", statement: "我右膝有旧伤，每周跑量增幅不能超过上周的一成。" },
      { attribute: "训练节奏", fact: "用户固定在周二、周四和周日训练，其余时间不安排跑步", statement: "我固定周二、周四、周日跑，其他时间别给我排训练。" },
    ],
    followUp: "这周的训练怎么排？",
    followUpReply: "这周排三次：周二八公里轻松跑，周四五公里节奏跑，周日十六公里长距离，总量二十九公里留出余量。",
    detailQuestion: "长距离那天需要注意什么？",
    detailReply: "出发前两小时吃碳水，配速比目标慢三十秒，中途每五公里补一次水，跑完当天不要再加力量训练。",
  },
  {
    title: "房贷与月度预算", subject: "用户",
    facts: [
      { attribute: "财务约束", fact: "用户每月房贷一万二，日常开销预算控制在八千以内", statement: "我每月房贷一万二，剩下的日常开销想控制在八千以内。" },
      { attribute: "记账方式", fact: "用户按周核对账目，超支时优先削减外食而不是动用储蓄", statement: "我每周对一次账，超了就先砍外食，不动储蓄。" },
      { attribute: "订阅支出", fact: "用户已退订三项长期未使用的订阅服务，每月固定支出减少两百四", statement: "那三个一年没用的订阅我退了，每月少两百四，记一下。" },
    ],
    followUp: "这个月超了吗？",
    followUpReply: "按目前的记录还差六百就到上限，主要是两笔临时的家电支出，后半月把外食减到每周两次就能打平。",
    detailQuestion: "有什么固定支出可以砍？",
    detailReply: "有三项重复订阅一年没用过，退掉每月省两百四；宽带套餐降一档再省八十，不影响你在家办公。",
  },
  {
    title: "猫咪日常照料", subject: "用户",
    facts: [
      { attribute: "宠物偏好", fact: "用户养了一只十岁的英短，需要长期吃处方粮控制肾指标", statement: "我家英短十岁了，肾指标偏高，一直吃处方粮，别给我推荐普通猫粮。" },
      { attribute: "复查周期", fact: "用户的猫每半年做一次肾功能复查，避开用户的述职周", statement: "猫的肾功能半年复查一次，尽量避开我述职那两周。" },
      { attribute: "喂养习惯", fact: "用户的猫每天分三次少量喂食，夜间不留粮", statement: "猫每天分三次少量喂，晚上不留粮，这个习惯别改。" },
    ],
    followUp: "处方粮快没了，帮我记一下补货。",
    followUpReply: "已记下。按现在的消耗大概还有十二天，我会在剩五天时提醒你，同时留意常买那家的补货时间。",
    detailQuestion: "体检该安排在什么时候？",
    detailReply: "上次复查是四个月前，肾指标建议半年一次，下个月中旬比较合适，避开你述职那两周。",
  },
  {
    title: "日语学习安排", subject: "用户",
    facts: [
      { attribute: "学习计划", fact: "用户在准备明年七月的日语 N2 考试，每天固定学习四十分钟", statement: "我在准备明年七月的日语 N2，每天固定学四十分钟，主要卡在听力。" },
      { attribute: "学习弱项", fact: "用户的日语听力是弱项，词汇与语法进度已经达标", statement: "我日语的词汇语法够用了，就是听力一直跟不上。" },
      { attribute: "学习时段", fact: "用户固定在早通勤时段学日语，晚上不安排学习任务", statement: "我只在早上通勤那段时间学日语，晚上不学。" },
    ],
    followUp: "听力怎么练效率高一点？",
    followUpReply: "把四十分钟拆成两段：前二十五分钟精听一段真题并复述，后十五分钟泛听通勤材料，一周只换一次素材。",
    detailQuestion: "现在的进度跟得上吗？",
    detailReply: "按每天四十分钟算，到考前还有约二百小时，词汇和语法够用，听力需要再压缩两个月的泛听比例。",
  },
  {
    title: "出差行程偏好", subject: "用户",
    facts: [
      { attribute: "出行偏好", fact: "用户出差只坐高铁二等座靠窗，不接受早于七点的航班", statement: "我出差习惯坐高铁二等座靠窗，早于七点的航班就别给我安排了。" },
      { attribute: "住宿偏好", fact: "用户出差住宿要求可免费取消，且步行十分钟内到达会场", statement: "订酒店必须能免费取消，而且走路十分钟内能到会场。" },
      { attribute: "行程约束", fact: "用户不接受连续两天以上的出差，返程当天不安排会议", statement: "出差别超过两天，回来当天也别给我排会。" },
    ],
    followUp: "下周去杭州的行程帮我看看。",
    followUpReply: "我按高铁排：周二上午九点十分出发，返程周三下午四点，都留了靠窗座位，不用赶早班机。",
    detailQuestion: "酒店呢？",
    detailReply: "选了离会场步行八分钟的那家，可以免费取消，比你上次住的便宜一百二且同样有洗衣服务。",
  },
  {
    title: "父母体检安排", subject: "用户",
    facts: [
      { attribute: "家庭承诺", fact: "用户答应每年春天陪父母做一次全面体检", statement: "我答应了我爸妈，每年春天陪他们做一次全面体检。" },
      { attribute: "体检偏好", fact: "用户父母的体检固定在三月下旬到四月中旬之间安排", statement: "体检时间固定在三月下旬到四月中旬之间，其他时候他们不方便。" },
      { attribute: "家庭安排", fact: "用户每两周回一次父母家，周末停留一晚", statement: "我每两周回一次爸妈家，周末住一晚，这个节奏别打乱。" },
    ],
    followUp: "今年的还没约，帮我记一下。",
    followUpReply: "已记下。春天窗口按三月下旬到四月中旬比较合适，我会在二月底提醒你提前预约。",
    detailQuestion: "要提前准备什么吗？",
    detailReply: "空腹项目要提前一天清淡饮食，带上去年的报告方便对比，如果做胃镜需要另外预约麻醉。",
  },
  {
    title: "阅读与书单", subject: "用户",
    facts: [
      { attribute: "阅读偏好", fact: "用户只读非虚构类书籍，尤其偏好科技史和城市规划", statement: "我基本只读非虚构，最喜欢科技史和城市规划这两类，小说就不用推荐了。" },
      { attribute: "阅读节奏", fact: "用户每月读完两本书，通勤与睡前各占一半时间", statement: "我一个月能读完两本，通勤和睡前各一半时间。" },
      { attribute: "阅读方式", fact: "用户只读纸质书，不使用电子阅读器", statement: "我只看纸质书，电子阅读器那种我看不进去。" },
    ],
    followUp: "最近有什么值得读的？",
    followUpReply: "按你的两个方向各挑一本：一本讲电网建设如何塑造城市形态，一本讲集装箱标准化的连锁影响，都偏叙事不枯燥。",
    detailQuestion: "先读哪本？",
    detailReply: "先读集装箱那本，篇幅短一半，而且能直接接上你上个月看的供应链内容。",
  },
];

const RECALL_PROMPTS = [
  "上次我们聊到的那个安排，你还记得结论吗？",
  "之前我提过的那个偏好，帮我再确认一遍。",
  "我们当时定下来的方案是什么来着？",
];

/**
 * 生成确定性的 Seed 会话集合：同一 count 与 seed 永远得到同一批对话。
 * 每个会话混合稳定事实陈述、工具调用、历史回顾与少量忘记请求，
 * 覆盖 create / noop / delete 三条记忆写入路径与 Session Recall。
 */
export function buildSeedSessions(count: number, seed = 1): SeedSession[] {
  const random = mulberry32(seed);
  const sessions: SeedSession[] = [];
  for (let index = 0; index < count; index += 1) {
    const topic = TOPICS[index % TOPICS.length]!;
    const round = Math.floor(index / TOPICS.length);
    const fact = topic.facts[round % topic.facts.length]!;
    const title = round === 0 ? topic.title : `${topic.title}（第 ${round + 1} 次）`;
    const turns: SeedTurn[] = [
      {
        prompt: fact.statement,
        script: {
          toolCalls: [{
            name: "manage_memory",
            input: { action: "submit", intent: "remember", subject: topic.subject, attribute: fact.attribute, content: fact.fact },
          }],
          reply: `明白了，我记下这一点：${fact.fact}。后续安排我都会按这个来。`,
        },
      },
      { prompt: topic.followUp, script: { reply: topic.followUpReply } },
    ];
    if (random() > 0.35) {
      turns.push({ prompt: topic.detailQuestion, script: { reply: topic.detailReply } });
    }
    if (random() > 0.5) {
      turns.push({
        prompt: "现在几点了？顺便看看今天还剩多少时间。",
        script: {
          toolCalls: [{ name: "get_current_time", input: {} }],
          reply: "我按当前时间算了一下，今天剩余的可用时段还够安排一件深度工作和一件杂事。",
        },
      });
    }
    if (index > 0 && random() > 0.45) {
      turns.push({
        prompt: RECALL_PROMPTS[index % RECALL_PROMPTS.length]!,
        script: {
          toolCalls: [{ name: "session_search", input: { query: topic.title } }],
          reply: `我翻了之前的记录：${fact.fact}。这次的安排继续沿用这个结论。`,
        },
      });
    }
    // 少量明确的忘记请求，让 delete 与 explicit_forget 也出现在记忆变更记录里。
    if (round > 0 && random() > 0.82) {
      turns.push({
        prompt: `关于${fact.attribute}的那条记录，你不用记着了，帮我忘掉吧。`,
        script: {
          toolCalls: [{
            name: "manage_memory",
            input: { action: "submit", intent: "forget", subject: topic.subject, attribute: fact.attribute, content: `忘记关于${fact.attribute}的记录` },
          }],
          reply: "好的，我已经提交忘记请求，后台确认后这条记录就不再保留。",
        },
      });
    }
    sessions.push({ title, turns });
  }
  return sessions;
}

/** 小巧的确定性伪随机数发生器，保证 Seed 结果可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
