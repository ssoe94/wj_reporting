from django.db.models import Q, Count, Max
from django.utils.dateparse import parse_date
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import JSONParser
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.exceptions import ValidationError

from .inspection_models import InspectionRequest
from .inspection_validation import CreateInspectionSerializer, DraftInspectionSerializer, ActionSerializer
from .inspection_workflow import can_access_beta, capabilities, serialize, operation_key, create_request, local_action, external_action


class InspectionReadPermission(BasePermission):
    def has_permission(self, request, view):
        return can_access_beta(request.user)


class InspectionPagination(PageNumberPagination):
    page_size = 25
    page_size_query_param = 'page_size'
    max_page_size = 100


class InspectionRequestViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    permission_classes = [InspectionReadPermission]
    parser_classes = [JSONParser]
    pagination_class = InspectionPagination
    queryset = InspectionRequest.objects.all()

    def get_queryset(self):
        queryset = super().get_queryset()
        params = self.request.query_params
        for field in ('status', 'sync_status', 'mes_completion_status', 'assigned_to', 'part_no', 'equipment_ref', 'inspection_type'):
            if params.get(field):
                value = params[field]
                if len(value) > 128 or (field == 'assigned_to' and (not value.isascii() or not value.isdigit() or len(value) > 18)):
                    raise ValidationError({field: 'Invalid filter.'})
                queryset = queryset.filter(**{field: value})
        if params.get('search'):
            term = params['search'][:128]
            queryset = queryset.filter(Q(work_order_ref__icontains=term) | Q(task_ref__icontains=term) | Q(part_no__icontains=term)
                                      | Q(equipment_ref__icontains=term) | Q(lot_ref__icontains=term))
        for param, lookup in [('created_after', 'created_at__date__gte'), ('created_before', 'created_at__date__lte')]:
            if params.get(param):
                try:
                    value = parse_date(params[param])
                except ValueError:
                    value = None
                if value is None:
                    raise ValidationError({param: 'Use an ISO date.'})
                queryset = queryset.filter(**{lookup: value})
        return queryset

    def list(self, request, *args, **kwargs):
        queryset = self.get_queryset()
        page = self.paginate_queryset(queryset)
        response = self.get_paginated_response([serialize(row, request.user, detail=False) for row in page])
        # Local evidence only. Group actual request identities, never fabricate MES
        # duplicate tasks from repeated polling, part numbers or equipment alone.
        grouped = queryset.order_by().values('work_order_ref', 'task_ref', 'equipment_ref', 'source_kind').annotate(
            request_count=Count('id'), open_count=Count('id', filter=~Q(mes_completion_status='completed')),
            latest_request_at=Max('created_at'),
            draft_count=Count('id', filter=Q(status='draft')),
            submitted_count=Count('id', filter=Q(status='submitted')),
            failed_count=Count('id', filter=Q(status='failed')),
            rejected_count=Count('id', filter=Q(status='rejected')),
            approved_count=Count('id', filter=Q(status='approved')),
            approval_pending_count=Count('id', filter=Q(mes_completion_status='approval_pending')),
            completion_unverified_count=Count('id', filter=~Q(mes_completion_status='completed')),
        ).order_by('-latest_request_at', 'work_order_ref', 'task_ref')
        rows = list(grouped[:31])
        groups = []
        for row in rows[:30]:
            reasons = []
            for field, reason in [('draft_count', 'draft_not_submitted'), ('submitted_count', 'awaiting_local_review'),
                                  ('failed_count', 'local_inspection_failed'), ('rejected_count', 'local_review_rejected'),
                                  ('approval_pending_count', 'mes_approval_pending'),
                                  ('completion_unverified_count', 'mes_completion_unverified')]:
                if row[field]:
                    reasons.append(reason)
            groups.append({key: row[key] for key in ['work_order_ref', 'task_ref', 'equipment_ref', 'source_kind', 'request_count', 'open_count']}
                | {'latest_request_at': row['latest_request_at'].isoformat(),
                   'statuses': {status: row[status + '_count'] for status in ['draft', 'submitted', 'approved', 'failed', 'rejected']},
                   'blocking_reasons': reasons})
        response.data.update(work_groups=groups, work_groups_truncated=len(rows) > 30)
        return response

    def retrieve(self, request, *args, **kwargs):
        return Response(serialize(self.get_object(), request.user))

    @action(detail=False, methods=['get'], url_path='capabilities')
    def capabilities(self, request):
        return Response(capabilities(request.user))

    @action(detail=False, methods=['get'], url_path='kanban')
    def kanban(self, request):
        from .inspection_kanban import projection
        value = request.query_params.get('date')
        target = None
        if value is not None:
            import re
            try:
                target = parse_date(value) if re.fullmatch(r'[0-9]{4}-[0-9]{2}-[0-9]{2}', value) else None
            except ValueError:
                target = None
            if target is None or target.year == 9999:
                raise ValidationError({'date': 'Use a supported ISO business date.'})
        return Response(projection(request.user, target))

    def create(self, request):
        key = operation_key(request.headers.get('Idempotency-Key'))
        serializer = CreateInspectionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data, status = create_request(request.user, key, serializer.validated_data)
        return Response(data, status=status)

    def partial_update(self, request, pk=None):
        return self._mutation(request, pk, 'draft', DraftInspectionSerializer)

    def _mutation(self, request, pk, action_name, serializer_class=ActionSerializer):
        self.get_object()  # 404 and standard access check; re-fetch/lock in service.
        key = operation_key(request.headers.get('Idempotency-Key'))
        serializer = serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        handler = external_action if action_name in {'sync', 'refresh'} else local_action
        data, status = handler(request.user, int(pk), action_name, key, serializer.validated_data)
        return Response(data, status=status)

    @action(detail=True, methods=['post'])
    def submit(self, request, pk=None):
        return self._mutation(request, pk, 'submit')

    @action(detail=True, methods=['post'])
    def approve(self, request, pk=None):
        return self._mutation(request, pk, 'approve')

    @action(detail=True, methods=['post'])
    def reject(self, request, pk=None):
        return self._mutation(request, pk, 'reject')

    @action(detail=True, methods=['post'])
    def reinspect(self, request, pk=None):
        return self._mutation(request, pk, 'reinspect')

    @action(detail=True, methods=['post'])
    def sync(self, request, pk=None):
        return self._mutation(request, pk, 'sync')

    @action(detail=True, methods=['post'])
    def refresh(self, request, pk=None):
        return self._mutation(request, pk, 'refresh')

    def _mes_stage(self, request, pk, name):
        from .inspection_mes_stages import stage_action
        self.get_object()
        key = operation_key(request.headers.get('Idempotency-Key'))
        serializer = ActionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data, status = stage_action(request.user, int(pk), name, key, serializer.validated_data)
        return Response(data, status=status)

    @action(detail=True, methods=['post'], url_path='mes-save')
    def mes_save(self, request, pk=None):
        return self._mes_stage(request, pk, 'mes-save')

    @action(detail=True, methods=['post'], url_path='mes-finish')
    def mes_finish(self, request, pk=None):
        return self._mes_stage(request, pk, 'mes-finish')

    @action(detail=True, methods=['post'], url_path='mes-reconcile')
    def mes_reconcile(self, request, pk=None):
        return self._mes_stage(request, pk, 'mes-reconcile')

    @action(detail=True, methods=['post'], url_path='review-failure')
    def review_failure(self, request, pk=None):
        return self._mutation(request, pk, 'review-failure')
