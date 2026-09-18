# Mac Studio WJ AI Worker

WJ Reporting uses one outbound `launchd` service after login:

- `com.wj.local-ai-worker`: waits for the model server's `/v1/models` response, polls the Render backend, ensures hourly jobs exist, and submits results.

The on-device model server (MLX, OpenAI-compatible) is managed separately at
`127.0.0.1:8082`. These scripts do not start, stop, or restart that protected
runtime. The Worker advertises `qwen38` only when `/v1/models` reports the
exact configured checkpoint (`Qwen3.8-27B-4bit`).

Production explanations, production questions, daily quality summaries, and
quality report audits all use the single canonical local model ID `qwen38`.
Weekly deep analysis jobs use model ID `claude` and are served by the Claude
desktop scheduled task through `local_worker/claude_bridge.py` (see below).

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
3. Confirm that the separately managed model server is ready on port 8082.
4. Install and start the outbound Worker:

   ```bash
   ./scripts/local_ai/install-launch-agents.sh
   ```

## Operations

```bash
launchctl print gui/$(id -u)/com.wj.local-ai-worker
tail -f ~/Library/Logs/wj-local-ai/worker.out.log
tail -f ~/Library/Logs/wj-local-ai/worker.err.log
```

To remove the Worker and any legacy WJ model launch agents while preserving
the Keychain token:

```bash
./scripts/local_ai/install-launch-agents.sh --uninstall
```

## Claude deep-tier bridge and scheduled task

`python -m local_worker.claude_bridge` (run from the repository root with the
backend virtualenv) serves `deep_analysis` jobs for model id `claude`. It reads
the same Keychain token item as the Worker and never prints it.

```bash
cd /path/to/wj_reporting
backend/.venv/bin/python -m local_worker.claude_bridge heartbeat
backend/.venv/bin/python -m local_worker.claude_bridge claim
backend/.venv/bin/python -m local_worker.claude_bridge submit <id> ~/.local/share/wj-claude-bridge/jobs/<id>/answer.json
backend/.venv/bin/python -m local_worker.claude_bridge fail <id> "<reason>"
backend/.venv/bin/python -m local_worker.claude_bridge status
```

`claim` marks the job running, writes `~/.local/share/wj-claude-bridge/jobs/<id>/bundle.md`
(instructions plus the input payload as fenced JSON) and prints the bundle path, job id,
kind, language and lease as JSON. `submit` validates the answer locally (schema, length
caps, every number must be in `input_payload.evidence_numbers`) and posts `complete`
with prompt version `deep-analysis-claude-v1`; on a validation failure it exits 1 and
leaves the job claimed so the answer can be revised and submitted again (`fail <id>
"<reason>"` gives up explicitly).

Scheduled task outline (`~/.claude/scheduled-tasks/wj-deep-analysis`; create it
disabled and enable it after the backend deploy):

1. Run `heartbeat`.
2. Run `claim`; if it prints `{"job": null}` stop.
3. Read the bundle, write `answer.json` in the required shape (all numbers from the payload).
4. Run `submit <id> <answer.json>`; on exit 1 fix the printed reason and submit once
   more, then `fail` the job if it is still rejected.
5. Repeat from step 2 while `claim` returns a job, at most 4 jobs per run.

Environment for the task: `RENDER_API_BASE_URL` (defaults to production),
`WORKER_NAME` (default `mac-studio-claude-desktop`), optional `CLAUDE_BRIDGE_HOME`,
`AI_WORKER_KEYCHAIN_SERVICE`, `AI_WORKER_KEYCHAIN_ACCOUNT`.
