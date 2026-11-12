"""HR-only roster. Historical payroll retains each month's reviewed source code."""
from collections import defaultdict

from django.db import connection, IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers

from .hr_contract import HrConflict, StrictSerializer
from .hr_workbook_contract import code_key, identity
from .models import HrMonthWorkspace, HrRosterCodeHistory, HrRosterEmployee


class RosterUpdateSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=1)
    status = serializers.ChoiceField(choices=['active', 'departed'], required=False)
    code = serializers.CharField(max_length=64, required=False)
    reason = serializers.CharField(max_length=500, required=False)

    def validate(self, data):
        if 'code' not in data and 'status' not in data:
            raise serializers.ValidationError('변경할 항목을 선택해 주세요.')
        if 'reason' not in data:
            raise serializers.ValidationError('명부 변경 사유를 입력해 주세요.')
        return data


def lock_roster():
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [0x574A4852524F5354])


def person_key(name, employment_type):
    return identity(name), employment_type


def codes_for(employee):
    return list(dict.fromkeys(
        code for item in employee.code_history.all()
        for code in (item.previous_code, item.new_code)
        if code_key(code) != code_key(employee.code)
    ))


def indexes():
    employees = list(HrRosterEmployee.objects.prefetch_related('code_history'))
    people = {person_key(item.name, item.employment_type): item for item in employees}
    owners = {code_key(code): person_key(item.name, item.employment_type)
              for item in employees for code in [item.code, *codes_for(item)]}
    return people, owners


def roster_payload(month):
    rows = HrMonthWorkspace.objects.filter(month=month).values_list('employees', flat=True).first() or []
    present = {code_key(row['code']): row for row in rows}
    result = []
    for item in HrRosterEmployee.objects.prefetch_related('code_history'):
        previous = codes_for(item)
        keys = [code_key(code) for code in [item.code, *previous]]
        in_month = any(key in present and identity(present[key]['name']) == identity(item.name) for key in keys)
        result.append({field: getattr(item, field) for field in (
            'id', 'code', 'name', 'employment_type', 'department', 'status', 'first_month', 'last_month', 'version'
        )} | {'previous_codes': previous, 'in_month': in_month})
    return {'employees': result}


def record_change(item, previous, new, reason, actor, *, new_status=None,
                  previous_employment_type=None, new_employment_type=None,
                  previous_department=None, new_department=None):
    HrRosterCodeHistory.objects.create(
        employee=item, previous_code=previous, new_code=new,
        previous_status=item.status, new_status=new_status if new_status is not None else item.status,
        previous_employment_type=previous_employment_type if previous_employment_type is not None else item.employment_type,
        new_employment_type=new_employment_type if new_employment_type is not None else item.employment_type,
        previous_department=previous_department if previous_department is not None else item.department,
        new_department=new_department if new_department is not None else item.department,
        reason=reason, actor=actor, actor_label=(actor.get_full_name() or actor.username)[:200],
    )


def update_employee(item, changes):
    # QuerySet.update bypasses Model.save; recompute keys for this CAS path too.
    try:
        with transaction.atomic():
            updated = HrRosterEmployee.objects.filter(pk=item.pk, version=item.version).update(
                **changes, normalized_name=identity(item.name),
                normalized_code=code_key(changes.get('code', item.code)), version=item.version + 1,
            )
    except IntegrityError as error:
        raise HrConflict('직원 명부의 이름·고용형태 또는 사번이 중복됩니다. 최신 명부를 확인해 주세요.') from error
    if updated != 1:
        raise HrConflict()


def check_owner(owners, code, key):
    if code_key(code) in owners and owners[code_key(code)][0] != key[0]:
        raise serializers.ValidationError('직원 명부에서 다른 직원에게 등록된 사번입니다.')


@transaction.atomic
def edit_roster(employee_id, data, actor):
    lock_roster()
    item = get_object_or_404(HrRosterEmployee, pk=employee_id)
    if item.version != data['version']:
        raise HrConflict()
    _, owners = indexes()
    new_code = data.get('code', item.code)
    status = data.get('status', item.status)
    check_owner(owners, new_code, person_key(item.name, item.employment_type))
    if (new_code, status) == (item.code, item.status):
        return
    update_employee(item, {'code': new_code, 'status': status})
    record_change(item, item.code, new_code, data['reason'], actor, new_status=status)


