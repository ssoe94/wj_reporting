"""Atomic WJ area results, with no MES transport or credential operations."""
from contextlib import contextmanager
from datetime import date, datetime, time, timedelta, timezone as dt_timezone
import re
from zoneinfo import ZoneInfo

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from .inspection_access import can_access_inspections, can_use_admin_inspection_flow
from .inspection_models import InspectionOperation, InspectionRequest, InspectionMesBinding
from .inspection_role_models import InspectionShiftSetting, InspectionRoleWorkflow, InspectionAreaResult, InspectionInspector
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
def _actor_transaction(user, session, *, permission='manage', participant_id=None):
    # Every mutation rechecks the verified login family, actor and permissions.
    if not user or not getattr(user, 'is_authenticated', False) or not user.pk:
        raise PermissionDenied('An authenticated inspection actor is required.')
    if session is None:
        raise PermissionDenied('A verified current inspection login is required.')
    with transaction.atomic():
        if participant_id is not None:
            # Direct authors lock their own user before the request. A terminal
            # must lock both identities first in a stable order to avoid taking
            # an inspector lock after a request already held by that inspector.
            # Preliminary NO KEY UPDATE locks still protect user state, while
            # allowing another operation's foreign-key KEY SHARE check to
            # finish before we can acquire that operation's login actor.
            list(get_user_model().objects.select_for_update(no_key=True).filter(
                pk__in={user.pk, participant_id}).order_by('pk'))
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
    zone = ZoneInfo(setting.timezone)
    def effective(field, *, local=False):
        value = getattr(setting, field)
        if value is None:
            return None
        if local:
            return value.astimezone(zone).replace(tzinfo=None).isoformat(timespec='minutes')
        return value.astimezone(dt_timezone.utc).isoformat()
    return {'id': setting.pk, 'code': setting.code, 'label': setting.label,
        'timezone': setting.timezone, 'start_time': setting.starts_at.isoformat() if setting.starts_at else None,
        'end_time': setting.ends_at.isoformat() if setting.ends_at else None,
        'appearance_assignee': setting.appearance_assignee_id,
        'dimension_assignee': setting.dimension_assignee_id,
        'appearance_person_id': setting.appearance_person_id,
        'dimension_person_id': setting.dimension_person_id,
        'appearance_assignee_name': setting.appearance_person.display_name if setting.appearance_person_id else _human_name(setting.appearance_assignee) if setting.appearance_assignee_id else '',
        'dimension_assignee_name': setting.dimension_person.display_name if setting.dimension_person_id else _human_name(setting.dimension_assignee) if setting.dimension_assignee_id else '',
        'active': setting.active,
        'version': setting.version, 'effective_from': effective('effective_from'),
        'effective_until': effective('effective_until'),
        'effective_from_local': effective('effective_from', local=True),
        'effective_until_local': effective('effective_until', local=True)}


def _mapped_mes_user(actor_id):
    # This only validates the already configured actor->MES id mapping. It does
    # not read credentials, invoke the provider, or assert executor authority.
    from mes_oauth.vault import expected_user, VaultBlocked
    try:
        return str(expected_user(actor_id))
    except VaultBlocked:
        return None


def _human_name(user):
    return user.get_full_name() or user.get_username()


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
                    'name': actor.get_full_name() or actor.get_username(),
                    'mes_user_id': _mapped_mes_user(actor.pk)})
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


def _effective_local(value, field, zone_name):
    if value is None or value == '':
        return None
    try:
        if (not isinstance(value, str) or not re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}', value)):
            raise ValueError()
        naive = datetime.fromisoformat(value)
        if naive.year == 9999:
            raise ValueError()
        zone = ZoneInfo(zone_name)
        local = naive.replace(tzinfo=zone)
        utc = local.astimezone(dt_timezone.utc)
        if utc.astimezone(zone).replace(tzinfo=None) != naive:
            raise ValueError()
        # Reject ambiguous historical local clock times rather than selecting
        # one occurrence without an explicit user decision.
        second = naive.replace(tzinfo=zone, fold=1)
        if (local.utcoffset() != second.utcoffset()
                and second.astimezone(dt_timezone.utc).astimezone(zone).replace(tzinfo=None) == naive):
            raise ValueError()
        return utc
    except (ValueError, OverflowError):
        raise ValidationError({field: 'Use an unambiguous local datetime YYYY-MM-DDTHH:mm in Asia/Shanghai.'}) from None


