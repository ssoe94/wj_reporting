from datetime import datetime
from unittest.mock import patch
from zoneinfo import ZoneInfo

from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from injection.models import MouldDataSnapshot, MouldUsageConfirmation
from injection.mould_snapshots import (
    BOARD_SNAPSHOT_KEY,
    decorate_detail_payload,
    detail_snapshot_key,
    last_production_at,
)


SHANGHAI = ZoneInfo('Asia/Shanghai')


def detail_payload(*, shot_count=245_000):
    return {
        'mould': {
            'instance_id': '123',
            'mould_code': 'MOLD-0123',
            'current_output_amount': shot_count,
            'location': {'code': 'A1-1', 'kind': 'storage'},
        },
        'production_history': [
            {'period': '2025-12', 'year': 2025, 'month': 12, 'quantity': 100},
            {'period': '2026-01', 'year': 2026, 'month': 1, 'quantity': 200},
        ],
        'data_freshness': {
            'status': 'live',
            'fetched_at': '2026-08-07T08:00:00+08:00',
            'source_latest_at': '2026-08-07T07:59:00+08:00',
        },
    }


class MouldSnapshotUsageTests(TestCase):
    def test_last_production_uses_monthly_period_not_generic_record_timestamp(self):
        result = last_production_at([
            {
                'period': '2025-11',
                'year': 2025,
                'month': 11,
                'recorded_at': '2026-08-07T08:00:00+08:00',
            },
            {'period': '2026', 'year': 2026, 'month': None},
        ])

        self.assertEqual(result, datetime(2025, 11, 30, 23, 59, 59, tzinfo=SHANGHAI))

    def test_detail_marks_latest_reached_100k_checkpoint_pending(self):
        decorated = decorate_detail_payload(detail_payload())

        self.assertEqual(decorated['mould']['shot_milestone'], 200_000)
        self.assertEqual(decorated['mould']['pending_milestone'], 200_000)
        self.assertTrue(decorated['mould']['confirmation_required'])

    def test_detail_checkpoint_uses_continuous_history_when_mes_counter_reset(self):
        payload = detail_payload(shot_count=115_224)
        payload['production_history'] = [
            {'period': '2024-12', 'year': 2024, 'month': 12, 'quantity': 276_430},
            {'period': '2025-01', 'year': 2025, 'month': 1, 'quantity': 6_679},
            {'period': '2026-07', 'year': 2026, 'month': 7, 'quantity': 142_456},
        ]

        decorated = decorate_detail_payload(payload)

        self.assertEqual(decorated['mould']['shot_milestone'], 400_000)
        self.assertEqual(decorated['mould']['pending_milestone'], 400_000)

    def test_existing_detail_snapshot_gets_continuous_cross_year_cumulative(self):
        payload = detail_payload()
        payload['production_history'][0]['cumulative_quantity'] = 139_798
        payload['production_history'][1]['cumulative_quantity'] = 200

        decorated = decorate_detail_payload(payload)

        self.assertEqual(
            [row['cumulative_quantity'] for row in decorated['production_history']],
            [100, 300],
        )
        self.assertEqual(
            [row['source_cumulative_quantity'] for row in decorated['production_history']],
            [139_798, 200],
        )

    def test_confirmed_checkpoint_is_not_pending(self):
        user = User.objects.create_user('mould-user')
        MouldUsageConfirmation.objects.create(
            mould_instance_id='123',
            milestone_shots=200_000,
            shot_count_at_confirmation=245_000,
            confirmed_by=user,
        )

        decorated = decorate_detail_payload(detail_payload())

        self.assertEqual(decorated['mould']['confirmed_milestone'], 200_000)
        self.assertIsNone(decorated['mould']['pending_milestone'])
        self.assertFalse(decorated['mould']['confirmation_required'])

    @patch('injection.mould_views.build_mould_board')
    def test_board_uses_database_snapshot_without_calling_blacklake(self, build_board):
        MouldDataSnapshot.objects.create(
            snapshot_key=BOARD_SNAPSHOT_KEY,
            kind=MouldDataSnapshot.KIND_BOARD,
            payload={
                'summary': {'total': 0},
                'locations': [],
                'machines': [],
                'moulds': [],
                'data_freshness': {'status': 'live'},
            },
        )

        response = APIClient().get('/api/injection/moulds/board/')

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['data_freshness']['status'], 'snapshot')
        build_board.assert_not_called()

    def test_usage_confirmation_requires_edit_permission_and_is_audited(self):
        MouldDataSnapshot.objects.create(
            snapshot_key=detail_snapshot_key('123'),
            kind=MouldDataSnapshot.KIND_DETAIL,
            instance_id='123',
            payload=detail_payload(),
        )
        user = User.objects.create_user('mould-editor')
        user.profile.can_edit_injection = True
        user.profile.save(update_fields=['can_edit_injection'])
        client = APIClient()
        client.force_authenticate(user)

        response = client.post(
            '/api/injection/moulds/123/usage-confirmations/',
            {'milestone_shots': 200_000},
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        confirmation = MouldUsageConfirmation.objects.get()
        self.assertEqual(confirmation.confirmed_by, user)
        self.assertEqual(confirmation.shot_count_at_confirmation, 245_000)

    def test_usage_confirmation_uses_continuous_history_after_mes_counter_reset(self):
        payload = detail_payload(shot_count=115_224)
        payload['production_history'] = [
            {'period': '2024-12', 'year': 2024, 'month': 12, 'quantity': 276_430},
            {'period': '2025-01', 'year': 2025, 'month': 1, 'quantity': 6_679},
            {'period': '2026-07', 'year': 2026, 'month': 7, 'quantity': 142_456},
        ]
        MouldDataSnapshot.objects.create(
            snapshot_key=detail_snapshot_key('123'),
            kind=MouldDataSnapshot.KIND_DETAIL,
            instance_id='123',
            payload=payload,
        )
        user = User.objects.create_user('mould-history-editor')
        user.profile.can_edit_injection = True
        user.profile.save(update_fields=['can_edit_injection'])
        client = APIClient()
        client.force_authenticate(user)

        response = client.post(
            '/api/injection/moulds/123/usage-confirmations/',
            {'milestone_shots': 400_000},
            format='json',
        )

        self.assertEqual(response.status_code, 201)
        confirmation = MouldUsageConfirmation.objects.get()
        self.assertEqual(confirmation.shot_count_at_confirmation, 425_565)

    def test_usage_confirmation_is_not_public(self):
        MouldDataSnapshot.objects.create(
            snapshot_key=detail_snapshot_key('123'),
            kind=MouldDataSnapshot.KIND_DETAIL,
            instance_id='123',
            payload=detail_payload(),
        )

        response = APIClient().post(
            '/api/injection/moulds/123/usage-confirmations/',
            {'milestone_shots': 200_000},
            format='json',
        )

        self.assertIn(response.status_code, (401, 403))
        self.assertFalse(MouldUsageConfirmation.objects.exists())
