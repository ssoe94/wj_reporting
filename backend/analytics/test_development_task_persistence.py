from copy import deepcopy

from django.contrib.auth import get_user_model
from django.test import TestCase
from rest_framework.test import APIRequestFactory, force_authenticate

from .development_task_views import DevelopmentTaskDetailView, DevelopmentTaskInitializeView, DevelopmentTaskListView
from .models import DevelopmentTask, DevelopmentTaskHistory
from .test_development_task_contract import example_task


class DevelopmentTaskPersistenceTests(TestCase):
    @classmethod
    def setUpTestData(cls):
        User = get_user_model()
        cls.users = {
            'superuser': User.objects.create(username='reviewer', is_superuser=True, is_staff=True),
            'staff': User.objects.create(username='staff', is_staff=True),
            'regular': User.objects.create(username='regular'),
            'inactive': User.objects.create(username='inactive', is_superuser=True, is_staff=True, is_active=False),
        }

    def request(self, view=DevelopmentTaskListView, method='get', data=None, role='superuser', query='', **kwargs):
        request = getattr(APIRequestFactory(), method)('/api/analytics/development-tasks/' + query, ({} if method == 'get' else data or {}), format='json')
        if role != 'anonymous':
            force_authenticate(request, user=self.users[role])
        return view.as_view()(request, **kwargs)

    def create(self, slug='test-work', **changes):
        data = example_task()
        data.update(slug=slug, **changes)
        response = self.request(method='post', data=data)
        self.assertEqual(response.status_code, 201, response.data)
        return deepcopy(response.data['task'])

    def patch(self, task, **changes):
        data = deepcopy(task)
        slug = data.pop('slug')
        for key in ('updated_at', 'completed_at'):
            data.pop(key, None)
        data['change_note'] = '검증에 따른 수정'
        data.update(changes)
        return self.request(DevelopmentTaskDetailView, 'patch', data, slug=slug)

    def done_changes(self, task):
        requirements = deepcopy(task['requirements'])
        for requirement in requirements:
            requirement.update(status='ready', evidence='원본 작업 식별자 및 대사 기록')
        checklist = deepcopy(task['checklist'])
        for item in checklist:
            item['done'] = True
        return dict(status='done', requirements=requirements, checklist=checklist, owner='생산관리',
                    completion_note='작업 및 화면 구현', verification_note='대사 확인',
                    locations=[{'kind': 'screen', 'url': '/quality/analysis', 'label': '검증 화면'}])

    def test_every_read_and_write_requires_active_superuser(self):
        for role in ('anonymous', 'regular', 'staff', 'inactive'):
            for view, method, kwargs in [
                (DevelopmentTaskListView, 'get', {}), (DevelopmentTaskListView, 'post', {}),
                (DevelopmentTaskInitializeView, 'post', {}),
                (DevelopmentTaskDetailView, 'get', {'slug': 'test-work'}),
                (DevelopmentTaskDetailView, 'patch', {'slug': 'test-work'}),
            ]:
                response = self.request(view, method, example_task(), role, **kwargs)
                self.assertIn(response.status_code, (401, 403), (role, method, response.data))
                self.assertEqual(response['Cache-Control'], 'private, no-store')
        self.assertEqual(DevelopmentTask.objects.count(), 0)
        self.assertEqual(DevelopmentTaskHistory.objects.count(), 0)

    def test_get_never_seeds_and_initialization_is_idempotent(self):
        response = self.request()
        self.assertEqual(response.data['tasks'], [])
        self.assertTrue(response.data['needs_initialization'])
        self.assertFalse(response.data['read_only'])
        response = self.request(DevelopmentTaskInitializeView, 'post')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertEqual(len(response.data['tasks']), 10)
        task = response.data['tasks'][0]
        self.assertEqual(self.patch(task, owner='수동 지정 담당').status_code, 200)
        response = self.request(DevelopmentTaskInitializeView, 'post')
        self.assertEqual(len(response.data['tasks']), 10)
        self.assertFalse(response.data['needs_initialization'])
        self.assertEqual(DevelopmentTask.objects.get(slug=task['slug']).owner, '수동 지정 담당')
        self.assertEqual(DevelopmentTaskHistory.objects.count(), 11)

    def test_save_survives_fresh_request_and_history_has_server_actor_and_snapshots(self):
        task = self.create()
        response = self.patch(task, owner='생산팀', due_date='2026-09-10')
        self.assertEqual(response.status_code, 200, response.data)
        reread = self.request(DevelopmentTaskDetailView, slug=task['slug'])
        self.assertEqual(reread.data['task']['owner'], '생산팀')
        self.assertEqual(reread.data['task']['version'], 2)
        self.assertEqual(reread.data['task']['due_date'], '2026-09-10')
        history = DevelopmentTaskHistory.objects.latest('id')
        self.assertEqual(history.actor_label, 'reviewer')
        self.assertEqual(history.before['owner'], '')
        self.assertEqual(history.after['owner'], '생산팀')
        self.assertEqual(set(history.changed_fields), {'owner', 'due_date'})

    def test_stale_version_cannot_overwrite_or_append_history(self):
        task = self.create()
        self.assertEqual(self.patch(task, owner='첫 번째').status_code, 200)
        stale = self.patch(task, owner='두 번째')
        self.assertEqual(stale.status_code, 409)
        self.assertEqual(DevelopmentTask.objects.get(slug=task['slug']).owner, '첫 번째')
        self.assertEqual(DevelopmentTaskHistory.objects.count(), 2)

    def test_completion_enforces_evidence_and_reopening_preserves_history(self):
        task = self.create()
        self.assertEqual(self.patch(task, status='done').status_code, 400)
        response = self.patch(task, **self.done_changes(task))
        self.assertEqual(response.status_code, 200, response.data)
        task = response.data['task']
        self.assertIsNotNone(task['completed_at'])
        self.assertEqual(response.data['history'][0]['action'], 'complete')
        response = self.patch(task, status='in_progress')
        self.assertEqual(response.status_code, 200, response.data)
        self.assertIsNone(response.data['task']['completed_at'])
        self.assertEqual(response.data['history'][0]['action'], 'reopen')
        self.assertEqual(DevelopmentTaskHistory.objects.latest('id').before['completed_at'], task['completed_at'])
        self.assertEqual(DevelopmentTaskHistory.objects.latest('id').before['verification_note'], '대사 확인')

    def test_unknown_self_and_cyclic_dependencies_and_unfinished_prerequisite_are_rejected(self):
        a = self.create('first')
        b = self.create('second', dependencies=['first'])
        for dependencies in (['missing'], ['first'], ['second']):
            response = self.patch(a, dependencies=dependencies)
            self.assertEqual(response.status_code, 400, response.data)
        response = self.patch(b, **self.done_changes(b))
        self.assertEqual(response.status_code, 400, response.data)
        self.assertIn('dependencies', response.data)

    def test_completed_dependent_must_be_reopened_first(self):
        a = self.create('first')
        a = self.patch(a, **self.done_changes(a)).data['task']
        b = self.create('second', dependencies=['first'])
        b = self.patch(b, **self.done_changes(b)).data['task']
        self.assertEqual(self.patch(a, status='in_progress').status_code, 400)
        self.assertEqual(self.patch(b, status='in_progress').status_code, 200)
        self.assertEqual(self.patch(a, status='in_progress').status_code, 200)

    def test_noop_duplicate_invalid_input_and_delete(self):
        task = self.create()
        response = self.patch(task)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.data['task']['version'], 1)
        self.assertEqual(DevelopmentTaskHistory.objects.count(), 1)
        self.assertEqual(self.request(method='post', data=example_task()).status_code, 409)
        self.assertEqual(self.patch(task, version=0).status_code, 400)
        self.assertEqual(self.patch(task, created_by=999).status_code, 400)
        self.assertEqual(self.patch(task, change_note=' ').status_code, 400)
        self.assertEqual(self.request(DevelopmentTaskDetailView, 'delete', slug=task['slug']).status_code, 405)
        self.assertEqual(self.request(DevelopmentTaskDetailView, slug='missing').status_code, 404)

    def test_history_pagination_is_stable_and_scoped_to_task(self):
        task = self.create()
        other = self.create('other')
        for index in range(51):
            task = self.patch(task, owner=f'담당 {index}').data['task']
        response = self.request(DevelopmentTaskDetailView, slug=task['slug'])
        self.assertEqual(len(response.data['history']), 50)
        cursor = response.data['next_history_before']
        response2 = self.request(DevelopmentTaskDetailView, query=f'?history_before={cursor}', slug=task['slug'])
        self.assertEqual(len(response2.data['history']), 2)
        self.assertIsNone(response2.data['next_history_before'])
        self.assertFalse({row['id'] for row in response.data['history']} & {row['id'] for row in response2.data['history']})
        self.assertEqual(len(self.request(DevelopmentTaskDetailView, slug=other['slug']).data['history']), 1)
        self.assertEqual(self.request(DevelopmentTaskDetailView, query='?history_before=-1', slug=task['slug']).status_code, 400)
