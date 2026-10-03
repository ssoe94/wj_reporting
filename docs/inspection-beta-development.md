# Inspection beta development contract

The beta adds an active-superuser-only inspection workflow with a 17-machine kanban, local result entry and independent review. Local approval and externally verified MES completion are separate states. The inspection adapter and read providers remain disabled by default.

## Read projection

The read decoder preserves exact decimal strings and separate QC, snapshot, configuration-row, master-item and sample-record identities. Records join on outer group plus configuration-row reference. A read join does not establish the write API's check-item identity. Multiple samples and comparator/base specifications remain distinct.

Fixtures committed here are fabricated. Private runtime observations and production measurements are not published. Synthetic tests cannot establish live tenant mappings, performed inspections, write authority or successful save/finish.

## Public injection board

The optional quality projection requires an independently verified current local-plan-to-MES-task relation and bounded read freshness. It clears current status on scope changes, expired evidence or failed refreshes, and preserves individual failed periodic checks when the combined state is unresolved. It does not infer inspection intervals, current operation, receipt permission or actor authority. Public fields exclude MES identifiers, measured values and actors; protected detail/input stays in the inspection beta.

## Remaining activation work

Before enabling live entry, complete the permanent tenant/QC/request relation and server-owned item/actor mapping, additive persistence and audit review, and distinct durable save/finish stages. Preserve the existing independent-review rule. A saved record must be re-read and matched before finish; timeout or ambiguous outcome requires reconciliation without automatic replay. A computed digest must derive from observed external values, never echo the request as external verification.

Actual validation needs a designated test-only QC or sandbox, a supported source test-label path, verified claim/start permissions, and reviewed approval/inventory/production side effects. Completed historical QCs must not be altered for testing. Both first and periodic flows need their applicable acceptance evidence. Do not activate or deploy merely because fixture tests pass.

## Checks

`scripts/check-inspection-requests.py` uses isolated settings without project environment files. `scripts/check-inspection-postgres-local.py` uses explicitly installed PostgreSQL tools and creates only its own disposable socket-only cluster under output. The CI validation step fails if those tools are absent. Node tests exercise access, state and public projection gates. Browser fixtures use loopback endpoints and fabricated data.

## Standard continuation: save/finish boundary

The legacy combined `send_reviewed_stages` entry point now fails before authentication
or transmission. `send_reviewed_record` can acknowledge only the reviewed item stage;
it never sends finish. Its in-memory replay fence is not durable idempotency. The
production adapter remains disabled. A separate durable coordinator, exact write-ID
mapping, scoped fresh readback of saved values and permanent test label, and explicit
finish reconciliation remain required before live entry or beta deployment.

## Standard continuation implementation

Durable separate measurement-save, QC-inspection-completion and read-only reconciliation actions now exist behind a disabled application-stage adapter. Synthetic PostgreSQL tests cover independent review, exact mappings/readback, immutable retries, unknown outcomes and concurrent writers. A failed result creates an independent nonconformance record; QC completion cannot close it. The dashboard uses the same optional quality scope/freshness contract as the injection board and retains production figures when quality is unavailable.

See [MES disposition boundary](inspection-mes-disposition-contract.md) for official API candidates and the remaining live integration gates. Local scaffolding and passing fixtures do not establish real MES operation or disposition support.
