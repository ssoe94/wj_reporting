# Completed WJ areas → one MES whole snapshot

## Studio continuation — 2026-10-08

An existing binding may now carry a server-reviewed `full_snapshot_connection`
manifest, loaded by `inspection_full_snapshot_policy.py`. The pure
`reviewed_manifest` helper performs no persistence or authorization. A manifest
pins binding scope, source digest/version, executor, expiry, exact typed detail
pins and a deployment-owned concurrency connector name. Reads do not create or
renew it. Actual CAS/fence callables must still be supplied; WJ locks do not
prevent edits made directly in MES. No manifest or connector is provisioned by
this change, and the concrete detail decoder remains standalone-test-only.

The explicit `completed_areas` source mode requires both distinct inspectors'
completed areas and all recorder/item history, without inventing a third
reviewer. The existing independent-approval mode remains the default. The
display inspector, authenticated WJ recorder and lawful MES executor stay
distinct; no account, mapping or permission is created by either mode.

Whole-save readback now preserves every existing record's ID, author, value and
raw creation/update timestamps exactly. Changing an existing value is rejected
before reservation. The concrete adapter also rejects a nonempty baseline
unless its reviewed policy explicitly establishes preservation semantics.
Metadata changes after dispatch remain unknown and cannot trigger a resend.
This does not add unsupported metadata fields to the provider's write payload.
All new acceptance evidence is synthetic; no completed live QC is replayed.

The kanban now passes the current authenticated session, actor and selected
business date to a server-owned reader hook. Its existing observation contract
remains fixture-only; actual equipment → current task → QC mapping and a live
decoder are still required. The UI displays source observation time and uses a
single compact dimension/appearance table with separate area actions.

Local implementation and connection follow-up at `2026-10-07T09:28:19Z`;
not integrated or deployed.
Owner checkout: `/Users/ssoe94/dev/mes-qc/wj_reporting-lee-diagnostics-20261006`,
branch `codex/lee-connection-diagnostics-20261006`, base HEAD
`2166bf623f1cfadbbeb4a07cc2f32f2057fe011d`.

The isolated trial observed two results after full setup at 08:32:31 UTC, then
only A after A-only replacement at 08:32:37 UTC. Evidence is
`output/mes-partial-trial-observed-omission-loss-20261007.json`. This establishes
omitted-row loss for that trial and endpoint. Sparse dispatch remains unavailable.

## Integration API

- `DjangoCompletedSource.capture(locked_request)` reads the two completed areas,
  request/config/area versions, exact item mapping, item inspector and authenticated
  recorder, completion inspector and recorder, stored shift/actor snapshots,
  designated shared-terminal WJ account, and historical area contributors.
  Missing UI 0015 provenance fields fail with `provenance_schema_unavailable`.
- `build_full_snapshot(server_source, binding, full_observation)` produces a
  detached whole intent, source/binding digests and the complete `checkItems` body.
  All configured MES rows must map exactly once; extra/unmapped rows block.
  Attachments and quantity effects are unsupported and block dispatch.
- `FullSnapshotCoordinator(source=..., executor_guard=..., adapter=...)`
  owns `run(actor, request_id, UUIDv4, source_digest=..., stage='save'|'finish')`
  and `reconcile(actor, request_id, operation_id)`.
  The source digest is a concurrency precondition, not client-supplied provenance.
  Integration must calculate it from a server-captured source under the same
  common request lock. Browser data never establishes recorder identity.

`CurrentExecutorGuard` now verifies current authenticated WJ actor/session, request
access, independent review/contributor restrictions, exact target/mapping,
existing MES USER credential and lawful MES executor. It returns a short-lived
`ExecutorAuthority` bound to actor, tenant, QC, config snapshot and MES user.
The two WJ inspectors and their recorders stay in the immutable intent and audit;
the MES result operator is the one actual lawful executor. No terminal/device ID
or per-item login-family ID is invented where the models do not record one.

`BlacklakeFullSnapshotAdapter` now exposes `read(binding, authority)`,
`guarded_save(binding, intent, expected_remote_fingerprint, operation_id, authority)`
and `guarded_finish` with the same signature. Guarded dispatch must hold the
current actor/session/credential authorization for the outbound operation and
enforce the expected provider fingerprint through a reviewed atomic provider CAS
or exclusive MES-writer fence. The observed provider write bytes have no
conditional field; no provider CAS or external fence is installed. The adapter
alternatively admits `reviewed_single_writer_trial` only with an explicitly
approved standalone test, no production link, a residual-race flag and recorded
operating conditions. The immediate whole read detects prior changes but leaves
an external read→write race. This mode does not guarantee concurrency safety.
There is no default policy, route or credential issuer. Every identity check uses
`ReuseOnlyIdentityProvider` and existing APP supply only.

