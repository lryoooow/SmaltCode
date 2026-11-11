# SmaltCode macOS 适配与验收

状态：源码适配和 Windows 主机可执行的回归已开展；尚未在真实 Mac 构建、签名、公证或完成界面验收。当前 GitHub v0.0.7 提供 Windows 安装包。本文不表示已有可下载的 Mac 安装包。

2026-10-28 本地验收：合并完整回归及最终受影响文件复测后，1,057 项通过、0 项失败；3 项 CLI 打包可执行文件测试因缺少对应 fixture 跳过。类型检查、桌面构建、Windows 启动/空页面拒绝、预览品牌及真实 PTY/Job Object 退出清理通过；18 项真实 LibreOffice 编辑、保存与恢复用例通过。首次 Office 样例生成使用了不含依赖的引擎 Python，已切换到既有测试 Python 并完成受影响用例复测。以上均为 Windows 主机结果，不能替代 Mac 原生验收。

2026-10-30 继续适配：加入跨平台证书后台生成、真实 Electron/ASAR 指纹链路验收和 Mac Office 只读诊断。合并整体回归及最终受影响文件复测后，1,050 项通过、0 项失败；21 项未运行（18 项未改动的 Windows 原生 Office 用例本轮未重跑，3 项 CLI 缺少可执行 fixture）。Docker 未运行导致的环境失败，已在恢复原有引擎后完成本机/SSH 容器与 Dev Container 复测，没有下载镜像。类型检查、桌面启动、实际 Electron 44.7.0 工作线程与 HTTPS 指纹校验通过。Mac 安装、签名、公证和界面验收仍未进行。

## 平台与分发

- 最低 macOS 13 Ventura，与项目使用的 Electron 44.7.0 最低版本一致。
- Apple Silicon 使用 arm64；Intel 使用 x64。先分别构建和验收，不宣称支持 Universal。
- 默认方案为 Developer ID 直接分发的 DMG / ZIP。DMG 提供拖入 Applications 的入口。
- Mac App Store 需要另行设计 App Sandbox、文件授权与执行能力，不将直接分发包当作商店版本。
- 不使用 GitHub Actions；构建、签名、公证、验收都在维护者的 Mac 本地执行。

## 已加入的源码适配

| 范围 | 行为 |
| --- | --- |
| 主窗口与独立审阅窗 | 原生红黄绿按钮；为系统按钮预留标题栏空间，不叠加 Windows 控件 |
| 顶部菜单 | 关于、设置、服务、隐藏、退出；文件、编辑、显示和窗口菜单；原生复制粘贴与撤销角色 |
| 快捷键 | ⌘N 新建对话、⌘, 设置；界面提示将 Ctrl / Shift / Alt 转换为 Mac 符号 |
| 驻留与退出 | 主窗口关闭后后台驻留；Dock 点击恢复原窗口；菜单栏退出和 ⌘Q 进入既有清理流程 |
| 品牌 | 同一份 S Fox SVG 生成 ICNS、原 Windows ICO / PNG、菜单栏透明模板及 Retina 资源 |
| 本地存储 | 新用户使用 `~/Library/Application Support/SmaltCode`；存在 `~/.smalt` 时继续使用原资料；显式 `SMALT_HOME` 优先，不自动迁移 |
| 终端 | Mac 使用 `/bin/zsh -f`，不自动载入用户 shell 配置；不传 Windows ConPTY 参数；保留 native helper 的执行权限 |
| 远程 HTTPS | 后台工作线程生成 RSA/SHA-256 自签服务器证书和加密 PFX；无需 PowerShell 或 OpenSSL 命令；沿用显式确认的证书指纹，支持取消和并发限制 |
| Mac Office 检测 | 手动选择应用包后只读检查结构、签名、Gatekeeper 和 Python 入口；不启动 Office/Python，不写引擎配置；切换文档或退出会取消检查，结果始终标明保存链未验证 |
| 开发预览 | 本机独立的 SmaltCode Preview.app、独立数据与 bundle ID；仅作 ad-hoc 本地签名，不能作为正式发行包 |
| 发行构建 | 独立 Mac 候选目录，强制 Developer ID、hardened runtime、最小 JIT entitlement 和 Apple 公证；失败不替换已有包 |

## 本地开发预览

在对应架构的 Mac 安装 Node.js 22 或更新版本并检出源码后：

```sh
npm ci
npm run preview:desktop
```

