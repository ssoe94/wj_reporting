"""Run AI backend contracts with disposable SQLite and no project .env/settings."""
from pathlib import Path
import sys
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from django.conf import settings
settings.configure(
    SECRET_KEY='isolated-ai-contract-checks',
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes', 'django.contrib.sessions',
        'rest_framework', 'django_filters', 'injection', 'assembly', 'sales', 'overview',
        'inventory', 'quality', 'production', 'ai_core', 'analytics'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True, TIME_ZONE='Asia/Shanghai',
    ROOT_URLCONF='isolated_ai_urls', ALLOWED_HOSTS=['testserver', 'localhost', '127.0.0.1'],
    PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
    REST_FRAMEWORK={'DEFAULT_PAGINATION_CLASS':'rest_framework.pagination.PageNumberPagination', 'PAGE_SIZE':25,
                    'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                    'DEFAULT_AUTHENTICATION_CLASSES': ['rest_framework.authentication.SessionAuthentication']},
    CLOUDINARY_STORAGE={'CLOUD_NAME':'test', 'API_KEY':'test', 'API_SECRET':'test'},
    MIDDLEWARE=[], MEDIA_ROOT='/private/tmp/wj-ai-contract-media',
)
import django
django.setup()
from django.urls import include, path
urls = types.ModuleType('isolated_ai_urls')
urls.urlpatterns = [
    path('api/ai/', include('ai_core.urls')),
    path('api/production/', include('production.urls')),
    path('api/quality/', include('quality.urls')),
    path('api/injection/', include('injection.urls')),
]
sys.modules[urls.__name__] = urls
from django.test.runner import DiscoverRunner
raise SystemExit(DiscoverRunner(verbosity=1).run_tests(sys.argv[1:] or ['ai_core.test_deep_analysis', 'ai_core.tests']))
