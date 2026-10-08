"""Operator-requested MES production-task state changes.

Only four operations exist: start, resume and pause a production task, and close
the work orders of selected tasks. Every task is re-read immediately before the
write and checked against what the operator saw (status, machine, task code). The
write is sent once; there is no automatic retry. The result is confirmed only by
reading MES again. Anything between "sent" and "confirmed" is reported as
uncertain so the operator re-checks MES instead of repeating the action.

The feature is off unless settings.MES_TASK_ACTIONS_ENABLED is true.
"""
from __future__ import annotations

import re
import time
from dataclasses import dataclass, replace
from typing import Any, Callable

from .mes_progress import extract_machine_number

DETAIL_PATH = '/mfg/open/v2/produce_task/_detail'
CLOSE_PATH = '/med/open/v2/work_order/batch_close'
TASK_ACTIONS = {
    # action: (path, allowed current statuses, expected status afterwards)
    'start': ('/mfg/open/v2/produce_task/_start', {1}, 2),
    'resume': ('/mfg/open/v2/produce_task/_resume', {3}, 2),
    'pause': ('/mfg/open/v2/produce_task/_pause', {2}, 3),
}
CLOSE_ACTION = 'close_work_order'
ALLOWED_ACTIONS = {*TASK_ACTIONS, CLOSE_ACTION}
MAX_ITEMS = 30
MAX_REASON = 200
MESSAGE_LIMIT = 200

Sender = Callable[[str, dict[str, Any]], dict[str, Any]]


class ActionRequestError(ValueError):
    """The request itself is invalid; nothing was read or sent."""


@dataclass(frozen=True)
class ActionItem:
    action: str
    task_id: str
    task_code: str
    machine_number: int
    expected_status: int
    work_order_code: str
    part_no: str


def parse_items(payload: Any) -> tuple[list[ActionItem], str]:
    if not isinstance(payload, dict):
        raise ActionRequestError('invalid_body')
    reason = payload.get('reason')
    if not isinstance(reason, str) or not reason.strip() or len(reason) > MAX_REASON:
        raise ActionRequestError('invalid_reason')
    raw_items = payload.get('items')
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > MAX_ITEMS:
        raise ActionRequestError('invalid_items')
    items, seen = [], set()
    for raw in raw_items:
        if not isinstance(raw, dict):
            raise ActionRequestError('invalid_items')
        action = raw.get('action')
        task_id = raw.get('task_id')
        task_code = raw.get('task_code')
        machine = raw.get('machine_number')
        status = raw.get('expected_status')
        work_order = raw.get('work_order_code', '')
        part = raw.get('part_no', '')
        if (action not in ALLOWED_ACTIONS or not isinstance(task_id, str) or not re.fullmatch(r'\d{1,20}', task_id)
                or not isinstance(task_code, str) or not task_code.strip() or len(task_code) > 100
                or type(machine) is not int or machine not in range(1, 18)
                or type(status) is not int or status not in {1, 2, 3}
                or not isinstance(work_order, str) or len(work_order) > 100
                or not isinstance(part, str) or len(part) > 100):
            raise ActionRequestError('invalid_items')
        if action == CLOSE_ACTION and not work_order.strip():
            raise ActionRequestError('invalid_items')
        if action in TASK_ACTIONS and status not in TASK_ACTIONS[action][1]:
            raise ActionRequestError('action_not_allowed_for_status')
        if task_id in seen:
            raise ActionRequestError('duplicate_task')
        seen.add(task_id)
        items.append(ActionItem(action, task_id, task_code.strip(), machine, status, work_order.strip(), part.strip()))
    return items, reason.strip()


def _status_code(detail: dict[str, Any] | None) -> int | None:
    if not isinstance(detail, dict):
        return None
    status = detail.get('taskStatus')
    if isinstance(status, dict):
        status = status.get('code')
    return status if type(status) is int else None


def _machine(detail: dict[str, Any]) -> int | None:
    equipments = detail.get('equipments')
    if not isinstance(equipments, list) or not equipments:
        return None
    numbers = {extract_machine_number(item.get('name')) for item in equipments if isinstance(item, dict)}
    return numbers.pop() if len(numbers) == 1 and None not in numbers else None


def _safe_message(payload: Any) -> str:
    message = payload.get('message') if isinstance(payload, dict) else None
    if not isinstance(message, str):
        return ''
    # Provider messages may echo identifiers or tokens; keep a short, single-line text.
    message = re.sub(r'(?i)(access_?token|app_?secret|app_?key)\S*', '[redacted]', message)
    return ' '.join(message.split())[:MESSAGE_LIMIT]


def _ok(payload: Any) -> bool:
    return isinstance(payload, dict) and payload.get('code') == 200


def _read_detail(send: Sender, task_id: str) -> dict[str, Any] | None:
    payload = send(DETAIL_PATH, {'taskId': int(task_id)})
    if not _ok(payload) or not isinstance(payload.get('data'), dict):
        return None
    return payload['data']


def _mismatch(item: ActionItem, detail: dict[str, Any]) -> str | None:
    """Return a blocking reason when MES no longer matches what the operator saw."""
    if str(detail.get('taskId')) != item.task_id or detail.get('taskCode') != item.task_code:
        return 'task_identity_changed'
    if _status_code(detail) != item.expected_status:
        return 'status_changed'
    if _machine(detail) != item.machine_number:
        return 'machine_changed'
    work_order = detail.get('relatedWorkOrderCode') or detail.get('workOrderCode')
    if item.work_order_code and work_order != item.work_order_code:
        return 'work_order_changed'
    return None


