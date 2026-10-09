# Integrated inspection UI review — 2026-10-07

Local implementation and synthetic verification completed; final deployment is recorded separately in the release handoff.

The primary week settings show exactly four DAY/NIGHT dimension/appearance cards, only a display name and applicable week. Desktop equipment cards show seventeen machines in nine/eight rows with readable PartNo and source-labelled MES/WJ status. No invented overdue threshold is used. Existing item tables, scoped area saves, the separate final decision and durable MES reconciliation are retained.

Verified current captures: `weekly-four-card-visible-20261007-03-assignment-synthetic.png` and `inspection-machine-cards-final-20261007-02-list-synthetic.png`. These use intercepted synthetic data only. The combined browser harness passed 64 checks including keyboard, Chinese desktop, narrow layout, week navigation and synthetic name-save persistence; the final machine-only refresh passed 22 checks. Frontend inspection tests passed 326 checks and the modern/legacy production build passed. A long mobile element export has a fixed-header overlay and is not published as a clean visual.

Production machine-bound MES observations remain unavailable. Synthetic green/request/overdue examples are explicitly labelled and do not establish actual MES state or field acceptance. No account/grant/token creation, production QC resend or flag toggling was performed in this integration.

---

# Alignment, language and single-choice appearance revision — 2026-10-07

final result: passed (local code and synthetic preview; no production deployment)

Aligned both card headers, five shared column widths, 40px desktop body rows,
36px table headers, centered value/verdict/save-state columns and 34px footer
buttons. Dimension and appearance cards stretch to equal height with independent
scrolling and matching save bars; narrow screens stack with 44px inputs/buttons.
Two-digit row numbers stay on one line. The legacy final bar uses ordinary
flow so it cannot cover the card save controls; worksheet height reserves its
space in a 768px viewport. Returning a temporary edit to its stored
value removes only that request's clean recovery draft, preserving pending
operations, reconciliation and review reasons.

Appearance pass/fail is selected once in the measurement column. The verdict
column is a read-only badge; value edits save the original configured option
string and matching pass/fail judgement together. Korean/Chinese choice labels
are localized without altering the MES option values. Explicit bilingual item
and shift labels display only the active language. Opaque record/account names
are preserved; synthetic QC-ROOM identities avoid a hardcoded Korean preview name.

Both cards remain visible for every ordinary inspection. New manual creation
starts with one required dimension and one required appearance choice item. A
missing or optional-only area blocks the UI's final decision instead of counting
0/0 as complete. Legacy production snapshots are not silently changed. The local
1-machine fixture now contains its preserved eight saved dimension measurements
and ten blank, required appearance items; no new appearance is premarked pass.
The previous fixture snapshot is retained in output/inspection-before-required-appearance.json.
Role configuration already enforces two areas server-side; this UI revision does
not change the legacy endpoint validation or backfill production standards.

Equipment/plan details expand inside the upper station card for the selected
machine. Removed the three unneeded footer disclosures (full request search/list,
data source, stop/resume guide). Existing authorized manual-create action is in
the header. The 1–9/10–17 station order and guarded selection are retained.

Actual browser checks: at1366×768 each card is653px, equal height363px, and every
row is40px including pass/fail appearance and numeric delta states. Headers and
save controls share their baselines. At390×844 both cards are332px, header64px,
inputs/save buttons44px, with document width390px. Chinese selected1/7 worksheets
and selected equipment expansion have no visible Hangul; earlier checks covered
all six Chinese auxiliary panels. Legacy1 displays appearance0/10 and disables
final judgement. Selecting appearance fail updates its badge immediately;
clearing restores input-waiting. Shared7 has ten selectors for ten appearance
items with no verdict dropdown. Temporary edits restored; no inspection save,
submission or MES writer call occurred in these browser checks.

Evidence: output/inspection-layout-required-appearance-ko.png,
output/inspection-layout-final-ko.png, output/inspection-layout-final-zh.png,
output/inspection-layout-recovery-ko.png. Validation:58 focused frontend tests,
targeted ESLint, TypeScript and modern/legacy fixture build passed; preexisting
bundle-size warning remains. git diff --check passed. No backend changes or new
migration in this revision; previous backend evidence remains below.

---

# Parallel cards and automatic dimension judgement — 2026-10-07

final result: passed (local implementation and synthetic preview)

Replaced the area switch with parallel dimension/appearance cards in both editors. Each card retains its inspector, entered/saved progress and scoped save control; deformation remains dimension. Removed duplicated area/inspector columns and bounded the five compact columns. Measurement, judgement and saved-state headings/cells, input text and badges are centered. Appearance uses explicit pass/fail options. Saving one area preserves the other draft, and Enter stays within the active card. The existing saved-required-items final-decision dialog remains.

