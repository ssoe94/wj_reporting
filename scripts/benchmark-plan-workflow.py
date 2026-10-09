"""Isolated deterministic workflow GET benchmark / local synthetic UI fixture.

Example: <existing venv>/python scripts/benchmark-plan-workflow.py \
  --source-root=/explicit/old-checkout --sizes=100,5611,12011 --output=output/workflow-performance/before.json
No project .env, ambient DB URL, tokens, deployment settings or MES traffic.
"""
import argparse
from pathlib import Path
import hashlib
import json
import subprocess
import sys
import tempfile
import time
import types
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source-root', type=Path, default=ROOT)
parser.add_argument('--sizes', default='100,5611,12011')
parser.add_argument('--repeat', type=int, default=1)
parser.add_argument('--output', type=Path, default=ROOT / 'output/workflow-performance/benchmark.json')
parser.add_argument('--compare-before', type=Path, help='Require identical full response hashes to this baseline JSON.')
parser.add_argument('--test', action='store_true')
parser.add_argument('--test-label', action='append', choices=[
    'production.test_plan_workflow_performance', 'production.test_plan_workflow_concurrency',
    'production.test_plan_workflow_read_context'], help='Optional narrowly selected isolated test label.')
parser.add_argument('--preview', action='store_true')
parser.add_argument('--port', type=int, default=8031)
parser.add_argument('--postgres-test-socket', type=Path)
args = parser.parse_args()
source = args.source_root.resolve()
if not (source / 'backend/production/plan_workflow.py').is_file():
    parser.error('source-root must be an explicit existing WJ checkout.')
sizes = [int(value) for value in args.sizes.split(',')]
if args.repeat < 1 or any(not 100 <= size <= 25000 for size in sizes):
    parser.error('Use repeat >=1 and synthetic sizes from 100 to 25000.')
if args.preview and not 1024 <= args.port <= 65535:
    parser.error('Use a non-privileged loopback fixture port.')
if args.test_label and not args.test:
    parser.error('test-label requires --test.')
sys.path.insert(0, str(source / 'backend'))
sys.path.insert(0, str(ROOT / 'scripts'))
bundled = Path.home() / '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/lib/python3.12/site-packages'
if bundled.is_dir():
    sys.path.append(str(bundled))
import decouple
decouple.config = decouple.Config(decouple.RepositoryEmpty())
from django.conf import settings
from inspection_test_database import inspection_test_database
temporary = tempfile.TemporaryDirectory(prefix='wj-workflow-performance-')
database_arguments = ['--preview'] if args.preview else []
if args.postgres_test_socket:
    database_arguments.append(f'--postgres-test-socket={args.postgres_test_socket}')
database = inspection_test_database(database_arguments, ROOT,
    sqlite_name=str(Path(temporary.name) / 'fixture.sqlite3'))
if args.postgres_test_socket:
    # The shared helper first validates the real target under ROOT/output/.
    # Preserve only this explicitly supplied, validated short socket alias;
    # expanding its symlink would exceed AF_UNIX path limits on macOS.
    socket_alias = args.postgres_test_socket
    if not socket_alias.is_absolute() or len(str(socket_alias / '.s.PGSQL.5432').encode()) >= 100:
        parser.error('Use a short absolute socket path alias whose real target is this worktree output/.')
    database['HOST'] = str(socket_alias)
settings.configure(
    BASE_DIR=source / 'backend', SECRET_KEY='synthetic-performance-only', DEBUG=args.preview,
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions',
        'rest_framework', 'django_filters', 'injection', 'assembly', 'sales', 'overview',
        'inventory', 'quality', 'production', 'ai_core', 'analytics', 'mes_oauth'],
    DATABASES={'default': database},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True, TIME_ZONE='Asia/Shanghai',
    ROOT_URLCONF='isolated_performance_urls', ALLOWED_HOSTS=['testserver', 'localhost', '127.0.0.1'],
    PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': [], 'UNAUTHENTICATED_USER': None}, MIDDLEWARE=[],
    CLOUDINARY_STORAGE={'CLOUD_NAME': 'synthetic', 'API_KEY': 'synthetic', 'API_SECRET': 'synthetic'},
    MEDIA_ROOT=temporary.name,
)
import django
django.setup()
import production
# The same new fixture/test module works with both old and optimized code. All
# real production modules retain source-root's precedence; no source is copied.
production.__path__.append(str(ROOT / 'backend/production'))
from django.urls import include, path
urls = types.ModuleType(settings.ROOT_URLCONF)
urls.urlpatterns = [path('api/production/', include('production.urls'))]
sys.modules[settings.ROOT_URLCONF] = urls
from django.core.management import call_command
from django.db import connection, transaction
from django.core.serializers.json import DjangoJSONEncoder
from production.workflow_performance_fixture import seed_performance_fixture, measure_workflow_get, workflow_state_digest
source_hashes = {name: hashlib.sha256((source / 'backend/production' / name).read_bytes()).hexdigest()
    for name in ('plan_workflow.py', 'plan_workflow_views.py', 'plan_workflow_read_context.py')
    if (source / 'backend/production' / name).is_file()}

