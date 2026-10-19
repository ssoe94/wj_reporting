# Sales daily movement history — local implementation

## Scope

Sales submenu `/sales/movement-history` shows finished-goods movements by Shanghai business date (08:00 through next 08:00), material/model, warehouse and unit. Each row expands into MES identifier totals and chronological source movements. Inbound and outbound remain separate even for the same identifier on the same day. Date/model/direction/order filters and pagination apply to persisted data. Period totals respect the direction filter; daily rows show both directions for context.

This is local code, not a deployed feature. No production migration, backfill, credentials or MES mutations were performed.

## Actual MES evidence (2026-10-19)

Read the existing authenticated MES browser session, warehouse → inventory change records:
`https://v3-ali.blacklake.cn/warehouseManagement/inventoryManagement/inventoryChangeRecord`.
The table uses the heading **标识码**. Both WJ and TT values appear in that column:

- `WJ-7459`: material `MBN66284901`, transfer out of 加工车间仓库 and into 半成品仓库 at 2026-10-19 09:56:03.
- `TT0940411`: finished-goods material `ACQ30669314`, inbound 100 at 09:57:39.
- Some finished-goods outbound rows have no identifier at all.

Read the browser Network response for `/api/inventory/domain/web/v1/inventory_change_log/_list_page`. Both values are explicitly `qrCode` values. The observed shape also has `material`, `warehouse`, `amount.direction` (boolean), nested `amount.amount`, `createdAt`, and `action.code/message`. No separate cart number appeared in the inspected records. Browser response reading did not extract credentials or replay requests.

Existing inventory collection code (`fetch_inventory.py::_build_staging_object`) separately preserves `qrCode` and assigns `trolleyCode` or fallback `labelCode` to its label column. That fallback is not evidence that all three fields mean the same thing. This feature preserves all three independently, never classifies WJ/TT by prefix, never backfills historical carts from current inventory, and never uses batch/order IDs as cart IDs. UI calls the common field MES identifier (logistics/cart). Empty identifier rows remain included.

The integration uses the existing authorized OpenAPI wrapper `/inventory/open/v1/material_inventory/_list_change_log`. Its raw identifier response was not independently fetched from production in this task; the actual web response and existing integration code are the field evidence. A deployed OpenAPI sample reconciliation remains a release check.

## Persistence and collection

Additive migration `inventory.0014_movement_history` creates three models:
- `MovementHistoryDay`: business date, published version and last successful check.
- `MovementHistoryRevision`: immutable capture fingerprint, source metadata, version and capture time.
- `MovementHistoryGroup`: material/warehouse/unit summaries and identifier details with source IDs, timestamps, direction, exact quantities, action, location and batch.

Decimal strings in JSON preserve MES precision across SQLite/PostgreSQL. Arithmetic uses Decimal with precision 100. A complete day publishes atomically; duplicate source IDs, missing IDs, invalid quantities/timestamps/units/model, unknown directions, incomplete pagination, changed totals, excessive data or fetch failure do not replace published history. Identical recapture is idempotent. Corrections append a version; old detail IDs remain readable. A day row lock prevents concurrent version overwrite; an older capture cannot overwrite a newer successful capture. SQLite tests cover publication and stale-capture protection; PostgreSQL concurrent execution has not been run.

History has no relation to the ephemeral 10/30-day inventory snapshots and is excluded from their cleanup. No automatic history deletion is added.

`sync_movement_history` collects the most recent seven **closed** business days by default, revisiting late corrections. Explicit `--start-date YYYY-MM-DD --end-date YYYY-MM-DD` supports a bounded historical backfill (up to 366 dates per invocation). Failed dates preserve prior revisions and other dates continue. Both the existing Celery inventory task and Render’s direct `daily_snapshot_auto` command invoke it; no deployment/scheduler settings were changed. Missing historical dates outside the seven-day window require explicit backfill.

GET endpoints perform no MES fetches or database writes. Missing collection dates are distinct from complete zero-movement days. Current/future business dates are pending. Main-page revision fingerprints prevent mixing pages after publication; detailed rows use immutable group IDs. Periods up to 366 dates can be queried, regardless of stored age.

## Local validation

Completed checks:
- `scripts/check-movement-history.py`: 17 passing tests, additive migrations replayed on disposable SQLite. Covers day boundaries, precise totals, identifiers/units, full pagination, invalid/incomplete data rejection, idempotency/corrections, transaction rollback, stale captures, auth/GET-only access, missing vs zero vs pending dates, and daily task failure isolation.
- Frontend helper tests: 3 passing (closed-day defaults, Shanghai boundary, date/filter validation and decimal display).
- Targeted ESLint: passed.
- `npm run build`: modern Vite and legacy CSS builds passed (existing bundle-size warnings).
- Offline Playwright acceptance: passed at 1280×720 and 390×844, Korean/Chinese. Tested lazy details, detail failure/retry, same identifier with both directions, event expansion, missing/pending dates, pagination, filter reset, URL/back, empty/invalid/error states, and mobile overflow. No page errors. All traffic intercepted; no production writes.
- `git diff --check`: passed.

Evidence: `output/movement-history/acceptance.json`, `desktop-expanded-ko.png`, `desktop-zh.png`, `mobile-ko.png`, `mobile-zh.png`.

Isolated runner `scripts/check-movement-history.py` configures disposable SQLite without project `.env` or production settings. The browser acceptance script intercepts all traffic and uses synthetic fixtures; screenshots are not production data acceptance.

The preexisting model state has four unnamed indexes whose generated names differ from migration 0012. Generated RenameIndex operations were removed from 0014 so this feature does not rename existing indexes. Applied migration 0012 is unchanged.

## Release steps still required

After an explicitly requested release: review/apply additive migration in production, deploy the code, run approved initial closed-day backfill, reconcile a representative model/day against MES including identifiers and both directions, and verify the existing daily scheduler actually captures the next closed day. Local code alone does not create production historical data.
