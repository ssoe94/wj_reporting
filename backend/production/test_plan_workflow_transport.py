"""Synthetic documented v2 responses; no provider or existing credentials."""
from copy import deepcopy
from datetime import date
from decimal import Decimal
from types import SimpleNamespace
from unittest.mock import Mock, patch
from datetime import datetime, timezone, timedelta
import time

from django.contrib.auth import get_user_model
from django.db import transaction
from django.test import TransactionTestCase, override_settings
from quality.inspection_transport import InspectionUserAccessToken, MesAuthenticationRejected
from .models import PlanWorkflowLock, PlanMesRequest, PlanWorkOrder, PlanMesRequestEvent
from .plan_workflow import (approve_materials, lock_type, prepare, preview, WorkflowConflict)
from .plan_workflow_transport import (PlanMesTransport, PlanTransportError, CREATE_PATH, ROUTE_BASE,
    dispatch_prepared_create, dispatch_prepared_batch, recheck_creation, recheck_creation_for_session)
from .plan_workflow_read_contract import READ_ROUTES
from .mes_execution_contract import encode_exact_json, parse_json_exact
from .test_plan_workflow import seed_catalog, new_plan, approval_data, reviewed

WORK_ID = '17000000000000007'


def response(value, *, status=200):
    return SimpleNamespace(status_code=status, history=[], content=encode_exact_json(value))


def bodies(req):
    intent, payload, binding = req.intent, req.contract['payload'], req.contract['readback_binding']
    setup = intent['setup']
    unit = {'unitId': int(setup['output_unit_id']), 'unitName': setup['output_unit_name']}
    values = {
        'base': {'id': int(WORK_ID), 'code': payload['code'], 'identifier': payload['identifier'],
            'externalOrderCode': payload['externalOrderCode'], 'plannedStartTime': payload['planStartTime'],
            'plannedFinishTime': payload['planFinishTime'], 'updatedAt': payload['planStartTime'],
            'actualStartTime': None, 'specifiedMaterial': 1, 'status': {'code': 1},
            'resource': {'id': int(binding['resource_id']), 'code': setup['resource_code']},
            'customFields': deepcopy(payload['customFields'])},
        'inputs': [{'materialId': int(row['material_id']), 'material': {'baseInfo': {'id': int(row['material_id']), 'code': row['material_code']}},
            'unitId': int(row['unit_id']), 'unitName': row['unit_name'], 'version': row['material_version'],
            'inputAmountNumerator': row['numerator'], 'inputAmountDenominator': row['denominator'],
            'inputProcessNum': setup['process_num'], 'specificProcessInput': 1, 'splitSopControlInput': 0,
            'lossRate': '0', 'workOrderAlternativePlan': None} for row in setup['inputs']],
        'outputs': [{'materialId': int(binding['output_material_id']), 'material': {'baseInfo': {'id': int(binding['output_material_id']), 'code': intent['part_no']}},
            **unit, 'version': setup['output_version'], 'main': 1,
            'plannedAmount': {**unit, 'amount': Decimal(intent['quantity'])},
            'outputProcessSimpleVO': {'processNum': setup['process_num']}, 'processRouteCode': setup['route_code'],
            'autoWarehousingFlag': binding['read_no_auto_warehousing'], 'warehousing': binding['read_manual_warehousing']}],
        'processes': {'enableSop': 0, 'originalProcessRoute': {'code': setup['route_code']}, 'relations': [],
            'processes': [{'processCode': setup['process_code'], 'processNum': setup['process_num'], 'reportFlag': 1}]}}
    return {key: {'code': 200, 'needCheck': 0, 'data': value, 'fieldPermission': {'noAccess': []}} for key, value in values.items()}


