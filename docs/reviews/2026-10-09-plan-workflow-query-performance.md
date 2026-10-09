# Plan workflow query performance — local validation, 2026-10-09

The material preparation GET on main `4574344f` queried identity, revision,
approval, defaults and execution history for each historical plan. Both real
production process views had returned HTTP 500 with a worker timeout. This
change bulk-loads request-local relationships and checks execution history only
for complete campaigns returned in the requested window.

## Preserved behavior

- Existing plan upload/display and historical quantities remain unchanged.
- Grouping still uses the whole selected-machine horizon, including consecutive
  days outside the requested dates. The existing 5,000-row cap blocks preparation
  while separately selected display rows retain their identities.
- Execution matching uses exact historical date/type/machine/part/LOT/sequence
  keys. NULL and empty LOT remain distinct; record PKs dedupe within each group.
  Optional coarse SQL filters may broaden a read but never discard exact matches.
- Approval/default/version selection, request dedupe, uncertainty guards,
  quantity precision and below-production/inbound guards remain in force.
- Each locked prepare builds a fresh read context. GET caching grants no writer
  authority. Ordinary MES writes remain OFF; no schema/settings/auth changes.

## Synthetic measurements

PostgreSQL 17.10, a private UNIX-socket fixture on Mac Studio; TCP disabled.
Times include the directly authenticated API handler and JSON rendering, and
exclude fixture setup, real authentication/middleware, network and Render.
The fixture includes both processes, approvals, revisions, defaults, ambiguity,
actual records, request history, continuous production and invalid legacy quantity.
Fixture tables are explicitly ANALYZEd before timing on both baseline and new code.

| Plans | Process | Baseline SQL | New SQL | Baseline seconds | New seconds | Response bytes |
|---:|---|---:|---:|---:|---:|---:|
| 100 | Injection | 527 | 14 | 0.1340 | 0.0130 | 35,662 |
| 100 | Machining | 500 | 12 | 0.1249 | 0.0107 | 34,367 |
| 5,611 | Injection | 25,090 | 14 | 5.8176 | 0.1944 | 35,662 |
| 5,611 | Machining | 25,072 | 12 | 5.6531 | 0.1902 | 34,367 |
| 12,011 | Injection | 37,600 | 14 | 8.3932 | 0.3106 | 35,662 |
| 12,011 | Machining | 37,582 | 12 | 8.3835 | 0.2662 | 34,367 |

SQLite showed the same SQL counts and response sizes. Full response SHA256,
row/group counts and bytes matched the baseline for all six responses on each
database. GET emitted zero write queries and preserved the fixture database
state digest. Source hashes did not change during measurement. More returned
members/parts can require additional bounded batches; this table does not claim
a universally constant query count or a measured production latency.

## Validation

- Isolated workflow: 195 tests, 191 passed, four PostgreSQL-only skips.
- PostgreSQL performance/concurrency/exact execution tests: 21/21 passed.
- Full backend using actual project settings with synthetic CI values, no `.env`,
  in-memory SQLite and blocked external Python traffic: 2,202 tests, 2,151 passed,
  51 environment-specific skips.
- Production migration check: no changes. Python syntax and whitespace checks pass.
- Frontend lint, 762 contract tests, TypeScript and modern/legacy builds pass.
- Local 5,611-plan UI: injection and machining GET 200; KO/ZH material tables and
  catalog/ratio/required-quantity editor verified at actual CSS 1280×720. Existing
  browser zoom was retained and the temporary viewport override was reset.

The unchanged legacy Korean upload toolbar wraps its button vertically at this
width. The material workflow table fits within the viewport. This backend change
does not redesign that toolbar. The limited UI fixture logged two generic API
errors during legacy-page initialization; all observed plan/workflow HTTP calls
returned 200. This is targeted workflow acceptance, not a complete-site UI test.

## Reproduction

Use an existing dependency environment; never supply production settings or DB URLs.
`--source-root` must identify an explicit baseline checkout, not an assumed parent
path. Baseline and new measurements import the same deterministic synthetic fixture.

```sh
backend/.venv/bin/python scripts/check-plan-workflow.py --migration-check
backend/.venv/bin/python scripts/check-plan-workflow.py
backend/.venv/bin/python scripts/benchmark-plan-workflow.py --test
backend/.venv/bin/python scripts/benchmark-plan-workflow.py --source-root=/explicit/baseline-checkout --sizes=100,5611,12011 --output=output/workflow-performance/before.json
backend/.venv/bin/python scripts/benchmark-plan-workflow.py --sizes=100,5611,12011 --output=output/workflow-performance/after.json --compare-before=output/workflow-performance/before.json
```

For PostgreSQL, add `--postgres-test-socket` pointing to an explicitly created
private fixture beneath this worktree's `output/`. A short absolute socket alias
is permitted only after its real target passes the existing fixture validator.
The CI PostgreSQL suite now includes the new performance and exact execution tests.

Local JSON results, full responses, logs and real browser captures are saved under
`output/workflow-performance/`. They contain synthetic data and are not committed.

## Release acceptance remaining

This performance change is local only. Push/PR/merge/deploy require new explicit
approval for this change. After the existing CI release path deploys the reviewed
commit, verify authenticated injection/machining GET 200 and KO/ZH loaded material
tables on the real service, confirm the exact deployed commit, and compare production
plan/history hashes and approval/request/diagnostic counts. No timeout increase,
production data edit, new credentials, MES writes or new migration is required.
