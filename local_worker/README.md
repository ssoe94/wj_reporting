# Local AI Worker

This worker runs on the Mac Studio and calls the Render backend using outbound HTTP only.
It is the **local (routine) tier**: it advertises model id `qwen38` and processes
production briefings, production questions, daily quality attention summaries and
quality report photo audits on the on-device model server at `127.0.0.1:8082`.
The **deep tier** (`chatgpt`) uses a daily ChatGPT desktop task through
`chatgpt_bridge.py` on the same job queue. Claude execution is retired; existing
results retain their original identity. See the [current contract](../docs/ai/2026-09-21-chatgpt-daily-analysis.md).

## Local test

```bash
cd local_worker
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
AI_WORKER_TOKEN=change-me AI_WORKER_USE_LLM=false LOCAL_LLM_LOCK_PATH= python worker.py --once
```

`AI_WORKER_USE_LLM=false` is a connectivity-only mode: the Worker can enqueue
periodic work and report that no model is ready, but it will not claim
model-bound jobs. Set it to `true` only when the configured local model
endpoint is running.

With `AI_WORKER_ENQUEUE_PERIODIC=true`, the worker asks the Render backend to ensure one Korean and one Chinese daily-analysis job exist for the current Asia/Shanghai hour. Repeated polling is idempotent within the hour.

The Worker also claims server-scheduled `quality_image_analysis` jobs whose mode is
`daily_attention_summary`. These jobs are bilingual, use only the
`qwen38` target on `127.0.0.1:8082`, and summarize the server-provided all-history quality
aggregates for the current production plan. If the local model is unavailable or returns
an invalid/ungrounded contract, the job completes with a deterministic bilingual
fallback; the browser never connects to the local model directly.
All-history report identifiers stay in the server-owned grounding payload. The
model prompt and result use compact aggregate evidence keys; the Worker validates
those keys and calculates de-duplicated counts before completion.

The backend supplies authoritative `report_metrics` for repeated issues,
report-frequency trends, and affected production scope. The model does not calculate
metrics or write unchecked public prose. JSON-constrained, bounded per-target
calls select server-classified metric and
evidence keys, followed by one compact call that ranks and connects eligible
metric, target, and evidence keys for the report. The Worker verifies the plan
and evidence fingerprints, rejects unknown/ineligible key combinations, and
replaces all prose with grounded bilingual templates for
`executive_summary`, `repeated_issues`, `accelerating_issues`, `affected_targets`,
`shift_checks`, and `caveats`. It rejects invented keys, numeric prose,
current-defect claims, root-cause claims, defect-rate claims, and prescriptive
corrective actions. A deterministic fallback remains retryable and is never
published as a successful model report.

AI report candidates are limited to canonical `problem_types` and backend-owned
`problem_location_pairs`. A pair is accepted only when the backend marks it as
coming from the same `QualityReport` row (`pair_basis=same_quality_report_id`);
the Worker never joins a problem and location itself. Standalone location
metrics and unknown/missing location coverage are not sent to the model and cannot
become a daily priority. A problem type remains eligible even when its location
was not recorded.

For continuous Mac Studio operation, use the Keychain-backed launch agents in
[`scripts/local_ai`](../scripts/local_ai/README.md). The launch agents keep the
outbound Worker running without putting `AI_WORKER_TOKEN` in a plist or
repository file. The model server on port 8082 is managed separately.

## Runtime behaviour

- **Heartbeat thread.** Heartbeats are posted every `AI_WORKER_HEARTBEAT_SECONDS`
  (default 30, minimum 15) from a daemon thread with its own HTTP session, so a
  long generation never makes the worker look offline. The `/v1/models` readiness
  probe (3 s) is skipped while a job is being generated; the last known readiness
  is reported instead. `model_name` in heartbeats and job completions is the
  checkpoint basename (for example `Qwen3.8-27B-4bit`), never the local path.
