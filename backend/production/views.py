from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status, generics
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.exceptions import PermissionDenied, ValidationError
from django.utils.dateparse import parse_date
from django.utils import timezone
from datetime import datetime, time, timedelta
import pandas as pd
import pytz
import re

from .models import ProductionExecution, ProductionMesReportRecord, ProductionPlan, ProductionPlanChangeLog, ProductionPartCavity
from injection.models import CycleTimeSetup, InjectionMonitoringRecord, PartSpec
from assembly.models import AssemblyReport

from django.db.models import Sum, Q, Max
from django.db.utils import OperationalError, ProgrammingError, IntegrityError
from .serializers import ProductionExecutionSerializer, ProductionPlanChangeLogSerializer, ProductionPlanSerializer
from .permissions import user_can_edit_plan, user_can_view_plan
from .models import ProductionPlanPart
from .mes_progress import equipment_sort_order, format_equipment_label, normalize_equipment_key, normalize_part_no
from .ai_answer import build_ai_briefing
from .ai_gateway import answer_from_intent, build_injection_plan_context, request_local_llm, request_question_intent
from .ai_retrievers import get_daily_production_context
from .counter_utils import calculate_cumulative_counter_delta
from .machining_reconciliation import (
    build_machining_provision_payload,
    build_manual_report_payload,
    confirm_manual_report_match,
    create_manual_report,
)
import math


def serialize_plan_for_log(plan):
    return {
        'machine_name': plan.machine_name,
        'part_no': plan.part_no,
        'model_name': plan.model_name,
        'lot_no': plan.lot_no,
        'planned_quantity': int(round(plan.planned_quantity or 0)),
        'sequence': plan.sequence,
    }


def build_plan_change_summary(before, after):
    labels = {
        'machine_name': '설비',
        'part_no': 'Part No',
        'model_name': '모델',
        'lot_no': 'Lot',
        'planned_quantity': '수량',
        'sequence': '순서',
    }
    changes = [
        f"{labels.get(key, key)} {before.get(key) or '-'} → {after.get(key) or '-'}"
        for key in labels
        if before.get(key) != after.get(key)
    ]
    return ', '.join(changes[:3]) if changes else '변경 없음'

class ProductionPlanSummaryView(APIView):
    """
    API view to get processed production plan summary for a specific date.
    This mimics the structure of the data returned by the original file upload processor.
    """
    permission_classes = []

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        if not date_str:
            return Response({"error": "Date parameter is required."}, status=status.HTTP_400_BAD_REQUEST)
        
        target_date = parse_date(date_str)
        if not target_date:
            return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)

        # Fetch all plan data for the target date
        plan_data_qs = ProductionPlan.objects.filter(plan_date=target_date, planned_quantity__gt=0)
        latest_updated_at = plan_data_qs.aggregate(latest=Max('updated_at'))['latest']
        part_nos = {
            (part_no or '').strip().upper()
            for part_no in plan_data_qs.values_list('part_no', flat=True)
            if part_no
        }
        cavity_map = {
            (row['part_no'] or '').strip().upper(): row['cavity']
            for row in ProductionPartCavity.objects.filter(part_no__in=part_nos).values('part_no', 'cavity')
        }
        
        if not plan_data_qs.exists():
            return Response({
                "plan_date": target_date.isoformat(),
                "latest_updated_at": latest_updated_at.isoformat() if latest_updated_at else None,
                "injection": {
                    "records": [],
                    "machine_summary": [],
                    "model_summary": [],
                    "daily_totals": []
                },
                "machining": {
                    "records": [],
                    "machine_summary": [],
                    "model_summary": [],
                    "daily_totals": []
                }
            })

        # Reconstruct the response format the frontend expects
        # Note: This is simplified. The original processor handled multiple days in one file.
        # Here, we are just looking at the single selected day.

        # 1. 'records' format (simplified)
        records_injection = list(plan_data_qs.filter(plan_type='injection').values(
            'id', 'machine_name', 'lot_no', 'model_name', 'part_spec',
            'product_family_code', 'product_family_name', 'is_finished_product',
            'part_no', 'planned_quantity', 'sequence', 'created_at', 'updated_at'
        ))
        records_machining = list(plan_data_qs.filter(plan_type='machining').values(
            'id', 'machine_name', 'lot_no', 'model_name', 'part_spec',
            'product_family_code', 'product_family_name', 'is_finished_product',
            'part_no', 'planned_quantity', 'sequence', 'created_at', 'updated_at'
        ))
        for record in records_injection:
            record['planned_quantity'] = int(round(record.get('planned_quantity') or 0))
            part_no = (record.get('part_no') or '').strip().upper()
            record['cavity'] = int(cavity_map.get(part_no, 1) or 1)
        for record in records_machining:
            record['planned_quantity'] = int(round(record.get('planned_quantity') or 0))
            part_no = (record.get('part_no') or '').strip().upper()
            record['cavity'] = int(cavity_map.get(part_no, 1) or 1)

        # 2. 'machine_summary'
        machine_summary_injection = list(plan_data_qs.filter(plan_type='injection').values('machine_name')
            .annotate(plan_qty=Sum('planned_quantity'))
            .values('machine_name', 'plan_qty', 'plan_date'))

        machine_summary_machining = list(plan_data_qs.filter(plan_type='machining').values('machine_name')
            .annotate(plan_qty=Sum('planned_quantity'))
            .values('machine_name', 'plan_qty', 'plan_date'))

        # 3. 'model_summary'
        model_summary_injection = list(plan_data_qs.filter(plan_type='injection').values('model_name')
            .annotate(plan_qty=Sum('planned_quantity'))
            .values('model_name', 'plan_qty', 'plan_date'))
        
        model_summary_machining = list(plan_data_qs.filter(plan_type='machining').values('model_name')
            .annotate(plan_qty=Sum('planned_quantity'))
            .values('model_name', 'plan_qty', 'plan_date'))

        # 4. 'daily_totals'
        daily_total_injection = plan_data_qs.filter(plan_type='injection').aggregate(total=Sum('planned_quantity'))['total'] or 0
        daily_total_machining = plan_data_qs.filter(plan_type='machining').aggregate(total=Sum('planned_quantity'))['total'] or 0
        daily_total_injection = int(round(daily_total_injection))
        daily_total_machining = int(round(daily_total_machining))

        # Helper to convert date objects to strings for JSON serialization
        def serialize_summary(summary_list):
            for item in summary_list:
                if 'plan_date' in item and hasattr(item['plan_date'], 'isoformat'):
                    item['plan_date'] = item['plan_date'].isoformat()
                if 'plan_qty' in item:
                    item['plan_qty'] = int(round(item.get('plan_qty') or 0))
            return summary_list


        response = {
            "plan_date": target_date.isoformat(),
            "latest_updated_at": latest_updated_at.isoformat() if latest_updated_at else None,
            "injection": {
                "records": records_injection,
                "machine_summary": serialize_summary(machine_summary_injection),
                "model_summary": serialize_summary(model_summary_injection),
                "daily_totals": [{'date': target_date.isoformat(), 'plan_qty': daily_total_injection}]
            },
            "machining": {
                "records": records_machining,
                "machine_summary": serialize_summary(machine_summary_machining),
                "model_summary": serialize_summary(model_summary_machining),
                "daily_totals": [{'date': target_date.isoformat(), 'plan_qty': daily_total_machining}]
            }
        }
        
        return Response(response)


