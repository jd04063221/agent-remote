# 安全策略

## 报告漏洞

请不要在公开 issue 中报告安全问题，改用 GitHub 的私有漏洞报告：

- 仓库页面 → **Security** → **Report a vulnerability**
- 直达：https://github.com/jd04063221/agent-remote/security/advisories/new

## 范围

本仓库为公开项目，以下情况一律按安全问题处理：

- 提交历史或发布物中出现 token、私钥、口令等凭据
- 自动化流程把本机敏感文件（`.env`、SSH 私钥、`*.db` 等）带入版本库
- 远端节点鉴权（Tailscale WhoIs / SSH）被绕过的路径

## 响应

个人维护，通常 7 天内回复。确认后会尽快修复，并在 Security Advisory 中披露。
