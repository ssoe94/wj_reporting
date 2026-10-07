"""Additive role schema preserves completed QC rows in a disposable database."""
from decimal import Decimal
import uuid

from django.db import connection, migrations
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone


class InspectionRoleMigrationTests(TransactionTestCase):
    def setUp(self):
        executor = MigrationExecutor(connection)
        self.latest = executor.loader.graph.leaf_nodes()
        self.before = [('quality', '0012_inspection_requests') if app == 'quality'
                       else (app, name) for app, name in self.latest]
        executor.migrate(self.before)
        self.old = executor.loader.project_state(self.before).apps

    def tearDown(self):
        MigrationExecutor(connection).migrate(self.latest)
        super().tearDown()

    def test_completed_qc_and_receipt_rows_are_unchanged_without_assignment_backfill(self):
        user = self.old.get_model('auth', 'User').objects.create(username='SYNTHETIC-completed-owner')
        request = self.old.get_model('quality', 'InspectionRequest').objects.create(
            identity='d' * 64, work_order_ref='SYNTHETIC-WO', task_ref='SYNTHETIC-TASK',
            part_no='SYNTHETIC-PART', equipment_ref='SYNTHETIC-MACHINE',
            target_quantity=Decimal('1'), uom='EA', warehouse_ref='SYNTHETIC-WAREHOUSE',
            lot_ref='SYNTHETIC-LOT', work_started_at=timezone.now(), assigned_to_id=user.pk,
            assigned_to_name=user.username, status='approved', version=12, judgement='pass',
            quantity_mode='not_recorded', mes_completion_status='completed', sync_status='succeeded',
            measurements=[{'item_id': 'SYNTHETIC-size', 'value': 'SYNTHETIC-preserved', 'judgement': 'pass'}])
        self.old.get_model('quality', 'InspectionAudit').objects.create(request_id=request.pk,
            actor_id=user.pk, actor_name=user.username, action='SYNTHETIC-finish', version=12,
            status='approved', result_digest='e' * 64)
        self.old.get_model('quality', 'InspectionOperation').objects.create(request_id=request.pk,
            scope='SYNTHETIC:mes-finish', key=uuid.uuid4(), payload_digest='f' * 64,
            status='succeeded', response_status=200, response={'result': 'SYNTHETIC-preserved'},
            completed_at=timezone.now())
        self.old.get_model('quality', 'InspectionMesBinding').objects.create(request_id=request.pk,
            tenant='SYNTHETIC', qc_id='91000000000000001', work_order_id='91000000000000002',
            reviewed_result_digest='a' * 64, test_only=True, test_label='SYNTHETIC',
            contract={'source': 'SYNTHETIC-preserved'}, phase='completed')
        names = ('InspectionRequest', 'InspectionAudit', 'InspectionOperation', 'InspectionMesBinding')
        snapshots = {name: list(self.old.get_model('quality', name).objects.values()) for name in names}
        tables = set(connection.introspection.table_names())
        executor = MigrationExecutor(connection)
        executor.migrate(self.latest)
        upgraded = executor.loader.project_state(self.latest).apps
        self.assertEqual(set(connection.introspection.table_names()) - tables,
            {'quality_inspectionshiftsetting', 'quality_inspectionroleworkflow', 'quality_inspectionarearesult'})
        for name, snapshot in snapshots.items():
            self.assertEqual(list(upgraded.get_model('quality', name).objects.values()), snapshot)
        for name in ('InspectionShiftSetting', 'InspectionRoleWorkflow', 'InspectionAreaResult'):
            model = upgraded.get_model('quality', name)
            self.assertEqual(model.objects.count(), 0)
            self.assertEqual(model._meta.default_permissions, ())
        from importlib import import_module
        migration = import_module('quality.migrations.0013_inspection_roles').Migration
        self.assertEqual(len(migration.operations), 3)
        self.assertTrue(all(isinstance(operation, migrations.CreateModel) for operation in migration.operations))


