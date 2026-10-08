"""Run inspection tests in a new, disposable local PostgreSQL cluster.

Requires an already installed initdb/pg_ctl and the caller's existing Python
environment. No dependency installation, project settings, credentials, TCP
listener, persistent service, production database or MES transport is used.
Use --postgres-bin=/absolute/bin to select existing PostgreSQL tools on CI or
another POSIX host; the default remains /opt/homebrew/bin. Missing tools fail.
Keep output/pg-qc for review after the server has been stopped. A second run
must use a separately reviewed new fixture directory; this script never replaces
an existing cluster.
"""
from getpass import getuser
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POSTGRES_BIN = Path('/opt/homebrew/bin')


def postgres_tools(directory):
    """Accept only an explicit local installation, never discover a server."""
    directory = Path(directory)
    if (not directory.is_absolute() or os.pathsep in str(directory)
            or any(ord(character) < 32 for character in str(directory))):
        raise SystemExit('Use an absolute PostgreSQL binary directory without PATH separators or control characters.')
    directory = directory.resolve()
    if os.pathsep in str(directory) or any(ord(character) < 32 for character in str(directory)):
        raise SystemExit('Resolved PostgreSQL binary directory contains a PATH separator or control character.')
    if not directory.is_dir() or not all(
            (directory / binary).is_file() and os.access(directory / binary, os.X_OK)
            for binary in ('initdb', 'pg_ctl', 'postgres')):
        raise SystemExit('PostgreSQL tools are absent or not executable; do not install automatically.')
    return directory


def fixture_paths(root, name):
    """Validate all fixture paths before creating directories or starting tools."""
    if not re.fullmatch(r'[a-z0-9-]{1,6}', name):
        raise SystemExit('Use a short fixture name; no path or external cluster is accepted.')
    output = root / 'output'
    if output.is_symlink() or output.resolve() != output:
        raise SystemExit('Fixture output must be inside this worktree, without a symlink.')
    if output.exists() and not output.is_dir():
        raise SystemExit('Fixture output must be a directory.')
    fixture = output / name
    if fixture.exists() or fixture.is_symlink():
        raise SystemExit('Fixture already exists; preserve it and do not reuse automatically.')
    socket = fixture / 'socket'
    # Conservative limit valid on both macOS (104) and Linux (108).
    if len(str(socket / '.s.PGSQL.5432').encode()) >= 104:
        raise SystemExit('Socket path exceeds the portable UNIX socket limit.')
    return output, fixture, fixture / 'data', socket


def fixture_environment(binary_directory):
    # Do not inherit PG*, DATABASE_URL, HOME, .env or credential discovery.
    return {'PATH': str(binary_directory) + os.pathsep + os.defpath,
            'LC_ALL': 'C', 'PYTHONDONTWRITEBYTECODE': '1'}


def run(arguments, *, environment, timeout=30):
    print('+', ' '.join(str(argument) for argument in arguments), flush=True)
    return subprocess.run([str(argument) for argument in arguments], cwd=ROOT,
                          env=environment, timeout=timeout, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-name', default='pg-qc',
                        help='New private fixture directory name under output/ (up to six characters).')
    parser.add_argument('--postgres-bin', type=Path, default=DEFAULT_POSTGRES_BIN,
                        help='Absolute directory of already installed initdb, pg_ctl and postgres.')
    arguments = parser.parse_args(argv)
    binary_directory = postgres_tools(arguments.postgres_bin)
    output, fixture, data, socket = fixture_paths(ROOT, arguments.fixture_name)
    environment = fixture_environment(binary_directory)
    output.mkdir(exist_ok=True)
    fixture.mkdir(mode=0o700)
    socket.mkdir(mode=0o700)
    run([binary_directory / 'initdb', '-D', data, '--locale=C', '--encoding=UTF8',
         '--auth-local=trust', '--auth-host=reject', '--username=' + getuser(),
         '--no-instructions'], environment=environment)
    # These settings apply only to the newly created private fixture cluster.
    (data / 'postgresql.auto.conf').write_text(
        "listen_addresses = ''\nport = 5432\n"
        + "unix_socket_directories = '" + str(socket).replace("'", "''") + "'\n"
        + "max_connections = 16\nshared_buffers = '16MB'\n", encoding='utf-8')
    result = 1
    try:
        run([binary_directory / 'pg_ctl', '-D', data, '-l', fixture / 'server.log',
             '-w', '-t', '15', 'start'], environment=environment)
        with (fixture / 'test.log').open('w', encoding='utf-8') as log:
            arguments = [sys.executable, ROOT / 'scripts/check-inspection-requests.py',
                         '--postgres-test-socket=' + str(socket)]
            print('+', ' '.join(str(argument) for argument in arguments), flush=True)
            process = subprocess.run([str(argument) for argument in arguments], cwd=ROOT,
                                     env=environment, timeout=300, stdout=log,
                                     stderr=subprocess.STDOUT)
            result = process.returncode
        print((fixture / 'test.log').read_text(encoding='utf-8'), end='', flush=True)
    finally:
        # Never inspect or stop any other server. A failed stop is a test failure.
        if (data / 'postmaster.pid').exists():
            run([binary_directory / 'pg_ctl', '-D', data, '-m', 'fast', '-w', '-t', '15', 'stop'],
                environment=environment)
    return result


if __name__ == '__main__':
    raise SystemExit(main())
