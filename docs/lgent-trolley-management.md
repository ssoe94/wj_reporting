# LGENT trolley management

Status: implemented and verified with disposable fixtures; not a claim of production deployment or live LG photo acceptance.

## Entry and operation

- Sales → 대차관리 / 台车管理, `/sales/trolleys`; Korean/Chinese follows the existing language switch.
- WJ sales viewing permission is required; uploading, analysis, matching and saving require sales editing permission. Staff/superusers retain existing access conventions.
- Each WJ user connects their own existing LG account. Typed passwords are forwarded to the fixed LG HTTPS API and never persisted. The LG token is encrypted using a dedicated key derived from the existing Django secret, follows JWT expiry (at most eight hours, one-hour fallback), and is cleared on disconnect or LG authentication failure. The optional cron-only credential configuration below can renew one explicitly bound account.
- Synchronize discovers the latest 30 days of TT094 inbound history, in three-day requests, then refreshes up to five trolley records per request. Direct number lookup and verified photo recognition extend this cache. This is the discovered fleet, not proof of the company's entire fleet count.
- Dates prefer explicit LG modification time, then this system's photo-save/readback verification, then the timestamp inferred from the LG photo filename. Unknown dates remain unknown. Inbound or query timestamps never substitute for a modification date. Filename dates are explicitly labelled estimates, in Asia/Shanghai.
- Choose multiple photos, choose a directory including subdirectories, or drop files/directories. Up to 500 photos can be pending per user. The browser prepares a JPEG at most 1440 px long-side; the backend validates, normalizes and removes source metadata. Unsupported formats are reported for conversion to JPEG/PNG.
- Uploaded images use the existing Cloudinary configuration with authenticated/private delivery. WJ LgentAccess protects workspace and image APIs; approved signed authenticated CDN links serve replicas. Production has no ephemeral local-media fallback. Local test media uses temporary directories.
- Gallery requests use 420 px JPEG previews, at most two simultaneous browser reads, a five-minute WJ-session-scoped browser cache, and a fifteen-minute server thumbnail cache. Opening a photo reads its original on demand. Unchanged metadata sync preserves thumbnails; a changed URL or verified-save digest changes the photo version. LG remains the authoritative source; display replicas are described below.
- Menu re-entry shows cached workspace data immediately and revalidates after thirty seconds. Idle workspace polling runs once per minute, or every five seconds while analysis/verification/save work is pending; hidden tabs do not poll. WJ logout clears the existing React Query cache. A photo read failure displays a retry action, not a missing-photo status. Login no longer waits for a complete fleet sync; initial discovery uses the explicit sync control.

## Mac processing, without a Mac web server

The browser talks only to Render. Render stores photo jobs in the existing `ai_core` queue. The Mac opens outbound HTTPS requests, downloads only the photo bound to its active claim, checks its SHA-256, and combines Apple Vision QR/OCR with the existing Qwen3.8 vision model. Neighboring trolley disagreements go to manual review. Render then verifies the recognized ID and TT094 ownership using the operator's LG session.

Run `local_worker/대차사진분석.command` on the Mac when needed. It uses the existing local-worker environment configuration and Python runtime, drains up to 500 trolley jobs and exits. It does not install dependencies, start/stop the model, create a web listener or modify credentials. It uses the same generation lock as the existing worker/coding gateway and exits without claiming work when AI is busy. If the Mac is unavailable, photo requests remain pending. Photos uploaded after the on-demand worker exits wait for its next launch. This implementation does not automate the ChatGPT desktop app.

## LG write boundary

Analysis and supplier matching do not write to LG. Only explicitly checked, ready photos can be submitted. A duplicate trolley selection is rejected; existing item, grade, problem and memo are preserved. The APK's fixed routing domain is `LGETA` even though the current company and validated trolley are LGENT. The LGENT native permission branch is preserved; do not infer write denial from the `RX` menu value alone.

Immediately before a write, compare both the current LG fields and old photo digest with the matched baseline. Commit a durable photo/cart attempt and audit event before the external POST. A timeout is uncertain and is never automatically repeated. The readback action performs GETs only; it clears the pending attempt only when the current photo digest and preserved fields match the submitted photo. An unresolved mismatch stays blocked for operational reconciliation. Never use `/cart/enter_history` for photo registration.

## Release requirements

New additive schema consists of four LGENT tables (profile, trolley cache, photo queue and save events), a persistent profile device ID, indexes/uniqueness and one additional `AiJob` choice. Existing business tables are not dropped or renamed. Test migrations only in disposable databases until explicit production migration authorization. The existing Render start command runs `manage.py migrate`, so merging/deploying is also a live schema-application boundary.

Use `scripts/check-lgent.py --migration-check`, `scripts/check-lgent.py`, the frontend LGENT contract tests, modern/legacy build, and the trolley worker unit tests. `scripts/check-lgent-postgres-local.py` uses an installed PostgreSQL runtime and a fresh private socket-only cluster to verify migrations and worker/manual-action lock ordering without touching an existing database. CI also runs the project-wide integration suite. Live release acceptance still requires the deployed build, real WJ/LG login, private Cloudinary round trip, Mac claim/result acceptance and a specifically selected real LG photo-save/readback trial. No actual LG inbound or photo record was written during local verification.