Dimension values derive inclusive range pass/fail and show exact decimal distance below minimum/above maximum. Configured pass/fail deformation choices derive badges. Appearance and items without an applicable range retain manual judgement. Empty/invalid values or invalid bounds never receive a fabricated pass. Read-only historical mismatches show the recorded verdict; no records are silently rewritten when read. Value edits persist the derived verdict through the existing scoped payload.

Browser verification: Korean/Chinese at1366×768 show two653px cards and142px measurement fields. Both save buttons fit in the viewport; appearance card bottom756.37px (initial implementation803.37px). The final button follows the taller card. No horizontal document overflow. At390px both cards stack at332px width, with44px controls and centered text; document width390px. Both editors' three requested headings/cells/input values compute as centered. Upper/lower boundary inputs pass;714.3 against714.2 shows upper excess0.1mm, and419.0 against419.2 shows lower shortfall0.2mm. Unsaved edits block the final decision; restored saved values allow the three-choice dialog. All temporary measurement edits were restored to the original strings; no save, submit or MES call was made in these browser checks. Final preview is Korean, saved and editable; viewport override was reset.

Evidence: output/inspection-cards-centered.png (temporary unsaved range examples), output/inspection-cards-zh.png. Validation:49 focused frontend checks passed, including both editors' automatic verdict/save payloads, inclusive/one-sided/negative/tiny decimal bounds, invalid input, appearance manual controls, parallel area draft preservation, scoped CAS/auth/session guards and final modal. Targeted ESLint, TypeScript and full modern/legacy fixture build passed; existing bundle-size warning remains. git diff --check passed. Previous backend/migration evidence is retained below; no additional backend changes, production migration or deployment in this revision.

---

# Area switch and final judgement revision — 2026-10-07

final result: passed (local implementation and synthetic preview)

Added a compact dimension/appearance segmented control above the worksheet, with inspector names and entered/saved counts. Only the selected area's rows render; deformation remains dimension. Switching preserves unsaved measurements and evidence. Scoped saves guide the user to unfinished input; once required values/evidence are saved with no pending draft, the owner receives a final pass/fail/concession dialog. Removed the overall judgement selects below both legacy and role tables. Per-item judgements remain. Separate inspector accounts retain explicit scoped completion; the shared operator's modal confirmation completes remaining areas sequentially and submits the chosen decision with current revisions.

Concession (한도승인 / 让步合格) records required grounds in the submit audit, preserves original failed measurements/nonconformance and requires independent approval with a recorded reason. Migration0016 widens only the final judgement column; disposable test migration/check succeeded. Standalone MES trials keep pass/fail-only semantics. Uncertain mutation recovery preserves original keys and can be reached by closing the dialog; no automatic final choice or submission occurs.

Browser verification: selected dimension shows6 rows and appearance10; a dimension save moved to appearance, and the second area save automatically opened the modal. Closing/reopening, arrow-key area selection, Tab wrapping, mandatory concession grounds and Korean/Chinese desktop labels were checked. A synthetic pass confirmation issued exactly area-complete(dimension), area-complete(appearance), submit, with completion attributed to202/201 and recorder101. Request became submitted/pass while MES remained not_completed. Evidence: output/inspection-entry-browser-confirmed.json. Existing fixture values were preserved before testing; the final preview was restored to the saved, editable Korean draft with no MES writes/proxy.

Screenshots: output/inspection-entry-desktop.png, output/inspection-entry-final-desktop.png, output/inspection-entry-final-zh.png, output/inspection-entry-final-mobile.png. At1366×768 the dimension table and save controls are visible together without horizontal document overflow. At390px the modal is350px wide, contained with20px margins; choice targets are72px tall. This checks the modal, not a full-app mobile overflow fix.

Validation:43 focused frontend tests passed, including both delivered editors, draft preservation, completion ordering/CAS, failure, session/conflict guards and final choice handling. Backend188 tests ran:179 passed,9 PostgreSQL concurrency tests skipped because no disposable PostgreSQL was supplied. New final-decision tests cover incomplete areas, forbidden pass promotion, concession grounds, independent review and exact replay. Targeted ESLint, TypeScript, full modern+legacy fixture build, script syntax and whitespace checks passed. Existing large-bundle warning remains. No production migration or deployment was performed.

---

# Always-visible MES status revision — 2026-10-07

final result: passed (requested desktop glanceability)

Moved MES synchronization and QC completion into button-shaped status chips next to the selected product heading, visible independently of auxiliary-panel selection. Existing MES save/finish/reconcile controls share this line without duplicate buttons. The former completion disclosure is now “MES 상세·안내” / “MES 详情·说明” and contains supplementary quality observations, checked time and existing guidance. The role worksheet shows the same statuses while retaining its unavailable shared-writer actions.

