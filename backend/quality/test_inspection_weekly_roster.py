"""Disposable weekly declarations and real actor provenance; no MES traffic."""
from copy import deepcopy
import uuid

from django.contrib.auth import get_user_model
from django.db import transaction
from django.db import connection
from django.test import TransactionTestCase
from unittest import skipUnless
from rest_framework.test import APITestCase

from .inspection_role_models import InspectionInspector, InspectionWeeklyRoster, InspectionShiftSetting, InspectionAreaResult
from .inspection_full_snapshot import validate_source, FullSnapshotError
from .inspection_full_snapshot_authority import CurrentExecutorGuard
from .inspection_full_snapshot_source import DjangoCompletedSource
from .inspection_models import InspectionAudit, InspectionOperation, InspectionRequest
from . import test_inspection_requests as fixture_helpers
from .test_inspection_requests import authenticate_inspection_client


class InspectionWeeklyRosterTests(APITestCase):
    make_user = fixture_helpers.InspectionRequestContractTests.make_user
    create_payload = fixture_helpers.InspectionRequestContractTests.create_payload
    base = '/api/quality/inspection-requests/'

    def setUp(self):
        self.owner = self.make_user('SYNTHETIC-week-admin', superuser=True)
        self.other = self.make_user('SYNTHETIC-week-outsider', superuser=True)
        authenticate_inspection_client(self.client, self.owner)

    def post(self, path, payload, key=None):
        return self.client.post(self.base + path, payload, format='json', HTTP_IDEMPOTENCY_KEY=key or str(uuid.uuid4()))

    def payload(self, **changes):
        data = {'week_start': '2026-10-05', 'version': 0, 'slots': [
            {'shift': shift, 'area': area, 'display_name': name}
            for shift in ('DAY', 'NIGHT') for area, name in (('dimension', 'SYNTHETIC 王明'), ('appearance', 'SYNTHETIC 陈丽'))]}
        data.update(changes)
        return data

    def save(self, payload=None, key=None):
        result = self.post('weekly-role-settings/', payload or self.payload(), key)
        self.assertEqual(result.status_code, 200, result.data)
        return result.data

    def create(self, shift=None, shift_date='2026-10-11', shared=True):
        weekly = self.save()
        payload = self.create_payload(role_workflow=True, quantity_mode='not_recorded', require_evidence=False)
        payload['inspection_items'][0]['evidence_required'] = False
        payload['inspection_items'].append({'id': 'look', 'label': 'SYNTHETIC appearance', 'kind': 'choice',
            'options': ['OK', 'NG'], 'required': True, 'evidence_required': False})
        result = self.post('', payload)
        self.assertEqual(result.status_code, 201, result.data)
        request = result.data
        chosen = weekly['settings'][1 if shift == 'NIGHT' else 0]
        config = {'config_version': request['role_workflow']['config_version'], 'shift_setting_id': chosen['id'],
            'shift_version': chosen['version'], 'shift_date': shift_date, 'shared_terminal': shared,
            'item_areas': {'dimension': 'dimension', 'look': 'appearance'}, 'reason': 'SYNTHETIC weekly declaration'}
        return request, self.post(f'{request["id"]}/role-configure/', config)

    def complete(self, request, area):
        workflow = request['role_workflow']
        row = next(row for row in workflow['areas'] if row['area'] == area)
        body = {'area': area, 'config_version': workflow['config_version'], 'area_version': row['version'],
            'inspector_person_id': row['assigned_person_id'], 'judgement': 'pass', 'measurements': [{
                'item_id': 'dimension' if area == 'dimension' else 'look', 'value': '10.0' if area == 'dimension' else 'OK', 'judgement': 'pass'}]}
        result = self.post(f'{request["id"]}/area-complete/', body)
        self.assertEqual(result.status_code, 200, result.data)
        return result.data

    def test_get_is_readonly_and_does_not_create_accounts_grants_people_or_weeks(self):
        before = (get_user_model().objects.count(), InspectionOperation.objects.count(), InspectionAudit.objects.count())
        response = self.client.get(self.base + 'weekly-role-settings/?week_start=2026-10-05')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['version'], 0)
        self.assertEqual(len(response.data['slots']), 4)
        self.assertEqual(InspectionInspector.objects.count(), 0)
        self.assertEqual(InspectionWeeklyRoster.objects.count(), 0)
        self.assertEqual(InspectionShiftSetting.objects.count(), 0)
        self.assertEqual(before, (get_user_model().objects.count(), InspectionOperation.objects.count(), InspectionAudit.objects.count()))

    def test_save_reuses_roster_and_preserves_accounts_permissions_and_week_boundaries(self):
        accounts = list(get_user_model().objects.values())
        saved = self.save()
        self.assertEqual(saved['actor_id'], self.owner.pk)
        self.assertEqual(saved['version'], 1)
        self.assertEqual(saved['week_end'], '2026-10-11')
        self.assertEqual(InspectionInspector.objects.count(), 2)
        self.assertEqual(list(get_user_model().objects.values()), accounts)
        for row in saved['settings']:
            self.assertIsNone(row['appearance_assignee'])
            self.assertIsNone(row['dimension_assignee'])
            self.assertEqual(row['effective_until_local'], '2026-10-12T08:00')
        self.assertEqual(saved['settings'][1]['effective_from_local'], '2026-10-05T20:00')

    def test_normalization_reuses_nfkc_whitespace_and_casefold_duplicates(self):
        payload = self.payload()
        payload['slots'][0]['display_name'] = ' Ｓｔｒａßｅ  王 '
        payload['slots'][2]['display_name'] = 'strasse 王'
        self.save(payload)
        self.assertEqual(InspectionInspector.objects.count(), 2)
        self.assertEqual(InspectionInspector.objects.get(normalized_name='strasse 王').display_name, 'Straße 王')

    def test_homonym_note_separates_people_but_same_person_pair_rolls_back(self):
        payload = self.payload()
        for row in payload['slots']:
            row['display_name'] = 'SYNTHETIC 王'
            row['distinguishing_note'] = row['area']
        self.save(payload)
        self.assertEqual(InspectionInspector.objects.count(), 2)
        payload = self.payload(week_start='2026-10-12')
        for row in payload['slots']:
            row['display_name'] = 'SYNTHETIC Same'
        response = self.post('weekly-role-settings/', payload)
        self.assertEqual(response.status_code, 400)
        self.assertEqual(InspectionWeeklyRoster.objects.count(), 1)
        self.assertFalse(InspectionInspector.objects.filter(display_name='SYNTHETIC Same').exists())

    def test_nullable_slots_save_inactive_pair_without_guessed_inspectors(self):
        data = self.payload()
        data['slots'] = [{'shift': shift, 'area': area, 'inspector_id': None} for shift in ('DAY', 'NIGHT') for area in ('dimension', 'appearance')]
        result = self.save(data)
        self.assertFalse(any(row['active'] for row in result['settings']))
        self.assertEqual(result['roster'], [])

    def test_same_key_replay_and_stale_week_preserve_saved_result(self):
        payload, key = self.payload(), str(uuid.uuid4())
        saved = self.save(payload, key)
        self.assertEqual(self.save(payload, key), saved)
        stale = self.post('weekly-role-settings/', payload)
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(str(stale.data['code']), 'stale_week_version')
        changed = deepcopy(payload); changed['slots'][0]['display_name'] = 'SYNTHETIC Changed'
        self.assertEqual(self.post('weekly-role-settings/', changed, key).status_code, 409)
        self.assertEqual(InspectionWeeklyRoster.objects.get().version, 1)

    def test_strict_week_slot_and_server_actor_field_validation(self):
        for changes in ({'week_start': '2026-10-06'}, {'version': True}, {'actor_id': self.other.pk}, {'slots': []}):
            with self.subTest(changes=changes):
                self.assertEqual(self.post('weekly-role-settings/', self.payload(**changes)).status_code, 400)
        self.assertEqual(InspectionWeeklyRoster.objects.count(), 0)

    def test_restricted_account_cannot_enumerate_or_save_display_roster(self):
        self.save()
        restricted = self.make_user('SYNTHETIC-restricted-roster', permissions=('manage', 'submit'))
        authenticate_inspection_client(self.client, restricted)
        read = self.client.get(self.base + 'weekly-role-settings/?week_start=2026-10-05')
        self.assertEqual(read.status_code, 403)
        self.assertNotIn('roster', read.data)
        self.assertEqual(self.post('weekly-role-settings/', self.payload(week_start='2026-10-12')).status_code, 403)

    def test_existing_pilot_has_no_roster_enumeration_or_configure_authority(self):
        from injection.models import UserProfile
        self.save()
        pilot = self.make_user('SYNTHETIC-existing-roster-pilot', permissions=('view', 'manage', 'submit'))
        pilot.set_password('SYNTHETIC-disposable-pilot-password'); pilot.save(update_fields=['password'])
        UserProfile.objects.filter(user=pilot).update(is_admin=False, password_reset_required=False, is_using_temp_password=False)
        pilot = get_user_model().objects.get(pk=pilot.pk)
        with self.settings(INSPECTION_PILOT_ENABLED=True, INSPECTION_PILOT_USER_IDS=[pilot.pk]):
            authenticate_inspection_client(self.client, pilot)
            read = self.client.get(self.base + 'weekly-role-settings/?week_start=2026-10-05')
            self.assertEqual(read.status_code, 200, read.data)
            self.assertEqual(read.data['roster'], [])
            self.assertFalse(read.data['can_configure'])
            self.assertEqual(self.post('weekly-role-settings/', self.payload(week_start='2026-10-12')).status_code, 403)

    def test_legacy_update_cannot_bypass_week_version(self):
        saved = self.save()
        row = saved['settings'][0]
        response = self.client.patch(self.base + f'role-settings/{row["id"]}/', {'version': row['version'],
            'reason': 'SYNTHETIC legacy bypass', 'active': False}, format='json', HTTP_IDEMPOTENCY_KEY=str(uuid.uuid4()))
        self.assertEqual(response.status_code, 409)
        self.assertEqual(str(response.data['code']), 'weekly_setting_managed')
        self.assertTrue(InspectionShiftSetting.objects.get(pk=row['id']).active)
        self.assertEqual(InspectionWeeklyRoster.objects.get().version, 1)

    def test_sunday_night_is_whole_shift_until_next_monday_08_and_requires_terminal(self):
        request, result = self.create(shift='NIGHT')
        self.assertEqual(result.status_code, 200, result.data)
        self.assertEqual(result.data['role_workflow']['shift_snapshot']['window_end'], '2026-10-12T08:00:00+08:00')
        authenticate_inspection_client(self.client, self.owner)
        weekly = self.client.get(self.base + 'weekly-role-settings/?week_start=2026-10-05').data
        payload = {'config_version': result.data['role_workflow']['config_version'], 'shift_setting_id': weekly['settings'][1]['id'],
            'shift_version': 1, 'shift_date': '2026-10-12', 'shared_terminal': True,
            'item_areas': {'dimension': 'dimension', 'look': 'appearance'}, 'reason': 'SYNTHETIC outside week'}
        self.assertEqual(self.post(f'{request["id"]}/role-configure/', payload).status_code, 400)
        payload.update(shift_date='2026-10-11', shared_terminal=False)
        self.assertEqual(self.post(f'{request["id"]}/role-configure/', payload).status_code, 400)

    def test_display_inspector_id_never_grants_account_authority_and_source_preserves_real_recorder(self):
        _, configured = self.create()
        self.assertEqual(configured.status_code, 200, configured.data)
        request = configured.data
        for row in request['role_workflow']['areas']:
            self.assertIsNone(row['assigned_to'])
            self.assertIsInstance(row['assigned_person_id'], int)
        area = request['role_workflow']['areas'][0]
        authenticate_inspection_client(self.client, self.other)
        denied = self.post(f'{request["id"]}/area-save/', {'area': area['area'], 'config_version': request['role_workflow']['config_version'],
            'area_version': area['version'], 'inspector_person_id': area['assigned_person_id']})
        self.assertEqual(denied.status_code, 403)
        authenticate_inspection_client(self.client, self.owner)
        denied = self.post(f'{request["id"]}/area-save/', {'area': area['area'], 'config_version': request['role_workflow']['config_version'],
            'area_version': area['version'], 'inspector_id': area['assigned_person_id']})
        self.assertEqual(denied.status_code, 403)
        request = self.complete(request, 'dimension')
        request = self.complete(request, 'appearance')
        for row in InspectionAreaResult.objects.all():
            self.assertIsNone(row.completed_by_id)
            self.assertEqual(row.completed_person_id, row.assigned_person_id)
            self.assertEqual(row.completed_recorded_by_id, self.owner.pk)
            self.assertEqual(next(iter(row.item_authorship.values()))['inspector_kind'], 'display_inspector')
        with transaction.atomic():
            source = DjangoCompletedSource.capture(InspectionRequest.objects.select_for_update().get(pk=request['id']))
            validated, values = validate_source(source)
        self.assertEqual(values, {'dimension': '10.0', 'look': 'OK'})
        self.assertEqual(CurrentExecutorGuard._contributors(validated), {self.owner.pk})
        tampered = deepcopy(source); tampered['areas'][0]['completion']['inspector'].pop('kind')
        with self.assertRaises(FullSnapshotError):
            validate_source(tampered)

    def test_following_week_is_adjacent_and_original_week_updates_keep_request_snapshots(self):
        _, configured = self.create()
        before = deepcopy(configured.data['role_workflow']['actor_snapshot'])
        self.save(self.payload(week_start='2026-10-12'))
        updated = self.payload(version=1)
        updated['slots'][0]['display_name'] = 'SYNTHETIC New next inspection'
        self.save(updated)
        current = self.client.get(self.base + str(configured.data['id']) + '/').data
        self.assertEqual(current['role_workflow']['actor_snapshot'], before)
        self.assertEqual(InspectionWeeklyRoster.objects.count(), 2)


