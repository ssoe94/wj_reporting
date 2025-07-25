from django.db import models
from django.core.validators import MinValueValidator

class InjectionReport(models.Model):
    SECTION_CHOICES = [
        ('C/A', 'C/A'),
        ('B/C', 'B/C'),
        ('COVER', 'COVER'),
    ]

    # 기본 정보
    date = models.DateField('생산일자')
    machine_no = models.PositiveSmallIntegerField('사출기 번호', null=True, blank=True)
    tonnage = models.CharField('형체력(T)', max_length=10)
    model = models.CharField('모델명', max_length=50)
    section = models.CharField('구분', max_length=50)
    
    # 수량 정보
    plan_qty = models.IntegerField('계획수량', validators=[MinValueValidator(0)])
    actual_qty = models.IntegerField('실제수량', validators=[MinValueValidator(0)])
    reported_defect = models.IntegerField('보고불량수', validators=[MinValueValidator(0)])
    actual_defect = models.IntegerField('실제불량수', validators=[MinValueValidator(0)])
    
    # 가동 정보
    operation_time = models.IntegerField('가동시간(분)', validators=[MinValueValidator(0)], default=0)
    total_time = models.IntegerField('총시간(분)', validators=[MinValueValidator(0)], default=1440)  # 24시간 = 1440분
    
    # 시작/종료 시각
    start_datetime = models.DateTimeField('시작 일시', null=True, blank=True)
    end_datetime = models.DateTimeField('종료 일시', null=True, blank=True)
    
    # 비고
    note = models.TextField('비고', blank=True)
    
    # 신규 필드
    part_no = models.CharField('Part No.', max_length=100, blank=True)
    
    # 생성/수정 시간
    created_at = models.DateTimeField('생성시간', auto_now_add=True)
    updated_at = models.DateTimeField('수정시간', auto_now=True)

    class Meta:
        verbose_name = '사출 보고서'
        verbose_name_plural = '사출 보고서 목록'
        ordering = ['-date', 'tonnage', 'model']

    def __str__(self):
        return f"{self.date} - {self.tonnage} {self.model}"

    # 자동 계산 필드들
    @property
    def achievement_rate(self):
        """달성률 (%) = 실제수량 / 계획수량 * 100"""
        return round((self.actual_qty / self.plan_qty) * 100, 1) if self.plan_qty else 0

    @property
    def defect_rate(self):
        """불량률 (%) = 실제불량수 / 실제수량 * 100"""
        return round((self.actual_defect / self.actual_qty) * 100, 1) if self.actual_qty else 0

    @property
    def total_qty(self):
        """총생산량 = 실제수량 + 실제불량수"""
        return self.actual_qty + self.actual_defect

    @property
    def uptime_rate(self):
        """가동률 (%) = 가동시간 / 총시간 * 100"""
        return round((self.operation_time / self.total_time) * 100, 1) if self.total_time else 0

class Product(models.Model):
    """제품 마스터"""
    model = models.CharField('모델명', max_length=100)
    type = models.CharField('구분', max_length=50)
    fg_part_no = models.CharField('成品 PART-NO', max_length=100)
    wip_part_no = models.CharField('半成品 PART-NO', max_length=100)

    class Meta:
        verbose_name = '제품'
        verbose_name_plural = '제품 목록'
        unique_together = ('model', 'type')
        ordering = ['model', 'type']

    def __str__(self):
        return f"{self.model} ({self.type})"

class PartSpec(models.Model):
    """사출 품목 스펙(버전 관리)"""
    part_no = models.CharField('Part No', max_length=100)
    model_code = models.CharField('모델 코드', max_length=100)
    description = models.CharField('설명', max_length=200, blank=True)

    mold_type = models.CharField('금형 타입', max_length=50, blank=True)
    color = models.CharField('색상', max_length=30, blank=True)

    resin_type = models.CharField('Resin 종류', max_length=50, blank=True)
    resin_code = models.CharField('Resin 코드', max_length=50, blank=True)

    net_weight_g = models.DecimalField('Net 중량(g)', max_digits=8, decimal_places=2, null=True, blank=True)
    sr_weight_g = models.DecimalField('S/R 중량(g)', max_digits=8, decimal_places=2, null=True, blank=True)
    tonnage = models.PositiveIntegerField('형체력(T)', null=True, blank=True)
    cycle_time_sec = models.PositiveIntegerField('사이클 타임(초)', null=True, blank=True)
    efficiency_rate = models.DecimalField('효율(%)', max_digits=5, decimal_places=2, null=True, blank=True)
    cavity = models.PositiveSmallIntegerField('Cavity', null=True, blank=True)
    resin_loss_pct = models.DecimalField('Resin Loss(%)', max_digits=5, decimal_places=2, null=True, blank=True)
    defect_rate_pct = models.DecimalField('불량률(%)', max_digits=5, decimal_places=2, null=True, blank=True)

    valid_from = models.DateField('유효 시작일')

    created_at = models.DateTimeField('생성일', auto_now_add=True)

    class Meta:
        verbose_name = '품목 스펙'
        verbose_name_plural = '품목 스펙 목록'
        unique_together = ('part_no', 'valid_from')
        ordering = ['part_no', '-valid_from']

    def __str__(self):
        return f"{self.part_no} ({self.valid_from})"

