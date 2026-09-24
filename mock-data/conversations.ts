import type { Dataset } from "./dataset.ts";
import type { TurnScript } from "./mock-provider.ts";

/** 一轮对话：用户消息与该回合模型应当产生的行为。 */
export interface SeedTurn {
  prompt: string;
  script: TurnScript;
}

export interface SeedSession {
  title: string;
  turns: SeedTurn[];
}

/**
 * 从数据集构建确定性的会话集合：同一数据集、count 与 seed 永远得到同一批对话。
 * 每个会话混合稳定事实陈述、工具调用、历史回顾与少量忘记请求，
 * 覆盖 create / noop / delete 三条记忆写入路径与 Session Recall。
 */
export function buildSessions(dataset: Dataset, count: number, seed = 1): SeedSession[] {
  const random = mulberry32(seed);
  const sessions: SeedSession[] = [];
  for (let index = 0; index < count; index += 1) {
    const topic = dataset.topics[index % dataset.topics.length]!;
    const round = Math.floor(index / dataset.topics.length);
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
        prompt: dataset.recallPrompts[index % dataset.recallPrompts.length]!,
        script: {
          toolCalls: [{ name: "session_search", input: { query: topic.title } }],
          reply: `我翻了之前的记录：${fact.fact}。这次的安排继续沿用这个结论。`,
        },
      });
    }
    // 少量失败的工具调用：模型引用了一个已经不存在的会话 ID。
    // 真实使用中这类失败一定会出现，模拟数据里也需要有，否则 tool_failed 与
    // turn_completed.failedToolCallCount 永远为零，无法验证展示与统计。
    if (index > 0 && random() > 0.88) {
      turns.push({
        prompt: "把我们最早那次讨论的原始记录调出来看看。",
        script: {
          toolCalls: [{ name: "session_read", input: { sessionId: `missing-${topic.subject}-${round}` } }],
          reply: "那次的原始记录已经不在了，我按现在保留的结论继续：" + `${fact.fact}。`,
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

/** 小巧的确定性伪随机数发生器，保证结果可复现。 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
