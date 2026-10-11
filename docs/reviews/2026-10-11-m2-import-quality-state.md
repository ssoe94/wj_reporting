# M2 import: explicit feeding quality states rejected

Historical report of the 07:37 failure and initial diagnostic change. The later
authorized `WJ-IT-QC-20261011-003` omission trial succeeded at 09:18 and established
the current [input quality contract](../mes-plan-input-qc-contract.md).
The sections below preserve the earlier findings; the 1,692-unit request still
requires correlated rejection evidence, a newly prepared contract and approval
before another creation. M2 remains incomplete.

## Actual result

On 2026-10-11 at 07:37:50 Asia/Shanghai, the authorized WJ screen action
attempted exactly one import on deployed commit
`cd2945e5dc4ab7a88cfb25f6e05152976d80e203`:

- Request `0932592c-ab15-46a9-b33b-892b19bcd865`.
- Order `WJ-0e225a71d55c432bb68b03e6c2f8de73`.
- Plan 17884, version 2, material approval 2; LOT `6L1M052Q` only.
- `850T-9 / ACQ30776301 / 1692`, 2026-10-12 08:00 to 2026-10-13 08:00.
- Inputs: MGJ63673601 5076 个, MGJ65121305 1692 个,
  ABS HA641 B8826 725.868 KG. Departments/planner: ZS / 002 / 2299.

The MES system integration log for `wj_report` in 南京万佳 records the response:

```json
{
  "code": 0,
  "subCode": "MED-DOMAIN/IMPORT_CREATE_ERROR",
  "message": "对象创建失败",
  "data": [
    "投料质量状态输入不合法",
    "投料质量状态输入不合法",
    "投料质量状态输入不合法"
  ],
  "needCheck": 0
}
```

Log ID: `56e600be-d91f-4dc7-8008-53237880ab60`. Exact-code reads after the
attempt, including 07:41:49, found no order. WJ retains attempt=1 and the
unresolved/recheck state; no retransmission or reservation reset was performed.
The global writer remains ON as requested. No dispatch, start, inventory action,
master edit, or change to the earlier 1920-unit order was performed.

## Contract discrepancy and required answer

Each explicit `inputMaterialControlOpenCOs` item sent `inputQcState` as the
string `"[1,2]"` for 合格 and 让步合格. Public document 1686655055663528,
`InputMaterialControlOpenCO.inputQcState`, still declares type `string` with
example `"[1,2,3]"`. The observed import rejects that form. The v2 editing API
uses an integer array, but its contract does not establish the import encoding.
Earlier imports omitted the entire control array; they do not prove the default
when only `inputQcState` is omitted from an explicit control item.

Required provider clarification (ready to forward; not sent):

> 南京万佳 wj_report 调用 `/med/open/v2/work_order/_doimport`，在
> `inputMaterialOpenV2COs[].inputMaterialControlOpenCOs[]` 中传入
> `inputQcState: "[1,2]"`，表示“合格、让步合格”。公开文档
> 1686655055663528 将该字段定义为 string，示例为 "[1,2,3]"，但日志
> 56e600be-d91f-4dc7-8008-53237880ab60 返回“投料质量状态输入不合法”。
> 请提供此导入接口同时允许这两种质量状态的实际可用请求示例，并确认枚举值和编码格式。

Do not try alternative encodings, remove quality controls, allocate a different
number, or clear attempt=1 without resolving the contract and recovery path.
M2 is not complete: no new object exists for department, material, control and
field acceptance checks. Number sequence and displayed version remain separately
deferred under `2026-10-11-plan-m2-number-version.md`.

## Local diagnostic improvement

The transport now recognizes only the exact observed import-error envelope and
records the fixed blocker `input_quality_state_invalid` in the existing event.
Unknown errors retain the generic rejection. Provider text, tokens and arbitrary
response objects are never copied into the event. Read routes cannot claim this
write-specific diagnosis. Attempts and replay checks are unchanged.

This does not correct the unverified encoding, change the historical event, or
add UI display of historical creation diagnostics. Regression covers exact
recognition, misleading envelopes, private-text exclusion, recheck history and
the single-attempt fence. Disposable SQLite: 334 tests, 328 passed, 6 PostgreSQL
tests skipped; no live MES calls in these tests.

Local evidence directory: `output/mes-plan-release-20261011/` in the primary
checkout: `mes-import-rejection.json`, `selected-pre-send.json`,
`selected-duplicates-pre-send.json`, `selected-final-outcome.json`, and
`wj-failed-outcome.png`. Request-query credentials are excluded from saved logs.
