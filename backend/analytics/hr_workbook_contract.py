"""Company payroll intake: explicit roster, source coordinates and bounded batches."""
import re
import unicodedata

from rest_framework import serializers

from .hr_company_structure import COMPANY_DEPARTMENTS
from .hr_contract import AmountField, StrictSerializer, validate_month


def identity(value):
    return re.sub(r'\s+', '', unicodedata.normalize('NFC', value))


def code_key(value):
    return str(int(value)) if re.fullmatch(r'[0-9]+', value) else value


class ReferenceRowSerializer(StrictSerializer):
    code = serializers.CharField(max_length=64, required=False, allow_blank=True)
    name = serializers.CharField(max_length=100)
    employment_type = serializers.ChoiceField(choices=['contract', 'hourly'])
    source_department = serializers.CharField(max_length=100, allow_blank=True)
    source_function = serializers.CharField(max_length=100, allow_blank=True)
    source_row = serializers.IntegerField(min_value=1, max_value=5100)
    department_id = serializers.ChoiceField(choices=[item['id'] for item in COMPANY_DEPARTMENTS], required=False, allow_null=True)


class ReferenceSerializer(StrictSerializer):
    filename = serializers.CharField(max_length=255)
    rows = ReferenceRowSerializer(many=True, allow_empty=False, max_length=5000)
    fingerprint = serializers.RegexField(r'^[a-f0-9]{64}$', required=False)

    def validate_rows(self, rows):
        names, codes, coordinates = set(), set(), set()
        for row in rows:
            key = (identity(row['name']), row['employment_type'])
            code = code_key(row['code']) if row.get('code') else None
            if key in names or (code and code in codes) or row['source_row'] in coordinates:
                raise serializers.ValidationError('분류표에 중복된 직원 또는 원본 행이 있습니다. 이름·고용형태와 사번을 확인해 주세요.')
            names.add(key)
            if code:
                codes.add(code)
            coordinates.add(row['source_row'])
        return rows


class SourceSerializer(StrictSerializer):
    id = serializers.CharField(max_length=255)
    filename = serializers.CharField(max_length=255)
    employment_type = serializers.ChoiceField(choices=['contract', 'hourly'])


class SaveReferenceSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=0, max_value=2147483647)
    reference = ReferenceSerializer()


class PayrollRowSerializer(StrictSerializer):
    code = serializers.CharField(max_length=64)
    name = serializers.CharField(max_length=100)
    title = serializers.CharField(max_length=100, allow_blank=True, default='')
    amount = AmountField()
    period = serializers.CharField(max_length=7)
    source_department = serializers.CharField(max_length=100, allow_blank=True, default='')
    employment_type = serializers.ChoiceField(choices=['contract', 'hourly'])
    source_file = serializers.CharField(max_length=255)
    source_sheet = serializers.CharField(max_length=100)
    source_row = serializers.IntegerField(min_value=1, max_value=5100)
    original_code = serializers.CharField(max_length=500, allow_blank=True)


class MonthSerializer(StrictSerializer):
    month = serializers.CharField(max_length=7)
    rows = PayrollRowSerializer(many=True, allow_empty=False, max_length=5000)

    def validate_month(self, value):
        return validate_month(value)


class WorkbookBatchSerializer(StrictSerializer):
    classification = ReferenceSerializer(required=False)
    classification_version = serializers.IntegerField(min_value=1, max_value=2147483647, required=False)
    files = SourceSerializer(many=True, allow_empty=False, max_length=10)
    months = MonthSerializer(many=True, allow_empty=False, max_length=24)
    assignment_policy = serializers.ChoiceField(choices=['preserve', 'reference'])

    def validate(self, data):
        if ('classification' in data) == ('classification_version' in data):
            raise serializers.ValidationError('저장한 기본 분류 버전 또는 분류표 중 하나를 지정해 주세요.')
        files = {item['id']: item for item in data['files']}
        months = [item['month'] for item in data['months']]
        if len(files) != len(data['files']) or len(set(months)) != len(months):
            raise serializers.ValidationError('파일 또는 급여 월이 중복되었습니다.')
        if sum(len(item['rows']) for item in data['months']) > 25000:
            raise serializers.ValidationError('한 번에 25,000행까지 저장할 수 있습니다.')
        identities, coordinates = {}, set()
        for month in data['months']:
            codes = set()
            for row in month['rows']:
                key = code_key(row['code'])
                name = identity(row['name'])
                source = files.get(row['source_file'])
                coordinate = (row['source_file'], row['source_sheet'], row['source_row'])
                if row['period'] != month['month'] or not source or source['employment_type'] != row['employment_type']:
                    raise serializers.ValidationError('급여 월 또는 원본 파일의 고용형태가 일치하지 않습니다.')
                if key in codes or coordinate in coordinates:
                    raise serializers.ValidationError('같은 월의 사번 또는 원본 행이 중복되었습니다.')
                if key in identities and identities[key] != name:
                    raise serializers.ValidationError('같은 사번의 직원 정보가 월별로 다릅니다. 원본 사번을 확인해 주세요.')
                codes.add(key)
                coordinates.add(coordinate)
                identities[key] = name
        return data


class ConfirmationSerializer(StrictSerializer):
    month = serializers.CharField(max_length=7)
    version = serializers.IntegerField(min_value=0, max_value=2147483647)
    expected_total = serializers.RegexField(r'^\d{1,13}\.\d{2}$', allow_null=True)
    fingerprint = serializers.RegexField(r'^[a-f0-9]{64}$')


class WorkbookCommitSerializer(WorkbookBatchSerializer):
    preview_token = serializers.RegexField(r'^[a-f0-9]{64}$')
    confirmations = ConfirmationSerializer(many=True, allow_empty=False, max_length=24)

    def validate(self, data):
        data = super().validate(data)
        confirmations = [item['month'] for item in data['confirmations']]
        if len(confirmations) != len(set(confirmations)) or set(confirmations) != {item['month'] for item in data['months']}:
            raise serializers.ValidationError('미리보기의 모든 월을 확인해 주세요.')
        return data
