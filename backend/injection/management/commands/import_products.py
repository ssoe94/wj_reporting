from django.core.management.base import BaseCommand, CommandError
from injection.models import Product
import pandas as pd
from pathlib import Path

class Command(BaseCommand):
    help = "엑셀 파일(models.xlsx)로부터 제품 마스터 데이터를 가져옵니다."

    def add_arguments(self, parser):
        parser.add_argument('excel_path', type=str, nargs='?', default='backend/models.xlsx', help='엑셀 파일 경로')

    def handle(self, *args, **options):
        excel_path = Path(options['excel_path'])
        if not excel_path.exists():
            raise CommandError(f"파일을 찾을 수 없습니다: {excel_path}")

        df = pd.read_excel(excel_path)
        required_cols = {'model', 'type', 'fg_part_no', 'wip_part_no'}
        if not required_cols.issubset(df.columns):
            raise CommandError(f"엑셀에 다음 열이 필요합니다: {required_cols}")

        products = []
        for _, row in df.iterrows():
            products.append(Product(
                model=str(row['model']).strip(),
                type=str(row['type']).strip(),
                fg_part_no=str(row['fg_part_no']).strip(),
                wip_part_no=str(row['wip_part_no']).strip(),
            ))

        Product.objects.all().delete()
        Product.objects.bulk_create(products)
        self.stdout.write(self.style.SUCCESS(f"{len(products)}개 제품을 저장했습니다.")) 