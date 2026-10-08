"""Integration guards for local area work; no MES credential or writer access."""
from rest_framework import serializers
from rest_framework.exceptions import PermissionDenied, ValidationError

from .inspection_access import require_owned_request
from .inspection_models import InspectionOperation, InspectionRequest
from .inspection_role_models import InspectionRoleWorkflow
from .inspection_validation import StrictSerializer, digest, validate_result
from .inspection_workflow import (
    InspectionConflict, audit, check_version, existing_operation, finish_operation,
    lock_scope, replay, require, serialize,
)


MES_ROLE_CONTRACT_UNVERIFIED = 'mes_partial_multi_executor_contract_unverified'


def require_verified_role_mes_contract(user, request_id):
    """Reject role writes before constructing an adapter or acquiring a lease.

    Item records and a single executor are documented. Missing-item preservation,
    cross-user authority and external concurrency control are not. WJ assignment
    never authorizes impersonating that executor or rewriting their other items.
    """
    if not InspectionRoleWorkflow.objects.filter(request_id=request_id).exists():
        return
    request = InspectionRequest.objects.get(pk=request_id)
    require_owned_request(user, request)
    raise InspectionConflict(MES_ROLE_CONTRACT_UNVERIFIED,
        'MES partial-update preservation and multiple-executor authority are unverified. '
        'WJ area results remain local; no MES action was dispatched.')


class RoleResultSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=1)
    inspected_quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=0)
    accepted_quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=0)
    rejected_quantity = serializers.DecimalField(max_digits=18, decimal_places=3, min_value=0)
    notes = serializers.CharField(max_length=2000, allow_blank=True)


def role_results(user, request_id, key, payload, *, session):
    """Owner-only quantity summary, independent of each inspector's area values."""
    require(user, 'manage')
    if isinstance(payload, dict) and type(payload.get('version')) is bool:
        raise ValidationError({'version': 'Use the current integer version.'})
    serializer = RoleResultSerializer(data=payload)
    serializer.is_valid(raise_exception=True)
    attrs = serializer.validated_data
    canonical = {name: str(value) if name.endswith('_quantity') else value for name, value in attrs.items()}
    scope = f'{user.pk}:{request_id}:role-results'
    with session.lock('manage', actor_id=user.pk) as user:
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        require_owned_request(user, request)
        if request.assigned_to_id != user.pk:
            raise PermissionDenied('Only the request owner may record the shared quantity summary.')
        if not InspectionRoleWorkflow.objects.filter(request=request).exists():
            raise InspectionConflict('role_workflow_required', 'This action belongs to a new area-assigned inspection.')
        previous = existing_operation(scope, key, canonical)
        if previous:
            return replay(previous, user)
        from .inspection_roles import _mutable
        _mutable(request)
        check_version(request, attrs)
        for name in ('inspected_quantity', 'accepted_quantity', 'rejected_quantity', 'notes'):
            setattr(request, name, attrs[name])
        validate_result(request)
        if request.judgement == 'pass' and request.rejected_quantity:
            raise ValidationError('Passed areas cannot contain a rejected quantity.')
        request.version += 1
        request.save(update_fields=['inspected_quantity', 'accepted_quantity', 'rejected_quantity',
                                    'notes', 'version', 'updated_at'])
        audit(request, user, 'role_results')
        operation = InspectionOperation.objects.create(scope=scope, key=key,
            request=request, payload_digest=digest(canonical))
        return finish_operation(operation, serialize(request, user))
