import logging

from django.db.models import Q, Count, Max
from django.utils.dateparse import parse_date
from rest_framework import mixins, viewsets
from rest_framework.decorators import action
from rest_framework.pagination import PageNumberPagination
from rest_framework.parsers import JSONParser
from rest_framework.permissions import BasePermission
from rest_framework.response import Response
from rest_framework.exceptions import PermissionDenied, ValidationError
from mes_oauth.session_guard import InspectionSession

from .inspection_models import InspectionRequest
from .inspection_access import can_use_admin_inspection_flow
from .inspection_validation import CreateInspectionSerializer, DraftInspectionSerializer, ActionSerializer
from .inspection_workflow import can_access_beta, capabilities, serialize, operation_key, create_request, local_action, external_action

logger = logging.getLogger(__name__)


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
        if not can_use_admin_inspection_flow(self.request.user):
            queryset = queryset.filter(Q(assigned_to_id=self.request.user.pk)
                | Q(role_workflow__areas__assigned_to_id=self.request.user.pk)).distinct()
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

    @action(detail=False, methods=['get', 'post'], url_path='role-settings')
    def role_settings(self, request):
        from .inspection_roles import settings_list, settings_create
        if request.method == 'GET':
            response = Response(settings_list(request.user))
            response['Cache-Control'] = 'no-store, max-age=0'
            return response
        key = operation_key(request.headers.get('Idempotency-Key'))
        data, status = settings_create(request.user, key, request.data,
                                      session=InspectionSession.from_request(request))
        return Response(data, status=status)

    @action(detail=False, methods=['patch'], url_path=r'role-settings/(?P<setting_id>[0-9]+)')
    def role_setting(self, request, setting_id=None):
        from .inspection_roles import settings_update
        if len(setting_id) > 18:
            raise ValidationError('Invalid shift setting.')
        key = operation_key(request.headers.get('Idempotency-Key'))
        data, status = settings_update(request.user, int(setting_id), key, request.data,
                                      session=InspectionSession.from_request(request))
        return Response(data, status=status)

    @action(detail=True, methods=['post'], url_path='role-configure')
    def role_configure(self, request, pk=None):
        from .inspection_roles import configure_role_workflow
        self.get_object()
        key = operation_key(request.headers.get('Idempotency-Key'))
        data, status = configure_role_workflow(request.user, int(pk), key, request.data,
                                              session=InspectionSession.from_request(request))
        return Response(data, status=status)

    def _area_action(self, request, pk, action_name):
        from . import inspection_roles
        self.get_object()
        if not isinstance(request.data, dict):
            raise ValidationError('Use an area action object.')
        payload = dict(request.data)
        area = payload.pop('area', None)
        handler = getattr(inspection_roles, 'area_' + action_name)
        key = operation_key(request.headers.get('Idempotency-Key'))
        data, status = handler(request.user, int(pk), area, key, payload,
                               session=InspectionSession.from_request(request))
        return Response(data, status=status)

    @action(detail=True, methods=['post'], url_path='area-save')
    def area_save(self, request, pk=None):
        return self._area_action(request, pk, 'save')

    @action(detail=True, methods=['post'], url_path='area-complete')
    def area_complete(self, request, pk=None):
        return self._area_action(request, pk, 'complete')

    @action(detail=True, methods=['post'], url_path='area-reopen')
    def area_reopen(self, request, pk=None):
        return self._area_action(request, pk, 'reopen')

    @action(detail=True, methods=['post'], url_path='role-results')
    def role_results(self, request, pk=None):
        from .inspection_role_actions import role_results
        self.get_object()
        key = operation_key(request.headers.get('Idempotency-Key'))
        data, status = role_results(request.user, int(pk), key, request.data,
                                   session=InspectionSession.from_request(request))
        return Response(data, status=status)

    @action(detail=False, methods=['get'], url_path='mes-detail-preview')
    def mes_detail_preview(self, request):
        """Read only the owner-approved QC; no local binding or write gate."""
        from mes_oauth import vault
        from mes_oauth.inspection_credentials import (
            APP_CREDENTIAL, CALLBACK, IDENTITY, POLICY, READ_AUTH, TEMPORARY, UNAVAILABLE)
        from .inspection_qc_read import read_approved_qc
        if request.method != 'GET':
            response = Response({'detail': 'mes_qc_read_unavailable',
                                 'code': 'read_method_not_allowed'}, status=405)
        elif request.query_params or request.body:
            response = Response({'detail': 'mes_qc_read_unavailable',
                                 'code': 'invalid_read_request'}, status=400)
        else:
            try:
                result = read_approved_qc(InspectionSession.from_request(request))
                response = Response(result)
            except vault.VaultBlocked as error:
                code = str(error)
                scope_denied = 'inspection_qc_read_scope_denied'
                allowed = {APP_CREDENTIAL, CALLBACK, IDENTITY, POLICY, READ_AUTH,
                           TEMPORARY, UNAVAILABLE, scope_denied}
                safe_code = code if code in allowed else UNAVAILABLE
                logger.warning('MES_QC_READ_BLOCKED code=%s', safe_code)
                response = Response({'detail': 'mes_qc_read_unavailable',
                                     'code': safe_code},
                                    status=403 if code in {POLICY, UNAVAILABLE, scope_denied} else 502)
        response['Cache-Control'] = 'no-store, max-age=0'
        response['Referrer-Policy'] = 'no-referrer'
        return response

    @action(detail=False, methods=['get'], url_path='kanban')
    def kanban(self, request):
        if not can_use_admin_inspection_flow(request.user):
            raise PermissionDenied('The production-wide board is outside this inspector pilot.')
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
        data, status = create_request(request.user, key, serializer.validated_data,
                                     session=InspectionSession.from_request(request))
        return Response(data, status=status)

    @action(detail=False, methods=['post'], url_path='integration-trial')
    def integration_trial(self, request):
        from .inspection_validation import CreateIntegrationTrialSerializer
        from .inspection_integration_trial import create_local_trial
        key = operation_key(request.headers.get('Idempotency-Key'))
        serializer = CreateIntegrationTrialSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data, status = create_local_trial(request.user, key, serializer.validated_data,
                                         session=InspectionSession.from_request(request))
        return Response(data, status=status)

    def partial_update(self, request, pk=None):
        return self._mutation(request, pk, 'draft', DraftInspectionSerializer)

    def _mutation(self, request, pk, action_name, serializer_class=ActionSerializer):
        self.get_object()  # 404 and standard access check; re-fetch/lock in service.
        key = operation_key(request.headers.get('Idempotency-Key'))
        serializer = serializer_class(data=request.data)
        serializer.is_valid(raise_exception=True)
        handler = external_action if action_name in {'sync', 'refresh'} else local_action
        data, status = handler(request.user, int(pk), action_name, key, serializer.validated_data,
                               session=InspectionSession.from_request(request))
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
        data, status = stage_action(request.user, int(pk), name, key, serializer.validated_data,
                                   session=InspectionSession.from_request(request))
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
