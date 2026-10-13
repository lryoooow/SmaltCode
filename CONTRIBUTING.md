# 参与 SmaltCode

SmaltCode 0.0.1 是公开测试版。欢迎从体验反馈、可复现的 Bug、交互改进、模型适配、测试和文档开始参与。

## 反馈问题与建议

- 使用 [Bug 模板](https://github.com/lryoooow/SmaltCode/issues/new?template=bug_report.yml)，提供版本、操作系统、复现步骤、预期和实际结果。
- 使用 [建议模板](https://github.com/lryoooow/SmaltCode/issues/new?template=feature_request.yml)，描述你的实际任务和希望改善的体验。
- 日志、截图与示例代码请移除密钥、令牌和私人资料。

## 本地开发

先 Fork 仓库，再克隆你的 Fork，创建描述用途的分支。需要 Node.js ≥ 22 与 npm；桌面打包和原生验收目前在 Windows 上进行。

```bash
npm ci
npm run typecheck
npm test -- --maxWorkers=1 --no-file-parallelism
npm run build
npm run desktop
```

涉及界面或运行交互的修改，请使用实际桌面验收脚本并检查生成截图：

```bash
python -m pip install --target .qa-python playwright
python scripts/test-desktop-ui.py
```

构建安装包：`npm run package:desktop`。最终安装包验收：`python scripts/test-desktop-ui.py --packaged`。测试资料与模型服务是隔离的本地夹具，不需要真实密钥。

## 代码约定

- 内核使用 Node 内置模块，保持零运行时第三方依赖。界面依赖放在桌面端。
- 权限、工作区路径、IPC 与命令识别的改动需要覆盖实际风险的回归测试。
- 操作拒绝作为可恢复的工具结果返回；任务循环的异步行为使用现有状态机。
- 前端统一从 `packages/desktop/src/renderer/src/main.tsx` 与 `App.tsx` 进入，事件订阅和会话状态由 `bridge.ts` 管理。
- 切换页面不停止后台任务；不要重新引入全局滚动锁定或每步重复审批。
- 界面截图必须来自实际构建。保持中文文案清楚，并考虑长路径、长输出、亮暗主题和键盘操作。
- 新增公开协议需要同步更新 `docs/`，对用户可见的变化需要补充说明。

## 提交 Pull Request

请描述问题、修改后的行为和验证结果；界面改动附截图。保持修改范围集中，避免提交构建产物、个人配置和测试工作区。

提交信息可以使用 `fix(composer): preserve rounded focus`、`feat(projects): improve sidebar` 这样的形式。所有贡献须符合本项目的 [Apache-2.0 协议](LICENSE)。

## 漏洞报告

涉及密钥泄漏或可利用的权限绕过，请避免在公开 Issue 中直接发布敏感数据和完整利用细节。如果仓库提供 Private vulnerability reporting，可通过 Security 页面私下报告；否则先提交不含利用细节的联系请求。
