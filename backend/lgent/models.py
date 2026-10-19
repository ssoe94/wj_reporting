import uuid
from django.conf import settings
from django.db import models


class LgentProfile(models.Model):
    """Per-WJ-user LG session; only the token is encrypted, never a password."""
    user = models.OneToOneField(settings.AUTH_USER_MODEL,on_delete=models.CASCADE,related_name='lgent_profile')
    device_id = models.UUIDField(default=uuid.uuid4,editable=False)
    encrypted_token = models.TextField(blank=True,default='')
    lg_user_id = models.CharField(max_length=160,blank=True,default='')
    lg_user_name = models.CharField(max_length=160,blank=True,default='')
    current_company = models.CharField(max_length=32,blank=True,default='')
    menu_permission = models.CharField(max_length=32,blank=True,default='')
    expires_at = models.DateTimeField(null=True,blank=True)
    stale_days = models.PositiveIntegerField(default=30)
    updated_at = models.DateTimeField(auto_now=True)


class LgentCart(models.Model):
    trolley_id = models.CharField(max_length=64,unique=True)
    supplier_code = models.CharField(max_length=32,default='TT094',editable=False)
    grade = models.CharField(max_length=8,blank=True,default='')
    baseline = models.JSONField(default=dict,blank=True)
    last_history_at = models.CharField(max_length=64,blank=True,default='')
    lg_modified_at = models.DateTimeField(null=True,blank=True)
    photo_file_at = models.DateTimeField(null=True,blank=True)
    verified_save_at = models.DateTimeField(null=True,blank=True)
    photo_sha256 = models.CharField(max_length=64,blank=True,default='')
    save_attempt_id = models.CharField(max_length=64,blank=True,default='')
    save_started_at = models.DateTimeField(null=True,blank=True)
    checked_at = models.DateTimeField(null=True,blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)


class LgentPhoto(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.SET_NULL,null=True,related_name='lgent_photos')
    filename = models.CharField(max_length=255)
    sha256 = models.CharField(max_length=64)
    storage_key = models.CharField(max_length=512)
    byte_size = models.PositiveIntegerField()
    status = models.CharField(max_length=24,default='pending',db_index=True)
    trolley_id = models.CharField(max_length=64,blank=True,default='')
    grade = models.CharField(max_length=8,blank=True,default='')
    baseline = models.JSONField(default=dict,blank=True)
    previous_photo_sha256 = models.CharField(max_length=64,blank=True,default='')
    recognized_ids = models.JSONField(default=list,blank=True)
    note = models.CharField(max_length=512,blank=True,default='')
    job = models.ForeignKey('ai_core.AiJob',on_delete=models.SET_NULL,null=True,blank=True,related_name='lgent_photos')
    save_attempt_id = models.CharField(max_length=64,blank=True,default='')
    saved_at = models.DateTimeField(null=True,blank=True)
    archived_at = models.DateTimeField(null=True,blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['user','sha256'],name='lgent_unique_user_photo')]
        indexes = [models.Index(fields=['user','status','-created_at'],name='lgent_user_photo_status')]


class LgentSaveEvent(models.Model):
    user = models.ForeignKey(settings.AUTH_USER_MODEL,on_delete=models.SET_NULL,null=True)
    photo = models.ForeignKey(LgentPhoto,on_delete=models.PROTECT,related_name='save_events')
    trolley_id = models.CharField(max_length=64)
    attempt_id = models.CharField(max_length=64,unique=True)
    outcome = models.CharField(max_length=24)
    info_verified = models.BooleanField(default=False)
    photo_verified = models.BooleanField(default=False)
    created_at = models.DateTimeField(auto_now_add=True)