class PlanTransportTests(TransactionTestCase):
    def setUp(self):
        for kind in ('injection', 'machining'): PlanWorkflowLock.objects.get_or_create(plan_type=kind)
        self.user = get_user_model().objects.create_user(username='SYNTHETIC-transport', is_staff=True, is_superuser=True)
        seed_catalog()
        self.plan = new_plan(actor=self.user)
        with transaction.atomic():
            lock_type('injection');approve_materials(self.plan, approval_data(self.plan), self.user)
        self.groups = preview(date(2026,10,8), date(2026,10,8), 'injection')
        self.policy = reviewed(self.groups)
        override = override_settings(MES_PLAN_REVIEWED_CONTRACT=self.policy)
        override.enable();self.addCleanup(override.disable)
        prepared = prepare(date(2026,10,8), date(2026,10,8), 'injection', [self.groups[0]['key']], self.user)[0]
        self.req = PlanMesRequest.objects.get(uid=prepared['uid'])
        self.values = bodies(self.req)
        self.calls = []
        self.create_result = {'code': 200, 'needCheck': 0, 'data': {'id': int(WORK_ID)}}

    def sender(self, url, **kwargs):
        self.assertFalse(kwargs['allow_redirects'])
        self.assertIn('access_token', kwargs['params'])
        path = url.split(ROUTE_BASE)[1]
        payload = parse_json_exact(kwargs['data'])
        self.calls.append((path,payload))
        if path == CREATE_PATH:
            # At IO the reservation has committed, and sends the reviewed bytes.
            self.assertFalse(transaction.get_connection().in_atomic_block)
            req = PlanMesRequest.objects.get(uid=self.req.uid)
            self.assertEqual(req.state, 'sending')
            self.assertEqual(payload, self.req.contract['payload'])
            return response(self.create_result)
        action = next(key for key, route in READ_ROUTES.items() if route == path)
        self.assertEqual(payload['workOrderCode'], self.req.work_order.code)
        self.assertIs(payload['warehouseFlag'], False)
        if action != 'base': self.assertEqual(payload['workOrderId'], int(WORK_ID))
        return response(self.values[action])

    def transport(self, sender=None, **kwargs):
        return PlanMesTransport(origin='https://v3-ali.blacklake.cn', tenant='SYNTHETIC-TENANT',
            actor_id=kwargs.get('actor_id', self.user.pk), mes_user_id=17000000000000009,
            credential=InspectionUserAccessToken(kwargs.get('token','SYNTHETIC-ONLY'), time.time()+60, user_id=17000000000000009),
            sender=sender or self.sender)

    def send(self, transport=None):
        return dispatch_prepared_create(self.req.uid, transport or self.transport(), fixture=True)

    def trial_review(self):
        from .plan_workflow_trial import request_digest
        now = datetime.now(timezone.utc)
        return {'reference': 'SYNTHETIC-TRIAL-REVIEW', 'request_uid': str(self.req.uid),
            'request_digest': request_digest(self.req), 'actor_id': self.user.pk,
            'mes_user_id': 17000000000000009, 'origin': 'https://v3-ali.blacklake.cn',
            'tenant': 'SYNTHETIC-TENANT', 'approved_at': now.isoformat(),
            'expires_at': (now + timedelta(minutes=10)).isoformat(),
            'test_master_reference': 'SYNTHETIC-TEST-MASTERS', 'side_effect_reference': 'SYNTHETIC-NO-EFFECTS',
            'test_resource_code': self.req.intent['setup']['resource_code'],
            'test_product_code': self.req.intent['part_no'], 'quantity': self.req.intent['quantity'],
            'unit_id': self.req.intent['setup']['output_unit_id'],
            **{key: True for key in ('no_dispatch','no_start','no_stock_movement','no_backflush','no_inspections')}}

    def test_trial_permit_requires_exact_short_server_approval(self):
        from .plan_workflow_trial import reviewed_trial
        with override_settings(MES_PLAN_TRIAL_APPROVAL=None):
            with self.assertRaises(WorkflowConflict): reviewed_trial(self.req)
        for changes in ({'no_stock_movement': False}, {'actor_id': self.user.pk+1},
                {'quantity': '2000'}, {'unit_id': '17000000000000099'},
                {'test_master_reference': ''}, {'request_digest': '0'*64},
                {'expires_at': (datetime.now(timezone.utc)+timedelta(hours=1)).isoformat()},
                {'approved_at': (datetime.now(timezone.utc)-timedelta(minutes=15)).isoformat(),
                 'expires_at': (datetime.now(timezone.utc)-timedelta(minutes=5)).isoformat()}):
            with override_settings(MES_PLAN_TRIAL_APPROVAL={**self.trial_review(), **changes}):
                with self.assertRaises(WorkflowConflict): reviewed_trial(self.req)
        with override_settings(MES_PLAN_TRIAL_APPROVAL=self.trial_review()):
            self.assertTrue(reviewed_trial(self.req).current())
        self.assertEqual(self.calls, [])

    def run_trial(self, *, timeout=False, missing_app=False):
        from .plan_workflow_trial import dispatch_trial_create
        from mes_oauth.session_guard import InspectionSession
        from mes_oauth.app_tokens import AppCredentialUnavailable
        session = InspectionSession(self.user.pk, 'SYNTHETIC-digest',
            datetime.now(timezone.utc)+timedelta(minutes=20), {})
        credential = InspectionUserAccessToken('SYNTHETIC-TRIAL-ONLY',time.time()+120,
            user_id=17000000000000009)
        operations = []
        def broker(*args, **kwargs):
            self.assertTrue(kwargs['policy_check']())
            operations.append(kwargs['operation'])
            # Match the existing broker's credential/session lock transaction.
            with transaction.atomic():
                return kwargs['callback'](credential)
        def sender(url, **kwargs):
            path = url.split(ROUTE_BASE)[1]
            self.calls.append((path,parse_json_exact(kwargs['data'])))
            if path == CREATE_PATH:
                self.assertEqual(PlanMesRequest.objects.get(uid=self.req.uid).state,'sending')
                if timeout: raise TimeoutError('SYNTHETIC timeout')
                return response(self.create_result)
            action = next(key for key, route in READ_ROUTES.items() if route == path)
            return response(self.values[action])
        with override_settings(MES_PLAN_TRIAL_APPROVAL=self.trial_review(),
                MES_USER_OAUTH_ENABLED=True,MES_INSPECTION_ENABLED=True), \
            patch('mes_oauth.vault.policy',return_value=SimpleNamespace(tenant='SYNTHETIC-TENANT')), \
            patch('mes_oauth.vault.expected_user',return_value=17000000000000009), \
            patch('mes_oauth.pilot_scope.pilot_route_scope_required',return_value=False), \
            patch('mes_oauth.inspection_credentials.call_with_user_credential',side_effect=broker), \
            patch('mes_oauth.app_tokens.get_existing_app_access_token',side_effect=AppCredentialUnavailable()), \
            patch('mes_oauth.app_tokens.get_app_access_token') as issue:
            if missing_app:
                with self.assertRaises(AppCredentialUnavailable):
                    dispatch_trial_create(self.req.uid,session,sender=sender)
                result = None
            else:
                result = dispatch_trial_create(self.req.uid,session,provider_factory=lambda: object(),sender=sender)
                with self.assertRaises(WorkflowConflict):
                    dispatch_trial_create(self.req.uid,session,provider_factory=lambda: object(),sender=sender)
            issue.assert_not_called()
        return result, operations

    def test_trial_bridge_create_and_readback_once_without_issuance(self):
        result, operations = self.run_trial()
        self.assertEqual(result['state'],'confirmed')
        self.assertEqual(result['work_order_id'],WORK_ID)
        self.assertEqual(operations,['read','save'])
        self.assertEqual(len([path for path,_ in self.calls if path==CREATE_PATH]),1)
        self.req.refresh_from_db();self.assertEqual(self.req.attempt,1)
        self.assertTrue(self.req.events.filter(evidence__trial_reference='SYNTHETIC-TRIAL-REVIEW').exists())

    def test_trial_bridge_timeout_stays_fenced_and_missing_app_never_issues(self):
        result, _ = self.run_trial(missing_app=True)
        self.assertIsNone(result);self.assertEqual(self.calls,[])
        self.req.refresh_from_db();self.assertEqual(self.req.state,'disabled')
        result, operations = self.run_trial(timeout=True)
        self.assertEqual(result['state'],'uncertain')
        self.assertEqual(operations,['read','save'])
        self.req.refresh_from_db();self.assertEqual(self.req.state,'uncertain')
        self.assertEqual(self.req.attempt,1)

    def test_create_and_all_campaign_reads_confirm_only_creation_preserving_large_id(self):
        result = self.send()
        self.assertEqual(result['state'], 'confirmed');self.assertFalse(result['production_totals_verified'])
        self.assertEqual(result['work_order_id'], WORK_ID)
        self.assertEqual(len(self.calls), 6)
        self.assertEqual([row[0] for row in self.calls], [CREATE_PATH, READ_ROUTES['base'], READ_ROUTES['inputs'], READ_ROUTES['outputs'], READ_ROUTES['processes'], READ_ROUTES['base']])
        order = PlanWorkOrder.objects.get()
        self.assertEqual(order.mes_id, WORK_ID);self.assertFalse(order.observation_complete)
        self.assertIsNone(order.observed_at)
        self.assertTrue(PlanMesRequestEvent.objects.filter(request=self.req,evidence__scope='creation_snapshot').exists())
        with self.assertRaises(WorkflowConflict): self.send()
        self.assertEqual(sum(path==CREATE_PATH for path,_ in self.calls),1)

    def test_multiday_campaign_2300_readback_has_no_daily_window(self):
        for day,qty in ((9,1000),(10,300)):
            plan=new_plan(day=day,quantity=qty,actor=self.user)
            with transaction.atomic():
                lock_type('injection');approve_materials(plan,approval_data(plan),self.user)
        groups=preview(date(2026,10,8),date(2026,10,10),'injection')
        with override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(groups)):
            prepared=prepare(date(2026,10,8),date(2026,10,10),'injection',[groups[0]['key']],self.user)[0]
            self.req=PlanMesRequest.objects.get(uid=prepared['uid']);self.values=bodies(self.req)
            self.assertEqual(self.req.intent['quantity'],'2300.0')
            self.assertEqual(self.req.intent['planned_end'],'2026-10-11T08:00:00+08:00')
            self.assertEqual(self.send()['state'],'confirmed')
        for path,payload in self.calls[1:]:
            self.assertEqual(set(payload)-{'workOrderCode','workOrderId','warehouseFlag'},set())

    def test_production_gate_and_direct_post_cannot_send(self):
        transport=self.transport(sender=Mock())
        with self.assertRaises(WorkflowConflict): dispatch_prepared_create(self.req.uid,transport)
        with self.assertRaises(WorkflowConflict): transport.send_create(self.req.contract)
        with self.assertRaises(WorkflowConflict): transport._post(CREATE_PATH,self.req.contract['payload'])
        transport.sender.assert_not_called()
        self.req.refresh_from_db();self.assertEqual(self.req.state,'disabled')
        with override_settings(MES_PLAN_WRITES_ENABLED=True):
            with self.assertRaises(WorkflowConflict):dispatch_prepared_create(self.req.uid,transport)
            with self.assertRaises(WorkflowConflict):dispatch_prepared_batch([str(self.req.uid)],lambda _:transport)
        transport.sender.assert_not_called()

    def test_partial_batch_keeps_timeout_fenced_and_confirms_independent_order(self):
        first_uid=str(self.req.uid)
        plan=new_plan(machine='imm02',actor=self.user)
        values=approval_data(plan);values['resource_code']='SYNTHETIC-IMM02'
        with transaction.atomic():
            lock_type('injection');approve_materials(plan,values,self.user)
        groups=preview(date(2026,10,8),date(2026,10,8),'injection')
        with override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(groups)):
            selected=next(group for group in groups if group['machine_name']=='imm02')
            prepared=prepare(date(2026,10,8),date(2026,10,8),'injection',[selected['key']],self.user)[0]
            self.req=PlanMesRequest.objects.get(uid=prepared['uid']);self.values=bodies(self.req)
            timed_out=Mock(side_effect=TimeoutError())
            def factory(uid):return self.transport(sender=timed_out) if uid==first_uid else self.transport()
            results=dispatch_prepared_batch([first_uid,str(self.req.uid)],factory,fixture=True)
        self.assertEqual([item['state'] for item in results],['uncertain','confirmed'])
        self.assertEqual(PlanMesRequest.objects.get(uid=first_uid).state,'uncertain')
        self.assertEqual(timed_out.call_count,1)
        self.assertEqual(sum(path==CREATE_PATH for path,_ in self.calls),1)

    def test_no_network_for_duplicate_batch_or_disabled_gate(self):
        factory=Mock()
        with self.assertRaises(WorkflowConflict):dispatch_prepared_batch([str(self.req.uid)]*2,factory,fixture=True)
        with self.assertRaises(WorkflowConflict):dispatch_prepared_batch([str(self.req.uid)],factory)
        factory.assert_not_called()

    def test_non_synthetic_credentials_and_wrong_actor_are_rejected_before_claim(self):
        for kwargs in ({'token':'not-a-fixture'}, {'actor_id':self.user.pk+1}):
            transport=self.transport(sender=Mock(),**kwargs)
            with self.assertRaises(WorkflowConflict): self.send(transport)
            transport.sender.assert_not_called()
        self.req.refresh_from_db();self.assertEqual(self.req.attempt,0)

    def test_contract_change_fails_before_claim_and_can_prepare_new_version(self):
        self.policy['setup_bindings'][self.groups[0]['setup_fingerprint']]['mold_field']['fieldValue']={'code':'changed'}
        with self.assertRaises(WorkflowConflict): self.send()
        self.req.refresh_from_db();self.assertEqual(self.req.state,'disabled')
        group=preview(date(2026,10,8),date(2026,10,8),'injection')[0]
        self.assertEqual(group['operation'],'prepare')
        prepared=prepare(date(2026,10,8),date(2026,10,8),'injection',[group['key']],self.user)[0]
        self.assertNotEqual(str(self.req.uid),prepared['uid'])
        self.req.refresh_from_db();self.assertEqual(self.req.state,'superseded')
        self.assertEqual(PlanWorkOrder.objects.count(),1)

    def test_unreviewed_mapping_clock_or_tenant_enum_fails_closed(self):
        binding=self.policy['setup_bindings'][self.groups[0]['setup_fingerprint']]
        for key in ('resource_id','mold_field','base_clock_covers_children','read_no_auto_warehousing'):
            saved=binding.pop(key)
            with self.assertRaises(WorkflowConflict):self.send()
            binding[key]=saved
        self.assertEqual(self.calls,[])

    def test_timeout_readback_confirms_existing_code_without_second_create(self):
        sender=Mock(side_effect=TimeoutError())
        self.assertEqual(self.send(self.transport(sender=sender))['state'],'uncertain')
        with self.assertRaises(WorkflowConflict): self.send()
        result=recheck_creation(self.req.uid,self.transport())
        self.assertEqual(result['state'],'confirmed')
        self.assertEqual(len(self.calls),5)
        self.assertFalse(any(path==CREATE_PATH for path,_ in self.calls))

    def test_acknowledged_id_mismatch_stays_fenced_on_later_readback(self):
        self.create_result['data']['id']=17000000000000008
        self.assertEqual(self.send()['state'],'readback_pending')
        self.assertEqual(recheck_creation(self.req.uid,self.transport())['state'],'readback_pending')
        self.assertEqual(PlanWorkOrder.objects.get().mes_id,'')

    def test_wrong_bom_qty_unit_resource_or_route_never_confirms(self):
        changes=[('inputs',lambda d:d['data'][0].update(inputAmountNumerator='0.03')),
                 ('outputs',lambda d:d['data'][0]['plannedAmount'].update(amount=999)),
                 ('outputs',lambda d:d['data'][0].update(unitId=17000000000000008)),
                 ('base',lambda d:d['data']['resource'].update(code='OTHER')),
                 ('processes',lambda d:d['data']['processes'][0].update(processCode='OTHER'))]
        originals=deepcopy(self.values)
        changes[0][1](self.values[changes[0][0]])
        self.assertEqual(self.send()['state'],'readback_pending')
        for action,change in changes:
            self.values=deepcopy(originals);change(self.values[action])
            self.assertNotEqual(recheck_creation(self.req.uid,self.transport())['state'],'confirmed')
        self.values=originals
        self.assertEqual(recheck_creation(self.req.uid,self.transport())['state'],'confirmed')

    def test_partial_hidden_field_and_weak_control_responses_do_not_confirm(self):
        originals=deepcopy(self.values)
        self.values['inputs']['data']=[]
        self.assertEqual(self.send()['state'],'readback_pending')
        for body in ({'code':200,'needCheck':1,'data':[]}, {'code':200,'needCheck':0,'data':[], 'fieldPermission':{'noAccess':['materialId']}}):
            self.values=deepcopy(originals);self.values['inputs']=body
            self.assertNotEqual(recheck_creation(self.req.uid,self.transport())['state'],'confirmed')

    def test_missing_write_confirmation_is_uncertain_until_full_readback(self):
        self.create_result.pop('needCheck')
        self.assertEqual(self.send()['state'],'uncertain')
        self.assertEqual(len(self.calls),1)
        with self.assertRaises(WorkflowConflict):self.send()
        self.assertEqual(recheck_creation(self.req.uid,self.transport())['state'],'confirmed')

    def test_redirect_and_permission_are_not_retried(self):
        bad=response({'code':403},status=403)
        sender=Mock(return_value=bad)
        self.assertEqual(self.send(self.transport(sender=sender))['state'],'uncertain')
        self.assertEqual(sender.call_count,1)
        result=recheck_creation(self.req.uid,self.transport(sender=sender))
        self.assertIn('permission_required',result['blockers'])
        with self.assertRaises(WorkflowConflict):self.send()

    def test_redirect_is_uncertain_and_never_followed_or_retried(self):
        bad=response({'code':200},status=302);bad.history=[object()]
        sender=Mock(return_value=bad)
        self.assertEqual(self.send(self.transport(sender=sender))['state'],'uncertain')
        self.assertFalse(sender.call_args.kwargs['allow_redirects'])
        with self.assertRaises(WorkflowConflict):self.send()
        self.assertEqual(sender.call_count,1)

    def test_existing_user_broker_is_used_read_only_for_current_actor(self):
        from mes_oauth.session_guard import InspectionSession
        self.req.state='uncertain';self.req.save(update_fields=['state'])
        configuration=SimpleNamespace(tenant='SYNTHETIC-TENANT')
        session=InspectionSession(self.user.pk,'SYNTHETIC-digest',datetime.now(timezone.utc)+timedelta(minutes=5),{})
        credential=InspectionUserAccessToken('SYNTHETIC-ONLY',time.time()+60,user_id=17000000000000009)
        def broker(session_arg,**kwargs):
            self.assertIs(session_arg,session);self.assertEqual(kwargs['operation'],'read')
            self.assertTrue(kwargs['policy_check']())
            return kwargs['callback'](credential)
        with override_settings(MES_INSPECTION_ENABLED=True,MES_USER_OAUTH_ENABLED=True,
                MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn'), \
                patch('mes_oauth.vault.policy',return_value=configuration), \
                patch('mes_oauth.vault.expected_user',return_value=17000000000000009), \
                patch('mes_oauth.inspection_credentials.call_with_user_credential',side_effect=broker) as call:
            result=recheck_creation_for_session(self.req.uid,session,provider=object(),sender=self.sender)
        self.assertEqual(result['state'],'confirmed');self.assertEqual(call.call_count,1)
        self.assertFalse(any(path==CREATE_PATH for path,_ in self.calls))

    def test_foreign_actor_read_does_not_acquire_credentials(self):
        from mes_oauth.session_guard import InspectionSession
        session=InspectionSession(self.user.pk+1,'SYNTHETIC-digest',datetime.now(timezone.utc)+timedelta(minutes=5),{})
        with patch('mes_oauth.inspection_credentials.call_with_user_credential') as broker:
            result=recheck_creation_for_session(self.req.uid,session)
        self.assertIn('own_reviewed_creation_required',result['blockers']);broker.assert_not_called()

    def test_rejected_user_lease_propagates_to_existing_broker_without_replay(self):
        self.req.state='uncertain';self.req.save(update_fields=['state'])
        sender=Mock(return_value=response({'code':401},status=401))
        with self.assertRaises(MesAuthenticationRejected):recheck_creation(self.req.uid,self.transport(sender=sender))
        self.req.refresh_from_db();self.assertEqual(self.req.state,'uncertain')
        self.assertEqual(sender.call_count,1)

    def test_changed_provider_clock_and_extra_output_hold_readback(self):
        original=self.sender
        bases=0
        def sender(url,**kwargs):
            nonlocal bases
            if url.endswith(READ_ROUTES['base']):
                bases+=1
                if bases==2:self.values['base']['data']['updatedAt']+=1
            return original(url,**kwargs)
        self.assertEqual(self.send(self.transport(sender=sender))['state'],'readback_pending')
        self.values['outputs']['data'].append(deepcopy(self.values['outputs']['data'][0]))
        self.assertNotEqual(recheck_creation(self.req.uid,self.transport())['state'],'confirmed')

    def test_unknown_lookup_cannot_clear_timeout_or_authorize_replay(self):
        self.send(self.transport(sender=Mock(side_effect=TimeoutError())))
        result=recheck_creation(self.req.uid,self.transport(sender=Mock(return_value=response({'code':200,'data':None,'needCheck':0}))))
        self.assertEqual(result['state'],'uncertain')
        with self.assertRaises(WorkflowConflict):self.send()

    def test_actual_start_preserved_without_guessing_production_totals(self):
        self.values['base']['data']['actualStartTime']=self.req.contract['payload']['planStartTime']
        self.assertEqual(self.send()['state'],'confirmed')
        order=PlanWorkOrder.objects.get();self.assertIsNotNone(order.actual_started_at)
        self.assertEqual(order.reported_quantity,0);self.assertFalse(order.observation_complete)
