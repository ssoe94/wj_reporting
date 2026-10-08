"""Server policy loading with isolated WJ rows; never acquire MES credentials."""
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from decimal import Decimal
from unittest.mock import Mock, patch

from django.db import transaction
from django.test import TestCase, override_settings
from django.utils import timezone
from mes_oauth.session_guard import InspectionSession

from . import test_inspection_full_snapshot_product as product_fixtures
from . import test_inspection_roles as role_fixtures
from .inspection_full_snapshot import binding_fingerprint, fingerprint
from .inspection_full_snapshot_authority import CurrentExecutorGuard
from .inspection_full_snapshot_connection import ReviewedFullSnapshotConnection
from .inspection_full_snapshot_policy import (
    POLICY_KEY, binding_scope_digest, load_binding_connection, reviewed_manifest,
)
from .inspection_full_snapshot_product import (
    ProductExecutorGuard, _approved, get_coordinator, load_connection, product_summary,
)
from .inspection_full_snapshot_readback import DetailPin, FullDetailReview
from .inspection_models import InspectionMesBinding, InspectionOperation, InspectionRequest
from .inspection_role_models import InspectionAreaResult
from .inspection_validation import digest
from .inspection_workflow import lock_scope, result_payload


@override_settings(INSPECTION_FULL_SNAPSHOT_CONNECTIONS={},
                   MES_USER_OAUTH_PROVIDER_ORIGIN='https://v3-ali.blacklake.cn',
                   MES_USER_OAUTH_APP_TOKEN_HEADER='access_token')
