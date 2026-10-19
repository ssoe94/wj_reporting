"""Persist complete closed MES days; explicit backfill is safe to rerun."""
from datetime import date, timedelta
from django.core.management.base import BaseCommand, CommandError
from inventory.movement_history import closed_business_date, sync_history_day


class Command(BaseCommand):
    help = 'Collect finished-goods daily/model/identifier history (default: last 7 closed days).'

    def add_arguments(self, parser):
        parser.add_argument('--start-date')
        parser.add_argument('--end-date')

    def handle(self, *args, **options):
        end = closed_business_date()
        try:
            if bool(options['start_date']) != bool(options['end_date']):
                raise ValueError('Provide both start-date and end-date.')
            if options['end_date']:
                end = date.fromisoformat(options['end_date'])
                start = date.fromisoformat(options['start_date'])
            else:
                start = end - timedelta(days=6)
            if not 0 <= (end-start).days < 366 or end > closed_business_date():
                raise ValueError('Choose 1–366 closed business days.')
        except ValueError as exc:
            raise CommandError(str(exc)) from None
        failed = []
        for index in range((end-start).days+1):
            day = start + timedelta(days=index)
            try:
                version = sync_history_day(day)
                self.stdout.write(f'{day}: revision {version}')
            except Exception:
                # No upstream URL/credential/body leakage. Continue other days.
                failed.append(day.isoformat())
                self.stderr.write(f'{day}: collection failed; last published data preserved')
        if failed:
            raise CommandError('Failed business dates: ' + ', '.join(failed))
