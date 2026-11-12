"""Strict, bounded rule edits. Missing inputs remain JSON null."""
from datetime import date
from decimal import Decimal
import re

from rest_framework import serializers

from .hr_contract import StrictSerializer
from .hr_labor_rules import DAY_TYPES, default_labor_rules


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
    contributions = data['employer_contributions']
    _keys(contributions, ('social_insurance', 'housing_fund'), 'employer_contributions')
    result['employer_contributions'] = {}
    for kind, types in contributions.items():
        _keys(types, ('contract', 'hourly'), kind)
        result['employer_contributions'][kind] = {}
        for employment, config in types.items():
            _keys(config, ('rate_percent', 'base', 'fixed_amount'), kind)
            if config['base'] not in (None, 'gross', 'fixed'):
                _invalid(kind)
            result['employer_contributions'][kind][employment] = {
                'rate_percent': _decimal(config['rate_percent'], kind, 100, nullable=True),
                'base': config['base'], 'fixed_amount': _decimal(config['fixed_amount'], kind, '999999999.99', nullable=True, places=2),
            }
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
