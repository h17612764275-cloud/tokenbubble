#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source_dir="$script_dir/upstream-v0.1.9"

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 OUTPUT_PATH" >&2
  exit 2
fi
if ! command -v go >/dev/null 2>&1; then
  echo "Go is required to rebuild CodexScope from source" >&2
  exit 1
fi

output_path="$1"
mkdir -p "$(dirname "$output_path")"
(
  cd "$source_dir"
  GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags='-s -w -buildid=' -o "$output_path" generate_codex_data.go
)
chmod +x "$output_path"
echo "Built $output_path"
