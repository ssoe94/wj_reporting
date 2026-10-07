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
