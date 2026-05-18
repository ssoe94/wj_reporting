# AGENTS.md

## Project Context

This repository is WJ DATA CENTER / `wj_reporting`.

Current product direction:

- Rebuild the reporting site without interrupting the existing Render deployment.
- Keep production numbers deterministic and auditable.
- Add AI as a production analysis layer, not as a free-form chatbot.
- Follow `docs/rebuild/19-ai-rag-architecture.md` for the AI/RAG direction.

Current AI priority:

- P1 계산형 RAG for the production dashboard.
- Production numbers must come from backend SQL/API retrievers and deterministic metric functions.
- LLM is optional and should only rewrite/explain verified facts.

Current implementation state:

- `backend/production/ai_types.py` exists.
- `backend/production/ai_metrics.py` exists.
- `backend/production/ai_retrievers.py` exists.
- `backend/production/ai_context.py` exists.
- `backend/production/ai_answer.py` exists.
- `GET /api/production/ai/briefing/` has been added as the first deterministic AI briefing endpoint.
- The frontend production dashboard calls the briefing endpoint and falls back to local screen-derived briefing if the endpoint fails.

## Hard Rules

- Do not connect frontend directly to Mac Studio, local MLX, or any local LLM for production behavior.
- Do not implement document RAG, pgvector, Qdrant, or vector DB work until P1 계산형 RAG is stable.
- Do not let an LLM calculate production numbers.
- Do not generate or execute free-form SQL from LLM output.
- Do not touch production secrets, `.env` files, credentials, or deployment settings.
- Do not modify database migrations unless explicitly requested.
- Do not deploy.
- Do not auto-merge.
- Do not commit directly to `main`.
- Do not revert unrelated user changes.
- Prefer small, reviewable changes.
- If production DB access, credentials, migrations, or deployment changes appear necessary, stop and summarize instead of guessing.

## Backend Rules

Allowed P1 modules:

- `backend/production/ai_types.py`
- `backend/production/ai_metrics.py`
- `backend/production/ai_retrievers.py`
- `backend/production/ai_context.py`
- `backend/production/ai_answer.py`
- `backend/production/ai_gateway.py`, only if needed for existing ask flow cleanup
- `backend/production/views.py`, only for API endpoint wiring
- `backend/production/urls.py`, only for API route wiring

The deterministic AI response must include:

- `answer`
- `facts`
- `used_data`
- `calculation_basis`
- `data_freshness`
- `warnings`
- `retrieval_trace`

Backend calculations should preserve these rules:

- Business day is 08:00 to next day 08:00 in Asia/Shanghai.
- Injection actual output is estimated from MES shots multiplied by Cavity and allocated in production plan sequence.
- Completion rate is `actual_qty / planned_qty * 100`.
- Time progress rate is elapsed business-day time divided by 24 hours.
- A process is behind when production progress is more than 5 percentage points below time progress.

## Frontend Rules

- Keep `ProductionDashboardPage` changes minimal.
- Do not redesign the whole dashboard during AI/RAG work.
- The AI briefing card should stay below the top summary cards.
- Use existing styles where possible.
- If frontend files are changed, run `npm run build` in `frontend-next`.
- The dashboard should still display a deterministic fallback briefing if the AI briefing endpoint fails.

## Nightly Work Rules

- Use Codex App Worktree mode for nighttime work when possible.
- Recommended branch name: `codex/nightly-ai-rag-p1`.
- Keep the original `main` working tree as the human review area.
- Use the worktree as the disposable experimentation area.
- Do not commit, push, create PRs, merge, or deploy unless explicitly requested.
- Before editing, inspect `git status --short` inside the worktree and avoid unrelated dirty files.
- Avoid broad refactors.
- Add tests or smoke checks when practical.
- If a build/check fails, attempt focused fixes only. After two failed fix attempts, stop and summarize.
- End every task with:
  - changed files
  - commands run
  - what is complete
  - remaining risks
  - recommended next task

## Useful Commands

Frontend:

```bash
cd frontend-next
npm run build
```

Python syntax smoke check:

```bash
python3 -m py_compile backend/production/ai_types.py backend/production/ai_metrics.py backend/production/ai_retrievers.py backend/production/ai_context.py backend/production/ai_answer.py backend/production/views.py backend/production/urls.py
```

Django checks require the correct backend virtual environment. If Django is not importable, do not install dependencies automatically; summarize the missing environment.
