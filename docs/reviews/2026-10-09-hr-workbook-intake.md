# Company payroll workbook intake

Company classification is registered once as a private system default. HR then uploads only contract/hourly payroll workbooks; monthly payroll ingestion remains an explicit user action.

## Input and classification

- Classification workbook: one populated sheet, headers `分类`, `姓名`, `部门`, `雇用性质`; `工号` is optional.
- Payroll workbooks: explicit contract/hourly type, month/year, employee code/name, source department, and `应发工资`. Multiple months may be consecutive rows in one sheet. All populated sheets must have recognized headers.
- Match the supplied roster by normalized name plus employment type; when the roster supplies a code, check its identity consistently. No fuzzy matching. Payroll department/title never infer a cost cell.
- The two generic general-manager categories can be disambiguated only by the previously supplied organization chart. Unknown functions remain unassigned and can be reviewed by source row without revealing names.
- Management rows map to each department's root cost cell; worker/function rows map to its children. Development management/staff remain separate. Incoming/outgoing inspection share `quality-oqc`.
- Missing or conflicting employee codes require explicit review; retain the original code and source file/sheet/row. Never auto-correct identity from another month.
- Use cached Excel values, never execute formulas. Text fields may have cached text results. Money requires a numeric cache; numeric values beyond two decimals may use a valid two-decimal Excel display only within half a cent. Show a warning. No absent wage becomes zero.

## Save contract

`GET classification-reference/` is read-only and returns the independent company master and its version. `PUT classification-reference/` validates and resolves the roster, checks its version, and saves it with server-attributed history. This can happen before any payroll month exists. Payroll uploads never replace this master implicitly.

`POST workbook-preview/` uses the selected master version to compute deterministic assignments and exact monthly Decimal totals. `POST workbook-import/` verifies that version, the preview token, all month versions, fingerprints and totals. It locks the company reference first, then selected months in chronological order, and saves the entire batch atomically. An inline reference is also accepted for compatible API clients, mutually exclusive with the master version.

For each selected month, replace the employment types actually included in that month's upload. Retain other employment types and unmatched legacy records whose type is unknown. Preview the retained count. Keep manual allocations by default, or explicitly reapply the reference. Reject incompatible currency/basis when old rows would be retained.

Monthly storage uses existing workspace JSON and audited history. The additive migration `analytics.0004_hr_classification_reference` creates two new tables for the company reference and its history, with singleton and history-version constraints. It does not alter existing rows/tables or contain real employee records. Source metadata contains the exact roster snapshot/version and file records; each employee retains payroll provenance. Changing the master does not rewrite past months. Monthly manual allocations are preserved on re-upload by default; they do not silently rewrite the company master or other months.

Access continues to require active superuser or explicit HR grant at the API, including all new endpoints. Responses are private/no-store. Screens show employee numbers, with existing five-digit formatting, and source coordinates rather than names. The supplied roster is registered through the authenticated production interface after release, never embedded in a public frontend bundle or repository fixture.

The existing application remains compatible with the additive schema during rollout. Application rollback can leave the new tables intact; production reversal of the migration is unnecessary and would delete its newly stored reference/history. Initial deployment must include the new migration before the frontend's default-reference flow is used.

Limits: 10 payroll files, 10 MB per file, 24 selected months, 25,000 batch rows, 5,000 people per month/reference, 5,100 physical rows per workbook, 200 columns, 50 sheets, 6 MB API payload.

## Validation

- `scripts/check-hr.py` includes `analytics.test_hr_workbooks`: permissions, reference matching, partial replacement, exact money, preview tampering, stale-month conflict, rollback of a partially written batch, original-code evidence, missing legacy costs, and idempotence.
- `frontend/tests/hr-workbook-import.test.ts` uses synthetic worksheets for parser precision, cached formulas, ambiguous periods/identities, manual code corrections and limits.
- Real source workbooks are read-only local acceptance inputs, never repository fixtures. UI save/reload checks use disposable synthetic data.

The isolated HR suite includes standalone reference permissions, empty/read-only GET, version conflicts, immutable past-month snapshots, audit rollback, and payroll-only import preserving later manual allocation. Its PostgreSQL run also verifies concurrent initial registration has one winner and a concurrent reference update invalidates a pending payroll commit. All 69 PostgreSQL checks passed against a disposable local cluster; no project `.env` or live database was used.

Final local checks passed 65 frontend HR tests, the modern/legacy build and targeted ESLint. SQLite passed 67 checks and skipped the two PostgreSQL-only concurrency checks; PostgreSQL passed all 69. Browser checks covered Korean/Chinese labels, standalone roster registration with no payroll, unknown-category correction, reference auto-loading after reload, payroll-only seven-month save, and reference-conflict recovery retaining files and corrections. Earlier intake checks also covered character-by-character code correction and partial employment-type replacement; both source filenames survive a partial replacement.

Read-only acceptance of the supplied files resolved all 130 classification records and parsed 907 employee-month rows across January–July without blocking issues. Ninety numeric-cache precision notices and five same-name/different-code notices remain visible review warnings; employee identities are not guessed or silently merged. Real payroll persistence is reserved for the user's later upload. Release/production registration evidence belongs to the release result, not these local checks.