## Prepared server change (not applied to Render)

The stage-one PR proposes gthread with eight threads and WEB_CONCURRENCY defaulting to one process on the currently observed 512 MB / 0.5 CPU service. The live dashboard has no WEB_CONCURRENCY or GUNICORN_CMD_ARGS override; its manually configured start command also includes the Render PORT bind. Editing this file does not prove that live command changed. Check connection capacity and memory before increasing process count. The bounded thread review found locks around AppTokenSupplier state, request-local requests.Session usage and Django-managed per-thread DB connections; it is not an exhaustive load certification.

Browser image APIs return private JPEG/PNG bytes with version/rendition ETags with early conditional 304 and one-day caching only for a matching version query. Missing images return uncached 204; authentication is checked before conditional 304 responses. Blob object URLs are released on replacement, query eviction and WJ logout. The Mac worker image JSON contract remains unchanged.

## Stage-two replica (local migration only; not applied to production)

Five additive, blank/default or nullable cart fields hold mirror_key, source SHA-256, source URL, mirrored_at and a sanitized error. Old rows fall back to the image API until copied. Original PNG/JPEG bytes are retained; the mirror asset locator records its extension. Cloudinary originals use authenticated delivery and deterministic trolley/hash IDs with overwrite disabled. Successful LG save/readback links the existing private uploaded asset without another upload. Nothing reads a mirror for match/preflight/reconciliation.

Metadata sync releases the screen before photo copying: each request submits up to five parallel copies with a 28-second response budget. A compact progress count is shown without pausing gallery, matching or saving. A nonblocking mirror-only PostgreSQL advisory lock and snapshot compare-and-set preserve business leases; a claim miss displays LG bytes directly without copying. Errors retain metadata and retry on the next sync.

Workspace exposes stable res.cloudinary.com authenticated signed delivery URLs, including without an LG connection, to authorized WJ LgentAccess users. Thumbnail transformation is w_420,c_limit,q_auto,f_auto; originals have no transformation. Hash-addressed IDs resist guessing, but a leaked signed URL does not expire. No public uploads or account configuration changes. Direct lazy images fall back to the authenticated API once on failure. Local tests use temporary media. TODO: retain old replicas until a separately authorized reference-aware cleanup policy is implemented.

No development Cloudinary account is available, so real transformed CDN delivery and production fleet timings remain unverified. Synthetic/local checks do not establish account compatibility or production latency.

Deployment remains prohibited for this work bundle. Before any future live migration, take the existing database backup, verify the additive migration against a staging copy and confirm the release rollback plan. Rolling back application code can leave the five additive cache columns in place; do not reverse-drop cache data as an automatic rollback. No existing business columns are modified.

## MES shipment plan/status and history

The compact gallery opens **MES 출고 계획 / 현황 / MES 出库计划 / 状态** above bulk photo registration. The modal has plan/status and history tabs, a date rail, photo-status badges, and an exact-cart link back to the gallery. All working badges are 24px high. Reads are lazy and independent of gallery busy/write state. Korean/Chinese and narrow-screen table scrolling are supported.

`GET /api/lgent/shipments/?mode=plan|history&start=YYYY-MM-DD&end=YYYY-MM-DD` uses the existing `LgentAccess` permission and existing authorized MES app-token transport. It does not require an LG connection, issue LG calls, mutate MES/LG, seed carts, or change credentials. The only upstream routes are the existing `outbound_order/_list` and the documented `outbound_order/_list_outbound_record`. Official record contract: https://v3-ali-openapi.blacklake.cn/document/api?detailId=1681109889053823&url=%2Finventory%2Fopen%2Fv1%2Foutbound_order%2F_list_outbound_record . An authorized application must already have access to both routes; a permission/fetch failure is an error, not an empty/unassigned fleet.

Dates use **Shanghai calendar days**, maximum 31 days. Plans use explicit `planAt`/`planTime` from LGENT/LGETA sales orders; associated records are fetched by exact order code even when created before the planned day. History uses the record's actual `createTime`; it is not a query of today's inventory or inferred shipment dates. The live MES UI inspected on 2026-10-20 showed order `20261020LGENT-JIT` planned at 12:00 on Oct 20, with TT0940367/TT0940715 records created on Oct 19. This establishes why planned and record dates must remain separate; it does not establish that a vehicle departed.

Only exact `qrCode` matches to previously LG-verified TT094 carts get photo/update metadata. A TT prefix, order ID, material number, current stock, or free-text remark never establishes cart ownership. Unassigned plans and unmatched identifiers remain visible, separately from missing photos and unknown update dates. MES order status is labelled as MES status; a created outbound record is preparation evidence, not a physical departure confirmation. Reversal records are distinct. Results cache for 60 seconds; incomplete/unstable pagination and range overflow fail explicitly and are not cached as successful data. Read-time joins refresh photo state without altering source records or triggering photo downloads.

