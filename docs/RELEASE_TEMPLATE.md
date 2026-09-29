# Token Bubble 0.2.2 · Mac 无语音版

下载 `Token-Bubble_0.2.2_macos-arm64_20260929.dmg`，并使用附件 `SHA256SUMS.txt` 校验；安装步骤见 `INSTALL-macOS-zh-CN.txt`。DMG 的 SHA-256 为 `9f0828de3fc1c8e11e8b6ab5f34ecffe5af050bfd65b27beaa0e3314476fa8c5`。对应源码位于 `codex/macos-no-voice` 分支，标签为 `macos-20260929-no-voice`；Windows 版本仍见原有发布。

## 支持范围

- Apple Silicon（arm64），macOS 14 或更新版本。
- 保留额度浮窗、用量面板和截图功能；不含语音识别、麦克风入口或本地语音模型。
- App 使用 ad-hoc 签名，未经 Developer ID 签名和公证。首次打开可能需要在 Finder 右键选择「打开」，并在「系统设置 → 隐私与安全性」中允许。

## 已验证与待验证

前端 149 项测试、Rust 61 项测试、生产构建、arm64 App 打包和深度签名校验曾通过。更换图标前的签名包已实测截图选区、矩形标注、保存与复制。更换图标后重新签名的安装包尚未完成录屏权限复测；贴图窗口可见性及交互、CodexScope 网页界面显示也尚未确认。CodexScope 命令行生成真实数据已通过。

本次 DMG 已通过 `hdiutil verify`、只读挂载和深度签名检查；挂载 App 的全部 15 个文件与已安装 App 的 SHA-256 一致。

截图需授权当前 App 使用「屏幕与系统音频录制」。此版本未验证 Intel Mac、异构多屏，也未经 Apple 公证。功能与隐私说明见 [Mac 移植说明](https://github.com/h17612764275-cloud/token-bubble/blob/codex/macos-no-voice/docs/MACOS-PORT.md) 和 [隐私说明](https://github.com/h17612764275-cloud/token-bubble/blob/codex/macos-no-voice/PRIVACY.md)。
