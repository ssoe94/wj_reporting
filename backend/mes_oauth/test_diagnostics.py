"""Synthetic exception boundaries only; no provider requests or credentials."""
from django.test import SimpleTestCase

from .continuity import ContinuityBlocked
from .diagnostics import (CONTINUITY_FAILURE_CODES, VAULT_FAILURE_CODES,
                          safe_callback_failure_code)
from .identity import UserContextUnverified
from .vault import VaultBlocked


class CallbackFailureCodeTests(SimpleTestCase):
    def test_known_classes_preserve_only_their_own_fixed_reasons(self):
        for error_type, reasons in ((VaultBlocked, VAULT_FAILURE_CODES),
                                    (ContinuityBlocked, CONTINUITY_FAILURE_CODES)):
            for reason in reasons:
                with self.subTest(error_type=error_type.__name__, reason=reason):
                    self.assertEqual(safe_callback_failure_code(error_type(reason)), reason)
        self.assertEqual(safe_callback_failure_code(
            UserContextUnverified('userinfo_http_rejected')), 'userinfo_http_rejected')

    def test_untrusted_class_reason_and_arguments_stay_generic(self):
        class UntrustedString(str):
            pass

        class VaultSubclass(VaultBlocked):
            pass

        class ContinuitySubclass(ContinuityBlocked):
            pass

        errors = [
            RuntimeError('vault_key_unavailable'),
            type('VaultBlocked', (Exception,), {})('vault_key_unavailable'),
            VaultSubclass('vault_key_unavailable'),
            ContinuitySubclass('provider_token_expired'),
            VaultBlocked('provider_token_expired'),
            ContinuityBlocked('vault_key_unavailable'),
            UserContextUnverified('provider_token_expired'),
        ]
        for error_type in (VaultBlocked, ContinuityBlocked):
            errors.extend((error_type(), error_type('SYNTHETIC-PRIVATE'),
                           error_type('expiry_value_invalid', 'SYNTHETIC-PRIVATE'),
                           error_type({'private': 'SYNTHETIC-PRIVATE'}),
                           error_type(UntrustedString('expiry_value_invalid'))))
        for number, error in enumerate(errors):
            with self.subTest(case=number):
                self.assertEqual(safe_callback_failure_code(error), 'identity_verification_failed')
