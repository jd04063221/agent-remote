# agent-remote (`ar`)

[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

> **远端大脑 × 本地双手** —— 分布式多 Agent 控制平面（Go + TypeScript Monorepo）

融合 [`cc-remote`](https://github.com/AkaraChen/cc-remote)（远端跑模型与认证、本地跑代码与工具）与 [`t3code`](https://github.com/pingdotgg/t3code)（本地单窗口多 Agent + Git Worktree 控制中心）范式：

- **Tailnet / 局域网 / VPN 直连多路复用 + 零端口 MCP-over-WSS**：Go 轻节点（`apps/remote-node`）单文件零依赖，支持 `tailscale-serve` / `tailscaled-whois` / `pubkey`（Ed25519 公私钥防重放签名，支持 `authorized_keys` 热加载）/ `token`（256 位 API 密钥）鉴权、单 WSS/WS 承载同机多 Agent、EventRing 断线续传与隔离空工作目录；同时支持免装节点的 Zero-Install SSH / Tailscale SSH 兜底。
- **7 大 Coding Agent 统一适配**：Antigravity (`agy`)、OpenCode (`opencode`)、Claude Code (`claude`)、Codex (`codex`)、Gemini CLI (`gemini`)、Kiro (`kiro-cli`)、Factory Droid (`droid`)。
- **动态模型目录 + 账号安全优先的用量统计 + Quota-Saver 省额度卸载**：按 `(Host, Profile)` 实时探测模型与思考深度，不读取任何消费级订阅 OAuth 凭据也不调用未公开额度接口（仅支持 Codex 官方 `account/rateLimits/read` RPC 与用户自带按量付费 DeepSeek / OpenRouter API 余额查询）；支持将代码遍历与单测委派给本地或低价模型池，并统计会话内 Token 与卸载占比。
- **本地共享 SQLite 历史 + 跨重启恢复 + 真无痕模式**：Web Workbench（`ar ui`）、Electron 桌面端（支持三端系统托盘/状态栏驻留与托盘右键退出）与交互式终端（`ar chat` / `ar threads`）共用同一份本地 SQLite 历史库，支持 `session/resume` 跨重启无感续接与零远端留痕的 `--ephemeral` 远端无痕模式。
- **多形态前端**：Web / Electron 三栏工作台（Git Worktree 隔离、分屏对比、Diff 审阅提交、6 档权限体系、审批卡片、Subagent 蓝图编辑）、交互式终端 `ar chat`、标准 ACP 桥接 `ar acp`（Zed/JetBrains）及无头执行 `ar exec`。

## 快速开始

### 1. 构建全仓库（Go + TypeScript）
```bash
pnpm install
make all
# 如需交叉编译 Linux / macOS / Windows 全部 6 平台远端节点：
make go-build-all
```

### 2. 部署远端 Tailnet 节点
```bash
# 生成 systemd + tailscale serve 一键部署脚本
node apps/cli/dist/index.js node deploy-script --port 19420 --auth tailscale-serve
```

### 3. 初始化配置并验证连通性、模型与额度
```bash
node apps/cli/dist/index.js init
node apps/cli/dist/index.js doctor --endpoint wss://<host>.<tailnet>.ts.net/v1/ws
node apps/cli/dist/index.js models --endpoint wss://<host>.<tailnet>.ts.net/v1/ws --agent antigravity
node apps/cli/dist/index.js quota  --endpoint wss://<host>.<tailnet>.ts.net/v1/ws --agent opencode
```

### 4. 启动控制窗口或终端聊天
```bash
# 浏览器三栏工作台 (http://127.0.0.1:3775)
node apps/cli/dist/index.js ui --port 3775

# 交互式终端聊天（与 Web 共享本地 SQLite 历史）
node apps/cli/dist/index.js chat
node apps/cli/dist/index.js threads

# Electron 桌面应用（详见使用说明中的打包章节）
pnpm --filter @agent-remote/desktop add -D electron
pnpm --filter @agent-remote/desktop start
```

## 文档

- 📝 **版本更新日志**：[CHANGELOG.md](CHANGELOG.md)
- 🚀 **远端节点部署与 Tailscale Tailnet 接入指南（Linux / Snap / macOS / Windows）**：[docs/tailscale-deploy.md](docs/tailscale-deploy.md)
- 📘 **详细使用说明（安装、配置、7 款 Agent、Quota-Saver、发版与 FAQ）**：[docs/usage.md](docs/usage.md)
- 🏗️ **完整系统架构设计文档**：[docs/architecture.md](docs/architecture.md)

## 许可证与免责声明

本项目基于 [**Apache License 2.0**](LICENSE) 开源，详见 [LICENSE](LICENSE) 与 [NOTICE](NOTICE)。

`agent-remote` 是独立的开源本地编排与标准协议桥接工具，与 Google、Anthropic、OpenAI、Tailscale 或任何第三方 AI 服务提供商无隶属或背书关系；使用外部 CLI 或服务时请自行遵守对应服务条款。
