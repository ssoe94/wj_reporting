from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient


class AdminUserCreateTests(TestCase):
    endpoint = '/api/admin/users/'

    def setUp(self):
        self.admin = User.objects.create_superuser('admin', password='StrongAdmin2026!')
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def test_admin_creates_regular_mould_confirmer_without_broad_edit_access(self):
        response = self.client.post(
            self.endpoint,
            {
                'username': 'mould-confirmer',
                'password': 'StrongMould2026!',
                'department': '금형',
                'permissions': {'can_confirm_moulds': True},
            },
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        user = User.objects.get(username='mould-confirmer')
        self.assertTrue(user.check_password('StrongMould2026!'))
        self.assertTrue(user.is_active)
        self.assertFalse(user.is_staff)
        self.assertTrue(user.profile.can_confirm_moulds)
        self.assertFalse(user.profile.can_edit_injection)
        self.assertFalse(user.profile.is_admin)
        self.assertNotIn('password', response.json())

    def test_duplicate_username_is_rejected_case_insensitively(self):
        User.objects.create_user('ExistingUser', password='StrongExisting2026!')

        response = self.client.post(
            self.endpoint,
            {'username': 'existinguser', 'password': 'StrongMould2026!'},
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(User.objects.filter(username__iexact='existinguser').count(), 1)

    def test_regular_user_cannot_create_accounts(self):
        regular = User.objects.create_user('regular', password='StrongRegular2026!')
        client = APIClient()
        client.force_authenticate(regular)

        response = client.post(
            self.endpoint,
            {'username': 'blocked', 'password': 'StrongBlocked2026!'},
            format='json',
        )

        self.assertEqual(response.status_code, 403)
        self.assertFalse(User.objects.filter(username='blocked').exists())
