from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import AllowAny
from django.utils.dateparse import parse_date
from datetime import datetime, time, timedelta
import pandas as pd
import pytz
import re

from .models import ProductionPlan
from injection.models import InjectionMonitoringRecord
from assembly.models import AssemblyReport

from django.db.models import Sum

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
        
        if not plan_data_qs.exists():
            return Response({
                "plan_date": target_date.isoformat(),
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
            'machine_name', 'lot_no', 'model_name', 'part_spec', 'part_no', 'planned_quantity'
        ))
        records_machining = list(plan_data_qs.filter(plan_type='machining').values(
            'machine_name', 'lot_no', 'model_name', 'part_spec', 'part_no', 'planned_quantity'
        ))
        for record in records_injection:
            record['planned_quantity'] = int(round(record.get('planned_quantity') or 0))
        for record in records_machining:
            record['planned_quantity'] = int(round(record.get('planned_quantity') or 0))

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
    [V4 - Handles machine name mismatch and custom sorting]
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

        # --- INJECTION LOGIC ---
        cst = pytz.timezone('Asia/Shanghai')
        start_local = cst.localize(datetime.combine(target_date, time(8, 0, 0)))
        end_local = start_local + timedelta(days=1)
        # Convert to UTC for DB filtering (USE_TZ=True)
        start_datetime = start_local.astimezone(pytz.UTC)
        end_datetime = end_local.astimezone(pytz.UTC)
        
        # 1. Fetch plans
        injection_plans_qs = ProductionPlan.objects.filter(
            plan_date=target_date,
            plan_type='injection',
            planned_quantity__gt=0,
        )
        
        # 2. Custom sort in Python
        def extract_machine_number(name: str | None) -> int | None:
            if not name:
                return None
            # Prefer explicit machine markers over tonnage.
            match = re.search(r'(\d+)\s*(?:호기)', name)
            if match:
                return int(match.group(1))
            match = re.search(r'-(\d+)\s*$', name)
            if match:
                return int(match.group(1))
            match = re.search(r'^\s*(\d+)\b', name)
            if match:
                return int(match.group(1))
            return None

        def get_sort_key(plan):
            machine_number = extract_machine_number(plan.machine_name)
            if machine_number is None:
                return (999, plan.sequence)
            return (machine_number, plan.sequence)

        sorted_plans = sorted(list(injection_plans_qs), key=get_sort_key)

        injection_results = []

        def compute_injection_actual(machine_monitor_name: str) -> float:
            """
            Compute total production within the 8:00~8:00 window by summing positive deltas.
            Falls back to the first value if no baseline exists and handles counter resets.
            """
            baseline = InjectionMonitoringRecord.objects.filter(
                machine_name=machine_monitor_name,
                capacity__isnull=False,
                timestamp__lt=start_datetime
            ).order_by('-timestamp').values_list('capacity', flat=True).first()

            records = InjectionMonitoringRecord.objects.filter(
                machine_name=machine_monitor_name,
                capacity__isnull=False,
                timestamp__gte=start_datetime,
                timestamp__lt=end_datetime
            ).order_by('timestamp').values_list('capacity', flat=True)

            prev = baseline
            total = 0.0
            for capacity in records:
                if capacity is None:
                    continue
                if prev is None:
                    delta = capacity
                else:
                    delta = capacity - prev if capacity >= prev else capacity
                if delta > 0:
                    total += delta
                prev = capacity
            return float(total)

        
        # 3. Group sorted plans by machine name
        for machine_name, plans_group in groupby(sorted_plans, key=lambda p: p.machine_name):
            plans = list(plans_group)
            
            # Map plan machine name to monitoring machine name
            machine_number = extract_machine_number(machine_name)
            if machine_number is None:
                continue
            monitoring_machine_name = f"{machine_number}호기"

            daily_production_delta = compute_injection_actual(monitoring_machine_name)
            remaining_production = daily_production_delta

            machine_parts = []
            total_planned = 0
            total_actual = 0

            # 6. Apply sequential fulfillment logic
            for plan in plans:
                planned_qty = plan.planned_quantity
                if not planned_qty or planned_qty <= 0:
                    continue
                actual_qty = 0
                
                if remaining_production > 0:
                    if remaining_production >= planned_qty:
                        actual_qty = planned_qty
                        remaining_production -= planned_qty
                    else:
                        actual_qty = remaining_production
                        remaining_production = 0
                
                progress = (actual_qty / planned_qty * 100) if planned_qty > 0 else 100 if actual_qty > 0 else 0
                
                machine_parts.append({
                    'part_no': plan.part_no,
                    'model_name': plan.model_name,
                    'planned_quantity': planned_qty,
                    'actual_quantity': actual_qty,
                    'progress': round(progress, 1)
                })
                total_planned += planned_qty
                total_actual += actual_qty

            total_progress = (total_actual / total_planned * 100) if total_planned > 0 else 0
            
            injection_results.append({
                'machine_name': machine_name,
                'total_planned': total_planned,
                'total_actual': total_actual,
                'progress': round(total_progress, 1),
                'parts': machine_parts
            })

        # --- MACHINING LOGIC ---
        machining_plans = ProductionPlan.objects.filter(
            plan_date=target_date,
            plan_type='machining',
            planned_quantity__gt=0,
        )
        assembly_reports = AssemblyReport.objects.filter(date=target_date)
        
        machining_results = []
        if machining_plans.exists():
            plan_df = pd.DataFrame(list(machining_plans.values('machine_name', 'part_no', 'model_name', 'planned_quantity')))
            
            if assembly_reports.exists():
                actual_df = pd.DataFrame(list(assembly_reports.values('line_no', 'part_no', 'actual_qty')))
                actual_df.rename(columns={'line_no': 'machine_name', 'actual_qty': 'actual_quantity'}, inplace=True)
                actual_summary = actual_df.groupby(['machine_name', 'part_no'])['actual_quantity'].sum().reset_index()
                merged_df = pd.merge(plan_df, actual_summary, on=['machine_name', 'part_no'], how='left')
            else:
                merged_df = plan_df
                merged_df['actual_quantity'] = 0

            merged_df['actual_quantity'] = merged_df['actual_quantity'].fillna(0)
            
            # Group by machine to create structural response
            for machine_name, machine_df in merged_df.groupby('machine_name'):
                machine_parts = []
                total_planned = 0
                total_actual = 0
                
                for _, row in machine_df.iterrows():
                    planned_qty = row['planned_quantity']
                    if not planned_qty or planned_qty <= 0:
                        continue
                    actual_qty = row['actual_quantity']
                    progress = (actual_qty / planned_qty * 100) if planned_qty > 0 else 100 if actual_qty > 0 else 0
                    
                    machine_parts.append({
                        'part_no': row['part_no'],
                        'model_name': row.get('model_name', ''),
                        'planned_quantity': int(planned_qty),
                        'actual_quantity': int(actual_qty),
                        'progress': round(progress, 1)
                    })
                    total_planned += planned_qty
                    total_actual += actual_qty
                
                total_progress = (total_actual / total_planned * 100) if total_planned > 0 else 0
                
                machining_results.append({
                    'machine_name': machine_name,
                    'total_planned': int(total_planned),
                    'total_actual': int(total_actual),
                    'progress': round(total_progress, 1),
                    'parts': machine_parts
                })

        return Response({
            'injection': injection_results,
            'machining': machining_results
        })

        return Response({
            'injection': injection_results,
            'machining': machining_results
        })

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