The chips reuse server observation copy and reconciliation guards. WJ approval does not imply MES completion; pending/unknown/stale observations cannot receive confirmed-success color. Added a meaningful delivered-role regression for WJ approval and stale prior completion, and retained mutation capability/dirty gates. The harness now resolves exact button names before abbreviated area-save labels because unavailable MES controls precede the worksheet.

Browser evidence: `output/inspection-room-mes-status-desktop.jpg`, `output/inspection-room-mes-status-role.jpg`, `output/inspection-room-mes-status-zh.jpg`, `output/inspection-room-mes-status-focus.jpg`. At 1366×768, heading height remains 34px; legacy status chips are at y256.07 with save controls ending at y683.57. Opening memo or MES guidance preserves visible states, and each MES action occurs once. Role save controls remain visible at the viewport bottom. Korean/Chinese desktop have no horizontal document overflow. At 390px, the role strip is contained at 332px and actionable buttons retain 44px height. No synthetic changes or MES actions were submitted.

Validation: 38 focused frontend checks, targeted ESLint, TypeScript, full modern/legacy fixture build and whitespace check passed (existing chunk-size warning). Existing backend work and production environment were preserved; no deployment in this revision.

---

# Evidence and expanded-panel density revision — 2026-10-07

final result: passed (requested desktop density)

Renamed the ambiguous “증빙 · 선택” menu to “사진·문서 링크 · 필요 시” (Chinese: “照片·文档链接 · 按需”). It records existing HTTPS references to inspection photos/documents; required evidence badges and item asterisks are preserved. This is not a file uploader. Existing URL validation, permissions, area ownership, draft recovery and save/submit gates remain in use.

The eight legacy item-link inputs now occupy four columns and two rows at 1672×941 and 1366×768. At the same 1672px viewport the expanded panel shrank from 760.88px to 246.77px (about 68%). Inputs changed from 1596px full-width to 391px each. Long repeated labels moved into accessible input names; visible labels retain item names and required markers. Common evidence rows share two columns. The role request retains separate inspector areas, each with two item-link columns (six dimension items, including deformation, and ten appearance items).

Broader density review: legacy memo and judgement guidance sit side by side (641px memo width and 99.70px expanded panel at 1366px). Role quantity fields use bounded widths alongside a memo capped at 720px; save/reload actions share a row. Expanded metadata uses four columns on desktop and two/one at narrower widths. The unselected-equipment placeholder is reduced to 88px. The selected worksheet, two equipment rows and inspector save bars are preserved.

Evidence: `output/inspection-room-evidence-before.jpg`, `output/inspection-room-evidence-desktop.jpg`, `output/inspection-room-evidence-1366.jpg`, `output/inspection-room-evidence-common.jpg`, `output/inspection-room-evidence-role.jpg`, `output/inspection-room-evidence-zh.jpg`, `output/inspection-room-evidence-mobile.jpg`. The user-reported before-state is `/var/folders/_8/7y6tkz950zgb76ljsnpbw0640000gn/T/codex-clipboard-a4ef1891-cd76-43b4-be46-706300c3b4ae.png`.

Browser checks: synthetic HTTPS input survived a panel switch, dirty state blocked submission, and a URL containing a query string blocked save with the existing validation message. Two temporary common-evidence rows appeared side by side. All synthetic draft edits were restored; the existing reload cleared recovery and no save was sent. Chinese desktop displayed four columns without document overflow. Mobile evidence used one 314px column and 44px inputs, contained within the 374px inspection page. Global mobile document scrollWidth reported 577px with bodyWidth390px; this revision does not claim a full-app mobile overflow fix. Empty/error fixture states retained accurate no-request/unconfirmed controls. The normal Korean evidence panel is left open for review.

Validation: targeted ESLint, TypeScript and full modern/legacy fixture build passed (existing large-chunk warning); 34 focused frontend tests passed; whitespace check passed. No backend or production data changes, deployment or MES writes in this revision.

---

# Auxiliary-menu revision — 2026-10-07

final result: passed (requested desktop footer density)

The user requested horizontal buttons/cards for the auxiliary footer. Replaced the six vertically stacked request disclosures and four full-width page disclosures with two horizontal button groups. Each group is 34px high at 1366×768; its selected content spans the available width directly below. Buttons toggle closed, and only one panel per group is displayed. Hidden panels remain mounted to preserve draft inputs.

