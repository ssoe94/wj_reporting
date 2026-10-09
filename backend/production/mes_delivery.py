"""Reviewed production delivery coordinator; no automatic live activation.

The four existing integration flags are intentionally outside this policy.
Production authority is a separately reviewed, exact work-order scope.
"""

from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from decimal import Decimal
import hashlib
import re

from django.db import connection
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied

from mes_oauth.pilot_scope import pilot_route_scope_required
from mes_oauth.session_guard import InspectionSession
from quality.inspection_adapter import MesOutcomeUnknown
from quality.inspection_models import InspectionOperation
from quality.inspection_workflow import InspectionConflict, lock_scope, operation_key
from .mes_execution_contract import ExactQuantity, encode_exact_json, mes_id

DELIVERY_STAGES = (
    'work_order_create', 'work_order_dispatch', 'task_start',
    'first_qc', 'periodic_qc', 'progress_report', 'manual_inbound',
)
WRITE_STAGES = frozenset(DELIVERY_STAGES) - {'first_qc', 'periodic_qc'}
_SHA = re.compile(r'[0-9a-f]{64}')
_REFERENCE = re.compile(r'[A-Za-z0-9][A-Za-z0-9._/-]{0,127}')


def _sha(value):
    return hashlib.sha256(encode_exact_json(value)).hexdigest()


def _require_time(value):
    if type(value) is not datetime or timezone.is_naive(value):
        raise ValueError('An aware observed timestamp is required.')
    return value


def _quantity(value, intent):
    return ExactQuantity(value, intent.unit_id, precision=intent.unit_precision).amount


@dataclass(frozen=True)
class ProductionDeliveryIntent:
    """Exact reviewed master/quantity/location intent, never an HTTP payload."""
    tenant: str
    work_order_code: str
    material_id: int
    resource_id: int
    unit_id: int
    unit_precision: int
    quantity: Decimal
    warehouse_id: int
    storage_location_id: int
    first_qc_plan_id: int
    periodic_qc_plan_id: int

    def __post_init__(self):
        if any(type(v) is not str or _REFERENCE.fullmatch(v) is None
               for v in (self.tenant, self.work_order_code)):
            raise ValueError('An exact tenant and work-order code are required.')
        for name in ('material_id', 'resource_id', 'unit_id', 'warehouse_id',
                     'storage_location_id', 'first_qc_plan_id', 'periodic_qc_plan_id'):
            object.__setattr__(self, name, mes_id(getattr(self, name)))
        amount = ExactQuantity(self.quantity, self.unit_id, precision=self.unit_precision)
        amount.require_positive()
        object.__setattr__(self, 'quantity', amount.amount)

    def projection(self):
        return {name: str(getattr(self, name)) if name == 'quantity' else getattr(self, name)
                for name in self.__dataclass_fields__}

    @property
    def digest(self):
        return _sha(self.projection())

    @property
    def workflow_scope(self):
        # Quantity, actor and key must not create another lock namespace for
        # the same physical work order. Pin changed intents inside this lock.
        return 'production:' + _sha([self.tenant, self.work_order_code])[:48]


@dataclass(frozen=True)
class ReviewedDeliveryScope:
    """Server-owned full-body review plus production authority.

    No API, setting, client boolean, QC grant or token creates this approval.
    A future runtime activation must supply verified master/role/source evidence
    and build each payload through mes_execution_contract before reviewing it.
    """
    intent: ProductionDeliveryIntent
    actor_id: int
    mes_user_id: int
    verification_reference: str
    authority_evidence_digest: str
    expires_at: datetime
    # Immutable (stage, exact wire-body sha) pairs, including the entire BOM.
    payloads: tuple = field(repr=False)

    def __post_init__(self):
        if type(self.intent) is not ProductionDeliveryIntent:
            raise ValueError('An exact reviewed production intent is required.')
        if type(self.actor_id) is not int or type(self.mes_user_id) is not int:
            raise ValueError('Exact integer actor identities are required.')
        mes_id(self.actor_id); mes_id(self.mes_user_id)
        if (type(self.verification_reference) is not str
                or _REFERENCE.fullmatch(self.verification_reference) is None
                or type(self.authority_evidence_digest) is not str
                or _SHA.fullmatch(self.authority_evidence_digest) is None):
            raise ValueError('Explicit production authority evidence is required.')
        _require_time(self.expires_at)
        if (type(self.payloads) is not tuple or not self.payloads
                or any(type(row) is not tuple or len(row) != 2
                       or row[0] not in WRITE_STAGES or type(row[1]) is not str
                       or _SHA.fullmatch(row[1]) is None for row in self.payloads)
                or len({row[0] for row in self.payloads}) != len(self.payloads)):
            raise ValueError('Review exact immutable full payload digests.')

    def require_current(self, stage=None, payload=None):
        if self.expires_at <= timezone.now():
            raise PermissionDenied('Production scope has expired.')
        if stage is not None and (stage not in WRITE_STAGES
                or dict(self.payloads).get(stage) != _sha(payload)):
            raise PermissionDenied('The entire production payload requires exact review.')