class ProductionPlanListView(generics.ListCreateAPIView):
    serializer_class = ProductionPlanSerializer
    permission_classes = [IsAuthenticated]
    pagination_class = None

    def get_queryset(self):
        date_str = self.request.query_params.get('date')
        plan_type = self.request.query_params.get('plan_type')
        if not date_str or not plan_type:
            raise ValidationError({'detail': 'date and plan_type are required.'})

        target_date = parse_date(date_str)
        if not target_date:
            raise ValidationError({'detail': 'Invalid date format. Use YYYY-MM-DD.'})

        if not user_can_view_plan(self.request.user, plan_type):
            raise PermissionDenied('You do not have permission to view this plan type.')

        return ProductionPlan.objects.filter(
            plan_date=target_date,
            plan_type=plan_type,
        ).order_by('machine_name', 'sequence', 'id')

    def perform_create(self, serializer):
        plan_type = self.request.data.get('plan_type')
        date_str = self.request.data.get('plan_date')
        if not plan_type or not date_str:
            raise ValidationError({'detail': 'plan_date and plan_type are required.'})
        target_date = parse_date(date_str)
        if not target_date:
            raise ValidationError({'detail': 'Invalid date format. Use YYYY-MM-DD.'})
        if plan_type not in ['injection', 'machining']:
            raise ValidationError({'detail': 'Invalid plan_type.'})
        if not user_can_edit_plan(self.request.user, plan_type):
            raise PermissionDenied('You do not have permission to edit this plan type.')
        machine_name = (serializer.validated_data.get('machine_name') or '').strip()
        sequence = serializer.validated_data.get('sequence')
        if sequence is None:
            last_seq = ProductionPlan.objects.filter(
                plan_date=target_date,
                plan_type=plan_type,
                machine_name=machine_name,
            ).aggregate(max_seq=Max('sequence'))['max_seq']
            sequence = (last_seq or 0) + 1
        try:
            obj = serializer.save(plan_date=target_date, plan_type=plan_type, sequence=sequence)
            ProductionPlanChangeLog.objects.create(
                plan_date=obj.plan_date,
                plan_type=obj.plan_type,
                action='create',
                machine_name=obj.machine_name,
                part_no=obj.part_no,
                model_name=obj.model_name,
                lot_no=obj.lot_no,
                plan_id=obj.id,
                after=serialize_plan_for_log(obj),
                summary=f"{obj.machine_name} {obj.part_no or obj.model_name or '-'} 생성",
                changed_by=self.request.user if self.request.user.is_authenticated else None,
            )
            part_no = (obj.part_no or '').strip().upper()
            if part_no:
                try:
                    ProductionPlanPart.objects.update_or_create(
                        plan_type=obj.plan_type,
                        part_no=part_no,
                        defaults={'model_name': (obj.model_name or '').strip() or None},
                    )
                except (OperationalError, ProgrammingError):
                    # Mapping table not ready; ignore to avoid 500 on plan creation.
                    pass
        except IntegrityError:
            raise ValidationError({'detail': 'Plan entry already exists for this machine/part.'})


class ProductionAiAskView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        question = (request.data.get('question') or '').strip()
        date_str = request.data.get('date') or timezone.localdate().isoformat()
        language = request.data.get('language') or 'ko'

        if not question:
            return Response({'detail': 'question is required.'}, status=status.HTTP_400_BAD_REQUEST)

        target_date = parse_date(date_str)
        if not target_date:
            return Response({'detail': 'Invalid date format. Use YYYY-MM-DD.'}, status=status.HTTP_400_BAD_REQUEST)

        intent = request_question_intent(question, target_date.isoformat(), language)
        context = build_injection_plan_context(target_date.isoformat())
        calculated_answer = answer_from_intent(intent, context, language)
        if calculated_answer:
            return Response({
                'answer': calculated_answer,
                'source': 'intent_calculated',
                'intent': intent,
                'context': {
                    'business_date': context['business_date'],
                    'range_start': context['range_start'],
                    'range_end': context['range_end'],
                    'recent_range_start': context['recent_range_start'],
                    'recent_range_end': context['recent_range_end'],
                },
            })

        try:
            answer = request_local_llm(question, context, language)
        except Exception as exc:
            return Response({
                'answer': '로컬 LLM 응답 시간이 길어져 중단했습니다. 계산형 질문은 더 빠르게 답할 수 있도록 계속 보강하겠습니다.',
                'source': 'timeout_or_llm_error',
                'detail': str(exc),
            })

        return Response({
            'answer': answer,
            'source': 'local_llm',
            'intent': intent,
            'context': {
                'business_date': context['business_date'],
                'range_start': context['range_start'],
                'range_end': context['range_end'],
                'recent_range_start': context['recent_range_start'],
                'recent_range_end': context['recent_range_end'],
            },
        })


