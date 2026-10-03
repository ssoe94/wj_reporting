# User authentication and production-flow acceptance

Updated 2026-10-03 against the local authentication and flow implementation. This
is a development and acceptance contract, not a deployment or live MES acceptance
record. Actual tenant identities, credentials, app configuration and observations
belong outside this public repository. Current local validation is recorded below;
it does not replace deployment or live authentication acceptance.

## Authentication boundary

The official [OAuth guide](https://v3-hw-openapi.blacklake.cn/document/api?docxHash=EP8bde9TnoyR9LxnEYwckBu4nAd)
describes an authorization code valid for five minutes and a registered, fixed SSO
callback with `?code=...`. A provider `state` echo is not documented in that
contract. Do not invent an authorize URL, assume arbitrary callback/query support,
or treat local browser correlation as proof that the provider echoes OAuth state.
The required user-token/user-information API access, exact application, actual
consent screen and requested permissions must be reviewed before a live grant or
persistent connection is created. No browser token extraction is part of this flow.

The local implementation now contains these direct backend routes:

| Route | Local behavior | Boundary |
| --- | --- | --- |
| `/integrations/blacklake/start/` | GET presents a preparation form. Same-origin CSRF-protected POST binds a random browser nonce to the existing backend login, server-selected expected MES identity and reviewed configuration. Older pending attempts for the actor are superseded. | Preparation does not issue a token or open new MES permissions. |
| `/integrations/blacklake/callback/` | GET prepares a confirmation form without an exchange. The code is held in browser memory and removed from the displayed URL. Same-origin CSRF-protected POST consumes the matching attempt before the provider call, exchanges the code, then checks user information with that exact user token. | Identity verification only; no WJ login creation, inspection dispatch, production action or receipt permission. |

The proposed registered callback is
`https://wj-reporting-backend.onrender.com/integrations/blacklake/callback/`.
Preparation included an HTTP 200 observation from the backend health endpoint;
the new callback has **not been deployed or registered by this work**. Backend
health is not evidence that either new route is live or that the provider accepts
the callback. Review the deployed route and exact HTTPS origin before registration.

`inspection_oauth_views.py` defaults to disabled through
`MES_USER_OAUTH_ENABLED=False`. An active permitted backend session, secure
session configuration, accepted account/profile state, exact reviewed origin and
server-owned expected-identity mapping are required. A frontend login or Bearer
header cannot replace this backend session or bypass CSRF. The browser nonce uses
a Secure, HttpOnly, SameSite=Lax host-only cookie. The durable attempt contains
digests for the nonce, session and reviewed policy; a unique `code_digest` rejects
reuse of a consumed authorization code, including after a new start. The local
attempt lifetime is five minutes and is separate from the user token's lifetime.

The additive attempt model/migration is local source only; applying it to the
live database is a separate release step. Neither raw authorization codes nor
user tokens are persisted. The explicit provider client has no app-token issuance,
automatic refresh, cache, fallback, redirect following or failure-triggered retry.
It requires an already configured app credential for the exchange and
user-information requests. The endpoint references specify an `access_token`
header; verify the app credential's effective authority on the target tenant
before activation. No live MES token issuance has been performed for this
implementation. If later activated and approved, a returned user token would
exist only temporarily in the callback request's memory, be used for the identity
lookup and be discarded rather than returned to the browser or write adapters.

Application responses use no-store/no-referrer controls; application middleware
and logging redact callback queries. These controls cannot remove a query already
captured by an upstream proxy or hosting ingress. Ingress log handling remains a
deployment gate. Missing, expired, superseded, already consumed or mismatched
attempts fail closed. A provider or identity failure consumes the attempt without
automatic retry. Provider correlation, callback/state provenance and safe handling
of interrupted requests still require deployment review; local tests do not
establish the provider's consent behavior.

`backend/quality/inspection_user_context.py` remains a pure validation component
used by the local callback. It requires a nonempty `data.userAccessToken`, successful HTTP/API
responses without a reported redirect, then one injected user-information lookup
with that exact token. Only an exact positive integer `data.userId` match returns
identity evidence. There is no app-token fallback. The helper itself cannot prove
the loader's provenance; the explicit callback client and its deployment must be
reviewed independently.

The [exchange contract](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1708927945926899&url=%2Fopenapi%2Fopen%2Fv1%2Faccess_token%2F_get_user_token)
describes `expire` in seconds but does not establish here whether it is relative
or epoch time. The helper deliberately reports `expiry_verified=False` and
`live_ready=False`; the callback also returns these false flags. The helper neither
assigns a fixed lifetime nor issues, refreshes, caches or dispatches a token.
The five-minute authorization-code or local-attempt lifetime must not be applied
to the user token. Identity verification does not grant claim, save,
finish or disposition authority. See [actor contract](inspection-mes-disposition-contract.md).

## Independent completion boundaries

| Operation | Official contract observed | Current integration limit |
| --- | --- | --- |
| Start production task | [POST `_start`](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1686645473258384&url=%2Fmfg%2Fopen%2Fv2%2Fproduce_task%2F_start): task ID or code, ID takes priority. | Local `ProductionExecution` state is not evidence that this MES call occurred. No connected production-task adapter. |
| Save / complete QC | Separate record and finish contracts; independent identity, executor and permission checks. | Stage adapter remains disabled. Local/mock success is not a tenant write. |
| Finish production task | [POST `_finish`](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1686645473258380&url=%2Fmfg%2Fopen%2Fv2%2Fproduce_task%2F_finish): required millisecond `operateTime`, optional `operatorId`, task ID or code. | No connected adapter or unresolved-QC completion gate. Proposed tests keep `forceFinish=false` and do not skip weak-control rules. |
| Finish work order | [POST `batch_finish`](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1686645473258369&url=%2Fmed%2Fopen%2Fv2%2Fwork_order%2Fbatch_finish): work-order IDs or codes. | Independent from task finish. Not implemented as a side effect of QC. |
| Close work order | [POST `batch_close`](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1686645473258368&url=%2Fmed%2Fopen%2Fv2%2Fwork_order%2Fbatch_close): IDs or codes; optional reason/type. | Close-type meaning and tenant side effects remain unverified. Excluded from the initial normal-path test. |
| Reverse close | [POST `batch_reverse_close`](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1761888015217818&url=%2Fmed%2Fopen%2Fv2%2Fwork_order%2Fbatch_reverse_close): ID list; optional return status/reason. | Its existence does not establish reversal of QC, quantities, dispositions or inventory effects. |
| Disposition / receipt | Separate approval, execution, quantity and inventory readback contracts required. | Open nonconformance is retained; `can_execute=False`. Receipt readiness remains unverified. |

## Minimum dedicated flow

Use a separate approved test tenant if available. Otherwise establish exact
test-only work-order, task, equipment, item, lot and QC identities, durable test
labels, authorized actors and downstream effects before any write. Do not reuse
an operating QC as a test fixture.

Proposed normal path: one work order and production task, planned quantity 10,
first inspection and one periodic inspection, proposed physical sample 1 each.
Production quantity, inspected quantity, sample return/scrap and inventory
quantity are independent fields. Current mock save/finish supports only
`quantity_mode=not_recorded`; a recorded-sample test needs a separately reviewed
provider mapping. Do not silently map the proposed physical sample to zero.

Sequence: identify test objects → start task → first QC claim/save/finish/readback
→ independently verify periodic-check timing → periodic QC/readback → check all
QC and disposition gates → finish production task/readback. Work-order finish,
close and stock receipt require separately stated acceptance and side effects.
Production operator, inspector, independent reviewer and disposition approver
must have verified roles; one authenticated identity does not imply all roles.

Use fresh fixtures for failure/retest, overdue or failed periodic QC, approval
pending/rejected, concession/rework/scrap, stop/resume, plan switch and interrupted
save/finish. Unknown writes require exact-target readback and preserved operation
identity before another write. Do not retry an uncertain mutation automatically.
Timer reset after stop/resume and unresolved-QC production completion policies
remain decisions to confirm, not implemented guarantees.

## Production completion and shared dashboard limits

The existing `ProductionExecutionUpsertView` records **local** production state.
It checks authentication/local plan edit access and records the server actor, but
does not verify a MES production actor or call the MES task-finish endpoint.
It currently has no gate for pending QC, draft reinspection or open nonconformance.
An explicit `completed` status is accepted even below the planned quantity. The
quantity used for automatic status calculation comes from the request payload,
not a reloaded plan quantity. These are limits to resolve before treating local
completion as an operational MES completion gate, not new execution guarantees.
Confirm partial-completion/exception policies and exact current task/QC/defect
relations before changing runtime behavior; matching part or equipment labels
alone does not establish those relations.

The injection board and production dashboard share the current-plan identity,
binding generation and freshness reduction. Only a fresh, complete, verified
read can contribute current failed/overdue attention. Plan changes and stale or
incomplete reads invalidate current conclusions; optional quality projection
failure does not hide production quantities. The runtime shared quality source
is still disconnected. Local QC fixtures are not automatically promoted into
live board evidence or a verified periodic schedule.

Dashboard disposition is `needs_verification` or `unlinked`; approval-pending and
action-overdue integration remain absent. The nonconformance record retains the
original failure, owner/evidence and known quantity, but it is not a completed
classification, proposal, approval, concession/rework/scrap execution or inventory
workflow. `can_execute=False` remains explicit. Production pause/resume suggestions
are disabled dry runs; automatic first-inspection regeneration and timer reset
after resume require tenant policy and provider support.

## Local evidence and remaining work

`quality.test_inspection_flow_scenarios` now has four tests:

| Scenario | Actual local path checked | What it does not establish |
| --- | --- | --- |
| QC completion boundary | Pass, fail and approval-pending mock terminal observations preserve local production rows and unresolved nonconformance. | Production task finish, disposition resolution or inventory readiness. |
| Failure → uncertain finish → reinspection | Save/finish timeout, read-only reconciliation, one explicit child and passing child completion preserve the failed parent, original defect evidence, operation history and duplicate protection. | Live reinspection creation or MES acceptance. |
| Local start → first/periodic QC → time check → local completion | Existing local production upsert, local QC workflow/stage mock, kanban, periodic reducer, pause/resume and actual local plan revision. Fixture provenance keeps current quality/due unknown; a separately simulated normalized read contract exercises scheduled→overdue, stale and changed-plan rejection. | A live collector, verified tenant timer policy, actual MES start/finish or automatic resumed-production QC generation. |
| Missing completion gate | Explicit local completion currently succeeds with an open defect case and draft reinspection; QC/operation/case rows remain unchanged. | Approval of that behavior for operational MES completion. This test characterizes the gap. |

The latest bounded flow-module run on 2026-10-03 passed **4 tests** in an isolated
SQLite memory database, with system checks passing and no quality migration
change at that run. Subtests are not counted as extra tests. The tests block
`requests.sessions.Session.request` and assert no calls; this is not a system-wide
network sandbox and does not prove every inventory row unchanged.

User-context and OAuth tests use synthetic responses/providers for identity,
session/CSRF/nonce, replay, error handling and token non-disclosure. Their local
success is not a live issuance, consent, user-information lookup or grant of MES
authority. Current 2026-10-03 local results:

- Isolated PostgreSQL: **310 passed**, including same-attempt and cross-attempt
  concurrent code consumption. The runner started and stopped only its own new
  fixture cluster; it did not inspect or stop another server.
- Isolated SQLite: **310 run, 300 passed, 10 PostgreSQL-only tests skipped**.
- Affected inspection/kanban/board frontend contracts: **41 passed**.
- Additive migration checks and system checks passed. No production migration.

Historical preparation evidence: an earlier isolated SQLite suite ran 283 tests
(275 passed, 8 PostgreSQL-only tests skipped), when the flow module had two tests
and the user-context module had eleven. That count predates the additional flow
and OAuth work; it is **not** the latest aggregate count or current CI evidence.
Deployment, actual user authentication, dedicated live QC
acceptance and the full production flow remain separate acceptance steps.

## Activation handoff

Review source and CI before an independently authorized release. Keep the OAuth
flag disabled while applying the additive migration and deploying the callback.
Verify direct backend HTTPS routing, Secure host-only session/CSRF behavior and
ingress query redaction before delivering any real code to that URL. The existing
frontend JWT login is not a backend Django session; use the backend login flow.

Then review the exact target application's `获取用户访问凭证` and `获取用户信息`
permissions, fixed redirect URL and custom-page/menu launch URL. The latter is
not guessed by this code: `MES_USER_OAUTH_LAUNCH_URL` must contain the reviewed
provider HTTPS page without a query or fragment. Keep the expected local-user to
MES-user mapping and existing app credential in authorized server configuration,
never in this repository or browser storage. App-permission/redirect changes and
user authorization remain separate from publishing this disabled implementation.
Inspect actual permission duration and user consent; the documented five-minute
code lifetime says nothing about app grants or the returned user token lifetime.
