"""Offline preparation for one new synthetic partial-record trial.

No transport, credentials, Django settings, models or activation capability.
An intent is reviewable bytes, never live authority. This in-memory coordinator
does not provide durable reservations, provider CAS or operational acceptance.
An eventual live adapter needs separately approved scope, existing lawful Lee
authority, independent review, durable atomic stages and a reviewed raw decoder.
Neither this module nor its mocks relax the existing role MES guard.
"""
from dataclasses import dataclass, field
from datetime import datetime, timedelta
import hashlib
import json
import re
from uuid import UUID

from .inspection_blacklake_contract import mes_id, result_and_finish_plan


TRIAL_CODE = 'WJ-IT-20261007-PARTIAL-01'
PLAN_NAME = 'WJ standalone partial-record preservation / ' + TRIAL_CODE
STAGES = ('setup-full', 'sparse-a', 'sparse-b', 'finish')
VALUES = (('10.0', '20.0'), ('10.1', '20.0'), ('10.1', '20.1'))


class TrialBlocked(ValueError):
    """Fixed reason codes; do not expose identities, values or provider bodies."""


def _aware(value):
    return type(value) is datetime and value.utcoffset() is not None


def _id(value):
    return str(mes_id(value))


def _fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True,
        separators=(',', ':'), ensure_ascii=False).encode()).hexdigest()


@dataclass(frozen=True)
class TrialItem:
    local_id: str
    read_id: str
    write_id: str
    group: str
    seq: int = 1


@dataclass(frozen=True)
class TrialScope:
    qc_id: str
    config_id: str
    tenant: str
    executor_wj_id: int
    executor_mes_id: str
    items: tuple[TrialItem, TrialItem]
    starts_at: datetime
    expires_at: datetime
    excluded_qc_ids: tuple[str, ...]
    creation_receipt_reference: str
    execution_review_reference: str
    existing_lee_authority_reference: str
    reviewed_configuration_digest: str

    def __post_init__(self):
        try:
            if (type(self.executor_wj_id) is not int or not 1 <= self.executor_wj_id <= 9223372036854775807
                    or not _aware(self.starts_at) or not _aware(self.expires_at)
                    or not timedelta(0) < self.expires_at - self.starts_at <= timedelta(minutes=30)
                    or type(self.items) is not tuple or len(self.items) != 2
                    or any(type(item) is not TrialItem for item in self.items)
                    or tuple(item.local_id for item in self.items) != ('A', 'B')
                    or type(self.excluded_qc_ids) is not tuple or not self.excluded_qc_ids
                    or type(self.reviewed_configuration_digest) is not str
                    or not re.fullmatch(r'[0-9a-f]{64}', self.reviewed_configuration_digest)):
                raise ValueError()
            ids = [_id(self.qc_id), _id(self.config_id), _id(self.executor_mes_id)]
            if ids[0] in {_id(value) for value in self.excluded_qc_ids}:
                raise ValueError()
            for value in (self.tenant, self.creation_receipt_reference,
                          self.execution_review_reference, self.existing_lee_authority_reference):
                if type(value) is not str or not 1 <= len(value.strip()) <= 500:
                    raise ValueError()
            read_keys, write_keys = set(), set()
            for item in self.items:
                if type(item.group) is not str or not 1 <= len(item.group.strip()) <= 128 or type(item.seq) is not int or item.seq != 1:
                    raise ValueError()
                read_keys.add((_id(item.read_id), item.group, item.seq))
                write_keys.add((_id(item.write_id), item.group, item.seq))
            if len(read_keys) != 2 or len(write_keys) != 2:
                raise ValueError()
        except (ValueError, TypeError):
            raise TrialBlocked('trial_scope_invalid') from None


@dataclass(frozen=True)
class TrialRecord:
    read_id: str
    group: str
    seq: int
    value: str
    operator_id: str | None
    created_at: datetime | None
    updated_at: datetime | None
    record_id: str | None = None


@dataclass(frozen=True)
class TrialObservation:
    qc_id: str
    config_id: str
    qc_code: str
    tenant: str
    executor_mes_id: str
    observed_at: datetime
    records: tuple[TrialRecord, ...]
    configuration_digest: str
    config_item_keys: tuple[tuple[str, str, int], ...]
    state: str = 'open'
    verdict: str | None = None
    completed_at: datetime | None = None
    # A future reviewed decoder must derive these from raw provider evidence.
    production_links: tuple = ()
    quantity_not_recorded: bool = True


