from rest_framework import serializers
from .models import InjectionReport, Product, PartSpec, EngineeringChangeOrder, EcoDetail, EcoPartSpec, InventorySnapshot

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
        fields = '__all__' 


class InventorySnapshotSerializer(serializers.ModelSerializer):
    part_no = serializers.CharField(source='part_spec.part_no', read_only=True)

    class Meta:
        model = InventorySnapshot
        fields = ['id', 'part_spec', 'part_no', 'qty', 'collected_at']
        read_only_fields = ['collected_at'] 