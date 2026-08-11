# Local AI Worker

This worker runs on the Mac Studio and calls the Render backend using outbound HTTP only.

## Local test

```bash
cd local_worker
cp .env.example .env
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python worker.py --once
```

`AI_WORKER_USE_LLM=false` keeps the worker in deterministic-analysis mode. Set it to `true` only when an OpenAI-compatible local LLM endpoint is running at `LOCAL_LLM_BASE_URL`.

With `AI_WORKER_ENQUEUE_PERIODIC=true`, the worker asks the Render backend to ensure one Korean and one Chinese daily-analysis job exist for the current Asia/Shanghai hour. Repeated polling is idempotent within the hour.

The Worker also claims server-scheduled `quality_image_analysis` jobs whose mode is
`daily_attention_summary`. These jobs are bilingual, use only the
`gemma4_26b_a4b` target, and summarize the server-provided all-history quality
aggregates for the current production plan. If Gemma is unavailable or returns
an invalid/ungrounded contract, the job completes with a deterministic bilingual
fallback; the browser never connects to the local model directly.
All-history report identifiers stay in the server-owned grounding payload. The
Gemma prompt and result use compact aggregate evidence keys; the Worker validates
those keys and calculates de-duplicated counts before completion.

The same structured call can also write the bilingual daily quality report. The
backend supplies authoritative `report_metrics` for repeated issues, report-frequency
trends, and affected production scope. Gemma may only prioritize supplied metric,
target, and evidence keys. The Worker verifies the plan and evidence fingerprints,
then replaces free report prose with grounded bilingual templates for
`executive_summary`, `repeated_issues`, `accelerating_issues`, `affected_targets`,
`shift_checks`, and `caveats`. It rejects invented keys, numeric prose,
current-defect claims, root-cause claims, defect-rate claims, and prescriptive
corrective actions. A deterministic fallback remains retryable and is never
published as a successful Gemma report.

For continuous Mac Studio operation, use the Keychain-backed launch agents in
[`scripts/local_ai`](../scripts/local_ai/README.md). The launch agents keep the
MLX server and Worker running without putting `AI_WORKER_TOKEN` in a plist or
repository file.

## LLM mode

Start a local OpenAI-compatible MLX server first:

```bash
cd ..
./scripts/start-local-mlx-llm.sh
```

Then verify the endpoint:

```bash
cd local_worker
AI_WORKER_USE_LLM=true AI_WORKER_TOKEN=change-me python worker.py --check-llm
```

`AI_WORKER_FALLBACK_TO_DETERMINISTIC=true` lets the worker complete a job with deterministic analysis if the local LLM fails or returns invalid JSON. Set it to `false` when testing strict LLM failures.

```env
RENDER_API_BASE_URL=http://127.0.0.1:8000/api
AI_WORKER_TOKEN=change-me
LOCAL_LLM_BASE_URL=http://127.0.0.1:8080/v1
LOCAL_LLM_MODEL=/Users/macstudio_ted/Developer/local-ai/models/Qwen3.5-35B-A3B-4bit
LOCAL_GEMMA_BASE_URL=http://127.0.0.1:8081/v1
LOCAL_GEMMA_MODEL=/Users/macstudio_ted/Developer/local-ai/models/gemma-4-26b-a4b-it-4bit
LOCAL_LLM_DEFAULT_MODEL_ID=qwen35
LOCAL_VLM_MODEL=qwen3-vl:8b
LOCAL_LLM_TIMEOUT_SECONDS=45
WORKER_NAME=mac-studio-local-ai
POLL_INTERVAL_SECONDS=5
AI_WORKER_USE_LLM=false
AI_WORKER_FALLBACK_TO_DETERMINISTIC=true
AI_WORKER_ENQUEUE_PERIODIC=true
PERIODIC_ENQUEUE_CHECK_SECONDS=60
```
