# Design QA — Grouped Raw-Material Stock Details

## Comparison setup

- Source visual truth: `C:\Users\ssoe9\AppData\Local\Temp\codex-clipboard-9b49095d-4bef-47e4-aa64-b2d05e825406.png`
- Implementation screenshot: `C:\Users\ssoe9\.codex\visualizations\2026\07\14\019f5f4a-467a-7772-b834-02813867c479\raw-material-grouped-details-2026-07-15.png`
- Viewport: 1691 × 1152
- State: Korean raw-material dashboard, `ABS HA641 18388` grouped to one 290 kg row with its three current-stock records expanded
- Source crop note: the source screenshot is cropped to the inventory table, while the implementation capture retains the existing application sidebar and adjacent dashboard panels. The table region was therefore used as the focused fidelity comparison.

## Evidence and interactions

- Full-view comparison: the source and implementation were opened together in one comparison input at the same 1691 × 1152 viewport.
- Focused region comparison: the inventory table header, grouped summary row, numeric alignment, row density, borders, typography, and the new expanded-detail region were inspected at readable scale.
- Primary interactions tested in the in-app browser: expand, collapse, re-expand, Korean/Chinese language switch, missing receipt-date localization, and QC-status localization.
- Console errors checked: none.

## Findings

- No actionable P0, P1, or P2 differences remain.
- The grouped row preserves the source table's compact hierarchy and numeric alignment while adding a clear chevron and a three-record count.
- The expanded area is visually subordinate to the grouped total, and its detail sum of 290 kg reconciles with the parent row.
- Missing `bizKeyAttr.inboundTime` is visibly labeled `미수집 / 未采集` rather than being replaced by the inventory-row creation date.

## Required fidelity surfaces

- Fonts and typography: existing product font stack, compact weights, line heights, truncation, and numeric emphasis are retained.
- Spacing and layout rhythm: header height, row density, sticky columns, cell padding, and table borders remain consistent; the detail panel uses the same radius and section spacing as adjacent panels.
- Colors and visual tokens: existing accent, muted text, QC semantic colors, borders, and surface colors are reused without introducing a new palette.
- Image quality and assets: no new raster or decorative asset was required; the existing application logo and icon library remain unchanged and sharp.
- Copy and content: Korean and Chinese labels cover the grouping behavior, receipt date, batch/identifier, QC, location, inbound document, and missing-data state.

## Comparison history

- Initial browser pass: grouping, expand/collapse, total reconciliation, receipt-date display, and both language states worked with no layout defect.
- Copy polish: changed the Korean hint from the literal mixed-language term `물료번호` to the product-friendly `원료 코드`; the final capture reflects the revised wording.

## Server-load safeguard

- The overview carries only each group's detail count. Expanding a row reads one bounded, cached detail page from the saved MES snapshot, so the initial dashboard payload does not grow with every inventory record.

## Final result

passed
