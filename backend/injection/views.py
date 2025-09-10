from rest_framework import viewsets, generics, status
from rest_framework.response import Response
from rest_framework.decorators import action
from django.db import models as django_models
from django.db.models import Q
from django.contrib.auth import get_user_model
from django.shortcuts import get_object_or_404

# Import actual models
from .models import (
    InjectionReport, Product, PartSpec, EcoPartSpec, EngineeringChangeOrder,
    UserRegistrationRequest, UserProfile, EcoDetail, InventorySnapshot
)

# Import actual serializers
from .serializers import (
    InjectionReportSerializer, ProductSerializer, PartSpecSerializer,
    EcoPartSpecSerializer, EngineeringChangeOrderSerializer,
    UserRegistrationRequestSerializer, UserProfileSerializer,
    InventorySnapshotSerializer, EcoDetailSerializer, UserSerializer, ChangePasswordSerializer
)

# For User related views
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework_simplejwt.views import TokenObtainPairView
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone
import secrets, string
from datetime import timedelta

User = get_user_model()

class InjectionReportViewSet(viewsets.ModelViewSet):
    queryset = InjectionReport.objects.all()
    serializer_class = InjectionReportSerializer

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """사출 보고서 요약 통계"""
        qs = self.get_queryset()
        date_str = request.query_params.get('date')
        if date_str:
            qs = qs.filter(date=date_str)

        total_count = qs.count()
        total_plan_qty = sum(r.plan_qty for r in qs)
        total_actual_qty = sum(r.actual_qty for r in qs)
        total_defect_qty = sum(r.actual_defect for r in qs)

        achievement_rate = round((total_actual_qty / total_plan_qty) * 100, 1) if total_plan_qty else 0

        total_production = total_actual_qty + total_defect_qty
        defect_rate = round((total_defect_qty / total_production) * 100, 1) if total_production else 0

        return Response({
            'total_count': total_count,
            'total_plan_qty': total_plan_qty,
            'total_actual_qty': total_actual_qty,
            'total_defect_qty': total_defect_qty,
            'achievement_rate': achievement_rate,
            'defect_rate': defect_rate,
        })

class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()
    serializer_class = ProductSerializer

