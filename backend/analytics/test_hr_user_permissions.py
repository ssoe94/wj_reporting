from unittest.mock import patch

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIClient

from injection.models import UserRegistrationRequest
from injection.serializers import UserSerializer
from .hr_permissions import can_access_hr
from .models import HrAccessGrant, HrAccessHistory

User = get_user_model()


class HrUserPermissionTests(TestCase):
    def setUp(self):
        self.root = User.objects.create_superuser('root', password='SyntheticOnly2026!')
        self.target = User.objects.create_user('target', email='target@example.invalid')
        self.admin = User.objects.create_user('app-admin')
        self.admin.profile.is_admin = True
        self.admin.profile.save()
        self.staff = User.objects.create_user('staff', is_staff=True)
        self.hr = User.objects.create_user('hr')
        HrAccessGrant.objects.create(user=self.hr, enabled=True)
        self.client = APIClient()
        self.client.force_authenticate(self.root)

    def payload(self, **permissions):
        return {'first_name': '합성 인사 계정', 'username': 'new-hr', 'email': 'new-hr@example.invalid',
                'department': '인사', 'permissions': permissions}

    def edit(self, target=None, **data):
        return self.client.patch(f'/api/admin/user-profiles/{(target or self.target).profile.pk}/', data, format='json')

    def test_create_grant_and_revoke_control_actual_hr_endpoint_and_user_response(self):
        response = self.client.post('/api/admin/users/', self.payload(can_manage_hr=True), format='json')
        self.assertEqual(response.status_code, 201)
        self.assertTrue(response.data['can_manage_hr'])
        created = User.objects.get(username='new-hr')
        self.assertFalse(created.is_staff)
        self.assertFalse(created.is_superuser)
        self.assertTrue(UserSerializer(created).data['can_access_hr'])
        grant = HrAccessGrant.objects.get(user=created)
        self.assertEqual(grant.updated_by, self.root)
        history = HrAccessHistory.objects.get(user=created)
        self.assertEqual(history.actor, self.root)
        self.client.force_authenticate(created)
        self.assertEqual(self.client.get('/api/analytics/hr/workspaces/2026-10/').status_code, 200)
        self.assertEqual(self.client.get('/api/analytics/hr/access/').status_code, 403)
        self.client.force_authenticate(self.root)
        self.assertEqual(self.edit(created, can_manage_hr=False).status_code, 200)
        self.client.force_authenticate(created)
        self.assertEqual(self.client.get('/api/analytics/hr/workspaces/2026-10/').status_code, 403)
        self.assertFalse(UserSerializer(created).data['can_access_hr'])
        self.assertEqual(HrAccessHistory.objects.filter(user=created).count(), 2)

    def test_ordinary_admin_creation_never_inherits_hr(self):
        for actor in [self.root, self.admin, self.staff]:
            self.client.force_authenticate(actor)
            payload = self.payload(is_admin=True)
            payload['username'] = f'ordinary-{actor.pk}'
            payload['email'] = f'ordinary-{actor.pk}@example.invalid'
            response = self.client.post('/api/admin/users/', payload, format='json')
            self.assertEqual(response.status_code, 201)
            self.assertFalse(response.data['can_manage_hr'])
            self.assertFalse(can_access_hr(User.objects.get(username=payload['username'])))
        self.assertEqual(HrAccessHistory.objects.count(), 0)

    def test_non_superusers_cannot_submit_grant_changes_on_create_or_edit(self):
        inactive = User.objects.create_superuser('inactive', is_active=False)
        for actor in [self.admin, self.staff, self.hr, self.target, inactive, None]:
            self.client.force_authenticate(actor)
            for enabled in [True, False]:
                created = self.client.post('/api/admin/users/', self.payload(can_manage_hr=enabled), format='json')
                self.assertIn(created.status_code, [401, 403])
                changed = self.edit(self.hr, first_name='must not persist', can_manage_hr=enabled)
                self.assertIn(changed.status_code, [401, 403])
        self.hr.refresh_from_db()
        self.assertEqual(self.hr.first_name, '')
        self.assertTrue(can_access_hr(self.hr))
        self.assertFalse(User.objects.filter(username='new-hr').exists())
        self.assertEqual(HrAccessHistory.objects.count(), 0)

    def test_unrelated_profile_edits_preserve_hr_grant(self):
        self.client.force_authenticate(self.admin)
        response = self.edit(self.hr, department='새 부서')
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.data['can_manage_hr'])
        self.assertTrue(can_access_hr(self.hr))
        self.assertEqual(HrAccessHistory.objects.count(), 0)

    def test_both_grant_screens_share_idempotent_state_and_history(self):
        self.assertEqual(self.edit(can_manage_hr=True).status_code, 200)
        self.assertEqual(self.edit(can_manage_hr=True).status_code, 200)
        self.assertEqual(HrAccessHistory.objects.count(), 1)
        self.client.patch(f'/api/analytics/hr/access/{self.target.pk}/', {'granted': False}, format='json')
        response = self.client.get('/api/admin/user-profiles/')
        self.assertEqual(response.status_code, 200)
        listing = response.data['results']
        profile = next(item for item in listing if item['user'] == self.target.pk)
        self.assertFalse(profile['can_manage_hr'])
        self.assertEqual(HrAccessHistory.objects.count(), 2)

    def test_inactive_and_superuser_targets_reject_grant_with_atomic_identity_changes(self):
        self.target.is_active = False
        self.target.save()
        for target, enabled in [(self.target, True), (self.root, False), (self.root, True)]:
            response = self.edit(target, first_name='must not persist', can_manage_hr=enabled)
            self.assertEqual(response.status_code, 400)
            target.refresh_from_db()
            self.assertNotEqual(target.first_name, 'must not persist')
        self.assertEqual(HrAccessHistory.objects.count(), 0)

    def test_duplicate_identity_does_not_partially_grant(self):
        response = self.edit(username='root', can_manage_hr=True)
        self.assertEqual(response.status_code, 400)
        self.assertFalse(can_access_hr(self.target))
        self.assertEqual(HrAccessHistory.objects.count(), 0)

    def test_audit_failure_rolls_back_account_and_profile_changes(self):
        with patch('analytics.hr_access_service.HrAccessHistory.objects.create', side_effect=RuntimeError('synthetic audit failure')):
            created = self.client.post('/api/admin/users/', self.payload(can_manage_hr=True), format='json')
            self.assertEqual(created.status_code, 500)
            self.assertEqual(self.edit(first_name='must not persist', can_manage_hr=True).status_code, 500)
        self.assertFalse(User.objects.filter(username='new-hr').exists())
        self.target.refresh_from_db()
        self.assertEqual(self.target.first_name, '')
        self.assertFalse(can_access_hr(self.target))

    def test_signup_approval_grants_hr_only_from_superuser(self):
        for actor, expected in [(self.admin, 403), (self.root, 200)]:
            signup = UserRegistrationRequest.objects.create(full_name='합성 승인', department='인사', email=f'approval-{actor.pk}@example.invalid')
            self.client.force_authenticate(actor)
            response = self.client.post(f'/api/admin/approval-requests/{signup.pk}/approve/', {'permissions': {'can_manage_hr': True}}, format='json')
            self.assertEqual(response.status_code, expected)
            signup.refresh_from_db()
            if expected == 200:
                created = User.objects.get(email=signup.email)
                self.assertTrue(can_access_hr(created))
                self.assertEqual(HrAccessHistory.objects.get(user=created).actor, self.root)
            else:
                self.assertEqual(signup.status, 'pending')
                self.assertFalse(User.objects.filter(email=signup.email).exists())

    def test_invalid_grant_value_rejects_without_account_creation(self):
        response = self.client.post('/api/admin/users/', self.payload(can_manage_hr='not-a-boolean'), format='json')
        self.assertEqual(response.status_code, 400)
        self.assertFalse(User.objects.filter(username='new-hr').exists())
