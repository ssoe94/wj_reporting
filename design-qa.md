# Design QA — Main Frontend Glass Refactor

## Comparison target

- Source visual truth: `/tmp/codex-remote-attachments/019fcb10-224f-7680-a214-936340e10d87/5EC2B0D7-1E81-4AFE-8262-38FA4EFE4F03/1-붙여넣은-이미지-1.jpg`
- Implementation: `http://127.0.0.1:5184/analysis`
- Desktop screenshot: `/Users/macstudio_ted/Developer/wj_reporting/design-qa-artifacts/main-after-shell-refactor-final.png`
- Mobile screenshot: `/Users/macstudio_ted/Developer/wj_reporting/design-qa-artifacts/main-after-mobile-final.png`
- Side-by-side comparison: `/Users/macstudio_ted/Developer/wj_reporting/design-qa-artifacts/main-glass-comparison.png`
- Baseline screenshot: `/Users/macstudio_ted/Developer/wj_reporting/design-qa-artifacts/main-before-refactor.png`

## Normalization and state

- Source pixels: `1179 × 1178`.
- Source comparison region: dashboard crop at `y=260`, `1178 × 880`, proportionally scaled to `964 × 720`.
- Desktop implementation: `1280 × 720` CSS px and screenshot px, `devicePixelRatio: 1`.
- Mobile implementation: `390 × 844` CSS px and screenshot px, `devicePixelRatio: 1`.
- Combined comparison: `2244 × 720` px, source on the left and implementation on the right.
- State: authenticated main-site analysis dashboard using the local production build and mock API.
- The reference is a style-guide board rather than the same product screen. Comparison is therefore limited to its visual direction—palette, translucency, edge treatment, elevation, typography hierarchy, and density—while WJ routes, copy, permissions, and data structure remain authoritative.

## Full-view comparison evidence

- The main frontend now follows the reference's pale blue/lavender ambient background, translucent white frame, highlight borders, soft blue elevation, and restrained blue accent.
- The fixed WJ sidebar and top bar preserve the application's information architecture while matching the reference's floating glass-frame proportions.
- Desktop hierarchy is balanced at `1280 × 720`: 236 px navigation, 996 px content, 28 px-equivalent page title, compact controls, and readable card headings.
- Mobile stacks the brand header, breadcrumb, page header, tabs, date controls, and cards without horizontal clipping at `390 × 844`.
- The production-plan screen was also checked at desktop and mobile widths; its calendar and plan cards retain their original content while adopting the new shell and surface rhythm.

## Focused-region evidence

- Typography and controls were checked separately in the native desktop screenshot and the `390 × 844` mobile screenshot because they are too small to judge precisely in the combined image.
- The mobile page title, tab labels, input labels, dates, card title, and body copy remain legible without truncation.
- The mobile navigation drawer was opened and checked as an interactive focused state: all routes scroll, KOR/中文 and lite-mode controls remain available, Escape closes the dialog, and focus returns to the menu button.

## Required fidelity surfaces

- Fonts and typography: existing system/Noto Korean/Chinese fallbacks are preserved. Page, section, card, body, and helper text now use a consistent hierarchy; no 9–10 px text was introduced.
- Spacing and layout rhythm: 16 px desktop frame, 18 px page gap, 14–20 px surface padding, 17–25 px radii, and compact navigation rows reproduce the reference's airy but information-dense balance.
- Colors and tokens: WJ blue/green semantics remain intact. Glass surfaces use dedicated background, border, shadow, blur, text, muted, accent, green, and violet tokens.
- Image quality and assets: the existing WJ raster logo is reused at its native aspect ratio. Navigation and page icons use the installed Lucide set; no placeholder or handcrafted SVG assets were added.
- Copy and content: routes, labels, permissions, languages, and business content remain unchanged. The refactor changes structure and presentation only.
- Accessibility and interaction: active routes use `aria-current`; language controls use `aria-pressed`; mobile navigation is a modal dialog with focus containment, Escape close, scroll lock, and focus return; analysis tabs have tab/panel relationships and arrow-key navigation; reduced-motion preferences remain supported.

## Findings

- No actionable P0, P1, or P2 visual differences remain for the requested glassmorphism adaptation of the main shell and verified native pages.
- P3: data-heavy legacy routes require a staging API for populated-state visual regression because the lightweight local mock returns generic response shapes.
- P3: the main JavaScript bundle remains about 1.89 MB; route-level code splitting should accompany the future Next-to-main migration.

