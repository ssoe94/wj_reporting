from rest_framework import serializers
from .models import InjectionReport, Product, PartSpec, EngineeringChangeOrder, EcoDetail, EcoPartSpec, InventorySnapshot, UserRegistrationRequest, UserProfile, CycleTimeSetup, CycleTimeTestRecord, InjectionMonitoringRecord
from functools import lru_cache
from django.db.models.functions import Substr
from django.db.models import Avg, ExpressionWrapper, F, FloatField

@lru_cache(maxsize=1)
def get_average_actual_cycle_times(prefix_length=9):
    """
    Calculates the average actual cycle time for each part_no prefix
    from historical InjectionReport data.
    """
    reports = (
        InjectionReport.objects
        .filter(actual_qty__gt=0, part_no__isnull=False)
        .exclude(part_no__exact='')
        .filter(total_time__gt=F('idle_time')) # Corrected filter
        .annotate(
            actual_ct=ExpressionWrapper(
                ((F('total_time') - F('idle_time')) * 60.0) / F('actual_qty'), # Corrected calculation
                output_field=FloatField()
            ),
            part_prefix=Substr('part_no', 1, prefix_length)
        )
        .values('part_prefix')
        .annotate(avg_actual_ct=Avg('actual_ct'))
        .filter(avg_actual_ct__isnull=False)
    )
    
    return {item['part_prefix']: item['avg_actual_ct'] for item in reports}

class InjectionReportSerializer(serializers.ModelSerializer):
    achievement_rate = serializers.FloatField(read_only=True)
    defect_rate = serializers.FloatField(read_only=True)
    total_qty = serializers.IntegerField(read_only=True)
    uptime_rate = serializers.FloatField(read_only=True)
    cycle_time_deviation = serializers.SerializerMethodField()
    operation_time = serializers.IntegerField(read_only=True) # Add this to expose the property

    class Meta:
        model = InjectionReport
        fields = [
            'id', 'date', 'machine_no', 'tonnage', 'model', 'section',
            'plan_qty', 'actual_qty', 'reported_defect', 'actual_defect',
            'start_datetime', 'end_datetime', 'total_time', 'idle_time', 'operation_time',
            'part_no', 'note',
            'achievement_rate', 'defect_rate', 'total_qty', 'uptime_rate',
            'cycle_time_deviation',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at']

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if data.get('part_no'):
            data['part_no'] = data['part_no'].upper()
        return data

    def get_cycle_time_deviation(self, obj):
        if not obj.actual_qty or obj.actual_qty == 0 or not obj.operation_time:
            return None
        
        actual_cycle_time = (obj.operation_time * 60) / obj.actual_qty

        if not obj.part_no:
            return None
        
        prefix_length = 9
        part_prefix = obj.part_no[:prefix_length]

        avg_actual_cts = get_average_actual_cycle_times(prefix_length)
        baseline_ct = avg_actual_cts.get(part_prefix)

        if baseline_ct is None:
            return None

        deviation = actual_cycle_time - baseline_ct
        return round(deviation, 2)

class ProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = Product
        fields = ['id', 'model', 'type', 'fg_part_no', 'wip_part_no']

class PartSpecSerializer(serializers.ModelSerializer):
    class Meta:
        model = PartSpec
        fields = '__all__'

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if data.get('part_no'):
            data['part_no'] = data['part_no'].upper()
        return data

# EcoDetailSerializer 먼저 정의
class EcoPartSpecSerializer(serializers.ModelSerializer):
    class Meta:
        model = EcoPartSpec
        fields = ['id', 'part_no', 'description', 'model_code', 'eco_category', 'change_history', 'created_at', 'updated_at']
        read_only_fields = ['created_at', 'updated_at']

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if data.get('part_no'):
            data['part_no'] = data['part_no'].upper()
        return data

    def validate_part_no(self, value):
        return (value or '').upper()

class EcoDetailSerializer(serializers.ModelSerializer):
    part_no = serializers.CharField(source='eco_part_spec.part_no', read_only=True)
    description = serializers.CharField(source='eco_part_spec.description', read_only=True)

    class Meta:
        model = EcoDetail
        fields = ['id', 'eco_header', 'eco_part_spec', 'part_no', 'description', 'change_reason', 'change_details', 'status', 'created_at']
        read_only_fields = ['created_at']

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if data.get('part_no'):
            data['part_no'] = data['part_no'].upper()
        return data


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
            'id', 'full_name', 'department', 'email', 'reason', 'status', 'created_at',
            'can_view_injection', 'can_view_assembly', 'can_view_quality',
            'can_view_sales', 'can_view_development', 'is_admin'
        ]
        read_only_fields = ['status', 'created_at']
    
    def validate_email(self, value):
        if not value.endswith('@njwanjia.com'):
            raise serializers.ValidationError('@njwanjia.com 도메인 이메일만 사용 가능합니다.')
        return value

    def validate(self, attrs):
        email = attrs.get('email')
        if email:
            existing = UserRegistrationRequest.objects.filter(email=email).exclude(status='rejected').first()
            if existing and existing.pk != getattr(self.instance, 'pk', None):
                raise serializers.ValidationError({
                    'email': '이미 처리 중인 가입 요청이 존재합니다. 관리자 승인을 기다려주세요.'
                })
        return super().validate(attrs)


