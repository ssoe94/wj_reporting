from rest_framework import serializers
from .models import InjectionReport

class InjectionReportSerializer(serializers.ModelSerializer):
    achievement_rate = serializers.FloatField(read_only=True)
    defect_rate = serializers.FloatField(read_only=True)
    total_qty = serializers.IntegerField(read_only=True)
    uptime_rate = serializers.FloatField(read_only=True)

    class Meta:
        model = InjectionReport
        fields = [
            'id', 'date', 'tonnage', 'model', 'section',
            'plan_qty', 'actual_qty', 'reported_defect', 'actual_defect',
            'operation_time', 'total_time', 'note',
            'achievement_rate', 'defect_rate', 'total_qty', 'uptime_rate',
            'created_at', 'updated_at'
        ]
        read_only_fields = ['created_at', 'updated_at'] 