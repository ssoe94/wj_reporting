#!/usr/bin/env python
"""
Daily Inventory Snapshot Creation Script for Render.com

This script:
1. Fetches the latest inventory data from MES
2. Creates a daily snapshot for today
3. Handles errors and logging
4. Designed to run as a Render cron job at 8 AM KST daily
"""

import os
import sys
import django
import logging
from datetime import datetime, timezone, timedelta

# Add the backend directory to Python path
backend_dir = os.path.dirname(os.path.abspath(__file__))
backend_parent = os.path.dirname(backend_dir)
if backend_parent not in sys.path:
    sys.path.insert(0, backend_parent)

# Django setup
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

# Now import Django components after setup
from django.core.management import call_command
from django.utils import timezone as django_timezone

# Logging setup
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(sys.stdout)
    ]
)
logger = logging.getLogger(__name__)

def get_korean_time():
    """Get current time in Korean timezone (KST)"""
    kst = timezone(timedelta(hours=9))
    return datetime.now(kst)

def main():
    """Main function to execute daily snapshot creation"""
    try:
        korean_time = get_korean_time()
        today_date = korean_time.strftime('%Y-%m-%d')
        
        logger.info(f"Starting daily snapshot creation for {today_date}")
        logger.info(f"Korean time: {korean_time.strftime('%Y-%m-%d %H:%M:%S KST')}")
        
        # Step 1: Fetch latest inventory data
        logger.info("Step 1: Fetching latest inventory data from MES...")
        try:
            call_command('fetch_inventory')
            logger.info("✅ Successfully fetched inventory data")
        except Exception as e:
            logger.error(f"❌ Failed to fetch inventory data: {str(e)}")
            # Continue with snapshot creation using existing data
            logger.warning("⚠️ Continuing with existing inventory data...")
        
        # Step 2: Create daily snapshot for today
        logger.info(f"Step 2: Creating daily snapshot for {today_date}...")
        try:
            call_command('create_daily_snapshot', date=today_date, force=True)
            logger.info(f"✅ Successfully created daily snapshot for {today_date}")
        except Exception as e:
            logger.error(f"❌ Failed to create daily snapshot: {str(e)}")
            raise
        
        # Step 3: Verify snapshot creation
        logger.info("Step 3: Verifying snapshot creation...")
        try:
            from inventory.models import DailyInventorySnapshot
            from django.db.models import Count, Sum
            
            snapshot_info = DailyInventorySnapshot.objects.filter(
                snapshot_date=today_date
            ).aggregate(
                count=Count('id'),
                total_quantity=Sum('total_quantity')
            )
            
            if snapshot_info['count'] > 0:
                logger.info(f"✅ Snapshot verification successful:")
                logger.info(f"   - Items: {snapshot_info['count']}")
                logger.info(f"   - Total quantity: {snapshot_info['total_quantity']}")
            else:
                logger.error("❌ No snapshot data found after creation")
                raise Exception("Snapshot verification failed")
                
        except Exception as e:
            logger.error(f"❌ Snapshot verification failed: {str(e)}")
            raise
        
        # Step 4: Check for email scheduling (if implemented)
        logger.info("Step 4: Checking email scheduling...")
        try:
            from inventory.models import DailyReportSummary
            
            summary, created = DailyReportSummary.objects.get_or_create(
                snapshot_date=today_date,
                defaults={
                    'total_items': snapshot_info['count'],
                    'total_quantity': snapshot_info['total_quantity'] or 0,
                    'email_status': 'pending'
                }
            )
            
            if created:
                logger.info("✅ Created daily report summary")
            else:
                logger.info("ℹ️ Daily report summary already exists")
                
        except Exception as e:
            logger.warning(f"⚠️ Email scheduling setup failed: {str(e)}")
            # This is not critical, continue
        
        logger.info(f"🎉 Daily snapshot creation completed successfully for {today_date}")
        return True
        
    except Exception as e:
        logger.error(f"💥 Critical error in daily snapshot creation: {str(e)}")
        logger.error("❌ Daily snapshot creation failed")
        return False

if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)