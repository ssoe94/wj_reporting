from django.urls import path
from .connection_views import (ConnectionStatus, ConnectionLaunch, ConnectionDisconnect,
                               ConnectionLogout, ConnectionRecheck)

urlpatterns = [
    path('', ConnectionStatus.as_view(), name='mes-connection-status'),
    path('launch/', ConnectionLaunch.as_view(), name='mes-connection-launch'),
    path('disconnect/', ConnectionDisconnect.as_view(), name='mes-connection-disconnect'),
    path('logout/', ConnectionLogout.as_view(), name='mes-connection-logout'),
    path('recheck/', ConnectionRecheck.as_view(), name='mes-connection-recheck'),
]
