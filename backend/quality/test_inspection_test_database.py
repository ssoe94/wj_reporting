"""Prevent the test harness from discovering or selecting a live DB."""
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch
from importlib.util import module_from_spec, spec_from_file_location

from django.test import SimpleTestCase

ROOT = Path(__file__).resolve().parents[2]
spec = spec_from_file_location('inspection_fixture_database', ROOT / 'scripts' / 'inspection_test_database.py')
fixture_database = module_from_spec(spec)
spec.loader.exec_module(fixture_database)
inspection_test_database = fixture_database.inspection_test_database


class InspectionTestDatabaseBoundaryTests(SimpleTestCase):
    def setUp(self):
        workspace = TemporaryDirectory(prefix='inspection-settings-workspace-')
        self.addCleanup(workspace.cleanup)
        self.root = Path(workspace.name)
        (self.root / 'output').mkdir()

    def test_default_ignores_external_database_environment_and_stays_sqlite(self):
        with patch.dict('os.environ', {'PGHOST': 'external.example.invalid', 'DATABASE_URL': 'postgresql://external.example.invalid/live'}):
            self.assertEqual(inspection_test_database([], self.root),
                             {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'})

    def test_network_url_relative_external_or_missing_socket_cannot_select_postgres(self):
        for value in ['postgresql://example.invalid/live', 'output/socket', '/tmp', str(self.root / 'output' / 'absent-synthetic-socket')]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                inspection_test_database(['--postgres-test-socket=' + value], self.root)

    def test_explicit_existing_workspace_socket_config_does_not_connect_or_load_password_files(self):
        with TemporaryDirectory(prefix='inspection-settings-fixture-', dir=self.root / 'output') as directory:
            config = inspection_test_database(['--postgres-test-socket=' + directory], self.root)
            self.assertEqual(config['HOST'], str(Path(directory).resolve()))
            self.assertEqual(config['PORT'], '5432')
            self.assertEqual(config['TEST']['NAME'], 'test_wj_inspection_fixture')
            self.assertEqual(config['PASSWORD'], '')
            self.assertEqual(config['OPTIONS']['passfile'], '/dev/null')
            self.assertNotIn('service', config['OPTIONS'])

    def test_ambient_service_discovery_is_rejected_without_loading_a_service_file(self):
        with TemporaryDirectory(prefix='inspection-settings-fixture-', dir=self.root / 'output') as directory:
            for name in ('PGSERVICE', 'PGSERVICEFILE'):
                with self.subTest(name=name), patch.dict('os.environ', {name: 'SYNTHETIC-EXTERNAL-SERVICE'}):
                    with self.assertRaises(ValueError):
                        inspection_test_database(['--postgres-test-socket=' + directory], self.root)

    def test_preview_migration_generation_duplicate_or_escaping_symlink_is_rejected(self):
        with TemporaryDirectory(prefix='inspection-settings-fixture-', dir=self.root / 'output') as directory:
            option = '--postgres-test-socket=' + directory
            for arguments in [[option, '--preview'], [option, '--make-migrations'], [option, option]]:
                with self.assertRaises(ValueError):
                    inspection_test_database(arguments, self.root)
            link = Path(directory) / 'outside'
            link.symlink_to('/tmp', target_is_directory=True)
            with self.assertRaises(ValueError):
                inspection_test_database(['--postgres-test-socket=' + str(link)], self.root)
