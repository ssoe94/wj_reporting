"""Synthetic exception boundaries only; no provider requests or credentials."""
from datetime import datetime, timedelta, timezone, tzinfo
import json

from django.test import SimpleTestCase

from .continuity import ContinuityBlocked
from .diagnostics import (CONTINUITY_FAILURE_CODES, VAULT_FAILURE_CODES,
                          expiry_metadata, safe_expiry_metadata, safe_callback_failure_code)
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


class ExpiryMetadataTests(SimpleTestCase):
    instant = datetime(2026, 10, 6, tzinfo=timezone.utc)

    def observe(self, value, **times):
        return expiry_metadata(value, request_started_at=times.get('start', self.instant),
                               received_at=times.get('end', self.instant + timedelta(seconds=1)))

    def test_observes_both_interpretations_without_selecting_one(self):
        observed = self.observe(3600)
        self.assertEqual(observed, {'stage': 'credential_storage', 'expire_type': 'integer',
            'expire_seconds': 3600, 'relative_expired': False, 'unix_expired': True,
            'elapsed_bound': 'within_300s', 'elapsed_ms': 1000})
        self.assertFalse(self.observe(2_000_000_000)['unix_expired'])
        self.assertTrue(self.observe(1)['relative_expired'])

    def test_untrusted_types_and_unbounded_values_never_escape(self):
        class IntSubclass(int):
            pass

        class HostileMeta(type):
            def __hash__(cls):
                raise AssertionError('Do not hash untrusted classes.')

        class Hostile(metaclass=HostileMeta):
            def __str__(self):
                raise AssertionError('Do not serialize untrusted values.')

        cases = [(True, 'boolean'), (None, 'null'), ('SYNTHETIC-PRIVATE', 'string'),
                 (3600.0, 'float'), (IntSubclass(3600), 'other'), (Hostile(), 'other'),
                 ({'secret': 'SYNTHETIC-PRIVATE'}, 'other'), (0, 'integer'),
                 (-1, 'integer'), (10**100, 'integer')]
        for number, (value, expected) in enumerate(cases):
            with self.subTest(case=number):
                observed = self.observe(value)
                self.assertEqual(observed['expire_type'], expected)
                self.assertIsNone(observed['expire_seconds'])
                self.assertIsNone(observed['relative_expired'])
                self.assertIsNone(observed['unix_expired'])
                self.assertNotIn('SYNTHETIC-PRIVATE', json.dumps(observed))

    def test_clock_bounds_and_datetime_overflow_are_bounded(self):
        class HostileTimezone(tzinfo):
            def utcoffset(self, value):
                raise AssertionError('Do not call untrusted timezone hooks.')

        for end, bound in ((self.instant - timedelta(seconds=1), 'reversed'),
                           (self.instant + timedelta(seconds=301), 'over_300s'),
                           (self.instant.replace(tzinfo=None), 'unavailable'),
                           (self.instant.replace(tzinfo=HostileTimezone()), 'unavailable')):
            observed = self.observe(3600, end=end)
            self.assertEqual(observed['elapsed_bound'], bound)
            self.assertIsNone(observed['elapsed_ms'])
        self.assertEqual(self.observe(3600, end=self.instant + timedelta(seconds=300))['elapsed_ms'], 300000)
        self.assertIsNone(self.observe(253402300799)['relative_expired'])

    def test_log_boundary_drops_extra_keys_and_rechecks_exact_field_types(self):
        class UntrustedString(str):
            pass

        original = self.observe(3600)
        tainted = {**original, 'token': 'SYNTHETIC-PRIVATE', 'expire_seconds': True,
                   'elapsed_ms': 10**100, 'relative_expired': 1}
        safe = safe_expiry_metadata(tainted)
        self.assertEqual(set(safe), set(original))
        self.assertIsNone(safe['expire_seconds'])
        self.assertIsNone(safe['elapsed_ms'])
        self.assertIsNone(safe['relative_expired'])
        for key in ('stage', 'expire_type', 'elapsed_bound'):
            self.assertIsNone(safe_expiry_metadata({**original, key: UntrustedString(original[key])}))
