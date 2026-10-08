from django.urls import path
from . import views
from .connection_views import establish_session

urlpatterns = [
    path('session/', establish_session, name='mes-oauth-session'),
    path('start/', views.start, name='mes-oauth-start'),
    path('callback/', views.callback, name='mes-oauth-callback'),
]
