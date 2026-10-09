# MES partial-save trial and single-executor delivery

Prepared 2026-10-07. This is a proposal and local contract analysis, not a live
trial receipt. No new QC, configuration, permission or credential has been
created. The previously completed trial is excluded from this plan.

## What existing evidence establishes

The completed single-account trial establishes one complete two-item record
submission, exact readback, a separate inspection finish and a final readback.
It does not establish repeated saves, omitted-item preservation, two MES USER
writers or atomic exclusion of an external editor.

The official [record contract](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047075.md)
accepts `taskId` and `checkItems[]` at
`/quality/open/v1/task/_update_task_check_item`. Each reviewed item identifies
`checkItemId`, `groupName`, `seq` and `result`. Its boolean acknowledgement has
no saved values or item operator. It does not specify what omission does.

The [detail contract](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047070.md)
accepts `id` at `/quality/open/v1/task/_detail`. Compare the complete
`data.checkItems[].qcTaskCheckItems[]` using `qcConfigCheckItemId`, group and
sample sequence. It documents `result`, `operator.id`, `createdAt` and
`updatedAt`, separately from the task's `executor.id`.

Also preserve the raw result record `id` separately from the configuration-row
`qcConfigCheckItemId`. A recreated row must not pass omitted-item preservation
merely because its item key, value and timestamps match. Creation's template
`configId` is separate from the task's configuration `snapshotId`; pin both in
the reviewed raw configuration identity/digest without substituting one ID.

The [finish contract](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1734579609709798.md)
accepts `id` and explicit `status` at `/quality/open/v1/task/_finish`.
For this synthetic pass trial, status is `1`. Confirm the observed final
lifecycle, verdict, completion time and complete item set afterwards.

The public source schemas were checked on 2026-10-07 at 06:14:24 UTC. They do
not provide an omission guarantee, a multiple-writer authority guarantee or a
provider version/If-Match contract. The singular executor field alone proves
none of those limits or permissions.

## Existing WJ implementation constraints

- `backend/quality/inspection_mes_stages.py` permits save only in `ready`, then
  transitions to `saved`; another save is rejected. A key replay does not send
  another write.
- `backend/quality/inspection_live_adapter.py` compares the fresh complete read
  digest against the fixed `initial_records_digest` before sending. It cannot
  advance through two changed baselines under the original policy.
- `backend/quality/inspection_mes_stages.py:binding_contract` requires exact
  complete local-item coverage and reviewed read/write mappings. The current
  coordinator cannot accept an area-only payload merely because the standalone
  documented payload compiler can construct it.
- `backend/quality/inspection_live_readback.py` validates exact configuration
  coverage and rejects unmapped records, but its normalized receipt retains
  value identities without the documented per-item operator/timestamps. The
  new trial needs separately bounded comparison evidence for those fields;
  a current normalized receipt is insufficient for omission auditing.
- Pending or unknown writes block new writes. Reconcile by readback; do not
  resend after a timeout, alter the initial baseline, reset a saved binding or
  reuse the completed trial's authority.

These are intentional constraints. A new sequential trial requires a reviewed
test-only coordinator with explicit stage progression and expected baselines;
neither an existing production path nor a disabled guard is that coordinator.

## Proposed isolated trial scope

Proposed QC code: **`WJ-IT-20261007-PARTIAL-01`**. Proposed new configuration
code, only if approved: **`WJ-IT-20261007-PARTIAL-CFG01`**. Both satisfy the
existing `WJ-IT-…` code validator. Availability of these names has not been
queried or reserved.

Plan name: **`WJ standalone partial-record preservation / WJ-IT-20261007-PARTIAL-01`**.
This names the isolated interface trial, not a production/inventory QC plan.
The executor is the already authorized existing WJ/MES identity, with its exact IDs
kept in the private reviewed execution manifest. Existing full-save/finish
evidence does not establish current configuration-create/claim authority or
shared-terminal administrator privileges. Before the approved live stages,
verify the executor's existing effective permission for every allowed action. An
unavailable permission or credential stops the trial; no grant, new token,
alternative identity or impersonation is included. Current authority has not
been refreshed or reissued as part of this local preparation.

