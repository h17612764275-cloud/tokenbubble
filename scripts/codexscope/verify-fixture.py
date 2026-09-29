#!/usr/bin/env python3
"""Verify the bundled generator using synthetic Codex metadata only."""

import json
import subprocess
import tempfile
from pathlib import Path


repo = Path(__file__).resolve().parents[2]
generator = (
    repo
    / "src-tauri/resources/codexscope/CodexScope Files/bin/codexscope-darwin-arm64"
)


def export(path: Path, global_name: str) -> dict:
    text = path.read_text(encoding="utf-8")
    prefix = f"window.{global_name} = "
    assert text.startswith(prefix), f"{path.name} variable mismatch"
    value, _ = json.JSONDecoder().raw_decode(text[len(prefix) :])
    assert isinstance(value, dict), f"{path.name} is not an object"
    return value


with tempfile.TemporaryDirectory(prefix="codexscope-fixture-") as directory:
    root = Path(directory)
    sessions = root / "sessions"
    sessions.mkdir()
    fixture = [
        {
            "timestamp": "2026-05-09T00:00:00Z",
            "type": "session_meta",
            "payload": {"id": "synthetic-session", "cwd": "/tmp/synthetic-project"},
        },
        {
            "timestamp": "2026-05-09T00:00:01Z",
            "type": "turn_context",
            "payload": {"model": "gpt-5.5"},
        },
        {
            "timestamp": "2026-05-09T00:00:02Z",
            "type": "event_msg",
            "payload": {
                "type": "token_count",
                "info": {
                    "last_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 20,
                        "output_tokens": 30,
                        "reasoning_output_tokens": 5,
                        "total_tokens": 130,
                    },
                    "total_token_usage": {
                        "input_tokens": 100,
                        "cached_input_tokens": 20,
                        "output_tokens": 30,
                        "reasoning_output_tokens": 5,
                        "total_tokens": 130,
                    },
                },
            },
        },
    ]
    (sessions / "synthetic.jsonl").write_text(
        "".join(json.dumps(row) + "\n" for row in fixture), encoding="utf-8"
    )

    result = subprocess.run(
        [
            str(generator),
            "--root", str(sessions),
            "--out", str(root / "data.js"),
            "--raw-out", str(root / "data.raw.js"),
            "--cache", str(root / ".codexscope-cache.json"),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, f"generator exit code {result.returncode}"
    main = export(root / "data.js", "CODEXSCOPE_DATA")
    raw = export(root / "data.raw.js", "CODEXSCOPE_RAW_DATA")
    history = main["views"]["history"]
    assert history["summary"]["requests"] == 1, "request count mismatch"
    assert history["summary"]["totalTokens"] == 130, "total mismatch"
    assert "recordsV2" in raw or "records" in raw, "raw records missing"
    assert (root / ".codexscope-cache.json").is_file(), "cache missing"
    print("CodexScope fixture: generator, exports, summary, and cache verified")