- **Timeouts.** `LOCAL_LLM_TIMEOUT_SECONDS` (default 240, honoured up to 600) is the
  ceiling for one model call. Each call uses
  `min(ceiling, prompt_tokens / 300 + max_tokens / 30 + 30)` seconds, where
  `prompt_tokens` counts latin text at 4 chars per token and every CJK character as
  one token (about 300 tok/s prefill and 35 tok/s decode, plus 5 s per attached
  image). Handlers that
  request a longer floor (the quality selectors ask for 180 s) get it as long as the
  ceiling allows. The backend re-pends a claimed job after 600 s, so never raise the
  ceiling above that.
- **Generation lock.** The model server runs one sequence at a time and is shared
  with the coding-delegation gateway. Before claiming, the worker takes a bounded
  advisory `flock` on `LOCAL_LLM_LOCK_PATH` (default
  `~/.local/share/codex-local-worker/state/generation.lock`, the gateway's own lock;
  the directory is created with mode 0700 if missing) waiting up to
  `LOCAL_LLM_LOCK_WAIT_SECONDS` (default 90). If the lock is busy the poll cycle is
  skipped without claiming, so no lease burns while another generation runs; the
  periodic enqueue call still happens. The lock is released after the job completes
  or fails. Set `LOCAL_LLM_LOCK_PATH=` (empty) to disable it.
- **Prefix-cache friendly prompts.** The runtime has automatic prefix caching, which
  only hits on identical token prefixes and keys on the system message. Every
  handler therefore puts static text first (instruction, output schema, taxonomy),
  then language-independent data, then language-dependent text, and finally the
  question/conversation history. Prompt versions: `production-daily-v5`,
  `production-machine-v5`, `production-question-v9`; the two quality handlers keep
  their backend-pinned versions and only reorder.
- **Question token budget.** The question handler estimates tokens
  (latin chars / 4 + one per CJK char) and trims `historical_snapshots`, then
  `conversation_history`, oldest first until the payload is <= 12,000 tokens. Above
  28,000 the job completes with the deterministic answer and
  `llm_fallback_code = input_too_large`. The estimate is logged to stderr.
- **Photo audits.** When a report attaches byte-identical photos (same SHA-256),
  identical observations returned under one `image_index` are re-homed onto the
  duplicate positions before validation instead of failing the audit. Inconsistent
  duplicates are still rejected.
- **Error wording.** Persisted error strings say `AI model`, never a vendor name.

## LLM mode

Confirm that the separately managed OpenAI-compatible endpoint is ready:

```bash
curl -fsS http://127.0.0.1:8082/v1/models
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
LOCAL_LLM_BASE_URL=http://127.0.0.1:8082/v1
LOCAL_LLM_MODEL=/Users/macstudio_ted/Developer/local-ai/models/Qwen3.8-27B-4bit
LOCAL_LLM_TIMEOUT_SECONDS=240
LOCAL_LLM_LOCK_PATH=~/.local/share/codex-local-worker/state/generation.lock
LOCAL_LLM_LOCK_WAIT_SECONDS=90
WORKER_NAME=mac-studio-local-ai
POLL_INTERVAL_SECONDS=10
AI_WORKER_HEARTBEAT_SECONDS=30
AI_WORKER_USE_LLM=true
AI_WORKER_FALLBACK_TO_DETERMINISTIC=true
AI_WORKER_ENQUEUE_PERIODIC=true
PERIODIC_ENQUEUE_CHECK_SECONDS=60
```

## Daily ChatGPT deep-tier bridge

Use `python -m local_worker.chatgpt_bridge readiness` to verify the deployed
contract without writes. Only then send `heartbeat`, `enqueue`, and `claim`.
The server builds production/quality evidence in Korean/Chinese after 09:00
Asia/Shanghai, for the previous closed business date and the preceding week.
The app writes the answer using only that evidence, runs local `validate`, then
`submit`. Inspect `accepted_explanation`, not just process exit code: a stored
server fallback or unverified submission must not be retried as a new submit.

The [current contract and runner procedure](../docs/ai/2026-09-21-chatgpt-daily-analysis.md)
cover credentials, command shapes, numeric grounding, lease handling, deployment
gates and acceptance checks. `status` and `validate` are entirely local.

`claude_bridge.py` remains as the shared implementation and compatibility-test
surface. This does not require Claude Code, the Claude app or a Claude subscription.
The current backend rejects Claude worker capabilities. Historical result rows
and their `claude_desktop_review` source must not be renamed or removed.
