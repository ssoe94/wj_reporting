"""Approved one-inspector, one-QC metadata read using an existing user lease.

No binding, credential issuance, write adapter or measurement persistence exists
here. IDs and approval are server constants; callers cannot select another QC.
"""
from django.conf import settings
from django.utils import timezone
from django.views.decorators.debug import sensitive_variables

from mes_oauth import vault
from mes_oauth.inspection_credentials import call_with_user_credential, APPROVED_QC_READ_SCOPE
from mes_oauth.session_guard import InspectionSession
from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown, MesRejected
from .inspection_blacklake_contract import ROUTE_BASE, TASK_DETAIL, ScopedInspectionReadClient
from .inspection_blacklake_snapshot import _id, _text, _enum, _decimal_source, _integer, _relation
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
        sender = self._sender
        if sender is None:
            # This helper moves the credential to a header, ignores proxy/netrc
            # configuration and bounds streamed bytes. It evaluates no write
            # policy and cannot supply or issue a credential.
            from .inspection_live_adapter import _user_sender
            sender = _user_sender
        try:
            response = sender(ORIGIN + DETAIL_ROUTE,
                params={'access_token': self._lease.value}, data=body.encode('utf-8'),
                headers={'Content-Type': 'application/json'}, timeout=(5, 20), allow_redirects=False)
            if response.status_code == 401:
                raise MesAuthenticationRejected()
            if response.status_code == 403:
                raise MesAccessDenied()
            if response.status_code != 200:
                raise MesOutcomeUnknown()
            content = response.content
            if type(content) is not bytes or not 0 < len(content) <= 524288:
                raise MesOutcomeUnknown()
            result = _decode(content.decode('utf-8'))
            if type(result) is not dict or type(result.get('code')) is not int:
                raise MesOutcomeUnknown()
            if result['code'] == 401:
                raise MesAuthenticationRejected()
            if result['code'] == 403:
                raise MesAccessDenied()
            if result['code'] != 200:
                raise MesRejected()
            if result.get('needCheck') is not None and (
                    type(result['needCheck']) is not int or result['needCheck'] != 0):
                raise MesOutcomeUnknown()
            return result
        except (MesRejected, MesOutcomeUnknown):
            raise
        except Exception:
            raise MesOutcomeUnknown() from None


def project_detail(response):
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
            items.append({'id': item_id, 'check_item_id': _id(row.get('checkItemId')),
                'version_id': _id(row.get('qcConfigVersionId')), 'group_name': group_name,
                'code': _text(row.get('checkItemCode')), 'serial_no': _integer(row.get('serialNo')),
                'execute_item_type': _enum(row.get('executeItemType')),
                'name': _text(row.get('checkItemName')), 'unit': _relation(row.get('unit')),
                'minimum': _decimal_source(row.get('min')), 'maximum': _decimal_source(row.get('max')),
                'base': _decimal_source(row.get('base')), 'scale': _integer(row.get('scale'), maximum=18),
                'logic': _enum(row.get('logic')), 'value_type': _enum(row.get('checkValueType')),
                'required_type': _enum(row.get('recordCheckItemType')),
                'options': options, 'missing_fields': ['options'] if options_missing else []})
    get_able = data.get('getAble')
    if get_able is not None and (type(get_able) is not int or get_able not in {0, 1}):
        raise ValueError('qc_eligibility_invalid')
    executor = data.get('executor')
    if executor is not None and type(executor) is not dict:
        raise ValueError('qc_executor_invalid')
    executor_id = _id((executor or {}).get('id'))
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
        approval = {'id': _id(approval.get('approvalId')),
                    'code': _text(approval.get('approvalCode')),
                    'status': _enum(approval.get('status')), 'status_meaning': 'unknown'}
    return {'qc_id': str(QC_ID), 'qc_code': QC_CODE, 'read_only': True,
        'observed_at': timezone.now().isoformat(), 'get_able': get_able,
        'status': _enum(data.get('status')), 'get_status': _enum(data.get('getStatus')),
        'executor_id': executor_id if executor_matches_lee else None,
        'executor_present': executor is not None,
        'executor_matches_lee': executor_matches_lee,
        'snapshot_id': _id(config.get('snapshotId')), 'items': items,
        'item_count': len(items) if groups is not None else None,
        'expected_item_count': 16, 'item_count_matches_expected': len(items) == 16 if groups is not None else None,
        'approval': approval, 'inventory_metadata': metadata,
        'missing_fields': [name for name, missing in (
            ('get_able', get_able is None), ('status', data.get('status') is None),
            ('get_status', data.get('getStatus') is None), ('executor_id', not executor or executor.get('id') is None),
            ('snapshot_id', config.get('snapshotId') is None), ('items', groups is None),
            ('approval', approval is None)) if missing] + inventory_missing}


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