Evidence:
- Reported before-state: `/var/folders/_8/7y6tkz950zgb76ljsnpbw0640000gn/T/codex-clipboard-3e228bd7-aca5-406c-94ac-7d0e735195f3.png` (3226×772 physical pixels; CSS viewport unavailable).
- Closed implementation: `output/inspection-room-auxiliary-closed.jpg` (1672×941, same CSS viewport), `output/inspection-room-auxiliary-1366.jpg` (1366×768).
- Focused implementation: `output/inspection-room-auxiliary-footer.jpg` (1366×158 native clip).
- Open panel: `output/inspection-room-auxiliary-open.jpg`.
- Reviewed before/after composite: `output/inspection-room-auxiliary-comparison.jpg`. Before-state normalized to 1366px wide; original screenshot remains untouched. This is a density/layout comparison, not a claim of equal viewport/font scale.

[P1 fixed] Full-width collapsed cards and stacked auxiliary links consumed vertical space without useful content. Final request buttons occupy y679.16–713.16, page buttons y728.16–762.16 at 1366×768. Both rows fit with the save controls visible.

Browser validation: memo text survived closing and switching to evidence and reopening; dirty inputs continued blocking submission. The synthetic test memo was restored to its original empty value and existing reload cleared the test recovery. Enter toggled a focused button. Data-source and request-list panels switched exclusively, full-width content showed two fixture requests, and the role request history showed its two actual fixture events. The 16-row role worksheet was retained. Chinese button titles and no desktop document overflow were verified; mobile buttons wrapped and retained 44px targets. Normal console showed no errors.

Fidelity: existing system fonts, navy/semantic palette and standard icon library retained; no new raster assets. The closed controls use 13px secondary text with 34px desktop targets, compact 6px gaps and existing border/background tokens. Stored labels and backend behavior remain unchanged.

Validation: targeted ESLint, TypeScript, whitespace check and full modern/legacy fixture build passed; 34 focused frontend checks passed. The existing role test harness was updated to recognize the new presentational wrapper. No production changes or deployment were performed.

---

## Previous revisions (preserved)

# Compact worksheet revision — 2026-10-07

final result: passed (desktop inspection layout)

The user requested another density adjustment after the legacy single-inspector request still showed a narrow, tall table. Existing role assignments, draft recovery, save gates, authentication and backend work are preserved.

## Source and captured implementation

- Selected visual: `output/inspection-room-selected.png` (1672×941).
- User-reported drift: `/var/folders/_8/7y6tkz950zgb76ljsnpbw0640000gn/T/codex-clipboard-d1bb6aae-2714-4d63-81cf-ec8fc65916b0.png`.
- Final role worksheet: `output/inspection-room-density-desktop.jpg` (1672×941 screenshot, CSS viewport 1672×941; no density adjustment).
- Final legacy worksheet: `output/inspection-room-density-legacy.jpg` (1672×941).
- Full comparison: `output/inspection-room-density-comparison.jpg` (source above implementation, native equal dimensions).
- Focused comparison: `output/inspection-room-density-focus.jpg` (native matching first-six-row crops).
- Additional captures: `output/inspection-room-density-1366.jpg`, `output/inspection-room-density-mobile.jpg`, `output/inspection-room-density-zh.jpg`.

The selected mock and implementation use the same equipment selection and 16-item schema. Sample progress differs: the mock contains inconsistent illustrative counts; actual preview counts use saved and entered data. Only loopback synthetic saves were performed.

## Fixed findings and post-fix evidence

- [P1 fixed] Legacy table capped at 1000px inside a much wider region; stacked item criteria produced approximately 76px rows. Removed the width cap, separated item/specification columns and reduced rows to 34px. The eight-item legacy worksheet, final verdict and save controls now fit at 1366×768. The table uses the available width.
- [P1 fixed] Repeated detail title, equipment, task type and owner occupied several lines above the table. Combined the request context into one flex row; folded notes, evidence and MES details after the core save controls. Role progress and unfilled filter now share the heading row.
- [P2 fixed] Permanent desktop navigation consumed worksheet width. The inspection route now opens the same navigation in a drawer from its menu button; other routes keep their existing layout. Open, Escape, focus restoration and menu access were verified. Account and home remain available.
- [P2 fixed] A provisional 1366×768 table-height cap placed the sticky footer over the last visible rows. Reduced the table cap: final table bottom and savebar top both equal 710.22px; savebar bottom is 761.22px. No footer/table overlap remains.

At 1672×941: all 17 tiles are visible (1–9 at y106.07; 10–17 at y155.82), the 16-row worksheet starts at y285.22, all rows measure 34px, and its savebar ends at y913.72. At 1366×768 the table scrolls locally and the savebar stays visible without horizontal document overflow.

## Fidelity and interactions