class PartSpecViewSet(viewsets.ModelViewSet):
    queryset = PartSpec.objects.all()
    serializer_class = PartSpecSerializer
    # 검색/필터 활성화: 모델코드 기반 추천 및 키워드 검색 지원
    search_fields = ['part_no', 'description', 'model_code']
    filterset_fields = ['model_code', 'part_no', 'description']
    
    def list(self, request, *args, **kwargs):
        """Models 데이터 + MES 데이터 통합 검색"""
        search = request.query_params.get('search', '').strip()
        model_code = request.query_params.get('model_code', '').strip()
        page_size = int(request.query_params.get('page_size', 20))
        page = int(request.query_params.get('page', 1))
        
        # 1. Models 데이터 (PartSpec) 검색 - 우선순위 높음
        models_queryset = self.get_queryset()
        if search:
            models_queryset = models_queryset.filter(
                Q(part_no__icontains=search) |
                Q(model_code__icontains=search) |
                Q(description__icontains=search)
            )
        if model_code:
            models_queryset = models_queryset.filter(model_code__icontains=model_code)
        
        models_data = []
        for part in models_queryset:
            models_data.append({
                'id': part.id,
                'part_no': part.part_no,
                'model_code': part.model_code,
                'description': part.description or '',
                'mold_type': part.mold_type or '',
                'color': part.color or '',
                'resin_type': part.resin_type or '',
                'resin_code': part.resin_code or '',
                'net_weight_g': str(part.net_weight_g) if part.net_weight_g else '',
                'sr_weight_g': str(part.sr_weight_g) if part.sr_weight_g else '',
                'tonnage': part.tonnage,
                'cycle_time_sec': part.cycle_time_sec,
                'efficiency_rate': str(part.efficiency_rate) if part.efficiency_rate else '',
                'cavity': part.cavity,
                'resin_loss_pct': str(part.resin_loss_pct) if part.resin_loss_pct else '',
                'defect_rate_pct': str(part.defect_rate_pct) if part.defect_rate_pct else '',
                'valid_from': part.valid_from.strftime('%Y-%m-%d') if part.valid_from else '',
                'created_at': part.created_at.isoformat() if part.created_at else '',
                'source': 'models'  # 데이터 출처 표시
            })
        
        # 2. MES 데이터 (AssemblyPartSpec + Production Reports) 검색
        mes_data = []
        if search or model_code:
            try:
                from assembly.models import AssemblyPartSpec, AssemblyReport
                
                # AssemblyPartSpec에서 검색
                assembly_filter = Q()
                if search:
                    assembly_filter |= (
                        Q(part_no__icontains=search) |
                        Q(model_code__icontains=search) |
                        Q(description__icontains=search)
                    )
                if model_code:
                    assembly_filter &= Q(model_code__icontains=model_code)
                
                assembly_parts = AssemblyPartSpec.objects.filter(assembly_filter)[:20] if assembly_filter.children else []
                
                for part in assembly_parts:
                    # Models에 이미 없는 것만 추가 (중복 방지)
                    if not any(m['part_no'] == part.part_no for m in models_data):
                        mes_data.append({
                            'id': f"assembly_{part.id}",
                            'part_no': part.part_no,
                            'model_code': part.model_code,
                            'description': part.description or '',
                            'process_type': part.process_type or '',
                            'material_type': part.material_type or '',
                            'standard_cycle_time': part.standard_cycle_time,
                            'standard_worker_count': part.standard_worker_count,
                            'valid_from': part.valid_from.strftime('%Y-%m-%d') if part.valid_from else '',
                            'source': 'mes_assembly'
                        })
                
                # AssemblyReport (생산 기록)에서도 검색
                report_filter = Q()
                if search:
                    report_filter |= (
                        Q(part_no__icontains=search) |
                        Q(model__icontains=search)
                    )
                if model_code:
                    report_filter &= Q(model__icontains=model_code)
                
                assembly_reports = AssemblyReport.objects.filter(report_filter).values('part_no', 'model').distinct()[:20] if report_filter.children else []
                
                for report in assembly_reports:
                    part_no = report['part_no']
                    model = report['model']
                    # 이미 추가되지 않은 것만 추가
                    if (not any(m['part_no'] == part_no for m in models_data) and
                        not any(m['part_no'] == part_no for m in mes_data)):
                        mes_data.append({
                            'id': f"report_assembly_{part_no}",
                            'part_no': part_no,
                            'model_code': model,
                            'description': '',
                            'source': 'mes_report_assembly'
                        })
                
                # InjectionReport (사출 생산 기록)에서도 검색
                injection_filter = Q()
                if search:
                    injection_filter |= (
                        Q(part_no__icontains=search) |
                        Q(model__icontains=search)
                    )
                if model_code:
                    injection_filter &= Q(model__icontains=model_code)
                
                injection_reports = InjectionReport.objects.filter(injection_filter).values('part_no', 'model', 'type').distinct()[:20] if injection_filter.children else []
                
                for report in injection_reports:
                    part_no = report['part_no']
                    model = report['model']
                    description = report['type'] or ''
                    # 이미 추가되지 않은 것만 추가
                    if (not any(m['part_no'] == part_no for m in models_data) and
                        not any(m['part_no'] == part_no for m in mes_data)):
                        mes_data.append({
                            'id': f"report_injection_{part_no}",
                            'part_no': part_no,
                            'model_code': model,
                            'description': description,
                            'source': 'mes_report_injection'
                        })
                        
            except Exception as e:
                # MES 데이터 조회 실패시 Models 데이터만 반환
                pass
        
        # 3. 결과 통합 (Models 우선, MES 보완)
        all_results = models_data + mes_data
        
        # 4. 페이지네이션
        total_count = len(all_results)
        start_idx = (page - 1) * page_size
        end_idx = start_idx + page_size
        page_results = all_results[start_idx:end_idx]
        
        # 5. 페이지네이션 응답 형식으로 반환
        return Response({
            'count': total_count,
            'next': f"?page={page + 1}&search={search}&page_size={page_size}" if end_idx < total_count else None,
            'previous': f"?page={page - 1}&search={search}&page_size={page_size}" if page > 1 else None,
            'results': page_results
        })

