from django.db import models
from django.core.validators import MinValueValidator
from django.contrib.auth.models import User
from django.db.models.signals import post_save
from django.dispatch import receiver

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
    total_time = models.IntegerField('총시간(분)', validators=[MinValueValidator(0)], default=1440)  # 24시간 = 1440분
    idle_time = models.IntegerField('부동시간(분)', default=0, validators=[MinValueValidator(0)])
    
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

    def save(self, *args, **kwargs):
        # Normalize PART NO to uppercase on save
        if getattr(self, 'part_no', None):
            self.part_no = self.part_no.upper()
        super().save(*args, **kwargs)

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
    def operation_time(self):
        """가동시간(분) = 총시간 - 부동시간"""
        return self.total_time - self.idle_time

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

    def save(self, *args, **kwargs):
        # Normalize PART NOs to uppercase on save
        if getattr(self, 'fg_part_no', None):
            self.fg_part_no = self.fg_part_no.upper()
        if getattr(self, 'wip_part_no', None):
            self.wip_part_no = self.wip_part_no.upper()
        super().save(*args, **kwargs)

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

    def save(self, *args, **kwargs):
        # Normalize PART NO to uppercase on save
        if getattr(self, 'part_no', None):
            self.part_no = self.part_no.upper()
        super().save(*args, **kwargs)

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

    def save(self, *args, **kwargs):
        # Normalize PART NO to uppercase on save
        if getattr(self, 'part_no', None):
            self.part_no = self.part_no.upper()
        super().save(*args, **kwargs)

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


class UserRegistrationRequest(models.Model):
    """사용자 가입 요청"""
    STATUS_CHOICES = [
        ('pending', '대기'),
        ('approved', '승인'),
        ('rejected', '거부'),
    ]
    
    full_name = models.CharField('성명', max_length=100)
    department = models.CharField('부서', max_length=100)
    email = models.EmailField('이메일', unique=True)
    reason = models.TextField('가입 사유', blank=True)
    status = models.CharField('상태', max_length=20, choices=STATUS_CHOICES, default='pending')
    
    # 승인 정보
    approved_by = models.ForeignKey('auth.User', on_delete=models.SET_NULL, null=True, blank=True, verbose_name='승인자')
    approved_at = models.DateTimeField('승인일시', null=True, blank=True)
    temporary_password = models.CharField('임시 비밀번호', max_length=100, blank=True)
    
    # 권한 설정 (조회 기본, 편집/삭제는 별도 플래그 없이 관리)
    can_view_injection = models.BooleanField('사출 메뉴 접근', default=False)
    can_view_assembly = models.BooleanField('가공 메뉴 접근', default=False)
    can_view_quality = models.BooleanField('품질 메뉴 접근', default=False)
    can_view_sales = models.BooleanField('영업/재고 메뉴 접근', default=False)
    can_view_development = models.BooleanField('개발/ECO 메뉴 접근', default=False)
    is_admin = models.BooleanField('관리자 메뉴 접근', default=False)
    
    created_at = models.DateTimeField('요청일시', auto_now_add=True)
    updated_at = models.DateTimeField('수정일시', auto_now=True)

    class Meta:
        verbose_name = '가입 요청'
        verbose_name_plural = '가입 요청 목록'
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.full_name} ({self.email}) - {self.get_status_display()}"


class UserProfile(models.Model):
    """사용자 권한 프로필"""
    user = models.OneToOneField(User, on_delete=models.CASCADE, related_name='profile')
    
    can_view_injection = models.BooleanField('사출 메뉴 접근', default=False)
    can_view_assembly = models.BooleanField('가공 메뉴 접근', default=False)
    can_view_quality = models.BooleanField('품질 메뉴 접근', default=False)
    can_view_sales = models.BooleanField('영업/재고 메뉴 접근', default=False)
    can_view_development = models.BooleanField('개발/ECO 메뉴 접근', default=False)
    is_admin = models.BooleanField('관리자 메뉴 접근', default=False)
    
    is_using_temp_password = models.BooleanField('임시 비밀번호 사용 중', default=False)
    password_reset_required = models.BooleanField('비밀번호 재설정 필요', default=False)
    last_password_change = models.DateTimeField('마지막 비밀번호 변경일', null=True, blank=True)
    
    created_at = models.DateTimeField('생성일시', auto_now_add=True)
    updated_at = models.DateTimeField('수정일시', auto_now=True)

    class Meta:
        verbose_name = '사용자 권한 프로필'
        verbose_name_plural = '사용자 권한 프로필 목록'

    def __str__(self):
        return f"{self.user.username} 권한"
    
    @classmethod
    def get_user_permissions(cls, user):
        try:
            return user.profile
        except UserProfile.DoesNotExist:
            return cls.objects.create(user=user)


