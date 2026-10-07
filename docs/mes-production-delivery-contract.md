# Production delivery contract

The existing inspection integration can save values, finish an individual QC,
and verify the exact MES result. Production order execution and inventory
receipt require their own target, authority and evidence. The production
delivery modules prepare that separate path without changing integration flags.

## Implemented code

- `backend/production/mes_execution_contract.py` builds bounded create, dispatch,
  task start, progress report and manual inbound bodies. Quantities remain
  exact decimals. It requires verified master IDs, unit precision, enums and
  explicit manual warehousing. A dispatch business ID is never a task ID.
- `mes_delivery_transport.py` accepts only an explicit same-user lease, fixed
  provider origins and documented routes. Exact full-body approval is checked
  immediately before dispatch. It never retries a write or refreshes a token.
- `mes_delivery_credentials.py` adds fresh unrestricted WJ admission and separate
  production authority evidence around the existing credential lease broker.
  QC submit permission and a reusable token alone grant no production action.
  An explicit identity provider is mandatory; there is no APP token fallback.
- `mes_delivery.py` commits a reservation before dispatch using the existing
  nullable operation journal. The PostgreSQL advisory lock is scoped to tenant
  and exact work-order code, independently of actor, quantity and UUID. Unknown
  and interrupted actions fence later writes. Only exact readback settles them.
- `GET /api/production/mes-delivery-readiness/` reports code readiness to current
  unrestricted superusers. It reads no business records and invokes no MES API.

The coordinator sequence is create → dispatch → start → first QC → periodic QC
→ report → manual inbound. QC stages only observe completed real measurements
for the same new work order, task and reviewed plans. Report and inbound require
fresh observations of those exact QC IDs. A standalone virtual QC is ineligible.

Report success requires report-record and new production-inventory provenance.
Inbound requires the same source inventory, approved warehouse/location/unit,
exact source/destination changes and linked receipt/change-log identifiers.
Provider acknowledgements and aggregate stock balances alone are insufficient.

## Runtime boundary

No production HTTP mutation, runtime scope issuer, production authority reader,
preflight reader or receipt reader is activated by this change. The reusable
coordinator accepts only trusted server callbacks. Runtime metadata explicitly
reports `runtime_connected: false`, `live_writes_enabled: false` and production
flow/receipt verification `not_evaluated`. These are production readiness facts;
the four existing inspection/login flags retain their current values.

Before runtime connection, bind verified material/version/BOM/route/resource,
quantity/unit/first and periodic plans, manual warehouse/location and inventory
effects, plus actor/API authority. Fresh preflight must verify code uniqueness,
current task state, approved units and manual warehousing before each write.
Fresh report/inventory/receipt readers must preserve exact request provenance,
bounded page completeness and causality. No client boolean attests these facts.

## Validation

Synthetic tests cover exact wire quantities and IDs, scoped transport rejection,
credential admission, durable interrupted/unknown fencing, fresh QC gates and
receipt evidence. They use injected senders and disposable databases. Real
PostgreSQL concurrency tests verify competing actors/keys cannot reserve two
actions for the same physical work order. These tests do not establish live
production or inventory acceptance.

Primary provider contracts: [create](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889053754.md),
[dispatch](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1686655055663527.md),
[start](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1779878826706456.md),
[reportable outputs](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681369551143844.md),
[report](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1745814197015893.md),
[production inventory](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1740034784757833.md),
[manual inbound](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1740034662264284.md).
