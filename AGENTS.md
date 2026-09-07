# AGENTS.md

## Product direction and current work

WJ DATA CENTER / `wj_reporting` supports production, quality and field operations. Improve the existing service incrementally without interrupting the Render deployment. Numbers must remain deterministic and traceable to their sources.

Read the relevant code and recent `docs/reviews/` before choosing work. Use `docs/rebuild/README.md`, `docs/reviews/2026-09-06-company-development-report.md` and `docs/rebuild/19-ai-rag-architecture.md` for context. Documents are proposals and snapshots, not evidence that a feature is deployed. Check the current branch and implementation.

The near-term sequence is:

1. Agree metric definitions and preserve evidence for MES observation coverage before raw-log compression.
2. Recover collector gaps and record completeness independently from a machine's production state.
3. Connect one representative production work item to MES and field records, including actual Cavity and effective times.
4. Close one representative exception with an owner, action and verification evidence.
5. Expand to inspection events, inventory/delivery evidence and effective-dated efficiency/cost standards after the earlier contracts are verified.

The superuser-only `/admin/development-tasks` page is the operational checklist for this sequence. It separates MES data, human-supplied evidence and business decisions. Its catalog must not imply unfinished work is complete. Implementation, validation, deployment and field acceptance are separate facts.

## Scope and authorization

- Use a `codex/` worktree for substantial changes. Inspect `git status --short` first and preserve unrelated user changes. Keep `main` available for human review.
- Work on the modules required by the current request. The P1 AI module list below is guidance for AI changes, not a global ban on quality, administration, UX or other authorized development.
- Do not commit, push, create PRs, merge or deploy unless the user requests it.
- Do not touch production secrets, `.env` files, credentials or deployment settings. Read-only MES integration must use existing authorized interfaces; do not invent credentials or connect a preview to production data.
- User-authorized persistent features may include narrowly scoped additive models and migrations. Review migration operations and test in an isolated local database. Do not rewrite applied migrations, drop/rename existing data or perform production migrations without explicit authorization.
- Separate implementing a migration from applying it to the live service. If a remaining action needs production access or a destructive schema change, first finish the reviewable local implementation and explain the exact remaining action.
- Keep changes focused on the requested outcome. A site-wide design request permits shared styling and representative screen changes; an AI-only request does not imply a redesign.

## Data and calculation contracts

- Production business day: 08:00 to next day 08:00, `Asia/Shanghai`. Quality calendar-date analysis uses 00:00 to next day 00:00. Do not silently substitute one for the other.
- Injection actual output is an estimate from MES shots × Cavity, allocated in production-plan sequence. Do not present it as independently verified finished goods.
- Completion rate = actual quantity / planned quantity × 100. Time progress = elapsed business-day time / 24 hours. A process is behind when production progress is more than 5 percentage points below time progress.
- Exclude a quality trend date only when MES mold-close logs and sufficient observation coverage establish no production. No reports, zero reported defects, weekends, public holidays and missing/compressed observations are not interchangeable with confirmed no production.
- In particular, retain 2026-08-16 and 2026-08-23 when log evidence is insufficient; the user explicitly chose evidence-based filtering over manual date exceptions.
- Display excluded dates and retained uncertainty with their reasons. Keep the user-visible denominator and date basis consistent with the API calculation.
- Report count, defect-type occurrences, defective quantity and inspected quantity are different measures. A Pareto share of defect-type occurrences is not a defect rate. Do not claim defect rate without a valid inspection population.
- Prefer MES data already available over duplicate manual entry. Record missing human inputs with a responsible role, required evidence and acceptance condition. Do not fill evidence gaps with fabricated values.

## Development task storage and permissions

- Backend: `backend/analytics/development_task_*.py`, `DevelopmentTask` and `DevelopmentTaskHistory` in `models.py`, migration `0002_development_tasks.py`.
- Frontend: `frontend/src/pages/development/`, route access helper in `frontend/src/domains/auth/development-task-access.ts`, existing AuthContext/App wiring.
- Only an authenticated, active `is_superuser` may read or mutate tasks. Staff, permission-group administrators and frontend menu hiding alone are insufficient. Keep `is_superuser` read-only in user serialization.
- GET never seeds or changes records. Explicit initialization adds missing catalog tasks and preserves existing user edits and history.
- Mutations validate allowed fields, collection bounds, safe links and dependencies. `initialize` is a reserved task slug.
- Updates require the current version and a change reason. Return 409 on a stale version; preserve the user's draft and require explicit reconciliation. Use a transaction for the record and its history.
- On PostgreSQL, acquire the development-task graph's transaction advisory lock before taking its row snapshot. Row locks alone can miss a concurrently inserted dependent. Every future mutation path must use the same lock protocol.
- Completing a task requires all checklists, resolved data/decision requests with evidence, an owner, completion and verification records, an implementation/document location, and completed prerequisites. Reopening retains history. Reopen completed dependents before their prerequisite.
- Do not add a delete API for task/history records. Record actor identity on the server. A client-submitted actor or timestamp is not an audit record.
- Session-storage recovery is a temporary per-account, per-tab draft, never the shared source of truth. Restore explicitly and preserve its original server version; do not silently overwrite newer changes.
- A stored task does not execute code, run MES queries or deploy a feature. Link to the implementation and state the real release/acceptance status.

