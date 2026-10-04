"""OAuth release does not expose the unreleased inspection router or models."""
from django.apps import apps
from django.test import SimpleTestCase
from django.urls import resolve, Resolver404


class OAuthReleaseScopeTests(SimpleTestCase):
    def test_only_explicit_oauth_routes_are_added(self):
        self.assertEqual(resolve('/integrations/blacklake/start/').func.__module__, 'mes_oauth.views')
        self.assertEqual(resolve('/integrations/blacklake/callback/').func.__module__, 'mes_oauth.views')
        self.assertEqual(resolve('/admin/login/').url_name, 'login')
        self.assertEqual(resolve('/api/token/').url_name, 'token_obtain_pair')
        with self.assertRaises(Resolver404):
            resolve('/api/quality/inspection-requests/')

    def test_no_unreleased_inspection_models_are_registered(self):
        for name in ('InspectionRequest', 'InspectionOperation', 'InspectionNonconformance',
                     'InspectionOAuthAttempt'):
            with self.subTest(model=name), self.assertRaises(LookupError):
                apps.get_model('quality', name)
        self.assertEqual([model.__name__ for model in apps.get_app_config('mes_oauth').get_models()],
                         ['OAuthAttempt'])
