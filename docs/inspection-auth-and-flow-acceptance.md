# User authentication and production-flow acceptance

Updated 2026-10-04 for the combined local authentication and inspection candidate. This
is a development and acceptance contract, not a deployment or live MES acceptance
record. Actual tenant identities, credentials, app configuration and observations
belong outside this public repository. Current local validation is recorded below;
it does not replace deployment or live authentication acceptance.

## Authentication boundary

The integrated candidate uses `backend/mes_oauth/` from the OAuth relay and
continuity branch. The earlier `quality.inspection_oauth_*` implementation and
quality migration `0013_inspection_oauth_attempt` are excluded. There is one
OAuth callback and one `mes_oauth.OAuthAttempt` replay ledger.

The direct backend `/integrations/blacklake/start/` and callback routes remain
session-bound, CSRF-protected and disabled by default. The reviewed static relay
removes the provider code from its query and returns it in a fragment; callback
GET does not exchange it. See [relay hardening](mes-oauth-relay-hardening.md) for
the exact return and logging boundary, and [OAuth release scope](mes-oauth-only-release.md)
for the historical OAuth-only release. This combined candidate adds the
inspection beta and therefore needs its own broader release review.

The callback requires the existing active staff-superuser backend session and
server-owned expected MES identity. Frontend JWT login cannot replace the
backend session. Neither identity verification nor a local superuser role grants
MES claim, save, finish, disposition, production or inventory authority. No role
is broadened by integrating the inspection beta.

`mes_oauth.identity.verify_user_context` verifies the exchange response and checks
`data.userId` with that exact returned user token. The callback then drops its
context reference; it does not retain a token or dispatch a QC operation.
`mes_oauth.continuity` contains metadata decisions only, remains disabled and
models only `identity_read`. It supplies neither a credential vault nor a QC
adapter. [Continuity prerequisites](mes-oauth-continuity-plan.md) still apply.

No inventory/app-token fallback, automatic refresh, silent reissue or uncertain
mutation replay is enabled by this integration. Five-minute authorization-code
or local-attempt limits do not establish user-token lifetime. Provider expiry,
per-operation authority, scope, revocation and current executor remain separate
verification requirements. Runtime inspection adapters remain disabled.

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

The imported branch recorded a bounded flow-module run on 2026-10-03 with **4 tests** passing in an isolated
SQLite memory database, with system checks passing and no quality migration
change at that run. Subtests are not counted as extra tests. The tests block
`requests.sessions.Session.request` and assert no calls; this is not a system-wide
network sandbox and does not prove every inventory row unchanged.

The OAuth and continuity tests now belong to `mes_oauth`. Historical aggregate
counts from the earlier quality-owned OAuth implementation do not validate this
combined source state. [Integration evidence](mes-workflow-integration.md) records
the exact imported commits, excluded paths and checks for this candidate.
Deployment, actual user authentication, dedicated live QC acceptance and the
full production flow remain separate acceptance steps.

## Activation handoff

Keep OAuth and every live inspection adapter disabled while reviewing this
combined source. The independent OAuth ledger, inspection tables, static relay,
existing login restrictions and callback redaction must survive integration.
Applying inspection migrations to production is not authorized by a prior
OAuth-only release. In particular, the new inspection user foreign keys impose
additional old-code account-deletion rollback limits.

Follow the current [relay hardening](mes-oauth-relay-hardening.md) and
[continuity plan](mes-oauth-continuity-plan.md), then verify designated test-only
QC targets, server-owned actors/items, permanent labels and physical side effects
before proposing live inspection activation. Resolve first/periodic generation,
operator/reviewer roles, defect disposition and production-impact policies rather
than inferring them from passing fixtures. No deployment or provider operation
has been performed by this integration.
