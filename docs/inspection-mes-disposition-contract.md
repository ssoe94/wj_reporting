# QC completion and nonconformance integration boundary

Status: local synthetic contracts; production adapters remain disabled. No production write or disposition acceptance is established.

## Independent operations

`mes-save` saves reviewed measurement values and requires a fresh, exact target/value/source-label readback. `mes-finish` is a separate user action for **QC inspection completion**, with another pre-read and terminal readback. Neither operation means production work-order completion, stopping production, goods receipt, or disposition closure. A durable operation reservation blocks overlapping writes. Unknown outcomes require read-only reconciliation; interrupted pending writers remain blocked pending an explicit recovery protocol.

Server-owned bindings require independent review, a designated test-only target, exact read/write item mappings, permanent test-label evidence and side-effect review. Browser-supplied bindings are not accepted. Required attachments and recorded quantity submission are blocked until provider-specific mappings exist. The application-stage adapter is deliberately disabled and is not a completed Blacklake provider integration.

A failed local submission creates a separate persistent nonconformance with source-result digest, recorded rejected quantity (otherwise unknown), owner and evidence. Independent review confirms the failed result without converting its judgement to pass. QC completion leaves the nonconformance open. Defect classification, cause, disposition proposal, approvals and inventory execution are not yet editable/integrated workflows; the present record is the foundation, not a completed disposition feature.

## Official API candidates reviewed

Official Blacklake documentation was inspected through the public documentation UI on 2026-10-03. These are candidates, not proof of availability or authority in the production tenant.

| Purpose | Documented contract | Remaining validation |
| --- | --- | --- |
| Scrap | [Production scrap](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1690596403836067&url=%2Fmfg%2Fopen%2Fv1%2Fscrap%2F_do_scrap), POST `/mfg/open/v1/scrap/_do_scrap`; required `qrCode`, `scrapUserIdList`, `taskId`; optional pictures, reasons and remark. | Exact barcode/task/actor mapping, quantity and partial-scrap semantics, approval path, stock effects, safe retries and readback. |
| Rework | [Production rework](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1690596403836073&url=%2Fmfg%2Fopen%2Fv1%2Frework%2F_do_rework), POST `/mfg/open/v1/rework/_do_rework`; required `qrCode`, `reworkUserIdList`, `taskId`. | Exact target and permitted actors, rework routing, quantity, approvals, inventory effects and readback. |
| Concession candidate | [Inventory QC status adjustment](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1681109889047066&url=%2Fquality%2Fopen%2Fv1%2Fqc_material%2F_change_qc_status), POST `/quality/open/v1/qc_material/_change_qc_status`; material and versioned inventory identities, destination QC status including concession-qualified. | This changes inventory quality status; it does not establish concession approval. Verify a supported approval workflow before any execution. Never treat a QC verdict code as disposition authorization. |

No actual API call, login, credential access, production MES write, scrap or rework was performed for this review. Historical completed QCs are not test targets.

## Shared board/dashboard read model

The injection board and operations dashboard use the same current-plan identity, generation and freshness reduction. Unknown, stale, incomplete or failed reads cannot produce current failure/overdue counts. The dashboard counts verified machines and shows coverage; disposition approvals/delays remain explicitly unlinked. Optional quality query failure leaves production quantities visible. Exact QC/disposition history links must wait for verified relations.

## Before live activation

1. Establish exact designated test-only QC and current production-plan relation, permitted actor, write/read item IDs and permanent source test-label path.
2. Confirm save/completion/disposition effects on approvals, inventory and production. Verify attachments and quantity mappings separately.
3. Implement and validate the live provider and readback using the approved target; maintain independent save and completion actions.
4. Build disposition proposals, independently authorized approvals, versioned partial-quantity execution, durable reconciliation, and confirmed MES disposition/inventory readback before enabling physical actions.
5. Review additive migrations, public-data exclusions, CI and both development streams before any merge or deployment.

## Review fixes (2026-10-03)