Full observations require tenant/QC/snapshot/executor, immutable config digest,
all config keys, lifecycle/verdict/end time, collection time and every actual
result's record ID, value, operator ID, creation and update times. The existing
four-field result decoder is insufficient. Finish requires whole-save proof and
preserves all result metadata in its full readback.
`decode_full_detail` checks all 64 immutable pins in the observed two-row trial,
the full sample/config mapping and raw records. It accepts a partial baseline
without presenting it as a saved whole result. `beginTime` is validated but is
not a field in the core fingerprint; external atomicity is not inferred from it.

## Durable fences

Existing `InspectionOperation`, `InspectionMesBinding` and common
`inspection:<request_id>` transaction lock are reused; no migration is added.
Reservations persist the whole intent, source versions, exact executor and
review references before outbound dispatch. A committed `dispatch_claimed`
marker precedes the provider call. Pending/unknown operations block new keys and
other actors; replay and restarted coordinators do not resend. Read reconciliation
can settle a proven whole result and retains the original intent.
If a worker stops before `dispatch_claimed`, the reservation remains blocked
against automatic dispatch and needs an explicit audited resolution; this
module does not infer that a safe retry has been authorized.

New scopes end in `:mes-full-save` / `:mes-full-finish`; binding phases begin
`full_`. Existing stage phase checks reject these phases. UI area's general
pending/unknown-operation and non-ready-binding guards freeze edits. A source or
mapping change before dispatch blocks; a change or uncertain result after
dispatch remains unknown. This local fence proves at-most-one dispatch, not
external exactly-once delivery or provider atomic CAS.

Focused isolated Django validation of core, connection and raw decoder passed
63/63 at 09:23:59 UTC. It includes the actual guard/transport with synthetic
provider and source, credential-rejection cleanup commit, actor-before-request
lock order, source/reviewer checks and last-read metadata/config races. Log:
`output/mes-full-snapshot-connection-tests-20261007.log`. Independent read review
at 09:28:19 UTC found no additional required fix in this scope. These are
synthetic SQLite checks, not PostgreSQL worker-concurrency or live write acceptance.

UI-owned role/workflow/models/0015 migration/frontend files are unchanged.
The UI final selected commit/tree remains an integration prerequisite. Combine
both owners' selected changes, then run the affected provenance/session/PG checks
before any integrated deployment. The four runtime flags stay True.

## Reviewed provider trial evidence

A separately authorized standalone virtual-value trial established that the provider's item endpoint replaces the full result collection: an omitted item disappeared after a sparse save. An approved whole replacement restored both reviewed values, and a separate finish followed by full reads confirmed completion and preserved raw record metadata. Target identifiers, account identifiers, actual wire bodies and private execution receipts remain outside this public repository. The completed target must never be replayed by product integration.

This provider contract trial does not establish a two-inspector WJ field acceptance or remote CAS. Production, inventory, quantities and attachments remain outside this connection.

## Integrated product path

The isolated integration combines the pinned UI source and MES contract sources on the existing released tree. Migration 0015 preserves declared inspector versus authenticated recorder and shared terminal provenance. Migration 0016 widens the final judgement column; concession remains a local reviewed decision and is not converted into a guessed MES verdict.

`mes-full-save`, `mes-full-finish` and `mes-full-reconcile` are separate authenticated endpoints. Only an approved pass/fail result with immutable matching submission/review audits, two completed areas, every configured item and an independent current reviewer can become a whole snapshot. Aggregate and area rows must match exactly. Authenticated WJ recorder, declared inspectors and legitimate MES executor remain distinct.

The browser sends only an opaque source digest or the original operation identifier. A server-owned `FullSnapshotProductConnection` registry fixes the target, current executor, existing USER mapping, reviewed configuration and reviewed CAS/fence hook. Replacing or withdrawing any connection invalidates an in-flight writer. Empty registry is the default; runtime flags and WJ assignments never provision this authority. No credential issuer or automatic fallback is added.

Provider acceptance and full read proof settle durable save before the separate finish. Pending/unknown operations never repeat a write. Unclaimed interrupted reservations require explicit audited resolution. Known pre-dispatch blocks return 409, unknown outcomes 503 and pending outcomes 202. Provider readback time is stored exactly. Standalone trial projection remains test-only and cannot enter production totals.

General production execution, external provider CAS/fence installation and actual two-inspector acceptance remain unverified. The deployed UI must display the reviewed connection requirement until a valid exact connection is supplied.
