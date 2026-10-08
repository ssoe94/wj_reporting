"""Fixed production routes, explicit verified USER lease, no retry or refresh.

ReviewedDeliveryAuthorization is a server attestation, never a client permission
or a credential source. A durable coordinator must validate its real authority
and bind every request/readback. Successful write acknowledgements still require
business readback. No constructor/import reads settings, credentials or the net.
"""
from dataclasses import dataclass
from decimal import Decimal
import hashlib
import hmac
import math
import re
import time

from quality.inspection_adapter import MesContractUnavailable, MesOutcomeUnknown, MesRejected
from quality.inspection_transport import (
    InspectionUserAccessToken, MesAccessDenied, MesAuthenticationExpired,
    MesAuthenticationMissing, MesAuthenticationRejected,
)
from .mes_execution_contract import ACTION_ROUTES, encode_exact_json, mes_id, parse_json_exact


READ_ACTIONS = frozenset({'reportable_materials', 'production_inventory_list'})
WRITE_ACTIONS = frozenset(ACTION_ROUTES) - READ_ACTIONS
ROUTE_BASE = '/api/openapi/domain/web/v1/route'
_ORIGINS = frozenset({'https://v3-ali.blacklake.cn', 'https://v3-hw.blacklake.cn'})


class DeliveryScopeRejected(MesContractUnavailable):
    code = 'mes_delivery_scope_unverified'


class DeliveryReplayRejected(MesRejected):
    code = 'mes_delivery_replay_blocked'


def _reference(value):
    return type(value) is str and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}', value) is not None


def _code(value):
    return (type(value) is str and 1 <= len(value) <= 255 and value == value.strip()
            and all(ord(character) >= 32 for character in value))


def _epoch(value):
    return type(value) in (int, float) and math.isfinite(value)


@dataclass(frozen=True)
class ReviewedDeliveryAuthorization:
    actor_id: int
    tenant: str
    work_order_code: str
    action: str
    payload_sha: str
    verification_reference: str
    expires_at: float

    def __post_init__(self):
        if (type(self.actor_id) is not int or not 1 <= self.actor_id <= 2**63 - 1
                or not _reference(self.tenant) or not _code(self.work_order_code)
                or type(self.action) is not str or self.action not in ACTION_ROUTES or type(self.payload_sha) is not str
                or re.fullmatch(r'[0-9a-f]{64}', self.payload_sha) is None
                or not _reference(self.verification_reference) or not _epoch(self.expires_at)):
            raise DeliveryScopeRejected()


def digest_payload(payload):
    """Digest the same exact bytes sent, including decimal numbers and key order."""
    return hashlib.sha256(encode_exact_json(payload)).hexdigest()


def _shape(value, required):
    if type(value) is not dict or set(value) != set(required):
        raise DeliveryScopeRejected()


def _id(value):
    if type(value) is not int:
        raise DeliveryScopeRejected()
    return mes_id(value)


def _positive(value):
    if type(value) not in (int, Decimal) or not value > 0:
        raise DeliveryScopeRejected()


