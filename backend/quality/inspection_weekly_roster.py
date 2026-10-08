"""Weekly display-name declarations. No accounts, grants, tokens or MES calls."""
from datetime import date, datetime, time, timedelta
import unicodedata
from zoneinfo import ZoneInfo

from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

from .inspection_access import can_access_inspections, can_use_admin_inspection_flow
from .inspection_role_models import InspectionInspector, InspectionShiftSetting, InspectionWeeklyRoster
from .inspection_roles import _actor_transaction, _admin, _conflict, _finish, _lock, _operation, _setting_data, _setting_validate

SLOTS = (('DAY', 'dimension'), ('DAY', 'appearance'), ('NIGHT', 'dimension'), ('NIGHT', 'appearance'))
ZONE = ZoneInfo('Asia/Shanghai')


def _week(value=None):
    if value is None:
        today = timezone.now().astimezone(ZONE).date()
        return today - timedelta(days=today.weekday())
    try:
        if type(value) is not str:
            raise ValueError()
        result = date.fromisoformat(value)
        if result.isoformat() != value or result.weekday() != 0 or result.year > 9998:
            raise ValueError()
        return result
    except (ValueError, OverflowError):
        raise ValidationError({'week_start': 'Select a Monday using YYYY-MM-DD.'}) from None


def _text(value, field, limit, *, optional=False):
    if type(value) is not str:
        raise ValidationError({field: 'Use a display name, not an account object.'})
    text = ' '.join(unicodedata.normalize('NFKC', value).split())
    if (not text and not optional) or len(text) > limit or any(unicodedata.category(c).startswith('C') for c in text):
        raise ValidationError({field: f'Use a readable name of up to {limit} characters.'})
    return text, text.casefold()


def weekly_settings(user, week_start=None):
    if not can_access_inspections(user):
        raise PermissionDenied('Current inspection access is required.')
    start = _week(week_start)
    admin = bool(can_use_admin_inspection_flow(user) and user.has_perm('quality.manage_inspectionrequest'))
    # GET never initializes a week or enumerates people to a restricted actor.
    week = InspectionWeeklyRoster.objects.select_related('day_setting', 'night_setting').filter(week_start=start).first() if admin else None
    settings = {'DAY': week.day_setting, 'NIGHT': week.night_setting} if week else {}
    return {'week_start': start.isoformat(), 'week_end': (start + timedelta(days=6)).isoformat(),
        'version': week.version if week else 0, 'can_configure': admin,
        'roster': [{'id': row.pk, 'display_name': row.display_name, 'distinguishing_note': row.distinguishing_note,
            'active': True} for row in InspectionInspector.objects.all()] if admin else [],
        'slots': [{'shift': shift, 'area': area, 'inspector_id': getattr(settings.get(shift), area + '_person_id', None)} for shift, area in SLOTS],
        'settings': [_setting_data(settings[shift]) for shift in ('DAY', 'NIGHT') if shift in settings]}


def _slots(payload):
    if type(payload) is not dict or set(payload) != {'week_start', 'version', 'slots'}:
        raise ValidationError('Use a week, version and exactly four declared slots.')
    start = _week(payload['week_start'])
    if type(payload['version']) is not int or payload['version'] < 0:
        raise ValidationError({'version': 'Use the current saved week version.'})
    rows = payload['slots']
    if type(rows) is not list or len(rows) != 4:
        raise ValidationError({'slots': 'Provide each of the four shift/area slots once.'})
    result = {}
    for row in rows:
        if type(row) is not dict or (row.get('shift'), row.get('area')) not in SLOTS:
            raise ValidationError({'slots': 'Use DAY/NIGHT and dimension/appearance.'})
        slot = (row['shift'], row['area'])
        if slot in result:
            raise ValidationError({'slots': 'Duplicate shift/area slot.'})
        if 'inspector_id' in row:
            if set(row) != {'shift', 'area', 'inspector_id'}:
                raise ValidationError({'slots': 'Select a saved inspector or enter a name.'})
            person_id = row['inspector_id']
            if person_id is not None and (type(person_id) is not int or not 0 < person_id < 2**63):
                raise ValidationError({'inspector_id': 'Select an existing saved display name.'})
            result[slot] = person_id
        else:
            if set(row) - {'shift', 'area', 'display_name', 'distinguishing_note'}:
                raise ValidationError({'slots': 'Unknown or account-controlled fields.'})
            name, normalized = _text(row.get('display_name'), 'display_name', 128)
            note, normalized_note = _text(row.get('distinguishing_note', ''), 'distinguishing_note', 64, optional=True)
            result[slot] = (name, normalized, note, normalized_note)
    return start, result


