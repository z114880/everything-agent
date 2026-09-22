# Codex 项目级技能

本目录是 Codex 的项目级技能根目录，对应 `{cwd}/.codex/skills/<技能名>/SKILL.md` 的发现规则：只要 Codex 的工作目录是本仓库，这些技能就会自动出现在技能清单里；克隆本仓库的其他人无需额外安装步骤即可获得同一套技能。

注意与项目自身的 `.everything/skills/` 区分：后者服务于本项目运行时的 Skill 模块（被 `.gitignore` 忽略，属于本地数据），本目录只服务于外部 Codex 助手。

## langfuse

- 来源：<https://github.com/langfuse/skills> 的 `skills/langfuse`（Langfuse 官方技能，MIT）。
- 固定提交：`f275566d06fba46278d94ceea0e00d5e0cf70e62`（对应 `.codex-plugin/plugin.json` 声明的插件版本 1.6.0）。
- 内容按上游原样落盘，未做本地改动，便于比对与升级。技能覆盖追踪接入、数据集与实验、评估、提示词管理、v4 迁移和 Langfuse 文档查询等场景。

### 更新

先删除旧目录（安装脚本检测到同名目录会直接退出），再执行 Codex 自带的安装脚本：

```bash
rm -rf .codex/skills/langfuse
python3 ~/.codex/skills/.system/skill-installer/scripts/install-skill-from-github.py \
  --repo langfuse/skills --path skills/langfuse --ref <提交或分支> --dest .codex/skills
```

升级后同步更新上面的固定提交，并用 `git diff` 确认改动范围。

### 前置条件

技能需要 Langfuse 凭证。本仓库使用 `deploy/langfuse/` 里的自建实例时，公共地址为 `http://localhost:3300`，`LANGFUSE_PUBLIC_KEY` 与 `LANGFUSE_SECRET_KEY` 取自被忽略的 `.langfuse/compose.env`（`LANGFUSE_INIT_PROJECT_*`），不要把密钥写入仓库。

### 与本仓库规则的差异

`SKILL.md` 的 `allowed-tools` 保留上游原文，其中包含 `npx langfuse-cli` / `bunx langfuse-cli` 命令。本仓库按 `AGENTS.md` 要求包管理一律使用 `pnpm`，因此在本仓库执行这些命令时改用等价的 `pnpm dlx langfuse-cli ...`，不要为了跟随技能而引入 `npm`、`npx` 或 `bunx`。
