#!/usr/bin/env bash
set -euo pipefail

LOCAL_AI_DIR="${LOCAL_AI_DIR:-/Users/macstudio_ted/Developer/local-ai}"
MLX_PORT="${MLX_PORT:-8080}"

if [ ! -x "$LOCAL_AI_DIR/serve.sh" ]; then
  echo "Local AI server script not found: $LOCAL_AI_DIR/serve.sh" >&2
  exit 1
fi

echo "Starting Qwen 3.5 MLX server"
echo "  profile: ${LOCAL_AI_PROFILE:-quality}"
echo "  url:     http://127.0.0.1:$MLX_PORT/v1"

exec "$LOCAL_AI_DIR/serve.sh" "$MLX_PORT"
