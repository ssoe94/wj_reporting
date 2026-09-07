from copy import deepcopy
from types import SimpleNamespace

from django.test import SimpleTestCase

from .development_task_catalog import INITIAL_TASKS
from .development_task_permissions import IsDevelopmentSuperuser
from .development_task_serializers import DevelopmentTaskInputSerializer, LocationSerializer


def example_task():
    return {
        'slug': 'test-work', 'title': '검증 과제', 'title_zh': '', 'objective': '자료 근거를 확인한다.',
        'phase': 1, 'priority': 'P1', 'status': 'planned', 'owner': '', 'due_date': None,
        'dependencies': [], 'requirements': [{'id': 'mes', 'kind': 'mes', 'text': '형합 원본', 'status': 'needed', 'evidence': ''}],
        'checklist': [{'id': 'one', 'text': '원본과 대사', 'done': False}], 'locations': [],
        'completion_note': '', 'verification_note': '', 'release_state': 'unreleased', 'sort_order': 10,
    }


class DevelopmentTaskContractTests(SimpleTestCase):
    def test_active_superuser_is_the_only_permission(self):
        for authenticated, active, superuser, expected in [
            (False, True, True, False), (True, False, True, False),
            (True, True, False, False), (True, True, True, True),
        ]:
            user = SimpleNamespace(is_authenticated=authenticated, is_active=active,
                                   is_superuser=superuser, is_staff=True, is_admin=True)
            self.assertEqual(IsDevelopmentSuperuser().has_permission(SimpleNamespace(user=user), None), expected)

    def test_planned_task_can_record_unresolved_data_without_fabricated_owner(self):
        serializer = DevelopmentTaskInputSerializer(data=example_task())
        self.assertTrue(serializer.is_valid(), serializer.errors)

    def test_done_requires_evidence_checklist_owner_and_location(self):
        data = example_task()
        data['status'] = 'done'
        serializer = DevelopmentTaskInputSerializer(data=data)
        self.assertFalse(serializer.is_valid())
        self.assertEqual(set(serializer.errors), {'checklist', 'requirements', 'owner', 'locations', 'completion_note', 'verification_note'})
        data.update(owner='생산관리 확인', completion_note='원인 해결', verification_note='대표 작업 대사 완료',
                    locations=[{'kind': 'screen', 'url': '/quality/analysis', 'label': '구현 화면'}])
        data['checklist'][0]['done'] = True
        data['requirements'][0].update(status='ready', evidence='검증 작업과 원본 식별 기록')
        serializer = DevelopmentTaskInputSerializer(data=data)
        self.assertTrue(serializer.is_valid(), serializer.errors)

    def test_ready_requires_evidence_even_before_completion(self):
        data = example_task()
        data['requirements'][0]['status'] = 'ready'
        serializer = DevelopmentTaskInputSerializer(data=data)
        self.assertFalse(serializer.is_valid())
        self.assertIn('requirements', serializer.errors)

    def test_duplicate_checklist_and_requirement_ids_are_rejected(self):
        for key in ['checklist', 'requirements']:
            data = example_task()
            data[key].append(deepcopy(data[key][0]))
            serializer = DevelopmentTaskInputSerializer(data=data)
            self.assertFalse(serializer.is_valid())
            self.assertIn(key, serializer.errors)

    def test_unknown_fields_and_overlong_collections_are_rejected(self):
        data = example_task()
        data['created_by'] = 'someone else'
        serializer = DevelopmentTaskInputSerializer(data=data)
        self.assertFalse(serializer.is_valid())
        self.assertIn('created_by', serializer.errors)
        del data['created_by']
        data['checklist'] = [{'id': f'item-{n}', 'text': 'one', 'done': False} for n in range(61)]
        self.assertFalse(DevelopmentTaskInputSerializer(data=data).is_valid())

    def test_initialization_route_slug_is_reserved(self):
        data = example_task()
        data['slug'] = 'initialize'
        serializer = DevelopmentTaskInputSerializer(data=data)
        self.assertFalse(serializer.is_valid())
        self.assertIn('slug', serializer.errors)

    def test_unsafe_links_are_rejected(self):
        for url in ['javascript:alert(1)', '//evil.test', '/\\evil.test', 'https://user:password@host.test', 'https://host.test/\nwrong', 'file:///tmp/a', 'https://[']:
            self.assertFalse(LocationSerializer(data={'kind': 'doc', 'url': url, 'label': 'link'}).is_valid(), url)
        for url in ['/quality/analysis#trend', 'https://github.com/ssoe94/wj_reporting/blob/main/README.md']:
            serializer = LocationSerializer(data={'kind': 'doc', 'url': url, 'label': 'link'})
            self.assertTrue(serializer.is_valid(), serializer.errors)
        self.assertFalse(LocationSerializer(data={'kind': 'screen', 'url': 'https://external.test', 'label': '화면'}).is_valid())

    def test_entire_catalog_is_valid_and_preserves_unverified_work(self):
        by_slug = {item['slug']: item for item in INITIAL_TASKS}
        self.assertEqual(len(by_slug), 10)
        for item in INITIAL_TASKS:
            serializer = DevelopmentTaskInputSerializer(data=item)
            self.assertTrue(serializer.is_valid(), (item['slug'], serializer.errors))
            self.assertNotEqual(item['status'], 'done')
            self.assertTrue(all(not entry['done'] for entry in item['checklist']))
            self.assertTrue(set(item['dependencies']) <= set(by_slug))
            self.assertNotIn(item['slug'], item['dependencies'])
        self.assertEqual(by_slug['quality-trend-retained-dates']['release_state'], 'unreleased')
        self.assertEqual(by_slug['quality-trend-retained-dates']['locations'], [])
