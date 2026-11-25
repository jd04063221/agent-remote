# agent-remote (`ar`)

> **远端大脑 × 本地双手** —— 分布式多 Agent 控制平面（Go + TypeScript Monorepo）

融合 [`cc-remote`](https://github.com/AkaraChen/cc-remote)（远端跑模型与认证、本地跑代码与工具）与 [`t3code`](https://github.com/pingdotgg/t3code)（本地单窗口多 Agent + Git Worktree 控制中心）范式：

- **Tailscale Tailnet 直连多路复用 + 零端口 MCP-over-WSS**：Go 轻节点（`apps/remote-node`）支持 `tailscale serve` / `tailscaled-whois` / `dev-token` 鉴权、单 WSS 承载同机多 Agent、Event Ring 断线断点续传、每会话隔离空目录与 `{{MCP_URL}}`/`{{MCP_TOKEN}}` 原子展开。
- **7 大 Coding Agent 统一适配**：Antigravity (`agy`)、OpenCode (`opencode`)、Claude Code (`claude`)、Codex (`codex`)、Gemini CLI (`gemini`)、Kiro (`kiro-cli`)、Factory Droid (`droid`)。
- **动态模型目录 + 远端额度探测 + 省额度联邦子代理（Quota-Saver）**：按 `(Host, Profile)` 实时拉取模型列表与思考档位；凭据不出远端即可探测剩余额度/余额；支持主脑（如 `agy`）通过 `dispatch_subagent` / `call_remote_model` 将检索、写单测、日志压缩卸载给低成本节点（如 `opencode` + `deepseek/deepseek-4.1-flash`）。
- **多形态前端**：`t3code` 风格 Web / Electron 控制窗口（含双线程分屏对比、Git Worktree 隔离、Diff 审阅、权限审批、Subagent 蓝图编辑）、标准 ACP Server（`ar acp` 接入 Zed/JetBrains）与 CLI（`ar ui` / `ar exec` / `ar doctor` / `ar models` / `ar quota`）。

## 快速开始

### 1. 构建全仓库（Go + TypeScript）
```bash
pnpm install
make all
```

### 2. 在远端 Tailnet 主机部署 Go 轻节点
```bash
# 生成 systemd + tailscale serve 一键部署脚本
node apps/cli/dist/index.js node deploy-script --port 19420 --auth tailscale-serve
```

### 3. 在本地验证连通性、动态模型目录与额度
```bash
node apps/cli/dist/index.js doctor --endpoint wss://<host>.<tailnet>.ts.net/v1/ws
node apps/cli/dist/index.js models --endpoint wss://<host>.<tailnet>.ts.net/v1/ws --agent antigravity
node apps/cli/dist/index.js quota  --endpoint wss://<host>.<tailnet>.ts.net/v1/ws --agent claude
```

### 4. 启动本地多 Agent 控制窗口（Web 或 Electron 桌面端）
```bash
# 浏览器控制窗口 (http://127.0.0.1:3775)
node apps/cli/dist/index.js ui --port 3775

# Electron 桌面应用（在装有桌面环境的本地电脑安装 electron 后运行）
pnpm --filter @agent-remote/desktop add -D electron
pnpm --filter @agent-remote/desktop start
```

## 文档

- 完整架构设计文档：[docs/architecture.md](docs/architecture.md)
