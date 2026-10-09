"""Synthetic signed-JWT route checks; no inventory work or provider calls.

Inventory handlers are replaced with inert responses after their real view
permissions and authentication run. Other probes test route admission only;
inspection ownership and MES eligibility remain independently enforced.
"""
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import patch

from django.apps import apps
from django.conf import settings
from django.contrib.auth import get_user_model
from django.http import HttpResponse
from django.test import Client, RequestFactory, SimpleTestCase, TestCase, override_settings
from django.urls import path, reverse
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.test import APITestCase
from rest_framework.views import APIView
from rest_framework_simplejwt.tokens import AccessToken, RefreshToken

from config.authentication import ScopedJWTAuthentication
from config.token_views import ScopedTokenObtainPairSerializer, ScopedTokenObtainPairView, ScopedTokenRefreshView
from inventory.views import InventoryListView, unified_parts_api
from .pilot_scope import PILOT_SCOPE_CLAIM, configured_pilot_actor_ids, pilot_route_scope_required
from .connection_views import BridgeRestrictionMiddleware


class RouteProbe(APIView):
    authentication_classes = [ScopedJWTAuthentication]
    permission_classes = [IsAuthenticated]

    def get(self, request):
        return Response({'actor_id': request.user.pk,
                         'pilot_scoped': getattr(request.user, '_inspection_pilot_scope', None)})

    post = patch = put = delete = get


PROBE_NAMES = (
    'user-me', 'change-password', 'user_change_password', 'admin-change-password',
    'mes-connection-status', 'mes-connection-launch', 'mes-connection-disconnect',
    'mes-connection-logout', 'mes-connection-recheck', 'inspection-request-capabilities',
    'inspection-request-list', 'inspection-request-detail', 'inspection-request-submit',
    'inspection-request-reinspect', 'inspection-request-sync', 'inspection-request-refresh',
    'inspection-request-mes-save', 'inspection-request-mes-finish', 'inspection-request-mes-reconcile',
    'inspection-request-kanban', 'inspection-request-approve', 'inspection-request-reject',
    'inspection-request-review-failure', 'quality-report-list', 'admin-reset-password',
    'reset-password', 'admin-user-list',
)
urlpatterns = [path('probe/' + name + '/', RouteProbe.as_view(), name=name) for name in PROBE_NAMES] + [
    path('unnamed/', RouteProbe.as_view()),
    path('inventory/', InventoryListView.as_view(authentication_classes=[ScopedJWTAuthentication]),
         name='inventory_list'),
    path('inventory/write/', unified_parts_api.cls.as_view(authentication_classes=[ScopedJWTAuthentication]),
         name='unified_parts_api'),
    path('token/', ScopedTokenObtainPairView.as_view(), name='token_obtain_pair'),
    path('token/refresh/', ScopedTokenRefreshView.as_view(), name='token_refresh'),
]


class PilotConfigurationTests(SimpleTestCase):
    def test_ids_accept_empty_or_bounded_unique_positive_integers(self):
        for raw, expected in [('[]', set()), ('[7, 12]', {7, 12}), ([7], {7})]:
            with self.subTest(raw=raw), override_settings(INSPECTION_PILOT_USER_IDS=raw):
                self.assertEqual(configured_pilot_actor_ids(), expected)

    def test_malformed_configuration_never_falls_back_to_general_scope(self):
        for raw in ('bad-json', '{}', '[true]', '[0]', '[-1]', '[1.0]', '["7"]',
                    '[7, 7]', None, list(range(1, 22)), [2**63]):
            with self.subTest(raw=raw), override_settings(INSPECTION_PILOT_USER_IDS=raw):
                with self.assertRaises(ValueError):
                    configured_pilot_actor_ids()
                self.assertTrue(pilot_route_scope_required(SimpleNamespace(pk=7), {}))


@override_settings(ROOT_URLCONF='config.urls', INSPECTION_PILOT_ENABLED=False,
                   INSPECTION_PILOT_USER_IDS='[]')
class PilotDjangoSessionScopeTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='SYNTHETIC-session-pilot',
            password='SYNTHETIC-session-password', is_staff=True, is_superuser=True)
        self.browser = Client()
        self.browser.force_login(self.user)

    def test_existing_admin_session_is_confined_despite_privilege_flags_and_disabled_pilot(self):
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.user.pk]):
            for path in ('/admin/', '/admin/auth/user/', '/admin/login/', '/staff/signup-approvals/'):
                with self.subTest(path=path):
                    self.assertEqual(self.browser.get(path, secure=True).status_code, 403)
            response = self.browser.post('/admin/auth/user/add/', {
                'username': 'SYNTHETIC-FORBIDDEN-ADMIN-CREATE'}, secure=True)
            self.assertEqual(response.status_code, 403)
            self.assertIn('no-store', response['Cache-Control'])
        self.assertFalse(get_user_model().objects.filter(username='SYNTHETIC-FORBIDDEN-ADMIN-CREATE').exists())

    def test_staff_approval_post_is_blocked_before_legacy_handler(self):
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.user.pk]), \
                patch('injection.views.SignupApprovalPortalView.post', return_value=HttpResponse('synthetic')) as handler:
            self.assertEqual(self.browser.post('/staff/signup-approvals/', {
                'action': 'approve', 'is_admin': 'on'}, secure=True).status_code, 403)
        handler.assert_not_called()

    def test_unlisted_administrator_keeps_existing_admin_access(self):
        self.assertEqual(self.browser.get('/admin/', secure=True).status_code, 200)

    def test_invalid_configuration_cannot_restore_admin_access(self):
        with override_settings(INSPECTION_PILOT_USER_IDS='[true]'):
            self.assertEqual(self.browser.get('/admin/', secure=True).status_code, 403)

    def test_request_scope_marker_blocks_admin_before_handler(self):
        self.user._inspection_pilot_scope = True
        request = RequestFactory().post('/admin/auth/user/add/')
        request.user, request.session = self.user, {}
        with patch('django.http.HttpResponse', return_value=HttpResponse('synthetic')) as handler:
            response = BridgeRestrictionMiddleware(handler)(request)
        self.assertEqual(response.status_code, 403)
        handler.assert_not_called()


