from django.core.management.base import BaseCommand
from inventory.models import DailyInventorySnapshot
from django.db.models import Count, Max


class Command(BaseCommand):
    help = '창고 이름 디버깅을 위한 명령'

    def handle(self, *args, **options):
        self.stdout.write('=== 창고 이름 디버깅 ===')
        
        # 최신 스냅샷 날짜 찾기
        latest_date = DailyInventorySnapshot.objects.aggregate(
            latest_date=Max('snapshot_date')
        )['latest_date']
        
        if not latest_date:
            self.stdout.write(self.style.ERROR('스냅샷 데이터가 없습니다.'))
            return
        
        self.stdout.write(f'최신 스냅샷 날짜: {latest_date}')
        
        # 창고별 데이터 수 확인
        warehouse_stats = DailyInventorySnapshot.objects.filter(
            snapshot_date=latest_date
        ).values('warehouse_name').annotate(
            count=Count('id')
        ).order_by('warehouse_name')
        
        self.stdout.write('\n=== 창고별 데이터 수 ===')
        for stat in warehouse_stats:
            self.stdout.write(f'{stat["warehouse_name"]}: {stat["count"]}개')
        
        # 成品 관련 창고 확인
        finished_warehouses = DailyInventorySnapshot.objects.filter(
            snapshot_date=latest_date,
            warehouse_name__icontains='成品'
        ).values('warehouse_name').distinct()
        
        self.stdout.write('\n=== 成品 관련 창고 ===')
        for warehouse in finished_warehouses:
            self.stdout.write(f'- {warehouse["warehouse_name"]}')
        
        # 半成品 관련 창고 확인
        semi_warehouses = DailyInventorySnapshot.objects.filter(
            snapshot_date=latest_date,
            warehouse_name__icontains='半成品'
        ).values('warehouse_name').distinct()
        
        self.stdout.write('\n=== 半成品 관련 창고 ===')
        for warehouse in semi_warehouses:
            self.stdout.write(f'- {warehouse["warehouse_name"]}')
        
        # 특정 제품 검색 (ACQ30776301)
        acq_items = DailyInventorySnapshot.objects.filter(
            snapshot_date=latest_date,
            material_code__icontains='ACQ30776301'
        )
        
        self.stdout.write(f'\n=== ACQ30776301 검색 결과: {acq_items.count()}개 ===')
        for item in acq_items:
            self.stdout.write(f'- {item.material_code} @ {item.warehouse_name} (수량: {item.total_quantity})') 