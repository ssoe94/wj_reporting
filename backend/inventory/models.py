from django.db import models
from django.core.validators import MinValueValidator


class UnifiedPartSpec(models.Model):
    """통합 품목 마스터 - 사출/가공/품질에서 공통 사용"""
    # 기본 정보 (필수)
    part_no = models.CharField('Part No', max_length=100, unique=True)
    model_code = models.CharField('모델 코드', max_length=100)
    description = models.CharField('설명', max_length=200, blank=True)
    valid_from = models.DateField('유효 시작일')
    
    # 공통 정보
    color = models.CharField('색상', max_length=30, blank=True)
    
    # 사출 관련 필드
    mold_type = models.CharField('금형 타입', max_length=50, blank=True)
    resin_type = models.CharField('Resin 종류', max_length=50, blank=True)
    resin_code = models.CharField('Resin 코드', max_length=50, blank=True)
    net_weight_g = models.DecimalField('Net 중량(g)', max_digits=8, decimal_places=2, null=True, blank=True)
    sr_weight_g = models.DecimalField('S/R 중량(g)', max_digits=8, decimal_places=2, null=True, blank=True)
    cycle_time_sec = models.PositiveIntegerField('사이클 타임(초)', null=True, blank=True)
    cavity = models.PositiveSmallIntegerField('Cavity', null=True, blank=True)
    tonnage = models.PositiveIntegerField('형체력(T)', null=True, blank=True)
    efficiency_rate = models.DecimalField('효율(%)', max_digits=5, decimal_places=2, null=True, blank=True)
    resin_loss_pct = models.DecimalField('Resin Loss(%)', max_digits=5, decimal_places=2, null=True, blank=True)
    defect_rate_pct = models.DecimalField('불량률(%)', max_digits=5, decimal_places=2, null=True, blank=True)
    
    # 가공 관련 필드
    process_type = models.CharField('가공 타입', max_length=50, blank=True)
    material_type = models.CharField('소재 종류', max_length=50, blank=True)
    standard_cycle_time = models.PositiveIntegerField('표준 사이클 타임(분)', null=True, blank=True)
    standard_worker_count = models.PositiveSmallIntegerField('표준 작업자수', null=True, blank=True, default=1)
    
    # 메타데이터
    source_system = models.CharField('생성 시스템', max_length=20, default='unified', 
                                   choices=[('injection', '사출'), ('assembly', '가공'), ('quality', '품질'), ('unified', '통합')])
    is_active = models.BooleanField('활성 상태', default=True)
    
    created_at = models.DateTimeField('생성일', auto_now_add=True)
    updated_at = models.DateTimeField('수정일', auto_now=True)

    class Meta:
        verbose_name = '통합 품목 스펙'
        verbose_name_plural = '통합 품목 스펙 목록'
        indexes = [
            models.Index(fields=['part_no']),
            models.Index(fields=['model_code']),
            models.Index(fields=['part_no', 'model_code']),
            models.Index(fields=['valid_from']),
            models.Index(fields=['is_active']),
        ]
        ordering = ['part_no', '-valid_from']

    def __str__(self):
        return f"{self.part_no} - {self.model_code}"

    @property
    def display_name(self):
        """표시용 이름: Part No - Model (Description)"""
        desc = f" ({self.description})" if self.description else ""
        return f"{self.part_no} - {self.model_code}{desc}"


class StagingInventory(models.Model):
    material_id = models.BigIntegerField()
    material_code = models.CharField(max_length=100)
    qr_code = models.CharField(max_length=100, blank=True, null=True, default='')
    composite_key = models.CharField(max_length=220, db_index=True, blank=True, null=True, default='')
    label_code = models.CharField(max_length=100, blank=True, null=True, default='')
    material_name = models.CharField(max_length=255, blank=True)
    specification = models.CharField(max_length=255, blank=True)
    biz_type = models.CharField(max_length=50, blank=True)
    warehouse_code = models.CharField(max_length=50, blank=True)
    warehouse_name = models.CharField(max_length=255, blank=True)
    location_name = models.CharField(max_length=255, blank=True)
    storage_status = models.CharField(max_length=50, blank=True)
    qc_status = models.CharField(max_length=50, blank=True)
    work_order_code = models.CharField(max_length=100, blank=True)
    quantity = models.DecimalField(max_digits=20, decimal_places=4)
    unit = models.CharField(max_length=20, blank=True)
    updated_at = models.DateTimeField()
    fetched_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        indexes = [
            models.Index(fields=["fetched_at"]),
            models.Index(fields=["material_code"]),
        ]
        ordering = ["-fetched_at"]

    def __str__(self):
        return f"{self.material_code} {self.quantity}{self.unit} @{self.warehouse_code}"


