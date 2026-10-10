"""Focused quality translation contracts: disposable SQLite, no project settings."""
from pathlib import Path
import sys
import types

database = {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}
if '--postgres-socket' in sys.argv:
    index = sys.argv.index('--postgres-socket')
    socket = Path(sys.argv[index + 1]).resolve()
    if socket.parent != Path('/private/tmp') or not socket.name.startswith('wj-translation-postgres.') or not (socket / 'PG_VERSION').is_file():
        raise SystemExit('Use only an owned disposable /private/tmp/wj-translation-postgres.* cluster.')
    database = {'ENGINE': 'django.db.backends.postgresql', 'NAME': 'wj_translation_test',
                'HOST': str(socket), 'PORT': '54137'}
    del sys.argv[index:index + 2]

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from django.conf import settings
settings.configure(
    SECRET_KEY='isolated-quality-translation-checks',
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions',
                    'rest_framework', 'django_filters', 'injection', 'assembly', 'sales', 'overview',
                    'inventory', 'quality', 'production', 'ai_core', 'analytics'],
    DATABASES={'default': database},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True, TIME_ZONE='Asia/Shanghai',
    ROOT_URLCONF='isolated_translation_urls', ALLOWED_HOSTS=['testserver', 'localhost', '127.0.0.1'],
    PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
    REST_FRAMEWORK={'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination', 'PAGE_SIZE': 25,
                    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                    'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.SessionAuthentication']},
    CLOUDINARY_STORAGE={'CLOUD_NAME': 'test', 'API_KEY': 'test', 'API_SECRET': 'test'},
    MIDDLEWARE=[], MEDIA_ROOT='/private/tmp/wj-translation-test-media',
)
import django
django.setup()
from django.urls import include, path
from rest_framework.routers import DefaultRouter
from quality.views import DailyQualityAttentionView, QualityReportViewSet
router = DefaultRouter()
router.register('reports', QualityReportViewSet, basename='quality-report')
urls = types.ModuleType('isolated_translation_urls')
urls.urlpatterns = [path('api/quality/', include(router.urls)),
                    path('api/quality/daily-attention/', DailyQualityAttentionView.as_view()),
                    path('api/ai/', include('ai_core.urls'))]
sys.modules[urls.__name__] = urls
if '--makemigrations' in sys.argv:
    from django.core.management import call_command
    call_command('makemigrations', 'quality', 'ai_core')
elif '--check-migrations' in sys.argv:
    from django.core.management import call_command
    call_command('makemigrations', 'quality', 'ai_core', check=True, dry_run=True)
else:
    from django.test.runner import DiscoverRunner
    raise SystemExit(DiscoverRunner(verbosity=1).run_tests(sys.argv[1:] or ['quality.test_action_result_translation']))
