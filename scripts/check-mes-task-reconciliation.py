"""Offline framework checks; requires the repository's existing Python dependencies."""
from pathlib import Path
import sys
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))

# Do not discover a project .env while importing the existing MES helper.
import decouple
decouple.config = decouple.Config(decouple.RepositoryEmpty())

from django.conf import settings
settings.configure(
    SECRET_KEY='isolated-mes-task-checks',
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'production'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
    CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True,
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': [], 'UNAUTHENTICATED_USER': None},
)
import django
django.setup()
from django.test.runner import DiscoverRunner

with patch('requests.sessions.Session.request', side_effect=AssertionError('Network is forbidden in offline checks')):
    raise SystemExit(DiscoverRunner(verbosity=2).run_tests([
        'production.test_mes_task_reconciliation', 'production.test_mes_task_reconciliation_api',
    ]))
