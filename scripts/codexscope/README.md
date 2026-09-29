# CodexScope v0.1.9 macOS generator

Source: [JUk1-GH/CodexScope v0.1.9](https://github.com/JUk1-GH/CodexScope/releases/tag/v0.1.9), commit `d471990520ee43decf2240aa02370857c0d14f1c`. The source files in `upstream-v0.1.9/` are unmodified and retain the upstream MIT license. The arm64 binary and launcher in `src-tauri/resources/codexscope/` are copied from the same official `CodexScope-mac.zip` release. The existing Windows binary and frontend matched the official v0.1.9 Windows archive byte for byte before adding macOS files.

Reference SHA-256:

| File | SHA-256 |
| --- | --- |
| `CodexScope Files/bin/codexscope-darwin-arm64` | `95a2cd38b7aea42a5a4efe2bec4d437fad140d4ebf57e8b092d175c7fbe322d3` |
| `Open CodexScope.command` | `102c994ba1b88069babf0838af3d1a50f589c1c45c344d62c4cc4677c7997827` |
| `upstream-v0.1.9/generate_codex_data.go` | `0ea056a7b86e38282001180dc687825f23e0c9c2f017afc039d79a4329f245d9` |

To rebuild a functional equivalent from the pinned source with Go 1.22 or newer:

```sh
./scripts/codexscope/build-mac-generator.sh /absolute/output/path/codexscope-darwin-arm64
```

The script uses upstream's release build flags (`GOOS=darwin GOARCH=arm64`, `-trimpath`, `-s -w -buildid=`). `go.mod` and `go.sum` pin its Go dependency versions. Bitwise equality with the release binary additionally depends on the upstream build toolchain version; the supplied binary is the byte-verified official release artifact.

The generator reads `~/.codex/sessions` by default and writes `data.js`, `data.raw.js`, `.codexscope-cache.json`, and its cache stamp. Runtime integration passes `--root` from the application's `CODEX_HOME` resolution, plus `--out`, `--raw-out`, and `--cache` into a writable app data directory. It waits for a successful exit, checks both export files, then opens `index.html`. For an isolated test, pass `--root` pointing to an empty temporary directory. The exported files and cache can contain private local usage metadata and must not be committed or logged. The upstream release provides only an arm64 macOS binary.
