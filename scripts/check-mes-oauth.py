"""OAuth-only checks with synthetic fixtures, full routes and no project .env.

Default: SQLite in memory. --postgres-test-socket accepts only a fixture created
by check-mes-oauth-postgres-local.py. --make-migrations writes mes_oauth only.
Never use these settings for deployment or live-provider acceptance.
"""
from contextlib import contextmanager, ExitStack
from datetime import timedelta
import os
from pathlib import Path
import socket
import sys
import tempfile
from unittest.mock import patch

from mes_oauth_test_database import mes_oauth_test_database, POSTGRES_SOCKET_OPTION


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_TEST_LABELS = ['mes_oauth', 'account_activation']


@contextmanager
def no_external_network(database):
    """Block Python HTTP/DNS/socket egress, including during Django imports.

    libpq uses C sockets, so it is constrained separately by the explicit UNIX
    fixture database settings and the clean process environment. This is not an
    operating-system network sandbox or evidence of provider connectivity.
    """
    attempts = []
    allowed = None
    if database['ENGINE'] == 'django.db.backends.postgresql':
        allowed = str(Path(database['HOST']) / '.s.PGSQL.5432')
    connect, connect_ex = socket.socket.connect, socket.socket.connect_ex

    def blocked(*args, **kwargs):
        attempts.append(True)
        raise AssertionError('External network is forbidden in isolated OAuth tests.')

    def unix_only(original):
        def guarded(connection, address):
            if (allowed and connection.family == socket.AF_UNIX
                    and isinstance(address, (str, bytes))
                    and os.fsdecode(address) == allowed):
                return original(connection, address)
            return blocked()
        return guarded

    with ExitStack() as stack:
        stack.enter_context(patch.object(socket.socket, 'connect', unix_only(connect)))
        stack.enter_context(patch.object(socket.socket, 'connect_ex', unix_only(connect_ex)))
        for name in ('create_connection', 'getaddrinfo', 'gethostbyname', 'gethostbyname_ex'):
            stack.enter_context(patch.object(socket, name, blocked))
        stack.enter_context(patch.object(socket.socket, 'sendto', blocked))
        stack.enter_context(patch('requests.sessions.Session.request', blocked))
        try:
            yield
        finally:
            if attempts:
                raise AssertionError('An unexpected network attempt was blocked; this run failed.')


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    try:
        database = mes_oauth_test_database(arguments, ROOT)
    except (ValueError, OSError) as error:
        raise SystemExit(str(error))
    arguments = [argument for argument in arguments if not argument.startswith(POSTGRES_SOCKET_OPTION)]
    make_migrations = arguments == ['--make-migrations']
    if not make_migrations and any(argument.startswith('-') for argument in arguments):
        raise SystemExit('Use test labels, one explicit fixture socket, or --make-migrations only.')
    # This modifies only this disposable runner process, never the parent shell.
    os.environ.clear()
    os.environ.update({'PATH': os.defpath, 'LC_ALL': 'C', 'PYTHONDONTWRITEBYTECODE': '1'})
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT / 'backend'))
    with no_external_network(database), tempfile.TemporaryDirectory(prefix='wj-mes-oauth-media-') as media:
        import decouple
        decouple.config = decouple.Config(decouple.RepositoryEmpty())
        from django.conf import settings
        if settings.configured:
            raise SystemExit('Run this fixture in a fresh Python process; existing settings are refused.')
        secret = 'synthetic-isolated-mes-oauth-regression-secret-not-for-deployment'
        settings.configure(
            SECRET_KEY=secret, DEBUG=False,
            INSTALLED_APPS=[
                'django.contrib.admin', 'django.contrib.auth', 'django.contrib.contenttypes',
                'django.contrib.sessions', 'django.contrib.messages', 'django.contrib.staticfiles',
                'rest_framework', 'rest_framework_simplejwt', 'rest_framework_simplejwt.token_blacklist',
                'corsheaders', 'django_filters', 'injection', 'assembly', 'sales', 'overview',
                'inventory', 'quality', 'production', 'ai_core', 'analytics', 'mes_oauth', 'account_activation',
            ],
            DATABASES={'default': database}, ROOT_URLCONF='config.urls',
            DEFAULT_AUTO_FIELD='django.db.models.BigAutoField', USE_TZ=True, TIME_ZONE='Asia/Shanghai',
            ALLOWED_HOSTS=['testserver', 'localhost', '127.0.0.1'],
            PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],
            MIDDLEWARE=[
                'account_activation.security.ActivationBoundaryMiddleware',
                'mes_oauth.security.OAuthQueryRedactionMiddleware',
                'corsheaders.middleware.CorsMiddleware', 'django.middleware.security.SecurityMiddleware',
                'django.contrib.sessions.middleware.SessionMiddleware',
                'django.middleware.common.CommonMiddleware', 'config.middleware.DisableCSRFMiddleware',
                'django.middleware.csrf.CsrfViewMiddleware',
                'django.contrib.auth.middleware.AuthenticationMiddleware',
                'mes_oauth.connection_views.BridgeRestrictionMiddleware',
                'django.contrib.messages.middleware.MessageMiddleware',
                'django.middleware.clickjacking.XFrameOptionsMiddleware',
                'config.middleware.NoCacheAPIMiddleware', 'config.middleware.APINotFoundMiddleware',
            ],
            TEMPLATES=[{'BACKEND': 'django.template.backends.django.DjangoTemplates',
                        'DIRS': [], 'APP_DIRS': True, 'OPTIONS': {'context_processors': [
                            'django.template.context_processors.request',
                            'django.contrib.auth.context_processors.auth',
                            'django.contrib.messages.context_processors.messages',
                        ]}}],
            REST_FRAMEWORK={
                'DEFAULT_FILTER_BACKENDS': ['django_filters.rest_framework.DjangoFilterBackend',
                                           'rest_framework.filters.SearchFilter',
                                           'rest_framework.filters.OrderingFilter'],
                'DEFAULT_AUTHENTICATION_CLASSES': ['config.authentication.ScopedJWTAuthentication'],
                'DEFAULT_PERMISSION_CLASSES': ['rest_framework.permissions.IsAuthenticated'],
                'DEFAULT_PAGINATION_CLASS': 'rest_framework.pagination.PageNumberPagination',
                'PAGE_SIZE': 100, 'DEFAULT_RENDERER_CLASSES': ['rest_framework.renderers.JSONRenderer'],
                'EXCEPTION_HANDLER': 'config.exceptions.custom_exception_handler',
            },
            SIMPLE_JWT={
                'ACCESS_TOKEN_LIFETIME': timedelta(minutes=30), 'REFRESH_TOKEN_LIFETIME': timedelta(days=7),
                'ROTATE_REFRESH_TOKENS': True, 'BLACKLIST_AFTER_ROTATION': True,
                'AUTH_HEADER_TYPES': ('Bearer',), 'ALGORITHM': 'HS256', 'SIGNING_KEY': secret,
                'VERIFYING_KEY': None, 'LEEWAY': 30,
            },
            SESSION_ENGINE='django.contrib.sessions.backends.db', SESSION_COOKIE_SECURE=True,
            SESSION_COOKIE_HTTPONLY=True, SESSION_COOKIE_SAMESITE='Lax', SESSION_COOKIE_DOMAIN=None,
            CSRF_COOKIE_SECURE=True, CSRF_TRUSTED_ORIGINS=['https://testserver'],
            STATIC_URL='/static/', MEDIA_URL='/media/', MEDIA_ROOT=media,
            STORAGES={'default': {'BACKEND': 'django.core.files.storage.FileSystemStorage'},
                      'staticfiles': {'BACKEND': 'django.contrib.staticfiles.storage.StaticFilesStorage'}},
            EMAIL_BACKEND='django.core.mail.backends.locmem.EmailBackend',
            CACHES={'default': {'BACKEND': 'django.core.cache.backends.locmem.LocMemCache'}},
            CLOUDINARY_STORAGE={'CLOUD_NAME': 'synthetic-test', 'API_KEY': 'synthetic-test',
                                'API_SECRET': 'synthetic-test'},
            MES_USER_OAUTH_ENABLED=False,
        )
        import django
        django.setup()
        from django.core.management import call_command
        if make_migrations:
            call_command('makemigrations', 'mes_oauth')
            return 0
        call_command('makemigrations', 'mes_oauth', check=True, dry_run=True)
        call_command('makemigrations', 'account_activation', check=True, dry_run=True)
        call_command('check')
        from django.test.runner import DiscoverRunner
        return DiscoverRunner(verbosity=2, interactive=False).run_tests(arguments or DEFAULT_TEST_LABELS)


if __name__ == '__main__':
    raise SystemExit(main())
