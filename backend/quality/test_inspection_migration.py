"""Inspection additive migration upgrade/rollback boundaries in the caller's disposable test database."""
from datetime import date
from decimal import Decimal
from importlib import import_module

from django.db import connection, IntegrityError, migrations, transaction
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone


class InspectionMigrationCompatibilityTests(TransactionTestCase):
    def setUp(self):
        executor = MigrationExecutor(connection)
        self.latest = executor.loader.graph.leaf_nodes()
        self.before = [('quality', '0009_qualityreport_direct_excel_import') if app == 'quality'
                       else (app, name) for app, name in self.latest]
        executor.migrate(self.before)
        self.old = executor.loader.project_state(self.before).apps
        self.user = self.old.get_model('auth', 'User').objects.create(username='SYNTHETIC-upgrade-user')
        self.report = self.old.get_model('quality', 'QualityReport').objects.create(
            report_dt=timezone.now(), part_no='SYNTHETIC-OLD-PART', phenomenon='SYNTHETIC preserved report')
        self.plan = self.old.get_model('production', 'ProductionPlan').objects.create(
            plan_date=date(2026, 9, 30), plan_type='injection', machine_name='imm02',
            part_no='SYNTHETIC-OLD-PART', lot_no='SYNTHETIC-OLD-LOT', planned_quantity=100, sequence=1)

    def tearDown(self):
        # Restore the complete schema even after a failed assertion, so later
        # tests never inherit the old model state. This is not live rollback.
        MigrationExecutor(connection).migrate(self.latest)
        super().tearDown()

    def upgrade(self):
        executor = MigrationExecutor(connection)
        executor.migrate(self.latest)
        return executor.loader.project_state(self.latest).apps

    def create_inspection(self, apps):
        return apps.get_model('quality', 'InspectionRequest').objects.create(
            identity='a' * 64, work_order_ref='SYNTHETIC-UPGRADE-WO', task_ref='SYNTHETIC-UPGRADE-TASK',
            part_no='SYNTHETIC-OLD-PART', equipment_ref='imm02', target_quantity=Decimal('10.000'),
            uom='EA', warehouse_ref='SYNTHETIC-WAREHOUSE', lot_ref='SYNTHETIC-OLD-LOT',
            work_started_at=timezone.now(), assigned_to_id=self.user.pk, assigned_to_name=self.user.username)

    def test_forward_preserves_existing_rows_and_only_adds_expected_tables(self):
        before_tables = set(connection.introspection.table_names())
        rows = {(app, model): list(self.old.get_model(app, model).objects.values()) for app, model in
                [('auth', 'User'), ('quality', 'QualityReport'), ('production', 'ProductionPlan')]}
        upgraded = self.upgrade()
        self.assertEqual(set(connection.introspection.table_names()) - before_tables,
                         {'quality_inspectionrequest', 'quality_inspectionaudit', 'quality_inspectionoperation', 'quality_inspectionmesbinding', 'quality_inspectionnonconformance',
                          'quality_inspectionshiftsetting', 'quality_inspectionroleworkflow', 'quality_inspectionarearesult', 'quality_inspectioninspector', 'quality_inspectionweeklyroster', 'quality_qualityactionresulttranslation'})
        for (app, model), existing in rows.items():
            self.assertEqual(list(upgraded.get_model(app, model).objects.values()), existing)
        for name in ('0010_inspection_requests', '0011_inspection_requests', '0012_inspection_requests', '0013_inspection_roles'):
            self.assertTrue(all(isinstance(operation, migrations.CreateModel) for operation in
                                import_module('quality.migrations.' + name).Migration.operations))
        self.assertTrue(all(isinstance(operation, migrations.CreateModel) for operation in
                            import_module('quality.migrations.0018_qualityactionresulttranslation').Migration.operations))

    def test_previous_models_can_read_and_edit_existing_rows_with_new_tables_retained(self):
        upgraded = self.upgrade()
        inspection = self.create_inspection(upgraded)
        cache = upgraded.get_model('quality', 'QualityActionResultTranslation').objects.create(
            report_id=self.report.pk, source_sha256='b' * 64, prompt_version='SYNTHETIC-upgrade', text='SYNTHETIC 번역')
        self.old.get_model('quality', 'QualityReport').objects.filter(pk=self.report.pk).update(
            phenomenon='SYNTHETIC edit by previous code')
        self.assertEqual(upgraded.get_model('quality', 'QualityReport').objects.get(pk=self.report.pk).phenomenon,
                         'SYNTHETIC edit by previous code')
        self.assertEqual(self.old.get_model('production', 'ProductionPlan').objects.get(pk=self.plan.pk).planned_quantity, 100)
        self.assertTrue(upgraded.get_model('quality', 'InspectionRequest').objects.filter(pk=inspection.pk).exists())
        self.assertTrue(upgraded.get_model('quality', 'QualityActionResultTranslation').objects.filter(pk=cache.pk).exists())

    def test_old_code_report_delete_with_translation_cache_is_a_rollback_limit(self):
        upgraded = self.upgrade()
        upgraded.get_model('quality', 'QualityActionResultTranslation').objects.create(
            report_id=self.report.pk, source_sha256='b' * 64, prompt_version='SYNTHETIC-upgrade')
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.old.get_model('quality', 'QualityReport').objects.get(pk=self.report.pk).delete()
        self.assertTrue(upgraded.get_model('quality', 'QualityReport').objects.filter(pk=self.report.pk).exists())

    def test_previous_user_delete_is_protected_by_new_fk_and_is_a_rollback_limit(self):
        upgraded = self.upgrade()
        inspection = self.create_inspection(upgraded)
        # Old Django's collector does not know the newly added user relations.
        # SET_NULL is implemented by current Django, not a database cascade.
        # Rollback must retain schema/data and suspend old-code user deletion.
        with self.assertRaises(IntegrityError), transaction.atomic():
            self.old.get_model('auth', 'User').objects.get(pk=self.user.pk).delete()
        self.assertTrue(upgraded.get_model('auth', 'User').objects.filter(pk=self.user.pk).exists())
        self.assertEqual(upgraded.get_model('quality', 'InspectionRequest').objects.get(pk=inspection.pk).assigned_to_id, self.user.pk)
