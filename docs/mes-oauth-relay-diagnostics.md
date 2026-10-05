# Official-button relay compatibility and diagnostics

This is a local candidate based on deployed commit
`65e327eb0003ae241d3d93e9b0961d34f61d75fd`. It has not been deployed and does not
authorize a second live identity attempt.

## Confirmed failure

The 2026-10-05 12:26:47 UTC official MES button opened the registered relay in a
top-level tab, but no callback or provider exchange followed. The deployed relay
rejects every query key except `code` before it navigates to the callback. Its
failure branches return without showing a reason.

Read-only inspection of that existing tab's `PerformanceNavigationTiming`
entry confirmed the original navigation had exactly one `code` key plus the
keys **`random` and `lang`**, with no fragment. Only key names/counts and fixed
booleans were extracted inside the page. No query value, authorization code,
token, raw navigation URL, cookie or storage value was read out or copied.
The source's additional-key guard therefore explains this attempt's stop.

The cleaned address bar alone could not establish this: `history.replaceState`
runs before validation. The synthetic fixture verifies that Navigation Timing
retains original key metadata after address cleanup. This diagnostic inspects an
already existing entry and sends no new navigation or authentication request.

Other observed evidence:

- The current page is top-level; JavaScript works; opener is absent; the referrer
  origin is MES. The relay does not depend on an opener or incoming referrer.
- The public relay returns HTTP 200 and exactly matches the deployed Git blob.
  Its inline-script hash matches both HTML and HTTP CSP. Headers retain
  `no-referrer`, `no-store`, `DENY`, and `Cross-Origin-Opener-Policy: same-origin`.
- The existing page shows only generic processing guidance. The checked console
  error categories were absent. This is not evidence about every possible
  browser error, nor proof that the authorization code itself was valid.
- Official documentation describes query `code`; it does not establish that
  no other keys are sent. The `random`/`lang` compatibility allowance is based on
  the observed official-button request, not an invented provider guarantee.

## Change

Allow only `code` and the observed optional keys `random` and `lang`. Each optional
key may occur at most once. Their **values are ignored entirely**: not rendered,
stored, logged, forwarded, interpreted as a redirect, or trusted as OAuth state.
The relay still requires one nonempty bounded ASCII code, HTTPS, the exact
registered origin/path, top-level navigation, and no incoming fragment. Unknown
keys and duplicates remain failures.

The destination remains the fixed backend callback. Only the code travels in
its fragment; no query metadata reaches the backend. Backend session, CSRF,
one-use attempt, expected-user checks and token handling are unchanged.
The backend fragment contract remains `fragment-relay-v1` because the data sent
to that endpoint has not changed.

Every rejection now shows a fixed, value-free reason. Static fallback text also
distinguishes a script that never starts. Exceptions from history cleanup and
navigation are caught without printing the exception or attempted URL. A
navigation that does not complete shows an error after four seconds and never
retries automatically. No browser storage, telemetry or logging is added.

The inline-script hash in the HTTP header manifest changes together with the
HTML hash. Any future release must ship both; a mismatched header intentionally
blocks the script. Existing frame, form and connection restrictions remain.

## Local verification

`scripts/check-mes-oauth-relay-diagnostics.cjs` uses a fresh temporary profile,
virtual HTTPS responses, a dead localhost proxy, disabled external name
resolution, and interception of every request. It never attaches to the user's
Chrome profile or uses a real provider, session, code or token. Chrome and
Playwright must already exist; the script does not install dependencies.

```sh
node scripts/check-mes-oauth-relay-diagnostics.cjs \
  --revision 65e3 \
  --chrome /absolute/path/to/chrome \
  --playwright-root /absolute/path/to/playwright

node scripts/check-mes-oauth-relay-diagnostics.cjs \
  --revision working \
  --chrome /absolute/path/to/chrome \
  --playwright-root /absolute/path/to/playwright
```

The fixture compares the old generic stall with fixed diagnostics and validates
normal codes, observed provider keys, encoded versus raw `+`, malformed inputs,
duplicates, hostile ignored metadata, unknown keys, fragments, real popup
navigation with opener/noopener/noreferrer, history failure, CSP mismatch,
navigation failure and a non-completing navigation. It checks URL cleanup,
fixed destinations, absent storage, sensitive-output suppression and zero real
provider/API requests. Local success does not establish a live token exchange.

The frontend production build must also preserve the relay bytes and matching
header manifest. See the task's dated result report for actual run counts and
commit identity.

## Live state and remaining work

The single live trial remains start POST 1, official button 1, callback confirm
0, code exchange 0, userinfo 0. Production OAuth was turned OFF and verified at
the same deployed SHA. This diagnosis makes no production configuration or
permission changes and issues no new code or token.

Button-permission revocation Save was submitted, then MES required re-login.
Its persistent readback and removal of Lee's temporary role, preserving Admin,
remain pending normal user login. The button definition is preserved and is
not to be deleted. This local candidate neither completes that cleanup nor
starts another login loop.