- Typography: existing Korean/Chinese system fonts retained. Working text remains 14px, secondary specifications 12–13px; controls remain readable at the reviewed desktop sizes. Mobile inputs retain 44px targets.
- Spacing: dense header, smaller equipment tiles, single-line request context and 34px worksheet rows restore the selected concept's proportions. The shared home/account strip adds approximately 42px; smaller equipment tiles compensate, keeping the table aligned with the source at y285.
- Colors: existing navy header, semantic area/status colors and system background preserved. No new palette or decoration.
- Assets: existing app logo/icons only; no generated bitmap UI, custom icon art or substitute asset.
- Copy: existing stored labels and state meanings preserved. Legacy controls shortened to 저장 / 결과 제출 / 새로고침. No automatic relabeling of existing records or fabricated area assignments.
- Keyboard: Enter moves to the next measurement; dirty row changes to 미저장 and enables save; restoring the original value returns it to 저장됨.
- Loopback role save: dimension saved while appearance value/judgement remained an unsaved draft; subsequent appearance save cleared the dirty rows. Real production/MES transport was not exercised.
- Chinese: deformation remains 尺寸 with inspector QC001; savebar stays within the viewport.
- Empty/error: 17 equipment tiles remain visible; empty count is zero, errors are explicit, unknown states are not represented as actual machine status.
- Normal browser console: no errors.

## Validation and limitations

- Focused frontend checks: 34 passed (`output/inspection-room-density-tests.log`).
- TypeScript, targeted ESLint and whitespace checks passed. Final modern/legacy fixture build passed (`output/inspection-room-density-build.log`). Existing large-chunk build warning remains.
- Mobile checked for page width, local worksheet scrolling, menu availability and 44px inputs. This desktop-first acceptance does not claim broad mobile shell QA.
- Prior PostgreSQL concurrency and real MES write limitations below remain unchanged. No deployment, production migrations or production inspection changes were made.

---

## Previous implementation QA (preserved)

# Inspection room worksheet QA — 2026-10-07

final result: passed

Acceptance scope: the selected desktop inspection workflow, implemented in the existing application. This is a local implementation and synthetic preview, not a deployment or MES acceptance test.

## Visual truth and evidence

- Selected revised reference: `output/inspection-room-selected.png` (1672 × 941 pixels, a 16:9 mock).
- Browser implementation: `output/inspection-room-desktop-final.jpg` (1920 × 1080 pixels), in-app Browser, CSS viewport 1920 × 1080. Existing application navigation is retained.
- Full comparison: `output/inspection-room-comparison.png`. Both originals are uniformly fitted to equal-width comparison slots, without modifying the originals.
- Focused table comparison: `output/inspection-room-comparison-focus.png`; classification, input sizing, row alignment and assigned authors are visible together.
- Comparison state: selected equipment 7, 16 items, dimension 6 including deformation and appearance 10, partial saved example values, second numerical input focused. No production values were entered. The generated reference's inconsistent example completion count was not reproduced.
- Other captures: `output/inspection-room-1366.jpg`, `output/inspection-room-zh.jpg`, `output/inspection-room-mobile-final.jpg`, `output/inspection-room-empty.jpg`, `output/inspection-room-error.jpg`.

## Comparison history

1. Initial desktop capture `output/inspection-room-before.jpg`: [P1] Duplicate metadata/toolbar rows pushed the worksheet to y=589 and its bottom to y=1244, hiding rows below the 1080 viewport. Fixed by putting current owners into the title bar, placing date/request controls on one row, removing repeated request headings and reducing row height.
2. Saving originally inserted a large success panel and changed table placement. [P2] Replaced it with inline feedback in the existing heading.
3. Final browser capture: table y=403–1012, all 16 rows visible; save bar y=1013–1064. Equipment 1–9 share the first row; 10–17 share the second. Saved and unsaved states remain distinct. No actionable P0/P1/P2 desktop findings remain.

## Required surfaces

- Typography: existing Korean/Chinese system font stack retained; worksheet body 14px, compact metadata 12–13px, clear 17–22px headings. Chinese labels are readable and columns align.
- Spacing: compact header and exactly two equipment rows; 36px worksheet rows, numerical controls capped at 200px. At 1366 × 768, the worksheet scrolls within its region while the save controls remain visible at the viewport bottom.
- Colors: original navy and blue tokens retained, white table surface and restrained alternate rows; text accompanies each semantic state. No decorative palette expansion.
- Assets: existing application logo and standard UI library icons retained. No generated bitmap is used as an interactive control.
- Content: deformation is dimension even though its value remains a choice. New unconfigured mappings receive this suggestion; existing configured/history mappings are not silently rewritten. Real result submission and area-completion gates retain their actual meaning; the mock's combined completion label does not bypass independent review or MES gates.

## Interaction evidence