Use one standalone GENERAL QC (`checkType=6`) with exactly two numeric synthetic
items, one sample per item, and the explicit virtual-value label required by
`inspection_integration_trial.py`. No work order, production task, equipment,
lot, warehouse, receipt, inventory movement, defect disposition, attachments or
quantity writes are included. Quantity is not recorded and the target is zero.
These values and bounds are invented solely for interface verification.

| Synthetic item | Reviewed test bounds | Initial sentinel | Changed sentinel |
| --- | --- | --- | --- |
| A | 9.0 through 11.0 | A0 = `10.0` | A1 = `10.1` |
| B | 19.0 through 21.0 | B0 = `20.0` | B1 = `20.1` |

Configuration creation is an explicit additional effect, not an implicit
precondition. An existing reviewed virtual configuration may replace it only
if it has exactly these two item contracts and the same valid sentinels.
Before creation, approve the exact proposed codes, configuration/QC creation
bodies, existing executor and stage/action budget. The creation receipt then
supplies the new QC/configuration IDs; those cannot be known beforehand. Verify
the receipt against that approved scope, and pin the returned IDs, separate
read/write item IDs, group/sequence, tenant, task/configuration identity and the
lawful executor's WJ ID and MES USER ID in an immutable server-reviewed execution
manifest before claim/start/record/finish. This is staged target binding within
the approved scope, not permission expansion. Do not guess IDs, map
configuration-row IDs to write IDs by assumption, or infer authority from
candidate lists. Check that the target is new and open, not the previously
completed QC. Use only the already authorized session and reusable credential;
if either is unavailable, stop without new issuance or grants.

The reviewed manifest must name an exclusive test interval and expiry, every
allowed stage/body digest, an independent reviewer, fresh-read bounds and
expected complete before/after states. No external writer may edit this QC in
that interval. This restriction narrows the test; it does not establish CAS.

## Exact sequence and write budget

1. If needed and approved, create the two-item virtual configuration once.
   Create the new standalone QC once, then claim/start it once each only if its
   observed lifecycle requires those actions. Read the task and exact complete
   configuration; reject a wrong executor, extra item or unexpected state.
2. **Setup save:** submit the complete synthetic `[A0, B0]` once. Read the full
   task and pin both nonempty values and both item metadata snapshots. Blank B
   cannot prove preservation of a previously entered nonempty B. Both raw rows
   must expose valid, nonnull `operator.id`, `createdAt` and `updatedAt` under
   the reviewed provider contract. Distinguish missing fields from explicit
   nulls; neither supports a metadata preservation pass. If the required
   metadata is unavailable, stop and report that proof as unverified rather
   than treating matching absent values as preservation evidence.
3. **First sparse save:** submit only `[A1]` once. Read the full task. Require
   A1/B0, stable item/sample identities and unchanged B operator/timestamps.
4. **Second sparse save:** only after that observation is verified, submit only
   `[B1]` once. Read the full task. Require A1/B1 and unchanged A metadata from
   the preceding observation. Record the actual task executor and item operators
   separately; the record body does not claim WJ authors.
5. **Separate finish:** only after both complete reads pass, submit explicit
   finish once. Read again and confirm A1/B1, completed lifecycle, pass verdict,
   completion timestamp and the actual identities. Record approval-pending as
   that observed state, not as completed.

The record write budget is **one setup full save plus two sparse saves**;
finish is a fourth write. QC/configuration creation and optional claim/start
are additional named effects. This is not a two-write trial. Each write has a
unique stage key and immutable reviewed body; a retry cannot consume the next
stage or send the old body again. Each new stage must verify a fresh complete
read against the previous verified stage before writing. A value digest alone
does not cover item operator/timestamps.

