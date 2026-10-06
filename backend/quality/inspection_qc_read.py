"""Approved one-inspector, one-QC metadata read using an existing user lease.

No binding, credential issuance, write adapter or measurement persistence exists
here. IDs and approval are server constants; callers cannot select another QC.
"""
import logging
from dataclasses import dataclass, field

from django.conf import settings
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from mes_oauth import vault
from mes_oauth.inspection_credentials import call_with_user_credential, APPROVED_QC_READ_SCOPE
from mes_oauth.session_guard import InspectionSession
from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown, MesRejected
from .inspection_blacklake_contract import ROUTE_BASE, TASK_DETAIL, ScopedInspectionReadClient
from .inspection_blacklake_snapshot import _id, _text, _enum, _decimal_source, _integer
from .inspection_transport import (InspectionUserAccessToken, MesAuthenticationExpired,
    MesAuthenticationRejected, MesAccessDenied, _decode)

ACTOR_ID = 18
MES_USER_ID = 1733276056994641
QC_ID = 1791013139392836
QC_CODE = 'QC-26100300323'
ORIGIN = 'https://v3-ali.blacklake.cn'
READ_REFERENCE = APPROVED_QC_READ_SCOPE.reference
DETAIL_ROUTE = ROUTE_BASE + TASK_DETAIL
# Official detail contract; enum presence is not write or inventory authority.
DETAIL_CONTRACT_URL = 'https://v3-ali-openapi.blacklake.cn/static/api-docs-md/1681109889047070.md'

logger = logging.getLogger(__name__)
_HTTP_CODES = frozenset({200, 201, 202, 204, 301, 302, 303, 307, 308,
    400, 401, 403, 404, 408, 409, 413, 422, 429, 500, 502, 503, 504})
_PROJECTION_REASONS = frozenset({'qc_detail_invalid', 'qc_detail_scope_mismatch',
    'qc_config_invalid', 'qc_items_invalid', 'qc_items_duplicate',
    'qc_item_options_invalid', 'qc_item_unit_invalid', 'qc_eligibility_invalid', 'qc_executor_invalid',
    'qc_inventory_invalid', 'qc_approval_invalid'})


def _diagnostic(stage, reason, *, http_status=None, api_code=None):
    # Callers pass fixed stages/reasons only. Never log exception text or bodies.
    metadata = {
        'qc_read_stage': stage, 'qc_read_reason': reason,
        'qc_read_http_status': http_status if type(http_status) is int and http_status in _HTTP_CODES else 'unknown',
        'qc_read_api_code': api_code if type(api_code) is int and 0 <= api_code <= 1_000_000_000 else None}
    # The production formatter prints messages, not custom fields, and its root
    # threshold is WARNING. Blocked stages must remain visible at that setting.
    logger.log(logging.INFO if reason == 'accepted' else logging.WARNING,
        'QC detail read stage=%s reason=%s http_status=%s api_code=%s',
        stage, reason, metadata['qc_read_http_status'], metadata['qc_read_api_code'],
        extra=metadata)


def _optional_id(value):
    # Optional source IDs may use the documented zero placeholder for absence.
    # Booleans and string/nonzero malformed IDs remain invalid.
    return None if type(value) is int and value == 0 else _id(value)


def _optional_unit(value):
    if value is None:
        return {'id': None, 'code': None, 'name': None}
    if type(value) is not dict:
        raise ValueError('qc_item_unit_invalid')
    return {'id': _optional_id(value.get('id')), 'code': _text(value.get('code')),
            'name': _text(value.get('name'))}


@dataclass(frozen=True)
class _ReadResponse:
    status_code: int
    content: bytes = field(repr=False)


@sensitive_variables()
def _send_user_detail(lease, body):
    # Bounded read-only header experiment, not proof of provider acceptance.
    # Reuse only the configured header NAME; the value remains the same typed
    # USER lease. No app credential is resolved and no alternate header is tried.
    header = getattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER', 'access_token')
    if (type(header) is not str or header not in {'access_token', 'X-AUTH'}
            or type(lease) is not InspectionUserAccessToken or lease.user_id != MES_USER_ID):
        raise MesContractUnavailable()
    import requests
    with requests.Session() as session:
        session.trust_env = False
        with session.post(ORIGIN + DETAIL_ROUTE, data=body.encode('utf-8'),
                headers={header: lease.value, 'Content-Type': 'application/json', 'Accept': 'application/json'},
                timeout=(5, 20), allow_redirects=False, stream=True) as response:
            if response.history:
                raise MesOutcomeUnknown()
            content = bytearray()
            for chunk in response.iter_content(8192):
                content.extend(chunk)
                if len(content) > 524288:
                    raise MesOutcomeUnknown()
            return _ReadResponse(response.status_code, bytes(content))


