"""Committed activity/logout admission races in the isolated PostgreSQL suite."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from threading import Event
from unittest import skipUnless

from django.contrib.auth import get_user_model
from django.db import connection, connections, transaction
from django.test import TransactionTestCase, override_settings

from . import vault
from .test_connection import CONNECTION_SETTINGS
from .test_session_activity import ActivityFixture


@skipUnless(connection.vendor == 'postgresql', 'Durable activity races require PostgreSQL.')
@override_settings(**CONNECTION_SETTINGS)
class SessionActivityConcurrencyTests(ActivityFixture, TransactionTestCase):
    def worker(self, callback):
        connections.close_all()
        try:
            with connection.cursor() as cursor:
                cursor.execute("SET statement_timeout = '10000ms'")
                cursor.execute("SET lock_timeout = '5000ms'")
            return callback()
        finally:
            connections.close_all()

    def test_logout_wins_actor_lock_and_late_activity_never_resurrects_login(self):
        locked, release, waiting = Event(), Event(), Event()
        before = self.row().idle_expires_at

        def revoke():
            with transaction.atomic():
                get_user_model().objects.select_for_update().get(pk=self.user.pk)
                vault.revoke_actor(self.user.pk, login_digest=self.login_digest(), reason='logout')
                locked.set()
                if not release.wait(5):
                    raise AssertionError('Synthetic revoke release timed out.')

        def activity():
            waiting.set()
            return self.activity()

        with ThreadPoolExecutor(max_workers=2) as pool:
            revoke_future = pool.submit(self.worker, revoke)
            try:
                self.assertTrue(locked.wait(5))
                activity_future = pool.submit(self.worker, activity)
                self.assertTrue(waiting.wait(5))
                with self.assertRaises(TimeoutError):
                    activity_future.result(timeout=0.2)
            finally:
                release.set()
            revoke_future.result(timeout=10)
            self.assertEqual(activity_future.result(timeout=10).status_code, 401)
        self.assertIsNotNone(self.row().revoked_at)
        self.assertEqual(self.row().idle_expires_at, before)
        self.assertEqual(self.activity().status_code, 401)
        self.assertEqual(self.refresh().status_code, 401)
        self.assert_no_provider()

    def test_concurrent_activity_can_consume_same_refresh_only_once(self):
        ready, release = Event(), Event()
        def held_activity():
            with transaction.atomic():
                get_user_model().objects.select_for_update().get(pk=self.user.pk)
                response = self.activity()
                ready.set()
                if not release.wait(5):
                    raise AssertionError('Synthetic activity release timed out.')
                return response
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(self.worker, held_activity)
            try:
                self.assertTrue(ready.wait(5))
                second = pool.submit(self.worker, self.activity)
                with self.assertRaises(TimeoutError):
                    second.result(timeout=0.2)
            finally:
                release.set()
            self.assertEqual(first.result(timeout=10).status_code, 200)
            self.assertEqual(second.result(timeout=10).status_code, 401)
        self.assertIsNone(self.row().revoked_at)
        self.assert_no_provider()

    def test_access_expiring_while_waiting_for_actor_lock_cannot_renew(self):
        from unittest.mock import patch
        from . import session_guard
        locked, release, authenticated = Event(), Event(), Event()
        before = self.row().idle_expires_at
        original = session_guard.check_known_login

        def observed_check(user, token):
            result = original(user, token)
            if token.get('token_type') == 'access':
                authenticated.set()
            return result

        def holder():
            with transaction.atomic():
                get_user_model().objects.select_for_update().get(pk=self.user.pk)
                locked.set()
                if not release.wait(5):
                    raise AssertionError('Synthetic actor lock release timed out.')

        with patch.object(session_guard, 'check_known_login', side_effect=observed_check):
            with ThreadPoolExecutor(max_workers=2) as pool:
                holding = pool.submit(self.worker, holder)
                try:
                    self.assertTrue(locked.wait(5))
                    activity = pool.submit(self.worker, self.activity)
                    self.assertTrue(authenticated.wait(5))
                    with self.assertRaises(TimeoutError):
                        activity.result(timeout=0.2)
                    self.advance(hours=1)
                finally:
                    release.set()
                holding.result(timeout=10)
                self.assertEqual(activity.result(timeout=10).status_code, 401)
        self.assertEqual(self.row().idle_expires_at, before)
        self.assert_no_provider()
