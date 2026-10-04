"""Additive upgrade and old-code compatibility, only in a disposable database."""
from datetime import date, timedelta
from importlib import import_module

from django.db import connection, IntegrityError, migrations, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone


class OAuthMigrationTests(TransactionTestCase):
    def setUp(self):
        executor = MigrationExecutor(connection)
        self.latest = executor.loader.graph.leaf_nodes()
        self.before = [node for node in self.latest if node[0] != 'mes_oauth']
        executor.migrate(self.before + [('mes_oauth', None)])
        self.old = executor.loader.project_state(self.before).apps
        self.user = self.old.get_model('auth', 'User').objects.create(username='SYNTHETIC-old-account')
        self.report = self.old.get_model('quality', 'QualityReport').objects.create(
            report_dt=timezone.now(), part_no='SYNTHETIC-PART', phenomenon='SYNTHETIC existing report')
        self.plan = self.old.get_model('production', 'ProductionPlan').objects.create(
            plan_date=date(2026, 9, 30), plan_type='injection', machine_name='imm02',
            part_no='SYNTHETIC-PART', lot_no='SYNTHETIC-LOT', planned_quantity=100, sequence=1)

    def tearDown(self):
        MigrationExecutor(connection).migrate(self.latest)
        super().tearDown()

    def upgrade(self):
        executor = MigrationExecutor(connection)
        executor.migrate(self.latest)
        return executor.loader.project_state(self.latest).apps

    def attempt(self, apps):
        return apps.get_model('mes_oauth', 'OAuthAttempt').objects.create(
            nonce_digest='a' * 64, actor_id=self.user.pk, session_digest='b' * 64,
            policy_digest='c' * 64, code_digest='d' * 64, expected_user_id='10000000000000003',
            status='verified', expires_at=timezone.now() + timedelta(minutes=5))

    def test_upgrade_adds_exactly_one_table_preserving_existing_rows(self):
        before_tables = set(connection.introspection.table_names())
        rows = {(app, model): list(self.old.get_model(app, model).objects.values()) for app, model in
                [('auth', 'User'), ('quality', 'QualityReport'), ('production', 'ProductionPlan')]}
        upgraded = self.upgrade()
        self.assertEqual(set(connection.introspection.table_names()) - before_tables,
                         {'mes_oauth_oauthattempt'})
        for (app, model), existing in rows.items():
            self.assertEqual(list(upgraded.get_model(app, model).objects.values()), existing)
        migration = import_module('mes_oauth.migrations.0001_initial').Migration
        self.assertEqual(migration.dependencies, [])
        self.assertEqual(len(migration.operations), 1)
        self.assertIsInstance(migration.operations[0], migrations.CreateModel)

    def test_code_rollback_keeps_replay_barrier_and_old_reads_edits_and_user_delete_work(self):
        upgraded = self.upgrade()
        row = self.attempt(upgraded)
        self.old.get_model('quality', 'QualityReport').objects.filter(pk=self.report.pk).update(
            phenomenon='SYNTHETIC edit using old model')
        self.assertEqual(upgraded.get_model('quality', 'QualityReport').objects.get(pk=self.report.pk).phenomenon,
                         'SYNTHETIC edit using old model')
        self.assertEqual(self.old.get_model('production', 'ProductionPlan').objects.get(pk=self.plan.pk).planned_quantity, 100)
        self.old.get_model('auth', 'User').objects.get(pk=self.user.pk).delete()
        self.assertFalse(upgraded.get_model('auth', 'User').objects.filter(pk=self.user.pk).exists())
        Attempt = upgraded.get_model('mes_oauth', 'OAuthAttempt')
        self.assertEqual(Attempt.objects.get(pk=row.pk).code_digest, 'd' * 64)
        with self.assertRaises(IntegrityError), transaction.atomic():
            Attempt.objects.create(nonce_digest='e' * 64, actor_id=self.user.pk,
                session_digest='b' * 64, policy_digest='c' * 64, code_digest='d' * 64,
                expected_user_id='10000000000000003', expires_at=timezone.now())

    def test_reverse_migration_is_destructive_to_replay_records_not_release_rollback(self):
        upgraded = self.upgrade()
        self.attempt(upgraded)
        MigrationExecutor(connection).migrate(self.before + [('mes_oauth', None)])
        self.assertNotIn('mes_oauth_oauthattempt', connection.introspection.table_names())
        self.assertTrue(self.old.get_model('quality', 'QualityReport').objects.filter(pk=self.report.pk).exists())
        # This is a synthetic demonstration of why production rollback must not
        # reverse the migration. A re-created table cannot remember prior codes.
        upgraded = self.upgrade()
        self.assertEqual(upgraded.get_model('mes_oauth', 'OAuthAttempt').objects.count(), 0)
