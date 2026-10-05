from django.urls import path
from . import views

urlpatterns = [
    path('start/', views.start, name='mes-oauth-start'),
    path('callback/', views.callback, name='mes-oauth-callback'),
]
