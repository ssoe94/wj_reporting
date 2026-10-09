import hashlib
from decimal import Decimal

from django.db import connection, transaction, IntegrityError
from rest_framework import serializers

from .hr_contract import HrConflict, preview_payload, summarize
from .models import HrMonthWorkspace, HrWorkspaceHistory
from .hr_company_structure import COMPANY_DEPARTMENTS, company_catalog


def lock_month(month):
    # Lock even an absent month before taking the snapshot on PostgreSQL.
    if connection.vendor == 'postgresql':
        key = int.from_bytes(hashlib.sha256(('wj-hr-month:' + month).encode()).digest()[:8], 'big', signed=True)
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s)', [key])
    return HrMonthWorkspace.objects.select_for_update().filter(month=month).first()


def snapshot(workspace):
    if workspace is None:
        return {}
    return {key: getattr(workspace, key) for key in ('month', 'currency', 'cost_basis', 'cost_basis_label', 'version', 'departments', 'employees', 'source')}


def workspace_payload(workspace, month=None):
    if workspace is None:
        return {
            'month': month, 'currency': 'CNY', 'cost_basis': 'gross_salary', 'cost_basis_label': '应发工资', 'version': 0,
            'departments': [], 'employees': [], 'source': None, 'summary': summarize([], []), 'updated_at': None, 'history': [], 'company_structure': company_catalog(),
        }
    return {
        **snapshot(workspace), 'summary': summarize(workspace.departments, workspace.employees), 'company_structure': company_catalog(),
        'updated_at': workspace.updated_at.isoformat(),
        'history': [{'version': entry.version, 'action': entry.action, 'actor': entry.actor_label, 'created_at': entry.created_at.isoformat()} for entry in workspace.history.filter(version__lte=workspace.version)[:20]],
    }


def check_version(workspace, version):
    current = workspace.version if workspace else 0
    if current != version:
        raise HrConflict()


def persist(workspace, month, values, user, action):
    before = snapshot(workspace)
    if workspace is None:
        try:
            with transaction.atomic():
                workspace = HrMonthWorkspace.objects.create(month=month, **values, updated_by=user)
        except IntegrityError:
            raise HrConflict()
    else:
        # Compare-and-swap also guards providers where SELECT FOR UPDATE is unsupported.
        from django.utils import timezone
        updated = HrMonthWorkspace.objects.filter(pk=workspace.pk, version=workspace.version).update(
            **values, version=workspace.version + 1, updated_by=user, updated_at=timezone.now(),
        )
        if updated != 1:
            raise HrConflict()
        workspace.refresh_from_db()
    HrWorkspaceHistory.objects.create(
        workspace=workspace, version=workspace.version, action=action, actor=user,
        actor_label=(user.get_full_name() or user.username)[:200], before=before, after=snapshot(workspace),
    )
    return workspace


@transaction.atomic
def save_import(month, data, user):
    workspace = lock_month(month)
    check_version(workspace, data['version'])
    if data.get('month') and data['month'] != month:
        raise serializers.ValidationError({'month': '가져올 급여 월과 저장 대상 월이 다릅니다.'})
    preview = preview_payload(data)
    actual_total = Decimal(preview['total']) if preview['total'] is not None else None
    if actual_total != data['expected_total']:
        raise serializers.ValidationError({'expected_total': '미리보기 합계와 업로드 금액이 다릅니다.'})
    previous = {employee['code']: employee['department_id'] for employee in workspace.employees} if workspace else {}
    apply_classification = data.get('apply_classification', False)
    assignment_matches = not apply_classification or all(previous.get(row['code']) == row['department_id'] for row in preview['rows'])
    if workspace and workspace.source and workspace.source.get('fingerprint') == preview['fingerprint'] and assignment_matches:
        return workspace
    departments = list(workspace.departments) if workspace else []
    if apply_classification:
        known = {department['id'] for department in departments}
        departments.extend(dict(item) for item in COMPANY_DEPARTMENTS if item['id'] not in known)
        if len(departments) > 200:
            raise serializers.ValidationError({'rows': '회사 분류도와 기존 부서의 합계가 200개를 초과합니다.'})
        from .hr_contract import validate_departments
        validate_departments(departments)
        valid_ids = {department['id'] for department in departments}
        if any(row.get('department_id') is not None and row['department_id'] not in valid_ids for row in preview['rows']):
            raise serializers.ValidationError({'rows': '존재하지 않는 시각화 분류 ID입니다.'})
    employees = [{**row, 'department_id': row['department_id'] if apply_classification else previous.get(row['code'])} for row in preview['rows']]
    return persist(workspace, month, {
        'currency': data['currency'], 'cost_basis': data['cost_basis'], 'cost_basis_label': data['cost_basis_label'],
        'departments': departments, 'employees': employees,
        'source': {'filename': data['source_filename'], 'fingerprint': preview['fingerprint'], 'row_count': preview['row_count'], 'total': preview['total'], 'known_total': preview['known_total'], 'missing_cost_count': preview['missing_cost_count']},
    }, user, 'import')


@transaction.atomic
def save_layout(month, data, user):
    workspace = lock_month(month)
    check_version(workspace, data['version'])
    employees = workspace.employees if workspace else []
    by_code = {assignment['code']: assignment['department_id'] for assignment in data['assignments']}
    if len(by_code) != len(data['assignments']) or set(by_code) != {employee['code'] for employee in employees}:
        raise serializers.ValidationError({'assignments': '현재 월의 모든 사번을 중복 없이 배치해 주세요.'})
    department_ids = {department['id'] for department in data['departments']}
    if any(value is not None and value not in department_ids for value in by_code.values()):
        raise serializers.ValidationError({'assignments': '존재하지 않는 부서에 배치할 수 없습니다.'})
    return persist(workspace, month, {
        'departments': data['departments'],
        'employees': [{**employee, 'department_id': by_code[employee['code']]} for employee in employees],
    }, user, 'layout')
