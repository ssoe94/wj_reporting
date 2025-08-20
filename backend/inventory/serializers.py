from rest_framework import serializers
from .models import StagingInventory, FactInventory, DailyInventorySnapshot


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