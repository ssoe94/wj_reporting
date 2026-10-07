"""Approved area results → reviewed whole MES save → separate MES finish.

Connections are supplied only by reviewed server integration. Empty registry is
the default; browser selections and runtime flags do not create executor or
remote-concurrency authority. This module never provisions bindings or tokens.
"""
from dataclasses import dataclass
from copy import deepcopy

from django.conf import settings
from django.db import transaction
from rest_framework import serializers

from .inspection_access import require_owned_request
from .inspection_full_snapshot import FullSnapshotCoordinator, FullSnapshotError, fingerprint, validate_source
from .inspection_full_snapshot_authority import CurrentExecutorGuard
from .inspection_full_snapshot_connection import BlacklakeFullSnapshotAdapter, ReviewedFullSnapshotConnection
from .inspection_full_snapshot_source import DjangoCompletedSource
from .inspection_models import InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_validation import StrictSerializer
from .inspection_workflow import lock_scope, require, serialize


@dataclass(frozen=True)
class FullSnapshotProductConnection:
    policy: ReviewedFullSnapshotConnection
    atomic_writer: object = None
    external_fence: object = None


class FullSnapshotActionSerializer(StrictSerializer):
    source_digest = serializers.RegexField(regex=r'^[0-9a-f]{64}$')


class FullSnapshotReconcileSerializer(StrictSerializer):
    operation_id = serializers.IntegerField(min_value=1)


def load_connection(request_id):
    registry = getattr(settings, 'INSPECTION_FULL_SNAPSHOT_CONNECTIONS', {})
    value = registry.get(request_id) if type(registry) is dict else None
    if (type(value) is not FullSnapshotProductConnection
            or type(value.policy) is not ReviewedFullSnapshotConnection
            or value.policy.request_id != request_id):
        raise FullSnapshotError('whole_connection_review_required')
    return value


def _approved(request, binding, policy):
    if (request.status != 'approved' or request.judgement not in {'pass', 'fail'}
            or request.reviewed_by_id != policy.reviewer_actor_id
            or not policy.matches(request, binding)):
        raise FullSnapshotError('independent_approval_required')
    source, _ = validate_source(DjangoCompletedSource.capture(request))
    if binding.reviewed_result_digest != source['approval']['result_digest']:
        raise FullSnapshotError('independent_approval_changed')
    normalized = deepcopy(source)
    normalized['request_version'] = policy.source_request_version
    if fingerprint(normalized) != policy.source_digest:
        raise FullSnapshotError('source_changed')
    return source


class ProductExecutorGuard(CurrentExecutorGuard):
    def __init__(self, connection, session):
        self.connection = connection
        super().__init__(connection.policy, session)

    def _check_policy(self, current, request, binding, stage):
        if load_connection(request.pk) is not self.connection:
            raise FullSnapshotError('whole_connection_review_changed')
        _approved(request, binding, self.policy)
        return super()._check_policy(current, request, binding, stage)


def get_coordinator(user, request_id, session):
    connection = load_connection(request_id)
    policy = connection.policy
    if user.pk != policy.actor_id:
        raise FullSnapshotError('mes_executor_mismatch')
    guard = ProductExecutorGuard(connection, session)
    adapter = BlacklakeFullSnapshotAdapter(policy, session=session, executor_guard=guard,
        atomic_writer=connection.atomic_writer, external_fence=connection.external_fence)
    if not adapter.enabled:
        raise FullSnapshotError('remote_concurrency_unverified')
    return FullSnapshotCoordinator(source=DjangoCompletedSource, executor_guard=guard, adapter=adapter)


