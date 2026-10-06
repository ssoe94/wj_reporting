# Inspection board: selected miniature design

Local implementation for the user's approved C information layout and simple
blue/yellow miniature injection machine with a small inspector. The selected
reference files are `WJ-inspection-C-revised-simple-3D.png` and
`WJ-inspection-3D-motion-storyboard.png`. Both original PNGs were materialized
from their existing Library identities and visually inspected on the Mac.
This is implementation evidence, not deployment or live MES acceptance.

## Existing service vocabulary and navigation

The public injection board was inspected on 2026-10-04 at 14:35:27 UTC using
an isolated browser and public GET requests only. It uses injection machines
1–17, separate tonnage, the production business date, current product, production
progress and MES observation time. Its code supplies the same Korean/Chinese
machine and production-state terms used by the new board.

The new route is `/boards/inspection`, linked from the board hub. It uses the
existing brand and language controls. Three rows contain 1–6, 7–12 and 13–17;
these are display groups, not invented physical A/B/C production lines. The
selected machine opens the right-hand detail. The original injection board is
linked back from the footer.

## Data boundaries

- Production estimates reuse the existing production calculation and are labeled
  as business-day output estimates. They are not inspected quantities.
- Current product and plan require the exact current plan and revision. A prior
  response or changed plan cannot establish current inspection status.
- First and periodic inspections remain separate. Individual observations and
  complete coverage of the required inspection population remain separate.
  Missing evidence is unknown, not a zero count or a passed inspection.
- Public data does not expose request-level MES save phase, inspected quantities
  or resolved disposition. Those fields remain unconfirmed; authenticated request
  details provide the actual save/completion workflow and audit records.
- The local observation list is explicitly a set of received observations for
  the current plan. The cumulative-history link opens authenticated inspection
  requests. It is not a fabricated public audit-history API.
- A failed or overdue inspection does not imply that concession, scrap or rework
  has been performed. A completed QC does not close those follow-up actions.
- Failed refreshes, stale data and late responses retain their uncertainty. The
  generation floor is preserved across temporarily missing datasets.

## Motion, assets and accessibility

The two transparent raster assets were generated from the approved reference
direction. No real factory photographs, production records or measurement values
are embedded in them. Standard controls use the existing project icon library.

The inspector has a small decorative movement only when a fresh, confirmed
observation is in progress. It is not synchronized with a machine cycle and does
not imply a measured production event. Stale/error states disable this movement.
Both the user's reduce-motion control and the operating-system preference are
honored. Status text accompanies every semantic color; native buttons, links and
the existing inspection-detail dialog preserve keyboard interaction.

The chosen composition is adapted to the existing Korean/Chinese font system,
real field names and available data. Example measurements, counts, plan numbers
and lettering errors in the mockup are not copied into the application.

## Verification

The pure view model adds 17 contract tests. The complete frontend Node suite
passed 410 tests with no skips. The final build completed at 2026-10-04
15:18:47 UTC with Vite and legacy checks passing. The same built assets passed
8 browser scenarios / 59 checks at 15:19:18 UTC: 17 machines, Korean/Chinese,
history/dialog navigation, motion preferences, stale/error/changed-plan states,
1672×941 and 1920×1080 desktop fit, and mobile horizontal fit. The existing
React–Django save/finish/reconciliation fixture then passed 2 scenarios / 26
checks on the preceding build. The only subsequent runtime change was two Korean/Chinese
help-text strings narrowing the history description; the final board browser
fixture passed again. MES responses were synthetic in both fixtures.

Private evidence: `output/inspection-board-browser-final3-20261004.json`,
`output/inspection-live-browser-board-release-final.log`, and
`output/inspection-board-design-comparison-20261004.png`. A private QA record
outside the public source tree records the original/render comparison and limitations.
Root visual review passed the agreed local scope; design is provisionally frozen
while actual authentication and single-QC acceptance take priority. Detail content
scrolls within its desktop panel when needed; mobile uses normal vertical scroll.
These results establish neither deployment nor actual MES acceptance.

The backend single-QC path is unchanged by this design. Its separate saved
checkpoint and live-acceptance conditions are described in
`inspection-single-task-live-path.md`.
