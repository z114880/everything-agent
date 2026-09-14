# Sandbox

Sandbox 为 [`run_terminal`](../tools/terminal.ts) 提供**由内核强制**的执行边界。它只负责「命令能碰到什么」，不负责「该不该执行这条命令」——后者属于审批策略。

## 为什么是内核强制

用户态的路径校验（`realpath` 之后判断是否落在工作区内）是 check-then-use 模式：校验通过之后、真正写入之前，路径可以被替换成指向工作区外的符号链接。再加多少次校验也消不掉这个竞态。

内核在每次系统调用时判定实际路径，没有这个窗口。`src/sandbox/test/seatbelt.test.ts` 里「经由符号链接的越界写入同样被拒」这条用例固定了该行为。

模块里仍有一处 `realpath`（[seatbelt.ts](./seatbelt.ts) 的 `canonicalPath`），它只为让策略文本匹配内核看到的路径（macOS 的 `/tmp` 与 `/var` 都是符号链接），不承担安全职责。

## 平台实现

| 平台 | 实现 | 机制 |
| --- | --- | --- |
| macOS | `SeatbeltSandbox` | 系统自带 `sandbox-exec`，SBPL 策略 |
| Linux / WSL2 | `BubblewrapSandbox` | `bwrap` 挂载命名空间 |
| 原生 Windows | 无 | 不提供终端能力，引导改用 WSL2 |

**探测不到沙箱就没有终端工具**，不存在「无沙箱」降级档位。这样同一份代码不会在某些平台上静默失去保护。`detectSandbox()` 返回不可用原因，供界面直接展示。

两种实现表达边界的方式完全不同，各有一个必须守住的顺序约定：

- **SBPL 后匹配优先**：每条 `deny` 必须排在对应的 `allow` 之后，否则被静默覆盖——策略失效时命令照常执行，不会有任何报错。
- **bubblewrap 后挂载覆盖先挂载**：顺序固定为「全盘只读 → 可写区改为读写 → 拒写区改回只读」。

这两条顺序都有对应的测试用例锁定。

## 边界策略

`SandboxPolicy` 与平台无关，由调用方给出绝对路径：

| 字段 | 含义 |
| --- | --- |
| `workspaceRoot` | 唯一可写根，必填 |
| `writableRoots` | 额外可写路径，用于会话临时目录 |
| `denyWrite` | 可写区内部再挖掉的路径，如 `.git`、`.everything` |
| `denyRead` | 禁止读取的路径，如 `~/.ssh`、`~/.aws` |
| `allowNetwork` | 默认 `false`；放行只应来自一次人工审批 |

**沙箱保护不了工作区内部。** 工作区必须可写，因此 `rm -rf src/`、`git reset --hard` 这类破坏不在沙箱职责内，由审批策略和 `.git` 拒写共同兜底。

## 环境变量

`buildSandboxEnv()` 采用**白名单**，父进程环境不会被整体继承。

按名称模式剔除敏感变量（匹配 `KEY`、`TOKEN`、`SECRET`）挡不住名字里不含这些词的凭证，而 `.everything/.env` 的全部内容都在 `process.env` 中，一条 `env` 就能读走。白名单之外固定注入 `TERM=dumb` 与 `NO_COLOR=1`，关闭无人值守场景下无意义的彩色与交互式渲染。

## 执行约束

[execute.ts](./execute.ts) 为两种实现提供统一的进程管理：

- **stdin 关闭**：交互式提示在无人值守执行里只会挂死。
- **独立进程组**：超时或取消时整组回收，避免 `pnpm test` 派生的子进程残留。先 `SIGTERM`，500ms 后 `SIGKILL`。
- **输出截断**：stdout 与 stderr 各保留首尾 16KB，中间标注省略字节数。一次构建日志足以撑爆模型上下文。
- **拒绝提示**：内核不会把拒绝原因回传给进程，命令只看到普通权限错误。`denialHint` 按 stderr 措辞猜测撞上了哪一层边界，是给模型和用户的方向提示，**不是权威判定**。

## 使用

```ts
import { buildSandboxEnv, createSandbox } from "everything-agent/sandbox";

const sandbox = createSandbox({
  workspaceRoot: "/Users/me/project",
  writableRoots: [sessionTempDir],
  denyWrite: ["/Users/me/project/.git"],
  denyRead: ["/Users/me/.ssh"],
  allowNetwork: false,
});

const result = await sandbox.run({
  command: "pnpm test",
  cwd: "/Users/me/project",
  timeoutMs: 120_000,
  env: buildSandboxEnv({ TMPDIR: sessionTempDir }),
  signal,
});
```

`sandbox.enforces` 声明该实现实际强制的边界，上层据此决定审批强度——不要改为判断 `kind`，新增实现时判断会漏。

## 每次执行都重新组装策略

`SeatbeltSandbox` 与 `BubblewrapSandbox` 都只在构造时保存 `SandboxPolicy`，策略文本与挂载参数在每次 `run()` 时重新生成。

构造时快照会带来真实故障：拒读路径的形态（目录 / 文件 / 不存在）可能在构造之后改变，而用文件的方式去遮挡一个目录会让 `bwrap` **启动失败**——不是丢掉这一条规则，而是所有命令一起失败。macOS 一侧同理，路径被创建后 `realpath` 的结果会变。

## 测试

策略写错时的失效是静默的，因此 macOS 上的用例直接调用真实 `sandbox-exec` 验证边界，而非断言生成的文本。

自动化测试中 bubblewrap 只覆盖参数组装与缺少 `bwrap` 时的失败路径；其真实边界已在 Debian 容器（bubblewrap 0.8.0、Node 24）中手工验证：工作区内可写、越界写入被拒、符号链接越界被拒、`.git` 不可写、拒读目录不可读、出站网络切断、凭证不进子进程、超时终止、超长输出截断。

在容器里复现这套验证时，除 `SYS_ADMIN` 外还需要 `NET_ADMIN`，否则 `--unshare-net` 会因无法配置 loopback 而让 bwrap 直接失败。这是容器环境的限制，真实 Linux 宿主上不需要。**这类失败会让每条命令都失败，从而让所有 deny 类断言假通过**，验证时必须同时断言一条正向用例。

## 与人工审批的分工

沙箱只回答「命令能碰到什么」。它挡不住两件事，这两件事由 [`approval.ts`](../tools/approval.ts) 的审批策略负责：

- **工作区内部的破坏**。工作区必须可写，所以 `rm -rf src/`、`git reset --hard` 沙箱一概不管。
- **外部可见的后果**。`git push`、发布软件包，做出去就收不回来。

两者的判定原则不同：沙箱是内核规则，审批是人的判断。因此审批必须**稀有**——把工作区内的常规删除也拿去问，用户很快就会条件反射点同意，审批随即失效。

审批只看命令文本，不去查工作树是否干净：那需要为每条候选命令额外执行一次 git，既拖慢执行，也让判定依赖另一次沙箱调用的成败。需要确认的命令本就少见，多问一次不会累积成疲劳。

网络是唯一支持「审批后放宽重试」的边界：它是独立的一层，单独放行不削弱文件系统保护。文件系统越界**不提供**放宽重试，因为放开可写范围基本等同于取消沙箱，而工作区本就是为写代码配置的，越界写几乎总是命令本身写错了。
