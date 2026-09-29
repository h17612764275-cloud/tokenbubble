# 发布说明

## 本次 Mac 发布

Mac 无语音源码保存在同一仓库的 `codex/macos-no-voice` 分支；`main` 和现有 Windows 发布保持原样。本次使用非 `v` 前缀标签 `macos-20260929-no-voice` 创建专用 GitHub Release，上传从现有已安装 App 制作的 `Token-Bubble_0.2.2_macos-arm64_20260929.dmg`、`SHA256SUMS.txt` 和 `INSTALL-macOS-zh-CN.txt`，不重新构建应用。

DMG 内为 Token Bubble 0.2.2，要求 Apple Silicon（arm64）和 macOS 14 或更新版本。应用使用 ad-hoc 签名，未经过 Apple Developer ID 签名或公证；不支持声明为 Universal 或 Intel 版本。语音识别、麦克风入口和本地语音模型均已从运行版移除。

推送 `v*` 标签会触发 `.github/workflows/release.yml` 自动构建并**直接公开** Release；本次专用标签不匹配该触发条件。不要使用 `v*` 标签代替本次标签，也不要将 Mac 分支推送到 `main`。

## 已验证与待验证

- 该代码版本的前端 149 项测试、Rust 61 项测试、生产构建、arm64 App 打包和深度签名校验曾通过。
- DMG 已通过 `hdiutil verify` 和只读挂载检查；挂载 App 的 15 个文件与已安装 App 的 SHA-256 均一致，深度签名校验通过。DMG 的 SHA-256 为 `9f0828de3fc1c8e11e8b6ab5f34ecffe5af050bfd65b27beaa0e3314476fa8c5`。
- 更换图标前的签名包，在实机完成截图选区、矩形标注、保存和剪贴板复制；更换图标后重新签名的安装包尚未完成录屏权限复测。
- 贴图窗口可见性及交互、CodexScope 网页界面显示尚未实机确认。CodexScope 命令行生成真实数据已通过。
- Developer ID 签名、公证、Intel Mac、异构多屏行为未验证。

## Mac 安装提示

打开 DMG，将 App 拖到「应用程序」。首次运行可能被 Gatekeeper 阻止；可在 Finder 中右键 App 选择「打开」，必要时到「系统设置 → 隐私与安全性」允许打开。截图需要在「屏幕与系统音频录制」中授权当前 App；ad-hoc 签名变化后可能需要重新授权。

源码范围、构建方式及功能边界见 [Mac 移植说明](MACOS-PORT.md)。公开分发若需更顺畅的首次安装体验，应另行完成 Developer ID 签名和公证。
