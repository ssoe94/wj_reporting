# WJ Operational QA Loop

## Purpose

WJ DATA CENTER is an operational manufacturing information system, not a static company site. QA must prove that production plans, MES data, machining reports, permissions, multilingual UI, and deterministic AI answers stay aligned.

The recommended method is:

```text
Contract definition
  -> deterministic fixtures
  -> backend contract tests
  -> browser operational scenarios
  -> evidence capture
  -> fix
  -> re-run
```

## Agent Split

Use agents by responsibility, not by page count.

| Agent | Responsibility | Output |
| --- | --- | --- |
| Backend contract explorer | Find gaps in production/MES/AI API contracts and tests | Missing contract tests and fixture candidates |
| Frontend flow explorer | Map actual routes, auth, selectors, and browser scenario blockers | Playwright-ready scenario list |
| QA infrastructure explorer | Review existing e2e/smoke/deployment checks | Files and commands to update |
| Data-flow architect | Review source tables, sync paths, grains, retention, and mart candidates | Analytics storage design and DQ gates |
| Analytics engineer | Review metrics, exception rules, and AI evidence contracts | Canonical calculations and roadmap |
| Visualization designer | Review dashboard structure, filters, charts, drilldowns, and responsive behavior | UI contracts for analytics screens |
| Worker agent | Implement one bounded slice after review | Patch + changed file list |
| Browser QA agent | Run local browser checks after implementation | Console/network/screenshot findings |

Do not ask an agent to "check everything." Each run needs a measurable scenario and pass/fail gates.

## Core Quality Gates

These gates should be checked before release and after any production dashboard, plan upload, MES, auth, or AI change.

| Gate | Pass Criteria |
| --- | --- |
| API routing | `/api/*` returns JSON, never `index.html` |
| Business date | Production day uses Asia/Shanghai 08:00 to next-day 08:00 |
| Plan anchor | Execution/MES/dashboard rows preserve `plan_date`, `plan_type`, `machine_name`, `part_no`, `lot_no`, `sequence` |
| Production math | Planned, actual, gap, progress, and Cavity allocation match deterministic fixtures |
| Browser health | Console errors 0, unexpected 404/500 requests 0 |
| Auth/RBAC | Protected pages redirect unauthenticated users; menus match capabilities |
| Language | Korean and Chinese UI render without `undefined`, `NaN`, or broken layout |
| AI briefing | AI answer includes facts, used data, calculation basis, freshness/warnings, and retrieval trace |
| LLM isolation | Production numbers are calculated before LLM use; LLM failure does not break deterministic answer |
| Analytics mart freshness | Mart output shows source latest time, mart generated time, stale flag, and warnings |
| Analytics source trace | Every insight can point to source tables, row counts, calculation basis, and filter scope |
| Analytics retention | Analysis history is not lost by operational cleanup jobs |

## First Operational Scenarios

### 1. Production Plan Flow

Route:

- `/production/plans`

Checks:

- Login with local dev session in Vite dev mode.
- Load plan dates.
- Show injection and machining records for selected date.
- Show plan totals, machine summary, model summary, and detail rows.
- Upload action reports success/failure clearly.
- Change log endpoint returns JSON and visible entries.
- Page text does not contain `undefined` or `NaN`.

Primary APIs:

- `GET /api/production/plan-dates/`
- `GET /api/production/plans/?date=...&plan_type=injection`
- `GET /api/production/plans/?date=...&plan_type=machining`
- `GET /api/production/plan-change-logs/?date=...`
- `POST /api/production/plan/upload/`

### 2. Production Dashboard Flow

Route:

- `/production`

Checks:

- Load plan summary, production status, machining MES stats, injection matrix, and AI briefing.
- If `machining/provision` is available, verify MES/manual/effective machining totals and manual supplement modal.
- If Render has not deployed `machining/provision` yet, verify the dashboard falls back to machining MES stats instead of blocking the page.
- Compare top summary cards against fixture totals.
- Verify live progress rows allocate injection shots by Cavity and plan sequence.
- AI briefing renders deterministic backend answer or safe fallback.
- Used data and calculation basis are visible or inspectable.
- Page text does not contain `undefined` or `NaN`.

Primary APIs:

- `GET /api/production/plan-summary/?date=...`
- `GET /api/production/status/?date=...`
- `GET /api/production/machining/provision/?business_date=...&days=3`
- `GET /api/production/mes-report-stats/?date=...&plan_type=machining`
- `GET /api/injection/production-matrix/?interval=...`
- `GET /api/production/ai/briefing/?date=...&language=...`

