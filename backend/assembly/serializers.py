from rest_framework import serializers
from .models import AssemblyReport

class AssemblyReportSerializer(serializers.ModelSerializer):
    # 계산된 필드들을 읽기 전용으로 포함
    total_defect_qty = serializers.ReadOnlyField()
    achievement_rate = serializers.ReadOnlyField()
    operation_rate = serializers.ReadOnlyField()
    uph = serializers.ReadOnlyField()
    upph = serializers.ReadOnlyField()

    class Meta:
        model = AssemblyReport
        fields = [
            'id', 'date', 'line_no', 'part_no', 'model', 'supply_type',
            'plan_qty', 'input_qty', 'actual_qty', 'rework_qty',
            'injection_defect', 'outsourcing_defect', 'processing_defect',
            'incoming_defects_detail', 'processing_defects_detail',
            'processing_defects_dynamic', 'outsourcing_defects_dynamic',
            'operation_time', 'total_time', 'idle_time', 'workers',
            'note',
            'created_at', 'updated_at',
            # 계산된 필드들
            'total_defect_qty', 'achievement_rate', 'operation_rate', 
            'uph', 'upph'
        ]