class EcoPartSpecViewSet(viewsets.ModelViewSet):
    queryset = EcoPartSpec.objects.all()
    serializer_class = EcoPartSpecSerializer
    # 검색: part_no, description, model_code
    search_fields = ['part_no', 'description', 'model_code']

    @action(detail=False, methods=['post'], url_path='create-or-update')
    def create_or_update(self, request):
        """part_no 기준으로 EcoPartSpec 생성 또는 업데이트"""
        part_no = (request.data.get('part_no') or '').strip()
        if not part_no:
            return Response({'part_no': 'required'}, status=status.HTTP_400_BAD_REQUEST)

        description = request.data.get('description', '')
        model_code = request.data.get('model_code', '')
        eco_category = request.data.get('eco_category', '')
        change_history = request.data.get('change_history', '')

        obj, created = EcoPartSpec.objects.get_or_create(
            part_no=part_no,
            defaults={
                'description': description,
                'model_code': model_code,
                'eco_category': eco_category,
                'change_history': change_history,
            }
        )

        if not created:
            # 전달된 값이 있으면 갱신
            updated = False
            if description != '':
                obj.description = description; updated = True
            if model_code != '':
                obj.model_code = model_code; updated = True
            if eco_category != '':
                obj.eco_category = eco_category; updated = True
            if change_history != '':
                obj.change_history = change_history; updated = True
            if updated:
                obj.save()

        serializer = self.get_serializer(obj)
        return Response(serializer.data)

