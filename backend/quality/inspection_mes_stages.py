"""Durable, separate MES stages. Live adapter intentionally remains disconnected.

Bindings are provisioned by reviewed server integration, never by a browser or
GET request. This is an application contract, not a claimed Blacklake mapping.
"""
from datetime import datetime
from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError
from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown
from .inspection_blacklake_contract import mes_id
from .inspection_models import InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_validation import digest
from .inspection_workflow import (InspectionConflict, require, lock_scope, existing_operation,
    replay, check_version, finish_operation, audit, result_payload, serialize)

TEST_LABEL = '연동 테스트용 가상값 / 非实测，仅用于接口测试'
STATES = {'ready', 'save_pending', 'save_unknown', 'saved', 'finish_pending', 'finish_unknown', 'completed', 'blocked'}


class DisabledStageAdapter:
    enabled = False
    def read(self, binding):
        raise MesContractUnavailable()
    def save(self, binding, records, test_label, operation_id):
        raise MesContractUnavailable()
    def finish_inspection(self, binding, verdict, operation_id):
        raise MesContractUnavailable()


def get_stage_adapter():
    return DisabledStageAdapter()


def binding_contract(binding, request):
    """Reviewed local-to-read-to-write relations; never infer any source ID."""
    contract = binding.contract
    expected_keys = {'production_task_id', 'equipment_id', 'snapshot_id', 'actor_id',
        'target_reference', 'mapping_reference', 'label_reference', 'side_effect_reference', 'items'}
    if not isinstance(contract, dict) or set(contract) != expected_keys:
        raise MesContractUnavailable()
    for key in ('production_task_id', 'equipment_id', 'snapshot_id', 'actor_id'):
        mes_id(contract[key])
    mes_id(binding.qc_id); mes_id(binding.work_order_id)
    if (not binding.tenant.strip() or binding.reviewed_result_digest != digest(result_payload(request))
            or request.status != 'approved' or request.submitted_by_id == request.reviewed_by_id
            or not request.reviewed_by_id or not binding.test_only
            or not binding.test_label.startswith(TEST_LABEL + ' / ') or len(binding.test_label) > 500):
        raise MesContractUnavailable()
    for key in ('target_reference', 'mapping_reference', 'label_reference', 'side_effect_reference'):
        if not isinstance(contract[key], str) or not 1 <= len(contract[key].strip()) <= 500:
            raise MesContractUnavailable()
    mappings = contract['items']
    if not isinstance(mappings, list) or not 1 <= len(mappings) <= 50:
        raise MesContractUnavailable()
    # Attachment IDs and provider-specific quantity writes need their own
    # reviewed mapping. Never silently drop required evidence in this stage.
    if request.quantity_mode != 'not_recorded' or request.require_evidence or request.evidence or any(item.get('evidence_required') for item in request.inspection_items) or any(row.get('evidence_url') for row in request.measurements):
        raise MesContractUnavailable()
    values = {row['item_id']: row['value'] for row in request.measurements}
    if len(values) != len(request.measurements):
        raise MesContractUnavailable()
    local_keys, read_keys, write_keys, records = set(), set(), set(), []
    for item in mappings:
        if not isinstance(item, dict) or set(item) != {'local_item_id', 'config_row_id', 'write_item_id', 'group', 'seq'}:
            raise MesContractUnavailable()
        local = item['local_item_id']; group = item['group']; seq = item['seq']
        if (not isinstance(local, str) or local not in values or local in local_keys
                or not isinstance(group, str) or not group.strip() or len(group) > 128
                or type(seq) is not int or not 1 <= seq <= 10000):
            raise MesContractUnavailable()
        read_key = (group, str(mes_id(item['config_row_id'])), seq)
        write_key = (group, str(mes_id(item['write_item_id'])), seq)
        if read_key in read_keys or write_key in write_keys:
            raise MesContractUnavailable()
        local_keys.add(local); read_keys.add(read_key); write_keys.add(write_key)
        records.append({'checkItemId': write_key[1], 'groupName': group, 'seq': seq, 'result': values[local]})
    if local_keys != set(values) or local_keys != {item['id'] for item in request.inspection_items}:
        raise MesContractUnavailable()
    return records


