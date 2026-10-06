"""Synthetic full-stage contracts; no production credentials or provider traffic.

The real coordinator, decoder, credential vault and scoped transport are used.
Only identity HTTP and inspection HTTP are replaced with fabricated responses.
These tests are not live Blacklake mapping or operational acceptance evidence.
"""
from copy import deepcopy
from datetime import timedelta
from decimal import Decimal
import json
from types import SimpleNamespace
import uuid
from unittest.mock import Mock, patch

from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APITestCase

from mes_oauth import vault
from mes_oauth.identity import VerifiedUserContext
from mes_oauth.models import MESCredential, MESLoginSession
from mes_oauth.test_vault import APP_TOKEN, KEY_ONE, TOKEN, userinfo
from . import test_inspection_requests as helpers
from .inspection_adapter import MesContractUnavailable
from .inspection_blacklake_contract import ITEM_RECORD, TASK_DETAIL, TASK_FINISH
from .inspection_live_adapter import binding_digest, load_policy, records_digest
from .inspection_mes_stages import TEST_LABEL, get_stage_adapter
from .inspection_models import InspectionMesBinding, InspectionRequest
from .inspection_validation import digest
from .inspection_workflow import result_payload


class LiveInspectionAdapterTests(APITestCase):
    base_url = helpers.InspectionRequestContractTests.base_url
    make_user = helpers.InspectionRequestContractTests.make_user
    create_payload = helpers.InspectionRequestContractTests.create_payload
    draft_payload = helpers.InspectionRequestContractTests.draft_payload
    post = helpers.InspectionRequestContractTests.post
    create = helpers.InspectionRequestContractTests.create
    draft = helpers.InspectionRequestContractTests.draft
    action = helpers.InspectionRequestContractTests.action
    approved = helpers.InspectionRequestContractTests.approved

    def setUp(self):
        helpers.InspectionRequestContractTests.setUp(self)
        # Vault admission requires a real local login credential even when the
        # request workflow fixture authenticates the synthetic API directly.
        self.editor.set_password('SYNTHETIC-LOCAL-INSPECTION-PASSWORD')
        self.editor.is_staff = True
        self.editor.save(update_fields=['password', 'is_staff'])
        del self.editor._inspection_test_access_token
        self.instant = timezone.now()
        self.mes_user = int(self.mes_user_map[str(self.editor.pk)])
        self.data = self.approved()
        row = InspectionRequest.objects.get(pk=self.data['id'])
        row.quantity_mode = 'not_recorded'
        row.inspected_quantity = row.accepted_quantity = row.rejected_quantity = Decimal('0.000')
        row.require_evidence = False
        row.evidence = []
        row.inspection_items[0]['evidence_required'] = False
        row.measurements[0]['evidence_url'] = ''
        row.save()
        self.binding = InspectionMesBinding.objects.create(request=row, tenant='SYNTHETIC-TENANT',
            qc_id='91000000000000001', work_order_id='91000000000000002',
            reviewed_result_digest=digest(result_payload(row)), test_only=True,
            test_label=TEST_LABEL + ' / SYNTHETIC-LIVE-ADAPTER', contract={
                'production_task_id': '91000000000000003', 'equipment_id': '91000000000000004',
                'snapshot_id': '91000000000000005', 'actor_id': str(self.mes_user),
                'target_reference': 'SYNTHETIC-TARGET', 'mapping_reference': 'SYNTHETIC-MAPPING',
                'label_reference': 'SYNTHETIC-LABEL', 'side_effect_reference': 'SYNTHETIC-ISOLATION',
                'items': [{'local_item_id': 'dimension', 'config_row_id': '91000000000000007',
                    'write_item_id': '91000000000000008', 'group': 'SYNTHETIC-GROUP', 'seq': 1}]})
        self.configure_vault()
        self.session = helpers.inspection_session(self.editor)
        self.store_credential()
        self.calls = []
        self.identity = Mock(spec=['userinfo', 'exchange', 'refresh', 'fallback'])
        self.identity.userinfo.return_value = userinfo(self.mes_user)
        identity = patch('mes_oauth.inspection_credentials.BlacklakeUserOAuthClient', return_value=self.identity)
        identity.start()
        self.addCleanup(identity.stop)
        network = patch('requests.sessions.Session.request', side_effect=AssertionError('No live HTTP.'))
        self.network = network.start()
        self.addCleanup(network.stop)
        self.addCleanup(self.network.assert_not_called)
        fallback = patch('quality.inspection_transport.existing_runtime_token',
            side_effect=AssertionError('Inventory authentication is forbidden.'))
        self.fallback = fallback.start()
        self.addCleanup(fallback.stop)
        self.addCleanup(self.fallback.assert_not_called)
        self.source = self.raw_detail()
        self.contract = self.reviewed_contract()
        self.policy_settings = override_settings(MES_INSPECTION_ENABLED=True,
            MES_INSPECTION_CONTRACT=json.dumps(self.contract))
        self.policy_settings.enable()
        self.addCleanup(self.policy_settings.disable)
        self.on_detail = None
        self.write_error = None
        self.read_index = 0
        sender = patch('quality.inspection_live_adapter._user_sender', side_effect=self.send)
        sender.start()
        self.addCleanup(sender.stop)

    def configure_vault(self):
        configuration = override_settings(MES_USER_OAUTH_ENABLED=True,
            MES_USER_SESSION_BRIDGE_ENABLED=True, MES_USER_TOKEN_STORAGE_ENABLED=True,
            MES_USER_OAUTH_CALLBACK_ORIGIN='https://testserver',
            MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
            MES_USER_OAUTH_LAUNCH_URL='https://v3-ali.blacklake.cn/SYNTHETIC-REVIEWED-PAGE',
            MES_USER_OAUTH_REVIEW_REFERENCE='SYNTHETIC-NO-NETWORK-REVIEW',
            MES_USER_OAUTH_APP_ACCESS_TOKEN=APP_TOKEN,
            MES_USER_TOKEN_APP_ID='91000000000000009',
            MES_USER_TOKEN_TENANT_REFERENCE='SYNTHETIC-TENANT',
            MES_USER_TOKEN_POLICY_REFERENCE='SYNTHETIC-VAULT-POLICY',
            MES_USER_TOKEN_EXPIRY_MODE='relative_seconds',
            MES_USER_TOKEN_CONTRACT_REFERENCE='SYNTHETIC-EXPIRY',
            MES_USER_TOKEN_MAX_AGE_SECONDS=600, MES_USER_TOKEN_IDLE_SECONDS=180,
            MES_USER_TOKEN_CONSENT_SECONDS=900, MES_USER_TOKEN_SAFETY_SECONDS=30,
            MES_USER_TOKEN_KEYS=json.dumps({'fixture-v1': KEY_ONE}),
            MES_USER_TOKEN_ACTIVE_KEY_ID='fixture-v1',
            MES_USER_FRONTEND_ORIGIN='https://testserver',
            INSPECTION_PILOT_ENABLED=False, INSPECTION_PILOT_USER_IDS=[])
        configuration.enable()
        self.addCleanup(configuration.disable)

    def store_credential(self):
        with self.session.lock('submit', actor_id=self.editor.pk):
            pass
        login = MESLoginSession.objects.get(pk=self.session.login_digest)
        now = timezone.now()
        vault.store_context(self.editor.pk, self.session.login_digest,
            VerifiedUserContext(self.mes_user, TOKEN, 1200), request_started_at=now - timedelta(seconds=2),
            received_at=now - timedelta(seconds=1), login_revision=login.revision)

    def raw_detail(self):
        return {'code': 200, 'needCheck': 0, 'data': {
            'id': int(self.binding.qc_id), 'workOrder': {'id': int(self.binding.work_order_id)},
            'produceTask': {'id': int(self.binding.contract['production_task_id'])},
            'equipment': {'id': int(self.binding.contract['equipment_id'])},
            'executor': {'id': self.mes_user}, 'remark': self.binding.test_label,
            'checkType': {'code': 3}, 'status': {'code': 1}, 'inspectionResult': None, 'endTime': None,
            'qcConfig': {'snapshotId': int(self.binding.contract['snapshot_id']), 'checkType': {'code': 3},
                'recordSample': {'code': 2}, 'recordSummaryCount': {'code': 2},
                'materialBatchRecordType': {'code': 1}, 'sampleProcessMethod': {'code': 1},
                'qcConfigCheckItemList': [{'groupName': 'SYNTHETIC-GROUP',
                    'checkItemAppDetailVOS': [{'id': 91000000000000007}]}]}, 'checkItems': []}}

    def reviewed_contract(self):
        return {'reference': 'SYNTHETIC-SINGLE-TARGET', 'authority_reference': 'SYNTHETIC-AUTHORITY',
            'expires_at': (self.instant + timedelta(minutes=30)).isoformat(),
            'actor_id': self.editor.pk, 'mes_user_id': str(self.mes_user),
            'tenant': self.binding.tenant, 'origin': 'https://v3-ali.blacklake.cn',
            'request_id': str(self.binding.request_id), 'qc_id': self.binding.qc_id,
            'work_order_id': self.binding.work_order_id, 'binding_digest': binding_digest(self.binding),
            'initial_records_digest': records_digest([]),
            'detail_contract': {'reference': 'SYNTHETIC-DETAIL-CONTRACT',
                'lifecycle_codes': {'open': [1], 'completed': [2], 'approval_pending': [4],
                    'cancelled': [3], 'rejected': [5]}, 'verdict_codes': {'pass': 1, 'fail': 4},
                'executor_path': ['executor', 'id'], 'label_path': ['remark'],
                'check_type': 3, 'source_checks': [
                    {'path': ['qcConfig', 'recordSample', 'code'], 'equals': 2}]}}

    def send(self, url, *, params, data, headers, timeout, allow_redirects):
        self.assertEqual(params.keys(), {'access_token'})
        self.assertTrue(params['access_token'] == TOKEN)
        self.assertNotIn(TOKEN, url)
        self.assertFalse(allow_redirects)
        body = json.loads(data)
        route = next((path for path in (TASK_DETAIL, ITEM_RECORD, TASK_FINISH) if url.endswith(path)), None)
        self.assertIsNotNone(route)
        self.calls.append((route, body))
        if route == TASK_DETAIL:
            self.read_index += 1
            if self.on_detail:
                replacement = self.on_detail(self.read_index)
                if replacement is not None:
                    return replacement
            result = deepcopy(self.source)
        else:
            self.apply_write(route, body)
            if self.write_error:
                raise self.write_error
            result = {'code': 200, 'needCheck': 0, 'data': True}
        return SimpleNamespace(status_code=200, content=json.dumps(result).encode())

    def apply_write(self, route, body):
        if route == ITEM_RECORD:
            self.assertEqual(set(body), {'taskId', 'checkItems'})
            self.assertEqual(body['taskId'], int(self.binding.qc_id))
            self.assertEqual(body['checkItems'], [{'checkItemId': 91000000000000008,
                'groupName': 'SYNTHETIC-GROUP', 'seq': 1, 'result': '10.0'}])
            self.set_records('10.0')
        elif route == TASK_FINISH:
            self.assertEqual(body, {'id': int(self.binding.qc_id), 'status': 1})
            self.source['data'].update(status={'code': 2}, inspectionResult={'code': 1},
                endTime=int(timezone.now().timestamp() * 1000))
        else:
            self.fail('Unexpected write route.')

    def set_records(self, value):
        self.source['data']['checkItems'] = [{'groupName': 'SYNTHETIC-GROUP', 'qcTaskCheckItems': [{
            'qcConfigCheckItemId': 91000000000000007, 'seq': 1, 'result': value}]}]

    def writes(self):
        return [entry for entry in self.calls if entry[0] != TASK_DETAIL]

    def assert_private(self, response):
        self.assertNotIn(TOKEN, str(response.data))
        self.assertNotIn(APP_TOKEN, str(response.data))
        for name in ('exchange', 'refresh', 'fallback'):
            getattr(self.identity, name).assert_not_called()

    def test_policy_uses_real_integer_request_identity(self):
        policy = load_policy()
        self.assertTrue(policy.matches(self.binding))
        self.assertTrue(get_stage_adapter(user=self.editor, session=self.session).enabled)

    def test_real_vault_coordinator_transport_save_then_finish(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(saved.data['mes_workflow']['phase'], 'saved')
        self.assertTrue(saved.data['mes_workflow']['can_finish'])
        self.assertEqual(saved.data['mes_completion_status'], 'not_completed')
        self.assertEqual([path for path, _ in self.calls], [TASK_DETAIL, ITEM_RECORD, TASK_DETAIL])
        self.assertEqual(self.identity.userinfo.call_count, 3)
        finished = self.action(saved.data, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual(finished.data['mes_workflow']['phase'], 'completed')
        self.assertEqual(finished.data['mes_completion_status'], 'completed')
        self.assertEqual(finished.data['injection_receipt_readiness'], 'not_verified')
        self.assertEqual([path for path, _ in self.calls],
            [TASK_DETAIL, ITEM_RECORD, TASK_DETAIL, TASK_DETAIL, TASK_FINISH, TASK_DETAIL])
        self.assertEqual(self.identity.userinfo.call_count, 6)
        self.assertTrue(all(call.args == (TOKEN,) for call in self.identity.userinfo.call_args_list))
        self.assert_private(finished)

    def _pilot_manifest(self, *, single=False):
        row = InspectionRequest.objects.get(pk=self.binding.request_id)
        fields = ('tenant', 'qc_id', 'work_order_id', 'contract', 'reviewed_result_digest', 'test_label')
        binding = {name: deepcopy(getattr(self.binding, name)) for name in fields}
        provider = deepcopy(self.contract)
        if single:
            row.status, row.reviewed_by, row.reviewed_at, row.review_reason = 'submitted', None, None, ''
            row.save()
            provider['single_actor_test_reference'] = 'SYNTHETIC-OWNER-SINGLE-QC'
        self.binding.delete()
        return {'actor_id': self.editor.pk, 'request_id': row.pk, 'expected_version': row.version,
                'binding': binding, 'provider_contract': provider}

    def test_server_preparation_dry_run_then_single_actor_save_finish_projection(self):
        self._single_actor_save_finish_projection()

    def test_single_actor_ten_synthetic_items_save_read_finish_public_projection(self):
        self._single_actor_save_finish_projection(synthetic_items=10)

    def test_single_actor_sixteen_synthetic_items_save_read_finish_public_projection(self):
        self._single_actor_save_finish_projection(synthetic_items=16)

    def _single_actor_save_finish_projection(self, *, synthetic_items=0):
        from quality.inspection_pilot_preparation import prepare_pilot
        from quality.inspection_board_repository import read_persisted_board_source
        from quality.inspection_board_status import BoardScope, project_machine_quality
        from quality.inspection_models import InspectionAudit
        from production.inspection_status_projection import build_inspection_board_fields
        from production.test_inspection_status_projection import row as canonical_row
        from production.views import ProductionStatusView
        from rest_framework.test import APIRequestFactory
        now = timezone.now()
        production_row = canonical_row()
        production_row.update(planned_qty=100, actual_qty=40, progress_rate=40,
                              recent_60m_shots=10, is_running=True)
        production_row['parts'][0].update(estimated_qty=40, allocated_shots=20,
                                          status='in-progress')
        displayed_scope = build_inspection_board_fields(now.date(), production_row,
            plan_updated_at=now, now=now)['inspection_scope']
        scope = BoardScope(now.date(), 1, 70, displayed_scope['plan_version'])
        manifest = self._pilot_manifest(single=True)
        items = deepcopy(InspectionRequest.objects.get(pk=manifest['request_id']).inspection_items)
        measurements = [{'item_id': 'dimension', 'value': '10.0',
                         'judgement': 'pass', 'evidence_url': ''}]
        if synthetic_items:
            # Shape only: these values, bounds and IDs are fabricated and do
            # not describe or approve any production QC's specifications.
            shape = 'SIXTEEN' if synthetic_items == 16 else 'TEN'
            items = [{'id': f'SYNTHETIC-number-{index}', 'label': f'SYNTHETIC dimension {index}',
                'kind': 'number', 'unit': 'mm', 'minimum': '9.5', 'maximum': '10.5',
                'required': True, 'evidence_required': False} for index in range(1, 6)]
            items += [{'id': f'SYNTHETIC-choice-{index}', 'label': f'SYNTHETIC choice {index}',
                'kind': 'choice', 'options': ['合格', '不合格'],
                'required': index not in (2, 3) if synthetic_items == 16 else index <= 3,
                'evidence_required': False} for index in range(1, synthetic_items - 4)]
            measurements = [{'item_id': item['id'], 'value': '10.0' if item['kind'] == 'number' else '合格',
                'judgement': 'pass', 'evidence_url': ''} for item in items]
            manifest['binding'].update(qc_id='93000000000000011', work_order_id='93000000000000012',
                test_label=TEST_LABEL + f' / SYNTHETIC-{shape}-ITEMS-NOT-MEASURED')
            manifest['binding']['contract'].update(production_task_id='93000000000000013',
                equipment_id='93000000000000014', snapshot_id='93000000000000015',
                target_reference=f'SYNTHETIC-{shape}-ITEM-TARGET', mapping_reference=f'SYNTHETIC-{shape}-ITEM-MAPPING',
                label_reference=f'SYNTHETIC-{shape}-ITEM-LABEL', side_effect_reference='SYNTHETIC-NO-NETWORK')
            manifest['binding']['contract']['items'] = [
                {'local_item_id': item['id'], 'config_row_id': str(93000000000000100 + index),
                 'write_item_id': str(94000000000000100 + index),
                 'group': 'SYNTHETIC-NUMBER' if item['kind'] == 'number' else 'SYNTHETIC-CHOICE', 'seq': 1}
                for index, item in enumerate(items, start=1)]
            manifest['provider_contract'].update(qc_id=manifest['binding']['qc_id'],
                work_order_id=manifest['binding']['work_order_id'], reference=f'SYNTHETIC-{shape}-ITEM-QC')
        created = self.create(task_ref=f'SYNTHETIC-{shape}-ITEM-FLOW' if synthetic_items else 'SYNTHETIC-ONE-ACCOUNT-FLOW', quantity_mode='not_recorded',
                              require_evidence=False, inspection_items=items)
        entered = self.draft(created, inspected_quantity='0.000', accepted_quantity='0.000',
            rejected_quantity='0.000', evidence=[], measurements=measurements)
        if synthetic_items:
            self.assertEqual(len(entered['inspection_items']), synthetic_items)
            self.assertEqual(sum(item['kind'] == 'number' for item in entered['inspection_items']), 5)
            self.assertEqual(sum(item['kind'] == 'choice' for item in entered['inspection_items']), synthetic_items - 5)
            self.assertEqual(sum(item['required'] for item in entered['inspection_items']), synthetic_items - 2)
            if synthetic_items == 16:
                self.assertEqual([item['id'] for item in entered['inspection_items'] if not item['required']],
                                 ['SYNTHETIC-choice-2', 'SYNTHETIC-choice-3'])
            self.assertEqual(entered['measurements'], measurements)
        submitted = self.action(entered, 'submit')
        self.assertEqual(submitted.status_code, 200, submitted.data)
        row = InspectionRequest.objects.get(pk=created['id'])
        manifest['request_id'], manifest['expected_version'] = row.pk, row.version
        manifest['binding']['reviewed_result_digest'] = digest(result_payload(row))
        manifest['provider_contract']['request_id'] = str(row.pk)
        manifest['provider_contract']['binding_digest'] = binding_digest(
            InspectionMesBinding(request=row, test_only=True, **manifest['binding']))
        manifest['provider_contract']['board_binding'] = {
            'business_date': scope.business_date.isoformat(), 'machine_number': 1,
            'current_plan_id': 70, 'plan_version': scope.plan_version, 'generation': 1,
            'reference': 'SYNTHETIC-PLAN', 'valid_from': (now - timedelta(seconds=1)).isoformat(),
            'valid_until': manifest['provider_contract']['expires_at'], 'stale_after_seconds': 120}
        with override_settings(MES_INSPECTION_ENABLED=False):
            dry = prepare_pilot(manifest, allow_single_actor_test=True)
            self.assertTrue(dry['dry_run'])
            self.assertFalse(InspectionMesBinding.objects.exists())
            row = InspectionRequest.objects.get(pk=manifest['request_id'])
            self.assertEqual(row.status, 'submitted')
            result = prepare_pilot(manifest, apply=True, allow_single_actor_test=True)
            self.assertTrue(result['prepared'])
            self.assertFalse(get_stage_adapter().enabled)
        self.assertEqual(self.calls, [])
        self.identity.userinfo.assert_not_called()
        row.refresh_from_db()
        self.assertEqual(row.reviewed_by_id, self.editor.pk)
        self.assertEqual(row.review_reason, 'single_actor_test:SYNTHETIC-OWNER-SINGLE-QC')
        self.assertTrue(InspectionAudit.objects.filter(request=row, action='prepare_single_actor_test').exists())
        self.binding = InspectionMesBinding.objects.get(request=row)
        if synthetic_items:
            mappings = manifest['binding']['contract']['items']
            expected_rows = [{'checkItemId': int(item['write_item_id']), 'groupName': item['group'],
                'seq': 1, 'result': '10.0' if index < 5 else '合格'} for index, item in enumerate(mappings)]
            self.source = self.raw_detail()
            self.source['data']['qcConfig']['qcConfigCheckItemList'] = [
                {'groupName': group, 'checkItemAppDetailVOS': [
                    {'id': int(item['config_row_id'])} for item in mappings if item['group'] == group]}
                for group in ('SYNTHETIC-NUMBER', 'SYNTHETIC-CHOICE')]
            default_write = self.apply_write
            def apply_synthetic_item_write(route, body):
                if route != ITEM_RECORD:
                    return default_write(route, body)
                self.assertEqual(body, {'taskId': int(self.binding.qc_id), 'checkItems': expected_rows})
                self.assertEqual(len({row['checkItemId'] for row in body['checkItems']}), synthetic_items)
                self.source['data']['checkItems'] = [
                    {'groupName': group, 'qcTaskCheckItems': [
                        {'qcConfigCheckItemId': int(item['config_row_id']), 'seq': 1,
                         'result': '10.0' if index < 5 else '合格'}
                        for index, item in enumerate(mappings) if item['group'] == group]}
                    for group in ('SYNTHETIC-NUMBER', 'SYNTHETIC-CHOICE')]
            self.apply_write = apply_synthetic_item_write
        with override_settings(MES_INSPECTION_CONTRACT=json.dumps(manifest['provider_contract'])):
            saved = self.action({'id': row.pk, 'version': row.version}, 'mes-save')
            self.assertEqual(saved.status_code, 200, saved.data)
            reloaded_save = self.client.get(self.base_url + str(row.pk) + '/')
            self.assertEqual(reloaded_save.status_code, 200, reloaded_save.data)
            self.assertEqual(reloaded_save.data['version'], saved.data['version'])
            self.assertEqual(reloaded_save.data['measurements'], entered['measurements'])
            self.assertEqual(reloaded_save.data['mes_workflow']['phase'], 'saved')
            self.assertEqual(reloaded_save.data['mes_completion_status'], 'not_completed')
            self.assertTrue(reloaded_save.data['mes_workflow']['can_finish'])
            finished = self.action(reloaded_save.data, 'mes-finish')
            self.assertEqual(finished.status_code, 200, finished.data)
            reloaded_finish = self.client.get(self.base_url + str(row.pk) + '/')
            self.assertEqual(reloaded_finish.status_code, 200, reloaded_finish.data)
            self.assertEqual(reloaded_finish.data['version'], finished.data['version'])
            self.assertEqual(reloaded_finish.data['measurements'], entered['measurements'])
            self.assertEqual(reloaded_finish.data['mes_workflow']['phase'], 'completed')
            self.assertFalse(reloaded_finish.data['mes_workflow']['can_finish'])
            source = read_persisted_board_source(scope)
            self.assertIsNotNone(source)
            projection = project_machine_quality(scope, bindings=source.bindings,
                observations=source.observations, read=source.read, now=timezone.now())
            self.assertEqual(projection['first']['checks'][0]['status'], 'passed')
            context = {'injection': {'machine_rows': [production_row], 'last_plan_updated_at': now},
                       'machining': {'rows': []}}
            with patch('production.views.get_daily_production_context', return_value=context), \
                    patch('production.views.timezone.now', return_value=timezone.now()):
                public = ProductionStatusView.as_view()(APIRequestFactory().get(
                    '/api/production/status/', {'date': scope.business_date.isoformat()}))
            self.assertEqual(public.status_code, 200, public.data)
            board_row = public.data['injection'][0]
            self.assertEqual(board_row['inspection_status']['first']['checks'][0]['status'], 'passed')
            self.assertFalse(board_row['inspection_status']['complete'])
            self.assertEqual(board_row['total_planned'], 100)
            self.assertEqual(board_row['total_actual'], 40)
            self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD, TASK_FINISH])
            self.assertEqual([path for path, _ in self.calls],
                [TASK_DETAIL, ITEM_RECORD, TASK_DETAIL, TASK_DETAIL, TASK_FINISH, TASK_DETAIL])
            self.assert_private(finished)
            self.assert_private(reloaded_save)
            self.assert_private(reloaded_finish)
            self.assert_private(public)

    def test_preparation_rejects_stale_or_broadened_or_unapproved_intent_atomically(self):
        from quality.inspection_pilot_preparation import PilotPreparationBlocked, prepare_pilot
        manifest = self._pilot_manifest(single=True)
        cases = [(manifest, False), ({**manifest, 'expected_version': 999}, True),
                 ({**manifest, 'actor_id': self.reviewer.pk}, True),
                 ({**manifest, 'binding': {**manifest['binding'], 'qc_id': '91000000000000099'}}, True)]
        with override_settings(MES_INSPECTION_ENABLED=False):
            for candidate, explicit in cases:
                with self.assertRaises(PilotPreparationBlocked):
                    prepare_pilot(candidate, apply=True, allow_single_actor_test=explicit)
                self.assertFalse(InspectionMesBinding.objects.exists())
                row = InspectionRequest.objects.get(pk=manifest['request_id'])
                self.assertEqual(row.status, 'submitted')
                self.assertIsNone(row.reviewed_by_id)
        with self.assertRaises(PilotPreparationBlocked):
            prepare_pilot(manifest, apply=True, allow_single_actor_test=True)
        self.assertEqual(self.calls, [])

    def test_preparation_command_uses_manifest_without_changing_runtime_flags(self):
        from django.core.management import call_command, CommandError
        from io import StringIO
        import tempfile
        manifest = self._pilot_manifest()
        with tempfile.NamedTemporaryFile(mode='w+', suffix='.json') as fixture, \
                override_settings(MES_INSPECTION_ENABLED=False):
            json.dump(manifest, fixture)
            fixture.flush()
            output = StringIO()
            call_command('prepare_inspection_pilot', manifest=fixture.name, stdout=output)
            self.assertTrue(json.loads(output.getvalue())['dry_run'])
            self.assertFalse(InspectionMesBinding.objects.exists())
            call_command('prepare_inspection_pilot', manifest=fixture.name, apply=True, stdout=StringIO())
            self.assertEqual(InspectionMesBinding.objects.count(), 1)
            with self.assertRaises(CommandError):
                call_command('prepare_inspection_pilot', manifest=fixture.name, apply=True, stdout=StringIO())
            self.assertFalse(get_stage_adapter().enabled)
        self.assertEqual(self.calls, [])

    def test_single_actor_exception_expires_and_never_changes_browser_approval_rule(self):
        from quality.inspection_pilot_preparation import prepare_pilot
        from quality.inspection_mes_stages import binding_contract
        manifest = self._pilot_manifest(single=True)
        with override_settings(MES_INSPECTION_ENABLED=False):
            prepare_pilot(manifest, apply=True, allow_single_actor_test=True)
        row = InspectionRequest.objects.get(pk=manifest['request_id'])
        binding = InspectionMesBinding.objects.get(request=row)
        for change in ({'expires_at': (timezone.now() - timedelta(seconds=1)).isoformat()},
                       {'actor_id': self.reviewer.pk}, {'single_actor_test_reference': 'DIFFERENT'}):
            with override_settings(MES_INSPECTION_CONTRACT=json.dumps({**manifest['provider_contract'], **change})):
                with self.assertRaises(MesContractUnavailable):
                    binding_contract(binding, row)
        self.assertEqual(self.calls, [])
        self.assertNotIn(TOKEN.encode(), bytes(MESCredential.objects.get(pk=self.editor.pk).ciphertext))

    def test_verified_stages_publish_only_the_reviewed_plan_and_one_qc_check(self):
        from quality.inspection_board_repository import read_persisted_board_source
        from quality.inspection_board_status import BoardScope, project_machine_quality
        now = timezone.now()
        scope = BoardScope(now.date(), 1, 70, 'a' * 64)
        contract = deepcopy(self.contract)
        contract['board_binding'] = {'business_date': scope.business_date.isoformat(),
            'machine_number': 1, 'current_plan_id': 70, 'plan_version': scope.plan_version,
            'generation': 1, 'reference': 'SYNTHETIC-REVIEWED-PLAN',
            'valid_from': (now - timedelta(seconds=1)).isoformat(),
            'valid_until': contract['expires_at'], 'stale_after_seconds': 120}
        with override_settings(MES_INSPECTION_CONTRACT=json.dumps(contract)):
            saved = self.action(self.data, 'mes-save')
            self.assertEqual(saved.status_code, 200, saved.data)
            source = read_persisted_board_source(scope)
            self.assertIsNotNone(source)
            self.assertEqual(source.observations[0].stage, 'in_progress')
            self.assertFalse(source.read.complete)
            finished = self.action(saved.data, 'mes-finish')
            self.assertEqual(finished.status_code, 200, finished.data)
            source = read_persisted_board_source(scope)
            self.assertIsNotNone(source)
            result = project_machine_quality(scope, bindings=source.bindings,
                observations=source.observations, read=source.read, now=timezone.now())
            self.assertEqual(result['first']['checks'][0]['status'], 'passed')
            self.assertFalse(result['complete'])
            self.assertEqual(result['first']['status'], 'unknown')
            self.assertNotIn(self.binding.qc_id, str(result))
            self.assertNotIn(TOKEN, str(result))
            changed = BoardScope(scope.business_date, 1, 70, 'b' * 64)
            self.assertIsNone(read_persisted_board_source(changed))

    def test_default_off_and_malformed_policy_fail_before_identity(self):
        changes = [dict(MES_INSPECTION_ENABLED=value) for value in (False, None, 1, 'true')]
        changes += [dict(MES_INSPECTION_CONTRACT=value) for value in ('', '{}', 'null', '[]', '{')]
        for settings in changes:
            with self.subTest(fields=settings), override_settings(**settings):
                self.assertFalse(get_stage_adapter(user=self.editor, session=self.session).enabled)
                response = self.action(self.data, 'mes-save')
                self.assertEqual(response.status_code, 503)
        self.identity.userinfo.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_expired_unbounded_and_naive_policy_fail_closed(self):
        for expiry in (self.instant - timedelta(seconds=1), self.instant + timedelta(hours=2),
                       self.instant.replace(tzinfo=None)):
            changed = dict(self.contract, expires_at=expiry.isoformat())
            with self.subTest(expiry=expiry), override_settings(MES_INSPECTION_CONTRACT=json.dumps(changed)):
                with self.assertRaises(MesContractUnavailable):
                    load_policy()
                self.assertEqual(self.action(self.data, 'mes-save').status_code, 503)
        self.identity.userinfo.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_changed_binding_and_other_actor_cannot_use_reviewed_scope(self):
        policy = load_policy()
        self.assertFalse(get_stage_adapter(user=self.other_editor, session=self.session).enabled)
        for field, changed in [('qc_id', '91000000000000099'), ('work_order_id', '91000000000000099'),
                ('tenant', 'SYNTHETIC-OTHER'), ('test_only', False), ('test_label', 'SYNTHETIC-OTHER'),
                ('reviewed_result_digest', '0' * 64)]:
            original = getattr(self.binding, field)
            setattr(self.binding, field, changed)
            self.assertFalse(policy.matches(self.binding), field)
            setattr(self.binding, field, original)
        self.binding.contract['items'][0]['write_item_id'] = '91000000000000099'
        self.assertFalse(policy.matches(self.binding))
        self.assertEqual(self.calls, [])

    def test_current_policy_is_rechecked_after_identity(self):
        def disable(token):
            changed = override_settings(MES_INSPECTION_ENABLED=False)
            changed.enable()
            self.addCleanup(changed.disable)
            return userinfo(self.mes_user)
        self.identity.userinfo.side_effect = disable
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.identity.userinfo.call_count, 1)
        self.assertEqual(self.calls, [])
        self.assert_private(response)

    def test_missing_credential_preserves_ready_and_explicit_reconnect_can_resume(self):
        MESCredential.objects.filter(pk=self.editor.pk).delete()
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_connection_required')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'ready')
        self.assertEqual(current['sync_status'], 'not_synced')
        self.identity.userinfo.assert_not_called()
        self.assertEqual(self.calls, [])
        self.store_credential()
        saved = self.action(current, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual(len(self.writes()), 1)

    def test_app_supply_failure_before_writer_keeps_stage_and_user_connection(self):
        from mes_oauth.app_tokens import AppCredentialUnavailable
        with patch('mes_oauth.inspection_credentials.get_app_access_token',
                side_effect=[APP_TOKEN, AppCredentialUnavailable('app_credential_unavailable')]):
            failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_app_credential_unavailable')
        self.assertEqual(failed.data['request']['mes_workflow']['phase'], 'ready')
        self.assertEqual(failed.data['request']['sync_status'], 'not_synced')
        self.assertTrue(vault._open(MESCredential.objects.get(pk=self.editor.pk)) == TOKEN)
        self.assertEqual(self.writes(), [])

    def test_app_supply_failure_after_writer_keeps_unknown_and_never_repeats(self):
        from mes_oauth.app_tokens import AppCredentialUnavailable
        with patch('mes_oauth.inspection_credentials.get_app_access_token',
                side_effect=[APP_TOKEN, APP_TOKEN, AppCredentialUnavailable('app_credential_unavailable')]):
            failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_outcome_unknown')
        self.assertEqual(failed.data['request']['mes_workflow']['phase'], 'save_unknown')
        self.assertEqual(len(self.writes()), 1)

    def test_expired_credential_never_reaches_identity_or_writer(self):
        MESCredential.objects.filter(pk=self.editor.pk).update(expires_at=self.instant - timedelta(seconds=1))
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data['code'], 'mes_connection_required')
        self.assertEqual(response.data['request']['mes_workflow']['phase'], 'ready')
        self.identity.userinfo.assert_not_called()
        self.assertEqual(self.calls, [])

    def test_identity_mismatch_wipes_token_and_never_writes(self):
        self.identity.userinfo.return_value = userinfo(self.mes_user + 1)
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.data['code'], 'mes_connection_required')
        self.assertEqual(self.calls, [])
        self.assertEqual(bytes(MESCredential.objects.get(pk=self.editor.pk).ciphertext), b'')
        self.assert_private(response)

    def test_identity_failure_between_read_and_save_preserves_ready(self):
        self.identity.userinfo.side_effect = [userinfo(self.mes_user), RuntimeError(TOKEN)]
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_identity_temporarily_unavailable')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'ready')
        self.assertEqual(current['sync_status'], 'not_synced')
        self.assertEqual([path for path, _ in self.calls], [TASK_DETAIL])
        self.assertEqual(self.identity.userinfo.call_count, 2)
        self.identity.userinfo.side_effect = None
        self.assertTrue(vault._open(MESCredential.objects.get(pk=self.editor.pk)) == TOKEN)
        saved = self.action(current, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])
        self.assert_private(failed)

    def assert_initial_detail_auth_reconnect(self, *, http_status=200, business_code=200, expired=False):
        self.on_detail = lambda index: SimpleNamespace(status_code=http_status,
            content=json.dumps({'code': business_code}).encode())
        key = uuid.uuid4()
        if expired:
            # Expire the actual typed lease at the transport's pre-send check;
            # userinfo and the Django login clock remain current.
            with patch('quality.inspection_transport.time.time', return_value=self.instant.timestamp() + 7200):
                failed = self.action(self.data, 'mes-save', key=key)
        else:
            failed = self.action(self.data, 'mes-save', key=key)
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_connection_required')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'ready')
        self.assertEqual(current['sync_status'], 'not_synced')
        self.assertEqual(self.writes(), [])
        self.assertEqual(len(self.calls), 0 if expired else 1)
        self.assertEqual(bytes(MESCredential.objects.get(pk=self.editor.pk).ciphertext), b'')
        self.assertEqual(self.action(self.data, 'mes-save', key=key).data, failed.data)
        self.on_detail = None
        self.store_credential()
        saved = self.action(current, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])
        self.assert_private(failed)

    def test_initial_detail_http_401_allows_reconnect_without_losing_ready(self):
        self.assert_initial_detail_auth_reconnect(http_status=401)

    def test_initial_detail_business_401_allows_reconnect_without_losing_ready(self):
        self.assert_initial_detail_auth_reconnect(business_code=401)

    def test_initial_detail_expired_typed_lease_allows_reconnect_before_send(self):
        self.assert_initial_detail_auth_reconnect(expired=True)

    def test_generic_read_timeout_is_not_a_proved_authentication_reconnect(self):
        def timed_out(index):
            raise TimeoutError(TOKEN)
        self.on_detail = timed_out
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_stage_blocked')
        self.assertEqual(failed.data['request']['mes_workflow']['phase'], 'blocked')
        self.assertEqual(self.writes(), [])
        self.assert_private(failed)

    def test_detail_forbidden_is_not_reclassified_as_authentication_reconnect(self):
        self.on_detail = lambda index: SimpleNamespace(status_code=403, content=b'{"code":403}')
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_stage_blocked')
        self.assertEqual(self.writes(), [])

    def test_postsave_detail_401_keeps_unknown_and_reconciles_without_rewrite(self):
        self.on_detail = lambda index: (SimpleNamespace(status_code=401, content=b'{"code":401}')
            if index == 2 else None)
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_outcome_unknown')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'save_unknown')
        self.assertEqual(bytes(MESCredential.objects.get(pk=self.editor.pk).ciphertext), b'')
        self.assertEqual(self.action(current, 'mes-save').status_code, 409)
        self.on_detail = None
        self.store_credential()
        reconciled = self.action(current, 'mes-reconcile')
        self.assertEqual(reconciled.status_code, 200, reconciled.data)
        self.assertEqual(reconciled.data['mes_workflow']['phase'], 'saved')
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])

    def test_postfinish_detail_401_keeps_unknown_and_never_resends_finish(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.on_detail = lambda index: (SimpleNamespace(status_code=401, content=b'{"code":401}')
            if index == 4 else None)
        failed = self.action(saved.data, 'mes-finish')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_outcome_unknown')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'finish_unknown')
        self.assertEqual(self.action(current, 'mes-finish').status_code, 409)
        self.on_detail = None
        self.store_credential()
        reconciled = self.action(current, 'mes-reconcile')
        self.assertEqual(reconciled.status_code, 200, reconciled.data)
        self.assertEqual(reconciled.data['mes_workflow']['phase'], 'completed')
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD, TASK_FINISH])

    def test_writer_authentication_error_is_never_a_safe_reconnect(self):
        from .inspection_transport import MesAuthenticationRejected
        self.write_error = MesAuthenticationRejected(TOKEN)
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_outcome_unknown')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'save_unknown')
        self.assertEqual(self.action(current, 'mes-save').status_code, 409)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])
        self.assert_private(failed)

    def test_identity_failure_between_saved_read_and_finish_preserves_saved(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.identity.userinfo.side_effect = [userinfo(self.mes_user), RuntimeError(TOKEN)]
        failed = self.action(saved.data, 'mes-finish')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_identity_temporarily_unavailable')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'saved')
        self.assertEqual(current['sync_status'], 'succeeded')
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])
        self.identity.userinfo.side_effect = None
        self.assertTrue(vault._open(MESCredential.objects.get(pk=self.editor.pk)) == TOKEN)
        finished = self.action(current, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD, TASK_FINISH])

    def test_transient_identity_failure_after_save_reconciles_without_reconnecting_or_resending(self):
        self.identity.userinfo.side_effect = [userinfo(self.mes_user), userinfo(self.mes_user), RuntimeError(TOKEN)]
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual(failed.data['code'], 'mes_outcome_unknown')
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'save_unknown')
        self.assertTrue(vault._open(MESCredential.objects.get(pk=self.editor.pk)) == TOKEN)
        self.assertEqual(self.action(current, 'mes-save').status_code, 409)
        self.identity.userinfo.side_effect = None
        reconciled = self.action(current, 'mes-reconcile')
        self.assertEqual(reconciled.status_code, 200, reconciled.data)
        self.assertEqual(reconciled.data['mes_workflow']['phase'], 'saved')
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])

    def test_successful_key_replay_does_not_repeat_identity_or_http(self):
        key = uuid.uuid4()
        saved = self.action(self.data, 'mes-save', key=key)
        self.assertEqual(saved.status_code, 200, saved.data)
        call_count, identity_count = len(self.calls), self.identity.userinfo.call_count
        repeated = self.action(self.data, 'mes-save', key=key)
        self.assertEqual(repeated.status_code, 200)
        self.assertEqual(repeated.data, saved.data)
        self.assertEqual(len(self.calls), call_count)
        self.assertEqual(self.identity.userinfo.call_count, identity_count)
        self.assertEqual(self.action(saved.data, 'mes-save').status_code, 409)
        self.assertEqual(len(self.writes()), 1)

    def test_changed_executor_even_with_getable_is_never_written(self):
        self.source['data']['executor']['id'] += 1
        self.source['data']['getAble'] = 1
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.writes(), [])
        self.assert_private(response)

    def test_missing_permanent_label_blocks_before_write(self):
        del self.source['data']['remark']
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.writes(), [])

    def test_unreviewed_source_config_mapping_blocks_before_write(self):
        self.source['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]['id'] += 1
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.writes(), [])

    def test_unreviewed_preexisting_records_are_not_overwritten(self):
        self.set_records('9.9')
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.writes(), [])

    def test_historical_completed_task_is_excluded_before_write(self):
        self.source['data'].update(status={'code': 2}, inspectionResult={'code': 1},
            endTime=int((self.instant - timedelta(days=1)).timestamp() * 1000))
        self.set_records('10.0')
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        self.assertEqual(self.writes(), [])

    def test_acknowledged_save_with_changed_readback_never_enables_finish(self):
        def corrupt(index):
            if index == 2:
                self.set_records('10.00')
        self.on_detail = corrupt
        response = self.action(self.data, 'mes-save')
        self.assertEqual(response.status_code, 503)
        current = response.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'save_unknown')
        self.assertFalse(current['mes_workflow']['can_finish'])
        self.assertEqual(self.action(current, 'mes-finish').status_code, 409)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])

    def test_timeout_after_remote_save_is_unknown_and_reconciles_without_resend(self):
        self.write_error = TimeoutError(TOKEN)
        key = uuid.uuid4()
        failed = self.action(self.data, 'mes-save', key=key)
        self.assertEqual(failed.status_code, 503)
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'save_unknown')
        self.assertEqual(self.action(current, 'mes-save').status_code, 409)
        self.assertEqual(self.action(self.data, 'mes-save', key=key).status_code, 503)
        self.write_error = None
        reconciled = self.action(current, 'mes-reconcile')
        self.assertEqual(reconciled.status_code, 200, reconciled.data)
        self.assertEqual(reconciled.data['mes_workflow']['phase'], 'saved')
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])
        self.assert_private(failed)

    def test_changed_saved_executor_prevents_finish(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.source['data']['executor']['id'] += 1
        failed = self.action(saved.data, 'mes-finish')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])

    def test_changed_saved_value_prevents_finish(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        self.set_records('10.00')
        failed = self.action(saved.data, 'mes-finish')
        self.assertEqual(failed.status_code, 503)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])

    def test_finish_acknowledgement_requires_fresh_matching_verdict(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        def corrupt(index):
            if index == 4:
                self.source['data']['inspectionResult'] = {'code': 4}
        self.on_detail = corrupt
        failed = self.action(saved.data, 'mes-finish')
        self.assertEqual(failed.status_code, 503)
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'finish_unknown')
        self.assertEqual(current['mes_completion_status'], 'not_completed')
        self.assertEqual(self.action(current, 'mes-finish').status_code, 409)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD, TASK_FINISH])

    def test_credential_loss_after_write_never_becomes_safe_retry(self):
        def identity(token):
            if self.identity.userinfo.call_count == 3:
                raise RuntimeError(TOKEN)
            return userinfo(self.mes_user)
        self.identity.userinfo.side_effect = identity
        failed = self.action(self.data, 'mes-save')
        self.assertEqual(failed.status_code, 503)
        current = failed.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'save_unknown')
        self.assertEqual(self.action(current, 'mes-save').status_code, 409)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])
        self.assert_private(failed)

    def test_logout_then_new_login_requires_new_connection_and_preserves_saved_work(self):
        saved = self.action(self.data, 'mes-save')
        self.assertEqual(saved.status_code, 200, saved.data)
        vault.revoke_actor(self.editor.pk, login_digest=self.session.login_digest,
            login_expires_at=self.session.expires_at, reason='logged_out')
        old = self.action(saved.data, 'mes-finish')
        self.assertIn(old.status_code, (401, 403))
        del self.editor._inspection_test_access_token
        self.session = helpers.inspection_session(self.editor)
        blocked = self.action(saved.data, 'mes-finish')
        self.assertEqual(blocked.status_code, 503)
        self.assertEqual(blocked.data['code'], 'mes_connection_required')
        current = blocked.data['request']
        self.assertEqual(current['mes_workflow']['phase'], 'saved')
        self.assertEqual(current['sync_status'], 'succeeded')
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD])
        self.store_credential()
        finished = self.action(current, 'mes-finish')
        self.assertEqual(finished.status_code, 200, finished.data)
        self.assertEqual([path for path, _ in self.writes()], [ITEM_RECORD, TASK_FINISH])
        self.assert_private(finished)
