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
        
        # 이미지 URL을 명시적으로 반환
        if instance.image1:
            try:
                data['image1'] = instance.image1.url
            except:
                data['image1'] = None
        
        if instance.image2:
            try:
                data['image2'] = instance.image2.url
            except:
                data['image2'] = None
        
        if instance.image3:
            try:
                data['image3'] = instance.image3.url
            except:
                data['image3'] = None
        
        return data


class SupplierSerializer(serializers.ModelSerializer):
    class Meta:
        model = Supplier
        fields = ['id', 'name', 'created_at']
        read_only_fields = ['created_at']