def product_summary(request, user):
    result = {'phase': 'blocked', 'enabled': False, 'test_only': False,
        'qc_code': None, 'test_label': None, 'last_verified_at': None,
        'can_save': False, 'can_finish': False, 'can_reconcile': False,
        'mode': 'whole_snapshot', 'source_digest': None, 'operation_id': None,
        'blocked_reason': 'whole_connection_review_required'}
    try:
        connection = load_connection(request.pk)
        policy = connection.policy
        require(user, 'submit')
        require_owned_request(user, request)
        if user.pk != policy.actor_id:
            raise FullSnapshotError('mes_executor_mismatch')
        from mes_oauth import vault
        if str(vault.expected_user(user.pk)) != str(policy.mes_user_id):
            raise FullSnapshotError('mes_executor_mismatch')
        concurrency = (policy.write_authorized is True and (
            policy.concurrency_mode == 'provider_cas' and callable(connection.atomic_writer)
            or policy.concurrency_mode == 'exclusive_writer' and callable(connection.external_fence)
            or policy.concurrency_mode == 'reviewed_single_writer_trial'
                and policy.residual_remote_race is True and bool(policy.operational_conditions_reference)))
        if not concurrency:
            raise FullSnapshotError('remote_concurrency_unverified')
        with transaction.atomic():
            lock_scope(f'inspection:{request.pk}')
            current = InspectionRequest.objects.select_for_update().get(pk=request.pk)
            binding = InspectionMesBinding.objects.select_for_update().filter(request=current).first()
            if binding is None:
                raise FullSnapshotError('whole_binding_review_required')
            _approved(current, binding, policy)
            if policy.concurrency_mode == 'reviewed_single_writer_trial' and not (
                binding.test_only and binding.work_order_id == ''
                and binding.contract.get('context') == 'standalone_test'):
                raise FullSnapshotError('remote_concurrency_unverified')
            unresolved = current.operations.filter(status__in=['pending', 'unknown'])
            # Use the module's owner constant, avoiding arbitrary operation IDs.
            from .inspection_full_snapshot import OWNER
            own = unresolved.filter(response__owner=OWNER,
                response__executor_actor_id=user.pk).order_by('id').first()
            result.update(phase=binding.phase, enabled=True, test_only=binding.test_only,
                qc_code=policy.qc_code, test_label=binding.test_label,
                source_digest=policy.source_digest,
                last_verified_at=binding.last_verified_at.isoformat() if binding.last_verified_at else None,
                can_save=not unresolved.exists() and binding.phase == 'ready',
                can_finish=not unresolved.exists() and binding.phase == 'full_saved',
                can_reconcile=bool(own and own.response.get('state') in {'dispatch_claimed', 'unknown'}),
                operation_id=own.pk if own else None, blocked_reason=None)
    except FullSnapshotError as error:
        result['blocked_reason'] = error.code
    except Exception:
        # Read projections never construct a credential lease or expose errors.
        result['blocked_reason'] = 'whole_connection_unavailable'
    return result


def product_action(user, request_id, action, key, payload, *, session):
    if action not in {'save', 'finish', 'reconcile'}:
        raise FullSnapshotError('invalid_stage')
    require(user, 'view' if action == 'reconcile' else 'submit')
    request = InspectionRequest.objects.get(pk=request_id)
    require_owned_request(user, request)
    from .inspection_role_models import InspectionRoleWorkflow
    if not InspectionRoleWorkflow.objects.filter(request=request).exists():
        raise FullSnapshotError('role_workflow_required')
    serializer = (FullSnapshotReconcileSerializer if action == 'reconcile'
                  else FullSnapshotActionSerializer)(data=payload)
    serializer.is_valid(raise_exception=True)
    coordinator = get_coordinator(user, request_id, session)
    if action == 'reconcile':
        operation_id = serializer.validated_data['operation_id']
        if not InspectionOperation.objects.filter(pk=operation_id, request_id=request_id,
                response__executor_actor_id=user.pk).exists():
            raise FullSnapshotError('operation_not_reconcilable')
        receipt = coordinator.reconcile(user, request_id, operation_id)
    else:
        receipt = coordinator.run(user, request_id, key,
            source_digest=serializer.validated_data['source_digest'], stage=action)
    request.refresh_from_db()
    data = serialize(request, user)
    data['whole_snapshot_operation'] = receipt
    if receipt.get('code'):
        data['code'] = receipt['code']
    return data, {'succeeded': 200, 'pending': 202, 'unknown': 503, 'blocked': 409}.get(receipt['status'], 409)
