from rest_framework import serializers

from .models import ProductionExecution, ProductionPlan, ProductionPlanChangeLog
from .product_context import extract_plan_product_context


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
            'product_family_code',
            'product_family_name',
            'is_finished_product',
            'part_no',
            'planned_quantity',
            'sequence',
            'created_at',
            'updated_at',
        ]
        read_only_fields = ['id', 'plan_date', 'plan_type', 'created_at', 'updated_at']

    def validate(self, attrs):
        if 'part_spec' in attrs:
            attrs.update(extract_plan_product_context(attrs.get('part_spec')))
        return attrs

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


class ProductionPlanChangeLogSerializer(serializers.ModelSerializer):
    changed_by_name = serializers.SerializerMethodField()

    class Meta:
        model = ProductionPlanChangeLog
        fields = [
            'id',
            'plan_date',
            'plan_type',
            'action',
            'machine_name',
            'part_no',
            'model_name',
            'lot_no',
            'plan_id',
            'before',
            'after',
            'summary',
            'changed_by_name',
            'created_at',
        ]

    def get_changed_by_name(self, obj):
        user = obj.changed_by
        if not user:
            return None
        return getattr(user, 'username', None) or getattr(user, 'email', None) or str(user)
