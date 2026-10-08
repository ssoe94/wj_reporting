"""Wire contract only: synthetic USER credentials, no provider traffic."""
from unittest.mock import Mock, patch

from django.conf import settings
from django.test import SimpleTestCase, override_settings

from .inspection_adapter import MesContractUnavailable, MesOutcomeUnknown
from .inspection_live_adapter import _user_sender


class InspectionStageSenderTests(SimpleTestCase):
    def send(self, **changes):
        arguments = dict(params={'access_token': 'synthetic-user-lease'},
            data=b'{"id":123}', headers={'Content-Type': 'application/json'},
            timeout=(5, 20), allow_redirects=False)
        arguments.update(changes)
        return _user_sender('https://v3-ali.blacklake.cn/synthetic-detail', **arguments)

    def wire(self, expected):
        response = Mock(status_code=200, history=[])
        response.iter_content.return_value = [b'{"code":200}']
        with patch('requests.Session') as factory:
            session = factory.return_value.__enter__.return_value
            session.post.return_value.__enter__.return_value = response
            result = self.send()
        session.post.assert_called_once_with(
            'https://v3-ali.blacklake.cn/synthetic-detail', data=b'{"id":123}',
            headers={'Content-Type': 'application/json', expected: 'synthetic-user-lease',
                     'Accept': 'application/json'},
            timeout=(5, 20), allow_redirects=False, stream=True)
        self.assertIs(session.trust_env, False)
        response.iter_content.assert_called_once_with(8192)
        self.assertEqual(result.content, b'{"code":200}')

    def test_default_header_uses_only_user_lease(self):
        with override_settings():
            if hasattr(settings, 'MES_USER_OAUTH_APP_TOKEN_HEADER'):
                del settings.MES_USER_OAUTH_APP_TOKEN_HEADER
            self.wire('access_token')

    @override_settings(MES_USER_OAUTH_APP_TOKEN_HEADER='X-AUTH')
    def test_configured_header_uses_only_same_user_lease(self):
        self.wire('X-AUTH')

    def test_invalid_configuration_or_competing_authority_fails_before_network(self):
        with patch('requests.Session') as factory:
            for header in ('Authorization', '', None, True):
                with self.subTest(header=header), override_settings(MES_USER_OAUTH_APP_TOKEN_HEADER=header):
                    with self.assertRaises(MesContractUnavailable):
                        self.send()
            with override_settings(MES_USER_OAUTH_APP_TOKEN_HEADER='X-AUTH'):
                for header in ('access_token', 'x-auth', 'Authorization'):
                    with self.subTest(header=header), self.assertRaises(MesContractUnavailable):
                        self.send(headers={header: 'synthetic-other-authority'})
        factory.assert_not_called()

    @override_settings(MES_USER_OAUTH_APP_TOKEN_HEADER='X-AUTH')
    def test_redirect_and_oversized_response_never_retry(self):
        for history, chunks in (([Mock()], []), ([], [b'x' * 524289])):
            with self.subTest(redirect=bool(history)), patch('requests.Session') as factory:
                session = factory.return_value.__enter__.return_value
                response = session.post.return_value.__enter__.return_value
                response.history = history
                response.iter_content.return_value = chunks
                with self.assertRaises(MesOutcomeUnknown):
                    self.send()
                session.post.assert_called_once()
