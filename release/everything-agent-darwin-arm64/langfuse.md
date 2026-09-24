# Langfuse 自托管部署（可选）

基础聊天、记忆和工作流执行不需要 Langfuse。本文档说明如何部署本地 Langfuse，用于 Evaluation 评估与日常运行 Trace 导出。

## 前置条件

- Docker Desktop（或带 Compose v2 的 Docker Engine）。
- Everything Agent 仓库中的 `deploy/langfuse/` 目录（含 `compose.yaml` 与部署脚本）。该目录不随发布包复制，请从仓库获取。

## 发布包内的凭证

在仓库执行 `pnpm run langfuse:up` 部署 Langfuse 时，脚本会生成 `.langfuse/compose.env`；若当时已存在 release 构建产物，同一份 compose.env 会被自动同步到每个产物目录的 `.langfuse/compose.env`。后端启动时读取发布包目录下的这份文件连接 Langfuse。

`.langfuse/compose.env` 是私有凭证，包含初始管理员账号、数据库与加密密钥、项目 API key，**不要提交 Git、不要分享**，也不要删除——加密密钥必须与部署数据保持一致。

## 部署步骤

1. 启动 Docker。
2. 从仓库获取 `deploy/langfuse/` 目录。
3. 在发布包目录用预置凭证启动服务（`--env-file` 指向发布包内的 `.langfuse/compose.env`，`-f` 指向仓库里的 compose.yaml）：

   ```bash
   docker compose --env-file .langfuse/compose.env -f <仓库路径>/deploy/langfuse/compose.yaml up -d --wait
   ```

   也可以直接在仓库执行 `pnpm run langfuse:up`，它会完成生成凭证、校验并启动服务，并在存在 release 产物时同步 compose.env。

4. 在发布包目录启动 Agent：

   ```bash
   npm start
   ```

   Langfuse 管理平台位于 `http://localhost:3300`。首次登录邮箱与密码见 `.langfuse/compose.env` 的 `LANGFUSE_INIT_USER_EMAIL` / `LANGFUSE_INIT_USER_PASSWORD`，项目公钥/私钥对应 `LANGFUSE_INIT_PROJECT_PUBLIC_KEY` / `LANGFUSE_INIT_PROJECT_SECRET_KEY`。

## 日常运行 Trace 导出

评估连接由后端自动读取 `.langfuse/compose.env` 完成。日常聊天的 Trace 导出需要另行启用，详见仓库 `src/tracing/README.md`。
