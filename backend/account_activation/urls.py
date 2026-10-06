from django.urls import path
from . import views

urlpatterns = [path('', views.activate, name='account-activation')]
for name in ('activate.js', 'issue.js', 'activation.css'):
    urlpatterns.append(path('assets/' + name, views.asset, {'name': name}, name='activation-' + name))
