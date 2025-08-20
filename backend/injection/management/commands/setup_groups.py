from django.core.management.base import BaseCommand
from django.contrib.auth.models import Group, Permission
from django.contrib.contenttypes.models import ContentType
from injection.models import InjectionReport, Product, PartSpec, EngineeringChangeOrder

class Command(BaseCommand):
    help = '역할 기반 권한 그룹을 생성합니다'

    def handle(self, *args, **options):
        # 그룹 생성
        editor_group, created = Group.objects.get_or_create(name='editor')
        viewer_group, created = Group.objects.get_or_create(name='viewer')
        
        if created:
            self.stdout.write(
                self.style.SUCCESS('그룹이 성공적으로 생성되었습니다.')
            )
        
        # 모델별 권한 설정
        models = [InjectionReport, Product, PartSpec, EngineeringChangeOrder]
        
        for model in models:
            content_type = ContentType.objects.get_for_model(model)
            permissions = Permission.objects.filter(content_type=content_type)
            
            # 편집자 권한: 조회, 추가, 변경, 삭제
            for perm in permissions:
                editor_group.permissions.add(perm)
            
            # 조회자 권한: 조회만
            view_permissions = permissions.filter(codename__startswith='view_')
            for perm in view_permissions:
                viewer_group.permissions.add(perm)
        
        self.stdout.write(
            self.style.SUCCESS('권한이 그룹에 성공적으로 할당되었습니다.')
        )
        
        # 현재 그룹과 권한 정보 출력
        self.stdout.write('\n=== 생성된 그룹 ===')
        for group in Group.objects.all():
            self.stdout.write(f'- {group.name}: {group.permissions.count()}개 권한') 