class ProductionAiBriefingView(APIView):
    permission_classes = []

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date') or timezone.localdate().isoformat()
        language = request.query_params.get('language') or 'ko'
        target_date = parse_date(date_str)
        if not target_date:
            return Response({'detail': 'Invalid date format. Use YYYY-MM-DD.'}, status=status.HTTP_400_BAD_REQUEST)

        payload = build_ai_briefing(target_date, language)
        return Response(payload.to_dict())


class ProductionPlanDetailView(generics.RetrieveUpdateDestroyAPIView):
    serializer_class = ProductionPlanSerializer
    permission_classes = [IsAuthenticated]
    queryset = ProductionPlan.objects.all()

    def get_object(self):
        obj = super().get_object()
        if self.request.method in ['GET', 'HEAD', 'OPTIONS']:
            if not user_can_view_plan(self.request.user, obj.plan_type):
                raise PermissionDenied('You do not have permission to view this plan type.')
            return obj

        if not user_can_edit_plan(self.request.user, obj.plan_type):
            raise PermissionDenied('You do not have permission to edit this plan type.')
        return obj

    def perform_update(self, serializer):
        before = serialize_plan_for_log(self.get_object())
        obj = serializer.save()
        after = serialize_plan_for_log(obj)
        action = 'reorder' if set(key for key in after if before.get(key) != after.get(key)) == {'sequence'} else 'update'
        ProductionPlanChangeLog.objects.create(
            plan_date=obj.plan_date,
            plan_type=obj.plan_type,
            action=action,
            machine_name=obj.machine_name,
            part_no=obj.part_no,
            model_name=obj.model_name,
            lot_no=obj.lot_no,
            plan_id=obj.id,
            before=before,
            after=after,
            summary=build_plan_change_summary(before, after),
            changed_by=self.request.user if self.request.user.is_authenticated else None,
        )
        part_no = (obj.part_no or '').strip().upper()
        if part_no:
            try:
                ProductionPlanPart.objects.update_or_create(
                    plan_type=obj.plan_type,
                    part_no=part_no,
                    defaults={'model_name': (obj.model_name or '').strip() or None},
                )
            except (OperationalError, ProgrammingError):
                # Mapping table not ready; ignore to avoid 500 on plan update.
                pass


class ProductionPlanDatesView(APIView):
    """
    API view to get distinct dates for which production plans exist.
    """
    permission_classes = []

    def get(self, request, *args, **kwargs):
        injection_dates = list(
            ProductionPlan.objects.filter(plan_type='injection')
            .values_list('plan_date', flat=True)
            .distinct()
            .order_by('plan_date')
        )
        machining_dates = list(
            ProductionPlan.objects.filter(plan_type='machining')
            .values_list('plan_date', flat=True)
            .distinct()
            .order_by('plan_date')
        )

        # Convert date objects to ISO format strings
        injection_dates_str = [d.isoformat() for d in injection_dates]
        machining_dates_str = [d.isoformat() for d in machining_dates]

        return Response({
            'injection': injection_dates_str,
            'machining': machining_dates_str,
        })


class ProductionPlanPartSearchView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        search = (request.query_params.get('search') or '').strip()
        plan_type = request.query_params.get('plan_type')
        if not search:
            return Response([])

        try:
            queryset = ProductionPlanPart.objects.all()
            if plan_type in ['injection', 'machining']:
                queryset = queryset.filter(plan_type=plan_type)

            queryset = queryset.filter(
                Q(part_no__istartswith=search) | Q(model_name__icontains=search)
            ).order_by('part_no')[:30]

            data = [
                {
                    'part_no': row.part_no,
                    'model_name': row.model_name or '',
                }
                for row in queryset
            ]
        except (OperationalError, ProgrammingError):
            # Fallback if mapping table is missing or not migrated.
            plan_qs = ProductionPlan.objects.all()
            if plan_type in ['injection', 'machining']:
                plan_qs = plan_qs.filter(plan_type=plan_type)
            plan_qs = plan_qs.filter(
                Q(part_no__istartswith=search) | Q(model_name__icontains=search)
            ).values('part_no', 'model_name').distinct()[:30]
            data = [
                {
                    'part_no': (row.get('part_no') or '').strip().upper(),
                    'model_name': row.get('model_name') or '',
                }
                for row in plan_qs
                if row.get('part_no')
            ]
        return Response(data)


class ProductionPlanChangeLogView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        if not date_str:
            return Response({'detail': 'date is required.'}, status=status.HTTP_400_BAD_REQUEST)

        target_date = parse_date(date_str)
        if not target_date:
            return Response({'detail': 'Invalid date format. Use YYYY-MM-DD.'}, status=status.HTTP_400_BAD_REQUEST)

        logs = ProductionPlanChangeLog.objects.filter(plan_date=target_date)
        plan_type = request.query_params.get('plan_type')
        if plan_type in ['injection', 'machining']:
            logs = logs.filter(plan_type=plan_type)

        latest_plan_updated_at = ProductionPlan.objects.filter(plan_date=target_date).aggregate(
            latest=Max('updated_at'),
        )['latest']
        latest_log_at = logs.aggregate(latest=Max('created_at'))['latest']
        latest_updated_at = max(
            [value for value in [latest_plan_updated_at, latest_log_at] if value],
            default=None,
        )

        logs = logs.select_related('changed_by')[:100]
        return Response({
            'date': target_date.isoformat(),
            'latest_updated_at': latest_updated_at.isoformat() if latest_updated_at else None,
            'logs': ProductionPlanChangeLogSerializer(logs, many=True).data,
        })