with patch('requests.sessions.Session.request', side_effect=AssertionError('MES network forbidden in performance fixture')):
    if args.test:
        from django.test.runner import DiscoverRunner
        labels = args.test_label or ['production.test_plan_workflow_performance', 'production.test_plan_workflow_concurrency']
        if not args.test_label and (ROOT / 'backend/production/test_plan_workflow_read_context.py').is_file():
            labels.append('production.test_plan_workflow_read_context')
        raise SystemExit(DiscoverRunner(verbosity=2).run_tests(labels))
    call_command('migrate', verbosity=0)
    if args.preview:
        fixture = seed_performance_fixture(total_plans=sizes[-1])
        from rest_framework.authentication import BaseAuthentication
        from production.plan_workflow_views import PlanWorkflowView
        from production.views import ProductionPlanListView
        class SyntheticAuthentication(BaseAuthentication):
            def authenticate(self, request):
                return fixture['user'], None
        PlanWorkflowView.authentication_classes = [SyntheticAuthentication]
        ProductionPlanListView.authentication_classes = [SyntheticAuthentication]
        print(f'SYNTHETIC {sizes[-1]} plans; API at 127.0.0.1:{args.port}; no MES network', flush=True)
        call_command('runserver', f'127.0.0.1:{args.port}', use_reloader=False)
    else:
        results = []
        output = args.output.resolve()
        output.parent.mkdir(parents=True, exist_ok=True)
        for size in sizes:
            with transaction.atomic():
                began = time.perf_counter()
                fixture = seed_performance_fixture(total_plans=size)
                seed_seconds = time.perf_counter() - began
                before = workflow_state_digest()
                for plan_type in ('injection', 'machining'):
                    for attempt in range(args.repeat):
                        measured = measure_workflow_get(fixture, plan_type)
                        data = measured.pop('data')
                        sql = measured.pop('sql')
                        measured.update(total_plans=size, plan_type=plan_type, repeat=attempt + 1,
                            seed_seconds=seed_seconds, fixture_counts=fixture['counts'],
                            rows=len(data['rows']), groups=len(data['preview']),
                            database_state_preserved=workflow_state_digest() == before)
                        response_path = output.with_name(f'{output.stem}-{size}-{plan_type}-{attempt + 1}-response.json')
                        response_path.write_text(json.dumps(data, cls=DjangoJSONEncoder, ensure_ascii=False,
                            sort_keys=True, separators=(',', ':')) + '\n')
                        measured['response_file'] = str(response_path)
                        results.append(measured)
                        print(json.dumps({key: measured[key] for key in ('total_plans', 'plan_type',
                            'query_count', 'elapsed_seconds', 'response_bytes', 'response_sha256', 'database_state_preserved')}) , flush=True)
                        if measured['write_queries'] or not measured['database_state_preserved']:
                            raise AssertionError('Workflow GET mutated the synthetic DB.')
                transaction.set_rollback(True)
        commit = subprocess.run(['git', '-C', str(source), 'rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
        final_hashes = {name: hashlib.sha256((source / 'backend/production' / name).read_bytes()).hexdigest()
            for name in source_hashes}
        comparison = None
        if args.compare_before:
            earlier = json.loads(args.compare_before.read_text())
            expected = {(row['total_plans'], row['plan_type'], row['repeat']): row
                        for row in earlier['measurements']}
            mismatches = [f"{row['total_plans']}:{row['plan_type']}:{row['repeat']}" for row in results
                if (row['total_plans'], row['plan_type'], row['repeat']) not in expected
                or any(row[key] != expected[(row['total_plans'], row['plan_type'], row['repeat'])][key]
                       for key in ('response_sha256', 'response_bytes', 'rows', 'groups'))]
            comparison = {'baseline': str(args.compare_before.resolve()), 'mismatches': mismatches,
                          'full_response_identical': not mismatches}
        output.write_text(json.dumps({'fixture_only': True, 'source_root': str(source), 'source_commit': commit,
            'source_sha256': source_hashes, 'source_changed_during_measurement': final_hashes != source_hashes,
            'comparison': comparison,
            'postgres_fixture_statistics': 'ANALYZE own seeded tables before timing' if connection.vendor == 'postgresql' else None,
            'database_vendor': settings.DATABASES['default']['ENGINE'], 'measurements': results}, indent=2) + '\n')
        print(f'Benchmark saved: {output}', flush=True)
        if final_hashes != source_hashes or (comparison and not comparison['full_response_identical']):
            raise AssertionError('Source changed during benchmark or response differs from the baseline.')
