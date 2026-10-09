# Local inspection and authentication integration

Verified locally on 2026-10-04. This candidate combines the existing inspection
beta with the current independent OAuth app and disconnected continuity decisions.
It does not activate OAuth, connect a credential vault or MES provider, deploy,
apply production migrations, issue credentials, or execute a real QC operation.

## Imported source and retained boundaries

Base: `cdc4b8958d3d4a4d0a5d7b1d419da776ceaf5839` (OAuth isolation, static fragment
relay, existing-login hardening and metadata-only continuity).

Inspection core: the 87 paths changed between production baseline
`9039735fc73443419ac392f9618e42d58207186e` and
`3d4cff854ff14f98352cc479eed53e451b7dbd72`. This includes `289b0ee`, `454922a`,
`a8e28d0`, `4b29131` and `3d4cff8`: local request/input/review, separate MES
save/inspection-finish/reconciliation, failure/reinspection history, shared board
projection, scope checks and synthetic tests.

From `d4f78cd43209e94bea02e3da6a713ba7f64dc8f1`, only these paths were selected:

- `backend/quality/test_inspection_flow_scenarios.py`
- `docs/inspection-auth-and-flow-acceptance.md`
- `docs/inspection-mes-disposition-contract.md`

The acceptance document now points to the retained `mes_oauth`/relay/continuity
implementation. The integration does not change any inspection business rule.
The local inspection request remains restricted to active superusers and its
independent-review rule is retained. Field-operator permissions, first/periodic
generation policies, disposition approvals and production-impact policies remain
unresolved activation work.

`DisabledInspectionAdapter`, `DisabledStageAdapter` and the board source returning
`None` remain intact. A saved QC result and completed QC inspection are separate
operations; neither finishes a production task/work order nor closes a defect
case. `can_execute=False` remains explicit for nonconformance follow-up.

The existing `mes_oauth` implementation, fragment relay, secure cookie controls,
CSRF exception, callback-query redaction and removal of raw authentication logging
are preserved. Its callback still drops the verified user-context reference.
Continuity still models only `identity_read` and cannot supply a live QC token.

## Deliberately excluded legacy OAuth paths

The following PR #87 paths were not imported:

- `backend/quality/inspection_oauth_client.py`, `inspection_oauth_models.py`,
  `inspection_oauth_security.py`, `inspection_oauth_urls.py`, `inspection_oauth_views.py`
- `backend/quality/inspection_user_context.py`
- `backend/quality/test_inspection_oauth.py`, `test_inspection_user_context.py`
- `backend/quality/migrations/0013_inspection_oauth_attempt.py`

The old OAuth model import, config wiring, migration-test expectations and runner
labels from that commit were also excluded. There is one replay ledger:
`mes_oauth.0001_initial` / `OAuthAttempt`. Quality migrations `0010` through `0012`
add five inspection tables and do not create another OAuth attempt table.

## Integration-specific adjustments

- `AuthContext.tsx` retains the current authentication logging hardening and adds
  the existing inspection-route access guard.
- The CI workflow retains both validation groups. OAuth and inspection PostgreSQL
  fixtures use distinct directories (`pg-ci` and `pg-ins`); neither overwrites or
  reuses a cluster. Deployment triggers/settings are unchanged.
- The inspection runner now includes the selected flow-scenario module. CI also
  runs inspection migration/flow/access checks through the full-route OAuth
  harness, which blocks Python external networking and uses synthetic settings.
- `mes_oauth.test_release_scope` verifies distinct inspection/OAuth handlers,
  one OAuth ledger and disabled MES adapters. Its former OAuth-only assumption
  that no inspection routes/models exist no longer describes this candidate.

## Local evidence

No dependencies were installed. Existing Python, PostgreSQL and Node packages
were reused. Frontend build/cache directories belong to this worktree, not the
source dependency checkout. The PostgreSQL runners created and stopped only
their own disposable socket-only clusters under this worktree's `output/`.

| Check | Result | Local record |
| --- | --- | --- |
| Isolated inspection SQLite | 274 run, 266 passed, 8 PostgreSQL-only skips | `output/inspection-sqlite.log` |
| Isolated inspection PostgreSQL | 274 passed | `output/inspection-postgres.log` |
| OAuth/continuity SQLite | 100 run, 98 passed, 2 PostgreSQL-only skips | `output/oauth-sqlite.log` |
| OAuth/continuity PostgreSQL | 100 passed | `output/oauth-postgres.log` |
| Full-route inspection migration/flow/access | 10 passed | `output/combined-routes-sqlite.log` |
| Existing archive/login/password/account regressions | 15 passed | `output/existing-auth.log` |
| PostgreSQL runner safeguards | Inspection 10 passed; OAuth 19 passed | `output/inspection-pg-safety.log`, `output/oauth-pg-safety.log` |
| Frontend Node contracts | 276 passed | `output/frontend-tests.log` |
| Frontend lint | Exit 0; 0 errors, 31 warnings | `output/frontend-lint.log` |
| Loopback inspection fixture build | Passed, including TypeScript and legacy CSS | `output/frontend-build.log` |

These are separate runs, not additive unique-test counts. The fixture build
loads no project environment file and points its API to loopback; it is not a
deployed build or a browser acceptance run. Migration/system checks passed for
the tested apps. No live provider or production database was involved, and no
remote CI run or publication was performed by this integration.

An independent static review found no new integration blocker. It noted one
pre-existing E2E limitation: the inspection spec recognizes `zh-mobile`, while
the general E2E config calls its mobile project `mobile-chromium`. General
`test:e2e:all` can therefore choose desktop navigation for that fixture. The
dedicated inspection-local config has the expected project names. Neither
browser suite was rerun here; the original spec was retained unchanged.

## Handoff to the credential/operation workstream

Cherry-pick the integration commit onto the chosen combined candidate only after
reviewing shared edits to CI and `mes_oauth/test_release_scope.py`. Future vault
models will require an explicit update to the one-app model assertion; preserve
the single OAuth replay ledger rather than reinstating the excluded quality app.
The integration acceptance document and this file may also overlap later plans.

No default runtime token source was redirected. A future user-scoped QC adapter
must explicitly bind the verified user credential and current operation actor;
the existing inspection transport's inventory-token default is not that binding.
Provider expiry, permission, executor, per-stage readback and uncertain-outcome
contracts must be reviewed before activation. Public board reads must consume
verified collected evidence without authenticating or dispatching MES operations.

The quality migrations have user foreign keys. Their existing regression records
the old-code account-deletion limitation when those tables contain relations;
do not apply the OAuth-only rollback guarantee to the broader inspection schema.
Keep source integration, production migration, deployment and live acceptance as
separate decisions.
