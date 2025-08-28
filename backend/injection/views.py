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
from rest_framework.permissions import IsAuthenticated
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

class EngineeringChangeOrderViewSet(viewsets.ModelViewSet):
    queryset = EngineeringChangeOrder.objects.all()
    serializer_class = EngineeringChangeOrderSerializer

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

class InventoryView(generics.ListAPIView):
    # Placeholder for InventoryView logic - needs actual queryset and serializer_class
    # Example:
    # queryset = InventorySnapshot.objects.all()
    # serializer_class = InventorySnapshotSerializer
    pass

class SignupRequestView(generics.CreateAPIView):
    # Placeholder for SignupRequestView logic - needs actual serializer_class
    # Example:
    # serializer_class = UserRegistrationRequestSerializer
    pass

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
