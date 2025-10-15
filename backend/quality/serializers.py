from rest_framework import serializers
from .models import QualityReport, Supplier


class QualityReportSerializer(serializers.ModelSerializer):
    class Meta:
        model = QualityReport
        fields = '__all__'

    def to_representation(self, instance):
        data = super().to_representation(instance)
        if data.get('part_no'):
            data['part_no'] = data['part_no'].upper()
        
        # 이미지 URL은 이미 Cloudinary URL이므로 그대로 반환
        # URLField이므로 별도 처리 불필요
        
        return data


class SupplierSerializer(serializers.ModelSerializer):
    class Meta:
        model = Supplier
        fields = ['id', 'name', 'created_at']
        read_only_fields = ['created_at']




