# LGENT trolley management

Status: implemented and verified with disposable fixtures; not a claim of production deployment or live LG photo acceptance.

## Entry and operation

- Sales → 대차관리 / 台车管理, `/sales/trolleys`; Korean/Chinese follows the existing language switch.
- WJ sales viewing permission is required; uploading, analysis, matching and saving require sales editing permission. Staff/superusers retain existing access conventions.
- Each WJ user connects their own existing LG account. Passwords are forwarded to the fixed LG HTTPS API and never persisted. The LG token is encrypted using a dedicated key derived from the existing Django secret, expires locally after one hour, and is cleared on disconnect or LG authentication failure.
- Synchronize discovers the latest 30 days of TT094 inbound history, in three-day requests, then refreshes up to five trolley records per request. Direct number lookup and verified photo recognition extend this cache. This is the discovered fleet, not proof of the company's entire fleet count.
- Dates prefer explicit LG modification time, then this system's photo-save/readback verification, then the timestamp inferred from the LG photo filename. Unknown dates remain unknown. Inbound or query timestamps never substitute for a modification date. Filename dates are explicitly labelled estimates, in Asia/Shanghai.
- Choose multiple photos, choose a directory including subdirectories, or drop files/directories. Up to 500 photos can be pending per user. The browser prepares a JPEG at most 1440 px long-side; the backend validates, normalizes and removes source metadata. Unsupported formats are reported for conversion to JPEG/PNG.
- Uploaded images use the existing Cloudinary configuration with authenticated/private delivery. Only authenticated Render endpoints serve images. Production has no ephemeral local-media fallback. Local test media uses temporary directories.
- Gallery requests use 420 px JPEG previews, at most two simultaneous browser reads, a five-minute WJ-session-scoped browser cache, and a fifteen-minute server thumbnail cache. Opening a photo reads its original on demand. Unchanged metadata sync preserves thumbnails; a changed URL or verified-save digest changes the photo version. LG remains the authoritative source; this is not a permanent Cloudinary mirror of existing LG images.
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

Browser image APIs return private JPEG/PNG bytes with content ETags and one-day caching only for a matching version query. Missing images return uncached 204; authentication is checked before conditional 304 responses. Blob object URLs are released on replacement, query eviction and WJ logout. The Mac worker image JSON contract remains unchanged.
