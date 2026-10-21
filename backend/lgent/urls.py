from django.urls import path
from . import views
urlpatterns=[
 path('shipments/',views.ShipmentsView.as_view()),
 path('auto-sync/',views.AutoSyncView.as_view()),
 path('workspace/',views.WorkspaceView.as_view()),path('login/',views.LoginView.as_view()),path('logout/',views.LogoutView.as_view()),
 path('settings/',views.SettingsView.as_view()),path('sync/',views.SyncView.as_view()),path('refresh/',views.RefreshView.as_view()),path('lookup/',views.LookupView.as_view()),
 path('carts/<str:trolley_id>/photo/',views.CartPhotoView.as_view()),path('photos/',views.PhotoUploadView.as_view()),
 path('photos/analyze/',views.AnalyzeView.as_view()),path('photos/verify/',views.VerifyView.as_view()),path('photos/save/',views.SaveView.as_view()),
 path('photos/<int:pk>/image/',views.PhotoImageView.as_view()),path('photos/<int:pk>/match/',views.MatchView.as_view()),
 path('photos/<int:pk>/remove/',views.RemoveView.as_view()),path('photos/<int:pk>/reconcile/',views.ReconcileView.as_view()),path('worker/photos/<int:pk>/',views.WorkerPhotoView.as_view()),
]
