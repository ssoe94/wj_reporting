#!/usr/bin/env bash
set -euo pipefail

local_ai_dir="${LOCAL_AI_DIR:-/Users/macstudio_ted/Developer/local-ai}"
model_dir="${LOCAL_GEMMA_MODEL:-$local_ai_dir/models/gemma-4-26b-a4b-it-4bit}"
mlx_port="${MLX_PORT:-8081}"
mlx_server="$local_ai_dir/.venv/bin/mlx_lm.server"
mlx_python="$local_ai_dir/.venv/bin/python"

if [[ $# -gt 1 || ( $# -eq 1 && "${1:-}" != "--check-model" ) ]]; then
  echo "Usage: $0 [--check-model]" >&2
  exit 64
fi
check_model_only=false
if [[ "${1:-}" == "--check-model" ]]; then
  check_model_only=true
fi

if [[ ! -x "$mlx_server" ]]; then
  echo "MLX-LM server is not executable: $mlx_server" >&2
  exit 78
fi

if [[ ! -x "$mlx_python" ]]; then
  echo "Local AI Python is not executable: $mlx_python" >&2
  exit 78
fi

if [[ ! -f "$model_dir/config.json" ]]; then
  echo "Gemma 4 model is not installed: $model_dir" >&2
  exit 78
fi

index_file="$model_dir/model.safetensors.index.json"
if [[ ! -f "$index_file" ]]; then
  echo "Gemma 4 weight index is missing: $index_file" >&2
  exit 78
fi

shard_check_output=""
if ! shard_check_output="$("$mlx_python" -c '
import json
import pathlib
import sys

model_dir = pathlib.Path(sys.argv[1])
index_file = model_dir / "model.safetensors.index.json"
try:
    index = json.loads(index_file.read_text(encoding="utf-8"))
    weight_map = index.get("weight_map")
    if not isinstance(weight_map, dict) or not weight_map:
        raise ValueError("weight_map is empty")
    shard_names = sorted({name for name in weight_map.values() if isinstance(name, str) and name})
    if not shard_names:
        raise ValueError("weight_map contains no shard filenames")
except (OSError, ValueError, json.JSONDecodeError) as exc:
    print(f"invalid weight index: {exc}")
    raise SystemExit(1)

missing = []
total_size = 0
for shard_name in shard_names:
    shard_path = model_dir / shard_name
    if not shard_path.is_file() or shard_path.stat().st_size <= 0:
        missing.append(shard_name)
    else:
        total_size += shard_path.stat().st_size

if missing:
    print("missing or empty shards: " + ", ".join(missing))
    raise SystemExit(1)

expected_size = index.get("metadata", {}).get("total_size")
if isinstance(expected_size, int) and expected_size > 0 and total_size < expected_size:
    print(f"weight shards are truncated: {total_size} bytes found, at least {expected_size} expected")
    raise SystemExit(1)
' "$model_dir")"; then
  echo "Gemma 4 weight shards are incomplete: $model_dir" >&2
  if [[ -n "$shard_check_output" ]]; then
    printf '  %s\n' "$shard_check_output" >&2
  fi
  exit 78
fi

if [[ "$check_model_only" == true ]]; then
  echo "Gemma 4 model preflight passed: $model_dir"
  exit 0
fi

echo "Starting Gemma 4 26B-A4B MLX server"
echo "  model: $model_dir"
echo "  url:   http://127.0.0.1:$mlx_port/v1"

exec "$mlx_server" \
  --host 127.0.0.1 \
  --port "$mlx_port" \
  --model "$model_dir" \
  --max-tokens 2048 \
  --decode-concurrency 1 \
  --prompt-concurrency 1 \
  --prompt-cache-size 2