def _effective_validate(setting, *, active):
    start, end = setting.effective_from, setting.effective_until
    if start is not None and timezone.is_naive(start) or end is not None and timezone.is_naive(end):
        raise ValidationError('Effective datetimes must include their server-interpreted timezone.')
    if start is not None and end is not None and end <= start:
        raise ValidationError({'effective_until_local': 'The end must be later than the start.'})
    if not active:
        return
    if start is None:
        raise ValidationError({'effective_from_local': 'Explicitly select the first effective shift start.'})
    zone = ZoneInfo(setting.timezone)
    if start.astimezone(zone).time() != setting.starts_at:
        raise ValidationError({'effective_from_local': 'The effective start must match the shift start clock time.'})
    if end is not None and end.astimezone(zone).time() not in {setting.starts_at, setting.ends_at}:
        raise ValidationError({'effective_until_local': 'The effective end must match a shift start or end boundary.'})


def _active_window_overlap(left, right):
    """Intersect half-open validity ranges with recurring local clock windows."""
    lower = max(left.effective_from, right.effective_from)
    endings = [value for value in (left.effective_until, right.effective_until) if value is not None]
    upper = min(endings) if endings else None
    if upper is not None and upper <= lower:
        return False
    clock_segments = [(max(a, c), min(b, d))
        for a, b in _intervals(left.starts_at, left.ends_at)
        for c, d in _intervals(right.starts_at, right.ends_at) if max(a, c) < min(b, d)]
    if not clock_segments:
        return False
    zone = ZoneInfo(left.timezone)
    local_day = lower.astimezone(zone).date()
    midnight = datetime.combine(local_day, time(), tzinfo=zone)
    for start, end in clock_segments:
        window_start = midnight + timedelta(seconds=start)
        window_end = midnight + timedelta(seconds=end)
        if window_end <= lower:
            window_start += timedelta(days=1)
            window_end += timedelta(days=1)
        if max(window_start, lower) < (min(window_end, upper) if upper is not None else window_end):
            return True
    return False


def _setting_validate(setting):
    if (not isinstance(setting.code, str) or not re.fullmatch(r'[A-Za-z0-9_-]{1,64}', setting.code)
            or not isinstance(setting.label, str) or not setting.label.strip() or len(setting.label) > 128):
        raise ValidationError('Provide a stable shift code and a label of up to 128 characters.')
    setting.label = setting.label.strip()
    if setting.timezone != 'Asia/Shanghai':
        raise ValidationError({'timezone': 'Inspection shifts use the factory timezone Asia/Shanghai.'})
    if type(setting.active) is not bool:
        raise ValidationError({'active': 'Use a boolean.'})
    if ((setting.appearance_person_id or setting.dimension_person_id)
            and (setting.appearance_assignee_id or setting.dimension_assignee_id)):
        raise ValidationError('A display-name roster cannot also claim WJ account assignments.')
    for field in ('appearance_assignee', 'dimension_assignee'):
        actor_id = getattr(setting, field + '_id')
        if actor_id is not None:
            if type(actor_id) is not int or not 1 <= actor_id <= 9223372036854775807:
                raise ValidationError({field: 'Select an existing eligible account.'})
            actor = get_user_model().objects.filter(pk=actor_id, is_active=True).first()
            if not actor or not _eligible(actor):
                raise ValidationError({field: 'The account must already have inspection access and input/submit permissions.'})
    _effective_validate(setting, active=False)
    if not setting.active:
        return
    people = (setting.appearance_person_id, setting.dimension_person_id)
    actors = (setting.appearance_assignee_id, setting.dimension_assignee_id)
    valid_pair = (all(people) and people[0] != people[1] and InspectionInspector.objects.filter(pk__in=people).count() == 2
                  or all(actors) and actors[0] != actors[1])
    if (not setting.starts_at or not setting.ends_at or setting.starts_at == setting.ends_at or not valid_pair):
        raise ValidationError('Activation requires explicit times and two distinct eligible inspectors.')
    _effective_validate(setting, active=True)
    for other in InspectionShiftSetting.objects.filter(active=True).exclude(pk=setting.pk):
        if (not other.starts_at or not other.ends_at or other.timezone != setting.timezone
                or other.effective_from is None):
            _conflict('shift_schedule_ambiguous', 'Resolve the existing active shift schedule before activating this shift.')
        if _active_window_overlap(setting, other):
            _conflict('shift_overlap', 'Active inspection shifts must not overlap within their effective periods.')


