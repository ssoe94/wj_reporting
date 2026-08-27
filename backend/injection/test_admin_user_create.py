from django.contrib.auth.models import User
from django.test import Client, TestCase
from rest_framework.test import APIClient

from injection.models import UserRegistrationRequest


class AdminUserCreateTests(TestCase):
    endpoint = '/api/admin/users/'

    def setUp(self):
        self.admin = User.objects.create_superuser('admin', password='StrongAdmin2026!')
        self.client = APIClient()
        self.client.force_authenticate(self.admin)

    def create_payload(self, **overrides):
        payload = {
            'first_name': '금형 담당자',
            'username': 'mould-confirmer',
            'email': 'mould-confirmer@njwanjia.com',
            'department': '금형',
            'permissions': {
                'can_confirm_moulds': True,
                'can_edit_quality': True,
                'is_admin': False,
            },
        }
        payload.update(overrides)
        return payload

    def test_admin_creates_user_with_random_initial_password_and_forced_change(self):
        response = self.client.post(
            self.endpoint,
            self.create_payload(password='ClientSuppliedPasswordMustBeIgnored!'),
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        initial_password = response.json()['initial_password']
        user = User.objects.get(username='mould-confirmer')
        self.assertEqual(user.first_name, '금형 담당자')
        self.assertEqual(user.email, 'mould-confirmer@njwanjia.com')
        self.assertGreaterEqual(len(initial_password), 12)
        self.assertTrue(user.check_password(initial_password))
        self.assertFalse(user.check_password('ClientSuppliedPasswordMustBeIgnored!'))
        self.assertTrue(user.is_active)
        self.assertFalse(user.is_staff)
        self.assertEqual(user.profile.department, '금형')
        self.assertTrue(user.profile.can_confirm_moulds)
        self.assertTrue(user.profile.can_edit_quality)
        self.assertFalse(user.profile.can_edit_injection)
        self.assertFalse(user.profile.is_admin)
        self.assertTrue(user.profile.is_using_temp_password)
        self.assertTrue(user.profile.password_reset_required)
        self.assertNotIn('password', response.json())
        self.assertIn('no-store', response['Cache-Control'])

    def test_each_created_user_receives_a_different_initial_password(self):
        first = self.client.post(self.endpoint, self.create_payload(), format='json')
        second = self.client.post(
            self.endpoint,
            self.create_payload(
                username='mould-confirmer-2',
                email='mould-confirmer-2@njwanjia.com',
            ),
            format='json',
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(second.status_code, 201)
        self.assertNotEqual(
            first.json()['initial_password'],
            second.json()['initial_password'],
        )

    def test_admin_can_create_application_admin(self):
        response = self.client.post(
            self.endpoint,
            self.create_payload(
                username='app-admin',
                email='app-admin@njwanjia.com',
                permissions={'is_admin': True},
            ),
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        initial_password = response.json()['initial_password']
        user = User.objects.get(username='app-admin')
        self.assertFalse(user.is_staff)
        self.assertTrue(user.profile.is_admin)
        self.assertTrue(user.profile.password_reset_required)

        session_client = Client()
        self.assertTrue(session_client.login(username='app-admin', password=initial_password))
        self.assertNotEqual(session_client.get('/admin/').status_code, 200)
        self.assertNotEqual(session_client.get('/staff/signup-approvals/').status_code, 200)

    def test_duplicate_username_is_rejected_case_insensitively(self):
        User.objects.create_user('ExistingUser', password='StrongExisting2026!')

        response = self.client.post(
            self.endpoint,
            self.create_payload(username='existinguser'),
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('username', response.json())
        self.assertEqual(User.objects.filter(username__iexact='existinguser').count(), 1)

    def test_duplicate_email_is_rejected_case_insensitively(self):
        User.objects.create_user(
            'existing-email',
            email='Existing.Email@njwanjia.com',
            password='StrongExisting2026!',
        )

        response = self.client.post(
            self.endpoint,
            self.create_payload(
                username='unique-user',
                email='existing.email@njwanjia.com',
            ),
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn('email', response.json())
        self.assertFalse(User.objects.filter(username='unique-user').exists())

    def test_regular_user_cannot_create_accounts(self):
        regular = User.objects.create_user('regular', password='StrongRegular2026!')
        client = APIClient()
        client.force_authenticate(regular)

        response = client.post(
            self.endpoint,
            self.create_payload(username='blocked', email='blocked@njwanjia.com'),
            format='json',
        )

        self.assertEqual(response.status_code, 403)
        self.assertFalse(User.objects.filter(username='blocked').exists())


class AdminUserEditTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser('admin', password='StrongAdmin2026!')
        self.user = User.objects.create_user(
            'old-id',
            first_name='이전 이름',
            email='old@njwanjia.com',
            password='StrongUser2026!',
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.endpoint = f'/api/admin/user-profiles/{self.user.profile.id}/'

    def test_admin_edits_identity_department_and_permissions_together(self):
        response = self.client.patch(
            self.endpoint,
            {
                'first_name': '새 이름',
                'username': 'new-id',
                'email': 'NEW@njwanjia.com',
                'department': '품질',
                'can_edit_quality': True,
                'can_confirm_moulds': True,
                'is_admin': True,
            },
            format='json',
        )

        self.assertEqual(response.status_code, 200)
        self.user.refresh_from_db()
        self.user.profile.refresh_from_db()
        self.assertEqual(self.user.first_name, '새 이름')
        self.assertEqual(self.user.username, 'new-id')
        self.assertEqual(self.user.email, 'new@njwanjia.com')
        self.assertFalse(self.user.is_staff)
        self.assertEqual(self.user.profile.department, '품질')
        self.assertTrue(self.user.profile.can_edit_quality)
        self.assertTrue(self.user.profile.can_confirm_moulds)
        self.assertTrue(self.user.profile.is_admin)

    def test_duplicate_identity_is_rejected_without_partial_update(self):
        User.objects.create_user(
            'already-used',
            email='already-used@njwanjia.com',
            password='StrongExisting2026!',
        )

        response = self.client.patch(
            self.endpoint,
            {
                'username': 'ALREADY-USED',
                'department': '변경되면 안 됨',
            },
            format='json',
        )

        self.assertEqual(response.status_code, 400)
        self.user.refresh_from_db()
        self.user.profile.refresh_from_db()
        self.assertEqual(self.user.username, 'old-id')
        self.assertEqual(self.user.profile.department, '')


class AdminUserStatusTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser('admin', password='StrongAdmin2026!')
        self.user = User.objects.create_user(
            'managed-user',
            email='managed-user@njwanjia.com',
            password='StrongUser2026!',
        )
        self.client = APIClient()
        self.client.force_authenticate(self.admin)
        self.endpoint = f'/api/admin/user-profiles/{self.user.profile.id}/'

    def test_account_can_be_deactivated_and_reactivated_without_deleting_profile(self):
        deactivate = self.client.patch(self.endpoint, {'is_active': False}, format='json')

        self.assertEqual(deactivate.status_code, 200)
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_active)
        self.assertTrue(User.objects.filter(pk=self.user.pk).exists())
        self.assertTrue(User.objects.filter(pk=self.user.pk, profile__isnull=False).exists())
        self.assertNotEqual(
            APIClient().post(
                '/api/token/',
                {'username': self.user.username, 'password': 'StrongUser2026!'},
                format='json',
            ).status_code,
            200,
        )

        reactivate = self.client.patch(self.endpoint, {'is_active': True}, format='json')
        self.assertEqual(reactivate.status_code, 200)
        self.user.refresh_from_db()
        self.assertTrue(self.user.is_active)

    def test_legacy_delete_request_deactivates_instead_of_deleting_user(self):
        response = self.client.delete(self.endpoint)

        self.assertEqual(response.status_code, 204)
        self.user.refresh_from_db()
        self.assertFalse(self.user.is_active)
        self.assertTrue(User.objects.filter(pk=self.user.pk).exists())

    def test_admin_cannot_deactivate_own_staff_account(self):
        endpoint = f'/api/admin/user-profiles/{self.admin.profile.id}/'
        response = self.client.patch(endpoint, {'is_active': False}, format='json')

        self.assertEqual(response.status_code, 400)
        self.admin.refresh_from_db()
        self.assertTrue(self.admin.is_active)
        self.assertIn('is_active', response.json())

    def test_admin_password_reset_revokes_existing_access_and_refresh_tokens(self):
        session = APIClient().post(
            '/api/token/',
            {'username': self.user.username, 'password': 'StrongUser2026!'},
            format='json',
        )
        self.assertEqual(session.status_code, 200)

        reset = self.client.post(
            '/api/admin/user/reset-password/',
            {'user_id': self.user.pk},
            format='json',
        )
        self.assertEqual(reset.status_code, 200)
        self.assertIn('no-store', reset['Cache-Control'])

        authenticated = APIClient()
        authenticated.credentials(HTTP_AUTHORIZATION=f"Bearer {session.json()['access']}")
        self.assertEqual(authenticated.get('/api/injection/user/me/').status_code, 401)
        self.assertEqual(
            APIClient().post(
                '/api/token/refresh/',
                {'refresh': session.json()['refresh']},
                format='json',
            ).status_code,
            401,
        )

        temporary_password = reset.json()['temporary_password']
        self.assertEqual(
            APIClient().post(
                '/api/token/',
                {'username': self.user.username, 'password': 'StrongUser2026!'},
                format='json',
            ).status_code,
            401,
        )
        new_session = APIClient().post(
            '/api/token/',
            {'username': self.user.username, 'password': temporary_password},
            format='json',
        )
        self.assertEqual(new_session.status_code, 200)


class MissingUserProfileAuthenticationTests(TestCase):
    def test_user_without_profile_cannot_obtain_or_use_application_tokens(self):
        user = User.objects.create_user(
            'missing-profile',
            password='StrongExisting2026!',
        )
        token_response = APIClient().post(
            '/api/token/',
            {'username': user.username, 'password': 'StrongExisting2026!'},
            format='json',
        )
        self.assertEqual(token_response.status_code, 200)
        access_token = token_response.json()['access']

        user.profile.delete()

        relogin_response = APIClient().post(
            '/api/token/',
            {'username': user.username, 'password': 'StrongExisting2026!'},
            format='json',
        )
        self.assertEqual(relogin_response.status_code, 401)

        authenticated_client = APIClient()
        authenticated_client.credentials(HTTP_AUTHORIZATION=f'Bearer {access_token}')
        blocked_response = authenticated_client.get('/api/injection/user/me/')
        self.assertEqual(blocked_response.status_code, 403)
        self.assertEqual(blocked_response.json()['code'], 'user_profile_required')


class SignupApprovalAdminSafetyTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser('admin', password='StrongAdmin2026!')

    def create_request(self, suffix):
        return UserRegistrationRequest.objects.create(
            full_name=f'승인 사용자 {suffix}',
            department='생산',
            email=f'approved-{suffix}@njwanjia.com',
        )

    def assert_application_admin_is_not_django_staff(self, signup_request):
        user = User.objects.get(email=signup_request.email)
        self.assertFalse(user.is_staff)
        self.assertTrue(user.profile.is_admin)
        self.assertTrue(user.profile.password_reset_required)

    def test_approval_api_does_not_grant_django_staff(self):
        signup_request = self.create_request('api')
        client = APIClient()
        client.force_authenticate(self.admin)
        response = client.post(
            f'/api/admin/approval-requests/{signup_request.id}/approve/',
            {'permissions': {'is_admin': True}},
            format='json',
        )
        self.assertEqual(response.status_code, 200)
        self.assert_application_admin_is_not_django_staff(signup_request)

    def test_legacy_approval_api_does_not_grant_django_staff(self):
        signup_request = self.create_request('legacy')
        client = APIClient()
        client.force_authenticate(self.admin)
        response = client.post(
            f'/api/admin/signup-requests/{signup_request.id}/approve/',
            {'permissions': {'is_admin': True}},
            format='json',
        )
        self.assertEqual(response.status_code, 200)
        self.assert_application_admin_is_not_django_staff(signup_request)

    def test_staff_portal_approval_does_not_grant_django_staff(self):
        signup_request = self.create_request('portal')
        client = Client()
        client.force_login(self.admin)
        response = client.post(
            '/staff/signup-approvals/',
            {
                'action': 'approve',
                'request_id': signup_request.id,
                'is_admin': 'on',
            },
        )
        self.assertEqual(response.status_code, 302)
        self.assert_application_admin_is_not_django_staff(signup_request)


class FirstLoginPasswordChangeTests(TestCase):
    def setUp(self):
        self.admin = User.objects.create_superuser('admin', password='StrongAdmin2026!')
        admin_client = APIClient()
        admin_client.force_authenticate(self.admin)
        response = admin_client.post(
            '/api/admin/users/',
            {
                'first_name': '신규 사용자',
                'username': 'first-login-user',
                'email': 'first-login@njwanjia.com',
                'department': '생산',
                'permissions': {},
            },
            format='json',
        )
        self.assertEqual(response.status_code, 201)
        self.initial_password = response.json()['initial_password']

        login_client = APIClient()
        token_response = login_client.post(
            '/api/token/',
            {'username': 'first-login-user', 'password': self.initial_password},
            format='json',
        )
        self.assertEqual(token_response.status_code, 200)
        self.refresh_token = token_response.json()['refresh']
        self.client = APIClient()
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_response.json()['access']}")

    def test_first_login_can_only_read_self_and_change_password(self):
        me_response = self.client.get('/api/injection/user/me/')
        blocked_response = self.client.get('/api/injection/inventory/')

        self.assertEqual(me_response.status_code, 200)
        self.assertTrue(me_response.json()['password_reset_required'])
        self.assertEqual(blocked_response.status_code, 403)
        self.assertEqual(blocked_response.json()['code'], 'password_change_required')

        change_response = self.client.post(
            '/api/user/change-password/',
            {
                'current_password': self.initial_password,
                'new_password': 'FreshSecret9876!',
            },
            format='json',
        )

        self.assertEqual(change_response.status_code, 200)
        user = User.objects.get(username='first-login-user')
        self.assertTrue(user.check_password('FreshSecret9876!'))
        self.assertFalse(user.check_password(self.initial_password))
        self.assertFalse(user.profile.is_using_temp_password)
        self.assertFalse(user.profile.password_reset_required)
        self.assertIsNotNone(user.profile.last_password_change)

        # Credential changes terminate the access and refresh sessions that
        # were issued for the temporary password.
        self.assertEqual(self.client.get('/api/injection/inventory/').status_code, 401)

        refresh_response = APIClient().post(
            '/api/token/refresh/',
            {'refresh': self.refresh_token},
            format='json',
        )
        self.assertEqual(refresh_response.status_code, 401)

        token_response = APIClient().post(
            '/api/token/',
            {'username': 'first-login-user', 'password': 'FreshSecret9876!'},
            format='json',
        )
        self.assertEqual(token_response.status_code, 200)
        self.client.credentials(HTTP_AUTHORIZATION=f"Bearer {token_response.json()['access']}")
        self.assertEqual(self.client.get('/api/injection/inventory/').status_code, 200)