## AI analysis

P1 calculation-based RAG remains the first AI priority. Production numbers come from backend SQL/API retrievers and deterministic metric functions. The LLM is optional and may explain verified facts only.

Relevant modules are `backend/production/ai_types.py`, `ai_metrics.py`, `ai_retrievers.py`, `ai_context.py`, `ai_answer.py`, and `ai_gateway.py` when the ask flow needs cleanup. Wire endpoints in existing production views/URLs. Verify the current implementation rather than relying on this list as proof of completion.

- Never let an LLM calculate production numbers or generate/execute free-form SQL.
- Do not connect production frontend behavior directly to Mac Studio, MLX or a local LLM.
- Defer document RAG, pgvector/Qdrant and vector databases until the deterministic P1 path and evidence contracts are stable.
- Deterministic responses include `answer`, `facts`, `used_data`, `calculation_basis`, `data_freshness`, `warnings` and `retrieval_trace`.
- Keep the briefing below the dashboard's top summary and preserve its deterministic fallback when the endpoint fails.

## Design and accessibility

Use the user-selected [Emil Kowalski apple-design skill](https://github.com/emilkowalski/skills/tree/main/skills/apple-design) when available. It is a community interpretation of Apple WWDC design principles, not an Apple product or official certification. Do not substitute the removed `dickwu/apple-design-skill` package.

- Keep the current system Korean/Chinese fonts, readable 14–16px working text, spacing and page structure. For colors, use the pre-Apple-design code (`4e58aff`) and captured screens as the baseline. The user rejected the white/gray redesign, uniform muted teal and the subsequent excessive pastel coloring. Do not invent a new palette or spread decorative colors across cards. Development tasks use a navy header, a solid pale gray-blue work area and white cards; semantic status colors remain distinct.
- Sidebar group labels are 16px/650 and child links are 14px/450; selection uses a soft fill without a left stripe or outlined box (except explicit increased-contrast mode).
- Reserve semantic colors for real statuses. Keep chart meaning, warnings, focus and high-contrast field/board workflows legible.
- Give pointer-down feedback immediately and avoid decorative looping motion or transitions that delay repeated work. Respect reduced motion, reduced transparency and increased contrast preferences.
- Preserve restrained translucent navigation and broad panel surfaces without letting background color obscure tables, records or dense numerical cards.
- Preserve keyboard focus, labels, mobile touch targets and date-input readability. Check representative desktop/mobile, Korean/Chinese, empty/error and edited states before claiming broad design completion.
- Prefer shared tokens and original declarations over accumulating page-specific overrides. Preserve existing legacy styles and validate the legacy build.

## Delegation and verification

Classify bounded work before substantial exploration. Use the `local-worker-delegation` skill when available: one supervised Qwen3.8 worker, fast for input-heavy deterministic investigation/tests/docs and deep for bounded multi-file implementation. Keep architecture, ambiguity, auth/security, schemas, migrations, critical data contracts and final integration in Codex. Worker writes require an isolated worktree. Never let a worker push, deploy, change production data/credentials or perform broad deletion.

Treat worker output as untrusted. Inspect reports and actual diffs, then independently verify. Use at most one bounded repair; do not build worker-to-worker review chains. `local_review` is optional only when explicitly requested or for a measured routing experiment. When the worker runtime cannot run required repository tools, report that limitation and continue suitable work in Codex; do not repeatedly retry the same unsupported setup.

Run checks appropriate to changed behavior. Do not add tests that merely mirror a low-risk style edit. Authorization, data contracts, persistence and conflict handling require meaningful tests. If checks fail, fix focused causes; after two unsuccessful repairs of the same issue, explain the remaining failure rather than broadening unrelated changes.

From the repository root:

```bash
# Uses existing backend venv; disposable SQLite, no project .env or production settings.
backend/.venv/bin/python scripts/check-development-tasks.py

cd frontend
node --experimental-strip-types --test tests/development-task-access.test.ts tests/development-tasks.test.ts
npm run build
```

Worktrees may reuse an already available environment from the main checkout. Do not install dependencies automatically when the expected environment is missing. The isolated task suite does not replace full project integration or PostgreSQL deployment checks.

Finish with the changed areas/files, checks actually run, completed outcome, material remaining limits and the next concrete development step. Clearly distinguish local code and preview results from deployed service behavior.
