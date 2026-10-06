"""Run OAuth regression checks in one new disposable PostgreSQL cluster.

Uses existing tools and Python only. No .env, credentials, TCP listener or
existing service is used. Keep output/<fixture-name> for evidence after stopping
this fixture. An existing directory is always refused, never replaced.
"""
from getpass import getuser
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

from mes_oauth_test_database import FIXTURE_MARKER, FIXTURE_MARKER_CONTENT


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POSTGRES_BIN = Path('/opt/homebrew/bin')


def postgres_tools(directory):
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
    if len(str(socket / '.s.PGSQL.5432').encode()) >= 104:
        raise SystemExit('Socket path exceeds the portable UNIX socket limit.')
    return output, fixture, fixture / 'data', socket


def fixture_environment(binary_directory):
    return {'PATH': str(binary_directory) + os.pathsep + os.defpath,
            'LC_ALL': 'C', 'PYTHONDONTWRITEBYTECODE': '1'}


def private_text(path, *, exclusive=True):
    """No symlink following or accidental replacement of review evidence."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW
    flags |= os.O_EXCL if exclusive else os.O_TRUNC
    return os.fdopen(os.open(path, flags, 0o600), 'w', encoding='utf-8')


def run(arguments, *, environment, timeout=30):
    print('+', ' '.join(str(argument) for argument in arguments), flush=True)
    return subprocess.run([str(argument) for argument in arguments], cwd=ROOT,
                          env=environment, timeout=timeout, check=True)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--fixture-name', default='pg-oa',
                        help='New private output/ fixture name (up to six characters).')
    parser.add_argument('--postgres-bin', type=Path, default=DEFAULT_POSTGRES_BIN,
                        help='Absolute directory of already installed initdb, pg_ctl and postgres.')
    parser.add_argument('test_labels', nargs='*', help='Optional bounded Django test labels.')
    arguments = parser.parse_args(argv)
    if any(not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_.]*', label) for label in arguments.test_labels):
        raise SystemExit('Use Django test labels, not paths or runner options.')
    binary_directory = postgres_tools(arguments.postgres_bin)
    output, fixture, data, socket = fixture_paths(ROOT, arguments.fixture_name)
    environment = fixture_environment(binary_directory)
    output.mkdir(exist_ok=True)
    fixture.mkdir(mode=0o700)
    socket.mkdir(mode=0o700)
    with private_text(fixture / FIXTURE_MARKER) as marker:
        marker.write(FIXTURE_MARKER_CONTENT)
    run([binary_directory / 'initdb', '-D', data, '--locale=C', '--encoding=UTF8',
         '--auth-local=trust', '--auth-host=reject', '--username=' + getuser(),
         '--no-instructions'], environment=environment)
    with private_text(data / 'postgresql.auto.conf', exclusive=False) as configuration:
        configuration.write(
            "listen_addresses = ''\nport = 5432\n"
            + "unix_socket_directories = '" + str(socket).replace("'", "''") + "'\n"
            + "max_connections = 16\nshared_buffers = '16MB'\n")
    result = 1
    try:
        # Reserve private log files before a subprocess opens them.
        with private_text(fixture / 'server.log'):
            pass
        run([binary_directory / 'pg_ctl', '-D', data, '-l', fixture / 'server.log',
             '-w', '-t', '15', 'start'], environment=environment)
        with private_text(fixture / 'test.log') as log:
            command = [sys.executable, ROOT / 'scripts/check-mes-oauth.py',
                       '--postgres-test-socket=' + str(socket), *arguments.test_labels]
            print('+', ' '.join(str(argument) for argument in command), flush=True)
            process = subprocess.run([str(argument) for argument in command], cwd=ROOT,
                                     env=environment, timeout=300, stdout=log,
                                     stderr=subprocess.STDOUT)
            result = process.returncode
        print((fixture / 'test.log').read_text(encoding='utf-8'), end='', flush=True)
    finally:
        # Only the new fixture above is considered. Stop failure remains failure.
        if (data / 'postmaster.pid').exists():
            run([binary_directory / 'pg_ctl', '-D', data, '-m', 'fast', '-w', '-t', '15', 'stop'],
                environment=environment)
    return result


if __name__ == '__main__':
    raise SystemExit(main())
