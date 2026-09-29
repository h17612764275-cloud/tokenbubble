#!/usr/bin/env bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "请在 Mac 上运行此构建脚本。" >&2
  exit 1
fi

# Use this checkout's toolchain without changing the user's shell configuration.
if [[ -x "$PROJECT_ROOT/.tooling/cargo/bin/cargo" ]]; then
  export CARGO_HOME="$PROJECT_ROOT/.tooling/cargo"
  export RUSTUP_HOME="$PROJECT_ROOT/.tooling/rustup"
  export PATH="$CARGO_HOME/bin:$PATH"
fi

command -v cargo >/dev/null || { echo "需要 Rust stable 工具链。" >&2; exit 1; }
command -v npm >/dev/null || { echo "需要 Node.js 和 npm。" >&2; exit 1; }
if [[ ! -d node_modules ]]; then
  npm ci --no-audit --no-fund --ignore-scripts
fi

npm run tauri -- build --bundles app "$@"
