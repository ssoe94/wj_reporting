"""Synthetic standards/calendar only, using the isolated HR test settings."""
from copy import deepcopy
from unittest.mock import patch, MagicMock

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from .hr_labor_rules import default_labor_rules
from .hr_labor_service import effective_standard, lock_labor
from .models import (HrAccessGrant, HrLaborStandard, HrLaborCalendar,
                     HrLaborStandardHistory, HrLaborCalendarHistory)


class HrLaborApiTests(TestCase):
    def setUp(self):
        User = get_user_model()
        self.hr = User.objects.create_user('synthetic-labor-hr')
        self.root = User.objects.create_user('synthetic-labor-root', is_superuser=True)
        self.staff = User.objects.create_user('synthetic-labor-staff', is_staff=True)
        self.inactive = User.objects.create_user('synthetic-labor-inactive', is_superuser=True, is_active=False)
        self.grant = HrAccessGrant.objects.create(user=self.hr, enabled=True)
        self.client = APIClient()
        self.client.force_authenticate(self.hr)
        self.standard = '/api/analytics/hr/labor-standards/2026-11/'
        self.calendar = '/api/analytics/hr/labor-calendar/2026-11/'

    def payload(self, version=0):
        return {'version': version, 'reason': 'Synthetic configuration review', 'rules': default_labor_rules()}

    def calendar_data(self, version=0):
        return {'version': version, 'reason': 'Synthetic calendar correction',
                'days': {'2026-11-14': 'adjusted_workday', '2026-11-16': 'public_holiday'}}

    def assert_private(self, response):
        self.assertTrue({'private', 'no-store'} <= set(response['Cache-Control'].split(', ')))

    def test_permission_and_cache_on_both_endpoints(self):
        for user in (self.staff, self.inactive):
            self.client.force_authenticate(user)
            for url, data in ((self.standard, self.payload()), (self.calendar, self.calendar_data())):
                for response in (self.client.get(url), self.client.put(url, data, format='json')):
                    self.assertEqual(response.status_code, 403)
                    self.assert_private(response)
        self.grant.enabled = False
        self.grant.save()
        self.client.force_authenticate(self.hr)
        self.assertEqual(self.client.get(self.standard).status_code, 403)
        self.assertEqual(self.client.get(self.calendar).status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(self.standard).status_code, (401, 403))
        self.assertEqual(HrLaborStandard.objects.count(), 0)
        self.assertEqual(HrLaborCalendar.objects.count(), 0)

    def test_get_defaults_is_read_only_and_retains_missing_and_unconfirmed(self):
        for user in (self.hr, self.root):
            self.client.force_authenticate(user)
            response = self.client.get(self.standard)
            self.assertEqual(response.status_code, 200)
            self.assert_private(response)
            self.assertEqual(response.data['version'], 0)
            self.assertIsNone(response.data['source_month'])
            self.assertEqual(response.data['rules'], default_labor_rules())
            self.assertEqual(response.data['history'], [])
            calendar = self.client.get(self.calendar)
            self.assertEqual(calendar.status_code, 200)
            self.assert_private(calendar)
            self.assertEqual(calendar.data['days'], {})
        self.assertFalse(HrLaborStandard.objects.exists())
        self.assertFalse(HrLaborCalendar.objects.exists())

    def test_standard_edit_versions_reason_and_immutable_actor_snapshots(self):
        first = self.client.put(self.standard, self.payload(), format='json')
        self.assertEqual(first.status_code, 200, first.data)
        self.assert_private(first)
        self.assertEqual(first.data['version'], 1)
        changed = self.payload(1)
        changed['rules']['department_overtime']['管理部'] = '2'
        changed['reason'] = 'Synthetic department hours supplied'
        response = self.client.put(self.standard, changed, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['version'], 2)
        audit = HrLaborStandardHistory.objects.get(version=2)
        self.assertIsNone(audit.before['department_overtime']['管理部'])
        self.assertEqual(audit.after['department_overtime']['管理部'], '2')
        self.assertEqual((audit.actor_id, audit.actor_label, audit.reason),
                         (self.hr.pk, self.hr.username, changed['reason']))
        self.assertEqual([row['version'] for row in response.data['history']], [2, 1])
        self.assertEqual(response.data['history'][0]['actor_label'], self.hr.username)
        self.assertIsNotNone(audit.created_at)
        stale = self.client.put(self.standard, changed, format='json')
        self.assertEqual(stale.status_code, 409)
        self.assert_private(stale)
        self.assertEqual(HrLaborStandardHistory.objects.count(), 2)

    def test_legacy_rule_reads_empty_rest_hours_and_can_be_edited(self):
        data = self.payload(1)
        data['rules'].pop('department_rest_hours')
        record = HrLaborStandard.objects.create(month='2026-11', rules=deepcopy(data['rules']), version=1)
        response = self.client.get(self.standard)
        self.assertEqual(response.data['rules']['department_rest_hours'], {})
        record.refresh_from_db()
        self.assertNotIn('department_rest_hours', record.rules)
        data['rules']['department_rest_hours'] = {'Synthetic team': '1.250', 'Other synthetic team': None}
        response = self.client.put(self.standard, data, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(effective_standard('2026-12')['rules']['department_rest_hours'],
                         {'Synthetic team': '1.25', 'Other synthetic team': None})
        self.assertNotIn('department_rest_hours', record.history.get(version=2).before)

    def test_effective_periods_inherit_without_mutating_previous_and_stop_at_next_start(self):
        self.client.put(self.standard.replace('2026-11', '2026-01'), self.payload(), format='json')
        later = self.payload()
        later['rules']['multipliers']['rest_day'] = '2.5'
        self.client.put(self.standard.replace('2026-11', '2026-07'), later, format='json')
        self.assertEqual(effective_standard('2026-06')['rules']['multipliers']['rest_day'], '2')
        self.assertEqual(effective_standard('2026-07')['rules']['multipliers']['rest_day'], '2.5')
        inherited = self.client.get(self.standard).data
        self.assertEqual((inherited['version'], inherited['source_month'], inherited['source_version']), (0, '2026-07', 1))
        self.assertEqual(inherited['rules']['multipliers']['rest_day'], '2.5')
        self.assertEqual(HrLaborStandard.objects.count(), 2)
        self.assertIsNone(effective_standard('2025-12')['month'])
        self.assertEqual([period['month'] for period in inherited['periods']], ['2026-01', '2026-07'])

    def test_calendar_edits_audited_default_restore_and_conflict(self):
        first = self.client.put(self.calendar, self.calendar_data(), format='json')
        self.assertEqual(first.status_code, 200, first.data)
        self.assertEqual(first.data['version'], 1)
        self.assert_private(first)
        response = self.client.put(self.calendar, {'version': 1, 'reason': 'Synthetic restore defaults', 'days': {}}, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        audit = HrLaborCalendarHistory.objects.get(version=2)
        self.assertEqual(audit.before, self.calendar_data()['days'])
        self.assertEqual(audit.after, {})
        self.assertEqual((audit.actor_id, audit.actor_label), (self.hr.pk, self.hr.username))
        self.assertEqual([row['version'] for row in response.data['history']], [2, 1])
        self.assertEqual(self.client.put(self.calendar, self.calendar_data(1), format='json').status_code, 409)
        self.assertTrue(HrLaborCalendar.objects.exists())

    def test_reason_version_and_extra_fields_are_required_or_rejected(self):
        for url, base in ((self.standard, self.payload()), (self.calendar, self.calendar_data())):
            for missing in ('version', 'reason'):
                data = deepcopy(base)
                data.pop(missing)
                self.assertEqual(self.client.put(url, data, format='json').status_code, 400)
            for extra in ({'reason': '  '}, {'actor': 90099}, {'created_at': '2026-01-01'}, {'version': -1}):
                self.assertEqual(self.client.put(url, base | extra, format='json').status_code, 400)
            self.assertEqual(self.client.delete(url).status_code, 405)
        self.assertFalse(HrLaborStandard.objects.exists())
        self.assertFalse(HrLaborCalendar.objects.exists())

    def test_rules_reject_invalid_nested_types_and_ranges(self):
        cases = [
            ('contract', {'days_per_month': '0', 'hours_per_day': '8'}),
            ('multipliers', {'workday': '1.5', 'rest_day': '-2', 'public_holiday': '3'}),
            ('hourly_premium', {'enabled': 'false', 'confirmed': True}),
            ('department_overtime', {'Synthetic team': '25'}),
            ('department_overtime', {'': '1'}),
            ('department_rest_hours', {'Synthetic team': '24.01'}),
            ('department_rest_hours', {'Synthetic team': '2', ' Synthetic team': '1'}),
            ('department_rest_hours', []),
            ('weekday_excluded_titles', {'titles': ['Synthetic', 'Synthetic'], 'confirmed': True}),
            ('weekday_excluded_titles', {'titles': [''], 'confirmed': True}),
            ('department_hours_include_fixed_overtime', 'unknown'),
        ]
        for field, value in cases:
            data = self.payload()
            data['rules'][field] = value
            with self.subTest(field=field, value=value):
                self.assertEqual(self.client.put(self.standard, data, format='json').status_code, 400)
        for field, value in [('common_amount', '1.005'), ('rule', 'employee_deduction')]:
            data = self.payload()
            data['rules']['contributions']['social_insurance']['base'][field] = value
            self.assertEqual(self.client.put(self.standard, data, format='json').status_code, 400)
        data = self.payload()
        data['rules']['contributions']['social_insurance']['items']['pension']['employer_rate'] = '101'
        self.assertEqual(self.client.put(self.standard, data, format='json').status_code, 400)
        data = self.payload()
        data['rules']['unknown'] = True
        self.assertEqual(self.client.put(self.standard, data, format='json').status_code, 400)
        self.assertFalse(HrLaborStandard.objects.exists())

    def test_calendar_rejects_wrong_month_invalid_date_or_type(self):
        for days in ({'2026-12-01': 'workday'}, {'2026-11-31': 'workday'}, {'20261112': 'workday'},
                     {'2026-11-12': 'guessed_holiday'}, []):
            self.assertEqual(self.client.put(self.calendar, self.calendar_data() | {'days': days}, format='json').status_code, 400)
        for url in (self.calendar, self.standard):
            self.assertEqual(self.client.get(url.replace('2026-11', '2026-13')).status_code, 400)
        self.assertFalse(HrLaborCalendar.objects.exists())

    def test_history_failure_rolls_back_creation_and_update(self):
        for url, data, model, audit in ((self.standard, self.payload(), HrLaborStandard, HrLaborStandardHistory),
                                        (self.calendar, self.calendar_data(), HrLaborCalendar, HrLaborCalendarHistory)):
            with patch.object(audit.objects, 'create', side_effect=RuntimeError('Synthetic audit failure')):
                self.assertEqual(self.client.put(url, data, format='json').status_code, 500)
            self.assertFalse(model.objects.exists())
            self.assertEqual(self.client.put(url, data, format='json').status_code, 200)
            original = deepcopy(model.objects.get())
            changed = deepcopy(data) | {'version': 1}
            field = 'rules' if model == HrLaborStandard else 'days'
            if field == 'rules':
                changed[field]['multipliers']['workday'] = '1.75'
            else:
                changed[field]['2026-11-17'] = 'rest_day'
            with patch.object(audit.objects, 'create', side_effect=RuntimeError('Synthetic audit failure')):
                self.assertEqual(self.client.put(url, changed, format='json').status_code, 500)
            stored = model.objects.get()
            self.assertEqual(stored.version, 1)
            self.assertEqual(getattr(stored, field), getattr(original, field))
            self.assertEqual(audit.objects.count(), 1)

    def test_noop_does_not_increment_or_audit_and_history_is_bounded(self):
        self.client.put(self.standard, self.payload(), format='json')
        noop = self.client.put(self.standard, self.payload(1), format='json')
        self.assertEqual(noop.data['version'], 1)
        for version in range(1, 23):
            data = self.payload(version)
            data['rules']['department_overtime']['Synthetic team'] = str(version)
            response = self.client.put(self.standard, data, format='json')
            self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(len(response.data['history']), 20)
        self.assertEqual([row['version'] for row in response.data['history']], list(range(23, 3, -1)))
        self.assertEqual(HrLaborStandardHistory.objects.count(), 23)

    def test_postgres_lock_keys_are_stable_distinct_and_parameterized(self):
        connection = MagicMock(vendor='postgresql')
        with patch('analytics.hr_labor_service.connection', connection):
            lock_labor('standard')
            lock_labor('standard')
            lock_labor('calendar')
        calls = connection.cursor.return_value.__enter__.return_value.execute.call_args_list
        self.assertEqual(calls[0], calls[1])
        self.assertNotEqual(calls[0], calls[2])
        self.assertEqual(calls[0].args[0], 'SELECT pg_advisory_xact_lock(%s)')