Local acceptance uses synthetic order/record fixtures and supplied sample photos; it never calls production MES/LG. Production OpenAPI permission and representative result reconciliation remain deployment acceptance checks.

### External LG changes and continuous read-only synchronization (2026-10-21)

The workspace poll reads WJ only. `/lgent/refresh/` performs a separate bounded LG
metadata check (five known TT094 carts per request, 15-minute attempt freshness).
It patches changed cards only, without locking gallery/upload/match/save controls.
The refresh icon forces a metadata sweep; 30-day/5-year inbound discovery stays
explicit. A full sweep adds time beyond the freshness interval. The inspected APK
exposes no verified modified-since photo feed; inbound history cannot reliably
identify photos changed without a new inbound movement.

A changed LG URL/metadata is only a photo-check candidate. Existing photo dates
are retained until the raw LG SHA-256 is compared with the previous private copy
(or the verified upload digest). Equal bytes reuse the existing Cloudinary asset
and preserve the date. Different bytes set `photo_changed_at` from the later of LG metadata/file timestamps
(or observation time if neither is available). The first copy establishes a
baseline and is not counted as a change. LG metadata modification timestamps alone
never advance the photo badge. `photo_checked_at` records comparisons separately.
An identical-URL replacement without a metadata signal still needs an explicit LG
photo readback; no unverified changed-record feed is claimed.

The existing `production-mes-progress-sync` Render cron keeps its five-minute
schedule and `python manage.py sync_mes_progress_reports` command. After successful
MES processing, it gives LG reads a 60-second budget and starts a new fleet round
30 minutes after the previous round's last run. Unfinished rounds resume on later
five-minute ticks; an in-flight bounded page can extend the budget. MES errors and
dry runs never invoke LG; LG errors cannot fail completed MES processing. No new
cron service or base charge is added, but extra running time can increase usage
charges. The standalone `sync_lgent --seconds 240` command remains available for
explicit bounded runs.

Users explicitly enable `/lgent/auto-sync/`. The existing cron must use the same
database, token encryption key and private media configuration as the backend.
A mismatched encryption key fails closed with `configuration_error` and preserves
the web connection's encrypted token. Never copy secrets into source, logs, or a
task payload. The additive migration 0004 must be authorized and applied before
activation. Deployment is separate from proving that scheduled execution works;
check shared-cron logs and profile progress after rollout. No Mac or open browser
is needed for the server job.

Each subscriber's own encrypted LG connection and current WJ sales access are
required. Without the optional runtime credentials below, expired LG sessions
display a reconnect status. No unsubscribed user's connection is borrowed.
Disabling stops the next bounded page; explicit logout also disables subscription.
Signed cursors persist in the
profile's private sync state; workspace exposes only counts/status/times. Reported
photo change/unchanged counts describe that server run, not lifetime turnover or
all LG edits. Errors preserve prior business data. `checked_at` remains an attempt
timestamp. A shared advisory lock avoids overlapping cron runs and metadata pages;
compare-and-set updates preserve concurrent verified saves and durable write leases.
LG save preflight/reconciliation continue to read LG live.

### Optional scheduled reauthentication (2026-10-22)

The administrator can supply `LGENT_AUTO_LOGIN_WJ_USERNAME` (the owning WJ login),
`LGENT_AUTO_LOGIN_USER_ID` (the exact previously connected LG user ID), and
`LGENT_AUTO_LOGIN_PASSWORD` through Render runtime environment variables. The
existing `shared-secrets` environment group is shared by the backend and cron;
do not overwrite `SECRET_KEY` or any worker/shared-secret token. Never add these
values to the frontend, source, task messages, logs, or a checked-in `.env` file.
Render changes must be deployed before they take effect. No new cron or DB
migration is needed. Environment groups linked to unrelated jobs also expose
their variables to those jobs; a dedicated backend/MES-cron group can narrow this
scope if desired, but creating/linking groups is a separate configuration change.

The existing cron renews only an expired, opted-in connection whose WJ owner and
stored LG identity exactly match those settings. It reuses the issued device ID
and rechecks ENT/TT094/company/menu permissions before storing the encrypted
token. An explicit logout, manual replacement login, disable, or permission
revocation wins over an in-flight renewal. Other users keep manual LG login;
credentials do not create a new profile or grant staff access to this LG account.
LG photo writes/preflight/reconciliation never use this path and are never
automatically resent. A token expiry can pause reads until the next five-minute
cron tick; existing thirty-minute round cadence/checkpoints remain in force.

Passwords stay in Render runtime settings and are not saved in WJ's database.
Only a private keyed configuration fingerprint and retry markers join the
existing sync state; these never appear in workspace output. Authentication or
identity/organization/supplier rejection blocks repeated logins until credentials
change or a manual login succeeds. Transient failures back off for thirty minutes.
Local synthetic tests cannot prove a real account's unattended LG login policy;
after deployment, verify `reauthenticated: 1` in the existing shared-cron summary
and resumed photo comparison counts. This counter contains no account or token.
