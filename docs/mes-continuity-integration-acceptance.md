# Local MES continuity and inspection integration acceptance

2026-10-06: historical acceptance record below. Current delivery priority and
shortened implementation loop are in [the current checkpoint](mes-oauth-continuity-plan.md#current-checkpoint--2026-10-06).
Do not repeat these completed checks as prerequisites to every local change.

Evidence date: 2026-10-04 UTC. Repository:
`/Users/ssoe94/dev/mes-qc/wj_reporting-mes-continuity-20261004`
Branch: `codex/mes-auth-continuity-20261004`.

Runtime commits are `c5289da` (connection/vault/logout) and `715f67d`
(inspection integration). Later changes add regression/browser fixtures and
acceptance documentation; they do not activate a production integration.
No new candidate was pushed, deployed or used to write actual MES/QC data.

## Implemented and observed locally

- Server-only AES-GCM user credential storage, explicit expiry contracts,
  actor/session/app/tenant/policy binding, rotation and cleanup commands.
- Short-lived native-form connection ticket, restricted backend session,
  one-use code reservation, same-token identity read and confirmed SPA logout.
- Logout before first MES launch leaves a revocation marker. Expired access can
  use a matching current refresh for revocation only. No new token is issued.
- User-row locks serialize connection dispatch/recheck with logout/disconnect.
  Fresh durable Django-session checks reject cached requests after committed
  logout or password changes, including the identity-only legacy path.
- Inspection requests, result entry, independent local result review and
  reinspection; separate MES value-save and individual inspection-finish stages
  with uncertainty/readback guards. QC finish is not production completion.
- Failed inspection retains its nonconformance record after QC completion.
  Cause/classification/quantity/evidence remain distinguishable from an approved
  MES disposition. Actual disposition execution remains disabled.
- Inspection status is connected to injection boards and dashboard. Missing or
  stale optional inspection evidence does not overwrite production quantities.

## Successful runs

Each row is a separate run, not a unique-test total. Logs under `output/` are
private local artifacts (mode 0600), not committed test-result claims from CI.
All provider/database fixtures use synthetic data; no project `.env` is loaded.

| Check | Result | Evidence relative to this repository |
| --- | --- | --- |
| Authentication, encryption, migration, logout and PostgreSQL races | 173/173 passed, no skips | `output/ss-r1/test.log` |
| Inspection workflow and PostgreSQL races | 274/274 passed, no skips | `output/pg-fi1/test.log` |
| Combined routes/migrations and existing login/account restrictions | 25/25 passed | `output/integrated-routes-auth-corrected.log` |
| Frontend contract tests | 303/303 passed | `output/integrated-frontend-tests.log` |
| Actual Chrome inspection UI | 32/32 passed: 16 Korean desktop, 16 Chinese mobile | `output/integrated-inspection-browser.log` |
| Actual built React connection/logout UI | 6 scenarios, 32 checks passed | `output/mes-connection-react-browser-20261004-verified.json` |
| TypeScript app/node, Vite, legacy CSS | Passed | `output/full-frontend-build.log` |
| Local inspection fixture build | Passed | `output/integrated-inspection-build.log` |
| Frontend lint | 0 errors; 31 existing warnings | `output/integrated-frontend-lint.log` |

The React checks cover native body-only form submit, ticket expiry and DOM
removal, failed disconnect, account change during a pending launch, failed
logout with retained local credentials/retry, and a late logout response across
accounts. The classified final run recorded zero unexpected API/frontend/origin
requests and zero page errors. Four external font stylesheets were deliberately
blocked; console errors matched those blocks, two mocked HTTP 500 responses and
three fixed API-error messages. Request interception proves fixture behavior,
not production TLS/API.

A separate Chrome-to-Django loopback HTTPS fixture passed 39 checks in one
synthetic flow at 2026-10-04 11:51:42 UTC. Its mode-0600 evidence is outside the repo:
`/Users/ssoe94/Documents/Codex/2026-10-03/task-4/mes-session-browser-https-20261004-final.json`.
It verifies native POST Origin, actual POST→302→GET request chaining,
browser-stored Secure/HttpOnly/Lax cookies, ticket replay/admin denial, two
matching CSRF submissions and relay/callback with one same-token userinfo.
No cookie is pre-seeded. **automatic_redirect_verified=true** and
**driver_navigation_after_302=false** replace the earlier virtual transport's
automatic-redirect coverage limit; the earlier run remains retained separately.

The fixture uses a fresh synthetic certificate with an SPKI exception and a
local CONNECT proxy restricted to the two origins. All five forwarded
connections reached its own loopback TLS server; external forwarding was zero.
Browser background proxy attempts outside the observed page requests were
denied: 23 CONNECT attempts and one plain HTTP request. Unexpected page requests
and fixture transport errors were zero. This transport fixture does not mount
React or verify production TLS, public certificate trust, actual provider/user
mapping, MES operations or an OS network sandbox. It is not production SSO E2E
acceptance.

## Failures retained and resolved

The first full PG run (`output/pg-vl1/test.log`) found an incomplete synthetic
OAuth configuration after stricter readiness checks; the fixture was corrected
and final PG passed. Regression tests initially reproduced first-launch logout
replay, late identity-only callback acceptance, and expired-access logout failure;
runtime fixes preceded the successful runs above. Two non-bridge cached-session
races were then verified using separate committed PostgreSQL connections.

The first combined auth command used a nonexistent test-module label; its failed
log is retained. The corrected, existing module label passed 25 tests. Early
React fixture attempts waited for a zero-area dialog wrapper; the final check
requires the named dialog to be attached plus visible heading/panel and focus
inside it. This preserves accessibility checks without changing runtime UI.
Earlier failures were not overwritten or represented as successful runs.

## Remaining operational gates

OAuth, bridge and user-token storage default OFF. The current user-token reuse
scope is identity_read only. Actual MES inspection adapters and board collection
sources remain disabled/unconnected. Existing inventory-token defaults were
not wired into a user-authorized QC operation.

Before any real trial, resolve the pilot account mapping, dedicated app credential
supply and scope, and actual MES launch page/button. Approve the exact runtime,
additive migration and deployment/activation plan before enabling it. The first
trial is one code exchange plus one same-token userinfo read, storage OFF, with
no MES/QC write or automatic retry. The app secret still needs explicit secure
provisioning approval even while user-token storage is OFF.

The minimum identity-only alternative is the already reviewed `65e327eb` runtime,
provided the target service still runs that SHA and has `mes_oauth.0001` applied.
It uses the existing backend Django login, start page and registered relay; it
discards the returned user credential after the identity read. That path needs
no new deployment, bridge, vault migration or inspection beta publication.
The continuity-only `c5289da` alternative adds `mes_oauth.0002` (four tables),
even with storage OFF. The integrated `69146dc` adds four migrations and nine
tables relative to `65e327eb`; it is not the minimum first-trial release.
Do not publish the full inspection beta before separately verified real MES
write behavior. Missing field-workflow decisions do not block the identity-only
read once its account, credential and launch requirements are resolved.

Persistent use additionally needs the official expiry semantics, managed vault
key, configured lifetime/retention values and cleanup operation. Inspection
creation cadence, assignee/reviewer permissions, defect approval and production
impact remain field-policy questions. MES scrap/rework/status-change candidates
are not yet verified disposition contracts. No local success above establishes
MES write permission, defect disposition execution or field acceptance.

Deployment order and rollback limits are in `mes-oauth-continuity-plan.md`:
additive schema, backend endpoint, then frontend; preserve replay/history tables.
The original `wj_reporting` checkout is not the candidate and was not modified.
