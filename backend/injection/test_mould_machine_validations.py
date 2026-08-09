from django.contrib.auth.models import User
from django.test import TestCase
from rest_framework.test import APIClient

from injection.models import MouldDataSnapshot
from injection.mould_machine_validations import (
    VALIDATION_RULES_SNAPSHOT_KEY,
    build_validation_lookup,
)
from injection.mould_snapshots import BOARD_SNAPSHOT_KEY


def board_payload(*, kind='machine', model='24G411A', instance_id='123'):
    return {
        'summary': {'total': 1},
        'locations': [],
        'machines': [],
        'moulds': [
            {
                'instance_id': instance_id,
                'mould_code': 'MOLD-0123',
                'asset_code': 'ASSET-24',
                'drawing_no': 'DRAWING-24',
                'model': model,
                'location': {
                    'code': '#1-850T' if kind == 'machine' else 'C3-10',
                    'kind': kind,
                    'machine_number': 1 if kind == 'machine' else None,
                },
            },
        ],
        'data_freshness': {'status': 'snapshot'},
    }


class MouldMachineValidationRuleTests(TestCase):
    endpoint = '/api/injection/moulds/machine-validation-rules/'

    def setUp(self):
        MouldDataSnapshot.objects.create(
            snapshot_key=BOARD_SNAPSHOT_KEY,
            kind=MouldDataSnapshot.KIND_BOARD,
            payload=board_payload(),
        )

    def editor_client(self):
        user = User.objects.create_user('mould-rule-editor')
        user.profile.can_edit_injection = True
        user.profile.save(update_fields=['can_edit_injection'])
        client = APIClient()
        client.force_authenticate(user)
        return client, user

    def payload(self, **overrides):
        value = {
            'action': 'confirm',
            'decision': 'match',
            'mould_instance_id': '123',
            'production_models': ['24U411B-BA.AWFYJVN'],
            'part_nos': ['24U411B-L', '24U411B-R'],
            'production_mode': 'multi_cavity',
            'cavity_pattern': '2x2',
            'business_date': '2026-08-09',
        }
        value.update(overrides)
        return value

    def test_public_get_exposes_no_rules_before_first_confirmation(self):
        response = APIClient().get(self.endpoint)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['rules'], [])

    def test_write_requires_injection_edit_permission(self):
        response = APIClient().post(self.endpoint, self.payload(), format='json')

        self.assertIn(response.status_code, (401, 403))
        self.assertFalse(
            MouldDataSnapshot.objects.filter(
                snapshot_key=VALIDATION_RULES_SNAPSHOT_KEY,
            ).exists()
        )

    def test_editor_saves_public_safe_reusable_model_pair_rule(self):
        client, user = self.editor_client()

        response = client.post(self.endpoint, self.payload(), format='json')

        self.assertEqual(response.status_code, 201)
        rule = response.json()['rule']
        self.assertEqual(rule['scope'], 'model_pair')
        self.assertEqual(rule['mould_model_key'], '24G411A')
        self.assertEqual(rule['production_model_key'], '24U411B')
        self.assertEqual(rule['decision'], 'match')
        self.assertNotIn('confirmed_by', rule)

        public_response = APIClient().get(self.endpoint)
        self.assertEqual(public_response.status_code, 200)
        self.assertEqual(public_response.json()['rules'], [rule])
        self.assertNotIn('confirmed_by', public_response.content.decode())

        stored = MouldDataSnapshot.objects.get(
            snapshot_key=VALIDATION_RULES_SNAPSHOT_KEY,
        )
        stored_rule = next(iter(stored.payload['rules'].values()))
        self.assertEqual(stored_rule['confirmed_by_id'], user.pk)
        self.assertEqual(stored.payload['history'][-1]['action'], 'confirm')

    def test_structured_pair_key_ignores_machine_date_part_order_and_instance(self):
        first = build_validation_lookup(
            mould_instance_id='123',
            mould_model='65UQ890',
            production_models=['65UQ79'],
            drawing_no='A',
        )
        second = build_validation_lookup(
            mould_instance_id='999',
            mould_model='65UQ890',
            production_models=['65UQ79'],
            drawing_no='B',
        )

        self.assertEqual(first['scope'], 'model_pair')
        self.assertEqual(first['lookup_key'], second['lookup_key'])
        self.assertEqual(first['rule_key'], second['rule_key'])

    def test_unstructured_model_rule_is_scoped_to_the_mould_instance(self):
        first = build_validation_lookup(
            mould_instance_id='123',
            mould_model='前仓行李箱',
            production_models=['汽车外部行李箱'],
            drawing_no='DRAWING-1',
        )
        second = build_validation_lookup(
            mould_instance_id='999',
            mould_model='前仓行李箱',
            production_models=['汽车外部行李箱'],
            drawing_no='DRAWING-1',
        )

        self.assertEqual(first['scope'], 'instance_pair')
        self.assertNotEqual(first['lookup_key'], second['lookup_key'])

    def test_non_mounted_mould_cannot_create_a_decision_rule(self):
        snapshot = MouldDataSnapshot.objects.get(snapshot_key=BOARD_SNAPSHOT_KEY)
        snapshot.payload = board_payload(kind='storage')
        snapshot.save(update_fields=['payload', 'refreshed_at'])
        client, _user = self.editor_client()

        response = client.post(self.endpoint, self.payload(), format='json')

        self.assertEqual(response.status_code, 409)
        self.assertIn('MES', response.json()['detail'])

    def test_saved_rule_can_be_changed_and_reset_with_an_audit_history(self):
        client, _user = self.editor_client()
        first = client.post(self.endpoint, self.payload(), format='json')
        changed = client.post(
            self.endpoint,
            self.payload(decision='mismatch'),
            format='json',
        )
        reset = client.post(
            self.endpoint,
            self.payload(action='reset'),
            format='json',
        )

        self.assertEqual(first.status_code, 201)
        self.assertEqual(changed.status_code, 200)
        self.assertEqual(changed.json()['rule']['revision'], 2)
        self.assertTrue(reset.json()['deleted'])
        self.assertEqual(APIClient().get(self.endpoint).json()['rules'], [])
        document = MouldDataSnapshot.objects.get(
            snapshot_key=VALIDATION_RULES_SNAPSHOT_KEY,
        ).payload
        self.assertEqual(
            [item['action'] for item in document['history']],
            ['confirm', 'confirm', 'reset'],
        )
