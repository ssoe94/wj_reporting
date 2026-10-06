# MES OAuth relay hardening candidate

Prepared 2026-10-04. This is a local implementation and release proposal, not
evidence of deployment, a provider grant, consent, token issuance or live MES
read/write readiness. It supersedes the direct backend callback and backend-only
release scope in `mes-oauth-only-release.md` for this candidate. OAuth remains off.

## Why the callback changed

A non-secret synthetic callback query was present in a Render web-service HTTP
request log even though application/access messages omitted that query. That
upstream log exists before Django can redact it. Browser history cleanup and
application logging filters cannot remove an already recorded request URL.

The new fixed provider SSO/return URL is:

`https://wj-reporting.onrender.com/integrations/blacklake/relay.html`

It is a physical, standalone static asset, independent of the SPA. It accepts a
single printable ASCII code (1–4096 characters), removes the query from the
current history entry, and navigates only to the fixed backend callback with
`#code=...`. HTTPS, the exact relay origin/path and a top-level window are required.
Unexpected parameters, duplicate codes, fragments and framed execution fail
closed. There are no external assets, fetches, storage writes or token exchanges.

The backend callback receives no code in its HTTP GET URL. Its hash-authorized
script clears the fragment, puts the code into a hidden field, and enables the
confirmation button. The native same-origin POST retains CSRF, exact Origin,
eligible session, host-only nonce, expected identity and one-use attempt checks.
Query-bearing callback GET and POST requests are rejected without consumption.
The policy fingerprint includes the relay contract so older attempts cannot
silently cross this change. `strict-origin` on the backend preserves the native
POST Origin; `no-referrer` on the relay suppresses its outgoing Referer.

Render's [logging documentation](https://render.com/docs/logging) says static
sites do not emit logs. This avoids the observed web-service request-log path;
it does **not** establish that Render/CDN internal infrastructure never processes
or retains a static request query. The initial provider GET necessarily reaches
the static host with its code. Resolve that remaining retention boundary before
claiming complete ingress exclusion or using a real code. External log-stream
exclusion does not disable internal collection.

## Exact release scope to review

1. Publish and review the exact candidate commit and CI evidence. No merge to
   `main` or automatic change to cron/collector services is implied.
2. Keep `MES_USER_OAUTH_ENABLED=False`. Deploy the pinned backend candidate and
   the frontend artifact containing the physical relay. This now requires a
   separately reviewed frontend release as well as a backend release. Compare
   each service's current live SHA with the candidate before approval.
3. Apply all seven headers in `deploy/mes-oauth-relay-headers.json` to that exact
   static path only. The JSON is a review manifest, **not** an automatically
   applied Render configuration. Its HTTP CSP includes `frame-ancestors 'none'`;
   HTML meta CSP alone cannot supply that directive. Recompute the hash after
   every relay script edit and check both meta and HTTP CSP against the build.
4. Preserve existing rewrites, including the SPA fallback. Render's
   [rule ordering](https://render.com/docs/redirects-rewrites#rule-matching-and-ordering)
   serves an existing physical file before rewrite rules. Verify the actual
   deployed relay body, MIME, hash and all headers with a non-secret marker;
   do not assume the local build proves hosted behavior.
5. The minimum backend setting changes are `DEBUG=False`,
   `SESSION_COOKIE_SECURE=True`, `CSRF_COOKIE_SECURE=True`. Do not change
   `ENVIRONMENT`, HSTS, SECRET_KEY, session backend, cookie domain or SameSite as
   a shortcut. Check actual external HTTPS/session/CSRF behavior and media
   readiness. A production storage gate passing does not prove credentials work.
6. Only after the logging/return conditions are resolved, review a distinct
   activation scope: the two documented user-token/user-info API capabilities,
   one relay URL registration, one reviewed top-level provider launch, one
   expected local-to-MES identity map, review reference and a securely supplied
   dedicated app access token. Do not invent an authorize URL or fall back to
   the inventory token provider. Credential provisioning/issuance is not
   implemented by this candidate.

The actual provider launch window type, consent scopes/duration, user-token
`expire` interpretation and app credential validity remain unverified. The
current contract rejects iframes; do not weaken cookie or frame policy merely
to accommodate an unverified launch. Code lifetime (five minutes) is a separate
fact from token/grant lifetime. The token is used only for one user-info call in
the same request and discarded; the database stores digests and bounded attempt
metadata. `identity_verified` does not imply `expiry_verified` or `live_ready`.

## Existing login and rollback

Setting DEBUG off and cookie Secure on does not rotate session/JWT signing keys
or delete sessions. Existing database sessions and JWT access/refresh credentials
remain valid under unchanged keys/settings; newly set Secure cookies are sent
over HTTPS only. Test existing and new HTTPS sessions after deployment. DEBUG
off removes development `/media/` serving; authenticated content API routes stay.
Do not mistake storage configuration presence for an actual upload test.

Record the exact previous values and live SHA before any approved change.
Rollback begins by keeping OAuth off, then restoring that reviewed code and
explicit environment values as needed. Code rollback alone does not revert
environment variables. Already issued Secure browser cookies do not immediately
lose that attribute on server rollback. Preserve the attempt table/replay digests,
SECRET_KEY, database and existing sessions. Reverting code does not revoke a
provider grant or remove a registered SSO URL. Never replay an uncertain exchange.

## Local verification and its limits

The isolated SQLite/PostgreSQL suite covers callback failures/replay/concurrency,
configuration guards and existing session/JWT/admin/media readiness. The actual
Chrome harness loads the relay source with the manifest headers and uses both
real hostname strings under intercepted virtual HTTPS transport. Every request
is fulfilled locally or blocked; no provider/Render connection occurs. It checks
native form Origin/Referer, CSP, invalid inputs, frame rejection, URL cleanup,
cookie separation, storage non-use, one exchange/user-info mock and replay 403.

Run `scripts/check-mes-oauth.py`, `scripts/check-mes-oauth-postgres-local.py`
with a fresh owned fixture name, `scripts/test_mes_oauth_cookie_settings.py`,
and `scripts/check-mes-oauth-browser.py` using existing installed dependencies;
run `npm run build` under `frontend/`. Store dated exact-run evidence privately.
Virtual browser transport does not verify real TLS, Render headers/logs, provider
navigation, actual consent or field acceptance. No MES QC write adapter is wired.
