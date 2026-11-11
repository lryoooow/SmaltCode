# 仓库工作约定

## 验证与多平台打包方式

- 日常自动化测试、类型检查与 Windows 桌面安装包（`npm run package:desktop`）均在本地执行，不启用任何 `push` / `pull_request` 自动触发的远程 CI。
- 经维护者明确授权，仓库仅保留 `.github/workflows/package-macos.yml` **纯手动触发工作流（`workflow_dispatch`）**，用于在无本地 Mac 设备时按需构建 macOS `arm64` / `x64` Ad-hoc 签名的 DMG 与 ZIP 安装包；不得添加自动触发器，也不主动触发远程运行。
- 保留并维护本地验证脚本，按修改范围运行类型检查、自动化测试和桌面验收，在提交说明中记录实际结果。
- 不因 GitHub 账户的计费限制反复尝试远程检查，也不要求维护者购买 CI 服务或付费证书。
