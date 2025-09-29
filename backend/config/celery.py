"""
Celery 설정 - 사출기 모니터링 자동화를 위한 스케줄링
"""

import os
from celery import Celery
from django.conf import settings

# Django 설정 모듈 지정
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

app = Celery('production_site')

# Django 설정에서 Celery 설정을 가져옴
app.config_from_object('django.conf:settings', namespace='CELERY')

# Django 앱에서 task 자동 발견
app.autodiscover_tasks()

# Beat 스케줄 설정 - 매 정시에 생산 매트릭스 업데이트
app.conf.beat_schedule = {
    'update-production-matrix-hourly': {
        'task': 'injection.tasks.update_production_matrix_hourly',
        'schedule': 3600.0,  # 매 시간 (3600초)
        'options': {
            'expires': 3600,  # 1시간 후 만료
        }
    },
}

# 시간대 설정
app.conf.timezone = 'Asia/Shanghai'

@app.task(bind=True)
def debug_task(self):
    print(f'Request: {self.request!r}')