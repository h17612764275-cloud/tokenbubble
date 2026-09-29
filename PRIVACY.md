# Privacy

Token Bubble is designed to be local-first and minimal.

## What It Reads

- The app reads the local Codex Desktop login file from `CODEX_HOME/auth.json` or the user's `.codex/auth.json`.
- The app sends the existing Codex access token only to the ChatGPT quota endpoints needed to read Codex usage.
- The app may read the account identifier from the login file or token payload only to set the request header expected by the quota service.
- This build does not include voice recognition, access the microphone, or download speech models.
- When the user starts a screenshot, the app reads the current monitor pixels and briefly enumerates visible top-level window process IDs, class names, and bounds to recommend local region selection and edge snapping.

## What It Stores

Token Bubble stores widget preferences and a bounded local usage history:

- locked state
- always-on-top state
- pinned provider
- auto-rotate interval
- daily quota percentages and token totals used by the local history view
- screenshot shortcut and default output folder
- PNG screenshots that the user explicitly confirms or saves

This history stays in the app's local storage. The app does not copy or persist
Codex access tokens, account IDs, raw quota responses, user prompts, chat
content, or local auth paths.

Screenshot pixels are held locally for the active capture and pinned-image
session. Confirmed screenshots are written only to the selected local folder
or save path and copied to the system clipboard. Token Bubble does not upload
screenshots.

Window process IDs and class names used during screenshot target filtering are
not retained. Only the resulting window bounds remain in the active local
screenshot session; they are not written to disk or uploaded.

## What It Sends

The app only calls these quota-related HTTPS endpoints from the local desktop process:

- `https://chatgpt.com/backend-api/wham/usage`
- `https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`

No telemetry, analytics, crash reporting, or third-party tracking is included.
Screenshot capture, annotation, clipboard copy, and pinned-image display do not
make network requests.

## Logging

Logs are intentionally generic. They must not include tokens, account IDs, raw backend responses, request headers, local auth paths, or personal file paths.

## Accuracy Boundary

Token Bubble displays quota windows returned by the Codex quota service and
separately summarizes local token usage for its history and verification views.
Local token totals do not replace service-provided quota values, and the app
does not fabricate quota values when the response shape is unknown.