def plan_roster(data):
    people, owners = indexes()
    # Join employment identities only with exact code AND name evidence. Names
    # alone never join a contract employee to a different hourly employee.
    aliases = {}

    def canonical(key):
        aliases.setdefault(key, key)
        if aliases[key] != key:
            aliases[key] = canonical(aliases[key])
        return aliases[key]

    sightings = dict(owners)
    for month in data['months']:
        for row in month['rows']:
            key = person_key(row['name'], row['employment_type'])
            check_owner(sightings, row['code'], key)
            owner = sightings.setdefault(code_key(row['code']), key)
            aliases[canonical(key)] = canonical(owner)
    linked_people = {}
    for key, item in people.items():
        target = canonical(key)
        if target in linked_people:
            raise HrConflict('서로 다른 기존 직원 명부를 자동으로 합칠 수 없습니다. 사번을 확인해 주세요.')
        linked_people[target] = item
    people = linked_people
    grouped = defaultdict(list)
    for month in data['months']:
        for row in month['rows']:
            key = canonical(person_key(row['name'], row['employment_type']))
            check_owner(owners, row['code'], key)
            grouped[key].append(row)
    decisions = {}
    for decision in data.get('roster_decisions', []):
        key = canonical(person_key(decision['name'], decision['employment_type']))
        if key in decisions or key not in grouped:
            raise serializers.ValidationError('사번 확인 항목이 중복되었거나 선택 월에 없습니다.')
        existing = people.get(key)
        if decision['version'] != (existing.version if existing else 0):
            raise HrConflict()
        if len({row['period'] for row in grouped[key]}) != len(grouped[key]):
            raise serializers.ValidationError('같은 달에 동일 이름의 여러 행을 한 직원으로 연결할 수 없습니다.')
        observed = {code_key(row['code']) for row in grouped[key]}
        if existing:
            observed.update(code_key(code) for code in [existing.code, *codes_for(existing)])
        latest = max(grouped[key], key=lambda row: row['period'])
        types = {row['employment_type'] for row in grouped[key]}
        if existing:
            types.add(existing.employment_type)
        if (len(observed) < 2 and len(types) < 2) or code_key(decision['code']) not in observed:
            raise serializers.ValidationError('원본에서 확인된 사번을 선택해 주세요.')
        if decision['employment_type'] != latest['employment_type']:
            raise serializers.ValidationError('선택한 최신 월의 고용형태를 확인해 주세요.')
        check_owner(owners, decision['code'], key)
        decisions[key] = decision
    return people, owners, grouped, decisions, {key: canonical(key) for key in aliases}


def sync_roster(plan, actor):
    people, _, grouped, decisions, _ = plan
    for key, rows in grouped.items():
        item = people.get(key)
        decision = decisions.get(key)
        known = {code_key(code) for code in [item.code, *codes_for(item)]} if item else set()
        observed = {code_key(row['code']): row['code'] for row in rows}
        original_first = min(rows, key=lambda row: row['period'])
        latest = max(rows, key=lambda row: row['period'])
        if not decision:
            if not item and len(observed) > 1:
                continue
            if item:
                if latest['period'] >= item.last_month and latest['employment_type'] != item.employment_type:
                    continue
                rows = [row for row in rows if code_key(row['code']) in known and row['employment_type'] == item.employment_type]
            else:
                # An unconfirmed first upload establishes only the original
                # employment period, not a second employee for the later type.
                rows = [row for row in rows if row['employment_type'] == original_first['employment_type']]
            if not rows:
                continue
        first = min(row['period'] for row in rows)
        latest = max(rows, key=lambda row: row['period'])
        chosen = decision['code'] if decision else item.code if item else latest['code']
        if item:
            changes = {
                'code': chosen, 'first_month': min(item.first_month, first),
                'last_month': max(item.last_month, latest['period']),
                'department': latest['source_department'] if latest['period'] >= item.last_month else item.department,
                'employment_type': latest['employment_type'] if decision and latest['period'] >= item.last_month else item.employment_type,
            }
            if any(getattr(item, field) != value for field, value in changes.items()) or decision:
                update_employee(item, changes)
        else:
            try:
                with transaction.atomic():
                    item = HrRosterEmployee.objects.create(
                        code=chosen, name=latest['name'], employment_type=latest['employment_type'],
                        department=latest['source_department'], first_month=first, last_month=latest['period'],
                    )
            except IntegrityError as error:
                raise HrConflict('직원 명부의 이름·고용형태 또는 사번이 중복됩니다. 최신 명부를 확인해 주세요.') from error
        if decision:
            new_type = changes['employment_type'] if key in people else item.employment_type
            new_department = changes['department'] if key in people else item.department
            previous_type = item.employment_type if key in people else original_first['employment_type']
            previous_department = item.department if key in people else original_first['source_department']
            snapshots = {'previous_employment_type': previous_type, 'new_employment_type': new_type,
                         'previous_department': previous_department, 'new_department': new_department}
            if item.code != chosen or previous_type != new_type:
                record_change(item, item.code, chosen, decision['reason'], actor, **snapshots)
            for old_key, old in observed.items():
                if old_key != code_key(chosen) and old_key not in known:
                    record_change(item, old, chosen, decision['reason'], actor, **snapshots)
