from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from analytics.services import parse_business_date, refresh_production_marts


class Command(BaseCommand):
    help = 'Refresh analytics mart tables.'

    def add_arguments(self, parser):
        parser.add_argument('--date', dest='date', default=None, help='Business date in YYYY-MM-DD format.')
        parser.add_argument(
            '--scope',
            dest='scope',
            default='production',
            choices=['production'],
            help='Analytics mart scope to refresh.',
        )
        parser.add_argument(
            '--language',
            dest='language',
            default='ko',
            choices=['ko', 'zh'],
            help='Calculation basis language for persisted evidence.',
        )

    def handle(self, *args, **options):
        date_value = options.get('date') or timezone.localdate().isoformat()
        try:
            target_date = parse_business_date(date_value)
        except ValueError as exc:
            raise CommandError(str(exc))

        if options['scope'] == 'production':
            payload = refresh_production_marts(target_date, language=options['language'])
            self.stdout.write(self.style.SUCCESS(
                'Refreshed production analytics marts '
                f"for {target_date.isoformat()} "
                f"(daily={len(payload['daily'])}, "
                f"equipment={len(payload['equipment'])}, "
                f"parts={len(payload['parts'])}, "
                f"exceptions={len(payload['exceptions'])})"
            ))
