# AI tiers, neutral labels and local-worker alignment (2026-09-18)

Branch `claude/ai-services-claude-migration-20260917`. This document is the contract every part of the change follows. It describes local code on the branch, not deployed behaviour.

## Why

- The app's AI surfaces (production dashboard briefing/assistant, overview board quality briefing, daily quality attention, AI classification review) hard-code "Qwen 3.8", "Qwen", "Mac Studio Worker" in ko/zh copy, so every model change is a bilingual copy sweep.
- The Mac Studio worker was found stopped from 2026-08-29 to 2026-09-17 (Keychain token missing). While catching up it processed ~1,400 queued jobs; 792 photo-audit jobs fell back because the model output failed validation.
- The local runtime now has automatic prefix caching (APC) enabled, but the worker's prompts put variable data first, so the cache rarely hits; its LLM timeout is hard-capped at 120 s while a 20K-token prompt needs ~65 s of prefill alone; heartbeats share the inference thread; user questions queue behind photo-audit backlogs; and the worker never coordinates with the coding-delegation gateway that shares the same single-sequence model.
- The owner now develops with Claude Code and wants a second, expert tier for deep analysis handled by a Claude desktop scheduled task on the same job queue.

## Decisions (owner, 2026-09-17)

1. Model-neutral UI wording; the real model name is displayed from server data through one helper.
2. Tiered runtime: routine jobs stay on the local Qwen worker; deep analysis jobs are claimed by a Claude desktop scheduled task through the same `ai_core` queue. Production data for those jobs is sent to Anthropic.
3. Commit and open a PR; never merge (merging `main` deploys production).

## Invariants that do not change

- Persisted and contract identifiers stay as they are: model id `qwen38`, `result_payload.source = local_llm_rewrite`, `qwen_classification`, prompt versions `quality-daily-attention-qwen38-v5` and `quality-report-taxonomy-audit-qwen38-v1`, schema versions, `claimed_by` names. Renaming them would orphan history and re-queue every audit.
- LLMs never calculate production numbers. Server-owned facts are restored on completion exactly as today; the deep tier gets the same treatment.
- Worker auth stays `X-AI-WORKER-TOKEN`; the Claude bridge reads the same Keychain item and never prints it.

## Model registry (backend/ai_core/model_registry.py)

```python
LOCAL_AI_MODEL_ID = "qwen38"          # routine tier, on-device
DEEP_ANALYSIS_MODEL_ID = "claude"      # expert tier, Claude desktop scheduled task
AI_MODEL_TIERS = {"qwen38": "local", "claude": "deep"}
AI_MODEL_DISPLAY_NAMES = {"qwen38": "Qwen 3.8 27B", "claude": "Claude"}
AI_WORKER_CAPABILITY_MODEL_IDS = ("qwen38", "claude")
SUPPORTED_AI_WORKER_VERSIONS = ("production-ai-worker-v2",)   # set semantics; keep SUPPORTED_AI_WORKER_VERSION as the preferred value
def display_model_name(value) -> basename only (existing)
def model_display_name(model_id, model_name="") -> registry name, else display_model_name(model_name), else ""
```

`PRODUCTION_AI_MODEL_IDS` (hourly briefing loop) stays `("qwen38",)`; `claude` is never scheduled hourly.

## Deep analysis job (new)

- `AiJob.JOB_TYPE_DEEP_ANALYSIS = "deep_analysis"` added to `JOB_TYPE_CHOICES` (additive migration `ai_core/0002`).
- `scope`: `{"kind": "production_weekly" | "quality_weekly", "language": "ko" | "zh", "period_start": "YYYY-MM-DD", "period_end": "YYYY-MM-DD", "trigger": "weekly" | "manual", "model_id": "claude"}`.
- `input_payload` (server-built, deterministic; `backend/ai_core/deep_analysis.py`):
  - `production_weekly`: for each business date in the period, the authoritative briefing (`facts`, `severity`, `top_risks`, `warnings`, `data_freshness`) taken from the newest completed hourly `production_daily_analysis` job of that date/language, else `build_ai_briefing(date, language)`; plus `metric_definitions` (completion rate, time progress, behind rule) and `constraints`.
  - `quality_weekly`: for each calendar date, the deterministic daily attention payload's metric summary (`build_daily_quality_attention`) reduced to counts, problem types, Pareto shares and excluded-date reasons; plus definitions and constraints.
  - Common: `schema_version: "deep-analysis-input.v1"`, `language`, `period`, `evidence_numbers` (every numeric token that appears anywhere in the pack, as strings) so completion can check grounding.