class ProductionDashboardView(APIView):
    """
    API view to provide data for the production status dashboard.
    Accepts 'date' and 'plan_type' query parameters.
    """
    permission_classes = [] # Adjust permissions as needed

    def get(self, request, *args, **kwargs):
        # 1. Get and validate query parameters
        date_str = request.query_params.get('date')
        plan_type = request.query_params.get('plan_type') # 'injection' or 'machining'

        if not date_str or not plan_type:
            return Response(
                {"error": "Date and plan_type parameters are required."},
                status=status.HTTP_400_BAD_REQUEST
            )

        target_date = parse_date(date_str)
        if not target_date:
            return Response(
                {"error": "Invalid date format. Use YYYY-MM-DD."},
                status=status.HTTP_400_BAD_REQUEST
            )
            
        if plan_type not in ['injection', 'machining']:
            return Response(
                {"error": "Invalid plan_type. Use 'injection' or 'machining'."},
                status=status.HTTP_400_BAD_REQUEST
            )

        # 2. Define the 24-hour window (8 AM to 8 AM next day)
        start_datetime = pd.Timestamp(target_date, tz='Asia/Shanghai').replace(hour=8, minute=0, second=0, microsecond=0)
        end_datetime = start_datetime + timedelta(days=1)

        # 3. Query Plan Data
        plan_queryset = ProductionPlan.objects.filter(
            plan_date=target_date,
            plan_type=plan_type,
            planned_quantity__gt=0,
        ).values('machine_name', 'planned_quantity')
        
        if not plan_queryset.exists():
            return Response({"message": "No production plan found for this date and type."}, status=status.HTTP_200_OK)

        plan_df = pd.DataFrame(list(plan_queryset))
        plan_summary = plan_df.groupby('machine_name')['planned_quantity'].sum().reset_index()
        plan_summary.rename(columns={'planned_quantity': 'total_planned'}, inplace=True)

        # 4. Query Actual Data based on plan_type
        actual_summary = pd.DataFrame(columns=['machine_name', 'total_actual'])

        if plan_type == 'injection':
            # MES data is stored in UTC, frontend time is Asia/Shanghai. Assuming UTC for now.
            # This might need adjustment based on how MES data is stored.
            actual_queryset = InjectionMonitoringRecord.objects.filter(
                timestamp__gte=start_datetime,
                timestamp__lt=end_datetime
            ).values('machine_name', 'capacity')
            
            if actual_queryset.exists():
                actual_df = pd.DataFrame(list(actual_queryset))
                # The 'capacity' from MES seems to be cumulative per hour, not a delta.
                # We need to calculate the production delta between periods.
                # For simplicity now, we will sum up the capacity. This needs refinement.
                # A better approach would be to get the max value per machine for the period.
                actual_summary = actual_df.groupby('machine_name')['capacity'].sum().reset_index()
                actual_summary.rename(columns={'capacity': 'total_actual'}, inplace=True)

        elif plan_type == 'machining':
            # Assumption: AssemblyReport.date corresponds to the start of the 24h cycle
            actual_queryset = AssemblyReport.objects.filter(
                date=target_date
            ).values('line_no', 'actual_qty')
            
            if actual_queryset.exists():
                actual_df = pd.DataFrame(list(actual_queryset))
                actual_summary = actual_df.groupby('line_no')['actual_qty'].sum().reset_index()
                actual_summary.rename(columns={'line_no': 'machine_name', 'actual_qty': 'total_actual'}, inplace=True)
        
        # 5. Combine data
        if actual_summary.empty:
             merged_df = plan_summary
             merged_df['total_actual'] = 0
        else:
             merged_df = pd.merge(plan_summary, actual_summary, on='machine_name', how='left')

        merged_df['total_actual'] = merged_df['total_actual'].fillna(0)
        
        # Calculate progress
        merged_df['progress'] = ((merged_df['total_actual'] / merged_df['total_planned']) * 100).fillna(0)
        # Handle cases where plan is 0 but actual is > 0
        merged_df.loc[merged_df['total_planned'] == 0, 'progress'] = 100
        merged_df['progress'] = merged_df['progress'].round(1)

        # 6. Format response
        response_data = merged_df.to_dict('records')

        return Response(response_data)


from itertools import groupby

class ProductionStatusView(APIView):
    """
    API view to provide consolidated production status data for the main dashboard.
    Uses the same canonical production context as AI briefing and analytics marts.
    """
    permission_classes = []

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        if not date_str:
            return Response({"error": "Date parameter is required."}, status=status.HTTP_400_BAD_REQUEST)

        try:
            target_date = parse_date(date_str)
            if not target_date:
                raise ValueError("Invalid date format")
        except (ValueError, TypeError):
            return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)

        context = get_daily_production_context(target_date)

        injection_results = [
            {
                'machine_name': row.get('machine_name') or row.get('machine') or '',
                'total_planned': int(row.get('planned_qty') or 0),
                'total_actual': int(row.get('actual_qty') or 0),
                'progress': float(row.get('progress_rate') or 0),
                'parts': [
                    {
                        'part_no': part.get('part_no'),
                        'model_name': part.get('model_name'),
                        'planned_quantity': int(part.get('planned_qty') or 0),
                        'actual_quantity': int(part.get('estimated_qty') or 0),
                        'progress': float(part.get('progress_rate') or 0),
                    }
                    for part in row.get('parts', [])
                ],
            }
            for row in context['injection'].get('machine_rows', [])
        ]

        machining_by_equipment = {}
        for row in context['machining'].get('rows', []):
            equipment_key = row.get('equipment_key') or row.get('equipment_label') or row.get('equipment_name') or ''
            group = machining_by_equipment.setdefault(equipment_key, {
                'machine_name': row.get('equipment_label') or row.get('equipment_name') or equipment_key,
                'total_planned': 0,
                'total_actual': 0,
                'total_mes': 0,
                'total_manual_open': 0,
                'total_manual_matched': 0,
                'total_defect': 0,
                'parts': [],
            })
            planned_qty = int(row.get('planned_qty') or 0)
            actual_qty = int(row.get('actual_qty') or 0)
            mes_qty = int(row.get('mes_qty') or 0)
            manual_open_qty = int(row.get('manual_open_qty') or 0)
            matched_manual_qty = int(row.get('matched_manual_qty') or 0)
            defect_qty = int(row.get('defect_qty') or 0)
            group['total_planned'] += planned_qty
            group['total_actual'] += actual_qty
            group['total_mes'] += mes_qty
            group['total_manual_open'] += manual_open_qty
            group['total_manual_matched'] += matched_manual_qty
            group['total_defect'] += defect_qty
            group['parts'].append({
                'part_no': row.get('part_no'),
                'model_name': row.get('model_name'),
                'planned_quantity': planned_qty,
                'actual_quantity': actual_qty,
                'progress': float(row.get('progress_rate') or 0),
                'mes_qty': mes_qty,
                'manual_open_qty': manual_open_qty,
                'matched_manual_qty': matched_manual_qty,
                'defect_qty': defect_qty,
                'status': row.get('status'),
            })

        machining_results = []
        for row in machining_by_equipment.values():
            total_planned = int(row['total_planned'])
            total_actual = int(row['total_actual'])
            row['progress'] = round((total_actual / total_planned) * 100, 1) if total_planned > 0 else 0
            machining_results.append(row)

        return Response({
            'injection': injection_results,
            'machining': sorted(machining_results, key=lambda item: item['machine_name'])
        })

