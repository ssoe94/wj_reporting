"""Synthetic metadata decisions only; no vault, credentials, provider or API.

These tests cannot establish MES token freshness, permission or live readiness.
The expiry contracts below are invented fixtures, not Blacklake contracts.
"""
from dataclasses import replace
from datetime import datetime, timedelta, timezone, tzinfo
from unittest import TestCase
from zoneinfo import ZoneInfo

from .continuity import (
    ActorState, ConnectionState, ContinuityBlocked, ExpiryContract,
    ExpiryEvidence, ReusePolicy, decide_reuse, resolve_provider_expiry,
)


BASE = datetime(2030, 1, 2, 3, 0, tzinfo=timezone.utc)
NOW = BASE + timedelta(seconds=120)
RELATIVE = ExpiryContract('relative_seconds', 'synthetic/relative-v1')
UNIX = ExpiryContract('unix_seconds', 'synthetic/unix-v1')
CONSERVATIVE = ExpiryContract('conservative_minimum', 'synthetic/seconds-minimum-v1')


class RaisingOffset(tzinfo):
    def utcoffset(self, value):
        raise RuntimeError('synthetic-tz-error-must-not-escape')


class InvalidOffset(tzinfo):
    def utcoffset(self, value):
        return timedelta(days=1)


def invalid_utc_clocks():
    # Labels avoid formatting malformed datetime values in test diagnostics.
    return (
        ('raising_offset', BASE.replace(tzinfo=RaisingOffset())),
        ('invalid_offset', BASE.replace(tzinfo=InvalidOffset())),
        ('utc_underflow', datetime.min.replace(tzinfo=timezone(timedelta(hours=1)))),
        ('utc_overflow', datetime.max.replace(tzinfo=timezone(timedelta(hours=-1)))),
    )


