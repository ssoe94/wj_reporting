import math
import datetime
import time
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
        import os
        from decouple import config
        
        page = 1
        size = 100  # 페이지 크기를 100으로 줄임 (더 안정적)
        total_imported = 0
        
        # 환경 변수 로깅
        self.stdout.write('=== Environment Check ===')
        self.stdout.write(f'MES_API_BASE: {os.getenv("MES_API_BASE", "https://v3-ali.blacklake.cn")}')
        self.stdout.write(f'MES_APP_KEY exists: {bool(os.getenv("MES_APP_KEY") or config("MES_APP_KEY", default=""))}')
        self.stdout.write(f'MES_APP_SECRET exists: {bool(os.getenv("MES_APP_SECRET") or config("MES_APP_SECRET", default=""))}')
        self.stdout.write(f'MES_ACCESS_TOKEN exists: {bool(os.getenv("MES_ACCESS_TOKEN") or config("MES_ACCESS_TOKEN", default=""))}')
        
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
                        
                        # MES 응답이 None이거나 빈 응답인 경우 처리
                        if not data:
                            self.stdout.write(self.style.WARNING(f'Page {page}: Empty response from MES'))
                            # 캐시에 완료 상태 설정
                            cache.set('inventory_fetch_progress', {
                                'current': total_imported,
                                'total': total_imported,
                                'status': 'completed'
                            }, 600)
                            return
                            
                        items = data.get('data', {}).get('list', []) or data.get('items', [])
                        if not items:
                            self.stdout.write(f'Page {page}: No more items to fetch')
                            break
                        
                        staging_objs = []
                        for it in items:
                            try:
                                # 안전한 데이터 접근
                                material_code = it.get('materialCode') if it else None
                                if not material_code and it:
                                    material_info = it.get('material')
                                    material_code = material_info.get('code') if material_info else None
                                
                                warehouse_code = it.get('warehouseCode') if it else None
                                if not warehouse_code and it:
                                    storage_detail = it.get('storageLocationDetail')
                                    if storage_detail:
                                        warehouse_info = storage_detail.get('warehouse')
                                        warehouse_code = warehouse_info.get('code', '') if warehouse_info else ''
                                
                                trolley_code = it.get('trolleyCode') or it.get('labelCode') or '' if it else ''
                                updated_at = it.get('updatedAt', 0) if it else 0
                                
                                # 필수 데이터가 없으면 스킵
                                if not material_code:
                                    self.stdout.write(self.style.WARNING(f'Skipping item without material_code: {it}'))
                                    continue
                                
                                # 대차번호 + Part No로 composite_key 생성 (시간 제외)
                                composite_key = f"{trolley_code}::{material_code}"
                            except Exception as item_error:
                                self.stdout.write(self.style.WARNING(f'Error processing item: {item_error}'))
                                continue
                            

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
                            # 에러 상태로 캐시 업데이트
                            cache.set('inventory_fetch_progress', {
                                'current': total_imported,
                                'total': total_imported,
                                'status': 'error',
                                'error': str(e)
                            }, 600)
                            return  # 전체 프로세스 중단
                        else:
                            self.stdout.write(self.style.WARNING(f'Retry {retry + 1}/3 for page {page}: {str(e)}'))
                            time.sleep(5)  # 5초 대기 후 재시도
                    
        except Exception as e:
            self.stdout.write(self.style.ERROR(f'Critical error in inventory fetch: {str(e)}'))
            # 에러 상태로 캐시 업데이트
            cache.set('inventory_fetch_progress', {
                'current': total_imported,
                'total': total_imported,
                'status': 'error',
                'error': str(e)
            }, 600)
            return
            
        self.stdout.write(self.style.SUCCESS(f'Imported {total_imported} rows to staging_inventory')) 