def _setting_payload(setting, payload, *, create):
    editable = {'code', 'label', 'timezone', 'start_time', 'end_time',
                'appearance_assignee', 'dimension_assignee', 'active',
                'effective_from_local', 'effective_until_local'}
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
        if field in {'effective_from_local', 'effective_until_local'}:
            continue
        if field in {'start_time', 'end_time'}:
            setattr(setting, 'starts_at' if field == 'start_time' else 'ends_at', _time(value, field))
        elif field.endswith('_assignee'):
            setattr(setting, field + '_id', value)
        else:
            setattr(setting, field, value)
    if setting.timezone != 'Asia/Shanghai':
        raise ValidationError({'timezone': 'Inspection shifts use the factory timezone Asia/Shanghai.'})
    for field in ('effective_from_local', 'effective_until_local'):
        if field in payload:
            setattr(setting, field.removesuffix('_local'), _effective_local(payload[field], field, setting.timezone))
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
        from .inspection_role_models import InspectionWeeklyRoster
        from django.db.models import Q
        if InspectionWeeklyRoster.objects.filter(Q(day_setting=setting) | Q(night_setting=setting)).exists():
            _conflict('weekly_setting_managed', 'Change this shift through its four-card weekly setting.')
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


def _terminal_access(user, workflow):
    return bool(_eligible(user) and can_use_admin_inspection_flow(user)
                and workflow.shared_terminal_operator_id == user.pk)


def _area_access(user, workflow, area, *, inspector_id=None, inspector_person_id=None):
    if workflow.status == 'unconfigured' or not _eligible(user):
        raise PermissionDenied('A configured assignment and current inspection authority are required.')
    if area.assigned_person_id is not None:
        if (area.assigned_to_id is not None or inspector_id is not None
                or not _terminal_access(user, workflow) or inspector_person_id != area.assigned_person_id):
            raise PermissionDenied('The configured terminal must name the declared display inspector for this area.')
        return area.assigned_person
    if inspector_person_id is not None:
        raise PermissionDenied('A display name cannot impersonate an assigned account.')
    if area.assigned_to_id == user.pk:
        if inspector_id is not None and inspector_id != user.pk:
            raise PermissionDenied('Select the inspector assigned to this area.')
        return user
    # A terminal entry records a declared inspector separately from its verified
    # login actor. It never changes the session or claims a colleague's identity.
    if not _terminal_access(user, workflow) or inspector_id != area.assigned_to_id:
        raise PermissionDenied('Only the assigned inspector or explicitly configured terminal operator may change this area.')
    inspector = get_user_model().objects.select_for_update().filter(pk=inspector_id, is_active=True).first()
    if not inspector or not _eligible(inspector):
        raise PermissionDenied('The assigned inspector must retain current inspection authority.')
    return inspector