预览生成于仓库 `.local-preview/runtime/`，数据位于 `.local-preview/data/`。不会修改共享 Electron 依赖或正式用户资料。修改后的本地应用需 ad-hoc 签名才能在 Apple Silicon 上运行；这不等同于 Developer ID 或公证。`--no-build` 仅适用于已构建的最新源码。

## 社区测试版（Ad-hoc 签名 DMG / ZIP）构建与安装

当尚未配置付费 Apple Developer ID 证书时，可通过显式 `--adhoc`（或环境变量 `SMALT_MAC_ADHOC=1`）构建可在 Apple Silicon（`arm64`）与 Intel（`x64`）Mac 上直接运行的 Ad-hoc 签名 DMG 与 ZIP 安装包：

### 方式一：在 Mac 本机执行 Ad-hoc 打包

```sh
# Apple Silicon Mac（Node 22 arm64）
node scripts/build-desktop-mac.mjs --arch arm64 --adhoc

# Intel Mac（Node 22 x64）
node scripts/build-desktop-mac.mjs --arch x64 --adhoc
```

### 方式二：GitHub Actions 手动按需构建（`workflow_dispatch`）

仓库提供纯手动触发工作流 `.github/workflows/package-macos.yml`（不会在 `push` 或 `pull_request` 时自动运行）：

1. 打开仓库 GitHub 页面 → **Actions** → **Package macOS Desktop (Manual)** → 点击 **Run workflow**。
2. 选择架构（`both` 同时构建 `arm64` 与 `x64`，或单选），可选填入已创建的 Release Tag（例如 `v0.0.8`）以自动附加安装包与 `SHA256SUMS`。
3. 工作流在原生 `macos-15`（`arm64`）与 `macos-15-intel`（`x64`）环境完成类型检查、内核单测、Electron 打包、`codesign --verify`、启动冒烟测试与原生 `node-pty` ABI 验证后，上传 `SmaltCode-macOS-arm64-adhoc` 与 `SmaltCode-macOS-x64-adhoc` 产物。

### macOS 用户首次安装打开说明

由于 Ad-hoc 签名包未经过付费 Apple 公证，通过浏览器下载 `.dmg` / `.zip` 并将 `SmaltCode.app` 拖入 `/Applications` 后，首次双击可能被 macOS Gatekeeper 拦截提示“无法验证开发者”或“已损坏”。在终端执行一次以下命令清除下载隔离扩展属性即可正常启动：

```sh
xattr -cr /Applications/SmaltCode.app
```

---

## 正式公证候选包（Developer ID + Notarization）

需要真实 Mac、Apple Developer Program 的 Developer ID Application 证书、Apple 签名工具以及可用的公证凭据。证书和密钥留在维护者的 Mac 钥匙串，不发到对话或提交进仓库。

先按照 Apple 的 notarytool 文档将凭据存入钥匙串。用本机环境变量选择身份和已保存的 profile：

```sh
export CSC_NAME='Developer ID Application: YOUR NAME (YOURTEAMID)'
export APPLE_KEYCHAIN_PROFILE='your-local-notary-profile'

# Apple Silicon，要求当前 Node 也是 arm64
npm run package:desktop:mac -- arm64

# Intel，要求当前 Node 也是 x64；在对应环境单独运行
npm run package:desktop:mac -- x64
```

使用非默认钥匙串时可设置 `APPLE_KEYCHAIN`。本流程只采用该 profile，拒绝同时混入其他 Apple 账号/API 公证环境变量。签名身份缺失、公证凭据不可用、架构不匹配或在 Windows 上执行时明确停止；不会退回未签名的正式包。

脚本进行类型检查、源码构建、bundle 身份/版本/图标检查、Mach-O 架构检查、签名完整性、Gatekeeper、Apple 公证/装订、启动与驻留退出、真实 PTY ABI/输入/会话隔离及 ZIP 解包核对。DMG 另行提交公证并装订；生成 SHA256SUMS.txt 和自动验收记录。

候选位于 `packages/desktop/release-mac/<版本>-<架构>-<时间>/`。失败资料保留在 `.qa-work/mac-package-*/`，不清理旧 Windows 包或 Mac 候选。脚本不上传 GitHub、不发布 Release；仍须人工验收。

## 发布前必须完成的真实 Mac 验收

两种架构分别记录机器型号、系统版本、源代码提交、包哈希、测试结果。源码单测和 Windows 截图不能代替下列项目。