def _result(item: ActionItem, outcome: str, **extra: Any) -> dict[str, Any]:
    result = {
        'task_id': item.task_id, 'task_code': item.task_code, 'action': item.action,
        'machine_number': item.machine_number, 'work_order_code': item.work_order_code,
        'part_no': item.part_no, 'status_before': item.expected_status,
        'outcome': outcome, 'status_after': None, 'reason': '', 'mes_code': None,
        'mes_sub_code': '', 'mes_message': '', 'need_check': None,
    }
    result.update(extra)
    return result


def _task_body(item: ActionItem, reason: str, actor_label: str, operator_id: int | None, now_ms: int) -> dict[str, Any]:
    body: dict[str, Any] = {'taskId': int(item.task_id)}
    if item.action in {'pause', 'resume'}:
        body['operateTime'] = now_ms
        if operator_id is not None:
            body['operatorId'] = operator_id
    if item.action == 'pause':
        body['operateReason'] = reason
        body['remark'] = f'WJ:{actor_label}'[:1000]
    return body


def _mes_fields(payload: Any) -> dict[str, Any]:
    data = payload if isinstance(payload, dict) else {}
    sub_code = data.get('subCode')
    need_check = data.get('needCheck')
    return {
        'mes_code': data.get('code') if type(data.get('code')) is int else None,
        'mes_sub_code': sub_code if isinstance(sub_code, str) else '',
        'mes_message': _safe_message(data),
        'need_check': need_check if type(need_check) is int else None,
    }


def execute_actions(
    items: list[ActionItem], reason: str, *, send: Sender, actor_label: str,
    operator_id: int | None = None, clock: Callable[[], float] = time.time,
) -> list[dict[str, Any]]:
    """Run task actions one by one, then close the selected work orders in one call."""
    results: list[dict[str, Any]] = []
    close_items: list[ActionItem] = []
    for item in items:
        try:
            detail = _read_detail(send, item.task_id)
        except Exception:
            detail = None
        if detail is None:
            results.append(_result(item, 'blocked', reason='mes_read_failed'))
            continue
        mismatch = _mismatch(item, detail)
        if mismatch:
            results.append(_result(item, 'blocked', reason=mismatch, status_after=_status_code(detail)))
            continue
        if item.action == CLOSE_ACTION:
            close_items.append(item)
            continue
        path, _allowed, expected_after = TASK_ACTIONS[item.action]
        body = _task_body(item, reason, actor_label, operator_id, int(clock() * 1000))
        try:
            payload = send(path, body)
        except Exception:
            # The request may have reached MES. Never repeat it automatically.
            results.append(_result(item, 'uncertain', reason='write_outcome_unknown'))
            continue
        fields = _mes_fields(payload)
        if not _ok(payload):
            results.append(_result(item, 'rejected', reason='mes_rejected', **fields))
            continue
        try:
            after = _read_detail(send, item.task_id)
        except Exception:
            after = None
        status_after = _status_code(after)
        expected = replace(item, expected_status=expected_after)
        outcome = 'confirmed' if after is not None and _mismatch(expected, after) is None else 'uncertain'
        results.append(_result(
            item, outcome, reason='' if outcome == 'confirmed' else 'readback_mismatch',
            status_after=status_after, **fields,
        ))

    if close_items:
        results.extend(_close_work_orders(close_items, reason, send))
    order = {item.task_id: index for index, item in enumerate(items)}
    return sorted(results, key=lambda result: order[result['task_id']])


def _close_work_orders(items: list[ActionItem], reason: str, send: Sender) -> list[dict[str, Any]]:
    codes = sorted({item.work_order_code for item in items})
    try:
        # workOrderCloseType is undocumented, so it is not sent.
        payload = send(CLOSE_PATH, {'workOrderCodeList': codes, 'operateReason': reason})
    except Exception:
        return [_result(item, 'uncertain', reason='write_outcome_unknown') for item in items]
    fields = _mes_fields(payload)
    data = payload.get('data') if isinstance(payload, dict) else None
    failed: dict[str, str] = {}
    for entry in (data.get('failResults') if isinstance(data, dict) else None) or []:
        if isinstance(entry, dict) and isinstance(entry.get('workOrderCode'), str):
            failed[entry['workOrderCode']] = _safe_message({'message': entry.get('failedReason')})
    results = []
    for item in items:
        if not _ok(payload):
            results.append(_result(item, 'rejected', reason='mes_rejected', **fields))
        elif item.work_order_code in failed:
            results.append(_result(item, 'rejected', reason='mes_rejected',
                                   **{**fields, 'mes_message': failed[item.work_order_code]}))
        else:
            # A success count is only an acknowledgment, not verified state for this
            # work order. Its closed-state read contract has not been validated.
            # Disappearance from the open-task list cannot prove closure either.
            results.append(_result(item, 'uncertain', reason='close_readback_unverified', **fields))
    return results


def mes_sender(path: str, body: dict[str, Any]) -> dict[str, Any]:
    """POST once using the route gateway's query authentication. Never retry."""
    import requests
    from inventory.mes import MES_BASE_URL, MES_ROUTE_BASE, get_access_token

    response = requests.post(
        f'{MES_BASE_URL}{MES_ROUTE_BASE}{path}',
        params={'access_token': get_access_token()},
        json=body,
        timeout=(3, 10),
    )
    try:
        payload = response.json()
    except ValueError:
        return {'code': response.status_code, 'message': ''}
    return payload if isinstance(payload, dict) else {'code': response.status_code, 'message': ''}
