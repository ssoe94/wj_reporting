from django.db import models


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