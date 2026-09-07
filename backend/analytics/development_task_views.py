"""Authenticated task storage; no MES/production mutations or writes during GET."""
import json

from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.parsers import JSONParser
from rest_framework.response import Response
from rest_framework.views import APIView

from .development_task_catalog import CATALOG_VERSION, INITIAL_TASKS
from .development_task_permissions import IsDevelopmentSuperuser
from .development_task_serializers import DevelopmentTaskInputSerializer
from .development_task_service import TaskConflict, create_task, detail_payload, task_payload, update_task, validate_dependencies, locked_tasks, record_change
from .models import DevelopmentTask

MAX_TASKS = 500


def list_payload():
    tasks = list(DevelopmentTask.objects.all())
    known = {task.slug for task in tasks}
    return {
        'tasks': [task_payload(task) for task in tasks], 'catalog_version': CATALOG_VERSION,
        'needs_initialization': any(item['slug'] not in known for item in INITIAL_TASKS), 'read_only': False,
    }


def validated_input(request):
    if len(json.dumps(request.data, ensure_ascii=False).encode('utf-8')) > 512_000:
        raise serializers.ValidationError({'detail': '한 과제의 입력 크기는 512KB 이하여야 합니다.'})
    serializer = DevelopmentTaskInputSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    return dict(serializer.validated_data)


class DevelopmentTaskBaseView(APIView):
    permission_classes = [IsDevelopmentSuperuser]
    parser_classes = [JSONParser]

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response['Cache-Control'] = 'private, no-store'
        return response


class DevelopmentTaskListView(DevelopmentTaskBaseView):
    def get(self, request):
        return Response(list_payload())

    @transaction.atomic
    def post(self, request):
        data = validated_input(request)
        if 'slug' not in data or 'version' in data:
            raise serializers.ValidationError({'slug': '새 과제 ID가 필요하며 version은 새 과제에 지정할 수 없습니다.'})
        note = data.pop('change_note', '')
        tasks = locked_tasks()
        if len(tasks) >= MAX_TASKS:
            raise serializers.ValidationError({'detail': '과제는 최대 500개까지 관리할 수 있습니다.'})
        if any(task.slug == data['slug'] for task in tasks):
            raise TaskConflict('이미 사용 중인 과제 ID입니다. 다른 ID로 생성해 주세요.')
        validate_dependencies(data['slug'], data, tasks)
        try:
            with transaction.atomic():
                task = create_task(data, request.user, note=note)
        except IntegrityError:
            raise TaskConflict('이미 사용 중인 과제 ID입니다. 다른 ID로 생성해 주세요.')
        return Response(detail_payload(task), status=201)


class DevelopmentTaskInitializeView(DevelopmentTaskBaseView):
    @transaction.atomic
    def post(self, request):
        if request.data:
            raise serializers.ValidationError({'detail': '기본 과제 등록에는 추가 입력이 필요하지 않습니다.'})
        tasks = locked_tasks()
        known = {task.slug for task in tasks}
        missing = [item for item in INITIAL_TASKS if item['slug'] not in known]
        if len(tasks) + len(missing) > MAX_TASKS:
            raise serializers.ValidationError({'detail': '과제는 최대 500개까지 관리할 수 있습니다.'})
        for item in missing:
            serializer = DevelopmentTaskInputSerializer(data=item)
            serializer.is_valid(raise_exception=True)
            data = dict(serializer.validated_data)
            # get_or_create's unique-key retry makes repeated initialization safe.
            task, created = DevelopmentTask.objects.get_or_create(slug=data.pop('slug'), defaults={
                **data, 'created_by': request.user, 'updated_by': request.user,
            })
            if created:
                record_change(task, request.user, 'initialize', {}, f'기본 계획 {CATALOG_VERSION} 등록')
        return Response(list_payload())


class DevelopmentTaskDetailView(DevelopmentTaskBaseView):
    def get(self, request, slug):
        task = get_object_or_404(DevelopmentTask, slug=slug)
        before_id = request.query_params.get('history_before')
        if before_id is not None:
            if not before_id.isdecimal() or len(before_id) > 18 or int(before_id) < 1:
                raise serializers.ValidationError({'history_before': '양의 이력 ID를 입력해 주세요.'})
            before_id = int(before_id)
        return Response(detail_payload(task, before_id))

    @transaction.atomic
    def patch(self, request, slug):
        tasks = locked_tasks()
        task = next((item for item in tasks if item.slug == slug), None)
        if task is None:
            return Response({'detail': '과제를 찾을 수 없습니다.'}, status=404)
        data = validated_input(request)
        if 'slug' in data:
            raise serializers.ValidationError({'slug': '과제 ID는 변경할 수 없습니다.'})
        version = data.pop('version', None)
        note = data.pop('change_note', '')
        if version is None or not note:
            raise serializers.ValidationError({'change_note': '현재 version과 변경 사유를 입력해 주세요.'})
        if task.version != version:
            raise TaskConflict()
        validate_dependencies(slug, data, tasks)
        task = update_task(task, data, request.user, version, note)
        return Response(detail_payload(task))
