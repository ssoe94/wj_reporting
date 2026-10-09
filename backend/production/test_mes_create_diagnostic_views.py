"""Exact-draft API admission with signed synthetic logins and the real broker.

Only disposable fixtures and fake provider HTTP are used. GET and prepare must
never consume APP authority or renew an existing USER credential. Send/recheck
exercise the actual durable fence rather than a mocked workflow callback.
"""
from datetime import datetime, timedelta
import re
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Permission
from django.contrib.contenttypes.models import ContentType
from django.db import connection
from django.test import TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient
from rest_framework_simplejwt.tokens import AccessToken

from mes_oauth import vault
from mes_oauth.app_tokens import AppCredentialUnavailable
from mes_oauth.client import USERINFO
from mes_oauth.identity import VerifiedUserContext
from mes_oauth.models import MESCredential, MESCredentialEvent, MESLoginSession
from mes_oauth.pilot_scope import PILOT_SCOPE_CLAIM
from mes_oauth.test_oauth import synthetic_session
from mes_oauth.test_vault import VaultFixture, APP_TOKEN, LOGIN_SID, TOKEN
from . import mes_create_diagnostic as diagnostic
from . import test_mes_create_diagnostic as provider_fixture
from .mes_execution_contract import encode_exact_json
from .models import MesCreateDiagnostic, MesCreateDiagnosticEvent, MesCreateDiagnosticPermit


URL = '/api/production/mes-create-diagnostic/'
WRITE_SQL = re.compile(r'^\s*(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP)\b', re.I)
ENVELOPE_FIELDS = {
    'code', 'scope', 'state', 'request_uid', 'attempt', 'approval', 'app_supply',
    'connection', 'can_prepare', 'can_send', 'can_recheck', 'can_reconnect', 'blockers',
    'ordinary_writer_enabled',
}


