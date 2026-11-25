# agent-remote (`ar`)

> **远端大脑 × 本地双手** —— 分布式多 Agent 控制平面（Go + TypeScript Monorepo）

融合 [`cc-remote`](https://github.com/AkaraChen/cc-remote)（远端跑模型与认证、本地跑代码与工具）与 [`t3code`](https://github.com/pingdotgg/t3code)（本地单窗口多 Agent + Git Worktree 控制中心）的设计范式：

- **Tailscale Tailnet 直连多路复用 + SSH 三模传输**：Go 轻量远端节点（`agent-remote-node`）支持 `tailscale serve` / `tsnet` WhoIs 鉴权、单 WSS 多路复用、MCP-over-WSS 零端口反向工具隧道与断线断点续传；同时兼容 Tailscale SSH 与传统 OpenSSH。
- **单窗口多主机 / 同主机多 Agent 并发**：`t3code` 风格 Web / Electron 控制窗口 + 标准 ACP Server（`ar acp`）+ CLI/TUI，支持每线程独立本地 Git Worktree 沙箱与 Unified Diff 审阅。
- **7 大 Coding Agent 统一适配**：Antigravity CLI (`agy`)、OpenCode (`opencode`)、Claude Code (`claude`)、Codex CLI (`codex`)、Gemini CLI (`gemini`)、Kiro CLI (`kiro-cli`)、Factory Droid (`droid`)。
- **动态模型目录同步 + 省额度联邦子代理（Quota-Saver）**：实时拉取远端各 Agent 账号可用模型与思考档位回传本地，按任务动态指定主/子 Agent 模型与思考深度，并支持把检索/单测/日志压缩等重 Token 子任务卸载给低成本开源/BYOK 节点（如 `opencode` + `deepseek-4.1-flash`）。

## 文档

- 完整架构设计文档：[docs/architecture.md](docs/architecture.md)