class ProviderExpiryContractTests(TestCase):
    def resolve(self, value, **overrides):
        arguments = {
            'request_started_at': BASE,
            'received_at': BASE + timedelta(seconds=9),
            'contract': RELATIVE,
        }
        arguments.update(overrides)
        return resolve_provider_expiry(value, **arguments)

    def assert_blocked(self, reason, value, **overrides):
        with self.assertRaises(ContinuityBlocked) as caught:
            self.resolve(value, **overrides)
        self.assertEqual(str(caught.exception), reason)

    def test_missing_unknown_or_unreviewed_contract_never_guesses_expiry(self):
        contracts = (None, ExpiryContract(), ExpiryContract('auto', 'synthetic/v1'),
                     ExpiryContract('relative_seconds', ''),
                     ExpiryContract('conservative_minimum', ''),
                     ExpiryContract('unix_seconds', 'unreviewed reference'),
                     {'mode': 'relative_seconds', 'review_reference': 'synthetic/v1'})
        for contract in contracts:
            for value in (3600, int((BASE + timedelta(hours=1)).timestamp())):
                with self.subTest(contract=contract, value=value):
                    self.assert_blocked('expiry_contract_unverified', value, contract=contract)
        with self.assertRaisesRegex(ContinuityBlocked, '^expiry_contract_unverified$'):
            resolve_provider_expiry(3600, request_started_at=BASE, received_at=BASE)

    def test_relative_lifetime_starts_at_request_start_not_response_arrival(self):
        evidence = self.resolve(3600)
        self.assertEqual(evidence.expires_at, BASE + timedelta(seconds=3600))
        self.assertEqual(evidence.contract, RELATIVE)
        self.assertNotEqual(evidence.expires_at, BASE + timedelta(seconds=3609))

    def test_unix_contract_uses_absolute_seconds_with_aware_utc_result(self):
        deadline = BASE + timedelta(hours=1)
        evidence = self.resolve(int(deadline.timestamp()), contract=UNIX)
        self.assertEqual(evidence.expires_at, deadline)
        self.assertEqual(evidence.contract, UNIX)
        self.assertEqual(evidence.expires_at.utcoffset(), timedelta())

    def test_magnitude_does_not_switch_the_reviewed_contract(self):
        epoch_value = int((BASE + timedelta(hours=1)).timestamp())
        relative = self.resolve(epoch_value)
        absolute = self.resolve(epoch_value, contract=UNIX)
        self.assertEqual(relative.expires_at, BASE + timedelta(seconds=epoch_value))
        self.assertNotEqual(relative.expires_at, absolute.expires_at)
        self.assert_blocked('provider_token_expired', 3600, contract=UNIX)

    def test_conservative_policy_bounds_both_interpretations_without_selecting_semantics(self):
        # Check both orders; the policy must not always select the Unix branch.
        for started, value in (
            (BASE, int((BASE + timedelta(hours=1)).timestamp())),
            (datetime(1969, 12, 31, tzinfo=timezone.utc), 3600),
        ):
            received = started + timedelta(seconds=9)
            with self.subTest(started=started):
                relative = self.resolve(value, contract=RELATIVE,
                                        request_started_at=started, received_at=received)
                absolute = self.resolve(value, contract=UNIX,
                                        request_started_at=started, received_at=received)
                evidence = self.resolve(value, contract=CONSERVATIVE,
                                        request_started_at=started, received_at=received)
                self.assertEqual(evidence.expires_at, min(relative.expires_at, absolute.expires_at))
                self.assertEqual(evidence.contract, CONSERVATIVE)

    def test_conservative_policy_cannot_discard_a_past_interpretation_or_gain_a_grace_period(self):
        for value in (3600, 604964, int((BASE + timedelta(seconds=9)).timestamp())):
            with self.subTest(value=value):
                self.assert_blocked('provider_token_expired', value, contract=CONSERVATIVE)

    def test_conservative_policy_rejects_one_unrepresentable_interpretation(self):
        started = datetime(9999, 12, 30, tzinfo=timezone.utc)
        # Unix interpretation is in the future; relative addition overflows.
        value = int((started + timedelta(hours=1)).timestamp())
        self.assert_blocked('expiry_value_invalid', value, contract=CONSERVATIVE,
                            request_started_at=started, received_at=started)

    def test_boolean_string_float_and_nonpositive_values_are_not_coerced(self):
        for value in (None, True, False, '3600', 3600.0, 0, -1, [], {}):
            with self.subTest(value=value):
                self.assert_blocked('expiry_value_invalid', value)

    def test_naive_or_invalid_exchange_timestamps_are_refused(self):
        for field in ('request_started_at', 'received_at'):
            for value in (BASE.replace(tzinfo=None), None, True, BASE.isoformat()):
                with self.subTest(field=field, value=value):
                    self.assert_blocked('exchange_clock_invalid', 3600, **{field: value})

    def test_malformed_timezone_and_utc_overflow_become_fixed_exchange_clock_errors(self):
        for field in ('request_started_at', 'received_at'):
            for label, value in invalid_utc_clocks():
                with self.subTest(field=field, clock=label):
                    with self.assertRaises(ContinuityBlocked) as caught:
                        self.resolve(3600, **{field: value})
                    self.assertEqual(str(caught.exception), 'exchange_clock_invalid')
                    self.assertIsNone(caught.exception.__context__)
                    self.assertIsNone(caught.exception.__cause__)

    def test_exchange_clock_cannot_run_backwards(self):
        self.assert_blocked('exchange_clock_invalid', 3600,
                            received_at=BASE - timedelta(microseconds=1))

    def test_expired_at_response_boundary_has_no_fallback_lifetime(self):
        for duration in (8, 9):
            with self.subTest(duration=duration):
                self.assert_blocked('provider_token_expired', duration)
        for deadline in (BASE + timedelta(seconds=8), BASE + timedelta(seconds=9)):
            with self.subTest(deadline=deadline):
                self.assert_blocked('provider_token_expired', int(deadline.timestamp()), contract=UNIX)

    def test_both_contracts_fail_closed_on_datetime_overflow(self):
        for contract in (RELATIVE, UNIX, CONSERVATIVE):
            with self.subTest(contract=contract.mode):
                self.assert_blocked('expiry_value_invalid', 10 ** 100, contract=contract)
        self.assert_blocked('expiry_value_invalid', 1,
                            request_started_at=datetime.max.replace(tzinfo=timezone.utc),
                            received_at=datetime.max.replace(tzinfo=timezone.utc))

    def test_timezone_offsets_are_compared_as_instants(self):
        offset = timezone(timedelta(hours=8))
        evidence = self.resolve(3600, request_started_at=BASE.astimezone(offset),
                                received_at=(BASE + timedelta(seconds=9)).astimezone(offset))
        self.assertEqual(evidence.expires_at, BASE + timedelta(hours=1))

    def test_relative_seconds_do_not_gain_an_hour_at_autumn_dst_fold(self):
        eastern = ZoneInfo('America/New_York')
        started = datetime(2026, 11, 1, 1, 30, tzinfo=eastern, fold=0)
        received = datetime(2026, 11, 1, 1, 31, tzinfo=eastern, fold=0)
        evidence = self.resolve(3600, request_started_at=started, received_at=received)
        self.assertEqual(evidence.expires_at, datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc))
        self.assertEqual(evidence.expires_at - started.astimezone(timezone.utc), timedelta(hours=1))

    def test_exchange_fold_order_uses_elapsed_time_not_wall_clock(self):
        eastern = ZoneInfo('America/New_York')
        earlier = datetime(2026, 11, 1, 1, 30, tzinfo=eastern, fold=0)
        later = datetime(2026, 11, 1, 1, 10, tzinfo=eastern, fold=1)
        evidence = self.resolve(3600, request_started_at=earlier, received_at=later)
        self.assertEqual(evidence.expires_at, datetime(2026, 11, 1, 6, 30, tzinfo=timezone.utc))
        self.assert_blocked('exchange_clock_invalid', 3600,
                            request_started_at=later, received_at=earlier)


