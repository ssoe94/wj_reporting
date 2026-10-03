"""Synthetic-only contract for the explicitly approved server-shell probe."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock


_spec = importlib.util.spec_from_file_location('eligibility_probe',
    Path(__file__).resolve().parents[2] / 'scripts/read-inspection-eligibility.py')
probe = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(probe)
QC = 10000000000000002
USER = 10000000000000004
ORIGIN = 'https://v3-ali.blacklake.cn'
PRIVATE = 'PRIVATE-FIXTURE-TOKEN'


def runtime():
    return SimpleNamespace(MES_BASE_URL=ORIGIN, APP_TOKEN_ENDPOINT=probe.APP_TOKEN_PATH,
        TOKEN_EXPIRES_KEY='synthetic-expiry', cache=SimpleNamespace(get=Mock(return_value=101)),
        fetch_app_token=Mock(return_value=PRIVATE), fetch_user_token=Mock())


def response(*, http=200, code=200, need_check=None, data=None, permission=None):
    return SimpleNamespace(status_code=http, content=json.dumps({
        'code': code, 'message': 'PRIVATE-RAW-MESSAGE', 'needCheck': need_check,
        'fieldPermission': permission,
        'data': {'id': QC, 'getAble': 0, 'status': {'code': 1}, 'getStatus': {'code': 0},
                 'executor': None, 'candidates': [], 'candidateDeps': []} if data is None else data,
    }).encode())


class EligibilityProbeTests(unittest.TestCase):
    def run_probe(self, source, sender, **kwargs):
        result = probe.run_comparison(QC, USER, origin=ORIGIN, runtime=source, post=sender,
                                      now=kwargs.pop('now', lambda: 100), **kwargs)
        self.assertNotIn('PRIVATE', json.dumps(result))
        source.fetch_user_token.assert_not_called()
        return result

    def test_one_issuance_two_exact_reads_and_no_identity_or_write_inference(self):
        source = runtime()
        sender = Mock(side_effect=[response(), response(data={'id': QC, 'getAble': 1})])
        result = self.run_probe(source, sender)
        source.fetch_app_token.assert_called_once_with()
        self.assertEqual(result['issuance'], 'app_token_received')
        self.assertEqual(result['authenticated_user'], 'unverified')
        self.assertEqual(result['write_authority'], 'unverified')
        self.assertEqual([row['getAble'] for row in result['observations']], [0, 1])
        self.assertEqual(sender.call_count, 2)
        for call, payload in zip(sender.call_args_list, [{'id': QC}, {'id': QC, 'receiveUserId': USER}]):
            self.assertEqual(call.args, (ORIGIN + probe.DETAIL_PATH,))
            self.assertEqual(json.loads(call.kwargs['data']), payload)
            self.assertEqual(call.kwargs['params'], {'access_token': PRIVATE})
            self.assertEqual(call.kwargs['timeout'], (5, 20))
            self.assertIs(call.kwargs['allow_redirects'], False)

    def test_uncertain_issuance_is_never_repeated(self):
        source, sender = runtime(), Mock()
        source.fetch_app_token.side_effect = RuntimeError(PRIVATE)
        result = self.run_probe(source, sender)
        self.assertEqual(result['issuance'], 'failed_or_uncertain_no_retry')
        source.fetch_app_token.assert_called_once_with()
        sender.assert_not_called()

    def test_missing_or_expired_token_stops_before_detail(self):
        for token, expiry, expected in [('', 101, 'token_missing_no_retry'),
                (PRIVATE, 100, 'token_expired_no_retry'), (PRIVATE, None, 'expiry_unavailable_no_retry'),
                (PRIVATE, float('nan'), 'expiry_unavailable_no_retry')]:
            with self.subTest(expected=expected, expiry=expiry):
                source, sender = runtime(), Mock()
                source.fetch_app_token.return_value = token
                source.cache.get.return_value = expiry
                result = self.run_probe(source, sender)
                outcome = result['observations'][0]['outcome'] if result['observations'] else result['issuance']
                self.assertEqual(outcome, expected)
                source.fetch_app_token.assert_called_once_with()
                sender.assert_not_called()

    def test_denial_confirmation_wrong_target_and_redirect_stop_after_one_read(self):
        for item, expected in [
                (response(http=401), 'authentication_rejected'), (response(code=401), 'authentication_rejected'),
                (response(http=403), 'access_denied'), (response(code=403), 'access_denied'),
                (response(need_check=1), 'confirmation_unverified_no_retry'),
                (response(data={'id': QC + 1}), 'target_unverified_no_retry'),
                (response(http=307), 'response_unknown_no_retry')]:
            with self.subTest(expected=expected):
                source, sender = runtime(), Mock(return_value=item)
                result = self.run_probe(source, sender)
                self.assertEqual(result['observations'][0]['outcome'], expected)
                sender.assert_called_once()
                source.fetch_app_token.assert_called_once_with()

    def test_allowlist_omits_names_measurements_and_permission_encoding(self):
        source = runtime()
        item = response(data={'id': QC, 'getAble': 1, 'measurement': 'PRIVATE-QC',
            'executor': {'id': USER, 'name': 'PRIVATE-NAME', 'phone': 'PRIVATE-PHONE'},
            'candidates': [{'id': USER, 'name': 'PRIVATE-NAME'}],
            'candidateDeps': [{'id': 10000000000000006, 'name': 'PRIVATE-DEPARTMENT'}]},
            permission={'encoding': 'PRIVATE-ENCODING', 'noAccess': ['getAble', 'PRIVATE-FIELD'], 'readonly': []})
        result = self.run_probe(source, Mock(return_value=item))
        row = result['observations'][0]
        self.assertEqual(row['executor_id'], USER)
        self.assertEqual(row['candidates'], {'count': 1, 'ids': [USER]})
        self.assertEqual(row['fieldPermission']['noAccess_count'], 2)
        self.assertEqual(row['fieldPermission']['noAccess_known_fields'], ['getAble'])
        self.assertIs(row['fieldPermission']['encoding_present'], True)

    def test_missing_or_invalid_eligibility_stops_after_one_read(self):
        for data in [{'id': QC}] + [{'id': QC, 'getAble': value} for value in (None, True, '1', 2, 1.0)]:
            with self.subTest(data=data):
                source, sender = runtime(), Mock(return_value=response(data=data))
                result = self.run_probe(source, sender)
                self.assertEqual(result['observations'][0]['outcome'], 'eligibility_unverified_no_retry')
                sender.assert_called_once()
                source.fetch_app_token.assert_called_once_with()

    def test_invalid_scope_stops_before_issuance(self):
        for qc, user, origin in [(True, USER, ORIGIN), (QC, str(USER), ORIGIN), (0, USER, ORIGIN),
                                  (QC, USER, ORIGIN + '/other'), (QC, USER, 'https://unreviewed.invalid')]:
            source, sender = runtime(), Mock()
            with self.assertRaises(ValueError):
                probe.run_comparison(qc, user, origin=origin, runtime=source, post=sender)
            source.fetch_app_token.assert_not_called()
            sender.assert_not_called()
        for attribute, value in [('MES_BASE_URL', 'https://v3-hw.blacklake.cn'),
                                 ('APP_TOKEN_ENDPOINT', '/other')]:
            source = runtime()
            setattr(source, attribute, value)
            with self.assertRaises(ValueError):
                probe.run_comparison(QC, USER, origin=ORIGIN, runtime=source, post=Mock())
            source.fetch_app_token.assert_not_called()

    def test_malformed_duplicate_nonfinite_or_oversize_json_stops(self):
        for content in [b'{', b'{"code":200,"code":200}', b'{"code":200,"data":NaN}', b' ' * 524289]:
            source, sender = runtime(), Mock(return_value=SimpleNamespace(status_code=200, content=content))
            result = self.run_probe(source, sender)
            self.assertEqual(result['observations'][0]['outcome'], 'response_unknown_no_retry')
            sender.assert_called_once()

    def test_second_read_does_not_refresh_an_expired_token(self):
        source, sender = runtime(), Mock(return_value=response())
        result = self.run_probe(source, sender, now=Mock(side_effect=[100, 100, 101]))
        self.assertEqual(result['observations'][1]['outcome'], 'token_expired_no_retry')
        sender.assert_called_once()
        source.fetch_app_token.assert_called_once_with()