1. **首次安装与系统验证**：通过浏览器下载 DMG，保留系统 quarantine；按正常系统流程验证 Gatekeeper、拖入 Applications、首次启动。不能以关闭 Gatekeeper 作为通过依据。
2. **图标与窗口**：Finder、DMG、Applications、Dock、菜单栏及关于页面均为 S Fox；浅深主题/Retina、最大化和全屏布局正确。关闭后 Dock 恢复原窗口，不创建重复任务。
3. **浏览与切换**：对话运行时切换历史、项目、搜索、资料和多个文档标签；正在运行的任务不被暂停或重建。输入法、⌘ 快捷键、系统编辑菜单和原生文件选择器行为正确。
4. **权限与网络**：模型密钥和搜索密钥采用 Mac Keychain 支持的 safeStorage；重启后验证；目录、SSH 凭据、主机指纹、取消/断线不重放命令、终端输入授权与来源隔离分别回归。
5. **进程与退出**：自然退出、停止、终端关闭、⌘Q、菜单栏退出、应用重开、清理失败返回检查；真实子孙进程和异常断线不遗留。Windows Job Object 的结果不作为 Mac 的证明。
6. **Office 与原件保护**：见下一节；验证文件预览、草稿、外部版本冲突、关闭前保存和崩溃恢复。未通过的引擎能力不得作为 Mac 完整编辑功能宣传。
7. **升级与数据**：新资料位置和旧 `~/.smalt` 分别验证；测试资料不混入正常资料；同一签名身份升级后密钥、历史和隔离目录仍可用。

## 当前明确的验收边界

- 没有真实 Mac 的签名、公证、Gatekeeper 和界面测试结果，因此尚未交付可安装的 Mac 版本。
- Microsoft Office COM 工作进程、现有 LibreOffice 的 `soffice.exe` / Python 配置依赖 Windows。Mac 原生 Office 完整编辑引擎尚未接入和验证；不能选择 Windows 可执行文件作为替代。
- Mac 审阅窗的“检查 Mac 引擎”只用于准备真实环境诊断。即使找到应用并通过系统签名检查，也不会将引擎标为可用；还需确认 UNO、独立进程和 DOCX/XLSX/PPTX 保存重开。
- Unix PTY 的子孙进程停止/退出保证须做真实 Mac 专项回归，不能用 Windows supervisor 的测试替代。原生 PTY 自动门禁覆盖 ABI、Unicode 目录、输入、会话隔离与自然退出，不声称覆盖 daemon/脱离会话进程。
- 远程 HTTPS 证书生成已改用跨平台后台工作线程，Windows 上的真实 Electron/ASAR 和指纹校验链路已验证；Mac 上仍需跑同一原生验证。自签证书不会自动获得浏览器或系统信任，也不会被自动导入系统信任库。
- SSH、容器、联网搜索和主界面的平台无关单测不能证明 Mac Keychain、系统弹窗、网络和文件权限已验收。
- 手机查看、远程连接和任务切换沿用现有权限规则；增加 Mac 目标不扩大代理的本地凭据访问范围。

## 原生证书验收

本地原生证书验收（先完成桌面 bundle）：

```sh
node scripts/test-desktop-certificate.mjs
```

该脚本使用隔离资料和回环 HTTPS，检查 ASAR 外部工作线程、界面线程可响应、取消清理、指纹一致时成功，以及指纹变化后不发送认证 HTTP 数据。输出仅含验收结果，不保存明文私钥或密钥口令。

## 官方依据

- [Electron 44：最低 macOS 13](https://www.electronjs.org/blog/electron-44-0)
- [Electron 签名与公证](https://www.electronjs.org/docs/latest/tutorial/code-signing)
- [Apple：分发前公证](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)
- [Apple：应用图标](https://developer.apple.com/design/human-interface-guidelines/app-icons)
- [Electron 原生窗口](https://www.electronjs.org/docs/latest/api/browser-window)
- [Electron Mac App Store 的独立要求](https://www.electronjs.org/docs/latest/tutorial/mac-app-store-submission-guide)
- [node-forge 官方变更记录与安全修复](https://github.com/digitalbazaar/forge/blob/main/CHANGELOG.md)：证书生成依赖固定为 1.4.2；TLS 对端指纹与证书检查仍使用 Node.js 原生能力。
- [LibreOffice 官方 macOS 应用包描述](https://github.com/LibreOffice/core/blob/master/sysui/desktop/macosx/Info.plist.in)：应用入口声明用于只读检测，不代表外部 UNO 环境已可用。

electron-builder 的选项以仓库实际安装的 25.1.8 类型和 schema 为准，配置测试会检查兼容性，不直接套用其他大版本的配置。