## Comparison history

### Pass 1

- [P2] At `390 × 844`, the desktop sidebar was still displayed and covered the mobile page.
  - Fix: made the desktop sidebar opt-in from the 768 px breakpoint and retained a separate mobile dialog drawer.
  - Post-fix evidence: `main-after-mobile-final.png` shows the mobile header and full-width content without the desktop rail.
- [P2] The old period-selector flex row expanded the page beyond the viewport.
  - Fix: refactored it into semantic fields with one-, two-, and four-column responsive layouts.
  - Post-fix evidence: measured document width equals viewport width at 390, 768, and 1280 px.

### Pass 2

- [P1] Theme selectors could override validation colors, custom card padding/overflow, and field-terminal high-contrast sizing.
  - Fix: moved UI primitive defaults into the CSS components layer so caller utilities win, removed forced card overflow, and scoped legacy typography/table overrides away from standalone field-terminal pages.
- [P1] The 768 px layout combined a desktop sidebar with a period-selector grid wider than the remaining workspace.
  - Fix: added a two-column 768–1100 px breakpoint.
  - Post-fix evidence: at 768 px the workspace is 516 px, the selector is 484 px with two 221 px columns, and document width remains 768 px.
- [P1] Mobile language switching was hidden.
  - Fix: restored KOR/中文, lite mode, and logout controls in the mobile navigation footer.
- [P2] Mobile navigation and analysis tabs lacked complete keyboard relationships.
  - Fix: added dialog/focus behavior and connected tabs to tabpanels with arrow-key navigation.
  - Post-fix evidence: browser interaction checks confirmed the language controls, Escape close, `aria-expanded=false`, selected assembly tab, and matching assembly tabpanel.

### Pass 3

- [P1] The lite-mode build disabled the Vite stylesheet but its standalone `legacy.css` did not include the new main theme.
  - Fix: added a legacy CSS entry that imports both the existing base stylesheet and `main-theme.css`, and routed PostCSS CLI through the dedicated legacy configuration.
  - Post-fix evidence: after a full reload in lite mode, the asset stylesheet was disabled while `legacy.css` retained the fixed 236 px sidebar, card borders/backgrounds, controls, and page layout. Custom-property usages were resolved in the generated legacy bundle.
- [P1] Logging out from an open mobile drawer could leave body scrolling locked.
  - Fix: the drawer now closes before logout, ensuring the scroll-lock effect cleans up.
- [P2] The account menu declared ARIA menu semantics without corresponding keyboard behavior.
  - Fix: opening focuses the first item; Up/Down and internal Tab move between items; Escape closes and returns focus; boundary Tab closes and moves to the next page control.
  - Post-fix evidence: browser interaction moved focus from password change to logout, then boundary Tab closed the menu and focused the next navigation link.
- [P2] Mobile navigation links and the account trigger were shorter than 44 px.
  - Fix: navigation links, home, account trigger, menu/close icon buttons, and account menu items are now at least 44 px at the mobile breakpoint.
  - Post-fix evidence: computed dimensions were 44 px for the home, account, open/close, and sampled drawer link controls.

### Pass 4

- The updated source/implementation composite and focused desktop/mobile checks found no remaining P0, P1, or P2 visual issue.

## Validation

- `cd frontend && npm run build` — passed.
- `cd frontend && npm run lint` — passed with 39 existing warnings and no errors.
- `git diff --check` — passed.
- Desktop, tablet, and mobile overflow checks — passed at 1280, 768, and 390 px.
- Main mobile menu, language controls, Escape close, and analysis-tab keyboard interaction — passed.
- Lite-mode standalone stylesheet and full-reload behavior — passed.
- Account-menu focus, arrow-key, and Escape behavior — passed.
- Account-menu internal and boundary Tab behavior — passed.

## Frontend consolidation

The production dashboard, injection board, MES monitoring, and raw-material management
screens now run as native modules in `frontend`. The iframe, bundled `/next` build, and beta
deployment configuration have been retired. Temporary `/next/*` client redirects remain only
for existing bookmarks.

## Incremental QA — sidebar brand and production-record controls

### Comparison target

