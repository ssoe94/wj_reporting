"""Isolated C/T tests: disposable SQLite and no project settings, .env or network."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
# Prevent imported legacy MES modules from searching for credentials in .env.
import decouple

decouple.config = decouple.Config(decouple.RepositoryEmpty())
from django.conf import settings

settings.configure(
    SECRET_KEY='isolated-cycle-time-history-checks',
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'injection', 'production'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True, TIME_ZONE='Asia/Shanghai',
    ROOT_URLCONF='injection.cycle_time_history_test_urls',
    CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.SessionAuthentication']},
)
import django

django.setup()
from django.core.management import call_command
from django.test.runner import DiscoverRunner

if '--make-migrations' in sys.argv:
    call_command('makemigrations', 'injection', name='cycle_time_history')
else:
    call_command('makemigrations', 'injection', check=True, dry_run=True)
    raise SystemExit(DiscoverRunner(verbosity=2).run_tests(['injection.test_cycle_time_history', 'injection.test_rollup_retention']))
