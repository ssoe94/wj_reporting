"""Synthetic settings-transition checks; not browser or live deployment evidence.

Run only with scripts/check-mes-oauth.py, which supplies a disposable database,
synthetic settings, temporary media root and a Python network guard. These tests
do not open media files or call MES. Django's test client does not emulate a
browser's Secure-cookie transport rules; cookie assertions inspect Set-Cookie.
"""
from contextlib import contextmanager
from importlib import reload
from types import SimpleNamespace
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.sessions.models import Session
from django.test import Client, SimpleTestCase, TestCase, override_settings
from django.urls import Resolver404, clear_url_caches, resolve, reverse
from django.views.static import serve
from rest_framework.permissions import IsAuthenticated

from injection.models import UserProfile
from quality.permissions import QualityImportPermission
from quality.storage import quality_import_media_upload_available
from quality.views import QualityImportAssetViewSet, QualityImportMediaViewSet


ORIGIN = 'https://testserver'
PASSWORD = 'SYNTHETIC-READINESS-ONLY-PASSWORD'
OLD_FLAGS = {'DEBUG': True, 'SESSION_COOKIE_SECURE': False, 'CSRF_COOKIE_SECURE': False}
HTTPS_FLAGS = {'DEBUG': False, 'SESSION_COOKIE_SECURE': True, 'CSRF_COOKIE_SECURE': True}


@override_settings(SESSION_ENGINE='django.contrib.sessions.backends.db', MES_USER_OAUTH_ENABLED=False)
class ExistingAuthenticationReadinessTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(
            username='SYNTHETIC-READINESS-ADMIN', password=PASSWORD,
            is_active=True, is_staff=True, is_superuser=True,
        )
        UserProfile.objects.update_or_create(user=self.user, defaults={
            'password_reset_required': False, 'is_using_temp_password': False,
        })

    def login_form(self, client):
        response = client.get('/admin/login/?next=/admin/', secure=True)
        self.assertEqual(response.status_code, 200)
        return response, client.cookies[settings.CSRF_COOKIE_NAME].value

    def admin_login(self, client):
        _, csrf = self.login_form(client)
        response = client.post('/admin/login/?next=/admin/', {
            'username': self.user.username, 'password': PASSWORD,
            'next': '/admin/', 'csrfmiddlewaretoken': csrf,
        }, secure=True, HTTP_ORIGIN=ORIGIN)
        self.assertEqual(response.status_code, 302)
        self.assertEqual(response['Location'], '/admin/')
        self.assertEqual(client.session['_auth_user_id'], str(self.user.pk))
        return response

    def token_pair(self, client):
        response = client.post('/api/token/', {
            'username': self.user.username, 'password': PASSWORD,
        }, content_type='application/json', secure=True)
        self.assertEqual(response.status_code, 200)
        return response.json()

    def assert_access_authenticated(self, client, access):
        response = client.get(reverse('user-me'), secure=True,
                              HTTP_AUTHORIZATION='Bearer ' + access)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.wsgi_request.user.pk, self.user.pk)

    def test_existing_database_session_survives_settings_transition(self):
        client = Client(enforce_csrf_checks=True)
        with override_settings(**OLD_FLAGS):
            response = self.admin_login(client)
            self.assertFalse(response.cookies[settings.SESSION_COOKIE_NAME]['secure'])
            session_key = client.cookies[settings.SESSION_COOKIE_NAME].value
            self.assertTrue(Session.objects.filter(session_key=session_key).exists())

        # Preserve the cookie and database record; do not log in or mint a new
        # session after changing the flags. No signing-key setting is changed.
        with override_settings(**HTTPS_FLAGS):
            response = client.get('/admin/', secure=True)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response.wsgi_request.user.is_authenticated)
            self.assertEqual(response.wsgi_request.user.pk, self.user.pk)
            self.assertEqual(client.cookies[settings.SESSION_COOKIE_NAME].value, session_key)
            stored = Session.objects.get(session_key=session_key)
            self.assertEqual(stored.get_decoded()['_auth_user_id'], str(self.user.pk))

    def test_existing_jwt_access_and_refresh_survive_settings_transition(self):
        client = Client(enforce_csrf_checks=True)
        with override_settings(**OLD_FLAGS):
            pair = self.token_pair(client)
            self.assert_access_authenticated(client, pair['access'])
            self.assertNotIn(settings.SESSION_COOKIE_NAME, client.cookies)

        with override_settings(**HTTPS_FLAGS):
            self.assert_access_authenticated(client, pair['access'])
            response = client.post('/api/token/refresh/', {'refresh': pair['refresh']},
                                   content_type='application/json', secure=True)
            self.assertEqual(response.status_code, 200)
            rotated = response.json()
            self.assert_access_authenticated(client, rotated['access'])
            self.assertNotEqual(rotated['refresh'], pair['refresh'])
            self.assertNotIn(settings.SESSION_COOKIE_NAME, client.cookies)

    @override_settings(**HTTPS_FLAGS)
    def test_https_admin_login_sets_secure_session_and_csrf_cookies(self):
        client = Client(enforce_csrf_checks=True)
        form, _ = self.login_form(client)
        self.assertTrue(form.cookies[settings.CSRF_COOKIE_NAME]['secure'])
        response = self.admin_login(client)
        session_cookie = response.cookies[settings.SESSION_COOKIE_NAME]
        self.assertTrue(session_cookie['secure'])
        self.assertTrue(session_cookie['httponly'])
        self.assertEqual(session_cookie['samesite'], 'Lax')
        self.assertEqual(session_cookie['domain'], '')
        self.assertTrue(response.cookies[settings.CSRF_COOKIE_NAME]['secure'])
        self.assertEqual(client.get('/admin/', secure=True).status_code, 200)

    @override_settings(**HTTPS_FLAGS)
    def test_https_admin_login_still_requires_csrf_and_same_origin(self):
        for kind in ('missing_csrf', 'cross_origin'):
            with self.subTest(kind=kind):
                client = Client(enforce_csrf_checks=True)
                _, csrf = self.login_form(client)
                payload = {'username': self.user.username, 'password': PASSWORD, 'next': '/admin/'}
                if kind == 'cross_origin':
                    payload['csrfmiddlewaretoken'] = csrf
                response = client.post('/admin/login/', payload, secure=True,
                    HTTP_ORIGIN='https://synthetic-untrusted.invalid' if kind == 'cross_origin' else ORIGIN)
                self.assertEqual(response.status_code, 403)
                self.assertNotIn(settings.SESSION_COOKIE_NAME, client.cookies)

    @override_settings(**HTTPS_FLAGS)
    def test_authenticated_content_routes_keep_their_authentication_boundary(self):
        client = Client(enforce_csrf_checks=True)
        pair = self.token_pair(client)
        for name in ('quality-import-media-content', 'quality-import-asset-content'):
            with self.subTest(route=name):
                # The disposable database has no quality records or files.
                path = reverse(name, kwargs={'pk': 1})
                self.assertEqual(client.get(path, secure=True).status_code, 401)
                response = client.get(path, secure=True,
                    HTTP_AUTHORIZATION='Bearer ' + pair['access'])
                self.assertEqual(response.status_code, 404)
                self.assertEqual(response.wsgi_request.user.pk, self.user.pk)


