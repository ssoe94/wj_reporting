"""Idempotently preserve existing raw C/T evidence, without any external MES query."""
from datetime import date, timedelta

from django.core.management.base import BaseCommand, CommandError
from django.utils import timezone

from injection.cycle_time_history import archive_cycle_time_range, business_date_at


class Command(BaseCommand):
    help = 'Archive durable hourly C/T evidence before monitoring retention. Reads existing local DB rows only.'

    def add_arguments(self, parser):
        parser.add_argument('--start-date', help='Inclusive Shanghai 08:00 business date (YYYY-MM-DD).')
        parser.add_argument('--end-date', help='Inclusive Shanghai 08:00 business date (defaults to today).')
        parser.add_argument('--compact', action='store_true', help='Use compressed hourly storage after all readers support it.')
        parser.add_argument('--machine-number', type=int, choices=range(1, 18))

    def handle(self, *args, **options):
        try:
            end = date.fromisoformat(options['end_date']) if options['end_date'] else business_date_at(timezone.now())
            start = date.fromisoformat(options['start_date']) if options['start_date'] else end - timedelta(days=7)
            if start > end or (end - start).days >= 366:
                raise ValueError('Choose 1 to 366 inclusive business dates.')
        except ValueError as exc:
            raise CommandError(str(exc)) from exc
        # Commit each day independently; a retry does not duplicate successful days.
        totals = dict(created=0, revised=0, unchanged=0, preserved=0)
        current = start
        while current <= end:
            result = archive_cycle_time_range(current, current, machine=options['machine_number'], compact=options['compact'])
            for key in totals:
                totals[key] += result[key]
            current += timedelta(days=1)
        self.stdout.write(self.style.SUCCESS(str(totals)))
