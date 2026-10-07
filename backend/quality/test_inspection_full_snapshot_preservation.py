"""Synthetic existing-record preservation checks; no MES I/O or credentials."""
from copy import deepcopy
from dataclasses import replace
from datetime import timedelta
from unittest.mock import Mock
import uuid

from django.test import TestCase
from django.utils import timezone

from . import test_inspection_full_snapshot as fixtures
from .inspection_full_snapshot import (
    FullSnapshotCoordinator, binding_fingerprint, build_full_snapshot,
)
from .inspection_full_snapshot_connection import (
    BlacklakeFullSnapshotAdapter, ReviewedFullSnapshotConnection,
)
from .inspection_full_snapshot_readback import FullDetailReview
from .inspection_models import InspectionOperation


class PreservingFixtureAdapter(fixtures.FixtureAdapter):
    """A synthetic CAS provider capable of carrying unchanged rows verbatim."""

    @staticmethod
    def record_key(row):
        return row['group'], row['config_row_id'], row['seq']

    def guarded_save(self, binding, intent, expected, operation_id, authority):
        if self.before_save:
            self.before_save()
        self._cas(expected)
        self.calls.append(('save', operation_id, deepcopy(intent['payload'])))
        existing = {self.record_key(row): row for row in self.remote['records']}
        now_ms = int(timezone.now().timestamp() * 1000)
        self.remote['records'] = [
            deepcopy(existing[self.record_key(row)])
            if self.record_key(row) in existing else dict(
                row, record_id=str(2201 + index), operator_id=authority.mes_user_id,
                created_at=now_ms - 10, updated_at=now_ms,
            )
            for index, row in enumerate(intent['expected_records'])
        ]
        if self.after_save:
            self.after_save()
        if self.save_timeout:
            raise TimeoutError('synthetic timeout after preservation-capable save')


