from django.urls import path
from . import inspection_oauth_views as views

urlpatterns = [
    path('start/', views.start, name='inspection-oauth-start'),
    path('callback/', views.callback, name='inspection-oauth-callback'),
]
