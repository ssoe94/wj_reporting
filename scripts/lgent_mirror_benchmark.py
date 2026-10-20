"""Reproducible local-only mirror timing. This is not an LG/Cloudinary SLA."""
import io,json,time
from unittest.mock import patch

def run(root):
    from django.conf import settings
    from django.core.management import call_command
    from lgent import client,mirror,service
    from PIL import Image
    if not settings.LGENT_FORCE_LOCAL_MEDIA or settings.DATABASES['default']['ENGINE']!='django.db.backends.sqlite3':
        raise RuntimeError('Benchmark requires the isolated SQLite/local-media runner.')
    call_command('migrate',verbosity=0)
    image=Image.effect_noise((1440,1920),90).convert('RGB');out=io.BytesIO();image.save(out,'JPEG',quality=85);raw=out.getvalue()
    rows=[]
    for index in range(316):
        rows.append(service.remember({'com_code':'LGENT','org_code':'ENT','supplier_id':'TT094','trolley_id':f'QA-{index:04}',
          'pic_url':f'/files/trolley_grade_management/ENT/2026/01/20260101000000{index:06}.jpg'}))
    calls=0
    def source(*args,**kwargs):
        nonlocal calls
        calls+=1;time.sleep(.02);return raw
    with patch.object(client,'photo',side_effect=source),patch.object(client,'request',side_effect=AssertionError('External network forbidden')):
        start=time.perf_counter()
        for cart in rows:
            _,error=mirror.copy(cart,'synthetic-token')
            if error:raise error
        first=time.perf_counter()-start;initial_calls=calls
        start=time.perf_counter()
        for cart in rows:mirror.copy(cart,'synthetic-token')
        repeat=time.perf_counter()-start
    report={'environment':'isolated SQLite, temporary local files, synthetic 1440x1920 JPEG; NO real LG or Cloudinary requests',
      'count':316,'jpeg_bytes':len(raw),'injected_lg_seconds_per_image':.02,'first_copy_seconds':round(first,3),
      'repeat_unchanged_seconds':round(repeat,3),'initial_lg_calls':initial_calls,'repeat_lg_calls':calls-initial_calls,
      'remaining':mirror.pending().count(),'gallery_browser_seconds':None,'production_316_timing':None}
    print(json.dumps(report,indent=2))
