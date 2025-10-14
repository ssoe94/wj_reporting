from django.core.management.base import BaseCommand
from django.contrib.auth.models import User
from injection.models import UserProfile


class Command(BaseCommand):
    help = '사용자 조회 권한 문제를 해결합니다 (기본: 모든 사용자에게 모든 조회 권한 부여)'

    def add_arguments(self, parser):
        parser.add_argument(
            '--grant-edit',
            nargs='+',
            help='특정 섹션의 편집 권한을 부여할 사용자명들 (예: --grant-edit user1 user2)',
        )
        parser.add_argument(
            '--section',
            choices=['injection', 'assembly', 'quality', 'sales', 'development'],
            default='assembly',
            help='편집 권한을 부여할 섹션 (기본: assembly)',
        )
        parser.add_argument(
            '--check-only',
            action='store_true',
            help='권한 상태만 확인하고 수정하지 않음',
        )

    def handle(self, *args, **options):
        if options['check_only']:
            self.check_permissions()
        elif options['grant_edit']:
            self.grant_edit_permissions(options['grant_edit'], options['section'])
        else:
            # 기본 동작: 모든 사용자에게 모든 조회 권한 부여
            self.grant_all_view_permissions()

    def check_permissions(self):
        self.stdout.write("=== 사용자 권한 상태 확인 ===\n")
        
        users = User.objects.all()
        for user in users:
            self.stdout.write(f"사용자: {user.username} ({user.email})")
            self.stdout.write(f"  - 스태프: {user.is_staff}")
            
            try:
                profile = user.profile
                self.stdout.write(f"  - 사출 조회: {profile.can_view_injection} | 편집: {profile.can_edit_injection}")
                self.stdout.write(f"  - 가공 조회: {profile.can_view_assembly} | 편집: {profile.can_edit_assembly}")
                self.stdout.write(f"  - 품질 조회: {profile.can_view_quality} | 편집: {profile.can_edit_quality}")
                self.stdout.write(f"  - 영업 조회: {profile.can_view_sales} | 편집: {profile.can_edit_sales}")
                self.stdout.write(f"  - 개발 조회: {profile.can_view_development} | 편집: {profile.can_edit_development}")
                self.stdout.write(f"  - 관리자: {profile.is_admin}")
            except UserProfile.DoesNotExist:
                self.stdout.write("  - 프로필 없음")
            
            self.stdout.write("-" * 50)

    def grant_all_view_permissions(self):
        self.stdout.write("=== 모든 조회 권한 부여 ===\n")
        
        users = User.objects.all()
        for user in users:
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
            
            if created:
                self.stdout.write(
                    self.style.SUCCESS(f"✓ {user.username}: 새 프로필 생성 (모든 조회 권한 부여)")
                )
            else:
                updated = False
                updates = []
                
                if not profile.can_view_injection:
                    profile.can_view_injection = True
                    updated = True
                    updates.append('사출')
                
                if not profile.can_view_assembly:
                    profile.can_view_assembly = True
                    updated = True
                    updates.append('가공')
                    
                if not profile.can_view_quality:
                    profile.can_view_quality = True
                    updated = True
                    updates.append('품질')
                    
                if not profile.can_view_sales:
                    profile.can_view_sales = True
                    updated = True
                    updates.append('영업')
                    
                if not profile.can_view_development:
                    profile.can_view_development = True
                    updated = True
                    updates.append('개발')
                
                if updated:
                    profile.save()
                    self.stdout.write(
                        self.style.SUCCESS(f"✓ {user.username}: {', '.join(updates)} 조회 권한 활성화")
                    )
                else:
                    self.stdout.write(f"- {user.username}: 이미 모든 조회 권한 있음")

    def grant_edit_permissions(self, usernames, section):
        section_names = {
            'injection': '사출',
            'assembly': '가공',
            'quality': '품질',
            'sales': '영업',
            'development': '개발'
        }
        
        self.stdout.write(f"=== {section_names[section]} 편집 권한 부여 ===\n")
        
        for username in usernames:
            try:
                user = User.objects.get(username=username)
                profile, created = UserProfile.objects.get_or_create(
                    user=user,
                    defaults={
                        'can_view_injection': True,
                        'can_view_assembly': True,
                        'can_view_quality': True,
                        'can_view_sales': True,
                        'can_view_development': True,
                    }
                )
                
                # 모든 조회 권한 먼저 부여
                profile.can_view_injection = True
                profile.can_view_assembly = True
                profile.can_view_quality = True
                profile.can_view_sales = True
                profile.can_view_development = True
                
                # 해당 섹션의 편집 권한 부여
                edit_field = f'can_edit_{section}'
                setattr(profile, edit_field, True)
                profile.save()
                
                self.stdout.write(
                    self.style.SUCCESS(f"✓ {username}: {section_names[section]} 편집 권한 부여 완료")
                )
            except User.DoesNotExist:
                self.stdout.write(
                    self.style.ERROR(f"✗ 사용자 '{username}'를 찾을 수 없습니다.")
                )