# Token Bubble

> See the [macOS port notes](docs/MACOS-PORT.md) for the scope and validation of the Mac build without voice recognition, microphone controls, or speech models. Historical release notes below describe upstream versions; no voice model download is needed for this branch.

[简体中文](README.md) · **English**

Token Bubble is a local-first desktop widget for Codex quota and token usage. It brings quota status, token distribution, estimated cost, and recent usage into a lightweight panel that can be resized and pinned.

Token Bubble is derived from **Quota Float** and integrates **CodexScope** for local usage verification. The original projects retain their respective copyrights and licenses. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Download

- [Download the latest installer](https://github.com/h17612764275-cloud/token-bubble/releases/latest)
- Current version: `v0.2.7`
- Windows users should download the `.exe` installer from the Release.

## v0.2.7 cloud clarity update (2026-09-03)

- **Easier-to-read remaining quota:** Cloud height alone now represents the remaining quota; lower levels no longer reduce cloud density or opacity and expose too much of the gray base.
- **Brighter, clearer clouds:** Increased cloud brightness and coverage with a tighter top fade, while preserving the pink-purple glass appearance and soft edges.

## v0.2.6 smart window selection and inline text update (2026-09-01)

- **Automatic window suggestions:** Hovering highlights the current top-level window, and clicking locks the capture to its bounds. Manual selection and resizing snap to nearby window edges; hold `Alt` to temporarily disable snapping.
- **Immediate bright preview:** A suggested window returns to full brightness as soon as it is hovered, without showing resize handles or the toolbar before confirmation.
- **Live inline text:** Every typed character is drawn directly on the screenshot canvas and is preserved on blur, confirmation, Save As, or Pin. Long text entered near an edge now previews exactly as it will export.
- **Local-only window detection:** Window bounds are processed transiently on the device for the current capture session without reading titles, uploading data, or writing it to disk.

## v0.2.5 annotation editing and window visibility update (2026-09-01)

- **Move existing annotations directly:** Hover and drag rectangles, ellipses, arrows, freehand strokes, mosaic regions, or text. Existing annotations keep hit priority even while a drawing tool remains selected, and cancelling or undoing a move restores its prior position without deleting another annotation.
- **Custom movement cursor:** Annotation hover and drag states use a lightweight glass, pink-to-purple four-way cursor with a visually centered concentric core.
- **Consistent hide behavior:** Choosing Hide now dismisses both the quota widget and tray panel, including repeated-click, focus-change, and asynchronous state races that could leave the panel visible or unclosable.

## v0.2.4 screenshot stability update (2026-08-30)

- **No top-left flash or black frame when a capture starts:** The capture window warms up invisibly and without intercepting input, then appears only after its image is ready to paint.
- **Faster capture startup:** The normal path removes unnecessary fixed waiting while keeping the paint-readiness checks that prevent flashing.
- **Safer sequential captures:** Stale asynchronous work cannot overwrite a newer capture, and native reveal, cancel, and timeout recovery share one session lifecycle to prevent stuck overlays.

## v0.2.3 fixes (2026-08-29)

- **No shrink transition after a capture:** The Windows screenshot window disables system transitions, so finishing or canceling a capture no longer plays the visible shrink animation.
- **Fresh tool state for every capture:** Reusing the screenshot window clears the previous arrow, pen, or other annotation choice, returning the next capture to selection movement.

## v0.2.2 updates (2026-08-11)

> These are the main `v0.2.2` updates; installer and source versions stay aligned.

- **Windows local screenshots and pinned captures:** Configure capture from the panel's camera button, then start with a global shortcut (`Ctrl+P` by default). Select, move, and resize a region, then annotate it with rectangles, ellipses, arrows, freehand strokes, mosaic, or text. Capture, clipboard copy, and pinned images are currently Windows-only.
- **Save, clipboard, and pin:** Confirming saves a PNG and copies it to the clipboard. A selection can also be saved elsewhere or opened as a draggable, resizable, always-on-top image.
- **Screenshot preferences:** Change the global shortcut, choose the default output folder, and open that folder directly from the panel.
- **Automatic quota recovery:** The last valid quota stays visible through transient failures. Token Bubble retries after 30 seconds, supports immediate retry from an unavailable widget, and shares successful recovery between the tray panel and widget.
- **Response ordering guards:** An older successful quota response cannot overwrite newer quota or a newer signed-out state, and it cannot corrupt the daily-usage baseline.

## Interface preview

The latest main-panel screenshot is generated from the current `main` interface with built-in demo data. It contains no real account or personal usage data.

### Current main panel

![Current Token Bubble main panel with screenshot settings entry](docs/images/token-bubble-panel.png?v=2026-08-11)

### Two panel skins

Token Bubble provides the Soap Bubble skin (Bubble) and the Glass Bottle skin (Glass). The panel and floating widget share the selected skin's material and visual style.

| Soap Bubble skin (Bubble) | Glass Bottle skin (Glass) |
| --- | --- |
| ![Token Bubble Bubble skin panel and widget](docs/images/token-bubble-skin-bubble-overview.png?v=0.2.0) | ![Token Bubble Glass skin panel and widget](docs/images/token-bubble-skin-glass-overview.png?v=0.2.0) |

### Custom colors for both skins

Both the Bubble and Glass panels support custom colors. Open the color picker to choose a color from the field, hue bar, or RGB values.

![Token Bubble panel color picker](docs/images/token-bubble-color-picker.png?v=0.2.0)

### Today, last 7 days, and last 30 days

Switch the usage range between today, the last 7 days, and the last 30 days. The panel updates the token total, chart, token-type distribution, and estimated cost for the selected range.

| Today | Last 7 days | Last 30 days |
| --- | --- | --- |
| ![Token Bubble token usage for today](docs/images/token-bubble-skin-bubble-today.png?v=0.2.0) | ![Token Bubble token usage for the last 7 days](docs/images/token-bubble-skin-bubble-7d.png?v=0.2.0) | ![Token Bubble token usage for the last 30 days](docs/images/token-bubble-skin-bubble-30d.png?v=0.2.0) |

### Floating widget

The floating widget matches the selected Bubble or Glass skin. It can be resized, locked in place, and kept on top. Click it to open the full panel.

| Bubble widget | Glass widget |
| --- | --- |
| ![Token Bubble Bubble floating widget](docs/images/token-bubble-orb-bubble.png?v=0.2.0) | ![Token Bubble Glass floating widget](docs/images/token-bubble-orb-glass.png?v=0.2.0) |

### Local real-time Chinese-English voice input

Press a configurable shortcut once to start continuous recognition and again to stop. Text appears while you speak, with support for Chinese, English, and mixed speech plus automatic on-device punctuation. The shortcut, microphone, and activation sensitivity are configurable.

![Token Bubble local voice input states](docs/images/token-bubble-voice-states.png?v=0.2.0)

## Features

- Shows the remaining Codex quota, refresh time, and quota status.
- Switches token usage between today, the last 7 days, and the last 30 days.
- Breaks usage down into input, cached, output, and reasoning tokens.
- Estimates cost from locally observed token usage.
- Shows usage trends with a bar chart and a 90-day heatmap.
- Switches between the Bubble and Glass panel skins, with custom colors for both.
- Resizes the floating widget, locks its position, and keeps it on top.
- Stores a membership renewal date and shows the remaining days.
- Provides tray actions for refresh and panel/widget visibility.
- Provides fully local real-time Chinese-English voice input, automatic punctuation, and voice activity detection.
- Tracks today's dictated characters and shows voice usage in the flippable 90-day heatmap.
- Provides local region capture, annotation, saving, clipboard copy, and always-on-top pinned images on Windows.
- Recovers quota automatically after transient network failures and synchronizes successful results across windows.

## Usage

1. Install and start Token Bubble.
2. Make sure Codex Desktop is signed in on the same computer.
3. Select today, 7 days, or 30 days from the usage range.
4. Use the controls to switch Bubble/Glass skins, open the color picker, resize the widget, or lock it in place.
5. Select the renewal date at the top of the panel to set your membership renewal.
6. Configure the voice shortcut, input device, and sensitivity; press the shortcut once to start and again to stop.
7. On Windows, open screenshot settings from the camera button, configure the shortcut and folder, then select a region to save, copy, or pin.

## Data and privacy

Token Bubble reads the existing local Codex Desktop login state and queries quota in read-only mode. Token history, voice-character totals, interface and screenshot preferences, and the membership renewal date stay on the device. Speech recognition, punctuation, and screenshot processing run on-device.

- It does not upload prompts, chats, or local usage history.
- It includes no telemetry, analytics, or crash reporting.
- It does not redeem reset credits or change account settings.
- Local token totals support history and verification views; they do not replace service-provided quota values.
- Microphone audio is neither uploaded nor saved; only final character counts are stored locally for usage statistics.
- Screen pixels are read only when the user starts a capture. Screenshots are not uploaded; they are saved locally and copied to the system clipboard.

See [PRIVACY.md](PRIVACY.md) and [SECURITY.md](SECURITY.md) for the complete boundary.

## Upstream projects and licenses

Token Bubble is an independent derivative project and is not an official release of Quota Float or CodexScope.

- **Quota Float** provided the base desktop-widget architecture and Codex quota display.
- **CodexScope** provided components used for local token-usage verification.
- **sherpa-onnx / Paraformer** provides the local streaming Chinese-English recognition and punctuation runtime and models.
- **Token Bubble** adds the new panel, skins, time ranges, token distribution, estimated cost, widget controls, membership renewal setting, and local voice input.

See [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for license and attribution details.

## Development

Requires Node.js 20+, Rust stable, and the Tauri 2 system dependencies for your platform.

```bash
npm install
npm run test
npm run build
npm run tauri dev
```

Build installers with:

```bash
npm run tauri build
```

## Feedback

Use [GitHub Issues](https://github.com/h17612764275-cloud/token-bubble/issues) for bugs and feature requests. Remove tokens, account information, email addresses, and local paths before sharing screenshots or logs.
