"""Synthetic fixed-QC reads only; no external provider/network is available."""
import json
from datetime import timedelta
from unittest.mock import MagicMock, Mock, patch

from django.test import TestCase, SimpleTestCase, override_settings
from rest_framework_simplejwt.tokens import AccessToken

from mes_oauth import vault
from mes_oauth.identity import VerifiedUserContext
from mes_oauth.session_guard import InspectionSession
from mes_oauth.test_vault import VaultFixture, TOKEN, LOGIN_SID, userinfo
from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown
from .inspection_models import InspectionMesBinding, InspectionOperation
from .inspection_transport import InspectionUserAccessToken, MesAuthenticationRejected, MesAccessDenied
from . import inspection_qc_read as service


def detail():
    return {'code': 200, 'data': {'id': service.QC_ID, 'code': service.QC_CODE,
        'getAble': 1, 'status': {'code': 1}, 'getStatus': {'code': 0},
        'executor': {'id': service.MES_USER_ID, 'phone': 'PRIVATE-PHONE'},
        'approvalDetail': {'approvalId': 901, 'approvalCode': 'SYNTHETIC-APPROVAL',
                           'status': {'code': 99}, 'private': 'PRIVATE-APPROVAL'},
        'checkMaterials': [{'private': 'PRIVATE-MATERIAL'}], 'sampleMaterials': [],
        'checkItems': [{'result': 'PRIVATE-MEASUREMENT'}],
        'qcConfig': {'snapshotId': 900, 'materialBatchRecordType': {'code': 3},
            'qcConfigCheckItemList': [{'groupName': 'SYNTHETIC-GROUP',
                'checkItemAppDetailVOS': [{'id': 1000 + index, 'checkItemId': 2000 + index,
                    'qcConfigVersionId': 900, 'checkItemName': 'SYNTHETIC-SPEC',
                    'unit': {'id': 800, 'name': 'SYNTHETIC-UNIT'},
                    'min': '1.20', 'max': '1.30', 'base': '1.25', 'result': 'PRIVATE-RESULT'}
                    for index in range(16)]}]}}}


def response(body=None, status=200):
    return Mock(status_code=status, content=json.dumps(body or detail()).encode())


