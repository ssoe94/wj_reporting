"""Synthetic inspector/session regressions; no provider or business database."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from contextlib import contextmanager
from threading import Event
from unittest import skipUnless
from unittest.mock import patch
import uuid

from django.contrib.auth import get_user_model
from django.db import connection, connections, transaction
from django.test import TransactionTestCase, override_settings
from django.urls import reverse
from rest_framework.test import APIClient, APITestCase
from rest_framework_simplejwt.tokens import AccessToken

from config.token_views import ScopedTokenObtainPairSerializer
from quality import test_inspection_requests as helpers
from quality.inspection_models import InspectionAudit, InspectionOperation, InspectionRequest
from quality.inspection_workflow import external_action
from . import vault
from .models import MESLoginSession
from .session_guard import InspectionSession, LoginRejected, login_identity


class InspectorFixture:
    base_url = helpers.InspectionRequestContractTests.base_url
    make_user = helpers.InspectionRequestContractTests.make_user
    create_payload = helpers.InspectionRequestContractTests.create_payload
    draft_payload = helpers.InspectionRequestContractTests.draft_payload
    post = helpers.InspectionRequestContractTests.post
    create = helpers.InspectionRequestContractTests.create
    draft = helpers.InspectionRequestContractTests.draft
    action = helpers.InspectionRequestContractTests.action
    approved = helpers.InspectionRequestContractTests.approved
    adapter_patch = helpers.InspectionRequestContractTests.adapter_patch

    def setUp(self):
        self.client = APIClient()
        helpers.InspectionRequestContractTests.setUp(self)
        adapter = self.adapter_patch()
        adapter.start()
        self.addCleanup(adapter.stop)

    def revoke(self, actor=None):
        actor = actor or self.editor
        digest, expiry = login_identity(helpers.synthetic_token(actor))
        vault.revoke_actor(actor.pk, login_digest=digest, login_expires_at=expiry, reason='logout')

    def direct_sync(self, data):
        return external_action(self.editor, data['id'], 'sync', uuid.uuid4(),
            {'version': data['version']}, session=helpers.inspection_session(self.editor))


class InspectorSessionTests(InspectorFixture, APITestCase):
    def test_legacy_token_can_read_but_cannot_create_new_inspection(self):
        client = APIClient()
        legacy = AccessToken.for_user(self.editor)
        client.credentials(HTTP_AUTHORIZATION='Bearer ' + str(legacy))
        self.assertEqual(client.get(self.base_url).status_code, 200)
        response = client.post(self.base_url, self.create_payload(), format='json',
                               HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 401)
        self.assertEqual(InspectionRequest.objects.count(), 0)
        self.assertEqual(MESLoginSession.objects.count(), 0)

    def test_logout_tombstone_rejects_never_used_login_for_local_draft(self):
        self.revoke()
        response = self.post(data=self.create_payload())
        self.assertIn(response.status_code, (401, 403))
        self.assertEqual(InspectionRequest.objects.count(), 0)
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)
        self.assertEqual(self.adapter.save_calls, [])

    def test_old_tab_cannot_patch_or_submit_after_logout_new_login_is_distinct(self):
        data = self.create()
        self.revoke()
        old = self.action(data, 'submit')
        self.assertIn(old.status_code, (401, 403))
        old_draft = self.client.patch(self.base_url + f'{data["id"]}/', self.draft_payload(data['version']),
                                     format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertIn(old_draft.status_code, (401, 403))
        self.assertEqual(InspectionRequest.objects.get(pk=data['id']).version, data['version'])
        fresh = ScopedTokenObtainPairSerializer.get_token(self.editor).access_token
        client = APIClient()
        client.force_authenticate(self.editor, token=fresh)
        response = client.patch(self.base_url + f'{data["id"]}/', self.draft_payload(data['version']),
                                format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['assigned_to'], self.editor.pk)
        self.assertEqual(InspectionAudit.objects.latest('id').actor_id, self.editor.pk)

    def test_fresh_actor_permissions_ignore_stale_force_authenticated_user(self):
        get_user_model().objects.filter(pk=self.editor.pk).update(is_superuser=False)
        response = self.post(data=self.create_payload())
        self.assertEqual(response.status_code, 403)
        self.assertEqual(InspectionRequest.objects.count(), 0)

    def test_claim_actor_mismatch_and_unsigned_claim_dictionary_are_rejected(self):
        token = helpers.synthetic_token(self.editor)
        for user, value in ((self.reviewer, token), (self.editor, dict(token.payload))):
            with self.subTest(signed=isinstance(value, AccessToken)):
                with self.assertRaises(LoginRejected):
                    InspectionSession.from_token(user, value)

    def test_revision_and_mapping_change_reject_admitted_context(self):
        for mutation in ('disconnect', 'mapping'):
            session = helpers.inspection_session(self.editor)
            with session.lock('manage', actor_id=self.editor.pk):
                pass
            if mutation == 'disconnect':
                vault.revoke_actor(self.editor.pk, login_digest=session.login_digest, revoke_login=False)
                with self.assertRaises(LoginRejected):
                    with session.lock('manage', actor_id=self.editor.pk):
                        pass
            else:
                with override_settings(MES_USER_OAUTH_USER_MAP={str(self.editor.pk): '92000000000000001'}):
                    with self.assertRaises(LoginRejected):
                        with session.lock('manage', actor_id=self.editor.pk):
                            pass

    def test_logout_between_committed_reservation_and_dispatch_makes_no_adapter_call(self):
        data = self.approved()
        original = InspectionSession.lock
        entered = 0

        @contextmanager
        def interrupted(session, *args, **kwargs):
            nonlocal entered
            entered += 1
            if entered == 2:
                self.revoke()
            with original(session, *args, **kwargs) as actor:
                yield actor

        with patch.object(InspectionSession, 'lock', interrupted):
            response, status = self.direct_sync(data)
        self.assertEqual(status, 403)
        self.assertEqual(response['code'], 'inspection_login_changed')
        self.assertEqual(self.adapter.refresh_calls, [])
        self.assertEqual(self.adapter.save_calls, [])
        op = InspectionOperation.objects.filter(scope__endswith=':sync').get()
        self.assertEqual(op.status, 'blocked')
        self.assertEqual(InspectionAudit.objects.latest('id').actor_id, self.editor.pk)

    @override_settings(MES_USER_FRONTEND_ORIGIN='https://testserver',
                       SESSION_COOKIE_SECURE=True, CSRF_COOKIE_SECURE=True)
    def test_real_logout_rejects_rotated_family_access_and_refresh(self):
        refresh = ScopedTokenObtainPairSerializer.get_token(self.editor)
        first_access = str(refresh.access_token)
        client = APIClient()
        rotated = client.post(reverse('token_refresh'), {'refresh': str(refresh)}, format='json')
        self.assertEqual(rotated.status_code, 200)
        client.credentials(HTTP_AUTHORIZATION='Bearer ' + first_access)
        logout = client.post(reverse('mes-connection-logout'), {}, format='json', secure=True,
                             HTTP_ORIGIN='https://testserver')
        self.assertEqual(logout.status_code, 200)
        client.credentials(HTTP_AUTHORIZATION='Bearer ' + rotated.data['access'])
        self.assertEqual(client.get(self.base_url).status_code, 401)
        client.credentials()
        response = client.post(reverse('token_refresh'), {'refresh': rotated.data['refresh']}, format='json')
        self.assertEqual(response.status_code, 401)

    def test_same_actor_new_login_replays_unknown_without_redispatch_or_new_key_bypass(self):
        data = self.approved()
        key = uuid.uuid4()
        self.adapter.save_mode = 'timeout_after_commit'
        failed = self.action(data, 'sync', key=key)
        self.assertEqual(failed.status_code, 503)
        self.revoke()
        client = APIClient()
        client.force_authenticate(self.editor,
            token=ScopedTokenObtainPairSerializer.get_token(self.editor).access_token)
        current = client.get(self.base_url + f'{data["id"]}/')
        self.assertEqual(current.status_code, 200)
        replay = client.post(self.base_url + f'{data["id"]}/sync/',
            {'version': data['version']}, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(replay.status_code, 503)
        self.assertEqual(replay.data, failed.data)
        denied = client.post(self.base_url + f'{data["id"]}/sync/',
            {'version': current.data['version']}, format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(denied.status_code, 409)
        self.assertEqual(str(denied.data['code']), 'reconciliation_required')
        self.assertEqual(len(self.adapter.save_calls), 1)

    def test_same_actor_new_login_replays_create_key_without_duplicate(self):
        key, payload = uuid.uuid4(), self.create_payload()
        created = self.post(data=payload, key=key)
        self.assertEqual(created.status_code, 201)
        self.revoke()
        client = APIClient()
        client.force_authenticate(self.editor,
            token=ScopedTokenObtainPairSerializer.get_token(self.editor).access_token)
        replay = client.post(self.base_url, payload, format='json', HTTP_IDEMPOTENCY_KEY=str(key))
        self.assertEqual(replay.status_code, 201)
        self.assertEqual(replay.data['id'], created.data['id'])
        self.assertEqual(InspectionRequest.objects.count(), 1)
        self.assertEqual(InspectionAudit.objects.count(), 1)


@skipUnless(connection.vendor == 'postgresql', 'Row-lock ordering requires PostgreSQL.')
class InspectorSessionConcurrencyTests(InspectorFixture, TransactionTestCase):
    def worker(self, callback):
        connections.close_all()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '10000ms'")
                cursor.execute("SET lock_timeout = '5000ms'")
            return callback()
        finally:
            connections.close_all()

    def test_logout_wins_actor_lock_before_inspection_admission(self):
        locked, release, waiting = Event(), Event(), Event()

        def logout():
            with transaction.atomic():
                get_user_model().objects.select_for_update().get(pk=self.editor.pk)
                self.revoke()
                locked.set()
                if not release.wait(5):
                    raise AssertionError('Synthetic logout release timed out.')

        def mutation():
            waiting.set()
            client = APIClient()
            client.force_authenticate(self.editor, token=helpers.synthetic_token(self.editor))
            return client.post(self.base_url, self.create_payload(), format='json',
                               HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))

        with ThreadPoolExecutor(max_workers=2) as pool:
            logout_future = pool.submit(self.worker, logout)
            try:
                self.assertTrue(locked.wait(5))
                mutation_future = pool.submit(self.worker, mutation)
                self.assertTrue(waiting.wait(5))
                with self.assertRaises(TimeoutError):
                    mutation_future.result(timeout=0.2)
            finally:
                release.set()
            logout_future.result(timeout=10)
            self.assertIn(mutation_future.result(timeout=10).status_code, (401, 403))
        self.assertEqual(InspectionRequest.objects.count(), 0)

    def test_inflight_dispatch_holds_logout_and_preserves_unknown_original_actor(self):
        data = self.approved()
        entered, release, logout_entered = Event(), Event(), Event()
        self.adapter.save_mode = 'timeout_after_commit'

        def held_save(request, operation):
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic dispatch release timed out.')

        def logout():
            logout_entered.set()
            self.revoke()

        self.adapter.on_save = held_save
        with ThreadPoolExecutor(max_workers=2) as pool:
            dispatch = pool.submit(self.worker, lambda: self.direct_sync(data))
            try:
                self.assertTrue(entered.wait(5))
                logout_future = pool.submit(self.worker, logout)
                self.assertTrue(logout_entered.wait(5))
                with self.assertRaises(TimeoutError):
                    logout_future.result(timeout=0.2)
            finally:
                release.set()
            response, status = dispatch.result(timeout=10)
            logout_future.result(timeout=10)
        self.assertEqual(status, 503)
        self.assertEqual(response['code'], 'mes_outcome_unknown')
        self.assertEqual(len(self.adapter.save_calls), 1)
        self.assertEqual(InspectionOperation.objects.filter(scope__endswith=':sync').get().status, 'unknown')
        self.assertEqual(InspectionAudit.objects.latest('id').actor_id, self.editor.pk)
        self.assertIsNotNone(MESLoginSession.objects.get(actor_id=self.editor.pk).revoked_at)
        with self.assertRaises(LoginRejected):
            self.direct_sync(response['request'])
        self.assertEqual(len(self.adapter.save_calls), 1)

    def test_refresh_waits_for_logout_then_rejects_same_family(self):
        token = ScopedTokenObtainPairSerializer.get_token(self.editor)
        digest, expiry = login_identity(token)
        locked, release, waiting = Event(), Event(), Event()

        def logout():
            with transaction.atomic():
                get_user_model().objects.select_for_update().get(pk=self.editor.pk)
                vault.revoke_actor(self.editor.pk, login_digest=digest, login_expires_at=expiry, reason='logout')
                locked.set()
                if not release.wait(5):
                    raise AssertionError('Synthetic logout release timed out.')

        def refresh():
            waiting.set()
            return APIClient().post(reverse('token_refresh'), {'refresh': str(token)}, format='json')

        with ThreadPoolExecutor(max_workers=2) as pool:
            logout_future = pool.submit(self.worker, logout)
            try:
                self.assertTrue(locked.wait(5))
                refresh_future = pool.submit(self.worker, refresh)
                self.assertTrue(waiting.wait(5))
                with self.assertRaises(TimeoutError):
                    refresh_future.result(timeout=0.2)
            finally:
                release.set()
            logout_future.result(timeout=10)
            self.assertEqual(refresh_future.result(timeout=10).status_code, 401)


@skipUnless(connection.vendor == 'postgresql', 'Separate MES stage locks require PostgreSQL.')
class InspectorStageSessionConcurrencyTests(InspectorFixture, TransactionTestCase):
    worker = InspectorSessionConcurrencyTests.worker

    def setUp(self):
        from quality.test_inspection_mes_stages import InspectionMesStageTests
        self.client = APIClient()
        InspectionMesStageTests.setUp(self)

    def dispatch(self, data, action):
        from quality.inspection_mes_stages import stage_action
        return stage_action(self.editor, data['id'], action, uuid.uuid4(),
            {'version': data['version']}, session=helpers.inspection_session(self.editor))

    def _assert_stage_holds_logout(self, action):
        entered, release, logout_entered = Event(), Event(), Event()
        data = self.data
        if action == 'mes-finish':
            data, status = self.dispatch(data, 'mes-save')
            self.assertEqual(status, 200)
        method_name = 'save' if action == 'mes-save' else 'finish_inspection'
        original = getattr(self.stage, method_name)

        def held_dispatch(*args):
            entered.set()
            if not release.wait(5):
                raise AssertionError('Synthetic stage release timed out.')
            return original(*args)

        def logout():
            logout_entered.set()
            self.revoke()

        with patch.object(self.stage, method_name, side_effect=held_dispatch), \
                ThreadPoolExecutor(max_workers=2) as pool:
            dispatched = pool.submit(self.worker, lambda: self.dispatch(data, action))
            try:
                self.assertTrue(entered.wait(5))
                logout_future = pool.submit(self.worker, logout)
                self.assertTrue(logout_entered.wait(5))
                with self.assertRaises(TimeoutError):
                    logout_future.result(timeout=0.2)
            finally:
                release.set()
            response, status = dispatched.result(timeout=10)
            logout_future.result(timeout=10)
        self.assertEqual(status, 200)
        self.assertEqual(InspectionAudit.objects.latest('id').actor_id, self.editor.pk)
        self.assertIsNotNone(MESLoginSession.objects.get(actor_id=self.editor.pk).revoked_at)
        with self.assertRaises(LoginRejected):
            self.dispatch(response, 'mes-reconcile')
        expected = ['save'] if action == 'mes-save' else ['save', 'finish']
        self.assertEqual([call[0] for call in self.stage.calls], expected)

    def test_separate_save_holds_logout_until_observation_is_committed(self):
        self._assert_stage_holds_logout('mes-save')

    def test_separate_finish_holds_logout_until_observation_is_committed(self):
        self._assert_stage_holds_logout('mes-finish')


class InspectorStageAdmissionTests(InspectorFixture, APITestCase):
    setUp = InspectorStageSessionConcurrencyTests.setUp
    dispatch = InspectorStageSessionConcurrencyTests.dispatch

    def test_binding_cannot_dispatch_as_different_mapped_mes_inspector(self):
        self.binding.contract['actor_id'] = self.mes_user_map[str(self.other_editor.pk)]
        self.binding.save(update_fields=['contract'])
        response, status = self.dispatch(self.data, 'mes-save')
        self.assertEqual(status, 403)
        self.assertEqual(response['code'], 'inspection_login_changed')
        self.assertEqual(self.stage.calls, [])
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.phase, 'ready')

    def test_reconciliation_admission_failure_restores_prior_unknown(self):
        self.stage.timeout = 'save'
        data, status = self.dispatch(self.data, 'mes-save')
        self.assertEqual(status, 503)
        data = data['request']
        self.assertEqual(data['sync_status'], 'unknown')
        original = InspectionSession.lock
        entered = 0

        @contextmanager
        def interrupted(session, *args, **kwargs):
            nonlocal entered
            entered += 1
            if entered == 2:
                self.revoke()
            with original(session, *args, **kwargs) as actor:
                yield actor

        with patch.object(InspectionSession, 'lock', interrupted):
            _, status = self.dispatch(data, 'mes-reconcile')
        self.assertEqual(status, 403)
        row = InspectionRequest.objects.get(pk=data['id'])
        self.binding.refresh_from_db()
        self.assertEqual(row.sync_status, 'unknown')
        self.assertEqual(self.binding.phase, 'save_unknown')
        self.assertEqual(row.operations.filter(status='pending').count(), 0)
        self.assertEqual(row.operations.filter(scope__endswith=':mes-save').get().status, 'unknown')
        self.assertEqual([call[0] for call in self.stage.calls], ['save'])
