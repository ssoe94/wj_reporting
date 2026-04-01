from django.contrib.auth.models import User
from django.core.management.base import BaseCommand

from injection.models import UserProfile


FIELD_PASSWORD = 'a123456789'


class Command(BaseCommand):
    help = 'Create or update field terminal users imm01~imm17 and assy01~assy04.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--password',
            default=FIELD_PASSWORD,
            help='Password applied to all field terminal users.',
        )
        parser.add_argument(
            '--update-existing-password',
            action='store_true',
            help='Also overwrite passwords for existing users.',
        )

    def handle(self, *args, **options):
        password = options['password']
        update_existing_password = options['update_existing_password']

        specs = [
            *[
                {
                    'username': f'imm{index:02d}',
                    'first_name': f'注塑{index:02d}',
                    'department': '注塑现场',
                    'can_view_injection': True,
                    'can_view_assembly': False,
                    'can_view_quality': False,
                    'can_view_sales': False,
                    'can_view_development': False,
                    'can_edit_injection': True,
                    'can_edit_assembly': False,
                    'can_edit_quality': False,
                    'can_edit_sales': False,
                    'can_edit_development': False,
                    'is_admin': False,
                }
                for index in range(1, 18)
            ],
            *[
                {
                    'username': f'assy{index:02d}',
                    'first_name': f'加工{label}',
                    'department': '加工现场',
                    'can_view_injection': False,
                    'can_view_assembly': True,
                    'can_view_quality': False,
                    'can_view_sales': False,
                    'can_view_development': False,
                    'can_edit_injection': False,
                    'can_edit_assembly': True,
                    'can_edit_quality': False,
                    'can_edit_sales': False,
                    'can_edit_development': False,
                    'is_admin': False,
                }
                for index, label in enumerate(['A', 'B', 'C', 'D'], start=1)
            ],
        ]

        created_count = 0
        updated_count = 0

        for spec in specs:
            username = spec['username']
            defaults = {
                'first_name': spec['first_name'],
                'email': '',
                'is_staff': False,
                'is_superuser': False,
                'is_active': True,
            }
            user, created = User.objects.get_or_create(username=username, defaults=defaults)

            user_changed = False
            for field, value in defaults.items():
                if getattr(user, field) != value:
                    setattr(user, field, value)
                    user_changed = True

            if created or update_existing_password:
                user.set_password(password)
                user_changed = True

            if user_changed:
                user.save()

            profile, _ = UserProfile.objects.get_or_create(user=user)
            profile.department = spec['department']
            profile.can_view_injection = spec['can_view_injection']
            profile.can_view_assembly = spec['can_view_assembly']
            profile.can_view_quality = spec['can_view_quality']
            profile.can_view_sales = spec['can_view_sales']
            profile.can_view_development = spec['can_view_development']
            profile.can_edit_injection = spec['can_edit_injection']
            profile.can_edit_assembly = spec['can_edit_assembly']
            profile.can_edit_quality = spec['can_edit_quality']
            profile.can_edit_sales = spec['can_edit_sales']
            profile.can_edit_development = spec['can_edit_development']
            profile.is_admin = spec['is_admin']
            profile.is_using_temp_password = False
            profile.password_reset_required = False
            profile.save()

            if created:
                created_count += 1
                self.stdout.write(self.style.SUCCESS(f'Created {username}'))
            else:
                updated_count += 1
                self.stdout.write(self.style.WARNING(f'Updated {username}'))

        self.stdout.write(
            self.style.SUCCESS(
                f'Field terminal users ready. created={created_count}, updated={updated_count}, password="{password}"'
            )
        )

