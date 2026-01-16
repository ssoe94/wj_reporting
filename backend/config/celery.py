"""
Celery 설정 - 생산 데이터 자동화를 위한 스케줄링 구성
"""

import os
from celery import Celery
from celery.schedules import crontab
from django.conf import settings

# Django 설정 모듈 지정
os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings')

app = Celery('production_site')

# Django 설정에서 Celery 설정을 가져옴
app.config_from_object('django.conf:settings', namespace='CELERY')

# Django 앱에서 task 자동 발견
app.autodiscover_tasks()

# Beat 스케줄 설정
app.conf.beat_schedule = {
    'update-production-matrix-every-10-mins': {
        'task': 'injection.tasks.update_production_matrix_hourly',
        'schedule': 600.0,  # 10분 (600초)
        'options': {
            'expires': 600,  # 10분 후 만료
        }
    },
    'capture-finished-goods-morning': {
        'task': 'inventory.tasks.capture_finished_goods_morning',
        'schedule': crontab(hour=8, minute=0),
    },
    'capture-finished-goods-evening': {
        'task': 'inventory.tasks.capture_finished_goods_evening',
        'schedule': crontab(hour=20, minute=0),
    },
}

# 시간대 설정
app.conf.timezone = 'Asia/Shanghai'


@app.task(bind=True)
def debug_task(self):
    print(f'Request: {self.request!r}')
