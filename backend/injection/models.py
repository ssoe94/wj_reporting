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
    tonnage = models.CharField('톤수', max_length=10)
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
    
    # 비고
    note = models.TextField('비고', blank=True)
    
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