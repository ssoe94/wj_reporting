"""Four bounded MES reads for one existing work order; no production mutations.

The caller chooses an existing MES code. The server discovers and checks its
IDs, uses the existing same-user lease and an existing APP identity supply, and
projects state without measurement values. No credential issuance, retry, page
crawl, inventory balance inference or state-changing route exists here.
"""
from dataclasses import replace
from datetime import datetime, time, timedelta
from types import MappingProxyType
from zoneinfo import ZoneInfo
import re
import time as clock

from django.conf import settings
from django.contrib.auth import get_user_model
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from mes_oauth import vault
from mes_oauth.app_tokens import AppCredentialUnavailable, get_existing_app_access_token
from mes_oauth.client import BlacklakeUserOAuthClient, ORIGINS
from mes_oauth.inspection_credentials import call_with_user_credential, APP_CREDENTIAL, TEMPORARY
from mes_oauth.pilot_scope import pilot_route_scope_required
from mes_oauth.session_guard import InspectionSession
from quality.inspection_blacklake_contract import ROUTE_BASE
from quality.inspection_live_adapter import _user_sender
from quality.inspection_transport import InspectionUserAccessToken, MesAuthenticationRejected
from .mes_execution_contract import encode_exact_json, parse_json_exact, MesExecutionContractError
from .mes_delivery_read_contract import (
    READ_ROUTES, DeliveryReadBinding, ValidatedReadEnums,
    build_work_order_detail_read, build_task_list_read, build_report_records_read,
    build_report_receipts_read, decode_work_order_detail, decode_task_list,
    decode_report_records, decode_report_receipts,
)

SCHEMA = 'production-mes-read-status/v1'
REFERENCE = 'WJ-PRODUCTION-STATUS-READ-20261007'
STATUS_ROUTES = MappingProxyType({name: READ_ROUTES[name] for name in (
    'work_order_detail', 'task_list', 'report_records', 'report_receipts')})
# Only task states have a numeric mapping in the reviewed official documents.
TASK_ENUMS = ValidatedReadEnums({'task_status': {
    1: 'pending', 2: 'running', 3: 'paused', 4: 'completed', 5: 'cancelled'}})
MINIMUM_READ_PERMISSIONS = (
    {'name': '工单基本信息详情', 'doc_id': '1686655055663531', 'state': 'unverified'},
    {'name': '生产任务列表', 'doc_id': '1681109889053785', 'state': 'unverified'},
    {'name': '批量根据报工记录查询入库记录', 'doc_id': '1693449354592534', 'state': 'unverified'},
)
DETAILS = {
    'not_queried': '기존 MES 공번을 입력하고 상태를 조회하세요. / 输入现有MES工单编号后查询状态。',
    'permission_required': 'MES 상태 읽기 권한을 확인하세요. 생산·입고는 MES에서 수행합니다. / 请确认MES状态查询权限，生产和入库在MES操作。',
    'connection_required': '현재 계정의 MES 연결을 확인하세요. / 请确认当前账户的MES连接。',
    'unavailable': 'MES 상태를 확인하지 못했습니다. / 暂未确认MES状态。',
    'partial': '선택한 공번의 일부 기록만 확인했습니다. 다음 상태는 MES에서 확인하세요. / 仅确认所选工单的部分记录，请在MES核实后续状态。',
    'verified': '선택한 공번의 MES 기록을 조회했습니다. / 已查询所选工单的MES记录。',
}


class StatusReadUnavailable(Exception):
    def __init__(self, state='unavailable'):
        self.state = state
        super().__init__(state)


