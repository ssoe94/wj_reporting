"""Independent whole-result protocol. No routes, token issuance or live defaults.

The injected executor guard must verify current WJ session, permissions, reviewed
mapping and the existing MES credential. The adapter must provide a reviewed
atomic provider CAS or an exclusive MES-writer fence; a read-before-write hash
alone does not satisfy that contract. Pending operations are never dispatched by
replay or reconciliation. WJ contributors remain distinct from the MES executor.
"""
from copy import deepcopy
from contextlib import contextmanager, nullcontext
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone as utc
from decimal import Decimal, InvalidOperation
import hashlib
import json

OWNER = 'wj-full-snapshot.v1'
AREAS = {'appearance', 'dimension'}


class FullSnapshotError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


class CredentialGuardFailure(FullSnapshotError):
    """Fixed broker rejection whose credential wipe must survive outer locks."""
    commit_credential_failure = True


def canonical(value):
    try:
        result = json.dumps(value, ensure_ascii=False, sort_keys=True,
                            separators=(',', ':'), allow_nan=False).encode()
        if len(result) > 256_000:
            raise ValueError()
        return result
    except (TypeError, ValueError):
        raise FullSnapshotError('invalid_snapshot') from None


def fingerprint(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def _check(condition, code):
    if not condition:
        raise FullSnapshotError(code)


def _id(value):
    _check(type(value) is str and value.isascii() and value.isdigit()
           and 0 < int(value) < 2**63 and str(int(value)) == value, 'invalid_mes_id')
    return value


def _person(person):
    _check(type(person) is dict and type(person.get('id')) is int
           and person['id'] > 0 and type(person.get('name')) is str
           and bool(person['name'].strip()) and type(person.get('kind', 'wj_actor')) is str
           and person.get('kind', 'wj_actor') in {'wj_actor', 'display_inspector'}, 'missing_actor_provenance')


def _identity(person):
    return person.get('kind', 'wj_actor'), person['id']


def _at(value):
    try:
        _check(type(value) is str, 'invalid_observation_time')
        parsed = datetime.fromisoformat(value)
        _check(parsed.utcoffset() is not None, 'invalid_observation_time')
        return parsed
    except ValueError:
        raise FullSnapshotError('invalid_observation_time') from None


def _digest(value):
    _check(type(value) is str and len(value) == 64
           and all(c in '0123456789abcdef' for c in value), 'invalid_digest')


def validate_source(source):
    """Server-captured content only; never accepts browser-supplied authors."""
    source = json.loads(canonical(source))  # detach every nested mutable object
    _check(type(source) is dict, 'invalid_snapshot')
    for key in ('request_id', 'request_version', 'config_version'):
        _check(type(source.get(key)) is int and source[key] > 0, 'invalid_source_version')
    approved = source.get('request_status') == 'approved'
    _check(source.get('request_status') in {'draft', 'approved'}
           and source.get('workflow_status') == 'completed'
           and source.get('new_role_only') is True, 'areas_not_complete')
    _check(source.get('quantity_mode') == 'not_recorded'
           and source.get('require_evidence') is False and source.get('evidence') == [],
           'unsupported_side_effects')
    try:
        _check(set(source['quantities']) == {'inspected', 'accepted', 'rejected'}
               and all(type(x) is str and Decimal(x).is_finite() and Decimal(x) == 0
                       for x in source['quantities'].values()), 'unsupported_side_effects')
    except (KeyError, TypeError, InvalidOperation):
        raise FullSnapshotError('unsupported_side_effects') from None
    _check(source.get('judgement') in {'pass', 'fail'}, 'invalid_judgement')
    _check(type(source.get('shift_snapshot')) is dict and bool(source['shift_snapshot'])
           and type(source.get('actor_snapshot')) is dict and bool(source['actor_snapshot']),
           'missing_historical_snapshot')
    terminal = source.get('terminal')
    _check(type(terminal) is dict, 'missing_actor_provenance')
    if terminal.get('id') is not None:
        _person(terminal)
        _check(terminal.get('kind', 'wj_actor') == 'wj_actor', 'missing_actor_provenance')
    else:
        _check(terminal.get('name') in {'', None}, 'missing_actor_provenance')
    items = source.get('items')
    _check(type(items) is list and 2 <= len(items) <= 50, 'invalid_item_coverage')
    item_ids = [row.get('id') for row in items if type(row) is dict]
    _check(len(item_ids) == len(items) and all(type(x) is str and x for x in item_ids)
           and len(set(item_ids)) == len(item_ids), 'invalid_item_coverage')
    _check(all(not x.get('evidence_required') for x in items), 'unsupported_side_effects')
    item_areas = source.get('item_areas')
    _check(type(item_areas) is dict and set(item_areas) == set(item_ids)
           and set(item_areas.values()) == AREAS, 'invalid_item_coverage')
    areas = source.get('areas')
    _check(type(areas) is list and len(areas) == 2
           and {x.get('area') for x in areas if type(x) is dict} == AREAS, 'areas_not_complete')
    assignees, values = set(), {}
    for area in areas:
        _check(area.get('status') == 'complete' and type(area.get('version')) is int
               and area['version'] > 0 and area.get('judgement') in {'pass', 'fail'},
               'areas_not_complete')
        _person(area.get('assigned'))
        assignees.add(_identity(area['assigned']))
        completion = area.get('completion')
        _check(type(completion) is dict, 'missing_completion_provenance')
        _person(completion.get('inspector')); _person(completion.get('recorder'))
        _check(_identity(completion['inspector']) == _identity(area['assigned'])
               and completion['recorder'].get('kind', 'wj_actor') == 'wj_actor', 'inspector_mismatch')
        if area['assigned'].get('kind') == 'display_inspector':
            _check(terminal.get('id') == completion['recorder']['id'], 'inspector_mismatch')
        completed_at = _at(completion.get('at'))
        _check(area.get('evidence') == [], 'unsupported_side_effects')
        measurements, authorship = area.get('measurements'), area.get('authorship')
        expected = {key for key, owner in item_areas.items() if owner == area['area']}
        _check(type(measurements) is list and type(authorship) is dict
               and set(authorship) == expected, 'missing_item_provenance')
        local = set()
        for row in measurements:
            _check(type(row) is dict and row.get('item_id') in expected
                   and row['item_id'] not in local and type(row.get('value')) is str
                   and 0 < len(row['value']) <= 500, 'invalid_item_coverage')
            _check(not row.get('evidence_url'), 'unsupported_side_effects')
            local.add(row['item_id']); values[row['item_id']] = row['value']
            author = authorship[row['item_id']]
            _check(type(author) is dict, 'missing_item_provenance')
            _person({'id': author.get('inspector_id'), 'name': author.get('inspector_name'), 'kind': author.get('inspector_kind', 'wj_actor')})
            _person({'id': author.get('recorded_by_id'), 'name': author.get('recorded_by_name')})
            _check((author.get('inspector_kind', 'wj_actor'), author['inspector_id']) == _identity(area['assigned']), 'inspector_mismatch')
            if area['assigned'].get('kind') == 'display_inspector':
                _check(author.get('inspector_wj_id') is None and author['recorded_by_id'] == terminal.get('id'), 'inspector_mismatch')
            _check(_at(author.get('recorded_at')) <= completed_at, 'invalid_provenance_time')
        _check(local == expected, 'invalid_item_coverage')
    _check(len(assignees) == 2, 'two_inspectors_required')
    area_judgement = 'fail' if any(x['judgement'] == 'fail' for x in areas) else 'pass'
    _check(source['judgement'] == area_judgement
           or approved and source['judgement'] == 'fail', 'invalid_judgement')
    history = source.get('historical_contributors')
    _check(type(history) is list and len(history) <= 1000, 'missing_historical_snapshot')
    for row in history:
        _check(type(row) is dict and row.get('action') in
               {f'role_{area}_{action}' for area in AREAS for action in ('save', 'complete', 'reopen')},
               'missing_historical_snapshot')
        _person({'id': row.get('actor_id'), 'name': row.get('actor_name')})
        _at(row.get('at'))
    if approved:
        approval = source.get('approval')
        _check(type(approval) is dict, 'independent_approval_required')
        _person(approval.get('submitter')); _person(approval.get('reviewer'))
        _check(all(approval[key].get('kind', 'wj_actor') == 'wj_actor' for key in ('submitter', 'reviewer')), 'independent_approval_required')
        _check(_at(approval.get('reviewed_at')) >= _at(approval.get('submitted_at')),
               'invalid_approval_time')
        _digest(approval.get('result_digest'))
        for key, actor_key, actions in (
                ('submit_audit', 'submitter', {'submit'}),
                ('review_audit', 'reviewer', {'approve', 'review-failure'})):
            row = approval.get(key)
            _check(type(row) is dict and row.get('action') in actions
                   and row.get('actor_id') == approval[actor_key]['id']
                   and row.get('actor_name') == approval[actor_key]['name']
                   and row.get('result_digest') == approval['result_digest'],
                   'independent_approval_changed')
            _check(all(type(row.get(key)) is int and row[key] > 0
                       for key in ('id', 'version')), 'independent_approval_changed')
            _at(row.get('at'))
        _check(approval['review_audit']['version'] > approval['submit_audit']['version']
               and _at(approval['review_audit']['at']) >= _at(approval['submit_audit']['at']),
               'invalid_approval_time')
        contributors = {actor_id for kind, actor_id in assignees if kind == 'wj_actor'} | {approval['submitter']['id']}
        if terminal.get('id') is not None:
            contributors.add(terminal['id'])
        for area in areas:
            contributors.add(area['completion']['recorder']['id'])
            contributors.update(author['recorded_by_id'] for author in area['authorship'].values())
        contributors.update(row['actor_id'] for row in history)
        _check(approval['reviewer']['id'] not in contributors, 'independent_reviewer_required')
    return source, values


def normalize_observation(value, *, fresh=False):
    value = json.loads(canonical(value))
    _check(type(value) is dict, 'invalid_mes_observation')
    required = {'tenant', 'qc_id', 'snapshot_id', 'executor_id', 'config_digest',
                'config_keys', 'records', 'state', 'verdict', 'end_time', 'observed_at'}
    _check(set(value) == required and type(value['tenant']) is str
           and value['tenant'].strip(), 'invalid_mes_observation')
    for key in ('qc_id', 'snapshot_id', 'executor_id'):
        _id(value[key])
    _digest(value['config_digest'])
    _check(value['state'] in {'open', 'completed'}
           and value['verdict'] in {None, 'pass', 'fail'}, 'invalid_mes_observation')
    if value['state'] == 'completed':
        _check(value['verdict'] is not None and type(value['end_time']) is int
               and value['end_time'] > 0, 'invalid_mes_observation')
    else:
        _check(value['end_time'] is None, 'invalid_mes_observation')
    at = _at(value['observed_at'])
    observed_ms = int(at.timestamp() * 1000)
    if value['state'] == 'completed':
        _check(value['end_time'] <= observed_ms, 'invalid_mes_observation')
    if fresh:
        now = datetime.now(utc.utc)
        _check(now - timedelta(seconds=30) <= at <= now, 'stale_mes_observation')
    _check(type(value['config_keys']) is list and 2 <= len(value['config_keys']) <= 50,
           'invalid_config_coverage')
    keys = set()
    for row in value['config_keys']:
        _check(type(row) is dict and set(row) == {'config_row_id', 'group', 'seq'},
               'invalid_config_coverage')
        key = _record_key(row)
        _check(key not in keys, 'invalid_config_coverage'); keys.add(key)
    _check(type(value['records']) is list and len(value['records']) <= len(keys),
           'invalid_result_coverage')
    seen, record_ids = set(), set()
    for row in value['records']:
        _check(type(row) is dict and set(row) == {'config_row_id', 'group', 'seq', 'value',
               'record_id', 'operator_id', 'created_at', 'updated_at'}, 'missing_mes_provenance')
        key = _record_key(row)
        _check(key in keys and key not in seen and type(row['value']) is str,
               'invalid_result_coverage')
        seen.add(key)
        _id(row['record_id']); _id(row['operator_id'])
        _check(row['record_id'] not in record_ids, 'invalid_result_coverage')
        record_ids.add(row['record_id'])
        _check(type(row['created_at']) is int and type(row['updated_at']) is int
               and 0 < row['created_at'] <= row['updated_at'] <= observed_ms,
               'missing_mes_provenance')
    value['config_keys'].sort(key=_record_key)
    value['records'].sort(key=_record_key)
    return value


def _record_key(row):
    _id(row.get('config_row_id'))
    _check(type(row.get('group')) is str and bool(row['group'].strip())
           and type(row.get('seq')) is int and 1 <= row['seq'] <= 10000,
           'invalid_record_key')
    return row['group'], row['config_row_id'], row['seq']


def remote_fingerprint(observation):
    value = normalize_observation(observation)
    value.pop('observed_at')  # collection time is not provider revision evidence
    return fingerprint(value)


@dataclass(frozen=True)
class ExecutorAuthority:
    actor_id: int
    mes_user_id: str
    tenant: str
    qc_id: str
    snapshot_id: str
    expires_at: datetime
    review_reference: str
    concurrency_reference: str
    concurrency_mode: str
    residual_remote_race: bool = False
    operational_conditions_reference: str = ''


def _authority(authority, actor_id, binding, adapter):
    _check(isinstance(authority, ExecutorAuthority)
           and authority.actor_id == actor_id and type(actor_id) is int
           and authority.tenant == binding.tenant and authority.qc_id == binding.qc_id
           and authority.snapshot_id == str(binding.contract.get('snapshot_id'))
           and authority.mes_user_id == str(binding.contract.get('actor_id')),
           'executor_authority_mismatch')
    _id(authority.mes_user_id)
    _check(isinstance(authority.expires_at, datetime) and authority.expires_at.utcoffset() is not None
           and authority.expires_at > datetime.now(utc.utc)
           and bool(authority.review_reference) and bool(authority.concurrency_reference),
           'executor_authority_unavailable')
    strong = authority.concurrency_mode in {'provider_cas', 'exclusive_writer'}
    trial = (authority.concurrency_mode == 'reviewed_single_writer_trial'
             and authority.residual_remote_race is True
             and bool(authority.operational_conditions_reference)
             and binding.test_only is True and binding.work_order_id == ''
             and binding.contract.get('context') == 'standalone_test')
    _check((strong or trial) and authority.concurrency_mode == getattr(adapter, 'concurrency_mode', None)
           and getattr(adapter, 'enabled', False) is True, 'remote_concurrency_unverified')


def binding_fingerprint(binding):
    return fingerprint({key: getattr(binding, key) for key in
        ('request_id', 'tenant', 'qc_id', 'work_order_id', 'test_only', 'test_label',
         'reviewed_result_digest', 'contract')})


def build_full_snapshot(source, binding, baseline):
    """Pure immutable intent; authority and dispatch remain separate stages."""
    source, values = validate_source(source)
    if source['request_status'] == 'approved':
        _check(binding.reviewed_result_digest == source['approval']['result_digest'],
               'independent_approval_changed')
    baseline = normalize_observation(baseline, fresh=True)
    target = {'tenant': binding.tenant, 'qc_id': binding.qc_id,
              'snapshot_id': str(binding.contract.get('snapshot_id')),
              'executor_id': str(binding.contract.get('actor_id'))}
    _check(all(baseline[k] == v for k, v in target.items()) and baseline['state'] == 'open',
           'mes_target_changed')
    mappings = binding.contract.get('items')
    _check(type(mappings) is list and len(mappings) == len(values), 'invalid_mapping_coverage')
    reads, writes, locals_seen, payload = set(), set(), set(), []
    expected_records = []
    for row in mappings:
        _check(type(row) is dict and set(row) == {'local_item_id', 'config_row_id',
               'write_item_id', 'group', 'seq'}, 'invalid_mapping_coverage')
        key = _record_key(row); _id(row['write_item_id'])
        write_key = row['group'], row['write_item_id'], row['seq']
        local = row['local_item_id']
        _check(local in values and local not in locals_seen and key not in reads
               and write_key not in writes, 'invalid_mapping_coverage')
        locals_seen.add(local); reads.add(key); writes.add(write_key)
        payload.append({'checkItemId': int(row['write_item_id']), 'groupName': row['group'],
                        'seq': row['seq'], 'result': values[local]})
        expected_records.append({'config_row_id': row['config_row_id'], 'group': row['group'],
                                 'seq': row['seq'], 'value': values[local]})
    _check(reads == {_record_key(x) for x in baseline['config_keys']}, 'unmapped_mes_rows')
    payload.sort(key=lambda x: (x['groupName'], x['checkItemId'], x['seq']))
    expected_records.sort(key=_record_key)
    return {'owner': OWNER, 'source': source, 'source_digest': fingerprint(source),
            'binding_digest': binding_fingerprint(binding), 'target': target,
            'baseline': baseline, 'remote_fingerprint': remote_fingerprint(baseline),
            'payload': {'taskId': int(binding.qc_id), 'checkItems': payload},
            'expected_records': expected_records, 'verdict': source['judgement']}


def verify_readback(intent, observation, *, stage, previous=None):
    observed = normalize_observation(observation, fresh=True)
    _check(all(observed[k] == v for k, v in intent['target'].items())
           and observed['config_digest'] == intent['baseline']['config_digest']
           and observed['config_keys'] == intent['baseline']['config_keys'], 'mes_target_changed')
    actual = [{k: row[k] for k in ('config_row_id', 'group', 'seq', 'value')}
              for row in observed['records']]
    _check(actual == intent['expected_records'], 'whole_readback_mismatch')
    _check(all(row['operator_id'] == intent['target']['executor_id']
               for row in observed['records']), 'mes_executor_mismatch')
    if stage == 'save':
        _check(observed['state'] == 'open', 'unexpected_mes_completion')
    else:
        _check(stage == 'finish' and observed['state'] == 'completed'
               and observed['verdict'] == intent['verdict'], 'mes_finish_unverified')
        _check(previous is not None and observed['records'] == previous['records'],
               'mes_result_provenance_changed')
    return observed


class DisabledFullSnapshotAdapter:
    enabled = False
    concurrency_mode = None


class FullSnapshotCoordinator:
    """Durable at-most-one dispatch per stage, including after worker restart.

Adapter guarded_save/guarded_finish MUST enforce expected_remote_fingerprint
atomically or within its reviewed exclusive-writer fence. No live implementation
is installed here. source.capture is server-owned and runs under request locks.
"""
    def __init__(self, *, source, executor_guard, adapter=None):
        self.source = source
        self.executor_guard = executor_guard
        self.adapter = adapter if adapter is not None else DisabledFullSnapshotAdapter()

    def _rows(self, request_id):
        from .inspection_models import InspectionRequest, InspectionMesBinding
        from .inspection_workflow import lock_scope
        lock_scope(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        binding = InspectionMesBinding.objects.select_for_update().get(request=request)
        return request, binding

    def _actor_lock(self, actor, stage):
        # Concrete session guards take user/login locks before the request lock,
        # matching existing role actions and credential leases.
        locker = getattr(self.executor_guard, 'lock', None)
        return locker(actor, stage) if callable(locker) else nullcontext()

    @contextmanager
    def _work(self, actor, stage):
        from django.db import transaction
        failure = None
        with self._actor_lock(actor, stage), transaction.atomic():
            try:
                yield
            except CredentialGuardFailure as error:
                # The broker deliberately wipes rejected credentials. Commit
                # that fixed rejection before raising outside session.lock too.
                failure = error
        if failure is not None:
            raise failure

    def _guard(self, actor, request, binding, stage):
        authority = self.executor_guard(actor, request, binding, stage)
        _authority(authority, actor.pk, binding, self.adapter)
        return authority

    @staticmethod
    def _result(operation):
        return {'operation_id': operation.pk, 'status': operation.status,
                'stage': operation.response.get('stage'), 'code': operation.response.get('code', '')}

    def run(self, actor, request_id, key, *, source_digest, stage='save'):
        from django.db import transaction
        from .inspection_models import InspectionOperation
        from .inspection_workflow import operation_key
        _check(stage in {'save', 'finish'}, 'invalid_stage'); _digest(source_digest)
        key = operation_key(key)
        scope = f'{actor.pk}:{request_id}:mes-full-{stage}'
        call_digest = fingerprint({'actor_id': actor.pk, 'request_id': request_id,
                                   'source_digest': source_digest, 'stage': stage})
        with self._work(actor, stage):
            request, binding = self._rows(request_id)
            authority = self._guard(actor, request, binding, stage)
            old = InspectionOperation.objects.filter(scope=scope, key=key).first()
            if old:
                _check(old.payload_digest == call_digest and old.response.get('owner') == OWNER,
                       'idempotency_payload_mismatch')
                return self._result(old)  # never redispatch even if pending/unknown
            _check(not request.operations.filter(status__in=['pending', 'unknown']).exists(),
                   'operation_unresolved')
            _check(binding.phase == ('ready' if stage == 'save' else 'full_saved'),
                   'stage_already_reserved')
            source = self.source.capture(request)
            if stage == 'save':
                _check(fingerprint(source) == source_digest, 'source_changed')
                intent = build_full_snapshot(source, binding, self.adapter.read(binding, authority))
                previous = None
            else:
                saved = request.operations.filter(status='succeeded', scope__endswith=':mes-full-save').first()
                _check(saved is not None and saved.response.get('owner') == OWNER, 'whole_save_unverified')
                intent = deepcopy(saved.response['intent'])
                previous = deepcopy(saved.response['readback'])
                _check(source_digest == intent['source_digest'], 'source_changed')
                self._same_source(source, request.version, saved.response['reserved_version'], intent)
                _check(binding_fingerprint(binding) == intent['binding_digest'], 'binding_changed')
                observed = verify_readback(intent, self.adapter.read(binding, authority), stage='save')
                _check(remote_fingerprint(observed) == remote_fingerprint(previous), 'mes_concurrent_change')
                intent['remote_fingerprint'] = remote_fingerprint(observed)
            request.version += 1
            request.sync_status = 'pending'
            request.save(update_fields=['version', 'sync_status', 'updated_at'])
            binding.phase = f'full_{stage}_pending'
            binding.save(update_fields=['phase'])
            operation = InspectionOperation.objects.create(request=request, scope=scope, key=key,
                payload_digest=call_digest, response={'owner': OWNER, 'stage': stage, 'state': 'reserved',
                    'intent': intent, 'previous_readback': previous, 'reserved_version': request.version,
                    'executor_actor_id': actor.pk, 'review_reference': authority.review_reference,
                    'concurrency_reference': authority.concurrency_reference})
        # Only the invocation which created the reservation reaches this code.
        return self._dispatch(actor, request_id, operation.pk)

    @staticmethod
    def _same_source(source, actual_version, reserved_version, intent):
        _check(actual_version == reserved_version and source.get('request_version') == actual_version,
               'source_changed')
        source = deepcopy(source)
        source['request_version'] = intent['source']['request_version']
        _check(fingerprint(source) == intent['source_digest'], 'source_changed')

    def _dispatch(self, actor, request_id, operation_id):
        from django.db import transaction
        from .inspection_models import InspectionOperation
        claimed = False
        try:
            with self._work(actor, 'submit'):
                request, binding = self._rows(request_id)
                op = InspectionOperation.objects.select_for_update().get(pk=operation_id, request=request)
                if op.status != 'pending' or op.response.get('state') != 'reserved':
                    return self._result(op)  # concurrent caller cannot alter the dispatch owner
                stage, intent = op.response['stage'], op.response['intent']
                _check(binding.phase == f'full_{stage}_pending', 'binding_phase_changed')
                authority = self._guard(actor, request, binding, stage)
                self._same_source(self.source.capture(request), request.version, op.response['reserved_version'], intent)
                _check(binding_fingerprint(binding) == intent['binding_digest'], 'binding_changed')
                current = normalize_observation(self.adapter.read(binding, authority), fresh=True)
                _check(remote_fingerprint(current) == intent['remote_fingerprint'], 'mes_concurrent_change')
                op.response['state'] = 'dispatch_claimed'
                op.response['dispatch_at'] = datetime.now(utc.utc).isoformat()
                op.save(update_fields=['response'])
            claimed = True
            method = self.adapter.guarded_save if stage == 'save' else self.adapter.guarded_finish
            method(binding, deepcopy(intent), intent['remote_fingerprint'], operation_id, authority)
            evidence = verify_readback(intent, self.adapter.read(binding, authority), stage=stage,
                                       previous=op.response['previous_readback'])
            return self._settle(actor, request_id, operation_id, evidence)
        except Exception as error:
            return self._uncertain(request_id, operation_id, claimed,
                error.code if isinstance(error, FullSnapshotError) else 'mes_outcome_unknown')

    def _uncertain(self, request_id, operation_id, claimed, code):
        from django.db import transaction
        from .inspection_models import InspectionOperation
        with transaction.atomic():
            request, binding = self._rows(request_id)
            op = InspectionOperation.objects.select_for_update().get(pk=operation_id, request=request)
            if op.status != 'succeeded':
                claimed = claimed or op.response.get('state') in {'dispatch_claimed', 'unknown'}
                op.status = 'unknown' if claimed else 'blocked'
                op.response.update(state=op.status, code=code)
                op.response_status = 503 if claimed else 409
                op.save(update_fields=['status', 'response', 'response_status'])
                expected_phases = {f"full_{op.response['stage']}_pending",
                                   f"full_{op.response['stage']}_unknown"}
                if request.version == op.response['reserved_version'] and binding.phase in expected_phases:
                    binding.phase = f"full_{op.response['stage']}_unknown" if claimed else 'full_blocked'
                    binding.save(update_fields=['phase'])
                    request.sync_status = 'unknown' if claimed else 'not_synced'
                    request.last_error_code = code
                    request.save(update_fields=['sync_status', 'last_error_code', 'updated_at'])
            return self._result(op)

    def _settle(self, actor, request_id, operation_id, evidence):
        from django.db import transaction
        from django.utils import timezone
        from .inspection_models import InspectionOperation, InspectionAudit
        with self._work(actor, 'submit'):
            request, binding = self._rows(request_id)
            op = InspectionOperation.objects.select_for_update().get(pk=operation_id, request=request)
            _check(op.response.get('owner') == OWNER and op.status in {'pending', 'unknown'},
                   'operation_not_reconcilable')
            _check(op.response.get('executor_actor_id') == actor.pk, 'mes_executor_mismatch')
            _check(binding.phase in {f"full_{op.response['stage']}_pending",
                                     f"full_{op.response['stage']}_unknown"}, 'binding_phase_changed')
            self._guard(actor, request, binding, op.response['stage'])
            self._same_source(self.source.capture(request), request.version, op.response['reserved_version'],
                              op.response['intent'])
            _check(binding_fingerprint(binding) == op.response['intent']['binding_digest'], 'binding_changed')
            evidence = verify_readback(op.response['intent'], evidence, stage=op.response['stage'],
                                      previous=op.response['previous_readback'])
            _check(_at(evidence['observed_at']) >= _at(op.response['dispatch_at']),
                   'readback_predates_dispatch')
            if op.response['stage'] == 'finish':
                _check(evidence['end_time'] >= int(_at(op.response['dispatch_at']).timestamp() * 1000),
                       'finish_predates_dispatch')
            op.status = 'succeeded'; op.response_status = 200; op.completed_at = timezone.now()
            op.response.update(state='verified', code='', readback=evidence)
            op.save(update_fields=['status', 'response_status', 'completed_at', 'response'])
            binding.phase = 'full_saved' if op.response['stage'] == 'save' else 'full_completed'
            binding.evidence_digest = remote_fingerprint(evidence)
            binding.last_verified_at = _at(evidence['observed_at'])
            binding.save(update_fields=['phase', 'evidence_digest', 'last_verified_at'])
            request.sync_status = 'succeeded'; request.last_error_code = ''
            request.mes_checked_at = binding.last_verified_at
            fields = ['sync_status', 'last_error_code', 'mes_checked_at', 'updated_at']
            if binding.test_only is True:
                snapshot = request.mes_snapshot if type(request.mes_snapshot) is dict else {}
                request.mes_snapshot = {**snapshot, 'verified_trial': {
                    'schema': 'integration-trial-observation.v1',
                    'identity': {'qc_id': binding.qc_id},
                    'state': evidence['state'], 'judgement': evidence['verdict'],
                    'observed_at': evidence['observed_at'],
                    'evidence_digest': binding.evidence_digest}}
                fields.append('mes_snapshot')
            if op.response['stage'] == 'finish':
                request.mes_completion_status = 'completed'; fields.append('mes_completion_status')
            request.save(update_fields=fields)
            InspectionAudit.objects.create(request=request, actor=actor, actor_name=actor.get_username(),
                action=f"mes_full_{op.response['stage']}", version=request.version, status=request.status,
                result_digest=op.response['intent']['source_digest'])
            return self._result(op)

    def reconcile(self, actor, request_id, operation_id):
        """Read only at MES; never saves, finishes or clears an uncertain stage."""
        from django.db import transaction
        from .inspection_models import InspectionOperation
        with self._work(actor, 'read'):
            request, binding = self._rows(request_id)
            op = InspectionOperation.objects.select_for_update().get(pk=operation_id, request=request)
            _check(op.response.get('owner') == OWNER and op.status in {'pending', 'unknown'},
                   'operation_not_reconcilable')
            _check(op.response.get('executor_actor_id') == actor.pk, 'mes_executor_mismatch')
            _check(op.response.get('state') in {'dispatch_claimed', 'unknown'}, 'dispatch_never_claimed')
            _check(binding.phase in {f"full_{op.response['stage']}_pending",
                                     f"full_{op.response['stage']}_unknown"}, 'binding_phase_changed')
            self._same_source(self.source.capture(request), request.version, op.response['reserved_version'],
                              op.response['intent'])
            _check(binding_fingerprint(binding) == op.response['intent']['binding_digest'], 'binding_changed')
            authority = self._guard(actor, request, binding, op.response['stage'])
            evidence = self.adapter.read(binding, authority)
        return self._settle(actor, request_id, operation_id, evidence)
