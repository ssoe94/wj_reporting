from rest_framework import serializers
from .models import InjectionReport, Product, PartSpec, EngineeringChangeOrder

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

class EngineeringChangeOrderSerializer(serializers.ModelSerializer):
    class Meta:
        model = EngineeringChangeOrder
        fields = '__all__' 