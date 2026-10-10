from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from .models import (ProductionPlan, PlanWorkIdentity, PlanWorkRevision,
                     PlanMaterialApproval, PlanMaterialDefault, PlanMesRequest)
from .plan_bom import MATERIAL_LIST
from .plan_workflow_transport import PlanTransportError
from .test_plan_master_gaps import Reader, master
from .test_plan_workflow import new_plan


class PlanMasterGapViewTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='synthetic-master-viewer')
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.url = '/api/production/plan-workflow/'
        self.scope = {'start': '2026-10-08', 'end': '2026-10-09',
            'plan_type': 'injection', 'action': 'master_gaps'}
        self.plan = new_plan(part='SYNTHETIC-A', part_spec='B/C', actor=self.user)

    def get(self, reader, **params):
        with patch('production.plan_master_gaps.BomReader', return_value=reader) as factory:
            response = self.client.get(self.url, {**self.scope, **params})
        return response, factory

    def database_state(self):
        return {model.__name__: list(model.objects.order_by('pk').values()) for model in (
            ProductionPlan, PlanWorkIdentity, PlanWorkRevision, PlanMaterialApproval,
            PlanMaterialDefault, PlanMesRequest)}

    def test_active_viewer_reads_only_stored_scoped_parts_using_authenticated_actor(self):
        second = new_plan(day=9, part='SYNTHETIC-A', part_spec='B/C完', actor=self.user)
        new_plan(day=10, part='SYNTHETIC-OUTSIDE', actor=self.user)
        new_plan(part='SYNTHETIC-MACHINING', plan_type='machining', actor=self.user)
        reader = Reader([master('SYNTHETIC-A')])
        response, factory = self.get(reader, codes=['UNREQUESTED'], actor_id=999)
        self.assertEqual(response.status_code, 200, response.data)
        factory.assert_called_once_with(self.user.pk)
        self.assertEqual(reader.calls, [(MATERIAL_LIST, {'codes': ['SYNTHETIC-A'], 'queryFieldList': [1, 4]})])
        self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertEqual(len(response.data['rows']), 1)
        row = response.data['rows'][0]
        self.assertEqual([item['plan_id'] for item in row['sources']], [self.plan.pk, second.pk])
        self.assertEqual(row['source_specs'], ['B/C', 'B/C完'])
        self.assertEqual(row['spec_state'], 'source_conflict')
        self.assertIsNone(row['spec_candidate'])

    def test_master_get_executes_no_database_writes_and_keeps_existing_plans_and_audits(self):
        before = self.database_state()
        with CaptureQueriesContext(connection) as queries:
            response, _ = self.get(Reader([master('SYNTHETIC-A')]))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(before, self.database_state())
        self.assertTrue(queries.captured_queries)
        mutations = ('INSERT ', 'UPDATE ', 'DELETE ', 'REPLACE ', 'CREATE ', 'ALTER ', 'DROP ')
        self.assertFalse([entry['sql'] for entry in queries if entry['sql'].lstrip().upper().startswith(mutations)])

    def test_explicit_master_blanks_and_missing_response_rows_are_different_states(self):
        response, _ = self.get(Reader([master('SYNTHETIC-A')]))
        self.assertEqual(response.status_code, 200)
        blank = response.data['rows'][0]
        self.assertEqual((blank['status'], blank['spec_state'], blank['spec_candidate']), ('ok', 'blank_candidate', 'B/C'))
        response, _ = self.get(Reader([]))
        self.assertEqual(response.status_code, 200)
        missing = response.data['rows'][0]
        self.assertEqual((missing['status'], missing['issue']), ('unknown', 'material_not_returned'))
        self.assertEqual(missing['spec_state'], 'unknown')
        self.assertIsNone(missing['mes'])
        self.assertIsNone(missing['spec_candidate'])

    def test_transport_failure_is_502_with_no_comparison_rows_or_database_mutation(self):
        before = self.database_state()
        with patch('production.plan_master_gaps.BomReader', side_effect=PlanTransportError('mes_read_unavailable')):
            response = self.client.get(self.url, self.scope)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.data, {'detail': 'mes_read_unavailable'})
        self.assertNotIn('rows', response.data)
        self.assertEqual(before, self.database_state())

    def test_denied_provider_envelope_is_an_error_not_a_successful_blank_comparison(self):
        for envelope in ({'code': 3500060, 'data': []},
                         {'code': 200, 'data': [], 'fieldPermission': {'noAccess': ['specification']}}):
            with self.subTest(envelope=envelope):
                response, _ = self.get(Reader(response=envelope))
                self.assertEqual(response.status_code, 400)
                self.assertIsInstance(response.data, list)
        self.assertFalse(PlanMaterialApproval.objects.exists())

    def test_anonymous_inactive_or_denied_viewer_never_contacts_provider(self):
        with patch('production.plan_master_gaps.BomReader') as reader:
            self.client.force_authenticate(None)
            self.assertIn(self.client.get(self.url, self.scope).status_code, (401, 403))
            inactive = get_user_model().objects.create_user(username='synthetic-master-inactive', is_active=False)
            self.client.force_authenticate(inactive)
            self.assertEqual(self.client.get(self.url, self.scope).status_code, 403)
            self.client.force_authenticate(self.user)
            with patch('production.plan_workflow_views.user_can_view_plan', return_value=False):
                self.assertEqual(self.client.get(self.url, self.scope).status_code, 403)
        reader.assert_not_called()

    def test_machining_or_invalid_date_scope_is_rejected_before_provider_read(self):
        for params in ({'plan_type': 'machining'}, {'end': '2026-12-01'}, {'start': 'bad-date'}):
            with self.subTest(params=params):
                response, reader = self.get(Reader([]), **params)
                self.assertEqual(response.status_code, 400)
                reader.assert_not_called()

    def test_empty_saved_scope_needs_no_provider_read_and_post_has_no_master_write_action(self):
        response, reader = self.get(Reader([]), start='2026-10-11', end='2026-10-11')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['rows'], [])
        reader.assert_not_called()
        editor = get_user_model().objects.create_user(username='synthetic-master-editor', is_staff=True)
        self.client.force_authenticate(editor)
        before = self.database_state()
        with patch('production.plan_master_gaps.BomReader') as reader:
            response = self.client.post(self.url, {**self.scope, 'plan_id': self.plan.pk}, format='json')
        self.assertEqual(response.status_code, 400)
        reader.assert_not_called()
        self.assertEqual(before, self.database_state())
