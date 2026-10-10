# M2 number and BOM version decision

Decision on 2026-10-11: defer MES sequence numbering and displayed BOM version for M2. This does not mark either feature complete. No number was allocated and no MES order/master was changed during this review.

## Numbering

Official document 1734580710879848 accepts objectCode/objects and fieldCode or numberRuleCode. The objects count allocates numbers. It is not a harmless permission probe. The document does not establish a recoverable/idempotent allocation contract. The tenant's exact work-order rule binding, allocation permission and date/counter scope remain unverified. Recent GD numbers alone do not establish these rules. Keep the persisted unique WJ order number for duplicate-safe creation; do not infer the next GD number from the largest observed value.

Before applying: identify the tenant rule and permission through read-only administration, then agree how to persist/recover an allocated number before attempting one authorized allocation. Do not consume a number just to test permission.

## BOM version

The existing actual M2 request sent output version 1.0; the resulting order's displayed version and bomId were null. Older orders have version 1.0/bomId 1751346014255499 alongside the replacement resin B8826, but their creation method is unknown. This does not prove that useBomFlag=1 retains explicit replacement rows.

The v2 import contract permits an output version but does not document an output bomId or precedence between BOM expansion and explicit input rows. The whole-object update API does not establish a safe partial correction. Preserve the existing actual order unchanged.

For new BOM-backed approvals, record the current source BOM ID/version/hash and every input row in WJ. Send the verified explicit-input creation path (useBomFlag=0), leave output_version empty, and show the MES displayed version as deferred in M2 evidence. Source BOM version and MES order version are distinct facts. M2 may close only with this documented deferral plus the approved actual trial and field acceptance; it does not close numbering/version work.

## BOM auto-read scope

Read the one enabled default BOM for the exact part number and its single-process route through the existing pure APP transport. Keep all input rows, sequence numbers, units and ratios. Only leaf category CAT-011 resin rows may be replaced, with an enabled material in that same category and exact unit. Re-read source and replacement metadata before creation; a changed or unavailable source blocks the write.

This first scope supports one output, productRate=100, lossRate=0, one process, and no nested/alternative/split BOM. Unsupported structures stop for review. Each input requires one verified control line, a denominator of 1, ordinary feed type, and no quantity bounds or SOP control. The official import control DTO has no denominator or feedType field; other shapes are not inferred.

Full existing-order evidence exposed a concrete difference missed by quantity-only acceptance: the prior WJ order's two hardware rows have mandatory feed=1/backflush=0, while all three compared operational orders and the current BOM have mandatory feed=0/backflush=1. Resin is 1/1 in all four orders. The existing WJ order stays unchanged.

New BOM approvals preserve line sequence, numerator, mandatory-feed flag, backflush flag, QC states and no-bound limit. The create payload sends these through the documented inputMaterialControlOpenCOs fields (feedFlag, backFlush, inputQcState as a JSON string, limit, lineSeq and inputAmountNumerator). The source and its controls are reread before creating. New contracts reread every input and its controls, bracketed by equal base reads; a mismatch becomes review and is never resent. This is documented request support and local regression evidence, not proof that MES has accepted a new controlled import. Actual M2 acceptance must verify that on the next authorized order.

## Evidence

Local evidence under `/Users/macstudio_ted/Developer/wj_reporting/output/`:

- `mes-m2-comparison-20261010/official-number-rule.json`
- `mes-m2-comparison-20261010/official-bom-inline-precedence-review.md`
- `mes-m2-comparison-20261010/live-comparison.json` and `recent-codes.json`
- `mes-m0-20261010/official-bom-detail.json`, `official-route-detail.json`, `official-wo-create.json`
- `mes-metadata-20261010/master-blank-fill-report.md` (previously approved 9 specifications / 3 categories; separate from order creation)
