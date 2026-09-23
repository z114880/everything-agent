import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { MemoryRuntime } from "../index.ts";
import type { AgentMessage, ContextCompaction } from "../../agent-loop/agent-loop.ts";

const homes: string[] = [];
const runtimes: MemoryRuntime[] = [];
afterEach(async () => { for (const runtime of runtimes.splice(0)) runtime.close(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function setup() {
  const home = await mkdtemp(join(tmpdir(), "compact-memory-")); homes.push(home);
  const memory = new MemoryRuntime(home); runtimes.push(memory);
  return { home, memory };
}
const answer = (text: string): AgentMessage => ({ role: "assistant", content: [{ type: "text", text }] });
function checkpoint(messages: AgentMessage[], compactionId = crypto.randomUUID()): ContextCompaction {
  return { messages, compactionId, iteration: 2, beforeTokens: 7000, afterTokens: 2000, targetTokens: 3000, availableInputTokens: 10000, targetReached: true, ms: 30 };
}

it("压缩检查点跨重启生效，完整聊天与最近原始回合保留，完成时不重复写入工具消息", async () => {
  const { home, memory } = await setup();
  const session = memory.createSession();
  memory.startRun(session.id, "old", "历史请求原文");
  await memory.completeRun(session.id, "old", [answer("历史回答原文")]);
  memory.startRun(session.id, "current", "当前请求");
  const tools: AgentMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "完整工具原文" }] },
  ];
  const compacted = checkpoint([{ role: "user", content: "历史与工具摘要", contextSummary: true }, { role: "user", content: "当前请求" }]);
  memory.saveCompaction(session.id, "current", tools, compacted);
  expect(memory.getWorkingMemory(session.id)).toEqual(compacted.messages);
  expect(memory.getChatLog(session.id)).toHaveLength(5);
  await memory.completeRun(session.id, "current", [...tools, answer("最终回答")]);
  expect(memory.getChatLog(session.id)).toHaveLength(6);
  expect(memory.getWorkingMemory(session.id)).toEqual([...compacted.messages, answer("最终回答")]);
  expect(memory.getWorkingMemory(session.id, 1)).toEqual([{ role: "user", content: "当前请求" }, ...tools, answer("最终回答")]);
  expect(memory.getChatLog(session.id).find((entry) => entry.runId === "current")?.compactions).toMatchObject([{ compactionId: compacted.compactionId, beforeTokens: 7000, afterTokens: 2000 }]);
  expect(memory.listSemantic()).toEqual([]);
  memory.close(); runtimes.splice(runtimes.indexOf(memory), 1);
  const reopened = new MemoryRuntime(home); runtimes.push(reopened);
  expect(reopened.getWorkingMemory(session.id)).toEqual([...compacted.messages, answer("最终回答")]);
  reopened.startRun(session.id, "next", "下一轮");
  await reopened.completeRun(session.id, "next", [answer("下一答")]);
  expect(reopened.getWorkingMemory(session.id).slice(-2)).toEqual([{ role: "user", content: "下一轮" }, answer("下一答")]);
  const independent = reopened.createSession();
  expect(reopened.getWorkingMemory(independent.id)).toEqual([]);
  reopened.deleteSession(session.id);
  expect(reopened.getWorkingMemory(session.id)).toEqual([]);
});

it("保存失败时回滚原始消息和检查点，不覆盖此前成功结果", async () => {
  const { memory } = await setup();
  const session = memory.createSession();
  memory.startRun(session.id, "current", "当前请求");
  const first = checkpoint([{ role: "user", content: "有效摘要", contextSummary: true }, { role: "user", content: "当前请求" }]);
  memory.saveCompaction(session.id, "current", [], first);
  const newer = [{ role: "assistant", content: [{ type: "tool_use", id: "tool", name: "read", input: {} }] }];
  expect(() => memory.saveCompaction(session.id, "current", newer, { ...first, messages: [{ role: "user", content: "不应写入" }] })).toThrow();
  expect(memory.getWorkingMemory(session.id)).toEqual(first.messages);
  expect(memory.getChatLog(session.id)).toHaveLength(1);
  expect(() => memory.saveCompaction(session.id, "missing", [], checkpoint([]))).toThrow("Run 的用户消息不存在");
});

it("压缩后可分页回查当前会话的原文，包含已保存工具结果并排除新输入", async () => {
  const { memory } = await setup();
  const session = memory.createSession();
  memory.startRun(session.id, "old", "必须保留的精确编号 ABC123");
  await memory.completeRun(session.id, "old", [answer("收到")]);
  memory.startRun(session.id, "active", "继续工作");
  const tools: AgentMessage[] = [
    { role: "assistant", content: [{ type: "tool_use", id: "t", name: "read", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: "完整工具结果" }] },
  ];
  memory.saveCompaction(session.id, "active", tools, checkpoint([{ role: "user", content: "摘要" }]));
  memory.startRun(session.id, "new", "未压缩的新输入");
  const settings = { searchWindow: 3, entryTokenLimit: 100, tokenLimit: 500, tokenEstimator: { estimateText: (text: string) => text.length } };
  let page = await memory.readSession({ sessionId: session.id, currentSessionId: session.id }, settings);
  const entries = [...page.entries];
  while (page.nextCursor) {
    page = await memory.readSession({ cursor: page.nextCursor, currentSessionId: session.id }, settings);
    entries.push(...page.entries);
  }
  expect(entries.map((entry) => entry.runId)).not.toContain("new");
  expect(JSON.stringify(entries)).toContain("ABC123");
  expect(JSON.stringify(entries)).toContain("完整工具结果");
  expect((await memory.searchSessions({ recent: true, currentSessionId: session.id }, settings)).sessions).toEqual([]);
});
