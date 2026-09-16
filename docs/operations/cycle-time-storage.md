# Hourly cycle-time storage

Live MES collection remains every 2 minutes. Detailed monitoring is retained for 168 hours by the existing collector; older monitoring is reduced to hourly counters only after rollups and the C/T archive succeed. C/T history has one row per device-hour, with per-part metrics within that hour. Shanghai production days begin at 08:00. Missing evidence remains unknown; compressed historical counters do not establish active C/T.

C/T JSON can be stored using `ct-zlib-json-v1`. It losslessly compresses hourly summaries, calculation evidence and revision payloads. Each object is round-trip verified and carries a SHA-256 checksum. Calculation hashes, timestamps, revision numbers, part attribution and API values are unchanged. No table or evidence is deleted.

## Compatible rollout

1. Deploy the reader-compatible release to both backend and collector. This release continues plain writes by default and understands plain and compressed objects.
2. Confirm both actual running versions. Do not rely solely on CI or a deployment hook returning success.
3. Run `python manage.py compact_cycle_time_history` to measure the serialized size without writing. Then use `--apply --batch-size 100 --max-db-mb 1800 --require-fresh-machines 17` to convert bounded batches. Each batch uses the archive advisory lock. Verify representative API responses before and after conversion.
4. After reader compatibility is live, enable compressed writes by default. Historical backfill can use `archive_cycle_time_history --compact` immediately after step 2.

Never roll back below the compatible-reader release after compressed objects exist. An explicit reverse conversion can be implemented using the same verified `unpack` function if required; it needs capacity planning first.

Physical database file allocation can temporarily rise while PostgreSQL retains replaced row versions. Ordinary vacuum makes their space reusable; it does not guarantee the allocated file shrinks. Do not run blocking `VACUUM FULL` as part of live-board recovery. Measure live column bytes and future growth separately from allocated database bytes and WAL/disk usage.

## Five-minute statistics retention (2026-09-16)

Keep the latest 30 days of 5-minute monitoring rollups. For older complete device-hours, sum the 12 five-minute records and retain one 60-minute record. If a 60-minute record already exists, preserve it and verify shots/active minutes (0.013 rounding tolerance), samples, endpoint counters, machine and maximum power against the 5-minute records. Conflicting or incomplete groups remain untouched. The 30-minute records used by existing historical production screens, raw-monitoring policy, C/T buckets and revisions are unchanged.

`compact_monitoring_rollups --start 2026-06-24T00:00:00+08:00 --max-hours 24` is read-only by default. Use `--apply` to compact verified groups. Each hour commits independently; use the reported `next_start` for the next bounded batch. End is capped at the 30-day cutoff. The collector also checks the two hours immediately before that cutoff after saving its live snapshot. A maintenance failure is logged without discarding the successful collection.

Inspect an initial dry run and record before/after row counts, hourly aggregates and fresh machine coverage when applying to production. Allocated database files may remain the same size; ordinary vacuum makes freed pages reusable. Do not promise immediate disk shrink or run VACUUM FULL.

## Public board history loading

The public endpoint still exposes only one exact part and a fixed 30-day summary. One archive scan builds shared, private cache entries for all part summaries for five minutes; separate requests no longer scan the same archive repeatedly. Part figures remain shot-weighted, with absent/ambiguous evidence unavailable. The board prefetches unique displayed part numbers sequentially into the same React Query cache used by the modal, refreshing every five minutes while visible. Date changes have separate keys; closed-page queues stop. The graph uses a monotone curve that does not overshoot the observed extrema, retains missing-date gaps and labels the maximum/minimum (one combined label for flat data).