def configure_role_workflow(user, request_id, key, payload, *, session):
    allowed = {'config_version', 'shift_setting_id', 'shift_version', 'shift_date', 'item_areas', 'reason', 'shared_terminal'}
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValidationError('Unknown or server-controlled assignment fields.')
    if 'shared_terminal' in payload and type(payload['shared_terminal']) is not bool:
        raise ValidationError({'shared_terminal': 'Use an explicit boolean.'})
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
        if (window_start < shift.effective_from
                or shift.effective_until is not None and window_end > shift.effective_until):
            raise ValidationError({'shift_date': 'The whole declared shift must fall inside the setting effective period.'})
        mapping = payload.get('item_areas')
        item_ids = {item['id'] for item in request.inspection_items}
        if (not isinstance(mapping, dict) or set(mapping) != item_ids
                or any(value not in AREAS for value in mapping.values()) or set(mapping.values()) != set(AREAS)):
            raise ValidationError({'item_areas': 'Explicitly map every item, with at least one item in each area.'})
        display_people = shift.appearance_person_id is not None or shift.dimension_person_id is not None
        if display_people and payload.get('shared_terminal') is not True:
            raise ValidationError({'shared_terminal': 'Display-name inspectors require an explicitly configured authenticated terminal.'})
        actors = {area: getattr(shift, area + ('_person' if display_people else '_assignee')) for area in AREAS}
        workflow.shift_setting = shift
        workflow.shift_snapshot = _setting_data(shift)
        workflow.shift_snapshot.update(shift_date=shift_date.isoformat(),
            window_start=window_start.isoformat(), window_end=window_end.isoformat(),
            basis='explicit_declaration')
        workflow.actor_snapshot = ({area: {'id': actor.pk, 'name': actor.display_name,
            'kind': 'display_inspector', 'wj_actor_id': None, 'distinguishing_note': actor.distinguishing_note}
            for area, actor in actors.items()} if display_people else
            {area: {'id': actor.pk, 'name': _human_name(actor), 'username': actor.get_username()} for area, actor in actors.items()})
        if 'shared_terminal' in payload:
            workflow.shared_terminal_operator = user if payload['shared_terminal'] else None
            workflow.shared_terminal_operator_name = _human_name(user)[:150] if payload['shared_terminal'] else ''
        workflow.item_areas = mapping
        workflow.config_version += 1
        workflow.status = 'in_progress'
        workflow.save()
        for area in workflow.areas.select_for_update().all():
            actor = actors[area.area]
            area.assigned_person, area.assigned_to = (actor, None) if display_people else (None, actor)
            area.assigned_to_name = actor.display_name if display_people else _human_name(actor)[:150]
            area.version += 1
            area.save()
        request.version += 1
        request.save(update_fields=['version', 'updated_at'])
        _audit(request, user, 'role_configure', reason)
        return _finish(scope, key, payload, _response(request, user), request=request)


def _audit(request, user, action, reason=''):
    from .inspection_workflow import audit
    audit(request, user, action, reason)


def is_area_contributor(request, user):
    """Declared inspectors and authenticated recorders need independent review."""
    from django.db.models import Q
    return bool(InspectionAreaResult.objects.filter(workflow__request=request).filter(
        Q(completed_by_id=user.pk) | Q(completed_recorded_by_id=user.pk)).exists()
        or request.audit.filter(actor_id=user.pk, action__in=[
            f'role_{area}_{action}' for area in AREAS for action in ('save', 'complete', 'reopen')]).exists())


def role_summary(request, user):
    workflow = InspectionRoleWorkflow.objects.filter(request=request).first()
    if not workflow:
        return None
    areas = []
    mutable = _is_mutable(request)
    eligible = _eligible(user)
    terminal = _terminal_access(user, workflow)
    for row in workflow.areas.order_by('area'):
        assigned_eligible = (row.assigned_person_id is not None and row.assigned_to_id is None
                             or row.assigned_to is not None and _eligible(row.assigned_to))
        owner = eligible and (row.assigned_to_id == user.pk or terminal and assigned_eligible) and workflow.status != 'unconfigured' and mutable
        areas.append({'area': row.area, 'assigned_to': row.assigned_to_id,
            'assigned_person_id': row.assigned_person_id,
            'assigned_to_name': row.assigned_to_name, 'version': row.version, 'status': row.status,
            'judgement': row.judgement, 'measurements': row.measurements, 'evidence': row.evidence,
            'item_authorship': row.item_authorship,
            'completed_by': row.completed_by_id, 'completed_by_name': row.completed_by_name,
            'completed_person_id': row.completed_person_id,
            'completed_recorded_by': row.completed_recorded_by_id,
            'completed_recorded_by_name': row.completed_recorded_by_name,
            'completed_at': row.completed_at.isoformat() if row.completed_at else None,
            'can_save': bool(owner and row.status == 'draft'), 'can_complete': bool(owner and row.status == 'draft'),
            'can_reopen': bool(owner and row.status == 'complete'), 'mes_status': row.mes_status,
            'mes_blocked_reason': row.mes_blocked_reason})
    owned = {row['area'] for row in areas if row['assigned_to'] == getattr(user, 'pk', None)
             or terminal and (row['can_save'] or row['can_reopen'])}
    return {'mode': 'roles', 'configured': workflow.status != 'unconfigured', 'status': workflow.status,
        'config_version': workflow.config_version, 'shift_snapshot': workflow.shift_snapshot,
        'shared_terminal': {'enabled': workflow.shared_terminal_operator_id is not None,
            'operator_id': workflow.shared_terminal_operator_id,
            'operator_name': workflow.shared_terminal_operator_name, 'can_operate': bool(terminal and mutable)},
        'actor_snapshot': workflow.actor_snapshot, 'item_areas': workflow.item_areas, 'areas': areas,
        'my_item_ids': [item for item, area in workflow.item_areas.items() if area in owned],
        'aggregate_judgement': request.judgement,
        'can_configure': bool(can_use_admin_inspection_flow(user) and workflow.status == 'unconfigured' and mutable),
        'can_submit': bool(mutable and eligible and request.assigned_to_id == user.pk
                           and workflow.status == 'completed' and request.judgement in {'pass', 'fail'}),
        'mes': {'can_save': False, 'can_finish': False, 'reason': MES_BLOCKED_REASON,
                'executor_identity': 'unverified', 'wj_actor_is_mes_executor': False}}


