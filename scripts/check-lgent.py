"""Isolated LGENT checks. Never loads project .env or a production database."""
from pathlib import Path
import sys,types,tempfile
from mes_oauth_test_database import mes_oauth_test_database,POSTGRES_SOCKET_OPTION
root=Path(__file__).resolve().parents[1]
database=mes_oauth_test_database(sys.argv[1:],root)
sys.argv=[sys.argv[0]]+[arg for arg in sys.argv[1:] if not arg.startswith(POSTGRES_SOCKET_OPTION)]
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'backend'))
import decouple
decouple.config=decouple.Config(decouple.RepositoryEmpty())
from django.conf import settings
media=tempfile.TemporaryDirectory(prefix='lgent-check-')
preview='--preview' in sys.argv
settings.configure(SECRET_KEY='isolated-lgent-check-secret',
 INSTALLED_APPS=['django.contrib.auth','django.contrib.contenttypes','django.contrib.sessions','rest_framework','django_filters',
                 'injection','assembly','sales','overview','inventory','quality','production','ai_core','analytics','lgent'],
 DATABASES={'default':{'ENGINE':'django.db.backends.sqlite3','NAME':str(Path(media.name)/'preview.sqlite3')} if preview else database},DEBUG=preview,DEFAULT_AUTO_FIELD='django.db.models.BigAutoField',
 USE_TZ=True,TIME_ZONE='Asia/Shanghai',ROOT_URLCONF='isolated_lgent_urls',ALLOWED_HOSTS=['testserver','localhost','127.0.0.1'],
 PASSWORD_HASHERS=['django.contrib.auth.hashers.MD5PasswordHasher'],MIDDLEWARE=[],MEDIA_ROOT=media.name,
 LGENT_ALLOW_LOCAL_MEDIA=True,LGENT_FORCE_LOCAL_MEDIA=True,CLOUDINARY_STORAGE={'CLOUD_NAME':'test','API_KEY':'test','API_SECRET':'test'},AI_WORKER_TOKEN='isolated-worker-token',
 REST_FRAMEWORK={'DEFAULT_AUTHENTICATION_CLASSES':['rest_framework.authentication.SessionAuthentication'],
                 'DEFAULT_PERMISSION_CLASSES':['rest_framework.permissions.IsAuthenticated'],'DEFAULT_PAGINATION_CLASS':'rest_framework.pagination.PageNumberPagination','PAGE_SIZE':25},
)
import django
django.setup()
from django.urls import path,include
urls=types.ModuleType('isolated_lgent_urls');urls.urlpatterns=[path('api/lgent/',include('lgent.urls')),path('api/ai/',include('ai_core.urls'))];sys.modules[urls.__name__]=urls
from django.core.management import call_command
if '--mirror-benchmark' in sys.argv:
 from lgent_mirror_benchmark import run
 run(root)
 raise SystemExit(0)
if '--migration-check' in sys.argv:
 call_command('makemigrations','lgent','ai_core',check=True,dry_run=True);raise SystemExit(0)
if '--makemigrations' in sys.argv:
 call_command('makemigrations','lgent','ai_core');raise SystemExit(0)
if preview:
 call_command('migrate',verbosity=0)
 import io,datetime as dt,hashlib
 from PIL import Image,ImageDraw
 from django.contrib.auth import get_user_model
 from django.utils import timezone
 from rest_framework.authentication import BaseAuthentication
 from lgent import views,service,client
 from lgent.models import LgentProfile,LgentCart,LgentPhoto
 from lgent.security import encrypt_token
 user=get_user_model().objects.create_user(username='SYNTHETIC-LGENT-QA',is_staff=True)
 class SyntheticAuthentication(BaseAuthentication):
  def authenticate(self,request):return user,None
 views.LgentView.authentication_classes=[SyntheticAuthentication]
 LgentProfile.objects.create(user=user,encrypted_token=encrypt_token('synthetic-token'),lg_user_id='QA',current_company='LGENT',menu_permission='RX',expires_at=timezone.now()+dt.timedelta(hours=1))
 images={};rows={}
 for index in range(1,13):
  code=f'QA-{index:04d}'
  image=Image.new('RGB',(300,400),(125+index*3,140,150));draw=ImageDraw.Draw(image)
  draw.rectangle((35,25,270,375),outline='white',width=6);draw.line((35,180,270,180),fill='white',width=5)
  draw.rectangle((60,130,230,170),fill='#ffe272');draw.text((75,145),code,fill='black')
  out=io.BytesIO();image.save(out,'JPEG');images[code]=out.getvalue()
  rows[code]={'trolley_id':code,'com_code':'LGENT','org_code':'ENT','supplier_id':'TT094','last_item_id':'QA-ITEM','last_grade':'B','problem':'','memo':'','pic_url':f'/files/trolley_grade_management/ENT/2026/10/{(timezone.now().astimezone(client.TZ)-dt.timedelta(days=238 if index<5 else index)).strftime("%Y%m%d%H%M%S")}.jpg'}
  cart=service.remember(rows[code]);cart.photo_file_at=timezone.now()-dt.timedelta(days=238 if index<5 else index);cart.save()
  if index<=4:
   value=service.upload(user,type('File',(),{'name':f'SYNTHETIC-QA-{index}.jpg','read':lambda self,n,raw=images[code]:raw})())
   value.status='ready';value.trolley_id=code;value.grade='B';value.baseline=rows[code];value.note='SYNTHETIC QA fixture';value.save()
 def fake_info(token,code):
  if code not in rows:raise client.LgError('SYNTHETIC not found','cart_not_found',404)
  return rows[code]
 client.info=fake_info
 client.photo=lambda token,row,**kwargs:images.get(row['trolley_id'],b'')
 def blocked(*args,**kwargs):raise client.LgError('SYNTHETIC PREVIEW: external LG network disabled')
 client.request=blocked
 print('SYNTHETIC LGENT preview only. No production DB, no LG network.',flush=True)
 call_command('runserver','127.0.0.1:8059',use_reloader=False)
 raise SystemExit(0)
from django.test.runner import DiscoverRunner
raise SystemExit(DiscoverRunner(verbosity=1).run_tests(sys.argv[1:] or ['lgent.tests','lgent.test_shipments']))
