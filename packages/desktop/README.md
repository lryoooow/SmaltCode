# SmaltCode desktop · 0.0.1 公开测试版

Electron + React 桌面助手，与 CLI 共用内核。完整介绍与界面截图见 [主 README](../../README.md)。

在仓库根目录运行：

```bash
npm ci
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
npm run desktop
```

首次使用，在设置中配置服务地址、模型 ID 与密钥，测试连接后选择工作文件夹。权限可在运行中调整；思考、计划、命令和文件变更默认折叠。上翻历史、查看文件或切换对话不会停止后台执行。

关闭窗口隐藏到托盘，右键选择“退出 SmaltCode”才完全退出。

## 打包与验收

```bash
npm run package:desktop
python -m pip install --target .qa-python playwright
python scripts/test-desktop-ui.py --packaged
```

安装包：`release/SmaltCode-Setup-0.0.1.exe`。打包前执行类型与启动检查，打包后验证真实应用启动、托盘生命周期、PE 文件/产品版本，以及 UI、窗口、托盘、EXE 和安装器图标一致性。界面验收连接实际打包程序、IPC 与内核，使用本地模拟模型和临时资料。

Logo 以 `assets/smalt.svg` 为唯一矢量源，构建时生成 PNG 与多尺寸 ICO。内部资源文件名、`@smalt/*` 包名与 `SMALT_HOME` 保留兼容性。

目前提供中文界面和 Windows x64 安装包。MCP、技能、定时任务、目标模式与 Office 原生预览仍在规划；安装包未签名，权限保护不等同于操作系统沙箱。
