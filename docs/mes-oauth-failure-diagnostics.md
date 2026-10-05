# Private OAuth failure diagnostics

This local change preserves a fixed failure reason in the existing
`OAuthAttempt.error_code`. It does not change the public failure page, which
continues to return `identity_verification_failed` with HTTP 502. It adds no
routes, models, migrations, credential reads, token issuance, retries or fallback.
Shipping it does not enable OAuth or authorize another real identity trial.

Only an exact `UserContextUnverified` exception with one exact string argument
from the fixed allowlist may supply a stored reason. Unknown exceptions, extra
arguments, string subclasses and provider-supplied strings fall back to a fixed
generic reason. Exception messages, request/response bodies, credentials and
authorization codes are never logged or persisted by this change.

After a caught failure, one best-effort `mes_oauth_identity_failure` WARNING
event contains exactly the safe reason and six fixed metadata fields:
`exchange_http_attempts`, `userinfo_http_attempts`, `exchange_http_status`,
`userinfo_http_status`, `exchange_api_code`, `userinfo_api_code`.
Counts are exact integers 0/1 or unknown (`null`); HTTP statuses are exact
integers 100–599 or unknown. API codes are exact signed int32 values from the
already-parsed top-level `code` field, as defined by the official schema. No API
message or data is logged, and non-200 HTTP response bodies remain unread, so
their API code is unknown. Numeric API codes are observations, not an expiry
diagnosis. There are no actor IDs,
request/response bodies, URLs, digests or exception text. The logging boundary
selects and validates each field again; it never expands an arbitrary snapshot.
Diagnostic collection/handler failure cannot change the public 502 response or
cookie cleanup. A missing log event is not evidence of zero requests.

Counters increment immediately before `Session.post`, so an invalid header can
produce attempt=1/status=null without transmitting to the provider. Session
creation failure stays zero. A second call to the same phase is blocked before
another POST. A concrete client supplies observed counts; no constructed provider
means zero, while an unknown injected provider means unknown. Database error codes
remain pure allowlisted values; no migration is required.

| Stored reason | What it establishes | What it does not establish |
| --- | --- | --- |
| `exchange_header_invalid`, `userinfo_header_invalid` | The request stack rejected header encoding/format. | A provider received a request, or a credential expired. |
| `exchange_request_failed`, `userinfo_request_failed` | The scoped client failed outside successful response decoding, including transport/streaming or session setup failure. | The exact transport cause or whether bytes reached the provider. |
| `exchange_response_decode_failed`, `userinfo_response_decode_failed` | UTF-8/JSON decoding, duplicate keys or unsupported JSON constants failed. | The raw response contents. |
| `exchange_response_too_large`, `userinfo_response_too_large` | The existing 64 KiB response bound was exceeded. | The response contents. |
| `*_http_rejected`, `*_redirect_unverified` | The HTTP/redirect contract was rejected before body parsing. | Credential expiry or the provider's business reason. |
| `*_api_response_invalid`, `*_data_invalid` | The required typed envelope/data structure was absent or invalid. | Whether the live provider changed its contract. |
| `*_api_rejected` | The typed API code was an integer other than 200. | A particular token-expiry condition. |
| `user_token_missing` | No nonempty string `data.userAccessToken` was available. | A token's validity or expiry. |
| `userinfo_user_id_invalid` | `userId` was absent or was not an exact integer. | A different logged-in person. |
| `user_identity_mismatch` | An exact integer `userId` differed from the expected ID. | Permission to perform MES writes. |

`oauth_endpoint_invalid` blocks an unreviewed client path;
`exchange_attempt_already_used` and `userinfo_attempt_already_used` block a second
POST in the same client phase. The legacy `oauth_provider_unavailable` and `userinfo_load_failed` reasons remain
allowlisted for older or injected provider boundaries. The concrete client now
preserves the phase for its bounded header, request, decode and size failures.
Credential origin/presence and internal input guard reasons remain bounded too.

No acceptance rule is relaxed: string API code `"200"` and string user IDs remain
rejected. They are distinguished from a non-200 integer API code and a different
integer user ID. The successful public response remains identity-only with
`expiry_verified=false` and `live_ready=false`.

The attempt is consumed before provider I/O. `consumed_at` proves reservation,
not an HTTP request. The client still makes at most one POST per phase, with
redirects and environment credentials disabled. A generic historical failure
cannot distinguish exchange/userinfo HTTP counts `(0,0)`, `(1,0)` and `(1,1)`.
No local code change can recover diagnostic information discarded by an earlier
deployment. New events record client invocation counts, not provider receipt.

For a narrowly authorized read of an existing attempt, project only `status`,
an allowlisted `error_code`, `created_at`, `expires_at`, `consumed_at`,
`verified_at`, and necessary boolean comparisons. Filter by actor and the exact
trial time window. Do not select digest, session, code or credential values.

Synthetic regression coverage verifies private reason persistence, unchanged
public failures (apart from per-response CSP nonces), consumed-code rejection,
unchanged call counts, strict response validation, and absence of synthetic
secrets from database rows, public responses, app/root logs and formatted
exception chains. Existing isolated SQLite/PostgreSQL runners block external
Python networking and do not load project `.env` files.

The [ALI contract audit](mes-oauth-ali-contract-audit.md) separately documents
verified URL/body/envelope fields and the unresolved credential-prefix contract.
