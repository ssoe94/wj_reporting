"""Signed HTTP admission for the one approved, read-only QC preview."""
from copy import copy
from datetime import timedelta
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.test import TestCase, override_settings
from rest_framework.test import APIClient

from config.token_views import ScopedTokenObtainPairSerializer
from injection.models import UserProfile
from mes_oauth import vault
from mes_oauth.identity import VerifiedUserContext
from mes_oauth.inspection_credentials import APPROVED_QC_READ_SCOPE, call_with_user_credential
from mes_oauth.session_guard import InspectionSession
from mes_oauth.test_vault import VaultFixture, TOKEN, LOGIN_SID, userinfo
from . import inspection_qc_read as service
from .inspection_models import InspectionMesBinding, InspectionOperation
from .test_inspection_qc_read import response


PATH = '/api/quality/inspection-requests/mes-detail-preview/'


class ApprovedQCReadAPITests(VaultFixture, TestCase):
    def setUp(self):
        super().setUp()
        self.user.pk = service.ACTOR_ID
        self.user._state.adding = True
        self.user.username = 'SYNTHETIC-APPROVED-API-ACTOR'
        self.user.save(force_insert=True)
        UserProfile.objects.get_or_create(user=self.user)
        self.user.refresh_from_db()
        self.login.delete()
        self.login = self.make_login(self.user, self.login_digest)
        config = override_settings(MES_INSPECTION_ENABLED=False,
            MES_USER_OAUTH_USER_MAP={str(service.ACTOR_ID): str(service.MES_USER_ID)})
        config.enable()
        self.addCleanup(config.disable)
        vault.store_context(self.user.pk, self.login_digest,
            VerifiedUserContext(service.MES_USER_ID, TOKEN, 1200),
            request_started_at=self.instant - timedelta(seconds=2),
            received_at=self.instant - timedelta(seconds=1), login_revision=1)
        self.token = ScopedTokenObtainPairSerializer.get_token(self.user).access_token
        self.token['mes_sid'] = LOGIN_SID
        self.token['mes_login_exp'] = int(self.login.expires_at.timestamp())
        self.session = InspectionSession.from_token(self.user, self.token)
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(self.token))
        self.provider.userinfo.return_value = userinfo(user_id=service.MES_USER_ID)
        self.sender = Mock(return_value=response())
        original = service.read_approved_qc
        routed = patch.object(service, 'read_approved_qc', side_effect=lambda session:
            original(session, provider=self.provider, sender=self.sender))
        self.read = routed.start()
        self.addCleanup(routed.stop)

    def get(self):
        return self.client.get(PATH, secure=True)

    def assert_no_dispatch(self):
        self.provider.userinfo.assert_not_called()
        self.sender.assert_not_called()
        self.assertFalse(InspectionOperation.objects.exists())

    def test_signed_get_reads_existing_token_with_write_gate_off_and_no_binding(self):
        result = self.get()
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.json()['qc_code'], service.QC_CODE)
        self.assertTrue(result.json()['read_only'])
        self.assertIn('no-store', result['Cache-Control'])
        self.assertEqual(result['Referrer-Policy'], 'no-referrer')
        self.provider.userinfo.assert_called_once_with(TOKEN)
        self.sender.assert_called_once()
        self.assertFalse(InspectionMesBinding.objects.exists())
        self.assertFalse(InspectionOperation.objects.exists())
        self.assertNotIn(TOKEN, result.content.decode())
        self.assertNotIn('PRIVATE', result.content.decode())

    def test_anonymous_and_invalid_signature_cannot_reach_service(self):
        for header in ('', 'Bearer SYNTHETIC-NOT-SIGNED'):
            self.client.credentials(HTTP_AUTHORIZATION=header)
            self.assertIn(self.get().status_code, (401, 403))
        self.read.assert_not_called()
        self.assert_no_dispatch()

    def test_signed_other_actor_cannot_dispatch_approved_qc(self):
        token = ScopedTokenObtainPairSerializer.get_token(self.other).access_token
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(token))
        self.assertEqual(self.get().status_code, 403)
        self.assert_no_dispatch()

    def test_actor_without_inspection_view_access_cannot_reach_service(self):
        # Bypass invalidation signals to exercise current permission admission.
        get_user_model().objects.filter(pk=self.user.pk).update(is_superuser=False, is_staff=False)
        self.user.refresh_from_db()
        fresh = ScopedTokenObtainPairSerializer.get_token(self.user).access_token
        self.client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(fresh))
        self.assertEqual(self.get().status_code, 403)
        self.read.assert_not_called()
        self.assert_no_dispatch()

    def test_revoked_login_changed_password_and_reset_profile_stop_before_service(self):
        for kind in ('logout', 'password', 'profile'):
            with self.subTest(kind=kind):
                if kind == 'logout':
                    vault.revoke_actor(self.user.pk, login_digest=self.login_digest, reason='logout')
                elif kind == 'password':
                    self.login.revoked_at = None
                    self.login.save(update_fields=['revoked_at'])
                    get_user_model().objects.filter(pk=self.user.pk).update(password=make_password('CHANGED'))
                else:
                    get_user_model().objects.filter(pk=self.user.pk).update(password=self.user.password)
                    UserProfile.objects.filter(user=self.user).update(password_reset_required=True)
                self.assertIn(self.get().status_code, (401, 403))
        self.read.assert_not_called()
        self.assert_no_dispatch()

    def test_query_or_body_cannot_override_actor_qc_or_provider(self):
        for name in ('actor_id', 'qc_id', 'origin', 'access_token'):
            for body in (False, True):
                with self.subTest(name=name, body=body):
                    result = (self.client.generic('GET', PATH,
                        data='{"' + name + '":"SYNTHETIC-OVERRIDE"}',
                        content_type='application/json', secure=True) if body else
                        self.client.get(PATH, {name: 'SYNTHETIC-OVERRIDE'}, secure=True))
                    self.assertEqual(result.status_code, 400)
                    self.assertEqual(result.json()['code'], 'invalid_read_request')
        for body in ('{}', '[]', 'null'):
            with self.subTest(empty_json_body=body):
                result = self.client.generic('GET', PATH, data=body,
                    content_type='application/json', secure=True)
                self.assertEqual(result.status_code, 400)
                self.assertEqual(result.json()['code'], 'invalid_read_request')
        self.read.assert_not_called()
        self.assert_no_dispatch()

    def test_post_and_head_are_rejected_before_service(self):
        self.assertEqual(self.client.post(PATH, {}, format='json', secure=True).status_code, 405)
        self.assertEqual(self.client.head(PATH, secure=True).status_code, 405)
        self.read.assert_not_called()
        self.assert_no_dispatch()

    def test_unknown_failure_uses_fixed_code_and_never_echoes_provider_text(self):
        self.read.side_effect = vault.VaultBlocked('https://provider.invalid/?token=' + TOKEN)
        result = self.get()
        self.assertEqual(result.status_code, 502)
        self.assertEqual(result.json(), {'detail': 'mes_qc_read_unavailable',
            'code': 'inspection_credential_unavailable'})
        self.assertIn('no-store', result['Cache-Control'])
        self.assertEqual(result['Referrer-Policy'], 'no-referrer')
        self.assertNotIn(TOKEN, result.content.decode())
        self.assert_no_dispatch()

    def test_provider_identity_failure_cannot_dispatch_detail_or_leak_token(self):
        self.provider.userinfo.return_value = userinfo(user_id=service.MES_USER_ID + 1)
        result = self.get()
        self.assertEqual(result.status_code, 502)
        self.assertEqual(result.json()['code'], 'inspection_identity_recheck_failed')
        self.sender.assert_not_called()
        self.assertNotIn(TOKEN, result.content.decode())
        self.assert_wiped()

    def test_approval_cannot_grant_writes_copied_scope_or_default_read(self):
        callback = Mock(return_value={})
        for operation, scope in (('save', APPROVED_QC_READ_SCOPE),
                                 ('finish', APPROVED_QC_READ_SCOPE),
                                 ('read', copy(APPROVED_QC_READ_SCOPE)), ('read', None)):
            with self.subTest(operation=operation, approved=scope is APPROVED_QC_READ_SCOPE):
                with self.assertRaisesRegex(vault.VaultBlocked, '^inspection_policy_unreviewed$'):
                    call_with_user_credential(self.session, mes_user_id=service.MES_USER_ID,
                        tenant=vault.policy().tenant, contract_reference=service.READ_REFERENCE,
                        policy_check=lambda: True, operation=operation, callback=callback,
                        provider=self.provider, approved_read_scope=scope)
        callback.assert_not_called()
        self.assert_no_dispatch()

    def test_provider_exception_is_sanitized_before_http_response(self):
        self.provider.userinfo.side_effect = RuntimeError('PROVIDER-PRIVATE ' + TOKEN)
        result = self.get()
        self.assertEqual(result.status_code, 502)
        self.assertEqual(result.json()['code'], 'inspection_identity_temporarily_unavailable')
        self.assertNotIn(TOKEN, result.content.decode())
        self.assertNotIn('PROVIDER-PRIVATE', result.content.decode())
        self.sender.assert_not_called()

    def test_missing_profile_cannot_reach_service(self):
        UserProfile.objects.filter(user=self.user).delete()
        self.assertEqual(self.get().status_code, 403)
        self.read.assert_not_called()
        self.assert_no_dispatch()