class EngineeringChangeOrderViewSet(viewsets.ModelViewSet):
    queryset = EngineeringChangeOrder.objects.all()
    serializer_class = EngineeringChangeOrderSerializer

    @action(detail=True, methods=['post'], url_path='details/bulk')
    def bulk_details(self, request, pk=None):
        """
        주어진 ECO 헤더의 상세 목록을 일괄 저장(업서트)하고,
        요청에 포함되지 않은 기존 상세는 삭제합니다.

        payload: { details: [{ eco_part_spec, change_details, status }, ...] }
        """
        header = self.get_object()
        details = request.data.get('details', [])
        if not isinstance(details, list):
            return Response({'details': 'must be a list'}, status=status.HTTP_400_BAD_REQUEST)

        desired_ids = []
        # 유효성 검사 선행
        for idx, item in enumerate(details):
            eco_part_spec_id = item.get('eco_part_spec')
            if not eco_part_spec_id:
                return Response({f'details[{idx}].eco_part_spec': 'required'}, status=status.HTTP_400_BAD_REQUEST)
            desired_ids.append(eco_part_spec_id)

        with transaction.atomic():
            # 제거: 요청에 없는 상세 삭제
            EcoDetail.objects.filter(eco_header=header).exclude(eco_part_spec_id__in=desired_ids).delete()

            # 업서트 처리
            for item in details:
                eco_part_spec_id = item.get('eco_part_spec')
                change_details = item.get('change_details', '')
                status_val = item.get('status', 'OPEN')

                EcoDetail.objects.update_or_create(
                    eco_header=header,
                    eco_part_spec_id=eco_part_spec_id,
                    defaults={
                        'change_details': change_details,
                        'status': status_val,
                    }
                )

            # 상세 상태를 기반으로 헤더 상태 자동 갱신
            total_cnt = EcoDetail.objects.filter(eco_header=header).count()
            closed_cnt = EcoDetail.objects.filter(eco_header=header, status='CLOSED').count()
            open_cnt = EcoDetail.objects.filter(eco_header=header, status='OPEN').count()

            if total_cnt > 0 and closed_cnt == total_cnt:
                new_status = 'CLOSED'
            elif 0 < closed_cnt < total_cnt:
                new_status = 'WIP'
            else:
                # 모든 상세가 OPEN 이거나 상세가 없는 경우
                new_status = 'OPEN'

            if header.status != new_status:
                header.status = new_status
                # 완료 시점에 close_date 자동 세팅 (이미 값이 있으면 유지)
                if new_status == 'CLOSED' and not header.close_date:
                    header.close_date = timezone.now().date()
                # 다시 열리면 close_date 는 유지 (업무 규칙에 따라 None 처리하려면 아래 주석 해제)
                # elif new_status != 'CLOSED':
                #     header.close_date = None
                header.save(update_fields=['status', 'close_date'])

        # 최신 데이터 반환
        qs = EcoDetail.objects.filter(eco_header=header).select_related('eco_part_spec')
        serializer = EcoDetailSerializer(qs, many=True)
        return Response({'details': serializer.data})

    @action(detail=False, methods=['get'], url_path='unified-search')
    def unified_search(self, request):
        """
        ECO 번호, Part No., 모델 코드를 통합하여 검색
        ?keyword=검색어&type=검색타입(eco|part|model|all)
        ?part_numbers=part1,part2&type=part (for multiple part numbers)
        """
        keyword = request.query_params.get('keyword', '').strip()
        part_numbers_str = request.query_params.get('part_numbers', '')
        search_type = request.query_params.get('type', 'all')
        
        queryset = self.get_queryset()
        
        if search_type == 'part' and part_numbers_str:
            part_numbers = [p.strip() for p in part_numbers_str.split(',') if p.strip()]
            if part_numbers:
                queryset = queryset.filter(details__eco_part_spec__part_no__in=part_numbers).distinct()
            else:
                queryset = queryset.none()
        elif keyword:
            if search_type == 'eco':
                queryset = queryset.filter(eco_no__icontains=keyword)
            elif search_type == 'part':
                queryset = queryset.filter(details__eco_part_spec__part_no__icontains=keyword).distinct()
            elif search_type == 'model':
                queryset = queryset.filter(
                    django_models.Q(eco_model__icontains=keyword) |
                    django_models.Q(details__eco_part_spec__model_code__icontains=keyword)
                ).distinct()
            else:
                queryset = queryset.filter(
                    django_models.Q(eco_no__icontains=keyword) |
                    django_models.Q(details__eco_part_spec__part_no__icontains=keyword) |
                    django_models.Q(eco_model__icontains=keyword) |
                    django_models.Q(details__eco_part_spec__model_code__icontains=keyword)
                ).distinct()
        
        queryset = queryset.order_by('-prepared_date')
        
        page = self.paginate_queryset(queryset)
        if page is not None:
            serializer = self.get_serializer(page, many=True)
            return self.get_paginated_response(serializer.data)
        
        serializer = self.get_serializer(queryset, many=True)
        return Response(serializer.data)