def _patch(area, workflow, payload, *, inspector, recorded_by):
    if 'measurements' in payload:
        measurements = DraftInspectionSerializer().validate_measurements(payload['measurements'])
        own_ids = {item for item, item_area in workflow.item_areas.items() if item_area == area.area}
        if any(entry['item_id'] not in own_ids for entry in measurements):
            raise PermissionDenied('Only items mapped to your assigned area may be saved.')
        merged = {entry['item_id']: entry for entry in area.measurements}
        merged.update({entry['item_id']: entry for entry in measurements})
        area.measurements = list(merged.values())
        authorship = dict(area.item_authorship)
        stamp = {'inspector_id': inspector.pk, 'inspector_name': area.assigned_to_name,
            'recorded_by_id': recorded_by.pk, 'recorded_by_name': _human_name(recorded_by)[:150],
            'recorded_at': timezone.now().isoformat()}
        if area.assigned_person_id is not None:
            stamp.update(inspector_kind='display_inspector', inspector_wj_id=None)
        authorship.update({entry['item_id']: dict(stamp) for entry in measurements})
        area.item_authorship = authorship
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
    allowed = {'area_version', 'config_version', 'reason', 'inspector_id', 'inspector_person_id'} | ({'measurements', 'evidence', 'judgement'} if action != 'reopen' else set())
    if not isinstance(payload, dict) or set(payload) - allowed:
        raise ValidationError('Unknown or server-controlled area fields.')
    if 'inspector_id' in payload and (type(payload['inspector_id']) is not int or not 1 <= payload['inspector_id'] <= 9223372036854775807):
        raise ValidationError({'inspector_id': 'Select the existing inspector assigned to this area.'})
    if ('inspector_id' in payload and 'inspector_person_id' in payload
            or 'inspector_person_id' in payload and (type(payload['inspector_person_id']) is not int or not 0 < payload['inspector_person_id'] < 2**63)):
        raise ValidationError({'inspector_person_id': 'Use one explicit display-inspector identity.'})
    reason = payload.get('reason', '')
    if not isinstance(reason, str) or len(reason) > 500 or (action == 'reopen' and not reason.strip()):
        raise ValidationError({'reason': 'An explicit reopen reason is required, up to 500 characters.'})
    with _actor_transaction(user, session, permission='submit' if action == 'complete' else 'manage',
                            participant_id=payload.get('inspector_id')) as user:
        _lock(f'inspection:{request_id}')
        request = InspectionRequest.objects.select_for_update().get(pk=request_id)
        workflow = _workflow(request, lock=True)
        area = InspectionAreaResult.objects.select_for_update().get(workflow=workflow, area=area_name)
        inspector = _area_access(user, workflow, area, inspector_id=payload.get('inspector_id'),
                                 inspector_person_id=payload.get('inspector_person_id'))
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
            area.completed_person = None
            area.completed_recorded_by, area.completed_recorded_by_name = None, ''
        else:
            if area.status != 'draft':
                _conflict('area_reopen_required', 'Explicitly reopen your completed area before editing.')
            _patch(area, workflow, payload, inspector=inspector, recorded_by=user)
            if action == 'complete':
                _complete_validate(request, workflow, area)
                area.status = 'complete'
                area.completed_person, area.completed_by = (inspector, None) if area.assigned_person_id is not None else (None, inspector)
                area.completed_by_name, area.completed_at = area.assigned_to_name, timezone.now()
                area.completed_recorded_by, area.completed_recorded_by_name = user, _human_name(user)[:150]
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