def read_evidence(adapter, binding, request, started_at, *, require_values):
    observed = adapter.read(binding)
    identity = {'tenant': binding.tenant, 'qc_id': binding.qc_id, 'work_order_id': binding.work_order_id,
        **{key: str(binding.contract[key]) for key in ('production_task_id', 'equipment_id', 'snapshot_id')}}
    if not isinstance(observed, dict) or observed.get('identity') != identity:
        raise MesOutcomeUnknown()
    at = observed.get('observed_at')
    if not isinstance(at, datetime) or at.utcoffset() is None or not started_at <= at <= timezone.now():
        raise MesOutcomeUnknown()
    if observed.get('state') not in {'open', 'completed', 'approval_pending', 'cancelled', 'rejected'}:
        raise MesOutcomeUnknown()
    inspection_result = observed.get('inspectionResult')
    if observed['state'] in {'completed', 'approval_pending'}:
        # Provider-normalized, observed final QC verdict, never echoed intent.
        if inspection_result not in {'pass', 'fail'} or inspection_result != request.judgement:
            raise MesOutcomeUnknown()
    if require_values:
        if observed.get('test_label') != binding.test_label:
            raise MesOutcomeUnknown()
        rows = observed.get('records')
        if not isinstance(rows, list) or len(rows) != len(binding.contract['items']):
            raise MesOutcomeUnknown()
        actual = {}
        for row in rows:
            if not isinstance(row, dict) or set(row) != {'config_row_id', 'group', 'seq', 'value'}:
                raise MesOutcomeUnknown()
            if type(row['seq']) is not int or not isinstance(row['group'], str) or not isinstance(row['value'], str):
                raise MesOutcomeUnknown()
            key = (row['group'], str(mes_id(row['config_row_id'])), row['seq'])
            if key in actual:
                raise MesOutcomeUnknown()
            actual[key] = row['value']
        values = {row['item_id']: row['value'] for row in request.measurements}
        expected = {(item['group'], str(mes_id(item['config_row_id'])), item['seq']): values[item['local_item_id']]
                    for item in binding.contract['items']}
        # Exact application strings: numeric normalization and choice encoding
        # need a reviewed provider mapping, never float coercion or guessed IDs.
        if actual != expected:
            raise MesOutcomeUnknown()
        observed_digest = digest({'identity': identity, 'records': sorted(actual.items()), 'test_label': observed['test_label'],
            'state': observed['state'], 'inspectionResult': inspection_result})
    else:
        observed_digest = ''
    return {'state': observed['state'], 'observed_at': at, 'evidence_digest': observed_digest}


def stage_summary(request, user):
    binding = InspectionMesBinding.objects.filter(request=request).first()
    enabled = get_stage_adapter().enabled
    valid = False
    if binding:
        try:
            binding_contract(binding, request)
            valid = True
        except (ValueError, TypeError, KeyError, MesContractUnavailable):
            pass
    pending = request.operations.filter(status='pending', scope__regex=r':mes-(save|finish|reconcile)$').exists()
    unknown_write = request.operations.filter(status='unknown', scope__regex=r':mes-(save|finish)$').exists()
    allowed = bool(not pending and user.is_active and user.is_superuser and request.status == 'approved')
    phase = binding.phase if binding else 'unbound'
    return {'phase': phase, 'enabled': enabled, 'test_label': binding.test_label if binding else None,
        'last_verified_at': binding.last_verified_at.isoformat() if binding and binding.last_verified_at else None,
        'can_save': bool(allowed and enabled and valid and not unknown_write and phase == 'ready'),
        'can_finish': bool(allowed and enabled and valid and not unknown_write and phase == 'saved'),
        'can_reconcile': bool(allowed and enabled and valid and phase not in {'ready', 'unbound'})}