class UserRegistrationRequestViewSet(viewsets.ModelViewSet):
    queryset = UserRegistrationRequest.objects.all()
    serializer_class = UserRegistrationRequestSerializer

    @action(detail=True, methods=['post'], url_path='approve', permission_classes=[IsAuthenticated])
    def approve(self, request, pk=None):
        if not request.user.is_staff:
            return Response({'detail': '관리자 권한이 필요합니다.'}, status=status.HTTP_403_FORBIDDEN)

        signup_req = self.get_object()
        if signup_req.status != 'pending':
            return Response({'detail': '이미 처리된 요청입니다.'}, status=status.HTTP_400_BAD_REQUEST)

        # 권한 페이로드 파싱
        perms = (request.data or {}).get('permissions', {})
        default_bool = lambda k: bool(perms.get(k, False))

        # 사용자 생성 또는 업데이트
        username_base = signup_req.email.split('@')[0]
        username = username_base
        # 동일 사용자명 충돌 회피
        i = 1
        while User.objects.filter(username=username).exclude(email=signup_req.email).exists():
            username = f"{username_base}{i}"
            i += 1

        # 안전한 랜덤 임시 비밀번호 생성 (영문 대/소문자+숫자, 최소 각 1자 포함)
        def generate_temp_password(length: int = 12) -> str:
            alphabet = string.ascii_letters + string.digits
            while True:
                pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
                if any(c.islower() for c in pwd) and any(c.isupper() for c in pwd) and any(c.isdigit() for c in pwd):
                    return pwd

        temp_password = generate_temp_password(12)

        user, created = User.objects.get_or_create(
            email=signup_req.email,
            defaults={
                'username': username,
                'first_name': signup_req.full_name,
                'password': make_password(temp_password),
            }
        )

        if not created:
            # 기존 사용자 비밀번호를 임시로 재설정
            user.username = user.username or username
            user.first_name = user.first_name or signup_req.full_name
            user.password = make_password(temp_password)
            user.save(update_fields=['username', 'first_name', 'password'])

        # 프로필 권한 적용
        profile = UserProfile.get_user_permissions(user)
        profile.can_view_injection = default_bool('can_view_injection')
        profile.can_edit_injection = default_bool('can_edit_injection')
        profile.can_view_machining = default_bool('can_view_machining')
        profile.can_edit_machining = default_bool('can_edit_machining')
        profile.can_view_eco = default_bool('can_view_eco')
        profile.can_edit_eco = default_bool('can_edit_eco')
        profile.can_view_inventory = default_bool('can_view_inventory')
        profile.can_edit_inventory = default_bool('can_edit_inventory')
        profile.is_using_temp_password = True
        profile.password_reset_required = True
        profile.save()

        signup_req.status = 'approved'
        signup_req.approved_by = request.user
        signup_req.approved_at = timezone.now()
        signup_req.temporary_password = temp_password
        signup_req.save(update_fields=['status', 'approved_by', 'approved_at', 'temporary_password'])

        return Response({
            'username': user.username,
            'temporary_password': temp_password,
        })

    @action(detail=True, methods=['post'], url_path='reject', permission_classes=[IsAuthenticated])
    def reject(self, request, pk=None):
        if not request.user.is_staff:
            return Response({'detail': '관리자 권한이 필요합니다.'}, status=status.HTTP_403_FORBIDDEN)

        signup_req = self.get_object()
        if signup_req.status != 'pending':
            return Response({'detail': '이미 처리된 요청입니다.'}, status=status.HTTP_400_BAD_REQUEST)

        signup_req.status = 'rejected'
        signup_req.approved_by = request.user
        signup_req.approved_at = timezone.now()
        signup_req.save(update_fields=['status', 'approved_by', 'approved_at'])

        return Response({'detail': '요청이 거부되었습니다.'})

class UserProfileViewSet(viewsets.ModelViewSet):
    queryset = UserProfile.objects.all()
    serializer_class = UserProfileSerializer

class InventoryView(generics.GenericAPIView):
    """
    간단 재고 조회 API
    입력: ?part_ids=1&part_ids=2 ... (PartSpec ID 목록)
    출력: { "1": 수량, "2": 수량 }
    가장 최근 스냅샷(Injection.InventorySnapshot 기준)을 사용합니다.
    """
    def get(self, request):
        part_ids = request.query_params.getlist('part_ids')
        try:
            part_ids_int = [int(x) for x in part_ids if str(x).strip()]
        except ValueError:
            return Response({'part_ids': 'must be integers'}, status=status.HTTP_400_BAD_REQUEST)

        result: dict[int, float] = {}
        if not part_ids_int:
            return Response(result)

        # 각 PartSpec에 대해 최신 스냅샷의 qty 반환
        for pid in part_ids_int:
            snap = InventorySnapshot.objects.filter(part_spec_id=pid).order_by('-collected_at').first()
            result[pid] = float(getattr(snap, 'qty', 0) or 0)

        return Response(result)

