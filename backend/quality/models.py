from django.conf import settings
from django.db import models

from .storage import quality_import_media_storage


class QualityReport(models.Model):
    SECTION_CHOICES = (
        ('LQC_INJ', 'LQC_INJ'),
        ('LQC_ASM', 'LQC_ASM'),
        ('IQC', 'IQC'),
        ('OQC', 'OQC'),
        ('CS', 'CS'),
    )

    report_dt = models.DateTimeField('보고일시')
    section = models.CharField('보고부문', max_length=16, choices=SECTION_CHOICES, default='LQC_INJ')
    model = models.CharField('모델', max_length=64, blank=True, default='')
    part_no = models.CharField('파트넘버', max_length=64, blank=True, default='')
    lot_qty = models.PositiveIntegerField('LOT 수', blank=True, null=True)

    inspection_qty = models.PositiveIntegerField('검사수', blank=True, null=True)
    defect_qty = models.PositiveIntegerField('불량수', blank=True, null=True)
    defect_rate = models.CharField('불량률', max_length=16, blank=True, default='')

    judgement = models.CharField('판정결과', max_length=8, default='NG')
    phenomenon = models.TextField('불량 현상', blank=True, default='')
    disposition = models.TextField('처리 방식', blank=True, default='')
    action_result = models.TextField('처리 결과', blank=True, default='')
    
    # 이미지 URL 필드 (Cloudinary URL 저장) - 최대 5장
    image1 = models.URLField('불량 이미지 1', max_length=500, blank=True, null=True)
    image2 = models.URLField('불량 이미지 2', max_length=500, blank=True, null=True)
    image3 = models.URLField('불량 이미지 3', max_length=500, blank=True, null=True)
    image4 = models.URLField('불량 이미지 4', max_length=500, blank=True, null=True)
    image5 = models.URLField('불량 이미지 5', max_length=500, blank=True, null=True)

    # Direct Excel imports use a deterministic event key so replaying the same
    # workbook row is idempotent. Manual reports keep this field NULL.
    excel_import_key = models.CharField(
        max_length=64,
        blank=True,
        null=True,
        unique=True,
        editable=False,
    )
    # Preserve the source row for audit and later user correction without
    # keeping the uploaded workbook itself.
    excel_source = models.JSONField(default=dict, blank=True, editable=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-report_dt', '-id']

    def __str__(self) -> str:
        return f"{self.report_dt} {self.section} {self.model} {self.part_no}"

    def save(self, *args, **kwargs):
        # Normalize PART NO to uppercase on save
        if getattr(self, 'part_no', None):
            self.part_no = self.part_no.upper()
        super().save(*args, **kwargs)


class Supplier(models.Model):
    """IQC 공급자 목록"""
    name = models.CharField('공급자명', max_length=128, unique=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['name']

    def __str__(self) -> str:
        return self.name


class QualityImportBatch(models.Model):
    """One immutable workbook intake.

    Imported rows deliberately remain separate from :class:`QualityReport` until
    a human has reviewed them.  ``sha256`` plus ``import_scope_key`` makes
    retrying the same file and selected period safe while still allowing a later
    backfill from the same workbook.
    """

    class Status(models.TextChoices):
        STAGING = 'staging', 'Staging parsed results'
        QUEUED = 'queued', 'Queued'
        PROCESSING = 'processing', 'Processing'
        READY = 'ready', 'Ready'
        READY_WITH_WARNINGS = 'ready_with_warnings', 'Ready with warnings'
        FAILED = 'failed', 'Failed'

    uploaded_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='quality_import_batches',
    )
    original_filename = models.CharField(max_length=255)
    sha256 = models.CharField(max_length=64, db_index=True)
    import_scope_key = models.CharField(max_length=32, default='full', db_index=True)
    file_size = models.PositiveBigIntegerField()
    dataset_key = models.CharField(max_length=64, default='quality_issue_workbook', db_index=True)
    baseline_batch = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='revision_batches',
    )
    status = models.CharField(
        max_length=32,
        choices=Status.choices,
        default=Status.STAGING,
        db_index=True,
    )
    sheet_names = models.JSONField(default=list, blank=True)
    total_rows = models.PositiveIntegerField(default=0)
    total_media = models.PositiveIntegerField(default=0)
    warning_count = models.PositiveIntegerField(default=0)
    warnings = models.JSONField(default=list, blank=True)
    source_total_rows = models.PositiveIntegerField(default=0)
    added_count = models.PositiveIntegerField(default=0)
    changed_count = models.PositiveIntegerField(default=0)
    unchanged_count = models.PositiveIntegerField(default=0)
    missing_count = models.PositiveIntegerField(default=0)
    new_media_count = models.PositiveIntegerField(default=0)
    reused_media_count = models.PositiveIntegerField(default=0)
    delta_summary = models.JSONField(default=dict, blank=True)
    phase = models.CharField(max_length=32, blank=True, default='staging')
    progress_done = models.PositiveIntegerField(default=0)
    progress_total = models.PositiveIntegerField(default=0)
    last_heartbeat_at = models.DateTimeField(null=True, blank=True)
    processing_owner = models.CharField(max_length=128, blank=True, default='')
    lease_expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    attempt_count = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True, blank=True, db_index=True)
    results_persisted_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at', '-id']
        constraints = [
            models.UniqueConstraint(
                fields=['sha256', 'import_scope_key'],
                name='quality_import_unique_source_scope',
            ),
            models.UniqueConstraint(
                fields=['status'],
                condition=models.Q(status='processing'),
                name='quality_import_single_processing_batch',
            ),
        ]

    def __str__(self) -> str:
        return f'{self.original_filename} ({self.status})'


