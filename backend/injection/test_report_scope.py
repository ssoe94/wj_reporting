import csv
from datetime import date
from io import StringIO

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from .models import InjectionReport
from .views import InjectionReportViewSet


class InjectionReportScopeTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='report-scope-test')
        self.factory = APIRequestFactory()
        for day, machine, actual in [(4, 1, 10), (4, 2, 20), (3, 1, 30), (2, 2, 40)]:
            InjectionReport.objects.create(
                date=date(2026, 9, day), machine_no=machine, tonnage='test',
                model='test', section='test', part_no=f'TEST-{machine}',
                plan_qty=100, actual_qty=actual, reported_defect=1, actual_defect=1,
            )

    def request(self, action, params):
        request = self.factory.get('/api/injection/reports/', params)
        force_authenticate(request, user=self.user)
        return InjectionReportViewSet.as_view({'get': action})(request)

    def test_list_summary_and_csv_share_date_and_machine_scope(self):
        params = {'date': '2026-09-04', 'machine_no': '1'}
        response = self.request('list', params)
        self.assertEqual(response.status_code, 200)
        rows = response.data['results'] if isinstance(response.data, dict) else response.data
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['actual_qty'], 10)
        summary = self.request('summary', params)
        self.assertEqual(summary.data['total_count'], 1)
        self.assertEqual(summary.data['total_actual_qty'], 10)
        exported = self.request('export_csv', params)
        csv_rows = list(csv.DictReader(StringIO(exported.content.decode('utf-8-sig'))))
        self.assertEqual(len(csv_rows), 1)
        self.assertEqual(csv_rows[0]['actual_qty'], '10')

    def test_dates_follow_machine_scope_but_remain_a_date_catalog(self):
        response = self.request('dates', {'machine_no': '1', 'date': '2026-09-04'})
        self.assertEqual(response.data, [date(2026, 9, 4), date(2026, 9, 3)])
        all_machines = self.request('summary', {'date': '2026-09-04'})
        self.assertEqual(all_machines.data['total_count'], 2)

    def test_invalid_machine_scope_is_rejected_for_every_read_action(self):
        for machine in ['', '0', '18', '1.0', '01', 'all', '1,2']:
            for action in ['list', 'summary', 'dates', 'export_csv']:
                with self.subTest(machine=machine, action=action):
                    response = self.request(action, {'machine_no': machine})
                    self.assertEqual(response.status_code, 400)
