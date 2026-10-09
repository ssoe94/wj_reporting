"""The initial allocation can be configured before any payroll is uploaded."""
from copy import deepcopy
from unittest.mock import patch
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event
from django.db import close_old_connections, transaction
from django.test import TestCase, TransactionTestCase, skipUnlessDBFeature
from rest_framework.test import APIClient

from . import test_hr_workbooks as intake
from .models import HrClassificationHistory, HrClassificationReference, HrMonthWorkspace, HrWorkspaceHistory

BASE, batch = intake.BASE, intake.batch


class HrReferenceTests(TestCase):
    setUp = intake.HrWorkbookTests.setUp
    preview = intake.HrWorkbookTests.preview
    commit = intake.HrWorkbookTests.commit
    save = intake.HrWorkbookTests.save

    def configure(self, reference=None, version=0):
        return self.client.put(BASE + 'classification-reference/', {
            'version': version, 'reference': reference or batch()['classification'],
        }, format='json')

    def payroll_only(self, version=1):
        data = batch()
        del data['classification']
        data['classification_version'] = version
        return data

    def test_standalone_reference_permissions_read_only_and_audit(self):
        for user in (None, self.staff, self.inactive):
            self.client.force_authenticate(user)
            response = self.configure()
            self.assertIn(response.status_code, (401, 403))
            self.assertIn('no-store', response['Cache-Control'])
        self.client.force_authenticate(self.hr)
        empty = self.client.get(BASE + 'classification-reference/')
        self.assertEqual(empty.data, {'reference': None, 'version': 0, 'updated_at': None})
        self.assertEqual(HrClassificationReference.objects.count(), 0)
        configured = self.configure()
        self.assertEqual(configured.status_code, 200, configured.data)
        self.assertEqual(configured.data['version'], 1)
        self.assertEqual(configured.data['reference']['rows'][0]['department_id'], 'injection')
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)
        history = HrClassificationHistory.objects.get()
        self.assertEqual(history.actor, self.hr)
        self.assertEqual(history.before, {})
        self.assertEqual(history.after, configured.data['reference'])
        self.assertEqual(self.client.get(BASE + 'classification-reference/').data, configured.data)
        self.assertEqual(HrClassificationHistory.objects.count(), 1)

    def test_payroll_only_uses_registered_reference_and_preserves_manual_assignment(self):
        self.configure()
        data = self.payroll_only()
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200, response.data)
        workspace = response.data['workspaces'][0]
        self.assertEqual(workspace['summary']['total'], '30.30')
        self.assertEqual(workspace['source']['classification_version'], 1)
        self.assertEqual(workspace['employees'][1]['department_id'], 'quality-oqc')
        assignments = [{'code': row['code'], 'department_id': 'development-staff'} for row in workspace['employees']]
        response = self.client.patch(BASE + 'workspaces/2026-01/', {
            'version': workspace['version'], 'departments': workspace['departments'], 'assignments': assignments,
        }, format='json')
        self.assertEqual(response.status_code, 200, response.data)
        data['months'] = [data['months'][0]]
        data['months'][0]['rows'][0]['amount'] = '12.00'
        response = self.save(self.commit(data))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(all(row['department_id'] == 'development-staff' for row in response.data['workspaces'][0]['employees']))
        self.assertEqual(HrClassificationReference.objects.get().version, 1)
        self.assertEqual(HrClassificationHistory.objects.count(), 1)

    def test_reference_conflicts_and_preview_staleness_do_not_write_payroll(self):
        self.assertEqual(self.preview(self.payroll_only()).status_code, 409)
        self.configure()
        commit = self.commit(self.payroll_only())
        changed = deepcopy(batch()['classification'])
        changed['rows'][0]['department_id'] = 'development'
        self.assertEqual(self.configure(changed, version=0).status_code, 409)
        self.assertEqual(self.configure(changed, version=1).status_code, 200)
        self.assertEqual(self.save(commit).status_code, 409)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)
        self.assertEqual(HrWorkspaceHistory.objects.count(), 0)
        self.assertEqual(HrClassificationHistory.objects.count(), 2)
        self.assertEqual(self.preview(self.payroll_only(2)).data['months'][0]['rows'][0]['department_id'], 'development')

    def test_reference_changes_do_not_rewrite_saved_months(self):
        self.configure()
        self.save(self.commit(self.payroll_only()))
        original = list(HrMonthWorkspace.objects.values('month', 'version', 'employees', 'source'))
        changed = deepcopy(batch()['classification'])
        changed['rows'][0]['department_id'] = 'development'
        self.configure(changed, version=1)
        self.assertEqual(list(HrMonthWorkspace.objects.values('month', 'version', 'employees', 'source')), original)

    def test_reference_validation_noop_and_history_atomicity(self):
        self.configure()
        current = self.client.get(BASE + 'classification-reference/').data['reference']
        self.assertEqual(self.configure(current, version=1).data['version'], 1)
        self.assertEqual(HrClassificationHistory.objects.count(), 1)
        invalid = deepcopy(current)
        invalid['rows'][0]['department_id'] = 'unknown'
        self.assertEqual(self.configure(invalid, version=1).status_code, 400)
        invalid = deepcopy(current)
        invalid['rows'][0]['actor'] = 'spoofed'
        self.assertEqual(self.configure(invalid, version=1).status_code, 400)
        changed = deepcopy(current)
        changed['rows'][0]['department_id'] = 'development'
        with patch('analytics.hr_reference_service.HrClassificationHistory.objects.create', side_effect=RuntimeError('synthetic failure')):
            self.assertEqual(self.configure(changed, version=1).status_code, 500)
        self.assertEqual(HrClassificationReference.objects.get().version, 1)
        self.assertEqual(HrClassificationReference.objects.get().reference, current)
        ambiguous = self.payroll_only()
        ambiguous['classification'] = current
        self.assertEqual(self.preview(ambiguous).status_code, 400)


