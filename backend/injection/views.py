from rest_framework import viewsets, generics, status
from rest_framework.response import Response
from rest_framework.decorators import action
from django.db import models as django_models
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
    InventorySnapshotSerializer, EcoDetailSerializer, UserSerializer
)

# For User related views
from rest_framework.permissions import IsAuthenticated, AllowAny
from rest_framework_simplejwt.views import TokenObtainPairView
from rest_framework_simplejwt.tokens import RefreshToken
from django.contrib.auth.hashers import make_password
from django.db import transaction
from django.utils import timezone
from datetime import timedelta

User = get_user_model()

class InjectionReportViewSet(viewsets.ModelViewSet):
    queryset = InjectionReport.objects.all()
    serializer_class = InjectionReportSerializer

class ProductViewSet(viewsets.ModelViewSet):
    queryset = Product.objects.all()
    serializer_class = ProductSerializer

class PartSpecViewSet(viewsets.ModelViewSet):
    queryset = PartSpec.objects.all()
    serializer_class = PartSpecSerializer

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

class ChangePasswordView(generics.UpdateAPIView):
    # Placeholder for ChangePasswordView logic - needs actual serializer_class
    # Example:
    # serializer_class = ChangePasswordSerializer
    permission_classes = [IsAuthenticated]
    def get_object(self):
        return self.request.user

class ResetPasswordView(generics.CreateAPIView):
    # Placeholder for ResetPasswordView logic - needs actual serializer_class
    # Example:
    # serializer_class = ResetPasswordSerializer
    pass
