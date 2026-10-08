# MES authentication continuity — local candidate

## Studio continuation — 2026-10-08

One Chrome profile supports sequential WJ users; its tabs share the current WJ
account. Switching waits for the old signed family logout and clears the active
editor, ticket, requests and caches; per-account recovery stays separate.
Credentials remain per WJ actor and exact mapped
MES identity. Separate simultaneous users require separate browser profiles.
This implementation does not activate accounts or widen MES permissions.

An existing valid connection is reused. For a disconnected/expired current
account, the dialog prepares one 60-second, memory-only bridge ticket and offers
one native POST button. Failed/expired attempts require an explicit retry.
Bridge-only browser pages automatically submit their existing CSRF forms for
preparation and callback confirmation. JSON clients retain their response
contract; browser success closes the dedicated tab and the original WJ tab
rechecks the server. Logout, identity mismatch and stale attempts still block.

The live MES custom-page menu embeds the relay and is rejected by its existing
frame protection. The already registered permission-controlled button
`WJLEE_OAUTH_BTN_20261005` (WJ Lee 신원 확인) instead uses 新页签跳转, OAuth2,
`code`, `wj_report` and the exact relay. Its existing landing page was observed
at `/custom/customObject/cust_object9__c`. Only the WJ production callback origin
and v3-ali generic home launch are redirected there by code; configured custom
paths and other deployments are preserved. No provider registration, deployment
setting, credential setting, CSP, X-Frame-Options or permission is changed.

The intended reconnect flow is WJ MES connection → existing MES identity button
→ automatic confirmation/return. An expired MES browser login or a different
MES account still requires the user's normal login/account switch. Lee/WJ18's
old flow was actually reconnected at 2026-10-08 08:30 China time; this is distinct
from acceptance or deployment of this new simplified flow. QC000/QC001/QC003/
QC004 (WJ46–49) were observed inactive with no login/credential history.

## Current checkpoint — 2026-10-06

Owner priority: finish one account/QC's entry, save, finish, readback and board
projection before account expansion, visual work or disposition. Worktree
`wj_reporting-single-qc-20261006`, branch `codex/mes-single-qc-delivery-20261006`,
business base `08e3cf6`. The separate deployed OAuth-only PR91 commit is
`e3f32527f9652a8b86b2db71f6a2b689a1d37a49`; frontend PR90 is
`928c9f8ac6df1613575aac0a2fa2882f9ae648c4`. Neither contains this complete business
candidate. Their authentication deltas are now integrated locally, using the
recorded tree-equivalent local commits `93d29a5` (PR90) and `29e42a2` (PR91).
The relay/CSP and safe diagnostics are retained with the business branch's vault,
session locks, policy checks and `VerifiedUserContext.expire` field. No model,
route or migration was added or duplicated by this integration.

Implemented in this branch: `mes_oauth/app_tokens.py` supplies app credentials
with `MES_USER_OAUTH_APP_TOKEN_SOURCE=server`; default remains `static`.
`MES_USER_OAUTH_APP_CREDENTIAL_SOURCE=dedicated` uses the dedicated pair.
Explicit `existing_mes` selection reads existing server `MES_APP_KEY/MES_APP_SECRET`
without token output or manual copying and requires a declared app ID. That
declaration records operator intent, not provider proof of the key's app binding.
Only an enabled OAuth operation can issue. It validates `data.expire`, subtracts
60 seconds from a maximum one-hour local cache, serializes issuance per process,
and cools down 30 seconds after failure. No automatic retry or user-token refresh.
`app_token_status()` returns only issue-attempt count, UTC request-start time,
returned duration, remaining cache time and fixed supply/source/header enums.
Multiple workers have separate
memory caches, so this is not a deployment-wide issuance quota. App-supply failure
before a QC write preserves the user lease and saved phase without requesting
user reconnection; failure after a write still requires read-only reconciliation.
App `expire` must be an integer duration from 61 to 86400 seconds; epoch-shaped,
missing and unsupported values are rejected, never interpreted as a default
lifetime. This range is a local acceptance bound, not a provider TTL claim.
The official SDK uses app-token `expire` as duration seconds; that does not prove
the separate user-token expiry semantics. Unknown user expiry still prevents
vault reuse. Neither a successful exchange nor userinfo extends that lifetime.