@skipUnlessDBFeature('has_select_for_update')
class HrReferenceConcurrencyTests(TransactionTestCase):
    setUp = intake.HrWorkbookTests.setUp

    def test_concurrent_initial_registration_has_one_winner(self):
        barrier = Barrier(2)

        def write():
            close_old_connections()
            try:
                client = APIClient()
                client.force_authenticate(self.hr)
                barrier.wait(timeout=5)
                return client.put(BASE + 'classification-reference/', {
                    'version': 0, 'reference': batch()['classification'],
                }, format='json').status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(write) for _ in range(2)]
            self.assertEqual(sorted(future.result(timeout=10) for future in futures), [200, 409])
        self.assertEqual(HrClassificationReference.objects.count(), 1)
        self.assertEqual(HrClassificationHistory.objects.count(), 1)

    def test_reference_update_serializes_before_pending_payroll_commit(self):
        from .hr_reference_service import lock_reference, save_reference
        from .hr_workbook_service import build_preview
        save_reference({'version': 0, 'reference': batch()['classification']}, self.hr)
        data = batch()
        del data['classification']
        data['classification_version'] = 1
        preview = build_preview(data)
        commit = {**data, 'preview_token': preview['preview_token'], 'confirmations': [
            {'month': item['month'], 'version': item['version'], 'expected_total': item['total'], 'fingerprint': item['fingerprint']}
            for item in preview['months']
        ]}
        entered = Event()

        def import_payroll():
            close_old_connections()
            try:
                client = APIClient()
                client.force_authenticate(self.hr)
                entered.set()
                return client.post(BASE + 'workbook-import/', commit, format='json').status_code
            finally:
                close_old_connections()

        with ThreadPoolExecutor(max_workers=1) as executor:
            with transaction.atomic():
                lock_reference()
                future = executor.submit(import_payroll)
                self.assertTrue(entered.wait(timeout=5))
                changed = deepcopy(batch()['classification'])
                changed['rows'][0]['department_id'] = 'development'
                save_reference({'version': 1, 'reference': changed}, self.hr)
            self.assertEqual(future.result(timeout=10), 409)
        self.assertEqual(HrMonthWorkspace.objects.count(), 0)
