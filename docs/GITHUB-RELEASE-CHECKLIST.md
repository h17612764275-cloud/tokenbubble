# Mac 无语音版 GitHub 发布清单

## 源码分支

在同一仓库的独立 `codex/macos-no-voice` 分支提交 Mac 移植源码，保持 `main` 和现有 Windows 发布不变。只暂存经审阅的源码与公开文档；`.agent/`、`截图/`、`outputs/`、本机日志、Codex 会话和凭据不得进入提交。确认 README 链接指向 `docs/MACOS-PORT.md`。

## 安装包与 Release

1. 从现有已安装的 Token Bubble 0.2.2 App 制作 DMG，不重新构建。本次产物为 `Token-Bubble_0.2.2_macos-arm64_20260929.dmg`、`SHA256SUMS.txt`、`INSTALL-macOS-zh-CN.txt`；DMG 已通过 `hdiutil verify`、只读挂载、深度签名及挂载 App 全部 15 个文件的一致性检查。
2. 在 Mac 源码提交上使用非 `v` 前缀标签 `macos-20260929-no-voice`。现有 `.github/workflows/release.yml` 只在推送 `v*` 标签时触发，且会直接公开 Release；本次不使用该流程。
3. 在同一 GitHub 仓库为专用标签创建 Mac Release，上传上述三个文件，发布说明使用 [Mac 模板](RELEASE_TEMPLATE.md)，核对附件后再公开。

## 下载页须说明

- 仅支持 Apple Silicon（arm64）与 macOS 14 或更新版本；不宣称 Universal 或 Intel 支持。
- App 是 ad-hoc 签名、未公证。首次打开可能需要在 Finder 右键选择「打开」，并在「系统设置 → 隐私与安全性」允许。
- 截图需要当前 App 的录屏授权。更换图标前的签名包已实测选区、标注、保存、复制；更换图标后重新签名的安装包待复测录屏权限。贴图窗口与 CodexScope 网页界面仍待实机确认。
- DMG 不含本地语音模型，也不应包含截图、会话导出或凭据。