@skipUnless(connection.vendor == 'postgresql', 'Requires disposable PostgreSQL for real concurrent week CAS.')
class InspectionWeeklyRosterPostgresTests(TransactionTestCase):
    from . import test_inspection_roles as role_fixtures
    concurrent = role_fixtures.InspectionRolePostgresTests.concurrent
    payload = InspectionWeeklyRosterTests.payload

    def setUp(self):
        self.actors = [get_user_model().objects.create_user(username=f'SYNTHETIC-week-cas-{i}', is_superuser=True) for i in range(2)]

    def callbacks(self, payloads):
        from .inspection_weekly_roster import save_weekly_settings
        from .test_inspection_requests import inspection_session
        result = []
        for actor, payload in zip(self.actors, payloads):
            session, actor_id = inspection_session(actor), actor.pk
            def call(actor_id=actor_id, session=session, payload=payload):
                current = get_user_model().objects.get(pk=actor_id)
                return save_weekly_settings(current, uuid.uuid4(), deepcopy(payload), session=session)
            result.append(call)
        return result

    def test_same_week_two_current_actors_commit_once_without_duplicate_people(self):
        from .inspection_workflow import InspectionConflict
        outcomes = self.concurrent(self.callbacks([self.payload(), self.payload()]))
        self.assertEqual(sorted(kind for kind, _ in outcomes), ['error', 'result'])
        error = next(value for kind, value in outcomes if kind == 'error')
        self.assertIsInstance(error, InspectionConflict)
        self.assertEqual(str(error.detail['code']), 'stale_week_version')
        self.assertEqual(InspectionWeeklyRoster.objects.get().version, 1)
        self.assertEqual(InspectionInspector.objects.count(), 2)
        self.assertEqual(InspectionShiftSetting.objects.count(), 2)

    def test_adjacent_weeks_both_commit_and_share_normalized_display_people(self):
        outcomes = self.concurrent(self.callbacks([self.payload(), self.payload(week_start='2026-10-12')]))
        self.assertEqual([kind for kind, _ in outcomes], ['result', 'result'])
        self.assertEqual(InspectionWeeklyRoster.objects.count(), 2)
        self.assertEqual(InspectionInspector.objects.count(), 2)