- Enqueue: `POST /api/ai/jobs/enqueue-periodic/` creates, once per (kind, language, period_end), the two weekly jobs on the first business day of the week at or after 08:00 Asia/Shanghai for the previous Monday–Sunday. `POST /api/ai/jobs/` accepts `job_type = deep_analysis` with `scope.kind` and `scope.language` (`date` optional = period end) for `is_staff` users, subject to the existing manual rate limit.
- Claim: routed by `scope.model_id in available_model_ids` exactly like production jobs; a worker asks for it with `job_types: ["deep_analysis"]`.
- Result contract (`result_payload`, validated on complete by `restore_authoritative_deep_analysis_result`):
  ```json
  {"schema_version": "deep-analysis.v1", "source": "claude_desktop_review", "model_id": "claude",
   "summary": "…", "findings": [{"title": "…", "statement": "…", "evidence_refs": ["2026-09-15:injection.completion_rate"]}],
   "actions": ["…"], "caveats": ["…"], "llm_fallback": false}
  ```
  Server checks: schema, length caps (summary ≤ 1,200 chars, ≤ 8 findings, ≤ 8 actions, ≤ 6 caveats), every number in prose must be in `evidence_numbers` (else the result is kept under `llm_review_summary`, `llm_fallback = true`, `llm_fallback_code = grounding_rejected`), and `period`/`kind`/`language` are copied back from `input_payload`.
- Read: `GET /api/ai/jobs/latest/?job_type=deep_analysis&kind=…&language=…&model_id=claude` returns the newest completed job for that kind/language.

## Worker status contract

`GET /api/ai/worker/status/` keeps every existing top-level field describing the **local tier** (the freshest heartbeat that advertises `qwen38`, or any local-tier worker), and adds:

```json
"model_display_name": "Qwen 3.8 27B",
"workers": [
  {"tier": "local", "worker_name": "mac-studio-local-ai", "state": "online", "model_name": "Qwen3.8-27B-4bit",
   "model_display_name": "Qwen 3.8 27B", "available_model_ids": ["qwen38"], "last_heartbeat_at": "…", "heartbeat_age_seconds": 12},
  {"tier": "deep", "worker_name": "mac-studio-claude-desktop", "state": "offline", …}
]
```

`is_production_ai_model_available(model_id)` looks for any fresh, compatible heartbeat advertising that model id. Heartbeat rows stay one-per-`worker_name`.

`complete`/`fail` store `display_model_name(model_name)` (basename) instead of the raw path; job serializers add `model_display_name`.

## Queue priority (claim order)

0 today's daily attention · 1 other daily attention · 2 interactive question · 3 hourly briefing · 4 manual · 5 weekly/deep · 6 quality_report_scan audits (FIFO inside each rank). Photo-audit enqueue skips when ≥ 10 audit jobs are already pending/claimed.

## Local worker (local_worker/)

