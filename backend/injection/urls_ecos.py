from rest_framework.routers import DefaultRouter

from .views import EngineeringChangeOrderViewSet

router = DefaultRouter()
router.register(r'', EngineeringChangeOrderViewSet, basename='ecos')

urlpatterns = router.urls
