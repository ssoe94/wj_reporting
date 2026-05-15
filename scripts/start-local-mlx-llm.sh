#!/usr/bin/env bash
set -euo pipefail

MLX_SERVER="${MLX_SERVER:-/Users/ssoe94/mlx312-env/bin/mlx_lm.server}"
MLX_MODEL="${MLX_MODEL:-mlx-community/gemma-4-e2b-it-8bit}"
MLX_HOST="${MLX_HOST:-127.0.0.1}"
MLX_PORT="${MLX_PORT:-8080}"

if [ ! -x "$MLX_SERVER" ]; then
  echo "MLX server not found: $MLX_SERVER" >&2
  exit 1
fi

echo "Starting MLX LLM server"
echo "  model: $MLX_MODEL"
echo "  url:   http://$MLX_HOST:$MLX_PORT/v1"

exec "$MLX_SERVER" \
  --model "$MLX_MODEL" \
  --host "$MLX_HOST" \
  --port "$MLX_PORT" \
  --allowed-origins "*" \
  --max-tokens 700 \
  --temp 0.2
