from rest_framework import serializers

from .models import ProductionPlan


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
