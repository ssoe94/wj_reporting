"""Administrator beta boundary, with local fixtures only."""
import uuid
from unittest.mock import patch

from django.test import override_settings
from rest_framework.test import APITestCase

from injection.models import UserProfile
from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest
from .inspection_workflow import capabilities
from . import test_inspection_requests as fixture_helpers


class InspectionBetaAccessTests(APITestCase):
    make_user = fixture_helpers.InspectionRequestContractTests.make_user
    create_payload = fixture_helpers.InspectionRequestContractTests.create_payload
    base = '/api/quality/inspection-requests/'

    def test_all_beta_routes_reject_non_superusers_even_with_staff_or_dedicated_permissions(self):
        users = [
            self.make_user('quality', permissions=('manage', 'submit', 'review')),
            self.make_user('staff', staff=True, permissions=('manage', 'submit', 'review')),
            self.make_user('inactive-admin', superuser=True, active=False), None,
        ]
        routes = [("get", ''), ("get", 'capabilities/'), ("get", 'kanban/'), ("get", '1/'),
                  ("post", ''), ("patch", '1/')] + [("post", f'1/{action}/') for action in
                  ('submit', 'approve', 'reject', 'reinspect', 'sync', 'refresh',
                   'review-failure', 'mes-save', 'mes-finish', 'mes-reconcile')]
        with patch('quality.inspection_adapter.get_inspection_adapter') as adapter:
            for user in users:
                self.client.force_authenticate(user)
                for method, suffix in routes:
                    with self.subTest(user=getattr(user, 'username', None), method=method, suffix=suffix):
                        response = getattr(self.client, method)(self.base + suffix, {}, format='json',
                            HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
                        # JWT challenges anonymous clients with 401; the
                        # isolated session-only harness denies them with 403.
                        if user is None:
                            self.assertIn(response.status_code, (401, 403))
                            if response.status_code == 401:
                                self.assertTrue(response.has_header('WWW-Authenticate'))
                        else:
                            self.assertEqual(response.status_code, 403)
            adapter.assert_not_called()
        for model in (InspectionRequest, InspectionAudit, InspectionOperation):
            self.assertEqual(model.objects.count(), 0)

    def test_active_superuser_without_staff_or_quality_profile_can_read_and_mes_stays_disabled(self):
        user = self.make_user('beta-admin', superuser=True, staff=False, view=False, edit=False)
        UserProfile.objects.filter(user=user).delete()
        self.client.force_authenticate(user)
        response = self.client.get(self.base + 'capabilities/')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['data_mode'], 'wj_local_beta')
        self.assertTrue(response.data['can_view'])
        self.assertFalse(response.data['mes']['enabled'])
        self.assertFalse(response.data['mes']['can_sync'])
        self.assertFalse(response.data['mes']['can_refresh'])
        self.assertEqual(self.client.get(self.base + 'kanban/').status_code, 200)

    @override_settings(INSPECTION_SYNTHETIC_PREVIEW=True)
    def test_synthetic_source_is_explicit_and_cannot_be_selected_by_request_body(self):
        user = self.make_user('preview-admin', superuser=True)
        self.assertEqual(capabilities(user)['data_mode'], 'synthetic_preview')
        self.client.force_authenticate(user)
        response = self.client.post(self.base, self.create_payload(data_mode='synthetic_preview'),
                                    format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 400)
