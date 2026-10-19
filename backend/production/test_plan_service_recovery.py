"""Synthetic recovery fences; these tests do not establish provider atomicity."""
from contextlib import contextmanager
from copy import deepcopy
from datetime import date
from unittest.mock import patch
from uuid import UUID

from django.test import TransactionTestCase, override_settings

from .models import PlanMaterialApproval, PlanMesRequest, PlanMesRequestEvent, PlanWorkOrder
from .plan_request_recovery import latest_request
from .plan_service_transport import BASE_PATH, LIST_PATH, _claim, _finish
from .plan_workflow import WorkflowConflict, preview
from .plan_workflow_contract import CREATE_PATH, build_contract
from .plan_workflow_read_context import order_read_context
from .test_plan_service_transport import MISSING_ORDER, PlanServiceFixture, SCOPE, URL, WORK_ID, synthetic_response


@override_settings(MES_PLAN_REVIEWED_CONTRACT=None, MES_PLAN_WRITES_ENABLED=True)
class PlanServiceRecoveryTests(PlanServiceFixture, TransactionTestCase):
    def setUp(self):
        super().setUp()
        self.approve()
        self.prepare()

    @contextmanager
    def contract_variant(self, *, wire=False, metadata=False):
        # Exercise changed serialization independently of the live QC format.
        def changed(order, intent):
            contract, blockers = build_contract(order, intent)
            contract = deepcopy(contract)
            if wire:
                contract['payload']['identifier'] += '-SYNTHETIC-B'
            if metadata:
                contract['synthetic_revision'] = 'metadata-only'
            return contract, blockers

        with patch('production.plan_workflow_contract.build_contract', side_effect=changed), \
                patch('production.plan_service_transport.build_contract', side_effect=changed):
            yield

    def fail_known(self):
        self.scripts[CREATE_PATH] = [synthetic_response({
            'code': 0, 'subCode': 'MED-DOMAIN/IMPORT_CREATE_ERROR', 'needCheck': 0,
            'data': ['投料质量状态输入不合法'],
        })]
        result = self.dispatch()
        self.assertEqual((result['state'], result['attempt']), ('failed', 1))
        self.assertEqual(result['blockers'], ['input_quality_state_invalid'])
        self.req.refresh_from_db()

    def reject_known(self):
        self.fail_known()
        self.scripts[LIST_PATH] = [synthetic_response(MISSING_ORDER)]
        result = self.recheck()
        self.assertEqual((result['state'], result['attempt']), ('rejected', 1))
        self.req.refresh_from_db()
        return self.req

    def assert_prepare_blocked(self, blocker):
        before = list(PlanWorkOrder.objects.values())
        group, = preview(date(2026, 10, 8), date(2026, 10, 8), 'injection')
        response = self.action('prepare', keys=[group['key']])
        self.assertEqual(response.status_code, 200, response.data)
        result, = response.data['results']
        self.assertEqual(result['state'], 'blocked')
        self.assertIn(blocker, result['blockers'])
        self.assertNotIn('uid', result)
        self.assertEqual(list(PlanWorkOrder.objects.values()), before)

    def test_known_validation_requires_absent_read_and_never_resends_original_request(self):
        original = self.reject_known()
        evidence = original.events.order_by('-id').first().evidence
        self.assertIs(evidence['exact_code_absent'], True)
        self.assertEqual(evidence['blockers'], ['input_quality_state_invalid'])
        self.assertEqual(original.work_order.mes_id, '')
        before = len(self.calls)
        with self.assertRaises(WorkflowConflict):
            self.dispatch(original)
        self.assertEqual(len(self.calls), before)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_generic_import_rejection_stays_uncertain_and_history_is_not_reclassified(self):
        self.scripts[CREATE_PATH] = [synthetic_response({
            'code': 0, 'subCode': 'MED-DOMAIN/IMPORT_CREATE_ERROR', 'needCheck': 0,
            'data': ['SYNTHETIC other validation'],
        })]
        self.assertEqual(self.dispatch()['state'], 'failed')
        failure = self.req.events.order_by('-id').first()
        before = deepcopy(failure.evidence)
        self.assertEqual(before['blockers'], ['provider_result_rejected'])
        self.scripts[LIST_PATH] = [synthetic_response(MISSING_ORDER)]
        self.assertEqual(self.recheck()['state'], 'uncertain')
        failure.refresh_from_db()
        self.assertEqual(failure.evidence, before)
        self.assertFalse(self.req.events.filter(state='rejected').exists())
        with self.contract_variant(wire=True):
            self.assert_prepare_blocked('readback_required')
        self.assertEqual(PlanMesRequest.objects.count(), 1)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_changed_wire_prepares_same_code_new_uid_and_old_finish_cannot_change_successor(self):
        original = self.reject_known()
        with self.contract_variant(wire=True):
            current = self.prepare()
            self.assertNotEqual(current.uid, original.uid)
            self.assertEqual(current.work_order_id, original.work_order_id)
            self.assertEqual(current.work_order.code, original.work_order.code)
            self.assertNotEqual(current.contract['payload'], original.contract['payload'])
            # Explicit scripts avoid the old fixture's one-request-per-code lookup.
            self.scripts[LIST_PATH] = [synthetic_response(MISSING_ORDER), synthetic_response({
                'code': 200, 'needCheck': 0, 'data': {'page': 1, 'total': 1, 'list': [
                    {'workOrderCode': current.work_order.code, 'workOrderId': int(WORK_ID)}]},
            })]
            self.scripts[CREATE_PATH] = [synthetic_response({'code': 200, 'needCheck': 0, 'data': None})]
            self.scripts[BASE_PATH] = [synthetic_response(self.detail(current))]
            result = self.dispatch(current)
        self.assertEqual((result['state'], result['attempt'], result['mes_id']), ('created', 1, WORK_ID))
        imports = [call for call in self.calls if call['path'] == CREATE_PATH]
        self.assertEqual([call['payload'] for call in imports],
            [original.contract['payload'], current.contract['payload']])
        before = (list(PlanMesRequest.objects.values()), list(PlanMesRequestEvent.objects.values()),
                  list(PlanWorkOrder.objects.values()), len(self.calls))
        _finish(original, self.service(), 'rejected')
        with self.assertRaises(WorkflowConflict):
            self.recheck(original)
        with self.assertRaises(WorkflowConflict):
            self.dispatch(original)
        self.assertEqual((list(PlanMesRequest.objects.values()), list(PlanMesRequestEvent.objects.values()),
                          list(PlanWorkOrder.objects.values()), len(self.calls)), before)

    def test_old_positive_result_after_reprepare_is_retained_and_blocks_successor_import(self):
        original = self.reject_known()
        with self.contract_variant(wire=True):
            current = self.prepare()
            successor_before = PlanMesRequest.objects.filter(pk=current.pk).values().get()
            order_before = PlanWorkOrder.objects.filter(pk=current.work_order_id).values().get()
            calls_before = len(self.calls)
            result = _finish(original, self.service(), 'created', mes_id_value=WORK_ID)
            self.assertEqual((result['state'], result['mes_id']), ('review', WORK_ID))
            event = original.events.order_by('-id').first()
            self.assertEqual((event.state, event.evidence['outcome'], event.evidence['mes_id']),
                ('review', 'earlier_request_identity_observed', WORK_ID))
            self.assertEqual(PlanMesRequest.objects.filter(pk=current.pk).values().get(), successor_before)
            self.assertEqual(PlanWorkOrder.objects.filter(pk=current.work_order_id).values().get(), order_before)
            with self.assertRaises(WorkflowConflict):
                self.dispatch(current)
        current.refresh_from_db()
        self.assertEqual((current.state, current.attempt), ('disabled', 0))
        self.assertEqual(len(self.calls), calls_before)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)  # Only the original failed import.

    def test_found_identity_survives_detail_failure_and_later_absence(self):
        self.fail_known()
        self.existing_rows[self.req.work_order.code] = [
            {'workOrderCode': self.req.work_order.code, 'workOrderId': int(WORK_ID)}]
        self.scripts[BASE_PATH] = [synthetic_response({}, status=403)]
        sender = self.sender

        def detail_after_identity_commit(url, **kwargs):
            if url.endswith(BASE_PATH):
                self.req.refresh_from_db()
                event = self.req.events.order_by('-id').first()
                self.assertEqual((self.req.state, event.evidence['mes_id']), ('review', WORK_ID))
            return sender(url, **kwargs)

        result = self.recheck(transport=self.service(sender=detail_after_identity_commit))
        self.assertEqual((result['state'], result['mes_id'], result['blockers']),
            ('review', WORK_ID, ['permission_required']))
        before = list(self.req.events.values())
        self.scripts[LIST_PATH] = [synthetic_response(MISSING_ORDER)]
        result = self.recheck()
        self.assertEqual((result['state'], result['mes_id']), ('review', WORK_ID))
        self.assertEqual(list(self.req.events.values()), before)
        self.assertFalse(self.req.events.filter(state='rejected').exists())
        with self.contract_variant(wire=True):
            self.assert_prepare_blocked('readback_required')
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_stale_reservation_positive_identity_blocks_current_generation_on_same_uid(self):
        first = _claim(self.req.uid, self.user.pk)
        _finish(first, self.service(), 'failed', blockers=['SYNTHETIC lookup failure'])
        current = _claim(self.req.uid, self.other.pk)
        self.assertNotEqual(first._reservation_id, current._reservation_id)
        result = _finish(first, self.service(), 'created', mes_id_value=WORK_ID)
        self.assertEqual((result['state'], result['mes_id'], result['attempt']), ('review', WORK_ID, 0))
        event = self.req.events.order_by('-id').first()
        self.assertEqual(event.evidence['outcome'], 'earlier_request_identity_observed')
        self.req.work_order.refresh_from_db()
        self.assertEqual(self.req.work_order.mes_id, '')
        with self.assertRaises(WorkflowConflict):
            _claim(self.req.uid, self.other.pk, creation=True, reservation_id=current._reservation_id)
        result = _finish(current, self.service(), 'failed',
            blockers=['current_approval_or_plan_required'])
        self.assertEqual((result['state'], result['mes_id']), ('review', WORK_ID))
        self.assertEqual(self.req.events.order_by('-id').first().pk, event.pk)
        self.assert_no_transport()

    def test_metadata_reapproval_and_a_b_a_rollback_cannot_reuse_attempted_payload(self):
        original = self.reject_known()
        with self.contract_variant(metadata=True):
            self.assert_prepare_blocked('same_payload_already_attempted')
        approval = PlanMaterialApproval.objects.get(pk=original.intent['approval_ids'][0])
        replacement = PlanMaterialApproval.objects.create(revision=approval.revision,
            snapshot=deepcopy(approval.snapshot), fingerprint=approval.fingerprint,
            reason='SYNTHETIC reapproval without provider changes', actor=self.other)
        self.assertNotEqual(replacement.pk, approval.pk)
        self.assert_prepare_blocked('same_payload_already_attempted')
        self.assertEqual(PlanMesRequest.objects.count(), 1)
        with self.contract_variant(wire=True):
            current = self.prepare()
            self.assertIn(replacement.pk, current.intent['approval_ids'])
            self.reject_known()
        self.assert_prepare_blocked('same_payload_already_attempted')
        self.assertEqual(PlanMesRequest.objects.count(), 2)
        self.assertEqual(self.paths().count(CREATE_PATH), 2)
        self.assertEqual(set(PlanMesRequest.objects.values_list('attempt', flat=True)), {1})

    def test_late_absent_recheck_cannot_erase_identity_observed_in_same_request_review(self):
        self.fail_known()
        sender = self.sender
        observed = []

        def absent_after_identity(url, **kwargs):
            self.assertTrue(url.endswith(LIST_PATH))
            _finish(self.req, self.service(), 'review', mes_id_value=WORK_ID,
                blockers=['existing_code_snapshot_mismatch'])
            observed.append(self.req.events.order_by('-id').first().pk)
            return sender(url, **kwargs)

        self.scripts[LIST_PATH] = [synthetic_response(MISSING_ORDER)]
        result = self.recheck(transport=self.service(sender=absent_after_identity))
        self.assertEqual((result['state'], result['mes_id']), ('review', WORK_ID))
        self.assertEqual(self.req.events.order_by('-id').first().pk, observed[0])
        self.assertFalse(self.req.events.filter(state='rejected').exists())
        self.assert_prepare_blocked('readback_required')
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_equal_created_times_use_first_audit_event_not_uuid_or_later_recheck(self):
        original = self.reject_known()
        contract = deepcopy(original.contract)
        contract['payload']['identifier'] += '-SYNTHETIC-B'
        # Deliberately give the newer generation a smaller UUID. Both states
        # participate in order_read_context, so filtering cannot hide a bad sort.
        current = PlanMesRequest.objects.create(uid=UUID(int=1),
            work_order=original.work_order, dedupe_key='1' * 64, operation='create',
            intent=deepcopy(original.intent), contract=contract, actor=self.user)
        first = PlanMesRequestEvent.objects.create(request=current, state='disabled')
        self.assertGreater(original.uid.int, current.uid.int)
        self.assertLess(original.events.order_by('id').first().pk, first.pk)
        PlanMesRequest.objects.filter(pk=original.pk).update(created_at=current.created_at)
        original.refresh_from_db()
        self.assertEqual(original.created_at, current.created_at)

        for add_late_recheck in (False, True):
            if add_late_recheck:
                late = PlanMesRequestEvent.objects.create(request=original, state='rejected',
                    evidence={'exact_code_absent': True, 'blockers': ['input_quality_state_invalid']})
                self.assertGreater(late.pk, first.pk)
            with self.subTest(late_recheck=add_late_recheck):
                latest = latest_request(original.work_order)
                _, unresolved, pending = order_read_context('injection')
                self.assertEqual((latest.pk, latest._first_event), (current.pk, first.pk))
                self.assertEqual((pending[original.work_order_id].pk,
                    pending[original.work_order_id]._first_event), (current.pk, first.pk))
                self.assertNotIn(original.work_order_id, unresolved)
                response = self.api.get(URL, SCOPE)
                self.assertEqual(response.status_code, 200, response.data)
                self.assertEqual([row['uid'] for row in response.data['requests']],
                    [str(current.uid), str(original.uid)])

    def test_unsent_a_b_a_contract_rollback_does_not_reactivate_superseded_uid(self):
        original = self.req
        with self.contract_variant(wire=True):
            current = self.prepare()
        original.refresh_from_db()
        self.assertEqual((original.state, original.attempt), ('superseded', 0))
        self.assertEqual((current.state, current.attempt), ('disabled', 0))
        self.assertNotEqual(original.uid, current.uid)
        before = (list(PlanMesRequest.objects.values()), list(PlanMesRequestEvent.objects.values()))
        self.assert_prepare_blocked('superseded_request_requires_new_contract')
        self.assertEqual((list(PlanMesRequest.objects.values()), list(PlanMesRequestEvent.objects.values())), before)
        self.assertEqual(latest_request(current.work_order).pk, current.pk)
        self.assert_no_transport()
        # An old aborted preflight may retain failed/attempt0 in history. The
        # screen must not advertise its send/recheck buttons over the successor.
        PlanMesRequest.objects.filter(pk=original.pk).update(state='failed')
        with self.contract_variant(wire=True):
            response = self.api.get(URL, SCOPE)
        self.assertEqual(response.status_code, 200, response.data)
        newest, old = response.data['requests']
        self.assertEqual(newest['uid'], str(current.uid))
        self.assertIs(newest['can_send'], True)
        self.assertEqual(old['uid'], str(original.uid))
        self.assertIs(old['can_send'], False)
        self.assertIs(old['can_recheck'], False)
