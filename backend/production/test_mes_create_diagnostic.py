"""Synthetic provider responses in disposable DB; all real network forbidden."""
from copy import deepcopy
from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import patch, Mock
import threading
import time

from django.contrib.auth import get_user_model
from django.db import transaction, connection, close_old_connections
from django.test import TransactionTestCase, override_settings
from django.utils import timezone
from mes_oauth.session_guard import InspectionSession
from quality.inspection_transport import InspectionUserAccessToken
from . import mes_create_diagnostic as d
from .mes_execution_contract import encode_exact_json, parse_json_exact
from .models import MesCreateDiagnostic
from .plan_workflow import WorkflowConflict

WORK_ID = '17000000000000007'


def envelope(node):
    return {'code': 200, 'needCheck': 0, 'data': node, 'fieldPermission': {'noAccess': []}}


def page(rows):
    return envelope({'list': rows, 'page': 1, 'total': len(rows)})


def response(body):
    return SimpleNamespace(status_code=200, history=[], content=encode_exact_json(body))


class DiagnosticTests(TransactionTestCase):
    def setUp(self):
        self.user = get_user_model().objects.create_user(pk=d.ACTOR_ID, username='SYNTHETIC-diagnostic', is_superuser=True)
        self.req = d.prepare_diagnostic(self.user)
        self.session = InspectionSession(d.ACTOR_ID, 'SYNTHETIC-session', timezone.now() + timedelta(minutes=30), {})
        self.credential = InspectionUserAccessToken('SYNTHETIC-NETWORK-FORBIDDEN', time.time()+3600, user_id=int(d.MES_USER_ID))
        now = timezone.now()
        self.approval = {'reference': 'SYNTHETIC-APPROVAL-ONLY', 'request_uid': str(self.req.uid),
            'payload_digest': d.PAYLOAD_DIGEST, 'code': d.CODE, 'actor_id': d.ACTOR_ID,
            'mes_user_id': d.MES_USER_ID, 'origin': d.ORIGIN, 'tenant': d.TENANT,
            'approved_at': (now-timedelta(seconds=1)).isoformat(), 'expires_at': (now+timedelta(minutes=20)).isoformat(),
            'max_attempts': 1, 'accept_unknown_common_automation': True, 'preserve_draft': True,
            'read_scope': 'exact_order_and_code0_effect_window'}
        self.calls, self.operations = [], []
        self.created = False
        self.timeout = False
        self.denied = ''
        self.inventory, self.qc, self.tasks, self.changes = [], [], [], []
        self.base = {'id': int(WORK_ID), 'code': d.CODE, 'identifier': d.CODE, 'externalOrderCode': d.CODE,
            'status': {'code': 0}, 'plannedStartTime': d.PAYLOAD['planStartTime'],
            'plannedFinishTime': d.PAYLOAD['planFinishTime'], 'updatedAt': d.PAYLOAD['planStartTime'],
            'actualStartTime': None, 'resource': None, 'bomId': None}
        self.output = {'materialId': int(d.MATERIAL_ID), 'material': {'baseInfo': {'code': '0'}}, 'main': 1,
            'unitName': '个', 'plannedAmount': {'amount': 1, 'unitName': '个'},
            'processRouteCode': None, 'outputProcessSimpleVO': None}
        self.inputs = []
        self.processes = {'processes': [], 'relations': [], 'originalProcessRoute': None}
        config = SimpleNamespace(tenant=d.TENANT)
        for context in (override_settings(MES_CREATE_DIAGNOSTIC_APPROVAL=self.approval,
                MES_INSPECTION_ENABLED=True, MES_USER_OAUTH_ENABLED=True),
                patch('mes_oauth.vault.policy', return_value=config),
                patch('mes_oauth.vault.expected_user', return_value=int(d.MES_USER_ID)),
                patch('mes_oauth.inspection_credentials.call_with_user_credential', side_effect=self.broker),
                patch('mes_oauth.app_tokens.get_app_access_token', side_effect=AssertionError('APP issuance forbidden'))):
            context.__enter__(); self.addCleanup(context.__exit__, None, None, None)

    def broker(self, session, **kwargs):
        self.assertIs(session, self.session)
        self.assertEqual(kwargs['mes_user_id'], int(d.MES_USER_ID))
        self.assertEqual(kwargs['tenant'], d.TENANT)
        self.assertIsNotNone(kwargs['provider'])
        self.assertTrue(kwargs['policy_check']())
        self.operations.append(kwargs['operation'])
        # The established broker holds auth/user locks during IO. Its rollback
        # must not undo the request fence that was committed beforehand.
        with transaction.atomic():
            return kwargs['callback'](self.credential)

    def sender(self, url, **kwargs):
        self.assertTrue(url.startswith(d.ORIGIN+d.ROUTE_BASE))
        self.assertFalse(kwargs['allow_redirects'])
        route = url.split(d.ROUTE_BASE)[1]
        payload = parse_json_exact(kwargs['data'])
        self.calls.append((route, payload))
        if route == self.denied:
            return response({'code': 3500060, 'subCode': 'URL_NO_PERMISSION'})
        if route == d.CREATE_PATH:
            persisted = MesCreateDiagnostic.objects.get(pk=self.req.pk)
            self.assertEqual((persisted.state, persisted.attempt), ('sending', 1))
            self.assertEqual(d.digest(payload), d.PAYLOAD_DIGEST)
            self.created = True
            if self.timeout: raise TimeoutError('SYNTHETIC lost acknowledgement')
            return response(envelope({'id': int(WORK_ID)}))
        action = next(key for key, value in d.READ_ROUTES.items() if value == route)
        if action == 'orders': return response(page([{'id': int(WORK_ID), 'code': d.CODE}] if self.created else []))
        if action == 'inventory': return response(page(self.inventory))
        if action == 'qc': return response(page(self.qc))
        if action == 'tasks': return response(page(self.tasks))
        if action == 'changes':
            self.assertNotIn('action', payload); self.assertNotIn('direction', payload)
            self.assertNotIn('operatorId', payload)
            return response(page(self.changes))
        return response(envelope({'base': self.base, 'inputs': self.inputs,
            'outputs': [self.output], 'processes': self.processes}[action]))

    def execute_fixture(self, *, read_only=False, sender=None, **kwargs):
        return d.run_for_session(self.req.uid, self.session, read_only=read_only,
            provider=object(), sender=sender or self.sender, **kwargs)

    def test_exact_bytes_and_persistent_separate_preparation(self):
        self.assertEqual(d.digest(self.req.payload), d.PAYLOAD_DIGEST)
        self.assertEqual(d.prepare_diagnostic(self.user).pk, self.req.pk)
        self.assertEqual(self.req.events.count(), 1)
        self.assertEqual((self.req.state, self.req.attempt), ('prepared', 0))
        for key in ('resourceCode', 'inputMaterialOpenV2COs', 'processPlanOpenCOs', 'useBomFlag'):
            self.assertNotIn(key, self.req.payload)
        self.assertEqual(self.calls, [])

    def test_missing_approval_cannot_acquire_credentials_or_send(self):
        with override_settings(MES_CREATE_DIAGNOSTIC_APPROVAL=None), \
                patch('mes_oauth.app_tokens.get_existing_app_access_token') as app:
            with self.assertRaises(WorkflowConflict): self.execute_fixture()
        app.assert_not_called(); self.assertEqual(self.operations, []); self.assertEqual(self.calls, [])

    def test_exact_approval_scope_expiry_and_booleans(self):
        changes = [{'max_attempts': 2}, {'max_attempts': True}, {'actor_id': 19},
            {'mes_user_id': int(d.MES_USER_ID)}, {'code': 'OTHER'}, {'request_uid': 'OTHER'},
            {'payload_digest': '0'*64}, {'accept_unknown_common_automation': False},
            {'preserve_draft': False}, {'origin': 'https://v3-hw.blacklake.cn'},
            {'read_scope': 'all'}, {'expires_at': (timezone.now()+timedelta(hours=1)).isoformat()},
            {'expires_at': (timezone.now()-timedelta(seconds=1)).isoformat()}]
        for changeset in changes:
            with self.subTest(changeset=changeset), override_settings(MES_CREATE_DIAGNOSTIC_APPROVAL={**self.approval, **changeset}):
                with self.assertRaises(WorkflowConflict): self.execute_fixture()
        self.assertEqual(self.calls, [])

    def test_payload_or_actor_change_rejected(self):
        self.req.payload['outputMaterialOpenCOs'][0]['plannedAmount'] = '2'
        self.req.save(update_fields=['payload'])
        with self.assertRaises(WorkflowConflict): self.execute_fixture()
        self.assertEqual(self.operations, [])

    def test_existing_only_app_supply_failure_before_any_reservation(self):
        from mes_oauth.app_tokens import AppCredentialUnavailable
        with patch('mes_oauth.app_tokens.get_existing_app_access_token', side_effect=AppCredentialUnavailable('unavailable')) as app:
            with self.assertRaises(AppCredentialUnavailable):
                d.run_for_session(self.req.uid, self.session, sender=self.sender)
        app.assert_called_once(); self.req.refresh_from_db()
        self.assertEqual((self.req.state,self.req.attempt), ('prepared',0)); self.assertEqual(self.calls, [])

    def test_one_creation_then_reads_with_exact_17_digit_id(self):
        result = self.execute_fixture()
        self.assertEqual(result['state'], 'draft_observed')
        self.assertEqual(result['work_order_id'], WORK_ID)
        self.assertEqual((result['status'],result['quantity'],result['unit_name']),(0,'1','个'))
        self.assertEqual(result['planned_start'],'2026-10-10T00:00:00+00:00')
        self.assertIsNone(result['actual_started_at'])
        self.assertFalse(result['global_or_delayed_effects_verified'])
        self.assertFalse(result['reported_and_inbound_totals_verified'])
        self.assertFalse(result['full_material_workflow_verified'])
        self.assertEqual(self.operations, ['read', 'save', 'read'])
        self.assertEqual(sum(route==d.CREATE_PATH for route,_ in self.calls),1)
        with self.assertRaises(WorkflowConflict): self.execute_fixture()
        self.req.refresh_from_db(); self.assertEqual(self.req.attempt,1)

    def test_timeout_survives_broker_rollback_and_read_only_recovery(self):
        self.timeout = True
        self.assertEqual(self.execute_fixture()['state'], 'uncertain')
        self.req.refresh_from_db(); self.assertEqual((self.req.state,self.req.attempt), ('uncertain',1))
        with self.assertRaises(WorkflowConflict): self.execute_fixture()
        with override_settings(MES_CREATE_DIAGNOSTIC_APPROVAL=None):
            self.assertEqual(self.execute_fixture(read_only=True)['state'], 'draft_observed')
        self.assertEqual(sum(route==d.CREATE_PATH for route,_ in self.calls),1)

    def test_process_restart_reservation_remains_fenced(self):
        transport = d.DiagnosticTransport(self.credential, sender=self.sender)
        baseline = transport.baseline()
        d.reserve(self.req,d.reviewed_permit(self.req),baseline)
        with self.assertRaises(WorkflowConflict): self.execute_fixture()
        # A lookup with no record is unresolved, never permission to resend.
        self.assertEqual(self.execute_fixture(read_only=True)['state'],'readback_pending')
        self.assertFalse(any(route==d.CREATE_PATH for route,_ in self.calls))

    def test_permission_denial_preflight_has_no_write_or_fallback(self):
        self.denied = d.READ_ROUTES['inventory']
        with self.assertRaises(d.PlanTransportError): self.execute_fixture()
        self.req.refresh_from_db(); self.assertEqual(self.req.attempt,0)
        self.assertEqual(len(self.calls),2); self.assertFalse(self.created)

    def test_code_appears_between_baseline_and_write_does_not_import_or_retry(self):
        reads=0
        def racing(url,**kwargs):
            nonlocal reads
            if url.endswith(d.READ_ROUTES['orders']):
                reads+=1
                if reads==2:self.created=True  # Another actor's intervening import.
            return self.sender(url,**kwargs)
        self.assertEqual(self.execute_fixture(sender=racing)['state'],'uncertain')
        self.assertFalse(any(route==d.CREATE_PATH for route,_ in self.calls))
        with self.assertRaises(WorkflowConflict):self.execute_fixture()
        self.req.refresh_from_db();self.assertEqual(self.req.attempt,1)

    def test_permission_denial_after_ack_preserves_id_and_never_resends(self):
        self.denied = d.READ_ROUTES['tasks']
        result=self.execute_fixture()
        self.assertEqual(result['state'],'readback_pending'); self.assertEqual(result['work_order_id'],WORK_ID)
        self.assertEqual(result['blocker'],'permission_required'); self.assertFalse(result['effects_verified'])
        with self.assertRaises(WorkflowConflict): self.execute_fixture()
        self.assertEqual(sum(route==d.CREATE_PATH for route,_ in self.calls),1)

    def test_unexpected_task_or_stock_or_qc_changes_require_review(self):
        self.assertEqual(self.execute_fixture()['state'],'draft_observed')
        self.tasks=[{'id':17000000000000008,'workOrderId':int(WORK_ID),'workOrderCode':d.CODE}]
        self.assertEqual(self.execute_fixture(read_only=True)['state'],'review')
        self.tasks=[]
        self.inventory=[{'id':17000000000000009,'material':{'id':int(d.MATERIAL_ID)},'amount':{'amount':1}}]
        self.assertTrue(self.execute_fixture(read_only=True)['inventory_changed'])
        self.inventory=[]
        self.qc=[{'id':17000000000000010,'materialId':int(d.MATERIAL_ID),'checkType':{'code':6}}]
        self.assertTrue(self.execute_fixture(read_only=True)['qc_changed'])
        self.qc=[]
        self.assertEqual(self.execute_fixture(read_only=True)['state'],'review')
        self.assertEqual(sum(route==d.CREATE_PATH for route,_ in self.calls),1)

    def test_all_direction_change_log_requires_review_and_has_bounded_window(self):
        self.assertEqual(self.execute_fixture()['state'],'draft_observed')
        self.changes=[{'id':17000000000000012,'createdAt':int(time.time()*1000),
            'material':{'id':int(d.MATERIAL_ID)},'action':{'action':'out'},'amount':{'direction':False}}]
        result=self.execute_fixture(read_only=True)
        self.assertEqual((result['state'],result['inventory_change_count']),('review',1))
        self.assertFalse(result['global_or_delayed_effects_verified'])
        self.changes[0]['createdAt']=1
        self.assertIn('blocker',self.execute_fixture(read_only=True))

    def test_partial_success_and_weak_confirmation_leave_one_attempt_uncertain(self):
        def partial(url,**kwargs):
            if url.endswith(d.CREATE_PATH):
                self.calls.append((d.CREATE_PATH,{}));self.created=True
                return response(envelope({'id':int(WORK_ID),'failAmount':1,'failResults':[{'code':'error'}]}))
            return self.sender(url,**kwargs)
        self.assertEqual(self.execute_fixture(sender=partial)['state'],'uncertain')
        with self.assertRaises(WorkflowConflict):self.execute_fixture()
        self.assertEqual(self.execute_fixture(read_only=True)['state'],'draft_observed')

    def test_read_only_prepared_request_and_wrong_session_rejected_before_provider(self):
        with self.assertRaises(WorkflowConflict):self.execute_fixture(read_only=True)
        foreign=InspectionSession(19,'SYNTHETIC-session',timezone.now()+timedelta(minutes=5),{})
        with self.assertRaises(WorkflowConflict):d.run_for_session(self.req.uid,foreign,provider=object(),sender=self.sender)
        self.assertEqual(self.operations,[])

    def test_inherited_setup_actual_start_or_missing_fields_never_claim_clean_draft(self):
        self.assertEqual(self.execute_fixture()['state'],'draft_observed')
        for key, value in [('bomId',17000000000000011),('resource',{}),('actualStartTime',d.PAYLOAD['planStartTime'])]:
            self.base[key]=value
            self.assertEqual(self.execute_fixture(read_only=True)['state'],'review')
            self.base[key]=None
        self.base.pop('bomId')
        self.assertEqual(self.execute_fixture(read_only=True)['state'],'review')

    def test_changed_status_quantity_and_provider_defaults_are_reported_for_review(self):
        self.assertEqual(self.execute_fixture()['state'],'draft_observed')
        self.base['status']={'code':2};self.output['plannedAmount']['amount']=2
        self.output['autoWarehousingFlag']='1'
        result=self.execute_fixture(read_only=True)
        self.assertEqual((result['state'],result['status'],result['quantity']),('review',2,'2'))
        self.assertEqual(result['provider_defaults_observed']['output.autoWarehousingFlag'],'1')

    def test_provider_clock_changed_or_ack_id_mismatch_stays_pending(self):
        bases=0
        def changing(url,**kwargs):
            nonlocal bases
            if url.endswith(d.READ_ROUTES['base']):
                bases+=1
                if bases==2:self.base['updatedAt']+=1
            return self.sender(url,**kwargs)
        self.assertEqual(self.execute_fixture(sender=changing)['state'],'readback_pending')
        self.req.refresh_from_db(); self.req.mes_id='17000000000000008'; self.req.save(update_fields=['mes_id'])
        self.assertEqual(self.execute_fixture(read_only=True)['state'],'readback_pending')

    def test_partial_pages_hidden_fields_and_float_ids_not_zero(self):
        for body in ({'code':403}, envelope(None), envelope({'list':[],'page':1,'total':1}),
                envelope({'list':[],'page':True,'total':0}),
                {**page([]),'fieldPermission':{'noAccess':['id']}}):
            with self.subTest(body=body), self.assertRaises(Exception):d.complete_page(body)
        for value in (float(WORK_ID), True, None):
            with self.assertRaises(Exception):d.identifier(value)

    def test_direct_write_and_broad_read_routes_are_rejected(self):
        sender=Mock()
        transport=d.DiagnosticTransport(self.credential,sender=sender)
        for action,payload in [('create',d.PAYLOAD),('qc',{}),('tasks',{}),('base',d.read_request(d.CODE,WORK_ID)),('dispatch',{})]:
            with self.assertRaises(WorkflowConflict):transport.post(action,payload)
        sender.assert_not_called()

    def test_approval_change_after_committed_reservation_cannot_send(self):
        baseline=d.DiagnosticTransport(self.credential,sender=self.sender).baseline()
        permit=d.reviewed_permit(self.req); d.reserve(self.req,permit,baseline)
        with override_settings(MES_CREATE_DIAGNOSTIC_APPROVAL={**self.approval,'reference':'changed'}):
            with self.assertRaises(WorkflowConflict):
                d.DiagnosticTransport(self.credential,sender=self.sender).post('create',self.req.payload,req=self.req,permit=permit)
        self.assertFalse(self.created); self.req.refresh_from_db();self.assertEqual(self.req.attempt,1)

    def test_postgres_two_reservations_allow_only_one_attempt(self):
        if connection.vendor!='postgresql':self.skipTest('PostgreSQL concurrency check')
        baseline=d.DiagnosticTransport(self.credential,sender=self.sender).baseline()
        permit=d.reviewed_permit(self.req)
        barrier=threading.Barrier(2); outcomes=[]
        def worker():
            close_old_connections()
            try:
                req=MesCreateDiagnostic.objects.get(pk=self.req.pk);barrier.wait(timeout=5)
                try:d.reserve(req,permit,baseline);outcomes.append('reserved')
                except WorkflowConflict:outcomes.append('blocked')
            finally:close_old_connections()
        threads=[threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:thread.start()
        for thread in threads:thread.join(timeout=10)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertCountEqual(outcomes,['reserved','blocked'])
        self.req.refresh_from_db();self.assertEqual(self.req.attempt,1)
        self.assertEqual(self.req.events.filter(state='sending').count(),1)
