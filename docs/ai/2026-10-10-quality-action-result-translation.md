# Korean quality action-result translations

`QualityReport.action_result` remains the editable source. A separate, additive
`QualityActionResultTranslation` row stores the Korean view, source SHA-256,
prompt version, model identity, generation time and current queue job. No source
report or Excel provenance is rewritten by translation. Existing consumers keep
receiving the source field; the history page also receives a read-only
`action_result_translation` object.

After a source registration/edit commits, a signal queues the current Chinese
text. A duplicate source/version with a current or accepted job does no new work.
The Render backend's existing worker periodic endpoint scans missing/stale notes
from **06:00 Asia/Shanghai** onwards in batches of 30. Repeated polling drains the
initial history and catches up after a Mac outage. Failed generations retry at the
next 06:00 boundary; a newly edited source gets a new job immediately. Blank and
Korean-only notes require no generation. Notes over 6,000 characters remain intact
with failed translation status instead of being silently truncated.

The Mac only makes outbound queue requests. The dedicated
`quality_action_result_translation` job uses the existing one `qwen38` runtime
and shared generation lock. Source-change translations run after interactive
questions/hourly summaries and before historical translation/photo audit work.
The handler never substitutes a deterministic translation or generic summary.
The server verifies the lease, prompt/schema, source fingerprint, codes, quantities,
company names and unsupported completion wording before publishing. Publication
also locks/re-reads the report and rejects a deleted, edited or superseded source.
The source row is locked before its translation row; nullable job joins only lock
the translation row on PostgreSQL.

Korean history shows the accepted translation with a closed original disclosure.
Chinese history shows the source. Editors explicitly open **원문 수정 / 修改原文**;
only the original draft is sent in PATCH. Pending/failed results retain visible
source text. A visible history page polls pending rows every 15 seconds, and the
detail dialog follows the refreshed row. Existing permissions remain authoritative.

## Evaluation and checks

30 actual source notes were read from the live history's newest 20 records plus
the next page's first 10 on 2026-10-10. The final
`quality-action-result-ko-v3` prompt passed 30/30 code/quantity/name/status checks
and a source-to-translation meaning review. Names are protected with placeholders
and restored verbatim; strict JSON schema prevents response-field drift. The
glossary distinguishes machine condition adjustment from assembly, wiping from
washing, and avoids asserting an action sequence absent in a shorthand note.
Ambiguous source wording remains inspectable. Evaluation evidence is local and
is not committed as a copy of operational quality records.

```bash
/Users/macstudio_ted/Developer/wj_reporting/backend/.venv/bin/python scripts/check-quality-translations.py
/Users/macstudio_ted/Developer/wj_reporting/backend/.venv/bin/python scripts/check-quality-translations.py --check-migrations
node --experimental-strip-types --test frontend/tests/quality-action-result-translation.test.ts
npm --prefix frontend run build
```

The focused backend runner uses disposable SQLite without project settings or
`.env`. It covers source retention, read-only serialization, source edits and
rollback, daily catch-up, failed retries, stale job publication, quantities and
company names, and actual worker claim/complete authorization. A disposable
PostgreSQL 17 cluster was also tested with 85 checks (two optional model integration
checks skipped), including simultaneous queueing and publication during a source
edit. No production database is used by these checks. The existing broader runner can
fail in an older local environment missing `cryptography`; the focused runner
does not import unrelated MES OAuth diagnostic URLs. CI uses the repository's
declared full dependency environment.

## Release acceptance

The migrations add a translation table and a job-type choice; they do not alter
existing source data. The existing backend deployment start command applies
migrations before starting the new application. Rolling back application code
can leave these additive structures in place without changing historical notes.

After reviewed PR merge, verify main CI, backend health, fresh build-info commit
and a hydrated live history in both languages. Update the main checkout without
discarding unrelated local changes, then reload only the existing outbound worker
with `launchctl kickstart -k gui/$(id -u)/com.wj.local-ai-worker` once it is idle.
The port-8082 model runtime stays running. Verify server-accepted translation
completion in worker logs and source/translation readback in the page. A tested
06:00 boundary and a configured catch-up loop are distinct from observing the
next real scheduled run. Historical queue draining is also distinct from the
feature becoming available.
