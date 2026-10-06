"""Explicit disposable database selection; never load settings or credentials."""
from getpass import getuser
from os import environ
from pathlib import Path
import re


POSTGRES_SOCKET_OPTION = '--postgres-test-socket='
FIXTURE_MARKER = '.mes-oauth-test-fixture'
FIXTURE_MARKER_CONTENT = 'Disposable mes_oauth tests only; never a production cluster.\n'


def mes_oauth_test_database(arguments, root):
    options = [argument for argument in arguments if argument.startswith(POSTGRES_SOCKET_OPTION)]
    if not options:
        return {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}
    if len(options) != 1 or '--make-migrations' in arguments:
        raise ValueError('Use one PostgreSQL fixture socket only for tests.')
    if any(name in environ for name in ('PGSERVICE', 'PGSERVICEFILE')):
        raise ValueError('Run the fixture without PostgreSQL service environment variables.')
    root = Path(root).resolve()
    output = root / 'output'
    socket = Path(options[0].split('=', 1)[1])
    marker = socket.parent / FIXTURE_MARKER
    # Only the fresh-cluster wrapper may supply this exact private layout.
    # Refuse symlinks, URLs, arbitrary sockets and the worktree's output root.
    if (output.is_symlink() or output.resolve() != output
            or not socket.is_absolute() or not socket.is_dir()
            or socket.resolve() != socket or socket.name != 'socket'
            or socket.parent.parent != output
            or not re.fullmatch(r'[a-z0-9-]{1,6}', socket.parent.name)
            or len(str(socket / '.s.PGSQL.5432').encode()) >= 104
            or marker.is_symlink() or not marker.is_file()
            or marker.stat().st_size != len(FIXTURE_MARKER_CONTENT)
            or marker.read_text(encoding='utf-8') != FIXTURE_MARKER_CONTENT):
        raise ValueError('Use the new private PostgreSQL fixture created by check-mes-oauth-postgres-local.py.')
    return {
        'ENGINE': 'django.db.backends.postgresql', 'NAME': 'postgres',
        'HOST': str(socket), 'PORT': '5432', 'USER': getuser(), 'PASSWORD': '',
        'OPTIONS': {'connect_timeout': 3, 'passfile': '/dev/null'},
        'TEST': {'NAME': 'test_wj_mes_oauth_fixture'},
    }
