# SmaltCode

<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/brand/smaltcode-wordmark-dark.svg" />
    <img src="docs/brand/smaltcode-wordmark-light.svg" width="400" height="115" alt="SmaltCode · S Fox 狐狸 Logo" />
  </picture>
  <p><strong>让 AI 的思考、执行与项目管理，回到一个清爽的工作区。</strong></p>
  <p>多模型 AI 编程与办公桌面助手 · 中文界面 · 本地项目 · 可控执行</p>
  <p>
    <img src="https://img.shields.io/badge/version-0.0.2%20preview-2F4FD0" alt="0.0.2 公开测试版" />
    <img src="https://img.shields.io/badge/platform-Windows%20x64-5B6475" alt="Windows x64" />
    <img src="https://img.shields.io/badge/license-Apache--2.0-23A075" alt="Apache-2.0" />
  </p>
  <p><a href="https://github.com/lryoooow/SmaltCode/releases/tag/v0.0.2">下载安装</a> · <a href="#快速开始">快速开始</a> · <a href="https://github.com/lryoooow/SmaltCode/issues">反馈与建议</a> · <a href="CONTRIBUTING.md">参与贡献</a></p>
</div>

> **v0.0.2 是公开测试版本。** 我们希望和大家一起把 SmaltCode 做好：欢迎试用、报告 Bug、提出交互和功能建议，也欢迎提交代码与文档改进。功能、兼容性和模型适配仍在持续打磨，请先在可以备份和恢复的项目中体验。

![SmaltCode 对话与执行界面](docs/images/conversation.png)

## 目录

