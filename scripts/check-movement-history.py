"""Run history API contracts with disposable SQLite; no project .env or MES."""
from pathlib import Path
import sys
import types

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from django.conf import settings

settings.configure(
    SECRET_KEY='isolated-movement-history-checks',
    INSTALLED_APPS=['django.contrib.auth', 'django.contrib.contenttypes',
                    'rest_framework', 'inventory'],
    DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}},
    DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True,
    TIME_ZONE='Asia/Shanghai', ROOT_URLCONF='movement_history_test_urls',
    ALLOWED_HOSTS=['testserver'], MIDDLEWARE=[],
    REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES': [
        'rest_framework.authentication.BasicAuthentication']},
)
import django
django.setup()
from django.urls import path
from inventory.movement_history import finished_goods_history, finished_goods_history_detail

urls = types.ModuleType('movement_history_test_urls')
urls.urlpatterns = [path('api/inventory/finished-goods/history/', finished_goods_history),
    path('api/inventory/finished-goods/history/<int:group_id>/', finished_goods_history_detail)]
sys.modules[urls.__name__] = urls
from django.test.runner import DiscoverRunner

if '--makemigrations' in sys.argv:
    from django.core.management import call_command
    call_command('makemigrations', 'inventory', name='movement_history')
    raise SystemExit(0)

raise SystemExit(DiscoverRunner(verbosity=2).run_tests(['inventory.tests.test_movement_history']))
