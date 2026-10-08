# Official ALI OAuth contract audit

The public ALI documentation was fetched without credentials on 2026-10-05 UTC.
This is a source/fixture review, not a provider request or runtime grant check.
It compares the deployed `65e327eb0003ae241d3d93e9b0961d34f61d75fd` client with
the official ALI API documentation (detail API version V7.4.1).

Primary sources:

- [ALI API index](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/api-index.json).
- [User-token exchange, ALI document 1708935281595630](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1708935281595630.md).
- [User information, ALI document 1708935281595627](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1708935281595627.md).
- The site's read-only documentation-detail endpoint
  `https://v3-ali-openapi.blacklake.cn/api/openapiadmin/domain/web/v1/openapi/_get_detail`
  supplies `openapiHost`, method and media types. The request selects only a
  public documentation ID/path/version; it is not an OAuth exchange endpoint.

## Request and response comparison

The ALI transport prefix is
`https://v3-ali.blacklake.cn/api/openapi/domain/web/v1/route`.

| Item | Official contract | Deployed client / result |
| --- | --- | --- |
| Exchange URL | Prefix + `/openapi/open/v1/access_token/_get_user_token` | Exact match; POST. |
| Userinfo URL | Prefix + `/openapi/open/v1/access_token/_get_user_info` | Exact match; POST. |
| Media type | JSON | `requests` JSON serialization sets `Content-Type: application/json`; prepared-request fixture checks it. |
| Required header | `access_token`, described as token | Header name matches; configured string is forwarded exactly. Prefix semantics remain unresolved below. |
| Exchange body | Required string `code`; optional string `grantType`, default `authorization_code` | Both fields sent with that explicit grant type. |
| Userinfo body | Required string `userAccessToken`; optional `grantType` with the same default | Same extracted user token sent; optional default omitted. |
| Envelope | Integer `code`, success example 200; one object `data` | Strict integer 200/object check matches. No invented second `data` layer. |
| Identity/token fields | Integer/int64 `userId`, string `userAccessToken` and `tokenType` | Requires the user-token field, then matches the userinfo integer ID exactly. No app-token fallback or string-ID coercion. |
| Expiry | Integer/int64 `expire`, unit seconds | Duration versus epoch is not specified. It is not used to invent token freshness. |

Userinfo is called once only after a successful, non-redirected exchange with a
nonempty user-token string. HTTP/API rejection, malformed data, nested data without
the token, and an app-token-only response stop before userinfo. Successful identity
verification still returns `expiry_verified=false`, `live_ready=false`.

## Header prefix and grant boundaries

The accessible endpoint schemas say only `access_token` / token. They do not
specify raw token, `appToken ` or `Bearer ` serialization. Public index and SPA
assets did not supply that missing rule. The first-party OAuth guide linked by
the site is [BTMdd3eOio9zEzxWYFNctJzHnzd](https://blacklake.feishu.cn/docx/BTMdd3eOio9zEzxWYFNctJzHnzd);
the [onboarding guide](https://blacklake.feishu.cn/docx/PNNwdvq1LoMFFrxAEN5cLDFWngd)
and [overview](https://blacklake.feishu.cn/docx/IKI2dzj9KoaRGnxBc8ZcF91AnNb)
also require login in this unauthenticated review. No login or access bypass was attempted.

A previously captured official OAuth example passes `appAccessToken` into SDK
methods `getUserToken` and `getUserInfo`. That proves the SDK argument, not its
HTTP header serialization. A captured onboarding section describes app-token
issuance at `/api/openapi/domain/api/v1/access_token/_get_access_token`, returning
`data.appAccessToken` and `data.expire` in seconds. It does not establish an
equivalent `_get_app_token` endpoint or the missing header-prefix rule. No token
issuance endpoint was invoked during this audit.

A bounded check of the public [Blacklake SDK source archive](https://repo.maven.apache.org/maven2/cn/blacklake/dev/oapi-sdk/20240912.01-RELEASE/oapi-sdk-20240912.01-RELEASE-sources.jar)
found a different request interceptor that passes the returned app token unchanged
as an `access_token` query parameter. Its app-token cache uses `expire` as TTL
seconds. That implementation neither proves this documented ALI header contract
nor establishes user-token expiry semantics. It is not a reason to move a
credential into our request URL or to copy its issuance/refresh behavior.

Fixtures verify exact forwarding of synthetic raw, `appToken ` and `Bearer `
values; they do not assert that the provider accepts all three. Do not add,
remove or guess a prefix from those fixtures. Confirm the actual wire-header
contract with accessible first-party guide/SDK evidence before treating this
configuration as reviewed for another real trial.

Earlier review links used HW documentation IDs `1708927945926899` and
`1708930376017421` with these same two endpoint paths. The current ALI index
maps different documentation IDs to those paths. Historical UI records show
permission names, not underlying endpoint IDs. Documentation IDs must not be
treated as runtime permission IDs; that application's persisted grant-to-endpoint
mapping was not newly verified by this public-document review.

## Local verification scope

Synthetic fixtures cover exact full URLs and serialized bodies, required headers,
response nesting, integer-versus-string IDs/API codes, expiry ambiguity, userinfo
gating, absence of app-token fallback, and unchanged identity-only success.
Separate diagnostic fixtures check safe phase reasons, POST invocation counts,
HTTP statuses and bounded int32 API codes, no second POST, no private fields in
logs, and non-throwing logging. API codes come only from already-parsed HTTP200
responses; HTTP error bodies remain unread and no provider message is retained.
They make no real provider request and do not prove credential validity or expiry.