class MesProductionStatusReadTransport:
    """Explicit USER lease and four fixed read routes; each at most once."""
    @sensitive_variables()
    def __init__(self, *, origin, credential, mes_user_id, sender=None):
        if (origin not in ORIGINS or type(credential) is not InspectionUserAccessToken
                or credential.user_id != mes_user_id or type(mes_user_id) is not int):
            raise StatusReadUnavailable('connection_required')
        self.origin, self.credential, self.sender = origin, credential, sender or _user_sender
        self._called = set()

    @sensitive_variables()
    def post(self, action, payload):
        if action not in STATUS_ROUTES or action in self._called or type(payload) is not dict:
            raise StatusReadUnavailable()
        if self.credential.expires_at <= clock.time():
            raise StatusReadUnavailable('connection_required')
        self._called.add(action)
        try:
            response = self.sender(self.origin + ROUTE_BASE + STATUS_ROUTES[action],
                params={'access_token': self.credential.value}, data=encode_exact_json(payload),
                headers={'Content-Type': 'application/json'}, timeout=(3, 7), allow_redirects=False)
            if response.history:
                raise StatusReadUnavailable()
            if response.status_code == 401:
                raise MesAuthenticationRejected()
            if response.status_code == 403:
                raise StatusReadUnavailable('permission_required')
            if type(response.status_code) is not int or response.status_code != 200:
                raise StatusReadUnavailable()
            if type(response.content) is not bytes or len(response.content) > 524288:
                raise StatusReadUnavailable()
            body = parse_json_exact(response.content)
            if type(body) is not dict or type(body.get('code')) is not int:
                raise StatusReadUnavailable()
            if body['code'] in (3500060, 403) or body.get('subCode') == 'URL_NO_PERMISSION':
                raise StatusReadUnavailable('permission_required')
            if body['code'] != 200 or body.get('needCheck', 0) != 0:
                raise StatusReadUnavailable()
            return body
        except (StatusReadUnavailable, MesAuthenticationRejected):
            raise
        except Exception:
            raise StatusReadUnavailable() from None


def status_response(business_date, state, *, work_order_code='', rows=()):
    return {'schema_version': SCHEMA, 'business_date': business_date.isoformat(),
        'work_order_code': work_order_code, 'read_only': True, 'live_writes_enabled': False,
        'state': state, 'observed_at': None, 'fresh_until': None,
        'work_orders': list(rows), 'detail': DETAILS[state],
        'required_read_permissions': [dict(item) for item in MINIMUM_READ_PERMISSIONS]}


def _dimension(state, label):
    return {'state': state, 'label': label}


def _project_order(order, tasks, reports, receipts):
    fields = order.fields
    states = [record.fields['state'] for record in tasks.records]
    if not states or any(state is None for state in states):
        production = _dimension('unknown', '생산 상태 미확인 / 生产状态未确认')
    elif all(state == 'completed' for state in states) and tasks.complete:
        production = _dimension('completed', 'MES 작업 완료 / MES任务已完工')
    elif all(state == 'cancelled' for state in states) and tasks.complete:
        production = _dimension('cancelled', 'MES 작업 취소 / MES任务已取消')
    elif 'paused' in states:
        production = _dimension('blocked', 'MES 작업 일시중지 / MES任务暂停')
    elif 'running' in states:
        production = _dimension('in_progress', 'MES 작업 진행중 / MES任务执行中')
    else:
        production = _dimension('waiting', 'MES 작업 대기·상태 확인 / MES任务待执行或待核实')
    receipt_count = len({row.fields['receipt_id'] for row in receipts.records}) if receipts else 0
    # A linked inbound record is evidence of an operation, not net stock or an
    # irreversible completed receipt. Never compare quantities without units.
    inbound = _dimension('unknown',
        f'연결된 입고 기록 {receipt_count}건·현재 입고 상태 확인 / 已关联{receipt_count}条入库记录，请核实当前入库状态'
        if receipt_count else '입고 상태 미확인 / 入库状态未确认')
    next_action = {'code': 'review_in_mes', 'target': 'MES',
        'label': 'MES에서 생산·입고 상태와 다음 작업을 확인하세요. / 请在MES确认生产、入库状态和下一项操作。'}
    if production['state'] == 'waiting':
        next_action.update(code='continue_in_mes', label='MES에서 배정·생산 시작 여부를 확인하세요. / 请在MES确认排程和生产开始状态。')
    elif production['state'] == 'blocked':
        next_action.update(code='review_pause_in_mes', label='MES에서 일시중지 사유와 다음 작업을 확인하세요. / 请在MES确认暂停原因和后续操作。')
    return {'id': str(fields['work_order_id']), 'code': fields['work_order_code'],
        'production_order': _dimension('unknown', 'MES 생산지시 확인·진행 상태 미확인 / 已查询MES工单，工单进度未确认'),
        'production': production, 'inbound': inbound, 'next_action': next_action}


