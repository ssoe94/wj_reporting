"""Bounded inputs and exact Decimal money for monthly personnel allocation."""
import hashlib
import json
import re
from datetime import datetime
from decimal import Decimal

from rest_framework import serializers
from rest_framework.exceptions import APIException

MAX_EMPLOYEES = 5000
MAX_DEPARTMENTS = 200


class HrConflict(APIException):
    status_code = 409
    default_detail = '다른 사용자가 저장했습니다. 현재 초안을 보존하고 최신 자료를 확인해 주세요.'
    default_code = 'hr_version_conflict'


def validate_month(month):
    if not isinstance(month, str) or not re.fullmatch(r'(19|20|21)\d{2}-(0[1-9]|1[0-2])', month):
        raise serializers.ValidationError({'month': 'YYYY-MM 형식의 월을 선택해 주세요.'})
    datetime.strptime(month, '%Y-%m')
    return month


def money(value):
    return format(Decimal(value).quantize(Decimal('.01')), '.2f')


class StrictSerializer(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict):
            raise serializers.ValidationError('객체 형식이 필요합니다.')
        unknown = set(data) - set(self.fields)
        if unknown:
            raise serializers.ValidationError({'fields': '허용하지 않은 필드가 있습니다.'})
        return super().to_internal_value(data)


class AmountField(serializers.CharField):
    def to_internal_value(self, data):
        if isinstance(data, bool) or not isinstance(data, (str, int)):
            raise serializers.ValidationError('인건비는 소수점 두 자리 이내의 금액 문자열로 입력해 주세요.')
        value = str(data).strip()
        if not re.fullmatch(r'\d{1,9}(\.\d{1,2})?', value):
            raise serializers.ValidationError('0 이상의 금액을 소수점 두 자리 이내로 입력해 주세요.')
        return money(value)


class ImportRowSerializer(StrictSerializer):
    code = serializers.CharField(max_length=64)
    name = serializers.CharField(max_length=100)
    title = serializers.CharField(max_length=100, allow_blank=True, required=False, default='')
    amount = AmountField(allow_null=True)
    period = serializers.CharField(max_length=7, required=False)
    source_department = serializers.CharField(max_length=100, allow_blank=True, required=False, default='')
    department_id = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$', allow_null=True, required=False)

    def validate_period(self, value):
        return validate_month(value)


class ImportSerializer(StrictSerializer):
    rows = ImportRowSerializer(many=True, allow_empty=False, max_length=MAX_EMPLOYEES)
    currency = serializers.ChoiceField(choices=['CNY', 'KRW', 'USD'])
    cost_basis = serializers.ChoiceField(choices=['employer_total', 'gross_salary', 'custom'])
    cost_basis_label = serializers.CharField(max_length=100, allow_blank=True, required=False, default='')
    source_filename = serializers.CharField(max_length=255)
    month = serializers.CharField(max_length=7, required=False)
    apply_classification = serializers.BooleanField(required=False, default=False)
    allow_missing_cost = serializers.BooleanField(required=False, default=False)

    def validate_month(self, value):
        return validate_month(value)

    def validate(self, attrs):
        codes = [row['code'] for row in attrs['rows']]
        if len(codes) != len(set(codes)):
            raise serializers.ValidationError({'rows': '사번이 중복되었습니다. 직원별 한 행만 올려 주세요.'})
        if attrs['cost_basis'] == 'custom' and not attrs['cost_basis_label']:
            raise serializers.ValidationError({'cost_basis_label': '선택한 인건비 항목의 이름을 입력해 주세요.'})
        if any(row['amount'] is None for row in attrs['rows']) and not attrs['allow_missing_cost']:
            raise serializers.ValidationError({'rows': '금액 미입력을 허용하려면 인원 명단 가져오기를 명시적으로 선택해 주세요.'})
        periods = {row['period'] for row in attrs['rows'] if 'period' in row}
        if periods and (not attrs.get('month') or periods != {attrs['month']}):
            raise serializers.ValidationError({'month': '직원별 급여 월과 가져올 월이 일치해야 합니다.'})
        if attrs['apply_classification'] and any('department_id' not in row for row in attrs['rows']):
            raise serializers.ValidationError({'rows': '파일 분류 반영에는 모든 직원의 분류 ID(또는 미분류)가 필요합니다.'})
        if attrs['apply_classification']:
            from .hr_company_structure import COMPANY_DEPARTMENTS
            from .models import HrMonthWorkspace
            known_ids = {node['id'] for node in COMPANY_DEPARTMENTS}
            existing = HrMonthWorkspace.objects.filter(month=attrs.get('month')).first() if attrs.get('month') else None
            if existing:
                known_ids.update(node['id'] for node in existing.departments)
            if any(row['department_id'] is not None and row['department_id'] not in known_ids for row in attrs['rows']):
                raise serializers.ValidationError({'rows': '시각화 분류 ID를 찾을 수 없습니다.'})
        if not attrs['apply_classification'] and any('department_id' in row for row in attrs['rows']):
            raise serializers.ValidationError({'rows': '분류 ID를 반영하려면 파일 분류 반영을 선택해 주세요.'})
        return attrs