@dataclass(frozen=True)
class OfflineTrialIntent:
    stage: str
    key: str
    endpoint: str
    json_body: str
    before_marker: str
    scope_marker: str
    reserved_at: datetime
    live_authorized: bool = field(default=False, init=False)


class OfflinePartialTrial:
    """One setup, two sparse intents and one finish; no dispatch or automatic retry.

    Persisting or signing this state is deliberately outside this preparation.
    Recreating the object is not a safe live retry mechanism. Caller observations
    are local inputs, not proof of provider behavior or current USER privileges.
    """

    def __init__(self, scope):
        if type(scope) is not TrialScope:
            raise TrialBlocked('trial_scope_invalid')
        self._scope = scope
        self._pinned_scope_marker = self._scope_marker()
        self.index = 0
        self.pending = None
        self.unknown = False
        self._baseline = None
        self._keys = set()

    @property
    def scope(self):
        return self._scope

    @property
    def phase(self):
        if self.pending:
            return 'unknown' if self.unknown else 'reserved'
        return 'complete' if self.index == len(STAGES) else STAGES[self.index]

    def _records(self, observation, now, *, writing):
        scope = self.scope
        try:
            deadline = scope.expires_at if writing else scope.expires_at + timedelta(minutes=5)
            if (type(observation) is not TrialObservation or not _aware(now)
                    or not scope.starts_at <= now < deadline
                    or not _aware(observation.observed_at)
                    or not max(scope.starts_at, now - timedelta(seconds=60)) <= observation.observed_at <= now
                    or _id(observation.qc_id) != _id(scope.qc_id)
                    or _id(observation.config_id) != _id(scope.config_id)
                    or observation.qc_code != TRIAL_CODE or observation.tenant != scope.tenant
                    or _id(observation.executor_mes_id) != _id(scope.executor_mes_id)
                    or observation.production_links != () or observation.quantity_not_recorded is not True
                    or observation.configuration_digest != scope.reviewed_configuration_digest
                    or type(observation.records) is not tuple or len(observation.records) not in (0, 2)):
                raise ValueError()
            allowed = {(_id(item.read_id), item.group, item.seq) for item in scope.items}
            if (type(observation.config_item_keys) is not tuple or len(observation.config_item_keys) != 2
                    or {(_id(identifier), group, seq) for identifier, group, seq in observation.config_item_keys} != allowed
                    or any(type(seq) is not int for _, _, seq in observation.config_item_keys)):
                raise ValueError()
            records = {}
            record_ids = set()
            for row in observation.records:
                if type(row) is not TrialRecord or type(row.seq) is not int:
                    raise ValueError()
                key = (_id(row.read_id), row.group, row.seq)
                if (key not in allowed or key in records or type(row.value) is not str
                        or not 1 <= len(row.value.strip()) <= 500
                        or row.operator_id is None or not _aware(row.created_at) or not _aware(row.updated_at)
                        or row.record_id is None or _id(row.record_id) in record_ids
                        or not row.created_at <= row.updated_at <= observation.observed_at):
                    raise ValueError()
                # Missing/null/invalid operator or timestamps cannot establish preservation.
                records[key] = (_id(row.operator_id), row.value,
                    row.created_at.isoformat(), row.updated_at.isoformat(), _id(row.record_id))
                record_ids.add(_id(row.record_id))
            if records and set(records) != allowed:
                raise ValueError()
            return records
        except (ValueError, TypeError):
            raise TrialBlocked('trial_observation_invalid') from None

    def _ordered(self, records):
        return [records[(_id(item.read_id), item.group, item.seq)] for item in self.scope.items]

    def _scope_marker(self):
        scope = self.scope
        return _fingerprint({'plan': PLAN_NAME, 'qc_id': _id(scope.qc_id),
            'config_id': _id(scope.config_id), 'tenant': scope.tenant,
            'executor_wj_id': scope.executor_wj_id, 'executor_mes_id': _id(scope.executor_mes_id),
            'items': [(item.local_id, _id(item.read_id), _id(item.write_id), item.group, item.seq) for item in scope.items],
            'configuration': scope.reviewed_configuration_digest,
            'starts_at': scope.starts_at.isoformat(), 'expires_at': scope.expires_at.isoformat(),
            'excluded_qc_ids': [_id(value) for value in scope.excluded_qc_ids],
            'creation': scope.creation_receipt_reference, 'review': scope.execution_review_reference,
            'existing_lee_authority': scope.existing_lee_authority_reference})

    def _require_pinned_scope(self):
        if (type(self._scope) is not TrialScope or self._scope_marker() != self._pinned_scope_marker
                or self.pending is not None and self.pending.scope_marker != self._pinned_scope_marker):
            raise TrialBlocked('trial_scope_changed')

    def reserve(self, stage, key, before, *, now, executor_wj_id, executor_mes_id):
        self._require_pinned_scope()
        if self.pending or self.index == len(STAGES) or stage != STAGES[self.index]:
            raise TrialBlocked('trial_stage_unavailable')
        try:
            if (type(key) is not str or str(UUID(key)) != key or key in self._keys
                    or type(executor_wj_id) is not int or executor_wj_id != self.scope.executor_wj_id
                    or _id(executor_mes_id) != _id(self.scope.executor_mes_id)):
                raise ValueError()
        except (ValueError, TypeError):
            raise TrialBlocked('trial_actor_or_key_invalid') from None
        records = self._records(before, now, writing=True)
        if before.state != 'open' or before.verdict is not None or before.completed_at is not None:
            raise TrialBlocked('trial_open_state_required')
        if records != (self._baseline or {}):
            raise TrialBlocked('trial_baseline_changed')
        # Verify complete nonempty prior records before advancing to sparse/finish.
        if (self.index == 0 and records) or (self.index > 0 and not records):
            raise TrialBlocked('trial_baseline_changed')
        values = VALUES[min(self.index, 2)]
        selected = (0, 1) if self.index in (0, 3) else (self.index - 1,)
        payload = [{'checkItemId': self.scope.items[i].write_id,
            'groupName': self.scope.items[i].group, 'seq': self.scope.items[i].seq,
            'result': values[i]} for i in selected]
        plans = result_and_finish_plan(self.scope.qc_id, payload, verdict='pass')
        plan = plans[1 if self.index == 3 else 0]
        intent = OfflineTrialIntent(stage, key, plan.endpoint, plan.json_body,
            _fingerprint(sorted(records.items())), self._scope_marker(), now)
        self._keys.add(key)
        self.pending = intent
        return intent

    def mark_unknown(self, key):
        if not self.pending or self.pending.key != key:
            raise TrialBlocked('trial_operation_unavailable')
        self.unknown = True

    def observe_result(self, key, after, *, now, reconcile=False):
        if not self.pending or self.pending.key != key or (self.unknown and not reconcile):
            raise TrialBlocked('trial_read_reconciliation_required')
        try:
            self._require_pinned_scope()
            records = self._records(after, now, writing=False)
            if after.observed_at < self.pending.reserved_at or not records:
                raise TrialBlocked('trial_after_evidence_required')
            ordered = self._ordered(records)
            if tuple(row[1] for row in ordered) != VALUES[min(self.index, 2)]:
                raise TrialBlocked('trial_result_mismatch')
            if self.index < 3:
                if after.state != 'open' or after.verdict is not None or after.completed_at is not None:
                    raise TrialBlocked('trial_open_state_required')
                changed = (0, 1) if self.index == 0 else (self.index - 1,)
                if any(ordered[i][0] != _id(self.scope.executor_mes_id) for i in changed):
                    raise TrialBlocked('trial_written_operator_mismatch')
                if self.index in (1, 2):
                    omitted = 2 - self.index
                    if ordered[omitted] != self._ordered(self._baseline)[omitted]:
                        raise TrialBlocked('trial_omitted_marker_changed')
            elif (records != self._baseline or after.state != 'completed' or after.verdict != 'pass'
                    or not _aware(after.completed_at)
                    or not self.pending.reserved_at <= after.completed_at <= after.observed_at):
                raise TrialBlocked('trial_finish_not_verified')
        except TrialBlocked:
            self.unknown = True
            raise
        self._baseline = records
        self.pending = None
        self.unknown = False
        self.index += 1
        return self.phase
