# MES OAuth-only release plan

Prepared 2026-10-03. This document defines a bounded release candidate and its
approval gates. It is not evidence of deployment, a live database migration,
application permission changes, user consent, token exchange or MES acceptance.
Attach the exact local commit and recorded validation below to any approval request.
Remote validation is attached to the draft PR for the exact published head.
The local results below are retained separately; no release action is implied.

## Release identity and deployment boundary

| Item | Recorded release baseline / required decision |
| --- | --- |
| Current backend live commit | `9039735fc73443419ac392f9618e42d58207186e`, deployed `2026-09-30T09:07:23Z` in the release preparation record. Recheck immediately before an approved deployment. |
| OAuth-only candidate | The exact commit containing this document; obtain its full SHA with `git show -s --format=%H HEAD` and attach it to approval. Use the successful remote CI run for that exact published head when preparing approval. A branch name alone is insufficient. |
| Backend | Reviewed existing Render backend (service ID in private approval record), tracked branch `main`, automatic deployment off. Any approved deployment must select the reviewed candidate commit explicitly. |
| Frontend | Reviewed existing Render frontend (service ID in private approval record), tracked branch `main`, automatic deployment off. No frontend deployment is part of this release. |
| Other consumers of `main` | Three cron services have automatic deployment enabled on commit. A merge to `main` could affect them; it is outside the backend-only deployment approval. |
| Beta static site | Existing beta static site, branch `beta`, automatic deployment off. No beta deployment. |
| Preview / cost | Backend preview generation is off. No new paid service, database, preview environment or credential store is requested. |

The proposed action is an explicitly approved deployment of one pinned commit to
the existing backend only. Do not substitute a merge to `main`, a repository-wide
deployment, or a frontend/cron release. Preserve existing branch and auto-deploy
settings. These recorded service settings are a release planning snapshot, not a
guarantee that they cannot change before approval.

## Source and database scope

The candidate isolates identity verification in the Django app `mes_oauth`.
Its two new direct backend routes are:

- `/integrations/blacklake/start/`
- `/integrations/blacklake/callback/`

The existing application routes, frontend JWT login, MES collectors, production
operations and quality workflows retain their existing behavior. The source
review must confirm this against the baseline, including the narrowly scoped
CSRF and callback-log handling in `backend/config/`. This release does not connect
an inspection adapter or a QC eligibility read to the callback.

`mes_oauth.0001` is an independent additive migration for one `OAuthAttempt`
model/table (`mes_oauth_oauthattempt`). It must not depend on the unreleased quality
migrations from PR #87. The intended metadata is:

| Metadata | Purpose / storage boundary |
| --- | --- |
| `nonce_digest` | Primary-key digest of the random browser nonce; no raw nonce in the table. |
| `actor_id` | Indexed positive bigint identifying the existing local actor; deliberately no user foreign key. |
| `session_digest`, `policy_digest` | Bind the attempt to the backend session and reviewed configuration. |
| `code_digest` | Nullable unique digest for consumed-code replay rejection. Never the authorization code. |
| `expected_user_id` | Server-selected expected MES identity; no browser-selected identity. |
| `status`, `error_code` | Bounded attempt state and safe diagnostic code. |
| `created_at`, `expires_at`, `consumed_at`, `verified_at` | Attempt lifecycle timestamps; no token-expiry claim. |

The absence of a foreign key is intentional: rolling code back to the previous
app must not make ordinary legacy user deletion fail, and deleting a user must
not cascade-delete consumed-code replay records. Runtime access still requires
the current authenticated, eligible account; a retained numeric actor ID does
not grant access. No raw authorization code, app-token value or user-token value
is stored in this table, a Django session, browser storage or application logs.

The currently configured backend start command runs **all** pending migrations
before Gunicorn. Although this diff adds one table only, confirm the live
migration ledger and approved plan contain no unrelated pending operations.
Review the generated migration and database plan before execution. A production
database backup and the forward migration are separately approved operations;
neither is recorded as completed here. Schema creation and a successful code
deployment do not activate OAuth.

## Disabled deployment and existing login

Keep `MES_USER_OAUTH_ENABLED=False` through publication, migration, deployment
and verification of the disabled routes. Activation requires a later explicit
approval after the gates below are satisfied.

