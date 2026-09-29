# Token Bubble 余量浮窗

**简体中文** · [English](README.en.md)

Token Bubble 是一个本地优先的 Codex 额度与 Token 用量桌面浮窗。它将额度、Token 分布、估算花费和近期用量放在一个可调整、可固定的轻量面板中。

Token Bubble 基于 **Quota Float** 开发，并集成 **CodexScope** 的本地用量验证功能。原项目版权及许可证归各自作者所有，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 下载

| 平台 | 版本 | 安装包 |
| --- | --- | --- |
| macOS · Apple Silicon（M 系列） | 0.2.2 · 无语音测试版 · 2026-09-29 | [下载 DMG（约 12 MB）](https://github.com/h17612764275-cloud/tokenbubble/releases/download/macos-20260929-no-voice/Token-Bubble_0.2.2_macos-arm64_20260929.dmg) |
| Windows · x64 | 0.2.2 · 中心云纹微调版 · 2026-09-12 | [下载 EXE](https://github.com/h17612764275-cloud/tokenbubble/releases/download/windows-backup-20260912-center-flow/Token-Bubble_0.2.2_center-flow_20260912_x64-setup.exe) |

[Mac 发布说明与校验文件](https://github.com/h17612764275-cloud/tokenbubble/releases/tag/macos-20260929-no-voice) · [Windows 备份说明](https://github.com/h17612764275-cloud/tokenbubble/releases/tag/windows-backup-20260912-center-flow) · [全部发布](https://github.com/h17612764275-cloud/tokenbubble/releases)

两个安装包的内部版本号均为 `0.2.2`，请按平台、文件名和发布日期区分。Windows 源码保留在 `main`；Mac 源码位于独立的 [codex/macos-no-voice 分支](https://github.com/h17612764275-cloud/tokenbubble/tree/codex/macos-no-voice)。

## Mac 无语音测试版（2026-09-29）

- **系统要求**：Apple Silicon（M 系列），macOS 14 或更新版本；不提供 Intel 或 Universal 安装包。
- **功能范围**：保留额度浮窗、Token 用量、两种皮肤、截图与标注、保存、复制、贴图及 CodexScope；统一状态栏、Dock 和 Finder 图标。Mac 版移除了语音识别及相关依赖，**无需下载语音模型**。
- **安装**：打开 DMG，将 App 拖入「应用程序」。当前使用 ad-hoc 本地签名，未经 Apple Developer ID 签名或公证；若被系统阻止，请确认下载来源，再按「系统设置 → 隐私与安全 → 仍要打开」提示操作。
- **截图授权**：在「屏幕与系统音频录制」中允许当前 App，然后完全退出并重启。默认快捷键为 `Ctrl+P`，也可在截图设置中点击「开始截图」。替换本地签名版本后，可能需要移除旧录屏条目并重新添加当前 App。
- **验证边界**：DMG 已通过镜像、挂载和签名检查，GitHub 附件已回下载核验。当前图标构建的录屏权限、贴图窗口交互及 CodexScope 网页界面仍待实机复验；「检查更新」尚未实现自动更新。

[安装说明](https://github.com/h17612764275-cloud/tokenbubble/releases/download/macos-20260929-no-voice/INSTALL-macOS-zh-CN.txt) · [SHA-256 校验文件](https://github.com/h17612764275-cloud/tokenbubble/releases/download/macos-20260929-no-voice/SHA256SUMS.txt) · [固定源码快照](https://github.com/h17612764275-cloud/tokenbubble/tree/macos-20260929-no-voice) · [Mac 移植与验证说明](https://github.com/h17612764275-cloud/tokenbubble/blob/macos-20260929-no-voice/docs/MACOS-PORT.md)

## Windows 中心云纹微调版备份（2026-09-12）

本版保留已经确认的浮窗外观，只微调数字后方中心云纹在拖动时的局部流动；保留原有整体回弹、边框内侧、外围云纹和静止后的模糊水平面。以 68px 圆球为基准，水平过渡带总宽为 **13.14px**，云面稳定高度按纵向剩余额度百分比映射。

当前备份还保留以下已选功能：

- 独立右键快捷栏：刷新、隐藏、固定/解锁位置及今日 Token 消耗；隐藏时同步关闭展开的面板。
- 截图启动与退出稳定性改进、窗口识别和边缘吸附；已有标注可拖动，文字原位输入并在完成、另存为或贴图时保留。
- 已确认的新应用图标，以及启动时优先显示有效缓存额度；缓存最多保留 15 分钟，额度重置或登录状态变化时失效。
- 移除单击切换 Spark 余量；双击打开面板，拖拽移动浮窗。

验证记录：139 项前端测试通过，正式构建与已认可预览的深浅背景、静止、拖动和回稳画面对照通过，安装文件与包内文件校验一致。

**此 Windows 安装包对应的应用源码已同步到仓库。** [查看固定源码快照](https://github.com/h17612764275-cloud/tokenbubble/tree/windows-source-20260912-center-flow) · [下载源码 ZIP](https://github.com/h17612764275-cloud/tokenbubble/archive/refs/tags/windows-source-20260912-center-flow.zip)。

安装包备份标签创建于源码同步之前，保持原样；需要对应源码时请使用上面的源码快照，而不是旧备份页底部自动生成的 Source code 文件。2026-09-12 的这次 Windows 备份未包含 macOS 包；Mac 安装包已于 2026-09-29 独立发布，见上方下载区。编译缓存、node_modules、本地账号设置、交接记录及语音模型文件不包含在源码提交中；含语音功能的 Windows 版构建方式见 `main` 分支的开发说明；Mac 分支不需要语音模型。

安装包：`Token-Bubble_0.2.2_center-flow_20260912_x64-setup.exe`（292,794,399 字节）

SHA-256：

```text
1AC826102367075B737540E89617F25FD09A8FCB97E20953A5B391C55CCEF40D
```

## 历史版本记录

以下为此前版本的发布记录；Spark 切换等历史行为不适用于上面的当前备份。

## v0.2.7 浮窗交互更新（2026-09-07）

- **单击查看 Spark 余额**：有 Spark 额度数据时，单击 Bubble 浮窗可切换查看 Spark 本周剩余额度；数字在原位用约 1 秒的失焦、重新对焦动效完成切换。
- **5 秒后自动返回**：Spark 数字完整显示 5 秒后，以相同动效返回 Codex 余额。
- **保留原有操作**：双击打开完整面板，拖拽移动浮窗。

本次更新的是 Windows 安装包；仓库源码及 `v0.2.7` 标签源码本轮未同步上述功能，按源码构建不会得到此次安装包的全部交互更新。

## v0.2.7 云层清晰度更新（2026-09-03）

- **剩余额度更容易辨认**：只用云层高度表达剩余额度，不再随着额度降低同步减少云量和透明度，避免底层灰色过度显露。
- **云层更明亮清晰**：提高云层亮度与覆盖度，收窄顶部渐隐范围，同时保留粉紫色玻璃质感和柔和边缘。

## v0.2.6 智能截图选区与文字输入更新（2026-09-01）

- **自动推荐窗口范围**：截图时悬停会高亮当前顶层窗口，单击即可按窗口边缘锁定截图范围；手动框选和缩放会自动吸附附近窗口边缘，按住 `Alt` 可临时关闭吸附。
- **推荐区域立即亮起**：鼠标移入推荐窗口后，区域内部会立即恢复原始亮度，确认前不提前显示控制点和工具栏。
- **文字原位实时显示**：输入的每个字符直接绘制在截图画布中，失焦、完成、另存为或贴图时都会自动保留；靠近选区边缘输入长文字时，预览与最终成图保持一致。
- **本地窗口识别**：窗口边界仅在单次截图会话中由本机临时处理，不读取标题、不上传、不写入磁盘。

## v0.2.5 标注编辑与窗口隐藏更新（2026-09-01）

- **已绘制标注可直接移动**：鼠标移到矩形、圆形、箭头、画笔、马赛克或文字上即可命中并拖动；即使原绘图工具仍处于选中状态，也不会误画新标注。取消或撤销拖动会恢复移动前的位置，不会误删其他标注。
- **定制移动光标**：标注悬停和拖动时使用轻薄毛玻璃、粉紫渐变的四向箭头光标，并采用同心圆结构保持视觉对称。
- **隐藏行为一致**：点击“隐藏”会同时隐藏额度浮窗和托盘面板，并修复重复点击、焦点变化及异步状态竞争导致的面板残留或无法关闭。

## v0.2.4 截图稳定性更新（2026-08-30）

- **启动截图不再闪出左上角小框或黑帧**：截图窗口先以不可见、不可交互状态完成预热，画面真正就绪后再一次性显示。
- **截图启动更快**：常规截图路径取消不必要的固定等待，同时保留防闪绘制检查。
- **连续截图更稳定**：旧截图的异步回调不会覆盖新截图；原生窗口显示、取消和超时恢复使用同一会话生命周期，避免卡屏或透明遮罩残留。

## v0.2.3 修复更新（2026-08-29）

- **截图结束不再出现缩小动效**：Windows 截图窗口禁用系统过渡，完成或取消截图时不再播放明显的缩小动画。
- **新截图不再记忆上次标注工具**：复用截图窗口时自动清空箭头、画笔等工具选择；新截图默认恢复选区移动操作。

## v0.2.2 功能更新（2026-08-11）

> 以下是 `v0.2.2` 的主要更新；安装包与源码版本保持一致。

- **Windows 本地截图与贴图**：从面板相机按钮配置截图，再按全局快捷键（默认 `Ctrl+P`）开始；支持框选、移动、八方向缩放、矩形、圆形、箭头、画笔、马赛克和文字标注。该历史版本的截图、剪贴板复制和贴图仅支持 Windows；Mac 移植情况见上方测试版说明。
- **保存、剪贴板与置顶**：完成后自动保存 PNG 并复制到剪贴板，也可以另存为或把选区作为可拖动、可缩放的置顶贴图。
- **截图设置**：可以修改全局快捷键、选择默认保存文件夹，并直接打开截图目录。
- **额度异常自动恢复**：短暂断网时保留最后一次有效额度，30 秒后自动重试；异常浮窗悬停可立即刷新，托盘与浮窗会同步恢复结果。
- **响应顺序保护**：较旧的成功额度响应不会覆盖更新额度或较新的已退出状态，也不会污染每日用量基线。

## 界面预览

以下为此前版本的界面截图，使用内置模拟数据，不包含真实账号或个人用量数据；当前备份以安装包实际效果为准。

### 当前主面板

![Token Bubble 当前主面板，包含截图设置入口](docs/images/token-bubble-panel.png?v=2026-08-11)

### 两款面板皮肤

Token Bubble 提供肥皂泡皮肤（Bubble）和玻璃瓶皮肤（Glass）。面板与浮窗会同步使用所选皮肤的材质和视觉样式。

| 肥皂泡皮肤（Bubble） | 玻璃瓶皮肤（Glass） |
| --- | --- |
| ![Token Bubble 肥皂泡皮肤面板和浮窗](docs/images/token-bubble-skin-bubble-overview.png?v=0.2.0) | ![Token Bubble 玻璃瓶皮肤面板和浮窗](docs/images/token-bubble-skin-glass-overview.png?v=0.2.0) |

### 两款皮肤均可自由取色

Bubble 和 Glass 两款面板都支持取色换色。打开取色器后，可以使用色板、色相条或 RGB 数值设置喜欢的界面颜色。

![Token Bubble 面板取色器](docs/images/token-bubble-color-picker.png?v=0.2.0)

### 今日、近7天和近30天

点击用量范围可以在今日、近7天和近30天之间切换。面板会同步更新 Token 总量、柱状图、Token 类型分布和估算花费。

| 今日 | 近7天 | 近30天 |
| --- | --- | --- |
| ![Token Bubble 今日 Token 用量](docs/images/token-bubble-skin-bubble-today.png?v=0.2.0) | ![Token Bubble 近7天 Token 用量](docs/images/token-bubble-skin-bubble-7d.png?v=0.2.0) | ![Token Bubble 近30天 Token 用量](docs/images/token-bubble-skin-bubble-30d.png?v=0.2.0) |

### 浮窗样式

浮窗可调整尺寸、固定位置并保持置顶。双击浮窗打开完整面板，拖拽移动浮窗；当前 Windows 备份已移除 Spark 余量切换。

| Bubble 浮窗 | Glass 浮窗 |
| --- | --- |
| ![Token Bubble Bubble 浮窗](docs/images/token-bubble-orb-bubble.png?v=0.2.0) | ![Token Bubble Glass 浮窗](docs/images/token-bubble-orb-glass.png?v=0.2.0) |

### Windows 版：本地实时中英文语音输入

按一次自定义快捷键开启持续识别，再按一次关闭。语音会边说边显示文字，支持中文、英文及中英混说，并通过本地模型自动补充标点。快捷键、麦克风设备和识别灵敏度均可设置。

![Token Bubble 本地语音输入状态](docs/images/token-bubble-voice-states.png?v=0.2.0)

## 主要功能

- 显示 Codex 周期剩余额度、刷新时间和额度状态。
- 切换今日、近7天、近30天的 Token 用量。
- 展示输入、缓存、输出和推理 Token 的分布。
- 根据本地 Token 用量估算花费。
- 使用柱状图和近90天热力图查看使用趋势。
- 切换 Bubble 与 Glass 面板皮肤，并为两款皮肤自由取色。
- 调整浮窗大小、固定浮窗位置并保持窗口置顶。
- 设置会员续费日期并显示距离续费还有多少天。
- 从托盘快速刷新、显示或隐藏面板和浮窗。
- Windows 版支持完全本地的中英文实时语音输入、自动标点和语音活动检测；Mac 版不包含语音功能。
- Windows 版统计今日语音输入字数，并在近90天热力图中查看语音用量。
- 提供本地截图选区、标注、保存、复制和置顶贴图；Mac 版的权限要求及验证边界见上方说明。
- 在网络恢复后自动刷新额度，并在托盘面板与浮窗之间同步成功结果。

## 使用说明

1. 安装并启动 Token Bubble。
2. 确保本机 Codex Desktop 已登录。
   双击浮窗打开面板，拖拽移动；右键打开快捷栏，可刷新、隐藏或固定位置。
3. 点击面板中的用量范围，在今日、近7天和近30天之间切换。
4. 使用右侧控制按钮切换 Bubble/Glass 皮肤、打开取色器、调整尺寸或固定浮窗。
5. 点击顶部续费日期设置会员续费时间。
6. 仅 Windows 版：在语音栏设置快捷键、输入设备和灵敏度；按一次快捷键开启识别，再按一次关闭。
7. 点击顶部相机按钮配置截图快捷键和保存目录；Mac 用户需先授予录屏权限，再开始截图。

## 数据与隐私

Token Bubble 在本机读取现有 Codex Desktop 登录状态，以只读方式查询额度。Token 用量历史、界面设置、截图设置和会员续费日期保存在本地，截图在本机处理。Windows 版的语音识别、标点恢复和语音字数统计也在本地完成；Mac 版没有语音功能。

- 不上传提示词、聊天内容或本地用量历史。
- 不记录遥测、分析数据或崩溃报告。
- 不兑换重置额度，也不修改账户设置。
- 本地 Token 统计用于历史和验证视图，不会替代服务端返回的真实额度。
- Windows 版麦克风音频不会上传或保存；仅最终识别字数用于本地统计。Mac 版不使用麦克风。
- 屏幕内容只会在用户主动截图时读取；截图不会上传，由用户保存到本地并复制到系统剪贴板。

完整边界请查看 [PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。

## 来源与授权

Token Bubble 是独立的衍生项目，并非 Quota Float 或 CodexScope 的官方版本。

- **Quota Float**：提供了基础桌面浮窗架构与 Codex 额度展示能力。
- **CodexScope**：提供了本地 Token 用量验证相关组件。
- **sherpa-onnx / Paraformer**：为 Windows 版提供本地中英文流式识别和标点恢复运行时及模型；Mac 版不包含这些依赖。
- **Token Bubble**：在上述基础上增加了新的面板、皮肤、时间范围、Token 分布、估算花费、浮窗控制、会员续费设置，以及 Windows 版的本地语音输入。

许可证和第三方声明见 [LICENSE](LICENSE) 与 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## Mac 源码与构建

需要 Apple Silicon Mac、Xcode 命令行工具、Node.js 和 Rust stable。从 Mac 专用分支构建，不运行语音模型下载命令：

```bash
git clone --branch codex/macos-no-voice https://github.com/h17612764275-cloud/tokenbubble.git tokenbubble-macos
cd tokenbubble-macos
npm ci --ignore-scripts
./scripts/build-macos.sh
```

产物位于 `src-tauri/target/release/bundle/macos/`。重新构建可能改变签名，并需要重新授予录屏权限；已发布 DMG 对应固定标签 `macos-20260929-no-voice`。

## 当前 Mac 分支开发

需要 Node.js 20+、Rust stable 和 Tauri 2 对应的系统依赖。

```bash
npm install
npm run test
npm run build
npm run tauri dev
```

在 Windows 上构建此无语音分支的 x64 安装包：

```bash
npm run tauri -- build --bundles nsis
```

## 反馈

请通过 [GitHub Issues](https://github.com/h17612764275-cloud/tokenbubble/issues) 提交问题或建议。发布截图和日志前，请移除令牌、账号信息、邮箱和本地文件路径。
