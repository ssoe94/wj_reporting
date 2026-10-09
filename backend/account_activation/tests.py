"""Synthetic activation fixtures only; the runner blocks all provider networking."""
from concurrent.futures import ThreadPoolExecutor, TimeoutError
from datetime import timedelta
import importlib
import re
from threading import Barrier, Event
from unittest import SkipTest, skipUnless
from unittest.mock import patch
from urllib.parse import urlencode

from django.apps import apps

if not apps.is_installed('account_activation'):
    raise SkipTest('Account activation is not installed in this configuration.')

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.contrib.admin.utils import quote
from django.db import connection, connections, transaction
from django.db.migrations.operations.models import CreateModel
from django.test import Client, TestCase, TransactionTestCase, override_settings
from django.urls import reverse
from django.utils import timezone
from rest_framework_simplejwt.token_blacklist.models import BlacklistedToken
from rest_framework_simplejwt.tokens import RefreshToken

from mes_oauth.models import MESLoginSession, MESLoginTicket
from . import services
from .models import ActivationGrant, ActivationRateBucket


PASSWORD = 'SYNTHETIC-owner-self-set-482!'
ORIGIN = 'https://testserver'
PAGE = '/accounts/activate/'
ISSUE = '/admin/account_activation/activationgrant/issue/'
CONFIG = dict(
    ACCOUNT_ACTIVATION_ENABLED=True, ACCOUNT_ACTIVATION_ORIGIN=ORIGIN,
    DEBUG=False, ALLOWED_HOSTS=['testserver'],
    SESSION_COOKIE_SECURE=True, CSRF_COOKIE_SECURE=True, SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_DOMAIN=None, CSRF_COOKIE_DOMAIN=None,
    SESSION_ENGINE='django.contrib.sessions.backends.db',
    CSRF_TRUSTED_ORIGINS=[ORIGIN],
    AUTH_PASSWORD_VALIDATORS=[
        {'NAME': 'django.contrib.auth.password_validation.UserAttributeSimilarityValidator'},
        {'NAME': 'django.contrib.auth.password_validation.MinimumLengthValidator'},
        {'NAME': 'django.contrib.auth.password_validation.CommonPasswordValidator'},
        {'NAME': 'django.contrib.auth.password_validation.NumericPasswordValidator'},
    ],
)


class ActivationFixture:
    def setUp(self):
        super().setUp()
        User = get_user_model()
        self.admin = User.objects.create_user(username='SYNTHETIC-ACTIVATION-ADMIN',
            password=PASSWORD, is_staff=True, is_superuser=True)
        self.target = User.objects.create_user(username='SYNTHETIC-ACTIVATION-OWNER',
            password=None, is_active=False)
        self.target.profile.can_view_quality = True
        self.target.profile.can_edit_quality = False
        self.target.profile.save()
        self.mapping = {str(self.target.pk): {'username': self.target.username,
            'policy_digest': services.policy_digest(self.target), 'reference': 'SYNTHETIC-APPROVAL'}}
        self.override = override_settings(ACCOUNT_ACTIVATION_APPROVED_TARGETS=self.mapping)
        self.override.enable()
        self.addCleanup(self.override.disable)
        self.browser = Client(enforce_csrf_checks=True)
        self.browser.force_login(self.admin)
        self.owner = Client(enforce_csrf_checks=True)

    def post(self, browser, path, fields, *, csrf=True, origin=ORIGIN, **headers):
        if origin is not None:
            headers['HTTP_ORIGIN'] = origin
        if csrf and 'csrftoken' in browser.cookies:
            headers['HTTP_X_CSRFTOKEN'] = browser.cookies['csrftoken'].value
        return browser.post(path, urlencode(fields), content_type='application/x-www-form-urlencoded',
                            secure=True, **headers)

    def issue(self, *, action='issue'):
        self.assertEqual(self.browser.get(ISSUE, secure=True).status_code, 200)
        return self.post(self.browser, ISSUE, {
            'csrfmiddlewaretoken': self.browser.cookies['csrftoken'].value,
            'target': str(self.target.pk), 'action': action, 'confirmed': 'yes'})

    def grant(self):
        response = self.issue()
        self.assertEqual(response.status_code, 200)
        self.assertEqual(ActivationGrant.objects.filter(status='pending').count(), 1)
        link = re.search(r'<textarea[^>]+>([^<]+)</textarea>', response.content.decode()).group(1)
        self.assertTrue(link.startswith(ORIGIN + PAGE + '#'))
        return link.split('#', 1)[1]

    def consume(self, token, password=PASSWORD, confirmation=None, **options):
        self.assertEqual(self.owner.get(PAGE, secure=True).status_code, 200)
        return self.post(self.owner, PAGE, {'token': token, 'password': password,
            'confirmation': password if confirmation is None else confirmation}, **options)


