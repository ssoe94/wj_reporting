"""Explicit standalone integration trials; never manufacture production IDs."""
from decimal import Decimal
import re

from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from .inspection_blacklake_contract import mes_id
from .inspection_validation import digest

CONTEXT = 'standalone_test'
SOURCE_KIND = 'integration_test'
TRIAL_LABEL = '연동 테스트용 가상값 / 非实测，仅用于接口测试'


def trial_code(value):
    if type(value) is not str or not re.fullmatch(r'WJ-IT-[A-Z0-9][A-Z0-9-]{0,47}', value):
        raise ValueError('integration_trial_code_invalid')
    return value


def standalone(binding):
    return isinstance(binding.contract, dict) and binding.contract.get('context') == CONTEXT


def validate_target(binding, request):
    contract = binding.contract
    if (not standalone(binding) or binding.work_order_id != '' or not binding.test_only
            or request.source_kind != SOURCE_KIND or request.inspection_type != 'general'
            or request.quantity_mode != 'not_recorded' or request.target_quantity != 0
            or any(getattr(request, key) for key in ('work_order_ref', 'task_ref', 'part_no',
                                                   'equipment_ref', 'warehouse_ref', 'lot_ref', 'uom'))):
        raise ValueError('integration_trial_target_invalid')
    trial_code(contract['qc_code'])
    trial_code(contract['config_code'])
    prepared = request.mes_snapshot.get('integration_trial') if type(request.mes_snapshot) is dict else None
    if (type(prepared) is not dict or prepared.get('qc_code') != contract['qc_code']
            or request.identity != digest({'source_kind': SOURCE_KIND, 'code': contract['qc_code']})):
        raise ValueError('integration_trial_target_invalid')
    if binding.test_label != TRIAL_LABEL + ' / ' + contract['qc_code']:
        raise ValueError('integration_trial_label_invalid')


def identity(binding):
    contract = binding.contract
    if standalone(binding) != (binding.request.source_kind == SOURCE_KIND):
        raise ValueError('integration_trial_target_invalid')
    if standalone(binding):
        validate_target(binding, binding.request)
        return {'tenant': binding.tenant, 'qc_id': str(mes_id(binding.qc_id)),
                'work_order_id': None, 'production_task_id': None, 'equipment_id': None,
                'snapshot_id': str(mes_id(contract['snapshot_id']))}
    return {'tenant': binding.tenant, 'qc_id': str(mes_id(binding.qc_id)),
            'work_order_id': str(mes_id(binding.work_order_id)),
            **{key: str(mes_id(contract[key])) for key in ('production_task_id', 'equipment_id', 'snapshot_id')}}


def creation_payload(*, config_id, code):
    """Official three-field QC request, returned for review; no HTTP or writes."""
    return {'checkType': 6, 'configId': mes_id(config_id), 'code': trial_code(code)}


def create_local_trial(user, key, attrs, *, session):
    """Create only a local draft. A provider target requires a reviewed binding."""
    from .inspection_models import InspectionOperation, InspectionRequest
    from .inspection_workflow import (require, lock_scope, existing_operation, replay,
                                     require_owned_request, audit, finish_operation, serialize, InspectionConflict)
    require(user, 'manage')
    if not user.is_superuser:
        raise PermissionDenied('Standalone integration preparation is administrator-only.')
    code = trial_code(attrs['code'])
    payload = {'code': code, 'inspection_items': attrs['inspection_items']}
    scope = f'{user.pk}:create-integration-trial'
    with session.lock('manage', actor_id=user.pk) as user:
        if not user.is_superuser:
            raise PermissionDenied('Standalone integration preparation is administrator-only.')
        lock_scope('inspection:create')
        previous = existing_operation(scope, key, payload)
        if previous:
            require_owned_request(user, previous.request)
            return replay(previous, user)
        target_identity = digest({'source_kind': SOURCE_KIND, 'code': code})
        if InspectionRequest.objects.filter(identity=target_identity).exists():
            raise InspectionConflict('duplicate_request', 'This integration trial already has a request.')
        request = InspectionRequest.objects.create(identity=target_identity, source_kind=SOURCE_KIND,
            work_order_ref='', task_ref='', part_no='', equipment_ref='', warehouse_ref='', lot_ref='',
            uom='', inspection_type='general', target_quantity=Decimal('0'), quantity_mode='not_recorded',
            work_started_at=timezone.now(), inspection_items=attrs['inspection_items'],
            assigned_to=user, assigned_to_name=user.get_username(), notes=TRIAL_LABEL + ' / ' + code,
            mes_snapshot={'integration_trial': {'qc_code': code, 'test_label': TRIAL_LABEL + ' / ' + code}})
        operation = InspectionOperation.objects.create(scope=scope, key=key, request=request,
                                                      payload_digest=digest(payload))
        audit(request, user, 'create_integration_trial')
        return finish_operation(operation, serialize(request, user), 201)
