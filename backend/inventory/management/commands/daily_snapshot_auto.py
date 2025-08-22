"""
Daily Inventory Snapshot Automation Command

This command:
1. Fetches the latest inventory data from MES
2. Creates a daily snapshot for today
3. Handles errors and logging
4. Designed to run as a Render cron job at 8 AM CST daily
"""

from django.core.management.base import BaseCommand
from django.core.management import call_command
from django.utils import timezone
from django.db import transaction
from datetime import datetime, timedelta
from inventory.models import DailyInventorySnapshot, DailyReportSummary, StagingInventory
from django.db.models import Count, Sum
from collections import defaultdict
import logging

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = 'Automated daily inventory snapshot creation for Render.com cron job'

    def add_arguments(self, parser):
        parser.add_argument(
            '--date',
            type=str,
            help='Snapshot date (YYYY-MM-DD format, default: today in CST)',
        )
        parser.add_argument(
            '--skip-fetch',
            action='store_true',
            help='Skip inventory fetch step (use existing data)',
        )

    def get_china_time(self):
        """Get current time in China timezone (CST)"""
        from datetime import timezone as dt_timezone
        cst = dt_timezone(timedelta(hours=8))
        return datetime.now(cst)

    def create_daily_snapshot(self, snapshot_date):
        """Create daily snapshot for the given date"""
        # Delete existing snapshots for this date
        existing_count = DailyInventorySnapshot.objects.filter(snapshot_date=snapshot_date).count()
        if existing_count > 0:
            DailyInventorySnapshot.objects.filter(snapshot_date=snapshot_date).delete()
            self.stdout.write(f"Deleted {existing_count} existing snapshots for {snapshot_date}")

        # Get current inventory data
        current_inventory = StagingInventory.objects.all()
        
        # Group inventory data
        inventory_groups = defaultdict(lambda: {
            'total_quantity': 0,
            'cart_count': 0,
            'cart_details': [],
            'material_name': '',
            'specification': '',
            'unit': ''
        })

        for item in current_inventory:
            # Group key: material_code + warehouse_code + qc_status
            group_key = (item.material_code, item.warehouse_code, item.qc_status or '')
            
            group = inventory_groups[group_key]
            group['total_quantity'] += float(item.quantity)
            group['cart_count'] += 1
            
            # Cart detail info
            cart_detail = {
                'qr_code': item.qr_code,
                'label_code': item.label_code,
                'quantity': float(item.quantity),
                'location_name': item.location_name,
                'work_order_code': item.work_order_code,
                'updated_at': item.updated_at.isoformat() if item.updated_at else None
            }
            group['cart_details'].append(cart_detail)
            
            # Metadata
            if not group['material_name']:
                group['material_name'] = item.material_name
            if not group['specification']:
                group['specification'] = item.specification
            if not group['unit']:
                group['unit'] = item.unit

        # Create snapshots
        snapshots_to_create = []
        for (material_code, warehouse_code, qc_status), group_data in inventory_groups.items():
            snapshot = DailyInventorySnapshot(
                snapshot_date=snapshot_date,
                material_code=material_code,
                material_name=group_data['material_name'],
                specification=group_data['specification'],
                warehouse_code=warehouse_code,
                warehouse_name=next(
                    (item.warehouse_name for item in current_inventory 
                     if item.material_code == material_code and item.warehouse_code == warehouse_code),
                    ''
                ),
                qc_status=qc_status,
                total_quantity=group_data['total_quantity'],
                unit=group_data['unit'],
                cart_count=group_data['cart_count'],
                cart_details=group_data['cart_details']
            )
            snapshots_to_create.append(snapshot)

        # Save to database
        with transaction.atomic():
            DailyInventorySnapshot.objects.bulk_create(snapshots_to_create, ignore_conflicts=True)

        return len(snapshots_to_create)

    def handle(self, *args, **options):
        try:
            # 환경 변수 로깅
            import os
            from decouple import config
            self.stdout.write('=== Cron Job Environment Check ===')
            self.stdout.write(f'DJANGO_SETTINGS_MODULE: {os.getenv("DJANGO_SETTINGS_MODULE")}')
            self.stdout.write(f'MES_APP_KEY exists: {bool(os.getenv("MES_APP_KEY") or config("MES_APP_KEY", default=""))}')
            self.stdout.write(f'MES_APP_SECRET exists: {bool(os.getenv("MES_APP_SECRET") or config("MES_APP_SECRET", default=""))}')
            
            # Determine the date
            if options['date']:
                try:
                    snapshot_date = timezone.datetime.strptime(options['date'], '%Y-%m-%d').date()
                except ValueError:
                    self.stdout.write(
                        self.style.ERROR('Invalid date format. Use YYYY-MM-DD format.')
                    )
                    return
            else:
                china_time = self.get_china_time()
                snapshot_date = china_time.date()

            self.stdout.write(f"Starting daily snapshot creation for {snapshot_date}")
            china_time_str = self.get_china_time().strftime('%Y-%m-%d %H:%M:%S CST')
            self.stdout.write(f"China time: {china_time_str}")

            # Step 1: Fetch latest inventory data (unless skipped)
            if not options['skip_fetch']:
                self.stdout.write("Step 1: Fetching latest inventory data from MES...")
                try:
                    call_command('fetch_inventory')
                    self.stdout.write(self.style.SUCCESS("Successfully fetched inventory data"))
                except Exception as e:
                    self.stdout.write(self.style.WARNING(f"WARNING: Failed to fetch inventory data: {str(e)}"))
                    self.stdout.write(self.style.WARNING("WARNING: Continuing with existing inventory data..."))
            else:
                self.stdout.write("Step 1: Skipping inventory fetch (using existing data)")

            # Step 2: Create daily snapshot for the specified date
            self.stdout.write(f"Step 2: Creating daily snapshot for {snapshot_date}...")
            try:
                snapshot_count = self.create_daily_snapshot(snapshot_date)
                self.stdout.write(self.style.SUCCESS(f"Successfully created daily snapshot for {snapshot_date} ({snapshot_count} items)"))
            except Exception as e:
                self.stdout.write(self.style.ERROR(f"FAILED to create daily snapshot: {str(e)}"))
                raise

            # Step 3: Verify snapshot creation
            self.stdout.write("Step 3: Verifying snapshot creation...")
            try:
                snapshot_info = DailyInventorySnapshot.objects.filter(
                    snapshot_date=snapshot_date
                ).aggregate(
                    count=Count('id'),
                    total_quantity=Sum('total_quantity')
                )

                if snapshot_info['count'] > 0:
                    self.stdout.write(self.style.SUCCESS("Snapshot verification successful:"))
                    self.stdout.write(f"   - Items: {snapshot_info['count']}")
                    self.stdout.write(f"   - Total quantity: {snapshot_info['total_quantity']}")
                else:
                    self.stdout.write(self.style.ERROR("No snapshot data found after creation"))
                    raise Exception("Snapshot verification failed")

            except Exception as e:
                self.stdout.write(self.style.ERROR(f"Snapshot verification failed: {str(e)}"))
                raise

            # Step 4: Create or update daily report summary
            self.stdout.write("Step 4: Creating daily report summary...")
            try:
                summary, created = DailyReportSummary.objects.get_or_create(
                    snapshot_date=snapshot_date,
                    defaults={
                        'total_items': snapshot_info['count'],
                        'total_quantity': snapshot_info['total_quantity'] or 0,
                        'email_status': 'pending'
                    }
                )

                if created:
                    self.stdout.write(self.style.SUCCESS("Created daily report summary"))
                else:
                    # Update existing summary
                    summary.total_items = snapshot_info['count']
                    summary.total_quantity = snapshot_info['total_quantity'] or 0
                    summary.save()
                    self.stdout.write(self.style.SUCCESS("Updated daily report summary"))

            except Exception as e:
                self.stdout.write(self.style.WARNING(f"Daily report summary creation failed: {str(e)}"))
                # This is not critical, continue

            self.stdout.write(
                self.style.SUCCESS(f"Daily snapshot creation completed successfully for {snapshot_date}")
            )

        except Exception as e:
            self.stdout.write(self.style.ERROR(f"Critical error in daily snapshot creation: {str(e)}"))
            self.stdout.write(self.style.ERROR("Daily snapshot creation failed"))
            raise  # Re-raise to ensure proper exit code