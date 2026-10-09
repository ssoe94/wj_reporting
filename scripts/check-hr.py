"""Disposable HR checks: no project settings, .env, production DB or payroll."""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
import decouple
decouple.config = decouple.Config(decouple.RepositoryEmpty())
from django.conf import settings
settings.configure(
    SECRET_KEY='isolated-hr-checks',
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'rest_framework', 'injection', 'production', 'analytics'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
    ROOT_URLCONF='analytics.hr_test_urls',
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True,
    SESSION_ENGINE='django.contrib.sessions.backends.signed_cookies',
    PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': [], 'UNAUTHENTICATED_USER': 'django.contrib.auth.models.AnonymousUser'},
)
import django
django.setup()
from django.core.management import call_command
from django.test.runner import DiscoverRunner
call_command('makemigrations', 'analytics', check=True, dry_run=True)
raise SystemExit(DiscoverRunner(verbosity=1).run_tests([
    'analytics.test_hr', 'analytics.test_hr_user_permissions',
    'injection.test_admin_user_create.AdminUserCreateTests',
    'injection.test_admin_user_create.AdminUserEditTests',
]))
