from django.db import models
from django.core.validators import MinValueValidator


class AssemblyReport(models.Model):
    """가공 생산 보고서"""
    
    # 기본 정보
    date = models.DateField('생산일자')
    line_no = models.CharField('라인번호', max_length=20, blank=True)
    part_no = models.CharField('Part No.', max_length=100)
    model = models.CharField('모델명', max_length=50)
    SUPPLY_TYPE_CHOICES = (
        ('JIT', 'JIT'),
        ('CSK', 'CSK'),
        ('SVC', 'SVC'),
        ('REWORK', 'REWORK'),
        ('INSPECTION', 'INSPECTION'),
    )
    supply_type = models.CharField('공급유형', max_length=10, choices=SUPPLY_TYPE_CHOICES, blank=True, default='JIT')
    
    # 수량 정보
    plan_qty = models.IntegerField('계획수량', validators=[MinValueValidator(0)])
    input_qty = models.IntegerField('투입수량', validators=[MinValueValidator(0)], default=0)
    actual_qty = models.IntegerField('실제수량', validators=[MinValueValidator(0)])
    rework_qty = models.IntegerField('재작업 수량', validators=[MinValueValidator(0)], default=0)
    
    # 불량 분류 (3가지 타입)
    injection_defect = models.IntegerField('注塑不良', validators=[MinValueValidator(0)], default=0)
    outsourcing_defect = models.IntegerField('外协不良', validators=[MinValueValidator(0)], default=0)
    processing_defect = models.IntegerField('加工不良', validators=[MinValueValidator(0)], default=0)
    # 불량 상세(JSON): 프론트 상세 항목 보존용
    incoming_defects_detail = models.JSONField('입고/사출 상세불량', default=dict, blank=True)
    processing_defects_detail = models.JSONField('가공 상세불량', default=dict, blank=True)
    
    # 가동 정보 (injection과 동일한 형태)
    operation_time = models.IntegerField('가동시간(분)', validators=[MinValueValidator(0)], default=0)
    total_time = models.IntegerField('총시간(분)', validators=[MinValueValidator(0)], default=1440)  # 24시간 = 1440분
    idle_time = models.IntegerField('부동시간(분)', validators=[MinValueValidator(0)], default=0)
    workers = models.IntegerField('작업인원(명)', validators=[MinValueValidator(1)], default=1)
    
    
    # 비고
    note = models.TextField('비고', blank=True)
    
    # 생성/수정 시간
    created_at = models.DateTimeField('생성시간', auto_now_add=True)
    updated_at = models.DateTimeField('수정시간', auto_now=True)

    class Meta:
        verbose_name = '가공 보고서'
        verbose_name_plural = '가공 보고서 목록'
        ordering = ['-date', 'line_no', 'model']

    def __str__(self):
        return f"{self.date} - {self.line_no} {self.model}"

    # 자동 계산 필드들
    @property
    def incoming_defect_qty(self):
        """입고 불량수량 = 注塑不良 + 外协不良"""
        return self.injection_defect + self.outsourcing_defect

    @property
    def total_defect_qty(self):
        """총 불량수량 = 注塑不良 + 外协불량 + 加工불량"""
        return self.injection_defect + self.outsourcing_defect + self.processing_defect

    @property
    def achievement_rate(self):
        """달성률 (%) = 실제수량 / 계획수량 * 100"""
        return round((self.actual_qty / self.plan_qty) * 100, 1) if self.plan_qty else 0

    @property
    def defect_rate(self):
        """불량률 (%) = 총불량수량 / (실제수량 + 총불량수량) * 100"""
        total_production = self.actual_qty + self.total_defect_qty
        return round((self.total_defect_qty / total_production) * 100, 1) if total_production else 0

    @property
    def total_production_qty(self):
        """총생산량 = 실제수량 + 총불량수량"""
        return self.actual_qty + self.total_defect_qty

    @property
    def uptime_rate(self):
        """가동률 (%) = (총시간 - 부동시간) / 총시간 * 100"""
        actual_operation_time = self.total_time - self.idle_time
        return round((actual_operation_time / self.total_time) * 100, 1) if self.total_time else 0

    @property
    def uph(self):
        """시간당 생산량 (UPH) = 생산수량 / 작업시간(시간)"""
        if self.operation_time > 0:
            return round(self.actual_qty / (self.operation_time / 60), 2)
        return 0

    @property
    def upph(self):
        """인당 시간당 생산량 (UPPH) = 생산수량 / (작업시간(시간) × 작업인원)"""
        if self.operation_time > 0 and self.workers > 0:
            return round(self.actual_qty / ((self.operation_time / 60) * self.workers), 2)
        return 0

    @property
    def actual_operation_time(self):
        """실제 작업시간(분) = 총시간 - 부동시간"""
        return max(0, self.total_time - self.idle_time)


class AssemblyPartSpec(models.Model):
    """가공 품목 스펙 (injection의 PartSpec과 유사하지만 가공 특화)"""
    part_no = models.CharField('Part No', max_length=100, unique=True)
    model_code = models.CharField('모델 코드', max_length=100)
    description = models.CharField('설명', max_length=200, blank=True)
    
    # 가공 특화 정보
    process_type = models.CharField('가공 타입', max_length=50, blank=True)
    material_type = models.CharField('소재 종류', max_length=50, blank=True)
    
    # 표준 정보
    standard_cycle_time = models.PositiveIntegerField('표준 사이클 타임(분)', null=True, blank=True)
    standard_worker_count = models.PositiveSmallIntegerField('표준 작업자수', null=True, blank=True, default=1)
    
    valid_from = models.DateField('유효 시작일')
    created_at = models.DateTimeField('생성일', auto_now_add=True)

    class Meta:
        verbose_name = '가공 품목 스펙'
        verbose_name_plural = '가공 품목 스펙 목록'
        ordering = ['part_no', '-valid_from']

    def __str__(self):
        return f"{self.part_no} - {self.model_code}"


class AssemblyProduct(models.Model):
    """가공 제품 마스터 (injection의 Product와 유사)"""
    model = models.CharField('모델명', max_length=100)
    part_no = models.CharField('대표 PART-NO', max_length=100)
    process_line = models.CharField('가공 라인', max_length=50, blank=True)
    
    class Meta:
        verbose_name = '가공 제품'
        verbose_name_plural = '가공 제품 목록'
        unique_together = ('model', 'part_no')
        ordering = ['model', 'part_no']

    def __str__(self):
        return f"{self.model} ({self.part_no})"