`prepare_inspection_pilot --manifest /private/reviewed.json` validates one exact
request version/result digest and mapping while inspection dispatch is OFF.
`--apply` stores only the local binding/audit. An optional `--allow-single-actor-test`
also requires `single_actor_test_reference` in that exact expiring provider
contract: it records the same actor honestly, permits only a submitted pass/test
result, and leaves normal browser self-approval forbidden. It cannot replace an
existing binding, enable dispatch or contact MES. The manifest consists of
`actor_id`, `request_id`, `expected_version`, `binding` (tenant, QC/work-order IDs,
mapping contract, result digest, permanent label), and `provider_contract` (the
existing exact scoped contract and optional single-actor reference). Prepare
values from the current selected QC; no production values are included here.

Focused synthetic evidence under this branch's private `output/`: app supply and
affected callback/credential tests passed (`app-token-focused.log`); the corrected
single-QC tests passed (`single-qc-focused-final.log`). The latter includes real
local API create/input/submit → server binding → value save/read → finish/read →
persisted individual board projection, with fabricated provider responses. It
does not observe the production browser, Blacklake or dashboard DOM. Initial
preparation validation and a ciphertext-rotation assertion failed; the nullable
pre-read timestamp handling and the assertion were corrected, with failures kept.

The existing business save/finish/readback/projection is implemented locally.
The observed live blocker is exchange HTTP200/API3401 before userinfo. Its cause
is unknown. The owner confirms the manually stored app token came from a server;
that does not establish its issue time, app binding or present validity. The old
handoff calls `inventory.mes.fetch_app_token` with `MES_APP_KEY/MES_APP_SECRET` and
uses `data.appAccessToken`; its marker records attempts/status, not provider expiry.
The OAuth setting is a static copy and does not follow that helper's cache.

The dedicated, opt-in server app-token provider now uses the documented app
response shape with bounded memory caching and no fallback/retry.
It does not reuse the inventory collector's implicit credentials or
its `expiresIn`/3600 expiry guess. Keep the existing user credential boundary for
QC until the provider confirms a supported app-only executor contract. Verify
only the changed token/configuration path and existing affected auth regressions.

Current recovery behavior preserves the encrypted user connection and its
deadlines on transport, malformed-response, HTTP403/5xx and generic API3401
failures. HTTP401, exact numeric API401 or a verified different user require
reconnection; they do not establish expiry. The exact permission marker below
takes precedence over numeric API401. Pre-write failures preserve the saved
phase; post-dispatch failures require read-only reconciliation and never resend
save/finish automatically. The connection API distinguishes service failure503
from reconnect409. Synthetic recovery logs are listed below.

The sections below preserve earlier implementation/acceptance history. Their
multi-stage approval sequence is superseded for authorized local development;
production activation, credentials and exact QC writes retain their actual scope.

Integration checks: `output/pr90-pr91-integration-focused.log` passes the selected
callback/client/identity, app-supply, bridge, unknown-expiry, duplicate-ledger/route
and one-QC flow tests. `output/pr90-relay-local-integration.log` confirms exact PR90
asset bytes, matching CSP and four relay VM cases without opening a browser or
using a network. OAuth/account-activation migration drift checks pass; the
integration diff changes no migration, model or URL registration file.