def save_weekly_settings(user, key, payload, *, session):
    start, slots = _slots(payload)
    scope = f'{user.pk}:role-week:{start.isoformat()}'
    with _actor_transaction(user, session) as user:
        _admin(user)
        # Same global lock as legacy activation and immutable request capture.
        _lock('inspection-role:shift-settings')
        previous, key = _operation(scope, key, payload)
        if previous:
            return previous.response, previous.response_status
        week = InspectionWeeklyRoster.objects.select_for_update().filter(week_start=start).first()
        if payload['version'] != (week.version if week else 0):
            _conflict('stale_week_version', 'Keep the four-card draft and explicitly reload the current week.')
        people = {}
        for slot, value in slots.items():
            if isinstance(value, tuple):
                name, normalized, note, normalized_note = value
                person, _ = InspectionInspector.objects.get_or_create(normalized_name=normalized,
                    normalized_note=normalized_note, defaults={'display_name': name, 'distinguishing_note': note, 'creator': user})
            else:
                person = InspectionInspector.objects.filter(pk=value).first() if value is not None else None
                if value is not None and person is None:
                    raise ValidationError({'inspector_id': 'The saved display name no longer exists.'})
            people[slot] = person
        for shift in ('DAY', 'NIGHT'):
            left, right = people[(shift, 'dimension')], people[(shift, 'appearance')]
            if left is not None and right is not None and left.pk == right.pk:
                raise ValidationError({'slots': 'Dimension and appearance need distinct declared people within a shift.'})
        rows = {'DAY': week.day_setting, 'NIGHT': week.night_setting} if week else {}
        # Temporarily inactive only inside this transaction, so the pair can be
        # validated atomically; any conflict rolls back names and both rows.
        if rows:
            InspectionShiftSetting.objects.filter(pk__in=[r.pk for r in rows.values()]).update(active=False)
        end = datetime.combine(start + timedelta(days=7), time(8), tzinfo=ZONE)
        for shift, begin, finish in (('DAY', time(8), time(20)), ('NIGHT', time(20), time(8))):
            row = rows.get(shift) or InspectionShiftSetting(code=f'WK_{start.strftime("%Y%m%d")}_{shift}', creator=user)
            row.label = f'{start.isoformat()} {shift}'
            row.timezone, row.starts_at, row.ends_at = 'Asia/Shanghai', begin, finish
            row.effective_from, row.effective_until = datetime.combine(start, begin, tzinfo=ZONE), end
            row.appearance_assignee = row.dimension_assignee = None
            row.appearance_person, row.dimension_person = people[(shift, 'appearance')], people[(shift, 'dimension')]
            row.active = row.appearance_person is not None and row.dimension_person is not None
            if row.pk:
                row.version += 1
            _setting_validate(row)
            row.save()
            rows[shift] = row
        if week:
            week.version += 1
            week.updated_by = user
            week.save(update_fields=['version', 'updated_by', 'updated_at'])
        else:
            week = InspectionWeeklyRoster.objects.create(week_start=start, day_setting=rows['DAY'], night_setting=rows['NIGHT'],
                creator=user, updated_by=user)
        response = weekly_settings(user, start.isoformat())
        response['actor_id'] = user.pk
        return _finish(scope, key, payload, response)