Use the existing backend admin login in the same browser. Admin login requires
the existing account to be active and `is_staff`; the OAuth endpoint also checks
`is_staff`, `is_superuser`, an accepted profile, and no temporary
password or required-password-reset restriction. Do not grant a role, set
`is_staff`, create an account, or connect the frontend JWT session as a shortcut.
The flow rejects Bearer authorization as a replacement for its backend session.

The session and nonce must use secure host-only cookies, with the session
HttpOnly and `SameSite=Lax`. Only `Lax` is accepted by this flow: do not change it
to `None` to accommodate an embedded launch or to `Strict` and assume the return
will preserve the session. Use a top-level HTTPS navigation that returns to the
same browser's backend session. An iframe launch is not an accepted flow. A
different browser/profile is not the same session.

The eligibility check never changes an account role. Start GET presents a form. Its same-origin, CSRF-protected POST prepares a
short-lived attempt; it does not exchange a code. Callback GET presents a
confirmation form, keeps the code in browser memory and removes it from the
displayed URL. Only the same-origin, CSRF-protected callback POST consumes an
attempt and may contact the provider. Failed, expired, superseded, consumed or
mismatched attempts must fail closed.

## Provider configuration and unresolved facts

The exact target application identifier belongs in the private approval record.
Review that application and its actual tenant before changing anything; do not
substitute a similarly named app or publish tenant configuration in this repository. The proposed exact registered callback is:

`https://wj-reporting-backend.onrender.com/integrations/blacklake/callback/`

The required API capabilities are [获取用户访问凭证](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1708927945926899&url=%2Fopenapi%2Fopen%2Fv1%2Faccess_token%2F_get_user_token)
and [获取用户信息](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1708930376017421&url=%2Fopenapi%2Fopen%2Fv1%2Faccess_token%2F_get_user_info).
`1708927945926899` and `1708930376017421` are **documentation IDs, not permission
IDs**. Do not send them to a permission-management API as grant identifiers.

