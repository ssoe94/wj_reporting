"""Inspection checks/preview with disposable local data, no .env or MES network.

--make-migrations generates additive quality migration only.
--preview runs disposable synthetic browser fixtures at 127.0.0.1:8017.
--preview-port=8021 allows an independent preview without replacing an existing one.
--postgres-test-socket=/absolute/worktree/output/socket uses an already approved
disposable local PostgreSQL cluster; never starts services or loads credentials.
Never use these settings for deployment.
"""
from pathlib import Path
import sys
import types
import tempfile
from inspection_test_database import inspection_test_database, POSTGRES_SOCKET_OPTION

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
import decouple
decouple.config = decouple.Config(decouple.RepositoryEmpty())
from django.conf import settings
preview = '--preview' in sys.argv
preview_port = int(next((arg.split('=', 1)[1] for arg in sys.argv if arg.startswith('--preview-port=')), '8017'))
if not 1024 <= preview_port <= 65535:
    raise SystemExit('Preview port must be between 1024 and 65535.')
preview_directory = tempfile.TemporaryDirectory(prefix='wj-inspection-preview-') if preview else None
try:
    test_database = inspection_test_database(sys.argv[1:], ROOT, sqlite_name=
        str(Path(preview_directory.name) / 'synthetic.sqlite3') if preview else ':memory:')
except ValueError as error:
    raise SystemExit(str(error))
sys.argv = [argument for argument in sys.argv if not argument.startswith(POSTGRES_SOCKET_OPTION)]
settings.configure(
    INSPECTION_SYNTHETIC_PREVIEW=preview,
    SECRET_KEY='isolated-inspection-tests-only', DEBUG=preview,
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions',
                    'rest_framework', 'django_filters', 'injection', 'assembly', 'sales', 'overview',
                    'inventory', 'quality', 'production', 'ai_core', 'analytics', 'mes_oauth'],
    DATABASES={'default': test_database},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True, TIME_ZONE='Asia/Shanghai',
    ROOT_URLCONF='isolated_inspection_urls', ALLOWED_HOSTS=['testserver', 'localhost', '127.0.0.1'],
    PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.SessionAuthentication']},
    MIDDLEWARE=[], CLOUDINARY_STORAGE={'CLOUD_NAME': 'synthetic-test', 'API_KEY': 'synthetic-test', 'API_SECRET': 'synthetic-test'}, MEDIA_ROOT=tempfile.gettempdir(),
)
import django
django.setup()
from django.urls import path, include
urls = types.ModuleType('isolated_inspection_urls')
urls.urlpatterns = [path('api/quality/', include('quality.urls')),
                    path('api/production/', include('production.urls'))]
sys.modules[urls.__name__] = urls
from django.core.management import call_command

if '--make-migrations' in sys.argv:
    call_command('makemigrations', 'quality', name='inspection_requests')
