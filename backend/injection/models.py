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
    section = models.CharField('구분', max_length=10, choices=SECTION_CHOICES)
    
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
    idle_note = models.CharField('부동시간 비고', max_length=200, blank=True)
    
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