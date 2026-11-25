# 远端节点部署与 Tailscale Tailnet 接入指南

本文档提供从零在远端主机部署 **`agent-remote-node`** 并通过 **Tailscale Serve** 零信任接入 Tailnet、再由本地电脑联调验证的完整步骤。

> **为什么推荐 Tailscale Serve？**
> - **零公网端口暴露**：`agent-remote-node` 只监听本机回环 `127.0.0.1:19420`，公网完全不可见。
> - **自动 HTTPS / WSS 证书**：由 Tailscale 为 `*.ts.net` 自动签发并续期 TLS 证书。
> - **零信任身份鉴权**：Tailscale Serve 自动注入 `Tailscale-User-Login` 身份头；Go 节点严格校验仅接受来自 `127.0.0.1` / `::1` 的反代请求，并支持 `--allowed-users` 白名单，无需管理长期 Token。

---

## 目录

1. [前置条件：开启 Tailscale MagicDNS 与 HTTPS](#1-前置条件开启-tailscale-magicdns-与-https)
2. [Linux 远端节点部署（含 Ubuntu Snap `agy` 适配）](#2-linux-远端节点部署含-ubuntu-snap-agy-适配)
3. [macOS 远端节点部署（LaunchAgent）](#3-macos-远端节点部署launchagent)
4. [Windows 远端节点部署（PowerShell）](#4-windows-远端节点部署powershell)
5. [可选：远端环境变量文件（`node.env`）与访问白名单](#5-可选远端环境变量文件nodeenv与访问白名单)
6. [自检与本地电脑全链路联调测试](#6-自检与本地电脑全链路联调测试)
7. [日常运维命令与排错](#7-日常运维命令与排错)

---

## 1. 前置条件：开启 Tailscale MagicDNS 与 HTTPS

1. 登录 Tailscale 管理后台：`https://login.tailscale.com/admin/dns`
2. 确认开启 **MagicDNS** 与 **HTTPS Certificates**。
3. 在远端主机与你的本地电脑上均登录**同一个 Tailscale 账号**（或同一个 Tailnet ACL 授权网络）：
   ```bash
   # Linux 安装 Tailscale（如尚未安装）
   curl -fsSL https://tailscale.com/install.sh | sh
   sudo tailscale up

   # 查看本机 Tailnet 域名（形如 my-vps.tailxxxxx.ts.net）
   tailscale status
   ```

---

## 2. Linux 远端节点部署（含 Ubuntu Snap `agy` 适配）

### 2.1 获取并安装 `agent-remote-node` 二进制

- **方式 A：从 GitHub Releases 下载**（推荐）
  前往 `https://github.com/jd04063221/agent-remote/releases`，按架构下载 `agent-remote-node-linux-amd64` 或 `agent-remote-node-linux-arm64`：
  ```bash
  sudo install -m 0755 ./agent-remote-node-linux-amd64 /usr/local/bin/agent-remote-node
  ```

- **方式 B：从本机源码构建产物直接安装**
  ```bash
  # 在仓库根目录执行 make go-build-all 后：
  sudo install -m 0755 /path/to/agent-remote/apps/remote-node/bin/agent-remote-node-linux-amd64 /usr/local/bin/agent-remote-node
  ```

### 2.2 创建并启动 `systemd` 服务

> **重要**：`User=` 请务必填写**实际登录了 `agy` / `claude` / `codex` / `opencode` 等 CLI 的那个系统用户**（如果是在 `root` 下登录的就填 `root`，普通用户就填对应用户名），否则服务将读不到你的 OAuth 登录态！

```bash
# 确认当前登录了 Agent CLI 的用户与家目录（也可手动替换为具体用户名，例如 RUN_USER=dev）
RUN_USER="$(whoami)"
RUN_HOME="$(getent passwd "$RUN_USER" | cut -d: -f6)"

cat <<EOF | sudo tee /etc/systemd/system/agent-remote-node.service
[Unit]
Description=agent-remote Remote Tailnet Node
After=network-online.target tailscaled.service

[Service]
Type=simple
User=${RUN_USER}
Environment="HOME=${RUN_HOME}"
Environment="PATH=${RUN_HOME}/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin"
ExecStart=/usr/local/bin/agent-remote-node --listen 127.0.0.1:19420 --auth-mode tailscale-serve
Restart=always
RestartSec=2

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now agent-remote-node
sudo systemctl status agent-remote-node --no-pager
```

> **Ubuntu Snap `agy` 特别说明**：
> - `agent-remote-node` 已内置 Snap 自动适配：启动 `/snap/bin/agy` 时会自动避开 Snap 私有 `/tmp`，把每会话临时目录建在宿主机与 Snap 共享的 `$HOME/snap/antigravity-cli/common/ar-sessions`（或 `$HOME/agent-remote-sessions`），也可以通过 `--work-base-dir` 手动指定。
> - 如果远端 CLI 是通过 `nvm` / `fnm` / `volta` / `pnpm` / `bun` 安装的，Go 节点会自动扫描这些目录并注入子进程 `PATH`。

### 2.3 使用 `tailscale serve` 暴露 WSS 端点

```bash
sudo tailscale serve --bg http://127.0.0.1:19420
tailscale serve status
```

- 若首次执行提示「Serve is not enabled on your tailnet」，打开终端打印的授权 URL 启用即可，然后重跑上述命令。
- 记下输出的 HTTPS 地址，例如 `https://my-vps.tailxxxxx.ts.net`，对应的 WebSocket 端点即为：
  **`wss://my-vps.tailxxxxx.ts.net/v1/ws`**

---

## 3. macOS 远端节点部署（LaunchAgent）

macOS 推荐同样使用 `--auth-mode tailscale-serve`（`agent-remote-node` 在 macOS 上已原生支持从系统 Keychain 读取 Claude Code OAuth 额度，且自动搜索 `/opt/homebrew/bin`）。

1. 下载 `agent-remote-node-darwin-arm64`（Apple Silicon）或 `agent-remote-node-darwin-amd64`（Intel）：
   ```bash
   sudo install -m 0755 ./agent-remote-node-darwin-arm64 /usr/local/bin/agent-remote-node
   ```
2. 使用 CLI 一键生成并执行 LaunchAgent 部署脚本：
   ```bash
   ar node deploy-script --os macos --port 19420 --auth tailscale-serve > deploy-macos.sh
   bash deploy-macos.sh
   ```
3. （可选）防止合盖休眠断开 Tailnet：在系统设置关闭自动休眠，或使用 `caffeinate -s`。

---

## 4. Windows 远端节点部署（PowerShell）

Windows 远端同样推荐使用 `--auth-mode tailscale-serve`（Windows 无 Linux Unix Socket，**不要**使用 `tailscaled-whois`）。

1. 从 Releases 下载 `agent-remote-node-windows-amd64.exe`（或 `arm64.exe`），放到例如 `C:\agent-remote\agent-remote-node.exe`。
2. 在 PowerShell 中启动节点并配置 `tailscale serve`：
   ```powershell
   # 启动远端节点（可配合 NSSM 或任务计划程序设为后台常驻）
   C:\agent-remote\agent-remote-node.exe --listen 127.0.0.1:19420 --auth-mode tailscale-serve

   # 在另一个 PowerShell 窗口开启 Tailscale Serve 代理
   tailscale serve --bg http://127.0.0.1:19420
   tailscale serve status
   ```

---

## 5. 可选：远端环境变量文件（`node.env`）与访问白名单

### 5.1 注入 BYOK API Key 或代理（凭据永不离开远端）

`agent-remote-node` 启动时会自动加载 `~/.config/agent-remote/node.env`（也可用 `--env-file <path>` 指定）：

```bash
mkdir -p ~/.config/agent-remote
cat <<'EOF' > ~/.config/agent-remote/node.env
# 用于 OpenCode / Factory Droid 余额查询或模型调用
# DEEPSEEK_API_KEY=sk-xxxx
# OPENROUTER_API_KEY=sk-or-xxxx
# HTTPS_PROXY=http://127.0.0.1:7890
EOF
chmod 600 ~/.config/agent-remote/node.env
sudo systemctl restart agent-remote-node
```

### 5.2 锁定仅允许指定 Tailnet 账号访问

测通后，强烈建议在 `ExecStart` 中加上 `--allowed-users`（多个邮箱用英文逗号分隔）：

```ini
ExecStart=/usr/local/bin/agent-remote-node --listen 127.0.0.1:19420 --auth-mode tailscale-serve --allowed-users your-email@example.com
```

修改 unit 文件后重载生效：
```bash
sudo systemctl daemon-reload && sudo systemctl restart agent-remote-node
```

---

## 6. 自检与本地电脑全链路联调测试

### 6.1 远端主机本机自检

```bash
# 1. 回环健康检查（预期输出 {"ok":true,"version":"0.1.0"}）
curl -s http://127.0.0.1:19420/healthz && echo

# 2. 经 Tailscale Serve 代理的 HTTPS 健康检查
curl -s https://<你的主机名>.<你的tailnet>.ts.net/healthz && echo
```

### 6.2 本地电脑 CLI 联调

在已登录同一 Tailnet 的本地电脑上（安装 Releases 中的 `agent-remote-cli-web.tar.gz` 或本地仓库）：

```bash
ENDPOINT="wss://<你的主机名>.<你的tailnet>.ts.net/v1/ws"

# 1. 检查节点延迟（RTT）与远端已安装的 7 款 Agent CLI
ar doctor --endpoint "$ENDPOINT"

# 2. 实时拉取远端可用模型与思考档位
ar models --endpoint "$ENDPOINT" --agent antigravity

# 3. 实时查询远端剩余额度/余额（按需替换 claude / codex / opencode）
ar quota --endpoint "$ENDPOINT" --agent claude

# 4. 启动交互式对话（思考在远端，读写文件和命令执行在你本地电脑）
ar chat --endpoint "$ENDPOINT" --agent antigravity
```

### 6.3 本地电脑 Web / Electron 图形界面联调

1. 启动桌面客户端（从 Releases 下载 `.exe` / `.dmg` / `.AppImage`）或运行 `ar ui` 打开 `http://127.0.0.1:3775`（左上角可自由切换 **简体中文 / 繁體中文 / English / 日本語**）。
2. 点击 **+ 主机** → 传输方式选 `Tailnet 直连 (WSS)` → 端点填 `wss://<你的主机名>.<你的tailnet>.ts.net/v1/ws` → 认证选 `Tailscale Serve` → 保存后点 **连接探测**。
3. 点击 **+ Agent** → 绑定刚添加的主机，选择远端已安装的 CLI（如 `Antigravity CLI (agy)`）→ 保存后点 **拉取模型 ↻** 确认拉取成功。
4. 点击 **+ 新建线程** → 填入本地项目目录（可勾选 Git Worktree 隔离或远端无痕模式）→ 发送「列出当前目录的文件并概述项目结构」，即可看到本地审批卡片、Diff 检视与实时流式输出。

---

## 7. 日常运维命令与排错

```bash
# 查看远端节点实时日志（Linux）
sudo journalctl -u agent-remote-node -f

# 查看 / 重置 Tailscale Serve 规则
tailscale serve status
sudo tailscale serve reset

# 升级远端二进制（覆盖后重启即可）
sudo install -m 0755 ./agent-remote-node-linux-amd64 /usr/local/bin/agent-remote-node
sudo systemctl restart agent-remote-node
```

**常见报错速查**：
- **`401 Unauthorized` / `missing Tailscale-User-Login header`**：直接连了 `ws://ip:19420` 而没走 `tailscale serve` 的 `wss://*.ts.net/v1/ws`，请改用 `wss://` 域名或本地测试时临时切 `--auth-mode dev-token`。
- **`ar doctor` 显示某 Agent `✗ not installed`**：检查 `systemd` 的 `User=` 是否与安装该 CLI 的用户一致，或在 Profile 里填写远端绝对路径 `remote_bin`（可用 `which agy` / `which claude` 查到）。
- **连接超时**：在本地电脑运行 `tailscale ping <你的主机名>` 确认两端已同在 Tailnet 且在线。
