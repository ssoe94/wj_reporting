"""Synthetic role-preparation acceptance; no production settings or identities."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier
from unittest import skipUnless
from unittest.mock import patch

from django.conf import settings
from django.contrib.auth import get_user_model
from django.contrib.auth.models import Group, Permission
from django.contrib.contenttypes.models import ContentType
from django.contrib.sessions.models import Session
from django.db import close_old_connections, connection, connections
from django.db.models.query import QuerySet
from django.test import TestCase, TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from injection.models import UserProfile

from quality_account_preparation import PreparationBlocked, prepare_accounts
from quality_account_role_preparation import ROLE, prepare_quality_roles


User = get_user_model()
REFERENCE = 'SYNTHETIC-role-review'


def source_fixture(count=2):
    manifest = dict(schema=1, review_reference='SYNTHETIC-placeholder-review', entries=[
        dict(username=f'fixture_quality_{index}', display_name=f'Fixture Quality Person {index}',
             mes_user_id=str(920000000 + index), mes_user_code=f'SYNTH_Q_{index}')
        for index in range(1, count + 1)])
    return prepare_accounts(manifest, apply=True)


def exact_permissions():
    return list(Permission.objects.filter(content_type__app_label='quality',
        content_type__model='inspectionrequest', codename__in=ROLE).order_by('pk').values_list('pk', flat=True))


class QualityAccountRolePreparationTests(TestCase):
    def setUp(self):
        self.source = source_fixture()

    def snapshot(self):
        return (list(User.objects.order_by('pk').values()),
                list(UserProfile.objects.order_by('pk').values()),
                list(User.user_permissions.through.objects.order_by('pk').values()),
                list(User.groups.through.objects.order_by('pk').values()))

    def test_default_dry_run_is_read_only_and_has_no_hypothetical_approval(self):
        before = self.snapshot()
        with CaptureQueriesContext(connection) as queries:
            result = prepare_quality_roles(self.source, REFERENCE)
        self.assertEqual(result['mode'], 'dry_run')
        self.assertEqual(result['account_activation_approved_targets_candidate'], {})
        self.assertTrue(all(row['policy_digest'] is None for row in result['accounts']))
        self.assertEqual(result['direct_permissions'], ['quality.' + code for code in ROLE])
        self.assertEqual(self.snapshot(), before)
        self.assertFalse(any(query['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for query in queries))

    def test_apply_changes_only_quality_view_and_three_direct_permissions(self):
        unrelated = User.objects.create_user(username='unrelated_fixture', first_name='Unrelated Fixture')
        before_users = list(User.objects.order_by('pk').values())
        before_profiles = {row['user_id']: row for row in UserProfile.objects.values()}
        before_permission_count = Permission.objects.count()
        from account_activation.models import ActivationGrant, ActivationRateBucket
        from account_activation.services import approved_targets, policy_digest
        from mes_oauth.models import MESCredential, MESCredentialEvent, MESLoginSession, MESLoginTicket, OAuthAttempt
        from rest_framework_simplejwt.token_blacklist.models import OutstandingToken, BlacklistedToken
        models = (Session, ActivationGrant, ActivationRateBucket, MESCredential, MESCredentialEvent,
                  MESLoginSession, MESLoginTicket, OAuthAttempt, OutstandingToken, BlacklistedToken)
        before_artifacts = [list(model.objects.values()) for model in models]
        old_configuration = getattr(settings, 'ACCOUNT_ACTIVATION_APPROVED_TARGETS', None)
        with patch('django.core.mail.send_mail', side_effect=AssertionError('mail forbidden')):
            result = prepare_quality_roles(self.source, REFERENCE, apply=True)
        self.assertEqual(list(User.objects.order_by('pk').values()), before_users)
        self.assertEqual(Permission.objects.count(), before_permission_count)
        self.assertEqual([list(model.objects.values()) for model in models], before_artifacts)
        self.assertEqual(getattr(settings, 'ACCOUNT_ACTIVATION_APPROVED_TARGETS', None), old_configuration)
        for user in User.objects.exclude(pk=unrelated.pk):
            profile = UserProfile.objects.get(user=user)
            expected = dict(before_profiles[user.pk], can_view_quality=True)
            self.assertEqual(UserProfile.objects.filter(pk=profile.pk).values().get(), expected)
            self.assertEqual(list(user.user_permissions.order_by('pk').values_list('pk', flat=True)), exact_permissions())
            self.assertEqual(user.groups.count(), 0)
            self.assertFalse(user.is_active or user.is_staff or user.is_superuser or user.has_usable_password())
            self.assertEqual(result['account_activation_approved_targets_candidate'][str(user.pk)],
                             dict(username=user.username, policy_digest=policy_digest(user, profile), reference=REFERENCE))
        self.assertEqual(UserProfile.objects.filter(user=unrelated).values().get(), before_profiles[unrelated.pk])
        self.assertEqual(unrelated.user_permissions.count(), 0)
        self.assertFalse(result['activation_config_written'] or result['runtime_mapping_enabled'])
        with override_settings(ACCOUNT_ACTIVATION_APPROVED_TARGETS=result['account_activation_approved_targets_candidate']):
            self.assertEqual(approved_targets(), result['account_activation_approved_targets_candidate'])

    def test_existing_roles_cannot_be_automatically_claimed(self):
        prepare_quality_roles(self.source, REFERENCE, apply=True)
        before = self.snapshot()
        for apply in (False, True):
            with self.assertRaises(PreparationBlocked):
                prepare_quality_roles(self.source, REFERENCE, apply=apply)
        self.assertEqual(self.snapshot(), before)

    def test_reviewed_exact_post_state_is_idempotent_without_writes(self):
        receipt = prepare_quality_roles(self.source, REFERENCE, apply=True)
        before = self.snapshot()
        with CaptureQueriesContext(connection) as queries:
            result = prepare_quality_roles(self.source, REFERENCE, apply=True, reviewed_role_receipt=receipt)
        self.assertEqual(result['account_activation_approved_targets_candidate'], receipt['account_activation_approved_targets_candidate'])
        self.assertTrue(all(row['state'] == 'verified_prior_roles' for row in result['accounts']))
        self.assertFalse(any(query['sql'].lstrip().upper().startswith(('INSERT', 'UPDATE', 'DELETE')) for query in queries))
        self.assertEqual(self.snapshot(), before)

    def test_changed_receipt_reference_or_mes_identity_blocks(self):
        receipt = prepare_quality_roles(self.source, REFERENCE, apply=True)
        before = self.snapshot()
        tampered = deepcopy(receipt)
        tampered['accounts'][0]['mes_user_id'] = '920099999'
        for prior, reference in ((tampered, REFERENCE), (receipt, 'SYNTHETIC-different-review')):
            with self.assertRaises(PreparationBlocked):
                prepare_quality_roles(self.source, reference, apply=True, reviewed_role_receipt=prior)
        self.assertEqual(self.snapshot(), before)

    def test_changed_post_permissions_are_never_repaired(self):
        receipt = prepare_quality_roles(self.source, REFERENCE, apply=True)
        user = User.objects.order_by('pk').first()
        extra = Permission.objects.get(content_type__app_label='quality',
            content_type__model='inspectionrequest', codename='review_inspectionrequest')
        user.user_permissions.add(extra)
        before = self.snapshot()
        with self.assertRaises(PreparationBlocked):
            prepare_quality_roles(self.source, REFERENCE, apply=True, reviewed_role_receipt=receipt)
        self.assertEqual(self.snapshot(), before)

    def test_missing_exact_model_permission_does_not_create_permissions(self):
        Permission.objects.get(content_type__app_label='quality', content_type__model='inspectionrequest',
                               codename='manage_inspectionrequest').delete()
        wrong_type = ContentType.objects.get_for_model(UserProfile)
        Permission.objects.create(content_type=wrong_type, codename='manage_inspectionrequest', name='Synthetic wrong model')
        before = self.snapshot()
        count = Permission.objects.count()
        with self.assertRaisesMessage(PreparationBlocked, 'required_exact_permissions_missing'):
            prepare_quality_roles(self.source, REFERENCE, apply=True)
        self.assertEqual(self.snapshot(), before)
        self.assertEqual(Permission.objects.count(), count)

    def test_non_inert_targets_and_case_insensitive_name_collision_block_batch(self):
        user = User.objects.order_by('pk').last()
        original = User.objects.filter(pk=user.pk).values().get()
        for change in ({'is_active': True}, {'is_staff': True}, {'is_superuser': True},
                       {'email': 'synthetic@example.invalid'}, {'password': 'synthetic-usable-marker'}):
            User.objects.filter(pk=user.pk).update(**change)
            before = self.snapshot()
            with self.subTest(change=change), self.assertRaises(PreparationBlocked):
                prepare_quality_roles(self.source, REFERENCE, apply=True)
            self.assertEqual(self.snapshot(), before)
            User.objects.filter(pk=user.pk).update(**{key: original[key] for key in change})
        User.objects.create_user(username='FIXTURE_QUALITY_1')
        before = self.snapshot()
        with self.assertRaisesMessage(PreparationBlocked, 'exact_account_identity_collision'):
            prepare_quality_roles(self.source, REFERENCE, apply=True)
        self.assertEqual(self.snapshot(), before)

    def test_preexisting_profile_and_group_grants_block_without_cleanup(self):
        user = User.objects.order_by('pk').last()
        UserProfile.objects.filter(user=user).update(can_view_sales=True)
        group = Group.objects.create(name='Synthetic existing group')
        user.groups.add(group)
        before = self.snapshot()
        with self.assertRaises(PreparationBlocked):
            prepare_quality_roles(self.source, REFERENCE, apply=True)
        self.assertEqual(self.snapshot(), before)

    def test_partial_second_write_failure_rolls_back_all_roles(self):
        before = self.snapshot()
        original, count = QuerySet.bulk_create, 0
        def fail_second(query, *args, **kwargs):
            nonlocal count
            if query.model is User.user_permissions.through:
                count += 1
                if count == 2:
                    raise PreparationBlocked('synthetic_second_write_failure')
            return original(query, *args, **kwargs)
        with patch.object(QuerySet, 'bulk_create', fail_second):
            with self.assertRaisesMessage(PreparationBlocked, 'synthetic_second_write_failure'):
                prepare_quality_roles(self.source, REFERENCE, apply=True)
        self.assertEqual(self.snapshot(), before)

    def test_original_receipt_and_role_reference_are_required(self):
        before = self.snapshot()
        missing = deepcopy(self.source); missing['mode'] = 'dry_run'
        wrong_id = deepcopy(self.source); wrong_id['accounts'][0]['wj_user_id'] = 99999999
        bad_mes = deepcopy(self.source); bad_mes['accounts'][0]['mes_user_id'] = '920099999'
        for source, reference in ((missing, REFERENCE), (wrong_id, REFERENCE),
                                  (bad_mes, REFERENCE), (self.source, 'bad reference')):
            with self.subTest(reference=reference), self.assertRaises(PreparationBlocked):
                prepare_quality_roles(source, reference, apply=True)
        self.assertEqual(self.snapshot(), before)


@skipUnless(connection.vendor == 'postgresql', 'PostgreSQL policy-lock race')
class QualityAccountRolePreparationRaceTests(TransactionTestCase):
    def test_concurrent_same_receipt_prepares_once_and_never_adopts_implicitly(self):
        source = source_fixture()
        barrier = Barrier(2)
        def prepare(_):
            close_old_connections()
            try:
                barrier.wait(timeout=5)
                return prepare_quality_roles(source, REFERENCE, apply=True)['mode']
            except PreparationBlocked:
                return 'blocked'
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(prepare, range(2)))
        self.assertCountEqual(results, ['applied', 'blocked'])
        for user in User.objects.all():
            self.assertEqual(list(user.user_permissions.order_by('pk').values_list('pk', flat=True)), exact_permissions())
            self.assertTrue(UserProfile.objects.get(user=user).can_view_quality)
            self.assertFalse(user.is_active or user.has_usable_password())
