from django.core.management.base import BaseCommand
from django.contrib.auth.models import Group, Permission
from django.contrib.contenttypes.models import ContentType
from injection.models import InjectionReport, Product, PartSpec, EngineeringChangeOrder

class Command(BaseCommand):
    help = 'Create role-based permission groups'

    def handle(self, *args, **options):
        # Create groups
        editor_group, editor_created = Group.objects.get_or_create(name='editor')
        viewer_group, viewer_created = Group.objects.get_or_create(name='viewer')
        
        if editor_created or viewer_created:
            self.stdout.write(
                self.style.SUCCESS('Groups created successfully.')
            )
        
        # Set model permissions
        models = [InjectionReport, Product, PartSpec, EngineeringChangeOrder]
        
        for model in models:
            content_type = ContentType.objects.get_for_model(model)
            permissions = Permission.objects.filter(content_type=content_type)
            
            # Editor permissions: view, add, change, delete
            for perm in permissions:
                editor_group.permissions.add(perm)
            
            # Viewer permissions: view only
            view_permissions = permissions.filter(codename__startswith='view_')
            for perm in view_permissions:
                viewer_group.permissions.add(perm)
        
        self.stdout.write(
            self.style.SUCCESS('Permissions assigned to groups successfully.')
        )
        
        # Display current groups and permissions
        self.stdout.write('\n=== Created Groups ===')
        for group in Group.objects.all():
            self.stdout.write(f'- {group.name}: {group.permissions.count()} permissions') 