"""Atomic WJ area results, with no MES transport or credential operations."""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta
import re
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from .inspection_access import can_access_inspections, can_use_admin_inspection_flow
from .inspection_models import InspectionOperation, InspectionRequest, InspectionMesBinding
from .inspection_role_models import InspectionShiftSetting, InspectionRoleWorkflow, InspectionAreaResult
from .inspection_validation import DraftInspectionSerializer, digest, validate_result

AREAS = ('appearance', 'dimension')
MES_BLOCKED_REASON = 'mes_partial_multi_executor_contract_unverified'


def _conflict(code, detail):
    from .inspection_workflow import InspectionConflict
    raise InspectionConflict(code, detail)


def _lock(scope):
    from .inspection_workflow import lock_scope
    lock_scope(scope)


def _eligible(user):
    return bool(can_access_inspections(user) and user.has_perm('quality.manage_inspectionrequest')
                and user.has_perm('quality.submit_inspectionrequest'))


def _admin(user):
    if not can_use_admin_inspection_flow(user) or not user.has_perm('quality.manage_inspectionrequest'):
        raise PermissionDenied('An active unrestricted superuser must explicitly configure inspection assignments.')


@contextmanager
def _actor_transaction(user, session, *, permission='manage'):
    # Every mutation rechecks the verified login family, actor and permissions.
    if not user or not getattr(user, 'is_authenticated', False) or not user.pk:
        raise PermissionDenied('An authenticated inspection actor is required.')
    if session is None:
        raise PermissionDenied('A verified current inspection login is required.')
    with session.lock(permission, actor_id=user.pk) as current:
        yield current


def _operation(scope, key, payload, *, request=None):
    from .inspection_workflow import operation_key
    key = operation_key(key)
    previous = InspectionOperation.objects.filter(scope=scope, key=key).first()
    if previous and previous.payload_digest != digest(payload):
        _conflict('idempotency_payload_mismatch', 'Use the original payload for this key.')
    return previous, key


def _finish(scope, key, payload, response, *, request=None, status=200):
    operation = InspectionOperation.objects.create(scope=scope, key=key, request=request,
        payload_digest=digest(payload), status='succeeded', response_status=status,
        response=response, completed_at=timezone.now())
    return operation.response, status


def _response(request, user):
    from .inspection_workflow import serialize
    response = serialize(request, user)
    response['role_workflow'] = role_summary(request, user)
    return response


def _setting_data(setting):
    return {'id': setting.pk, 'code': setting.code, 'label': setting.label,
        'timezone': setting.timezone, 'start_time': setting.starts_at.isoformat() if setting.starts_at else None,
        'end_time': setting.ends_at.isoformat() if setting.ends_at else None,
        'appearance_assignee': setting.appearance_assignee_id,
        'dimension_assignee': setting.dimension_assignee_id, 'active': setting.active,
        'version': setting.version}


def settings_list(user):
    if not can_access_inspections(user):
        raise PermissionDenied('Current inspection access is required.')
    admin = can_use_admin_inspection_flow(user) and user.has_perm('quality.manage_inspectionrequest')
    # A restricted inspector sees only active shifts involving themselves, and
    # cannot enumerate accounts or configure a colleague's role.
    rows = InspectionShiftSetting.objects.all()
    if not admin:
        from django.db.models import Q
        rows = rows.filter(active=True).filter(Q(appearance_assignee=user) | Q(dimension_assignee=user))
    candidates = []
    if admin:
        for actor in get_user_model().objects.filter(is_active=True).order_by('username', 'id'):
            if _eligible(actor):
                candidates.append({'id': actor.pk, 'username': actor.get_username(),
                                   'name': actor.get_full_name() or actor.get_username()})
    return {'settings': [_setting_data(row) for row in rows], 'candidates': candidates,
            'can_configure': bool(admin)}


def _time(value, field):
    if value is None or value == '':
        return None
    try:
        result = time.fromisoformat(value) if isinstance(value, str) else value
        if not isinstance(result, time) or result.tzinfo is not None:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValidationError({field: 'Use a local clock time without a UTC offset.'}) from None
    return result


def _intervals(start, end):
    def seconds(value):
        return value.hour * 3600 + value.minute * 60 + value.second + value.microsecond / 1000000
    a, b = seconds(start), seconds(end)
    return [(a, b)] if a < b else [(a, 86400), (0, b)]


