"""Finished-goods index names: model/migration agreement and the 0015 upgrade path."""
from importlib import import_module
from io import StringIO

from django.core.management import call_command
from django.db import connection, models
from django.db.migrations.executor import MigrationExecutor
from django.test import TestCase, TransactionTestCase
from django.utils import timezone


# Migration module names start with a digit, so load 0015 by name.
INDEXES = import_module('inventory.migrations.0015_finishedgoods_index_names').INDEXES
BEFORE = ('inventory', '0014_movement_history')
SNAPSHOT_TABLE = 'inventory_finishedgoodstransactionsnapshot'
TRANSACTION_TABLE = 'inventory_finishedgoodstransaction'


def index_names(table):
    with connection.cursor() as cursor:
        constraints = connection.introspection.get_constraints(cursor, table)
    return {name for name, details in constraints.items() if details['index']}


def all_index_names():
    return index_names(SNAPSHOT_TABLE) | index_names(TRANSACTION_TABLE)


class FinishedGoodsIndexStateTests(TestCase):
    def test_models_need_no_new_inventory_migration(self):
        # Raises SystemExit when the autodetector would write a migration.
        call_command('makemigrations', 'inventory', check=True, dry_run=True, stdout=StringIO())


class FinishedGoodsIndexMigrationTests(TransactionTestCase):
    def setUp(self):
        executor = MigrationExecutor(connection)
        self.latest = executor.loader.graph.leaf_nodes()
        self.before = [BEFORE if app == 'inventory' else (app, name) for app, name in self.latest]
        executor.migrate(self.before)
        self.old = executor.loader.project_state(self.before).apps

    def tearDown(self):
        # Leave the full schema for later tests even after a failed assertion.
        MigrationExecutor(connection).migrate(self.latest)
        super().tearDown()

    def migrate(self, targets):
        executor = MigrationExecutor(connection)
        executor.migrate(targets)

    def written(self):
        return {written for _model, _fields, written, _derived in INDEXES}

    def derived(self):
        return {derived for _model, _fields, _written, derived in INDEXES}

    def test_0012_schema_is_renamed_forward_and_back_with_rows_kept(self):
        self.assertTrue(self.written() <= all_index_names())
        snapshot = self.old.get_model('inventory', 'FinishedGoodsTransactionSnapshot').objects.create(
            slot='morning', report_date=timezone.localdate(), scheduled_at=timezone.now(),
            range_start=timezone.now(), range_end=timezone.now())
        self.old.get_model('inventory', 'FinishedGoodsTransaction').objects.create(
            snapshot_id=snapshot.pk, material_code='SYNTHETIC-MATERIAL')

        self.migrate(self.latest)
        names = all_index_names()
        self.assertTrue(self.derived() <= names)
        self.assertFalse(self.written() & names)
        upgraded = MigrationExecutor(connection).loader.project_state(self.latest).apps
        self.assertEqual(
            list(upgraded.get_model('inventory', 'FinishedGoodsTransaction').objects.values_list(
                'material_code', flat=True)),
            ['SYNTHETIC-MATERIAL'])

        self.migrate(self.before)
        names = all_index_names()
        self.assertTrue(self.written() <= names)
        self.assertFalse(self.derived() & names)

    def test_database_not_built_by_0012_still_ends_with_the_declared_indexes(self):
        # One index already carries the derived name and one is missing entirely,
        # as in a database whose tables were created outside 0012.
        renamed_model, renamed_fields, renamed_written, renamed_derived = INDEXES[0]
        dropped_model, dropped_fields, dropped_written, _dropped_derived = INDEXES[3]
        with connection.schema_editor() as editor:
            editor.rename_index(
                self.old.get_model('inventory', renamed_model),
                models.Index(fields=renamed_fields, name=renamed_written),
                models.Index(fields=renamed_fields, name=renamed_derived))
            editor.remove_index(
                self.old.get_model('inventory', dropped_model),
                models.Index(fields=dropped_fields, name=dropped_written))

        self.migrate(self.latest)
        names = all_index_names()
        self.assertTrue(self.derived() <= names)
        self.assertFalse(self.written() & names)