class SignupRequestView(generics.CreateAPIView):
    serializer_class = UserRegistrationRequestSerializer
    permission_classes = [AllowAny]

    def create(self, request, *args, **kwargs):
        # only accept required fields; ignore unknowns
        data = {
            'full_name': request.data.get('full_name', '').strip(),
            'department': request.data.get('department', '').strip(),
            'email': request.data.get('email', '').strip(),
            'reason': request.data.get('reason', ''),
        }
        serializer = self.get_serializer(data=data)
        serializer.is_valid(raise_exception=True)
        self.perform_create(serializer)
        headers = self.get_success_headers(serializer.data)
        return Response(serializer.data, status=status.HTTP_201_CREATED, headers=headers)

class UserMeView(generics.RetrieveAPIView):
    # Placeholder for UserMeView logic - needs actual queryset and serializer_class
    # Example:
    # queryset = User.objects.all()
    serializer_class = UserSerializer # Set the serializer class
    permission_classes = [IsAuthenticated]
    def get_object(self):
        return self.request.user

class ChangePasswordView(generics.GenericAPIView):
    permission_classes = [IsAuthenticated]
    serializer_class = ChangePasswordSerializer

    def post(self, request, *args, **kwargs):
        serializer = self.get_serializer(data=request.data, context={'request': request})
        serializer.is_valid(raise_exception=True)
        user = request.user
        new_password = serializer.validated_data['new_password']
        user.set_password(new_password)
        user.save()

        # 프로필 플래그 해제
        try:
            profile = user.profile
            profile.is_using_temp_password = False
            profile.password_reset_required = False
            profile.last_password_change = timezone.now()
            profile.save(update_fields=['is_using_temp_password', 'password_reset_required', 'last_password_change'])
        except Exception:
            pass

        return Response({'detail': '비밀번호가 변경되었습니다.'})

class ResetPasswordView(generics.CreateAPIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, *args, **kwargs):
        if not request.user.is_staff:
            return Response({'detail': '관리자 권한이 필요합니다.'}, status=status.HTTP_403_FORBIDDEN)

        user_id = request.data.get('user_id')
        if not user_id:
            return Response({'user_id': 'required'}, status=status.HTTP_400_BAD_REQUEST)
        try:
            user_id = int(user_id)
        except (TypeError, ValueError):
            return Response({'user_id': 'must be an integer'}, status=status.HTTP_400_BAD_REQUEST)

        try:
            target = User.objects.get(id=user_id)
        except User.DoesNotExist:
            return Response({'detail': '사용자를 찾을 수 없습니다.'}, status=status.HTTP_404_NOT_FOUND)

        # 안전한 랜덤 임시 비밀번호 생성
        def generate_temp_password(length: int = 12) -> str:
            alphabet = string.ascii_letters + string.digits
            while True:
                pwd = ''.join(secrets.choice(alphabet) for _ in range(length))
                if any(c.islower() for c in pwd) and any(c.isupper() for c in pwd) and any(c.isdigit() for c in pwd):
                    return pwd

        temp_password = generate_temp_password(12)
        target.set_password(temp_password)
        target.save()

        # 사용자 프로필 플래그 설정
        try:
            profile = UserProfile.get_user_permissions(target)
            profile.is_using_temp_password = True
            profile.password_reset_required = True
            profile.save(update_fields=['is_using_temp_password', 'password_reset_required'])
        except Exception:
            pass

        return Response({'username': target.username, 'temporary_password': temp_password})