class InspectionShiftEffectiveMigrationTests(TransactionTestCase):
    def setUp(self):
        executor = MigrationExecutor(connection)
        self.latest = executor.loader.graph.leaf_nodes()
        self.before = [('quality', '0013_inspection_roles') if app == 'quality'
                       else (app, name) for app, name in self.latest]
        executor.migrate(self.before)
        self.old = executor.loader.project_state(self.before).apps

    def tearDown(self):
        MigrationExecutor(connection).migrate(self.latest)
        super().tearDown()

    def test_effective_fields_preserve_existing_assignment_and_completed_author_snapshots(self):
        from datetime import time
        user = self.old.get_model('auth', 'User').objects.create(username='SYNTHETIC-existing-author')
        other = self.old.get_model('auth', 'User').objects.create(username='SYNTHETIC-existing-dimension')
        shift = self.old.get_model('quality', 'InspectionShiftSetting').objects.create(
            code='SYNTHETIC-EXISTING', label='SYNTHETIC existing shift', timezone='Asia/Shanghai',
            starts_at=time(20), ends_at=time(8), appearance_assignee_id=user.pk,
            dimension_assignee_id=other.pk, active=True, version=4, creator_id=user.pk)
        request = self.old.get_model('quality', 'InspectionRequest').objects.create(
            identity='b' * 64, work_order_ref='SYNTHETIC-WO', task_ref='SYNTHETIC-TASK',
            part_no='SYNTHETIC-PART', equipment_ref='SYNTHETIC-MACHINE', target_quantity=Decimal('1'),
            uom='EA', warehouse_ref='SYNTHETIC-WAREHOUSE', lot_ref='SYNTHETIC-LOT',
            work_started_at=timezone.now(), assigned_to_id=user.pk, assigned_to_name=user.username,
            status='approved', version=12, judgement='pass', quantity_mode='not_recorded',
            mes_completion_status='completed', sync_status='succeeded',
            measurements=[{'item_id': 'SYNTHETIC-item', 'value': 'SYNTHETIC-kept', 'judgement': 'pass'}])
        workflow = self.old.get_model('quality', 'InspectionRoleWorkflow').objects.create(
            request_id=request.pk, shift_setting_id=shift.pk, status='completed', config_version=2,
            shift_snapshot={'id': shift.pk, 'version': 4, 'shift_date': '2026-10-01',
                            'window_start': '2026-10-01T20:00:00+08:00',
                            'window_end': '2026-10-02T08:00:00+08:00'},
            actor_snapshot={'appearance': {'id': user.pk, 'name': 'SYNTHETIC original author'}},
            item_areas={'SYNTHETIC-item': 'appearance'})
        self.old.get_model('quality', 'InspectionAreaResult').objects.create(
            workflow_id=workflow.pk, area='appearance', assigned_to_id=user.pk,
            assigned_to_name='SYNTHETIC original author', version=3, status='complete', judgement='pass',
            measurements=request.measurements, completed_by_id=user.pk,
            completed_by_name='SYNTHETIC original author', completed_at=timezone.now())
        names = ('InspectionShiftSetting', 'InspectionRequest', 'InspectionRoleWorkflow', 'InspectionAreaResult')
        snapshots = {name: list(self.old.get_model('quality', name).objects.values()) for name in names}
        permission_count = self.old.get_model('auth', 'Permission').objects.count()
        tables = set(connection.introspection.table_names())
        executor = MigrationExecutor(connection)
        executor.migrate(self.latest)
        upgraded = executor.loader.project_state(self.latest).apps
        self.assertEqual(set(connection.introspection.table_names()), tables)
        for name, snapshot in snapshots.items():
            fields = list(snapshot[0])
            self.assertEqual(list(upgraded.get_model('quality', name).objects.values(*fields)), snapshot)
        upgraded_shift = upgraded.get_model('quality', 'InspectionShiftSetting').objects.get(pk=shift.pk)
        self.assertIsNone(upgraded_shift.effective_from)
        self.assertIsNone(upgraded_shift.effective_until)
        self.assertEqual(upgraded.get_model('auth', 'Permission').objects.count(), permission_count)
        from importlib import import_module
        migration = import_module('quality.migrations.0014_inspection_shift_effective_period').Migration
        self.assertEqual(len(migration.operations), 2)
        self.assertTrue(all(isinstance(operation, migrations.AddField) for operation in migration.operations))
        self.assertEqual({operation.name for operation in migration.operations}, {'effective_from', 'effective_until'})