- Source visual truth: `/var/folders/vh/jb7m4x251z7bhnszypqrhydm0000gn/T/codex-clipboard-0ba73f95-0804-4ee8-b748-48b0905cedd0.png` and `/var/folders/vh/jb7m4x251z7bhnszypqrhydm0000gn/T/codex-clipboard-4a8e8e41-9255-4943-bb10-eaf99fdafdd7.png`.
- Browser-rendered implementation screenshot: `/private/tmp/wj-assembly-records-final.png`.
- Combined comparison evidence: `/private/tmp/wj-ui-design-qa-comparison.png`.
- Implementation route/state: authenticated `/assembly#records`, Korean locale, empty production-record state.

### Normalization and evidence

- Source logo pixels: `267 × 177`; source records pixels: `1230 × 619`.
- Implementation viewport and screenshot: `1280 × 720` CSS/image pixels at device pixel ratio 1.
- The combined comparison preserves each source aspect ratio and places the focused logo and records regions beside the implementation; exact pixel overlay is not used because the source captures are differently cropped.
- Full-view evidence confirms the CSV controls are above the calendar, occupy the same 338 px grid column, and leave more vertical room for records.
- Focused-region evidence confirms the logo asset has no visible block background, border, or shadow; the Chinese subtitle is larger; the records panel and calendar are both 458.4 px high.

### Required fidelity surfaces

- Fonts and typography: `WJ DATA CENTER` remains the primary line; the Chinese subtitle increased to a computed 11.52 px with stronger contrast and no clipping.
- Spacing and layout rhythm: the two CSV buttons are 36 px high, share the calendar's 338 px width, bottom-align to the title row, and retain a 10 px gap above the calendar. The records and calendar cards have equal heights.
- Colors and visual tokens: existing glass surfaces, blue primary action, muted secondary action, and card tokens are unchanged.
- Image quality and asset fidelity: the supplied transparent WJ logo is rendered directly on the sidebar surface with no surrounding block treatment or transparency halo visible at the rendered size.
- Copy and content: all production-record, calendar, CSV, and brand copy remains unchanged.

### Comparison history

- Pass 1 — [P2] CSV controls consumed a separate row below the calendar and the two cards ended at different heights.
  - Fix: moved CSV controls into the section heading and stretched the records/calendar cards to an equal grid-row height.
- Pass 2 — [P2] the controls were narrower than the calendar and vertically centered in the heading row.
  - Fix: matched the 338 px calendar column, reduced control height to 36 px, reduced section gap to 10 px, and bottom-aligned the controls. Post-fix metrics show matching width, matching right/left edges, and a 10 px button-to-calendar gap.

### Interaction and console checks

- Calendar previous/next navigation changed the visible month from August to September and back.
- CSV upload and save controls remain enabled; their existing handlers were not changed.
- Browser console errors: none.
- No actionable P0, P1, or P2 visual findings remain. Narrow mobile layout continues to stack the title and actions, with full-width touch targets.

## Incremental QA — assembly defect-entry visual cleanup

### Comparison target and normalization

- Source visual truth: `/var/folders/vh/jb7m4x251z7bhnszypqrhydm0000gn/T/codex-clipboard-9e4ed545-0398-4e93-b004-690c58bc1be5.png` (`1176 × 274` px).
- Browser-rendered implementation: `/private/tmp/wj-assembly-defects-final.png`, captured at a `1280 × 720` CSS/image viewport with device pixel ratio 1.
- Focused side-by-side comparison: `/private/tmp/wj-defect-card-design-qa-comparison.png`. Both regions preserve their aspect ratios; the implementation is cropped to the same processing/outsourcing card content shown in the source.
- State: authenticated `/assembly#new`, Korean locale, blank defect-entry rows.

### Full-view and focused evidence

- All five assembly input group cards now share one border color (`rgba(79, 139, 184, 0.2)`) and one background (`rgba(250, 253, 255, 0.76)`).
- The processing/outsourcing column header dividers and add-row dividers both compute to `0px`; no black horizontal rule remains.
- Focused comparison shows the original amber/purple card outlines and dark dividers replaced by the existing glass theme's quiet blue-gray treatment while retaining card boundaries and input affordances.

### Required fidelity surfaces

- Fonts and typography: labels, totals, input text, and add-row actions retain their existing size, weight, and hierarchy.
- Spacing and layout rhythm: card dimensions, two-column grid, row spacing, and control heights are unchanged; only decorative rules and colors changed.
- Colors and tokens: quantity, time, incoming, processing, and outsourcing cards use one neutral palette. Status badges retain semantic zero/error colors.
- Image quality and assets: no image or icon asset changed; existing Lucide add/delete controls remain sharp and aligned.
- Copy and content: all defect labels, totals, placeholders, and actions are unchanged.