@override_settings(ROOT_URLCONF=__name__, INSPECTION_PILOT_ENABLED=False, INSPECTION_PILOT_USER_IDS='[]')
class PilotRouteScopeTests(APITestCase):
    password = 'SYNTHETIC-pilot-route-password'

    def setUp(self):
        self.user = get_user_model().objects.create_user(username='SYNTHETIC-pilot-route', password=self.password)

    def authenticate(self, refresh=None):
        refresh = refresh if refresh is not None else ScopedTokenObtainPairSerializer.get_token(self.user)
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(refresh.access_token))
        return refresh

    def assert_inventory_scope(self, expected):
        with patch.object(InventoryListView, 'get', return_value=Response({'synthetic': True})) as read, \
                patch.object(unified_parts_api.cls, 'post', return_value=Response({'synthetic': True})) as write:
            self.assertEqual(self.client.get(reverse('inventory_list')).status_code, expected)
            self.assertEqual(self.client.post(reverse('unified_parts_api'), {}, format='json').status_code, expected)
            self.assertEqual(read.call_count, int(expected == 200))
            self.assertEqual(write.call_count, int(expected == 200))

    def test_server_id_confines_existing_general_token_even_with_pilot_disabled(self):
        refresh = self.authenticate()
        self.assertNotIn(PILOT_SCOPE_CLAIM, refresh)
        self.assert_inventory_scope(200)
        self.assertIs(self.client.get(reverse('user-me')).data['pilot_scoped'], False)
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.user.pk]):
            self.assert_inventory_scope(403)
            self.assertIs(self.client.get(reverse('user-me')).data['pilot_scoped'], True)

    def test_signed_scope_survives_disabled_feature_and_allowlist_removal(self):
        refresh = ScopedTokenObtainPairSerializer.get_token(self.user)
        refresh[PILOT_SCOPE_CLAIM] = True
        self.authenticate(refresh)
        self.assert_inventory_scope(403)
        response = self.client.get(reverse('user-me'))
        self.assertEqual(response.status_code, 200)
        self.assertIs(response.data['pilot_scoped'], True)
        self.assertEqual(self.client.head(reverse('user-me')).status_code, 200)

    def test_malformed_signed_scope_marker_cannot_restore_general_access(self):
        for marker in (False, None, 'false', 0):
            with self.subTest(marker=marker):
                refresh = ScopedTokenObtainPairSerializer.get_token(self.user)
                refresh[PILOT_SCOPE_CLAIM] = marker
                self.authenticate(refresh)
                self.assert_inventory_scope(403)

    def test_exact_workflow_routes_are_allowed_but_other_reads_writes_and_reviews_are_denied(self):
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.user.pk]):
            self.authenticate()
        allowed = [('get', 'inspection-request-list'), ('post', 'inspection-request-list'),
                   ('get', 'inspection-request-detail'), ('patch', 'inspection-request-detail'),
                   ('get', 'inspection-request-capabilities'), ('get', 'mes-connection-status')]
        allowed += [('post', name) for name in (
            'change-password', 'user_change_password', 'admin-change-password',
            'mes-connection-launch', 'mes-connection-disconnect', 'mes-connection-logout',
            'mes-connection-recheck', 'inspection-request-submit', 'inspection-request-reinspect',
            'inspection-request-refresh', 'inspection-request-mes-save',
            'inspection-request-mes-finish', 'inspection-request-mes-reconcile')]
        for method, name in allowed:
            with self.subTest(method=method, name=name):
                self.assertEqual(getattr(self.client, method)(reverse(name), {}, format='json').status_code, 200)
        denied = [('get', 'inspection-request-kanban'), ('get', 'quality-report-list'),
                  ('post', 'inspection-request-sync'),
                  ('post', 'inspection-request-approve'), ('post', 'inspection-request-reject'),
                  ('post', 'inspection-request-review-failure'), ('post', 'admin-reset-password'),
                  ('post', 'reset-password'), ('get', 'admin-user-list'),
                  ('put', 'inspection-request-detail'), ('delete', 'inspection-request-detail'),
                  ('post', 'user-me'), ('get', 'mes-connection-launch')]
        for method, name in denied:
            with self.subTest(method=method, name=name):
                self.assertEqual(getattr(self.client, method)(reverse(name), {}, format='json').status_code, 403)
        self.assertEqual(self.client.get('/unnamed/').status_code, 403)

    def test_malformed_config_confines_existing_tokens(self):
        self.authenticate()
        with override_settings(INSPECTION_PILOT_USER_IDS='[true]'):
            self.assert_inventory_scope(403)
            self.assertEqual(self.client.get(reverse('user-me')).status_code, 200)

    def test_token_obtain_marks_configured_actor_even_when_pilot_is_disabled(self):
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.user.pk]):
            response = self.client.post(reverse('token_obtain_pair'),
                {'username': self.user.username, 'password': self.password}, format='json')
        self.assertEqual(response.status_code, 200)
        self.assertIs(AccessToken(response.data['access'])[PILOT_SCOPE_CLAIM], True)
        self.assertIs(RefreshToken(response.data['refresh'])[PILOT_SCOPE_CLAIM], True)

    def test_refresh_adds_scope_to_legacy_family_and_keeps_it_after_allowlist_removal(self):
        jwt_settings = {**getattr(settings, 'SIMPLE_JWT', {}),
                        'ROTATE_REFRESH_TOKENS': True, 'BLACKLIST_AFTER_ROTATION': False}
        with override_settings(SIMPLE_JWT=jwt_settings):
            legacy = RefreshToken.for_user(self.user)
            self.assertNotIn(PILOT_SCOPE_CLAIM, legacy)
            with override_settings(INSPECTION_PILOT_USER_IDS=[self.user.pk]):
                first = self.client.post(reverse('token_refresh'), {'refresh': str(legacy)}, format='json')
            self.assertEqual(first.status_code, 200)
            self.assertIs(AccessToken(first.data['access'])[PILOT_SCOPE_CLAIM], True)
            rotated = RefreshToken(first.data['refresh'])
            self.assertIs(rotated[PILOT_SCOPE_CLAIM], True)
            second = self.client.post(reverse('token_refresh'), {'refresh': str(rotated)}, format='json')
            self.assertEqual(second.status_code, 200)
            self.assertIs(AccessToken(second.data['access'])[PILOT_SCOPE_CLAIM], True)
            self.assertIs(RefreshToken(second.data['refresh'])[PILOT_SCOPE_CLAIM], True)
            self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + second.data['access'])
            self.assert_inventory_scope(403)

    @skipUnless(apps.is_installed('rest_framework_simplejwt.token_blacklist'), 'JWT blacklist app is required.')
    def test_scoped_refresh_rotation_still_blacklists_the_original_token(self):
        jwt_settings = {**getattr(settings, 'SIMPLE_JWT', {}),
                        'ROTATE_REFRESH_TOKENS': True, 'BLACKLIST_AFTER_ROTATION': True}
        with override_settings(SIMPLE_JWT=jwt_settings, INSPECTION_PILOT_USER_IDS=[self.user.pk]):
            refresh = ScopedTokenObtainPairSerializer.get_token(self.user)
            original = str(refresh)
            first = self.client.post(reverse('token_refresh'), {'refresh': original}, format='json')
            self.assertEqual(first.status_code, 200)
            replay = self.client.post(reverse('token_refresh'), {'refresh': original}, format='json')
            self.assertEqual(replay.status_code, 401)
            rotated = self.client.post(reverse('token_refresh'),
                                       {'refresh': first.data['refresh']}, format='json')
            self.assertEqual(rotated.status_code, 200)
            self.assertIs(AccessToken(rotated.data['access'])[PILOT_SCOPE_CLAIM], True)
