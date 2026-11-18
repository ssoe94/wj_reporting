from datetime import date
from unittest.mock import patch

from django.db import connection
from django.test import TestCase
from django.test.utils import CaptureQueriesContext
from rest_framework.permissions import AllowAny
from rest_framework.test import APIRequestFactory

from .models import PartSpec
from .views import PartSpecViewSet


class PartSearchLoadingTests(TestCase):
    def test_page_loading_does_not_scale_with_matching_rows(self):
        view = PartSpecViewSet.as_view({'get': 'list'}, permission_classes=[AllowAny])
        factory = APIRequestFactory()

        for first, total in ((0, 300), (300, 3000)):
            with self.subTest(total=total):
                PartSpec.objects.bulk_create([
                    PartSpec(
                        part_no=f'SYNTHETIC-PART-{index:04d}',
                        model_code='SYNTHETIC-MODEL',
                        valid_from=date(2026, 11, 1),
                    )
                    for index in range(first, total)
                ])
                request = factory.get('/api/injection/parts/', {'page': 2, 'page_size': 20})
                with (
                    patch.object(PartSpec, 'from_db', wraps=PartSpec.from_db) as hydrate,
                    CaptureQueriesContext(connection) as queries,
                ):
                    response = view(request)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.data['count'], total)
                self.assertEqual(len(response.data['results']), 20)
                self.assertEqual(response.data['results'][0]['part_no'], 'SYNTHETIC-PART-0020')
                self.assertEqual(len(queries), 2)
                self.assertEqual(hydrate.call_count, 20)