### Comparison history and findings

- Pass 1 — [P2] processing/outsourcing cards used unrelated amber and purple outlines, while dark top/bottom rules over-emphasized an otherwise light form.
  - Fix: removed both horizontal divider utilities and replaced all group-card accent borders/backgrounds with one neutral theme treatment. Performance fields were also changed away from decorative green styling.
- Post-fix inspection found no remaining P0, P1, or P2 visual issue. Browser-rendered controls remain enabled and no layout dimensions changed.

final result: passed

---

# Incremental Design QA — Mobile Language Switch and Collapsing Headers

## Comparison target

- Source visual truth: `/tmp/codex-remote-attachments/019fd084-5c34-7b50-ba25-ff74a5870269/E998AB3E-0F27-4CCF-B604-8710620BC452/1-사진-1.jpg` (`590 × 1280` px, including iPhone browser chrome).
- Browser-rendered injection implementation: `/private/tmp/wj-dashboard-hub-deploy/qa-language-injection-mobile.jpg` and `/private/tmp/wj-dashboard-hub-deploy/qa-language-injection-mobile-compact.jpg`.
- Browser-rendered mould implementation: `/private/tmp/wj-dashboard-hub-deploy/qa-language-mould-mobile.jpg` and `/private/tmp/wj-dashboard-hub-deploy/qa-language-mould-mobile-compact.jpg`.
- Combined source/default/compact comparison: `/private/tmp/wj-dashboard-hub-deploy/qa-language-switch-comparison.jpg` (`1280 × 920` px).
- Implementation routes: `http://127.0.0.1:5180/boards/injection` and `http://127.0.0.1:5180/boards/moulds`.

## Normalization and state

- All implementation captures use a `390 × 844` CSS viewport at device pixel ratio 1 and are saved at `390 × 844` pixels.
- The combined comparison scales the source image to the same 390 px column width as the implementation. Browser chrome remains visible only in the source and is excluded from app-owned fidelity findings.
- Default state: Korean locale, top of page, populated mould data; injection data in its existing live-loading state.
- Compact state: board content scrolled more than 56 CSS px, Korean locale, sticky mobile header collapsed.

## Full-view and focused evidence

- Full-view comparison shows that the original one-third control row has been replaced by a half-width language selector plus two quarter-width icon actions. Each language option now has enough horizontal space to read as an intentional segmented control.
- Focused header comparison shows a filled WJ-blue active language segment, muted inactive segment, and matching 44 px control height across both boards.
- After scrolling, both mobile headers reduce from approximately 235 px to 104 px while preserving home, board identity, language, refresh, and fullscreen controls. Secondary timestamp, search, and history content is removed only from the compact state.
- Injection and mould pages both remain exactly 390 px wide with no horizontal overflow. Compact injection language/action widths measure approximately 167/80.5 px; compact mould widths measure approximately 174.5/83.75 px.

## Required fidelity surfaces

- Fonts and typography: KOR and 中文 use the existing UI font stack at 0.72 rem with slightly increased letter spacing; active and inactive labels remain legible without wrapping. Compact titles retain the strongest hierarchy at 1.05 rem.
- Spacing and layout rhythm: the mobile action row uses a 2:1:1 proportion, 6–7 px gaps, and consistent 44 px touch height. Compact headers use 6 px internal gaps and 6–8 px padding, reducing vertical obstruction without crowding controls.
- Colors and visual tokens: both boards share the existing `#0a82b2` active fill, white active text, blue-tinted shadow, pale inactive surface, and neutral outlined icon actions.
- Image quality and asset fidelity: existing WJ logo and installed Lucide icons are reused at their intended rendered sizes; no new raster, custom SVG, CSS drawing, emoji, or placeholder asset was introduced.
- Copy and content: KOR/中文 labels and all existing Korean/Chinese board copy remain unchanged. Compact mode hides only duplicate secondary context and does not remove a primary action.

## Comparison history

### Pass 1

- [P2] The source showed the language control constrained to one third of the row, making two language options look cramped and visually weaker than neighboring fullscreen/close controls.
  - Fix: changed the mobile control grid to a 2:1:1 proportion and gave the selected language a clear filled state.
