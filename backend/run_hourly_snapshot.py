
import os
import sys
import django
import logging

# Add backend directory to Python path
BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

# Django settings
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

try:
    django.setup()
except Exception as e:
    print(f"ERROR: Failed to setup Django: {e}")
    sys.exit(1)

from injection.mes_service import mes_service

# Configure logging with more details
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [%(levelname)s] %(name)s: %(message)s',
    datefmt='%Y-%m-%d %H:%M:%S'
)
logger = logging.getLogger(__name__)

def run_snapshot():
    """
    This script is intended to be run by a scheduler (e.g., cron) every 10 minutes.
    It fetches the latest data point and saves it as a snapshot for the current 10-minute slot.
    Example: When run at 18:12, it saves the latest record with an 18:10 timestamp.
    """
    logger.info("=" * 80)
    logger.info("INTERVAL SNAPSHOT UPDATE - CRON JOB EXECUTION")
    logger.info("=" * 80)
    logger.info(f"Python version: {sys.version}")
    logger.info(f"Working directory: {os.getcwd()}")
    logger.info(f"Script location: {__file__}")
    logger.info(f"Django settings: {os.environ.get('DJANGO_SETTINGS_MODULE')}")
    logger.info("=" * 80)

    logger.info("Starting the 10-minute snapshot update process...")
    try:
        result = mes_service.update_hourly_snapshot_from_mes()
        logger.info(f"Interval snapshot update completed. Result: {result}")
        logger.info("=" * 80)
        logger.info("CRON JOB COMPLETED SUCCESSFULLY")
        logger.info("=" * 80)
    except Exception as e:
        logger.error("=" * 80)
        logger.error("CRON JOB FAILED")
        logger.error("=" * 80)
        logger.error(f"An error occurred during the hourly snapshot update: {e}", exc_info=True)
        sys.exit(1)

if __name__ == '__main__':
    run_snapshot()
