# Weekly inspection declarations

The default settings screen has exactly four cards: DAY dimension, DAY appearance,
NIGHT dimension and NIGHT appearance. A saved display name can be selected or a
new name entered. Names are declarations, not WJ login accounts, MES USERs or
permission grants. NFKC, collapsed Unicode whitespace and casefold normalization
reuse the same name; an optional short note separates homonyms.

`GET /api/quality/inspection-requests/weekly-role-settings/?week_start=YYYY-MM-DD`
is read-only. The week starts on Monday in Asia/Shanghai. Only an existing
authorized unrestricted administrator can enumerate or configure the roster.
Existing restricted pilots receive no roster enumeration or configuration access.

`POST` requires the verified current inspection login, `Idempotency-Key`, the
current week version and exactly four distinct shift/area slots. Each slot selects
`inspector_id` (a roster ID or null), or supplies `display_name` and an optional
`distinguishing_note`. Unknown actor, account, grant and time fields are rejected.
The response contains the whole current week and authenticated `actor_id`.
Same-key replay preserves the original response; a stale version returns 409.
Both rows and names roll back on failure under the same global shift lock used
by legacy settings and request assignment capture.

DAY is 08:00–20:00; NIGHT is 20:00–next day 08:00. The final Sunday NIGHT ends on
the following Monday at 08:00. A pair remains inactive until both distinct names
are present. Existing overlapping legacy schedules are rejected rather than
silently shortened. Legacy PATCH cannot change a week-managed shift. Changing a
future declaration never rewrites an already captured request assignment.

Migration 0017 adds only two display-roster/week tables, four nullable person
references and a normalized name/note unique constraint. It creates no people,
accounts, credentials, grants or inspection results. Migrations 0015 and 0016
retain shared-terminal provenance and the separately grounded final decision.

Display-name role entry requires an explicitly configured existing authenticated
terminal. `inspector_person_id` selects the declared human; it cannot be sent as
`inspector_id` to impersonate a WJ account. Item and completion provenance keep
the display inspector and actual WJ recorder separately. Approved whole-result
submission also keeps the independently authorized MES executor and reviewer
separate. Numeric roster IDs never become authentication contributor IDs.

# Machine cards and MES evidence

The desktop picker displays 17 machines in two rows of nine and eight. Current
PartNo, product and production state retain their source labels. WJ local request
counts are separate from MES evidence. Status uses both color and short text.

The optional signal DTO requires exact machine, business date, local plan/version,
work/task/plan identity, complete verified evidence, observation time and a
server-issued freshness expiry. It keeps first, production and periodic kinds
separate. Completion green requires current running work, exact binding, fresh
verified MES completion/pass and a resolved successful first-inspection sequence.
Stopped, stale, changed, missing, failed or ambiguous evidence cannot become green.

Overdue is based only on an actual verified MES deadline. No 105/135-minute rule
is installed. Without an official deadline the screen shows factual waiting or
request elapsed time; refresh time never substitutes for inspection completion.
The current production reader supplies no live machine-bound signal batch, so
production shows unknown MES status. Synthetic fixture cards are explicitly
labelled and cannot establish live field acceptance.

The whole-save protocol and provider boundary remain described in
[inspection-full-snapshot-contract.md](inspection-full-snapshot-contract.md).
No provider policy, credential issuance, external CAS or writer fence is enabled
by this UI release. The established single-inspector path remains available under
its current authority; the independently reviewed whole-result path blocks until
a server-owned reviewed connection is available.
