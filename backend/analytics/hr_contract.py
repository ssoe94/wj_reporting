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
    amount = AmountField()


class ImportSerializer(StrictSerializer):
    rows = ImportRowSerializer(many=True, allow_empty=False, max_length=MAX_EMPLOYEES)
    currency = serializers.ChoiceField(choices=['CNY', 'KRW', 'USD'])
    cost_basis = serializers.ChoiceField(choices=['employer_total', 'gross_salary', 'custom'])
    cost_basis_label = serializers.CharField(max_length=100, allow_blank=True, required=False, default='')
    source_filename = serializers.CharField(max_length=255)

    def validate(self, attrs):
        codes = [row['code'] for row in attrs['rows']]
        if len(codes) != len(set(codes)):
            raise serializers.ValidationError({'rows': '사번이 중복되었습니다. 직원별 한 행만 올려 주세요.'})
        if attrs['cost_basis'] == 'custom' and not attrs['cost_basis_label']:
            raise serializers.ValidationError({'cost_basis_label': '선택한 인건비 항목의 이름을 입력해 주세요.'})
        return attrs


class SaveImportSerializer(ImportSerializer):
    version = serializers.IntegerField(min_value=0, max_value=2147483647)
    expected_total = serializers.DecimalField(max_digits=16, decimal_places=2, min_value=Decimal('0'))


class DepartmentSerializer(StrictSerializer):
    id = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$')
    name = serializers.CharField(max_length=100)
    parent_id = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$', allow_null=True)
    function = serializers.CharField(max_length=500, allow_blank=True)


class AssignmentSerializer(StrictSerializer):
    code = serializers.CharField(max_length=64)
    department_id = serializers.RegexField(r'^[A-Za-z0-9_-]{1,64}$', allow_null=True)


def validate_departments(departments):
    by_id = {department['id']: department for department in departments}
    if len(by_id) != len(departments):
        raise serializers.ValidationError({'departments': '부서 ID가 중복되었습니다.'})
    for department in departments:
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
    fingerprint = hashlib.sha256(json.dumps(normalized, sort_keys=True, ensure_ascii=False).encode('utf-8')).hexdigest()
    return {
        'rows': data['rows'], 'row_count': len(data['rows']),
        'total': money(sum((Decimal(row['amount']) for row in data['rows']), Decimal(0))),
        'fingerprint': fingerprint,
    }


def summarize(departments, employees):
    zero = Decimal(0)
    totals = {department['id']: {'direct_total': zero, 'total': zero, 'direct_count': 0, 'headcount': 0} for department in departments}
    by_id = {department['id']: department for department in departments}
    total = sum((Decimal(employee['amount']) for employee in employees), zero)
    unassigned = zero
    unassigned_count = 0
    for employee in employees:
        amount = Decimal(employee['amount'])
        department_id = employee['department_id']
        if department_id is None:
            unassigned += amount
            unassigned_count += 1
            continue
        totals[department_id]['direct_total'] += amount
        totals[department_id]['direct_count'] += 1
        while department_id is not None:
            totals[department_id]['total'] += amount
            totals[department_id]['headcount'] += 1
            department_id = by_id[department_id]['parent_id']
    return {
        'total': money(total), 'assigned_total': money(total - unassigned), 'unassigned_total': money(unassigned),
        'employee_count': len(employees), 'assigned_count': len(employees) - unassigned_count, 'unassigned_count': unassigned_count,
        'departments': [{
            'id': department['id'], **{key: money(value) if 'total' in key else value for key, value in totals[department['id']].items()},
            'share': money(totals[department['id']]['total'] / total * 100) if total else '0.00',
        } for department in departments],
    }