### 3. MES Monitoring Flow

Route:

- `/mes/monitoring`

Checks:

- Injection machine rail renders 1 to 17 machines.
- Current machine summary and 24-hour trend render from matrix data.
- Snapshot refresh starts a job and shows progress/status.
- Machining report section separates matched, plan-only, and MES-only rows.
- Utilization modal opens and renders recent-day data.
- Page text does not contain `undefined` or `NaN`.

Primary APIs:

- `GET /api/injection/production-matrix/?interval=2min&columns=721`
- `GET /api/injection/production-matrix/?interval=1hour&columns=...`
- `POST /api/injection/update-recent-snapshots/`
- `GET /api/injection/update-recent-snapshots/status/`
- `GET /api/production/mes-report-stats/?date=...&plan_type=machining`

### 4. Auth and Language Flow

Routes:

- `/login`
- `/production`
- `/analysis`
- `/inventory`

Checks:

- Unauthenticated protected route redirects to `/login`.
- Vite dev login with `superuser` reaches `/production`.
- Staff user sees production, MES, analysis, and inventory nav items.
- Korean and Chinese language switch persists in `localStorage`.
- No route renders an empty shell because of capability mismatch.

### 5. AI Contract Flow

APIs:

- `GET /api/production/ai/briefing/?date=...&language=ko`
- `GET /api/production/ai/briefing/?date=...&language=zh`
- `POST /api/production/ai/ask/`

Checks:

- Briefing works without local LLM.
- Response contains `answer`, `facts`, `top_risks`, `used_data`, `calculation_basis`, `context_pack`, `cache`.
- `context_pack.retrieval_trace` names the data sources used.
- Korean and Chinese answers use the same facts.
- Numeric facts match backend fixture expectations.

### 6. Analytics Storage and Visualization Flow

Routes:

- `/analysis`
- `/production`
- `/mes/monitoring`
- `/inventory`

Checks:

- Analysis pages read from deterministic analytics APIs or fixtures, not ad hoc page-local calculations.
- KPI cards, trend charts, exception tables, and drilldown modals expose freshness and source evidence.
- Empty data, stale data, and DQ warnings render as explicit states instead of blank charts.
- Production progress, AI briefing facts, and analytics mart totals match the same backend fixture.
- Inventory and MES history used for analysis is not removed by operational cleanup retention.

Primary future APIs:

- `GET /api/analytics/overview/?date=...`
- `GET /api/analytics/production-progress/?date=...`
- `GET /api/analytics/exceptions/?date=...`
- `GET /api/analytics/inventory-risk/?date=...`
- `GET /api/analytics/ai-evidence/?date=...`

## Implementation Order

1. Add backend fixture tests for business date, Cavity allocation, machining matched/plan-only/MES-only rows, and AI briefing schema.
2. Replace old Playwright route assumptions with `frontend-next` routes.
3. Add stable selectors only where user-facing text is not a reliable selector.
4. Add Playwright network/console guards shared by all operational specs.
5. Run local Vite dev mode with mocked or test backend data first, then run a smaller smoke suite against deployed URLs.
6. Add analytics fixtures only after the grain and source trace are documented.

## Commands

Local browser QA starts the `frontend-next` Vite server and uses deterministic Playwright API mocks:

```bash
npm run test:e2e
```

Deployed API routing checks are opt-in because they hit the configured environment:

```bash
FRONTEND_URL=https://wj-reporting.onrender.com npm run test:e2e:api
```

Backend production contract tests:

```bash
cd backend
.venv/bin/python manage.py test production --no-input
```

## Current Automated Coverage

The first implemented suite covers:

- auth redirect and local dev session shell smoke
- Korean/Chinese shell navigation
- production dashboard deterministic plan/MES/AI briefing evidence
- production progress detail modal
- MES injection machine rail
- MES utilization modal
- MES snapshot refresh status
- MES machining matched, plan-only, and MES-only rows
- backend production console plan-anchor contract
- backend AI briefing evidence contract

## Evidence Standard

Each automated browser scenario should keep:

- console error list
- failed request list
- viewport used
- route visited
- screenshot or trace on failure
- relevant API response fixture name

Passing a scenario means the workflow reached the expected final state and all quality gates stayed clean.
