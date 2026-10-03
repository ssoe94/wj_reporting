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