Every MES stage, including read-only reconciliation, holds a durable operation
reservation across provider I/O. A different idempotency key cannot start another
stage while that reservation is pending. Unknown writes require reconciliation;
a stale response cannot restore its original phase over a newer reservation.
Interrupted pending operations still require an explicit recovery procedure.

Terminal readback must include the provider-normalized `inspectionResult` (`pass`
or `fail`) observed from the external QC and matching the independently reviewed
local judgement. Missing, conflicting, concession or pending verdicts cannot
confirm completion. The observed lifecycle and verdict enter the evidence digest;
`approval_pending` remains distinct from completed approval and inventory rights.
This field is an application adapter contract, not a verified raw Blacklake mapping.

Independently reviewed failures can create one explicit reinspection child after
external operations settle. Parent failure, nonconformance and audit history stay
intact; creating or completing the child does not close disposition. Permissions,
reason, version checks and duplicate-child protection remain mandatory.

## Read-only preflight and documented completion effects

The public [task detail contract](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1681109889047070&url=%2Fquality%2Fopen%2Fv1%2Ftask%2F_detail)
was inspected on 2026-10-03 (document update: 2026-04-27). Its `data.qcConfig`
contains these enum objects with integer `code` and text `message`:

| Field | Documented codes | Preflight implication |
| --- | --- | --- |
| `materialBatchRecordType` | 1: do not record; 2: record only; 3: record and update quality status | Completion may change inventory quality status. A displayed empty inventory relation does not prove that it cannot. |
| `sampleProcessMethod` | 1: return sample; 2: scrap sample | Sample disposition must be reviewed independently. |
| `recordSample` | 1: required; 2: not required | No sample-record requirement does not establish a safe sample-disposition default. |
| `recordSummaryCount` | 1: required; 2: not required | Quantity requirements remain distinct from disposition and inventory effects. |

The [finish contract](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1734575507154323&url=%2Fquality%2Fopen%2Fv1%2Ftask%2F_finish)
accepts `id` and verdict `status` (1: pass, 2: concession, 3: pending, 4: fail).
Its acknowledgement does not prove the resulting lifecycle, approval outcome,
inventory effects or actor authority. Those require independently scoped evidence.

The [task edit contract](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1681109889047074&url=%2Fquality%2Fopen%2Fv1%2Ftask%2F_update)
documents `remark` and custom fields, alongside conclusion, claim, task-status and
quantity fields. Detail also documents a top-level task `remark`. This is a
candidate permanent test-label path only: tenant permissions, retention, exact
readback and partial-update semantics remain unverified. The current write plan
does not support editing a source label. Do not use a broad task update to relabel
an ordinary production or completed QC as a test target.

`inspection_preflight.assess_detail_preflight` is a pure observer for one
sanitized or synthetic detail fixture, preserving the existing decoder's
provenance limit. It does not accept a raw live response as fixture evidence.
It requires explicit reviewed paths, enum allowlists,
target relations and observation freshness. Missing or conflicting configuration,
identity, lifecycle or source label blocks the detail contract. It returns status
codes, never raw IDs, measurements, label contents or response fields. Actor and
approval authority, tenant identity and production/inventory effects remain
unverified; `can_save` and `can_finish` are always false, even for a matching
synthetic contract. No transport, token loading, persistence or runtime route is
introduced. Its synthetic tests are not evidence of live tenant acceptance.

For an authorized eligibility comparison, bind the transport to one reviewed QC
and `eligibility_user_id`. The detail client accepts that same optional user ID,
encoded as the documented `receiveUserId`. The transport permits only that task's
detail route and either omission or the bound user; it rejects other users,
routes, extra fields and write authorization. The official contract describes
omission as the current logged-in actor, but it does not prove that actor's
identity. An explicit subject and `getAble=1` do not authenticate as that user or
grant claim, save, finish or inventory rights. The production adapter stays disabled.

### Token identity and stage actors: official contract review, 2026-10-03