- [P2] The initial sticky mobile headers occupied roughly 235 px while scrolling, obscuring too much operational content.
  - Fix: added a 56 px scroll threshold and a compact 104 px two-row header that retains essential controls while hiding secondary metadata/search/history.

### Pass 2

- Post-fix browser evidence shows no actionable P0, P1, or P2 issue. Both default and compact states have complete controls, readable labels, stable 390 px width, and no scroll-trigger oscillation.

## Interaction and runtime checks

- Injection KOR → 中文 → KOR switching passed; the Chinese title became `注塑实时看板` and `aria-pressed="true"` moved to 中文.
- Mould KOR → 中文 → KOR switching passed; the Chinese title became `模具实时看板` and `aria-pressed="true"` moved to 中文.
- Injection window scroll activated `is-compact` at 404 px scroll position; mould container scroll activated the compact hero at 520 px.
- Returning both scroll containers to the top removed the compact state and restored the full header.
- `npm run build` — passed.
- `git diff --check` — passed.
- No visible application error or horizontal overflow was present in the verified states.

## Findings

- No actionable P0, P1, or P2 visual findings remain.
- P3: compact mode intentionally removes live timestamp details; returning to the top restores the full header immediately.

final result: passed

---

# Incremental Design QA — Mould and Injection Board Headers

## Comparison target

- Source visual truth (mould mobile): `/tmp/codex-remote-attachments/019fd084-5c34-7b50-ba25-ff74a5870269/51E14C97-F0C3-46CE-8B37-1B401360B33B/1-사진-1.jpg`.
- Source visual truth (injection mobile): `/tmp/codex-remote-attachments/019fd084-5c34-7b50-ba25-ff74a5870269/51E14C97-F0C3-46CE-8B37-1B401360B33B/2-사진-2.jpg`.
- Browser-rendered mobile implementations: `/private/tmp/wj-dashboard-hub-deploy/qa-mould-mobile.jpg` and `/private/tmp/wj-dashboard-hub-deploy/qa-injection-mobile.jpg`.
- Browser-rendered 4K implementations: `/private/tmp/wj-dashboard-hub-deploy/qa-mould-4k.jpg` and `/private/tmp/wj-dashboard-hub-deploy/qa-injection-4k.jpg`.
- Combined source/implementation comparison: `/private/tmp/wj-dashboard-hub-deploy/qa-header-mobile-comparison.jpg`.
- Implementation routes: `http://127.0.0.1:5177/boards/moulds` and `http://127.0.0.1:5177/boards/injection`.

## Normalization and state

- Both source images are `590 × 1280` px and include iPhone browser chrome.
- Both mobile implementation screenshots are `390 × 844` px at a `390 × 844` CSS viewport with device pixel ratio 1 and no browser chrome.
- The `1500 × 900` comparison board scales all four images to the same column width; the source and implementation aspect ratios differ by less than 0.1%, so header height and information density can be judged without geometric distortion.
- The 4K CSS viewport is `3840 × 2160` at device pixel ratio 1. The in-app browser screenshots are `3840 × 1920` px because the capture surface excludes its 240 px browser-control region.
- State: Korean locale, live production mould data, default board filters, injection production data after a manual refresh. The 4K injection empty/error state was also checked to ensure the header and board remain usable when upstream data is unavailable.

## Full-view comparison evidence

- The mould header keeps its existing WJ logo, home action, search, language, refresh, fullscreen, and freshness information, while scaling the same hierarchy for 4K instead of leaving controls visually undersized.
- The injection header now follows the same order as the mould header: board home, product mark, eyebrow/title, operational timestamps, secondary history action, language, refresh, and fullscreen.
- At `390 × 844`, both boards have a single-column body, `390 px` document width, no horizontal overflow, and touch controls at least `40–44 px` tall.
- At `3840 × 2160`, both headers span the display without clipping. Mould header height is approximately `128 px`; injection header height is approximately `125 px`, giving the two boards a consistent monitor-scale silhouette.

## Focused-region evidence

- The combined comparison isolates all four mobile headers and the first operational cards in one view. It confirms that the injection board no longer has an unrelated header grammar or a destructive-looking close action, and that both boards use the same white surface, blue outline, compact eyebrow/title, status-card, and control treatment.
- The 4K captures were inspected separately because the source references provide no 4K state. Search, timestamp, language, refresh, and fullscreen controls have measured bounding boxes within the header even when downsampling makes their text too small to judge in the full 4K image.