Reject or stop on an extra/missing item, wrong identity, stale baseline, changed
omitted value or metadata, unknown outcome, expired authorization or an
unexpected lifecycle. After an unknown outcome, permit bounded read-only
reconciliation and retain the operation evidence. Do not replay, repair with a
full payload, finish, delete or clean up automatically. No recovery write is
included in this scope. A detected destructive omission is evidence to report,
not a reason to overwrite a record to make the test pass.

This trial can establish observed sparse preservation for this tenant, test
configuration, item/sample mapping and USER. It cannot establish different
USERs' authority, every QC type, external concurrent editing or unattended
operational safety. Production role writers remain blocked after this test
unless their own complete authority and concurrency contracts are approved.

## Single lawful MES executor after both WJ areas complete

A final full submission is a distinct alternative with an already established
payload/readback/finish shape. `inspection_roles.py:_aggregate` merges the two
areas in original item order; `binding_contract` requires their complete
mapping; `inspection_blacklake_contract.py:result_and_finish_plan` builds the
full record and separate finish bodies. It does not require a second MES USER.
It also does not immediately reflect each earlier partial WJ area save in MES.

To implement this alternative, add an explicit server-reviewed role-delivery
authorization. Pin the existing request owner as the first trial's executor,
both completed area versions and immutable author/completion snapshots, the
role configuration version, full result digest, complete item mapping, exact
QC/tenant, independent review and expiry. Recheck all of them before reserving
or replaying a stage. The two authors receive no MES credential or executor
permission through assignment.

Keep both WJ authors on the WJ audit and area snapshots; report the single real
MES executor/updater on MES evidence. Do not submit fabricated author/operator
fields in the record body. Separate WJ user IDs from provider MES USER IDs.
Request access alone is insufficient executor authority: area participants also
have request access. The delivery reviewer must not be the submitter or either
area completer; do not reuse the historical single-actor trial review exception
or grant the executor review permission to satisfy preparation.

Allow only the reviewed `mes-save`, `mes-finish` and read-only reconciliation
actions through an action-specific guard; generic sync remains blocked. Reject
incomplete/reopened areas, changed author snapshots, extra MES items, another
executor, revoked permission and uncertain writes. Preserve existing no-resend
reconciliation and verify stored values before separate finish. This delivery
authorization and its runtime path are not implemented or activated by this
document.

The separate shared-terminal UI work adds declared inspector attribution and
authenticated recorder attribution. Preserve `item_authorship`, area
`completed_recorded_by` snapshots and authenticated audit contributors alongside
the assigned inspector and completed-area/config versions. A terminal's
`completed_by` may identify its selected assigned inspector; it does not prove
that inspector logged in or personally confirmed the entry. Pin inspector,
recorder and MES executor separately. A delivery reviewer must be independent
of all input contributors, including earlier/reopened entries. A UI
`can_operate` flag or selected `inspector_id` never supplies MES authority.

## Local coordinator preparation

`backend/quality/inspection_partial_trial_contract.py` prepares immutable offline
intents for exactly this synthetic setup/full, sparse-A, sparse-B and finish
sequence. It verifies fresh complete configuration/record evidence, exact
executor IDs, excluded completed targets, scope fingerprints, omitted metadata,
pending/unknown blocking and bounded read-only reconciliation. Every returned
intent has `live_authorized=False` and no send method. The associated independent
test file uses fabricated identities, observations and values only.

The module has no transport, credential, model, settings, endpoint or activation
integration. It does not change the current API or role MES guard. Its state is
in memory; recreating it is not a safe live retry. Before a real trial, a reviewed
live coordinator still needs durable atomic reservations, current permission
checks, a bounded raw decoder retaining operator/timestamps and approved
dispatch. The offline result does not establish provider partial-write support,
durable idempotency, CAS or the executor's current effective privileges.

The fresh-read/digest guard does not prevent an external edit between read and
write. Restrict a first isolated full trial to the same explicit exclusive
window. Operational expansion needs provider CAS or effective serialization of
all external writers, rather than repeated success under a quiet test window.
