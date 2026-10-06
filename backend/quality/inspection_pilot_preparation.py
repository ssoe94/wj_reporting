"""Prepare one server-owned QC binding; never contacts MES or enables a flag."""
import json

from django.conf import settings
from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils import timezone

from mes_oauth import vault
from .inspection_live_adapter import binding_digest, parse_policy
from .inspection_mes_stages import binding_contract
from .inspection_models import InspectionMesBinding, InspectionRequest
from .inspection_validation import digest, validate_result
from .inspection_workflow import audit, lock_scope, require, result_payload


class PilotPreparationBlocked(Exception):
    pass


def prepare_pilot(manifest, *, apply=False, allow_single_actor_test=False):
    """Dry by default. A single-actor exception requires two explicit inputs.

The reviewed manifest contains the exact current WJ version/results and MES
mapping. This validates local intent, not live MES state/authority. Runtime still
performs the existing fresh scoped read before each write.
"""
    try:
        return _prepare(manifest, apply=apply, allow_single_actor_test=allow_single_actor_test)
    except Exception:
        # Do not echo the manifest, result values or database/provider errors.
        raise PilotPreparationBlocked('inspection_pilot_preparation_blocked') from None


def _prepare(manifest, *, apply=False, allow_single_actor_test=False):
    if type(apply) is not bool or type(allow_single_actor_test) is not bool:
        raise ValueError()
    if getattr(settings, 'MES_INSPECTION_ENABLED', False) is not False:
        raise ValueError()
    if (type(manifest) is not dict or set(manifest) != {'actor_id', 'request_id',
            'expected_version', 'binding', 'provider_contract'}
            or type(manifest['actor_id']) is not int or manifest['actor_id'] < 1
            or type(manifest['request_id']) is not int or manifest['request_id'] < 1
            or type(manifest['expected_version']) is not int or manifest['expected_version'] < 1):
        raise ValueError()
    candidate = manifest['binding']
    if type(candidate) is not dict or set(candidate) != {'tenant', 'qc_id', 'work_order_id',
            'contract', 'reviewed_result_digest', 'test_label'}:
        raise ValueError()
    policy = parse_policy(json.dumps(manifest['provider_contract']))
    if (policy.data['actor_id'] != manifest['actor_id']
            or policy.data['request_id'] != str(manifest['request_id'])):
        raise ValueError()
    single = 'single_actor_test_reference' in policy.data
    if single != allow_single_actor_test:
        raise ValueError()
    with transaction.atomic():
        # Match existing user -> request/advisory lock order.
        actor = get_user_model().objects.select_for_update().get(pk=manifest['actor_id'])
        require(actor, 'manage')
        require(actor, 'review')
        if not vault.eligible(actor) or str(vault.expected_user(actor.pk)) != policy.data['mes_user_id']:
            raise ValueError()
        lock_scope(f'inspection:{manifest["request_id"]}')
        row = InspectionRequest.objects.select_for_update().get(pk=manifest['request_id'])
        if (row.version != manifest['expected_version'] or row.assigned_to_id != actor.pk
                or row.sync_status != 'not_synced'
                or row.operations.filter(status__in=['pending', 'unknown']).exists()
                or InspectionMesBinding.objects.filter(request=row).exists()):
            raise ValueError()
        validate_result(row, submit=True)
        if candidate['reviewed_result_digest'] != digest(result_payload(row)):
            raise ValueError()
        if single:
            if row.status != 'submitted' or row.submitted_by_id != actor.pk or row.judgement != 'pass':
                raise ValueError()
            row.status = 'approved'
            row.reviewed_by, row.reviewed_at = actor, timezone.now()
            row.review_reason = 'single_actor_test:' + policy.data['single_actor_test_reference']
        elif row.status != 'approved' or row.submitted_by_id == row.reviewed_by_id:
            raise ValueError()
        binding = InspectionMesBinding(request=row, test_only=True, **candidate)
        # The first provider read has not happened; this nullable observation
        # timestamp intentionally remains empty (the model is not a form).
        binding.full_clean(exclude=['last_verified_at'])
        if (binding_digest(binding) != policy.data['binding_digest']
                or binding.qc_id != policy.data['qc_id'] or binding.tenant != policy.data['tenant']
                or binding.work_order_id != policy.data['work_order_id']
                or str(binding.contract['actor_id']) != policy.data['mes_user_id']):
            raise ValueError()
        records = binding_contract(binding, row, preparation_policy=policy)
        if apply:
            row.version += 1
            row.save(update_fields=['status', 'reviewed_by', 'reviewed_at', 'review_reason', 'version'])
            binding.save(force_insert=True)
            audit(row, actor, 'prepare_single_actor_test' if single else 'prepare_mes_binding',
                  row.review_reason if single else policy.data['reference'])
        return {'prepared': apply, 'dry_run': not apply, 'request_id': row.pk,
                'binding_digest': binding_digest(binding), 'record_count': len(records),
                'single_actor_test': single, 'expires_at': policy.expires_at.isoformat()}