class QualityImportProvenance(models.Model):
    """Checksum/parser audit only; original workbook bytes are temporary."""

    batch = models.OneToOneField(
        QualityImportBatch,
        on_delete=models.CASCADE,
        related_name='provenance',
    )
    source_sha256 = models.CharField(max_length=64, db_index=True)
    source_content_type = models.CharField(max_length=128, blank=True, default='')
    source_filename = models.CharField(max_length=255)
    source_byte_size = models.PositiveBigIntegerField()
    parser_name = models.CharField(max_length=64, default='quality_xlsx_v1')
    parser_version = models.CharField(max_length=32, default='1')
    workbook_properties = models.JSONField(default=dict, blank=True)
    source_discarded_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return f'{self.source_filename} ({self.source_sha256[:12]})'


class QualityImportRow(models.Model):
    """Normalized, reviewable row imported from a workbook sheet."""

    class ReviewStatus(models.TextChoices):
        DRAFT = 'draft', 'Draft'
        REVIEWED = 'reviewed', 'Reviewed'
        REJECTED = 'rejected', 'Rejected'
        UNCHANGED = 'unchanged', 'Unchanged baseline row'
        PUBLISHED = 'published', 'Published'

    class DeltaStatus(models.TextChoices):
        ADDED = 'added', 'Added'
        CHANGED = 'changed', 'Changed'
        UNCHANGED = 'unchanged', 'Unchanged'

    batch = models.ForeignKey(
        QualityImportBatch,
        on_delete=models.CASCADE,
        related_name='rows',
    )
    sheet_name = models.CharField(max_length=128)
    sheet_role = models.CharField(max_length=32, blank=True, default='')
    source_row_number = models.PositiveIntegerField()
    source_sequence = models.CharField(max_length=64, blank=True, default='')
    source_key = models.CharField(max_length=64, db_index=True)
    business_key = models.CharField(max_length=64, db_index=True)
    content_sha256 = models.CharField(max_length=64, db_index=True)
    evidence_sha256 = models.CharField(max_length=64, blank=True, default='', db_index=True)
    reviewed_content_sha256 = models.CharField(max_length=64, blank=True, default='', db_index=True)
    duplicate_of = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='duplicate_rows',
    )
    baseline_row = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='baseline_revisions',
    )
    supersedes = models.ForeignKey(
        'self',
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='superseded_by_rows',
    )
    delta_status = models.CharField(
        max_length=16,
        choices=DeltaStatus.choices,
        default=DeltaStatus.ADDED,
        db_index=True,
    )
    duplicate_override_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='quality_duplicate_overrides',
    )
    duplicate_override_at = models.DateTimeField(null=True, blank=True)
    duplicate_override_reason = models.CharField(max_length=255, blank=True, default='')

    report_date = models.DateField(null=True, blank=True)
    section = models.CharField(
        max_length=16,
        choices=QualityReport.SECTION_CHOICES,
        blank=True,
        default='',
    )
    occurrence_location = models.CharField(max_length=64, blank=True, default='')
    model = models.CharField(max_length=128, blank=True, default='')
    part_no = models.CharField(max_length=128, blank=True, default='')
    item_name = models.CharField(max_length=255, blank=True, default='')
    lot_qty = models.PositiveIntegerField(null=True, blank=True)
    inspection_qty = models.PositiveIntegerField(null=True, blank=True)
    defect_qty = models.PositiveIntegerField(null=True, blank=True)
    defect_rate = models.CharField(max_length=32, blank=True, default='')
    judgement = models.CharField(max_length=16, blank=True, default='')
    phenomenon = models.TextField(blank=True, default='')
    disposition = models.TextField(blank=True, default='')
    action_result = models.TextField(blank=True, default='')

    raw_data = models.JSONField(default=dict, blank=True)
    warnings = models.JSONField(default=list, blank=True)
    review_status = models.CharField(
        max_length=16,
        choices=ReviewStatus.choices,
        default=ReviewStatus.DRAFT,
        db_index=True,
    )
    reviewed_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='reviewed_quality_import_rows',
    )
    reviewed_at = models.DateTimeField(null=True, blank=True)
    approved_report = models.OneToOneField(
        QualityReport,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='source_import_row',
    )
    published_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['sheet_name', 'source_row_number', 'id']
        constraints = [
            models.UniqueConstraint(
                fields=['batch', 'sheet_name', 'source_row_number'],
                name='quality_import_unique_source_row',
            ),
        ]

    def save(self, *args, **kwargs):
        if self.part_no:
            self.part_no = self.part_no.upper()
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return f'{self.sheet_name}:{self.source_row_number} {self.part_no}'