elif preview:
    # Preview authentication is injected only into this disposable local server,
    # not the application authentication or deployed routes.
    (ROOT / 'output').mkdir(exist_ok=True)
    call_command('migrate', verbosity=0)
    from django.contrib.auth import get_user_model
    from django.utils import timezone
    from rest_framework.authentication import BaseAuthentication
    from config.token_views import ScopedTokenObtainPairSerializer
    from mes_oauth.session_guard import InspectionSession
    from quality.inspection_models import InspectionRequest
    from quality.inspection_workflow import create_request
    from quality.inspection_kanban import business_date
    from production.models import ProductionPlan, ProductionExecution
    import uuid
    user, _ = get_user_model().objects.get_or_create(username='synthetic-inspection-qa', defaults={'is_superuser': True, 'is_staff': True})
    token = ScopedTokenObtainPairSerializer.get_token(user).access_token

    class SyntheticAuthentication(BaseAuthentication):
        def authenticate(self, request):
            return user, token

    from quality.inspection_views import InspectionRequestViewSet
    InspectionRequestViewSet.authentication_classes = [SyntheticAuthentication]
    from datetime import timedelta
    today = business_date()
    for number, part, state in [(2, 'SYNTHETIC-PART', 'running'), (7, 'SYNTHETIC-PLANNED', 'paused')]:
        plan = {'plan_date': today, 'plan_type': 'injection', 'machine_name': f'imm{number:02d}',
                'part_no': part, 'lot_no': 'SYNTHETIC-LOT', 'sequence': 1}
        ProductionPlan.objects.create(**plan, planned_quantity=500)
        ProductionExecution.objects.create(**plan, status=state)
    for index, machine, kind in [(1, 'imm02', 'first'), (2, '2号注塑机', 'process'),
                                  (3, 'imm07', 'first'), (4, 'imm05', 'first'),
                                  (5, 'SYNTHETIC-UNKNOWN', 'first'), (6, 'imm01', 'first')]:
        data, _ = create_request(user, uuid.uuid4(), {
            'work_order_ref': f'SYNTHETIC-WO-{index:03d}', 'task_ref': f'SYNTHETIC-TASK-{index:03d}',
            'part_no': 'SYNTHETIC-PART', 'equipment_ref': machine, 'inspection_type': kind,
            'target_quantity': '10.000', 'uom': 'EA', 'warehouse_ref': 'SYNTHETIC-WAREHOUSE',
            'lot_ref': 'SYNTHETIC-LOT', 'work_started_at': timezone.now() - timedelta(minutes=30),
            'quantity_mode': 'not_recorded', 'require_evidence': False,
            'inspection_items': [{'id': 'dimension', 'label': '치수 / 尺寸', 'kind': 'number',
                'unit': 'mm', 'minimum': '9.5', 'maximum': '10.5', 'required': True, 'evidence_required': False}],
        }, session=InspectionSession.from_token(user, token))
        # Presentation fixtures only: not produced by a MES adapter or a live
        # inspection. All identifiers are conspicuously SYNTHETIC.
        changes = {'created_at': timezone.now() - timedelta(minutes=index * 20)}
        if index == 3:
            changes.update(status='failed', judgement='fail')
        if index == 6:
            changes.update(status='approved', sync_status='succeeded', mes_completion_status='completed',
                           mes_checked_at=timezone.now(), judgement='pass',
                           mes_snapshot={'task_status': 2, 'qc_status': 1, 'state_version': 'SYNTHETIC-COMPLETED',
                                         'receipt_allowed': False})
        InspectionRequest.objects.filter(pk=data['id']).update(**changes)
    call_command('runserver', f'127.0.0.1:{preview_port}', use_reloader=False)
else:
    call_command('makemigrations', 'quality', check=True, dry_run=True)
    call_command('check')
    from django.test.runner import DiscoverRunner
    raise SystemExit(DiscoverRunner(verbosity=2).run_tests(sys.argv[1:] or [
        'quality.test_inspection_flow_scenarios',
        'quality.test_inspection_requests', 'quality.test_inspection_mes_stages', 'quality.test_inspection_blacklake_contract',
        'quality.test_inspection_read_snapshot', 'quality.test_inspection_blacklake_snapshot',
        'quality.test_inspection_live_readback', 'quality.test_inspection_board_repository',
        'quality.test_inspection_preflight', 'quality.test_inspection_eligibility_probe',
        'quality.test_inspection_board_status', 'production.test_inspection_status_projection',
        'production.test_inspection_status_view',
        'production.test_mes_execution_contract', 'production.test_mes_delivery_transport',
        'production.test_mes_delivery', 'production.test_mes_delivery_credentials',
        'production.test_mes_delivery_views', 'production.test_mes_delivery_postgres',
        'production.test_mes_delivery_read_contract', 'production.test_mes_read_status',
        'quality.test_inspection_kanban', 'quality.test_inspection_beta_access',
        'quality.test_inspection_transport', 'quality.test_inspection_migration',
        'quality.test_inspection_postgres', 'quality.test_inspection_test_database',
        'quality.test_import_security']))
