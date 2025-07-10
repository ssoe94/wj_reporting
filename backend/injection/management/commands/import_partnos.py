from django.core.management.base import BaseCommand, CommandError
from injection.models import PartSpec
import pandas as pd
from pathlib import Path
from datetime import date

class Command(BaseCommand):
    help = "backend/data/partnos.xlsx 파일에서 Part 번호와 설명을 가져와 PartSpec에 저장합니다.\n\n필터 조건\n  * 物料状态 == '启用'\n  * 物料规格(Description) 공란 제외"

    def add_arguments(self, parser):
        parser.add_argument(
            "excel_path",
            type=str,
            nargs="?",
            default="backend/data/partnos.xlsx",
            help="엑셀 파일 경로 (기본: backend/data/partnos.xlsx)",
        )

    def handle(self, *args, **options):
        excel_path = Path(options["excel_path"])
        if not excel_path.exists():
            raise CommandError(f"파일을 찾을 수 없습니다: {excel_path}")

        try:
            df = pd.read_excel(excel_path)
        except Exception as e:
            raise CommandError(f"엑셀 로드 실패: {e}")

        # 열 이름 normalize
        df = df.rename(columns=lambda c: str(c).strip())
        if "物料编号" not in df.columns:
            raise CommandError("엑셀에 '物料编号' 열이 없습니다.")
        if "物料状态" not in df.columns:
            raise CommandError("엑셀에 '物料状态' 열이 없습니다.")
        if "物料规格" not in df.columns:
            raise CommandError("엑셀에 '物料规格' 열이 없습니다.")

        filtered = (
            df[df["物料状态"].astype(str).str.strip() == "启用"]
            .copy()
        )
        # description 공란 제거
        filtered["物料规格"] = filtered["物料规格"].astype(str).str.strip()
        filtered = filtered[filtered["物料规格"] != ""]
        filtered = filtered.drop_duplicates(subset=["物料编号"])

        if filtered.empty:
            self.stdout.write(self.style.WARNING("조건에 맞는 데이터가 없습니다."))
            return

        today = date.today()
        objs = []
        for _, row in filtered.iterrows():
            part_no = str(row["物料编号"]).strip()
            desc = str(row["物料规格"]).strip()
            objs.append(
                PartSpec(
                    part_no=part_no,
                    description=desc,
                    model_code="",  # 알 수 없으므로 빈값
                    valid_from=today,
                )
            )

        # 기존 동일 part_no & valid_from(today) 삭제 후 재적재
        PartSpec.objects.filter(part_no__in=[o.part_no for o in objs], valid_from=today).delete()
        PartSpec.objects.bulk_create(objs)
        self.stdout.write(self.style.SUCCESS(f"{len(objs)}개 PartSpec 저장 완료")) 