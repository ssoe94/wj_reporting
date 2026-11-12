"""Strict, bounded rule edits. Missing inputs remain JSON null."""
from datetime import date
from decimal import Decimal
import re

from rest_framework import serializers

from .hr_contract import StrictSerializer, validate_month
from .hr_labor_rules import DAY_TYPES, SOCIAL_ITEMS, default_labor_rules


def _invalid(field):
    raise serializers.ValidationError({field: '기준 항목·형식·허용 범위를 확인해 주세요.'})


def _keys(value, keys, field):
    if not isinstance(value, dict) or set(value) != set(keys):
        _invalid(field)


def _bool(value, field, nullable=False):
    if (nullable and value is None) or type(value) is bool:
        return value
    _invalid(field)


def _decimal(value, field, maximum, *, nullable=False, positive=False, places=4):
    if value is None and nullable:
        return None
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        _invalid(field)
    if not re.fullmatch(r'\d{1,9}(?:\.\d{1,' + str(places) + r'})?', str(value)):
        _invalid(field)
    number = Decimal(value)
    if number > Decimal(str(maximum)) or (positive and number == 0):
        _invalid(field)
    return format(number.normalize(), 'f')


def validate_rules(data):
    defaults = default_labor_rules()
    _keys(data, defaults, 'rules')
    result = {}
    _keys(data['multipliers'], defaults['multipliers'], 'multipliers')
    result['multipliers'] = {key: _decimal(value, 'multipliers', 10) for key, value in data['multipliers'].items()}
    _keys(data['contract'], defaults['contract'], 'contract')
    result['contract'] = {key: _decimal(data['contract'][key], 'contract', limit, positive=True)
                          for key, limit in [('days_per_month', 31), ('hours_per_day', 24)]}
    _keys(data['hourly_premium'], ('enabled', 'confirmed'), 'hourly_premium')
    result['hourly_premium'] = {key: _bool(value, 'hourly_premium') for key, value in data['hourly_premium'].items()}
    departments = data['department_overtime']
    if not isinstance(departments, dict) or len(departments) > 200:
        _invalid('department_overtime')
    result['department_overtime'] = {}
    for label, hours in departments.items():
        if not isinstance(label, str) or not label.strip() or len(label) > 100 or label.strip() in result['department_overtime']:
            _invalid('department_overtime')
        result['department_overtime'][label.strip()] = _decimal(hours, 'department_overtime', 24, nullable=True)
    excluded = data['weekday_excluded_titles']
    _keys(excluded, ('titles', 'confirmed'), 'weekday_excluded_titles')
    titles = excluded['titles']
    if not isinstance(titles, list) or len(titles) > 200 or any(not isinstance(item, str) or not item.strip() or len(item) > 100 for item in titles):
        _invalid('weekday_excluded_titles')
    titles = [item.strip() for item in titles]
    if len(set(titles)) != len(titles):
        _invalid('weekday_excluded_titles')
    result['weekday_excluded_titles'] = {'titles': titles, 'confirmed': _bool(excluded['confirmed'], 'weekday_excluded_titles')}
    result['department_hours_include_fixed_overtime'] = _bool(data['department_hours_include_fixed_overtime'], 'department_hours_include_fixed_overtime', nullable=True)
    hourly = data['hourly_rates']
    _keys(hourly, ('company_default', 'employee_overrides'), 'hourly_rates')
    _keys(hourly['company_default'], ('amount', 'confirmed'), 'hourly_rates')
    company = hourly['company_default']
    overrides = hourly['employee_overrides']
    if not isinstance(overrides, list) or len(overrides) > 5000:
        _invalid('hourly_rates')
    result['hourly_rates'] = {'company_default': {
        'amount': _decimal(company['amount'], 'hourly_rates', '999999999.99', nullable=True, places=2),
        'confirmed': _bool(company['confirmed'], 'hourly_rates')}, 'employee_overrides': []}
    identities, referenced = set(), set()
    for item in overrides:
        _keys(item, ('employee_id', 'effective_month', 'amount', 'reason'), 'hourly_rates')
        employee_id = item['employee_id']
        if type(employee_id) is not int or not 0 < employee_id <= 9223372036854775807:
            _invalid('employee_id')
        validate_month(item['effective_month'])
        key = (employee_id, item['effective_month'])
        if key in identities or not isinstance(item['reason'], str) or not item['reason'].strip() or len(item['reason']) > 500:
            _invalid('hourly_rates')
        identities.add(key)
        referenced.add(employee_id)
        result['hourly_rates']['employee_overrides'].append({**item, 'reason': item['reason'].strip(),
            'amount': _decimal(item['amount'], 'hourly_rates', '999999999.99', places=2)})
    contributions = data['contributions']
    _keys(contributions, ('social_insurance', 'housing_fund'), 'contributions')
    result['contributions'] = {}
    for kind, config in contributions.items():
        _keys(config, ('applies_to', 'base', 'items'), kind)
        _keys(config['applies_to'], ('contract', 'hourly'), kind)
        base = config['base']
        _keys(base, ('rule', 'common_amount', 'employee_amounts', 'lower', 'upper'), kind)
        if base['rule'] not in (None, 'common', 'employee', 'gross'):
            _invalid(kind)
        clean_base = {'rule': base['rule'], 'employee_amounts': {}}
        for field in ('common_amount', 'lower', 'upper'):
            clean_base[field] = _decimal(base[field], kind, '999999999.99', nullable=True, places=2)
        if clean_base['lower'] is not None and clean_base['upper'] is not None and Decimal(clean_base['lower']) > Decimal(clean_base['upper']):
            _invalid(kind)
        if not isinstance(base['employee_amounts'], dict) or len(base['employee_amounts']) > 5000:
            _invalid(kind)
        for employee_id, amount in base['employee_amounts'].items():
            if not isinstance(employee_id, str) or not re.fullmatch(r'[1-9]\d{0,17}', employee_id):
                _invalid(kind)
            referenced.add(int(employee_id))
            clean_base['employee_amounts'][employee_id] = _decimal(amount, kind, '999999999.99', places=2)
        _keys(config['items'], SOCIAL_ITEMS if kind == 'social_insurance' else ('housing_fund',), kind)
        items = {}
        for item, rates in config['items'].items():
            _keys(rates, ('employer_rate', 'employee_rate'), kind)
            items[item] = {side: _decimal(value, kind, 100, nullable=True) for side, value in rates.items()}
        result['contributions'][kind] = {'applies_to': {key: _bool(value, kind, nullable=True) for key, value in config['applies_to'].items()},
                                        'base': clean_base, 'items': items}
    if referenced:
        from .models import HrRosterEmployee
        if set(HrRosterEmployee.objects.filter(pk__in=referenced).values_list('pk', flat=True)) != referenced:
            _invalid('employee_id')
    return result


class LaborStandardSaveSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(max_length=500)
    rules = serializers.JSONField()

    def validate_rules(self, value):
        return validate_rules(value)


class LaborCalendarSaveSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(max_length=500)
    days = serializers.JSONField()

    def validate_days(self, value):
        if not isinstance(value, dict) or len(value) > 31:
            _invalid('days')
        for day, kind in value.items():
            if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day) or day[:7] != self.context['month']:
                _invalid('days')
            try:
                date.fromisoformat(day)
            except ValueError:
                _invalid('days')
            if kind not in DAY_TYPES:
                _invalid('days')
        return dict(sorted(value.items()))


class LaborActualPaymentSaveSerializer(StrictSerializer):
    version = serializers.IntegerField(min_value=0)
    reason = serializers.CharField(max_length=500)
    amounts = serializers.JSONField()
    evidence_memo = serializers.CharField(max_length=1000, allow_blank=True)

    def validate_amounts(self, value):
        _keys(value, ('social_insurance', 'housing_fund'), 'amounts')
        result = {}
        for kind, amounts in value.items():
            _keys(amounts, ('total', 'contract', 'hourly'), 'amounts')
            parsed = {key: _decimal(amount, 'amounts', '999999999.99', nullable=True, places=2) for key, amount in amounts.items()}
            known = sum((Decimal(parsed[key]) for key in ('contract', 'hourly') if parsed[key] is not None), Decimal(0))
            complete = parsed['contract'] is not None and parsed['hourly'] is not None
            if parsed['total'] is not None and (known > Decimal(parsed['total']) or complete and known != Decimal(parsed['total'])):
                _invalid('amounts')
            if complete and parsed['total'] is None:
                parsed['total'] = _decimal(format(known, 'f'), 'amounts', '999999999.99', places=2)
            result[kind] = parsed
        return result

    def validate(self, data):
        if any(value is not None for amounts in data['amounts'].values() for value in amounts.values()) and not data['evidence_memo'].strip():
            raise serializers.ValidationError({'evidence_memo': '실제 납부액의 근거 메모를 입력해 주세요.'})
        return data
