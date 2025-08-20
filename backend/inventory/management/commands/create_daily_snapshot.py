from django.core.management.base import BaseCommand
from django.utils import timezone
from django.db import transaction
from inventory.models import StagingInventory, DailyInventorySnapshot, DailyReportSummary
from collections import defaultdict
from datetime import timedelta
import logging

logger = logging.getLogger(__name__)


class Command(BaseCommand):
    help = '매일 오전 8시 기준 재고 스냅샷 생성'

    def add_arguments(self, parser):
        parser.add_argument(
            '--date',
            type=str,
            help='스냅샷을 생성할 날짜 (YYYY-MM-DD 형식, 기본값: 오늘)',
        )
        parser.add_argument(
            '--force',
            action='store_true',
            help='이미 존재하는 스냅샷을 덮어쓰기',
        )

    def handle(self, *args, **options):
        # 날짜 결정
        if options['date']:
            try:
                snapshot_date = timezone.datetime.strptime(options['date'], '%Y-%m-%d').date()
            except ValueError:
                self.stdout.write(
                    self.style.ERROR('잘못된 날짜 형식입니다. YYYY-MM-DD 형식을 사용하세요.')
                )
                return
        else:
            snapshot_date = timezone.now().date()

        # 이미 스냅샷이 존재하는지 확인
        existing_count = DailyInventorySnapshot.objects.filter(snapshot_date=snapshot_date).count()
        if existing_count > 0 and not options['force']:
            self.stdout.write(
                self.style.WARNING(
                    f'{snapshot_date} 날짜의 스냅샷이 이미 존재합니다 ({existing_count}개). '
                    '덮어쓰려면 --force 옵션을 사용하세요.'
                )
            )
            return

        # 기존 스냅샷 삭제 (force 옵션이 있는 경우)
        if options['force'] and existing_count > 0:
            DailyInventorySnapshot.objects.filter(snapshot_date=snapshot_date).delete()
            self.stdout.write(f'{snapshot_date} 날짜의 기존 스냅샷 {existing_count}개를 삭제했습니다.')

        # 현재 재고 데이터 조회 (StagingInventory 사용)
        current_inventory = StagingInventory.objects.all()
        
        # 재고 데이터를 그룹화
        inventory_groups = defaultdict(lambda: {
            'total_quantity': 0,
            'cart_count': 0,
            'cart_details': [],
            'material_name': '',
            'specification': '',
            'unit': ''
        })

        for item in current_inventory:
            # 그룹 키: material_code + warehouse_code + qc_status
            group_key = (item.material_code, item.warehouse_code, item.qc_status or '')
            
            group = inventory_groups[group_key]
            group['total_quantity'] += float(item.quantity)
            group['cart_count'] += 1
            
            # 대차 상세 정보 추가
            cart_detail = {
                'qr_code': item.qr_code,
                'label_code': item.label_code,
                'quantity': float(item.quantity),
                'location_name': item.location_name,
                'work_order_code': item.work_order_code,
                'updated_at': item.updated_at.isoformat() if item.updated_at else None
            }
            group['cart_details'].append(cart_detail)
            
            # 메타데이터 저장
            if not group['material_name']:
                group['material_name'] = item.material_name
            if not group['specification']:
                group['specification'] = item.specification
            if not group['unit']:
                group['unit'] = item.unit

        # 스냅샷 생성
        snapshots_to_create = []
        for (material_code, warehouse_code, qc_status), group_data in inventory_groups.items():
            snapshot = DailyInventorySnapshot(
                snapshot_date=snapshot_date,
                material_code=material_code,
                material_name=group_data['material_name'],
                specification=group_data['specification'],
                warehouse_code=warehouse_code,
                warehouse_name=next(
                    (item.warehouse_name for item in current_inventory 
                     if item.material_code == material_code and item.warehouse_code == warehouse_code),
                    ''
                ),
                qc_status=qc_status,
                total_quantity=group_data['total_quantity'],
                unit=group_data['unit'],
                cart_count=group_data['cart_count'],
                cart_details=group_data['cart_details']
            )
            snapshots_to_create.append(snapshot)

        # 데이터베이스에 저장
        with transaction.atomic():
            DailyInventorySnapshot.objects.bulk_create(snapshots_to_create, ignore_conflicts=True)

        self.stdout.write(
            self.style.SUCCESS(
                f'{snapshot_date} 날짜의 재고 스냅샷을 성공적으로 생성했습니다. '
                f'총 {len(snapshots_to_create)}개의 스냅샷이 생성되었습니다.'
            )
        )

        # 10일 이전의 오래된 스냅샷 데이터 자동 삭제
        ten_days_ago = timezone.now().date() - timedelta(days=10)
        deleted_snapshots = DailyInventorySnapshot.objects.filter(
            snapshot_date__lt=ten_days_ago
        ).delete()
        
        deleted_summaries = DailyReportSummary.objects.filter(
            snapshot_date__lt=ten_days_ago
        ).delete()
        
        if deleted_snapshots[0] > 0 or deleted_summaries[0] > 0:
            self.stdout.write(
                self.style.SUCCESS(
                    f'10일 이전 데이터 정리 완료: 스냅샷 {deleted_snapshots[0]}개, 요약 {deleted_summaries[0]}개 삭제됨'
                )
            )

        # 통계 정보 출력
        warehouse_stats = defaultdict(int)
        for snapshot in snapshots_to_create:
            warehouse_stats[snapshot.warehouse_name] += 1

        self.stdout.write('\n창고별 스냅샷 개수:')
        for warehouse_name, count in warehouse_stats.items():
            self.stdout.write(f'  {warehouse_name}: {count}개') 