class QCDetailReadTransport:
    """Only the exact approved detail request can cross this transport."""
    def __init__(self, lease, *, sender=None):
        if type(lease) is not InspectionUserAccessToken or lease.user_id != MES_USER_ID:
            raise MesContractUnavailable()
        self._lease, self._sender = lease, sender

    @sensitive_variables()
    def post_json(self, route, body):
        # Compare exact parsed shape and numeric types, rejecting bool IDs.
        payload = _decode(body)
        if (route != DETAIL_ROUTE or type(payload) is not dict
                or set(payload) != {'id'} or type(payload['id']) is not int
                or payload['id'] != QC_ID):
            raise MesContractUnavailable()
        if self._lease.expires_at <= timezone.now().timestamp():
            raise MesAuthenticationExpired()
        stage, http_status, api_code = 'request', None, None
        rejection_reason = 'rejected'
        try:
            if self._sender is None:
                response = _send_user_detail(self._lease, body)
            else:
                response = self._sender(ORIGIN + DETAIL_ROUTE,
                    params={'access_token': self._lease.value}, data=body.encode('utf-8'),
                    headers={'Content-Type': 'application/json'}, timeout=(5, 20), allow_redirects=False)
            stage, http_status = 'response_http', response.status_code
            if response.status_code == 401:
                raise MesAuthenticationRejected()
            if response.status_code == 403:
                raise MesAccessDenied()
            if response.status_code != 200:
                raise MesOutcomeUnknown()
            stage = 'response_size'
            content = response.content
            if type(content) is not bytes or not 0 < len(content) <= 524288:
                raise MesOutcomeUnknown()
            stage = 'response_json'
            result = _decode(content.decode('utf-8'))
            stage = 'response_envelope'
            if type(result) is not dict or type(result.get('code')) is not int:
                raise MesOutcomeUnknown()
            api_code = result['code']
            if (api_code != 200 and type(result.get('subCode')) is str
                    and result['subCode'] == 'OPENAPI-DOMAIN/URL_NO_PERMISSION'):
                rejection_reason = 'provider_url_permission'
            if result['code'] == 401:
                raise MesAuthenticationRejected()
            if result['code'] == 403:
                raise MesAccessDenied()
            if result['code'] != 200:
                raise MesRejected()
            stage = 'response_confirmation'
            if result.get('needCheck') is not None and (
                    type(result['needCheck']) is not int or result['needCheck'] != 0):
                raise MesOutcomeUnknown()
            _diagnostic('response_envelope', 'accepted', http_status=http_status, api_code=api_code)
            return result
        except (MesRejected, MesOutcomeUnknown):
            _diagnostic(stage, rejection_reason, http_status=http_status, api_code=api_code)
            raise
        except Exception:
            _diagnostic(stage, 'invalid_or_unavailable', http_status=http_status, api_code=api_code)
            raise MesOutcomeUnknown() from None


