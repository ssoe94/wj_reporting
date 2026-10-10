from datetime import date, datetime
from decimal import Decimal
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import TestCase, override_settings
from rest_framework.test import APIClient
from rest_framework.exceptions import ValidationError
from inventory.models import RawMaterialMESDataset
from .models import (ProductionPlan, ProductionExecution, PlanWorkIdentity, PlanWorkRevision,
                     PlanMaterialApproval, PlanMaterialDefault, PlanMesRequest, PlanMesRequestEvent, PlanWorkOrder)
from .plan_workflow import (snapshot, _record, lock_type, replace_uploaded_plans, material_catalog,
    approve_materials, preview, prepare, claim_for_isolated_adapter, record_adapter_result, serialize_row,
    reconcile_readback, resolve_identity, WorkflowConflict, digest)

REVIEW = {'reference': 'SYNTHETIC-reviewed-fixture-only', 'initial_status': 1, 'report_flag': 1,
          'manual_warehousing': '1', 'no_auto_warehousing': '0', 'tenant': 'SYNTHETIC-TENANT'}


def reviewed(groups):
    bindings = {}
    for group in groups:
        setup = group['setup']
        if not setup: continue
        bindings[group['setup_fingerprint']] = {'resource_id': '17000000000000004',
            'part_no': group['part_no'], 'machine_name': group['machine_name'],
            'output_material_id': '17000000000000005', 'mold_code': setup['mold_code'],
            'bom_version': setup['bom_version'], 'read_manual_warehousing': 1,
            'read_no_auto_warehousing': 0, 'base_clock_covers_children': True,
            'mold_field': {'fieldCode': 'SYNTHETIC_MOLD', 'fieldValue': {'code': setup['mold_code']}},
            'bom_version_field': {'fieldCode': 'SYNTHETIC_BOM', 'fieldValue': {'code': setup['bom_version']}}}
    return {**REVIEW, 'setup_fingerprints': list(bindings), 'setup_bindings': bindings}


def seed_catalog():
    return RawMaterialMESDataset.objects.create(kind='inventory', scope_key='synthetic', payload=[{
        'material': {'id': '17000000000000001', 'code': 'SYNTHETIC-RM', 'name': 'SYNTHETIC Resin', 'version': 'V1'},
        'amount': {'amount': '50', 'unit': {'id': '17000000000000002', 'name': '千克'}}}])


def new_plan(day=8, quantity=1000, part='SYNTHETIC-PART', machine='imm01', actor=None, **kwargs):
    with transaction.atomic():
        lock_type(kwargs.get('plan_type', 'injection'))
        plan = ProductionPlan.objects.create(plan_date=date(2026, 10, day), plan_type=kwargs.pop('plan_type', 'injection'),
            machine_name=machine, part_no=part, planned_quantity=quantity, sequence=kwargs.pop('sequence', 1), **kwargs)
        _record(plan, actor, 'added')
        return plan


def approval_data(plan):
    catalog = material_catalog()
    return {'uid': str(plan.work_uid), 'version': plan.work_version, 'dataset_id': catalog['dataset_id'],
        'inputs': [{'key': catalog['materials'][0]['key'], 'numerator': '0.02', 'denominator': '1', 'material_version': 'V1'}],
        'bom_version': 'SYNTHETIC-BOM-V1', 'mold_code': 'SYNTHETIC-MOLD', 'resource_code': 'SYNTHETIC-IMM01',
        'process_code': 'ZS', 'process_num': '10', 'route_code': 'SYNTHETIC-ROUTE',
        'output_unit_name': '个', 'output_unit_id': '17000000000000003', 'output_version': 'V1',
        'reason': 'SYNTHETIC reviewed formula'}