class FactInventory(models.Model):
    id = models.AutoField(primary_key=True)
    composite_key = models.CharField(max_length=220, unique=True, default='')
    qr_code = models.CharField(max_length=100)
    label_code = models.CharField(max_length=100, blank=True, null=True, default='')
    material_id = models.BigIntegerField()
    material_code = models.CharField(max_length=100)
    material_name = models.CharField(max_length=255, blank=True)
    specification = models.CharField(max_length=255, blank=True)
    biz_type = models.CharField(max_length=50, blank=True)
    warehouse_code = models.CharField(max_length=50, blank=True)
    warehouse_name = models.CharField(max_length=255, blank=True)
    location_name = models.CharField(max_length=255, blank=True)
    storage_status = models.CharField(max_length=50, blank=True)
    qc_status = models.CharField(max_length=50, blank=True)
    work_order_code = models.CharField(max_length=100, blank=True)
    quantity = models.DecimalField(max_digits=20, decimal_places=4)
    unit = models.CharField(max_length=20, blank=True)
    updated_at = models.DateTimeField()

    class Meta:
        indexes = [
            models.Index(fields=["warehouse_code"]),
            models.Index(fields=["material_code"]),
            models.Index(fields=["qr_code"]),
            models.Index(fields=["composite_key"]),
            models.Index(fields=["label_code"]),
        ]

    def __str__(self):
        return f"{self.material_code} {self.quantity}{self.unit}"


class DailyInventorySnapshot(models.Model):
    """매일 오전 8시 기준 재고 스냅샷"""
    snapshot_date = models.DateField(db_index=True)  # 스냅샷 날짜 (오전 8시 기준)
    material_code = models.CharField(max_length=100, db_index=True)
    material_name = models.CharField(max_length=255, blank=True)
    specification = models.CharField(max_length=255, blank=True)
    warehouse_code = models.CharField(max_length=50, db_index=True)
    warehouse_name = models.CharField(max_length=255, blank=True)
    qc_status = models.CharField(max_length=50, blank=True)
    total_quantity = models.DecimalField(max_digits=20, decimal_places=4, default=0)
    unit = models.CharField(max_length=20, blank=True)
    cart_count = models.IntegerField(default=0)  # 대차 개수
    cart_details = models.JSONField(default=list)  # 대차 상세 정보
    created_at = models.DateTimeField(auto_now_add=True)
    
    # 추가 필드들
    is_email_sent = models.BooleanField(default=False)  # 이메일 발송 여부
    email_sent_at = models.DateTimeField(null=True, blank=True)  # 이메일 발송 시간
    excel_file_path = models.CharField(max_length=500, blank=True)  # 엑셀 파일 경로
    total_items = models.IntegerField(default=0)  # 해당 날짜 총 품목 수
    total_carts = models.IntegerField(default=0)  # 해당 날짜 총 대차 수

    class Meta:
        indexes = [
            models.Index(fields=["snapshot_date", "material_code"]),
            models.Index(fields=["snapshot_date", "warehouse_code"]),
            models.Index(fields=["material_code", "warehouse_code"]),
            models.Index(fields=["snapshot_date", "is_email_sent"]),
        ]
        unique_together = ["snapshot_date", "material_code", "warehouse_code", "qc_status"]

    def __str__(self):
        return f"{self.snapshot_date} - {self.material_code} @{self.warehouse_code}"


class DailyReportSummary(models.Model):
    """일일 보고서 요약 정보"""
    snapshot_date = models.DateField(unique=True, db_index=True)
    total_items = models.IntegerField(default=0)  # 총 품목 수
    total_quantity = models.DecimalField(max_digits=20, decimal_places=4, default=0)  # 총 수량
    total_carts = models.IntegerField(default=0)  # 총 대차 수
    warehouse_summary = models.JSONField(default=dict)  # 창고별 요약
    is_email_sent = models.BooleanField(default=False)  # 이메일 발송 여부
    email_sent_at = models.DateTimeField(null=True, blank=True)  # 이메일 발송 시간
    email_recipients = models.JSONField(default=list)  # 수신자 목록
    email_scheduled_at = models.DateTimeField(null=True, blank=True)  # 발송 예정 시간
    email_status = models.CharField(max_length=20, default='pending')  # pending, sent, failed
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        indexes = [
            models.Index(fields=["snapshot_date"]),
            models.Index(fields=["is_email_sent"]),
            models.Index(fields=["email_status"]),
        ]

    def __str__(self):
        return f"{self.snapshot_date} - 요약 보고서" 