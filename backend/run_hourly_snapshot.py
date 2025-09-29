
import os
import django
import logging

# Django settings
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')
django.setup()

from injection.mes_service import mes_service

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def run_snapshot():
    """
    This script is intended to be run by a scheduler (e.g., cron, Windows Task Scheduler) every hour on the hour.
    It calls the function that fetches the last data point from the previous hour and saves it as a snapshot for the current hour.
    Example: When run at 18:00, it fetches data from 17:00-18:00 and saves the latest record with an 18:00 timestamp.
    """
    logger.info("Starting the hourly snapshot update process...")
    try:
        result = mes_service.update_hourly_snapshot_from_mes()
        logger.info(f"Hourly snapshot update completed. Result: {result}")
    except Exception as e:
        logger.error(f"An error occurred during the hourly snapshot update: {e}", exc_info=True)

if __name__ == '__main__':
    run_snapshot()
