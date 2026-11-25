# agent-remote (`ar`) 详细使用说明

> **远端大脑 × 本地双手**：在远端服务器（如美国/日本 VPS、公司跳板机、云端开发机）上运行 Coding Agent 的模型推理、订阅登录与外网访问；在你的**本地电脑**上保管源码、执行 Shell 命令、管理 Git Worktree、人工审批 Diff，并在单个窗口里同时指挥多台远端主机上的多款 Agent。

---

## 目录

1. [环境要求与组件角色](#1-环境要求与组件角色)
2. [安装与编译](#2-安装与编译)
3. [远端节点部署（三种连接模式）](#3-远端节点部署三种连接模式)
4. [初始化与配置文件详解（`config.toml`）](#4-初始化与配置文件详解configtoml)
5. [7 款 Agent 适配与能力矩阵](#5-7-款-agent-适配与能力矩阵)
6. [四种使用方式详解](#6-四种使用方式详解)
   - [6.1 Web / Electron 图形工作台（`ar ui`）](#61-web--electron-图形工作台ar-ui)
   - [6.2 交互式终端聊天与共享历史（`ar chat` / `ar threads`）](#62-交互式终端聊天与共享历史ar-chat--ar-threads)
   - [6.3 Zed / JetBrains 编辑器接入（`ar acp`）](#63-zed--jetbrains-编辑器接入ar-acp)
   - [6.4 命令行运维与无头脚本（`ar doctor` / `models` / `quota` / `exec`）](#64-命令行运维与无头脚本ar-doctor--models--quota--exec)
7. [Quota-Saver 省额度实战（主脑 + 低价子代理卸载）](#7-quota-saver-省额度实战主脑--低价子代理卸载)
8. [对话保存、跨重启恢复与远端无痕模式](#8-对话保存跨重启恢复与远端无痕模式)
9. [本地 MCP 联邦与安全权限控制](#9-本地-mcp-联邦与安全权限控制)
10. [跨平台编译、Electron 打包与自动发版](#10-跨平台编译electron-打包与自动发版)
11. [常见问题排查（FAQ）](#11-常见问题排查faq)

---

## 1. 环境要求与组件角色

`agent-remote` 由两端协作完成：

| 组件 | 运行位置 | 职责 | 运行依赖 |
| :--- | :--- | :--- | :--- |
| **`agent-remote-node`** | **远端主机**（可部署多台） | 极简 Go 守护进程：Tailscale 身份鉴权、单 WSS 多路复用、MCP-over-WSS 零端口反向隧道、隔离空工作目录、模型目录与额度探测 | **零依赖**（单文件静态二进制，约 6MB）+ 已登录的各 Agent CLI |
| **`agent-remote` (`ar`) + Hub + Web/Electron** | **本地开发机** | 沙箱化本地文件/Shell 工具引擎、权限审批、Git Worktree 隔离、本地 SQLite 历史库、Subagent 联邦编排、Web/桌面/终端/ACP 前端 | **Node.js `>= 26.0.0`**（使用原生 `node:sqlite`）、`git` |

> **安全边界**：远端账号凭据、OAuth Token、API Key **永远留在远端主机**；你的本地源码、`.env`、本地执行权限 **永远留在本地机器**。

---

## 2. 安装与编译

### 方式 A：直接下载 GitHub Releases 预编译产物（推荐）

当你打 tag（例如 `v0.1.0`）触发自动发版后，可直接从 Releases 下载：
1. **远端节点二进制**：按远端架构下载对应文件（`linux-amd64` / `linux-arm64` / `darwin-arm64` / `darwin-amd64` / `windows-amd64.exe` / `windows-arm64.exe`）。
2. **本地控制端**（二选一或同时安装）：
   - **桌面客户端**：下载 `.dmg`（macOS）、`.exe`（Windows）或 `.AppImage` / `.deb`（Linux）。
   - **便携 CLI + Web 包**：解压 `agent-remote-cli-web.tar.gz`，运行 `node dist/index.js ui` 或 `node dist/index.js chat`。

### 方式 B：从源码构建

```bash
git clone https://github.com/jd04063221/agent-remote.git
cd agent-remote

# 1. 安装依赖（需 Node >= 26 与 pnpm 10）
pnpm install

# 2. 全量构建（TS 全工作区 + 本机 Go 节点）并运行测试
make all

# 3. 如需交叉编译全部 6 个平台的远端节点二进制
make go-build-all
# 输出位于 apps/remote-node/bin/
```

### 将 `ar` / `agent-remote` 注册为全局命令

```bash
# 方式 1：pnpm 全局链接
pnpm --filter agent-remote link --global

# 方式 2：直接软链（示例）
ln -sf /root/projects/agent-remote/apps/cli/dist/index.js /usr/local/bin/ar
chmod +x /root/projects/agent-remote/apps/cli/dist/index.js

# 验证
ar --help
```

---

## 3. 远端节点部署（三种连接模式）

### 模式一：Tailscale Serve 零信任直连（强烈推荐）

无需开放任何公网端口，无需管理 Token，利用 Tailscale 自动签发 HTTPS 证书并注入 `Tailscale-User-Login` 身份头（Go 节点严格校验仅允许 `127.0.0.1` / `::1` 回环代理请求，防止头伪造）。

1. **拷贝二进制到远端主机**（示例为 Linux x86_64）：
   ```bash
   scp apps/remote-node/bin/agent-remote-node-linux-amd64 user@your-vps:/tmp/agent-remote-node
   ssh user@your-vps "sudo install -m 0755 /tmp/agent-remote-node /usr/local/bin/agent-remote-node"
   ```

2. **生成并执行 systemd + `tailscale serve` 一键部署脚本**：
   ```bash
   # 在本地生成脚本
   ar node deploy-script --port 19420 --auth tailscale-serve > deploy.sh
   ```
   将 `deploy.sh` 放到远端主机执行（若只想允许指定 Tailnet 账号访问，可在 systemd `ExecStart` 追加 `--allowed-users you@example.com`）：
   ```bash
   sudo bash deploy.sh
   ```

3. **在本地验证连通性**：
   ```bash
   ar doctor --endpoint wss://<your-host>.<your-tailnet>.ts.net/v1/ws
   ```
   成功后会显示远端主机信息、Tailnet 延迟（RTT）以及远端已安装的 7 款 Agent CLI 检测状态。

### 模式二：局域网 / 本机开发调试（`dev-token` 模式）

适合不走 `tailscale serve` 的内网或本机自测：

```bash
# 在远端（或本机）启动节点
./apps/remote-node/bin/agent-remote-node \
  --listen 127.0.0.1:19420 \
  --auth-mode dev-token \
  --dev-token "my-secret-token"

# 本地探测
ar doctor --endpoint ws://127.0.0.1:19420/v1/ws --token my-secret-token
```

> 若使用 `tailscaled-whois` 模式（直连 Tailnet IP 而非 `tailscale serve`），可加 `--auth-mode tailscaled-whois --listen 100.x.y.z:19420`，Go 节点会自动通过 `/var/run/tailscale/tailscaled.sock` 校验来访者身份。

### 模式三：免部署远端节点（Zero-Install SSH / Tailscale SSH 兜底）

如果你暂时不想在远端安装 `agent-remote-node`，可在 `config.toml` 将主机 `transport` 设为 `"tailscale-ssh"` 或 `"openssh"` 并填写 `ssh_target = "user@vps"`。Hub 会自动启动本地临时 HTTP MCP 服务，通过 `ssh -R 127.0.0.1:0:127.0.0.1:<localPort>` 建立反向隧道并过滤登录 MOTD 噪声。

---

## 4. 初始化与配置文件详解（`config.toml`）

运行以下命令生成默认配置文件 `~/.config/agent-remote/config.toml`（项目根目录也可放 `.agent-remote.toml` 覆盖当前项目配置）：

```bash
ar init
```

完整配置示例与字段说明：

```toml
[hub]
bind = "127.0.0.1:3775"
expose_over_tailscale = false
default_profile = "us-agy"
# 可选：自定义本地 SQLite 历史库路径（默认 ~/.config/agent-remote/hub.sqlite）
# db_path = "/path/to/hub.sqlite"
# 可选：全局默认开启「远端无痕模式」（禁止远端 CLI 落盘对话，仅保留本地 SQLite 历史）
ephemeral_remote = false

# ---- 远端主机（支持同时配置多台）----
[hosts.us-vps]
name = "US Tailnet VPS"
transport = "tailnet-direct"          # tailnet-direct | tailscale-ssh | openssh | local
endpoint = "wss://us-vps.your-tailnet.ts.net/v1/ws"
auth = "tailscale-serve"              # tailscale-serve | tailscaled-whois | dev-token | none
max_concurrent_sessions = 8

[hosts.jp-ssh]
name = "JP Zero-Install SSH"
transport = "tailscale-ssh"
ssh_target = "dev@jp-node"

# ---- Agent Profile（同一台主机可配多个不同 Agent！）----
[profiles.us-agy]
name = "Antigravity @ US"
host = "us-vps"
agent = "antigravity"                 # antigravity | opencode | claude | codex | gemini | kiro | factory-droid
remote_bin = "agy"
default_effort = "high"

[profiles.us-opencode]
name = "OpenCode DeepSeek Pool @ US"
host = "us-vps"
agent = "opencode"
remote_bin = "opencode"
default_model = "deepseek/deepseek-4.1-flash"

[profiles.us-claude]
name = "Claude Code @ US"
host = "us-vps"
agent = "claude"
default_model = "opus"
default_effort = "high"

[profiles.us-codex]
name = "Codex @ US"
host = "us-vps"
agent = "codex"
default_effort = "high"

# ---- Subagent 蓝图（供 Quota-Saver 与原生/联邦委派使用）----
[subagents.explorer]
description = "快速全库检索与上下文摘要（卸载至低价 DeepSeek 节省主模型额度）"
system_prompt = "快速定位相关文件和符号，返回精简结构化摘要，不要倾倒整文件原文。"
tools = ["read_file", "grep", "glob", "list_dir"]
execution_mode = "federated"          # auto | native | federated
default_profile = "us-opencode"
default_model = "deepseek/deepseek-4.1-flash"
default_effort = "low"

[subagents.implementer]
description = "按范围修改代码并补充单元测试"
system_prompt = "按要求完成局部代码修改并运行本地测试，返回修改文件清单与测试结论。"
tools = ["read_file", "edit_file", "write_file", "run_command", "grep", "glob"]
execution_mode = "auto"
default_profile = "us-opencode"
default_model = "deepseek/deepseek-4.1-flash"
default_effort = "medium"

# ---- 本地工具权限策略（优先级：deny > ask > allow）----
[permissions]
default_mode = "default"              # default | accept-edits | auto | plan
allow = ["read(**)", "search(**)", "command(git status*)", "command(git diff*)"]
ask = ["write(**)", "command(pnpm *)"]
deny = ["write(.git/**)", "command(rm -rf /*)", "command(sudo *)"]

# ---- 本地 MCP 联邦（可选：把本地数据库/内网工具安全暴露给远端 Agent）----
# [local_mcp.postgres]
# command = "npx"
# args = ["-y", "@modelcontextprotocol/server-postgres", "postgres://localhost/mydb"]
```

---

## 5. 7 款 Agent 适配与能力矩阵

所有驱动均在远端禁用或拦截远端自带的文件/Shell 工具，确保模型只能通过反向隧道操作你的**本地工作区**。

| Agent | 配置值 | 远端隔离/禁用策略 | 动态模型目录 | 剩余额度探测 | 精确 Token 统计 | 跨重启远端恢复 | 远端无痕模式 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Antigravity (`agy`)** | `antigravity` | ACP + 远端工具拒批 + 本地 MCP | ✅ `agy models` + `session/new` | 订阅等级（如 `Google AI Pro`） | ✅ ACP `usage` / 估算兜底 | ✅ `session/load` + 本地回填 | ✅ 本地历史回填 |
| **OpenCode** | `opencode` | `OPENCODE_CONFIG_CONTENT` 禁内置工具 | ✅ `opencode models` + ACP | ✅ DeepSeek / OpenRouter 实时余额 | ✅ ACP `usage` / 估算兜底 | ✅ `session/load` + 本地回填 | ✅ 本地历史回填 |
| **Claude Code** | `claude` | `--disallowedTools` + `--mcp-config` | ✅ 别名列表 + 参数透传 | ✅ OAuth 5h/周窗口剩余 % 与重置时间 | ✅ 真实 `usage` + 美元费用 | ✅ `--resume <id>` | ✅ `--no-session-persistence` |
| **Codex CLI** | `codex` | `app-server` `read-only` + `dynamicTools` + 审批拦截 | ✅ `model/list` 含思考档位 | ✅ 实时 `account/rateLimits/read` 5h/周窗口 | ✅ `thread/tokenUsage/updated` | ✅ `thread/resume` | ✅ `-c ephemeral=true` |
| **Gemini CLI** | `gemini` | `.gemini/policies/` TOML 全局 deny 内置工具 | ✅ ACP | 本地估算（上游暂无限额 API） | ✅ ACP `usage` / 估算兜底 | ✅ `session/load` + 本地回填 | ✅ 本地历史回填 |
| **Kiro CLI** | `kiro` | V3 Profile allowlist `@agent_remote_local/*` | ✅ `kiro-cli chat --list-models` | 本地估算（上游暂无限额 API） | ✅ ACP `usage` / 估算兜底 | ✅ `session/load` + 本地回填 | ✅ 本地历史回填 |
| **Factory Droid** | `factory-droid` | `--remove-tools` + `--add-tools MCP:agent_remote_local` | ✅ 读取远端 `~/.factory/settings.json` | ✅ DeepSeek / OpenRouter 实时余额 | ✅ ACP `usage` / 估算兜底 | ✅ `session/load` + 本地回填 | ✅ 本地历史回填 |

---

## 6. 四种使用方式详解

### 6.1 Web / Electron 图形工作台（`ar ui`）

启动本地 Hub 并托管 `t3code` 风格的三栏多 Agent 控制面板：

```bash
ar ui --port 3775
# 浏览器打开 http://127.0.0.1:3775
```

使用 Electron 桌面窗口运行（需在具备桌面环境的机器安装 `electron`）：
```bash
pnpm --filter @agent-remote/desktop add -D electron
pnpm --filter @agent-remote/desktop start
```

**界面功能速览**：
- **左侧边栏（Threads / Remote Fleet / Subagents）**：
  - 管理多台远端主机（一键 `Connect / Probe` 查看远端已装 Agent 与 RTT 延迟）。
  - 管理各 Agent Profile（一键刷新实时模型列表与思考档位）。
  - 点击 `+ Thread` 创建任务线程：支持勾选 **Isolate in a new Git Worktree branch**（为每个并行任务自动建独立分支和 Worktree，互不踩踏）以及 **Remote incognito**（远端无痕模式）。
  - 点击 **Subagent Blueprints** 增删改子代理配置。
- **中间主画布**：
  - 实时流式输出 + 可折叠思考过程（Thinking Process）+ 子代理派发卡片。
  - **顶部 Split 下拉框**：支持双线程左右分屏对比（例如左边跑 `agy`，右边跑 `claude`）。
  - **交互式审批卡片**：当 Agent 请求写入文件或执行本地 Shell 时，自动弹出彩色 Unified Diff / 命令预览，支持 `Allow Once` / `Allow Session` / `Deny`。
  - **底部任务级 Composer**：发送前可随时切换本次任务的 Profile、模型、思考深度（动态联动模型真实支持档位）、权限模式、`Quota-Saver` 开关以及单任务子代理模型覆盖。
- **右侧检视面板（Diff / Terminal / Quota）**：
  - **Diff**：实时查看当前 Worktree 的变更文件与完整 `git diff`，支持直接填 Commit Message 一键提交。
  - **Terminal**：实时流式查看本地命令执行输出。
  - **Quota**：点击 `Check ↻` 探测当前 Agent 远端剩余额度（支持 Claude 5h/周、Codex 5h/周、DeepSeek/OpenRouter 余额），并查看本线程的 **Exact API / Estimated** Token 统计、缓存命中、思考 Token、费用与 Quota-Saver 卸载占比。

---

### 6.2 交互式终端聊天与共享历史（`ar chat` / `ar threads`）

`ar chat` 与 Web 工作台**共用同一份本地 SQLite 数据库**（`~/.config/agent-remote/hub.sqlite`）。

```bash
# 1. 使用 config.toml 中的 default_profile 直接开聊（自动保存到本地 SQLite）
ar chat

# 2. 指定 Profile、模型、思考深度，或开启远端无痕模式
ar chat --profile us-agy --effort xhigh --ephemeral

# 3. 也可以不写配置，直接连端点
ar chat --endpoint wss://us-vps.your-tailnet.ts.net/v1/ws --agent claude --model opus

# 4. 查看所有本地保存的会话（含终端与 Web 创建的线程）
ar threads

# 5. 一键恢复任意历史会话（自动还原主机、工作目录、上下文，并继续写入同一线程）
ar chat --resume thr_a1b2c3d4e5f6

# 6. 临时一次性对话，不写入本地 SQLite
ar chat --no-save
```

**对话内支持的斜杠命令**：

| 命令 | 功能 |
| :--- | :--- |
| `/models` | 实时拉取远端可用模型与支持的思考档位 |
| `/model <id>` | 动态切换下一轮使用的模型 |
| `/effort <level>` | 动态切换思考深度（`low\|medium\|high\|xhigh\|max`） |
| `/mode <mode>` | 切换本地权限模式（`default\|accept-edits\|auto\|plan`） |
| `/quota` | 实时查询远端剩余额度/余额（支持 Claude / Codex / OpenCode / Droid） |
| `/usage` | 查看当前线程精确/估算 Token 统计、缓存、思考 Token 与费用 |
| `/history` | 打印当前线程本地保存的完整聊天记录 |
| `/threads` | 列出本地 SQLite 中最近的线程列表 |
| `/diff` | 彩色查看当前本地仓库的 `git diff` |
| `/help` / `/exit` | 查看帮助 / 退出会话 |

---

### 6.3 Zed / JetBrains 编辑器接入（`ar acp`）

`ar acp` 提供标准 ACP v1 stdio 桥接，可直接在 Zed 等支持 ACP 的编辑器中把远端 Agent 当作本地原生 AI 助手使用。

在 Zed 的 `settings.json` 中添加：

```json
{
  "agent_servers": {
    "Antigravity (Remote US)": {
      "command": "ar",
      "args": [
        "acp",
        "--endpoint",
        "wss://us-vps.your-tailnet.ts.net/v1/ws",
        "--agent",
        "antigravity"
      ]
    },
    "OpenCode DeepSeek (Remote US)": {
      "command": "ar",
      "args": [
        "acp",
        "--endpoint",
        "wss://us-vps.your-tailnet.ts.net/v1/ws",
        "--agent",
        "opencode",
        "--model",
        "deepseek/deepseek-4.1-flash"
      ]
    }
  }
}
```

---

### 6.4 命令行运维与无头脚本（`ar doctor` / `models` / `quota` / `exec`）

```bash
# 节点健康检查 + 探测远端已安装的 7 款 CLI 版本
ar doctor --endpoint wss://<host>.ts.net/v1/ws

# 查询远端实时模型列表与思考档位
ar models --endpoint wss://<host>.ts.net/v1/ws --agent antigravity

# 查询远端剩余额度 / 余额（支持 --profile 或 --endpoint）
ar quota --profile us-claude
ar quota --profile us-codex
ar quota --endpoint wss://<host>.ts.net/v1/ws --agent opencode

# 无头单次执行（适合脚本与自动化，支持 --output-format text|json）
ar exec --endpoint wss://<host>.ts.net/v1/ws \
  --agent antigravity \
  --effort medium \
  --cwd /path/to/local/repo \
  -p "分析 src/ 目录结构并列出所有待办 TODO" \
  --output-format json
```

---

## 7. Quota-Saver 省额度实战（主脑 + 低价子代理卸载）

当你使用昂贵或有滚动窗口限制的闭源主模型（如 `agy`、`claude`、`codex`）时，可以开启 **Quota-Saver** 把重上下文、机械性任务卸载到低价模型池（如 `opencode` + `deepseek/deepseek-4.1-flash`）：

1. 在同一台（或不同）远端主机同时配置主脑 Profile（如 `us-agy`）和低价池 Profile（如 `us-opencode`）。
2. 在 `config.toml` 或 Web 左侧 **Subagents** 中，将 `explorer`（只读全库搜索与总结）和 `implementer`（局部实现与写单测）的 `execution_mode` 设为 `federated`，`default_profile` 指向 `us-opencode`，模型设为 `deepseek/deepseek-4.1-flash`。
3. 在 Web 底部 Composer 勾选 **Quota-Saver**（或使用预设任务配置）：
   - Hub 会自动向主脑注册 `dispatch_subagent` 与 `call_remote_model` 两个联邦工具，并注入省额度调度提示。
   - 主脑负责架构规划、疑难排查与最终把关，把大面积读文件、跑测试、日志压缩委派给 `opencode` 子代理（子代理同样通过本地沙箱安全读写你的本地代码，只把精炼摘要返回主脑）。
   - 右侧 **Quota** 面板会实时显示主脑消耗 vs. 卸载到低价子代理的 Token 占比。

---

## 8. 对话保存、跨重启恢复与远端无痕模式

- **本地持久化（默认开启）**：
  - Web（`ar ui`）、Electron 桌面端与 `ar chat` 均写入同一份本地 SQLite 数据库：`~/.config/agent-remote/hub.sqlite`。
  - 包含 `hosts`、`profiles`、`model_catalogs`、`quota_snapshots`、`subagent_blueprints`、`threads`、`thread_events` 表，老库升级会自动迁移列结构。
- **断线漫游与跨重启恢复**：
  - **网络闪断（合盖/切换 Wi-Fi）**：远端 Go 节点不杀死 Agent 进程，通过 `EventRing` 缓存在途帧，重连后按 `lastSeq` 补帧无缝续传。
  - **本地重启 Hub 或切换终端/网页**：系统优先使用保存的 `remote_session_id` 调用各 Agent 的原生恢复能力（`session/load` / `--resume` / `thread/resume`）；若远端不支持或会话已过期，则自动从本地 SQLite 读取历史对话拼装上下文回填，确保不断片。
- **远端无痕模式（Remote Incognito）**：
  - 启用方式：`config.toml` 设置 `ephemeral_remote = true`、CLI 加 `--ephemeral` / `--incognito`、或 Web 新建线程勾选 **Remote incognito**。
  - 效果：自动向支持无痕参数的远端 CLI 传递禁用落盘参数（Claude `--no-session-persistence`、Codex `-c ephemeral=true`），不记录远端 `remote_session_id`，所有历史仅留在你本机 SQLite 并在下次重启时通过本地回填恢复上下文。

---

## 9. 本地 MCP 联邦与安全权限控制

- **路径沙箱防越狱**：本地工具引擎对所有文件读写做 `fs.realpath` 规范化，严格限制在当前线程绑定的工作目录 / Git Worktree 内，并默认禁止修改 `.git/hooks` 等高危路径。
- **本地权限模式**：
  - `default`：读取/搜索默认放行，写入文件、删除文件和 Shell 命令弹窗/终端审批（含彩色 Diff 预览）。
  - `accept-edits`：自动放行工作区内文件编辑，Shell 命令仍需审批。
  - `auto`：全自动放行（仍受高危黑名单与 `deny` 规则兜底保护，如 `rm -rf /`、`sudo` 等默认拒绝）。
  - `plan`：纯只读规划模式，拒绝所有写入与命令执行。
- **本地 MCP 联邦（`[local_mcp.*]`）**：在 `config.toml` 配置本地 stdio MCP Server（如本地 PostgreSQL、内网文档库），Hub 启动时会自动把其工具挂载到 Local Tool Engine，经由权限网关审批后暴露给远端 Agent，无需把内网数据库暴露到公网。

---

## 10. 跨平台编译、Electron 打包与自动发版

### 本地一键交叉编译 6 平台 Go 远端节点
```bash
make go-build-all
```
会在 `apps/remote-node/bin/` 生成：
- `agent-remote-node-linux-amd64` / `agent-remote-node-linux-arm64`
- `agent-remote-node-darwin-arm64` / `agent-remote-node-darwin-amd64`
- `agent-remote-node-windows-amd64.exe` / `agent-remote-node-windows-arm64.exe`

### 本地打包 Electron 桌面安装包
在目标操作系统上执行：
```bash
pnpm run build
pnpm --filter @agent-remote/desktop add -D electron@35 electron-builder@25

# macOS (.dmg + .zip)
pnpm --filter @agent-remote/desktop dist:mac

# Windows (NSIS .exe + portable)
pnpm --filter @agent-remote/desktop dist:win

# Linux (.AppImage + .deb)
pnpm --filter @agent-remote/desktop dist:linux
```

### GitHub Actions 自动 CI 与 Release 发版
仓库已内置两条工作流：
- `.github/workflows/ci.yml`：每次 Push / PR 自动跑 Go `-race` 测试、6 平台交叉编译检查、TS 全量构建与 Vitest。
- `.github/workflows/release.yml`：推送 `v*` 标签（或在 GitHub Actions 页面手动触发 `workflow_dispatch`）即自动构建全部 6 平台 `agent-remote-node`、CLI+Web 便携包、macOS/Windows/Linux Electron 安装包及 SHA256 校验文件，并发布到 GitHub Releases：

```bash
git tag v0.1.0
git push origin v0.1.0
```

---

## 11. 常见问题排查（FAQ）

1. **`ar doctor` 连接报 `401` / `tailscale-serve mode only accepts loopback proxy connections`**
   - `tailscale-serve` 模式要求远端节点监听 `127.0.0.1:<port>` 且必须通过 `tailscale serve` 反代访问；如果你直接连远端 IP，请改用 `--auth-mode tailscaled-whois` 或测试时使用 `--auth-mode dev-token`。
2. **`ar models` 返回空列表**
   - 先运行 `ar doctor` 确认远端对应的 Agent CLI 已安装并在远端 `PATH` 中；若安装了自定义路径，可在 Profile 里配置 `remote_bin = "/abs/path/to/bin"`。
3. **`ar quota` 提示 `unavailable`**
   - Claude 需远端存在已登录的 `~/.claude/.credentials.json`（OAuth 订阅）；OpenCode / Factory Droid 需远端环境变量设置 `DEEPSEEK_API_KEY` 或 `OPENROUTER_API_KEY`；Antigravity (`agy 1.5.x`) 上游暂未提供非交互式剩余额度接口，仅展示订阅等级与本地 Token 统计。
4. **本地提示 Node 版本或 `node:sqlite` 错误**
   - 本项目使用 Node.js 内置 `node:sqlite`，请确保本地运行环境为 **Node.js `>= 26.0.0`**（`node -v` 检查）。
5. **在 `ar ui` 新建线程时看不到 Git Worktree 分支**
   - 请确认填写的 Local Workspace Path 是一个有效的 Git 仓库且至少有一次 commit。