class DetailProjectionTests(SimpleTestCase):
    def test_allowlist_excludes_measurements_personal_and_raw_provider_fields(self):
        result = service.project_detail(detail())
        self.assertEqual(result['item_count'], 16)
        self.assertTrue(result['item_count_matches_expected'])
        self.assertEqual(result['items'][0]['minimum'], '1.20')
        self.assertEqual(result['items'][0]['id'], '1000')
        self.assertEqual(result['items'][0]['check_item_id'], '2000')
        self.assertEqual(result['approval']['status_meaning'], 'unknown')
        self.assertEqual(result['inventory_metadata']['check_material_count'], 1)
        self.assertNotIn('PRIVATE', json.dumps(result))

    def test_missing_metadata_is_explicit_and_never_invented(self):
        result = service.project_detail({'code': 200, 'data': {
            'id': service.QC_ID, 'code': service.QC_CODE}})
        self.assertIsNone(result['get_able'])
        self.assertIsNone(result['item_count'])
        self.assertIsNone(result['approval'])
        self.assertIn('items', result['missing_fields'])
        self.assertIn('inventory_metadata.qcRange', result['missing_fields'])

    def test_wrong_qc_boolean_eligibility_and_duplicate_item_are_rejected(self):
        for mutation in ('id', 'code', 'getAble', 'duplicate'):
            body = detail()
            if mutation == 'duplicate':
                rows = body['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS']
                rows[1]['id'] = rows[0]['id']
            else:
                body['data'][mutation] = {'id': service.QC_ID + 1, 'code': 'OTHER', 'getAble': True}[mutation]
            with self.subTest(mutation=mutation), self.assertRaises(ValueError):
                service.project_detail(body)

    def test_transport_rejects_every_other_route_or_body_before_sender(self):
        sender = Mock()
        lease = InspectionUserAccessToken(TOKEN, 9999999999, user_id=service.MES_USER_ID)
        transport = service.QCDetailReadTransport(lease, sender=sender)
        for route, body in (('/quality/_finish', {'id': service.QC_ID}),
                            (service.DETAIL_ROUTE, {'id': service.QC_ID + 1}),
                            (service.DETAIL_ROUTE, {'id': service.QC_ID, 'receiveUserId': service.MES_USER_ID})):
            with self.assertRaises(MesContractUnavailable):
                transport.post_json(route, json.dumps(body))
        sender.assert_not_called()
        self.assertFalse(hasattr(transport, 'send_stages'))


    def test_configuration_choices_preserved_bounded_and_not_measurement_values(self):
        body = detail()
        row = body['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]
        row['radios'] = ['CHOICE-' + str(index) for index in range(50)]
        item = service.project_detail(body)['items'][0]
        self.assertEqual(item['options'], row['radios'])
        self.assertEqual(item['missing_fields'], [])
        for value in (None, []):
            row['radios'] = value
            item = service.project_detail(body)['items'][0]
            self.assertEqual(item['options'], [])
            self.assertEqual(item['missing_fields'], ['options'] if value is None else [])
        del row['radios']
        self.assertEqual(service.project_detail(body)['items'][0]['missing_fields'], ['options'])

    def test_malformed_or_excessive_configuration_choices_are_rejected(self):
        for options in ([str(index) for index in range(51)], ['x' * 501], [''],
                        [None], [True], [{'result': 'PRIVATE'}], 'NOT-A-LIST'):
            body = detail()
            body['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]['radios'] = options
            with self.subTest(kind=type(options).__name__), self.assertRaises(ValueError):
                service.project_detail(body)

    def test_executor_identity_is_only_disclosed_for_approved_lee(self):
        body = detail()
        self.assertEqual(service.project_detail(body)['executor_id'], str(service.MES_USER_ID))
        for executor, present, match in ((None, False, None), ({}, True, None),
                                        ({'id': service.MES_USER_ID + 1}, True, False)):
            body['data']['executor'] = executor
            result = service.project_detail(body)
            self.assertIsNone(result['executor_id'])
            self.assertIs(result['executor_present'], present)
            self.assertIs(result['executor_matches_lee'], match)


    def test_optional_zero_ids_are_missing_but_required_identity_stays_strict(self):
        body = detail()
        config = body['data']['qcConfig']
        config['snapshotId'] = 0
        item = config['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]
        item.update(checkItemId=0, qcConfigVersionId=0, unit={'id': 0, 'name': 'SYNTHETIC'})
        body['data']['approvalDetail']['approvalId'] = 0
        result = service.project_detail(body)
        self.assertIsNone(result['snapshot_id'])
        self.assertIsNone(result['approval']['id'])
        self.assertEqual(result['approval']['missing_fields'], ['id'])
        for field in ('check_item_id', 'version_id'):
            self.assertIsNone(result['items'][0][field])
            self.assertIn(field, result['items'][0]['missing_fields'])
        self.assertIsNone(result['items'][0]['unit']['id'])
        self.assertIn('unit.id', result['items'][0]['missing_fields'])
        self.assertIn('snapshot_id', result['missing_fields'])
        self.assertIn('approval.id', result['missing_fields'])
        for source in (body['data'], item):
            previous = source['id']
            source['id'] = 0
            with self.assertRaises(ValueError):
                service.project_detail(body)
            source['id'] = previous
        for invalid in (True, False, -1, '0'):
            item['checkItemId'] = invalid
            with self.assertRaises(ValueError):
                service.project_detail(body)

    def test_projection_logs_fixed_reason_without_source_or_exception_text(self):
        private = 'PRIVATE-PROVIDER-MEASUREMENT-' + TOKEN
        body = detail()
        body['data']['qcConfig']['qcConfigCheckItemList'][0]['checkItemAppDetailVOS'][0]['min'] = private
        with self.assertLogs(service.logger, level='INFO') as logs:
            with self.assertRaises(ValueError):
                service.project_detail(body)
            with patch.object(service, '_project_detail', side_effect=RuntimeError(private)):
                with self.assertRaises(RuntimeError):
                    service.project_detail(body)
        for record in logs.records:
            self.assertEqual(record.qc_read_stage, 'projection')
            self.assertEqual(record.qc_read_reason, 'projection_source_invalid')
            self.assertIsNone(record.exc_info)
            self.assertNotIn(private, str(record.__dict__))
            self.assertNotIn(TOKEN, str(record.__dict__))


    def test_zero_executor_reference_is_explicitly_missing_without_matching_lee(self):
        body = detail()
        body['data']['executor'] = {'id': 0}
        result = service.project_detail(body)
        self.assertTrue(result['executor_present'])
        self.assertIsNone(result['executor_matches_lee'])
        self.assertIsNone(result['executor_id'])
        self.assertIn('executor_id', result['missing_fields'])


class ApprovedQCReadTests(VaultFixture, TestCase):
    def setUp(self):
        super().setUp()
        # Synthetic actor PK follows the approved scope without altering its constants.
        self.user.pk = service.ACTOR_ID
        self.user._state.adding = True
        self.user.username = 'SYNTHETIC-APPROVED-LEE'
        self.user.save(force_insert=True)
        from injection.models import UserProfile
        UserProfile.objects.get_or_create(user=self.user)
        self.user.refresh_from_db()
        self.login.delete()
        self.login = self.make_login(self.user, self.login_digest)
        config = override_settings(MES_INSPECTION_ENABLED=False,
            MES_USER_OAUTH_USER_MAP={str(service.ACTOR_ID): str(service.MES_USER_ID)})
        config.enable()
        self.addCleanup(config.disable)
        vault.store_context(self.user.pk, self.login_digest,
            VerifiedUserContext(service.MES_USER_ID, TOKEN, 1200),
            request_started_at=self.instant - timedelta(seconds=2),
            received_at=self.instant - timedelta(seconds=1), login_revision=1)
        token = AccessToken.for_user(self.user)
        token['mes_sid'] = LOGIN_SID
        token['mes_login_exp'] = int(self.login.expires_at.timestamp())
        self.session = InspectionSession.from_token(self.user, token)
        self.provider.userinfo.return_value = userinfo(user_id=service.MES_USER_ID)
        self.sender = Mock(return_value=response())

    def invoke(self):
        return service.read_approved_qc(self.session, provider=self.provider, sender=self.sender)

    def test_read_with_write_gate_off_and_no_binding_uses_only_existing_user_token(self):
        result = self.invoke()
        self.assertEqual(result['qc_code'], service.QC_CODE)
        self.provider.userinfo.assert_called_once_with(TOKEN)
        self.sender.assert_called_once()
        args, kwargs = self.sender.call_args
        self.assertEqual(args, (service.ORIGIN + service.DETAIL_ROUTE,))
        self.assertEqual(json.loads(kwargs['data']), {'id': service.QC_ID})
        self.assertEqual(kwargs['params'], {'access_token': TOKEN})
        self.assertFalse(kwargs['allow_redirects'])
        self.assertFalse(InspectionMesBinding.objects.exists())
        self.assertFalse(InspectionOperation.objects.exists())
        self.assertNotIn(TOKEN, json.dumps(result))

    def test_wrong_actor_revoked_session_and_expired_credential_never_reach_detail(self):
        for kind in ('actor', 'logout', 'expiry'):
            with self.subTest(kind=kind):
                if kind == 'actor':
                    self.session.actor_id = self.other.pk
                elif kind == 'logout':
                    self.session.actor_id = self.user.pk
                    vault.revoke_actor(self.user.pk, login_digest=self.login_digest, reason='logout')
                else:
                    self.login.revoked_at = None
                    self.login.save(update_fields=['revoked_at'])
                    self.clock.return_value = self.instant + timedelta(seconds=180)
                with self.assertRaises(vault.VaultBlocked):
                    self.invoke()
        self.sender.assert_not_called()
        self.assert_no_provider()

    def test_provider_identity_mismatch_revokes_without_detail_dispatch(self):
        self.provider.userinfo.return_value = userinfo(user_id=service.MES_USER_ID + 1)
        with self.assertRaises(vault.VaultBlocked):
            self.invoke()
        self.sender.assert_not_called()
        self.assert_wiped()


    def test_detail_401_wipes_credential_without_retry(self):
        self.sender.return_value = response(status=401)
        with self.assertRaisesRegex(vault.VaultBlocked, '^inspection_read_authentication_failed$'):
            self.invoke()
        self.provider.userinfo.assert_called_once_with(TOKEN)
        self.sender.assert_called_once()
        self.assert_wiped()

    def test_different_executor_is_observed_without_granting_write_authority(self):
        body = detail()
        body['data']['executor']['id'] += 1
        self.sender.return_value = response(body)
        result = self.invoke()
        self.assertFalse(result['executor_matches_lee'])
        self.assertTrue(result['executor_present'])
        self.assertIsNone(result['executor_id'])
        self.assertNotIn(str(service.MES_USER_ID + 1), json.dumps(result))
        self.assertTrue(result['read_only'])
        self.assertFalse(InspectionOperation.objects.exists())

    def test_wrong_origin_and_wrong_mapping_block_before_any_provider_dispatch(self):
        for configuration in ({'MES_USER_OAUTH_PROVIDER_ORIGIN': 'https://v3-hw.blacklake.cn'},
                              {'MES_USER_OAUTH_USER_MAP': {str(service.ACTOR_ID): str(service.MES_USER_ID + 1)}}):
            with override_settings(**configuration), self.assertRaises(vault.VaultBlocked):
                self.invoke()
        self.assert_no_provider()
        self.sender.assert_not_called()



class DefaultSenderSecurityTests(SimpleTestCase):
    def transport(self):
        return service.QCDetailReadTransport(InspectionUserAccessToken(
            TOKEN, 9999999999, user_id=service.MES_USER_ID))

    def session(self, *, status=200, chunks=None, history=None):
        session, response = MagicMock(), MagicMock()
        session.__enter__.return_value = session
        session.post.return_value.__enter__.return_value = response
        response.status_code = status
        response.history = [] if history is None else history
        response.iter_content.return_value = [json.dumps(detail()).encode()] if chunks is None else chunks
        return session, response

    def invoke(self):
        return self.transport().post_json(service.DETAIL_ROUTE, json.dumps({'id': service.QC_ID}))

    def test_default_sender_uses_header_only_and_disables_environment_credentials(self):
        session, response = self.session()
        with patch('requests.Session', return_value=session) as constructor:
            self.assertEqual(self.invoke()['data']['id'], service.QC_ID)
        constructor.assert_called_once_with()
        self.assertFalse(session.trust_env)
        session.post.assert_called_once()
        args, kwargs = session.post.call_args
        self.assertEqual(args, (service.ORIGIN + service.DETAIL_ROUTE,))
        self.assertNotIn(TOKEN, args[0])
        self.assertNotIn('?', args[0])
        self.assertNotIn('params', kwargs)
        self.assertEqual(kwargs['headers']['access_token'], TOKEN)
        self.assertNotIn(TOKEN.encode(), kwargs['data'])
        self.assertEqual(kwargs['timeout'], (5, 20))
        self.assertTrue(kwargs['stream'])
        self.assertFalse(kwargs['allow_redirects'])
        response.iter_content.assert_called_once_with(8192)

    def test_oversized_stream_and_redirect_are_rejected_without_retry(self):
        for options in ({'chunks': [b'x' * 524288, b'x']},
                        {'history': [object()]}, {'status': 302}):
            with self.subTest(options=list(options)):
                session, response = self.session(**options)
                with patch('requests.Session', return_value=session), self.assertRaises(MesOutcomeUnknown):
                    self.invoke()
                session.post.assert_called_once()
                if 'history' in options:
                    response.iter_content.assert_not_called()

    def test_http_authentication_and_permission_errors_keep_fixed_types_without_retry(self):
        for status, exception in ((401, MesAuthenticationRejected), (403, MesAccessDenied), (500, MesOutcomeUnknown)):
            session, response = self.session(status=status)
            with self.subTest(status=status), patch('requests.Session', return_value=session):
                with self.assertRaises(exception):
                    self.invoke()
            session.post.assert_called_once()


    def test_transport_diagnostics_bound_status_and_code_without_payload_or_error(self):
        private = 'PRIVATE-RAW-' + TOKEN
        for status, body, expected_status, expected_code, stage in (
                (599, {'code': 200}, 'unknown', None, 'response_http'),
                (200, {'code': 1000000001, 'message': private}, 200, None, 'response_envelope'),
                (200, {'code': 403, 'message': private}, 200, 403, 'response_envelope'),
                (200, {'code': True, 'message': private}, 200, None, 'response_envelope')):
            sender = Mock(return_value=response(body, status=status))
            transport = service.QCDetailReadTransport(InspectionUserAccessToken(
                TOKEN, 9999999999, user_id=service.MES_USER_ID), sender=sender)
            with self.subTest(status=status, code=body['code']), self.assertLogs(service.logger, level='INFO') as logs:
                with self.assertRaises((MesOutcomeUnknown, MesAccessDenied, service.MesRejected)):
                    transport.post_json(service.DETAIL_ROUTE, json.dumps({'id': service.QC_ID}))
            record = logs.records[-1]
            self.assertEqual(record.qc_read_stage, stage)
            self.assertEqual(record.qc_read_http_status, expected_status)
            self.assertEqual(record.qc_read_api_code, expected_code)
            self.assertNotIn(private, str(record.__dict__))
            self.assertNotIn(TOKEN, str(record.__dict__))
            self.assertIsNone(record.exc_info)
            sender.assert_called_once()
        sender = Mock(side_effect=RuntimeError(private))
        transport = service.QCDetailReadTransport(InspectionUserAccessToken(
            TOKEN, 9999999999, user_id=service.MES_USER_ID), sender=sender)
        with self.assertLogs(service.logger, level='INFO') as logs, self.assertRaises(MesOutcomeUnknown):
            transport.post_json(service.DETAIL_ROUTE, json.dumps({'id': service.QC_ID}))
        self.assertEqual(logs.records[-1].qc_read_stage, 'request')
        self.assertNotIn(private, str(logs.records[-1].__dict__))
        self.assertNotIn(TOKEN, str(logs.records[-1].__dict__))


    @override_settings(MES_USER_OAUTH_APP_TOKEN_HEADER='X-AUTH',
                       MES_USER_OAUTH_APP_ACCESS_TOKEN='SYNTHETIC-APP-MUST-NOT-BE-SENT')
    def test_configured_header_carries_only_same_user_lease_without_app_resolution(self):
        session, response = self.session()
        with patch('requests.Session', return_value=session), \
                patch('mes_oauth.app_tokens.get_app_access_token', side_effect=AssertionError('No app token resolution.')) as app:
            self.assertEqual(self.invoke()['data']['id'], service.QC_ID)
        session.post.assert_called_once()
        args, kwargs = session.post.call_args
        self.assertEqual(kwargs['headers'], {'X-AUTH': TOKEN,
            'Content-Type': 'application/json', 'Accept': 'application/json'})
        self.assertNotIn('params', kwargs)
        self.assertNotIn(TOKEN, args[0])
        self.assertNotIn(TOKEN.encode(), kwargs['data'])
        self.assertNotIn('SYNTHETIC-APP-MUST-NOT-BE-SENT', str(session.post.call_args))
        self.assertFalse(session.trust_env)
        self.assertTrue(kwargs['stream'])
        self.assertFalse(kwargs['allow_redirects'])
        response.iter_content.assert_called_once_with(8192)
        app.assert_not_called()

    def test_invalid_header_configuration_rejects_before_network(self):
        for header in ('Authorization', 'access_token,X-AUTH', '', None, True, ['X-AUTH']):
            with self.subTest(kind=type(header).__name__), \
                    override_settings(MES_USER_OAUTH_APP_TOKEN_HEADER=header), \
                    patch('requests.Session') as constructor, self.assertRaises(MesOutcomeUnknown):
                self.invoke()
            constructor.assert_not_called()

    def test_only_exact_url_permission_subcode_gets_fixed_diagnostic(self):
        private = 'PRIVATE-PROVIDER-BODY-' + TOKEN
        for subcode, expected in (
                ('OPENAPI-DOMAIN/URL_NO_PERMISSION', 'provider_url_permission'),
                ('OPENAPI-DOMAIN/URL_NO_PERMISSION ' + private, 'rejected'),
                (private, 'rejected'), (None, 'rejected'), (3401, 'rejected')):
            body = {'code': 3401, 'subCode': subcode, 'message': private, 'data': {'secret': private}}
            session, response = self.session(chunks=[json.dumps(body).encode()])
            with patch('requests.Session', return_value=session), \
                    self.assertLogs(service.logger, level='INFO') as logs, self.assertRaises(service.MesRejected):
                self.invoke()
            session.post.assert_called_once()
            record = logs.records[-1]
            self.assertEqual(record.qc_read_stage, 'response_envelope')
            self.assertEqual(record.qc_read_reason, expected)
            self.assertEqual(record.qc_read_api_code, 3401)
            self.assertNotIn(private, str(record.__dict__))
            self.assertNotIn(TOKEN, str(record.__dict__))
            self.assertNotIn('OPENAPI-DOMAIN/', str(record.__dict__))
            self.assertIsNone(record.exc_info)
