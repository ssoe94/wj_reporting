"""Real workflow credential admission with synthetic HTTP and disposable data.

The vault, signed login guard, credential broker and single-use OAuth client run
unchanged. Only provider HTTP and application-token issuance are intercepted.
No project settings, stored production credential or real network is read.
"""
from datetime import date, timedelta
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TransactionTestCase, override_settings
from django.utils.dateparse import parse_datetime
from rest_framework_simplejwt.tokens import AccessToken

from mes_oauth import vault
from mes_oauth.app_tokens import AppCredentialUnavailable
from mes_oauth.client import USERINFO
from mes_oauth.identity import VerifiedUserContext
from mes_oauth.models import MESCredential
from mes_oauth.session_guard import InspectionSession
from mes_oauth.test_oauth import synthetic_session
from mes_oauth.test_vault import VaultFixture, LOGIN_SID, TOKEN
from . import mes_create_diagnostic as diagnostic
from .mes_execution_contract import encode_exact_json
from .models import MesCreateDiagnosticPermit
from .plan_workflow import WorkflowConflict
from . import test_mes_create_diagnostic as diagnostic_fixture
from . import test_plan_workflow_transport as transport_fixture


TENANT_REFERENCE = 'SYNTHETIC-TENANT'


class PlanWorkflowCredentialTests(VaultFixture, TransactionTestCase):
    """Exercise the real broker, rather than returning a lease from a mock."""

    def setUp(self):
        # Reuse the existing vault's synthetic encryption/login settings while
        # preserving the diagnostic's exact actor and MES-user restrictions.
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
        self.store(context=VerifiedUserContext(int(diagnostic.MES_USER_ID), TOKEN, 1200))
        token = AccessToken.for_user(self.user)
        token['mes_sid'] = LOGIN_SID
        token['mes_login_exp'] = int(self.login.expires_at.timestamp())
        self.session = InspectionSession.from_token(self.user, token)
        self.req = diagnostic.prepare_diagnostic(self.user)
        self.approval = {
            'reference': diagnostic.APPROVAL_REFERENCE,
            'request_uid': str(self.req.uid), 'payload_digest': diagnostic.PAYLOAD_DIGEST,
            'code': diagnostic.CODE, 'actor_id': diagnostic.ACTOR_ID,
            'mes_user_id': diagnostic.MES_USER_ID, 'origin': diagnostic.ORIGIN,
            'tenant': diagnostic.TENANT, 'tenant_reference': TENANT_REFERENCE,
            'approved_at': (self.instant - timedelta(seconds=1)).isoformat(),
            'expires_at': (self.instant + timedelta(minutes=20)).isoformat(),
            'max_attempts': 1, 'accept_unknown_common_automation': True,
            'preserve_draft': True, 'read_scope': 'exact_order_and_code0_effect_window',
        }
        MesCreateDiagnosticPermit.objects.create(request=self.req, snapshot=self.approval,
            snapshot_digest=diagnostic.digest(self.approval), approved_at=parse_datetime(self.approval['approved_at']),
            expires_at=parse_datetime(self.approval['expires_at']))
        self.identity_ids = []
        self.identity_sessions = []
        self.calls = []
        self.created = False
        self.timeout = False
        self.denied = ''
        self.inventory, self.qc, self.tasks, self.changes = [], [], [], []
        WORK_ID = diagnostic_fixture.WORK_ID
        self.base = {
            'id': int(WORK_ID), 'code': diagnostic.CODE, 'identifier': diagnostic.CODE,
            'externalOrderCode': diagnostic.CODE, 'status': {'code': 0},
            'plannedStartTime': diagnostic.PAYLOAD['planStartTime'],
            'plannedFinishTime': diagnostic.PAYLOAD['planFinishTime'],
            'updatedAt': diagnostic.PAYLOAD['planStartTime'],
            'actualStartTime': None, 'resource': None, 'bomId': None,
        }
        self.output = {
            'materialId': int(diagnostic.MATERIAL_ID),
            'material': {'baseInfo': {'code': '0'}}, 'main': 1,
            'unitName': '个', 'plannedAmount': {'amount': 1, 'unitName': '个'},
            'processRouteCode': None, 'outputProcessSimpleVO': None,
        }
        self.inputs = []
        self.processes = {'processes': [], 'relations': [], 'originalProcessRoute': None}
        gates = override_settings(
            MES_INSPECTION_ENABLED=True, INSPECTION_PILOT_ENABLED=False,
            INSPECTION_PILOT_USER_IDS=[], MES_USER_OAUTH_APP_TOKEN_SOURCE='static',
        )
        gates.enable()
        self.addCleanup(gates.disable)
        # VaultFixture freezes Django time. Provider leases and observation
        # windows use epoch seconds, so keep that clock on the same instant.
        epoch = patch('time.time', return_value=self.instant.timestamp())
        epoch.start()
        self.addCleanup(epoch.stop)
        sessions = patch('mes_oauth.client.requests.Session', side_effect=self.oauth_session)
        sessions.start()
        self.addCleanup(sessions.stop)
        self.issuers = []
        for name in ('mes_oauth.app_tokens.get_app_access_token',
                     'mes_oauth.inspection_credentials.get_app_access_token',
                     'mes_oauth.app_tokens.AppTokenSupplier._issue'):
            guard = patch(name, side_effect=AssertionError('New APP issuance forbidden.'))
            blocked = guard.start()
            self.issuers.append(blocked)
            self.addCleanup(guard.stop)
            self.addCleanup(blocked.assert_not_called)

    def oauth_session(self):
        index = len(self.identity_sessions)
        user_id = self.identity_ids[index] if index < len(self.identity_ids) else int(diagnostic.MES_USER_ID)
        session = synthetic_session(encode_exact_json({'code': 200, 'data': {'userId': user_id}}))
        original = session.post.return_value

        def post(url, **kwargs):
            self.assertTrue(url.endswith(USERINFO), 'Only current-user identity reads are allowed.')
            self.assertEqual(kwargs['json'], {'userAccessToken': TOKEN})
            self.assertFalse(kwargs['allow_redirects'])
            return original

        session.post.side_effect = post
        self.identity_sessions.append(session)
        return session

    # Reuse response bytes and strict exact-code/read scope assertions. This
    # method does not import DiagnosticTests.setUp or its mocked broker/policy.
    sender = diagnostic_fixture.DiagnosticTests.sender

    def execute(self, **kwargs):
        return diagnostic.run_for_session(self.req.uid, self.session, sender=self.sender, **kwargs)

    def assert_prepared(self):
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('prepared', 0))
        self.assertFalse(self.req.events.filter(state='sending').exists())
        self.assertFalse(any(path == diagnostic.CREATE_PATH for path, _ in self.calls))

    def test_real_broker_creates_once_and_rechecks_identity_for_each_stage(self):
        result = self.execute()
        self.assertEqual(result['state'], 'draft_observed')
        self.assertEqual(result['quantity'], '1')
        self.assertFalse(result['full_material_workflow_verified'])
        self.assertEqual(len(self.identity_sessions), 3)
        self.assertTrue(all(session.post.call_count == 1 for session in self.identity_sessions))
        self.assertEqual(len(self.calls), 15)
        self.assertEqual(sum(path == diagnostic.CREATE_PATH for path, _ in self.calls), 1)
        sending = self.req.events.get(state='sending')
        self.assertEqual(sending.evidence['tenant_reference'], TENANT_REFERENCE)
        with self.assertRaises(WorkflowConflict):
            self.execute()
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('draft_observed', 1))
        self.assertEqual(len(self.identity_sessions), 3)
        self.assertEqual(len(self.calls), 15)

    def test_reviewed_tenant_reference_mismatch_never_acquires_or_reserves(self):
        snapshot = {**self.approval, 'tenant_reference': 'SYNTHETIC-OTHER-TENANT'}
        MesCreateDiagnosticPermit.objects.filter(request=self.req).update(
            snapshot=snapshot, snapshot_digest=diagnostic.digest(snapshot))
        with self.assertRaises(WorkflowConflict):
            self.execute()
        self.assert_prepared()
        self.assertEqual(self.identity_sessions, [])
        self.assertEqual(self.calls, [])

    def test_missing_existing_app_never_issues_or_reserves(self):
        with patch('mes_oauth.app_tokens.get_existing_app_access_token',
                   side_effect=AppCredentialUnavailable('app_credential_existing_supply_unavailable')) as supply:
            with self.assertRaises(AppCredentialUnavailable):
                self.execute()
        supply.assert_called_once()
        self.assert_prepared()
        self.assertEqual(self.identity_sessions, [])
        self.assertEqual(self.calls, [])

    def test_provider_factory_returning_none_cannot_enter_issuing_fallback(self):
        with self.assertRaises((WorkflowConflict, AppCredentialUnavailable, vault.VaultBlocked)):
            self.execute(provider_factory=lambda *args, **kwargs: None)
        self.assert_prepared()
        self.assertEqual(self.identity_sessions, [])
        self.assertEqual(self.calls, [])

    def test_identity_mismatch_revokes_before_reservation_or_mes_calls(self):
        self.identity_ids = [int(diagnostic.MES_USER_ID) + 1]
        with self.assertRaises(vault.VaultBlocked):
            self.execute()
        self.assert_prepared()
        row = MESCredential.objects.get(pk=diagnostic.ACTOR_ID)
        self.assertIsNotNone(row.revoked_at)
        self.assertEqual(bytes(row.ciphertext), b'')
        self.assertEqual(len(self.identity_sessions), 1)
        self.assertEqual(self.calls, [])

    def test_save_identity_mismatch_preserves_committed_fence_without_creation(self):
        self.identity_ids = [int(diagnostic.MES_USER_ID), int(diagnostic.MES_USER_ID) + 1]
        result = self.execute()
        self.assertEqual(result['state'], 'uncertain')
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('uncertain', 1))
        self.assertEqual(len(self.identity_sessions), 2)
        self.assertEqual(len(self.calls), 3)
        self.assertFalse(self.created)
        self.assertIsNotNone(MESCredential.objects.get(pk=diagnostic.ACTOR_ID).revoked_at)
        with self.assertRaises(WorkflowConflict):
            self.execute()
        with self.assertRaises(vault.VaultBlocked):
            self.execute(read_only=True)
        self.assertEqual(len(self.identity_sessions), 2)
        self.assertEqual(len(self.calls), 3)

    def test_lost_acknowledgement_uses_read_only_recovery_without_second_create(self):
        self.timeout = True
        self.assertEqual(self.execute()['state'], 'uncertain')
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('uncertain', 1))
        self.assertEqual(len(self.identity_sessions), 2)
        self.assertEqual(len(self.calls), 5)
        with self.assertRaises(WorkflowConflict):
            self.execute()
        MesCreateDiagnosticPermit.objects.filter(request=self.req).delete()
        self.assertEqual(self.execute(read_only=True)['state'], 'draft_observed')
        self.assertEqual(len(self.identity_sessions), 3)
        self.assertEqual(len(self.calls), 15)
        self.assertEqual(sum(path == diagnostic.CREATE_PATH for path, _ in self.calls), 1)

    def prepare_plan_trial(self):
        from django.db import transaction
        from .models import PlanWorkflowLock, PlanMesRequest
        from .plan_workflow import approve_materials, lock_type, prepare, preview
        from .test_plan_workflow import seed_catalog, new_plan, approval_data, reviewed

        for plan_type in ('injection', 'machining'):
            PlanWorkflowLock.objects.get_or_create(plan_type=plan_type)
        seed_catalog()
        plan = new_plan(actor=self.user)
        with transaction.atomic():
            lock_type('injection')
            approve_materials(plan, approval_data(plan), self.user)
        day = date(2026, 10, 8)
        groups = preview(day, day, 'injection')
        configuration = override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(groups))
        configuration.enable()
        self.addCleanup(configuration.disable)
        from .plan_workflow_contract import build_legacy_contract
        prepared = prepare(day, day, 'injection', [groups[0]['key']], self.user,
            contract_builder=build_legacy_contract)[0]
        req = PlanMesRequest.objects.select_related('work_order').get(uid=prepared['uid'])
        return req

    def test_real_plan_trial_uses_fresh_identity_client_for_both_leases(self):
        from .plan_workflow_trial import dispatch_trial_create, request_digest, EFFECTS
        from .plan_workflow_transport import CREATE_PATH, READ_ROUTES, ROUTE_BASE
        from .mes_execution_contract import parse_json_exact

        req = self.prepare_plan_trial()
        responses = transport_fixture.bodies(req)
        review = {
            'reference': 'SYNTHETIC-REAL-BROKER-PLAN-TRIAL', 'request_uid': str(req.uid),
            'request_digest': request_digest(req), 'actor_id': self.user.pk,
            'mes_user_id': int(diagnostic.MES_USER_ID), 'origin': diagnostic.ORIGIN,
            'tenant': TENANT_REFERENCE, 'approved_at': self.instant.isoformat(),
            'expires_at': (self.instant + timedelta(minutes=10)).isoformat(),
            'test_master_reference': 'SYNTHETIC-TEST-MASTERS',
            'side_effect_reference': 'SYNTHETIC-REVIEWED-EFFECTS',
            'test_resource_code': req.intent['setup']['resource_code'],
            'test_product_code': req.intent['part_no'], 'quantity': req.intent['quantity'],
            'unit_id': req.intent['setup']['output_unit_id'], **{key: True for key in EFFECTS},
        }

        def sender(url, **kwargs):
            route = url.split(ROUTE_BASE)[1]
            payload = parse_json_exact(kwargs['data'])
            self.calls.append((route, payload))
            if route == CREATE_PATH:
                return transport_fixture.response({'code': 200, 'needCheck': 0,
                    'data': {'id': int(transport_fixture.WORK_ID)}})
            action = next(key for key, path in READ_ROUTES.items() if path == route)
            return transport_fixture.response(responses[action])

        with override_settings(MES_PLAN_TRIAL_APPROVAL=review):
            result = dispatch_trial_create(req.uid, self.session, sender=sender)
            self.assertEqual(result['state'], 'confirmed')
            self.assertEqual(result['verified_scope'], 'creation_snapshot')
            self.assertFalse(result['production_totals_verified'])
            self.assertEqual(len(self.identity_sessions), 2)
            self.assertTrue(all(session.post.call_count == 1 for session in self.identity_sessions))
            self.assertEqual(sum(path == CREATE_PATH for path, _ in self.calls), 1)
            calls_before = list(self.calls)
            with self.assertRaises(WorkflowConflict):
                dispatch_trial_create(req.uid, self.session, sender=sender)
            self.assertEqual(self.calls, calls_before)
            self.assertEqual(len(self.identity_sessions), 2)
        req.refresh_from_db()
        self.assertEqual(req.attempt, 1)

    def test_creation_recheck_missing_existing_app_stops_before_broker_fallback(self):
        from .plan_workflow_transport import recheck_creation_for_session

        req = self.prepare_plan_trial()
        req.state, req.attempt = 'uncertain', 1
        req.save(update_fields=['state', 'attempt'])
        with patch('mes_oauth.app_tokens.get_existing_app_access_token',
                   side_effect=AppCredentialUnavailable('app_credential_existing_supply_unavailable')) as supply:
            result = recheck_creation_for_session(req.uid, self.session, sender=self.sender)
        supply.assert_called_once()
        self.assertEqual(result['state'], 'uncertain')
        self.assertTrue(result['blockers'])
        req.refresh_from_db()
        self.assertEqual((req.state, req.attempt), ('uncertain', 1))
        self.assertEqual(self.identity_sessions, [])
        self.assertEqual(self.calls, [])