class ContinuityDecisionTests(TestCase):
    def setUp(self):
        self.actor = ActorState(
            local_user_id=101, mes_user_id=202, tenant_id='synthetic-tenant', app_id=303,
            session_digest='a' * 64, authorization_digest='b' * 64,
            authenticated=True, active=True, eligible=True, password_change_required=False,
        )
        self.policy = ReusePolicy(
            enabled=True, review_reference='synthetic/policy-v1', expiry_contract=RELATIVE,
            allowed_operations=frozenset({'identity_read'}),
            max_connection_seconds=1200, idle_seconds=300, safety_seconds=30,
        )
        self.connection = ConnectionState(
            local_user_id=self.actor.local_user_id, mes_user_id=self.actor.mes_user_id,
            tenant_id=self.actor.tenant_id, app_id=self.actor.app_id,
            session_digest=self.actor.session_digest,
            authorization_digest=self.actor.authorization_digest,
            policy_reference=self.policy.review_reference,
            verified_at=BASE, last_used_at=BASE + timedelta(seconds=60),
            provider_expiry=ExpiryEvidence(BASE + timedelta(hours=1), RELATIVE),
            consent_expires_at=BASE + timedelta(minutes=30),
        )

    def decision(self, **overrides):
        arguments = dict(actor=self.actor, connection=self.connection, policy=self.policy,
                         operation='identity_read', now=NOW)
        arguments.update(overrides)
        return decide_reuse(**arguments)

    def assert_decision(self, action, reason, **overrides):
        result = self.decision(**overrides)
        self.assertEqual((result.action, result.reason), (action, reason))
        self.assertIs(result.live_ready, False)
        return result

    def test_default_and_explicitly_disabled_policies_never_allow_reuse(self):
        result = decide_reuse(actor=self.actor, connection=self.connection,
                              operation='identity_read', now=NOW)
        self.assertEqual((result.action, result.reason), ('blocked', 'continuity_disabled'))
        self.assertIs(result.live_ready, False)
        self.assert_decision('blocked', 'continuity_disabled',
                             policy=replace(self.policy, enabled=False))

    def test_invalid_enable_flags_are_not_treated_as_true(self):
        for value in (1, 'true', None):
            with self.subTest(value=value):
                self.assert_decision('blocked', 'policy_invalid',
                                     policy=replace(self.policy, enabled=value))
        self.assert_decision('blocked', 'policy_invalid', policy=None)

    def test_unreviewed_policy_and_invalid_time_limits_fail_closed(self):
        variants = [dict(review_reference=''), dict(expiry_contract=ExpiryContract()),
                    dict(allowed_operations=frozenset()),
                    dict(allowed_operations={'identity_read'}),
                    dict(allowed_operations=frozenset({'identity_read', 'qc_complete'})),
                    dict(max_connection_seconds=True), dict(max_connection_seconds=0),
                    dict(max_connection_seconds=86401), dict(max_connection_seconds='1200'),
                    dict(idle_seconds=True), dict(idle_seconds=0), dict(idle_seconds=1201),
                    dict(safety_seconds=True), dict(safety_seconds=-1), dict(safety_seconds=300)]
        for changed in variants:
            with self.subTest(changed=changed):
                self.assert_decision('blocked', 'policy_unreviewed',
                                     policy=replace(self.policy, **changed))

    def test_only_explicit_identity_read_is_modelled_never_qc_or_production(self):
        for operation in ('qc_complete', 'production_start', 'token_refresh', '', None, True):
            with self.subTest(operation=operation):
                self.assert_decision('blocked', 'operation_unapproved', operation=operation)

    def test_same_account_repeated_identity_reads_only_produce_reuse_candidates(self):
        snapshot = replace(self.connection)
        for seconds in (120, 121, 150, 240):
            with self.subTest(seconds=seconds):
                self.assert_decision('reuse_candidate', 'metadata_valid',
                                     now=BASE + timedelta(seconds=seconds))
                self.assertEqual(self.connection, snapshot)

    def test_missing_connection_requires_reauthentication_not_automatic_grant(self):
        self.assert_decision('reauthenticate', 'connection_missing', connection=None)

    def test_each_earliest_deadline_and_exact_safety_boundary_controls_reuse(self):
        connection = replace(self.connection, last_used_at=NOW)
        deadline = NOW + timedelta(seconds=60)
        cases = (
            ('provider_token_expired', replace(connection,
                provider_expiry=ExpiryEvidence(deadline, RELATIVE)), self.policy),
            ('consent_expired', replace(connection, consent_expires_at=deadline), self.policy),
            ('connection_expired', connection,
                replace(self.policy, max_connection_seconds=180, idle_seconds=180)),
            ('connection_idle', connection, replace(self.policy, idle_seconds=60)),
        )
        for reason, supplied, policy in cases:
            cutoff = deadline - timedelta(seconds=policy.safety_seconds)
            with self.subTest(reason=reason):
                self.assert_decision('reuse_candidate', 'metadata_valid', connection=supplied,
                                     policy=policy, now=cutoff - timedelta(microseconds=1))
                for now in (cutoff, deadline, deadline + timedelta(microseconds=1)):
                    self.assert_decision('reauthenticate', reason, connection=supplied,
                                         policy=policy, now=now)

    def test_zero_safety_still_refuses_exact_expiry(self):
        policy = replace(self.policy, safety_seconds=0)
        deadline = NOW + timedelta(seconds=1)
        connection = replace(self.connection, provider_expiry=ExpiryEvidence(deadline, RELATIVE))
        self.assert_decision('reuse_candidate', 'metadata_valid', connection=connection, policy=policy)
        self.assert_decision('reauthenticate', 'provider_token_expired', connection=connection,
                             policy=policy, now=deadline)

    def test_expired_provider_deadline_is_not_reopened_by_autumn_dst_fold(self):
        eastern = ZoneInfo('America/New_York')
        expiry = datetime(2026, 11, 1, 1, 30, tzinfo=eastern, fold=0)
        now = datetime(2026, 11, 1, 1, 10, tzinfo=eastern, fold=1)
        connection = replace(
            self.connection, verified_at=datetime(2026, 11, 1, 0, 30, tzinfo=eastern),
            last_used_at=datetime(2026, 11, 1, 1, 0, tzinfo=eastern, fold=1),
            provider_expiry=ExpiryEvidence(expiry, RELATIVE),
            consent_expires_at=datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc),
        )
        policy = replace(self.policy, max_connection_seconds=14400, idle_seconds=3600)
        self.assert_decision('reauthenticate', 'provider_token_expired',
                             connection=connection, policy=policy, now=now)

    def test_connection_and_idle_seconds_do_not_gain_an_hour_at_dst_fold(self):
        eastern = ZoneInfo('America/New_York')
        verified = datetime(2026, 11, 1, 1, 30, tzinfo=eastern, fold=0)
        now = datetime(2026, 11, 1, 1, 30, tzinfo=eastern, fold=1)
        future = datetime(2026, 11, 1, 9, 0, tzinfo=timezone.utc)
        connection = replace(self.connection, verified_at=verified, last_used_at=verified,
                             provider_expiry=ExpiryEvidence(future, RELATIVE),
                             consent_expires_at=future)
        policy = replace(self.policy, max_connection_seconds=14400,
                         idle_seconds=3600, safety_seconds=0)
        self.assert_decision('reauthenticate', 'connection_idle', connection=connection,
                             policy=policy, now=now)
        self.assert_decision('reauthenticate', 'connection_expired',
                             connection=replace(connection, last_used_at=now),
                             policy=replace(policy, max_connection_seconds=3600), now=now)

    def test_account_mes_identity_tenant_and_app_changes_are_blocked(self):
        changes = dict(local_user_id=102, mes_user_id=203, tenant_id='synthetic-other', app_id=304)
        for field, value in changes.items():
            with self.subTest(field=field):
                self.assert_decision('blocked', 'identity_mismatch',
                                     actor=replace(self.actor, **{field: value}))

    def test_session_password_digest_and_review_changes_require_new_authentication(self):
        self.assert_decision('reauthenticate', 'session_changed',
                             actor=replace(self.actor, session_digest='c' * 64))
        # A trusted caller must incorporate password/role changes in this digest;
        # this fixture does not implement or claim a production logout hook.
        self.assert_decision('reauthenticate', 'authorization_changed',
                             actor=replace(self.actor, authorization_digest='d' * 64))
        self.assert_decision('reauthenticate', 'review_changed',
                             policy=replace(self.policy, review_reference='synthetic/policy-v2'))
        for contract in (UNIX, replace(RELATIVE, review_reference='synthetic/relative-v2')):
            with self.subTest(contract=contract):
                self.assert_decision('reauthenticate', 'review_changed',
                                     policy=replace(self.policy, expiry_contract=contract))

    def test_logged_out_inactive_ineligible_or_password_reset_actor_is_blocked(self):
        cases = ((dict(authenticated=False), 'local_login_required'),
                 (dict(active=False), 'actor_ineligible'),
                 (dict(eligible=False), 'actor_ineligible'),
                 (dict(password_change_required=True), 'actor_ineligible'))
        for changed, reason in cases:
            with self.subTest(changed=changed):
                self.assert_decision('blocked', reason, actor=replace(self.actor, **changed))

    def test_revoked_connection_never_becomes_reuse_candidate(self):
        for revoked_at in (NOW - timedelta(seconds=1), NOW, NOW + timedelta(seconds=1)):
            with self.subTest(revoked_at=revoked_at):
                self.assert_decision('reauthenticate', 'connection_revoked',
                                     connection=replace(self.connection, revoked_at=revoked_at))

    def test_invalid_identity_binding_is_not_coerced_for_actor_or_connection(self):
        changes = [('local_user_id', True), ('local_user_id', '101'), ('mes_user_id', 0),
                   ('mes_user_id', 2 ** 63), ('app_id', 303.0), ('tenant_id', ''),
                   ('tenant_id', 'invalid tenant'), ('session_digest', 'a' * 63),
                   ('authorization_digest', 'B' * 64)]
        for field, value in changes:
            with self.subTest(field=field, value=value):
                self.assert_decision('blocked', 'actor_invalid',
                                     actor=replace(self.actor, **{field: value}))
                self.assert_decision('blocked', 'connection_invalid',
                                     connection=replace(self.connection, **{field: value}))

    def test_actor_flags_require_exact_booleans(self):
        for field in ('authenticated', 'active', 'eligible', 'password_change_required'):
            for value in (0, 1, 'true', None):
                with self.subTest(field=field, value=value):
                    self.assert_decision('blocked', 'actor_invalid',
                                         actor=replace(self.actor, **{field: value}))

    def test_invalid_now_and_naive_connection_times_fail_closed(self):
        for value in (NOW.replace(tzinfo=None), None, True, NOW.isoformat()):
            with self.subTest(now=value):
                self.assert_decision('blocked', 'clock_invalid', now=value)
        for field in ('verified_at', 'last_used_at', 'consent_expires_at', 'revoked_at'):
            with self.subTest(field=field):
                self.assert_decision('blocked', 'connection_invalid',
                                     connection=replace(self.connection, **{field: NOW.replace(tzinfo=None)}))
        self.assert_decision('blocked', 'connection_invalid', connection=replace(
            self.connection, provider_expiry=ExpiryEvidence(NOW.replace(tzinfo=None), RELATIVE)))

    def test_malformed_timezone_and_utc_overflow_now_are_blocked_without_exception(self):
        for label, value in invalid_utc_clocks():
            with self.subTest(clock=label):
                self.assert_decision('blocked', 'clock_invalid', now=value)

    def test_malformed_timezone_and_utc_overflow_connection_times_are_blocked(self):
        for label, value in invalid_utc_clocks():
            for field in ('verified_at', 'last_used_at', 'consent_expires_at', 'revoked_at'):
                with self.subTest(clock=label, field=field):
                    self.assert_decision('blocked', 'connection_invalid',
                                         connection=replace(self.connection, **{field: value}))
            with self.subTest(clock=label, field='provider_expiry'):
                self.assert_decision('blocked', 'connection_invalid', connection=replace(
                    self.connection, provider_expiry=ExpiryEvidence(value, RELATIVE)))

    def test_connection_clock_order_and_future_activity_fail_closed(self):
        for changed in (dict(last_used_at=BASE - timedelta(microseconds=1)),
                        dict(last_used_at=NOW + timedelta(microseconds=1)),
                        dict(verified_at=NOW + timedelta(seconds=1))):
            with self.subTest(changed=changed):
                self.assert_decision('blocked', 'connection_clock_invalid',
                                     connection=replace(self.connection, **changed))
        self.assert_decision('blocked', 'connection_clock_invalid', now=BASE)

    def test_deadline_or_safety_arithmetic_overflow_fails_closed(self):
        edge = datetime.max.replace(tzinfo=timezone.utc)
        connection = replace(self.connection, verified_at=edge - timedelta(seconds=120),
                             last_used_at=edge - timedelta(seconds=60),
                             provider_expiry=ExpiryEvidence(edge, RELATIVE), consent_expires_at=edge)
        self.assert_decision('blocked', 'connection_clock_invalid', connection=connection, now=edge)
        connection = replace(connection, verified_at=edge - timedelta(seconds=1200),
                             last_used_at=edge - timedelta(seconds=300))
        self.assert_decision('blocked', 'connection_clock_invalid', connection=connection,
                             now=edge - timedelta(seconds=1))

    def test_metadata_reads_do_not_extend_idle_expiry_consent_or_maximum_age(self):
        snapshot = replace(self.connection)
        # Repeated readiness reads never count as successful MES activity.
        for seconds in (120, 240, 329):
            self.assert_decision('reuse_candidate', 'metadata_valid',
                                 now=BASE + timedelta(seconds=seconds))
            self.assertEqual(self.connection, snapshot)
        self.assert_decision('reauthenticate', 'connection_idle',
                             now=BASE + timedelta(seconds=330))
        self.assertEqual(self.connection, snapshot)
        self.assertEqual(self.connection.last_used_at, BASE + timedelta(seconds=60))
        self.assertEqual(self.connection.provider_expiry.expires_at, BASE + timedelta(hours=1))
        self.assertEqual(self.connection.consent_expires_at, BASE + timedelta(minutes=30))

    def test_actor_scope_permits_only_session_change(self):
        policy = replace(self.policy, credential_scope='actor')
        actor = replace(self.actor, session_digest='c' * 64)
        self.assert_decision('reuse_candidate', 'metadata_valid', actor=actor, policy=policy)
        for change, reason in (({'local_user_id': 999}, 'identity_mismatch'),
                               ({'mes_user_id': 999}, 'identity_mismatch'),
                               ({'authorization_digest': 'd' * 64}, 'authorization_changed'),
                               ({'authenticated': False}, 'local_login_required'),
                               ({'eligible': False}, 'actor_ineligible')):
            result = self.decision(actor=replace(actor, **change), policy=policy)
            self.assertEqual(result.reason, reason)
            self.assertNotEqual(result.action, 'reuse_candidate')
        for scope in ('shared', '', None, True):
            self.assert_decision('blocked', 'policy_unreviewed',
                                 policy=replace(policy, credential_scope=scope))
