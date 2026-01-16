from rest_framework import serializers
from .models import (
    StagingInventory,
    FactInventory,
    DailyInventorySnapshot,
    UnifiedPartSpec,
    FinishedGoodsTransaction,
    FinishedGoodsTransactionSnapshot,
)


class StagingInventorySerializer(serializers.ModelSerializer):
    class Meta:
        model = StagingInventory
        fields = '__all__'


class FactInventorySerializer(serializers.ModelSerializer):
    class Meta:
        model = FactInventory
        fields = '__all__'


class DailyInventorySnapshotSerializer(serializers.ModelSerializer):
    class Meta:
        model = DailyInventorySnapshot
        fields = '__all__'


class UnifiedPartSpecSerializer(serializers.ModelSerializer):
    """통합 품목 스펙 시리얼라이저"""
    class Meta:
        model = UnifiedPartSpec
        fields = '__all__'
        read_only_fields = ('created_at', 'updated_at')

    def create(self, validated_data):
        """통합 품목 생성"""
        # valid_from이 없으면 현재 날짜로 설정
        if 'valid_from' not in validated_data:
            from django.utils import timezone
            validated_data['valid_from'] = timezone.now().date()
        
        return super().create(validated_data)

    def to_representation(self, instance):
        """직렬화 출력에 display_name 추가"""
        data = super().to_representation(instance)
        data['display_name'] = instance.display_name
        return data


class DailyReportSerializer(serializers.Serializer):
    """일일 보고서 데이터 시리얼라이저"""
    snapshot_date = serializers.DateField()
    material_code = serializers.CharField()
    material_name = serializers.CharField()
    specification = serializers.CharField()
    warehouse_code = serializers.CharField()
    warehouse_name = serializers.CharField()
    qc_status = serializers.CharField()
    total_quantity = serializers.DecimalField(max_digits=20, decimal_places=4)
    unit = serializers.CharField()
    cart_count = serializers.IntegerField()
    cart_details = serializers.ListField()
    
    # 전일 대비 증감 정보
    prev_quantity = serializers.DecimalField(max_digits=20, decimal_places=4, allow_null=True)
    quantity_change = serializers.DecimalField(max_digits=20, decimal_places=4, allow_null=True)
    quantity_change_percent = serializers.FloatField(allow_null=True)
    prev_cart_count = serializers.IntegerField(allow_null=True)
    cart_count_change = serializers.IntegerField(allow_null=True)


class FinishedGoodsTransactionSerializer(serializers.ModelSerializer):
    class Meta:
        model = FinishedGoodsTransaction
        fields = [
            'id',
            'material_code',
            'material_name',
            'specification',
            'warehouse_code',
            'warehouse_name',
            'unit',
            'total_in',
            'total_out',
            'net_change',
            'record_count',
            'last_in_time',
            'last_out_time',
            'action_breakdown',
            'created_at',
            'updated_at',
        ]


class FinishedGoodsTransactionSnapshotSerializer(serializers.ModelSerializer):
    transactions = FinishedGoodsTransactionSerializer(many=True, read_only=True)
    slot_display = serializers.CharField(source='get_slot_display', read_only=True)

    class Meta:
        model = FinishedGoodsTransactionSnapshot
        fields = [
            'id',
            'slot',
            'slot_display',
            'report_date',
            'scheduled_at',
            'range_start',
            'range_end',
            'record_count',
            'total_in',
            'total_out',
            'net_change',
            'warehouse_filter',
            'metadata',
            'created_at',
            'updated_at',
            'transactions',
        ]
