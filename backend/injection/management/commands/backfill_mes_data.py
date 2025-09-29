import datetime
from django.core.management.base import BaseCommand
from injection.mes_service import mes_service

class Command(BaseCommand):
    help = 'Backfills historical injection monitoring data from the MES API.'

    def add_arguments(self, parser):
        parser.add_argument(
            '--start-date',
            type=str,
            default='2025-09-19',
            help='The start date for backfilling data in YYYY-MM-DD format.'
        )
        parser.add_argument(
            '--end-date',
            type=str,
            default=datetime.date.today().strftime('%Y-%m-%d'),
            help='The end date for backfilling data in YYYY-MM-DD format.'
        )

    def handle(self, *args, **options):
        start_date_str = options['start_date']
        end_date_str = options['end_date']

        try:
            start_date = datetime.datetime.strptime(start_date_str, '%Y-%m-%d').date()
            end_date = datetime.datetime.strptime(end_date_str, '%Y-%m-%d').date()
        except ValueError:
            self.stdout.write(self.style.ERROR('Invalid date format. Please use YYYY-MM-DD.'))
            return

        if start_date > end_date:
            self.stdout.write(self.style.ERROR('Start date cannot be after end date.'))
            return

        self.stdout.write(self.style.SUCCESS(f'Starting backfill from {start_date} to {end_date}...'))

        current_date = start_date
        while current_date <= end_date:
            self.stdout.write(f'Fetching data for {current_date.strftime("%Y-%m-%d")}...')
            
            import pytz
            cst = pytz.timezone('Asia/Shanghai')
            begin_time = datetime.datetime.combine(current_date, datetime.time.min, tzinfo=cst)
            end_time = datetime.datetime.combine(current_date, datetime.time.max, tzinfo=cst)

            try:
                mes_service.fetch_and_save_range(begin_time, end_time)
                self.stdout.write(self.style.SUCCESS(f'Successfully processed {current_date.strftime("%Y-%m-%d")}.'))
            except Exception as e:
                self.stdout.write(self.style.ERROR(f'An error occurred on {current_date.strftime("%Y-%m-%d")}: {e}'))

            current_date += datetime.timedelta(days=1)

        self.stdout.write(self.style.SUCCESS('Historical data backfill complete.'))
