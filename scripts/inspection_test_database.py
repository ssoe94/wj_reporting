"""Explicit local fixture DB selection; never reads project/env credentials."""
from getpass import getuser
from os import environ
from pathlib import Path


POSTGRES_SOCKET_OPTION = '--postgres-test-socket='


def inspection_test_database(arguments, root, *, sqlite_name=':memory:'):
    options = [argument for argument in arguments if argument.startswith(POSTGRES_SOCKET_OPTION)]
    if not options:
        return {'ENGINE': 'django.db.backends.sqlite3', 'NAME': sqlite_name}
    if len(options) != 1 or '--preview' in arguments or '--make-migrations' in arguments:
        raise ValueError('Use one PostgreSQL fixture socket only for tests.')
    # An explicit empty service name is invalid in libpq. Refuse service-file
    # discovery instead of forwarding or reading an ambient service name.
    if any(name in environ for name in ('PGSERVICE', 'PGSERVICEFILE')):
        raise ValueError('Run the fixture without PostgreSQL service environment variables.')
    socket_dir = Path(options[0].split('=', 1)[1])
    output = (Path(root) / 'output').resolve()
    if (not socket_dir.is_absolute() or not socket_dir.is_dir()
            or not socket_dir.resolve().is_relative_to(output) or socket_dir.resolve() == output):
        raise ValueError('Use an existing approved disposable PostgreSQL socket directory under this worktree output/.')
    # This does not start a server, create a role, read .pgpass, accept a URL,
    # discover production settings or load credentials. The caller must supply
    # an already approved local test cluster with the existing OS user role.
    return {'ENGINE': 'django.db.backends.postgresql', 'NAME': 'postgres',
            'HOST': str(socket_dir.resolve()), 'PORT': '5432', 'USER': getuser(), 'PASSWORD': '',
            'OPTIONS': {'connect_timeout': 3, 'passfile': '/dev/null'},
            'TEST': {'NAME': 'test_wj_inspection_fixture'}}
