import math
import datetime
from django.core.management.base import BaseCommand
from django.utils import timezone
from inventory.mes import call_inventory_list
from inventory.models import StagingInventory
from django.db import transaction
from django.db import models
from django.core.cache import cache


class Command(BaseCommand):
    help = "Fetch inventory from MES and upsert into staging & fact tables"

    def add_arguments(self, parser):
        parser.add_argument('--hours', type=int, default=2, help='Lookback hours for upsert window')

    def handle(self, *args, **options):
        page = 1
        size = 100  # 페이지 크기를 100으로 줄임 (더 안정적)
        total_imported = 0
        
        # MES와 완전 동기화 (시간 필터 없이)
        self.stdout.write('Full synchronization with MES (no time filter)...')
        
        # 진행 상황 초기화
        cache.set('inventory_fetch_progress', {
            'current': 0,
            'total': 0,
            'status': 'initializing'
        }, 600)  # 10분 캐시
        
        # StagingInventory 초기화
        StagingInventory.objects.all().delete()
        self.stdout.write('Cleared existing staging inventory data')
        
        try:
            while True:
                # 페이지별 재시도 로직 (최대 3번)
                for retry in range(3):
                    try:
                        # MES에서 모든 데이터 가져오기 (시간 필터 없이)
                        data = call_inventory_list(page=page, size=size)
                        items = data.get('data', {}).get('list', []) or data.get('items', [])
                        if not items:
                            break
                        
                        staging_objs = []
                        for it in items:
                            material_code = it.get('materialCode') or it.get('material', {}).get('code')
                            warehouse_code = it.get('warehouseCode') or it.get('storageLocationDetail', {}).get('warehouse', {}).get('code', '')
                            trolley_code = it.get('trolleyCode') or it.get('labelCode') or ''
                            updated_at = it.get('updatedAt', 0)
                            
                            # 대차번호 + Part No로 composite_key 생성 (시간 제외)
                            composite_key = f"{trolley_code}::{material_code}"
                            

                            staging_objs.append(StagingInventory(
                                material_id=it.get('materialId') or it.get('material', {}).get('id'),
                                qr_code=it.get('qrCode') or '',
                                label_code=it.get('trolleyCode') or it.get('labelCode') or '',
                                composite_key=composite_key,
                                material_code=it.get('materialCode') or it.get('material', {}).get('code'),
                                material_name=it.get('materialName') or it.get('material', {}).get('name', ''),
                                specification=it.get('material', {}).get('specification',''),
                                biz_type=str(it.get('material', {}).get('bizType', '')),
                                warehouse_code=it.get('warehouseCode') or it.get('storageLocationDetail', {}).get('warehouse', {}).get('code', ''),
                                warehouse_name=it.get('warehouseName') or it.get('storageLocationDetail', {}).get('warehouse', {}).get('name', ''),
                                location_name=it.get('storageLocationDetail', {}).get('location', {}).get('name',''),
                                storage_status=str(it.get('storageStatus', {}).get('code', '')),
                                qc_status=str(it.get('qcStatus', {}).get('code', '')),
                                work_order_code=(it.get('workOrderSimpleInfos') or [{}])[0].get('code',''),
                                quantity=it.get('amount', {}).get('amount', 0),
                                unit=it.get('amount', {}).get('unit', {}).get('code', ''),
                                updated_at=datetime.datetime.fromtimestamp(it.get('updatedAt')/1000, tz=datetime.timezone.utc),
                            ))
                        
                        # StagingInventory에 직접 저장 (중복 제거 없이)
                        StagingInventory.objects.bulk_create(staging_objs, batch_size=1000)
                        total_imported += len(staging_objs)
                        
                        # 진행 상황 표시
                        self.stdout.write(f'Page {page}: imported {len(staging_objs)} items (total: {total_imported})')
                        
                        # 진행 상황 캐시 업데이트
                        cache.set('inventory_fetch_progress', {
                            'current': total_imported,
                            'total': total_imported,  # 현재까지의 총합
                            'status': 'fetching',
                            'page': page
                        }, 600)
                        
                        if len(items) < size:
                            # 완료
                            cache.set('inventory_fetch_progress', {
                                'current': total_imported,
                                'total': total_imported,
                                'status': 'completed'
                            }, 600)
                            return  # 모든 데이터를 가져왔으므로 전체 프로세스 종료
                        page += 1
                        break  # 성공하면 재시도 루프 종료
                        
                    except Exception as e:
                        if retry == 2:  # 마지막 시도
                            self.stdout.write(self.style.ERROR(f'Error fetching page {page} after 3 retries: {str(e)}'))
                            return  # 전체 프로세스 중단
                        else:
                            self.stdout.write(self.style.WARNING(f'Retry {retry + 1}/3 for page {page}: {str(e)}'))
                            time.sleep(5)  # 5초 대기 후 재시도
                    
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'Critical error in inventory fetch: {str(e)}'))
            return
            
        self.stdout.write(self.style.SUCCESS(f'Imported {total_imported} rows to staging_inventory')) 