from django.core.management.base import BaseCommand, CommandError
from injection.models import PartSpec
import pandas as pd
from pathlib import Path

COL_MAP = {
    'Model': 'model_code',
    'P/N': 'part_no',
    'start date': 'valid_from',
    'Desc': 'description',
    'Mold Type': 'mold_type',
    'Color': 'color',
    'Resin(1)': 'resin_type',
    'Resin(2)': 'resin_code',
    'Net(g)': 'net_weight_g',
    'S/R(g)': 'sr_weight_g',
    'Ton': 'tonnage',
    'C/T': 'cycle_time_sec',
    '효율': 'efficiency_rate',
    'Cavity': 'cavity',
    'ResinLoss(%)': 'resin_loss_pct',
    'Defect(%)': 'defect_rate_pct',
}

SHEETS = ['MNT_modi', 'MNT_modi_2207']

class Command(BaseCommand):
    help = "c_table.xlsx 파일을 PartSpec 테이블로 불러옵니다."

    def add_arguments(self, parser):
        parser.add_argument('excel_path', type=str, nargs='?', default='backend/data/c_table.xlsx', help='엑셀 파일 경로')

    def handle(self, *args, **options):
        excel_path = Path(options['excel_path'])
        if not excel_path.exists():
            raise CommandError(f"파일이 존재하지 않습니다: {excel_path}")

        frames = []
        for sheet in SHEETS:
            try:
                df = pd.read_excel(excel_path, sheet_name=sheet)
            except ValueError:
                self.stderr.write(f"시트 {sheet} 를 찾을 수 없습니다. 스킵합니다.")
                continue
            df = df.rename(columns=lambda c: COL_MAP.get(str(c).strip(), str(c).strip()))
            # self.stdout.write is 디버깅용. 필요 시 주석 해제
            df = df[[col for col in COL_MAP.values() if col in df.columns]]

            # 데이터 타입 변환
            if 'valid_from' in df.columns:
                df['valid_from'] = pd.to_datetime(df['valid_from'], errors='coerce')

            # 모델 코드 공백 제거 및 대문자 통일
            if 'model_code' in df.columns:
                df['model_code'] = (
                    df['model_code']
                    .astype(str)
                    .str.replace(r"\s+", "", regex=True)
                    .str.upper()
                )
            numeric_cols = [
                'net_weight_g', 'sr_weight_g', 'tonnage', 'cycle_time_sec',
                'efficiency_rate', 'cavity', 'resin_loss_pct', 'defect_rate_pct'
            ]
            for col in numeric_cols:
                if col in df.columns:
                    df[col] = pd.to_numeric(df[col], errors='coerce')
            frames.append(df)

        if not frames:
            raise CommandError('적재할 데이터가 없습니다.')

        merged = pd.concat(frames, ignore_index=True)
        merged = merged.dropna(subset=['part_no']).fillna({})

        # 기존 데이터 삭제 후 재적재
        PartSpec.objects.all().delete()
        objs = [PartSpec(**row.dropna().to_dict()) for _, row in merged.iterrows()]
        PartSpec.objects.bulk_create(objs)
        self.stdout.write(self.style.SUCCESS(f"{len(objs)}개 PartSpec 저장 완료")) 