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
    action_result = models.TextField('처리 결과', blank=True, default='')
    
    # 이미지 필드 (Cloudinary에 저장) - 최대 3장
    image1 = models.ImageField('불량 이미지 1', upload_to='quality_reports/', blank=True, null=True)
    image2 = models.ImageField('불량 이미지 2', upload_to='quality_reports/', blank=True, null=True)
    image3 = models.ImageField('불량 이미지 3', upload_to='quality_reports/', blank=True, null=True)

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