def stage_action(user, request_id, action, key, payload):
    if action not in {'mes-save', 'mes-finish', 'mes-reconcile'}:
        raise ValidationError('Unsupported MES stage.')
    require(user, 'view' if action == 'mes-reconcile' else 'submit')
    adapter = get_stage_adapter()
    scope = f'{user.pk}:{request_id}:{action}'
    with transaction.atomic():
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        previous = existing_operation(scope, key, payload)
        if previous:
            return replay(previous, user)
        check_version(request, payload)
        binding = InspectionMesBinding.objects.select_for_update().filter(request=request).first()
        if binding is None or not adapter.enabled:
            return {'code': 'mes_contract_unverified', 'detail': 'Reviewed MES stage binding is unavailable.'}, 503
        try:
            records = binding_contract(binding, request)
        except (ValueError, TypeError, KeyError, MesContractUnavailable):
            return {'code': 'mes_contract_unverified', 'detail': 'Reviewed MES stage mapping is unavailable.'}, 503
        allowed = {'mes-save': {'ready'}, 'mes-finish': {'saved'},
            'mes-reconcile': STATES - {'ready'}}[action]
        if binding.phase not in allowed:
            raise InspectionConflict('reconciliation_required', 'Reconcile the existing MES stage without repeating writes.')
        # Read reservations also own this request until they settle. Otherwise a
        # late read could overwrite a newer finish reservation with its old phase.
        if request.operations.filter(status='pending', scope__regex=r':mes-(save|finish|reconcile)$').exists():
            raise InspectionConflict('operation_pending', 'Resolve the active or interrupted MES operation before starting another stage.')
        if action != 'mes-reconcile' and request.operations.filter(status='unknown', scope__regex=r':mes-(save|finish)$').exists():
            raise InspectionConflict('reconciliation_required', 'Reconcile uncertain writes before starting another write.')
        initial_phase = binding.phase
        op = InspectionOperation.objects.create(request=request, scope=scope, key=key, payload_digest=digest(payload))
        if action != 'mes-reconcile':
            binding.phase = 'save_pending' if action == 'mes-save' else 'finish_pending'
            binding.save(update_fields=['phase'])
        request.sync_status = 'pending'
        request.injection_receipt_readiness = 'not_verified'
        request.version += 1; request.save()
        audit(request, user, action + '_reserved')
        reserved_version = request.version
    evidence, attempted, failure = None, False, ''
    try:
        if action == 'mes-reconcile':
            evidence = read_evidence(adapter, binding, request, op.created_at, require_values=True)
            if evidence['state'] in {'cancelled', 'rejected'}:
                raise MesOutcomeUnknown()
            # An open read cannot resolve an uncertain finish or a write still
            # in flight. Only a terminal matching read can settle that stage.
            if initial_phase in {'finish_pending', 'finish_unknown'} and evidence['state'] == 'open':
                raise MesOutcomeUnknown()
        else:
            before = read_evidence(adapter, binding, request, op.created_at, require_values=action == 'mes-finish')
            if before['state'] != 'open':
                raise InspectionConflict('mes_task_closed', 'A historical completed or non-open QC cannot be changed.')
            attempted = True
            if action == 'mes-save':
                adapter.save(binding, records, binding.test_label, op.id)
            else:
                adapter.finish_inspection(binding, request.judgement, op.id)
            evidence = read_evidence(adapter, binding, request, timezone.now(), require_values=True)
            if action == 'mes-save' and evidence['state'] != 'open':
                raise MesOutcomeUnknown()
            if action == 'mes-finish' and evidence['state'] not in {'completed', 'approval_pending'}:
                raise MesOutcomeUnknown()
    except Exception:
        # No provider values, tokens, URLs or exception text enter an API/log.
        failure = 'mes_outcome_unknown' if attempted or action == 'mes-reconcile' else 'mes_stage_blocked'
    with transaction.atomic():
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        binding = InspectionMesBinding.objects.select_for_update().get(pk=binding.pk)
        op = InspectionOperation.objects.select_for_update().get(pk=op.pk)
        if op.status != 'pending':
            return replay(op, user)
        if request.version != reserved_version:
            # Never publish an older observation or repeat the call. A new read
            # must independently reconcile the durable operation.
            audit(request, user, action + '_stale_observation')
            return finish_operation(op, {'code': 'stale_remote_observation',
                'detail': 'A newer state exists. Reconcile without repeating MES writes.',
                'operation_id': op.pk, 'request': serialize(request, user)}, 409, 'unknown')
        reconciled_operations = []
        if failure:
            binding.phase = ('save_unknown' if action == 'mes-save' else 'finish_unknown' if action == 'mes-finish'
                             else initial_phase) if attempted or action == 'mes-reconcile' else 'blocked'
            request.sync_status = 'unknown'
        else:
            binding.phase = 'completed' if evidence['state'] in {'completed', 'approval_pending'} else 'saved'
            binding.last_verified_at = evidence['observed_at']; binding.evidence_digest = evidence['evidence_digest']
            request.sync_status = 'succeeded'
            request.mes_completion_status = evidence['state'] if binding.phase == 'completed' else 'not_completed'
            request.mes_checked_at = evidence['observed_at']
            if action == 'mes-reconcile':
                # Terminal finish or matching saved values settle only the
                # appropriate durable stages. No write is dispatched here.
                for pending in request.operations.filter(status__in=['pending', 'unknown']).exclude(pk=op.pk):
                    stage = pending.scope.rsplit(':', 1)[-1]
                    if stage == 'mes-save' or (stage == 'mes-finish' and binding.phase == 'completed'):
                        reconciled_operations.append(pending)
        binding.save()
        request.last_error_code = failure
        request.version += 1; request.save()
        audit(request, user, action + ('_unknown' if failure else '_verified'))
        operation_state = ('unknown' if attempted or action == 'mes-reconcile' else 'blocked') if failure else 'succeeded'
        op.status = operation_state
        op.save(update_fields=['status'])
        for pending in reconciled_operations:
            pending.status = 'succeeded'
            pending.save(update_fields=['status'])
        data = serialize(request, user)
        for pending in reconciled_operations:
            finish_operation(pending, data, state='succeeded')
        body = {'code': failure, 'operation_id': op.pk, 'request': data,
                'detail': 'Use scoped reconciliation; do not repeat an uncertain MES write.'} if failure else data
        result = finish_operation(op, body, 503 if failure else 200, operation_state)
        # Persist the fully settled operation list for the original key too.
        for pending in reconciled_operations:
            pending.response = body
            pending.save(update_fields=['response'])
        return result
