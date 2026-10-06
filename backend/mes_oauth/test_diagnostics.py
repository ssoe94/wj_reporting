"""Synthetic exception boundaries only; no provider requests or credentials."""
from datetime import datetime, timedelta, timezone, tzinfo
import json
from unittest.mock import patch

from django.test import SimpleTestCase, override_settings

from .continuity import ContinuityBlocked, ExpiryContract, ReusePolicy
from .diagnostics import (CONTINUITY_FAILURE_CODES, VAULT_FAILURE_CODES,
                          expiry_metadata, failure_expiry_metadata,
                          safe_expiry_metadata, safe_callback_failure_code)
from .identity import UserContextUnverified, VerifiedUserContext
from .vault import VaultBlocked, VaultPolicy, store_context


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
                               received_at=times.get('end', self.instant + timedelta(seconds=1)),
                               applied_mode=times.get('mode', 'unavailable'))

    def test_observes_both_interpretations_without_selecting_one(self):
        observed = self.observe(3600)
        self.assertEqual(observed, {'stage': 'credential_storage', 'expire_type': 'integer',
            'expire_seconds': 3600, 'relative_expired': False, 'unix_expired': True,
            'elapsed_bound': 'within_300s', 'elapsed_ms': 1000,
            'applied_mode': 'unavailable', 'interpretation': 'unavailable',
            'request_started_at': '2026-10-06T00:00:00.000000Z',
            'received_at': '2026-10-06T00:00:01.000000Z',
            'relative_expires_at': '2026-10-06T01:00:00.000000Z',
            'unix_expires_at': '1970-01-01T01:00:00.000000Z'})
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

    def test_conflict_requires_applied_conservative_mode_and_valid_observations(self):
        self.assertEqual(self.observe(7200, mode='conservative_minimum')['interpretation'],
                         'interpretation_conflict')
        for mode in ('relative_seconds', 'unix_seconds'):
            self.assertEqual(self.observe(7200, mode=mode)['interpretation'], 'not_conflicting')
        self.assertEqual(self.observe(1, mode='conservative_minimum')['interpretation'], 'not_conflicting')
        self.assertEqual(self.observe(2_000_000_000, mode='conservative_minimum')['interpretation'],
                         'not_conflicting')
        self.assertEqual(self.observe(7200, mode='conservative_minimum',
                         end=self.instant - timedelta(seconds=1))['interpretation'], 'unavailable')

    def test_log_revalidates_timestamps_mode_and_classification(self):
        from .views import _record_failure_diagnostic

        class UntrustedString(str):
            pass

        original = self.observe(7200, mode='conservative_minimum')
        for value in ('SYNTHETIC-PRIVATE', '2026-02-30T00:00:00.000000Z',
                      '2026-10-06T00:00:00.000000+08:00', '2026-10-06T00:00:00Z',
                      UntrustedString(original['received_at']), self.instant):
            safe = safe_expiry_metadata({**original, 'received_at': value})
            self.assertIsNone(safe['received_at'])
            self.assertEqual(safe['interpretation'], 'unavailable')
        for mode in ('SYNTHETIC-PRIVATE', UntrustedString('conservative_minimum'), None):
            safe = safe_expiry_metadata({**original, 'applied_mode': mode})
            self.assertEqual(safe['applied_mode'], 'unavailable')
            self.assertEqual(safe['interpretation'], 'unavailable')
        tainted = {**original, 'interpretation': 'SYNTHETIC-PRIVATE',
                   'expire_seconds': 253402300800, 'secret': 'SYNTHETIC-PRIVATE'}
        with self.assertLogs('mes_oauth.diagnostics', level='WARNING') as captured:
            _record_failure_diagnostic('provider_token_expired', None, expiry=tainted)
        observed = json.loads(captured.records[0].getMessage().split(' ', 1)[1])['expiry']
        self.assertEqual(observed['interpretation'], 'unavailable')
        self.assertIsNone(observed['expire_seconds'])
        self.assertNotIn('SYNTHETIC-PRIVATE', captured.records[0].getMessage())

    @override_settings(MES_USER_TOKEN_EXPIRY_MODE='relative_seconds')
    def test_store_failure_captures_actual_policy_mode_without_changing_rejection(self):
        policy = VaultPolicy(ReusePolicy(expiry_contract=ExpiryContract(
            'conservative_minimum', 'SYNTHETIC-REVIEW')), 1, 'SYNTHETIC-TENANT', 600)
        context = VerifiedUserContext(1, 'SYNTHETIC-PRIVATE-TOKEN', 7200)
        with patch('mes_oauth.vault.policy', return_value=policy), \
                self.assertRaises(ContinuityBlocked) as caught:
            store_context(1, None, context, request_started_at=self.instant,
                          received_at=self.instant + timedelta(seconds=1), login_revision=None)
        self.assertEqual(caught.exception.args, ('provider_token_expired',))
        observed = failure_expiry_metadata(caught.exception, self.observe(7200))
        self.assertEqual(observed['applied_mode'], 'conservative_minimum')
        self.assertEqual(observed['interpretation'], 'interpretation_conflict')
        self.assertEqual(observed['relative_expires_at'], '2026-10-06T02:00:00.000000Z')
        self.assertEqual(observed['unix_expires_at'], '1970-01-01T02:00:00.000000Z')

    def test_exception_metadata_requires_exact_class_and_fallback_never_claims_mode(self):
        class HostileError(Exception):
            @property
            def expiry_diagnostic(self):
                raise AssertionError('Do not read arbitrary exception properties.')

        class ContinuitySubclass(ContinuityBlocked):
            @property
            def expiry_diagnostic(self):
                raise AssertionError('Do not read subclass properties.')

        original = self.observe(7200, mode='conservative_minimum')
        for error in (HostileError(), ContinuitySubclass('provider_token_expired'),
                      ContinuityBlocked('SYNTHETIC-PRIVATE'), VaultBlocked('credential_expired')):
            observed = failure_expiry_metadata(error, original)
            self.assertEqual(observed['applied_mode'], 'unavailable')
            self.assertEqual(observed['interpretation'], 'unavailable')
        error = ContinuityBlocked('provider_token_expired')
        error.expiry_diagnostic = {'secret': 'SYNTHETIC-PRIVATE'}
        self.assertEqual(failure_expiry_metadata(error, original)['applied_mode'], 'unavailable')
