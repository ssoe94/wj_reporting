# Appearance and dimension inspection assignment

New requests can explicitly opt into `role_workflow: true`. Existing requests keep
their current workflow and cannot be converted. Each configured request has one
appearance input author and one distinct dimension input author. These are WJ
authors; assigning them does not assign or impersonate a MES executor.

## Configuration and ownership

An existing inspection administrator can create an inactive shift draft. There
are no seeded shifts, users, permissions or account mappings. The UI offers local
templates for the confirmed factory schedule: DAY 08:00–20:00 and NIGHT
20:00–next day 08:00 in `Asia/Shanghai`. Choosing a template does not save or
activate an assignment. A user must explicitly select the two existing accounts
and the effective local date/time. Account choices show the name, WJ username/id
and any existing MES USER ID mapping; a mapping does not prove executor authority.

Activation requires explicit start/end times, an effective start, two distinct
eligible existing users, and a non-overlapping active window. The start must
match the shift's start clock; an optional effective end must match a shift start
or end boundary and follow the effective start. Active recurring clock windows
and half-open effective periods are checked together. Adjacent 08:00/20:00
boundaries and disjoint future assignment periods are allowed. Each setting row
has a unique internal code; a new assignment period can be added separately.
Local input fields use exact `YYYY-MM-DDTHH:mm`. API responses expose both local
values and UTC instants, and the database stores timezone-aware instants. A request
requires an explicit `shift_date`, versioned shift selection, and a complete
item-to-area mapping. Its whole declared day or overnight shift must fit within
the selected effective period. Production start time does not select the shift.

The request snapshots the declared shift window and authors. Assignment and
mapping cannot change after work starts. Unconfigured requests expose a setup
action. The whole-request result editor is unavailable for role requests.

Only the currently assigned author can save, complete or reopen their area,
including when the caller is an administrator. Each save validates item ownership
and merges only that area's items. A request lock and area/configuration versions
serialize writes while allowing the other area's independent version to remain
valid. Idempotent replay rechecks the current session, permission and assignment.
Audit authors and completion times come from the server.

Both areas must be complete and PASS for the aggregate verdict to be PASS. A
completed FAIL area makes the aggregate FAIL. Incomplete work has no aggregate
PASS. Reopening an area clears the aggregate completion. Shared quantities and
notes remain a separate versioned request-owner action; they cannot carry item
results, evidence or an area verdict. The request owner can submit after both
areas complete. A completed-area author cannot review their own work. A failed
request's reinspection child starts unconfigured, without copied assignments or
results; parent evidence remains unchanged.

## API

All mutation endpoints use the current inspection session and an idempotency key.

| Endpoint under `/quality/inspection-requests/` | Purpose |
| --- | --- |
| `GET/POST role-settings/` | List configuration or create a shift draft |
| `PATCH role-settings/{setting_id}/` | Versioned shift update |
| `POST {id}/role-configure/` | Explicit shift/date/authors and item mapping |
| `POST {id}/area-save/` | Save only the caller's area |
| `POST {id}/area-complete/` | Validate and complete only the caller's area |
| `POST {id}/area-reopen/` | Reopen only the caller's area |
| `POST {id}/role-results/` | Request-owner shared quantities and notes |

Area actions return the full serialized inspection request. Settings mutations
return `{settings, candidates, can_configure, setting, actor_id}`. The frontend
validates the nested setting and current author before acknowledging the save.
The existing limited pilot route policy includes area actions and shared results;
it does not add pilot identities, settings administration or permission grants.

## MES contract boundary

Official ALI documentation shows a singular task `executor` and separate item
`operator`/updater fields. Item-wise `reportPageType=2` does not establish that two
different USER identities may save one QC, and a singular schema does not prove
a provider-enforced single-executor limit. The record body contains item IDs and
results, but does not document omission-preserves-other-items semantics, a partial
update guarantee, or a version/ETag/CAS contract.

Sources: [task detail](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047070.md),
[record](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047075.md),
[claim](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047071.md),
[finish](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1734579609709798.md).

Plan/task candidate arrays document multiple claim candidates, rather than
multiple active executors. Task editing does not establish per-item author
delegation. The combined item/configuration update endpoint is not an evidenced
record-only partial replacement contract. Sources:
[plan detail](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047059.md),
[task creation](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047069.md),
[task edit](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047074.md),
[item/configuration update](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047073.md).

The current WJ live path validates one WJ actor, one MES USER and the exact
executor identity. The existing successful full-two-item save/finish trial does
not establish omitted-item preservation, multiple active USER writers or external
concurrency guarantees. Those provider contracts remain unverified.

Therefore role requests block MES save, finish, refresh, reconcile and sync before
constructing an adapter or obtaining a credential. The UI states that partial
save and multiple-executor contracts are unverified. Existing single-executor
requests retain their established path. WJ area-save success is not MES save
success. Activation requires an authorized, separately evidenced contract for
each USER, omitted-item preservation, exact item/sample identities, external
concurrency, actual operators and the MES executor's finish permission.

A possible separately reviewed alternative preserves WJ area authors while a
legitimate MES executor reviews the merged complete result and submits with their
own authorized identity. It must retain the distinction between WJ input authors
and the MES executor/updater. Full-item payload coverage, external-edit protection,
readback and finish permission still require evidence. This is not an automatic
fallback after a partial save fails.

A future partial-write trial needs a separately authorized in-progress test QC,
the exact USER/item/value/action scope, known A/B values, evidence that omitted
items and their operators are preserved, and external concurrent-edit checks.
Unknown outcomes require readback rather than retransmission. Existing completed
QC evidence must remain unchanged. No role implementation or migration authorizes
creation of a new QC, credential issuance or permission expansion.

## Migration and deployment

`quality.0013_inspection_roles` contains exactly three additive `CreateModel`
operations: shift settings, request role workflow, and area result. It has no
backfill, account activation, default permission creation or existing-column
changes. Existing completed QC, audit, operation and MES binding records are
preserved by an isolated upgrade regression. Apply this migration before serving
the new backend: role projection is also present on legacy request reads.

`quality.0014_inspection_shift_effective_period` adds exactly two nullable datetime
fields to shift settings. It creates no rows and does not infer effective dates
for old settings. Existing request/area author snapshots and completed QC rows
remain unchanged. A pre-existing active setting with no effective start needs an
explicit reviewed setting update before configuring new requests with it.

Deploy the matching backend and frontend commit after the full CI succeeds,
including PostgreSQL tests for independent area saves and same-area stale conflicts.
The local SQLite suite cannot prove PostgreSQL locking behavior. Preserve the
existing four enabled integration flags and authenticated account state.

Rollback retains all three tables and their records. Never reverse/drop the
migration as routine rollback. If role work has started, pause those actions
before rolling back to code that does not enforce their ownership contract.
Existing older models can read legacy rows with the new tables retained, but
deleting referenced users may be protected by the new foreign keys.