class SaveImportSerializer(ImportSerializer):
    version = serializers.IntegerField(min_value=0, max_value=2147483647)
    expected_total = serializers.DecimalField(max_digits=16, decimal_places=2, min_value=Decimal('0'), allow_null=True)


class DepartmentSerializer(StrictSerializer):
    id = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$')
    name = serializers.CharField(max_length=100)
    parent_id = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$', allow_null=True)
    function = serializers.CharField(max_length=500, allow_blank=True)


class AssignmentSerializer(StrictSerializer):
    code = serializers.CharField(max_length=64)
    department_id = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$', allow_null=True)


def validate_departments(departments):
    from .hr_company_structure import COMPANY_DEPARTMENTS
    company_parents = {node['id']: node['parent_id'] for node in COMPANY_DEPARTMENTS}
    by_id = {department['id']: department for department in departments}
    if len(by_id) != len(departments):
        raise serializers.ValidationError({'departments': '부서 ID가 중복되었습니다.'})
    for department in departments:
        if department['id'] in company_parents and department['parent_id'] != company_parents[department['id']]:
            raise serializers.ValidationError({'departments': '회사 고정 분류 박스의 상위 부문은 변경할 수 없습니다. 추가 분류를 별도로 만들어 주세요.'})
        visited = {department['id']}
        parent = department['parent_id']
        while parent is not None:
            if parent not in by_id:
                raise serializers.ValidationError({'departments': '상위 부서를 찾을 수 없습니다.'})
            if parent in visited:
                raise serializers.ValidationError({'departments': '부서 계층이 순환합니다.'})
            visited.add(parent)
            if len(visited) > 8:
                raise serializers.ValidationError({'departments': '부서 계층은 최대 8단계입니다.'})
            parent = by_id[parent]['parent_id']
    return departments


class LayoutSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=0, max_value=2147483647)
    departments = DepartmentSerializer(many=True, max_length=MAX_DEPARTMENTS)
    assignments = AssignmentSerializer(many=True, max_length=MAX_EMPLOYEES)

    def validate_departments(self, value):
        return validate_departments(value)


def preview_payload(data):
    normalized = {key: data[key] for key in ('rows', 'currency', 'cost_basis', 'cost_basis_label')}
    normalized.update({key: data.get(key, False) for key in ('apply_classification', 'allow_missing_cost')})
    normalized['month'] = data.get('month')
    fingerprint = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    missing = sum(row['amount'] is None for row in data['rows'])
    known_total = money(sum((Decimal(row['amount']) for row in data['rows'] if row['amount'] is not None), Decimal(0)))
    return {
        'rows': data['rows'], 'row_count': len(data['rows']),
        'total': None if missing else known_total, 'known_total': known_total,
        'missing_cost_count': missing, 'known_cost_count': len(data['rows']) - missing,
        'fingerprint': fingerprint,
    }


def summarize(departments, employees):
    zero = Decimal(0)
    totals = {department['id']: {'known_direct_total': zero, 'known_total': zero, 'direct_count': 0, 'headcount': 0, 'direct_missing_cost_count': 0, 'missing_cost_count': 0} for department in departments}
    by_id = {department['id']: department for department in departments}
    total = sum((Decimal(employee['amount']) for employee in employees if employee['amount'] is not None), zero)
    missing = sum(employee['amount'] is None for employee in employees)
    unassigned = zero
    unassigned_count = 0
    unassigned_missing = 0
    for employee in employees:
        unknown = employee['amount'] is None
        amount = zero if unknown else Decimal(employee['amount'])
        department_id = employee['department_id']
        if department_id is None:
            unassigned += amount
            unassigned_count += 1
            unassigned_missing += int(unknown)
            continue
        totals[department_id]['known_direct_total'] += amount
        totals[department_id]['direct_count'] += 1
        totals[department_id]['direct_missing_cost_count'] += int(unknown)
        while department_id is not None:
            totals[department_id]['known_total'] += amount
            totals[department_id]['headcount'] += 1
            totals[department_id]['missing_cost_count'] += int(unknown)
            department_id = by_id[department_id]['parent_id']
    return {
        'total': None if missing else money(total), 'known_total': money(total),
        'known_cost_count': len(employees) - missing, 'missing_cost_count': missing, 'cost_complete': missing == 0,
        'assigned_total': None if missing - unassigned_missing else money(total - unassigned),
        'unassigned_total': None if unassigned_missing else money(unassigned),
        'employee_count': len(employees), 'assigned_count': len(employees) - unassigned_count, 'unassigned_count': unassigned_count,
        'departments': [{
            'id': department['id'], **{key: money(value) if 'total' in key else value for key, value in totals[department['id']].items()},
            'direct_total': None if totals[department['id']]['direct_missing_cost_count'] else money(totals[department['id']]['known_direct_total']),
            'total': None if totals[department['id']]['missing_cost_count'] else money(totals[department['id']]['known_total']),
            'share': None if missing else money(totals[department['id']]['known_total'] / total * 100) if total else '0.00',
        } for department in departments],
    }
