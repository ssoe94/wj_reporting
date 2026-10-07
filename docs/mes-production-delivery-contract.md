# MES production and inbound observation

Production orders, production actions and inbound operations are performed by
users in MES. WJ reads the selected existing work order and displays observed
states and the next action. WJ retains QC result saving and individual inspection
completion through the existing QC adapter. The four existing integration flags
and the Lee connection are not changed by this implementation.

`ScopedProductionWriter` rejects construction and every call before credential,
authority or network access. No production/inbound mutation endpoint is exposed.
Historical pure write contracts and isolated coordinator fixtures are retained
as development history; they do not activate a runtime writer.

## Read path

`GET /api/production/mes-read-status/?business_date=YYYY-MM-DD&work_order_code=...`
requires a current unrestricted superuser. Without a code, GET and HEAD perform
no MES request. The dashboard and injection board make no initial request or
poll; the user selects an existing MES code and explicitly queries its state.

The server uses only these four fixed READ APIs, once each at most:

| Official API | Document | Route after `/api/openapi/domain/web/v1/route` |
|---|---|---|
| 工单基本信息详情 | [1686655055663531](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1686655055663531.md) | `/med/open/v2/work_order/base/_detail` |
| 生产任务列表 | [1681109889053785](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889053785.md) | `/mfg/open/v1/produce_task/_list` |
| 报工记录列表 | [1681109889053794](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889053794.md) | `/mfg/open/v1/progress_report/_list` |
| 批量根据报工记录查询入库记录 | [1693449354592534](https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1693449354592534.md) | `/mfg/open/v2/progress_report/_list_inbound_record` |

The selected code must match the returned work-order ID/code. Task IDs must be
from that exact work order; report IDs must match those tasks within the selected
Shanghai 08:00 business day. Inbound observations must join to the observed
report IDs. Queries and response sizes are bounded; missing or truncated evidence
stays partial. IDs and quantities preserve exact representation.

The reader reuses the current account's USER lease. Its explicit identity client
accepts only an already available static/cached APP token: no USER/APP issuance,
refresh, fallback, response-driven retry or additional stored authority. Missing
connection/supply and provider permission errors are distinct fixed failures.
Raw responses, credentials and QC measurements are never returned to this UI.

## State interpretation and validation

Only documented task statuses 1–5 are mapped. The work-order lifecycle enum is
not guessed. A linked inbound record confirms a recorded operation; it does not
prove current net stock, irreversible completion or physical machine actuation.
The user checks those states and performs the next production/inbound action in
MES. WJ links inspection entry/completion to its existing QC screen.

Permission failures, changed date/code/account, failed refresh and expired
observations hide prior completion claims. Regression tests use synthetic leases,
injected senders and disposable databases. CI and deployment do not prove a live
MES business transaction; live acceptance requires the needed READ permissions
and an explicitly selected existing MES work order.