- [它能做什么](#它能做什么)
- [界面一览](#界面一览)
- [下载与安装](#下载与安装)
- [快速开始](#快速开始)
- [权限与运行体验](#权限与运行体验)
- [v0.0.2 更新内容](#v002-更新内容)
- [v0.0.1 更新内容](#v001-更新内容)
- [测试版的边界](#测试版的边界)
- [常见问题](#常见问题)
- [参与建设](#参与建设)
- [开发与验证](#开发与验证)
- [项目结构](#项目结构)
- [开源协议与致谢](#开源协议与致谢)

## 它能做什么

SmaltCode 把模型对话连接到实际工作文件夹。你可以让它理解代码、修改文件、运行命令、整理资料，再查看执行记录、文件产物和修改差异。桌面端与命令行共用同一个智能体内核。

| 能力 | 当前体验 |
| --- | --- |
| 多模型接入 | 内置多个服务商配置，支持 OpenAI 兼容 Chat Completions 与 Anthropic Messages 协议，也可连接本机 Ollama；服务地址与模型 ID 可修改 |
| 实际任务执行 | 读取与编辑文件、执行命令、展示计划、流式输出、查看产物和 diff |
| 项目与对话 | 左侧项目分组、项目说明与默认文件夹，对话重命名、置顶、归档、恢复与删除 |
| 灵活审批 | 运行中调整权限，允许一次、本组操作或本对话同类操作，并可撤销额外许可 |
| 清晰的过程展示 | 思考、计划、命令与文件变更合并到默认折叠的过程区，按需展开详情 |
| 自由浏览 | 运行时上翻历史、查看文件、切换对话；保留阅读位置，点击“查看最新”恢复跟随 |
| 后台驻留 | 关闭窗口隐藏到系统托盘，后台任务继续；通过托盘菜单完全退出 |
| 桌面细节 | 亮暗主题、搜索与快捷键，窗口、托盘、应用和安装程序使用统一 Logo |

内置配置包括 DeepSeek、智谱、Kimi、通义千问、OpenAI、Anthropic、OpenRouter 和 Ollama。**是否可用取决于你的服务地址、账户权限和模型的工具调用能力**；本版本没有宣称逐一完成所有真实服务商的兼容验证。

## 界面一览

<table>
  <tr>
    <td width="50%"><img src="docs/images/home.png" alt="浅色首页与任务入口" /><p align="center">清爽首页 · 从任务开始</p></td>
    <td width="50%"><img src="docs/images/projects.png" alt="项目侧栏与项目工作区" /><p align="center">项目分组 · 对话有归属</p></td>
  </tr>
  <tr>
    <td width="50%"><img src="docs/images/activity.png" alt="思考与执行过程默认折叠" /><p align="center">过程可折叠 · 进展看得见</p></td>
    <td width="50%"><img src="docs/images/permissions.png" alt="同组审批与运行中权限" /><p align="center">合并审批 · 减少反复点击</p></td>
  </tr>
</table>

<details>
<summary>查看运行中浏览历史与文件的界面</summary>

![运行中自由浏览](docs/images/free-browse.png)

上翻查看历史时，界面暂停自动跟随；任务继续执行，新内容通过“查看最新”入口提醒。

</details>

截图来自 v0.0.2 更新内容的真实桌面验收场景，使用模拟模型服务和测试资料；截图中的模型名称、路径与任务内容仅用于展示。

## 下载与安装

**当前安装包：Windows x64，版本 0.0.2，S Fox 狐狸图标。**

1. 打开 [v0.0.2 Release](https://github.com/lryoooow/SmaltCode/releases/tag/v0.0.2)。
2. 下载 [SmaltCode-Setup-0.0.2-SFox.exe](https://github.com/lryoooow/SmaltCode/releases/download/v0.0.2/SmaltCode-Setup-0.0.2-SFox.exe)。
3. 按安装向导选择目录，使用桌面或开始菜单中的 **SmaltCode** 打开程序。
4. 在设置中配置模型服务，选择工作文件夹，即可开始。

Release 同时提供 [SHA256SUMS.txt](https://github.com/lryoooow/SmaltCode/releases/download/v0.0.2/SHA256SUMS.txt) 供校验安装包。PowerShell 示例：

```powershell
Get-FileHash .\SmaltCode-Setup-0.0.2-SFox.exe -Algorithm SHA256
```

安装包目前未做代码签名，Windows 可能显示发布者未验证的提示。请从本仓库的 Release 下载，并核对文件哈希。macOS、Linux 暂未提供经过桌面验收的安装包。

## 快速开始

### 1. 配置模型

打开 **设置 → 模型服务商**，选择服务商，填写 **API Key、服务地址、模型 ID**，点击“保存并测试连接”。

- 使用支持工具调用的模型，才能执行文件与命令操作。
- 服务地址须与所选协议匹配；模型 ID 以你的服务商实际提供的名称为准。
- Ollama 需要先在本机运行服务，并安装支持工具调用的模型。
- 测试连接会发送一条简短请求，可能产生少量模型费用。

桌面端在系统加密可用时，将新输入的密钥加密保存在本机；加密不可用时只用于本次运行。也可使用设置页面提示的服务商环境变量。

### 2. 选择工作文件夹

选择具体的代码或资料目录。也可以创建项目，为它设置默认文件夹与项目说明，再在项目下建立对话。

项目说明会进入关联对话的上下文，适合记录代码规范、输出格式与任务背景。

### 3. 描述任务并查看结果

例如：

```text
先阅读这个项目的 README 和目录结构，说明启动方式，找出一个可复现的问题。

帮我修复这个报错，完成后列出修改的文件与验证结果。

整理这个文件夹中的会议记录，生成一份 Markdown 周报，并更新索引。
```

根据需要审批操作、回答模型的问题，展开过程区查看详情，再检查生成文件和差异。执行中可以发送补充说明，也可以随时停止任务。

## 权限与运行体验

### 权限可以在运行中调整

输入框下方的权限菜单随时可用，调整会影响后续操作及适用的待审批操作。

| 模式 | 行为 |
| --- | --- |
| 敏感操作先问 | 对需要许可的操作请求确认 |
| 计划模式 | 只读分析，不执行文件修改 |
| 自动接受编辑 | 自动接受允许范围内的文件编辑，命令仍按规则审批 |
| 不询问 | 不弹出审批，未预先允许的操作直接拒绝 |
| 跳过审批 | 跳过一般操作审批；工作区、敏感路径和拒绝规则仍然生效 |

审批卡片提供一次、本组和本对话同类操作的许可。批量与同类许可仍受风险判断和拒绝规则约束；可在权限菜单中撤销本对话的额外许可。

这些是应用层的审批与路径保护，**不等同于操作系统沙箱**。命令以当前用户身份运行，请选择与你的任务相符的权限。

### 长任务与浏览互不打断

- 默认移除固定的 50 步上限，连续任务无需每 50 步点击继续；开发者仍可通过 `SMALT_MAX_STEPS` 显式设置上限。
- 当前阶段与已完成节点来自实际执行事件。模型在关键节点可以给出简短说明；不是虚构的百分比进度条。
- 思考与执行详情默认折叠；用户手动展开的内容保持展开。
- 上翻、键盘翻页、查看输出、选取文字和切换对话时，可以保留阅读位置。
- 关闭窗口后程序驻留托盘。单击托盘恢复窗口，右键选择 **“退出 SmaltCode”** 完全退出并结束工具子进程。

## v0.0.2 更新内容

相较于 0.0.1，本次新增：

| 更新 | 带来的体验 |
| --- | --- |
| 任务中心与桌面通知 | 集中查看运行、待处理、未读和失败任务，点击回到对应对话 |
| 多标签预览与文本选区修改 | 同时打开多个文本文件，选中片段后提出修改要求 |
| @ 文件引用 | 搜索工作区文件加入上下文，各对话引用草稿独立 |
| 变更审查与检查点 | 查看实际差异，按文件撤销，冲突时保护后续手动修改 |
| S Fox 品牌图标 | 狐狸轮廓结合字母 S，界面、窗口、托盘、应用和安装包统一 |

安装包统一为 **SmaltCode-Setup-0.0.2-SFox.exe**；旧安装包已清理，旧版本页面保留更新历史。功能使用、截图、恢复范围和测试说明见 [0.0.2 发布说明](docs/releases/v0.0.2.md)，图标源文件见 [品牌资源](docs/brand/README.md)。

## v0.0.1 更新内容

这是 SmaltCode 的首个公开测试版，包含：

- 新版 React 桌面界面，以及与真实智能体内核的完整连接。
- 默认持续执行、运行中权限调整、本组与同类审批。
- 项目侧栏、项目说明，以及对话归档、恢复、删除和置顶。
- 默认折叠的过程区、节点进展、文件预览与修改差异。
- 运行中自由浏览、阅读位置保留和“查看最新”提醒。
- 系统托盘驻留、统一应用图标，以及输入框聚焦样式修复。
- Windows x64 安装包、源代码、开发文档与自动化验收脚本。

详细内容见 [v0.0.1 发布说明](docs/releases/v0.0.1.md)。

## 测试版的边界

| 当前状态 | 说明 |
| --- | --- |
| 模型适配 | 使用兼容协议，但不同模型的工具调用、流式思考与上下文能力可能存在差异 |
| 桌面平台 | 当前提供 Windows x64；其他平台安装包尚未完成验收 |
| 任务执行 | 移除默认固定步数限制，并不保证无限执行；仍可能因服务错误、上下文或任务本身而停止 |
| 数据与文件 | 对话与项目资料保存在本机；模型请求会将必要任务内容发送到你配置的服务地址 |
| 文件删除 | 删除对话、移除项目不会删除对应工作文件夹中的真实文件 |
| 安装与更新 | 安装包暂未签名；目前从 Release 手动下载更新 |
| 后续规划 | MCP、技能、定时任务、目标模式及 Office 原生预览尚未作为完整桌面功能交付 |

欢迎在 [Issues](https://github.com/lryoooow/SmaltCode/issues) 中讨论你最需要的能力，帮助确定下一步优先级。

## 常见问题

**为什么配置了密钥仍不能运行？** 先测试连接，核对服务地址、模型 ID、账户权限和服务端返回的错误。连接测试成功也不代表模型支持所有工具调用。

**关闭窗口后任务会停止吗？** 关闭按钮将窗口隐藏到托盘，后台任务继续。托盘右键“退出 SmaltCode”会完全结束程序。

**退出后双击没有反应怎么办？** 先检查桌面和开始菜单快捷方式是否指向正式安装目录，运行所需文件应与 `SmaltCode.exe` 一起保留。如果启动日志出现 `ICU data` 错误，检查安装目录中的 `icudtl.dat` 等运行文件是否缺失，再使用 Release 中的完整安装包覆盖修复。排查时保留用户目录中的 `.smalt` 与应用数据，无需先清空对话或模型配置。

**任务栏为何仍显示 Electron 默认图标？** 正式安装包与窗口已使用 S Fox 图标。若同时运行过源码或桌面测试，还应检查 Windows 快捷方式的应用标识是否冲突。当前源码将正式版、开发版和测试进程的标识分开，模拟通知也不再调用会注册系统快捷方式的原生接口，避免测试影响正式安装的任务栏关联。

**运行时可以看别的对话吗？** 可以。切换对话不会停止原来的任务；返回后继续查看进展。

**能否减少审批次数？** 可允许本组或本对话同类操作，也可按任务选择“自动接受编辑”等模式；运行中仍可调整或撤销许可。

**本地数据放在哪里？** 内核默认使用用户目录中的 `.smalt` 保存配置、项目与对话；可通过 `SMALT_HOME` 覆盖。界面偏好与系统加密密钥使用 Electron 的本地数据目录。工作产物保存在你选择的工作文件夹。

## 参与建设

你不需要先成为开发者。**一句清楚的使用感受、一个可复现的问题、一张能说明交互问题的截图，都很有价值。**

- [报告 Bug](https://github.com/lryoooow/SmaltCode/issues/new?template=bug_report.yml)：说明版本、环境、复现步骤、预期与实际结果。
- [提出建议](https://github.com/lryoooow/SmaltCode/issues/new?template=feature_request.yml)：描述真实使用场景，以及你希望改善的体验。
- [提交 Pull Request](CONTRIBUTING.md)：参与修复、模型适配、交互打磨、测试和文档。

提交截图或日志前，请移除 API Key、访问令牌和私人项目资料。感谢每一位愿意试用和建设 SmaltCode 的朋友。

## 开发与验证

需要 **Node.js 22 或更高版本**与 npm。桌面安装包构建和以下原生验收目前面向 Windows。

本仓库使用本地测试与打包，GitHub Actions 已关闭；推送和 Pull Request 不会自动触发云端 CI。贡献时请附上实际执行的本地验证结果。

```bash
git clone https://github.com/lryoooow/SmaltCode.git
cd SmaltCode
npm ci
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
npm run desktop
```

修改源码后重新执行 `npm run build`，再启动桌面端。

```bash
# 构建 Windows x64 安装包，并执行打包前后的原生检查
npm run package:desktop

# 使用实际打包程序进行界面、IPC 和内核验收
python -m pip install --target .qa-python playwright
python scripts/test-desktop-ui.py --packaged

# 同一测试配置连续三次关闭、托盘恢复、完全退出和重新启动
node scripts/test-desktop-tray.mjs --packaged

# 核对实际安装目录（替换为自己的安装路径），不修改原有对话和配置
node scripts/test-desktop-tray.mjs --installed-dir "D:\smalt\SmaltCode"
```

当前源码的安装包输出到 `packages/desktop/release/SmaltCode-Setup-0.0.2-SFox.exe`。UI 验收使用 Electron 自带浏览器、本地模拟模型与隔离临时目录，无需真实 API Key；截图和报告生成到 `docs/screenshots/`。

Windows 托盘检查复用同一份隔离测试配置完成三轮退出与重启，并校验运行文件没有被修改或删除。开发与测试进程使用独立应用标识；正式安装版仍与安装程序中的 `app.smaltcode.desktop` 保持一致。

本次公开版本的验收结果与范围见 [发布说明](docs/releases/v0.0.2.md)。模拟服务测试覆盖实际执行链路，不代表已对所有外部服务商做真实 API 兼容测试。

## 项目结构

```text
SmaltCode/
├── packages/
│   ├── kernel/       # 模型适配、任务循环、权限、工具与存储
│   ├── desktop/      # Electron 主进程、React 界面和安装包配置
│   └── cli/          # 共用内核的命令行客户端
├── scripts/          # 构建、打包与桌面验收
├── docs/
│   ├── images/       # README 的实际界面截图
│   └── releases/     # 公开版本发布说明
└── .github/          # 问题反馈模板
```

阅读 [架构说明](docs/ARCHITECTURE.md) 与 [内核协议](docs/PROTOCOL.md) 了解实现。内部包名 `@smalt/*`、命令行名称 `smalt` 和配置目录 `.smalt` 保留兼容性；桌面产品统一命名为 **SmaltCode**。

## 开源协议与致谢

SmaltCode 按 [Apache License 2.0](LICENSE) 开源。相关声明与第三方设计来源见 [NOTICE](NOTICE)。

感谢开源社区提供的 Electron、React、Tailwind CSS、TypeScript，以及对文件编辑格式和智能体交互设计的探索。欢迎把你的建议带来，让下一版更好用。
