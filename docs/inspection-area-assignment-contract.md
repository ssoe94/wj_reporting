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

By default only the assigned author can save, complete or reopen their area,
including when the caller is an administrator. An administrator may explicitly
select `shared_terminal: true` during request configuration for one inspection-room
screen, keyboard and mouse. The server records that authenticated configurator as
the terminal operator. Selecting an inspector does not switch the login or prove
that person authenticated. Another administrator cannot use this terminal authority,
and it does not grant MES executor authority. Terminal configuration, assignments
and item mapping become immutable once any area input starts.

The terminal operator may record either assigned inspector's area by submitting
the exact `inspector_id`. Each mutation and idempotent replay rechecks the verified
operator session, unrestricted administrator authority and selected assignee's
current active inspection authority. Ordinary authors retain their own-area flow.
Each save validates item ownership and merges only that area's items. A request
lock and area/configuration versions
serialize writes while allowing the other area's independent version to remain
valid. A terminal takes preliminary `NO KEY UPDATE` locks on caller and selected
inspector in stable ID order before session and request locks; this permits a
concurrent assignment's foreign-key checks to finish. The full inspector lock is
taken after verified actor and request access. A direct author locks their own
identity before the request. This avoids reversing the user/request lock order
during mixed saves.

Audit actors and timestamps come from the server. Each submitted item's
`item_authorship` records the declared inspector separately from the authenticated
recorder. Untouched values and authorship remain intact. `completed_by` records
the assigned inspector, while `completed_recorded_by` records the authenticated
account that entered completion. Reopening clears completion identities and
retains the item's prior attribution.

Both areas must be complete and PASS for the aggregate verdict to be PASS. A
completed FAIL area makes the aggregate FAIL. Incomplete work has no aggregate
PASS. Reopening an area clears the aggregate completion. Shared quantities and
notes remain a separate versioned request-owner action; they cannot carry item
results, evidence or an area verdict. The request owner can submit after both
areas complete. An area author or recorder cannot review their own work. A failed
request's reinspection child starts unconfigured, without copied assignments or
results; parent evidence remains unchanged.

## API

All mutation endpoints use the current inspection session and an idempotency key.

| Endpoint under `/quality/inspection-requests/` | Purpose |
| --- | --- |
| `GET/POST role-settings/` | List configuration or create a shift draft |
| `PATCH role-settings/{setting_id}/` | Versioned shift update |
| `POST {id}/role-configure/` | Explicit shift/date/authors and item mapping |
| `POST {id}/area-save/` | Save an authorized assigned area |
| `POST {id}/area-complete/` | Validate and complete an authorized assigned area |
| `POST {id}/area-reopen/` | Reopen an authorized assigned area |
| `POST {id}/role-results/` | Request-owner shared quantities and notes |

Area actions return the full serialized inspection request. Settings mutations
return `{settings, candidates, can_configure, setting, actor_id}`. The frontend
validates the nested setting and current author before acknowledging the save.
The existing limited pilot route policy includes area actions and shared results;
it does not add pilot identities, settings administration or permission grants.

`role-configure` accepts the optional boolean `shared_terminal`; omission preserves
the current selection and a new request defaults to off. The server chooses the
operator from the authenticated configurator, never from a supplied actor ID.
Area actions accept `inspector_id`, required for terminal entries and constrained
to the immutable area assignee. Authorship maps and timestamps are server-owned.
The role projection adds `shared_terminal: {enabled, operator_id, operator_name,
can_operate}`; area projections add `item_authorship`, `completed_recorded_by` and
`completed_recorded_by_name`. Area capabilities reflect current terminal authority.
Shared quantities and submission remain request-owner actions.

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

The [concrete partial-save trial and single-executor plan](inspection-partial-save-trial-plan.md)
names a proposed new virtual QC, valid synthetic sentinels, the setup/full and
two sparse save budget, complete readback comparisons and stop conditions. It
also identifies the current one-save phase/fixed baseline limits and the
server authorization needed for a full merged submission. This proposal has
not created or written a live target.

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

`quality.0015_inspection_shared_terminal` adds exactly five fields: nullable
operator and completion-recorder foreign keys, their preserved names, and the
per-item authorship JSON map. It adds no rows, permissions, grants or inferred
historical authorship. Existing author and completion evidence stays unchanged;
new terminal/recorder identities stay null and authorship stays empty. Apply it
before serving the matching backend. Rollback must retain these columns and any
recorded attribution rather than reversing the migration.

Deploy the matching backend and frontend commit after the full CI succeeds,
including PostgreSQL tests for independent area saves and same-area stale conflicts.
The local SQLite suite cannot prove PostgreSQL locking behavior. Preserve the
existing four enabled integration flags and authenticated account state.

Rollback retains all three tables and their records. Never reverse/drop the
migration as routine rollback. If role work has started, pause those actions
before rolling back to code that does not enforce their ownership contract.
Existing older models can read legacy rows with the new tables retained, but
deleting referenced users may be protected by the new foreign keys.


## Area entry and final decision — 2026-10-07

The worksheet displays dimension (including deformation) and appearance in two
parallel cards. Each card has its assigned inspector, input/save progress and
scoped save control; editing or saving one card preserves the other card's draft.
Compact columns for measurement, judgement and saved state are centered, including
the input text and status badges. Cards stack on narrower screens. Shared-terminal
area saves retain existing scoped CAS, authenticated recorder and explicitly
assigned inspector attribution.

Numeric dimension inputs derive pass/fail from inclusive configured minimum and
maximum bounds. An out-of-range badge shows the distance from the violated bound
using decimal arithmetic. The input update saves the derived judgement with the
measurement; reading historical records never silently rewrites them. Recognized
pass/fail choices in deformation and appearance derive a read-only badge from
one measurement selection; the stored configured option string is preserved.
Arbitrary choice contracts and unbounded numeric items retain their existing
measurement semantics. Empty or invalid
measurements and invalid bounds never fabricate a pass.
The worksheet always shows both cards. Ordinary inspection creation starts with
a required dimension item and a required pass/fail appearance item. The UI blocks
creation/final judgement unless each area has a required configured item; older
missing snapshots show a configuration warning and cannot be treated as passed.
Existing production snapshots are not backfilled by reads. Explicit integration
trials retain their isolated test-only flow. Role configuration already validates
both areas on the server; legacy API validation is unchanged in this UI revision.

After saved required values and evidence are ready and no local draft remains,
the owner receives an explicit final-decision dialog. Confirming completes the
remaining owned areas in order using each latest area revision, then submits the
chosen final judgement using the latest request revision. Failures stop the
sequence; uncertain writes retain their original idempotency key for explicit
recovery. Separate inspector accounts retain scoped area completion.

Final choices are pass, fail and concession (Korean: 한도승인; Chinese: 让步合格).
A concession records mandatory grounds in the submit audit, preserves failed
measurements and the nonconformance, and requires an independent reviewer with
a recorded approval reason. It does not promote failed measurements to pass or
imply confirmed MES completion/receipt readiness. Standalone integration trials
retain their pass/fail-only contract. Per-item judgements remain pass/fail.
`quality.0016_inspection_final_concession` widens only the final request judgement
column from 8 to 16 characters, preserving rows; it must precede matching backend
code in a future release. It has been applied only in disposable local tests.
