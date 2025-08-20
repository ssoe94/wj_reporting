from django.urls import path
from . import views

app_name = 'machining'

urlpatterns = [
    path('', views.index, name='index'),
] 