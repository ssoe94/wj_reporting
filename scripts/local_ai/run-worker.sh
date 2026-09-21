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
# Ceiling for one model call (5..600); each call uses min(ceiling, size estimate).
export LOCAL_LLM_TIMEOUT_SECONDS="${LOCAL_LLM_TIMEOUT_SECONDS:-240}"
# Advisory flock shared with the coding-delegation gateway on the same model
# server. Set LOCAL_LLM_LOCK_PATH to an empty string to disable.
export LOCAL_LLM_LOCK_PATH="${LOCAL_LLM_LOCK_PATH-$HOME/.local/share/codex-local-worker/state/generation.lock}"
export LOCAL_LLM_LOCK_WAIT_SECONDS="${LOCAL_LLM_LOCK_WAIT_SECONDS:-90}"
export WORKER_NAME="${WORKER_NAME:-mac-studio-local-ai}"
export POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"
export AI_WORKER_USE_LLM="${AI_WORKER_USE_LLM:-true}"
export AI_WORKER_FALLBACK_TO_DETERMINISTIC="${AI_WORKER_FALLBACK_TO_DETERMINISTIC:-true}"
export AI_WORKER_ENQUEUE_PERIODIC="${AI_WORKER_ENQUEUE_PERIODIC:-true}"
export PERIODIC_ENQUEUE_CHECK_SECONDS="${PERIODIC_ENQUEUE_CHECK_SECONDS:-60}"

# One start-only bootstrap restores the owned model after login/reboot. The
# manager's start command is idempotent and never stops an existing server.
# Keep it in the background so model loading cannot suppress worker heartbeats.
runtime_repo="${LOCAL_AI_RUNTIME_REPO:-/Users/macstudio_ted/Documents/Codex/2026-08-16/codex-master-local-ai-worker-hybrid/codex-local-worker}"
runtime_uv="${LOCAL_AI_UV_BIN:-/opt/homebrew/bin/uv}"
flag_enabled() {
  case "$1" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}
if flag_enabled "${AI_WORKER_AUTOSTART_RUNTIME:-true}" \
  && flag_enabled "$AI_WORKER_USE_LLM" \
  && [[ "${LOCAL_LLM_BASE_URL%/}" == "http://127.0.0.1:8082/v1" ]]; then
  if [[ -x "$runtime_uv" && -f "$runtime_repo/pyproject.toml" && -f "$runtime_repo/config/worker.toml" ]]; then
    (
      if ! /usr/bin/env -u AI_WORKER_TOKEN "$runtime_uv" run --no-sync --directory "$runtime_repo" local-coder start >/dev/null; then
        echo "Local AI runtime start failed; worker heartbeats continue." >&2
      fi
    ) &
  else
    echo "Local AI runtime manager unavailable; worker heartbeats continue." >&2
  fi
fi

# Readiness belongs to the Python worker: it keeps sending heartbeats when the
# separately managed model is unavailable, and claims only ready model work.
# Starting here must not turn a model outage into a silent worker restart loop.
export PYTHONUNBUFFERED=1
exec "$worker_python" "$worker_script" "$@"