- Equipment selection opens the request inline; no full-page editor navigation or inspector logout.
- Enter from the first numeric field focuses the next measurement input. Native Tab remains available.
- Dimension save leaves the appearance value, judgement and unsaved indicator intact.
- Item attribution displays assigned inspector QC001 and authenticated terminal recorder separately.
- Actual synthetic request: area `dimension`, inspector ID 202, recorder ID 101, only the six dimension item IDs. Production/MES requests: none.
- Korean/Chinese worksheet labels, empty requests and failed reads were observed. Failed reads disable unknown equipment instead of inventing statuses.
- Normal-state console error check: none.

## Remaining limits

- Mobile equipment and table regions scroll locally and their page/body containers fit 390px. The shared shell still reports a larger root scroll extent during mobile browser resizing; full mobile shell acceptance is outside this desktop request.
- PostgreSQL-specific concurrent lock regressions are present but could not run because local PostgreSQL is unavailable. They must run before production release.
- Backend migration 0015 is additive and unapplied in production. Shared-terminal WJ attribution is implemented; the existing unverified MES partial/multi-executor contract remains blocked.

## Checklist

- [x] Selected desktop layout and user amendments implemented.
- [x] Modern/legacy fixture build and focused frontend/backend checks passed.
- [x] Browser interactions and full/focused visual comparison completed.
- [x] Local preview kept available with synthetic data.
- [ ] Production database migration, PostgreSQL CI and live MES role acceptance are separate release work.

---

# HR compact UI QA — 2026-10-09

Final target: the user's latest instruction to turn raw classification ideas into a compact working UI. The original image geometry is not the final layout requirement.

Source visual truth:
- `/var/folders/vh/jb7m4x251z7bhnszypqrhydm0000gn/T/codex-clipboard-7269994e-64b6-466d-827f-3afbff1da29a.png` (2454×989): seven functional cost groups, repeated names scoped by group.
- `/var/folders/vh/jb7m4x251z7bhnszypqrhydm0000gn/T/codex-clipboard-a6d6d5d9-d205-4ea3-9ba5-a93dcd7a06f9.png` (4560×2565): reporting hierarchy used in the secondary organization view.

Implementation: `http://127.0.0.1:5186/hr/labor-cost?month=2026-10`, synthetic employees and salaries. Actual supplied payroll was parsed read-only; no real payroll amounts were supplied or imported.

Evidence:
- `docs/reviews/assets/hr-labor-cost-20261009/compact-cost-desktop.jpg`, desktop CSS viewport 1920×1200.
- `docs/reviews/assets/hr-labor-cost-20261009/compact-cost-mobile.jpg`, mobile CSS viewport 390×843.
- `/private/tmp/wj-hr-qa-20261009/functional-before-comparison.png`: combined source + first implementation, normalized to the same width. It exposed amount wrapping and a sprawling diagram.
- `/private/tmp/wj-hr-qa-20261009/organization-comparison.png`: combined source + reporting graph; relationships and names matched, long role wrapping was corrected.
- The final layout was inspected together with these visual references. It retains the seven groups and their functions but replaces their large literal geometry with responsive cards per the user's corrective instruction.

Density normalization: in-app browser viewport dimensions use a 1.612 scale on this host. Requested 1191×744 produced DOM 1920×1200; requested 242×523 produced DOM 390×843. Screenshot clip coordinates were normalized by the measured ratio. The retained desktop raster is 1921×1200 pixels and mobile is 390×844 pixels; the measured CSS sizes are 1920×1200 and 390×843. Browser chrome is excluded. Source references were scaled proportionally without altering their content for combined comparisons.

Findings and fixes:
1. P1: literal large canvas and duplicate bars/table hid the useful cost overview. Replaced by one summary strip and seven small cards; removed default zoom/canvas, repeated descriptions and long bars. Detailed table, reporting view, editing and grants are closed by default.
2. P2: monetary values wrapped across digits. All final values are one line at 14px, with CNY currency stated in the summary. No ellipsis or discarded precision.
3. P1: duplicate CS/操作工 destinations were ambiguous. All selectors and row labels include the actual ancestor path.
4. P2: notices moved targets during dragging. Personnel notices now float outside layout; cancellation preserves assignments.
5. P1: month selection could leave old data labelled as another month. The hook rejects mismatched month snapshots, month input commits immediately, URL/tab/reload preserve the selected period. January/February same-code import was verified through the UI and API.
6. P2: missing amounts resembled zero cost. Null salaries are distinct, incomplete totals/shares remain unknown, and empty no-person cells are quiet. Known partial sums appear only when informative.