class UserProfileSerializer(serializers.ModelSerializer):
    username = serializers.CharField(source='user.username', read_only=True)
    email = serializers.CharField(source='user.email', read_only=True)
    first_name = serializers.CharField(source='user.first_name', read_only=True)

    class Meta:
        model = UserProfile
        fields = [
            'id', 'user', 'username', 'email', 'first_name', 'department',
            'can_view_injection', 'can_view_assembly', 'can_view_quality',
            'can_view_sales', 'can_view_development',
            'can_edit_injection', 'can_edit_assembly', 'can_edit_quality',
            'can_edit_sales', 'can_edit_development',
            'is_admin', 'created_at', 'updated_at'
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
            # 프로필이 없는 경우 기본 권한 부여 (스태프는 모든 권한, 일반 사용자는 조회만)
            return {
                'can_view_injection': True,
                'can_view_assembly': True,
                'can_view_quality': True,
                'can_view_sales': True,
                'can_view_development': True,
                'can_edit_injection': bool(obj.is_staff),
                'can_edit_assembly': bool(obj.is_staff),
                'can_edit_quality': bool(obj.is_staff),
                'can_edit_sales': bool(obj.is_staff),
                'can_edit_development': bool(obj.is_staff),
                'can_edit_eco': bool(obj.is_staff),
                'can_edit_machining': bool(obj.is_staff),
                'can_edit_inventory': bool(obj.is_staff),
                'is_admin': bool(obj.is_staff),
            }
        return {
            'can_view_injection': bool(profile.can_view_injection or obj.is_staff),
            'can_view_assembly': bool(profile.can_view_assembly or obj.is_staff),
            'can_view_quality': bool(profile.can_view_quality or obj.is_staff),
            'can_view_sales': bool(profile.can_view_sales or obj.is_staff),
            'can_view_development': bool(profile.can_view_development or obj.is_staff),
            # 편집 권한 - 체크박스 설정대로 정확히 반영 (스태프는 항상 허용)
            'can_edit_injection': bool(profile.can_edit_injection or obj.is_staff),
            'can_edit_assembly': bool(profile.can_edit_assembly or obj.is_staff),
            'can_edit_quality': bool(profile.can_edit_quality or obj.is_staff),
            'can_edit_sales': bool(profile.can_edit_sales or obj.is_staff),
            'can_edit_development': bool(profile.can_edit_development or obj.is_staff),
            # 호환성을 위한 레거시 필드들
            'can_edit_eco': bool(profile.can_edit_development or obj.is_staff),
            'can_edit_machining': bool(profile.can_edit_assembly or obj.is_staff),
            'can_edit_inventory': bool(profile.can_edit_sales or obj.is_staff),
            'is_admin': bool(profile.is_admin or obj.is_staff),
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

class HistoricalPerformanceSerializer(serializers.ModelSerializer):
    """
    Serializer for the historical performance chart.
    """
    actual_cycle_time = serializers.SerializerMethodField()

    class Meta:
        model = InjectionReport
        fields = ['date', 'part_no', 'actual_qty', 'actual_cycle_time']

    def get_actual_cycle_time(self, obj):
        if not obj.actual_qty or obj.actual_qty == 0 or not obj.operation_time:
            return None
        
        # operation_time is a property now, so this works
        return round((obj.operation_time * 60) / obj.actual_qty, 2)


class CycleTimeTestRecordSerializer(serializers.ModelSerializer):
    tested_by_name = serializers.CharField(source='tested_by.first_name', read_only=True)

    class Meta:
        model = CycleTimeTestRecord
        fields = [
            'id', 'setup', 'test_datetime', 'actual_cycle_time', 'test_qty',
            'quality_ok', 'note', 'tested_by', 'tested_by_name'
        ]
        read_only_fields = ['test_datetime', 'tested_by', 'tested_by_name']


class CycleTimeSetupSerializer(serializers.ModelSerializer):
    setup_by_name = serializers.CharField(source='setup_by.first_name', read_only=True)
    approved_by_name = serializers.CharField(source='approved_by.first_name', read_only=True)
    test_records = CycleTimeTestRecordSerializer(many=True, read_only=True)
    final_cycle_time = serializers.IntegerField(read_only=True)
    status_display = serializers.CharField(source='get_status_display', read_only=True)

    # 평균 테스트 사이클 타임 계산
    avg_test_cycle_time = serializers.SerializerMethodField()
    test_count = serializers.SerializerMethodField()
    quality_pass_rate = serializers.SerializerMethodField()

    class Meta:
        model = CycleTimeSetup
        fields = [
            'id', 'setup_date', 'machine_no', 'part_no', 'model_code', 'target_cycle_time',
            'standard_cycle_time', 'mean_cycle_time', 'personnel_count', 'status', 'status_display',
            'setup_by', 'setup_by_name', 'approved_by', 'approved_by_name',
            'approved_at', 'note', 'rejection_reason', 'created_at', 'updated_at',
            'test_records', 'final_cycle_time', 'avg_test_cycle_time',
            'test_count', 'quality_pass_rate'
        ]
        read_only_fields = ['setup_date', 'setup_by', 'setup_by_name', 'approved_by_name', 'created_at', 'updated_at']

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if data.get('part_no'):
            data['part_no'] = data['part_no'].upper()
        return data

    def validate_part_no(self, value):
        return (value or '').upper()

    def get_avg_test_cycle_time(self, obj):
        records = obj.test_records.all()
        if not records:
            return None
        return round(sum(r.actual_cycle_time for r in records) / len(records), 1)

    def get_test_count(self, obj):
        return obj.test_records.count()

    def get_quality_pass_rate(self, obj):
        records = obj.test_records.all()
        if not records:
            return None
        pass_count = records.filter(quality_ok=True).count()
        return round((pass_count / len(records)) * 100, 1)


class CycleTimeSetupDashboardSerializer(serializers.Serializer):
    """대시보드용 간단한 셋업 정보"""
    total_setups_today = serializers.IntegerField()
    pending_approvals = serializers.IntegerField()
    approved_today = serializers.IntegerField()
    rejected_today = serializers.IntegerField()
    active_machines = serializers.ListField(child=serializers.IntegerField())
    recent_setups = CycleTimeSetupSerializer(many=True)

class InjectionMonitoringRecordSerializer(serializers.ModelSerializer):
    """사출기 모니터링 기록 Serializer"""
    class Meta:
        model = InjectionMonitoringRecord
        fields = '__all__'