@override_settings(**CONFIG)
class ActivationFlowTests(ActivationFixture, TestCase):
    def test_end_to_end_self_set_then_normal_login_without_role_changes(self):
        before = services.policy_digest(self.target)
        token = self.grant()
        row = ActivationGrant.objects.get()
        self.assertLessEqual(row.expires_at - row.created_at, timedelta(minutes=15))
        self.assertGreater(row.expires_at - row.created_at, timedelta(minutes=14, seconds=59))
        self.assertNotIn(token, repr(services.IssuedActivation(token, row.expires_at)))
        self.assertNotIn(token, repr(list(ActivationGrant.objects.values())))
        self.assertNotIn(PASSWORD, repr(list(ActivationGrant.objects.values())))
        response = self.consume(token)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {'status': 'activated'})
        self.target.refresh_from_db()
        row.refresh_from_db()
        self.assertTrue(self.target.is_active)
        self.assertTrue(self.target.check_password(PASSWORD))
        self.assertEqual(services.policy_digest(self.target), before)
        self.assertFalse(self.target.profile.password_reset_required)
        self.assertFalse(self.target.profile.is_using_temp_password)
        self.assertIsNotNone(self.target.profile.last_password_change)
        self.assertEqual(row.status, 'consumed')
        self.assertIsNotNone(row.consumed_at)
        self.assertNotIn('_auth_user_id', self.owner.session)
        login = self.owner.post(reverse('token_obtain_pair'), {
            'username': self.target.username, 'password': PASSWORD},
            content_type='application/json', secure=True)
        self.assertEqual(login.status_code, 200)
        self.assertIn('access', login.json())

    def test_disabled_has_no_grant_or_counter_side_effect(self):
        with override_settings(ACCOUNT_ACTIVATION_ENABLED=False):
            self.assertEqual(self.owner.get(PAGE, secure=True).status_code, 403)
            self.assertEqual(self.browser.get(ISSUE, secure=True).status_code, 403)
            with self.assertRaises(services.ActivationBlocked):
                services.issue(self.admin.pk, self.target.pk)
        self.assertEqual(ActivationGrant.objects.count(), 0)
        self.assertEqual(ActivationRateBucket.objects.count(), 0)

    def test_admin_requires_active_staff_superuser_session(self):
        for staff, superuser, active in [(True, False, True), (False, True, True), (True, True, False)]:
            with self.subTest(staff=staff, superuser=superuser, active=active):
                self.admin.is_staff, self.admin.is_superuser, self.admin.is_active = staff, superuser, active
                self.admin.save()
                response = self.browser.get(ISSUE, secure=True)
                self.assertIn(response.status_code, (302, 403))
        self.assertEqual(ActivationGrant.objects.count(), 0)

    def test_configured_pilot_cannot_issue_or_revoke_even_if_promoted_to_admin(self):
        with override_settings(INSPECTION_PILOT_ENABLED=False, INSPECTION_PILOT_USER_IDS=[self.admin.pk]):
            self.assertFalse(services.administrator(self.admin))
            self.assertEqual(self.browser.get(ISSUE, secure=True).status_code, 403)
            self.assertEqual(self.post(self.browser, ISSUE, {
                'target': str(self.target.pk), 'action': 'issue', 'confirmed': 'yes'}).status_code, 403)
            for action in (services.issue, services.revoke):
                with self.assertRaisesMessage(services.ActivationBlocked, 'issuer_unavailable'):
                    action(self.admin.pk, self.target.pk)
        self.assertEqual(ActivationGrant.objects.count(), 0)
        self.assertEqual(ActivationRateBucket.objects.count(), 0)

    def test_request_scoped_admin_cannot_be_an_activation_issuer(self):
        self.admin._inspection_pilot_scope = True
        with override_settings(INSPECTION_PILOT_USER_IDS='[]'):
            self.assertFalse(services.administrator(self.admin))

    def test_newly_confined_issuer_cannot_activate_a_previously_issued_grant(self):
        token = self.grant()
        with override_settings(INSPECTION_PILOT_USER_IDS=[self.admin.pk]):
            response = self.consume(token)
        self.assertEqual(response.status_code, 400)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)
        self.assertFalse(self.target.has_usable_password())
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')

    def test_bearer_and_bridge_sessions_cannot_issue(self):
        self.assertEqual(self.browser.get(ISSUE, secure=True,
            HTTP_AUTHORIZATION='Bearer SYNTHETIC-NOT-AN-AUTHORITY').status_code, 403)
        session = self.browser.session
        session['mes_bridge_only'] = True
        session.save()
        self.assertIn(self.browser.get(ISSUE, secure=True).status_code, (302, 403))
        self.assertEqual(ActivationGrant.objects.count(), 0)

    def test_csrf_origin_and_bearer_are_enforced_for_both_posts(self):
        token = self.grant()
        self.owner.get(PAGE, secure=True)
        for origin, csrf, bearer in [(ORIGIN, False, False), ('https://evil.example', True, False),
                                     (None, True, False), (ORIGIN, False, True), (ORIGIN, True, True)]:
            with self.subTest(origin=origin, csrf=csrf, bearer=bearer):
                headers = {'HTTP_AUTHORIZATION': 'Bearer SYNTHETIC'} if bearer else {}
                response = self.post(self.owner, PAGE,
                    {'token': token, 'password': PASSWORD, 'confirmation': PASSWORD},
                    origin=origin, csrf=csrf, **headers)
                self.assertEqual(response.status_code, 403)
                response = self.post(self.browser, ISSUE,
                    {'target': str(self.target.pk), 'action': 'revoke', 'confirmed': 'yes',
                     'csrfmiddlewaretoken': self.browser.cookies['csrftoken'].value if csrf else ''},
                    origin=origin, csrf=csrf, **headers)
                self.assertEqual(response.status_code, 403)
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')

    def test_insecure_debug_host_query_and_iframe_protection(self):
        self.assertEqual(self.owner.get(PAGE).status_code, 403)
        with override_settings(DEBUG=True):
            self.assertEqual(self.owner.get(PAGE, secure=True).status_code, 403)
        with override_settings(ACCOUNT_ACTIVATION_ORIGIN='https://other.example'):
            self.assertEqual(self.owner.get(PAGE, secure=True).status_code, 403)
        response = self.owner.get(PAGE + '?token=SYNTHETIC-LEAK', secure=True)
        self.assertEqual(response.status_code, 403)
        self.assertNotIn(b'SYNTHETIC-LEAK', response.content)
        for path in (PAGE, ISSUE):
            response = self.browser.get(path, secure=True)
            self.assertIn('no-store', response['Cache-Control'])
            self.assertEqual(response['X-Frame-Options'], 'DENY')
            self.assertIn("frame-ancestors 'none'", response['Content-Security-Policy'])

    def test_get_never_consumes_and_never_discloses_grant(self):
        token = self.grant()
        for _ in range(3):
            response = self.owner.get(PAGE, secure=True)
            self.assertEqual(response.status_code, 200)
            self.assertNotIn(token.encode(), response.content)
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')
        self.assertEqual(self.browser.get(ISSUE, secure=True).status_code, 200)
        self.assertNotIn(token.encode(), self.browser.get(ISSUE, secure=True).content)

    def test_backend_delivers_fixed_script_and_style_assets(self):
        for name, mime in [('activate.js', 'text/javascript'), ('issue.js', 'text/javascript'),
                           ('activation.css', 'text/css')]:
            response = self.owner.get(PAGE + 'assets/' + name, secure=True)
            self.assertEqual(response.status_code, 200)
            self.assertTrue(response['Content-Type'].startswith(mime))
            self.assertGreater(len(response.content), 100)
        self.assertEqual(self.owner.get(PAGE + 'assets/missing.js', secure=True).status_code, 404)

    def test_pending_link_cannot_be_reissued_without_explicit_revoke(self):
        original = self.grant()
        repeated = self.issue()
        self.assertEqual(repeated.status_code, 200)
        self.assertNotIn(b'<textarea', repeated.content)
        self.assertEqual(ActivationGrant.objects.count(), 1)
        self.assertEqual(self.issue(action='revoke').status_code, 200)
        new = self.grant()
        self.assertNotEqual(original, new)
        self.assertEqual(self.consume(original).status_code, 400)
        self.assertEqual(self.consume(new).json(), {'status': 'activated'})
        self.assertEqual(ActivationGrant.objects.filter(status='revoked').count(), 1)

    def test_expiry_tampering_and_replay_are_rejected(self):
        token = self.grant()
        changed = token[:-1] + ('A' if token[-1] != 'A' else 'B')
        self.assertEqual(self.consume(changed).status_code, 400)
        ActivationGrant.objects.update(expires_at=timezone.now())
        self.assertEqual(self.consume(token).status_code, 400)
        ActivationGrant.objects.update(expires_at=timezone.now() + timedelta(minutes=1))
        self.assertEqual(self.consume(token).status_code, 200)
        self.assertEqual(self.consume(token).status_code, 400)

    def test_password_validation_and_confirmation_do_not_consume(self):
        token = self.grant()
        for password, confirmation in [('short', 'short'), ('password', 'password'),
                ('1234567891011', '1234567891011'), (PASSWORD, 'different'), ('x' * 257, 'x' * 257)]:
            with self.subTest(kind=len(password)):
                response = self.consume(token, password, confirmation)
                self.assertEqual(response.json(), {'status': 'password_invalid'})
                if password != 'password':
                    self.assertNotIn(password.encode(), response.content)
                self.assertEqual(ActivationGrant.objects.get().status, 'pending')
        self.assertEqual(self.consume(token).json(), {'status': 'activated'})

    def test_allowlist_identity_and_role_fingerprint_fail_closed(self):
        original = dict(self.mapping[str(self.target.pk)])
        for change in ({}, {'username': 'SYNTHETIC-OTHER'}, {'policy_digest': '0' * 64}):
            mapping = {} if not change else {str(self.target.pk): {**original, **change}}
            with self.subTest(fields=tuple(change)), override_settings(ACCOUNT_ACTIVATION_APPROVED_TARGETS=mapping):
                with self.assertRaises(services.ActivationBlocked):
                    services.issue(self.admin.pk, self.target.pk)
        self.assertEqual(ActivationGrant.objects.count(), 0)

    def test_targets_active_usable_staff_superuser_or_profile_admin_are_rejected(self):
        for field in ('is_active', 'is_staff', 'is_superuser', 'password', 'is_admin'):
            with self.subTest(field=field):
                self.target.refresh_from_db()
                if field == 'is_admin':
                    self.target.profile.is_admin = True
                    self.target.profile.save()
                elif field == 'password':
                    self.target.set_password(PASSWORD)
                    self.target.save()
                else:
                    setattr(self.target, field, True)
                    self.target.save()
                self.mapping[str(self.target.pk)]['policy_digest'] = services.policy_digest(self.target)
                with self.assertRaises(services.ActivationBlocked):
                    services.issue(self.admin.pk, self.target.pk)
                self.target.is_active = self.target.is_staff = self.target.is_superuser = False
                self.target.set_unusable_password()
                self.target.save()
                self.target.profile.is_admin = False
                self.target.profile.save()
        self.assertEqual(ActivationGrant.objects.count(), 0)

    def test_policy_change_after_issue_cannot_be_activated(self):
        token = self.grant()
        self.target.profile.can_edit_quality = True
        self.target.profile.save()
        self.assertEqual(self.consume(token).status_code, 400)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)

    def test_group_permission_changes_are_part_of_policy(self):
        group = Group.objects.create(name='SYNTHETIC-ACTIVATION-GROUP')
        self.target.groups.add(group)
        self.mapping[str(self.target.pk)]['policy_digest'] = services.policy_digest(self.target)
        token = self.grant()
        group.permissions.add(Permission.objects.filter(codename='view_user').first())
        self.assertEqual(self.consume(token).status_code, 400)

    def test_changed_approval_reference_or_unusable_hash_invalidates_link(self):
        token = self.grant()
        self.mapping[str(self.target.pk)]['reference'] = 'SYNTHETIC-NEW-APPROVAL'
        self.assertEqual(self.consume(token).status_code, 400)
        self.mapping[str(self.target.pk)]['reference'] = 'SYNTHETIC-APPROVAL'
        self.target.set_unusable_password()
        self.target.save()
        self.assertEqual(self.consume(token).status_code, 400)

    def test_demoted_issuer_cannot_leave_a_usable_link(self):
        token = self.grant()
        self.admin.is_superuser = False
        self.admin.save()
        self.assertEqual(self.consume(token).status_code, 400)

    def test_old_refresh_django_and_mes_sessions_are_revoked(self):
        old_browser = Client()
        old_browser.force_login(self.target)
        refresh = RefreshToken.for_user(self.target)
        MESLoginSession.objects.create(digest='a' * 64, actor_id=self.target.pk,
            authorization_digest='b' * 64, expires_at=timezone.now() + timedelta(hours=1))
        MESLoginTicket.objects.create(digest='c' * 64, actor_id=self.target.pk,
            login_digest='a' * 64, authorization_digest='b' * 64,
            expires_at=timezone.now() + timedelta(minutes=1))
        token = self.grant()
        with patch('mes_oauth.vault._open', side_effect=AssertionError('No credential decrypt.')):
            self.assertEqual(self.consume(token).status_code, 200)
        self.assertTrue(BlacklistedToken.objects.filter(token__jti=refresh['jti']).exists())
        self.assertIsNotNone(MESLoginSession.objects.get().revoked_at)
        self.assertIsNotNone(MESLoginTicket.objects.get().consumed_at)
        old_browser.get('/admin/', secure=True)
        self.assertNotIn('_auth_user_id', old_browser.session)

    def test_revocation_failure_rolls_back_password_active_and_grant(self):
        token = self.grant()
        with patch('mes_oauth.vault.revoke_actor', side_effect=RuntimeError('SYNTHETIC-PRIVATE-ERROR')):
            response = self.consume(token)
        self.assertEqual(response.status_code, 503)
        self.assertNotIn(b'SYNTHETIC-PRIVATE-ERROR', response.content)
        self.assertNotIn(token.encode(), response.content)
        self.target.refresh_from_db()
        self.assertFalse(self.target.is_active)
        self.assertFalse(self.target.has_usable_password())
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')
        self.assertIsNone(self.target.profile.last_password_change)

    def test_selector_rate_limit_blocks_and_does_not_persist_source(self):
        token = self.grant()
        for _ in range(8):
            self.assertEqual(self.consume(token, 'short').status_code, 200)
        self.assertEqual(self.consume(token).status_code, 429)
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')
        self.assertNotIn('127.0.0.1', repr(list(ActivationRateBucket.objects.values())))
        self.assertNotIn(token, repr(list(ActivationRateBucket.objects.values())))

    def test_unknown_tokens_still_spend_shared_source_budget(self):
        self.owner.get(PAGE, secure=True)
        for _ in range(40):
            response = self.post(self.owner, PAGE,
                {'token': 'invalid', 'password': PASSWORD, 'confirmation': PASSWORD})
            self.assertEqual(response.status_code, 400)
        self.assertEqual(self.post(self.owner, PAGE,
            {'token': 'invalid', 'password': PASSWORD, 'confirmation': PASSWORD}).status_code, 429)
        self.assertEqual(ActivationRateBucket.objects.count(), 1)

    def test_duplicate_fields_extra_fields_and_oversized_body_are_refused(self):
        token = self.grant()
        self.owner.get(PAGE, secure=True)
        for fields in ([('token', token), ('password', PASSWORD), ('confirmation', PASSWORD), ('password', PASSWORD)],
                {'token': token, 'password': PASSWORD, 'confirmation': PASSWORD, 'target_id': self.admin.pk},
                {'token': token, 'password': 'x' * 5000, 'confirmation': PASSWORD}):
            self.assertEqual(self.post(self.owner, PAGE, fields).status_code, 400)
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')

    def test_additive_two_table_migration_has_no_user_foreign_keys(self):
        migration = importlib.import_module('account_activation.migrations.0001_initial').Migration
        self.assertEqual(len(migration.operations), 2)
        self.assertTrue(all(isinstance(operation, CreateModel) for operation in migration.operations))
        with connection.cursor() as cursor:
            for model in (ActivationGrant, ActivationRateBucket):
                constraints = connection.introspection.get_constraints(cursor, model._meta.db_table)
                self.assertTrue(all(not item['foreign_key'] for item in constraints.values()))
        self.grant()
        self.target.delete()
        self.assertEqual(ActivationGrant.objects.count(), 1)

    def test_admin_history_and_model_views_exclude_raw_secret_and_digests(self):
        token = self.grant()
        row = ActivationGrant.objects.get()
        response = self.browser.get('/admin/account_activation/activationgrant/', secure=True)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn(token.encode(), response.content)
        detail = self.browser.get('/admin/account_activation/activationgrant/' + quote(row.pk) + '/change/', secure=True)
        self.assertEqual(detail.status_code, 200)
        for value in (token, row.token_digest, row.credential_digest):
            self.assertNotIn(value.encode(), detail.content)
        from django.contrib.admin.models import LogEntry
        self.assertEqual(LogEntry.objects.count(), 0)


