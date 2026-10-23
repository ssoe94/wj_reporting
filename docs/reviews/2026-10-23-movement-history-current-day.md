# Current-day MES movement history

The production history cache stopped at the last closed Shanghai business day.
On 2026-10-23 the newest stored date was 2026-10-22, checked at 08:03 Shanghai.
Consequently today's receipt in the supplied MES screenshot (ACQ30641403,
100 units, identifier TT0940286) could not appear in that cache. The existing
search also matched material information only.

The history page now includes the current 08:00–next 08:00 business date. When
that date is selected, the page requests an authenticated POST to
`finished-goods/history/refresh/` on entry and offers a refresh button. It reads
the existing MES change-log interface and publishes a complete capture bounded
by its start time. It creates no MES receipts or stock movements. GET endpoints
remain database-only reads. Repeated refreshes within 30 seconds reuse the
successful capture, with six requests per minute per user allowed.

The same immutable revision/group models store open and closed captures; there
is no schema or scheduler change. `period_start` and `period_end` record source
coverage. Open captures stay provisional until a complete closed-day capture
replaces them, even if the clock has passed the next 08:00 boundary. The existing
daily collector still collects the last seven closed dates. Fetch validation,
atomic publication, last-good-data preservation and snapshot pagination apply
to current-day captures too.

Search supports material information and the stored MES QR/cart/label fields.
An identifier-only match projects the daily row, period totals and expanded
details to matching identifiers, preserving exact Decimal quantities. Reused
identifiers remain separate events by MES source ID and timestamp. Receipt
document numbers from a different MES screen are not inferred or invented.
Model searches use stored aggregates without loading event arrays. Identifier
projection is limited to 20,000 candidate events per query; broader requests
return the existing reduce-date-range error before loading those arrays.

Local checks: 29 isolated SQLite backend contracts, four frontend helper tests,
scoped ESLint, TypeScript and modern/legacy production builds passed. A synthetic
browser fixture confirmed current-day refresh and expanded identifier details.

Acceptance requires a deployed current-day capture plus visible confirmation of
the supplied receipt's material, identifier, time, direction and quantity. Local
fixtures and unit tests are separate from that production evidence.