# ================================
# ECO 관리
# ================================

class EngineeringChangeOrder(models.Model):
    STATUS_CHOICES = [
        ("OPEN", "OPEN"),
        ("WIP", "WIP"),
        ("CLOSED", "CLOSED"),
    ]

    form_type = models.CharField("양식 구분", max_length=10, choices=[("REGULAR", "REGULAR"), ("TEMP", "TEMP")], default="REGULAR")

    eco_no = models.CharField("ECO 번호", max_length=50, unique=True)
    eco_model = models.CharField("모델", max_length=100, blank=True)
    customer = models.CharField("고객사", max_length=100, blank=True)

    prepared_date = models.DateField("제정일", null=True, blank=True)
    issued_date = models.DateField("발표일", null=True, blank=True)
    received_date = models.DateField("접수일", null=True, blank=True)
    due_date = models.DateField("완료 예정일", null=True, blank=True)
    close_date = models.DateField("완료일", null=True, blank=True)

    change_reason = models.TextField("변경 사유", blank=True)
    change_details = models.TextField("변경 내용", blank=True)
    applicable_work_order = models.CharField("적용 작업지시/시점", max_length=200, blank=True)

    storage_action = models.CharField("재고 처리", max_length=200, blank=True)
    inventory_finished = models.IntegerField("완제품 재고", null=True, blank=True)
    inventory_material = models.IntegerField("자재 재고", null=True, blank=True)

    applicable_date = models.DateField("적용일", null=True, blank=True)

    status = models.CharField("상태", max_length=10, choices=STATUS_CHOICES, default="OPEN")

    note = models.TextField("비고", blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        verbose_name = "ECO"
        verbose_name_plural = "ECO 목록"
        ordering = ["-prepared_date", "eco_no"]

    def __str__(self):
        return self.eco_no

class EcoPartSpec(models.Model):
    """ECO 전용 Part 스펙 (생산관리와 분리)"""
    part_no = models.CharField('Part No', max_length=100, unique=True)
    description = models.CharField('설명', max_length=200, blank=True)
    model_code = models.CharField('모델 코드', max_length=100, blank=True)
    
    # ECO 관련 추가 정보
    eco_category = models.CharField('ECO 카테고리', max_length=50, blank=True)
    change_history = models.TextField('변경 이력', blank=True)
    
    created_at = models.DateTimeField('생성일', auto_now_add=True)
    updated_at = models.DateTimeField('수정일', auto_now=True)

    class Meta:
        verbose_name = 'ECO Part 스펙'
        verbose_name_plural = 'ECO Part 스펙 목록'
        ordering = ['part_no']

    def __str__(self):
        return f"{self.part_no} - {self.description}"

class EcoDetail(models.Model):
    """ECO 상세 정보"""
    eco_header = models.ForeignKey(EngineeringChangeOrder, on_delete=models.CASCADE, related_name='details')
    # 임시로 기존 PartSpec 참조 유지 (마이그레이션 후 제거 예정)
    part_spec = models.ForeignKey(PartSpec, on_delete=models.CASCADE, related_name='ecodetail', null=True, blank=True)
    # 새로운 EcoPartSpec 참조 (마이그레이션 후 필수로 변경 예정)
    eco_part_spec = models.ForeignKey(EcoPartSpec, on_delete=models.CASCADE, related_name='eco_details', null=True, blank=True)
    
    change_reason = models.CharField('변경 사유', max_length=200, blank=True)
    change_details = models.TextField('변경 내용', blank=True)
    status = models.CharField('상태', max_length=10, choices=[('OPEN', 'OPEN'), ('CLOSED', 'CLOSED')], default='OPEN')
    
    created_at = models.DateTimeField('생성일', auto_now_add=True)
    updated_at = models.DateTimeField('수정일', auto_now=True)

    class Meta:
        verbose_name = 'ECO 상세'
        verbose_name_plural = 'ECO 상세 목록'
        unique_together = ('eco_header', 'part_spec')  # 임시로 기존 unique_together 유지
        ordering = ['eco_header', 'part_spec']

    def __str__(self):
        part_info = self.eco_part_spec.part_no if self.eco_part_spec else (self.part_spec.part_no if self.part_spec else 'Unknown')
        return f"{self.eco_header.eco_no} - {part_info}"

class InventorySnapshot(models.Model):
    """재고 스냅샷"""
    part_spec = models.ForeignKey(PartSpec, on_delete=models.CASCADE, related_name='inventory_snapshots')
    qty = models.IntegerField('수량', default=0)
    collected_at = models.DateTimeField('수집일시', auto_now_add=True)

    class Meta:
        verbose_name = '재고 스냅샷'
        verbose_name_plural = '재고 스냅샷 목록'
        ordering = ['-collected_at']

    def __str__(self):
        return f"{self.part_spec.part_no} - {self.qty} ({self.collected_at})" 