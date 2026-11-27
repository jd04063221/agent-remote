# 更新日志（Changelog）

本项目所有重要变更均记录于此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [语义化版本（Semantic Versioning）](https://semver.org/lang/zh-CN/)。

## [0.1.5] - 2026-11-27

### 新增（Added）
- **跨平台桌面端系统托盘 / 状态栏驻留与自定义图标**：
  - Windows / macOS / Linux 点击窗口关闭（`×` / `Alt+F4` / `Cmd+W`）默认隐藏进入系统托盘 / 顶部状态栏，本地 Hub 与远端任务持续后台运行；完全退出需右键点击托盘图标选择「退出 agent-remote」（macOS 同步支持标准 `Cmd+Q` 与原生全屏安全退出后再隐藏，极简无托盘桌面自动安全降级）。
  - 新增桌面单实例防重开锁（窗口在托盘隐藏时再次启动自动唤醒已有窗口，不再冲突端口 `3775`）。
  - 生成并内置全新跨平台应用与托盘图标资产（Windows 多分辨率 `.ico`、macOS `.icns` 及自适应明暗主题的 `Template` 菜单栏图标、Linux `.png`），托盘菜单自动按系统语言切换中/英文。
- **局域网 / OpenVPN / WireGuard 节点原生认证（Ed25519 公私钥 + 随机 API 密钥）**：
  - Go 远端节点新增 `--auth-mode pubkey`（读取 `~/.config/agent-remote/authorized_keys` 或 `--authorized-keys`，兼容标准 `ssh-ed25519` 与 `ed25519:` 格式，支持免重启热加载），每次建连现场以 `timestamp + nonce` 做 Ed25519 防重放签名，私钥不离本机，即使走局域网/VPN `ws://` 也无明文泄露风险。
  - 新增 `--auth-mode token --token` 友好别名（兼容 `dev-token`），Web / 桌面端添加主机弹窗支持**一键生成 Ed25519 密钥对**、导入已有 PKCS#8 / OpenSSH `~/.ssh/id_ed25519` 私钥、**随机生成 256 位 `ar_sk_` API 密钥**，并提供一键复制公钥与远端启动命令；裸局域网/VPN `IP:端口` 地址（如 `192.168.1.50:19420`）自动补全为 `ws://.../v1/ws`。

### 修复（Fixed）
- **真正零留痕的远端无痕模式（`ephemeralRemote`）与非无痕无缝会话续接**：
  - Go 远端节点与本地子进程通道按会话隔离 Antigravity（`--gemini-dir <workdir>/.ephem-gemini`）与 OpenCode（隔离 `XDG_DATA_HOME` 并兼容 Windows `%LOCALAPPDATA%` / `%APPDATA%` 登录态保护），会话结束立即销毁临时目录，确保真实 `conversations/` 目录零新增记录；所有联邦子代理默认启用无痕隔离。
  - 非无痕模式下优先通过 ACP `session/resume`（回退 `session/load`）精确恢复同一远端对话并自动重绑重启后的新 MCP 通道；会话意外断开时自动剔除僵尸 runtime，并增加 3.5s 取消宽限窗口，避免同一任务在远端碎裂为多段对话。
  - 统一多轮上下文回放（24K 字符窗口 + 子代理结果摘要）与强化 Quota-Saver 本地委派规则提示词，确保远端大脑跨重启记忆连贯且主动通过 `dispatch_subagent` 委派本地代码遍历任务。
- **彻底解决 Windows 退出后残留 Node/Electron 进程导致重开 GUI 报错的问题**：
  - `AgentRemoteHub.close()` 与 `LocalHttpMcpServer.close()` 主动调用 `ws.terminate()` 与 `closeAllConnections()` 瞬时释放 HTTP Keep-Alive 连接与端口 `3775`；修复端口被占时 `WebSocketServer` 二次抛出未捕获 `EADDRINUSE` 异常的问题。
  - 统一清理 Windows 本地/SSH/MCP 子进程管道并 `unref()` `taskkill` 与定时器，为 SQLite 启用 `WAL` + `busy_timeout`，在 Electron 退出阶段加入 `300ms` 零延迟 `unref` 看门狗兜底 `app.exit(0)`，并在端口 `3775` 被外部占用时自动重试并安全回退空闲端口。
- **深度审计边界修复与界面体验优化**：
  - 修复并发发送与取消 `graceTimer` 竞态、防止运行中误触 `Ctrl+Enter` 重复发消息；
  - 修复 Tailnet 客户端 `ManagedChannel.kill()` 通道表泄漏，并为 `handleMcpReq()` 补齐断线重连可靠回包（`sendReliable`）；
  - Web UI 将 `file://` 文件引用安全渲染为行内代码徽章，消息流仅在接近底部时自动滚底，不再打断向上翻阅历史。

## [0.1.4] - 2026-11-26

### 新增（Added）
- **Web / 桌面端完整 GFM Markdown 渲染**：新增零依赖、XSS 安全的纯 React Markdown 解析与渲染组件（`MarkdownContent`），专门兼容中文标点加粗（如 `类似**应该加重**这类`、`**“重要”**：`）与流式未闭合输出，支持标题、粗体/斜体/删除线、围栏代码块与一键复制、表格（含反引号内 `|` 联合类型与横向滚动）、任务列表与引用提示框，全面覆盖主模型回复、思考过程、子代理实时流与分屏对比面板。
- **6 档完整权限体系（新增“工作区完全权限”与“完全权限·无沙盒”）**：
  - `workspace-full`（**工作区完全权限**）：严格限定在当前工作区沙盒内（保护 `.git/hooks`），工作区内读写、删除、任意脚本/构建/测试命令及本地 MCP 全部免审批自动放行；
  - `full-access`（**完全权限·无沙盒**）：解除工作区目录沙盒限制，放行全机路径读写与全部命令（含 `sudo`）及本地 MCP（仅保留 `rm -rf /`、`mkfs`、`format`、fork bomb 极端毁灭操作兜底）；
  - 支持会话中途动态切换沙盒边界，非只读子代理（如 `implementer`）同步继承对应高权限档位。
- **Web / 桌面端版本号常驻显示**：在左侧栏 `agent-remote` 品牌下方及浏览器标签/桌面窗口标题实时展示当前版本号（自动从 Electron `app.getVersion()`、CLI 或 Hub 读取）。
- **自动化版本对比发布说明**：新增 `scripts/extract-release-notes.mjs` 并接入 Release 工作流，每次打 tag 自动在 GitHub Release 页面生成相对上一版本的中文改进说明、提交明细与完整代码对比链接。

### 变更（Changed）
- **Windows 便携版改为 `.zip` 压缩包**：将 Windows 便携版产物由单文件便携 `.exe` 改为 `agent-remote-0.1.4-windows-x64-portable.zip`（免启动二次解压、减少杀软误报，解压后可直接调用内置 `resources/bin/ar.cmd`）；NSIS 安装包仍为 `agent-remote-0.1.4-windows-x64-setup.exe`。
- **全端统一 6 档权限顺序与命名**：Web / 桌面端、`ar chat`、`ar exec`、`ar acp`、`config.toml` 与文档统一按权限由低到高排列：`plan` → `default` → `accept-edits` → `auto`（更名为“工作区安全自动”）→ `workspace-full` → `full-access`；`ar acp`（Zed / JetBrains）同步暴露 6 档模式列表并支持 `session/set_mode` 动态切换。

### 修复（Fixed）
- **修复长任务 / 长脚本超过 10 分钟触发 `ACP request "session/prompt" timed out after 600000ms` 报错，并打通全链路 5 处超时限制**：
  - 移除 ACP `session/prompt` 与 Codex `turn/start` 的 600s 墙钟上限（远端进程退出或点击“停止/强制停止”仍立即终止）；
  - Go 远端节点 MCP 桥接单次工具调用超时从 `10m` 放宽至 `2h`；
  - 本地 HTTP MCP Server 显式关闭 Node.js 默认 5 分钟 `requestTimeout`，消除本地 `opencode` / SSH 长工具调用 5 分钟被强断的隐患；
  - `run_command` 改为默认 5 分钟无输出空闲超时（只要脚本持续打印日志即自动续期，单次硬上限提升至 60 分钟；卡死无输出仍按时中止）；本地 MCP 联邦工具调用超时从 60s 提至 10 分钟。
- **修复 `v0.1.3` 下调用 MCP 或执行脚本仍弹窗要求手动确认的问题**：`workspace-full` 与 `full-access` 直接放行脚本、删除与全部 MCP 工具并跳过 `config.toml` 中的 `ask` 规则（仍保留显式 `deny` 规则）；ACP `session/request_permission` 补充识别 `toolCall.kind === "mcp"` 与 `local_mcp__`。

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

[0.1.5]: https://github.com/jd04063221/agent-remote/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/jd04063221/agent-remote/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/jd04063221/agent-remote/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/jd04063221/agent-remote/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/jd04063221/agent-remote/compare/e3f2da6...v0.1.1
[0.1.0]: https://github.com/jd04063221/agent-remote/commits/e3f2da6