@skipUnless(connection.vendor == 'postgresql', 'Requires isolated PostgreSQL row locks.')
@override_settings(**CONFIG)
class ActivationConcurrencyTests(ActivationFixture, TransactionTestCase):
    def parallel(self, callback, count=2):
        barrier = Barrier(count)
        def worker():
            connections.close_all()
            try:
                barrier.wait(timeout=10)
                return callback()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=count) as pool:
            futures = [pool.submit(worker) for _ in range(count)]
            return [future.result(timeout=20) for future in futures]

    def test_concurrent_consumers_activate_exactly_once(self):
        token = services.issue(self.admin.pk, self.target.pk).token
        def consume():
            try:
                services.activate(token, PASSWORD, PASSWORD)
                return 'activated'
            except services.ActivationBlocked:
                return 'blocked'
        self.assertCountEqual(self.parallel(consume), ['activated', 'blocked'])
        self.target.refresh_from_db()
        self.assertTrue(self.target.is_active)
        self.assertEqual(ActivationGrant.objects.get().status, 'consumed')

    def test_concurrent_issuance_has_one_pending_grant(self):
        def issue():
            try:
                services.issue(self.admin.pk, self.target.pk)
                return 'issued'
            except services.ActivationBlocked:
                return 'blocked'
        self.assertCountEqual(self.parallel(issue), ['issued', 'blocked'])
        self.assertEqual(ActivationGrant.objects.filter(status='pending').count(), 1)

    def test_shared_database_rate_counter_does_not_overshoot(self):
        now = timezone.now()
        results = self.parallel(lambda: services.take_rate('SYNTHETIC-CONCURRENCY', 'fixture', 3, now=now), 8)
        self.assertEqual(sum(results), 3)
        self.assertEqual(ActivationRateBucket.objects.get().count, 3)

    def blocked_consume(self, token, entered):
        connections.close_all()
        try:
            entered.set()
            services.activate(token, PASSWORD, PASSWORD)
            return 'activated'
        except services.ActivationBlocked:
            return 'blocked'
        finally:
            connections.close_all()

    def test_issuer_revocation_wins_before_activation_and_is_observed(self):
        token = services.issue(self.admin.pk, self.target.pk).token
        entered = Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                issuer = get_user_model().objects.select_for_update().get(pk=self.admin.pk)
                issuer.is_staff = False
                issuer.save(update_fields=['is_staff'])
                future = pool.submit(self.blocked_consume, token, entered)
                self.assertTrue(entered.wait(timeout=5))
                with self.assertRaises(TimeoutError):
                    future.result(timeout=0.1)
            self.assertEqual(future.result(timeout=10), 'blocked')
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')

    def test_permission_change_wins_before_activation_and_is_observed(self):
        group = Group.objects.create(name='SYNTHETIC-CONCURRENT-PERMISSION')
        self.target.groups.add(group)
        self.mapping[str(self.target.pk)]['policy_digest'] = services.policy_digest(self.target)
        token = services.issue(self.admin.pk, self.target.pk).token
        entered = Event()
        with ThreadPoolExecutor(max_workers=1) as pool:
            with transaction.atomic():
                group.permissions.add(Permission.objects.filter(codename='view_user').first())
                future = pool.submit(self.blocked_consume, token, entered)
                self.assertTrue(entered.wait(timeout=5))
                with self.assertRaises(TimeoutError):
                    future.result(timeout=0.1)
            self.assertEqual(future.result(timeout=10), 'blocked')
        self.assertEqual(ActivationGrant.objects.get().status, 'pending')
