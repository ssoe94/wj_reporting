# Single-inspection connection and acceptance

2026-10-06 local update: the server preparation command and exact, expiring
single-actor test exception now exist; see the [current checkpoint](mes-oauth-continuity-plan.md#current-checkpoint--2026-10-06).
The normal independent-review rule below remains in place outside that explicit
test contract. App-token supply failures no longer erase a valid user credential.

Local development on 2026-10-04. This extends the saved shared-PC checkpoint;
it is not evidence of deployment, a real MES login, or a real QC write. The four
inactive account preparations remain paused. The immediate target is one
existing WJ actor, its verified MES identity, and one explicitly designated QC.

## Connected runtime path

`InspectionSession` checks the signed WJ login and reserves the operation.
`LiveInspectionStageAdapter` then uses the inspection credential broker to
decrypt the server-held credential, verify the same token with userinfo, and
perform one scoped operation. No inspection request supplies a token or actor.
The broker holds the user/login/credential locks, checks policy and permission
again after external I/O, and never exchanges, refreshes or falls back to an
application token. A new WJ login family needs its own MES connection.

Save and finish remain separate clicks:

1. Read the exact current detail; verify identity, executor, snapshot, permanent
   test label, explicit source checks and the reviewed pre-existing records.
2. Send the reviewed item record once. Read again and compare every saved value.
   Acknowledgement alone cannot enable finish.
3. On the separate finish action, read and compare the saved values again, then
   send the exact reviewed QC conclusion once using the verified user token.
4. Read again. The observed lifecycle and verdict must match. An approval-pending
   result remains distinct from completed approval, inventory and production.

An authentication failure proved to precede a write preserves the ready/saved
phase and returns `mes_connection_required`. WJ offers reconnection, preserves
the draft and version, and requires another explicit click. Any failure after
writer entry, including a local transaction-exit failure, remains unknown and
requires read-only reconciliation. Neither path automatically repeats a write.
This also covers an explicit authentication rejection from the initial detail
read after userinfo succeeds; a post-write detail rejection remains unknown.

The HTTP boundary uses an access-token header, no credential-bearing URL, no
environment proxy/netrc authentication, bounded response streams, and no retry.
Source values and exception text do not enter public errors.

## Review configuration, not browser configuration

`MES_INSPECTION_ENABLED` defaults to false. `MES_INSPECTION_CONTRACT` is one
bounded JSON contract, with no default target or status-code guesses. It binds:

- An exact WJ actor, mapped MES actor, tenant, provider origin, local request,
  QC and work order, plus an immutable binding/result digest.
- Operational and authority review references and an expiry no more than one
  hour ahead. Department, role and claim eligibility do not grant write rights.
  MES enforces the actual user's authority on each operation; no undocumented
  pre-write permission flag is fabricated.
- The observed baseline-record digest and explicit detail lifecycle/verdict
  codes, inspection type, `executor.id`, permanent `remark`, and source checks.
- Optionally, a separately reviewed current local-plan relation: business date,
  machine number, plan ID/version, generation, bounded validity and freshness.

The decoder accepts only the exact reviewed config/item/sample population. This
first path supports text result records without required quantity or attachment
submission. It rejects required sample/summary counts, inventory-status updates
and sample scrapping. Unsupported source encodings must be resolved explicitly;
they are not silently normalized or dropped. Historical completed QCs cannot be
written. Binding creation remains a reviewed server operation, never a GET or
browser-submitted mapping.

## WJ connection and reauthentication UX

The server can supply `MES_USER_OAUTH_LOGIN_FACTORY_NUMBER` and
`MES_USER_OAUTH_LOGIN_HINTS`, a mapping of WJ ID to `{mes_user_id, account_name}`.
Only the current actor's exact numeric mapping is exposed as a display/copy
hint. A hint is not authentication and cannot change the expected MES identity.
Actual organization and account values remain outside this public source.

WJ prepares the existing one-use, top-level launch and keeps the inspection tab
and draft. Password entry occurs only on the official MES screen. On return,
WJ rereads server connection status; opening a window is not connection success.
Cancellation, expiration, copied-text failure and account changes have explicit
recovery. Native popup blocking is explained without claiming that a form can
reliably detect every browser permission decision.

No official factory/account prefill parameter was found in the reviewed public
documents. This is unconfirmed support, not proof of non-support. The implemented
fallback is display/copy plus the reviewed official launch, without a guessed
query parameter, internal password API, WJ password form or password relay.

The official [token schema](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1708935281595630.md)
describes integer `expire` in seconds but does not distinguish TTL from epoch in
the inspected text. A fixed lifetime, refresh grant and automatic renewal were
not established. The existing reviewed expiry policy therefore remains required;
userinfo success never extends absolute token lifetime. See also the official
[userinfo schema](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1708935281595627.md).

## Board and dashboard evidence

Only a successfully reconciled stage can atomically publish `verified_stage`
metadata into the existing request snapshot. No new table is required. The DB
repository matches the exact captured local-plan scope, MES binding, digest,
timestamp, phase and request state. Public requests never authenticate to MES.
Plan changes, unknown writes, stale or conflicting evidence cannot appear as a
current verified result. Public projection excludes actors, QC IDs and values.

Both existing board and dashboard consume this same projection. One QC appears
as an individual check; it never establishes complete coverage of every required
inspection. Whole-plan completeness remains false, and no overdue schedule is
invented. Approval-pending remains in progress. Graphical redesign is separate.

## Actual acceptance still required

Before enabling this path, verify the dedicated application credential, actual
saved OAuth entry, provider expiry interpretation, exact WJ/MES mapping, current
test-only QC and executor, independent local review, source enums, read/write
item mapping, permanent label, baseline values and completion effects. The
current production-plan relation is an additional condition for board acceptance.
Then verify the deployed commit and perform the approved save/read/finish/read
sequence once. Local synthetic and browser checks do not replace that evidence.

No ordinary production task completion, receipt, scrap, rework or concession is
part of this path. No actual credential, account activation, MES QC write or
production setting was changed during this local implementation.

## Local verification record

| Check | Result | Private local evidence |
| --- | --- | --- |
| Full-route PostgreSQL integration, 25 labels | 684 passed, zero skipped; completed 2026-10-04 14:30:01 UTC | `output/pg-in4/test.log` |
| All frontend Node contracts, 47 files | 393 passed, zero skipped | `output/frontend-live-path-node-final-20261004.log` |
| TypeScript, Vite, legacy assets and targeted lint | Passed | `output/mes-stage-reconnect-final-build-20261004.log` |
| React/Chrome connection and stage recovery | 10 synthetic scenarios, 91 checks; final build | `output/mes-reconnect-hints-final-20261004.json`, `output/inspection-stage-reconnect-final-20261004.json` |
| Real built React with real isolated Django routes | 2 synthetic scenarios, 24 browser checks, plus 2 screenshot checks; 2026-10-04 14:29:31 UTC | `output/inspection-live-browser-auth-summary-final.json` |

The last fixture uses a real WJ login, request card, stage APIs, credential broker,
decoder, database publication and public projection. It verifies save, separate
finish, the individual completed board check, and recovery after an uncertain
save with no repeated write. MES HTTP is replaced by fabricated responses and
the initial MES credential is attached through an explicit test seam. It does
not test an actual provider login, production TLS, ingress logging or live MES.
No complete coverage of a plan is claimed. These suites are not added together
as a unique-test count. Only test-owned browsers and databases are used.
