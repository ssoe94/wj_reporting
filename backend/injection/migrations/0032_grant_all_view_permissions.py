# Generated manually to grant all view permissions to all users

from django.db import migrations

def grant_all_view_permissions(apps, schema_editor):
    """모든 사용자에게 모든 섹션의 조회 권한 부여"""
    UserProfile = apps.get_model('injection', 'UserProfile')
    User = apps.get_model('auth', 'User')
    
    # 모든 사용자에 대해 UserProfile 생성 및 모든 조회 권한 부여
    for user in User.objects.all():
        profile, created = UserProfile.objects.get_or_create(
            user=user,
            defaults={
                'can_view_injection': True,
                'can_view_assembly': True,
                'can_view_quality': True,
                'can_view_sales': True,
                'can_view_development': True,
                'can_edit_injection': False,
                'can_edit_assembly': False,
                'can_edit_quality': False,
                'can_edit_sales': False,
                'can_edit_development': False,
                'is_admin': False,
            }
        )
        
        if not created:
            # 기존 프로필이 있는 경우 모든 조회 권한 활성화
            updated = False
            
            if not profile.can_view_injection:
                profile.can_view_injection = True
                updated = True
            
            if not profile.can_view_assembly:
                profile.can_view_assembly = True
                updated = True
                
            if not profile.can_view_quality:
                profile.can_view_quality = True
                updated = True
                
            if not profile.can_view_sales:
                profile.can_view_sales = True
                updated = True
                
            if not profile.can_view_development:
                profile.can_view_development = True
                updated = True
            
            if updated:
                profile.save()

def reverse_grant_all_view_permissions(apps, schema_editor):
    """롤백 시 실행될 함수 (필요시)"""
    pass

class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0031_fix_assembly_permissions'),
    ]

    operations = [
        migrations.RunPython(
            grant_all_view_permissions,
            reverse_grant_all_view_permissions,
        ),
    ]