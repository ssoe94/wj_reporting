from rest_framework import serializers

from .models import ProductionExecution, ProductionPlan


class ProductionPlanSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProductionPlan
        fields = [
            'id',
            'plan_date',
            'plan_type',
            'machine_name',
            'lot_no',
            'model_name',
            'part_spec',
            'part_no',
            'planned_quantity',
            'sequence',
        ]
        read_only_fields = ['id', 'plan_date', 'plan_type']

    def validate_planned_quantity(self, value):
        try:
            return int(round(float(value)))
        except (TypeError, ValueError):
            raise serializers.ValidationError('Invalid planned quantity.')


class ProductionExecutionSerializer(serializers.ModelSerializer):
    class Meta:
        model = ProductionExecution
        fields = [
            'id',
            'plan_date',
            'plan_type',
            'machine_name',
            'part_no',
            'lot_no',
            'sequence',
            'model_name',
            'actual_qty',
            'defect_qty',
            'idle_time',
            'personnel_count',
            'operating_ct',
            'start_datetime',
            'end_datetime',
            'note',
            'status',
            'updated_by',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'updated_by', 'created_at', 'updated_at']

    def validate_actual_qty(self, value):
        return max(0, int(value or 0))

    def validate_defect_qty(self, value):
        return max(0, int(value or 0))

    def validate_idle_time(self, value):
        return max(0, int(value or 0))

    def validate_personnel_count(self, value):
        return max(0, float(value or 0))
