# Design QA — Raw Material Management

## Comparison setup

- Reference: user-provided current raw-material page screenshot
- Implementation: local Chromium operational fixture
- Viewport: 1720 × 996
- Language/state: Korean, populated `原材料仓库` kg report with one localized data-quality warning

## Results

- Fixed context: warehouse, unit, and advanced selectors are removed; `原材料仓库`, kg, daily 08:00, report time, and manual refresh form one compact toolbar.
- Localization: no raw English MES warning is visible. Korean and Chinese warning variants are covered by the operational scenario.
- Information hierarchy: current stock, usable stock, 24-hour change, 30-day usage, and at-risk materials are visible before the diagnostic charts.
- Data integrity cues: explicit non-kg exclusions are stated; unavailable movement analysis is shown as uncollected rather than zero.
- Visualization: QC composition, replenishment risk, movement trends, daily comparison, ordering priority, material detail, and recent movements use the existing product visual language.
- Layout: the 1720 × 996 comparison shows no clipping, overflow, or broken card alignment. Search is located with the material table instead of in a global filter block.
- Empty comparison: the former large empty panel is replaced by a compact pending state when two consecutive 08:00 snapshots are unavailable.

## Iteration note

The first implementation capture wrapped the final Korean character of the page description onto a second line. The raw-material page now removes the desktop description width cap, and the repeated capture keeps the heading and description on one line.

## Final result

Passed