class FullSnapshotPolicyTests(role_fixtures.RoleFixtures, TestCase):
    completed_areas = product_fixtures.FullSnapshotProductSourceTests.completed_areas
    approve = product_fixtures.FullSnapshotProductSourceTests.approve
    capture = product_fixtures.FullSnapshotProductSourceTests.capture
    bind = product_fixtures.FullSnapshotProductSourceTests.bind
    assert_code = product_fixtures.FullSnapshotProductSourceTests.assert_code

    def setUp(self):
        super().setUp()
        self.configure(shared_terminal=True)
        self.completed_areas()
        self.binding = self.bind()
        self.source = self.capture()
        self.writer = Mock(side_effect=AssertionError('Synthetic policy checks must not write'))
        self.connectors = {'SYNTHETIC-cas': {'atomic_writer': self.writer}}
        setting = override_settings(INSPECTION_FULL_SNAPSHOT_CONNECTORS=self.connectors,
                                   MES_USER_OAUTH_USER_MAP={str(self.admin.pk): '501'})
        setting.enable()
        self.addCleanup(setting.disable)
        self.session = InspectionSession(self.admin.pk, 'f' * 64,
            timezone.now() + timedelta(minutes=5), {}, version=2)

    def policy(self, *, source_mode='completed_areas', reviewer_actor_id=0):
        kwargs = dict(
            request_id=self.request.pk, actor_id=self.admin.pk,
            reviewer_actor_id=reviewer_actor_id, tenant=self.binding.tenant,
            mes_user_id=501, qc_id=self.binding.qc_id, qc_code='SYNTHETIC QC',
            snapshot_id='1002', binding_digest=binding_fingerprint(self.binding),
            source_digest=fingerprint(self.capture()), source_request_version=self.request_now().version,
            expires_at=timezone.now() + timedelta(minutes=5),
            review_reference='SYNTHETIC-policy-review', write_authorized=True,
            concurrency_mode='provider_cas', concurrency_reference='SYNTHETIC-provider-CAS',
            residual_remote_race=False,
            # Serializer fixtures only: no raw MES detail is decoded in these tests.
            detail_review=FullDetailReview('SYNTHETIC QC', (
                DetailPin(('qcConfig', 'min'), Decimal('1.250'), 'number'),
                DetailPin(('qcConfig', 'inspectionResultOptions'), {'SYNTHETIC': [1, True]}),
            )),
        )
        if source_mode is not None:
            kwargs['source_mode'] = source_mode
        return ReviewedFullSnapshotConnection(**kwargs)

    def persist(self, policy=None, *, connector='SYNTHETIC-cas'):
        manifest = reviewed_manifest(policy or self.policy(), self.binding, connector=connector)
        self.binding.contract = {**self.binding.contract, POLICY_KEY: manifest}
        self.binding.save(update_fields=['contract'])
        return load_connection(self.request.pk)

    @contextmanager
    def locked(self):
        with transaction.atomic():
            lock_scope(f'inspection:{self.request.pk}')
            request = InspectionRequest.objects.select_for_update().get(pk=self.request.pk)
            binding = InspectionMesBinding.objects.select_for_update().get(request=request)
            yield request, binding

    def check_guard(self, guard):
        with self.locked() as (request, binding):
            return guard._check_policy(self.admin, request, binding, 'save')

    def assert_no_mes_operation(self):
        self.assertFalse(InspectionOperation.objects.filter(response__owner='wj-full-snapshot.v1').exists())
        self.writer.assert_not_called()

    def test_manifest_helper_writes_nothing_and_roundtrip_detaches_json(self):
        original = deepcopy(self.binding.contract)
        policy = self.policy()
        manifest = reviewed_manifest(policy, self.binding, connector='SYNTHETIC-cas')
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.contract, original)
        self.assertNotIn('binding_digest', manifest['policy'])
        self.assertEqual(manifest['binding_scope_digest'], binding_scope_digest(self.binding))
        self.assertEqual(manifest['policy']['detail_review']['pins'][0]['expected'],
                         {'kind': 'decimal', 'value': '1.250'})
        policy.detail_review.pins[1].expected['SYNTHETIC'].append(2)
        self.assertEqual(manifest['policy']['detail_review']['pins'][1]['expected'],
                         {'kind': 'object', 'value': {'SYNTHETIC': {'kind': 'array', 'value': [
                             {'kind': 'scalar', 'value': 1}, {'kind': 'scalar', 'value': True}]}}})
        self.assert_no_mes_operation()

    def test_dynamic_same_valued_connections_keep_decimal_pins_and_pass_current_guard(self):
        first = self.persist()
        second = load_binding_connection(self.request.pk)
        self.assertIsNot(first, second)
        self.assertIsNot(first.policy, second.policy)
        self.assertEqual(first.policy, second.policy)
        self.assertIs(first.atomic_writer, second.atomic_writer)
        self.assertEqual(second.policy.detail_review.pins[0].expected, Decimal('1.250'))
        self.assertEqual(second.policy.binding_digest, binding_fingerprint(self.binding))
        guard = ProductExecutorGuard(first, self.session)
        self.assertTrue(self.check_guard(guard))
        self.assert_no_mes_operation()

    def test_manifest_roundtrip_preserves_exact_decimal_configuration_pins(self):
        original = self.policy()
        review = FullDetailReview(original.qc_code, (
            DetailPin(('qcConfig', 'base'), Decimal('10.250'), 'exact'),
            DetailPin(('qcConfig', 'defaultMin'), Decimal('-0.0050'), 'exact'),
        ))
        loaded = self.persist(replace(original, detail_review=review)).policy.detail_review
        self.assertEqual(loaded, review)
        for before, after in zip(review.pins, loaded.pins):
            self.assertIs(type(after.expected), Decimal)
            self.assertEqual(after.expected.as_tuple(), before.expected.as_tuple())
        self.assert_no_mes_operation()

    def test_manifest_roundtrip_preserves_nested_decimal_and_numeric_text_types(self):
        expected = {'limits': [Decimal('1.250'), '1.250', {'value': Decimal('-0.0050'),
            'text': '-0.0050', 'integer': 2, 'boolean': True, 'null': None}]}
        original = self.policy()
        review = FullDetailReview(original.qc_code, (
            DetailPin(('qcConfig', 'SYNTHETIC-nested-value'), expected, 'exact'),
            DetailPin(('qcConfig', 'defaultValue'), '10.250', 'exact'),
        ))
        loaded = self.persist(replace(original, detail_review=review)).policy.detail_review
        self.assertEqual(loaded, review)
        limits = loaded.pins[0].expected['limits']
        self.assertIs(type(limits[0]), Decimal)
        self.assertEqual(limits[0].as_tuple(), Decimal('1.250').as_tuple())
        self.assertIs(type(limits[1]), str)
        self.assertIs(type(limits[2]['value']), Decimal)
        self.assertEqual(limits[2]['value'].as_tuple(), Decimal('-0.0050').as_tuple())
        self.assertIs(type(limits[2]['text']), str)
        self.assertIs(type(limits[2]['integer']), int)
        self.assertIs(type(limits[2]['boolean']), bool)
        self.assertIsNone(limits[2]['null'])
        self.assertIs(type(loaded.pins[1].expected), str)
        self.assert_no_mes_operation()

    def test_completed_areas_pass_source_and_current_guard_without_a_third_reviewer(self):
        connection = self.persist()
        with self.locked() as (request, binding):
            source = _approved(request, binding, connection.policy)
            self.assertEqual(source['request_status'], 'draft')
            self.assertIsNone(request.reviewed_by_id)
            self.assertNotIn('approval', source)
            self.assertEqual(connection.policy.reviewer_actor_id, 0)
            guard = CurrentExecutorGuard(connection.policy, self.session)
            self.assertTrue(guard._check_policy(self.admin, request, binding, 'save'))
        self.assertEqual({area['assigned']['id'] for area in source['areas']},
                         {self.appearance.pk, self.dimension.pk})
        self.assertEqual({area['completion']['recorder']['id'] for area in source['areas']}, {self.admin.pk})
        self.assertEqual(connection.policy.mes_user_id, 501)
        self.assert_no_mes_operation()

    def test_completed_area_mode_cannot_invent_a_reviewer(self):
        connection = self.persist(self.policy(reviewer_actor_id=self.outsider.pk))
        with self.locked() as (request, binding):
            self.assert_code('completed_area_source_required',
                             lambda: _approved(request, binding, connection.policy))
        self.assert_code('completed_area_source_required', lambda: self.check_guard(
            CurrentExecutorGuard(connection.policy, self.session)))
        self.assert_no_mes_operation()

    def test_default_mode_still_requires_independent_approval(self):
        policy = self.policy(source_mode=None, reviewer_actor_id=self.outsider.pk)
        self.assertEqual(policy.source_mode, 'independent_approval')
        connection = self.persist(policy)
        with self.locked() as (request, binding):
            self.assert_code('independent_approval_required',
                             lambda: _approved(request, binding, connection.policy))
        self.assert_no_mes_operation()

    def test_existing_independent_approval_mode_still_accepts_real_review_audits(self):
        self.approve()
        self.binding.reviewed_result_digest = digest(result_payload(self.request_now()))
        self.binding.save(update_fields=['reviewed_result_digest'])
        connection = self.persist(self.policy(source_mode=None, reviewer_actor_id=self.outsider.pk))
        with self.locked() as (request, binding):
            source = _approved(request, binding, connection.policy)
            self.assertEqual(source['approval']['reviewer']['id'], self.outsider.pk)
            self.assertTrue(CurrentExecutorGuard(connection.policy, self.session)._check_policy(
                self.admin, request, binding, 'save'))
        self.assert_no_mes_operation()

    def test_changed_binding_is_rejected_without_repinning_manifest(self):
        self.persist()
        self.binding.contract['items'][0]['write_item_id'] = '999999'
        self.binding.save(update_fields=['contract'])
        self.assert_code('whole_connection_review_required', lambda: load_connection(self.request.pk))
        self.assert_no_mes_operation()

    def test_changed_source_is_rejected_without_automatic_digest_refresh(self):
        connection = self.persist()
        area = InspectionAreaResult.objects.get(workflow=self.workflow, area='dimension')
        measurements = deepcopy(area.measurements)
        next(row for row in measurements if row['item_id'] == 'size')['value'] = '10.5'
        area.measurements = measurements
        area.save(update_fields=['measurements'])
        fresh = load_connection(self.request.pk)
        self.assertEqual(fresh.policy.source_digest, connection.policy.source_digest)
        self.assert_code('source_changed', lambda: self.check_guard(ProductExecutorGuard(fresh, self.session)))
        self.assert_no_mes_operation()

    def test_expired_and_naive_deadlines_are_rejected_without_extension(self):
        for expiry in (timezone.now() - timedelta(seconds=1), timezone.now().replace(tzinfo=None)):
            with self.subTest(expiry=expiry):
                policy = replace(self.policy(), expires_at=expiry)
                self.binding.contract[POLICY_KEY] = reviewed_manifest(policy, self.binding, connector='SYNTHETIC-cas')
                self.binding.save(update_fields=['contract'])
                self.assert_code('whole_connection_review_required', lambda: load_connection(self.request.pk))
        self.assert_no_mes_operation()

    def test_removed_or_replaced_hook_revokes_an_existing_guard(self):
        connection = self.persist()
        guard = ProductExecutorGuard(connection, self.session)
        for replacement in (None, Mock(side_effect=AssertionError('Replacement cannot be called'))):
            with self.subTest(replacement_present=replacement is not None):
                self.connectors['SYNTHETIC-cas'] = {'atomic_writer': replacement}
                self.assert_code('whole_connection_review_changed', lambda: self.check_guard(guard))
        self.assert_no_mes_operation()

    def test_nested_policy_mutation_revokes_an_existing_guard(self):
        connection = self.persist()
        guard = ProductExecutorGuard(connection, self.session)
        connection.policy.detail_review.pins[1].expected['SYNTHETIC'].append(2)
        self.assert_code('whole_connection_review_changed', lambda: self.check_guard(guard))
        self.assert_no_mes_operation()

    def test_unknown_connector_cannot_enable_a_writer(self):
        self.persist(connector='SYNTHETIC-missing')
        self.assert_code('remote_concurrency_unverified',
                         lambda: get_coordinator(self.admin, self.request.pk, self.session))
        self.assert_no_mes_operation()

    def test_default_missing_manifest_stays_blocked_without_credentials_despite_legacy_flag(self):
        with override_settings(MES_INSPECTION_ENABLED=True), \
             patch('mes_oauth.app_tokens.get_app_access_token', side_effect=AssertionError('No issuance')), \
             patch('mes_oauth.app_tokens.get_existing_app_access_token', side_effect=AssertionError('No app lease')), \
             patch('mes_oauth.inspection_credentials.call_with_user_credential', side_effect=AssertionError('No user lease')):
            self.assert_code('whole_connection_review_required', lambda: load_connection(self.request.pk))
            summary = product_summary(self.request_now(), self.admin)
        self.assertFalse(summary['enabled'])
        self.assertEqual(summary['blocked_reason'], 'whole_connection_review_required')
        self.binding.refresh_from_db()
        self.assertNotIn(POLICY_KEY, self.binding.contract)
        self.assert_no_mes_operation()

    def test_malformed_or_extra_manifest_fields_cannot_become_authority(self):
        valid = reviewed_manifest(self.policy(), self.binding, connector='SYNTHETIC-cas')
        invalid = []
        extra = deepcopy(valid)
        extra['unreviewed'] = True
        invalid.append(extra)
        boolean_actor = deepcopy(valid)
        boolean_actor['policy']['actor_id'] = True
        invalid.append(boolean_actor)
        unsupported_mode = deepcopy(valid)
        unsupported_mode['policy']['source_mode'] = 'SYNTHETIC-automatic-approval'
        invalid.append(unsupported_mode)
        nonfinite_pin = deepcopy(valid)
        nonfinite_pin['policy']['detail_review']['pins'][0]['expected'] = 'NaN'
        invalid.append(nonfinite_pin)
        for index, manifest in enumerate(invalid):
            with self.subTest(case=index):
                self.binding.contract[POLICY_KEY] = manifest
                self.binding.save(update_fields=['contract'])
                self.assert_code('whole_connection_review_required', lambda: load_connection(self.request.pk))
        self.assert_no_mes_operation()
