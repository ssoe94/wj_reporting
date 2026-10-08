"""Disposable workflow QA. No project .env, production DB or MES network.

--make-migrations: additive production schema generation.
--migration-check: detects missing migration operations.
--preview: local synthetic API fixture at 127.0.0.1:8029.
"""
from pathlib import Path
import sys
import types
import tempfile
from unittest.mock import patch
from inspection_test_database import inspection_test_database

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
# Reuse an installed bundled library, preserving the repository venv precedence.
bundled_packages = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/lib/python3.12/site-packages'
if bundled_packages.is_dir():
    sys.path.append(str(bundled_packages))
import decouple
decouple.config = decouple.Config(decouple.RepositoryEmpty())
from django.conf import settings
preview = '--preview' in sys.argv
fixture_dir = tempfile.TemporaryDirectory(prefix='wj-plan-workflow-')
settings.configure(
    SECRET_KEY='isolated-plan-workflow-only', DEBUG=preview,
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions',
        'rest_framework', 'django_filters', 'injection', 'assembly', 'sales', 'overview',
        'inventory', 'quality', 'production', 'ai_core', 'analytics', 'mes_oauth'],
    DATABASES={'default': inspection_test_database(sys.argv[1:], ROOT, sqlite_name=str(Path(fixture_dir.name) / 'fixture.sqlite3'))},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True, TIME_ZONE='Asia/Shanghai',
    ROOT_URLCONF='isolated_plan_urls', ALLOWED_HOSTS=['testserver', 'localhost', '127.0.0.1'],
    PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': [], 'UNAUTHENTICATED_USER': None}, MIDDLEWARE=[],
    CLOUDINARY_STORAGE={'CLOUD_NAME': 'synthetic', 'API_KEY': 'synthetic', 'API_SECRET': 'synthetic'},
    MEDIA_ROOT=fixture_dir.name,
)
import django
django.setup()
from django.urls import path, include
from injection.views import ProductionPlanUploadView, InjectionMonitoringDatesView
urls = types.ModuleType('isolated_plan_urls')
urls.urlpatterns = [path('api/injection/monitoring-dates/', InjectionMonitoringDatesView.as_view()), path('api/production/', include('production.urls')),
    path('api/injection/production-plan/upload/', ProductionPlanUploadView.as_view(), name='production-plan-upload-root')]
sys.modules[urls.__name__] = urls
from django.core.management import call_command
if '--make-migrations' in sys.argv:
    call_command('makemigrations', 'production', name='plan_material_workflow')
elif '--sql-migration' in sys.argv:
    call_command('sqlmigrate', 'production', '0016')
elif '--migration-check' in sys.argv:
    call_command('makemigrations', 'production', check=True, dry_run=True)
elif preview:
    call_command('migrate', verbosity=0)
    from django.contrib.auth import get_user_model
    from rest_framework.authentication import BaseAuthentication
    user = get_user_model().objects.create_user(username='SYNTHETIC-plan-qa', is_staff=True, is_superuser=True)
    class SyntheticAuthentication(BaseAuthentication):
        def authenticate(self, request): return user, None
    from production.plan_workflow_views import PlanWorkflowView
    from production.views import ProductionPlanListView
    PlanWorkflowView.authentication_classes = [SyntheticAuthentication]
    ProductionPlanListView.authentication_classes = [SyntheticAuthentication]
    from production.test_plan_workflow import seed_catalog, new_plan, approval_data
    from production.plan_workflow import approve_materials
    seed_catalog()
    for day, quantity in [(8, 1000), (9, 1000), (10, 300)]:
        plan = new_plan(day=day, quantity=quantity, actor=user)
        approve_materials(plan, approval_data(plan), user)
    new_plan(day=8, part='SYNTHETIC-UNCONFIRMED', machine='imm02', actor=user)
    with patch('requests.sessions.Session.request', side_effect=AssertionError('MES network forbidden in synthetic preview')):
        call_command('runserver', '127.0.0.1:8029', use_reloader=False)
else:
    from django.test.runner import DiscoverRunner
    labels = ['production.test_plan_workflow', 'production.test_mes_execution_contract',
        'production.test_plan_workflow_concurrency', 'production.test_mes_delivery', 'production.test_mes_task_actions', 'injection.tests']
    with patch('requests.sessions.Session.request', side_effect=AssertionError('MES network forbidden in isolated tests')):
        raise SystemExit(DiscoverRunner(verbosity=2).run_tests(labels))
