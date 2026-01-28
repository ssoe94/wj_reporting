from django.contrib.auth import get_user_model
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone
from rest_framework import status
from rest_framework.authentication import BaseAuthentication
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework_simplejwt.authentication import JWTAuthentication

from .models import UserRegistrationRequest, UserProfile
from .serializers import UserRegistrationRequestSerializer
from .permissions import AdminOnlyPermission

import secrets
import string

User = get_user_model()


def _generate_temp_password(length: int = 12) -> str:
    alphabet = string.ascii_letters + string.digits
    while True:
        pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
        if any(c.islower() for c in pwd) and any(c.isupper() for c in pwd) and any(c.isdigit() for c in pwd):
            return pwd


class SignupApprovalRequestsView(APIView):
    """List signup approval requests."""
    authentication_classes = [JWTAuthentication]
    permission_classes = [AdminOnlyPermission]

    def get(self, request):
        status_filter = request.query_params.get('status')
        qs = UserRegistrationRequest.objects.all()
        if status_filter:
            qs = qs.filter(status=status_filter)
        qs = qs.order_by('-created_at')
        serializer = UserRegistrationRequestSerializer(qs, many=True)
        return Response(serializer.data)


class SignupApprovalApproveView(APIView):
    """Approve a signup request and create/update user + profile."""
    authentication_classes = [JWTAuthentication]
    permission_classes = [AdminOnlyPermission]

    @transaction.atomic
    def post(self, request, pk: int):
        signup_req = UserRegistrationRequest.objects.select_for_update().filter(pk=pk).first()
        if not signup_req:
            return Response({'detail': 'Request not found'}, status=status.HTTP_404_NOT_FOUND)
        if signup_req.status != 'pending':
            return Response({'detail': 'Request already processed'}, status=status.HTTP_400_BAD_REQUEST)

        perms = (request.data or {}).get('permissions', {}) or {}
        def bool_flag(key: str) -> bool:
            return bool(perms.get(key, False))

        is_admin_flag = bool_flag('is_admin')

        username_base = signup_req.email.split('@')[0]
        username = username_base
        suffix = 1
        while User.objects.filter(username=username).exclude(email=signup_req.email).exists():
            username = f"{username_base}{suffix}"
            suffix += 1

        temp_password = _generate_temp_password(12)

        user, _created = User.objects.get_or_create(
            email=signup_req.email,
            defaults={
                'username': username,
                'first_name': signup_req.full_name,
                'password': make_password(temp_password),
                'is_staff': is_admin_flag,
            }
        )

        update_fields = ['password']
        user.password = make_password(temp_password)
        if not user.username:
            user.username = username
            update_fields.append('username')
        if not user.first_name:
            user.first_name = signup_req.full_name
            update_fields.append('first_name')
        if user.is_staff != is_admin_flag:
            user.is_staff = is_admin_flag
            update_fields.append('is_staff')
        if update_fields:
            user.save(update_fields=update_fields)

        profile = UserProfile.get_user_permissions(user)
        profile.department = signup_req.department
        profile.can_edit_injection = bool_flag('can_edit_injection')
        profile.can_edit_assembly = bool_flag('can_edit_assembly')
        profile.can_edit_quality = bool_flag('can_edit_quality')
        profile.can_edit_sales = bool_flag('can_edit_sales')
        profile.can_edit_development = bool_flag('can_edit_development')
        profile.is_admin = is_admin_flag
        profile.is_using_temp_password = True
        profile.password_reset_required = True
        profile.save(update_fields=[
            'department',
            'can_edit_injection',
            'can_edit_assembly',
            'can_edit_quality',
            'can_edit_sales',
            'can_edit_development',
            'is_admin',
            'is_using_temp_password',
            'password_reset_required',
            'updated_at',
        ])

        signup_req.status = 'approved'
        signup_req.approved_by = request.user
        signup_req.approved_at = timezone.now()
        signup_req.temporary_password = temp_password
        signup_req.save(update_fields=['status', 'approved_by', 'approved_at', 'temporary_password'])

        return Response({
            'username': user.username,
            'temporary_password': temp_password,
        })


class SignupApprovalRejectView(APIView):
    """Reject a signup request."""
    authentication_classes = [JWTAuthentication]
    permission_classes = [AdminOnlyPermission]

    @transaction.atomic
    def post(self, request, pk: int):
        signup_req = UserRegistrationRequest.objects.select_for_update().filter(pk=pk).first()
        if not signup_req:
            return Response({'detail': 'Request not found'}, status=status.HTTP_404_NOT_FOUND)
        if signup_req.status != 'pending':
            return Response({'detail': 'Request already processed'}, status=status.HTTP_400_BAD_REQUEST)

        signup_req.status = 'rejected'
        signup_req.approved_by = request.user
        signup_req.approved_at = timezone.now()
        signup_req.save(update_fields=['status', 'approved_by', 'approved_at'])

        return Response({'detail': 'Request rejected'})
