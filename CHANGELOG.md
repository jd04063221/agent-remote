# 更新日志（Changelog）

本项目所有重要变更均记录于此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本（Semantic Versioning）](https://semver.org/lang/zh-CN/)。

## [0.1.3] - 2026-11-25

### 新增（Added）
- **子代理实时流式进度与主工具状态**：新增 `subagent_status`、`subagent_stream`（实时思考链与文本输出流）、`subagent_tool` 以及主模型 `tool_activity` WebSocket 事件；工作台统一 Subagent 卡片支持实时查看运行状态、工具调用明细与流式输出。
- **可搜索、可滚动的模型选择器（`<ModelPicker />`）**：解决 OpenCode 等 230+ 模型列表在下拉框中无法滚动、难以查找的问题，支持关键字检索与按 Provider 分组浏览。
- **两段式任务与子代理取消（Stop / Force Stop）**：每次对话轮次使用独立 `AbortController`，点击停止会同步终止运行中的联邦子代理并拒绝挂起审批；若 1.2s 内远端未响应或再次点击“强制停止”，立即断开卡死会话并在下一轮基于本地 SQLite 历史无感续聊。
- **跨主机端到端模拟测试**：新增真实拉起 Go `agent-remote-node` 的集成测试（`apps/hub-server/src/cross-host-sim.test.ts`），覆盖“远端 `agy` 读本地项目 → 派发任务至本地 `opencode` → 实时流式回传 → 同线程中途动态切换路由”完整链路。

### 变更（Changed）
- **动态思考深度档位**：移除固定 5 档与虚构的 `max` 档位；Composer、Blueprint 编辑弹窗、Subagent 抽屉与后端统一按当前所选模型的真实 `supportedEfforts` 动态渲染与校验。
- **主主机优先的子代理路由**：移除默认蓝图中写死的 `deepseek/deepseek-4.1-flash`（并对既有 SQLite 数据库自动迁移）；未显式指定目标主机/模型时优先使用主模型所在主机与 Agent，显式指定时精准路由至目标主机。
- **远端 `agy` / `opencode` 的 `auto` 蓝图默认走联邦子代理**：确保默认未修改蓝图时主模型即可获得 `dispatch_subagent` 工具，且在会话中途修改蓝图或抽屉覆盖配置后，下一轮立即按最新配置生效。
- **版本统一升级**：CLI（`ar --version`）、Desktop preload 与 Go `agent-remote-node`（`/healthz`）版本号统一更新为 `0.1.3`。

### 修复（Fixed）
- 修复 `PolicyEngine` 在默认模式下将内部 `dispatch_subagent` / `call_remote_model` 拦截为审批请求导致委派阻塞的问题（子代理内部所有文件与命令工具仍独立受本地沙盒与策略审批保护）。
- 修复本地 `opencode` 子代理收不到角色系统提示词与本地工作区/MCP 指引的问题，派发时自动注入精简的 `[Subagent Role]` 与 `[Workspace Context]`。
- 修复 ACP 会话多项运行期兼容性问题：
  - `session/request_permission` 改为检索完整序列化 `toolCall`，避免漏判 `call_remote_model` 或非 `title` 字段中的 MCP 工具调用；
  - 对 `opencode` 关闭 `blockRemoteBuiltins`（其内置 FS/Shell 工具已由 `OPENCODE_CONFIG_CONTENT` 全部禁用）；
  - `setModelAndEffort` 增加 `session/set_model` 回退并将 `thought_level` 独立容错，兼容 OpenCode ACP 协议；
  - `fs/read_text_file` / `fs/write_text_file` 自动将远端 Linux 空工作目录或本地临时目录路径折算到本地项目相对路径，避免误报 `SandboxViolationError`。
- 修复本地 HTTP MCP Server 对 MCP `2025-03-26` Streamable-HTTP 规范的兼容性（`GET /mcp` 返回 `405`、`DELETE /mcp` 返回 `204`、无 `id` 的 `notifications/*` 返回 `202`）。
- 修复 `LocalProcessChannel` 缺失进程 `error` 事件监听导致本地未安装目标 CLI 时 Electron 崩溃的问题，补齐 Windows 含空格可执行文件路径引号转义，并在进程退出时自动清理 `ar-local-sess-*` 临时目录。
- 放宽 OpenCode `OPENCODE_CONFIG_CONTENT` 中的本地 MCP 权限匹配前缀，同时保持所有内置工具严格禁用。

## [0.1.2] - 2026-11-25

### 新增（Added）
- **桌面端安装包内置 `ar` / `agent-remote` CLI**：直接复用 Electron 内嵌 Node 运行时（`ELECTRON_RUN_AS_NODE=1`），Windows NSIS 安装包自动写入/卸载用户级 `PATH`，Linux `.deb` 包自动注册 `/usr/local/bin/ar` 与 `/usr/local/bin/agent-remote`，CI 同步加入三平台 CLI 冒烟测试。
- **Host / Profile / Thread 编辑与二次确认删除**：支持在 Web / 桌面端直接编辑或删除已添加的远端主机、Agent Profile 与历史会话线程。
- **多语言界面（i18n）**：内置简体中文（`zh-CN`）、繁体中文（`zh-TW`）、English（`en`）、日本語（`ja`），支持自动检测浏览器/系统语言与顶部一键切换。
- **Tailscale Tailnet 远端节点部署指南**：新增 `docs/tailscale-deploy.md`，涵盖 Linux / Snap / macOS / Windows 节点部署与 `tailscale serve --bg` 配置步骤。

### 修复（Fixed）
- 修复桌面端添加远端 Host 后一直停留在 `Connect` 状态的问题：自动将 `https://<host>` 规范化为 `wss://<host>/v1/ws`、增加 12 秒连接超时、透传 HTTP 401/404 错误响应详情、在修改或出错时清理过期客户端缓存，并将 Go 远端节点的 CLI 探测改为并发执行以缩短连接耗时。
- 修复 macOS Apple Silicon 打包跳过 ad-hoc 签名及 CI 冒烟测试在 `pipefail` 下因 `head` 触发 `SIGPIPE` 失败的问题。
- 升级 `zod` 至 `^4.6.6`、`vitest` 至 `^4.1.12` 并完成 v4 适配，消除全部依赖安全告警。

## [0.1.1] - 2026-11-25

### 新增（Added）
- **跨平台本地 × 远端全矩阵适配**：补齐 Windows PowerShell UTF-8 编码、`.cmd`/`.ps1` 启动与进程树清理、Linux Snap 共享工作目录与 SSH 工作目录兼容、macOS Keychain Claude 额度读取、`launchd`/`systemd` 一键部署脚本生成、全部 7 款 Agent 的 `ar acp` 桥接支持以及 Web 端默认工作目录填充。

### 修复（Fixed）
- 修复 Linux `.deb` 安装包的 `executableName` 与非 scoped 包名配置、区分 Windows 安装包与便携版产物命名，并为 `electron-builder` 显式传入 `--publish never`。

## [0.1.0] - 2026-11-25

### 新增（Added）
- **核心架构与 Go + TypeScript Monorepo**：建立“远端大脑 × 本地双手”分布式多 Agent 控制平面。
- **Go 远端轻节点（`apps/remote-node`）**：零依赖单文件二进制，支持 `tailscale-serve` / `tailscaled-whois` / `dev-token` 鉴权、单 WSS 连接多路复用、EventRing 断线续传、隔离空工作目录、零端口 MCP-over-WSS 桥接与 6 平台交叉编译。
- **7 大 Coding Agent 统一驱动**：接入 Antigravity (`agy`)、OpenCode (`opencode`)、Claude Code (`claude`)、Codex (`codex`)、Gemini CLI (`gemini`)、Kiro (`kiro-cli`)、Factory Droid (`droid`)。
- **本地工具平面与策略沙盒**：实现 `WorkspaceSandbox`、`PolicyEngine`、本地 HTTP MCP Server、本地 MCP 联邦以及 Git Worktree 分支隔离与 Diff 审阅。
- **动态模型目录、远端实时额度与 Quota-Saver 卸载**：实时探测模型与远端剩余额度（支持 Claude OAuth、Codex `account/rateLimits/read`、DeepSeek/OpenRouter 余额），支持 Track 1 原生子代理编译与 Track 2 跨机联邦委派。
- **多形态前端与共享 SQLite 历史**：提供 Web / Electron 三栏工作台（含分屏对比、审批卡片、Subagent 蓝图编辑）、交互式终端 `ar chat` / `ar threads`、标准 ACP 桥接 `ar acp`、无头执行 `ar exec` 与 `--ephemeral` 远端无痕模式。
- **零安装 SSH 兜底与配置管理**：支持 SSH / Tailscale SSH 免装节点接入、TOML 配置文件初始化（`ar init`）以及 GitHub Actions CI 与多平台 Release 自动发版流水线。

[0.1.3]: https://github.com/jd04063221/agent-remote/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jd04063221/agent-remote/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jd04063221/agent-remote/compare/e3f2da6...v0.1.1
[0.1.0]: https://github.com/jd04063221/agent-remote/commits/e3f2da6