class ProductionPartCavityView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        part_no = (request.query_params.get('part_no') or '').strip().upper()
        if not part_no:
            return Response({"error": "part_no is required."}, status=status.HTTP_400_BAD_REQUEST)
        cavity = ProductionPartCavity.objects.filter(part_no=part_no).values_list('cavity', flat=True).first() or 1
        return Response({"part_no": part_no, "cavity": int(cavity)})

    def post(self, request, *args, **kwargs):
        part_no = (request.data.get('part_no') or '').strip().upper()
        cavity = request.data.get('cavity')
        if not part_no:
            return Response({"error": "part_no is required."}, status=status.HTTP_400_BAD_REQUEST)
        try:
            cavity_val = int(cavity)
        except (TypeError, ValueError):
            return Response({"error": "cavity must be an integer."}, status=status.HTTP_400_BAD_REQUEST)
        cavity_val = max(1, cavity_val)
        obj, _ = ProductionPartCavity.objects.update_or_create(
            part_no=part_no,
            defaults={'cavity': cavity_val},
        )
        return Response({"part_no": obj.part_no, "cavity": obj.cavity})


class ProductionConsoleView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        plan_type = request.query_params.get('plan_type')
        if not date_str or not plan_type:
            return Response({"error": "date and plan_type are required."}, status=status.HTTP_400_BAD_REQUEST)

        target_date = parse_date(date_str)
        if not target_date:
            return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)
        if plan_type not in ['injection', 'machining']:
            return Response({"error": "Invalid plan_type."}, status=status.HTTP_400_BAD_REQUEST)

        plans = list(
            ProductionPlan.objects.filter(
                plan_date=target_date,
                plan_type=plan_type,
                planned_quantity__gt=0,
            )
            .order_by('machine_name', 'sequence', 'id')
            .values(
                'machine_name',
                'lot_no',
                'model_name',
                'part_spec',
                'product_family_code',
                'product_family_name',
                'is_finished_product',
                'part_no',
                'planned_quantity',
                'sequence',
            )
        )

        execution_map = {
            self._key(exec_row.plan_date, exec_row.plan_type, exec_row.machine_name, exec_row.part_no, exec_row.lot_no, exec_row.sequence): exec_row
            for exec_row in ProductionExecution.objects.filter(plan_date=target_date, plan_type=plan_type)
        }

        part_nos = sorted({(row.get('part_no') or '').strip().upper() for row in plans if row.get('part_no')})
        cavity_map = {
            row['part_no']: int(row['cavity'] or 1)
            for row in ProductionPartCavity.objects.filter(part_no__in=part_nos).values('part_no', 'cavity')
        }

        latest_partspec_map = {}
        if part_nos:
            for spec in PartSpec.objects.filter(part_no__in=part_nos).order_by('part_no', '-valid_from'):
                latest_partspec_map.setdefault(spec.part_no, spec)

        latest_setup_map = {}
        if plan_type == 'injection':
            machine_numbers = sorted({
                number for number in (self._extract_machine_number(row.get('machine_name')) for row in plans)
                if isinstance(number, int)
            })
            if machine_numbers and part_nos:
                setups = CycleTimeSetup.objects.filter(
                    machine_no__in=machine_numbers,
                    part_no__in=part_nos,
                ).exclude(status='REJECTED').order_by('machine_no', 'part_no', '-setup_date')
                for setup in setups:
                    latest_setup_map.setdefault((setup.machine_no, setup.part_no), setup)

        rows = []
        total_planned = 0
        total_actual = 0
        total_defect = 0

        for row in plans:
            machine_name = (row.get('machine_name') or '').strip()
            part_no = (row.get('part_no') or '').strip().upper()
            lot_no = (row.get('lot_no') or '').strip() or None
            sequence = int(row.get('sequence') or 0)
            planned_quantity = int(round(float(row.get('planned_quantity') or 0)))
            key = self._key(target_date, plan_type, machine_name, part_no, lot_no, sequence)
            execution = execution_map.get(key)
            machine_number = self._extract_machine_number(machine_name)
            setup = latest_setup_map.get((machine_number, part_no)) if machine_number is not None else None
            spec = latest_partspec_map.get(part_no)

            actual_qty = int(execution.actual_qty if execution else 0)
            defect_qty = int(execution.defect_qty if execution else 0)
            idle_time = int(execution.idle_time if execution else 0)
            personnel_count = float(execution.personnel_count if execution else (setup.personnel_count if setup else 0))
            operating_ct = (
                float(execution.operating_ct)
                if execution and execution.operating_ct is not None
                else float(setup.target_cycle_time)
                if setup and setup.target_cycle_time is not None
                else float(spec.cycle_time_sec)
                if spec and spec.cycle_time_sec is not None
                else None
            )
            status_value = self._derive_status(
                planned_quantity=planned_quantity,
                actual_qty=actual_qty,
                idle_time=idle_time,
                explicit_status=execution.status if execution else None,
                has_started=bool(execution and execution.start_datetime),
            )

            rows.append({
                'key': self._key_str(target_date, plan_type, machine_name, part_no, lot_no, sequence),
                'execution_id': execution.id if execution else None,
                'plan_date': target_date.isoformat(),
                'plan_type': plan_type,
                'machine_name': machine_name,
                'machine_number': machine_number,
                'sequence': sequence,
                'part_no': part_no,
                'model_name': row.get('model_name') or '',
                'part_spec': row.get('part_spec') or '',
                'lot_no': lot_no,
                'planned_quantity': planned_quantity,
                'actual_qty': actual_qty,
                'defect_qty': defect_qty,
                'idle_time': idle_time,
                'personnel_count': personnel_count,
                'operating_ct': operating_ct,
                'start_datetime': execution.start_datetime.isoformat() if execution and execution.start_datetime else None,
                'end_datetime': execution.end_datetime.isoformat() if execution and execution.end_datetime else None,
                'note': execution.note if execution else '',
                'status': status_value,
                'progress': round((actual_qty / planned_quantity) * 100, 1) if planned_quantity > 0 else 0,
                'cavity': cavity_map.get(part_no, 1),
                'baseline_ct': int(spec.cycle_time_sec) if spec and spec.cycle_time_sec is not None else None,
                'target_cycle_time': int(setup.target_cycle_time) if setup else None,
                'standard_cycle_time': int(setup.standard_cycle_time) if setup and setup.standard_cycle_time is not None else None,
                'mean_cycle_time': int(setup.mean_cycle_time) if setup and setup.mean_cycle_time is not None else None,
            })

            total_planned += planned_quantity
            total_actual += actual_qty
            total_defect += defect_qty

        return Response({
            'date': target_date.isoformat(),
            'plan_type': plan_type,
            'summary': {
                'total_planned': total_planned,
                'total_actual': total_actual,
                'total_defect': total_defect,
                'achievement_rate': round((total_actual / total_planned) * 100, 1) if total_planned > 0 else 0,
                'defect_rate': round((total_defect / total_actual) * 100, 1) if total_actual > 0 else 0,
                'pending_count': sum(1 for row in rows if row['status'] == 'pending'),
                'running_count': sum(1 for row in rows if row['status'] == 'running'),
                'paused_count': sum(1 for row in rows if row['status'] == 'paused'),
                'completed_count': sum(1 for row in rows if row['status'] == 'completed'),
                'avg_operating_ct': round(
                    sum(row['operating_ct'] for row in rows if row['operating_ct'] is not None) /
                    sum(1 for row in rows if row['operating_ct'] is not None),
                    1,
                ) if any(row['operating_ct'] is not None for row in rows) else 0,
            },
            'rows': rows,
        })

    @staticmethod
    def _extract_machine_number(name):
        if not name:
            return None
        text = str(name)
        patterns = (
            r'-(\d+)\s*$',
            r'^\s*(\d+)\b',
            r'(\d+)',
        )
        for pattern in patterns:
            match = re.search(pattern, text)
            if match:
                return int(match.group(1))
        return None

    @staticmethod
    def _extract_line_key(name):
        if not name:
            return ''
        text = str(name).strip().upper()
        match = re.search(r'([A-Z])', text)
        if match:
            return match.group(1)
        return text

    @classmethod
    def _normalize_equipment_key(cls, plan_type, equipment_name):
        if plan_type == 'injection':
            number = cls._extract_machine_number(equipment_name)
            return str(number) if number is not None else ''
        return cls._extract_line_key(equipment_name)

    @classmethod
    def _format_equipment_label(cls, plan_type, equipment_name, equipment_key):
        if plan_type == 'injection':
            number = cls._extract_machine_number(equipment_name) if equipment_name else None
            machine_number = number if number is not None else int(equipment_key)
            tonnage_match = re.search(r'(\d{2,5}T)', str(equipment_name or '').upper())
            tonnage = tonnage_match.group(1) if tonnage_match else ''
            return f"{machine_number}\uD638\uAE30 {tonnage}".strip()
        return f"{equipment_key}\uB77C\uC778"

    @classmethod
    def _equipment_sort_order(cls, plan_type, equipment_key):
        if plan_type == 'injection':
            try:
                return int(equipment_key)
            except (TypeError, ValueError):
                return 9999
        return ord(str(equipment_key or 'Z')[0])

    @staticmethod
    def _format_report_time(value):
        if not value:
            return None
        try:
            dt = datetime.fromtimestamp(int(value) / 1000, tz=timezone.get_current_timezone())
            return dt.isoformat()
        except (TypeError, ValueError, OSError):
            return None

    @staticmethod
    def _key(plan_date, plan_type, machine_name, part_no, lot_no, sequence):
        normalized_lot_no = (lot_no or '').strip() or None
        return (
            plan_date,
            (plan_type or '').strip(),
            (machine_name or '').strip(),
            (part_no or '').strip().upper(),
            normalized_lot_no,
            int(sequence or 0),
        )

    @classmethod
    def _key_str(cls, plan_date, plan_type, machine_name, part_no, lot_no, sequence):
        return '|'.join(str(value or '') for value in cls._key(
            plan_date,
            plan_type,
            machine_name,
            part_no,
            lot_no,
            sequence,
        ))

    @staticmethod
    def _derive_status(planned_quantity, actual_qty, idle_time, explicit_status=None, has_started=False):
        valid_statuses = {'pending', 'running', 'completed', 'paused'}
        if explicit_status in {'paused', 'completed'}:
            return explicit_status

        try:
            planned = int(round(float(planned_quantity or 0)))
            actual = int(round(float(actual_qty or 0)))
            idle_minutes = int(round(float(idle_time or 0)))
        except (TypeError, ValueError):
            planned = 0
            actual = 0
            idle_minutes = 0

        if planned > 0 and actual >= planned:
            return 'completed'
        if explicit_status == 'running' or actual > 0 or has_started:
            return 'running'
        if idle_minutes > 0:
            return 'paused'
        if explicit_status in valid_statuses:
            return explicit_status
        return 'pending'