class PlanWorkflowTests(TestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(username='synthetic-admin', is_staff=True, is_superuser=True)
        self.client = APIClient()
        self.client.force_authenticate(self.user)
        self.dataset = seed_catalog()

    def approve(self, plan, **changes):
        data = {**approval_data(plan), **changes}
        with transaction.atomic():
            lock_type(plan.plan_type)
            return approve_materials(plan, data, self.user)

    def groups(self, plan_type='injection'):
        return preview(date(2026, 10, 8), date(2026, 10, 15), plan_type)

    def upload(self, rows, days=None, plan_type='injection'):
        with transaction.atomic():
            return replace_uploaded_plans(rows, days or [date(2026, 10, 8)], plan_type, self.user)

    def clone(self, plan, **changes):
        data = {key: getattr(plan, key) for key in snapshot(plan)}
        return ProductionPlan(**{**data, **changes})

    def test_past_legacy_precision_does_not_block_valid_today_read(self):
        old = new_plan(day=8, quantity=123.4567890123456, actor=self.user)
        today = new_plan(day=9, actor=self.user)
        self.approve(today)
        before = PlanWorkRevision.objects.get(work_id=old.work_uid).fingerprint
        response = self.client.get('/api/production/plan-workflow/?start=2026-10-09&end=2026-10-09&plan_type=injection')
        self.assertEqual(response.status_code, 200)
        self.assertEqual([row['uid'] for row in response.data['rows']], [str(today.work_uid)])
        self.assertEqual([group['quantity'] for group in response.data['preview']], ['1000.0'])
        self.assertNotIn('plan_quantity_review', response.data['preview'][0]['blockers'])
        self.assertEqual(PlanWorkRevision.objects.get(work_id=old.work_uid).fingerprint, before)
        self.assertFalse(PlanMesRequest.objects.exists())

    def test_legacy_quantity_is_visible_verbatim_and_cannot_be_approved_or_prepared(self):
        for quantity in (123.4567890123456, -1.0, 1e16, float('inf')):
            with self.subTest(quantity=quantity):
                plan = new_plan(quantity=quantity, machine=f'imm-{quantity}', actor=self.user)
                expected = format(Decimal(str(quantity)), 'f')
                response = self.client.get('/api/production/plan-workflow/?start=2026-10-08&end=2026-10-08&plan_type=injection')
                self.assertEqual(response.status_code, 200)
                row = next(row for row in response.data['rows'] if row['uid'] == str(plan.work_uid))
                group = next(group for group in response.data['preview'] if str(plan.work_uid) in group['members'])
                self.assertEqual((row['planned_quantity'], row['quantity_valid']), (expected, False))
                self.assertEqual(group['quantity'], expected)
                self.assertIn('plan_quantity_review', group['blockers'])
                scope = {'start': '2026-10-08', 'end': '2026-10-08', 'plan_type': 'injection'}
                rejected = self.client.post('/api/production/plan-workflow/', {
                    **scope, **approval_data(plan), 'plan_id': plan.pk, 'action': 'approve'}, format='json')
                self.assertEqual(rejected.status_code, 400)
                blocked = self.client.post('/api/production/plan-workflow/', {
                    **scope, 'action': 'prepare', 'keys': [group['key']]}, format='json')
                self.assertEqual(blocked.status_code, 200)
                self.assertEqual(blocked.data['results'][0]['state'], 'blocked')
                self.assertFalse(PlanMaterialApproval.objects.exists())
                self.assertFalse(PlanWorkOrder.objects.exists())
                self.assertFalse(PlanMesRequest.objects.exists())

    def test_legacy_quantity_reupload_preserves_baseline_uid_version_and_fingerprint(self):
        old = new_plan(quantity=123.4567890123456, actor=self.user)
        revision = PlanWorkRevision.objects.get(work_id=old.work_uid)
        baseline_quantity = revision.snapshot['planned_quantity']
        self.upload([self.clone(old)])
        new = ProductionPlan.objects.get()
        self.assertEqual((new.work_uid, new.work_version), (old.work_uid, 1))
        self.assertEqual(PlanWorkRevision.objects.count(), 1)
        self.assertEqual(snapshot(new)['planned_quantity'], baseline_quantity)
        self.assertEqual(digest(snapshot(new)), revision.fingerprint)

    def test_absent_mold_allows_one_day_preparation_without_merging_adjacent_days(self):
        first = new_plan(day=8, actor=self.user)
        second = new_plan(day=9, actor=self.user)
        for plan in (first, second): self.approve(plan, mold_code='')
        groups = self.groups()
        self.assertEqual([g['members'] for g in groups], [[str(first.work_uid)], [str(second.work_uid)]])
        self.assertTrue(all(g['setup']['mold_code'] == '' and not g['blockers'] for g in groups))
        results = prepare(date(2026, 10, 8), date(2026, 10, 8), 'injection', [groups[0]['key']], self.user)
        request = PlanMesRequest.objects.get(uid=results[0]['uid'])
        self.assertEqual(request.intent['quantity'], '1000.0')
        self.assertEqual(request.work_order.members, [str(first.work_uid)])
        self.assertEqual(request.intent['planned_end'], '2026-10-09T08:00:00+08:00')

    def test_campaign_total_limit_blocks_whole_campaign_without_splitting(self):
        plans = [new_plan(day=day, quantity=800000000000000, actor=self.user) for day in (8, 9, 10)]
        for plan in plans: self.approve(plan)
        groups = self.groups()
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['members'], [str(plan.work_uid) for plan in plans])
        self.assertEqual(groups[0]['quantity'], '2400000000000000.0')
        self.assertIn('plan_quantity_review', groups[0]['blockers'])
        results = prepare(date(2026, 10, 8), date(2026, 10, 10), 'injection', [groups[0]['key']], self.user)
        self.assertEqual(results[0]['state'], 'blocked')
        self.assertFalse(PlanMesRequest.objects.exists())

    def test_invalid_day_is_a_visible_boundary_between_approved_days(self):
        first = new_plan(day=8, actor=self.user)
        middle = new_plan(day=9, quantity=123.4567890123456, actor=self.user)
        last = new_plan(day=10, actor=self.user)
        self.approve(first)
        self.approve(last)
        groups = self.groups()
        self.assertEqual([group['members'] for group in groups],
                         [[str(plan.work_uid)] for plan in (first, middle, last)])
        self.assertIn('plan_quantity_review', groups[1]['blockers'])
        self.assertNotIn('plan_quantity_review', groups[0]['blockers'])
        self.assertNotIn('plan_quantity_review', groups[2]['blockers'])
        self.assertEqual(groups[1]['quantity'], '123.4567890123456')

    def test_nonfinite_snapshot_read_does_not_allow_mes_quantity(self):
        from .plan_workflow import valid_plan_quantity
        # SQLite cannot persist NaN in its NOT NULL float column, PostgreSQL can.
        plan = ProductionPlan(plan_date=date(2026, 10, 8), plan_type='injection',
                              machine_name='synthetic', planned_quantity=float('nan'))
        self.assertEqual(snapshot(plan)['planned_quantity'], 'NaN')
        self.assertFalse(valid_plan_quantity(snapshot(plan)['planned_quantity']))

    def test_identical_reupload_preserves_uid_version_approval_and_history(self):
        old = new_plan(actor=self.user)
        approval = self.approve(old)
        self.upload([self.clone(old)])
        new = ProductionPlan.objects.get()
        self.assertNotEqual(new.pk, old.pk)
        self.assertEqual((new.work_uid, new.work_version), (old.work_uid, 1))
        self.assertEqual(PlanMaterialApproval.objects.get().pk, approval.pk)
        self.assertEqual(PlanWorkRevision.objects.count(), 1)

    def test_quantity_change_increments_version_and_requires_new_approval(self):
        old = new_plan(actor=self.user)
        self.approve(old)
        self.upload([self.clone(old, planned_quantity=2000)])
        new = ProductionPlan.objects.get()
        self.assertEqual((new.work_uid, new.work_version), (old.work_uid, 2))
        self.assertIsNone(serialize_row(new)['approval'])
        self.assertEqual(PlanWorkRevision.objects.count(), 2)
        self.assertIsNotNone(serialize_row(new)['previous_approval'])
        with self.assertRaises(WorkflowConflict): approve_materials(new, approval_data(old), self.user)

    def test_duplicate_and_reorder_are_never_guessed(self):
        old = new_plan(actor=self.user)
        self.upload([self.clone(old, sequence=2), self.clone(old, sequence=3)])
        rows = list(ProductionPlan.objects.all())
        self.assertEqual(len(set(row.work_uid for row in rows)), 2)
        self.assertTrue(all(row.work_uid != old.work_uid for row in rows))
        self.assertTrue(all(PlanWorkIdentity.objects.get(uid=row.work_uid).resolution == 'confirmation' for row in rows))
        self.assertFalse(PlanWorkIdentity.objects.get(uid=old.work_uid).active)

    def test_date_move_requires_explicit_audited_identity_confirmation(self):
        old = new_plan(actor=self.user)
        self.upload([self.clone(old, plan_date=date(2026, 10, 9))], [date(2026, 10, 8), date(2026, 10, 9)])
        row = ProductionPlan.objects.get()
        self.assertIn(str(old.work_uid), PlanWorkIdentity.objects.get(uid=row.work_uid).candidates)
        with transaction.atomic():
            result = resolve_identity(row, {'version': row.work_version, 'previous_uid': str(old.work_uid), 'reason': 'explicit moved task'}, self.user)
        self.assertEqual(result['uid'], str(old.work_uid))
        self.assertEqual(PlanWorkRevision.objects.filter(work_id=old.work_uid).count(), 3)
        self.assertEqual(PlanWorkRevision.objects.get(work_id=old.work_uid, version=3).reason, 'explicit moved task')

    def test_fresh_multiday_rows_not_ambiguous_from_the_same_upload(self):
        rows = [ProductionPlan(plan_date=date(2026, 10, day), plan_type='injection', machine_name='imm01',
            part_no='SYNTHETIC-PART', planned_quantity=1000, sequence=1) for day in (8, 9, 10)]
        self.upload(rows, [date(2026, 10, day) for day in (8, 9, 10)])
        self.assertTrue(all(work.resolution == 'identified' for work in PlanWorkIdentity.objects.all()))

    def test_execution_composite_key_history_is_preserved(self):
        old = new_plan(actor=self.user)
        execution = ProductionExecution.objects.create(plan_date=old.plan_date, plan_type=old.plan_type,
            machine_name=old.machine_name, part_no=old.part_no, sequence=old.sequence, actual_qty=100)
        self.upload([self.clone(old, sequence=2)])
        self.assertEqual(ProductionExecution.objects.get(pk=execution.pk).actual_qty, 100)

    def test_missing_id_or_unit_and_dash_are_not_selectable_fallbacks(self):
        for payload in [ {'material': {'code': 'RM', 'name': 'RM'}, 'amount': {'unit': {'id': '12', 'name': 'kg'}}},
                         {'material': {'id': '11', 'code': 'RM', 'name': 'RM'}, 'amount': {}},
                         {'material': {'id': '11', 'code': 'RM', 'name': 'RM'}, 'amount': {'unit': {'id': '12', 'name': '-'}}} ]:
            self.dataset.payload = [payload]; self.dataset.save()
            self.assertEqual(material_catalog()['materials'], [])

    def test_same_code_different_id_is_blocked(self):
        row = self.dataset.payload[0]
        self.dataset.payload.append({**row, 'material': {**row['material'], 'id': '17000000000000005'}})
        self.dataset.save()
        self.assertTrue(all(not row['selectable'] for row in material_catalog()['materials']))
        with self.assertRaises(ValidationError): self.approve(new_plan(actor=self.user))

    def test_large_mes_ids_are_strings_and_snapshot_quantities_exact(self):
        plan = new_plan(quantity=2300, actor=self.user)
        approval = self.approve(plan)
        self.assertEqual(approval.snapshot['inputs'][0]['material_id'], '17000000000000001')
        self.assertEqual(Decimal(approval.snapshot['inputs'][0]['required_quantity']), Decimal('46'))
        self.assertEqual(PlanMaterialDefault.objects.count(), 0)

    def test_bad_ratio_float_or_unit_id_rejected(self):
        plan = new_plan(actor=self.user)
        for key, value in [('output_unit_id', 17000000000000003), ('output_unit_name', '-')]:
            with self.assertRaises(ValidationError): self.approve(plan, **{key: value})
        for ratio in ('0', 'NaN', 0.02, '-1'):
            data = approval_data(plan); data['inputs'][0]['numerator'] = ratio
            with self.assertRaises(ValidationError): approve_materials(plan, data, self.user)

    def test_source_dataset_change_returns_conflict(self):
        plan = new_plan(actor=self.user)
        data = approval_data(plan)
        RawMaterialMESDataset.objects.create(kind='inventory', scope_key='new', payload=self.dataset.payload)
        with self.assertRaises(WorkflowConflict): approve_materials(plan, data, self.user)

    def test_d1_d3_2300_then_d4_3200_same_work_order_and_original_actual_start(self):
        plans = [new_plan(day=d, quantity=q, actor=self.user) for d, q in [(8,1000), (9,1000), (10,300)]]
        for plan in plans: self.approve(plan)
        group = self.groups()[0]
        self.assertEqual(group['quantity'], '2300.0')
        self.assertIsNone(group['mes_id'])
        self.assertEqual(group['planned_end'], '2026-10-11T08:00:00+08:00')
        with override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(self.groups())):
            result = prepare(date(2026,10,8), date(2026,10,10), 'injection', [group['key']], self.user)[0]
            req = PlanMesRequest.objects.get(uid=result['uid'])
            claim_for_isolated_adapter(req.uid, fixture=True)
            record_adapter_result(req.uid, 'acknowledged')
            evidence = {**{key:req.intent[key] for key in ['quantity','planned_start','planned_end','setup_fingerprint']},
                'work_order_code':req.work_order.code, 'work_order_id':'17000000000000007', 'complete':True,
                'reported_quantity':'100', 'inbound_quantity':'80', 'actual_started_at':'2026-10-08T09:30:00+08:00'}
            self.assertEqual(reconcile_readback(req.uid, evidence), 'confirmed')
            actual = PlanWorkOrder.objects.get().actual_started_at
            self.upload([self.clone(plans[2], planned_quantity=1000)], [date(2026,10,10)])
            changed = ProductionPlan.objects.get(plan_date=date(2026,10,10)); self.approve(changed)
            appended = new_plan(day=11, quantity=200, actor=self.user); self.approve(appended)
            group = self.groups()[0]
            self.assertEqual(group['quantity'], '3200.0')
            self.assertEqual(group['planned_end'], '2026-10-12T08:00:00+08:00')
            self.assertEqual(group['operation'], 'update')
            self.assertEqual(group['mes_id'], '17000000000000007')
            result2 = prepare(date(2026,10,8), date(2026,10,11), 'injection', [group['key']], self.user)[0]
            update = PlanMesRequest.objects.get(uid=result2['uid'])
            self.assertEqual(update.work_order.code, req.work_order.code)
            self.assertEqual(update.contract['payload']['workOrderUpdatePlanTimeList'][0]['plannedAmount'], '3200.0')
            self.assertNotIn('planStartTime', update.contract['payload']['workOrderUpdatePlanTimeList'][0])
            self.assertEqual(PlanWorkOrder.objects.get().actual_started_at, actual)
            self.assertIn('task_quantity_propagation_and_allowed_state_review', update.blockers)

    def test_intervening_other_product_gap_and_material_change_do_not_merge(self):
        for day, part in [(8,'A'), (9,'B'), (10,'A'), (12,'A')]:
            self.approve(new_plan(day=day, part=part, actor=self.user))
        self.assertEqual(len(self.groups()), 4)
        extra = new_plan(day=13, part='A', actor=self.user)
        self.approve(extra, mold_code='OTHER-MOLD')
        self.assertEqual(len(self.groups()), 5)

    def test_unprepared_first_row_is_not_skipped(self):
        new_plan(day=8, actor=self.user)
        self.approve(new_plan(day=9, actor=self.user))
        groups = self.groups()
        self.assertEqual(len(groups), 2)
        self.assertIn('material_confirmation', groups[0]['blockers'])
        self.assertEqual(groups[1]['planned_start'], '2026-10-09T08:00:00+08:00')

    def test_machining_stays_daily(self):
        for day in (8,9): self.approve(new_plan(day=day, plan_type='machining', actor=self.user))
        self.assertEqual(len(self.groups('machining')), 2)

    def test_machining_multiple_products_on_one_line_prepare_separate_daily_orders(self):
        for part in ('A','B'):
            self.approve(new_plan(part=part,plan_type='machining',sequence=1 if part=='A' else 2,actor=self.user))
        groups=self.groups('machining')
        self.assertEqual(len(groups),2)
        self.assertTrue(all(not group['blockers'] for group in groups))
        result=prepare(date(2026,10,8),date(2026,10,8),'machining',[group['key'] for group in groups],self.user)
        self.assertEqual(len(result),2)
        self.assertEqual(PlanWorkOrder.objects.count(),2)

    def test_duplicate_prepare_has_one_persisted_request_even_after_refresh(self):
        plan = new_plan(actor=self.user); self.approve(plan)
        group = self.groups()[0]
        first = prepare(date(2026,10,8), date(2026,10,8), 'injection', [group['key']], self.user)
        repeated = prepare(date(2026,10,8), date(2026,10,8), 'injection', [group['key']], self.user)
        self.assertEqual(repeated[0]['state'], 'unchanged')
        latest = self.groups()[0]
        self.assertEqual(latest['operation'], 'unchanged')
        prepare(date(2026,10,8), date(2026,10,8), 'injection', [latest['key']], self.user)
        self.assertEqual(PlanMesRequest.objects.count(), 1)
        self.assertEqual(PlanWorkOrder.objects.count(), 1)

    def test_partial_batch_keeps_good_and_blocks_unapproved(self):
        good = new_plan(actor=self.user); self.approve(good)
        new_plan(machine='imm02', actor=self.user)
        result = prepare(date(2026,10,8), date(2026,10,8), 'injection', [g['key'] for g in self.groups()], self.user)
        self.assertEqual({r['state'] for r in result}, {'disabled','blocked'})
        self.assertEqual(PlanMesRequest.objects.count(), 1)

    def test_timeout_or_crash_never_replays_and_mismatch_stays_review(self):
        plan = new_plan(actor=self.user); self.approve(plan)
        with override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(self.groups())):
            group = self.groups()[0]
            result = prepare(date(2026,10,8), date(2026,10,8), 'injection', [group['key']], self.user)[0]
            req = PlanMesRequest.objects.get(uid=result['uid'])
            with self.assertRaises(WorkflowConflict): claim_for_isolated_adapter(req.uid)
            claim_for_isolated_adapter(req.uid, fixture=True)
            with self.assertRaises(WorkflowConflict): claim_for_isolated_adapter(req.uid, fixture=True)
            record_adapter_result(req.uid, 'timeout')
            self.assertEqual(reconcile_readback(req.uid, {'complete':False}), 'review')
            with self.assertRaises(WorkflowConflict): claim_for_isolated_adapter(req.uid, fixture=True)
            self.assertIn('readback_required', self.groups()[0]['blockers'])

    def test_below_reported_or_inbound_is_blocked_no_receipt_shortfall_increment(self):
        plan = new_plan(quantity=1000, actor=self.user); self.approve(plan)
        group = self.groups()[0]
        prepare(date(2026,10,8),date(2026,10,8),'injection',[group['key']],self.user)
        order = PlanWorkOrder.objects.get(); order.reported_quantity=Decimal('800');order.inbound_quantity=Decimal('600');order.save()
        self.assertEqual(self.groups()[0]['quantity'], '1000.0')
        self.upload([self.clone(plan, planned_quantity=700)]); changed = ProductionPlan.objects.get();self.approve(changed)
        self.assertIn('below_produced_or_inbound', self.groups()[0]['blockers'])

    def test_quantity_below_preserved_local_execution_is_also_held_for_review(self):
        plan=new_plan(actor=self.user)
        ProductionExecution.objects.create(plan_date=plan.plan_date,plan_type=plan.plan_type,
            machine_name=plan.machine_name,part_no=plan.part_no,lot_no=plan.lot_no,sequence=plan.sequence,actual_qty=800)
        self.upload([self.clone(plan,planned_quantity=700)])
        plan=ProductionPlan.objects.get();self.approve(plan)
        self.assertIn('below_existing_execution_review',self.groups()[0]['blockers'])

    def test_direct_reorder_retains_historical_execution_reduction_guard(self):
        plan=new_plan(actor=self.user)
        ProductionExecution.objects.create(plan_date=plan.plan_date,plan_type=plan.plan_type,
            machine_name=plan.machine_name,part_no=plan.part_no,lot_no=plan.lot_no,sequence=plan.sequence,actual_qty=800)
        response=self.client.patch(f'/api/production/plans/{plan.pk}/',{'sequence':5,'planned_quantity':700,'work_version':1},format='json')
        self.assertEqual(response.status_code,200)
        plan.refresh_from_db();self.approve(plan)
        self.assertIn('below_existing_execution_review',self.groups()[0]['blockers'])

    def test_product_machine_or_lot_change_cannot_update_an_existing_order(self):
        plan=new_plan(actor=self.user);self.approve(plan)
        group=self.groups()[0]
        prepare(date(2026,10,8),date(2026,10,8),'injection',[group['key']],self.user)
        plan.part_no='OTHER-PART';plan.save()
        with transaction.atomic():
            lock_type('injection');_record(plan,self.user,'changed')
        self.approve(plan)
        self.assertIn('work_target_changed_review',self.groups()[0]['blockers'])

    def test_stale_preview_and_stale_claim_blocked_after_plan_change(self):
        plan = new_plan(actor=self.user); self.approve(plan)
        group = self.groups()[0]
        with override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(self.groups())):
            req = prepare(date(2026,10,8),date(2026,10,8),'injection',[group['key']],self.user)[0]
        self.upload([self.clone(plan, planned_quantity=2000)])
        with self.assertRaises(WorkflowConflict): prepare(date(2026,10,8),date(2026,10,8),'injection',[group['key']],self.user)
        with self.assertRaises(WorkflowConflict): claim_for_isolated_adapter(req['uid'], fixture=True)
        self.assertEqual(PlanMesRequest.objects.get().state, 'superseded')

    def test_api_read_never_writes_or_queries_mes_and_permissions_enforced(self):
        plan = new_plan(actor=self.user)
        before = PlanWorkRevision.objects.count()
        response = self.client.get('/api/production/plan-workflow/?start=2026-10-08&end=2026-10-10&plan_type=injection')
        self.assertEqual(response.status_code,200)
        self.assertFalse(response.data['write_enabled'])
        self.assertEqual(before,PlanWorkRevision.objects.count())
        viewer = get_user_model().objects.create_user(username='viewer')
        self.client.force_authenticate(viewer)
        response = self.client.post('/api/production/plan-workflow/', {'start':'2026-10-08','end':'2026-10-10','plan_type':'injection','action':'approve', 'plan_id':plan.pk, **approval_data(plan)},format='json')
        self.assertEqual(response.status_code,403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get('/api/production/plan-workflow/').status_code,(401,403))

    def test_material_approval_api_roundtrip_preserves_exact_ids_and_actor(self):
        plan=new_plan(actor=self.user)
        scope={'start':'2026-10-08','end':'2026-10-08','plan_type':'injection','plan_id':plan.pk,'action':'approve'}
        response=self.client.post('/api/production/plan-workflow/',{**scope,**approval_data(plan)},format='json')
        self.assertEqual(response.status_code,201,response.data)
        self.assertEqual(response.data['snapshot']['inputs'][0]['material_id'],'17000000000000001')
        self.assertEqual(PlanMaterialApproval.objects.get().actor_id,self.user.pk)
        self.assertEqual(PlanMaterialDefault.objects.count(),0)

    def test_invalid_range_and_direct_write_action_rejected(self):
        response=self.client.get('/api/production/plan-workflow/?start=2026-10-08&end=2026-12-08&plan_type=injection')
        self.assertEqual(response.status_code,400)
        plan = new_plan(actor=self.user)
        response=self.client.post('/api/production/plan-workflow/', {'start':'2026-10-08','end':'2026-10-08','plan_type':'injection','plan_id':plan.pk,'action':'send'},format='json')
        self.assertEqual(response.status_code,400)

    def test_approval_replay_and_default_are_separate_explicit_operations(self):
        plan=new_plan(actor=self.user)
        first=self.approve(plan);second=self.approve(plan)
        self.assertEqual(first.pk,second.pk)
        scope={'start':'2026-10-08','end':'2026-10-08','plan_type':'injection','plan_id':plan.pk,'version':plan.work_version,'action':'save_default','default_version':0,'reason':'explicit default'}
        response=self.client.post('/api/production/plan-workflow/',scope,format='json');self.assertEqual(response.status_code,201)
        self.assertEqual(self.client.post('/api/production/plan-workflow/',scope,format='json').status_code,409)
        self.assertEqual(PlanMaterialDefault.objects.count(),1)

    def test_existing_edit_api_versions_and_delete_keep_revisions(self):
        plan=new_plan(actor=self.user)
        response=self.client.patch(f'/api/production/plans/{plan.pk}/',{'planned_quantity':1200,'work_version':1},format='json')
        self.assertEqual(response.status_code,200,response.data)
        self.assertEqual(response.data['work_version'],2)
        stale=self.client.patch(f'/api/production/plans/{plan.pk}/',{'planned_quantity':500,'work_version':1},format='json')
        self.assertEqual(stale.status_code,409)
        response=self.client.delete(f'/api/production/plans/{plan.pk}/');self.assertEqual(response.status_code,204)
        self.assertEqual(PlanWorkRevision.objects.count(),3)
        self.assertFalse(PlanWorkIdentity.objects.get(uid=plan.work_uid).active)