## Required fidelity surfaces

- Fonts and typography: existing Korean/Chinese system fallbacks are retained. Both headers use the same eyebrow weight/spacing, compact display-title rhythm, muted helper copy, and readable metadata hierarchy; labels do not wrap or truncate at mobile or 4K.
- Spacing and layout rhythm: both headers use an 8 px outer frame, 9 px radius, 8–10 px internal gaps, aligned icon tiles, bordered metadata cells, and consistent action rows. Mobile content stacks without hiding persistent controls.
- Colors and visual tokens: both boards use the existing navy/blue WJ palette, pale blue-gray background, white translucent header surface, blue active language state, and neutral outlined actions. Operational summary colors remain unchanged.
- Image quality and asset fidelity: the existing WJ raster logo is reused in the mould board, and all controls use the installed Lucide icon set. No placeholder, handcrafted SVG, CSS drawing, or emoji asset was added.
- Copy and content: all business labels and KOR/中文 switching remain intact. The injection header adds explicit board-home and refresh labels while removing the redundant close action from the anonymous direct-link board.

## Comparison history

### Pass 1

- [P2] The source captures showed two different header grammars: mould used home/logo/search/refresh while injection used a standalone factory mark and terminal-like close action.
  - Fix: added a home action, shared eyebrow/title hierarchy, explicit refresh action, matching outlined control surfaces, and consistent 4K scaling to the injection board; retained each board's domain-specific metadata.
  - Post-fix evidence: `qa-header-mobile-comparison.jpg` shows both boards using the same title → status → action reading order.
- [P2] The first injection mobile capture made the refresh action appear permanently unavailable while queries were pending.
  - Fix: kept the action enabled during background fetches, added `aria-busy`, and limited motion to the refresh icon.
  - Post-fix evidence: `qa-injection-mobile.jpg` shows the active outlined refresh control and a successful populated-state refresh without horizontal overflow.
- [P2] The first 4K injection pass mixed 40 px language controls with 68 px home, refresh, and fullscreen controls.
  - Fix: aligned the 4K language switch and primary icon actions to 68 px, and scaled the history/auto-refresh treatments proportionally.
  - Post-fix evidence: `qa-injection-4k.jpg` measures the language switch and all three icon actions at 68 px high within a 125 px header.

### Pass 2

- The revised combined mobile comparison and the two 4K captures found no remaining actionable P0, P1, or P2 visual issue.

## Interaction and runtime checks

- Injection KOR → 中文 → KOR language switching passed and updated the title, metadata, action labels, and board copy.
- Injection manual refresh passed; live data repopulated and `aria-busy` reflected the fetch state.
- Both home, fullscreen, and refresh controls are present with accessible names; fullscreen itself was not forced during capture because the QA viewport override was required.
- No uncaught browser runtime error was observed. One expected local-preview upstream request error was rendered through the board's existing error state during the 4K check; a subsequent mobile refresh succeeded with populated production data.
- `cd frontend && npm run build` — passed.
- Backend mould service tests — passed, 36 tests.
- `git diff --check` — passed.

## Findings

- No actionable P0, P1, or P2 visual findings remain.
- P3: the injection board's three mobile metadata cells are intentionally compact; on devices narrower than 360 px, abbreviating the labels may improve scan speed, but no clipping occurs at the requested 390 px phone viewport.

final result: passed

---

# Incremental Design QA — Mobile Header Information-Preserving Collapse

## Comparison target

- Source visual truth (injection): `/tmp/codex-remote-attachments/019fd084-5c34-7b50-ba25-ff74a5870269/70B48FF3-70F9-4AC7-A629-9C4A6734791F/1-사진-1.jpg` (`590 × 1280` px).
- Source visual truth (mould): `/tmp/codex-remote-attachments/019fd084-5c34-7b50-ba25-ff74a5870269/70B48FF3-70F9-4AC7-A629-9C4A6734791F/2-사진-2.jpg` (`590 × 1280` px).
- Browser-rendered injection implementation: `/private/tmp/wj-dashboard-hub-deploy/qa-header-v2-injection-mobile.jpg` and `/private/tmp/wj-dashboard-hub-deploy/qa-header-v2-injection-compact.jpg`.
- Browser-rendered mould implementation: `/private/tmp/wj-dashboard-hub-deploy/qa-header-v2-mould-mobile.jpg` and `/private/tmp/wj-dashboard-hub-deploy/qa-header-v2-mould-compact.jpg`.
- Combined comparison input: `/private/tmp/wj-dashboard-hub-deploy/qa-header-v2-comparison.jpg` (`1660 × 930` px).
- Implementation routes: `http://127.0.0.1:5180/boards/injection` and `http://127.0.0.1:5180/boards/moulds`.