class FullSnapshotPreservationTests(TestCase):
    # Reuse only the existing isolated fixture helpers, not its test methods.
    guard = fixtures.FullSnapshotContractTests.guard
    make_coordinator = fixtures.FullSnapshotContractTests.make_coordinator
    run_stage = fixtures.FullSnapshotContractTests.run_stage
    assert_code = fixtures.FullSnapshotContractTests.assert_code

    def setUp(self):
        fixtures.FullSnapshotContractTests.setUp(self)
        self.adapter = PreservingFixtureAdapter()
        self.coordinator = self.make_coordinator()
        now_ms = int(timezone.now().timestamp() * 1000)
        self.existing = {
            'config_row_id': '1101', 'group': 'SYNTHETIC', 'seq': 1,
            'value': '10.1', 'record_id': '1901', 'operator_id': '901',
            'created_at': now_ms - 120000, 'updated_at': now_ms - 60000,
        }
        self.adapter.remote['records'] = [deepcopy(self.existing)]

    def assert_no_reservation_or_write(self):
        self.assertFalse(InspectionOperation.objects.exists())
        self.assertEqual(self.adapter.calls, [])
        self.request.refresh_from_db()
        self.binding.refresh_from_db()
        self.assertEqual(self.request.version, 1)
        self.assertEqual(self.binding.phase, 'ready')

    def test_existing_different_value_blocks_before_reservation_without_rewrite(self):
        self.adapter.remote['records'][0]['value'] = 'SYNTHETIC earlier different result'
        baseline = deepcopy(self.adapter.remote['records'])
        self.assert_code('mes_existing_result_change_unreviewed', self.run_stage)
        self.assert_no_reservation_or_write()
        self.assertEqual(self.adapter.remote['records'], baseline)

    def test_same_value_existing_author_is_preserved_while_new_row_uses_executor(self):
        saved = self.run_stage()
        self.assertEqual(saved['status'], 'succeeded', saved)
        records = deepcopy(self.adapter.remote['records'])
        self.assertEqual(records[0], self.existing)
        self.assertEqual(records[1]['operator_id'], '501')
        self.assertNotEqual(records[0]['operator_id'], records[1]['operator_id'])
        self.assertEqual(len(self.adapter.calls[0][2]['checkItems']), 2)
        operation = InspectionOperation.objects.get(pk=saved['operation_id'])
        self.assertEqual(operation.response['intent']['baseline']['records'], [self.existing])
        self.assertEqual(operation.response['readback']['records'][0], self.existing)

        finished = self.run_stage(stage='finish')
        self.assertEqual(finished['status'], 'succeeded', finished)
        self.assertEqual(self.adapter.remote['records'], records)
        self.assertEqual([entry[0] for entry in self.adapter.calls], ['save', 'finish'])

    def metadata_change_stays_unknown_without_redispatch(self, field, value):
        def alter_existing_metadata():
            self.adapter.remote['records'][0][field] = value
        self.adapter.after_save = alter_existing_metadata
        key = uuid.uuid4()
        unknown = self.run_stage(key=key)
        self.assertEqual((unknown['status'], unknown['code']),
                         ('unknown', 'mes_result_provenance_changed'))
        self.assertEqual([entry[0] for entry in self.adapter.calls], ['save'])
        self.binding.refresh_from_db()
        self.assertEqual(self.binding.phase, 'full_save_unknown')

        replay = self.run_stage(key=key, coordinator=self.make_coordinator())
        self.assertEqual(replay, unknown)
        self.assert_code('operation_unresolved', self.run_stage)
        self.assert_code('mes_result_provenance_changed', lambda: self.make_coordinator().reconcile(
            self.actor, self.request.pk, unknown['operation_id']))
        self.assertEqual([entry[0] for entry in self.adapter.calls], ['save'])
        self.assertEqual(InspectionOperation.objects.get(pk=unknown['operation_id']).status, 'unknown')

    def test_existing_record_id_rewrite_stays_unknown_without_redispatch(self):
        self.metadata_change_stays_unknown_without_redispatch('record_id', '3901')

    def test_existing_author_rewrite_stays_unknown_without_redispatch(self):
        self.metadata_change_stays_unknown_without_redispatch('operator_id', '501')

    def test_existing_creation_time_rewrite_stays_unknown_without_redispatch(self):
        self.metadata_change_stays_unknown_without_redispatch(
            'created_at', self.existing['created_at'] + 1)

    def test_existing_update_time_rewrite_stays_unknown_without_redispatch(self):
        self.metadata_change_stays_unknown_without_redispatch(
            'updated_at', self.existing['updated_at'] + 1)

    def test_new_row_cannot_borrow_an_existing_records_author(self):
        def alter_new_author():
            self.adapter.remote['records'][1]['operator_id'] = self.existing['operator_id']
        self.adapter.after_save = alter_new_author
        result = self.run_stage()
        self.assertEqual((result['status'], result['code']), ('unknown', 'mes_executor_mismatch'))
        self.assertEqual([entry[0] for entry in self.adapter.calls], ['save'])

    def test_timeout_with_preserved_records_reconciles_by_read_without_resend(self):
        self.adapter.save_timeout = True
        key = uuid.uuid4()
        unknown = self.run_stage(key=key)
        self.assertEqual(unknown['status'], 'unknown', unknown)
        records = deepcopy(self.adapter.remote['records'])
        self.assertEqual(records[0], self.existing)
        receipt = self.make_coordinator().reconcile(self.actor, self.request.pk, unknown['operation_id'])
        self.assertEqual(receipt['status'], 'succeeded', receipt)
        self.assertEqual(self.run_stage(key=key, coordinator=self.make_coordinator()), receipt)
        self.assertEqual(self.adapter.remote['records'], records)
        self.assertEqual([entry[0] for entry in self.adapter.calls], ['save'])

    def concrete_adapter(self, *, reviewed_preservation=False):
        policy = ReviewedFullSnapshotConnection(
            request_id=self.request.pk, actor_id=self.actor.pk,
            reviewer_actor_id=self.other_actor.pk, tenant=self.binding.tenant,
            mes_user_id=501, qc_id=self.binding.qc_id, qc_code='SYNTHETIC QC',
            snapshot_id='1002', binding_digest=binding_fingerprint(self.binding),
            source_digest=self.source_digest, source_request_version=1,
            expires_at=timezone.now() + timedelta(minutes=5),
            review_reference='SYNTHETIC-preservation-review',
            detail_review=FullDetailReview(qc_code='SYNTHETIC QC', pins=()),
            write_authorized=True, concurrency_mode='provider_cas',
            concurrency_reference='SYNTHETIC-provider-CAS',
        )
        if reviewed_preservation:
            policy = replace(policy, preserves_existing_records=True)
        forbidden = Mock(side_effect=AssertionError('No wire call or credential access is permitted'))
        adapter = BlacklakeFullSnapshotAdapter(
            policy, session=None, sender=forbidden, credential_call=forbidden,
            identity_provider=object(), executor_guard=object(), atomic_writer=forbidden,
        )
        adapter.read = Mock(side_effect=self.adapter.read)
        return adapter, forbidden

    def test_concrete_default_blocks_nonempty_baseline_before_reservation(self):
        adapter, forbidden = self.concrete_adapter()
        self.assertFalse(adapter.policy.preserves_existing_records)
        coordinator = FullSnapshotCoordinator(
            source=self.source, executor_guard=self.guard, adapter=adapter)
        self.assert_code('mes_existing_result_preservation_unverified',
                         lambda: self.run_stage(coordinator=coordinator))
        self.assert_no_reservation_or_write()
        forbidden.assert_not_called()
        self.assertEqual(self.adapter.remote['records'], [self.existing])

    def test_concrete_reviewed_preservation_flag_allows_baseline_validation_only(self):
        adapter, forbidden = self.concrete_adapter(reviewed_preservation=True)
        intent = build_full_snapshot(self.source.data, self.binding,
                                    self.adapter.read(self.binding, None))
        adapter.validate_save_baseline(self.binding, intent)
        self.assert_no_reservation_or_write()
        forbidden.assert_not_called()
        self.assertEqual(self.adapter.remote['records'], [self.existing])
