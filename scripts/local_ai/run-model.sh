#!/usr/bin/env bash
set -euo pipefail
# Reuse the approved isolated runtime, without installs or cloud fallback.
runtime_root="${LOCAL_AI_OMLX_ROOT:-$HOME/Developer/wj-ai-omlx-stage2-20261025}"
for required in env/bin/python state/serve-verified-runtime.py state/runtime-switch-002/omlx/model_settings.json; do
  if [[ ! -f "$runtime_root/$required" ]]; then
    echo "Local AI runtime file missing: $runtime_root/$required" >&2
    exit 78
  fi
done
exec /usr/bin/env -u AI_WORKER_TOKEN /usr/bin/nice -n 15 \
  "$runtime_root/env/bin/python" -I "$runtime_root/state/serve-verified-runtime.py" serve \
  --base-path "$runtime_root/state/runtime-switch-002/omlx" \
  --model-dir "$runtime_root/state/runtime-switch-002/models" \
  --host 127.0.0.1 --port 8082 --max-concurrent-requests 1 --memory-guard-gb 32 \
  --paged-ssd-cache-dir "$runtime_root/cache/runtime-switch-002-kv" \
  --paged-ssd-cache-max-size 4GB --hot-cache-max-size 0 --no-hf-cache --headless