def _project_detail(response):
    """Allowlist configuration metadata; omit actual sample/result collections."""
    if type(response) is not dict or type(response.get('code')) is not int or response['code'] != 200:
        raise ValueError('qc_detail_invalid')
    data = response.get('data')
    if (type(data) is not dict or _id(data.get('id')) != str(QC_ID)
            or data.get('code') != QC_CODE):
        raise ValueError('qc_detail_scope_mismatch')
    config = data.get('qcConfig')
    if config is None:
        config = {}
    if type(config) is not dict:
        raise ValueError('qc_config_invalid')
    groups = config.get('qcConfigCheckItemList')
    if groups is not None and (type(groups) is not list or len(groups) > 20):
        raise ValueError('qc_items_invalid')
    items, seen = [], set()
    for group in groups or []:
        if type(group) is not dict or type(group.get('checkItemAppDetailVOS')) is not list:
            raise ValueError('qc_items_invalid')
        group_name = _text(group.get('groupName'), limit=128)
        for row in group['checkItemAppDetailVOS']:
            if type(row) is not dict or len(items) >= 100:
                raise ValueError('qc_items_invalid')
            item_id = _id(row.get('id'), required=True)
            if item_id in seen:
                raise ValueError('qc_items_duplicate')
            seen.add(item_id)
            options = row.get('radios')
            options_missing = options is None
            if options_missing:
                options = []
            if type(options) is not list or len(options) > 50:
                raise ValueError('qc_item_options_invalid')
            options = [_text(value, limit=500, required=True) for value in options]
            items.append({'id': item_id, 'check_item_id': _optional_id(row.get('checkItemId')),
                'version_id': _optional_id(row.get('qcConfigVersionId')), 'group_name': group_name,
                'code': _text(row.get('checkItemCode')), 'serial_no': _integer(row.get('serialNo')),
                'execute_item_type': _enum(row.get('executeItemType')),
                'name': _text(row.get('checkItemName')), 'unit': _optional_unit(row.get('unit')),
                'minimum': _decimal_source(row.get('min')), 'maximum': _decimal_source(row.get('max')),
                'base': _decimal_source(row.get('base')), 'scale': _integer(row.get('scale'), maximum=18),
                'logic': _enum(row.get('logic')), 'value_type': _enum(row.get('checkValueType')),
                'required_type': _enum(row.get('recordCheckItemType')),
                'options': options, 'missing_fields': (['options'] if options_missing else []) +
                    [name for name, value in (('check_item_id', row.get('checkItemId')),
                        ('version_id', row.get('qcConfigVersionId')),
                        ('unit.id', (row.get('unit') or {}).get('id')))
                     if value is None or (type(value) is int and value == 0)]})
    get_able = data.get('getAble')
    if get_able is not None and (type(get_able) is not int or get_able not in {0, 1}):
        raise ValueError('qc_eligibility_invalid')
    executor = data.get('executor')
    if executor is not None and type(executor) is not dict:
        raise ValueError('qc_executor_invalid')
    executor_id = _optional_id((executor or {}).get('id'))
    executor_matches_lee = executor_id == str(MES_USER_ID) if executor_id is not None else None
    metadata = {key: _enum(config.get(key)) for key in
        ('qcRange', 'materialBatchRecordType', 'sampleProcessMethod', 'recordSample', 'recordSummaryCount')}
    inventory_missing = ['inventory_metadata.' + key for key in metadata if config.get(key) is None]
    for source, field in (('checkMaterials', 'check_material_count'), ('sampleMaterials', 'sample_material_count')):
        value = data.get(source)
        if value is not None and (type(value) is not list or len(value) > 1000):
            raise ValueError('qc_inventory_invalid')
        metadata[field] = len(value) if value is not None else None
        if value is None:
            inventory_missing.append('inventory_metadata.' + field)
    approval = data.get('approvalDetail')
    if approval is not None:
        if type(approval) is not dict:
            raise ValueError('qc_approval_invalid')
        approval = {'id': _optional_id(approval.get('approvalId')),
                    'code': _text(approval.get('approvalCode')),
                    'status': _enum(approval.get('status')), 'status_meaning': 'unknown',
                    'missing_fields': ['id'] if _optional_id(approval.get('approvalId')) is None else []}
    return {'qc_id': str(QC_ID), 'qc_code': QC_CODE, 'read_only': True,
        'observed_at': timezone.now().isoformat(), 'get_able': get_able,
        'status': _enum(data.get('status')), 'get_status': _enum(data.get('getStatus')),
        'executor_id': executor_id if executor_matches_lee else None,
        'executor_present': executor is not None,
        'executor_matches_lee': executor_matches_lee,
        'snapshot_id': _optional_id(config.get('snapshotId')), 'items': items,
        'item_count': len(items) if groups is not None else None,
        'expected_item_count': 16, 'item_count_matches_expected': len(items) == 16 if groups is not None else None,
        'approval': approval, 'inventory_metadata': metadata,
        'missing_fields': [name for name, missing in (
            ('get_able', get_able is None), ('status', data.get('status') is None),
            ('get_status', data.get('getStatus') is None), ('executor_id', executor_id is None),
            ('snapshot_id', _optional_id(config.get('snapshotId')) is None), ('items', groups is None),
            ('approval', approval is None),
            ('approval.id', approval is not None and approval['id'] is None)) if missing] + inventory_missing}


@sensitive_variables()
def project_detail(response):
    try:
        return _project_detail(response)
    except Exception as error:
        reason = error.args[0] if type(error) is ValueError and error.args else None
        if type(reason) is not str or reason not in _PROJECTION_REASONS:
            reason = 'projection_source_invalid'
        _diagnostic('projection', reason)
        raise


@sensitive_variables()
def read_approved_qc(session, *, provider=None, sender=None):
    if type(session) is not InspectionSession or session.actor_id != ACTOR_ID:
        raise vault.VaultBlocked('inspection_qc_read_scope_denied')
    configuration = vault.policy()
    def approved():
        return (settings.MES_USER_OAUTH_PROVIDER_ORIGIN == ORIGIN
                and vault.expected_user(ACTOR_ID) == MES_USER_ID
                and vault.policy() == configuration)
    def read(lease):
        transport = QCDetailReadTransport(lease, sender=sender)
        return project_detail(ScopedInspectionReadClient(transport.post_json).detail(QC_ID))
    return call_with_user_credential(session, mes_user_id=MES_USER_ID,
        tenant=configuration.tenant, contract_reference=READ_REFERENCE,
        policy_check=approved, operation='read', callback=read, provider=provider,
        approved_read_scope=APPROVED_QC_READ_SCOPE)