class QualityImportMedia(models.Model):
    """Logical workbook image anchor linked to a normalized shared asset."""

    class Kind(models.TextChoices):
        IMAGE = 'image', 'Image'

    batch = models.ForeignKey(
        QualityImportBatch,
        on_delete=models.CASCADE,
        related_name='media',
    )
    row = models.ForeignKey(
        QualityImportRow,
        on_delete=models.CASCADE,
        null=True,
        blank=True,
        related_name='media',
    )
    asset = models.ForeignKey(
        'QualityImportAsset',
        on_delete=models.PROTECT,
        null=True,
        blank=True,
        related_name='attachments',
    )
    kind = models.CharField(max_length=16, choices=Kind.choices, default=Kind.IMAGE)
    source_sheet_name = models.CharField(max_length=128)
    source_anchor_row = models.PositiveIntegerField()
    source_anchor_col = models.PositiveIntegerField()
    source_index = models.PositiveIntegerField(default=0)
    original_filename = models.CharField(max_length=255)
    source_sha256 = models.CharField(max_length=64, blank=True, default='', db_index=True)
    source_byte_size = models.PositiveBigIntegerField(default=0)
    source_width = models.PositiveIntegerField(null=True, blank=True)
    source_height = models.PositiveIntegerField(null=True, blank=True)
    warnings = models.JSONField(default=list, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['source_sheet_name', 'source_anchor_row', 'source_index', 'id']
        constraints = [
            models.UniqueConstraint(
                fields=['batch', 'source_sheet_name', 'source_anchor_row', 'source_index'],
                name='quality_import_unique_media_anchor_index',
            ),
        ]

    def __str__(self) -> str:
        return f'{self.source_sheet_name}:{self.source_anchor_row}#{self.source_index}'


class QualityImportAsset(models.Model):
    """Content-addressed image stored once and shared by anchor attachments."""

    class UploadState(models.TextChoices):
        STAGED = 'staged', 'Staged in database'
        UPLOADING = 'uploading', 'Uploading'
        READY = 'ready', 'Ready'
        FAILED = 'failed', 'Failed'

    class MirrorState(models.TextChoices):
        PENDING = 'pending', 'Pending local mirror'
        MIRRORED = 'mirrored', 'Mirrored'
        FAILED = 'failed', 'Mirror failed'

    sha256 = models.CharField(max_length=64, unique=True, db_index=True)
    normalizer_version = models.CharField(max_length=32, default='quality-image-v1')
    byte_size = models.PositiveBigIntegerField()
    content_type = models.CharField(max_length=128)
    width = models.PositiveIntegerField(null=True, blank=True)
    height = models.PositiveIntegerField(null=True, blank=True)
    extension = models.CharField(max_length=16, blank=True, default='')
    storage_key = models.CharField(max_length=512, unique=True)
    file = models.FileField(
        upload_to='',
        storage=quality_import_media_storage,
        max_length=512,
        blank=True,
        default='',
    )
    staged_bytes = models.BinaryField(null=True, blank=True)
    upload_state = models.CharField(
        max_length=16,
        choices=UploadState.choices,
        default=UploadState.STAGED,
        db_index=True,
    )
    processing_owner = models.CharField(max_length=128, blank=True, default='')
    lease_expires_at = models.DateTimeField(null=True, blank=True, db_index=True)
    attempt_count = models.PositiveIntegerField(default=0)
    next_attempt_at = models.DateTimeField(null=True, blank=True, db_index=True)
    last_error = models.CharField(max_length=512, blank=True, default='')
    remote_verified_at = models.DateTimeField(null=True, blank=True, db_index=True)
    created_by_batch = models.ForeignKey(
        QualityImportBatch,
        on_delete=models.SET_NULL,
        null=True,
        blank=True,
        related_name='created_assets',
    )
    mirror_state = models.CharField(
        max_length=16,
        choices=MirrorState.choices,
        default=MirrorState.PENDING,
        db_index=True,
    )
    archive_relative_path = models.CharField(max_length=512, blank=True, default='')
    mirrored_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self) -> str:
        return self.sha256
