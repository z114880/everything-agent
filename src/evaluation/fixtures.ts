import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { ToolRegistry } from "../agent-loop/agent-loop.ts";
import { timeToolSchema } from "../tools/tool-registry.ts";
import { searchWebSchema } from "../tools/tavily-search.ts";
import { runTerminalSchema } from "../tools/terminal.ts";
import { evaluateCommand } from "../tools/approval.ts";
import { safeRelativePath } from "./validation.ts";
import type { EvaluationCase } from "./types.ts";

/** 仅替换外部工具；记忆、Skill 和历史召回继续走原始实现。 */
export function createFixtureTools(original: ToolRegistry, testCase: EvaluationCase, workspace: string): ToolRegistry {
  const external = [timeToolSchema, searchWebSchema, runTerminalSchema];
  const schemas = external.filter((s) => testCase.tools.some((f) => f.name === s.name));
  return {
    schemas() { return [...(original.schemas() as { name: string }[]).filter((s) => !external.some((e) => e.name === s.name)), ...schemas]; },
    async execute(name, args, notify, context) {
      context.signal?.throwIfAborted();
      if (!external.some((s) => s.name === name)) return original.execute(name, args, notify, context);
      const schema = schemas.find((s) => s.name === name);
      if (!schema) throw new Error(`工具未注册：${name}`);
      validateArguments(args, schema.input_schema);
      const argumentsObject = args as Record<string, unknown>;
      if (name === "search_web" && !String(argumentsObject.query).trim()) throw new Error("搜索词不能为空");
      if (name === "run_terminal") {
        if (!String(argumentsObject.command).trim() || String(argumentsObject.command).length > 10000) throw new Error("命令为空或过长");
        if (argumentsObject.workdir) safeRelativePath(String(argumentsObject.workdir));
      }
      const fixture = testCase.tools.find((f) => f.name === name && isDeepStrictEqual(f.arguments, args));
      if (!fixture) throw new Error(`固定工具环境未匹配：${name}`);
      if (name === "run_terminal") {
        const command = String((args as Record<string, unknown>).command);
        const verdict = evaluateCommand(command);
        if (verdict.action === "block") { await notify("command_blocked", { tool: name, reason: verdict.reason }); throw new Error("命令被安全规则拒绝"); }
        if (verdict.action === "approve") {
          await notify("approval_requested", { tool: name, command, reason: verdict.reason });
          await notify("approval_resolved", { tool: name, approved: fixture.approval === true });
          if (fixture.approval !== true) throw new Error("固定审批环境拒绝命令");
        }
      }
      for (const [path, content] of Object.entries(fixture.files ?? {})) {
        const target = join(workspace, safeRelativePath(path)); await mkdir(dirname(target), { recursive: true }); await writeFile(target, content);
      }
      return structuredClone(fixture.result);
    },
  };
}
function validateArguments(value: unknown, schema: unknown): void {
  const s = schema as { type?: string; properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; enum?: unknown[]; minimum?: number; maximum?: number };
  if (s.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("工具参数必须为对象");
    const v = value as Record<string, unknown>;
    for (const key of s.required ?? []) if (!(key in v)) throw new Error(`缺少工具参数：${key}`);
    for (const [key, item] of Object.entries(v)) {
      if (!s.properties?.[key]) { if (s.additionalProperties === false) throw new Error(`未知工具参数：${key}`); }
      else validateArguments(item, s.properties[key]);
    }
  } else if (s.type && (s.type === "integer" ? !Number.isInteger(value) : typeof value !== s.type)) throw new Error("工具参数类型错误");
  if (s.enum && !s.enum.includes(value)) throw new Error("工具参数不在允许值中");
  if (typeof value === "number" && (s.minimum !== undefined && value < s.minimum || s.maximum !== undefined && value > s.maximum)) throw new Error("工具参数超出范围");
}
