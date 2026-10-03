"""Runner safety tests. All subprocess calls are mocked; no server is started."""
from contextlib import redirect_stdout
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))
from mes_oauth_test_database import (
    FIXTURE_MARKER, FIXTURE_MARKER_CONTENT, mes_oauth_test_database,
)


def load_runner(filename, module_name):
    spec = importlib.util.spec_from_file_location(module_name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


runner = load_runner('check-mes-oauth-postgres-local.py', 'mes_oauth_pg_fixture_runner')


class FixtureSafetyTests(unittest.TestCase):
    def setUp(self):
        # macOS's default per-user temp root can exceed UNIX socket limits.
        self.temporary = tempfile.TemporaryDirectory(prefix='oa-', dir='/tmp')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.binary = self.root / 'bin'
        self.binary.mkdir()
        for name in ('initdb', 'pg_ctl', 'postgres'):
            path = self.binary / name
            path.write_text('SYNTHETIC; NEVER EXECUTED\n', encoding='utf-8')
            path.chmod(0o700)

    def make_socket(self):
        socket = self.root / 'output' / 'pg-oa' / 'socket'
        socket.mkdir(parents=True)
        (socket.parent / FIXTURE_MARKER).write_text(FIXTURE_MARKER_CONTENT, encoding='utf-8')
        return socket

    def database(self, socket, *extra):
        return mes_oauth_test_database(['--postgres-test-socket=' + str(socket), *extra], self.root)

    def test_explicit_existing_tools_and_installation_symlink_are_allowed(self):
        self.assertEqual(runner.postgres_tools(self.binary), self.binary)
        alias = self.root / 'alias'
        alias.symlink_to(self.binary, target_is_directory=True)
        self.assertEqual(runner.postgres_tools(alias), self.binary)

    def test_tools_reject_relative_url_control_and_path_separator(self):
        for value in ('bin', 'postgres://host', '/tmp/bin:other', '/tmp/bin\nother'):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                runner.postgres_tools(value)

    def test_resolved_tool_path_cannot_hide_path_separator(self):
        invalid = self.root / 'bin:other'
        self.binary.rename(invalid)
        alias = self.root / 'alias'
        alias.symlink_to(invalid, target_is_directory=True)
        with self.assertRaises(SystemExit):
            runner.postgres_tools(alias)

    def test_missing_or_nonexecutable_tools_fail_before_subprocess_or_fixture(self):
        (self.binary / 'postgres').chmod(0o600)
        with patch.object(runner, 'ROOT', self.root), patch.object(runner.subprocess, 'run') as run:
            with self.assertRaises(SystemExit):
                runner.main(['--postgres-bin=' + str(self.binary)])
            run.assert_not_called()
        self.assertFalse((self.root / 'output').exists())

    def test_fixture_rejects_path_traversal_and_long_names(self):
        for value in ('../out', '/tmp/a', 'too-long', '', 'PG-OA'):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                runner.fixture_paths(self.root, value)
        self.assertFalse((self.root / 'output').exists())

    def test_existing_fixture_and_symlink_are_preserved(self):
        output = self.root / 'output'
        output.mkdir()
        fixture = output / 'pg-oa'
        fixture.mkdir()
        evidence = fixture / 'evidence'
        evidence.write_text('preserve', encoding='utf-8')
        with self.assertRaises(SystemExit):
            runner.fixture_paths(self.root, 'pg-oa')
        self.assertEqual(evidence.read_text(encoding='utf-8'), 'preserve')
        (output / 'alias').symlink_to(fixture, target_is_directory=True)
        with self.assertRaises(SystemExit):
            runner.fixture_paths(self.root, 'alias')

    def test_output_symlink_and_overlong_socket_fail_without_creation(self):
        (self.root / 'output').symlink_to(self.binary, target_is_directory=True)
        with self.assertRaises(SystemExit):
            runner.fixture_paths(self.root, 'pg-oa')
        long_root = self.root / ('x' * 100)
        with self.assertRaises(SystemExit):
            runner.fixture_paths(long_root, 'pg-oa')
        self.assertFalse(long_root.exists())

    def test_environment_discards_ambient_credentials_and_discovery(self):
        with patch.dict(os.environ, {'PGHOST': 'forbidden.invalid', 'PGSERVICE': 'forbidden',
                                    'DATABASE_URL': 'forbidden', 'HOME': '/forbidden',
                                    'HTTP_PROXY': 'forbidden', 'PYTHONPATH': '/forbidden'}):
            environment = runner.fixture_environment(self.binary)
        self.assertEqual(set(environment), {'PATH', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE'})
        self.assertEqual(environment['PATH'], str(self.binary) + os.pathsep + os.defpath)

    def test_private_log_open_refuses_existing_files_and_symlinks(self):
        original = self.root / 'original'
        original.write_text('preserve', encoding='utf-8')
        link = self.root / 'link'
        link.symlink_to(original)
        for path in (original, link):
            with self.subTest(path=path), self.assertRaises(OSError):
                with runner.private_text(path):
                    self.fail('Existing evidence was opened.')
        with self.assertRaises(OSError):
            with runner.private_text(link, exclusive=False):
                self.fail('Symlink was followed.')
        self.assertEqual(original.read_text(encoding='utf-8'), 'preserve')

    def test_database_defaults_only_to_memory(self):
        with patch.dict(os.environ, {'DATABASE_URL': 'forbidden', 'PGHOST': 'forbidden'}):
            self.assertEqual(mes_oauth_test_database([], self.root),
                             {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'})

    def test_database_requires_fixture_marker_and_exact_private_layout(self):
        socket = self.make_socket()
        with patch.dict(os.environ, {}, clear=True):
            database = self.database(socket)
            self.assertEqual(database['HOST'], str(socket))
            self.assertEqual(database['PASSWORD'], '')
            self.assertEqual(database['OPTIONS'], {'connect_timeout': 3, 'passfile': '/dev/null'})
            self.assertEqual(database['TEST']['NAME'], 'test_wj_mes_oauth_fixture')
            (socket.parent / FIXTURE_MARKER).unlink()
            with self.assertRaises(ValueError):
                self.database(socket)

    def test_database_refuses_external_symlink_duplicate_and_migration_sockets(self):
        socket = self.make_socket()
        alias = socket.parent / 'alias'
        alias.symlink_to(socket, target_is_directory=True)
        with patch.dict(os.environ, {}, clear=True):
            for value in (self.binary, alias, 'postgres://host', socket.parent.parent):
                with self.subTest(value=value), self.assertRaises(ValueError):
                    self.database(value)
            with self.assertRaises(ValueError):
                self.database(socket, '--make-migrations')
            with self.assertRaises(ValueError):
                self.database(socket, '--postgres-test-socket=' + str(socket))

    def test_database_refuses_service_file_discovery(self):
        socket = self.make_socket()
        for name in ('PGSERVICE', 'PGSERVICEFILE'):
            with patch.dict(os.environ, {name: 'never-read'}, clear=True), self.assertRaises(ValueError):
                self.database(socket)


class FixtureLifecycleTests(unittest.TestCase):
    # Reuse temporary private paths, not the safety test methods themselves.
    setUp = FixtureSafetyTests.setUp

    def simulate(self, *, test_status=0, failure=None, start_pid=True):
        calls = []
        data = self.root / 'output' / 'pg-oa' / 'data'

        def fake_run(command, **kwargs):
            calls.append((command, kwargs))
            executable = Path(command[0]).name
            if executable == 'initdb':
                data.mkdir()
                (data / 'postgresql.auto.conf').write_text('', encoding='utf-8')
            elif executable == 'pg_ctl' and command[-1] == 'start':
                if start_pid:
                    (data / 'postmaster.pid').write_text('SYNTHETIC', encoding='utf-8')
                if failure == 'start':
                    raise subprocess.CalledProcessError(1, command)
            elif executable == 'pg_ctl' and command[-1] == 'stop':
                if failure == 'stop':
                    raise subprocess.CalledProcessError(1, command)
                (data / 'postmaster.pid').unlink()
            else:
                self.assertEqual(Path(command[1]), self.root / 'scripts/check-mes-oauth.py')
                self.assertEqual(command[2], '--postgres-test-socket=' + str(data.parent / 'socket'))
                if failure == 'timeout':
                    raise subprocess.TimeoutExpired(command, 300)
                kwargs['stdout'].write('SYNTHETIC TEST RESULT\n')
                return subprocess.CompletedProcess(command, test_status)
            return subprocess.CompletedProcess(command, 0)

        with patch.object(runner, 'ROOT', self.root), patch.object(runner.subprocess, 'run', side_effect=fake_run), redirect_stdout(io.StringIO()):
            try:
                result = runner.main(['--postgres-bin=' + str(self.binary), '--fixture-name=pg-oa'])
            except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
                result = error
        for command, kwargs in calls:
            self.assertEqual(kwargs['cwd'], self.root)
            self.assertEqual(set(kwargs['env']), {'PATH', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE'})
            self.assertLessEqual(kwargs['timeout'], 300)
            if Path(command[0]).name in ('initdb', 'pg_ctl'):
                self.assertEqual(command[command.index('-D') + 1], str(data))
        stops = [command for command, _ in calls if command[-1] == 'stop']
        return result, stops, data

    def test_success_stops_only_the_owned_cluster_and_keeps_evidence(self):
        result, stops, data = self.simulate()
        self.assertEqual(result, 0)
        self.assertEqual(len(stops), 1)
        self.assertFalse((data / 'postmaster.pid').exists())
        self.assertIn("listen_addresses = ''", (data / 'postgresql.auto.conf').read_text())
        self.assertEqual((data.parent / 'test.log').read_text(), 'SYNTHETIC TEST RESULT\n')

    def test_failed_tests_preserve_failure_status_and_stop(self):
        result, stops, _ = self.simulate(test_status=3)
        self.assertEqual(result, 3)
        self.assertEqual(len(stops), 1)

    def test_test_timeout_stops_owned_cluster_and_remains_failure(self):
        result, stops, _ = self.simulate(failure='timeout')
        self.assertIsInstance(result, subprocess.TimeoutExpired)
        self.assertEqual(len(stops), 1)

    def test_partial_start_failure_stops_only_when_own_pid_exists(self):
        result, stops, _ = self.simulate(failure='start')
        self.assertIsInstance(result, subprocess.CalledProcessError)
        self.assertEqual(len(stops), 1)

    def test_start_failure_without_pid_does_not_stop_any_server(self):
        result, stops, _ = self.simulate(failure='start', start_pid=False)
        self.assertIsInstance(result, subprocess.CalledProcessError)
        self.assertEqual(stops, [])

    def test_stop_failure_cannot_be_reported_as_success(self):
        result, stops, _ = self.simulate(failure='stop')
        self.assertIsInstance(result, subprocess.CalledProcessError)
        self.assertEqual(len(stops), 1)


if __name__ == '__main__':
    unittest.main(verbosity=2)