class CycleTimeSetup(models.Model):
    """사이클 타임 셋업 기록"""
    # 기본 정보
    setup_date = models.DateTimeField('설정일시', auto_now_add=True)
    machine_no = models.PositiveSmallIntegerField('사출기 번호')
    part_no = models.CharField('Part No.', max_length=100)
    model_code = models.CharField('모델 코드', max_length=50, blank=True)

    # 사이클 타임 정보
    target_cycle_time = models.PositiveIntegerField('목표 사이클 타임(초)')
    standard_cycle_time = models.PositiveIntegerField('표준 사이클 타임(초)', null=True, blank=True)
    mean_cycle_time = models.PositiveIntegerField('평균 사이클 타임(초)', null=True, blank=True)
    personnel_count = models.FloatField('배치인원수', default=1.5)

    # 상태 관리
    STATUS_CHOICES = [
        ('SETUP', '설정중'),
        ('TESTING', '테스트중'),
        ('APPROVED', '승인완료'),
        ('REJECTED', '반려'),
    ]
    status = models.CharField('상태', max_length=20, choices=STATUS_CHOICES, default='SETUP')

    # 설정자/승인자
    setup_by = models.ForeignKey(User, on_delete=models.CASCADE, related_name='cycle_setups')
    approved_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True, related_name='approved_setups')
    approved_at = models.DateTimeField('승인일시', null=True, blank=True)

    # 비고
    note = models.TextField('설정 비고', blank=True)
    rejection_reason = models.TextField('반려 사유', blank=True)

    # 생성/수정 시간
    created_at = models.DateTimeField('생성시간', auto_now_add=True)
    updated_at = models.DateTimeField('수정시간', auto_now=True)

    class Meta:
        verbose_name = '사이클 타임 셋업'
        verbose_name_plural = '사이클 타임 셋업 목록'
        ordering = ['-setup_date']

    def __str__(self):
        return f"{self.machine_no}번기 {self.part_no} - {self.get_status_display()}"

    def save(self, *args, **kwargs):
        # Normalize PART NO to uppercase on save
        if getattr(self, 'part_no', None):
            self.part_no = self.part_no.upper()
        super().save(*args, **kwargs)

    @property
    def final_cycle_time(self):
        """최종 적용된 사이클 타임"""
        return self.mean_cycle_time or self.standard_cycle_time or self.target_cycle_time


class CycleTimeTestRecord(models.Model):
    """사이클 타임 테스트 기록"""
    setup = models.ForeignKey(CycleTimeSetup, on_delete=models.CASCADE, related_name='test_records')
    test_datetime = models.DateTimeField('테스트 시간', auto_now_add=True)
    actual_cycle_time = models.PositiveIntegerField('실제 사이클 타임(초)')
    test_qty = models.PositiveSmallIntegerField('테스트 수량', default=1)
    quality_ok = models.BooleanField('품질 양호', default=True)
    note = models.TextField('테스트 비고', blank=True)
    tested_by = models.ForeignKey(User, on_delete=models.CASCADE, related_name='test_records')

    class Meta:
        verbose_name = '사이클 타임 테스트 기록'
        verbose_name_plural = '사이클 타임 테스트 기록 목록'
        ordering = ['-test_datetime']

    def __str__(self):
        return f"{self.setup.part_no} 테스트 - {self.actual_cycle_time}초"


@receiver(post_save, sender=User)
def create_user_profile(sender, instance, created, **kwargs):
    """User 생성 시 자동으로 UserProfile 생성"""
    if created:
        UserProfile.objects.create(
            user=instance,
            # 관리자가 아닌 경우 기본 조회 권한 부여
            can_view_injection=not instance.is_staff,
            can_view_assembly=not instance.is_staff,
            can_view_quality=not instance.is_staff,
            can_view_sales=not instance.is_staff,
            can_view_development=not instance.is_staff,
            is_admin=instance.is_staff,
        ) 

class InjectionMonitoringRecord(models.Model):
    """사출기 파라미터 모니터링 시계열 데이터"""
    machine_name = models.CharField('설비명', max_length=50)
    device_code = models.CharField('Device Code', max_length=100, db_index=True)
    timestamp = models.DateTimeField('측정시간', db_index=True)
    capacity = models.FloatField('생산량', null=True, blank=True)
    oil_temperature = models.FloatField('오일온도', null=True, blank=True)

    class Meta:
        verbose_name = '사출기 모니터링 기록'
        verbose_name_plural = '사출기 모니터링 기록 목록'
        unique_together = ('device_code', 'timestamp')
        ordering = ['-timestamp', 'machine_name']

    def __str__(self):
        return f"{self.timestamp.strftime('%Y-%m-%d %H:%M')} - {self.machine_name}"