Required fidelity surfaces:
- Typography: existing Korean/Chinese fonts; working names and money 14–16px, headings 16–22px, ancillary metadata 12–13px. No split monetary strings.
- Layout: desktop header about 67px. Seven card bottoms measured below 800px within a 1200px viewport. Mobile uses one-column readable cards and internal table scrolling, document width <=390px.
- Color: existing navy/gray-blue tokens, restrained white surfaces; amber only indicates a real missing/unclassified status. The colorful source hierarchy was not spread across salary cards.
- Asset quality: no rasterized functional controls or invented image assets. Cards, controls and reporting connectors are code-native UI primitives. Existing company logo is retained.
- Copy/content: original functional labels, correct scoped names and reference manager names; source departments remain separate, wages use the user's confirmed 应发工资 basis. No inferred employee placement or fabricated salary.

Primary interaction checks: scope selection, same-month tab navigation, upload mapping, other-month exclusion, import validation/confirmation, automatic cell allocation, drawer with descendants, employee button move/save/readback, incomplete amount display, desktop/mobile layout. Console errors: none observed. Drag start/cancel observed; native automated drop completion remains a field-validation gap, not claimed as acceptance.

No actionable P0/P1/P2 compact-layout issues remain in the inspected states. Remaining acceptance: actual pointer drops, actual company file with supplied wages and corrected missing May employee code, production/PostgreSQL deployment.

final result: passed

---

# HR option 3 allocation board and private code display — 2026-10-09

This section supersedes the earlier HR layout and native-drop acceptance notes above.

Source visual truth: `docs/reviews/assets/hr-labor-cost-20261009/option3/selected-concept.png`, the third displayed image selected by the user (1586×992 pixels). User amendments take precedence: employees appear as codes, numeric codes are padded to at least five digits, and names are not shown by default.

Implementation: `http://127.0.0.1:5186/hr/personnel?month=2026-10`, isolated local API and disposable SQLite. All 67 employees and the 536,000 CNY total are synthetic. No source payroll names or amounts were copied into fixtures or Git.

Evidence (under `docs/reviews/assets/hr-labor-cost-20261009/option3/`):
- `personnel-desktop.png`: Korean default allocation view, 1921×1200 pixels / measured 1920×1200 CSS viewport.
- `cost-desktop-zh.png`: Chinese read-only cost view, same dimensions.
- `personnel-mobile.png`: Korean responsive view, 390×844 pixels / measured 390×843 CSS viewport.
- `comparison-full.png`: source and implementation placed together, implementation proportionally normalized to source width 1586. Both have nearly identical aspect ratio. Existing app navigation is retained; it has more entries and takes more space than the mock.
- `comparison-detail.png`: combined close comparison of the summary, typography, functional cells and codes. The reference's names/avatars are intentionally replaced by the user's five-digit codes. The reference illustrates an active drag; the retained full-view capture is the idle saved state. Active movement and its amounts were checked through native pointer input and the detail movement preview rather than claiming an identical interaction-state capture.

Findings and comparison history:
1. P1 fixed: the first one-code-per-row implementation pushed the dock below the 1200px viewport. At desktop widths of 1700px and above, compact code pills now use two columns. All seven lanes and the six-person dock fit: dock bottom measured 1148px. Additional unoccupied management cells stay out of the main view.
2. P1 fixed: default employee names leaked through cards, detail lists, import preview and reporting diagram. The default UI now uses codes; one selected person's name requires the explicit name button, and closes/reset on selection dismissal, month/data changes. Original identifiers remain unchanged for mutations.
3. P2 fixed: padding could create display aliases (11 and 00011). Colliding displays include a small original-code annotation; move keys remain distinct. Unit tests cover collisions, nonnumeric codes and codes longer than five digits.
4. P2 fixed: null cost shares previously rendered zero-width tracks. Unknown shares now render no lane meter; incomplete total displays remain unknown with a separately labelled known subtotal.
5. P2 fixed: dragging to off-screen destinations had no auto-scroll. Active pointer dragging now scrolls the viewport and horizontal lane container at their edges, updating the drop target even with a stationary pointer. Native mobile edge drag produced 37px vertical movement and narrow-desktop edge drag produced 10px horizontal movement.
6. P2 fixed: small mobile percentage segments clipped digits. Narrow-screen bars omit labels for shares below 15%; values remain in the corresponding department headers and the chart's accessible description. Post-fix mobile image was inspected.

Required fidelity surfaces:
- Typography: retained existing Korean/Chinese system font stack and readable codes/money; 14px working code pills, 14–17px values, 19px lane titles. Compact integer money omits .00 while fractional amounts retain both decimals. No names or initials substitute for the requested codes.
- Layout rhythm: one heading/tab/month/action row, one total-and-share ribbon, seven equal lanes with function zones, and a six-person search dock. Small desktop uses internal horizontal scrolling; mobile stacks lanes and preserves approximately 44px drag handles. No page-level horizontal overflow was observed at 1920, 1200 or 390 CSS px.
- Colors/tokens: existing navy, gray-blue surface and white cards; restrained navy-to-gray blue distribution segments, sufficient text contrast, semantic amber only for missing values. Existing site shell retained intentionally.
- Asset fidelity: existing supplied WJ logo retained as an image; no decorative bitmap assets were required. Icons reuse the site's installed Lucide set. Charts and controls are functional code, not a rasterized mock.
- Copy/content: original seven functional groups and scoped repeated labels retained; 应发工资 basis, explicit source department, missing costs and original identity keys preserved. Extra explanatory mock copy and fictional HR badge were omitted from the working screen.

