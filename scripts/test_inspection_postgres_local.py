"""Stdlib-only safety tests; never execute PostgreSQL or discover external DBs."""
import importlib.util
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location(
    'inspection_postgres_local', ROOT / 'scripts' / 'check-inspection-postgres-local.py')
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class PostgresFixtureSafetyTests(unittest.TestCase):
    def setUp(self):
        output = ROOT / 'output'
        output.mkdir(exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(prefix='pg-tools-', dir=output)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def tools(self):
        directory = self.root / 'installed'
        directory.mkdir()
        for name in ('initdb', 'pg_ctl', 'postgres'):
            binary = directory / name
            # Metadata-only fixtures. No executable is invoked by these tests.
            binary.write_text('synthetic tool fixture\n', encoding='utf-8')
            binary.chmod(0o700)
        return directory

    def test_relative_url_and_path_injection_directories_are_rejected(self):
        for value in ('bin', 'postgresql://remote.example.invalid/database',
                      '/tmp/bin:/another/bin', '/tmp/bin\nother'):
            with self.subTest(value=value), self.assertRaises(SystemExit):
                runner.postgres_tools(value)

    def test_missing_or_nonexecutable_tools_fail_before_any_subprocess_or_output(self):
        tools = self.tools()
        (tools / 'postgres').chmod(0o600)
        with self.assertRaises(SystemExit):
            runner.postgres_tools(tools)
        with patch.object(runner, 'ROOT', self.root), patch.object(runner.subprocess, 'run') as process:
            with self.assertRaises(SystemExit):
                runner.main(['--postgres-bin=' + str(self.root / 'absent')])
            process.assert_not_called()
            self.assertFalse((self.root / 'output').exists())

    def test_explicit_existing_tools_and_installation_symlink_are_accepted(self):
        tools = self.tools()
        link = self.root / 'selected'
        link.symlink_to(tools, target_is_directory=True)
        with patch.object(runner.subprocess, 'run') as process:
            self.assertEqual(runner.postgres_tools(link), tools.resolve())
            process.assert_not_called()

    def test_installation_symlink_cannot_hide_a_path_separator(self):
        tools = self.tools()
        unsafe = self.root / 'bin:unexpected'
        tools.rename(unsafe)
        link = self.root / 'selected'
        link.symlink_to(unsafe, target_is_directory=True)
        with self.assertRaises(SystemExit):
            runner.postgres_tools(link)

    def test_fixture_name_cannot_select_an_external_path(self):
        for name in ('', '../db', '/tmp/x', 'long-name', 'a/b', 'A', 'db\n'):
            with self.subTest(name=name), self.assertRaises(SystemExit):
                runner.fixture_paths(self.root, name)

    def test_existing_fixture_and_symlink_are_never_reused(self):
        output = self.root / 'output'
        output.mkdir()
        fixture = output / 'pg-ci'
        fixture.mkdir()
        marker = fixture / 'preserve'
        marker.write_text('existing fixture', encoding='utf-8')
        with self.assertRaises(SystemExit):
            runner.fixture_paths(self.root, 'pg-ci')
        self.assertEqual(marker.read_text(encoding='utf-8'), 'existing fixture')
        (output / 'link').symlink_to(self.root / 'absent', target_is_directory=True)
        with self.assertRaises(SystemExit):
            runner.fixture_paths(self.root, 'link')

    def test_output_symlink_is_rejected_without_touching_target(self):
        destination = self.root / 'outside'
        destination.mkdir()
        (self.root / 'output').symlink_to(destination, target_is_directory=True)
        with self.assertRaises(SystemExit):
            runner.fixture_paths(self.root, 'pg-ci')
        self.assertEqual(list(destination.iterdir()), [])

    def test_socket_length_fails_before_creating_output(self):
        root = self.root / ('x' * 110)
        with self.assertRaisesRegex(SystemExit, 'socket limit'):
            runner.fixture_paths(root, 'pg-ci')
        self.assertFalse(root.exists())

    def test_private_path_plan_stays_inside_root(self):
        root = Path('/synthetic-inspection-worktree')
        output, fixture, data, socket = runner.fixture_paths(root, 'pg-ci')
        self.assertEqual(output, root / 'output')
        self.assertEqual(fixture.parent, output)
        self.assertEqual(data.parent, fixture)
        self.assertEqual(socket.parent, fixture)

    def test_child_environment_excludes_ambient_credentials_and_server_selection(self):
        with patch.dict(os.environ, {
            'DATABASE_URL': 'postgresql://synthetic.invalid/not-used',
            'PGHOST': 'synthetic.invalid', 'PGPASSFILE': '/not/read',
            'PGSERVICE': 'not-used', 'PGSERVICEFILE': '/not/read',
            'PYTHONPATH': '/not/loaded', 'MES_ACCESS_TOKEN': 'synthetic-not-read',
        }):
            environment = runner.fixture_environment(Path('/selected/bin'))
        self.assertEqual(set(environment), {'PATH', 'LC_ALL', 'PYTHONDONTWRITEBYTECODE'})
        self.assertEqual(environment['PATH'], '/selected/bin' + os.pathsep + os.defpath)
        self.assertEqual(environment['LC_ALL'], 'C')


if __name__ == '__main__':
    unittest.main(verbosity=2)
