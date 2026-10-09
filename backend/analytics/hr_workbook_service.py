"""Deterministic roster matching and atomic, versioned multi-month payroll saves."""
import hashlib
import json
from copy import deepcopy
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework import serializers

from .hr_company_structure import COMPANY_DEPARTMENTS, ORGANIZATION_NODES
from .hr_contract import money, validate_departments
from .hr_service import check_version, lock_month, persist
from .hr_workbook_contract import code_key, identity
from .hr_reference_service import lock_reference, stored_reference
from .models import HrMonthWorkspace


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


# These are labels from the company's supplied classification list, not guesses
# based on a payroll job title or payroll department.
FUNCTIONS = {
    '品质': {'品质管理': 'quality', '巡检': 'quality-patrol', '进出货检验': 'quality-oqc', 'OQC': 'quality-oqc', 'IQC': 'quality-oqc', 'CS': 'quality-cs'},
    '注塑': {'注塑管理': 'injection', '操作工': 'injection-operator', '换模工': 'injection-mold-change', '5S': 'injection-5s', '加料/入库': 'injection-feeding'},
    '加工': {'加工管理': 'machining', '操作工': 'machining-operator'},
    '营业': {'营业管理': 'sales', '仓库/物理': 'sales-warehouse', '仓库/物流': 'sales-warehouse', 'CS': 'sales-cs', '辅助': 'sales-support'},
    '资材': {'资材管理': 'materials', '原材料': 'materials-raw', '副材料': 'materials-secondary', '副资材': 'materials-secondary', '粉碎': 'materials-crushing'},
    '模具': {'模具/公务管理': 'mold-maintenance', '模具工': 'mold-worker'},
    '公务': {'模具/公务管理': 'mold-maintenance', '公务员工': 'maintenance-worker'},
    '管理部': {'财务': 'admin-finance', '人事总务': 'admin-hr', '人事/总务': 'admin-hr'},
    '开发': {'开发管理': 'development', '开发': 'development-staff', '开发人员': 'development-staff'},
    '总经办': {'董事长': 'board-chairman'},
}


def resolve_reference(reference):
    result = {'filename': reference['filename'], 'rows': deepcopy(reference['rows'])}
    for row in result['rows']:
        if 'department_id' in row:
            continue
        department, function = identity(row['source_department']), identity(row['source_function'])
        target = FUNCTIONS.get(department, {}).get(function)
        if department == '总经办' and function == '总经理':
            # Only the explicit, previously supplied organization chart can
            # disambiguate these two otherwise identical roster categories.
            target = next((node_id + '-gm' for node_id, _, name, _ in ORGANIZATION_NODES
                           if node_id in ('business', 'technical') and identity(name) == identity(row['name'])), None)
        row['department_id'] = target
    result['fingerprint'] = digest(result)
    return result


def company_departments(workspace):
    departments = deepcopy(workspace.departments) if workspace else []
    known = {item['id'] for item in departments}
    departments.extend(deepcopy(item) for item in COMPANY_DEPARTMENTS if item['id'] not in known)
    if len(departments) > 200:
        raise serializers.ValidationError('회사 분류도와 기존 부서의 합계가 200개를 초과합니다.')
    return validate_departments(departments)


