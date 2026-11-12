"""Strict inputs for daily HR previews, work sheets, and personnel events."""
from datetime import date
from decimal import Decimal
import re

from rest_framework import serializers

from .hr_contract import AmountField, MAX_EMPLOYEES, StrictSerializer, validate_month


ATTENDANCE = ('present', 'absent', 'personal_leave', 'sick_leave', 'off')
HOURS = ('regular_hours', 'weekday_hours', 'rest_hours', 'holiday_hours',
         'personal_leave_hours', 'sick_leave_hours')
KINDS = ('hire', 'terminate', 'transfer', 'title_change', 'employment_change', 'cancel')
MAX_ID = 2**63 - 1


def validate_day(value):
    if isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        validate_month(value[:7])
        try:
            return date.fromisoformat(value)
        except ValueError:
            pass
    raise serializers.ValidationError({'date': 'YYYY-MM-DD 형식의 유효한 날짜를 선택해 주세요.'})


class HoursField(serializers.Field):
    def to_internal_value(self, value):
        if isinstance(value, bool) or not isinstance(value, (str, int)):
            raise serializers.ValidationError('시간은 0~24의 소수점 네 자리 이내 숫자로 입력해 주세요.')
        value = str(value)
        if not re.fullmatch(r'\d{1,2}(\.\d{1,4})?', value) or Decimal(value) > 24:
            raise serializers.ValidationError('시간은 0~24의 소수점 네 자리 이내 숫자로 입력해 주세요.')
        return format(Decimal(value).normalize(), 'f')


class WorkOverrideSerializer(StrictSerializer):
    attendance = serializers.ChoiceField(ATTENDANCE, required=False)
    regular_hours = HoursField(required=False, allow_null=True)
    weekday_hours = HoursField(required=False, allow_null=True)
    rest_hours = HoursField(required=False, allow_null=True)
    holiday_hours = HoursField(required=False, allow_null=True)
    personal_leave_hours = HoursField(required=False, allow_null=True)
    sick_leave_hours = HoursField(required=False, allow_null=True)


class EmployeeWorkSerializer(StrictSerializer):
    employee_id = serializers.IntegerField(min_value=1, max_value=MAX_ID)
    work = WorkOverrideSerializer()


class DailyPreviewSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=0, max_value=2**31 - 1)
    context = serializers.RegexField(r'^[a-f0-9]{64}$', max_length=64)
    rows = EmployeeWorkSerializer(many=True, max_length=MAX_EMPLOYEES)

    def validate_rows(self, rows):
        if len({row['employee_id'] for row in rows}) != len(rows):
            raise serializers.ValidationError('같은 직원의 근무 입력이 중복되었습니다.')
        return rows


class DailySaveSerializer(DailyPreviewSerializer):
    status = serializers.ChoiceField(('draft', 'confirmed'))
    reason = serializers.CharField(max_length=500, required=False, allow_blank=True, default='')

    def validate(self, data):
        if data['status'] == 'confirmed' and not data['reason']:
            raise serializers.ValidationError({'reason': '확정 사유를 입력해 주세요.'})
        return data


class PersonnelChangesSerializer(StrictSerializer):
    code = serializers.CharField(max_length=64, required=False)
    name = serializers.CharField(max_length=100, required=False)
    employment_type = serializers.ChoiceField(('contract', 'hourly'), required=False)
    department = serializers.CharField(max_length=100, required=False)
    title = serializers.CharField(max_length=100, required=False)
    base_salary = AmountField(required=False, allow_null=True)
    fixed_overtime = AmountField(required=False, allow_null=True)
    hourly_rate = AmountField(required=False, allow_null=True)


class PersonnelEventSerializer(StrictSerializer):
    revision = serializers.IntegerField(min_value=0, max_value=MAX_ID)
    kind = serializers.ChoiceField(KINDS)
    employee_id = serializers.IntegerField(min_value=1, max_value=MAX_ID, required=False)
    target_id = serializers.IntegerField(min_value=1, max_value=MAX_ID, required=False)
    changes = PersonnelChangesSerializer(required=False, default=dict)
    reason = serializers.CharField(max_length=500)

    def validate(self, data):
        kind = data['kind']
        changes = data['changes']
        if ('employee_id' in data) != (kind not in ('hire', 'cancel')):
            raise serializers.ValidationError({'employee_id': '이벤트에 맞는 직원을 선택해 주세요.'})
        if ('target_id' in data) != (kind == 'cancel'):
            raise serializers.ValidationError({'target_id': '취소할 이벤트를 선택해 주세요.'})
        required = {
            'hire': {'code', 'name', 'employment_type', 'department', 'title'},
            'transfer': {'department'},
            'title_change': {'title'},
            'employment_change': {'employment_type'},
            'terminate': set(),
            'cancel': set(),
        }[kind]
        allowed = set(required)
        if kind in ('hire', 'employment_change'):
            if changes.get('employment_type') == 'contract':
                allowed.update(('base_salary', 'fixed_overtime'))
                if kind == 'hire':
                    required.update(('base_salary', 'fixed_overtime'))
            elif changes.get('employment_type') == 'hourly':
                allowed.add('hourly_rate')
        if not required <= changes.keys() or changes.keys() - allowed:
            raise serializers.ValidationError({'changes': '이벤트의 필수 항목과 입력 범위를 확인해 주세요.'})
        if kind == 'hire' and changes['employment_type'] == 'contract' and any(
            changes[field] is None for field in ('base_salary', 'fixed_overtime')
        ):
            raise serializers.ValidationError({'changes': '계약직의 기본급과 고정 연장수당을 입력해 주세요.'})
        return data