class ProductionExecutionUpsertView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        plan_type = request.data.get('plan_type')
        if plan_type not in ['injection', 'machining']:
            return Response({'detail': 'Invalid plan_type.'}, status=status.HTTP_400_BAD_REQUEST)
        if not user_can_edit_plan(request.user, plan_type):
            raise PermissionDenied('You do not have permission to edit this plan type.')

        payload = request.data.copy()
        payload['part_no'] = (payload.get('part_no') or '').strip().upper()
        payload['lot_no'] = (payload.get('lot_no') or '').strip() or None
        payload['machine_name'] = (payload.get('machine_name') or '').strip()

        target_date = parse_date(payload.get('plan_date'))
        if not target_date:
            return Response({'detail': 'Invalid plan_date.'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            sequence = int(payload.get('sequence') or 0)
            planned_quantity = int(round(float(payload.get('planned_quantity') or 0)))
        except (TypeError, ValueError):
            return Response({'detail': 'Invalid numeric payload.'}, status=status.HTTP_400_BAD_REQUEST)

        plan_queryset = ProductionPlan.objects.filter(
            plan_date=target_date,
            plan_type=plan_type,
            machine_name=payload['machine_name'],
            part_no=payload['part_no'],
            sequence=sequence,
        )
        if payload['lot_no']:
            plan_queryset = plan_queryset.filter(lot_no=payload['lot_no'])
        else:
            plan_queryset = plan_queryset.filter(Q(lot_no__isnull=True) | Q(lot_no=''))

        if not plan_queryset.exists():
            return Response({'detail': 'Matching production plan row not found.'}, status=status.HTTP_404_NOT_FOUND)

        execution_queryset = ProductionExecution.objects.filter(
            plan_date=target_date,
            plan_type=plan_type,
            machine_name=payload['machine_name'],
            part_no=payload['part_no'],
            sequence=sequence,
        )
        if payload['lot_no']:
            execution_queryset = execution_queryset.filter(lot_no=payload['lot_no'])
        else:
            execution_queryset = execution_queryset.filter(Q(lot_no__isnull=True) | Q(lot_no=''))

        existing = execution_queryset.first()

        serializer = ProductionExecutionSerializer(instance=existing, data=payload, partial=bool(existing))
        serializer.is_valid(raise_exception=True)

        actual_qty = int(serializer.validated_data.get('actual_qty', existing.actual_qty if existing else 0) or 0)
        idle_time = int(serializer.validated_data.get('idle_time', existing.idle_time if existing else 0) or 0)
        status_value = ProductionConsoleView._derive_status(
            planned_quantity=planned_quantity,
            actual_qty=actual_qty,
            idle_time=idle_time,
            explicit_status=request.data.get('status'),
            has_started=bool(serializer.validated_data.get('start_datetime') or (existing.start_datetime if existing else None)),
        )

        saved = serializer.save(updated_by=request.user, status=status_value)
        return Response(ProductionExecutionSerializer(saved).data)


class DebugPlanView(APIView):
    """
    A temporary view to debug the state of ProductionPlan data for a specific machine and date.
    """
    permission_classes = [AllowAny]

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        machine_name = request.query_params.get('machine_name')

        if not date_str or not machine_name:
            return Response(
                {"error": "Date and machine_name parameters are required."},
                status=status.HTTP_400_BAD_REQUEST
            )

        try:
            target_date = parse_date(date_str)
        except (ValueError, TypeError):
            return Response({"error": "Invalid date format. Use YYYY-MM-DD."}, status=status.HTTP_400_BAD_REQUEST)

        plans = ProductionPlan.objects.filter(
            plan_date=target_date,
            machine_name=machine_name
        ).order_by('sequence')

        if not plans.exists():
            return Response({"message": "No plans found for this date and machine."})

        data = list(plans.values(
            'id',
            'machine_name',
            'part_no',
            'sequence',
            'planned_quantity'
        ))

        return Response(data)


class ProductionMesReportStatsView(APIView):
    permission_classes = []

    def get(self, request, *args, **kwargs):
        date_str = request.query_params.get('date')
        plan_type = request.query_params.get('plan_type', 'injection')
        if not date_str:
            return Response({'detail': 'date is required.'}, status=status.HTTP_400_BAD_REQUEST)
        if plan_type not in {'injection', 'machining'}:
            return Response({'detail': 'Invalid plan_type.'}, status=status.HTTP_400_BAD_REQUEST)

        target_date = parse_date(date_str)
        if not target_date:
            return Response({'detail': 'Invalid date format. Use YYYY-MM-DD.'}, status=status.HTTP_400_BAD_REQUEST)

        tz = pytz.timezone('Asia/Shanghai')
        range_mode = 'day'
        business_start = time(hour=8, minute=0)
        start_dt = tz.localize(datetime.combine(target_date, business_start))
        end_dt = tz.localize(datetime.combine(target_date + timedelta(days=1), business_start))

        mes_groups = {}
        raw_count = ProductionMesReportRecord.objects.filter(
            report_time__gte=start_dt,
            report_time__lt=end_dt,
            plan_type=plan_type,
        ).count()
        mes_records = ProductionMesReportRecord.objects.filter(
            business_date=target_date,
            plan_type=plan_type,
        ).order_by('report_time')
        filtered_count = mes_records.count()

        def stats_key(equipment_key, part_no):
            if plan_type == 'machining':
                return part_no
            return (equipment_key, part_no)

        for record in mes_records:
            key = stats_key(record.equipment_key, record.part_no)
            group = mes_groups.setdefault(key, {
                'equipment_key': record.equipment_key,
                'equipment_name': record.equipment_name,
                'part_no': record.part_no,
                'mes_qty': 0,
                'mes_report_count': 0,
                'latest_report_time': None,
                'process_code': record.process_code,
                'mes_material_name': record.material_name,
            })
            group['mes_qty'] += int(record.report_qty or 0)
            group['mes_report_count'] += 1
            latest_report_time = record.report_time.isoformat() if record.report_time else None
            if latest_report_time and (
                not group['latest_report_time'] or latest_report_time > group['latest_report_time']
            ):
                group['latest_report_time'] = latest_report_time

        plan_groups = {}
        plans = ProductionPlan.objects.filter(plan_date=target_date, plan_type=plan_type, planned_quantity__gt=0)
        for plan in plans:
            equipment_key = normalize_equipment_key(plan_type, plan.machine_name)
            part_no = normalize_part_no(plan.part_no)
            if not part_no or (plan_type != 'machining' and not equipment_key):
                continue
            key = stats_key(equipment_key, part_no)
            group = plan_groups.setdefault(key, {
                'equipment_key': equipment_key,
                'machine_name': plan.machine_name,
                'part_no': part_no,
                'model_name': plan.model_name or '',
                'planned_qty': 0,
                'plan_row_count': 0,
            })
            group['planned_qty'] += int(round(plan.planned_quantity or 0))
            group['plan_row_count'] += 1
            if not group['model_name'] and plan.model_name:
                group['model_name'] = plan.model_name

        keys = sorted(
            set(plan_groups.keys()) | set(mes_groups.keys()),
            key=lambda item: (
                equipment_sort_order(plan_type, (plan_groups.get(item) or mes_groups.get(item) or {}).get('equipment_key') or ''),
                (plan_groups.get(item) or mes_groups.get(item) or {}).get('part_no') or '',
            ),
        )

        rows = []
        total_planned = 0
        total_mes = 0
        matched_rows = 0
        plan_only_rows = 0
        mes_only_rows = 0

        for key in keys:
            plan_group = plan_groups.get(key, {})
            mes_group = mes_groups.get(key, {})
            planned_qty = int(plan_group.get('planned_qty') or 0)
            mes_qty = int(round(mes_group.get('mes_qty') or 0))
            gap_qty = mes_qty - planned_qty
            equipment_key = plan_group.get('equipment_key') or mes_group.get('equipment_key') or ''
            part_no = plan_group.get('part_no') or mes_group.get('part_no') or ''
            equipment_name = plan_group.get('machine_name') or mes_group.get('equipment_name') or equipment_key

            if planned_qty and mes_qty:
                compare_status = 'matched'
                matched_rows += 1
            elif planned_qty:
                compare_status = 'plan_only'
                plan_only_rows += 1
            else:
                compare_status = 'mes_only'
                mes_only_rows += 1

            rows.append({
                'equipment_key': equipment_key,
                'equipment_name': equipment_name,
                'equipment_label': format_equipment_label(plan_type, equipment_name, equipment_key),
                'part_no': part_no,
                'model_name': plan_group.get('model_name') or mes_group.get('mes_material_name') or '',
                'planned_qty': planned_qty,
                'mes_qty': mes_qty,
                'gap_qty': gap_qty,
                'achievement_rate': round((mes_qty / planned_qty) * 100, 1) if planned_qty > 0 else None,
                'mes_report_count': int(mes_group.get('mes_report_count') or 0),
                'latest_report_time': mes_group.get('latest_report_time'),
                'compare_status': compare_status,
                'process_code': mes_group.get('process_code') or ('ZS' if plan_type == 'injection' else 'JG'),
                'plan_row_count': int(plan_group.get('plan_row_count') or 0),
            })
            total_planned += planned_qty
            total_mes += mes_qty

        return Response({
            'date': target_date.isoformat(),
            'plan_type': plan_type,
            'range_mode': range_mode,
            'range_start': start_dt.isoformat(),
            'range_end': end_dt.isoformat(),
            'latest_synced_at': mes_records.order_by('-updated_at').values_list('updated_at', flat=True).first(),
            'summary': {
                'total_planned': total_planned,
                'total_mes': total_mes,
                'gap_qty': total_mes - total_planned,
                'achievement_rate': round((total_mes / total_planned) * 100, 1) if total_planned > 0 else 0,
                'matched_rows': matched_rows,
                'plan_only_rows': plan_only_rows,
                'mes_only_rows': mes_only_rows,
                'raw_mes_count': raw_count,
                'grouped_mes_count': filtered_count,
            },
            'rows': rows,
        })


class MachiningProvisionView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        business_date = request.query_params.get('business_date') or request.query_params.get('date')
        if not business_date:
            return Response({'detail': 'business_date is required.'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            days = int(request.query_params.get('days') or 3)
        except (TypeError, ValueError):
            days = 3

        payload = build_machining_provision_payload(business_date, days=days)
        return Response(payload)


class MachiningManualReportView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        if not user_can_edit_plan(request.user, 'machining'):
            raise PermissionDenied('You do not have permission to edit machining reports.')
        try:
            report = create_manual_report(user=request.user, payload=request.data)
        except ValueError as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(build_manual_report_payload(report), status=status.HTTP_201_CREATED)


class MachiningReconciliationView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, *args, **kwargs):
        business_date = request.query_params.get('business_date') or request.query_params.get('date')
        if not business_date:
            return Response({'detail': 'business_date is required.'}, status=status.HTTP_400_BAD_REQUEST)
        statuses = {
            value.strip()
            for value in (request.query_params.get('status') or 'open,partial,mismatch').split(',')
            if value.strip()
        }
        payload = build_machining_provision_payload(business_date, days=3)
        reports = []
        for row in payload.get('rows', []):
            for report in row.get('manual_reports', []):
                if report.get('status') in statuses:
                    reports.append({**report, 'row': {
                        'plan_id': row.get('plan_id'),
                        'plan_date': row.get('plan_date'),
                        'machine_name': row.get('machine_name'),
                        'part_no': row.get('part_no'),
                        'planned_qty': row.get('planned_qty'),
                    }})
        return Response({
            'business_date': payload.get('business_date'),
            'reports': reports,
        })


class MachiningManualReportConfirmMatchView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, manual_report_id, *args, **kwargs):
        if not user_can_edit_plan(request.user, 'machining'):
            raise PermissionDenied('You do not have permission to edit machining reports.')
        try:
            report = confirm_manual_report_match(
                manual_report_id=manual_report_id,
                mes_report_record_ids=[int(value) for value in request.data.get('mes_report_record_ids') or []],
                matched_qty=int(request.data.get('matched_qty') or 0),
                user=request.user,
                note=(request.data.get('note') or '').strip(),
            )
        except (ValueError, TypeError) as exc:
            return Response({'detail': str(exc)}, status=status.HTTP_400_BAD_REQUEST)
        return Response(build_manual_report_payload(report))
