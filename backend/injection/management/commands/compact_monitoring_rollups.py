from datetime import datetime

from django.conf import settings
from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from injection.rollup_retention import compact_five_minute_rollups, retention_cutoff


class Command(BaseCommand):
    help = 'Verify hourly totals and compact five-minute statistics older than 30 days. Dry run by default.'

    def add_arguments(self, parser):
        parser.add_argument('--apply', action='store_true')
        parser.add_argument('--start', required=True, help='Inclusive ISO timestamp with timezone.')
        parser.add_argument('--end', help='Exclusive ISO timestamp with timezone; capped at 30-day retention.')
        parser.add_argument('--max-hours', type=int, default=24)

    def handle(self, *args, **options):
        settings.DEBUG = False
        try:
            start = datetime.fromisoformat(options['start'])
            end = datetime.fromisoformat(options['end']) if options['end'] else retention_cutoff()
            if timezone.is_naive(start) or timezone.is_naive(end) or start >= end or not 1 <= options['max_hours'] <= 168:
                raise ValueError()
        except ValueError:
            raise CommandError('Use timezone-aware start < end and max-hours from 1 to 168.')
        result = compact_five_minute_rollups(start, end, apply=options['apply'], max_hours=options['max_hours'])
        self.stdout.write(str(result))
