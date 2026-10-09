"""Synthetic offline stage integrity; never evidence of provider partial support."""
from dataclasses import replace
from datetime import datetime, timedelta, timezone
import json
from unittest import TestCase
from uuid import UUID

from .inspection_blacklake_contract import ITEM_RECORD, TASK_FINISH
from .inspection_partial_trial_contract import (
    OfflinePartialTrial, PLAN_NAME, TRIAL_CODE, TrialBlocked, TrialItem,
    TrialObservation, TrialRecord, TrialScope,
)


class OfflinePartialTrialContractTests(TestCase):
    def setUp(self):
        self.at = datetime(2026, 10, 7, 7, tzinfo=timezone.utc)
        self.scope = TrialScope('9000000000000000001', '9000000000000000002',
            'SYNTHETIC-TENANT', 71, '9000000000000000003',
            (TrialItem('A', '9000000000000000004', '9000000000000000006', 'SYNTHETIC'),
             TrialItem('B', '9000000000000000005', '9000000000000000007', 'SYNTHETIC')),
            self.at, self.at + timedelta(minutes=30), ('9000000000000000099',),
            'SYNTHETIC-CREATE-RECEIPT', 'SYNTHETIC-INDEPENDENT-REVIEW',
            'SYNTHETIC-EXISTING-LEE-AUTHORITY-NOT-LIVE-PROOF', 'c' * 64)
        self.trial = OfflinePartialTrial(self.scope)

    def observation(self, values=(), *, seconds=0, **changes):
        stamp = self.at + timedelta(seconds=seconds)
        records = tuple(TrialRecord(item.read_id, item.group, item.seq, value,
            self.scope.executor_mes_id, self.at, stamp,
            '9000000000000000010' if item.local_id == 'A' else '9000000000000000011')
            for item, value in zip(self.scope.items, values))
        return replace(TrialObservation(self.scope.qc_id, self.scope.config_id,
            TRIAL_CODE, self.scope.tenant, self.scope.executor_mes_id, stamp, records,
            self.scope.reviewed_configuration_digest,
            tuple((item.read_id, item.group, item.seq) for item in self.scope.items)), **changes)

    def reserve(self, index, before, *, seconds=0, **changes):
        kwargs = {'now': self.at + timedelta(seconds=seconds),
            'executor_wj_id': self.scope.executor_wj_id,
            'executor_mes_id': self.scope.executor_mes_id}
        kwargs.update(changes)
        return self.trial.reserve(('setup-full', 'sparse-a', 'sparse-b', 'finish')[index],
            str(UUID(int=index + 1)), before, **kwargs)

    def seed(self):
        intent = self.reserve(0, self.observation())
        after = self.observation(('10.0', '20.0'), seconds=1)
        self.trial.observe_result(intent.key, after, now=after.observed_at)
        return after

    def test_full_setup_two_sparse_stages_then_separate_finish_exact_large_ids(self):
        self.assertIn(TRIAL_CODE, PLAN_NAME)
        seed = self.seed()
        a = self.reserve(1, seed, seconds=1)
        self.assertEqual(a.endpoint, ITEM_RECORD)
        body = json.loads(a.json_body)
        self.assertEqual(body['taskId'], 9000000000000000001)
        self.assertEqual(body['checkItems'], [{'checkItemId': 9000000000000000006,
            'groupName': 'SYNTHETIC', 'seq': 1, 'result': '10.1'}])
        after_a = self.observation(('10.1', '20.0'), seconds=2,
            records=(replace(seed.records[0], value='10.1', updated_at=self.at + timedelta(seconds=2)), seed.records[1]))
        self.trial.observe_result(a.key, after_a, now=after_a.observed_at)
        b = self.reserve(2, after_a, seconds=2)
        self.assertEqual(len(json.loads(b.json_body)['checkItems']), 1)
        after_b = replace(after_a, observed_at=self.at + timedelta(seconds=3),
            records=(after_a.records[0], replace(after_a.records[1], value='20.1', updated_at=self.at + timedelta(seconds=3))))
        self.trial.observe_result(b.key, after_b, now=after_b.observed_at)
        finish = self.reserve(3, after_b, seconds=3)
        self.assertEqual(finish.endpoint, TASK_FINISH)
        self.assertEqual(json.loads(finish.json_body), {'id': 9000000000000000001, 'status': 1})
        self.assertFalse(finish.live_authorized)
        self.assertFalse(hasattr(finish, 'send'))
        self.assertEqual(len(finish.scope_marker), 64)
        final = replace(after_b, state='completed', verdict='pass',
            observed_at=self.at + timedelta(seconds=4), completed_at=self.at + timedelta(seconds=4))
        self.assertEqual(self.trial.observe_result(finish.key, final, now=final.observed_at), 'complete')
        with self.assertRaises(TrialBlocked): self.reserve(3, final, seconds=4)

    def test_timeout_blocks_every_write_until_read_only_reconciliation_without_new_intent(self):
        intent = self.reserve(0, self.observation())
        self.trial.mark_unknown(intent.key)
        after = self.observation(('10.0', '20.0'), seconds=1)
        with self.assertRaises(TrialBlocked): self.reserve(0, self.observation(), seconds=1)
        with self.assertRaises(TrialBlocked): self.trial.observe_result(intent.key, after, now=after.observed_at)
        self.assertEqual(self.trial.observe_result(intent.key, after, now=after.observed_at, reconcile=True), 'sparse-a')
        self.assertEqual(len(self.trial._keys), 1)

    def test_omitted_value_or_operator_or_timestamp_change_never_advances(self):
        for field, value in [('value', '20.1'), ('operator_id', '999'),
                             ('updated_at', self.at + timedelta(seconds=2)), ('record_id', '998')]:
            with self.subTest(field=field):
                self.trial = OfflinePartialTrial(self.scope)
                seed = self.seed()
                a = self.reserve(1, seed, seconds=1)
                after = replace(seed, observed_at=self.at + timedelta(seconds=2),
                    records=(replace(seed.records[0], value='10.1', updated_at=self.at + timedelta(seconds=2)),
                             replace(seed.records[1], **{field: value})))
                with self.assertRaises(TrialBlocked): self.trial.observe_result(a.key, after, now=after.observed_at)
                self.assertEqual(self.trial.phase, 'unknown')

    def test_missing_null_or_invalid_metadata_is_not_preservation_evidence(self):
        for changes in ({'operator_id': None}, {'operator_id': True}, {'created_at': None},
                        {'updated_at': None}, {'record_id': None}, {'record_id': True},
                        {'created_at': self.at.replace(tzinfo=None)}):
            with self.subTest(changes=changes):
                self.trial = OfflinePartialTrial(self.scope)
                intent = self.reserve(0, self.observation())
                after = self.observation(('10.0', '20.0'), seconds=1)
                after = replace(after, records=(replace(after.records[0], **changes), after.records[1]))
                with self.assertRaises(TrialBlocked): self.trial.observe_result(intent.key, after, now=after.observed_at)
                self.assertEqual(self.trial.phase, 'unknown')

    def test_changed_fresh_baseline_and_wrong_executor_fail_before_reservation(self):
        seed = self.seed()
        external = replace(seed, records=(replace(seed.records[0], value='10.1'), seed.records[1]))
        with self.assertRaises(TrialBlocked): self.reserve(1, external, seconds=1)
        with self.assertRaises(TrialBlocked): self.reserve(1, seed, seconds=1, executor_wj_id=72)
        with self.assertRaises(TrialBlocked): self.reserve(1, seed, seconds=1, executor_mes_id='999')
        self.assertIsNone(self.trial.pending)

    def test_extra_or_missing_item_or_production_link_or_quantity_is_rejected(self):
        seed = self.seed()
        for records in (seed.records[:1], (*seed.records, replace(seed.records[0], read_id='998'))):
            with self.subTest(records=records), self.assertRaises(TrialBlocked):
                self.reserve(1, replace(seed, records=records), seconds=1)
        for changes in ({'production_links': ('SYNTHETIC-WORK-ORDER',)}, {'quantity_not_recorded': False}):
            with self.subTest(changes=changes), self.assertRaises(TrialBlocked):
                self.reserve(1, replace(seed, **changes), seconds=1)
        self.assertIsNone(self.trial.pending)

    def test_historical_completed_target_wrong_code_and_expiry_never_reserve(self):
        with self.assertRaises(TrialBlocked): replace(self.scope, qc_id=self.scope.excluded_qc_ids[0])
        for changes in ({'qc_code': 'WJ-IT-OLD-COMPLETED'}, {'state': 'completed'},
                        {'config_id': '999'}, {'executor_mes_id': '999'}):
            with self.subTest(changes=changes), self.assertRaises(TrialBlocked):
                self.reserve(0, self.observation(**changes))
        with self.assertRaises(TrialBlocked): self.reserve(0, self.observation(seconds=1800), seconds=1800)
        with self.assertRaises(TrialBlocked): self.reserve(0, self.observation(), seconds=61)
        self.assertIsNone(self.trial.pending)

    def test_acknowledgement_cannot_advance_without_actual_item_observation(self):
        # Scalar acknowledgements are not observations and cannot advance setup.
        intent = self.reserve(0, self.observation())
        with self.assertRaises(TrialBlocked):
            self.trial.observe_result(intent.key, {'code': 200, 'data': True}, now=self.at)
        self.assertEqual(self.trial.phase, 'unknown')

    def test_changed_configuration_or_extra_unrecorded_config_item_blocks_setup(self):
        base = self.observation()
        for changes in ({'configuration_digest': 'd' * 64},
                        {'config_item_keys': base.config_item_keys[:1]},
                        {'config_item_keys': (*base.config_item_keys, ('999', 'SYNTHETIC', 1))}):
            with self.subTest(changes=changes), self.assertRaises(TrialBlocked):
                self.reserve(0, replace(base, **changes))
        self.assertIsNone(self.trial.pending)

    def test_expired_unknown_can_reconcile_read_without_enabling_next_write(self):
        intent = self.reserve(0, self.observation())
        self.trial.mark_unknown(intent.key)
        after = self.observation(('10.0', '20.0'), seconds=1801)
        self.assertEqual(self.trial.observe_result(intent.key, after,
            now=after.observed_at, reconcile=True), 'sparse-a')
        with self.assertRaises(TrialBlocked): self.reserve(1, after, seconds=1801)

    def test_known_failure_or_missing_omitted_row_stays_unknown_without_finish(self):
        seed = self.seed()
        intent = self.reserve(1, seed, seconds=1)
        after = self.observation(('10.1',), seconds=2)
        with self.assertRaises(TrialBlocked): self.trial.observe_result(intent.key, after, now=after.observed_at)
        with self.assertRaises(TrialBlocked): self.reserve(3, after, seconds=2)
        self.assertEqual(self.trial.phase, 'unknown')

    def test_review_references_and_exclusion_manifest_are_required(self):
        for changes in ({'execution_review_reference': ''}, {'existing_lee_authority_reference': ''},
                        {'creation_receipt_reference': ''}, {'excluded_qc_ids': ()},
                        {'expires_at': self.at + timedelta(minutes=31)}):
            with self.subTest(changes=changes), self.assertRaises(TrialBlocked): replace(self.scope, **changes)

    def test_written_row_must_observe_actual_authorized_executor_operator(self):
        intent = self.reserve(0, self.observation())
        after = self.observation(('10.0', '20.0'), seconds=1)
        after = replace(after, records=(replace(after.records[0], operator_id='999'), after.records[1]))
        with self.assertRaises(TrialBlocked): self.trial.observe_result(intent.key, after, now=after.observed_at)
        self.assertEqual(self.trial.phase, 'unknown')

    def test_old_stage_key_cannot_reserve_next_stage_or_replay_write(self):
        seed = self.seed()
        with self.assertRaises(TrialBlocked):
            self.trial.reserve('sparse-a', str(UUID(int=1)), seed, now=seed.observed_at,
                executor_wj_id=self.scope.executor_wj_id, executor_mes_id=self.scope.executor_mes_id)
        self.assertIsNone(self.trial.pending)

    def test_approval_pending_or_changed_record_cannot_verify_finish(self):
        for case in ('approval_pending', 'changed-record', 'missing-completion-time'):
            with self.subTest(case=case):
                self.trial = OfflinePartialTrial(self.scope)
                seed = self.seed()
                a = self.reserve(1, seed, seconds=1)
                after_a = replace(seed, observed_at=self.at + timedelta(seconds=2),
                    records=(replace(seed.records[0], value='10.1', updated_at=self.at + timedelta(seconds=2)), seed.records[1]))
                self.trial.observe_result(a.key, after_a, now=after_a.observed_at)
                b = self.reserve(2, after_a, seconds=2)
                after_b = replace(after_a, observed_at=self.at + timedelta(seconds=3),
                    records=(after_a.records[0], replace(after_a.records[1], value='20.1', updated_at=self.at + timedelta(seconds=3))))
                self.trial.observe_result(b.key, after_b, now=after_b.observed_at)
                finish = self.reserve(3, after_b, seconds=3)
                final = replace(after_b, state='completed', verdict='pass',
                    observed_at=self.at + timedelta(seconds=4), completed_at=self.at + timedelta(seconds=4))
                if case == 'approval_pending': final = replace(final, state='approval_pending')
                if case == 'changed-record': final = replace(final,
                    records=(replace(final.records[0], operator_id='999'), final.records[1]))
                if case == 'missing-completion-time': final = replace(final, completed_at=None)
                with self.assertRaises(TrialBlocked): self.trial.observe_result(finish.key, final, now=final.observed_at)
                self.assertEqual(self.trial.phase, 'unknown')

    def test_public_scope_cannot_be_reassigned_after_intent(self):
        intent = self.reserve(0, self.observation())
        with self.assertRaises(AttributeError):
            self.trial.scope = replace(self.scope, qc_id='999')
        self.assertEqual(self.trial.pending, intent)

    def test_pending_scope_drift_cannot_accept_different_target_expiry_or_review(self):
        for changes in ({'qc_id': '999'}, {'expires_at': self.scope.expires_at - timedelta(minutes=1)},
                        {'execution_review_reference': 'SYNTHETIC-DIFFERENT-REVIEW'}):
            with self.subTest(changes=changes):
                self.trial = OfflinePartialTrial(self.scope)
                intent = self.reserve(0, self.observation())
                # Simulate an erroneous internal restore; normal scope assignment is read-only.
                self.trial._scope = replace(self.scope, **changes)
                after = self.observation(('10.0', '20.0'), seconds=1)
                if 'qc_id' in changes: after = replace(after, qc_id=changes['qc_id'])
                with self.assertRaises(TrialBlocked): self.trial.observe_result(intent.key, after, now=after.observed_at)
                self.assertEqual(self.trial.phase, 'unknown')
                self.assertEqual(self.trial.pending, intent)

    def test_between_stage_target_drift_cannot_reserve_next_intent(self):
        seed = self.seed()
        self.trial._scope = replace(self.scope, qc_id='999')
        with self.assertRaises(TrialBlocked): self.reserve(1, replace(seed, qc_id='999'), seconds=1)
        self.assertIsNone(self.trial.pending)
        self.assertEqual(len(self.trial._keys), 1)

    def test_pending_intent_scope_marker_is_checked_on_unknown_reconciliation(self):
        intent = self.reserve(0, self.observation())
        self.trial.pending = replace(intent, scope_marker='0' * 64)
        self.trial.mark_unknown(intent.key)
        after = self.observation(('10.0', '20.0'), seconds=1)
        with self.assertRaises(TrialBlocked):
            self.trial.observe_result(intent.key, after, now=after.observed_at, reconcile=True)
        self.assertEqual(self.trial.phase, 'unknown')
        self.assertIsNotNone(self.trial.pending)

    def test_duplicate_raw_record_id_cannot_verify_two_distinct_items(self):
        intent = self.reserve(0, self.observation())
        after = self.observation(('10.0', '20.0'), seconds=1)
        after = replace(after, records=(after.records[0],
            replace(after.records[1], record_id=after.records[0].record_id)))
        with self.assertRaises(TrialBlocked): self.trial.observe_result(intent.key, after, now=after.observed_at)
        self.assertEqual(self.trial.phase, 'unknown')
