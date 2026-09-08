import type { AgentObserver, ToolExecutionContext } from "../agent-loop/agent-loop.ts";
import type { SkillStore } from "./skill-store.ts";

export const READ_SKILL_TOOL = "read_skill";

export const readSkillSchema = {
  name: READ_SKILL_TOOL,
  description: "读取一个已发现 Skill 的完整执行指令。决定使用 Skill 后必须先调用此工具。",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "可用 Skill 目录中的精确名称" },
    },
    required: ["name"],
    additionalProperties: false,
  },
};

/** 将 Skill 正文按需交给模型，并只发布不含正文的加载事件。 */
export class ReadSkillTool {
  private readonly store: SkillStore;

  constructor(store: SkillStore) {
    this.store = store;
  }

  async execute(args: unknown, notify: AgentObserver, context: ToolExecutionContext): Promise<Record<string, string>> {
    if (context.signal?.aborted) throw context.signal.reason;
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("read_skill 参数必须是对象");
    const input = args as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== "name")) throw new TypeError("read_skill 包含未知参数");
    const name = input.name;
    if (typeof name !== "string") throw new TypeError("read_skill.name 必须是字符串");
    const skill = await this.store.read(name);
    await notify("skill_loaded", {
      skill: skill.name,
      description: skill.description,
      path: skill.path,
      instructionLength: skill.instructions.length,
      iteration: context.iteration,
      toolCallId: context.toolUseId,
    });
    return { name: skill.name, description: skill.description, instructions: skill.instructions };
  }
}
