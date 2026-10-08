"""Synthetic ORM checks; run with check-mes-oauth.py, never live settings."""
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.contrib.auth.hashers import is_password_usable
from django.contrib.sessions.models import Session
from django.db.models.signals import post_save
from django.db import connection, connections, close_old_connections
from django.test import TestCase, TransactionTestCase
from django.test.utils import CaptureQueriesContext
from injection.models import UserProfile

from quality_account_preparation import PreparationBlocked, prepare_accounts


User = get_user_model()


def fixture():
    return {'schema': 1, 'review_reference': 'synthetic-local-review', 'entries': [
        {'username': 'fixture_inspector_a', 'display_name': 'Fixture Inspector Alpha',
         'mes_user_id': '910000001', 'mes_user_code': 'SYNTH_A'},
        {'username': 'fixture_inspector_b', 'display_name': 'Fixture Inspector Beta',
         'mes_user_id': '910000002', 'mes_user_code': 'SYNTH_B'},
    ]}


class QualityAccountPreparationTests(TestCase):
    def test_default_dry_run_does_not_create_or_claim(self):
        with CaptureQueriesContext(connection) as queries:
            result = prepare_accounts(fixture())
        sql = ' '.join(query['sql'] for query in queries)
        for field in ('email', 'last_login', 'is_active', 'is_staff', 'is_superuser', 'password'):
            self.assertNotIn('"auth_user"."' + field + '"', sql)
        self.assertEqual(result['mode'], 'dry_run')
        self.assertFalse(result['runtime_mapping_enabled'])
        self.assertFalse(result['blocked'])
        self.assertEqual(User.objects.count(), 0)
        self.assertEqual(UserProfile.objects.count(), 0)
        self.assertTrue(all(row['wj_user_id'] is None for row in result['accounts']))

    def test_signal_default_views_are_removed_and_no_access_is_issued(self):
        seen_defaults = []

        def observe(sender, instance, created, **kwargs):
            if created:
                profile = UserProfile.objects.get(user=instance)
                seen_defaults.append([getattr(profile, name) for name in (
                    'can_view_injection', 'can_view_assembly', 'can_view_quality',
                    'can_view_sales', 'can_view_development')])

        post_save.connect(observe, sender=User, weak=False)
        try:
            with patch('django.core.mail.send_mail', side_effect=AssertionError('mail forbidden')):
                result = prepare_accounts(fixture(), apply=True)
        finally:
            post_save.disconnect(observe, sender=User)
        self.assertEqual(seen_defaults, [[True] * 5, [True] * 5])
        self.assertEqual(User.objects.count(), 2)
        for user in User.objects.all():
            self.assertFalse(user.is_active or user.is_staff or user.is_superuser)
            self.assertFalse(is_password_usable(user.password))
            self.assertEqual(user.email, '')
            self.assertEqual(user.last_name, '')
            self.assertIsNone(user.last_login)
            self.assertEqual(user.groups.count(), 0)
            self.assertEqual(user.user_permissions.count(), 0)
            profile = UserProfile.objects.get(user=user)
            self.assertEqual(profile.department, '')
            for field in profile._meta.concrete_fields:
                if field.name.startswith('can_') or field.name == 'is_admin':
                    self.assertIs(getattr(profile, field.name), False)
        self.assertEqual(Session.objects.count(), 0)
        from rest_framework_simplejwt.token_blacklist.models import OutstandingToken
        from mes_oauth.models import MESCredential, MESCredentialEvent, MESLoginSession, MESLoginTicket, OAuthAttempt
        for model in (OutstandingToken, MESCredential, MESCredentialEvent, MESLoginSession, MESLoginTicket, OAuthAttempt):
            self.assertEqual(model.objects.count(), 0)
        self.assertTrue(all(row['mapping_enabled'] is False for row in result['accounts']))

    def test_existing_active_case_insensitive_username_blocks_whole_batch(self):
        existing = User.objects.create_user(username='FIXTURE_INSPECTOR_B', password='synthetic-pass')
        before = list(User.objects.values())
        profile_before = list(UserProfile.objects.values())
        self.assertTrue(prepare_accounts(fixture())['blocked'])
        with self.assertRaisesMessage(PreparationBlocked, 'batch_identity_conflict_no_changes'):
            prepare_accounts(fixture(), apply=True)
        self.assertEqual(list(User.objects.values()), before)
        self.assertEqual(list(UserProfile.objects.values()), profile_before)
        self.assertTrue(User.objects.get(pk=existing.pk).is_active)
        # Exact names must also short-circuit at active state, before inspecting
        # private attributes or the profile of an existing account.
        User.objects.filter(pk=existing.pk).update(
            username='fixture_inspector_b', first_name='Fixture Inspector Beta')
        with CaptureQueriesContext(connection) as queries:
            self.assertTrue(prepare_accounts(fixture())['blocked'])
        sql = ' '.join(query['sql'] for query in queries)
        for field in ('email', 'last_login', 'password'):
            self.assertNotIn('"auth_user"."' + field + '"', sql)
        self.assertNotIn('"injection_userprofile"', sql)

    def test_display_name_and_cross_field_collisions_block(self):
        for kwargs in ({'first_name': 'fixture inspector beta'},
                       {'first_name': 'Fixture Inspector', 'last_name': 'Beta'},
                       {'username': 'Fixture Inspector Alpha'},
                       {'first_name': 'FIXTURE_INSPECTOR_A'}):
            with self.subTest(kwargs=kwargs):
                User.objects.all().delete()
                values = {'username': 'existing_fixture', **kwargs}
                User.objects.create_user(**values)
                with self.assertRaises(PreparationBlocked):
                    prepare_accounts(fixture(), apply=True)
                self.assertEqual(User.objects.count(), 1)

    def test_existing_exact_inactive_is_not_automatically_adopted(self):
        prepare_accounts(fixture(), apply=True)
        before = list(User.objects.values())
        result = prepare_accounts(fixture())
        self.assertTrue(result['blocked'])
        self.assertTrue(all(row['state'] == 'blocked_existing_inactive_unclaimed' for row in result['accounts']))
        self.assertTrue(all(row['wj_user_id'] is None for row in result['accounts']))
        with self.assertRaises(PreparationBlocked):
            prepare_accounts(fixture(), apply=True)
        self.assertEqual(list(User.objects.values()), before)

    def test_reviewed_receipt_allows_no_write_idempotence(self):
        receipt = prepare_accounts(fixture(), apply=True)
        before = list(User.objects.values())
        profiles = list(UserProfile.objects.values())
        with patch.object(User, 'save', side_effect=AssertionError('existing user must not be saved')):
            result = prepare_accounts(fixture(), apply=True, reviewed_prior_manifest=receipt)
        self.assertFalse(result['blocked'])
        self.assertTrue(all(row['state'] == 'verified_prior_inactive' for row in result['accounts']))
        self.assertEqual(list(User.objects.values()), before)
        self.assertEqual(list(UserProfile.objects.values()), profiles)

    def test_changed_prior_account_or_mes_mapping_is_not_repaired(self):
        receipt = prepare_accounts(fixture(), apply=True)
        first = User.objects.order_by('pk').first()
        UserProfile.objects.filter(user=first).update(can_view_quality=True)
        with self.assertRaises(PreparationBlocked):
            prepare_accounts(fixture(), apply=True, reviewed_prior_manifest=receipt)
        self.assertTrue(UserProfile.objects.get(user=first).can_view_quality)
        changed = deepcopy(fixture())
        changed['entries'][0]['mes_user_id'] = '910000099'
        with self.assertRaisesMessage(PreparationBlocked, 'reviewed_prior_manifest_mismatch'):
            prepare_accounts(changed, apply=True, reviewed_prior_manifest=receipt)

    def test_existing_groups_and_direct_permissions_block_even_with_receipt(self):
        receipt = prepare_accounts(fixture(), apply=True)
        user = User.objects.order_by('pk').first()
        group = Group.objects.create(name='Synthetic unrelated group')
        user.groups.add(group)
        user.user_permissions.add(Permission.objects.first())
        with self.assertRaises(PreparationBlocked):
            prepare_accounts(fixture(), apply=True, reviewed_prior_manifest=receipt)
        self.assertEqual(user.groups.count(), 1)
        self.assertEqual(user.user_permissions.count(), 1)

    def test_second_creation_failure_rolls_back_first_and_profiles(self):
        def fail_second(sender, instance, created, **kwargs):
            if created and instance.username == 'fixture_inspector_b':
                raise PreparationBlocked('synthetic_failure')
        post_save.connect(fail_second, sender=User, weak=False)
        try:
            with self.assertRaisesMessage(PreparationBlocked, 'synthetic_failure'):
                prepare_accounts(fixture(), apply=True)
        finally:
            post_save.disconnect(fail_second, sender=User)
        self.assertEqual(User.objects.count(), 0)
        self.assertEqual(UserProfile.objects.count(), 0)

    def test_unexpected_signal_grant_rolls_back_instead_of_clearing_it(self):
        group = Group.objects.create(name='Synthetic surprise grant')
        def grant(sender, instance, created, **kwargs):
            if created:
                instance.groups.add(group)
        post_save.connect(grant, sender=User, weak=False)
        try:
            with self.assertRaisesMessage(PreparationBlocked, 'new_account_not_inert_batch_rolled_back'):
                prepare_accounts(fixture(), apply=True)
        finally:
            post_save.disconnect(grant, sender=User)
        self.assertEqual(User.objects.count(), 0)
        self.assertEqual(UserProfile.objects.count(), 0)

    def test_invalid_duplicate_and_unreviewed_fields_never_write(self):
        cases = []
        duplicate = deepcopy(fixture()); duplicate['entries'][1]['display_name'] = 'FIXTURE_INSPECTOR_A'; cases.append(duplicate)
        duplicate_mes = deepcopy(fixture()); duplicate_mes['entries'][1]['mes_user_id'] = '910000001'; cases.append(duplicate_mes)
        invalid_id = deepcopy(fixture()); invalid_id['entries'][0]['mes_user_id'] = 910000001; cases.append(invalid_id)
        extra = deepcopy(fixture()); extra['entries'][0]['password'] = 'forbidden'; cases.append(extra)
        department = deepcopy(fixture()); department['entries'][0]['department'] = 'unreviewed'; cases.append(department)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(PreparationBlocked):
                prepare_accounts(value, apply=True)
        self.assertEqual(User.objects.count(), 0)


@skipUnless(connection.vendor == 'postgresql', 'PostgreSQL table-lock race')
class QualityAccountPreparationRaceTests(TransactionTestCase):
    def test_concurrent_case_variants_cannot_create_two_users(self):
        barrier = Barrier(2)

        def attempt(uppercase):
            close_old_connections()
            value = fixture()
            value['entries'] = value['entries'][:1]
            if uppercase:
                value['entries'][0]['username'] = value['entries'][0]['username'].upper()
                value['entries'][0]['display_name'] = 'Different Synthetic Name'
                value['entries'][0]['mes_user_id'] = '910000099'
                value['entries'][0]['mes_user_code'] = 'SYNTH_OTHER'
            try:
                barrier.wait(timeout=5)
                prepare_accounts(value, apply=True)
                return 'created'
            except PreparationBlocked:
                return 'blocked'
            finally:
                connections.close_all()

        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(attempt, (False, True)))
        self.assertCountEqual(outcomes, ['created', 'blocked'])
        self.assertEqual(User.objects.count(), 1)
        self.assertFalse(User.objects.get().is_active)
