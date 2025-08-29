from rest_framework import serializers
from .models import InjectionReport, Product, PartSpec, EngineeringChangeOrder, EcoDetail, EcoPartSpec, InventorySnapshot, UserRegistrationRequest, UserProfile

class InjectionReportSerializer(serializers.ModelSerializer):
    achievement_rate = serializers.FloatField(read_only=True)
    defect_rate = serializers.FloatField(read_only=True)
    total_qty = serializers.IntegerField(read_only=True)
    uptime_rate = serializers.FloatField(read_only=True)

    class Meta:
        model = InjectionReport
        fields = [
            'id', 'date', 'machine_no', 'tonnage', 'model', 'section',
            'plan_qty', 'actual_qty', 'reported_defect', 'actual_defect',
            'start_datetime', 'end_datetime', 'operation_time', 'total_time',
            'part_no', 'note',
            'achievement_rate', 'defect_rate', 'total_qty', 'uptime_rate',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at']

class ProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ['id', 'model', 'type', 'fg_part_no', 'wip_part_no']

class PartSpecSerializer(serializers.ModelSerializer):
    class Meta:
        model = PartSpec
        fields = '__all__'

# EcoDetailSerializer 먼저 정의
class EcoPartSpecSerializer(serializers.ModelSerializer):
    class Meta:
        model = EcoPartSpec
        fields = ['id', 'part_no', 'description', 'model_code', 'eco_category', 'change_history', 'created_at', 'updated_at']
        read_only_fields = ['created_at', 'updated_at']

class EcoDetailSerializer(serializers.ModelSerializer):
    part_no = serializers.CharField(source='eco_part_spec.part_no', read_only=True)
    description = serializers.CharField(source='eco_part_spec.description', read_only=True)

    class Meta:
        model = EcoDetail
        fields = ['id', 'eco_header', 'eco_part_spec', 'part_no', 'description', 'change_reason', 'change_details', 'status', 'created_at']
        read_only_fields = ['created_at']


class EngineeringChangeOrderSerializer(serializers.ModelSerializer):
    details = EcoDetailSerializer(many=True, read_only=True)

    class Meta:
        model = EngineeringChangeOrder
        fields = [
            'id', 'form_type', 'eco_no', 'eco_model', 'customer',
            'prepared_date', 'issued_date', 'received_date', 'due_date', 'close_date',
            'change_reason', 'change_details', 'applicable_work_order', 'storage_action',
            'inventory_finished', 'inventory_material', 'applicable_date', 'status', 'note',
            'created_at', 'updated_at', 'details'
        ]
        read_only_fields = ['created_at', 'updated_at'] 


class InventorySnapshotSerializer(serializers.ModelSerializer):
    part_no = serializers.CharField(source='part_spec.part_no', read_only=True)

    class Meta:
        model = InventorySnapshot
        fields = ['id', 'part_spec', 'part_no', 'qty', 'collected_at']
        read_only_fields = ['collected_at']


class UserRegistrationRequestSerializer(serializers.ModelSerializer):
    class Meta:
        model = UserRegistrationRequest
        fields = [
            'id', 'full_name', 'department', 'email', 'status', 'created_at',
            'can_view_injection', 'can_edit_injection',
            'can_view_machining', 'can_edit_machining', 
            'can_view_inventory', 'can_edit_inventory',
            'can_view_eco', 'can_edit_eco'
        ]
        read_only_fields = ['status', 'created_at']
    
    def validate_email(self, value):
        if not value.endswith('@njwanjia.com'):
            raise serializers.ValidationError('@njwanjia.com 도메인 이메일만 사용 가능합니다.')
        return value


class UserProfileSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    email = serializers.CharField(source='user.email', read_only=True)
    first_name = serializers.CharField(source='user.first_name', read_only=True)
    
    class Meta:
        model = UserProfile
        fields = [
            'id', 'user', 'username', 'email', 'first_name',
            'can_view_injection', 'can_edit_injection',
            'can_view_machining', 'can_edit_machining',
            'can_view_inventory', 'can_edit_inventory', 
            'can_view_eco', 'can_edit_eco',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['user', 'username', 'email', 'first_name', 'created_at', 'updated_at']

from django.contrib.auth import get_user_model
from django.contrib.auth import password_validation

User = get_user_model()

class UserSerializer(serializers.ModelSerializer):
    profile = UserProfileSerializer(read_only=True) # 기존 중첩 프로필 유지
    is_staff = serializers.BooleanField(read_only=True)
    groups = serializers.SerializerMethodField()
    permissions = serializers.SerializerMethodField()
    is_using_temp_password = serializers.SerializerMethodField()
    password_reset_required = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = [
            'id', 'username', 'email', 'first_name', 'last_name',
            'is_staff', 'groups',
            'permissions',
            'is_using_temp_password', 'password_reset_required',
            'profile',
        ]

    def get_groups(self, obj):
        try:
            return list(obj.groups.values_list('name', flat=True))
        except Exception:
            return []

    def _get_profile(self, obj):
        try:
            return obj.profile
        except Exception:
            return None

    def get_permissions(self, obj):
        profile = self._get_profile(obj)
        if not profile:
            return {
                'can_view_injection': False,
                'can_edit_injection': False,
                'can_view_machining': False,
                'can_edit_machining': False,
                'can_view_eco': False,
                'can_edit_eco': False,
                'can_view_inventory': False,
                'can_edit_inventory': False,
            }
        return {
            'can_view_injection': bool(profile.can_view_injection or obj.is_staff),
            'can_edit_injection': bool(profile.can_edit_injection or obj.is_staff),
            'can_view_machining': bool(profile.can_view_machining or obj.is_staff),
            'can_edit_machining': bool(profile.can_edit_machining or obj.is_staff),
            'can_view_eco': bool(profile.can_view_eco or obj.is_staff),
            'can_edit_eco': bool(profile.can_edit_eco or obj.is_staff),
            'can_view_inventory': bool(profile.can_view_inventory or obj.is_staff),
            'can_edit_inventory': bool(profile.can_edit_inventory or obj.is_staff),
        }

    def get_is_using_temp_password(self, obj):
        profile = self._get_profile(obj)
        return bool(getattr(profile, 'is_using_temp_password', False))

    def get_password_reset_required(self, obj):
        profile = self._get_profile(obj)
        return bool(getattr(profile, 'password_reset_required', False))


class ChangePasswordSerializer(serializers.Serializer):
    current_password = serializers.CharField(write_only=True)
    new_password = serializers.CharField(write_only=True, min_length=8)

    def validate(self, attrs):
        request = self.context.get('request')
        user = getattr(request, 'user', None)
        if user is None or not user.is_authenticated:
            raise serializers.ValidationError({'detail': '인증이 필요합니다.'})

        current = attrs.get('current_password')
        new = attrs.get('new_password')

        if not user.check_password(current):
            raise serializers.ValidationError({'current_password': '현재 비밀번호가 올바르지 않습니다.'})
        if current == new:
            raise serializers.ValidationError({'new_password': '이전 비밀번호와 동일할 수 없습니다.'})

        # Django 비밀번호 정책 검증
        password_validation.validate_password(new, user=user)

        return attrs