def _forbid_skips(value):
    if isinstance(value, dict):
        if 'skipWeakControlRule' in value:
            raise DeliveryScopeRejected()
        for item in value.values():
            _forbid_skips(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            _forbid_skips(item)


class MesDeliveryUserTransport:
    def __init__(self, *, origin, actor_id, tenant, work_order_code,
                 expected_mes_user_id, sender=None, clock=time.time):
        if (type(origin) is not str or origin not in _ORIGINS or type(actor_id) is not int or not 1 <= actor_id <= 2**63 - 1
                or not _reference(tenant) or not _code(work_order_code)
                or (sender is not None and not callable(sender)) or not callable(clock)):
            raise DeliveryScopeRejected()
        try:
            expected_mes_user_id = mes_id(expected_mes_user_id)
        except Exception:
            raise DeliveryScopeRejected() from None
        self.origin, self.actor_id, self.tenant = origin, actor_id, tenant
        self.work_order_code, self.expected_mes_user_id = work_order_code, expected_mes_user_id
        self._sender, self._clock = sender, clock
        self._attempted_writes = set()
        self.dispatched = False
        self.readback_allowed_after_error = False
        self.status_flag = 'not_dispatched'
        self.readback_required = False

    def consume_readback_allowance(self):
        allowed = self.readback_allowed_after_error is True
        self.readback_allowed_after_error = False
        return allowed

    def _validate_payload(self, action, payload):
        if type(payload) is not dict:
            raise DeliveryScopeRejected()
        _forbid_skips(payload)
        if action == 'reportable_materials':
            _shape(payload, {'taskId'})
            _id(payload['taskId'])
        elif action == 'production_inventory_list':
            _shape(payload, {'taskId', 'lineId', 'materialId', 'amountFilterFlag', 'page', 'size'})
            for key in ('taskId', 'lineId', 'materialId'):
                _id(payload[key])
            if (payload['amountFilterFlag'] is not False or type(payload['page']) is not int
                    or not 1 <= payload['page'] <= 2 or type(payload['size']) is not int
                    or not 1 <= payload['size'] <= 25):
                raise DeliveryScopeRejected()
        elif action == 'task_start':
            _shape(payload, {'taskId', 'alsoStartSopTaskFlag'})
            _id(payload['taskId'])
            if payload['alsoStartSopTaskFlag'] is not False:
                raise DeliveryScopeRejected()
        elif action == 'work_order_create':
            required = {'code', 'externalOrderCode', 'planStartTime', 'planFinishTime', 'enableSopInt', 'specifiedMaterialInt',
                        'useBomFlag', 'useProcessRouteFlag', 'status', 'inputMaterialControlOpenCOs', 'inputMaterialOpenCOs',
                        'outputMaterialOpenCOs', 'processPlanNodeRelationOpenCOs', 'processPlanOpenCOs', 'workInProgressOpenCOs'}
            if not required <= set(payload) or set(payload) - required - {'identifier', 'remark', 'processPlanType'}:
                raise DeliveryScopeRejected()
            if payload.get('code') != self.work_order_code or type(payload.get('enableSopInt')) is not int or payload['enableSopInt'] != 0:
                raise DeliveryScopeRejected()
            outputs = payload.get('outputMaterialOpenCOs')
            if type(outputs) is not list or len(outputs) != 1 or type(outputs[0]) is not dict:
                raise DeliveryScopeRejected()
            if (outputs[0].get('workOrderCode') != self.work_order_code
                    or outputs[0].get('autoWarehousingFlag') != '否' or outputs[0].get('warehousing') != '是'):
                raise DeliveryScopeRejected()
        elif action == 'work_order_dispatch':
            _shape(payload, {'dispatchRequests'})
            rows = payload['dispatchRequests']
            if type(rows) is not list or len(rows) != 1 or type(rows[0]) is not dict:
                raise DeliveryScopeRejected()
            _shape(rows[0], {'plannedAmount', 'plannedFinishTime', 'plannedStartTime', 'processNum', 'produceTaskCode',
                             'remark', 'resourceGroupList', 'taskIdentifier', 'workOrderCode', 'workOrderId'})
            if rows[0].get('workOrderCode') != self.work_order_code:
                raise DeliveryScopeRejected()
            _id(rows[0].get('workOrderId'))
        elif action == 'progress_report':
            _shape(payload, {'taskId', 'reportType', 'qcStatus', 'feedAndReportFlag',
                             'progressReportMaterial', 'progressReportItems'})
            _id(payload['taskId'])
            if (type(payload['reportType']) is not int or type(payload['qcStatus']) is not int or payload['qcStatus'] != 1
                    or type(payload['feedAndReportFlag']) is not int or payload['feedAndReportFlag'] != 0):
                raise DeliveryScopeRejected()
            material = payload['progressReportMaterial']
            _shape(material, {'materialId', 'lineId', 'reportProcessId'})
            for value in material.values():
                _id(value)
            items = payload['progressReportItems']
            if type(items) is not list or len(items) != 1:
                raise DeliveryScopeRejected()
            _shape(items[0], {'executorIds', 'progressReportMaterialItems'})
            executors = items[0]['executorIds']
            if type(executors) is not list or not 1 <= len(executors) <= 4 or len(set(executors)) != len(executors):
                raise DeliveryScopeRejected()
            for executor in executors:
                _id(executor)
            quantities = items[0]['progressReportMaterialItems']
            if type(quantities) is not list or len(quantities) != 1:
                raise DeliveryScopeRejected()
            _shape(quantities[0], {'reportUnitId', 'reportAmount', 'remark'})
            _id(quantities[0]['reportUnitId'])
            _positive(quantities[0]['reportAmount'])
        elif action == 'manual_inbound':
            _shape(payload, {'taskId', 'storageLocationId', 'remark', 'productionInventoryMaterialList'})
            _id(payload['taskId'])
            _id(payload['storageLocationId'])
            rows = payload['productionInventoryMaterialList']
            if type(rows) is not list or len(rows) != 1:
                raise DeliveryScopeRejected()
            row = rows[0]
            _shape(row, {'productionInventoryId', 'lineId', 'materialId', 'qcStatus',
                         'warehouseIntoAmount', 'warehouseIntoUnitId'})
            for key in ('productionInventoryId', 'lineId', 'materialId', 'warehouseIntoUnitId'):
                _id(row[key])
            _positive(row['warehouseIntoAmount'])
            if type(row['qcStatus']) is not int or row['qcStatus'] != 1:
                raise DeliveryScopeRejected()
        else:
            raise DeliveryScopeRejected()

    def _data(self, action, data):
        """Only documented business fields; omit messages, diagnostics and extras."""
        if action == 'work_order_create':
            return {'workOrderId': _id(data.get('workOrderId'))}
        if action == 'work_order_dispatch':
            return {'id': _id(data.get('id'))}
        if action in ('task_start', 'manual_inbound'):
            return {}
        if action == 'progress_report':
            records = data.get('progressReportRecordIds')
            if (type(records) is not list or not 1 <= len(records) <= 50
                    or len(set(records)) != len(records) or type(data.get('queryInventoryResult')) is not bool):
                raise ValueError()
            return {'messageTraceId': _id(data.get('messageTraceId')),
                    'progressReportRecordIds': [_id(value) for value in records],
                    'queryInventoryResult': data['queryInventoryResult']}
        if action == 'reportable_materials':
            rows = data.get('outputMaterials')
            if type(rows) is not list or len(rows) > 50:
                raise ValueError()
            result = []
            for row in rows:
                if type(row) is not dict:
                    raise ValueError()
                key, unit, modes = row.get('progressReportKey'), row.get('outputMaterialUnit'), row.get('reportType')
                if type(key) is not dict or type(unit) is not dict or type(modes) is not list:
                    raise ValueError()
                _id(key.get('materialId'))
                for field in ('lineId', 'reportProcessId'):
                    if key.get(field) is not None:
                        _id(key[field])
                _id(unit.get('id'))
                if (type(unit.get('precisionFigure')) is not int or not 0 <= unit['precisionFigure'] <= 10
                        or any(type(row.get(field)) is not bool for field in
                               ('warehousingFlag', 'autoWarehousingFlag', 'virtualMaterialFlag', 'mainFlag'))):
                    raise ValueError()
                for field in ('enableFlag', 'enablePrecision'):
                    flag = unit.get(field)
                    if type(flag) is not dict or type(flag.get('code')) is not int or flag['code'] not in (0, 1):
                        raise ValueError()
                if len(modes) > 50 or any(type(mode) is not dict or type(mode.get('code')) is not int for mode in modes):
                    raise ValueError()
                result.append({**{field: row.get(field) for field in
                    ('warehousingFlag', 'autoWarehousingFlag', 'virtualMaterialFlag', 'mainFlag')},
                    'progressReportKey': {field: key.get(field) for field in ('materialId', 'lineId', 'reportProcessId')},
                    'outputMaterialUnit': {'id': unit.get('id'), 'precisionFigure': unit.get('precisionFigure'),
                        'enableFlag': {'code': (unit.get('enableFlag') or {}).get('code')},
                        'enablePrecision': {'code': (unit.get('enablePrecision') or {}).get('code')}},
                    'reportType': [{'code': mode['code']} for mode in modes]})
            return {'outputMaterials': result}
        rows = data.get('list')
        if type(rows) is not list or len(rows) > 25:
            raise ValueError()
        result = []
        for row in rows:
            if type(row) is not dict:
                raise ValueError()
            base = (row.get('materialVO') or {}).get('baseInfo') or {}
            amount, status = row.get('amount') or {}, row.get('qcStatus') or {}
            for value in (row.get('id'), row.get('lineId'), base.get('id'), amount.get('unitId')):
                _id(value)
            if (type(amount.get('amount')) not in (int, Decimal) or type(row.get('virtualMaterialFlag')) is not bool
                    or type(status.get('code')) is not int or not 1 <= status['code'] <= 4):
                raise ValueError()
            if amount['amount'] < 0:
                raise ValueError()
            encode_exact_json({'amount': amount['amount']})
            result.append({'id': row.get('id'), 'lineId': row.get('lineId'),
                'materialVO': {'baseInfo': {'id': base.get('id')}},
                'amount': {'amount': amount.get('amount'), 'unitId': amount.get('unitId')},
                'virtualMaterialFlag': row.get('virtualMaterialFlag'), 'qcStatus': {'code': status.get('code')}})
        if (type(data.get('page')) is not int or not 1 <= data['page'] <= 2
                or type(data.get('total')) is not int or data['total'] < len(result)):
            raise ValueError()
        return {'page': data['page'], 'total': data['total'], 'list': result}

    def call(self, action, payload, authorization, credential):
        self.dispatched = self.readback_allowed_after_error = self.readback_required = False
        self.status_flag = 'not_dispatched'
        confirmation_required = False
        try:
            if (type(action) is not str or action not in ACTION_ROUTES or type(authorization) is not ReviewedDeliveryAuthorization
                    or authorization.action != action or authorization.actor_id != self.actor_id
                    or authorization.tenant != self.tenant or authorization.work_order_code != self.work_order_code):
                raise DeliveryScopeRejected()
            self._validate_payload(action, payload)
            encoded = encode_exact_json(payload)
            if not hmac.compare_digest(hashlib.sha256(encoded).hexdigest(), authorization.payload_sha):
                raise DeliveryScopeRejected()
            now = self._clock()
            if not _epoch(now) or authorization.expires_at <= now:
                raise DeliveryScopeRejected()
            if (type(credential) is not InspectionUserAccessToken or type(credential.value) is not str
                    or not credential.value or any(ord(c) <= 32 or ord(c) == 127 for c in credential.value)):
                raise MesAuthenticationMissing()
            if credential.user_id != self.expected_mes_user_id:
                raise MesAuthenticationRejected()
            if credential.expires_at <= now:
                raise MesAuthenticationExpired()
            replay_key = action
            if action in WRITE_ACTIONS and replay_key in self._attempted_writes:
                raise DeliveryReplayRejected()
            sender = self._sender
            if sender is None:
                from quality.inspection_live_adapter import _user_sender
                sender = _user_sender
            # Recheck immediately before using this one lease; no provider/refresh.
            now = self._clock()
            if not _epoch(now) or authorization.expires_at <= now:
                raise DeliveryScopeRejected()
            if credential.expires_at <= now:
                raise MesAuthenticationExpired()
            if action in WRITE_ACTIONS:
                self._attempted_writes.add(replay_key)
            self.dispatched, self.status_flag = True, 'dispatched'
            response = sender(self.origin + ROUTE_BASE + ACTION_ROUTES[action], params={'access_token': credential.value},
                              data=encoded, headers={'Content-Type': 'application/json'},
                              timeout=(5, 20), allow_redirects=False)
            status = response.status_code
            if type(status) is not int or getattr(response, 'history', None):
                raise MesOutcomeUnknown()
            if status == 401:
                raise MesAuthenticationRejected()
            if status == 403:
                raise MesAccessDenied()
            if status in (202, 408) or status >= 500 or 300 <= status < 400:
                raise MesOutcomeUnknown()
            if status not in (200, 201):
                raise MesRejected()
            content = response.content
            if type(content) is not bytes or not 1 <= len(content) <= 524288:
                raise MesOutcomeUnknown()
            body = parse_json_exact(content.decode('utf-8'))
            if type(body) is not dict or type(body.get('code')) is not int:
                raise MesOutcomeUnknown()
            if body['code'] == 401:
                raise MesAuthenticationRejected()
            if body['code'] == 403:
                raise MesAccessDenied()
            if body['code'] != 200:
                raise MesRejected()
            if type(body.get('needCheck')) is not int or body['needCheck'] != 0:
                confirmation_required = body.get('needCheck') is not None
                raise MesOutcomeUnknown()
            if type(body.get('data')) is not dict:
                raise MesOutcomeUnknown()
            try:
                checked = self._data(action, body['data'])
            except DeliveryScopeRejected:
                raise ValueError() from None
            self.readback_required = action in WRITE_ACTIONS
            self.status_flag = 'acknowledged' if self.readback_required else 'read_verified'
            return {'code': 200, 'needCheck': 0, 'data': checked}
        except DeliveryReplayRejected:
            self.status_flag = 'replay_blocked'
            raise DeliveryReplayRejected() from None
        except MesAuthenticationExpired:
            self.status_flag = 'authentication_expired'
            raise MesAuthenticationExpired() from None
        except MesAuthenticationMissing:
            self.status_flag = 'authentication_missing'
            raise MesAuthenticationMissing() from None
        except MesAuthenticationRejected:
            self.status_flag = 'authentication_rejected'
            raise MesAuthenticationRejected() from None
        except MesAccessDenied:
            self.status_flag = 'access_denied'
            raise MesAccessDenied() from None
        except MesRejected:
            self.status_flag = 'provider_rejected'
            raise MesRejected() from None
        except MesContractUnavailable:
            self.status_flag = 'scope_rejected'
            raise DeliveryScopeRejected() from None
        except Exception:
            if not self.dispatched:
                self.status_flag = 'scope_rejected'
                raise DeliveryScopeRejected() from None
            self.readback_allowed_after_error = action in WRITE_ACTIONS and not confirmation_required
            self.readback_required = action in WRITE_ACTIONS
            self.status_flag = 'confirmation_required' if confirmation_required else 'outcome_unknown'
            raise MesOutcomeUnknown() from None