def build_preview(data, workspaces=None):
    if workspaces is None:
        workspaces = {workspace.month: workspace for workspace in HrMonthWorkspace.objects.filter(month__in=[item['month'] for item in data['months']])}
    reference = (stored_reference(data['classification_version']) if 'classification_version' in data
                 else resolve_reference(data['classification']))
    by_name = {(identity(row['name']), row['employment_type']): row for row in reference['rows']}
    by_code = {code_key(row['code']): row for row in reference['rows'] if row.get('code')}
    months = []
    for item in sorted(data['months'], key=lambda value: value['month']):
        workspace = workspaces.get(item['month'])
        old_rows = workspace.employees if workspace else []
        previous = {code_key(row['code']): row for row in old_rows}
        if len(previous) != len(old_rows):
            raise serializers.ValidationError('기존 자료에 표시 사번이 중복되어 있습니다. 기존 월 자료를 먼저 확인해 주세요.')
        imported_codes = {code_key(row['code']) for row in item['rows']}
        employment_types = {row['employment_type'] for row in item['rows']}
        retained = [deepcopy(row) for row in old_rows if row.get('employment_type') not in employment_types and code_key(row['code']) not in imported_codes]
        if retained and (workspace.currency != 'CNY' or workspace.cost_basis != 'gross_salary'):
            raise serializers.ValidationError('기존 월의 통화 또는 인건비 기준이 다릅니다. 서로 다른 기준의 금액을 합칠 수 없습니다.')
        rows = []
        for incoming in item['rows']:
            row = deepcopy(incoming)
            key = code_key(row['code'])
            old = previous.get(key)
            if old and identity(old['name']) != identity(row['name']):
                raise serializers.ValidationError('기존 자료와 같은 사번의 직원 정보가 다릅니다. 사번을 확인해 주세요.')
            matched = by_code.get(key) or by_name.get((identity(row['name']), row['employment_type']))
            if matched and (identity(matched['name']) != identity(row['name']) or matched['employment_type'] != row['employment_type'] or (matched.get('code') and code_key(matched['code']) != key)):
                raise serializers.ValidationError('분류표와 임금표의 직원 정보 또는 사번이 다릅니다. 원본을 확인해 주세요.')
            row['department_id'] = old['department_id'] if old and data['assignment_policy'] == 'preserve' else matched['department_id'] if matched else None
            rows.append(row)
        rows.extend(retained)
        if len(rows) > 5000:
            raise serializers.ValidationError('기존 인원을 포함하여 월별 5,000명까지 저장할 수 있습니다.')
        departments = company_departments(workspace)
        known_ids = {department['id'] for department in departments}
        if any(row['department_id'] is not None and row['department_id'] not in known_ids for row in rows):
            raise serializers.ValidationError('존재하지 않는 부서 배치가 있습니다.')
        total = money(sum((Decimal(row['amount']) for row in rows if row['amount'] is not None), Decimal(0)))
        missing = sum(row['amount'] is None for row in rows)
        fingerprint = digest({'month': item['month'], 'rows': rows, 'departments': departments, 'classification': reference, 'files': data['files']})
        months.append({
            'month': item['month'], 'version': workspace.version if workspace else 0,
            'row_count': len(rows), 'total': None if missing else total, 'known_total': total, 'missing_cost_count': missing,
            'imported_count': len(item['rows']), 'retained_count': len(retained),
            'unassigned_count': sum(row['department_id'] is None for row in rows),
            'fingerprint': fingerprint, 'rows': rows,
        })
    return {'classification': reference, 'months': months, 'preview_token': digest({'classification': reference, 'classification_version': data.get('classification_version'), 'months': months, 'assignment_policy': data['assignment_policy']})}


@transaction.atomic
def save_batch(data, user):
    if 'classification_version' in data:
        check_version(lock_reference(), data['classification_version'])
    # Every writer uses the same month locks. Sort before locking to avoid
    # deadlocks between overlapping multi-month batches.
    workspaces = {month: lock_month(month) for month in sorted(item['month'] for item in data['months'])}
    confirmations = {item['month']: item for item in data['confirmations']}
    for month, workspace in workspaces.items():
        check_version(workspace, confirmations[month]['version'])
    preview = build_preview(data, workspaces)
    if preview['preview_token'] != data['preview_token']:
        raise serializers.ValidationError('자료가 미리보기 이후 변경되었습니다. 미리보기를 다시 실행해 주세요.')
    for item in preview['months']:
        confirmation = confirmations[item['month']]
        if item['fingerprint'] != confirmation['fingerprint'] or item['total'] != confirmation['expected_total']:
            raise serializers.ValidationError('월별 미리보기 합계가 일치하지 않습니다.')
    saved = []
    imported_at = timezone.now().isoformat()
    for item in preview['months']:
        workspace = workspaces[item['month']]
        if workspace and workspace.source and workspace.source.get('fingerprint') == item['fingerprint']:
            saved.append(workspace)
            continue
        used_files = {row.get('source_file') for row in item['rows']}
        files = {source['id']: source for source in (workspace.source or {}).get('files', [])} if workspace else {}
        files.update({source['id']: source for source in data['files']})
        source_files = [source for key, source in files.items() if key in used_files]
        source = {
            'filename': ', '.join(dict.fromkeys(source['filename'] for source in source_files)), 'fingerprint': item['fingerprint'],
            'row_count': item['row_count'], 'total': item['total'], 'known_total': item['known_total'], 'missing_cost_count': item['missing_cost_count'],
            'files': source_files,
            'classification': {**preview['classification'], 'imported_at': imported_at},
            'classification_version': data.get('classification_version'),
            'assignment_policy': data['assignment_policy'],
        }
        saved.append(persist(workspace, item['month'], {
            'currency': 'CNY', 'cost_basis': 'gross_salary', 'cost_basis_label': '应发工资',
            'departments': company_departments(workspace), 'employees': item['rows'], 'source': source,
        }, user, 'import'))
    return saved
