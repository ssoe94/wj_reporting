# WJ operational design profile

Selected by the owner on 2026-10-21. This profile supersedes the earlier color direction only where this migration applies. C (Gold/Ink) is discarded.

## Appearance

- Light = A, Silver/Cyan: canvas `#F3F5F7`, content/navigation white, text `#222B33`, secondary text `#5D6872`, action `#006D91`, selection `#EDF7FB`.
- Dark = B, Black/Mint: canvas `#101619`, content `#192328`, navigation `#0B1013`, text `#EFF5F6`, secondary text `#ADBCC4`, action `#57F2B6`, selection `#153C31`.
- The owning role declarations are `frontend/src/styles/design-tokens.css`. Domain styles alias these roles; do not reintroduce independent pale-blue backgrounds or page-specific dark overrides.
- Actions use `--wj-on-accent`; dark mint buttons need dark lettering. Success, attention, failure and data-series colors have separate roles with explicit status names.
- Keep the supplied logo and its aspect ratio, on a small white plate when necessary. Check the visible glyph center of the uppercase wordmark independently of its line box.

- Neutral panels use `--wj-surface-muted`: light `#F4F8FA`, dark `#202D33`. Chart tint keeps its pre-review values under the separate `--wj-data-tint` role. Reserve `--wj-accent-soft` for selection and pressed/drag choices; do not tint neutral cards or empty/help states mint. Success uses a distinct olive-green dark fill `#30451C` with `#C4EB91` lettering; light info uses periwinkle `#E5EDFF` with `#274C91` lettering, separate from cyan selection.

## Mode behavior

- Injection board (`/boards/injection`, `/production/injection-board`, including legacy aliases) is excluded. Force legacy light before first paint and at runtime, restore its pre-A/B dedicated rules and shared dialog appearance, and preserve the stored ordinary preference.
- Field kanban (`/field`, `/field/:stationId`) and recognized field-terminal accounts are excluded. Keep both field page styles equal to main and force light before first paint and at runtime, without changing the saved ordinary-workspace preference. Scoped legacy roles protect shared field controls from A/B colors.

- Shared light/dark preference is stored under `wj:appearance:v1`; light is the default. Apply before React for a stable first paint. Browser-storage denial must not break the appearance controls.
- Switching appearance preserves current forms, query filters, selection, permissions and auth-session ownership.
- Existing lightweight mode remains a separate low-effect, high-contrast light mode. It temporarily uses light appearance without overwriting a preferred dark choice.
- Overview retains its independent Asia/Shanghai 08:00/20:00 schedule, expiring manual override, image-only logo toggle and 3x3 composition. Its local `--board-*` roles use the selected palettes independently of the ordinary workspace preference.

## Layout and typography

- Existing system Korean/Chinese sans-serif coverage; 14–16px working text, 12–13px supporting labels where readable. Improve density by reducing spacing and duplication, not by shrinking working text.
- One stable page title and task toolbar. Use 4/8/12/16/24 spacing by relationship and restrained 1px boundaries. Avoid nested cards, decorative gradients and redundant summaries.
- Table text/identifiers left, quantities right, short equipment/selection/actions centered, matching headers. Ordinary cells vertically centered; expanded multi-paragraph details can align to their reading start.
- Two-line records start at 48px and grow for meaningful content. Shared header/body cell inset 12px. On narrow screens use deliberate local scrolling or labelled record layouts.
- Explanatory paragraphs and prose lists use justified full lines with a start-aligned last line; headings, controls, numerical tables and link strips retain their own alignment. Use language-aware wrapping in narrow columns.
- Sidebar keeps 16px/650 group labels and 14px/450 links, soft selection without a stripe, explicit mobile focus/close behavior. Login shares the same surface, input, button and appearance grammar.

## Verification and scope

Check representative Korean/Chinese desktop and narrow layouts in both modes, including forms, menus, date inputs, empty/error/expanded states and chart labels. Preserve series meanings and source identifiers. Chart label foreground may adapt to contrast while the series colors and quantities stay unchanged.

Run frontend contract tests, lint, TypeScript and modern/legacy builds. Existing CI decides release scope. Local screenshots and fixtures are synthetic; a successful deployment is separately verified by build identity and site behavior. A physical kiosk is not accepted by a desktop screenshot.