@dataclass(frozen=True)
class VerifiedDeliveryEffect:
    """A trusted server reader's normalized exact evidence, never a write ack."""
    stage: str
    tenant: str
    work_order_code: str
    observed_at: datetime
    evidence_digest: str
    effects: dict = field(repr=False)

    def __post_init__(self):
        if (self.stage not in DELIVERY_STAGES or type(self.effects) is not dict
                or type(self.evidence_digest) is not str
                or _SHA.fullmatch(self.evidence_digest) is None):
            raise ValueError('A normalized, traceable delivery observation is required.')
        _require_time(self.observed_at)
        object.__setattr__(self, 'effects', deepcopy(self.effects))


class ProductionDeliveryCoordinator:
    """Durable write fence with exact readback and separately scoped authority.

    No default writer/reader or production HTTP mutation is wired. Callbacks are
    server closures, never request parameters. Reservations commit before any
    external write. A crash/ambiguous outcome cannot be retried with a new UUID,
    actor or changed quantity. Only an exact read may reconcile it.
    """
    def __init__(self, scope, *, session):
        if type(scope) is not ReviewedDeliveryScope or type(session) is not InspectionSession:
            raise PermissionDenied('Reviewed production scope and current login are required.')
        self.scope, self.session = scope, session

    @contextmanager
    def _guard(self):
        self.scope.require_current()
        with self.session.lock('submit', actor_id=self.scope.actor_id,
                               require_mapping=True, mes_actor=self.scope.mes_user_id) as user:
            if not user.is_active or not user.is_superuser or pilot_route_scope_required(user, self.session.claims):
                raise PermissionDenied('Unrestricted production authority is required.')
            self.scope.require_current()
            lock_scope(self.scope.intent.workflow_scope)
            yield

    def _rows(self):
        rows = list(InspectionOperation.objects.select_for_update().filter(
            scope__startswith=self.scope.intent.workflow_scope + ':').order_by('id'))
        for row in rows:
            if (row.request_id is not None or type(row.response) is not dict
                    or row.response.get('intent_digest') != self.scope.intent.digest):
                raise InspectionConflict('production_intent_conflict', 'The existing work-order intent must be reconciled.')
        return rows

    def _stage_rows(self, rows, stage):
        return [r for r in rows if r.scope == self.scope.intent.workflow_scope + ':' + stage]

    def _previous_effects(self, rows, stage):
        index = DELIVERY_STAGES.index(stage)
        previous = {}
        for name in DELIVERY_STAGES[:index]:
            completed = [r for r in self._stage_rows(rows, name) if r.status == 'succeeded']
            if len(completed) != 1 or type(completed[0].response.get('verified_effect')) is not dict:
                raise InspectionConflict('production_prerequisite_unverified', 'The preceding MES stage needs exact verified evidence.')
            previous[name] = completed[0].response['verified_effect']
        return previous

    def _reservation(self, stage, key, payload):
        self.scope.require_current(stage, payload)
        key = operation_key(key)
        with self._guard():
            rows = self._rows()
            same_stage = self._stage_rows(rows, stage)
            for row in same_stage:
                if row.key == key:
                    if row.payload_digest != _sha(payload) or row.response['actor_id'] != self.scope.actor_id:
                        raise InspectionConflict('production_key_mismatch', 'Replay requires the original actor and complete payload.')
                    return row, False
            if any(r.status in {'pending', 'unknown'} for r in rows):
                raise InspectionConflict('production_reconciliation_required', 'Read back the pending or uncertain MES action; do not resend it.')
            if any(r.status == 'succeeded' for r in same_stage):
                raise InspectionConflict('production_stage_already_completed', 'This work-order stage already has verified MES evidence.')
            self._previous_effects(rows, stage)
            row = InspectionOperation.objects.create(
                request=None, scope=self.scope.intent.workflow_scope + ':' + stage,
                key=key, payload_digest=_sha(payload), response={
                    'schema': 'production-delivery-operation/v1', 'stage': stage,
                    'actor_id': self.scope.actor_id, 'mes_user_id': self.scope.mes_user_id,
                    'intent_digest': self.scope.intent.digest,
                    'intent': self.scope.intent.projection(),
                    'verification_reference': self.scope.verification_reference,
                    'authority_evidence_digest': self.scope.authority_evidence_digest,
                    'automatic_readback_attempted': False, 'dispatched': False,
                    'code': 'production_reserved',
                })
            return row, True

    def _settle(self, row, status, code, *, proof=None):
        data = deepcopy(row.response)
        data['code'] = code
        if proof is not None:
            data['verified_effect'] = deepcopy(proof.effects)
            data['evidence_digest'] = proof.evidence_digest
            data['observed_at'] = proof.observed_at.isoformat()
        row.status, row.response = status, data
        row.response_status = {'succeeded': 200, 'unknown': 202, 'rejected': 409}[status]
        row.completed_at = timezone.now() if status != 'unknown' else None
        row.save(update_fields=['status', 'response', 'response_status', 'completed_at'])
        return self._result(row)

    @staticmethod
    def _result(row):
        # Never expose raw MES responses, intent details or credentials.
        return {'operation_id': row.pk, 'stage': row.response['stage'],
                'status': row.status, 'code': row.response['code'],
                'readback_verified': row.status == 'succeeded',
                'automatic_readback_attempted': row.response['automatic_readback_attempted']}

    def _verify(self, stage, proof, started_at, previous):
        intent = self.scope.intent
        now = timezone.now()
        if (type(proof) is not VerifiedDeliveryEffect or proof.stage != stage
                or proof.tenant != intent.tenant or proof.work_order_code != intent.work_order_code
                or not started_at <= proof.observed_at <= now
                or now - proof.observed_at > timedelta(minutes=5)):
            raise MesOutcomeUnknown()
        e = proof.effects
        base = {'work_order_id', 'material_id', 'unit_id'}
        task = {'task_id', 'resource_id'}
        plan = {'planned_quantity', 'automatic_warehousing'}
        fields = {
            'work_order_create': base | plan,
            'work_order_dispatch': base | task | plan | {'dispatch_state'},
            'task_start': base | task | plan | {'task_state'},
            'first_qc': base | task | {'qc_id', 'qc_plan_id', 'qc_type', 'qc_state',
                'judgement', 'approval_pending', 'nonconformance_open', 'measurement_basis'},
            'periodic_qc': base | task | {'qc_id', 'qc_plan_id', 'qc_type', 'qc_state',
                'judgement', 'approval_pending', 'nonconformance_open', 'measurement_basis'},
            'progress_report': base | task | {'production_inventory_id', 'report_record_ids',
                'report_inventory_link_digest', 'reported_quantity', 'inventory_quantity', 'qc_status'},
            'manual_inbound': base | task | {'production_inventory_id', 'warehouse_id',
                'storage_location_id', 'receipt_quantity', 'source_before', 'source_after',
                'destination_before', 'destination_after', 'receipt_id', 'inventory_change_log_id',
                'receipt_report_record_ids'},
        }
        if set(e) != fields[stage] or any(type(value) is not int for name, value in e.items()
                if name.endswith('_id')):
            raise MesOutcomeUnknown()
        if e.get('material_id') != intent.material_id or e.get('unit_id') != intent.unit_id:
            raise MesOutcomeUnknown()
        mes_id(e.get('work_order_id'))
        if stage != 'work_order_create' and e['work_order_id'] != previous['work_order_create']['work_order_id']:
            raise MesOutcomeUnknown()
        if stage in {'work_order_create', 'work_order_dispatch', 'task_start'}:
            if (_quantity(e.get('planned_quantity'), intent) != intent.quantity
                    or e.get('automatic_warehousing') is not False):
                raise MesOutcomeUnknown()
        if stage != 'work_order_create':
            mes_id(e.get('task_id'))
            if stage != 'work_order_dispatch' and e['task_id'] != previous['work_order_dispatch']['task_id']:
                raise MesOutcomeUnknown()
            if e.get('resource_id') != intent.resource_id:
                raise MesOutcomeUnknown()
        if stage == 'task_start' and e.get('task_state') != 'started':
            raise MesOutcomeUnknown()
        if stage == 'work_order_dispatch' and e.get('dispatch_state') != 'dispatched':
            raise MesOutcomeUnknown()
        if stage in {'first_qc', 'periodic_qc'}:
            expected_plan = intent.first_qc_plan_id if stage == 'first_qc' else intent.periodic_qc_plan_id
            if (e.get('qc_type') != (3 if stage == 'first_qc' else 5)
                    or e.get('qc_plan_id') != expected_plan or e.get('qc_state') != 'completed'
                    or e.get('judgement') != 'pass' or e.get('approval_pending') is not False
                    or e.get('nonconformance_open') is not False
                    or e.get('measurement_basis') != 'actual_measurement'):
                raise MesOutcomeUnknown()
            mes_id(e.get('qc_id'))
            if stage == 'periodic_qc' and e['qc_id'] == previous['first_qc']['qc_id']:
                raise MesOutcomeUnknown()
        if stage == 'progress_report':
            mes_id(e.get('production_inventory_id'))
            ids = e.get('report_record_ids')
            if (type(ids) is not list or not ids or len(ids) > 25
                    or any(type(v) is not int for v in ids)
                    or len({mes_id(v) for v in ids}) != len(ids)
                    or type(e.get('report_inventory_link_digest')) is not str
                    or _SHA.fullmatch(e['report_inventory_link_digest']) is None
                    or _quantity(e.get('reported_quantity'), intent) != intent.quantity
                    or _quantity(e.get('inventory_quantity'), intent) != intent.quantity
                    or type(e.get('qc_status')) is not int or e['qc_status'] != 1):
                raise MesOutcomeUnknown()
        if stage == 'manual_inbound':
            report = previous['progress_report']
            if (e.get('production_inventory_id') != report['production_inventory_id']
                    or e.get('warehouse_id') != intent.warehouse_id
                    or e.get('storage_location_id') != intent.storage_location_id
                    or _quantity(e.get('receipt_quantity'), intent) != intent.quantity
                    or _quantity(e.get('source_before'), intent) != intent.quantity
                    or _quantity(e.get('source_after'), intent) != 0
                    or _quantity(e.get('destination_after'), intent) - _quantity(e.get('destination_before'), intent) != intent.quantity):
                raise MesOutcomeUnknown()
            # Balance changes alone cannot prove this request made a receipt.
            mes_id(e.get('receipt_id')); mes_id(e.get('inventory_change_log_id'))
            receipt_records = e.get('receipt_report_record_ids')
            if (type(receipt_records) is not list or not 1 <= len(receipt_records) <= 25
                    or any(type(v) is not int for v in receipt_records)
                    or len({mes_id(v) for v in receipt_records}) != len(receipt_records)
                    or receipt_records != report['report_record_ids']):
                raise MesOutcomeUnknown()
        # Persist exact decimal text in JSON; no binary float or raw provider
        # object belongs in the durable proof. Keep the original read immutable.
        normalized = deepcopy(e)
        for name in ('planned_quantity', 'reported_quantity', 'inventory_quantity',
                     'receipt_quantity', 'source_before', 'source_after',
                     'destination_before', 'destination_after'):
            if name in normalized:
                normalized[name] = format(_quantity(normalized[name], intent), 'f')
        return VerifiedDeliveryEffect(proof.stage, proof.tenant, proof.work_order_code,
            proof.observed_at, proof.evidence_digest, normalized)

    def _fresh_qc(self, callback, previous, started_at):
        if not callable(callback):
            raise MesOutcomeUnknown()
        proofs = callback(self.scope)
        if type(proofs) is not tuple or len(proofs) != 2:
            raise MesOutcomeUnknown()
        for stage, proof in zip(('first_qc', 'periodic_qc'), proofs):
            self._verify(stage, proof, started_at, previous)
            if proof.effects['qc_id'] != previous[stage]['qc_id']:
                raise MesOutcomeUnknown()

    def execute(self, stage, key, payload, *, writer, readback, preflight, qc_readback=None):
        """One reservation, one write, then at most one automatic exact read.

        preflight is a trusted current-state reader. It must verify remote code
        uniqueness / expected stage, units and manual warehouse controls before
        dispatch. No truthy or browser-supplied substitute is admitted.
        """
        if connection.in_atomic_block:
            raise ValueError('A reservation must commit before external dispatch.')
        if stage not in WRITE_STAGES or not all(callable(v) for v in (writer, readback, preflight)):
            raise PermissionDenied('Only fixed reviewed writers and server readers are allowed.')
        row, created = self._reservation(stage, key, payload)
        if not created:
            return self._result(row)
        with self._guard():
            rows = self._rows()
            row = next(r for r in rows if r.pk == row.pk)
            previous = self._previous_effects(rows, stage)
            started_at = timezone.now()
            try:
                # The server reader attests the approved exact preconditions.
                # A digest/time-bound object is required, never True from UI.
                checked = preflight(self.scope, stage, deepcopy(payload), deepcopy(previous))
                if (type(checked) is not VerifiedDeliveryEffect or checked.stage != stage
                        or checked.tenant != self.scope.intent.tenant
                        or checked.work_order_code != self.scope.intent.work_order_code
                        or not started_at <= checked.observed_at <= timezone.now()
                        or checked.effects.get('intent_digest') != self.scope.intent.digest
                        or checked.effects.get('payload_digest') != row.payload_digest):
                    raise MesOutcomeUnknown()
                if stage in {'progress_report', 'manual_inbound'}:
                    self._fresh_qc(qc_readback, previous, started_at)
                row.response['preflight_evidence_digest'] = checked.evidence_digest
                row.save(update_fields=['response'])
            except Exception:
                return self._settle(row, 'rejected', 'production_preflight_unverified')
            try:
                ack = writer(stage, deepcopy(payload), self.scope)
                if (type(ack) is not dict or type(ack.get('code')) is not int or ack['code'] != 200
                        or type(ack.get('needCheck')) is not int or ack['needCheck'] != 0
                        or type(ack.get('data')) is not dict):
                    raise MesOutcomeUnknown()
                row.response['dispatched'] = True
            except Exception:
                dispatched = getattr(writer, 'dispatched', False) is True
                row.response['dispatched'] = dispatched
                allowance = getattr(writer, 'consume_readback_allowance', None)
                if not dispatched:
                    return self._settle(row, 'rejected', 'production_not_dispatched')
                if getattr(writer, 'status_flag', None) in {
                        'authentication_rejected', 'access_denied', 'provider_rejected'}:
                    return self._settle(row, 'rejected', 'production_provider_rejected')
                if not callable(allowance) or allowance() is not True:
                    return self._settle(row, 'unknown', 'production_outcome_unverified')
            row.response['automatic_readback_attempted'] = True
            row.save(update_fields=['response'])
            try:
                proof = self._verify(stage, readback(self.scope, stage, deepcopy(previous)), started_at, previous)
            except Exception:
                return self._settle(row, 'unknown', 'production_readback_unverified')
            return self._settle(row, 'succeeded', 'production_effect_verified', proof=proof)

    def observe_qc(self, stage, key, *, reader):
        """Read a new work order's real first/periodic QC; never save/finish it."""
        if stage not in {'first_qc', 'periodic_qc'} or not callable(reader):
            raise PermissionDenied('An exact first/periodic MES reader is required.')
        key = operation_key(key)
        with self._guard():
            rows = self._rows()
            same_stage = self._stage_rows(rows, stage)
            if same_stage:
                row = same_stage[0]
                if row.key != key or row.response['actor_id'] != self.scope.actor_id:
                    raise InspectionConflict('production_qc_already_observed', 'Use the original exact QC observation.')
                return self._result(row)
            if any(r.status in {'pending', 'unknown'} for r in rows):
                raise InspectionConflict('production_reconciliation_required', 'Resolve the uncertain stage first.')
            previous = self._previous_effects(rows, stage)
            started_at = timezone.now()
            proof = self._verify(stage, reader(self.scope, stage, deepcopy(previous)), started_at, previous)
            row = InspectionOperation.objects.create(request=None,
                scope=self.scope.intent.workflow_scope + ':' + stage, key=key,
                payload_digest=_sha([stage, self.scope.intent.digest]), response={
                    'schema': 'production-delivery-operation/v1', 'stage': stage,
                    'actor_id': self.scope.actor_id, 'mes_user_id': self.scope.mes_user_id,
                    'intent_digest': self.scope.intent.digest, 'intent': self.scope.intent.projection(),
                    'automatic_readback_attempted': False, 'dispatched': False})
            return self._settle(row, 'succeeded', 'production_qc_verified', proof=proof)

    def reconcile(self, operation_id, *, readback):
        """An explicit exact read settles interrupted/unknown actions; no resend."""
        if not callable(readback):
            raise PermissionDenied('An exact server reader is required.')
        with self._guard():
            rows = self._rows()
            row = next((r for r in rows if r.pk == operation_id), None)
            if row is None or row.response['actor_id'] != self.scope.actor_id:
                raise PermissionDenied('The original production actor and scope are required.')
            if row.status not in {'pending', 'unknown'}:
                return self._result(row)
            previous = self._previous_effects(rows, row.response['stage'])
            started_at = timezone.now()
            try:
                proof = self._verify(row.response['stage'], readback(self.scope, row.response['stage'], deepcopy(previous)), started_at, previous)
            except Exception:
                return self._settle(row, 'unknown', 'production_readback_unverified')
            return self._settle(row, 'succeeded', 'production_effect_verified', proof=proof)


def implementation_readiness():
    """Pure code metadata: never reads records, credentials or the network."""
    return {
        'writers_implemented': False,
        'runtime_connected': False,
        'live_writes_enabled': False,
        'reason': 'mes_read_only_workflow',
    }
