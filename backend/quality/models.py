from django.db import models


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

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-report_dt', '-id']

    def __str__(self) -> str:
        return f"{self.report_dt} {self.section} {self.model} {self.part_no}"

# Create your models here.
