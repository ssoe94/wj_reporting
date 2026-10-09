# Exact draft session bridge

The normal WJ production plan remains available independently of material approval
and MES delivery. This release adds an account-menu diagnostic for the one owner
approved draft, `WJ-IT-CREATE-20261009-001`. It does not enable the general writer.

The fixed payload uses material code `0`, quantity `1`, unit `个`, status `0`,
2026-10-10 08:00 through 2026-10-11 08:00 Asia/Shanghai, without equipment,
input material or process assignment. Actor 18 and the mapped MES identity are
server selected. An explicit prepare stores the request, immutable payload digest
and a maximum 30-minute permit once. Repeat preparation cannot extend that window.

An explicit reconnect carries the prepared UID through the existing login ticket,
restricted backend session and OAuthAttempt. Ordinary unpinned connections retain
their existing behavior. The callback commits the APP issuance counter before
provider I/O, validates current WJ authority, exchanges and verifies USER identity,
and commits encrypted storage. Only then may that exact callback offer its original
APP supply once to the same worker's memory cache. It preserves binding, process,
clock domain and original expiry. No new supply is obtained by status GET, send,
recheck or a failed cache handoff. A failed callback does not refund the counter.

The browser makes prepare, send and readback explicit. Diagnostic POST requests
disable automatic auth-refresh replay. Server admission requires the actual signed
v2 login and current active superuser actor; menu visibility is not authorization.
GET returns bounded metadata and never decrypts USER, reserves authority or enters
the provider broker.

Send requires the existing APP/USER context and fixed permit. It reads the exact
code absence and material inventory/QC baseline, commits a durable create attempt,
rechecks absence under its credential lease and calls only the reviewed create
contract. Timeout, partial response or an uncertain acknowledgement preserves
attempt 1; recovery is read-only. MES IDs are parsed exactly and returned as strings.

Readback compares the exact ID, draft status, output quantity/unit, planned times,
absence of actual start, assignments and related task/inventory/QC/change evidence.
It does not establish verified production-report or inbound totals, complete material
workflow coverage, or absence of all global and delayed tenant automation.

Two additive migrations create the permit table with max-one/short-window checks
and nullable diagnostic UID fields on existing ticket/attempt rows. They do not
modify existing plans, execution history, permissions, secrets or service settings.
Applying them uses the existing approved release/startup migration path.

Acceptance requires isolated authorization/replay/concurrency and migration checks,
Korean/Chinese 1280×720 UI verification, all required CI checks, exact deployed SHA,
unchanged plan/history baseline, and a separately recorded real single-draft result.
Missing existing supply, expired authority/permit, failed mandatory reads or a
security gate stops the trial; there is no automatic retry or fallback issuance.

Deployment must precede the normal reconnect so restarting workers cannot discard
the freshly approved supply. A different worker can safely report supply missing;
durable cross-worker APP storage and global writer enablement remain outside scope.