The public [integration guide, section 5.2.3](https://v3-hw-openapi.blacklake.cn/document/api?docxHash=PNNwdvq1LoMFFrxAEN5cLDFWngd)
distinguishes an application credential from a user credential: use
`userAccessToken` in place of `appAccessToken` to execute/access data as that user.
The [OAuth guide](https://v3-hw-openapi.blacklake.cn/document/api?docxHash=BTMdd3eOio9zEzxWYFNctJzHnzd)
describes an authorization-code exchange followed by user-information lookup.
This documentation is not evidence that the deployed application has that flow
configured or that a particular user has authorized it.

| Stage | Documented request and actor limit |
| --- | --- |
| Detail | `id` and optional integer `receiveUserId`; omission defaults to the current logged-in person. `getAble` describes current-user claim eligibility (0/1). The field description does not establish how an app token resolves that current user, whether an explicit ID controls every eligibility check, or any delegation rule. |
| [Claim](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1681109889047071&url=%2Fquality%2Fopen%2Fv1%2Ftask%2F_get_task) | `id` and optional integer `receiveUserId`, with the same current-user default. The published schema does not establish who may claim on behalf of another person. Claim is a mutation and is not implemented by the read transport. |
| [Record](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1681109889047075&url=%2Fquality%2Fopen%2Fv1%2Ftask%2F_update_task_check_item) | Required `taskId`, optional `checkItems`; no actor/receiver parameter appears in the inspected request schema. Authentication, current executor and save permission need independent evidence. |
| Finish | `id` and verdict `status`; no actor/receiver parameter appears in the request schema. The verdict field is distinct from detail's lifecycle status. Completion authority cannot be copied from claim eligibility. |

The [user-information contract](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1708930376017421&url=%2Fopenapi%2Fopen%2Fv1%2Faccess_token%2F_get_user_info)
requires a `userAccessToken` body field and documents `data.userId`.
The [user-token contract](https://v3-hw-openapi.blacklake.cn/document/api?detailId=1708927945926899&url=%2Fopenapi%2Fopen%2Fv1%2Faccess_token%2F_get_user_token)
requires an authorization `code`. Do not substitute an application token or a
browser display name for verified user identity. Do not extract browser tokens.
Any future user-context comparison must verify `data.userId` and then use that
same user token for both detail reads. Missing/mismatched identity or a missing
user token must stop the comparison, without an app-token fallback.
The existing general `inventory.mes.fetch_user_token` helper can fall back to
the app token when the code or user token is missing; its return value alone
therefore cannot certify a user-context comparison.

Before enabling the disconnected stage adapter, add a reviewed actor contract
and synthetic acceptance cases: missing/mismatched/stale actor evidence must
block before a provider write; claim eligibility, department membership and
local superuser status must not grant save/finish rights; executor or permission
changes after save must block finish; uncertain claims must be reconciled by
exact task/executor readback without resending. Current stage fixtures do not
prove these provider actor relationships. These are outstanding activation
requirements, not implemented or live-verified guarantees.

An eligibility report's subject fields are request metadata, not a server echo
of authenticated identity. The current probe retains selected fields rather
than a complete response snapshot and folds missing/null optional fields
together. Its shared `observed_at` is created before issuance, not separately
for each response. Compare browser and API observations with those limits.

Transport failures distinguish missing token, known expired token, authentication
rejection (401), and access denial (403). A 401 alone is not proof of expiry.
An injected `InspectionAccessToken` can carry observed expiry without exposing
its credential in representations. There is no failure-triggered refresh/retry;
the normal initial runtime provider retains its existing token-resolution behavior.

`scripts/read-inspection-eligibility.py` is an import-only, separately approved
server-shell probe, with no runtime route or CLI. After validating the origin
and exact target, it invokes the existing app-token helper once and reads the
same task at most twice: omission, then the explicit subject. It never invokes
the user-token exchange helper. Missing/expired/uncertain authentication,
denial, malformed response, unverified target or required confirmation stops
the comparison without retry. Output is limited to query scope, status codes,
bounded candidate/department IDs and permission metadata; credentials, raw
messages, names and measurements are omitted. Its synthetic tests are not live
acceptance evidence. Keep actual target IDs and observations outside this public
repository; MES writes and live activation require separate explicit approval.
