from django.urls import reverse
from rest_framework import serializers

from .models import (
    QualityImportAsset,
    QualityImportBatch,
    QualityImportMedia,
    QualityImportProvenance,
    QualityImportRow,
    QualityReport,
    Supplier,
)


class QualityReportSerializer(serializers.ModelSerializer):
    source_import = serializers.SerializerMethodField()

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

    def get_source_import(self, instance):
        try:
            row = instance.source_import_row
        except QualityImportRow.DoesNotExist:
            return None
        return {
            'row_id': row.id,
            'batch_id': row.batch_id,
            'sheet_name': row.sheet_name,
            'source_row_number': row.source_row_number,
            'occurrence_location': row.occurrence_location,
            'item_name': row.item_name,
        }


class SupplierSerializer(serializers.ModelSerializer):
    class Meta:
        model = Supplier
        fields = ['id', 'name', 'created_at']
        read_only_fields = ['created_at']


class QualityImportProvenanceSerializer(serializers.ModelSerializer):
    class Meta:
        model = QualityImportProvenance
        fields = [
            'source_sha256',
            'source_content_type',
            'source_filename',
            'source_byte_size',
            'parser_name',
            'parser_version',
            'workbook_properties',
            'source_discarded_at',
            'created_at',
        ]


class QualityImportMediaSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()
    source_anchor = serializers.SerializerMethodField()
    filename = serializers.CharField(source='original_filename', read_only=True)
    content_type = serializers.CharField(source='asset.content_type', read_only=True, allow_null=True)
    byte_size = serializers.IntegerField(source='asset.byte_size', read_only=True, allow_null=True)
    sha256 = serializers.CharField(source='asset.sha256', read_only=True, allow_null=True)
    width = serializers.IntegerField(source='asset.width', read_only=True, allow_null=True)
    height = serializers.IntegerField(source='asset.height', read_only=True, allow_null=True)
    mirror_state = serializers.CharField(source='asset.mirror_state', read_only=True, allow_null=True)
    mirrored_at = serializers.DateTimeField(source='asset.mirrored_at', read_only=True, allow_null=True)

    class Meta:
        model = QualityImportMedia
        fields = [
            'id',
            'kind',
            'content_type',
            'byte_size',
            'sha256',
            'source_sha256',
            'source_byte_size',
            'source_width',
            'source_height',
            'filename',
            'width',
            'height',
            'source_anchor',
            'mirror_state',
            'mirrored_at',
            'warnings',
            'url',
        ]

    def get_url(self, obj):
        if not obj.asset_id:
            return None
        request = self.context.get('request')
        path = reverse('quality-import-media-content', kwargs={'pk': obj.pk})
        return request.build_absolute_uri(path) if request else path

    def get_source_anchor(self, obj):
        column = obj.source_anchor_col
        letters = ''
        while column:
            column, remainder = divmod(column - 1, 26)
            letters = chr(65 + remainder) + letters
        return f'{obj.source_sheet_name}!{letters}{obj.source_anchor_row}#{obj.source_index}'


class QualityImportAssetSerializer(serializers.ModelSerializer):
    url = serializers.SerializerMethodField()

    class Meta:
        model = QualityImportAsset
        fields = [
            'id', 'sha256', 'byte_size', 'content_type', 'width', 'height',
            'extension', 'mirror_state', 'mirrored_at', 'url', 'created_at',
            'normalizer_version',
        ]

    def get_url(self, obj):
        request = self.context.get('request')
        path = reverse('quality-import-asset-content', kwargs={'pk': obj.pk})
        return request.build_absolute_uri(path) if request else path


class QualityImportRowSerializer(serializers.ModelSerializer):
    media = QualityImportMediaSerializer(many=True, read_only=True)
    reviewed_by = serializers.CharField(source='reviewed_by.username', read_only=True, allow_null=True)
    duplicate_override_by = serializers.CharField(
        source='duplicate_override_by.username',
        read_only=True,
        allow_null=True,
    )

    class Meta:
        model = QualityImportRow
        fields = [
            'id',
            'batch',
            'sheet_name',
            'sheet_role',
            'source_row_number',
            'source_sequence',
            'source_key',
            'business_key',
            'content_sha256',
            'delta_status',
            'baseline_row',
            'supersedes',
            'reviewed_content_sha256',
            'duplicate_of',
            'duplicate_override_by',
            'duplicate_override_at',
            'duplicate_override_reason',
            'report_date',
            'section',
            'occurrence_location',
            'model',
            'part_no',
            'item_name',
            'lot_qty',
            'inspection_qty',
            'defect_qty',
            'defect_rate',
            'judgement',
            'phenomenon',
            'disposition',
            'action_result',
            'raw_data',
            'warnings',
            'review_status',
            'reviewed_by',
            'reviewed_at',
            'approved_report',
            'published_at',
            'media',
            'created_at',
            'updated_at',
        ]
        read_only_fields = [
            'id',
            'batch',
            'sheet_name',
            'sheet_role',
            'source_row_number',
            'source_sequence',
            'source_key',
            'business_key',
            'content_sha256',
            'delta_status',
            'baseline_row',
            'supersedes',
            'reviewed_content_sha256',
            'duplicate_of',
            'duplicate_override_by',
            'duplicate_override_at',
            'duplicate_override_reason',
            'raw_data',
            'warnings',
            'reviewed_by',
            'reviewed_at',
            'approved_report',
            'published_at',
            'media',
            'created_at',
            'updated_at',
        ]

    def validate_part_no(self, value):
        return value.strip().upper()

    def validate_review_status(self, value):
        if value in {
            QualityImportRow.ReviewStatus.UNCHANGED,
            QualityImportRow.ReviewStatus.PUBLISHED,
        }:
            raise serializers.ValidationError(
                'Only the importer may assign unchanged/published workflow states.'
            )
        return value

    def validate(self, attrs):
        if self.instance and self.instance.approved_report_id:
            raise serializers.ValidationError('Published import rows are immutable.')
        return attrs


class QualityImportBatchSerializer(serializers.ModelSerializer):
    uploaded_by = serializers.CharField(source='uploaded_by.username', read_only=True, allow_null=True)
    provenance = QualityImportProvenanceSerializer(read_only=True)

    class Meta:
        model = QualityImportBatch
        fields = [
            'id',
            'original_filename',
            'sha256',
            'file_size',
            'status',
            'dataset_key',
            'baseline_batch',
            'sheet_names',
            'total_rows',
            'total_media',
            'warning_count',
            'warnings',
            'source_total_rows',
            'added_count',
            'changed_count',
            'unchanged_count',
            'missing_count',
            'new_media_count',
            'reused_media_count',
            'delta_summary',
            'phase',
            'progress_done',
            'progress_total',
            'last_heartbeat_at',
            'results_persisted_at',
            'uploaded_by',
            'provenance',
            'created_at',
            'updated_at',
        ]
