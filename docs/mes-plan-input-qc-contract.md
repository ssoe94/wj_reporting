# Work-order input quality contract — 2026-10-11

`inputQcState` controls eligible input-lot quality states. It is separate from
finished-product first-article and periodic inspection results and triggers.

## Observed import behavior

The official work-order import document 1686655055663528 describes a String.
The tenant rejected both strings `"[1,2]"` and `"1,2"` with
`MED-DOMAIN/IMPORT_CREATE_ERROR` / `投料质量状态输入不合法`. A JSON array `[1,2]`
failed String deserialization. Other endpoints' array schemas are not evidence
that import accepts arrays.

On 2026-10-11, the explicitly approved draft `WJ-IT-QC-20261011-003` was sent
once with only this field omitted. MES ID `1791681034680794` has draft status,
output `0/测试物料` quantity 1, input `100*125` quantity 1, ZS process, no resource,
and the approved October 12 08:00–October 13 08:00 Shanghai period. Independent
API reads and the MES input-control dialog showed **合格 + 让步合格 (1,2)**.
Other control values matched the baseline. No dispatch, start or inventory
operation was performed. Evidence is in the task's
`output/mes-plan-release-20261011/qc-default-trial-result.md` and accompanying JSON/screenshots.

## Product behavior

Keep the approved BOM snapshot, including its QC expectation, immutable. For
the observed `[1,2]` expectation, omit only the import field. Before reserving
the single write attempt, read each selected material with
`/material/open/v2/material/_list_by_codes`, `queryFieldList: [1,10]`, and require
its exact identity, enabled status and `feedInfo.qcStatus` to match the approval.
Missing, duplicate, malformed or different defaults block creation. Other
approved QC combinations remain unsupported. After creation, compare actual
input controls with the approval even though QC was absent from the payload.
Historical explicit-field contracts remain readable.

A known QC validation rejection followed by exact-code absence can be recorded
as `rejected`; this is not a general retry policy or a provider atomicity
guarantee. Preserve prior attempts and events. Only a changed provider payload
may produce a new request, with a fresh exact-code precheck before sending.
Generic errors, timeouts and any observed MES identity stay unresolved.
The old 1,692-unit request contains only a generic stored error; it requires
explicit correlation with the original MES log and is not reclassified by deployment.
