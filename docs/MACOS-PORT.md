# Token Bubble：Mac 无语音版本

## 来源与范围

本分支 `codex/macos-no-voice` 基于 [h17612764275-cloud/token-bubble](https://github.com/h17612764275-cloud/token-bubble) 的 `73b9645b9b392b34b0fdc42f62c1cdc34e3c4f22` 提交。Mac 应用版本为 0.2.2，面向 Apple Silicon（arm64），最低要求 macOS 14；不声明 Intel Mac 或 Universal 支持。Windows 版本及 `main` 分支保持独立。

保留额度浮窗、两种皮肤、Token 用量面板、截图选区与标注、保存、复制、贴图入口，以及 CodexScope 独立数据核验。运行版移除了语音识别、麦克风入口、语音快捷键、语音字数和本地语音模型；仓库中部分上游历史文档与未编译语音源码仅供对照。

## 实现

| 部分 | 主要文件 | 处理方式 |
| --- | --- | --- |
| 主界面 | `src/App.tsx`、`src/components/TrayPanel.tsx`、`src/components/QuotaCard.tsx` | React / TypeScript；共享浮窗与面板视觉，移除语音交互 |
| 原生窗口 | `src-tauri/src/lib.rs`、`quick_actions.rs` | Tauri；同步浮窗、面板、快捷栏、截图与贴图窗口 |
| Codex 额度 | `src-tauri/src/codex.rs`、`quota.rs`、`quota_cache.rs` | 读取现有登录态以请求额度，不修改登录凭据 |
| 本地用量 | `src-tauri/src/local_usage.rs` | 从本地会话汇总；使用 `CODEX_HOME` 或用户目录下的 `.codex` |
| 截图 | `src-tauri/src/screenshot.rs`、`screenshot_macos.rs`、`screenshot_macos.m`、`src/components/ScreenshotOverlay.tsx` | ScreenCaptureKit 捕获、窗口边界映射、AppKit 剪贴板；复用标注界面 |
| CodexScope | `src-tauri/src/codexscope.rs`、`resources/codexscope` | 后台生成本地统计数据后打开上游仪表盘 |

上游 Mac 截图入口原本只返回不支持错误；本分支加入原生捕获实现。截图默认保存在 `~/Pictures/Token Bubble 截图`，也可选择保存位置。检查更新入口目前只显示版本信息，不进行联网更新检查。

CodexScope 基于 [JUk1-GH/CodexScope v0.1.9](https://github.com/JUk1-GH/CodexScope/releases/tag/v0.1.9)。来源、校验和重建方式见 [CodexScope 说明](../scripts/codexscope/README.md)。其 Mac 生成器仅提供 arm64；生成的 `data.js`、`data.raw.js` 和缓存位于可写的应用数据目录，可能含本地用量元数据，不应提交或上传。

## 构建与权限

构建需 Xcode 命令行工具、Node.js 和 Rust stable。运行 `./scripts/build-macos.sh` 可在支持的 Mac 上构建；此命令生成的新 App 签名与本次发布的现有安装包不同，不能代替本次 DMG 产物。

截图需在 macOS「系统设置 → 隐私与安全性 → 屏幕与系统音频录制」授权当前 App。应用只获取截图，不录制音频或访问麦克风。当前包使用 ad-hoc 签名，未经 Developer ID 签名或公证；重新构建可能改变签名，使录屏授权需要重新设置。权限问题应通过系统设置处理，不修改 TCC 数据库。

截图设置中有「开始截图」按钮；默认全局快捷键为 Ctrl+P。原生日志位于 `~/Library/Logs/app.tokenbubble.desktop/screenshot.log`，不记录图片内容。应用标识为 `app.tokenbubble.desktop`，状态与 CodexScope 数据保存在对应的应用目录。

## 验证边界

- 此代码版本的 149 项前端测试、61 项 Rust 测试、TypeScript 与生产构建、arm64 App 打包和深度签名校验曾通过。
- 更换图标前的签名包已由用户在实机确认截图选区、矩形标注、默认目录保存和剪贴板复制成功。更换图标后重新签名的安装包尚未完成录屏权限复测，不能沿用旧包的截图验收结论。
- CodexScope Mac 命令行生成器已解析真实本地会话并产生非空导出；菜单集成和网页界面的实际显示尚未实机确认。
- 贴图命令已生成图片并结束截图选区；贴图窗口的可见性和交互尚未确认。
- Developer ID 签名、公证、Intel Mac 与异构多屏行为未验证。首次授权交互中，权限预检失败后立即返回错误的体验问题尚未修复。

本次专用 Release 使用现有已安装 App 制作 DMG；`hdiutil verify`、只读挂载、深度签名检查以及挂载 App 全部 15 个文件的一致性检查已通过。标签为 `macos-20260929-no-voice`；详见 [发布说明](RELEASE.md)。
