# One-use self-set activation — local release candidate

This candidate adds a backend-only first-password path for at most four
explicitly approved, inactive accounts with unusable passwords. It does not
grant roles, send email, issue temporary passwords, or automatically log in.
Existing account creation, reset-password, change-password and login routes
retain their behavior. No operational account was activated by these tests.

## Concrete entry points and settings

- Existing Django administrator session →
  `/admin/account_activation/activationgrant/` → “최초 활성화 링크 발급 / 취소”.
  Issuance requires an active staff-superuser, session authentication, CSRF,
  exact HTTPS Origin, explicit owner/approval confirmation, and an approved
  target. Bearer authentication and the restricted MES bridge session are refused.
- Recipient opens `/accounts/activate/#<selector>.<random-secret>` in a top-level
  browser and personally sets the password. Fixed backend routes under
  `/accounts/activate/assets/` deliver the scripts/styles; no separate static
  service or frontend release is required. GET never consumes a grant.
- `ACCOUNT_ACTIVATION_ENABLED` defaults to `False`.
  `ACCOUNT_ACTIVATION_APPROVED_TARGETS` defaults to `{}`. Its JSON object maps
  an exact WJ user ID string to `username`, `policy_digest`, and `reference`.
  The map is limited to four entries and contains no actual identities in source.
  `services.policy_digest(user)` fingerprints the reviewed identity/profile,
  direct/group permissions and their meaning; it excludes password/active so
  activation cannot silently confer authority. Privileged targets are refused.
- Fixed production origin: `https://wj-reporting-backend.onrender.com`.
  HTTPS, DEBUG=False, secure host-only cookies, HttpOnly Lax session cookies,
  DB sessions, exact Origin and CSRF must all pass. The helper does not configure
  these settings, deployment credentials, email, or user roles.

## One-use transaction and exposure limits

`account_activation.0001_initial` creates exactly two independent tables:
`ActivationGrant` and `ActivationRateBucket`. There are no user FKs and no edits
to existing migrations. Grants contain random selectors, keyed digests, numeric
actor IDs, approval/credential fingerprints and lifecycle timestamps. Raw links,
passwords and request bodies are never persisted in these models or admin history.

A grant expires after 15 minutes; at most one pending grant exists per target.
Losing an issuance response does not reissue or reveal its link: the administrator
must explicitly cancel the outstanding link before issuing another. The issue
page clears its raw link on page exit/restoration. Recipient script removes the
fragment immediately, keeps it only in memory, clears password inputs on submit,
and uses no browser storage. An uncertain POST/timeout clears the in-memory
token and never automatically retries. Password validation failures permit a
deliberate correction within the original expiry/rate limit.

Consumption locks issuer → target → grant/profile, verifies current inactive /
unusable state and exact approval/credential fingerprints, validates the new
password using the existing Django validators, and atomically sets password,
active status, profile password-change metadata and consumed status. Existing
refresh blacklist and MES revocation helpers run in that transaction; Django
session authentication fails after the password hash changes. No automatic login
or MES/provider operation occurs.

PostgreSQL SHARE locks on the four permission / membership tables freeze the
approval fingerprint during the short transaction because older role editing
paths do not share a per-user lock protocol. They allow ordinary reads while
briefly delaying permission writes. A three-second lock timeout or deadlock
fails closed and rolls back the activation. The PostgreSQL tests cover issuer
revocation and permission changes winning before activation.

Rate limits use atomic, shared DB counters in fixed 15-minute windows: 40 per
action/source, 10 issuance actions per issuer, 8 per target and 8 consumption
attempts per selector. Source keys are HMAC digests of `REMOTE_ADDR`; forwarded
headers are not trusted. A shared ingress address may share a bucket and fail
closed. Expired buckets remain as metadata: **no scheduled cleanup is implemented**.
Review retention and bounded cleanup before broad use; no operational deletion
is included in this candidate.

## Verification evidence

All verification uses synthetic identities and isolated fixtures; no credentials,
existing account passwords, QC rows, provider or production database were read.
Verification completed locally on 2026-10-04 by 13:34 UTC.

- `output/activation-sqlite-final.log`: **29 run, 24 passed, 5 PostgreSQL-only
  concurrency tests skipped**. System checks and migration consistency passed.
- `output/activation-postgres.log`, fixture `output/pg-ac1/test.log`:
  **29 passed**, including concurrent single consumption, one pending issuance,
  rate counter saturation, role/issuer changes, atomic rollback, password
  validation, CSRF/Origin/Bearer rejection, additive migration and prior-session
  revocation. Only this newly created UNIX-socket cluster was started/stopped.
- `output/activation-dom.log`: **7 passed**, covering fragment removal, input
  clearing, uncertain response, no automatic retry/login, page restoration,
  iframe/HTTP rejection and duplicate-click suppression.
- `output/activation-chrome-2.log`: **1 actual Chrome scenario / 11 assertions
  passed** on Chrome 154.0.8037.93. Administrator session form issuance → fresh
  anonymous recipient browser → fragment removal → real form password POST →
  consumed-link replay rejection → ordinary `/api/token/` login succeeded.
  There were 15 intercepted Django requests, zero external requests, no detected
  secret in URL/Referer/console, and no browser token storage. Transport was
  **virtual HTTPS via Playwright interception/Django Client**; this does not
  establish public TLS, real ingress behavior or actual account acceptance.
  The initial browser fixture password was rejected for similarity to its
  synthetic username; only the fixture password was corrected, with validators
  unchanged. The original failed fixture log is preserved.
- `scripts/check-mes-oauth.py` includes this app in default SQLite/PostgreSQL
  labels and checks its migration consistency, so the existing CI commands pick
  up these tests. The Chrome scenario is explicit and requires already installed
  Node, Chrome and Playwright; it never installs them.

## Release and owner handoff gates

1. Review the final exact commit (filled by the parent release review), exact
   account identities and separate approved role policy. Confirm pending grants
   were not accidentally created while preparing accounts.
2. Approve the backend release and additive two-table migration separately from
   implementation. Complete the approved DB backup and check table metadata;
   no deployment or operational migration was performed here.
3. Verify ingress/application monitoring never records request/response bodies
   containing activation links or passwords. Application no-store, CSP, generic
   errors and sensitive-variable/body protections do not prove ingress redaction.
   Use a synthetic marker before any real issuance. This remains unverified.
4. Review exact-origin/cookie delivery and any shared ingress rate-limit effects,
   then approve the allowlist/config enablement. Keep all role grants separate.
5. An authorized administrator confirms the intended person and sends the
   one-time link through an approved private channel. Email addresses are
   unverified, so no email dispatch is provided. Hand browser control to that
   person for password entry; no shared/temporary password, screen capture or
   password collection by the agent. The person then uses the existing login.
6. Verify the actual account identity and approved work permissions/workflow
   separately, recording only safe outcomes. **Actual four-account activation,
   owner-entered passwords and operational workflow acceptance remain undone.**

Rollback first disables the flag, then restores the reviewed earlier code while
retaining both additive tables/digests; no reverse migration is needed by default.
Disabling the feature invalidates pending activation use, but does not revert an
already activated account or reset its password. Any account deactivation or role
change requires its own approved action.
