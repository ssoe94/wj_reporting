#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd "$script_dir/../.." && pwd)"
worker_python="${WORKER_PYTHON:-$repo_dir/backend/.venv/bin/python}"
worker_script="$repo_dir/local_worker/worker.py"
keychain_service="${AI_WORKER_KEYCHAIN_SERVICE:-com.wj.local-ai-worker.token}"
keychain_account="${AI_WORKER_KEYCHAIN_ACCOUNT:-$(id -un)}"

if [[ ! -x "$worker_python" ]]; then
  echo "Worker Python is not executable: $worker_python" >&2
  exit 78
fi

if [[ ! -f "$worker_script" ]]; then
  echo "Worker script was not found: $worker_script" >&2
  exit 78
fi

if [[ -z "${AI_WORKER_TOKEN:-}" ]]; then
  if ! worker_token="$(/usr/bin/security find-generic-password -a "$keychain_account" -s "$keychain_service" -w 2>/dev/null)"; then
    echo "AI Worker token was not found in macOS Keychain service $keychain_service." >&2
    exit 78
  fi
  export AI_WORKER_TOKEN="$worker_token"
  unset worker_token
fi

export RENDER_API_BASE_URL="${RENDER_API_BASE_URL:-https://wj-reporting-backend.onrender.com/api}"
export LOCAL_LLM_BASE_URL="${LOCAL_LLM_BASE_URL:-http://127.0.0.1:8082/v1}"
export LOCAL_LLM_MODEL="${LOCAL_LLM_MODEL:-/Users/macstudio_ted/Developer/local-ai/models/Qwen3.8-27B-4bit}"
export LOCAL_LLM_TIMEOUT_SECONDS="${LOCAL_LLM_TIMEOUT_SECONDS:-120}"
export WORKER_NAME="${WORKER_NAME:-mac-studio-local-ai}"
export POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
export AI_WORKER_USE_LLM="${AI_WORKER_USE_LLM:-true}"
export AI_WORKER_FALLBACK_TO_DETERMINISTIC="${AI_WORKER_FALLBACK_TO_DETERMINISTIC:-true}"
export AI_WORKER_ENQUEUE_PERIODIC="${AI_WORKER_ENQUEUE_PERIODIC:-true}"
export PERIODIC_ENQUEUE_CHECK_SECONDS="${PERIODIC_ENQUEUE_CHECK_SECONDS:-60}"

model_health_url="${LOCAL_LLM_BASE_URL%/}/models"
for attempt in $(seq 1 90); do
  if /usr/bin/curl -fsS --connect-timeout 2 --max-time 5 "$model_health_url" \
    | "$worker_python" -c 'import json,sys; expected=sys.argv[1].replace("\\", "/").rstrip("/").rsplit("/", 1)[-1]; payload=json.load(sys.stdin); ids=[str(row.get("id", "") if isinstance(row, dict) else row).replace("\\", "/").rstrip("/").rsplit("/", 1)[-1] for row in payload.get("data", [])]; raise SystemExit(0 if expected in ids else 1)' "$LOCAL_LLM_MODEL"; then
    exec "$worker_python" "$worker_script" "$@"
  fi
  if (( attempt % 15 == 0 )); then
    echo "Waiting for the default local AI server at $model_health_url ($attempt/90)" >&2
  fi
  /bin/sleep 2
done

echo "The Qwen3.8 local AI server did not become ready within 180 seconds." >&2
exit 69