def _read_projection(transport, binding, business_date):
    order = decode_work_order_detail(transport.post('work_order_detail', build_work_order_detail_read(binding)), binding)
    binding = replace(binding, work_order_id=order.fields['work_order_id'])
    tasks = decode_task_list(transport.post('task_list', build_task_list_read(binding)), binding, enums=TASK_ENUMS)
    task_ids = tuple(row.fields['task_id'] for row in tasks.records)
    reports = receipts = None
    if task_ids:
        reports = decode_report_records(transport.post('report_records',
            build_report_records_read(binding, task_ids=task_ids)), binding, task_ids=task_ids)
        report_ids = tuple(sorted({row.fields['report_record_id'] for row in reports.records}))
        if report_ids:
            # This reads only records causally linked to the observed reports.
            receipts = decode_report_receipts(transport.post('report_receipts',
                build_report_receipts_read(binding, report_ids)), binding, report_ids)
    # WO lifecycle enum and net inbound state remain undocumented/unverified.
    result = status_response(business_date, 'partial', work_order_code=binding.work_order_code,
        rows=(_project_order(order, tasks, reports, receipts),))
    observed = timezone.now()
    result.update(observed_at=observed.isoformat(), fresh_until=(observed+timedelta(minutes=5)).isoformat())
    return result


def valid_work_order_code(code):
    return (type(code) is str and 1 <= len(code) <= 100 and code == code.strip()
        and not any(ord(char) < 32 or ord(char) == 127 for char in code))


@sensitive_variables()
def read_mes_production_status(session, business_date, work_order_code, *, provider=None, sender=None):
    if not work_order_code:
        return status_response(business_date, 'not_queried')
    if type(session) is not InspectionSession or not valid_work_order_code(work_order_code):
        raise ValueError('A current account and an existing MES work order code are required.')
    try:
        configuration = vault.policy()
        mes_user_id = vault.expected_user(session.actor_id)
        origin = settings.MES_USER_OAUTH_PROVIDER_ORIGIN
        def policy_check():
            user = get_user_model().objects.filter(pk=session.actor_id).only('is_active', 'is_superuser').first()
            return (user is not None and user.is_active and user.is_superuser
                and not pilot_route_scope_required(user, session.claims)
                and vault.policy() == configuration and vault.expected_user(session.actor_id) == mes_user_id
                and getattr(settings, 'MES_INSPECTION_ENABLED', False) is True
                and getattr(settings, 'MES_USER_OAUTH_ENABLED', False) is True)
        # Explicit provider excludes the broker's APP issuance fallback.
        if provider is None:
            provider = BlacklakeUserOAuthClient(origin=origin,
                app_access_token=get_existing_app_access_token(),
                app_token_header=getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token'))
        start = datetime.combine(business_date, time(8), ZoneInfo('Asia/Shanghai'))
        binding = DeliveryReadBinding(configuration.tenant, work_order_code,
            window_start_ms=int(start.timestamp())*1000,
            window_end_ms=int((start+timedelta(days=1)).timestamp())*1000)
        def callback(credential):
            transport = MesProductionStatusReadTransport(origin=origin, credential=credential,
                mes_user_id=mes_user_id, sender=sender)
            try:
                return _read_projection(transport, binding, business_date)
            except StatusReadUnavailable as error:
                return status_response(business_date, error.state, work_order_code=work_order_code)
            except MesExecutionContractError:
                return status_response(business_date, 'unavailable', work_order_code=work_order_code)
        return call_with_user_credential(session, mes_user_id=mes_user_id,
            tenant=configuration.tenant, contract_reference=REFERENCE, policy_check=policy_check,
            operation='read', callback=callback, provider=provider)
    except AppCredentialUnavailable:
        return status_response(business_date, 'unavailable', work_order_code=work_order_code)
    except vault.VaultBlocked as error:
        state = 'unavailable' if str(error) in (APP_CREDENTIAL, TEMPORARY) else 'connection_required'
        return status_response(business_date, state, work_order_code=work_order_code)
