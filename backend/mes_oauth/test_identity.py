"""Synthetic identity-boundary tests; no Django, credentials, network or cache."""
from dataclasses import FrozenInstanceError
from io import StringIO
from contextlib import redirect_stderr, redirect_stdout
import traceback
from unittest import TestCase
from unittest.mock import Mock

from .identity import (
    UserContextResponse, UserContextUnverified, verify_user_context,
)


USER = 10_000_000_000_000_003
TOKEN = 'SYNTHETIC-USER-TOKEN'
PRIVATE_MESSAGE = 'SYNTHETIC-RAW-RESPONSE-MESSAGE'


def response(data, *, status=200, code=200, redirected=False):
    return UserContextResponse(status_code=status,
        body={'code': code, 'data': data, 'message': PRIVATE_MESSAGE},
        redirected=redirected)


def exchange(**extra):
    return response({'userAccessToken': TOKEN, **extra})


def matching_info():
    return response({'userId': USER, 'name': PRIVATE_MESSAGE})


class InspectionUserContextTests(TestCase):
    def assert_blocked(self, exchange_response, loader, *, expected_user=USER):
        # This is a synthetic caller, not a production detail dispatcher. It
        # cannot reach a subsequent action if verification raises.
        detail = Mock()
        output = StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            try:
                context = verify_user_context(expected_user, exchange_response, info_loader=loader)
            except UserContextUnverified as exc:
                rendered = ''.join(traceback.format_exception(type(exc), exc, exc.__traceback__))
                self.assertNotIn(TOKEN, rendered)
                self.assertNotIn(PRIVATE_MESSAGE, rendered)
                self.assertNotIn(TOKEN, str(exc))
                self.assertNotIn(PRIVATE_MESSAGE, repr(exc))
            else:
                detail(context)
                self.fail('Unverified context escaped the boundary.')
        self.assertEqual(output.getvalue(), '')
        detail.assert_not_called()

    def test_matching_identity_uses_exact_same_token_once_without_live_readiness(self):
        token = ''.join(['SYNTHETIC-', 'USER-TOKEN'])
        loader = Mock(return_value=matching_info())
        supplied = response({'userAccessToken': token})
        context = verify_user_context(USER, supplied, info_loader=loader)
        loader.assert_called_once_with(token)
        self.assertIs(loader.call_args.args[0], token)
        self.assertIs(context.token, token)
        self.assertEqual(context.user_id, USER)
        self.assertIs(context.expiry_verified, False)
        self.assertIs(context.live_ready, False)
        self.assertNotIn(TOKEN, repr(context))
        self.assertNotIn(TOKEN, repr(supplied))
        self.assertNotIn(PRIVATE_MESSAGE, repr(supplied))
        with self.assertRaises(FrozenInstanceError):
            context.user_id = USER + 1

    def test_missing_user_token_never_uses_app_token_or_calls_loader(self):
        values = [{}, {'appAccessToken': TOKEN}]
        values += [{'userAccessToken': value, 'appAccessToken': TOKEN}
                   for value in (None, '', ' \t\n', True, 123, [], {})]
        for data in values:
            with self.subTest(data_keys=list(data)):
                loader = Mock()
                self.assert_blocked(response(data), loader)
                loader.assert_not_called()

    def test_valid_user_token_is_selected_even_if_app_field_is_present(self):
        loader = Mock(return_value=matching_info())
        context = verify_user_context(USER, exchange(appAccessToken='SYNTHETIC-APP-TOKEN'),
                                      info_loader=loader)
        loader.assert_called_once_with(TOKEN)
        self.assertEqual(context.token, TOKEN)

    def test_invalid_expected_ids_stop_before_loader(self):
        for user in (None, True, False, 0, -1, 1.0, str(USER), 9_223_372_036_854_775_808):
            with self.subTest(user=user):
                loader = Mock()
                self.assert_blocked(exchange(), loader, expected_user=user)
                loader.assert_not_called()

    def test_wrong_or_coerced_observed_user_id_blocks_after_one_lookup(self):
        for user in (None, True, False, 0, -1, USER + 1, str(USER), float(USER), [], {}):
            with self.subTest(user=user):
                loader = Mock(return_value=response({'userId': user}))
                self.assert_blocked(exchange(), loader)
                loader.assert_called_once_with(TOKEN)
        loader = Mock(return_value=response({}))
        self.assert_blocked(exchange(), loader)
        loader.assert_called_once_with(TOKEN)

    def test_exchange_http_failures_redirects_and_api_failures_never_call_loader(self):
        rows = [response({'userAccessToken': TOKEN}, status=status)
                for status in (True, '200', 200.0, 201, 202, 301, 302, 307, 308, 401, 403, 500)]
        rows += [response({'userAccessToken': TOKEN}, code=code)
                 for code in (None, True, '200', 200.0, 401, 403, 500)]
        rows += [response({'userAccessToken': TOKEN}, redirected=value)
                 for value in (True, None, 0, 'false')]
        for supplied in rows:
            with self.subTest(response=supplied):
                loader = Mock()
                self.assert_blocked(supplied, loader)
                loader.assert_not_called()

    def test_userinfo_http_failures_redirects_and_api_failures_never_return_context(self):
        rows = [response({'userId': USER}, status=status)
                for status in (True, '200', 200.0, 201, 202, 301, 302, 307, 308, 401, 403, 500)]
        rows += [response({'userId': USER}, code=code)
                 for code in (None, True, '200', 200.0, 401, 403, 500)]
        rows += [response({'userId': USER}, redirected=value)
                 for value in (True, None, 0, 'false')]
        for supplied in rows:
            with self.subTest(response=supplied):
                loader = Mock(return_value=supplied)
                self.assert_blocked(exchange(), loader)
                loader.assert_called_once_with(TOKEN)

    def test_malformed_envelopes_and_data_stop_at_their_boundary(self):
        rows = [None, {}, [], UserContextResponse(200, None, False),
                UserContextResponse(200, [], False), UserContextResponse(200, {}, False)]
        rows += [response(data) for data in (None, [], '', True)]
        for supplied in rows:
            with self.subTest(type=type(supplied).__name__):
                loader = Mock()
                self.assert_blocked(supplied, loader)
                loader.assert_not_called()
                loader = Mock(return_value=supplied)
                self.assert_blocked(exchange(), loader)
                loader.assert_called_once_with(TOKEN)

    def test_loader_exception_has_no_raw_message_or_token_and_is_not_retried(self):
        loader = Mock(side_effect=RuntimeError(TOKEN + ' ' + PRIVATE_MESSAGE))
        self.assert_blocked(exchange(), loader)
        loader.assert_called_once_with(TOKEN)

    def test_response_contract_errors_are_distinct_from_provider_rejection_and_identity_mismatch(self):
        for supplied, expected in (
            (response({'userAccessToken': TOKEN}, code='200'), 'exchange_api_response_invalid'),
            (response({'userAccessToken': TOKEN}, code=403), 'exchange_api_rejected'),
            (response({'userAccessToken': TOKEN}, status=401), 'exchange_http_rejected'),
        ):
            loader = Mock()
            with self.assertRaisesRegex(UserContextUnverified, '^' + expected + '$'):
                verify_user_context(USER, supplied, info_loader=loader)
            loader.assert_not_called()
        for supplied, expected in (
            (response({'userId': USER}, code='200'), 'userinfo_api_response_invalid'),
            (response({'userId': USER}, code=403), 'userinfo_api_rejected'),
            (response({'userId': str(USER)}), 'userinfo_user_id_invalid'),
            (response({'userId': USER + 1}), 'user_identity_mismatch'),
        ):
            loader = Mock(return_value=supplied)
            with self.assertRaisesRegex(UserContextUnverified, '^' + expected + '$'):
                verify_user_context(USER, exchange(), info_loader=loader)
            loader.assert_called_once_with(TOKEN)

    def test_nested_data_or_app_token_cannot_substitute_for_documented_user_token(self):
        for data in ({'data': {'userAccessToken': TOKEN}}, {'appAccessToken': TOKEN}):
            loader = Mock()
            with self.assertRaisesRegex(UserContextUnverified, '^user_token_missing$'):
                verify_user_context(USER, response(data), info_loader=loader)
            loader.assert_not_called()

    def test_noncallable_loader_is_rejected_without_detail_capability(self):
        self.assert_blocked(exchange(), None)

    def test_expire_never_becomes_an_invented_live_expiry(self):
        for expire in (None, 0, 3600, 1_900_000_000, -1, True, '3600'):
            with self.subTest(expire=expire):
                loader = Mock(return_value=matching_info())
                context = verify_user_context(USER, exchange(expire=expire), info_loader=loader)
                self.assertIs(context.expiry_verified, False)
                self.assertIs(context.live_ready, False)
                self.assertFalse(hasattr(context, 'expires_at'))
                loader.assert_called_once_with(TOKEN)

    def test_only_exact_documented_permission_subcode_changes_fixed_reason(self):
        from .identity import _successful_data, safe_failure_code
        for subcode, reason in (
                ('OPENAPI-DOMAIN/URL_NO_PERMISSION', 'userinfo_api_permission_denied'),
                ('URL_NO_PERMISSION', 'userinfo_api_rejected'),
                (TOKEN, 'userinfo_api_rejected'), (None, 'userinfo_api_rejected'),
                (['OPENAPI-DOMAIN/URL_NO_PERMISSION'], 'userinfo_api_rejected')):
            response = UserContextResponse(200, {'code':3401,'subCode':subcode,
                                                'message':TOKEN,'data':{}}, False)
            with self.assertRaises(UserContextUnverified) as raised:
                _successful_data(response, 'userinfo')
            self.assertEqual(safe_failure_code(raised.exception), reason)
            self.assertNotIn(TOKEN,str(raised.exception))
        # Exact symbol interpretation remains independent of numeric API code.
        response = UserContextResponse(200, {'code':401,
            'subCode':'OPENAPI-DOMAIN/URL_NO_PERMISSION','data':{}}, False)
        with self.assertRaises(UserContextUnverified) as raised:
            _successful_data(response, 'userinfo')
        self.assertEqual(safe_failure_code(raised.exception), 'userinfo_api_permission_denied')