The parent inspected official CLI `@blacklake-tech-cn/hhzz-cli` 1.5.2: its ALI
app issuer matches this supplier, and routed calls use raw `appAccessToken` in
`X-AUTH`, without a prefix. Sources: [official CLI instructions](https://bl-v3-cli.oss-cn-shanghai.aliyuncs.com/hhzz-cli/.well-known/skills/hhzz-shared/SKILL.md)
and [package metadata](https://registry.npmjs.org/@blacklake-tech-cn%2Fhhzz-cli).
The CLI has no `_get_user_token` operation: this is a concrete header hypothesis,
not proof of OAuth acceptance. `MES_USER_OAUTH_APP_TOKEN_HEADER` now selects
exactly `access_token` (default) or `X-AUTH`; URL/body remain fixed, with no
simultaneous headers or fallback. No CLI was installed or executed here.

Next bounded authentication execution, once its exact live scope is authorized:
check the existing key's app binding, issue one fresh app token, perform one
already-permitted routed QC detail read as control, then exchange one fresh
same-app code and verify userinfo with that returned user token. Stop on the
first failure. Server setting `MES_USER_OAUTH_CONTROL_QC_ID` scopes the optional
control; empty default performs no extra call. A mismatch or read failure stops
before exchange/userinfo. No returned QC values are exposed. This is an
identity-only experiment; the local full business branch has additional schema
requirements and is not an OAuth-only deployment candidate. No live issuance,
exchange, grant, deployment or QC write was performed for these local changes.

Exact `subCode=OPENAPI-DOMAIN/URL_NO_PERMISSION` maps to a fixed permission
reason; numeric3401 alone remains unexplained. Raw subCode/message/body are never
logged. The seven-field identity diagnostic is unchanged; the separate control
event has four fixed fields. Private focused logs: `server-supply-recovery-focused.log`
(27 tests), `permission-subcode-focused.log` (3),
`saved-stage-transient-recovery.log` (1), `x-auth-contract-focused.log` (18),
and `app-control-focused.log` (5). These are overlapping synthetic runs, not
unique-test totals or live MES success. All pass with networking blocked.
The support question remains an unsent draft; current stored-token issue time
and provider key/app association remain unverified.

Updated 2026-10-04. This is a local implementation, not evidence of a deployed
vault or a working production MES integration. OAuth, the SPA session bridge,
and credential storage default OFF. No real credentials or managed keys were
created for this candidate. Synthetic fixture keys are not deployment keys.

## User flow and implemented boundaries

The WJ user menu now exposes MES connection status and explicit connection /
disconnect controls. An authenticated request prepares a 60-second single-use
ticket. A second user action submits it in the body of a native top-level form
into a new tab. Neither the WJ JWT nor the ticket is put in a URL. The exact
frontend Origin, HTTPS, signed login identity, current account permissions,
one-use digest and expiry must match. The resulting backend session is limited
to the three MES connection routes; it cannot enter Django admin or other APIs.
The existing fragment relay and CSRF/nonce/code replay protection remain.

A successful callback checks the expected MES user using the same token obtained
from the code exchange. When storage is OFF it drops the token reference. When
storage is explicitly enabled with a reviewed expiry/key policy, the backend
stores AES-256-GCM ciphertext only. Authenticated metadata binds it to actor,
MES identity, tenant, app, WJ login, authorization/policy/key versions and all
lifetime/activity fields. Tokens never enter browser storage or API responses.
Dropping a Python reference is not guaranteed memory zeroization.

Reuse currently permits **identity_read only**. A userinfo request uses the same
stored user token once; it cannot refresh/reissue a token, widen scope or fall
back to inventory/app credentials. QC read/save/finish authorization is not
provided by this identity feature. `live_ready` remains false.

The user-row lock serializes provider dispatch and acceptance with disconnect,
logout and credential replacement. A callback first commits its one-use code
reservation, then locks/rechecks before bounded provider I/O. Disconnect changes
the login revision, invalidates pending tickets and clears matching ciphertext;
logout also records revocation even if that login never opened MES. A signed,
unexpired refresh can prove a revocation-only logout when access has expired;
it does not issue another access token. Actor/login mismatches are rejected.
The SPA clears its login only after server acknowledgement and preserves a new
account if an old account's delayed response arrives.

Password, active/staff/superuser, profile and permission-group changes revoke
existing MES sessions through signals. Every later use also checks fresh account
state, covering bulk changes that bypass signals. Browser JWT validity for
unrelated existing WJ endpoints is a separate boundary; this feature does not
claim immediate revocation of every previously issued WJ access JWT.

## Expiry is a reviewed contract, not an inferred number

The official [SSO guide](https://v3-ali-openapi.blacklake.cn/document/api?docxHash=EP8bde9TnoyR9LxnEYwckBu4nAd)
describes a code lifetime of five minutes. Provider enforcement of a single
successful exchange has not been independently confirmed; WJ rejects local replay.
The [exchange document](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1708935281595630.md)
and [userinfo document](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1708935281595627.md)
call `expire` integer seconds but do not establish relative TTL versus epoch,
a fixed lifetime, provider revoke, refresh or silent SSO reentry semantics.

`continuity.py` requires an explicit expiry mode and reviewed contract reference;
no real mode is selected. Relative expiry conservatively starts before exchange.
The earliest provider, consent, configured connection maximum and idle expiry
wins, with a safety margin. A maximum of 24 hours is a WJ implementation bound,
not a provider lifetime claim. No operational duration is activated. Unknown
expiry, missing keys, changed binding or expired/revoked state prevents reuse.
A userinfo response never extends provider or consent expiry.

## Files, migrations and maintenance

- `backend/mes_oauth/vault.py`: encrypted persistence, binding checks, serialized
  identity read/revoke, key rotation and expiry cleanup.
- `backend/mes_oauth/connection_views.py`: JWT metadata API, ticket bridge,
  restricted backend sessions and revocation-only logout.
- `backend/mes_oauth/views.py`: existing OAuth start/callback with final policy
  checks and optional encrypted persistence.
- `backend/mes_oauth/signals.py`: local account/authorization invalidation.
- Migration `0002_mescredential_mescredentialevent_mesloginsession_and_more.py`
  only creates four tables. It does not alter/drop existing QC or replay tables.
- `frontend/src/components/MesConnectionDialog.tsx`, AuthContext and auth helpers:
  status, native form, account-scoped asynchronous responses and confirmed logout.

`cryptography==50.0.2` supplies AESGCM; deployment must provision an independent
managed 32-byte key, never reuse SECRET_KEY. Active/old key identifiers support
explicit rotation without renewing expiry. `rotate_mes_credential_key` and
`purge_mes_credentials` are dry by default and require `--apply` to mutate.
Expired credentials cannot be used, but physical cleanup requires an approved
job/operator invocation. No production cleanup scheduler has been created.
Audit rows contain fixed action/reason codes and server actor/time only. There is
no update/delete API or admin registration; this is not a claim of DBA-proof
immutability. Backup ciphertext retention and key destruction need an operational
policy. Rollback must preserve additive tables and the code-replay ledger.

For the combined inspection candidate, deploy additive migrations first, then
the backend/logout endpoint, then the frontend. Account signals and confirmed
logout use the new tables even while OAuth is OFF. The already-deployed OAuth
replay table is preserved; this candidate adds four vault/session tables and
five inspection tables. Inspection user foreign keys impose a separate old-code
account-deletion limitation after related rows exist. Do not promise the broader
schema can be rolled back by deleting tables or running reverse migrations.

## Acceptance and remaining operational actions

Use the private fixture logs named in the final work report for exact run counts.
SQLite is useful for behavior; PostgreSQL is required for row-lock races. The
browser fixtures use actual fresh Chrome with synthetic requests. The separate
Chrome-to-Django loopback HTTPS run at 2026-10-04 11:51:42 UTC passed 39 checks,
including automatic native POST→302→GET, CSRF and relay/callback; no driver
navigation or cookie bootstrap substitutes for that redirect. Its synthetic
certificate uses an SPKI exception. Proxy forwarding was loopback-only, while
23 unlisted CONNECT attempts and one plain HTTP background request were blocked;
unexpected page requests were zero. See [integration acceptance](mes-continuity-integration-acceptance.md)
for the private evidence location and boundaries. This transport fixture does
not mount React or validate production TLS, provider consent, real user mapping,
actual MES mutations or OS-level network isolation.

Before a real integration trial, separately approve and verify:

The first identity-only trial need not deploy this continuity candidate. If the
existing backend is verified at `65e327eb` with `mes_oauth.0001` applied, its
ordinary Django login/start/relay/callback path can verify identity and discard
the token without new migrations or deployment. It does not need the JWT bridge
or vault. Deploying `c5289da` instead adds four tables; the integrated `69146dc`
adds nine tables relative to `65e327eb`. User-token storage OFF does not remove
those newer runtime schema dependencies. Keep the full inspection beta out of
the first identity trial and defer its publication until real MES writes have
been separately verified. The numbered approvals below apply only to the exact
chosen runtime; they do not imply deploying the entire integrated candidate.

1. Exact WJ-account/MES-user mapping and the allowed pilot account. The current
   identity boundary remains active staff superuser; do not make field operators
   admins to bypass it. Their operational permission policy is still required.
2. A dedicated wj_report app credential and its official issuance/scope contract,
   supplied directly into the backend secret store without chat/log/browser
   storage. The inventory credential fallback is not acceptable.
3. An actual reviewed MES custom launch page/button, selected app and existing
   registered relay, including top-level browser behavior. Do not invent an
   authorization URL or silently enable OAuth.
4. Before the first trial, separately approve its exact runtime SHA, deployment,
   required additive migrations, dedicated app-secret storage, pilot mapping,
   reviewed launch and OAuth/bridge activation. User-token storage stays OFF;
   that does not waive approval for storing the app credential. Keep inspection
   dispatch disabled and identify a rollback/deactivation action in advance.
5. First trial: one fresh code exchange and one same-token userinfo read for the
   approved account, no MES/QC writes or automatic retries. Verify identity,
   consent scope and exact expiry semantics before persistence.
6. Only after that evidence, approve the managed vault key, configured lifetime /
   retention values, user-token storage activation and cleanup job. No merge,
   deploy, real credential storage or MES write is implied by local tests.
   Inspection completion remains distinct from production completion.
