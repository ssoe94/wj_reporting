"""Readiness admission and source boundaries using disposable auth fixtures."""
from copy import copy
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.db import connection
from django.test import TestCase, override_settings
from django.test.utils import CaptureQueriesContext
from django.urls import reverse
from rest_framework.test import APIClient, APIRequestFactory, force_authenticate

from mes_oauth.pilot_scope import PILOT_SCOPE_CLAIM
from production.mes_delivery_views import MesDeliveryReadinessView


PATH = '/api/production/mes-delivery-readiness/'


@override_settings(INSPECTION_PILOT_USER_IDS=[])
class MesDeliveryReadinessTests(TestCase):
    def setUp(self):
        self.admin = get_user_model().objects.create_user(
            username='SYNTHETIC-delivery-readiness-admin', is_active=True,
            is_superuser=True, is_staff=True)
        self.staff = get_user_model().objects.create_user(
            username='SYNTHETIC-delivery-readiness-staff', is_active=True,
            is_superuser=False, is_staff=True)
        self.factory = APIRequestFactory()

    def request(self, user=None, token=None, method='get', query=None):
        request = getattr(self.factory, method)(PATH, data=query or {})
        if user is not None:
            force_authenticate(request, user=user, token=token)
        return MesDeliveryReadinessView.as_view()(request)

    def test_registered_get_returns_only_code_readiness_without_production_reads_or_writes(self):
        self.assertEqual(reverse('production-mes-delivery-readiness'), PATH)
        client = APIClient()
        client.force_authenticate(user=self.admin)
        with CaptureQueriesContext(connection) as queries, \
                patch('socket.socket.connect', side_effect=AssertionError('Readiness must not open a network connection.')) as connect:
            response = client.get(PATH)
        connect.assert_not_called()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['scope'], 'code_readiness_only')
        self.assertIs(data['read_only'], True)
        self.assertEqual(data['contract_stages'], [
            'work_order_create', 'work_order_dispatch', 'task_start', 'first_qc',
            'periodic_qc', 'progress_report', 'manual_inbound'])
        self.assertIs(data['writers_implemented'], True)
        self.assertIs(data['runtime_connected'], False)
        self.assertIs(data['live_writes_enabled'], False)
        self.assertEqual(data['reason'], 'production_scope_unapproved')
        self.assertEqual(data['production_flow_status'], 'not_evaluated')
        self.assertEqual(data['receipt_verification'], 'not_evaluated')
        self.assertEqual(len(queries), 1)
        self.assertTrue(queries[0]['sql'].lstrip().upper().startswith('SELECT'))
        self.assertIn('auth_user', queries[0]['sql'])
        self.assertNotIn(self.admin.username, str(data))
        self.assertNotIn('SYNTHETIC', str(data))
        self.assertIn('no-store', response['Cache-Control'])
        self.assertEqual(response['Referrer-Policy'], 'no-referrer')

    def test_missing_approvals_are_grouped_requirements_not_fabricated_business_observations(self):
        groups = self.request(self.admin).data['missing_approval_groups']
        self.assertEqual([group['id'] for group in groups], [
            'material_bom_routing_resource', 'quantity_unit_qc_plans',
            'warehouse_location_effects', 'actor_api_authority'])
        self.assertTrue(all(group['status'] == 'approval_required' for group in groups))
        requirements = {item for group in groups for item in group['requirements']}
        self.assertEqual(requirements, {
            'material', 'bom', 'routing', 'resource', 'quantity', 'unit',
            'first_qc_plan', 'periodic_qc_plan', 'warehouse', 'location',
            'inventory_effects', 'actor', 'api_authority'})

    def test_anonymous_and_staff_cannot_reach_readiness(self):
        with patch('production.mes_delivery_views.implementation_readiness') as readiness:
            self.assertIn(self.request().status_code, (401, 403))
            self.assertEqual(self.request(self.staff).status_code, 403)
        readiness.assert_not_called()

    def test_fresh_database_privileges_override_stale_superuser_snapshot(self):
        for changes in ({'is_active': False}, {'is_superuser': False, 'is_staff': True}):
            with self.subTest(changes=changes):
                get_user_model().objects.filter(pk=self.admin.pk).update(**changes)
                self.assertTrue(self.admin.is_active)
                self.assertTrue(self.admin.is_superuser)
                with patch('production.mes_delivery_views.implementation_readiness') as readiness:
                    self.assertEqual(self.request(self.admin).status_code, 403)
                readiness.assert_not_called()
                get_user_model().objects.filter(pk=self.admin.pk).update(is_active=True, is_superuser=True)

    def test_deleted_identity_cannot_use_a_cached_authenticated_user(self):
        stale_user = copy(self.admin)
        get_user_model().objects.filter(pk=self.admin.pk).delete()
        with patch('production.mes_delivery_views.implementation_readiness') as readiness:
            self.assertEqual(self.request(stale_user).status_code, 403)
        readiness.assert_not_called()

    def test_any_signed_pilot_claim_presence_is_rejected_including_malformed_values(self):
        for value in (True, False, None, 'SYNTHETIC-malformed', {}):
            with self.subTest(value=value), \
                    patch('production.mes_delivery_views.implementation_readiness') as readiness:
                self.assertEqual(self.request(self.admin, {PILOT_SCOPE_CLAIM: value}).status_code, 403)
                readiness.assert_not_called()

    def test_configured_pilot_stays_confined_when_pilot_activation_is_off(self):
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.admin.pk], INSPECTION_PILOT_ENABLED=False), \
                patch('production.mes_delivery_views.implementation_readiness') as readiness:
            self.assertEqual(self.request(self.admin).status_code, 403)
        readiness.assert_not_called()

    def test_sticky_authenticated_pilot_classification_is_preserved(self):
        user = copy(self.admin)
        user._inspection_pilot_scope = True
        with patch('production.mes_delivery_views.implementation_readiness') as readiness:
            self.assertEqual(self.request(user).status_code, 403)
        readiness.assert_not_called()

    def test_invalid_pilot_configuration_fails_closed(self):
        with override_settings(INSPECTION_PILOT_USER_IDS='SYNTHETIC-invalid-json'), \
                patch('production.mes_delivery_views.implementation_readiness') as readiness:
            self.assertEqual(self.request(self.admin).status_code, 403)
        readiness.assert_not_called()

    def test_write_methods_are_unavailable_and_cannot_mutate_database(self):
        for method in ('post', 'put', 'patch', 'delete'):
            with self.subTest(method=method), CaptureQueriesContext(connection) as queries, \
                    patch('production.mes_delivery_views.implementation_readiness') as readiness:
                self.assertEqual(self.request(self.admin, method=method).status_code, 405)
                readiness.assert_not_called()
                self.assertTrue(all(query['sql'].lstrip().upper().startswith('SELECT') for query in queries))

    def test_query_input_cannot_select_or_expose_production_data_or_credentials(self):
        original = self.request(self.admin).data
        response = self.request(self.admin, query={
            'actor_id': 'SYNTHETIC-other-actor', 'access_token': 'SYNTHETIC-secret',
            'work_order_id': 'SYNTHETIC-target', 'live_writes_enabled': 'true'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data, original)

    def test_readiness_metadata_cannot_enable_live_writes(self):
        with patch('production.mes_delivery_views.implementation_readiness', return_value={
                'writers_implemented': True, 'runtime_connected': False,
                'live_writes_enabled': True, 'reason': 'production_scope_unapproved'}):
            self.assertIs(self.request(self.admin).data['live_writes_enabled'], False)