class MediaStorageReadinessTests(SimpleTestCase):
    def storage_gate(self, *, debug, local_proxy, storage):
        # Exercise the real readiness predicate only. Global setting changes
        # reload the third-party Cloudinary SDK and can fail before this helper
        # runs; this is deliberately not a missing-credentials boot test.
        synthetic_settings = SimpleNamespace(
            DEBUG=debug, QUALITY_IMPORT_ALLOW_LOCAL_PROXY=local_proxy,
            CLOUDINARY_STORAGE=storage,
        )
        with patch('quality.storage.settings', synthetic_settings):
            return quality_import_media_upload_available()

    def test_storage_availability_is_independent_of_debug_when_configured(self):
        configured = {'CLOUD_NAME': 'synthetic', 'API_KEY': 'synthetic', 'API_SECRET': 'synthetic'}
        cases = (
            (False, False, {}, False),
            (True, False, {}, True),
            (False, True, {}, True),
            (False, False, configured, True),
        )
        for debug, local_proxy, storage, expected in cases:
            with self.subTest(debug=debug, local_proxy=local_proxy, configured=bool(storage)):
                self.assertIs(self.storage_gate(debug=debug, local_proxy=local_proxy,
                                               storage=storage), expected)

    def test_incomplete_storage_fails_closed_without_explicit_local_override(self):
        configured = {'CLOUD_NAME': 'synthetic', 'API_KEY': 'synthetic', 'API_SECRET': 'synthetic'}
        for missing in configured:
            with self.subTest(missing=missing):
                incomplete = {key: value for key, value in configured.items() if key != missing}
                self.assertFalse(self.storage_gate(debug=False, local_proxy=False,
                                                   storage=incomplete))


@contextmanager
def debug_urlconf(debug):
    """Re-evaluate the real URL module, restoring its original DEBUG branches."""
    from config import urls
    try:
        with override_settings(DEBUG=debug):
            reload(urls)
            clear_url_caches()
            yield
    finally:
        reload(urls)
        clear_url_caches()


class MediaRouteReadinessTests(SimpleTestCase):
    def test_debug_media_route_disappears_but_authenticated_content_routes_remain(self):
        path = '/media/SYNTHETIC-NONEXISTENT-READINESS.png'
        with debug_urlconf(True):
            self.assertIs(resolve(path).func, serve)
        with debug_urlconf(False):
            with self.assertRaises(Resolver404):
                resolve(path)
            for name, viewset in (
                ('quality-import-media-content', QualityImportMediaViewSet),
                ('quality-import-asset-content', QualityImportAssetViewSet),
            ):
                with self.subTest(route=name):
                    route = resolve(reverse(name, kwargs={'pk': 1}))
                    self.assertIs(route.func.cls, viewset)
                    self.assertEqual(route.func.actions['get'], 'content')
                    self.assertIn(IsAuthenticated, route.func.cls.permission_classes)
                    self.assertIn(QualityImportPermission, route.func.cls.permission_classes)
