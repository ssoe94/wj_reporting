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
