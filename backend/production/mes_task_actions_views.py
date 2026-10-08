import uuid

from django.conf import settings
from django.core.cache import cache
from django.db import transaction
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView

from .mes_task_actions import ActionRequestError, execute_actions, mes_sender, parse_items
from .mes_task_reconciliation_service import TASK_LIST_CACHE_KEY
from .models import MesTaskActionLog
from .permissions import user_can_edit_plan


def _actor_label(user):
    name = (user.get_full_name() or user.get_username() or '').strip()
    return f'{name}#{user.pk}'


class MesTaskActionView(APIView):
    """Start, resume or pause MES production tasks, or close their work orders.

    GET reports whether actions are available to the current user; it never calls MES.
    """

    permission_classes = [IsAuthenticated]
    http_method_names = ['get', 'post', 'options']
    sender = staticmethod(mes_sender)

    def _allowed(self, request):
        return request.user.is_active and user_can_edit_plan(request.user, 'injection')

    def get(self, request):
        response = Response({
            'enabled': bool(getattr(settings, 'MES_TASK_ACTIONS_ENABLED', False)),
            'permitted': self._allowed(request),
        })
        response['Cache-Control'] = 'no-store'
        return response

    def post(self, request):
        if not self._allowed(request):
            return Response({'detail': 'Permission denied.'}, status=403)
        if not getattr(settings, 'MES_TASK_ACTIONS_ENABLED', False):
            return Response({'detail': 'MES task actions are disabled.', 'code': 'disabled'}, status=409)
        try:
            items, reason = parse_items(request.data)
        except ActionRequestError as error:
            return Response({'detail': 'Invalid action request.', 'code': str(error)}, status=400)

        request_id = str(uuid.uuid4())
        results = execute_actions(
            items, reason, send=self.sender, actor_label=_actor_label(request.user),
            operator_id=getattr(settings, 'MES_TASK_ACTION_OPERATOR_ID', None),
        )
        # Record what happened even when individual items failed; MES state is the source of truth.
        with transaction.atomic():
            MesTaskActionLog.objects.bulk_create([
                MesTaskActionLog(
                    request_id=request_id, actor=request.user, action=result['action'], reason=reason,
                    machine_number=result['machine_number'], task_id=result['task_id'],
                    task_code=result['task_code'], work_order_code=result['work_order_code'],
                    part_no=result['part_no'], status_before=result['status_before'],
                    status_after=result['status_after'], outcome=result['outcome'],
                    outcome_reason=result['reason'], mes_code=result['mes_code'],
                    mes_sub_code=result['mes_sub_code'][:40], mes_message=result['mes_message'],
                    need_check=result['need_check'],
                )
                for result in results
            ])
        # The reconciliation reuses a 60-second task-list snapshot; the board must see the change.
        cache.delete(TASK_LIST_CACHE_KEY)
        response = Response({'request_id': request_id, 'results': results})
        response['Cache-Control'] = 'no-store'
        return response
