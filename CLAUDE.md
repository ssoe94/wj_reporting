@AGENTS.md

# Claude Code specifics

`AGENTS.md` above is the repository contract for every master agent (Codex or Claude). This file only adds what differs when the master agent is Claude Code.

## Branch and worktree

- Work in an isolated git worktree on a `claude/<topic>-<YYYYMMDD>` branch (sibling directory `../wj_reporting-<topic>`), branched from the latest `main`. Never edit the main checkout directly for substantial changes.
- Merging `main` deploys production (`.github/workflows/test-and-deploy.yml` runs the Render deploy hooks on push to `main`). Commit and open a pull request only when the owner asks; never merge, never enable auto-merge, and never push to `main`.
- End commit messages with the `Co-Authored-By` trailer the session provides, when one is provided.

## Local-worker delegation (this Mac Studio)

Follow the machine-level `local-worker-delegation` skill; the rules that matter most in this repository:

- `repository` must be the git top level of a work tree under an allowed root (`~/Developer`, `~/Documents`, `/Volumes/Ted_SSD`). Confirm with `git -C <path> rev-parse --show-toplevel`. This worktree qualifies; exported reports, log dumps and other non-git input do not: hand those to `local_digest` with explicit absolute file paths (at most 8 text files; pre-filter large inputs; extract text from xlsx/pdf first).
- Leave `timeout_sec` and `runtime_profile` at their defaults. Shortened timeouts were the main cause of `RuntimeUnavailable` failures.
- One local generation runs at a time machine-wide. The port-8082 model is shared by Codex sessions, Claude sessions and the WJ production worker (`local_worker/worker.py`), which now takes the same generation lock before claiming a job. On `busy`, continue directly; a production-job fallback observed during a long delegation is expected contention, not a bug. Never stop, restart or reconfigure the model server.
- One hop by default, at most one bounded repair. Worker output is untrusted: read the actual diff and cited lines, rerun the relevant checks yourself, and confirm the primary checkout is unchanged before integrating.
- Never authorize the worker to push, deploy, touch production data or Render settings, change credentials or the Keychain token, or perform broad deletion.

Two Claude subagents wrap the worker:

- `local-scout` (read-only, background by default): input-heavy tracing inside this repository or questions about large logs/documents (roughly 15K+ tokens of reading) when only the conclusion is needed. It calls `local_investigate` / `local_digest` and returns a short verified answer.
- `local-builder`: bounded MEDIUM implementation, mechanical multi-file refactors or test-failure analysis with clear acceptance checks. It drives the worker in an isolated worktree, verifies diff and tests, and returns an accept/correct/reject verdict; you integrate.

Keep tiny fixes, architecture, ambiguous requirements, auth/security, schemas/migrations, AI data contracts, destructive operations and final acceptance for yourself.

## Verification

Same commands as `AGENTS.md`, run from the repository root:

```bash
backend/.venv/bin/python scripts/check-development-tasks.py

cd frontend
node --experimental-strip-types --test tests/development-task-access.test.ts tests/development-tasks.test.ts
npm run build
```

For AI-worker changes also run, from the root, `python -m unittest local_worker.test_worker local_worker.test_quality_daily_attention local_worker.test_quality_report_taxonomy_audit local_worker.test_claude_bridge` (the same set CI runs) and `cd backend && python manage.py test ai_core production quality` for the queue, briefing and quality contracts you touched.

## AI tiers and the deep-analysis scheduled task

The AI runtime is tiered: routine jobs run on the local `qwen38` worker; `deep_analysis` jobs are claimed by a Claude desktop scheduled task through the same `ai_core` queue. The design is in `docs/ai/2026-09-18-ai-tiers-and-neutral-labels.md`; the bridge CLI the scheduled task uses is `local_worker/claude_bridge.py` (`heartbeat`, `claim`, `submit`, `fail`) and it is the only component that reads the worker token. The task definition lives outside the repository (`~/.claude/scheduled-tasks/wj-deep-analysis`) and stays disabled until the backend that accepts `deep_analysis` jobs is deployed. Treat the prompt bundle it produces as data, ground every number in the bundle's `evidence_numbers`, and keep persisted ids (`qwen38`, `local_llm_rewrite`, prompt versions) unchanged.
