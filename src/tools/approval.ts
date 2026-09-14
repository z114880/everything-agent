/** 需要人工确认的原因分类。 */
export type ApprovalKind =
  /** 命令撞上沙箱边界，用户可授权在沙箱外重试。 */
  | "sandbox_denial"
  /** 命令会产生外部可见或不可回滚的后果。 */
  | "irreversible";

/** 一次待确认的请求；`command` 会原样展示给用户。 */
export interface ApprovalRequest {
  kind: ApprovalKind;
  command: string;
  /** 面向用户的中文说明，解释为什么停下来问。 */
  reason: string;
  /** 沙箱拒绝时补充被拒的路径或主机等细节。 */
  detail?: string;
}

/** 审批通道；由运行时实现，工具只依赖这个契约。 */
export interface ApprovalGate {
  /** 发起一次确认，解析为 true 表示用户同意继续。 */
  request(input: ApprovalRequest, signal: AbortSignal | undefined): Promise<boolean>;
}

/** 命令在执行前的判定结果。 */
export type CommandVerdict =
  | { action: "allow" }
  | { action: "approve"; reason: string }
  | { action: "block"; reason: string };

/**
 * 无条件拒绝的命令。
 *
 * 这类模式只防手滑，不防对抗：编码、变量展开与别名都能绕过字符串匹配。真正的
 * 边界来自沙箱；这里拦住的是模型在工作区内部犯的低级错误，而沙箱恰好不管那里。
 */
const HARDLINE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\brm\s+(-[a-zA-Z]*\s+)*-?[a-zA-Z]*[rR][a-zA-Z]*f?[a-zA-Z]*\s+\/(\s|$)/, reason: "递归删除根目录" },
  { pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(~|\$HOME)(\/\s*|\s|$)/, reason: "递归删除主目录" },
  { pattern: /:\(\)\s*\{.*\|.*&.*\}\s*;?\s*:/, reason: "fork 炸弹" },
  { pattern: /\bmkfs(\.\w+)?\b/, reason: "格式化文件系统" },
  { pattern: /\bdd\b[^|;]*\bof=\/dev\/(disk|sd|nvme)/, reason: "直接写入磁盘设备" },
];

/**
 * 需要人工确认的命令：外部可见的后果，以及会丢弃工作成果的本地操作。
 *
 * 不去查工作树是否干净。判定要么只看命令文本，要么就得为每条候选命令额外执行
 * 一次 git，既拖慢执行也让判定依赖另一次沙箱调用的成败；这些命令本就少见，
 * 多问一次不会累积成审批疲劳。
 */
const IRREVERSIBLE_PATTERNS: { pattern: RegExp; reason: string }[] = [
  { pattern: /\bgit\s+push\b/, reason: "向远端推送提交" },
  { pattern: /\bgit\s+push\b.*(--force|-f)\b/, reason: "强制推送会覆盖远端历史" },
  { pattern: /\bnpm\s+publish\b|\bpnpm\s+publish\b/, reason: "发布软件包" },
  { pattern: /\bgit\s+reset\s+.*--hard\b/, reason: "硬重置会丢弃未提交改动" },
  { pattern: /\bgit\s+clean\b.*-[a-zA-Z]*[fd]/, reason: "清理未跟踪文件" },
  { pattern: /\bgit\s+checkout\s+--\s+\./, reason: "回退工作区全部改动" },
  { pattern: /\bgit\s+restore\s+(--\s+)?\./, reason: "回退工作区全部改动" },
];

/**
 * 判定一条命令在执行前需要什么处理。
 *
 * 只做粗粒度分流：允许、需要确认、直接拒绝。命令能碰到什么由沙箱决定，这里
 * 关心的是沙箱管不到的后果。
 */
export function evaluateCommand(command: string): CommandVerdict {
  for (const { pattern, reason } of HARDLINE_PATTERNS) {
    if (pattern.test(command)) return { action: "block", reason };
  }
  for (const { pattern, reason } of IRREVERSIBLE_PATTERNS) {
    if (pattern.test(command)) return { action: "approve", reason };
  }
  return { action: "allow" };
}