The [OAuth guide](https://v3-hw-openapi.blacklake.cn/document/api?docxHash=EP8bde9TnoyR9LxnEYwckBu4nAd)
describes a fixed callback with `code` and a five-minute authorization-code
lifetime. Five minutes is not the app-grant duration or the user-token lifetime.
The exchange's `expire` interpretation and a safe freshness duration still need
an independently reviewed contract; `expiry_verified=False` remains explicit.

The actual grant duration, consent permissions, custom-page/menu launch URL and
availability/validity of an existing app access token remain unverified. Do not
invent an authorization URL, query parameters, scope or consent behavior. The
reviewed launch page must use the approved provider HTTPS origin without an
unreviewed query or fragment.

If separately approved, configure the existing app access token only as a secret
on this backend service, under `MES_USER_OAUTH_APP_ACCESS_TOKEN`; do not use a
shared environment group, copy it into a document/browser, or expose it to the
frontend. No new app-key/app-secret issuance, app-token minting, automatic refresh,
fallback or retry is part of this release. If the existing credential is missing,
expired or rejected, stop and report that condition. Do not rotate `SECRET_KEY`:
it also protects existing sessions and the consumed-code digest boundary.

Provider `state` echo and callback provenance have not been verified. The local
nonce/session binding and exact returned user-ID match are useful checks but do
not establish provider state correlation. The result is **identity verification
only**: it cannot create a WJ login, link an account persistently, or establish
claim, save, finish, disposition, production or inventory authority. The callback
continues to return `live_ready=False`.

## Logging gate before any real authorization code

Application query redaction, no-store/no-referrer responses, sensitive-variable
handling and safe errors protect only their own layers. Verify Render ingress,
reverse-proxy/access logs, application request logs and connected error reporting
before any real code is sent to the callback. An upstream capture cannot be
removed by later application redaction.

Use a non-secret synthetic marker to verify the deployed callback's query handling
while OAuth is disabled. Record which log layers were checked and what evidence
shows query exclusion/redaction. Do not use a real code to test redaction. If an
upstream layer cannot be inspected or its handling remains unknown, activation
is blocked; do not claim the application middleware proves ingress safety.

## Future two-QC read: design only, excluded from this release

A later approved implementation may extend one callback POST with a bounded
identity-and-eligibility observation. It must preserve these boundaries:

1. Reserve/consume one approved attempt before exchanging its code exactly once.
   Validate the user-token response, then query user information using that exact
   returned `userAccessToken`; require the exact server-selected expected user.
2. Select exactly two approved QC IDs on the server. Do not accept QC/user IDs,
   endpoint URLs, origins or a token from the frontend. Use the **same returned
   user token** for both fixed task-detail reads within this POST's memory.
3. Do not persist or cache the token, put it in a session, pass it to the frontend,
   store it in the attempt table, or forward it to any write adapter. Do not fall
   back to an app token, refresh automatically, retry a failed read, or repeat the
   code exchange. No claim, save, finish or production request is permitted.
4. A failed first read stops the remaining reads. A later failure may leave a
   partial observation, but the consumed attempt stays consumed. Timeout,
   disconnection or ambiguous completion does not authorize automatic replay.
   Any later attempt needs a separately approved new flow; it must not reset or
   bypass the earlier attempt's replay record.
5. Return only a redacted eligibility summary, per-read outcome, provenance and
   observation timestamps. Use approved target labels rather than raw QC IDs;
   omit real QC details, measurements, names, raw provider messages and tokens.
   Mark missing/partial observations explicitly and keep write readiness false.

Before implementing or activating this extension, confirm the exact detail
endpoint's support for user tokens, token placement and effective scope, identity
binding, expiry semantics, allowable freshness duration, permitted summary fields
and the two targets' approved scope. Existing app-token detail observations do
not establish those facts. Matching identity and `getAble=1` still do not prove
executor authority, claim delegation or save/finish permission. This document
does not implement a live adapter or claim the two-QC flow is ready.

## Rollback and future integration

First disable `MES_USER_OAUTH_ENABLED`. Reverting the backend to the recorded
previous code commit is a separately approved code rollback. Keep the one
additive table and its attempt/code digests; reverse migration or deleting rows
is not the default rollback. Preserve the existing `SECRET_KEY` and replay
records. Do not reset `processing` attempts or allow forward reactivation to
resume/exchange them: an interrupted provider call may already have consumed the
code. Reconcile safe metadata without repeating the provider operation.

Code rollback or flag-off does not revoke a provider grant, remove a registered
callback, or undo consent. Any external app permission/redirect revocation is a
distinct action with its own reviewed scope. A schema backup also does not
establish reversal of an external grant.

### Relationship to PR #87 and integration order

[PR #87](https://github.com/ssoe94/wj_reporting/pull/87) contains the inspection
workflow, production projections and a previous OAuth implementation. This
independent OAuth PR contains only the disabled identity-verification preparation
and its validation. Publishing either draft does not authorize merging or
releasing either one. PR #87 is preserved unchanged during this preparation.

The intended **code integration order** is this OAuth-only change first, then a
rebased and reviewed PR #87 that reuses it. This does not mean merging to `main`
now: existing main workflows and cron auto-deploy would expand the release.
If a backend-only preparation deployment is separately approved before a main
merge, pin the reviewed OAuth commit; later source integration must preserve
that same implementation and ledger.

Before PR #87 can be merged or deployed:

1. Rebase/integrate it onto the accepted OAuth-only code, leaving one
   `mes_oauth` app, one authoritative `mes_oauth_oauthattempt` ledger and one
   start/callback URL registration. Reuse the same cookie and digest namespace.
   Remove duplicate quality OAuth view/client/model/security/URL wiring and adapt
   its tests and runner to the shared app. Preserve unrelated inspection changes.
2. Check the **actual migration ledger** of every durable target. If quality
   `0013_inspection_oauth_attempt` has never been applied there, remove that
   unreleased duplicate migration from PR #87 before integration. Keep inspection
   migrations 0010–0012 and reuse `mes_oauth.0001_initial`; do not create a second
   OAuth table. This check has not been performed on production databases.
3. If quality 0013 has already been applied to any durable target, stop this
   shortcut. Do not delete/rewrite an applied migration or blindly copy digests.
   Review a forward reconciliation plan first, including the previous
   `inspection-oauth-code` versus `mes-oauth-code` HMAC namespaces, retained
   consumed/processing attempts, identity bindings and cross-ledger replay
   rejection. Raw codes do not exist to recompute their digests. That exceptional
   migration is not part of this PR or its one-table deployment approval.
4. Re-run full CI, PostgreSQL concurrency/replay tests, the combined migration
   upgrade/old-code compatibility tests, and URL-resolution checks. The combined
   app must have no duplicate callback route or second OAuth model/table. Apply
   the inspection/MES acceptance and separate deployment gates before releasing
   the larger beta.

### Narrow preparation-deployment approval

After publishing and checking the exact candidate, the first approval request
must cover **only** one pinned backend deployment with OAuth kept OFF, the
verified one-table migration plan and backend restart. Record the existing live
commit, backup/recovery evidence, affected service and rollback owner. The start
command runs all pending migrations, so unexpected entries block execution.

Do not bundle unresolved app grants, grant duration, consent scope, redirect
registration, token/secret configuration, OAuth activation or a real user flow
into that preparation approval. Main merge, frontend/cron/beta release, paid
resources and QC/production/disposition/inventory writes are excluded. Those
remaining provider decisions require their own concrete scope after inspection.

The identity callback is implemented and covered by synthetic tests; a live user
identity verification has **not** occurred. The two-QC same-request read remains
**design only** in the preceding section: no detail-read adapter is connected,
no user token is retained, and no inventory or production write is included.

## Local validation on 2026-10-03

The focused, no-project-settings runner uses synthetic data and blocks Python
HTTP/DNS/socket egress. PostgreSQL uses an explicit private UNIX-socket fixture,
with no inherited database credentials. These are local results, not remote CI
or provider acceptance:

| Check | Observed result |
| --- | --- |
| `scripts/check-mes-oauth.py` | 46 run: 44 passed, 2 PostgreSQL concurrency tests skipped. |
| `scripts/check-mes-oauth-postgres-local.py` | All 46 passed, including concurrent same-attempt and cross-attempt code reuse. Only its own newly created fixture cluster was started and stopped. |
| Existing archive/JWT and account-restriction regression | 15 passed (archive service, missing profile, first password change, account status and token revocation). |
| `scripts/test_mes_oauth_postgres_local.py` | 19 passed; path, credentials, fixture ownership, failure and cleanup behavior tested with subprocess mocks. |
| Schema checks | No model/migration drift; Django system checks passed. One new table; historical user/report/plan rows preserved. |
| Rollback compatibility | Historical ORM reads/edits/account deletion work while the new table and unique replay digest remain. This is not an actual previous-server restart or production rollback. |

Do not add overlapping SQLite/PostgreSQL counts as separate coverage. Logs and
operational identifiers are retained in the private task record. No frontend,
MES-network, production-database or actual-browser acceptance was run. Two
independent source reviews found no blocking issue in this identity-only scope.

In particular, source settings do not establish the live reverse proxy's HTTPS
scheme handling. Verify that Django sees the direct backend request as secure
before any real code is delivered; this candidate rejects insecure requests.
Do not blindly trust forwarded headers or weaken this guard to make a flow pass.

## Approval checklist and evidence to attach

- [ ] Fill in the exact candidate commit SHA, base SHA and CI run for that commit.
  Attach the reviewed diff, local results above and the separately obtained
  remote CI result; local evidence does not stand in for remote CI.
- [ ] Confirm one independent additive `mes_oauth.0001` table, its fields/indexes,
  no user FK, no raw secrets, no quality migration dependency, and unchanged
  existing routes/behavior in the candidate source.
- [ ] Approve the production database backup and forward one-table migration;
  record backup verification, migration plan/result and rollback owner.
- [ ] Reconfirm Render service IDs, live base commit and auto-deploy settings.
  Approve only the pinned backend deployment with OAuth disabled. Exclude main
  merge, cron/frontend/beta deployment, paid environments and unrelated settings.
- [ ] After deployment, verify the exact disabled callback/start routes, existing
  backend login behavior, secure host-only Lax cookies, same-browser top-level
  return and ingress/application query redaction using synthetic data.
- [ ] Separately review and approve the exact app's grants, consent scope/duration,
  launch URL, fixed callback and valid existing backend-only app credential.
  Resolve token expiry/scope and provider correlation limits before any real flow.
- [ ] Separately approve activation and one identity-only user flow. Record only
  safe result metadata. Do not infer QC read/write permission from success.

All unchecked items remain release/activation prerequisites. Code publication,
database application, backend deployment, app configuration, user consent and
live identity verification must be reported as separate outcomes.