Primary behavior observed: native drag 00001 from injection operator to materials raw; injection 28/216000 → 27/208800 and materials 6/48000 → 7/55200, while total 67/536000 remains unchanged. Save and reload preserve the move; reverse drag/save restores the fixture. Dropping outside a target cancels without enabling save. A detail button move of original code 245 saves/reloads as display 00245 while its DOM identity remains 245. Name reveal and close/reopen hiding were observed. September's missing salary leaves overall total unknown; October and empty August remain distinct. Cost view has no drag handles. Chinese and mobile views were inspected.

Checks: 36 HR frontend tests, TypeScript/Vite/legacy build, selected changed-file ESLint (no errors or warnings), and git diff whitespace check passed. Build retains the existing large-chunk warning. Fresh final-preview console error log was empty. No backend/schema/auth changes were made in this iteration.

Remaining test limits: the pre-existing browser-native discard confirmation caused the automation tab to stop responding; its confirmation acceptance was not verified. A fresh saved-state preview was opened without saving that temporary test move. This is not counted as a completed discard test. Physical touchscreen acceptance, production/PostgreSQL behavior, real payroll reconciliation, and re-running the full import UI after this visual-only preview change are not claimed. Import preview code display was reviewed in code and the source-code formatting/import tests passed.

Implementation checklist: completed visual comparison, privacy/display changes, exact move previews, native move/save/reload, responsive fixes, affected tests and build. No actionable P0/P1/P2 visual findings remain in the inspected states. The feature remains local and un-deployed.

final result: passed

---

# HR department / management / work hierarchy correction — 2026-10-09

The user's latest clarification supersedes the earlier interpretation of management labels and the decision to hide empty management cells. The source means a department contains manager labor and separate worker/function labor. The selected option 3 remains the density/layout direction, but its prior labels are not the semantic authority.

Implemented hierarchy: neutral department header and whole-department total → always-visible manager assignment cell plus work subtotal → individual work functions. Parent headers and work subtotals are roster controls, never drop targets. The existing group ID remains the manager assignment key; descendants comprise work, including additional nested functions. No employee is reclassified from their job title and no persisted IDs or schema changed. Import previews, move notices, destination paths and the cost ribbon use the same distinction.

Cost proof with disposable synthetic data: native drag moved original code `1` / display `00001` from injection operator to injection manager, then save/reload retained it. Department total stayed 28 people / 216,000 CNY; managers became 1 / 7,200 and work became 27 / 208,800. Company total stayed 67 / 536,000. A reverse move preview showed manager 1→0 and 7,200→0, work 27→28 and 208,800→216,000, with unchanged department/company totals. It was closed without applying. The work-only roster contains 27 people and excludes 00001. Cost-page role table matches these figures and its board has no movement handles.

Evidence under `docs/reviews/assets/hr-labor-cost-20261009/hierarchy/`:
- `personnel-desktop.png`: final allocation hierarchy, 1920×1200 CSS / 1921×1200 raster.
- `cost-desktop.png`: read-only hierarchy and role composition, same dimensions.
- `personnel-mobile.png`: 390×843 CSS / 390×844 raster, single-column hierarchy without document horizontal overflow.
- `same-department-preview.png`: manager/work before-and-after values for a same-department move.

Visual findings: the first hierarchy revision pushed the personnel dock 22px below the tested desktop viewport. Compact function padding, two code chips plus the remainder count, and the short Korean feeding label corrected this; final board bottom was 990px and dock bottom 1193px. Department, manager and work totals stay distinct through nesting, restrained blue surfaces and a manager/work composition strip. Empty manager cells remain available. Korean and Chinese paths were checked; all displayed identities remain codes by default. Fresh preview console error log was empty.

Checks: 42 HR frontend tests passed, including six added tests for role partitioning, deeper descendants, same-department moves, independent missing costs, invalid graphs and stable assignment paths. Changed-file ESLint, full TypeScript/Vite/legacy build and whitespace checks passed. Existing large-chunk build warning remains. Independent read-only code review found no numeric duplication or destination-key issue.

This is local implementation and synthetic browser verification only. No backend, permissions, migrations, production data or deployment were changed. Existing real-file reconciliation, physical-device and production acceptance limits remain. No actionable hierarchy defect remains in the inspected states.

final result: passed