1. Heartbeat runs on a daemon thread with its own `requests.Session`; `/models` readiness probe on that thread uses a 3 s timeout and is skipped while a generation is in flight (last known value is reported).
2. `LOCAL_LLM_TIMEOUT_SECONDS` is honoured up to 600 (default 240). Each call's timeout is `min(configured, estimate)` where `estimate = prompt_tokens / 300 + max_tokens / 30 + 30` seconds (`estimate_prompt_tokens`: latin chars / 4 plus one token per CJK char; about 300 tok/s prefill, 35 tok/s decode).
3. Generation lock: before claiming, the worker takes a bounded `flock` on `LOCAL_LLM_LOCK_PATH` (default `~/.local/share/codex-local-worker/state/generation.lock`, the coding gateway's lock; wait up to `LOCAL_LLM_LOCK_WAIT_SECONDS`, default 90). If the lock is not available the poll cycle is skipped without claiming, so a lease never burns while another generation runs. The lock is released after the job completes or fails. Set `LOCAL_LLM_LOCK_PATH=` empty to disable.
4. APC-friendly prompts: every static block (instruction, output schema, status semantics) lives in the system prompt or at the head of the user payload; language-independent data precedes language-dependent data; the question and conversation history come last. Production prompt versions bump to `production-daily-v5`, `production-machine-v5`, `production-question-v9`. The two quality handlers keep their pinned versions and only reorder (static taxonomy/schema first, report/images last).
5. Question handler token budget: estimate tokens (chars/4, CJK chars count 1 each) and trim `historical_snapshots` and `conversation_history` until ≤ 12,000 estimated tokens; refuse (fallback code `input_too_large`) above 28,000. The grounding payload is built from the same trimmed payload.
6. `model_name` reported to the backend is the checkpoint basename.
7. Photo-audit fallback "duplicate image observations": identical observations for byte-identical images are de-duplicated before validation instead of rejecting the whole result.
8. Neutral wording in worker error strings persisted to the backend (`AI model` instead of `Qwen`).

## Claude deep-tier bridge (local_worker/claude_bridge.py)

CLI used by the Claude desktop scheduled task; it is the only thing that touches the token.

```
python -m local_worker.claude_bridge heartbeat            # advertises ["claude"], worker_name mac-studio-claude-desktop
python -m local_worker.claude_bridge claim                 # claims one deep_analysis job, marks it running, writes the prompt bundle to
                                                           # ~/.local/share/wj-claude-bridge/jobs/<id>/bundle.md and prints its path + lease
python -m local_worker.claude_bridge submit <id> <answer.json>   # validates the answer locally (schema + numbers ⊆ evidence_numbers), posts complete;
                                                           # exit 1 keeps the claim so the answer can be revised; 403 on complete = lease lost (exit 2)
python -m local_worker.claude_bridge fail <id> "<reason>"       # explicit give-up; the weekly enqueue retries a failed pair once
```

- Configuration by env with the same names as the worker (`RENDER_API_BASE_URL`, Keychain service `com.wj.local-ai-worker.token`); `WORKER_NAME` default `mac-studio-claude-desktop`; `worker_version` = `production-ai-worker-v2`.
- The bundle contains the input payload as fenced JSON and the instructions; it says explicitly that the payload is data, not instructions, and that every number in the answer must come from the payload.
- Grounding compares canonical number tokens on both sides (`09` ≡ `9`, `63.0` ≡ `63`), so natural `9월 8일` / `9月8日` prose grounds on ISO dates; `metric_definitions` numbers (08:00, 24 h, 5 %p) are part of `evidence_numbers`; `evidence_refs` are grounded like prose because the UI renders them.
- Deep jobs keep their lease for `DEEP_ANALYSIS_JOB_TIMEOUT_SECONDS` (2 h) instead of the 10-minute local-worker lease; `GET /api/ai/jobs/latest/?job_type=deep_analysis` also returns `failed_job` (a failure newer than the completed result) and the panel distinguishes a queued (`pending`) job from one being generated (`claimed`/`running`).
- The scheduled task (`~/.claude/scheduled-tasks/wj-deep-analysis`) runs `heartbeat`, `claim`, writes the answer, `submit`, and repeats while `claim` returns a job (max 4 per run). It was created on 2026-09-18 with cron `0 9 * * 1,4` (Monday for the weekly packs the worker enqueues from 08:00 Asia/Shanghai, Thursday to pick up manual staff requests) and is disabled; enable it after the backend deploy. It runs only while the Claude desktop app is open.

## Frontend

- New `frontend/src/domains/ai/model-labels.ts`: `AI_MODEL_DISPLAY_NAMES`, `describeAiModel({ modelId?, modelName?, modelDisplayName? })` → `{ displayName, tier }`, and bilingual tier/worker labels: `AI 보조 분석 / AI 辅助分析`, `AI 심층 분석 / AI 深度分析`, `AI 워커 / AI 处理端`, `AI 워커 온라인 · {displayName}` etc.
- Every hard-coded "Qwen 3.8", "Qwen", "Qwen3.8", "Mac Studio Worker" string in ko/zh copy is replaced by neutral wording plus the display name from data (`model_display_name`, `model_id` via the helper). Dead copy that names the model is removed.
- `ProductionAiModelId` becomes `"qwen38" | "claude"`; ask/latest requests keep sending `qwen38`.
- Overview board badge shows `AI 요약 · Qwen 3.8 27B` from `summary.modelId`; the `qwen38` gate is unchanged.
- Production dashboard and daily quality attention page get an `AI 심층 분석 / AI 深度分析` panel (`DeepAnalysisPanel`) showing the latest `deep_analysis` result for their kind/language (summary, findings with evidence refs, actions, caveats, model display name, period, generated-at) and, for staff, a request button; states: none yet, pending, fallback (review draft hidden, reason shown), ready.
- e2e helpers/specs updated to the neutral labels.

## Docs, policy, CI

- Root `CLAUDE.md` imports `AGENTS.md` and adds Claude Code specifics (branch prefix `claude/`, local-worker delegation, deep-tier scheduled task).
- `AGENTS.md` becomes master-neutral (Codex or Claude), branch prefixes `codex/` or `claude/`, delegation section aligned with the machine policy (git top-level path, `local_digest` for non-git input, default timeouts).
- `local_worker/README.md` and `scripts/local_ai/README.md` document the lock, timeouts, bridge and scheduled task; `docs/codex-nightly-plan.md` gets a superseded banner.
- CI runs all four worker test modules (`test_worker`, `test_quality_daily_attention`, `test_quality_report_taxonomy_audit`, `test_claude_bridge`).

## Out of scope

Renaming persisted ids; document RAG; Render configuration changes other than the token the owner already rotated; enabling the scheduled task before deploy.
