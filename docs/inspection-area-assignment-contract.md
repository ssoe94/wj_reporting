# Appearance and dimension inspection assignment

New requests can explicitly opt into `role_workflow: true`. Existing requests keep
their current workflow and cannot be converted. Each configured request has one
appearance input author and one distinct dimension input author. These are WJ
authors; assigning them does not assign or impersonate a MES executor.

## Configuration and ownership

An existing inspection administrator can create an inactive shift draft. There
are no seeded shifts, users, permissions, account mappings or inferred shift
times. Activation requires explicit start/end times, a valid timezone, two
distinct eligible existing users, and a non-overlapping active window. A request
requires an explicit `shift_date`, versioned shift selection, and a complete
item-to-area mapping. Production start time does not select the inspection shift.

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

Official ALI documentation defines a single task `executor` and separate item
`operator`/updater fields. Item-wise `reportPageType=2` does not establish that two
different USER identities may save one QC. The record body contains item IDs and
results, but does not document omission-preserves-other-items semantics, a partial
update guarantee, or a version/ETag/CAS contract.

Sources: [task detail](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047070.md),
[record](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047075.md),
[claim](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047071.md),
[finish](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1734579609709798.md).

Therefore role requests block MES save, finish, refresh, reconcile and sync before
constructing an adapter or obtaining a credential. The UI states that partial
save and multiple-executor contracts are unverified. Existing single-executor
requests retain their established path. WJ area-save success is not MES save
success. Activation requires an authorized, separately evidenced contract for
each USER, omitted-item preservation, exact item/sample identities, external
concurrency, actual operators and the MES executor's finish permission.

## Migration and deployment

`quality.0013_inspection_roles` contains exactly three additive `CreateModel`
operations: shift settings, request role workflow, and area result. It has no
backfill, account activation, default permission creation or existing-column
changes. Existing completed QC, audit, operation and MES binding records are
preserved by an isolated upgrade regression. Apply this migration before serving
the new backend: role projection is also present on legacy request reads.

Deploy the matching backend and frontend commit after the full CI succeeds,
including PostgreSQL tests for concurrent area saves and complete/reopen races.
The local SQLite suite cannot prove PostgreSQL locking behavior. Preserve the
existing four enabled integration flags and authenticated account state.

Rollback retains all three tables and their records. Never reverse/drop the
migration as routine rollback. If role work has started, pause those actions
before rolling back to code that does not enforce their ownership contract.
Existing older models can read legacy rows with the new tables retained, but
deleting referenced users may be protected by the new foreign keys.
