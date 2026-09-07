"""Deterministic task workflow. Call mutations inside a transaction with task rows locked."""
from django.db import connection
from django.utils import timezone
from rest_framework import serializers
from rest_framework.exceptions import APIException

from .development_task_serializers import DevelopmentTaskInputSerializer
from .models import DevelopmentTask, DevelopmentTaskHistory

TASK_FIELDS = tuple(key for key in DevelopmentTaskInputSerializer().fields if key not in {'slug', 'version', 'change_note'})


def locked_tasks():
    # A row scan alone misses tasks inserted while SELECT FOR UPDATE waits.
    # Lock the graph before taking its snapshot, including an initially empty catalog.
    # All task mutations call this inside transaction.atomic; the lock ends at commit.
    if connection.vendor == 'postgresql':
        with connection.cursor() as cursor:
            cursor.execute('SELECT pg_advisory_xact_lock(%s, %s)', [1464484932, 1])
    return list(DevelopmentTask.objects.select_for_update().order_by('id'))


class TaskConflict(APIException):
    status_code = 409
    default_detail = '다른 창에서 과제가 변경되었습니다. 작성 내용을 확인한 뒤 최신 내용을 다시 불러와 주세요.'
    default_code = 'task_conflict'


def task_payload(task):
    result = {key: getattr(task, key) for key in TASK_FIELDS}
    result.update(slug=task.slug, version=task.version, updated_at=task.updated_at.isoformat(),
                  completed_at=task.completed_at.isoformat() if task.completed_at else None)
    result['due_date'] = task.due_date.isoformat() if task.due_date else None
    return result


def history_payload(task, before_id=None):
    queryset = task.history.all()
    if before_id is not None:
        queryset = queryset.filter(id__lt=before_id)
    rows = list(queryset[:51])
    return {
        'history': [{
            'id': row.id, 'actor': row.actor_label, 'action': row.action,
            'changed_fields': row.changed_fields, 'change_note': row.change_note,
            'created_at': row.created_at.isoformat(),
        } for row in rows[:50]],
        'next_history_before': rows[49].id if len(rows) > 50 else None,
    }


def detail_payload(task, before_id=None):
    return {'task': task_payload(task), **history_payload(task, before_id)}


def validate_dependencies(slug, data, tasks):
    by_slug = {task.slug: task for task in tasks}
    dependencies = data['dependencies']
    if slug in dependencies or any(key not in by_slug for key in dependencies):
        raise serializers.ValidationError({'dependencies': '자기 자신이나 존재하지 않는 과제를 선행 과제로 지정할 수 없습니다.'})
    graph = {key: list(task.dependencies) for key, task in by_slug.items()}
    graph[slug] = dependencies
    pending = [(slug, False)]
    active, visited = set(), set()
    while pending:
        key, leaving = pending.pop()
        if leaving:
            active.remove(key)
            visited.add(key)
        elif key in active:
            raise serializers.ValidationError({'dependencies': '선행 과제가 서로를 기다리는 순환 관계입니다.'})
        elif key not in visited:
            active.add(key)
            pending.append((key, True))
            pending.extend((child, False) for child in graph.get(key, []))
    if data['status'] == 'done' and any(by_slug[key].status != 'done' for key in dependencies):
        raise serializers.ValidationError({'dependencies': '선행 과제를 완료한 뒤 이 과제를 완료해 주세요.'})
    if data['status'] != 'done':
        dependents = [task.title for task in tasks if task.status == 'done' and slug in task.dependencies]
        if dependents:
            raise serializers.ValidationError({'status': '완료된 후속 과제를 먼저 재개해 주세요: ' + ', '.join(dependents)})


def record_change(task, actor, action, before, note):
    after = task_payload(task)
    fields = [key for key in TASK_FIELDS if before.get(key) != after.get(key)]
    DevelopmentTaskHistory.objects.create(
        task=task, actor=actor, actor_label=actor.get_username(), action=action,
        changed_fields=fields, change_note=note, before=before, after=after,
    )


def create_task(data, actor, action='create', note=''):
    task = DevelopmentTask.objects.create(
        **data, created_by=actor, updated_by=actor,
        completed_at=timezone.now() if data['status'] == 'done' else None,
    )
    record_change(task, actor, action, {}, note)
    return task


def update_task(task, data, actor, version, note):
    if task.version != version:
        raise TaskConflict()
    before = task_payload(task)
    changed = any(getattr(task, key) != value for key, value in data.items())
    if not changed:
        return task
    now = timezone.now()
    old_status = task.status
    completed_at = (task.completed_at or now) if data['status'] == 'done' else None
    # Conditional write is also required on SQLite, where SELECT FOR UPDATE is a no-op.
    updated = DevelopmentTask.objects.filter(pk=task.pk, version=version).update(
        **data, version=version + 1, updated_by=actor, updated_at=now, completed_at=completed_at,
    )
    if updated != 1:
        raise TaskConflict()
    task.refresh_from_db()
    action = 'complete' if task.status == 'done' and old_status != 'done' else 'reopen' if old_status == 'done' and task.status != 'done' else 'update'
    record_change(task, actor, action, before, note)
    return task
