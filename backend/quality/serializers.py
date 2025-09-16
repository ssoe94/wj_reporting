from rest_framework import serializers
from .models import QualityReport


class QualityReportSerializer(serializers.ModelSerializer):
    class Meta:
        model = QualityReport
        fields = '__all__'

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if data.get('part_no'):
            data['part_no'] = data['part_no'].upper()
        return data




