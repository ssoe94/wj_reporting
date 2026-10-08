"""Final decision after area completion; disposable fixtures, no MES writes."""
import uuid
from django.test import TestCase
from rest_framework.exceptions import PermissionDenied, ValidationError
from .inspection_models import InspectionAudit, InspectionNonconformance
from .inspection_role_models import InspectionAreaResult
from .inspection_roles import area_complete
from .inspection_workflow import local_action, InspectionConflict
from .inspection_validation import SubmitInspectionSerializer, ActionSerializer
from .test_inspection_roles import RoleFixtures
from .test_inspection_requests import inspection_session


class FinalJudgementTests(RoleFixtures, TestCase):
    def final(self, judgement, reason='', key=None):
        return local_action(self.admin, self.request.pk, 'submit', key or uuid.uuid4(),
            {'version': self.request_now().version, 'judgement': judgement, 'reason': reason}, session=inspection_session(self.admin))

    def failed_areas(self):
        self.complete('appearance')
        self.action(area_complete, 'dimension', self.payload('dimension',
            measurements=[self.measure('dimension', value='12', judgement='fail')], judgement='fail'))

    def test_final_decision_waits_for_both_completed_areas(self):
        self.complete('appearance')
        with self.assertRaises(InspectionConflict):
            self.final('pass')
        self.assertEqual(self.request_now().status, 'draft')

    def test_fail_is_explicit_final_decision_and_retains_item_results(self):
        self.complete('appearance'); self.complete('dimension')
        result, _ = self.final('fail')
        self.assertEqual(result['status'], 'failed')
        self.assertEqual(result['judgement'], 'fail')
        self.assertTrue(all(area.judgement == 'pass' for area in InspectionAreaResult.objects.filter(workflow=self.workflow)))
        self.assertTrue(InspectionNonconformance.objects.filter(request=self.request).exists())

    def test_failed_measurement_cannot_be_promoted_to_pass(self):
        self.failed_areas()
        with self.assertRaises(ValidationError):
            self.final('pass')
        self.assertEqual(self.request_now().judgement, 'fail')
        self.assertEqual(self.request_now().status, 'draft')

    def test_concession_requires_grounds_and_preserves_nonconformance(self):
        self.failed_areas()
        with self.assertRaises(ValidationError):
            self.final('concession')
        key = uuid.uuid4(); version = self.request_now().version
        payload = {'version': version, 'judgement': 'concession', 'reason': 'SYNTHETIC customer limit approval'}
        result, _ = local_action(self.admin, self.request.pk, 'submit', key, payload, session=inspection_session(self.admin))
        replay, _ = local_action(self.admin, self.request.pk, 'submit', key, payload, session=inspection_session(self.admin))
        self.assertEqual(result, replay)
        self.assertEqual(result['status'], 'submitted'); self.assertEqual(result['judgement'], 'concession')
        self.assertEqual(result['role_workflow']['aggregate_judgement'], 'concession')
        self.assertEqual(result['measurements'][1]['value'], '12')
        self.assertTrue(InspectionNonconformance.objects.filter(request=self.request).exists())
        self.assertEqual(InspectionAudit.objects.filter(request=self.request, action='submit').count(), 1)
        self.assertEqual(InspectionAudit.objects.get(request=self.request, action='submit').reason, payload['reason'])
        for reviewer in [self.admin, self.dimension, self.appearance]:
            with self.subTest(reviewer=reviewer.username), self.assertRaises(PermissionDenied):
                local_action(reviewer, self.request.pk, 'approve', uuid.uuid4(), {'version': result['version'], 'reason': 'SYNTHETIC review'}, session=inspection_session(reviewer))
        with self.assertRaises(ValidationError):
            local_action(self.outsider, self.request.pk, 'approve', uuid.uuid4(), {'version': result['version']}, session=inspection_session(self.outsider))
        approved, _ = local_action(self.outsider, self.request.pk, 'approve', uuid.uuid4(), {'version': result['version'], 'reason': 'SYNTHETIC independent approval'}, session=inspection_session(self.outsider))
        self.assertEqual(approved['judgement'], 'concession'); self.assertEqual(approved['status'], 'approved')
        self.assertTrue(InspectionNonconformance.objects.filter(request=self.request).exists())
        self.assertEqual(approved['sync_status'], 'not_synced')

    def test_final_serializer_is_scoped_and_old_submit_remains_valid(self):
        for judgement in ['pass', 'fail', 'concession']:
            serializer = SubmitInspectionSerializer(data={'version': 1, 'judgement': judgement})
            self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertTrue(SubmitInspectionSerializer(data={'version': 1}).is_valid())
        self.assertFalse(SubmitInspectionSerializer(data={'version': 1, 'judgement': 'pending'}).is_valid())
        self.assertFalse(SubmitInspectionSerializer(data={'version': 1, 'judgement': 'pass', 'actor': 1}).is_valid())
        self.assertFalse(ActionSerializer(data={'version': 1, 'judgement': 'pass'}).is_valid())
