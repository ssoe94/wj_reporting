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

    # 새로운 동적 불량 데이터 (JSON 필드)
    processing_defects_dynamic = models.JSONField('가공불량 동적 리스트', default=list, blank=True,
        help_text="[{'type': '스크래치', 'quantity': 5, 'timestamp': '...'}, ...]")
    outsourcing_defects_dynamic = models.JSONField('외주불량 동적 리스트', default=list, blank=True,
        help_text="[{'type': '치수불량', 'quantity': 3, 'timestamp': '...'}, ...]")

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

    def save(self, *args, **kwargs):
        # Normalize PART NO to uppercase on save
        if getattr(self, 'part_no', None):
            self.part_no = self.part_no.upper()
        super().save(*args, **kwargs)

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
    def operation_rate(self):
        """가동률 (%) = 가동시간 / 총시간 * 100"""
        return round((self.operation_time / self.total_time) * 100, 1) if self.total_time else 0

    @property
    def uph(self):
        """시간당 생산수량 (UPH) = 실제수량 / (가동시간/60)"""
        operation_hours = self.operation_time / 60
        return round(self.actual_qty / operation_hours, 1) if operation_hours else 0

    @property
    def upph(self):
        """인당 시간당 생산수량 (UPPH) = UPH / 작업인원"""
        return round(self.uph / self.workers, 1) if self.workers else 0


class DefectHistory(models.Model):
    """불량 유형 히스토리 관리"""

    DEFECT_CATEGORY_CHOICES = [
        ('processing', '가공불량'),
        ('outsourcing', '외주불량'),
    ]

    category = models.CharField('불량 카테고리', max_length=20, choices=DEFECT_CATEGORY_CHOICES)
    defect_type = models.CharField('불량 유형', max_length=100)
    usage_count = models.IntegerField('사용 횟수', default=1)
    first_used = models.DateTimeField('최초 사용일', auto_now_add=True)
    last_used = models.DateTimeField('최종 사용일', auto_now=True)

    class Meta:
        verbose_name = '불량 히스토리'
        verbose_name_plural = '불량 히스토리 목록'
        unique_together = ('category', 'defect_type')
        ordering = ['-last_used', '-usage_count']
        indexes = [
            models.Index(fields=['category', '-last_used']),
            models.Index(fields=['category', '-usage_count']),
        ]

    def __str__(self):
        return f"{self.get_category_display()} - {self.defect_type} ({self.usage_count}회)"

    @classmethod
    def record_usage(cls, category, defect_type):
        """불량 유형 사용 기록"""
        history, created = cls.objects.get_or_create(
            category=category,
            defect_type=defect_type,
            defaults={'usage_count': 1}
        )

        if not created:
            history.usage_count += 1
            history.save(update_fields=['usage_count', 'last_used'])

        return history

    @classmethod
    def get_popular_types(cls, category, limit=20):
        """인기 불량 유형 반환 (사용 빈도 순)"""
        return cls.objects.filter(category=category).order_by('-usage_count', '-last_used')[:limit]

    @classmethod
    def get_recent_types(cls, category, limit=20):
        """최근 사용 불량 유형 반환 (최신 순)"""
        return cls.objects.filter(category=category).order_by('-last_used')[:limit]