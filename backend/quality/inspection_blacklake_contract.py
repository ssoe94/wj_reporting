"""Document-backed request construction, deliberately disconnected from production.

Contract and activation limits: docs/inspection-beta-development.md.
Read transport is injected and scoped to one work order/task. Write plans are
reviewable bytes only: no send/retry/credential capability is exposed here.
Public docs use integer IDs larger than JavaScript's safe integer range.
Keep MES IDs as strings at the frontend boundary and Python integers on the wire.
"""
import json
import re
from decimal import Decimal
from dataclasses import dataclass


ROUTE_BASE = '/api/openapi/domain/web/v1/route'
TASK_LIST = '/quality/open/v1/task/_list'
TASK_DETAIL = '/quality/open/v1/task/_detail'
PLAN_BY_WORK_ORDER = '/quality/open/v1/qc_plan/_get_by_work_order_id'
ITEM_RECORD = '/quality/open/v1/task/_update_task_check_item'
TASK_FINISH = '/quality/open/v1/task/_finish'
FIRST_INSPECTION = 3
PRODUCTION_INSPECTION = 4
PERIODIC_INSPECTION = 5


def inspection_check_type(value):
    # These are documented request enum values. Never infer them from a plan
    # name containing 首检/巡检, or from the local manual UI's process type.
    if type(value) is not int or value not in {FIRST_INSPECTION, PRODUCTION_INSPECTION, PERIODIC_INSPECTION}:
        raise ValueError('Use explicit documented inspection type 3, 4 or 5.')
    return value


def mes_id(value):
    if isinstance(value, bool) or not isinstance(value, (str, int)) or not re.fullmatch(r'[1-9][0-9]{0,18}', str(value)):
        raise ValueError('MES id must be an exact positive decimal string or Python integer.')
    number = int(value)
    if number > 9_223_372_036_854_775_807:
        raise ValueError('MES id exceeds the reviewed integer range.')
    return number


def encode_payload(value):
    """Exact JSON numbers without turning quantities into binary floating point."""
    if isinstance(value, Decimal):
        if not value.is_finite() or abs(value) > Decimal('1e15') or value.as_tuple().exponent < -6:
            raise ValueError('Invalid decimal in documented request.')
        return format(value, 'f')
    if isinstance(value, dict):
        return '{' + ','.join(json.dumps(k, ensure_ascii=False) + ':' + encode_payload(v) for k, v in value.items()) + '}'
    if isinstance(value, list):
        return '[' + ','.join(encode_payload(v) for v in value) + ']'
    if isinstance(value, float):
        raise ValueError('Use exact decimal quantities, never float IDs or quantities.')
    return json.dumps(value, ensure_ascii=False, allow_nan=False)


class ScopedInspectionReadClient:
    def __init__(self, post_json):
        # Signature: (route_path, exact_json_text) -> decoded body. No transport
        # is configured by this module or by get_inspection_adapter().
        self._post_json = post_json

    def list_inspections(self, work_order_id, *, check_type, page=1, size=25):
        if type(page) is not int or type(size) is not int or not 1 <= page <= 2 or not 1 <= size <= 25:
            raise ValueError('Inspection lookup is bounded to two pages of at most 25 rows.')
        payload = {'workOrderIds': [mes_id(work_order_id)], 'checkType': inspection_check_type(check_type), 'page': page, 'size': size}
        return self._post_json(ROUTE_BASE + TASK_LIST, encode_payload(payload))

    def list_first_inspections(self, work_order_id, *, page=1, size=25):
        return self.list_inspections(work_order_id, check_type=FIRST_INSPECTION, page=page, size=size)

    def list_periodic_inspections(self, work_order_id, *, page=1, size=25):
        return self.list_inspections(work_order_id, check_type=PERIODIC_INSPECTION, page=page, size=size)

    def detail(self, task_id):
        # receiveUserId deliberately omitted: a read must not claim another actor.
        return self._post_json(ROUTE_BASE + TASK_DETAIL, encode_payload({'id': mes_id(task_id)}))

    def first_inspection_plan(self, work_order_id):
        return self.inspection_plan(work_order_id, check_type=FIRST_INSPECTION)

    def periodic_inspection_plan(self, work_order_id):
        return self.inspection_plan(work_order_id, check_type=PERIODIC_INSPECTION)

    def inspection_plan(self, work_order_id, *, check_type):
        return self._post_json(ROUTE_BASE + PLAN_BY_WORK_ORDER,
                               encode_payload({'workOrderId': mes_id(work_order_id), 'checkType': inspection_check_type(check_type)}))


@dataclass(frozen=True)
class DocumentedStage:
    endpoint: str
    json_body: str


def result_and_finish_plan(task_id, records, *, verdict):
    """Compile documented stages for review/mocks, not an executable adapter.

Does not infer attachmentIds from URLs, copy local item ids into MES ids, update
specifications, bind/change inventory or bypass weak control rules. Sample-record
and task-config requirements must be resolved before this plan can be executed.
The workflow may contain approval after finish; HTTP success is never completion.
The conclusion must be supplied explicitly; no default pass is constructed.
"""
    task_id = mes_id(task_id)
    statuses = {'pass': 1, 'concession': 2, 'pending': 3, 'fail': 4}
    if verdict not in statuses or not isinstance(records, list) or not 1 <= len(records) <= 50:
        raise ValueError('Invalid record set or explicit QC verdict.')
    items = []
    sample_keys = set()
    for record in records:
        if not isinstance(record, dict) or set(record) - {'checkItemId', 'groupName', 'seq', 'result', 'min', 'max', 'attachmentIds'}:
            raise ValueError('Only reviewed item-record fields are allowed.')
        group, seq = record.get('groupName'), record.get('seq')
        if not isinstance(group, str) or not group.strip() or len(group) > 128 or type(seq) is not int or not 1 <= seq <= 10000:
            raise ValueError('groupName and positive integer seq are required.')
        item = {'checkItemId': mes_id(record.get('checkItemId')), 'groupName': group, 'seq': seq}
        sample_key = (group, item['checkItemId'], seq)
        if sample_key in sample_keys:
            raise ValueError('Duplicate group/item/sample in reviewed result records.')
        sample_keys.add(sample_key)
        if 'result' in record:
            if not isinstance(record['result'], str) or len(record['result']) > 500:
                raise ValueError('Item result must be bounded text.')
            item['result'] = record['result']
        for bound in ('min', 'max'):
            if bound in record:
                number = record[bound]
                if not isinstance(number, Decimal):
                    raise ValueError('Numeric item result requires Decimal.')
                encode_payload(number)
                item[bound] = number
        if 'attachmentIds' in record:
            ids = record['attachmentIds']
            if not isinstance(ids, list) or len(ids) > 10:
                raise ValueError('At most 10 verified attachment ids.')
            item['attachmentIds'] = [mes_id(value) for value in ids]
        items.append(item)
    return [DocumentedStage(ITEM_RECORD, encode_payload({'taskId': task_id, 'checkItems': items})),
            DocumentedStage(TASK_FINISH, encode_payload({'id': task_id, 'status': statuses[verdict]}))]
