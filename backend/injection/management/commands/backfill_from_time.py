
import time
from django.core.management.base import BaseCommand, CommandError
from datetime import datetime, timedelta
import pytz
import logging

from injection.mes_service import mes_service

class Command(BaseCommand):
    help = 'Backfills historical injection monitoring data from the MES API starting from a specific time or for the last N hours.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--hours',
            type=int,
            help='Specifies how many hours back from the current time to backfill data.'
        )
        parser.add_argument(
            '--start-time',
            type=str,
            help='Specifies the start time for backfilling in YYYY-MM-DDTHH:MM:SS format (e.g., 2026-01-26T06:00:00). Assumes Asia/Shanghai timezone.'
        )

    def handle(self, *args, **options):
        hours_to_backfill = options['hours']
        start_time_str = options['start_time']
        
        cst = pytz.timezone('Asia/Shanghai')
        now = datetime.now(cst)

        if not hours_to_backfill and not start_time_str:
            raise CommandError('Either --hours or --start-time must be provided.')

        if start_time_str:
            try:
                start_time = cst.localize(datetime.strptime(start_time_str, '%Y-%m-%dT%H:%M:%S'))
                if start_time >= now:
                    raise CommandError(f'Start time ({start_time.isoformat()}) must be in the past.')
                
                time_diff = now - start_time
                # Round up to the nearest whole hour
                hours_to_backfill = int(time_diff.total_seconds() / 3600) + 1
                
                self.stdout.write(self.style.SUCCESS(f'Calculated backfill duration: {hours_to_backfill} hours (from {start_time_str} to now).'))

            except ValueError:
                raise CommandError('Invalid --start-time format. Please use YYYY-MM-DDTHH:MM:SS.')

        if hours_to_backfill <= 0:
            raise CommandError('The calculated number of hours to backfill must be positive.')

        self.stdout.write(self.style.SUCCESS(f'Starting data backfill for the last {hours_to_backfill} hours...'))
        
        try:
            # Use the robust, existing service function for backfilling
            mes_service.update_recent_hourly_snapshots(hours_to_update=hours_to_backfill)
        except Exception as e:
            self.stderr.write(self.style.ERROR(f'An error occurred during the backfill process: {e}'))
            raise CommandError('Backfill failed.')

        self.stdout.write(self.style.SUCCESS('Data backfill process completed successfully.'))
