# Generated manually to fix assembly permissions

from django.db import migrations

def fix_assembly_permissions(apps, schema_editor):
    """모든 사용자에게 가공 조회 권한 부여"""
    UserProfile = apps.get_model('injection', 'UserProfile')
    User = apps.get_model('auth', 'User')
    
    # 모든 사용자에 대해 UserProfile 생성 및 권한 부여
    for user in User.objects.all():
        profile, created = UserProfile.objects.get_or_create(
            user=user,
            defaults={
                'can_view_assembly': True,
                'can_edit_assembly': False,
            }
        )
        
        if not created and not profile.can_view_assembly:
            # 기존 프로필이 있지만 가공 조회 권한이 없는 경우
            profile.can_view_assembly = True
            profile.save()

def reverse_fix_assembly_permissions(apps, schema_editor):
    """롤백 시 실행될 함수 (필요시)"""
    pass

class Migration(migrations.Migration):

    dependencies = [
        ('injection', '0030_fix_assembly_permissions'),
    ]

    operations = [
        migrations.RunPython(
            fix_assembly_permissions,
            reverse_fix_assembly_permissions,
        ),
    ]