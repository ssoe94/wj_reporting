# Mac Studio WJ AI Worker

WJ Reporting uses two login-time launchd services:

- `com.wj.local-ai-worker`: outbound Render polling, heartbeats and result submission.
- `com.wj.local-ai-model`: independently supervised loopback model server on
  `127.0.0.1:8082`, with RunAtLoad and KeepAlive. A model exit is restarted without
  restarting the worker; a worker reinstall does not stop a running model.

`run-model.sh` reuses the existing approved, isolated oMLX environment under
`~/Developer/wj-ai-omlx-stage2-20261025` (override: `LOCAL_AI_OMLX_ROOT`). It runs
`serve-verified-runtime.py`, which verifies installed module versions/paths, with
one concurrent request, the existing 32 GB memory guard and 4 GB SSD cache.
It never installs dependencies and removes the Worker token from its environment.
The actual artifact is Qwen3.8-27B-oQ4e-mtp; the preserved
`Qwen3.8-27B-4bit` request alias is configured by the existing model settings.
Do not replace that model setting or change stored model identities during recovery.

The worker prefers the supervised service (kickstart without `-k`). For older
installations without that service, the previous one-shot `local-coder start`
bootstrap remains available through `LOCAL_AI_RUNTIME_REPO` / `LOCAL_AI_UV_BIN`.
Custom endpoints and `AI_WORKER_AUTOSTART_RUNTIME=false` skip worker bootstrap.
Neither setting disables an independently installed model service.

The Worker advertises `qwen38` only when `/v1/models` reports the
exact configured checkpoint (`Qwen3.8-27B-4bit`). If the endpoint is unavailable,
the worker keeps reporting its status and skips claims until readiness returns.
Completion logs carry a UTC timestamp and use the server's accepted payload to
distinguish `llm_success`, `deterministic_fallback`, `server_rejected`, and
`deterministic`. Missing acceptance evidence is logged as `acceptance_unknown`.

Production explanations, production questions, daily quality summaries, and
quality report audits all use the single canonical local model ID `qwen38`.
Daily deep-analysis jobs use model ID `chatgpt` and are served at 09:00
Asia/Shanghai through `local_worker/chatgpt_bridge.py` (see below).

The Worker token is stored in macOS Keychain. It is never written to a plist, `.env`, frontend bundle, or repository file.

## Shared model server, lock and timeouts

Port 8082 is shared with the coding-delegation gateway (`local_worker` MCP), and
the server generates one sequence at a time. The two clients coordinate through
an advisory `flock`:

- `LOCAL_LLM_LOCK_PATH` (default `$HOME/.local/share/codex-local-worker/state/generation.lock`,
  the gateway's lock; the directory is created with mode 0700 when missing). The
  Worker takes the lock before claiming a job and releases it after the job
  completes or fails. While the lock is busy the poll cycle is skipped without
  claiming, so no backend lease burns behind a coding generation. Periodic
  enqueue calls do not need the lock. Set it to an empty string to disable.
- `LOCAL_LLM_LOCK_WAIT_SECONDS` (default 90): how long one poll waits for the lock.
- `LOCAL_LLM_TIMEOUT_SECONDS` (default 240, honoured up to 600): ceiling for one
  model call. Each call actually uses `min(ceiling, prompt_chars/1200 + max_tokens/30 + 30)`
  seconds, so small prompts fail fast and 20K-token question prompts get the time
  their prefill needs. Keep it below the backend job lease (600 s).
- `AI_WORKER_HEARTBEAT_SECONDS` (default 30): heartbeats run on a daemon thread and
  keep flowing during long generations; the backend stale threshold is 300 s.

The runtime's automatic prefix cache only reuses identical token prefixes, so the
Worker keeps static prompt text (instructions, schemas, taxonomy) first and the
per-job data last. Do not reorder prompt payloads without checking the tests.

## First-time setup

1. Generate and store the token, then copy it to the clipboard:

   ```bash
   ./scripts/local_ai/configure-worker-token.sh
   ```

2. In the Render `shared-secrets` environment group, set `AI_WORKER_TOKEN` to the clipboard value and redeploy the backend.
3. Confirm the approved oMLX runtime files exist; installation does not download a model or dependencies.
4. Install and start the supervised model and outbound Worker from a normal macOS login terminal:

   ```bash
   ./scripts/local_ai/install-launch-agents.sh
   ```

## Operations

```bash
launchctl print gui/$(id -u)/com.wj.local-ai-model
launchctl print gui/$(id -u)/com.wj.local-ai-worker
curl --fail http://127.0.0.1:8082/v1/models
tail -f ~/Library/Logs/wj-local-ai/worker.out.log
tail -f ~/Library/Logs/wj-local-ai/worker.err.log
```

To remove the Worker and any legacy WJ model launch agents while preserving
the Keychain token:

```bash
./scripts/local_ai/install-launch-agents.sh --uninstall
```

## Daily ChatGPT bridge and scheduled task

Use `python -m local_worker.chatgpt_bridge` from the repository root with the
existing backend virtualenv. The app automation runs daily at 09:00 Asia/Shanghai
and checks the deployed contract before any heartbeat or queue operation.

```bash
backend/.venv/bin/python -m local_worker.chatgpt_bridge readiness
backend/.venv/bin/python -m local_worker.chatgpt_bridge status
```

The authorized runner then uses `heartbeat`, `enqueue`, `claim`, `validate` and
`submit`, processing at most four jobs per run. Treat `accepted_explanation=true`
as success; HTTP success or exit zero alone is insufficient. Never resubmit or
fail an already submitted job. See the [complete bridge and acceptance contract](../../docs/ai/2026-09-21-chatgpt-daily-analysis.md)
for commands, evidence rules and failure handling.

The Claude scheduled task is retired and must remain disabled. Its shared bridge
module is retained for implementation compatibility and historical records; the
current deployment does not accept Claude worker capabilities.

Runtime bootstrap uses `uv run --no-sync`: it reuses the installed manager environment and does not install or update dependencies at worker startup.

## Quality translation outage recovery

Quality action-result translation uses only the local qwen38 queue, not ChatGPT.
A live worker heartbeat is insufficient: check `workers[]` for
`worker_name=mac-studio-local-ai`, `llm_ready=true`, and `available_model_ids`.
The LGENT companion heartbeat can be online while the model is down.
After 06:00 Shanghai, ordinary periodic polls enqueue bounded missing-translation
batches. Verify `accepted_translation=true` and Korean text in quality history;
do not edit source reports or submit guessed translations to clear a backlog.

On 2026-11-10, 53 reports dated Nov 3–9 were pending while Nov 2 reports had
accepted translations. Port 8082 was closed and the old bootstrap manager path
under Documents/Codex/2026-08-16 no longer existed. This change restores persistent
supervision using the already installed runtime, without Render configuration,
credentials, source-data changes, or ChatGPT fallback.

Model execution needs a normal macOS login session with Metal/GPU access.
A sandbox reporting `No Metal device available` cannot verify the running model;
install/start from the normal Mac terminal rather than altering OS protections.