def _setting_validate(setting):
    if (not isinstance(setting.code, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', setting.code)
            or not isinstance(setting.label, str) or not setting.label.strip() or len(setting.label) > 128):
        raise ValidationError('Provide a stable shift code and a label of up to 128 characters.')
    setting.label = setting.label.strip()
    if setting.timezone != 'Asia/Shanghai':
        raise ValidationError({'timezone': 'Inspection shifts use the factory timezone Asia/Shanghai.'})
    if type(setting.active) is not bool:
        raise ValidationError({'active': 'Use a boolean.'})
    for field in ('appearance_assignee', 'dimension_assignee'):
        actor_id = getattr(setting, field + '_id')
        if actor_id is not None:
            if type(actor_id) is not int or not 1 <= actor_id <= 9223372036854775807:
                raise ValidationError({field: 'Select an existing eligible account.'})
            actor = get_user_model().objects.filter(pk=actor_id, is_active=True).first()
            if not actor or not _eligible(actor):
                raise ValidationError({field: 'The account must already have inspection access and input/submit permissions.'})
    if not setting.active:
        return
    if (not setting.starts_at or not setting.ends_at or setting.starts_at == setting.ends_at
            or not setting.appearance_assignee_id or not setting.dimension_assignee_id
            or setting.appearance_assignee_id == setting.dimension_assignee_id):
        raise ValidationError('Activation requires explicit times and two distinct eligible inspectors.')
    intervals = _intervals(setting.starts_at, setting.ends_at)
    for other in InspectionShiftSetting.objects.filter(active=True).exclude(pk=setting.pk):
        if not other.starts_at or not other.ends_at or other.timezone != setting.timezone:
            _conflict('shift_schedule_ambiguous', 'Resolve the existing active shift schedule before activating this shift.')
        if any(max(a, c) < min(b, d) for a, b in intervals for c, d in _intervals(other.starts_at, other.ends_at)):
            _conflict('shift_overlap', 'Active inspection shift times must not overlap.')


def _setting_payload(setting, payload, *, create):
    editable = {'code', 'label', 'timezone', 'start_time', 'end_time',
                'appearance_assignee', 'dimension_assignee', 'active'}
    allowed = editable | ({'reason'} if create else {'version', 'reason'})
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValidationError('Unknown or server-controlled shift fields.')
    reason = payload.get('reason', '')
    if not isinstance(reason, str) or len(reason) > 500 or (not create and not reason.strip()):
        raise ValidationError({'reason': 'Provide a change reason of up to 500 characters.'})
    for field in editable:
        if field not in payload:
            continue
        value = payload[field]
        if field in {'start_time', 'end_time'}:
            setattr(setting, 'starts_at' if field == 'start_time' else 'ends_at', _time(value, field))
        elif field.endswith('_assignee'):
            setattr(setting, field + '_id', value)
        else:
            setattr(setting, field, value)
    _setting_validate(setting)


def settings_create(user, key, payload, *, session):
    scope = f'{user.pk}:role-shift:create'
    with _actor_transaction(user, session) as user:
        _admin(user)
        _lock('inspection-role:shift-settings')
        previous, key = _operation(scope, key, payload)
        if previous:
            return previous.response, previous.response_status
        setting = InspectionShiftSetting(creator=user)
        _setting_payload(setting, payload, create=True)
        if InspectionShiftSetting.objects.filter(code=setting.code).exists():
            _conflict('duplicate_shift_code', 'This shift code already exists.')
        setting.save()
        response = settings_list(user)
        response.update(setting=_setting_data(setting), actor_id=user.pk)
        return _finish(scope, key, payload, response, status=201)


def settings_update(user, setting_id, key, payload, *, session):
    if not isinstance(payload, dict):
        raise ValidationError('Use a shift setting object.')
    scope = f'{user.pk}:role-shift:{setting_id}:update'
    with _actor_transaction(user, session) as user:
        _admin(user)
        _lock('inspection-role:shift-settings')
        setting = get_object_or_404(InspectionShiftSetting.objects.select_for_update(), pk=setting_id)
        previous, key = _operation(scope, key, payload)
        if previous:
            return previous.response, previous.response_status
        if type(payload.get('version')) is not int or payload['version'] != setting.version:
            _conflict('stale_shift_version', 'Keep the draft and explicitly reload the current shift setting.')
        _setting_payload(setting, payload, create=False)
        if InspectionShiftSetting.objects.filter(code=setting.code).exclude(pk=setting.pk).exists():
            _conflict('duplicate_shift_code', 'This shift code already exists.')
        setting.version += 1
        setting.save()
        response = settings_list(user)
        response.update(setting=_setting_data(setting), actor_id=user.pk)
        return _finish(scope, key, payload, response)


def initialize_role_workflow(request):
    """Internal new-record creation hook. Never called by GET or configure."""
    if not isinstance(request.inspection_items, list) or len(request.inspection_items) < 2:
        raise ValidationError({'inspection_items': 'Role inspection needs at least one item in each of two areas.'})
    if (request.version != 1 or request.status != 'draft' or request.measurements or request.evidence
            or request.judgement or request.sync_status != 'not_synced' or request.submitted_at or request.reviewed_at
            or request.mes_completion_status != 'not_completed' or request.external_result_id):
        _conflict('role_requires_new_request', 'Role inspection requires a new empty request; preserve existing evidence.')
    with transaction.atomic():
        workflow = InspectionRoleWorkflow.objects.create(request=request)
        InspectionAreaResult.objects.bulk_create([InspectionAreaResult(workflow=workflow, area=area) for area in AREAS])
    return workflow


def _is_mutable(request):
    return not (request.status != 'draft' or request.mes_completion_status in {'completed', 'approval_pending', 'unknown'}
        or request.sync_status in {'pending', 'unknown', 'succeeded'} or request.external_result_id
        or request.operations.filter(status__in=['pending', 'unknown']).exists()
        or InspectionMesBinding.objects.filter(request=request).exclude(phase='ready').exists())


def _mutable(request):
    if not _is_mutable(request):
        _conflict('role_request_immutable', 'Preserve completed or pending MES evidence; this request cannot be changed.')


def _workflow(request, *, lock=False):
    queryset = InspectionRoleWorkflow.objects
    if lock:
        queryset = queryset.select_for_update()
    workflow = queryset.filter(request=request).first()
    if not workflow or workflow.new_role_only is not True:
        _conflict('legacy_request_preserved', 'Existing requests retain their original workflow. Create an explicit role inspection.')
    return workflow


def _area_access(user, workflow, area):
    if not _eligible(user) or area.assigned_to_id != user.pk or workflow.status == 'unconfigured':
        raise PermissionDenied('Only the assigned current inspector may change this area, including for superusers.')


def configure_role_workflow(user, request_id, key, payload, *, session):
    allowed = {'config_version', 'shift_setting_id', 'shift_version', 'shift_date', 'item_areas', 'reason'}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValidationError('Unknown or server-controlled assignment fields.')
    with _actor_transaction(user, session) as user:
        _admin(user)
        # Shift updates and request snapshots share this lock. Existing requests
        # retain immutable snapshots when a future shift setting changes.
        _lock('inspection-role:shift-settings')
        _lock(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        workflow = _workflow(request, lock=True)
        scope = f'{user.pk}:{request_id}:role-configure'
        previous, key = _operation(scope, key, payload, request=request)
        if previous:
            return previous.response, previous.response_status
        _mutable(request)
        if type(payload.get('config_version')) is not int or payload['config_version'] != workflow.config_version:
            _conflict('stale_config_version', 'Reload the assignment configuration before applying the change.')
        if (request.measurements or request.judgement or request.evidence
                or workflow.areas.filter(status='complete').exists()
                or any(row.measurements or row.evidence for row in workflow.areas.all())):
            _conflict('populated_assignment_immutable', 'Assignments cannot change after any inspector has entered results.')
        reason = payload.get('reason', '')
        if not isinstance(reason, str) or not reason.strip() or len(reason) > 500:
            raise ValidationError({'reason': 'An explicit configuration reason is required.'})
        shift_id = payload.get('shift_setting_id')
        if type(shift_id) is not int or not 1 <= shift_id <= 9223372036854775807:
            raise ValidationError({'shift_setting_id': 'Select an explicitly configured active shift.'})
        shift = InspectionShiftSetting.objects.select_for_update().filter(pk=shift_id, active=True).first()
        if not shift:
            raise ValidationError({'shift_setting_id': 'Select an explicitly configured active shift.'})
        if type(payload.get('shift_version')) is not int or shift.version != payload['shift_version']:
            _conflict('stale_shift_version', 'Reload the current shift setting before assigning the request.')
        _setting_validate(shift)
        try:
            if not isinstance(payload.get('shift_date'), str):
                raise ValueError()
            shift_date = date.fromisoformat(payload['shift_date'])
            if payload['shift_date'] != shift_date.isoformat() or shift_date.year == 9999:
                raise ValueError()
        except ValueError:
            raise ValidationError({'shift_date': 'Explicitly select the declared shift date (YYYY-MM-DD).'}) from None
        local_zone = ZoneInfo(shift.timezone)
        window_start = datetime.combine(shift_date, shift.starts_at, tzinfo=local_zone)
        window_end = datetime.combine(shift_date, shift.ends_at, tzinfo=local_zone)
        if window_end <= window_start:
            window_end += timedelta(days=1)
        mapping = payload.get('item_areas')
        item_ids = {item['id'] for item in request.inspection_items}
        if (not isinstance(mapping, dict) or set(mapping) != item_ids
                or any(value not in AREAS for value in mapping.values()) or set(mapping.values()) != set(AREAS)):
            raise ValidationError({'item_areas': 'Explicitly map every item, with at least one item in each area.'})
        actors = {area: getattr(shift, area + '_assignee') for area in AREAS}
        workflow.shift_setting = shift
        workflow.shift_snapshot = _setting_data(shift)
        workflow.shift_snapshot.update(shift_date=shift_date.isoformat(),
            window_start=window_start.isoformat(), window_end=window_end.isoformat(),
            basis='explicit_declaration')
        workflow.actor_snapshot = {area: {'id': actor.pk, 'name': actor.get_username()} for area, actor in actors.items()}
        workflow.item_areas = mapping
        workflow.config_version += 1
        workflow.status = 'in_progress'
        workflow.save()
        for area in workflow.areas.select_for_update().all():
            actor = actors[area.area]
            area.assigned_to, area.assigned_to_name = actor, actor.get_username()
            area.version += 1
            area.save()
        request.version += 1
        request.save(update_fields=['version', 'updated_at'])
        _audit(request, user, 'role_configure', reason)
        return _finish(scope, key, payload, _response(request, user), request=request)


def _audit(request, user, action, reason=''):
    from .inspection_workflow import audit
    audit(request, user, action, reason)


def role_summary(request, user):
    workflow = InspectionRoleWorkflow.objects.filter(request=request).first()
    if not workflow:
        return None
    areas = []
    mutable = _is_mutable(request)
    eligible = _eligible(user)
    for row in workflow.areas.order_by('area'):
        owner = eligible and row.assigned_to_id == user.pk and workflow.status != 'unconfigured' and mutable
        areas.append({'area': row.area, 'assigned_to': row.assigned_to_id,
            'assigned_to_name': row.assigned_to_name, 'version': row.version, 'status': row.status,
            'judgement': row.judgement, 'measurements': row.measurements, 'evidence': row.evidence,
            'completed_by': row.completed_by_id, 'completed_by_name': row.completed_by_name,
            'completed_at': row.completed_at.isoformat() if row.completed_at else None,
            'can_save': bool(owner and row.status == 'draft'), 'can_complete': bool(owner and row.status == 'draft'),
            'can_reopen': bool(owner and row.status == 'complete'), 'mes_status': row.mes_status,
            'mes_blocked_reason': row.mes_blocked_reason})
    owned = {row['area'] for row in areas if row['assigned_to'] == getattr(user, 'pk', None)}
    return {'mode': 'roles', 'configured': workflow.status != 'unconfigured', 'status': workflow.status,
        'config_version': workflow.config_version, 'shift_snapshot': workflow.shift_snapshot,
        'actor_snapshot': workflow.actor_snapshot, 'item_areas': workflow.item_areas, 'areas': areas,
        'my_item_ids': [item for item, area in workflow.item_areas.items() if area in owned],
        'aggregate_judgement': request.judgement,
        'can_configure': bool(can_use_admin_inspection_flow(user) and workflow.status == 'unconfigured' and mutable),
        'can_submit': bool(mutable and eligible and request.assigned_to_id == user.pk
                           and workflow.status == 'completed' and request.judgement in {'pass', 'fail'}),
        'mes': {'can_save': False, 'can_finish': False, 'reason': MES_BLOCKED_REASON,
                'executor_identity': 'unverified', 'wj_actor_is_mes_executor': False}}


def _patch(area, workflow, payload):
    if 'measurements' in payload:
        measurements = DraftInspectionSerializer().validate_measurements(payload['measurements'])
        own_ids = {item for item, item_area in workflow.item_areas.items() if item_area == area.area}
        if any(entry['item_id'] not in own_ids for entry in measurements):
            raise PermissionDenied('Only items mapped to your assigned area may be saved.')
        merged = {entry['item_id']: entry for entry in area.measurements}
        merged.update({entry['item_id']: entry for entry in measurements})
        area.measurements = list(merged.values())
    if 'evidence' in payload:
        area.evidence = DraftInspectionSerializer().validate_evidence(payload['evidence'])
    if 'judgement' in payload:
        if payload['judgement'] not in {'', 'pass', 'fail'}:
            raise ValidationError({'judgement': 'Use pass, fail or an empty draft judgement.'})
        area.judgement = payload['judgement']


def _complete_validate(request, workflow, area):
    # Reuse the existing numeric bounds, choices and evidence rules for a scoped
    # unsaved projection. Quantity belongs to the whole request, never one area.
    from copy import copy
    scoped = copy(request)
    scoped.inspection_items = [item for item in request.inspection_items if workflow.item_areas[item['id']] == area.area]
    scoped.measurements, scoped.evidence = area.measurements, area.evidence
    scoped.judgement, scoped.judgement_policy = area.judgement, 'strict_items'
    scoped.quantity_mode = 'not_recorded'
    scoped.inspected_quantity = scoped.accepted_quantity = scoped.rejected_quantity = 0
    validate_result(scoped, submit=True)
    failures = any(entry.get('judgement') == 'fail' for entry in area.measurements if entry.get('value', '').strip())
    if area.judgement != ('fail' if failures else 'pass'):
        raise ValidationError({'judgement': 'Area judgement must match its own item results.'})


def _aggregate(request, workflow):
    areas = list(workflow.areas.order_by('area'))
    measurements, evidence = {}, []
    for area in areas:
        for entry in area.measurements:
            if workflow.item_areas.get(entry['item_id']) != area.area:
                _conflict('role_item_mapping_invalid', 'Resolve the item mapping without overwriting results.')
            measurements[entry['item_id']] = entry
        for entry in area.evidence:
            if entry not in evidence:
                evidence.append(entry)
    request.measurements = [measurements[item['id']] for item in request.inspection_items if item['id'] in measurements]
    request.evidence = evidence
    completed = len(areas) == 2 and all(area.status == 'complete' for area in areas)
    failed = any(area.status == 'complete' and area.judgement == 'fail' for area in areas)
    request.judgement = 'fail' if failed else 'pass' if completed and all(area.judgement == 'pass' for area in areas) else ''
    workflow.status = 'completed' if completed else 'in_progress'
    workflow.save(update_fields=['status', 'updated_at'])
    request.version += 1
    request.save(update_fields=['measurements', 'evidence', 'judgement', 'version', 'updated_at'])


def _area_action(user, request_id, area_name, key, payload, action, *, session):
    if area_name not in AREAS:
        raise ValidationError({'area': 'Use appearance or dimension.'})
    allowed = {'area_version', 'config_version', 'reason'} | ({'measurements', 'evidence', 'judgement'} if action != 'reopen' else set())
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValidationError('Unknown or server-controlled area fields.')
    reason = payload.get('reason', '')
    if not isinstance(reason, str) or len(reason) > 500 or (action == 'reopen' and not reason.strip()):
        raise ValidationError({'reason': 'An explicit reopen reason is required, up to 500 characters.'})
    with _actor_transaction(user, session, permission='submit' if action == 'complete' else 'manage') as user:
        _lock(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        workflow = _workflow(request, lock=True)
        area = InspectionAreaResult.objects.select_for_update().get(workflow=workflow, area=area_name)
        _area_access(user, workflow, area)
        scope = f'{user.pk}:{request_id}:role-{area_name}-{action}'
        previous, key = _operation(scope, key, payload, request=request)
        if previous:
            return previous.response, previous.response_status
        _mutable(request)
        if type(payload.get('config_version')) is not int or payload['config_version'] != workflow.config_version:
            _conflict('stale_config_version', 'Reload the assignment configuration and preserve your draft.')
        if type(payload.get('area_version')) is not int or payload['area_version'] != area.version:
            _conflict('stale_area_version', 'This area changed. Keep your draft and explicitly reload its current result.')
        if action == 'reopen':
            if area.status != 'complete':
                _conflict('area_not_complete', 'Only a completed area needs reopening.')
            area.status, area.judgement = 'draft', ''
            area.completed_by, area.completed_by_name, area.completed_at = None, '', None
        else:
            if area.status != 'draft':
                _conflict('area_reopen_required', 'Explicitly reopen your completed area before editing.')
            _patch(area, workflow, payload)
            if action == 'complete':
                _complete_validate(request, workflow, area)
                area.status = 'complete'
                area.completed_by, area.completed_by_name, area.completed_at = user, user.get_username(), timezone.now()
        area.version += 1
        area.save()
        _aggregate(request, workflow)
        _audit(request, user, f'role_{area_name}_{action}', reason)
        return _finish(scope, key, payload, _response(request, user), request=request)


def area_save(user, request_id, area, key, payload, *, session):
    return _area_action(user, request_id, area, key, payload, 'save', session=session)


def area_complete(user, request_id, area, key, payload, *, session):
    return _area_action(user, request_id, area, key, payload, 'complete', session=session)


def area_reopen(user, request_id, area, key, payload, *, session):
    return _area_action(user, request_id, area, key, payload, 'reopen', session=session)
