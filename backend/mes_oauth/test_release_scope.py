"""Integrated inspection beta retains one OAuth boundary and disabled MES writes."""
from django.apps import apps
from django.test import SimpleTestCase
from django.urls import resolve


class OAuthReleaseScopeTests(SimpleTestCase):
    def test_oauth_and_inspection_routes_keep_distinct_handlers(self):
        self.assertEqual(resolve('/integrations/blacklake/start/').func.__module__, 'mes_oauth.views')
        self.assertEqual(resolve('/integrations/blacklake/callback/').func.__module__, 'mes_oauth.views')
        self.assertEqual(resolve('/admin/login/').url_name, 'login')
        self.assertEqual(resolve('/api/token/').url_name, 'token_obtain_pair')
        inspection = resolve('/api/quality/inspection-requests/').func
        self.assertEqual(inspection.cls.__module__, 'quality.inspection_views')
        for path, action in (('mes-save', 'mes_save'), ('mes-finish', 'mes_finish'),
                             ('mes-reconcile', 'mes_reconcile')):
            self.assertEqual(resolve('/api/quality/inspection-requests/1/' + path + '/').func.actions['post'], action)

    def test_inspection_models_do_not_duplicate_the_oauth_replay_ledger(self):
        for name in ('InspectionRequest', 'InspectionOperation', 'InspectionNonconformance'):
            with self.subTest(model=name):
                self.assertEqual(apps.get_model('quality', name).__module__, 'quality.inspection_models')
        with self.assertRaises(LookupError):
            apps.get_model('quality', 'InspectionOAuthAttempt')
        self.assertEqual([model.__name__ for model in apps.get_app_config('mes_oauth').get_models()],
                         ['OAuthAttempt', 'MESLoginSession', 'MESLoginTicket',
                          'MESCredential', 'MESCredentialEvent'])

    def test_integrating_inspection_does_not_enable_a_live_mes_adapter(self):
        from quality.inspection_adapter import get_inspection_adapter
        from quality.inspection_mes_stages import get_stage_adapter
        self.assertFalse(get_inspection_adapter().enabled)
        self.assertFalse(get_stage_adapter().enabled)