class MesCreateDiagnosticViewTests(VaultFixture, TransactionTestCase):

    def make_login(self, actor, login_digest):
        # VaultFixture normally registers a legacy login. These endpoints require
        # genuine v2 provenance; a v2 JWT alone must not manufacture that row.
        return MESLoginSession.objects.create(
            digest=login_digest, actor_id=actor.pk,
            authorization_digest=vault.authorization_digest(actor),
            expires_at=self.instant + timedelta(hours=1), session_version=2,
            last_activity_at=self.instant, idle_expires_at=self.instant + timedelta(hours=1),
        )

    def setUp(self):
        manager = get_user_model().objects
        create_user = manager.create_user

        def create_fixture_user(**kwargs):
            if kwargs.get('username') == 'SYNTHETIC-VAULT-ACTOR':
                kwargs['pk'] = diagnostic.ACTOR_ID
            elif kwargs.get('username') == 'SYNTHETIC-VAULT-OTHER':
                kwargs['pk'] = diagnostic.ACTOR_ID + 1
            return create_user(**kwargs)

        with patch.object(manager, 'create_user', side_effect=create_fixture_user), \
                patch('mes_oauth.test_vault.MES_USER', int(diagnostic.MES_USER_ID)):
            super().setUp()
        self.clock.side_effect = lambda: self.instant
        fixture = self

        class FrozenJWTDatetime(datetime):
            @classmethod
            def now(cls, tz=None):
                return fixture.instant

        for context in (
            patch('rest_framework_simplejwt.tokens.aware_utcnow', side_effect=lambda: self.instant),
            patch('jwt.api_jwt.datetime', FrozenJWTDatetime),
            patch('time.time', side_effect=lambda: self.instant.timestamp()),
            override_settings(
                MES_INSPECTION_ENABLED=True, INSPECTION_PILOT_ENABLED=False,
                INSPECTION_PILOT_USER_IDS=[], MES_USER_OAUTH_APP_TOKEN_SOURCE='static',
            ),
        ):
            context.__enter__()
            self.addCleanup(context.__exit__, None, None, None)

        self.api = APIClient()
        self.authenticate()
        self.identity_ids, self.identity_sessions, self.calls = [], [], []
        self.created = self.timeout = False
        self.denied = ''
        self.inventory, self.qc, self.tasks, self.changes = [], [], [], []
        self.inputs = []
        self.processes = {'processes': [], 'relations': [], 'originalProcessRoute': None}
        self.base = {
            'id': int(provider_fixture.WORK_ID), 'code': diagnostic.CODE,
            'identifier': diagnostic.CODE, 'externalOrderCode': diagnostic.CODE,
            'status': {'code': 0}, 'plannedStartTime': diagnostic.PAYLOAD['planStartTime'],
            'plannedFinishTime': diagnostic.PAYLOAD['planFinishTime'],
            'updatedAt': diagnostic.PAYLOAD['planStartTime'],
            'actualStartTime': None, 'resource': None, 'bomId': None,
        }
        self.output = {
            'materialId': int(diagnostic.MATERIAL_ID), 'material': {'baseInfo': {'code': '0'}},
            'main': 1, 'unitName': '个', 'plannedAmount': {'amount': 1, 'unitName': '个'},
            'processRouteCode': None, 'outputProcessSimpleVO': None,
        }
        for context in (
            patch('mes_oauth.client.requests.Session', side_effect=self.oauth_session),
            patch('quality.inspection_live_adapter._user_sender', side_effect=self.sender),
        ):
            context.__enter__()
            self.addCleanup(context.__exit__, None, None, None)
        self.issuers = []
        for target in (
            'mes_oauth.app_tokens.get_app_access_token',
            'mes_oauth.inspection_credentials.get_app_access_token',
            'mes_oauth.callback_app_tokens.get_app_access_token',
            'mes_oauth.app_tokens.AppTokenSupplier._issue',
        ):
            guard = patch(target, side_effect=AssertionError('New APP issuance forbidden in API fixtures.'))
            issuer = guard.start()
            self.issuers.append(issuer)
            self.addCleanup(guard.stop)
            self.addCleanup(issuer.assert_not_called)

    def authenticate(self, actor=None, *, sid=LOGIN_SID, extra=None):
        actor = actor or self.user
        login = MESLoginSession.objects.get(pk=vault.digest('client-login', sid))
        token = AccessToken.for_user(actor)
        token['mes_sid'] = sid
        token['mes_login_exp'] = int(login.expires_at.timestamp())
        token['mes_session_v'] = 2
        if extra:
            token.payload.update(extra)
        self.token = token
        self.api.credentials(HTTP_AUTHORIZATION='Bearer ' + str(token))

    def oauth_session(self):
        index = len(self.identity_sessions)
        mes_user = self.identity_ids[index] if index < len(self.identity_ids) else int(diagnostic.MES_USER_ID)
        session = synthetic_session(encode_exact_json({'code': 200, 'data': {'userId': mes_user}}))
        response = session.post.return_value

        def post(url, **kwargs):
            self.assertTrue(url.endswith(USERINFO))
            self.assertEqual(kwargs['json'], {'userAccessToken': TOKEN})
            self.assertFalse(kwargs['allow_redirects'])
            return response

        session.post.side_effect = post
        self.identity_sessions.append(session)
        return session

    # This helper asserts exact payload bytes, scope and a committed attempt=1
    # at the fake CREATE boundary. No DiagnosticTests broker mock is inherited.
    sender = provider_fixture.DiagnosticTests.sender

    def store_user(self):
        return self.store(context=VerifiedUserContext(int(diagnostic.MES_USER_ID), TOKEN, 1200))

    def post(self, action, **fields):
        return self.api.post(URL, {'action': action, **fields}, format='json', secure=True)

    def prepare(self):
        response = self.post('prepare')
        self.assertEqual(response.status_code, 200, response.data)
        self.req = MesCreateDiagnostic.objects.get(pk=response.data['request_uid'])
        self.assert_envelope(response.data)
        return response.data

    def assert_envelope(self, data):
        self.assertTrue(ENVELOPE_FIELDS.issubset(data))
        self.assertEqual(data['code'], diagnostic.CODE)
        self.assertIs(data['ordinary_writer_enabled'], False)
        self.assertEqual(data['approval']['max_attempts'], 1)
        self.assertEqual(set(data['app_supply']), {'available', 'usable_for_seconds', 'supply_mode'})
        for key in ('can_prepare', 'can_send', 'can_recheck', 'can_reconnect'):
            self.assertIs(type(data[key]), bool)
        encoded = encode_exact_json(data).decode()
        for private_value in (TOKEN, APP_TOKEN):
            self.assertNotIn(private_value, encoded)
        for private_field in ('ciphertext', 'app_access_token', 'userAccessToken',
                              'refresh_token', 'auth_oauth_attempt', 'snapshot_digest',
                              'authorization_digest', 'login_digest', 'key_id', 'auth_nonce'):
            self.assertNotIn('"' + private_field + '"', encoded)

    def assert_no_dispatch(self):
        self.assertEqual(self.identity_sessions, [])
        self.assertEqual(self.calls, [])
        for issuer in self.issuers:
            issuer.assert_not_called()

    def read_without_writes(self):
        with CaptureQueriesContext(connection) as queries:
            response = self.api.get(URL, secure=True)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertTrue(any(query['sql'].lstrip().upper().startswith('SELECT') for query in queries))
        self.assertEqual([query['sql'] for query in queries if WRITE_SQL.match(query['sql'])], [])
        self.assert_envelope(response.data)
        return response.data

    def test_get_does_not_seed_journal_register_login_or_enter_broker(self):
        before = list(MESLoginSession.objects.values())
        with patch('mes_oauth.inspection_credentials.call_with_user_credential',
                   side_effect=AssertionError('GET must not enter the USER broker.')) as broker, \
                patch('mes_oauth.vault._open', side_effect=AssertionError('GET must not decrypt USER.')) as decrypt:
            data = self.read_without_writes()
        broker.assert_not_called()
        decrypt.assert_not_called()
        self.assertIs(data['can_prepare'], True)
        self.assertIs(data['can_send'], False)
        self.assertEqual(list(MESLoginSession.objects.values()), before)
        self.assertFalse(MesCreateDiagnostic.objects.exists())
        self.assertFalse(MesCreateDiagnosticEvent.objects.exists())
        self.assertFalse(MESCredentialEvent.objects.exists())
        self.assert_no_dispatch()

    def test_get_with_stored_user_preserves_ciphertext_and_all_deadlines(self):
        self.store_user()
        self.prepare()
        before = list(MESCredential.objects.values())
        events = MESCredentialEvent.objects.count()
        journal_events = MesCreateDiagnosticEvent.objects.count()
        login = list(MESLoginSession.objects.values())
        self.read_without_writes()
        self.assertEqual(list(MESCredential.objects.values()), before)
        self.assertEqual(MESCredentialEvent.objects.count(), events)
        self.assertEqual(MesCreateDiagnosticEvent.objects.count(), journal_events)
        self.assertEqual(list(MESLoginSession.objects.values()), login)
        self.assert_no_dispatch()

    def test_get_never_exposes_callback_binding_or_private_journal_evidence(self):
        prepared = self.prepare()
        self.assertIs(prepared['can_reconnect'], True)
        private_attempt = 'SYNTHETIC-PRIVATE-CALLBACK-ATTEMPT'
        permit = MesCreateDiagnosticPermit.objects.get(request=self.req)
        permit.auth_app_attempt = 1
        permit.auth_oauth_attempt = private_attempt
        permit.auth_claimed_at = self.instant
        permit.save(update_fields=['auth_app_attempt', 'auth_oauth_attempt', 'auth_claimed_at'])
        MesCreateDiagnosticEvent.objects.create(request=self.req, state='auth_reserved',
            evidence={'oauth_attempt_id': private_attempt, 'app_attempt': 1})
        data = self.read_without_writes()
        self.assertIs(data['can_reconnect'], False)
        encoded = encode_exact_json(data).decode()
        self.assertNotIn(private_attempt, encoded)
        self.assertNotIn(permit.snapshot_digest, encoded)
        self.assert_no_dispatch()

    def test_prepare_needs_normal_wj_login_but_not_a_stored_user_connection(self):
        data = self.prepare()
        self.assertEqual((self.req.state, self.req.attempt), ('prepared', 0))
        self.assertIs(data['approval']['active'], True)
        self.assertIs(data['can_send'], False)
        self.assertFalse(MESCredential.objects.exists())
        self.assertFalse(MESCredentialEvent.objects.exists())
        self.assert_no_dispatch()

    def test_prepare_accepts_current_authority_without_rewriting_old_user_lease(self):
        self.store_user()
        before = list(MESCredential.objects.values())
        events = MESCredentialEvent.objects.count()
        # A new permission definition changes a superuser's authorization
        # fingerprint without invoking the group/profile revocation signals.
        # Register a separate current WJ login; never revive the old family or
        # update its encrypted USER lease to make this synthetic case pass.
        Permission.objects.create(
            content_type=ContentType.objects.get_for_model(MesCreateDiagnostic),
            codename='synthetic_exact_diagnostic_authority', name='SYNTHETIC changed authority',
        )
        self.user = get_user_model().objects.get(pk=self.user.pk)
        self.assertNotEqual(before[0]['authorization_digest'], vault.authorization_digest(self.user))
        sid = 'N' * 43
        self.login = self.make_login(self.user, vault.digest('client-login', sid))
        self.authenticate(sid=sid)
        data = self.prepare()
        self.assertIs(data['approval']['active'], True)
        self.assertIs(data['can_send'], False)
        self.assertEqual(list(MESCredential.objects.values()), before)
        self.assertEqual(MESCredentialEvent.objects.count(), events)
        self.assert_no_dispatch()

    def test_prepare_is_idempotent_and_does_not_extend_approval_or_add_events(self):
        first = self.prepare()
        events = MesCreateDiagnosticEvent.objects.count()
        self.instant += timedelta(minutes=2)
        self.authenticate()
        second = self.prepare()
        self.assertEqual(second['request_uid'], first['request_uid'])
        self.assertEqual(second['approval'], first['approval'])
        self.assertEqual(MesCreateDiagnostic.objects.count(), 1)
        self.assertEqual(MesCreateDiagnosticEvent.objects.count(), events)
        self.assert_no_dispatch()

    def test_expired_approval_cannot_be_reactivated_or_extended(self):
        first = self.prepare()
        self.instant += timedelta(minutes=31)
        self.authenticate()
        response = self.post('prepare')
        self.assertIn(response.status_code, (200, 409), response.data)
        current = self.read_without_writes()
        self.assertEqual(current['request_uid'], first['request_uid'])
        self.assertEqual(current['approval']['approved_at'], first['approval']['approved_at'])
        self.assertEqual(current['approval']['expires_at'], first['approval']['expires_at'])
        self.assertIs(current['approval']['active'], False)
        self.assertIs(current['approval']['expired'], True)
        self.assertIs(current['can_prepare'], False)
        self.assertIs(current['can_send'], False)
        self.assertEqual(MesCreateDiagnostic.objects.count(), 1)
        self.assert_no_dispatch()

    def test_wrong_actor_and_pilot_claim_cannot_prepare_or_seed(self):
        sid = 'O' * 43
        self.make_login(self.other, vault.digest('client-login', sid))
        self.authenticate(self.other, sid=sid)
        self.assertIn(self.post('prepare').status_code, (401, 403))
        self.authenticate(extra={PILOT_SCOPE_CLAIM: True})
        self.assertIn(self.post('prepare').status_code, (401, 403))
        self.assertFalse(MesCreateDiagnostic.objects.exists())
        self.assertFalse(MesCreateDiagnosticEvent.objects.exists())
        self.assert_no_dispatch()

    def test_inactive_or_non_superuser_cannot_prepare_with_an_otherwise_current_login(self):
        for field in ('is_superuser', 'is_active'):
            with self.subTest(field=field):
                setattr(self.user, field, False)
                self.user.save(update_fields=[field])
                self.user = get_user_model().objects.get(pk=self.user.pk)
                self.login.authorization_digest = vault.authorization_digest(self.user)
                self.login.save(update_fields=['authorization_digest'])
                self.authenticate()
                self.assertIn(self.post('prepare').status_code, (401, 403))
                setattr(self.user, field, True)
                self.user.save(update_fields=[field])
                self.user = get_user_model().objects.get(pk=self.user.pk)
                self.login.authorization_digest = vault.authorization_digest(self.user)
                self.login.save(update_fields=['authorization_digest'])
                self.authenticate()
        self.assertFalse(MesCreateDiagnostic.objects.exists())
        self.assert_no_dispatch()

    def test_legacy_or_unregistered_login_cannot_get_or_prepare(self):
        self.token.payload.pop('mes_session_v')
        self.api.credentials(HTTP_AUTHORIZATION='Bearer ' + str(self.token))
        self.assertIn(self.api.get(URL, secure=True).status_code, (401, 403))
        self.assertIn(self.post('prepare').status_code, (401, 403))
        self.authenticate()
        self.login.delete()
        self.assertIn(self.api.get(URL, secure=True).status_code, (401, 403))
        self.assertIn(self.post('prepare').status_code, (401, 403))
        self.assertFalse(MesCreateDiagnostic.objects.exists())
        self.assert_no_dispatch()

    def test_client_scope_payload_actor_and_approval_injection_are_rejected(self):
        cases = [
            [], {'action': True},
            {'action': 'prepare', 'payload': diagnostic.PAYLOAD},
            {'action': 'prepare', 'actor_id': diagnostic.ACTOR_ID},
            {'action': 'prepare', 'tenant_reference': 'SYNTHETIC-OTHER'},
            {'action': 'prepare', 'expires_at': (self.instant + timedelta(hours=1)).isoformat()},
            {'action': 'prepare', 'app_budget': 99},
            {'action': 'send'}, {'action': 'recheck'},
            {'action': 'send', 'request_uid': str(uuid.uuid4()), 'quantity': '2'},
            {'action': 'recheck', 'request_uid': str(uuid.uuid4()), 'read_only': False},
            {'action': 'unknown'},
        ]
        for payload in cases:
            with self.subTest(payload=payload):
                response = self.api.post(URL, payload, format='json', secure=True)
                self.assertEqual(response.status_code, 400, response.data)
        self.assertFalse(MesCreateDiagnostic.objects.exists())
        self.assert_no_dispatch()

    def test_real_broker_send_is_once_and_second_send_is_permanently_blocked(self):
        self.store_user()
        prepared = self.prepare()
        response = self.post('send', request_uid=prepared['request_uid'])
        self.assertEqual(response.status_code, 200, response.data)
        self.assert_envelope(response.data)
        self.assertEqual(response.data['state'], 'draft_observed')
        self.assertEqual(response.data['attempt'], 1)
        self.assertIs(response.data['can_send'], False)
        self.assertEqual(len(self.identity_sessions), 3)
        self.assertEqual(sum(path == diagnostic.CREATE_PATH for path, _ in self.calls), 1)
        repeated = self.post('send', request_uid=prepared['request_uid'])
        self.assertIn(repeated.status_code, (400, 409), repeated.data)
        self.assertEqual(len(self.identity_sessions), 3)
        self.assertEqual(sum(path == diagnostic.CREATE_PATH for path, _ in self.calls), 1)
        self.assertIs(self.read_without_writes()['can_send'], False)

    def test_existing_app_disappearing_before_send_is_a_safe_conflict_without_reservation(self):
        self.store_user()
        prepared = self.prepare()
        with patch('mes_oauth.app_tokens.get_existing_app_access_token',
                   side_effect=AppCredentialUnavailable('app_credential_existing_supply_unavailable')):
            response = self.post('send', request_uid=prepared['request_uid'])
        self.assertEqual(response.status_code, 409, response.data)
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('prepared', 0))
        self.assertFalse(self.req.events.filter(state='sending').exists())
        self.assert_no_dispatch()

    def test_save_identity_rejection_preserves_attempt_without_any_mes_create(self):
        self.store_user()
        prepared = self.prepare()
        self.identity_ids = [int(diagnostic.MES_USER_ID), int(diagnostic.MES_USER_ID) + 1]
        response = self.post('send', request_uid=prepared['request_uid'])
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data['state'], response.data['attempt']), ('uncertain', 1))
        self.assertIs(response.data['can_send'], False)
        self.assertFalse(any(path == diagnostic.CREATE_PATH for path, _ in self.calls))
        self.assertIsNotNone(MESCredential.objects.get(pk=self.user.pk).revoked_at)
        repeated = self.post('send', request_uid=prepared['request_uid'])
        self.assertIn(repeated.status_code, (400, 409), repeated.data)
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('uncertain', 1))

    def test_lost_acknowledgement_rechecks_without_a_second_create(self):
        self.store_user()
        prepared = self.prepare()
        self.timeout = True
        response = self.post('send', request_uid=prepared['request_uid'])
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual((response.data['state'], response.data['attempt']), ('uncertain', 1))
        self.assertIs(response.data['can_send'], False)
        self.assertIs(response.data['can_recheck'], True)
        observed = self.post('recheck', request_uid=prepared['request_uid'])
        self.assertEqual(observed.status_code, 200, observed.data)
        self.assertEqual((observed.data['state'], observed.data['attempt']), ('draft_observed', 1))
        self.assertIs(observed.data['can_send'], False)
        self.assertEqual(sum(path == diagnostic.CREATE_PATH for path, _ in self.calls), 1)
        self.assertEqual(len(self.identity_sessions), 3)
