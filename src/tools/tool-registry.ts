import type {
  AgentObserver,
  ToolExecutionContext,
  ToolRegistry,
} from "../agent-loop/agent-loop.js";
import type { MemoryRuntime } from "../memory/index.js";
import { MANAGE_MEMORY_TOOL, ManageMemoryTool, manageMemorySchema } from "./manage-memory.js";

const TIME_TOOL = "get_current_time";

/** 注册本地受控工具，并在执行前统一检查取消信号和参数。 */
export class LocalToolRegistry implements ToolRegistry {
  private readonly manageMemory: ManageMemoryTool | null;

  constructor(memory?: MemoryRuntime, manageMemory?: ManageMemoryTool) {
    this.manageMemory = manageMemory ?? (memory ? new ManageMemoryTool(memory) : null);
  }

  schemas(): unknown {
    const schemas: unknown[] = [{
      name: TIME_TOOL,
      description: "读取 Agent 所在服务器的当前日期、时间和时区。需要回答当前时间时必须调用此工具。",
      input_schema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    }];
    if (this.manageMemory) schemas.push(manageMemorySchema);
    return schemas;
  }

  execute(
    name: string,
    args: unknown,
    _notify: AgentObserver,
    context: ToolExecutionContext,
  ): unknown {
    if (context.signal?.aborted) throw context.signal.reason;
    if (name === MANAGE_MEMORY_TOOL && this.manageMemory) return this.manageMemory.execute(args);
    if (name !== TIME_TOOL) throw new Error(`工具未注册：${name}`);
    if (!isEmptyObject(args)) throw new TypeError(`${TIME_TOOL} 不接受参数`);

    const now = new Date();
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return {
      iso: now.toISOString(),
      timeZone,
      local: new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone,
      }).format(now),
    };
  }
}

function isEmptyObject(value: unknown): value is Record<string, never> {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).length === 0;
}
