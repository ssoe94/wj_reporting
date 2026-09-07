"""Run task workflow checks against disposable SQLite, without loading project .env/settings."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from django.conf import settings

settings.configure(
    SECRET_KEY='isolated-development-task-checks',
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'analytics'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True,
)
import django

django.setup()
from django.core.management import call_command
from django.test.runner import DiscoverRunner

call_command('makemigrations', 'analytics', check=True, dry_run=True)
raise SystemExit(DiscoverRunner(verbosity=1).run_tests([
    'analytics.test_development_task_contract', 'analytics.test_development_task_persistence',
]))
