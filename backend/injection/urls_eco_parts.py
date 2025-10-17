from rest_framework.routers import DefaultRouter

from .views import EcoPartSpecViewSet

router = DefaultRouter()
router.register(r'', EcoPartSpecViewSet, basename='eco-parts')

urlpatterns = router.urls
