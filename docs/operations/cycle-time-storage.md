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