## Normalization and state

- The two source captures include iPhone browser chrome. App-owned implementation captures use a `390 × 844` CSS viewport at device pixel ratio 1 and are saved at `390 × 844` pixels.
- The comparison board scales every source/implementation image to 390 px width. Browser chrome and live-data timing differences are excluded from app-owned visual findings.
- Default state: Korean locale at the top of each board. Compact state: more than 56 CSS px scrolled, after the 260 ms collapse transition completed.

## Full-view and focused evidence

- Both leading home buttons are absent. The injection title now begins with its factory mode control; the mould title begins with the existing WJ logo.
- The injection language switch now uses the same two equal grid columns, active fill, inactive surface, 44 px height, radius, and shadow treatment as the mould switch. At 390 px, its two tracks measure `78.5 px` each; mould measures `82.25 px` each because of its 7 px action-row gaps.
- Injection collapse preserves all three 48 px operational time cells: 기준일, MES 기준, and 화면 갱신. Its header transitions from 220 px through 136.4 px to 114 px.
- Mould collapse preserves the full 44 px 최종 변경 시각 row while collapsing the title and search rows. Its header transitions from 220 px through 131 px to 112 px.
- The compact screenshots show the retained information rows above live content with no horizontal overflow and no hidden primary language/refresh/fullscreen action.

## Required fidelity surfaces

- Fonts and typography: the existing Korean/Chinese font stack, label weights, timestamp hierarchy, and compact control labels are unchanged. Retained time values stay readable without wrapping.
- Spacing and layout rhythm: both boards collapse to approximately 112–114 px with a consistent information row plus action row. The 260 ms cubic-bezier transition animates title/search/history height, opacity, and translation instead of abruptly toggling display.
- Colors and visual tokens: both language controls share the WJ blue active fill, white active text, pale inactive background, blue shadow, and neutral outline.
- Image quality and asset fidelity: the existing mould WJ logo and Lucide factory/refresh/fullscreen icons remain sharp. The removed home icons were not replaced by custom artwork or placeholders.
- Copy and content: all Korean/Chinese labels remain intact. Compact injection retains 기준일/MES 기준/화면 갱신; compact mould retains 최종 변경 시각.

## Comparison history

### Pass 1

- [P2] Both source headers still led with a home button that the user no longer wanted.
  - Fix: removed both home controls and their unused navigation handlers/imports.
- [P2] The injection language wrapper used flex sizing, so its KOR/中文 segments did not fill the available half-width control like the mould switch.
  - Fix: changed the shared injection language wrapper to a two-column grid.
- [P2] The previous compact state hid every timestamp and switched layout abruptly with `display: none`.
  - Fix: retained the requested time rows and animated known heights, opacity, translation, padding, gaps, and borders over 260 ms.

### Pass 2

- Post-fix browser metrics show intermediate heights between default and compact endpoints, proving the collapse is progressive rather than discrete. No actionable P0, P1, or P2 issue remains.

## Interaction and runtime checks

- Injection KOR → 中文 → KOR passed; the Chinese title became `注塑实时看板` and `aria-pressed="true"` moved correctly.
- Mould KOR → 中文 → KOR passed; the Chinese title became `模具实时看板` and `aria-pressed="true"` moved correctly.
- Returning the mould scroll container to the top restored the header from 112 px to 220 px and removed compact state. Injection used the same verified threshold/state implementation.
- Injection document width and mould page width both remained 390 px at the 390 px viewport.
- At `3840 × 2160`, injection and mould remained 3840 px wide with zero home controls; their headers measured approximately 125 px and 128 px respectively.
- `npm run build` — passed.
- `git diff --check` — passed.

## Findings

- No actionable P0, P1, or P2 visual findings remain.
- P3: the compact header intentionally removes the board title; the retained timestamps and controls provide the requested high-value sticky context with minimal obstruction.

final result: passed
