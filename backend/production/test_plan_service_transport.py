"""General plan dispatch with disposable WJ data and synthetic APP transport.

The fixtures exercise actual material approval and persisted preparation. No
MES credentials, OAuth sessions, production settings or network are used.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
import json
from threading import Barrier
from types import SimpleNamespace
from unittest import skipUnless
from unittest.mock import Mock, patch

from django.contrib.auth import get_user_model
from django.db import connection, connections, transaction
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APIClient

from .mes_execution_contract import encode_exact_json, parse_json_exact
from .models import (PlanMaterialApproval, PlanMesRequest, PlanMesRequestEvent, PlanWorkflowLock,
    PlanWorkOrder, PlanWorkRevision, ProductionPlan)
from .plan_workflow import preview, replace_uploaded_plans, snapshot
from .test_plan_workflow import approval_data, new_plan, seed_catalog


URL = '/api/production/plan-workflow/'
SCOPE = {'start': '2026-10-08', 'end': '2026-10-08', 'plan_type': 'injection'}
WORK_ID = '17000000000000007'
APP_TOKEN = 'SYNTHETIC-SERVICE-APP-ONLY'
APP_REFRESHED = 'SYNTHETIC-SERVICE-APP-REFRESHED'
ORIGIN = 'https://v3-ali.blacklake.cn'
ROUTE_BASE = '/api/openapi/domain/web/v1/route'
# ALI response observed before the 2026-10-10 M1 trial (no order data or secrets).
MISSING_ORDER = {'code': 200066, 'message': '未找到生产工单{0}',
    'subCode': 'MED-DOMAIN/WORK_ORDER_BASE_WORK_ORDER_NOT_FOUND',
    'data': None, 'needCheck': 0, 'fieldPermission': None}


def synthetic_response(value, *, status=200):
    return SimpleNamespace(status_code=status, history=[], content=encode_exact_json(value))


class PlanServiceAppIsolationTests(SimpleTestCase):
    def test_shared_service_app_never_uses_an_environment_user_token_cached_user_or_user_code(self):
        from inventory import mes
        values = {mes.APP_TOKEN_CACHE_KEY: APP_TOKEN,
            mes.USER_TOKEN_CACHE_KEY: 'SYNTHETIC-CACHED-USER-NOT-FOR-SERVICE',
            mes.TOKEN_EXPIRES_KEY: 1_000_000}
        with patch.object(mes, 'ACCESS_TOKEN_ENV', 'SYNTHETIC-ENV-USER-NOT-FOR-SERVICE'), \
                patch.object(mes, 'USER_CODE', 'SYNTHETIC-USER-CODE-NOT-FOR-SERVICE'), \
                patch.object(mes.cache, 'get', side_effect=values.get) as cached, \
                patch.object(mes.time, 'time', return_value=1000), \
                patch.object(mes, 'fetch_app_token', return_value=APP_REFRESHED) as app, \
                patch.object(mes, 'fetch_user_token', side_effect=AssertionError('USER exchange forbidden')) as user:
            self.assertEqual(mes.get_app_access_token(), APP_TOKEN)
            app.assert_not_called()
            self.assertEqual(mes.get_app_access_token(force_refresh=True), APP_REFRESHED)
            app.assert_called_once_with()
            user.assert_not_called()
        self.assertNotIn(mes.USER_TOKEN_CACHE_KEY, [call.args[0] for call in cached.call_args_list])

    def test_missing_service_app_cache_obtains_only_an_app_token(self):
        from inventory import mes
        with patch.object(mes.cache, 'get', return_value=None), \
                patch.object(mes, 'fetch_app_token', return_value=APP_TOKEN) as app, \
                patch.object(mes, 'fetch_user_token', side_effect=AssertionError('USER exchange forbidden')) as user:
            self.assertEqual(mes.get_app_access_token(), APP_TOKEN)
            app.assert_called_once_with()
            user.assert_not_called()


class PlanServiceFixture:
    def setUp(self):
        super().setUp()
        self.user = get_user_model().objects.create_user(
            username='SYNTHETIC-service-plan-editor', is_staff=True, is_superuser=True)
        self.other = get_user_model().objects.create_user(
            username='SYNTHETIC-service-plan-other', is_staff=True, is_superuser=True)
        self.api = APIClient()
        self.api.force_authenticate(self.user)
        self.catalog = seed_catalog()
        for kind in ('injection', 'machining'):
            PlanWorkflowLock.objects.get_or_create(plan_type=kind)
        self.plan = new_plan(quantity=1000.0, actor=self.user)
        self.calls = []
        self.token_requests = []
        self.created_codes = set()
        self.existing_rows = {}
        self.scripts = {}
        self.create_body = {'code': 200, 'needCheck': 0, 'data': {'id': int(WORK_ID)}}
        network = patch('requests.sessions.Session.request',
            side_effect=AssertionError('Synthetic service-plan tests forbid network.'))
        self.network = network.start()
        self.addCleanup(network.stop)
        self.addCleanup(self.network.assert_not_called)

    def action(self, action, **fields):
        return self.api.post(URL, {**SCOPE, 'action': action, **fields}, format='json')

    def approve(self, plan=None, **changes):
        plan = plan or self.plan
        data = {**approval_data(plan), **changes}
        result = self.action('approve', plan_id=plan.pk, **data)
        self.assertEqual(result.status_code, 201, result.data)
        return PlanMaterialApproval.objects.get(pk=result.data['approval_id'])

    def prepare(self, plan=None):
        plan = plan or self.plan
        groups = preview(date(2026, 10, 8), date(2026, 10, 8), 'injection')
        group = next(row for row in groups if str(plan.work_uid) in row['members'])
        response = self.action('prepare', keys=[group['key']])
        self.assertEqual(response.status_code, 200, response.data)
        item = response.data['results'][0]
        self.assertIn('uid', item, item)
        self.req = PlanMesRequest.objects.select_related('work_order').get(uid=item['uid'])
        return self.req

    def token_provider(self, *, force_refresh=False):
        self.token_requests.append(force_refresh)
        return APP_REFRESHED if force_refresh else APP_TOKEN

    def service(self, *, actor=None, sender=None):
        from .plan_service_transport import PlanMesServiceTransport
        return PlanMesServiceTransport(origin=ORIGIN, actor_id=(actor or self.user).pk,
            token_provider=self.token_provider, sender=sender or self.sender)

    def sender(self, url, **kwargs):
        from .plan_service_transport import LIST_PATH, BASE_PATH
        from .plan_workflow_contract import CREATE_PATH
        self.assertFalse(kwargs['allow_redirects'])
        self.assertEqual(kwargs['headers']['Content-Type'], 'application/json')
        path = url.removeprefix(ORIGIN + ROUTE_BASE)
        payload = parse_json_exact(kwargs['data'])
        token = kwargs['params']['access_token']
        self.assertIn(token, (APP_TOKEN, APP_REFRESHED))
        self.calls.append({'path': path, 'payload': payload, 'token': token})
        script = self.scripts.get(path, [])
        if script:
            value = script.pop(0)
            if isinstance(value, Exception):
                raise value
            if value is not None:
                return value
        if path == CREATE_PATH:
            req = PlanMesRequest.objects.select_related('work_order').get(work_order__code=payload['code'])
            self.assertFalse(connection.in_atomic_block)
            self.assertEqual((req.state, req.attempt), ('sending', 1))
            self.assertEqual(payload, req.contract['payload'])
            self.created_codes.add(payload['code'])
            return synthetic_response(self.create_body)
        if path == LIST_PATH:
            code = payload['exactWorkOrderCode']
            self.assertEqual(payload, {'exactWorkOrderCode': code, 'page': 1, 'size': 25})
            rows = self.existing_rows.get(code, [{'workOrderCode': code, 'workOrderId': int(WORK_ID)}]
                if code in self.created_codes else [])
            return synthetic_response({'code': 200, 'needCheck': 0,
                'data': {'list': rows, 'total': len(rows), 'page': 1}})
        self.assertEqual(path, BASE_PATH)
        code = payload['workOrderCode']
        self.assertEqual(payload, {'workOrderCode': code, 'workOrderId': int(WORK_ID), 'warehouseFlag': False})
        req = PlanMesRequest.objects.select_related('work_order').get(work_order__code=code)
        return synthetic_response(self.detail(req))

    def paths(self):
        return [call['path'] for call in self.calls]

    def dispatch(self, req=None, *, transport=None):
        from .plan_service_transport import dispatch_service_create
        return dispatch_service_create((req or self.req).uid, transport or self.service())

    def recheck(self, req=None, *, transport=None):
        from .plan_service_transport import recheck_service_creation
        return recheck_service_creation((req or self.req).uid, transport or self.service())

    def detail(self, req=None):
        req = req or self.req
        payload = req.contract['payload']
        return {'code': 200, 'needCheck': 0, 'data': {
            'id': int(WORK_ID), 'code': req.work_order.code,
            'identifier': payload['identifier'], 'externalOrderCode': payload['externalOrderCode'],
            'plannedStartTime': payload['planStartTime'], 'plannedFinishTime': payload['planFinishTime'],
            'updatedAt': payload['planStartTime'], 'actualStartTime': None,
            'specifiedMaterial': 1, 'status': {'code': 1},
            'resource': {'code': req.intent['setup']['resource_code']},
        }, 'fieldPermission': {'noAccess': []}}

    def change_plan_quantity(self, quantity):
        fields = {name: getattr(self.plan, name) for name in snapshot(self.plan)}
        fields['planned_quantity'] = quantity
        with transaction.atomic():
            replace_uploaded_plans([ProductionPlan(**fields)], [date(2026, 10, 8)],
                'injection', self.user)
        return ProductionPlan.objects.get(work_uid=self.plan.work_uid)

    def assert_no_transport(self):
        self.assertEqual(self.calls, [])
        self.assertEqual(self.token_requests, [])
        self.network.assert_not_called()

    def assert_private(self, value):
        encoded = json.dumps(value, default=str)
        self.assertNotIn(APP_TOKEN, encoded)
        self.assertNotIn(APP_REFRESHED, encoded)
        for key in ('access_token', 'appAccessToken', 'ciphertext', 'userAccessToken'):
            self.assertNotIn('"' + key + '"', encoded)


@override_settings(MES_PLAN_REVIEWED_CONTRACT=None)
class PlanServicePersistenceTests(PlanServiceFixture, TransactionTestCase):
    def test_approved_inputs_build_a_normal_contract_without_tenant_review_or_setup_fingerprints(self):
        self.approve()
        req = self.prepare()
        self.assertEqual(req.blockers, [])
        self.assertEqual(req.contract['readback_scope'], 'base_creation')
        payload = req.contract['payload']
        self.assertEqual(payload['status'], 1)
        self.assertEqual(payload['useBomFlag'], 0)
        self.assertEqual(payload['processPlanOpenCOs'][0]['reportFlag'], 1)
        self.assertEqual(payload['inputMaterialOpenV2COs'][0]['materialCode'], 'SYNTHETIC-RM')
        self.assertEqual(payload['inputMaterialOpenV2COs'][0]['subInputAmountNumerator'], '0.02')
        self.assertEqual(payload['outputMaterialOpenCOs'][0]['materialCode'], 'SYNTHETIC-PART')
        self.assertEqual(payload['outputMaterialOpenCOs'][0]['unitName'], '个')
        self.assertEqual(payload['inputMaterialOpenV2COs'][0]['version'], 'V1')
        self.assertEqual(payload['outputMaterialOpenCOs'][0]['version'], 'V1')
        self.assert_no_transport()

    def test_unversioned_materials_can_be_approved_and_prepared_without_invented_versions(self):
        self.catalog.payload[0]['material']['version'] = None
        self.catalog.save(update_fields=['payload'])
        data = approval_data(self.plan)
        data['inputs'][0]['material_version'] = ''
        approval = self.approve(inputs=data['inputs'], output_version=None)
        self.assertEqual(approval.snapshot['output_version'], '')
        self.assertEqual(approval.snapshot['inputs'][0]['material_version'], '')
        payload = self.prepare().contract['payload']
        self.assertNotIn('version', payload['inputMaterialOpenV2COs'][0])
        self.assertNotIn('version', payload['outputMaterialOpenCOs'][0])
        self.assertEqual(payload['inputMaterialOpenV2COs'][0]['subInputAmountNumerator'], '0.02')
        self.assert_no_transport()

    def test_blank_input_version_preserves_a_version_from_the_selected_mes_catalog(self):
        data = approval_data(self.plan)
        data['inputs'][0]['material_version'] = ''
        approval = self.approve(inputs=data['inputs'])
        self.assertEqual(approval.snapshot['inputs'][0]['material_version'], 'V1')
        self.assertEqual(self.prepare().contract['payload']['inputMaterialOpenV2COs'][0]['version'], 'V1')
        self.assert_no_transport()

    def test_optional_versions_still_reject_invalid_types_and_placeholder_values(self):
        for value in (False, 0, [], {}, '-', 'x' * 256):
            for field in ('input', 'output'):
                with self.subTest(value=value, field=field):
                    data = approval_data(self.plan)
                    if field == 'input': data['inputs'][0]['material_version'] = value
                    else: data['output_version'] = value
                    result = self.action('approve', plan_id=self.plan.pk, **data)
                    self.assertEqual(result.status_code, 400, result.data)
        self.assertFalse(PlanMaterialApproval.objects.exists())
        self.assert_no_transport()


@override_settings(MES_PLAN_REVIEWED_CONTRACT=None, MES_PLAN_WRITES_ENABLED=True)
class PlanServiceDispatchTests(PlanServiceFixture, TransactionTestCase):
    def setUp(self):
        super().setUp()
        self.approve()
        self.prepare()

    def test_disabled_writer_never_obtains_app_looks_up_imports_or_changes_attempt(self):
        with override_settings(MES_PLAN_WRITES_ENABLED=False):
            transport = self.service()
            from .plan_service_transport import dispatch_service_create
            from .plan_workflow import WorkflowConflict
            with self.assertRaises(WorkflowConflict):
                dispatch_service_create(self.req.uid, transport)
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('disabled', 0))
        self.assert_no_transport()

    def test_normal_absent_lookup_import_and_base_detail_preserve_exact_id_and_scope(self):
        from .plan_service_transport import LIST_PATH, BASE_PATH
        from .plan_workflow_contract import CREATE_PATH
        result = self.dispatch()
        self.assertEqual(result['state'], 'created')
        self.assertEqual(result['uid'], str(self.req.uid))
        self.assertEqual(result['work_order_code'], self.req.work_order.code)
        self.assertEqual(result['mes_id'], WORK_ID)
        self.assertEqual(self.paths(), [LIST_PATH, CREATE_PATH, LIST_PATH, BASE_PATH])
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)
        self.assertEqual(self.req.work_order.mes_id, WORK_ID)
        self.assertIs(self.req.work_order.observation_complete, False)
        self.assertIsNone(self.req.work_order.observed_at)
        self.assert_private(result)

    def test_existing_exact_matching_order_is_read_without_import_or_send_attempt(self):
        from .plan_service_transport import LIST_PATH, BASE_PATH
        from .plan_workflow_contract import CREATE_PATH
        self.existing_rows[self.req.work_order.code] = [
            {'workOrderCode': self.req.work_order.code, 'workOrderId': int(WORK_ID)}]
        result = self.dispatch()
        self.assertEqual(result['state'], 'already_exists')
        self.assertEqual(result['mes_id'], WORK_ID)
        self.assertEqual(self.paths(), [LIST_PATH, BASE_PATH])
        self.assertNotIn(CREATE_PATH, self.paths())
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)
        self.assertEqual(self.req.work_order.mes_id, WORK_ID)

    def test_import_timeout_is_recovered_by_code_query_without_retransmission(self):
        from .plan_workflow_contract import CREATE_PATH
        original_sender = self.sender
        def timeout_after_remote_acceptance(url, **kwargs):
            response = original_sender(url, **kwargs)
            if url.endswith(CREATE_PATH):
                raise TimeoutError('SYNTHETIC private access_token=' + APP_TOKEN)
            return response
        result = self.dispatch(transport=self.service(sender=timeout_after_remote_acceptance))
        self.assertEqual(result['state'], 'created')
        self.assertEqual(result['mes_id'], WORK_ID)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)
        self.assert_private(result)
        from .plan_workflow import WorkflowConflict
        before = len(self.calls)
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assertEqual(len(self.calls), before)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_unresolved_import_timeout_requires_read_only_recheck_and_never_imports_again(self):
        from .plan_workflow_contract import CREATE_PATH
        self.scripts[CREATE_PATH] = [TimeoutError('SYNTHETIC private access_token=' + APP_TOKEN)]
        result = self.dispatch()
        self.assertEqual(result['state'], 'uncertain')
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        before = len(self.calls)
        from .plan_workflow import WorkflowConflict
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assertEqual(len(self.calls), before)
        self.existing_rows[self.req.work_order.code] = [
            {'workOrderCode': self.req.work_order.code, 'workOrderId': WORK_ID}]
        recovered = self.recheck()
        self.assertEqual(recovered['state'], 'created')
        self.assertEqual(recovered['mes_id'], WORK_ID)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)

    def test_need_check_one_is_not_accepted_as_success_or_retransmitted(self):
        from .plan_workflow_contract import CREATE_PATH
        self.create_body = {'code': 200, 'needCheck': 1, 'data': {'id': int(WORK_ID)}}
        result = self.dispatch()
        self.assertEqual(result['state'], 'review')
        self.assertIn('write_confirmation_required', result['blockers'])
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)

    def test_documented_success_without_need_check_is_accepted(self):
        # The documented import ACK need not carry data or a work-order ID.
        self.create_body = {'code': 200}
        result = self.dispatch()
        self.assertEqual(result['state'], 'created')
        self.assertEqual(result['mes_id'], WORK_ID)

    def test_observed_missing_order_and_null_success_envelopes_create_once_with_readback(self):
        from .plan_service_transport import LIST_PATH, BASE_PATH
        from .plan_workflow_contract import CREATE_PATH
        from .plan_workflow import WorkflowConflict
        original_sender = self.sender

        def observed_envelopes(url, **kwargs):
            response = original_sender(url, **kwargs)
            body = parse_json_exact(response.content)
            if url.endswith(LIST_PATH) and body['data']['total'] == 0:
                # Live ALI errors omit data and fieldPermission altogether.
                return synthetic_response({key: value for key, value in MISSING_ORDER.items()
                    if key not in ('data', 'fieldPermission')})
            return synthetic_response({**body, 'needCheck': None})

        result = self.dispatch(transport=self.service(sender=observed_envelopes))
        self.assertEqual((result['state'], result['mes_id']), ('created', WORK_ID))
        self.assertEqual(self.paths(), [LIST_PATH, CREATE_PATH, LIST_PATH, BASE_PATH])
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_explicit_null_missing_order_is_also_absent(self):
        transport = self.service(sender=Mock(return_value=synthetic_response(MISSING_ORDER)))
        self.assertIsNone(transport.find_by_code('SYNTHETIC'))

    def test_similar_missing_order_errors_never_authorize_import(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow_contract import CREATE_PATH
        cases = [
            {**MISSING_ORDER, 'code': 3500060},
            {**MISSING_ORDER, 'code': '200066'},
            {**MISSING_ORDER, 'subCode': 'OTHER_NOT_FOUND'},
            {**MISSING_ORDER, 'data': {}},
            *[{**MISSING_ORDER, 'data': value} for value in ([], '', 0, False)],
            *[{**MISSING_ORDER, 'needCheck': value} for value in (None, 1, False, '0')],
            {**MISSING_ORDER, 'fieldPermission': {'noAccess': ['workOrderCode']}},
            {**MISSING_ORDER, 'fieldPermission': []},
        ]
        for body in cases:
            with self.subTest(body=body):
                self.scripts[LIST_PATH] = [synthetic_response(body)]
                result = self.dispatch()
                self.assertEqual(result['state'], 'failed')
                self.assertNotIn(CREATE_PATH, self.paths())
                self.req.refresh_from_db()
                self.assertEqual(self.req.attempt, 0)

    def test_missing_order_envelope_is_rejected_outside_exact_list_lookup(self):
        from .plan_service_transport import LIST_PATH, BASE_PATH
        from .plan_workflow_contract import CREATE_PATH
        from .plan_workflow_transport import PlanTransportError
        for path, payload in ((BASE_PATH, {'workOrderCode': 'SYNTHETIC'}),
                (CREATE_PATH, {'code': 'SYNTHETIC'}),
                (LIST_PATH, {'workOrderCode': 'SYNTHETIC'}),
                (LIST_PATH, {'exactWorkOrderCode': ' '})):
            with self.subTest(path=path, payload=payload):
                transport = self.service(sender=Mock(return_value=synthetic_response(MISSING_ORDER)))
                with self.assertRaises(PlanTransportError):
                    transport._post(path, payload, write=path == CREATE_PATH)

    def test_null_need_check_does_not_relax_http_or_field_permissions(self):
        from .plan_service_transport import _body
        from .plan_workflow_transport import PlanTransportError
        for status in (401, 403, 500):
            with self.subTest(status=status), self.assertRaises(PlanTransportError):
                _body(synthetic_response({'code': 200, 'needCheck': None}, status=status))
        with self.assertRaises(PlanTransportError):
            _body(synthetic_response({'code': 200, 'needCheck': None,
                'fieldPermission': {'noAccess': ['id']}}))
        for value in (False, True, '0', 1, -1):
            with self.subTest(needCheck=value), self.assertRaises(PlanTransportError):
                _body(synthetic_response({'code': 200, 'needCheck': value}))

    def test_http_401_refreshes_only_service_app_once_then_uses_it_for_import_and_reads(self):
        from .plan_service_transport import LIST_PATH
        self.scripts[LIST_PATH] = [synthetic_response({'code': 401}, status=401)]
        result = self.dispatch()
        self.assertEqual(result['state'], 'created')
        self.assertEqual(self.token_requests.count(True), 1)
        self.assertEqual(self.calls[0]['token'], APP_TOKEN)
        self.assertTrue(all(call['token'] == APP_REFRESHED for call in self.calls[1:]))

    def test_body_401_refreshes_only_service_app_once(self):
        from .plan_service_transport import LIST_PATH
        self.scripts[LIST_PATH] = [synthetic_response({'code': 401})]
        self.assertEqual(self.dispatch()['state'], 'created')
        self.assertEqual(self.token_requests.count(True), 1)

    def test_repeated_401_stops_without_import_and_keeps_preflight_retry_separate_from_send_attempt(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow_contract import CREATE_PATH
        self.scripts[LIST_PATH] = [synthetic_response({'code': 401}, status=401),
            synthetic_response({'code': 401})]
        result = self.dispatch()
        self.assertEqual(result['state'], 'failed')
        self.assertEqual(self.token_requests.count(True), 1)
        self.assertEqual(self.paths(), [LIST_PATH, LIST_PATH])
        self.assertNotIn(CREATE_PATH, self.paths())
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)
        retry = self.dispatch()
        self.assertEqual(retry['state'], 'created')
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_ambiguous_exact_code_lookup_never_imports(self):
        from .plan_workflow_contract import CREATE_PATH
        self.existing_rows[self.req.work_order.code] = [
            {'workOrderCode': self.req.work_order.code, 'workOrderId': int(WORK_ID)},
            {'workOrderCode': self.req.work_order.code, 'workOrderId': int(WORK_ID) + 1}]
        result = self.dispatch()
        self.assertIn(result['state'], ('review', 'failed'))
        self.assertNotIn(CREATE_PATH, self.paths())
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)

    def test_changed_plan_version_is_rejected_before_any_app_or_mes_io(self):
        from .plan_workflow import WorkflowConflict
        changed = self.change_plan_quantity(2000)
        self.assertEqual(changed.work_uid, self.plan.work_uid)
        self.assertEqual(changed.work_version, 2)
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assert_no_transport()
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)

    def test_reapproved_material_snapshot_is_rejected_before_any_app_or_mes_io(self):
        from .plan_workflow import WorkflowConflict
        data = approval_data(self.plan)
        data['inputs'][0]['numerator'] = '0.04'
        self.approve(inputs=data['inputs'])
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assert_no_transport()
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)

    def test_another_authorized_editor_preserves_preparer_and_records_actual_dispatch_actor(self):
        result = self.dispatch(transport=self.service(actor=self.other))
        self.assertEqual(result['state'], 'created')
        self.req.refresh_from_db()
        self.assertEqual(self.req.actor_id, self.user.pk)
        for event in self.req.events.filter(state__in=('checking', 'sending', 'created')):
            self.assertEqual(event.evidence['actor_id'], self.other.pk)
            if event.state in ('checking', 'sending'):
                self.assertEqual(event.evidence['authentication'], 'service_app')
            else:
                self.assertEqual(event.evidence['verified_scope'], 'base_creation')
                self.assertIs(event.evidence['material_assignment_verified'], False)
                self.assertIs(event.evidence['production_totals_verified'], False)
        self.assertEqual(self.req.attempt, 1)

    def test_inactive_dispatch_actor_cannot_use_app_or_mes(self):
        from .plan_workflow import WorkflowConflict
        self.other.is_active = False
        self.other.save(update_fields=['is_active'])
        with self.assertRaises(WorkflowConflict):
            self.dispatch(transport=self.service(actor=self.other))
        self.assert_no_transport()
        self.req.refresh_from_db()
        self.assertEqual(self.req.actor_id, self.user.pk)
        self.assertEqual(self.req.attempt, 0)

    def test_request_remains_reserved_during_preflight_and_a_duplicate_dispatch_has_zero_io(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow import WorkflowConflict
        sender = self.sender
        checked = []
        def while_checking(url, **kwargs):
            if url.endswith(LIST_PATH) and not checked:
                req = PlanMesRequest.objects.get(pk=self.req.pk)
                self.assertFalse(connection.in_atomic_block)
                self.assertEqual((req.state, req.attempt), ('checking', 0))
                before = (len(self.calls), len(self.token_requests))
                with self.assertRaises(WorkflowConflict):
                    self.dispatch()
                self.assertEqual((len(self.calls), len(self.token_requests)), before)
                checked.append(True)
            return sender(url, **kwargs)
        self.assertEqual(self.dispatch(transport=self.service(sender=while_checking))['state'], 'created')
        self.assertEqual(checked, [True])

    def test_plan_changed_between_absent_lookup_and_import_cannot_be_sent(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow_contract import CREATE_PATH
        sender = self.sender
        def change_after_lookup(url, **kwargs):
            response = sender(url, **kwargs)
            if url.endswith(LIST_PATH):
                self.change_plan_quantity(2000.0)
            return response
        result = self.dispatch(transport=self.service(sender=change_after_lookup))
        self.assertEqual(result['state'], 'failed')
        self.assertNotIn(CREATE_PATH, self.paths())
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)

    def test_matching_code_with_mismatched_base_times_requires_review_and_never_imports(self):
        from .plan_service_transport import BASE_PATH
        from .plan_workflow_contract import CREATE_PATH
        self.existing_rows[self.req.work_order.code] = [
            {'workOrderCode': self.req.work_order.code, 'workOrderId': int(WORK_ID)}]
        body = self.detail()
        body['data']['plannedFinishTime'] += 3_600_000
        self.scripts[BASE_PATH] = [synthetic_response(body)]
        result = self.dispatch()
        self.assertEqual(result['state'], 'review')
        self.assertIn('existing_code_snapshot_mismatch', result['blockers'])
        self.assertNotIn(CREATE_PATH, self.paths())
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)

    def test_permission_rejection_after_import_is_terminal_for_resend_and_does_not_claim_success(self):
        from .plan_workflow_contract import CREATE_PATH
        from .plan_workflow import WorkflowConflict
        self.scripts[CREATE_PATH] = [synthetic_response(
            {'code': 403, 'subCode': 'URL_NO_PERMISSION', 'message': APP_TOKEN}, status=403)]
        result = self.dispatch()
        self.assertEqual(result['state'], 'failed')
        self.assertIn('permission_required', result['blockers'])
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.assert_private(result)
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assertEqual(self.paths().count(CREATE_PATH), 1)

    def test_partial_batch_preserves_each_order_attempt_without_rolling_back_its_successful_peer(self):
        from .plan_service_transport import dispatch_service_batch
        from .plan_workflow_contract import CREATE_PATH
        first = self.req
        second_plan = new_plan(quantity=1000.0, machine='imm02', actor=self.user)
        self.approve(second_plan, resource_code='SYNTHETIC-IMM02')
        second = self.prepare(second_plan)
        self.scripts[CREATE_PATH] = [TimeoutError('SYNTHETIC response lost')]
        results = dispatch_service_batch([str(first.pk), str(second.pk)], lambda uid: self.service())
        self.assertEqual([(item['uid'], item['state']) for item in results],
            [(str(first.pk), 'uncertain'), (str(second.pk), 'created')])
        self.assertEqual(self.paths().count(CREATE_PATH), 2)
        first.refresh_from_db()
        second.refresh_from_db()
        self.assertEqual((first.attempt, second.attempt), (1, 1))
        self.assertEqual(first.work_order.mes_id, '')
        self.assertEqual(second.work_order.mes_id, WORK_ID)
        self.assertTrue(first.events.filter(state='uncertain').exists())
        self.assertTrue(second.events.filter(state='created').exists())
        self.assert_private(results)

    def test_duplicate_batch_uids_are_rejected_before_transport_factory_or_app(self):
        from .plan_service_transport import dispatch_service_batch
        from .plan_workflow import WorkflowConflict
        factory = Mock(side_effect=AssertionError('Duplicate batch must not instantiate transport'))
        with self.assertRaises(WorkflowConflict):
            dispatch_service_batch([str(self.req.pk), str(self.req.pk)], factory)
        factory.assert_not_called()
        self.assert_no_transport()

    def test_four_request_batch_is_rejected_before_factory_or_persisted_attempts(self):
        from uuid import uuid4
        from .plan_service_transport import dispatch_service_batch, CREATE_REQUEST_LIMIT
        from .plan_workflow import WorkflowConflict
        self.assertEqual(CREATE_REQUEST_LIMIT, 3)
        selected = [str(self.req.uid), *[str(uuid4()) for _ in range(3)]]
        factory = Mock(side_effect=AssertionError('Oversized batch must not obtain a transport'))
        events = self.req.events.count()
        with self.assertRaises(WorkflowConflict):
            dispatch_service_batch(selected, factory)
        factory.assert_not_called()
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('disabled', 0))
        self.assertEqual(self.req.events.count(), events)
        self.assert_no_transport()

    def test_http_send_four_requests_rejects_entire_batch_before_transport(self):
        from uuid import uuid4
        selected = [str(self.req.uid), *[str(uuid4()) for _ in range(3)]]
        events = self.req.events.count()
        with patch('production.plan_workflow_views.PlanMesServiceTransport',
                side_effect=AssertionError('Oversized HTTP batch must not obtain service APP')) as factory:
            response = self.action('send', request_uids=selected)
        self.assertEqual(response.status_code, 409, response.data)
        factory.assert_not_called()
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('disabled', 0))
        self.assertEqual(self.req.events.count(), events)
        self.assert_no_transport()

    def test_http_send_accepts_three_approved_requests_at_the_boundary(self):
        selected = [self.req]
        for index in (2, 3):
            plan = new_plan(quantity=1000.0, machine=f'imm0{index}', actor=self.user)
            self.approve(plan, resource_code=f'SYNTHETIC-IMM0{index}')
            selected.append(self.prepare(plan))
        with patch('production.plan_workflow_views.PlanMesServiceTransport',
                side_effect=lambda *, actor_id: self.service()) as factory:
            response = self.action('send', request_uids=[str(req.uid) for req in selected])
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(factory.call_count, 3)
        self.assertEqual([row['state'] for row in response.data['results']], ['created'] * 3)
        for req in selected:
            req.refresh_from_db()
            self.assertEqual((req.state, req.attempt), ('created', 1))
        from .plan_workflow_contract import CREATE_PATH
        self.assertEqual(self.paths().count(CREATE_PATH), 3)

    def test_incomplete_or_wrong_exact_code_lookup_cannot_be_interpreted_as_absence(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow_contract import CREATE_PATH
        code = self.req.work_order.code
        cases = [
            {'list': [], 'page': 1},
            {'list': [], 'total': 1, 'page': 1},
            {'list': [], 'total': 0, 'page': 2},
            {'list': [], 'total': False, 'page': 1},
            {'list': [{'workOrderCode': code + '-OTHER', 'workOrderId': int(WORK_ID)}], 'total': 1, 'page': 1},
            {'list': [{'workOrderCode': code, 'workOrderId': True}], 'total': 1, 'page': 1},
            {'list': [{'workOrderCode': code, 'workOrderId': float(WORK_ID)}], 'total': 1, 'page': 1},
        ]
        for case in cases:
            with self.subTest(data=case):
                # External JSON may contain a rounded floating-point ID. Use
                # raw provider bytes here; our own exact encoder forbids it.
                self.scripts[LIST_PATH] = [SimpleNamespace(status_code=200, history=[],
                    content=json.dumps({'code': 200, 'data': case}).encode())]
                result = self.dispatch()
                self.assertEqual(result['state'], 'failed')
                self.assertNotIn(CREATE_PATH, self.paths())
                self.req.refresh_from_db()
                self.assertEqual(self.req.attempt, 0)

    def test_no_second_app_refresh_is_allowed_when_import_rejects_after_lookup_already_refreshed(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow_contract import CREATE_PATH
        self.scripts[LIST_PATH] = [synthetic_response({'code': 401})]
        self.scripts[CREATE_PATH] = [synthetic_response({'code': 401}, status=401)]
        result = self.dispatch()
        self.assertEqual(result['state'], 'failed')
        self.assertIn('app_authentication_rejected', result['blockers'])
        self.assertEqual(self.token_requests.count(True), 1)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)

    def test_explicit_import_401_refreshes_once_and_success_keeps_one_durable_create_attempt(self):
        from .plan_workflow_contract import CREATE_PATH
        self.scripts[CREATE_PATH] = [synthetic_response({'code': 401}, status=401)]
        result = self.dispatch()
        self.assertEqual(result['state'], 'created')
        imports = [call for call in self.calls if call['path'] == CREATE_PATH]
        self.assertEqual(len(imports), 2)
        self.assertEqual(imports[0]['payload'], imports[1]['payload'])
        self.assertEqual([call['token'] for call in imports], [APP_TOKEN, APP_REFRESHED])
        self.assertEqual(self.token_requests.count(True), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)
        self.assertEqual(self.req.events.filter(state='sending').count(), 1)

    def test_second_import_401_stops_after_one_app_refresh_without_code_recovery_or_resend(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow_contract import CREATE_PATH
        from .plan_workflow import WorkflowConflict
        self.scripts[CREATE_PATH] = [synthetic_response({'code': 401}, status=401),
            synthetic_response({'code': 401})]
        result = self.dispatch()
        self.assertEqual(result['state'], 'failed')
        self.assertIn('app_authentication_rejected', result['blockers'])
        self.assertEqual(self.paths(), [LIST_PATH, CREATE_PATH, CREATE_PATH])
        self.assertEqual(self.token_requests.count(True), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)
        self.assertEqual(self.req.events.filter(state='sending').count(), 1)
        before = len(self.calls)
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assertEqual(len(self.calls), before)

    def test_http_send_off_blocks_before_the_service_transport_is_instantiated(self):
        with override_settings(MES_PLAN_WRITES_ENABLED=False), \
                patch('production.plan_workflow_views.PlanMesServiceTransport',
                    side_effect=AssertionError('OFF send must not construct service transport')) as factory:
            result = self.action('send', request_uids=[str(self.req.uid)])
        self.assertEqual(result.status_code, 409, result.data)
        self.assertIs(result.data['write_enabled'], False)
        factory.assert_not_called()
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('disabled', 0))
        self.assert_no_transport()

    def test_http_send_records_authenticated_dispatcher_and_rejects_client_actor_fields(self):
        self.api.force_authenticate(self.other)
        with patch('production.plan_workflow_views.PlanMesServiceTransport',
                side_effect=lambda *, actor_id: self.service(actor=get_user_model().objects.get(pk=actor_id))) as factory:
            rejected = self.action('send', request_uids=[str(self.req.uid)], actor_id=self.user.pk)
            self.assertEqual(rejected.status_code, 400, rejected.data)
            factory.assert_not_called()
            self.assert_no_transport()
            sent = self.action('send', request_uids=[str(self.req.uid)])
        self.assertEqual(sent.status_code, 200, sent.data)
        self.assertEqual(sent.data['results'][0]['state'], 'created')
        self.assertEqual(sent.data['results'][0]['mes_id'], WORK_ID)
        factory.assert_called_once_with(actor_id=self.other.pk)
        self.req.refresh_from_db()
        self.assertEqual(self.req.actor_id, self.user.pk)
        self.assertEqual(self.req.events.get(state='sending').evidence['actor_id'], self.other.pk)
        self.assert_private(sent.data)

    def test_http_send_request_outside_selected_dates_is_blocked_before_app_or_transport(self):
        with patch('production.plan_workflow_views.PlanMesServiceTransport',
                side_effect=AssertionError('Out-of-scope request must not obtain transport')) as factory:
            result = self.action('send', start='2026-10-09', end='2026-10-09',
                request_uids=[str(self.req.uid)])
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data['results'][0]['state'], 'blocked')
        factory.assert_not_called()
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 0)
        self.assert_no_transport()

    def test_http_recheck_uses_the_same_service_path_without_any_second_import(self):
        from .plan_workflow_contract import CREATE_PATH
        self.scripts[CREATE_PATH] = [TimeoutError('SYNTHETIC response lost')]
        self.assertEqual(self.dispatch()['state'], 'uncertain')
        self.existing_rows[self.req.work_order.code] = [
            {'workOrderCode': self.req.work_order.code, 'workOrderId': WORK_ID}]
        with patch('production.plan_workflow_views.PlanMesServiceTransport',
                side_effect=lambda *, actor_id: self.service(actor=get_user_model().objects.get(pk=actor_id))) as factory:
            response = self.action('recheck', request_uid=str(self.req.uid))
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(response.data['state'], 'created')
        self.assertEqual(response.data['mes_id'], WORK_ID)
        factory.assert_called_once_with(actor_id=self.user.pk)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual(self.req.attempt, 1)

    def test_http_status_with_writer_on_is_read_only_and_does_not_start_a_prepared_request(self):
        before = list(PlanMesRequest.objects.values())
        events = list(PlanMesRequestEvent.objects.values())
        with patch('production.plan_workflow_views.PlanMesServiceTransport',
                side_effect=AssertionError('GET must not construct service transport')) as factory, \
                CaptureQueriesContext(connection) as queries:
            response = self.api.get(URL, SCOPE)
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIs(response.data['write_enabled'], True)
        self.assertEqual(response.data['requests'][0]['attempt'], 0)
        self.assertIs(response.data['requests'][0]['can_send'], True)
        self.assertEqual(list(PlanMesRequest.objects.values()), before)
        self.assertEqual(list(PlanMesRequestEvent.objects.values()), events)
        for query in queries:
            self.assertFalse(query['sql'].lstrip().upper().startswith(('INSERT ', 'UPDATE ', 'DELETE ')))
        factory.assert_not_called()
        self.assert_no_transport()

    def test_an_old_checking_generation_cannot_claim_import_or_overwrite_the_new_owner(self):
        from .plan_service_transport import _claim, _finish
        from .plan_workflow import WorkflowConflict
        transport = self.service()
        old = _claim(self.req.uid, self.user.pk)
        self.assertEqual(_finish(old, transport, 'failed', blockers=['SYNTHETIC lookup failed'])['state'],
            'failed')
        new = _claim(self.req.uid, self.other.pk)
        self.assertNotEqual(old._reservation_id, new._reservation_id)
        events = list(self.req.events.values())
        with self.assertRaises(WorkflowConflict):
            _claim(self.req.uid, self.user.pk, creation=True, reservation_id=old._reservation_id)
        result = _finish(old, transport, 'failed', blockers=['SYNTHETIC late old lookup'])
        self.assertEqual(result['state'], 'checking')
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('checking', 0))
        self.assertEqual(list(self.req.events.values()), events)
        sending = _claim(self.req.uid, self.other.pk, creation=True, reservation_id=new._reservation_id)
        self.assertEqual((sending.state, sending.attempt), ('sending', 1))
        events = list(self.req.events.values())
        self.assertEqual(_finish(old, transport, 'failed')['state'], 'sending')
        self.assertEqual(list(self.req.events.values()), events)
        self.assert_no_transport()

    def test_late_preflight_failure_cannot_clear_the_send_attempt_in_its_own_generation(self):
        from .plan_service_transport import _claim, _finish
        transport = self.service()
        preflight = _claim(self.req.uid, self.user.pk)
        _claim(self.req.uid, self.user.pk, creation=True, reservation_id=preflight._reservation_id)
        events = list(self.req.events.values())
        result = _finish(preflight, transport, 'failed', blockers=['SYNTHETIC late lookup'])
        self.assertEqual((result['state'], result['attempt']), ('sending', 1))
        self.assertEqual(list(self.req.events.values()), events)
        self.assert_no_transport()

    def test_late_public_recheck_cannot_overwrite_a_new_checking_generation(self):
        from .plan_service_transport import _claim, _finish, LIST_PATH
        original = _claim(self.req.uid, self.user.pk)
        sender = self.sender
        new_generation = []
        def recheck_after_retry(url, **kwargs):
            if url.endswith(LIST_PATH):
                _finish(original, self.service(), 'failed', blockers=['SYNTHETIC sibling fast lookup'])
                new = _claim(self.req.uid, self.other.pk)
                new_generation.append(new._reservation_id)
            return sender(url, **kwargs)
        result = self.recheck(transport=self.service(sender=recheck_after_retry))
        self.assertEqual(result['state'], 'checking')
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('checking', 0))
        latest = self.req.events.order_by('-id').first()
        self.assertEqual(latest.pk, new_generation[0])
        self.assertEqual(latest.evidence['actor_id'], self.other.pk)

    def test_invalid_http_recheck_uid_is_rejected_before_transport_or_app(self):
        with patch('production.plan_workflow_views.PlanMesServiceTransport',
                side_effect=AssertionError('Invalid request UID must not obtain transport')) as factory:
            response = self.action('recheck', request_uid='SYNTHETIC-invalid-uuid')
        self.assertEqual(response.status_code, 409, response.data)
        factory.assert_not_called()
        self.assert_no_transport()


@override_settings(MES_PLAN_REVIEWED_CONTRACT=None, MES_PLAN_WRITES_ENABLED=True)
class PlanServiceReprepareFenceTests(PlanServiceFixture, TransactionTestCase):
    def setUp(self):
        super().setUp()
        self.approve()
        self.prepare()

    def test_changed_plan_cannot_prepare_a_second_request_during_an_ongoing_lookup(self):
        from .plan_service_transport import LIST_PATH
        from .plan_workflow_contract import CREATE_PATH
        original_quantity = self.req.intent['quantity']
        sender = self.sender
        checked = []

        def change_during_lookup(url, **kwargs):
            if url.endswith(LIST_PATH) and not checked:
                current = PlanMesRequest.objects.get(pk=self.req.pk)
                self.assertEqual((current.state, current.attempt), ('checking', 0))
                changed = self.change_plan_quantity(2000.0)
                self.approve(changed)
                group = preview(date(2026, 10, 8), date(2026, 10, 8), 'injection')[0]
                self.assertIn('readback_required', group['blockers'])
                response = self.action('prepare', keys=[group['key']])
                self.assertEqual(response.status_code, 200, response.data)
                result = response.data['results'][0]
                self.assertEqual(result['state'], 'blocked')
                self.assertIn('readback_required', result['blockers'])
                self.assertNotIn('uid', result)
                self.assertEqual(PlanMesRequest.objects.count(), 1)
                self.assertEqual(PlanWorkOrder.objects.count(), 1)
                checked.append(True)
            return sender(url, **kwargs)

        result = self.dispatch(transport=self.service(sender=change_during_lookup))
        self.assertEqual(checked, [True])
        self.assertEqual(result['state'], 'failed')
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('failed', 0))
        self.assertEqual(self.req.intent['quantity'], original_quantity)
        self.assertEqual(self.req.work_order.approved_snapshot['quantity'], original_quantity)
        self.assertNotIn(CREATE_PATH, self.paths())

    def test_failed_import_attempt_blocks_changed_plan_repreparation_and_any_second_import(self):
        from .plan_workflow import WorkflowConflict
        from .plan_workflow_contract import CREATE_PATH
        original_quantity = self.req.intent['quantity']
        self.scripts[CREATE_PATH] = [synthetic_response({'code': 500})]
        result = self.dispatch()
        self.assertEqual(result['state'], 'failed')
        self.assertIn('provider_result_rejected', result['blockers'])
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('failed', 1))
        changed = self.change_plan_quantity(2000.0)
        self.approve(changed)
        group = preview(date(2026, 10, 8), date(2026, 10, 8), 'injection')[0]
        self.assertIn('readback_required', group['blockers'])
        response = self.action('prepare', keys=[group['key']])
        self.assertEqual(response.status_code, 200, response.data)
        blocked = response.data['results'][0]
        self.assertEqual(blocked['state'], 'blocked')
        self.assertIn('readback_required', blocked['blockers'])
        self.assertNotIn('uid', blocked)
        self.assertEqual(PlanMesRequest.objects.count(), 1)
        self.assertEqual(PlanWorkOrder.objects.count(), 1)
        before = (len(self.calls), len(self.token_requests))
        with self.assertRaises(WorkflowConflict):
            self.dispatch()
        self.assertEqual((len(self.calls), len(self.token_requests)), before)
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('failed', 1))
        self.assertEqual(self.req.intent['quantity'], original_quantity)
        self.assertEqual(self.req.work_order.approved_snapshot['quantity'], original_quantity)


@skipUnless(connection.vendor == 'postgresql', 'Requires disposable PostgreSQL row locks')
@override_settings(MES_PLAN_REVIEWED_CONTRACT=None, MES_PLAN_WRITES_ENABLED=True)
class PlanServiceConcurrencyTests(PlanServiceFixture, TransactionTestCase):
    def test_two_dispatchers_commit_one_import_attempt(self):
        from .plan_workflow import WorkflowConflict
        from .plan_workflow_contract import CREATE_PATH
        self.approve()
        self.prepare()
        barrier = Barrier(2)
        def dispatch():
            connections.close_all()
            try:
                barrier.wait(timeout=5)
                try:
                    return self.dispatch()['state']
                except WorkflowConflict:
                    return 'blocked'
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as executor:
            futures = [executor.submit(dispatch) for _ in range(2)]
            results = [future.result(timeout=15) for future in futures]
        self.assertEqual(sorted(results), ['blocked', 'created'])
        self.assertEqual(self.paths().count(CREATE_PATH), 1)
        self.req.refresh_from_db()
        self.assertEqual((self.req.state, self.req.attempt), ('created', 1))
        self.assertEqual(self.req.events.filter(state='sending').count(), 1)


@override_settings(MES_PLAN_REVIEWED_CONTRACT=None)
class PlanServiceHistoryTests(PlanServiceFixture, TransactionTestCase):
    def test_normal_approval_preparation_reuses_the_persisted_order_and_request(self):
        approval = self.approve()
        first = self.prepare()
        original = (first.uid, first.work_order_id, first.dedupe_key)
        response = self.action('prepare', keys=[preview(date(2026, 10, 8),
            date(2026, 10, 8), 'injection')[0]['key']])
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(PlanMesRequest.objects.count(), 1)
        self.assertEqual(PlanWorkOrder.objects.count(), 1)
        current = PlanMesRequest.objects.get()
        self.assertEqual((current.uid, current.work_order_id, current.dedupe_key), original)
        self.assertEqual(current.intent['approval_ids'], [approval.pk])
        self.assertEqual(current.actor_id, self.user.pk)
        self.assert_no_transport()

    def test_wj_revision_approval_and_preparation_keep_each_server_actor_despite_client_actor_fields(self):
        self.api.force_authenticate(self.other)
        approval = self.approve(actor=self.user.pk, actor_id=self.user.pk)
        preparer = get_user_model().objects.create_user(
            username='SYNTHETIC-service-plan-preparer', is_staff=True, is_superuser=True)
        self.api.force_authenticate(preparer)
        group = preview(date(2026, 10, 8), date(2026, 10, 8), 'injection')[0]
        result = self.action('prepare', keys=[group['key']], actor=self.user.pk, actor_id=self.user.pk)
        self.assertEqual(result.status_code, 200, result.data)
        req = PlanMesRequest.objects.get(uid=result.data['results'][0]['uid'])
        self.assertEqual(PlanWorkRevision.objects.get(work_id=self.plan.work_uid).actor_id, self.user.pk)
        self.assertEqual(approval.actor_id, self.other.pk)
        self.assertEqual(req.actor_id, preparer.pk)
        self.assert_no_transport()

    def test_get_does_not_prepare_send_or_enable_the_disabled_writer(self):
        self.approve()
        before = PlanMesRequestEvent.objects.count()
        with override_settings(MES_PLAN_WRITES_ENABLED=False), CaptureQueriesContext(connection) as queries:
            result = self.api.get(URL, SCOPE)
        self.assertEqual(result.status_code, 200, result.data)
        self.assertIs(result.data['write_enabled'], False)
        self.assertEqual(PlanMesRequestEvent.objects.count(), before)
        self.assertFalse(PlanMesRequest.objects.exists())
        self.assertFalse(PlanWorkOrder.objects.exists())
        for query in queries:
            self.assertFalse(query['sql'].lstrip().upper().startswith(('INSERT ', 'UPDATE ', 'DELETE ')))
        self.assert_no_transport()
