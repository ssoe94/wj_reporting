# Saved injection SPEC / MES master comparison

This read-only follow-up is separate from M2 order creation and from material-master update automation. `GET plan-workflow?action=master_gaps` compares the selected date's saved injection `part_spec` values with pure-APP MES material metadata. Machining SUFFIX is not a SPEC source and is rejected for this comparison.

Existing nonblank MES specifications/categories take precedence. A missing provider row, missing field, duplicate identity, permission failure or malformed response is not a blank. Multiple source SPEC values are displayed for a human decision. Category candidates are limited to the four exact part numbers previously confirmed by the user on 2026-10-10; there is no generic SPEC-to-category rule. No candidate is written automatically.

The header, successful-upload notice and upload result provide entry points into a temporary comparison dialog. It shows source plan dates/machines and current MES values, preserves 14px text, allows horizontal table scrolling on mobile, and restores keyboard focus on close. Failed refreshes hide prior results rather than presenting them as current.

No models, migrations, approval stages, permits, credential changes or MES writes are added. Tests cover scoped permissions, no database mutations, explicit blanks vs missing data, preserved existing values, source conflicts, provider failures, focus handling, and Korean/Chinese rendering. Local synthetic previews are not evidence of production master accuracy.

Previously approved one-time master changes are documented separately in `output/mes-metadata-20261010/master-blank-fill-report.md`. Any future automated master update still requires evidence that the provider preserves omitted fields and specific authorization. Role enforcement remains a separate pre-M3 change.
