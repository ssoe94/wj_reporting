import base64
import copy
import datetime as dt
import hashlib
import io
import tempfile
from unittest.mock import patch,Mock
from PIL import Image
from django.contrib.auth import get_user_model
from django.test import TestCase,override_settings
from django.utils import timezone
from django.core.cache import cache
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient
from ai_core.models import AiJob
from . import service,client,media,mirror
from .models import LgentProfile,LgentCart,LgentPhoto,LgentSaveEvent
from .security import encrypt_token,decrypt_token

ROW={'com_code':'LGENT','org_code':'ENT','trolley_id':'TT0940306','supplier_id':'TT094','last_item_id':'ITEM',
     'last_grade':'B','problem':'','memo':'','pic_url':'/files/trolley_grade_management/ENT/2025/03/20250307103712345678.jpg','update_user_id':''}

def jpeg():
    out=io.BytesIO();Image.new('RGB',(32,40),'green').save(out,'JPEG');return out.getvalue()


@override_settings(LGENT_FORCE_LOCAL_MEDIA=True,LGENT_ALLOW_LOCAL_MEDIA=True,AI_WORKER_TOKEN="isolated-worker-token",CLOUDINARY_STORAGE={"CLOUD_NAME":"test","API_KEY":"test","API_SECRET":"test"})
class LgentTests(TestCase):
    def setUp(self):
        cache.clear()
        directory=self.enterContext(tempfile.TemporaryDirectory(prefix="lgent-test-media-"))
        self.enterContext(override_settings(MEDIA_ROOT=directory))
        self.user=get_user_model().objects.create_user(username='operator',is_staff=True)
        self.other=get_user_model().objects.create_user(username='other',is_staff=True)
        self.api=APIClient();self.api.force_authenticate(self.user)
        self.profile=LgentProfile.objects.create(user=self.user,encrypted_token=encrypt_token('private-token'),lg_user_id='lg-user',
                    lg_user_name='Operator',current_company='LGENT',menu_permission='RX',expires_at=timezone.now()+dt.timedelta(hours=1))
        self.raw=media.normalize(jpeg());self.digest=hashlib.sha256(self.raw).hexdigest()
        self.cart=service.remember(copy.deepcopy(ROW))

    def photo(self,status='ready',suffix=''):
        raw=self.raw if not suffix else media.normalize(self.raw)
        digest=self.digest if not suffix else hashlib.sha256((self.digest+suffix).encode()).hexdigest()
        key=media.put(raw,self.user.pk,digest)
        return LgentPhoto.objects.create(user=self.user,filename='photo.jpg',sha256=digest,storage_key=key,byte_size=len(raw),
                    status=status,trolley_id=ROW['trolley_id'],grade='B',baseline=copy.deepcopy(ROW))

    def test_token_encrypted_and_never_exposed_by_workspace(self):
        self.assertNotIn('private-token',self.profile.encrypted_token)
        self.assertEqual(decrypt_token(self.profile.encrypted_token),'private-token')
        response=self.api.get('/api/lgent/workspace/')
        self.assertEqual(response.status_code,200)
        for secret in ('private-token','encrypted_token','baseline','lg-user'):
            self.assertNotIn(secret,response.content.decode())

    def test_anonymous_and_inactive_rejected(self):
        self.api.force_authenticate(None);self.assertIn(self.api.get('/api/lgent/workspace/').status_code,(401,403))
        self.user.is_active=False;self.user.save();self.api.force_authenticate(self.user)
        self.assertEqual(self.api.get('/api/lgent/workspace/').status_code,403)

    def test_sales_viewer_cannot_save_or_upload(self):
        user=get_user_model().objects.create_user(username='viewer')
        from injection.models import UserProfile
        profile,_=UserProfile.objects.get_or_create(user=user);profile.can_view_sales=True;profile.can_edit_sales=False;profile.save()
        self.api.force_authenticate(user)
        self.assertEqual(self.api.get('/api/lgent/workspace/').status_code,200)
        self.assertEqual(self.api.post('/api/lgent/photos/save/',{'ids':[1],'confirmed':True},format='json').status_code,403)
        self.assertEqual(self.api.post('/api/lgent/photos/',{}).status_code,403)

    def test_photo_ownership_enforced_on_image_and_match(self):
        value=self.photo()
        self.api.force_authenticate(self.other)
        self.assertEqual(self.api.get(f'/api/lgent/photos/{value.pk}/image/').status_code,404)
        self.assertEqual(self.api.post(f'/api/lgent/photos/{value.pk}/match/',{'trolleyId':'TT0940306','confirmed':True},format='json').status_code,404)

    def test_login_contract_and_only_public_identity_returned(self):
        responses=[{'token':'new-token','user_info':{'userId':'id','userName':'Name','userPassword':'echo-password'}},'LGENT',
                   [{'orgCode':'ENT'}],[{'supplier_code':'TT094'}],'RX']
        with patch('lgent.client.request',side_effect=responses) as upstream:
            response=self.api.post('/api/lgent/login/',{'userId':'id','password':'secret-password'},format='json')
        self.assertEqual(response.status_code,200)
        self.assertNotIn('token',response.content.decode());self.assertNotIn('password',response.content.decode())
        payload=upstream.call_args_list[0].kwargs['payload'];self.assertEqual(payload['UserId'],'id');self.assertEqual(payload['UserPassword'],'secret-password')
        self.profile.refresh_from_db();self.assertEqual(decrypt_token(self.profile.encrypted_token),'new-token')

    def test_foreign_org_login_fails_without_saving_token(self):
        with patch('lgent.client.request',side_effect=[{'token':'new-token','user_info':{}},'LGENT',[{'orgCode':'OTHER'}]]):
            response=self.api.post('/api/lgent/login/',{'userId':'id','password':'pw'},format='json')
        self.assertEqual(response.status_code,403);self.profile.refresh_from_db();self.assertEqual(decrypt_token(self.profile.encrypted_token),'private-token')

    def test_expired_lg_connection_not_a_wj_401(self):
        self.profile.expires_at=timezone.now()-dt.timedelta(seconds=1);self.profile.save()
        response=self.api.post('/api/lgent/lookup/',{'trolleyId':'TT0940306'},format='json')
        self.assertEqual(response.status_code,409);self.assertEqual(response.data['code'],'lg_connection_required')
        self.profile.refresh_from_db();self.assertEqual(self.profile.encrypted_token,'')
        self.assertFalse(self.api.get('/api/lgent/workspace/').data['connection']['authenticated'])

    def test_logout_only_clears_current_users_token(self):
        LgentProfile.objects.create(user=self.other,encrypted_token='untouched')
        self.assertEqual(self.api.post('/api/lgent/logout/',{},format='json').status_code,200)
        self.profile.refresh_from_db();self.assertEqual(self.profile.encrypted_token,'')
        self.assertEqual(LgentProfile.objects.get(user=self.other).encrypted_token,'untouched')

    def test_age_is_photo_file_estimate_not_arrival_or_query(self):
        value=service.public_cart(self.cart)
        self.assertEqual(value['dateSource'],'photo_file');self.assertTrue(value['displayAt'].startswith('2025-03-07'))
        self.assertEqual(value['alert'],'stale');self.assertIn('T10:37:12+08:00',value['displayAt'])
        self.cart.photo_file_at=None;self.cart.last_history_at=timezone.now().isoformat();self.cart.save()
        value=service.public_cart(self.cart);self.assertEqual(value['dateSource'],'unknown');self.assertIsNone(value['ageDays'])

    def test_external_photo_change_invalidates_local_save_timestamp(self):
        self.cart.verified_save_at=timezone.now();self.cart.save()
        after=service.remember(dict(ROW,pic_url='/different.jpg'))
        self.assertIsNone(after.verified_save_at)

    def test_gallery_reuses_verified_metadata_and_small_thumbnail(self):
        raw=io.BytesIO();Image.new('RGB',(1400,1800),'green').save(raw,'JPEG')
        before=self.cart.updated_at
        self.cart.verified_save_at=timezone.now();self.cart.save()
        verified=self.cart.verified_save_at
        with patch('lgent.client.info') as info,patch('lgent.client.photo',return_value=raw.getvalue()) as photo:
            first=self.api.get('/api/lgent/carts/TT0940306/photo/?size=thumbnail')
            second=self.api.get('/api/lgent/carts/TT0940306/photo/?size=thumbnail')
        self.assertEqual(first.status_code,200);self.assertEqual(first.content,second.content)
        info.assert_not_called();photo.assert_called_once()
        small=first.content
        with Image.open(io.BytesIO(small)) as image:self.assertLessEqual(max(image.size),420)
        self.cart.refresh_from_db();self.assertEqual(self.cart.verified_save_at,verified)
        self.assertGreaterEqual(self.cart.updated_at,before)
        with patch('lgent.client.photo',return_value=raw.getvalue()):
            full=self.api.get('/api/lgent/carts/TT0940306/photo/')
        self.assertEqual(full.content,raw.getvalue())

    def test_same_metadata_keeps_thumbnail_and_photo_version(self):
        version=service.public_cart(self.cart)['photoVersion']
        with patch('lgent.client.photo',return_value=self.raw) as photo:
            service.cart_image(self.user,'TT0940306',True)
            self.cart=service.remember(copy.deepcopy(ROW))
            self.assertEqual(service.public_cart(self.cart)['photoVersion'],version)
            service.cart_image(self.user,'TT0940306',True)
        self.assertEqual(photo.call_count,1)
        after=service.remember(dict(ROW,pic_url='/files/replaced.jpg'))
        self.assertNotEqual(service.public_cart(after)['photoVersion'],version)

    def test_binary_images_are_private_versioned_and_etag_revalidated(self):
        version=service.public_cart(self.cart)['photoVersion']
        url='/api/lgent/carts/TT0940306/photo/?size=thumbnail&v='+version
        with patch('lgent.client.photo',return_value=self.raw):
            response=self.api.get(url)
            self.assertEqual(response['Content-Type'],'image/jpeg')
            self.assertEqual(response['Cache-Control'],'private, max-age=86400')
            repeated=self.api.get(url,HTTP_IF_NONE_MATCH=response['ETag'])
            self.assertEqual(repeated.status_code,304)
            stale=self.api.get(url.replace(version,'old-version'))
            self.assertEqual(stale['Cache-Control'],'private, no-cache')
        self.api.force_authenticate(None)
        self.assertIn(self.api.get(url,HTTP_IF_NONE_MATCH=response['ETag']).status_code,(401,403))
        value=self.photo()
        self.api.force_authenticate(self.user)
        response=self.api.get(f'/api/lgent/photos/{value.pk}/image/?v={value.sha256}')
        self.assertEqual(response.content,self.raw)
        self.assertEqual(response['Cache-Control'],'private, max-age=86400')

    def test_missing_gallery_photo_is_an_empty_uncached_response(self):
        self.cart=service.remember(dict(ROW,pic_url=''))
        with patch('lgent.client.photo',return_value=b''):
            response=self.api.get('/api/lgent/carts/TT0940306/photo/?size=thumbnail')
        self.assertEqual(response.status_code,204)
        self.assertEqual(response['Cache-Control'],'private, no-store')

    def test_mirrored_gallery_remains_available_to_wj_viewer_after_lg_expiry(self):
        with patch('lgent.client.photo',return_value=self.raw):service.cart_image(self.user,'TT0940306',True)
        self.profile.expires_at=timezone.now()-dt.timedelta(seconds=1);self.profile.save()
        with patch('lgent.client.photo') as photo:
            response=self.api.get('/api/lgent/carts/TT0940306/photo/?size=thumbnail')
        self.assertEqual(response.status_code,200);photo.assert_not_called()

    def test_gallery_failure_is_not_cached_as_missing_photo(self):
        with patch('lgent.client.photo',side_effect=client.LgError('upstream timed out')):
            response=self.api.get('/api/lgent/carts/TT0940306/photo/?size=thumbnail')
        self.assertEqual(response.status_code,502)
        with patch('lgent.client.photo',return_value=self.raw) as photo:
            response=self.api.get('/api/lgent/carts/TT0940306/photo/?size=thumbnail')
        self.assertEqual(response.status_code,200);photo.assert_called_once()

    def test_same_url_photo_replacement_invalidates_only_old_verified_snapshot(self):
        self.cart.verified_save_at=timezone.now();self.cart.photo_sha256='old-digest';self.cart.save()
        with patch('lgent.client.photo',return_value=self.raw):service.cart_image(self.user,'TT0940306',True)
        self.cart.refresh_from_db();self.assertIsNone(self.cart.verified_save_at)
        self.cart.verified_save_at=timezone.now();self.cart.photo_sha256='old-digest';self.cart.save_attempt_id='in-flight';self.cart.save()
        with patch('lgent.client.photo',return_value=self.raw):service.cart_image(self.user,'TT0940306',True)
        self.cart.refresh_from_db();self.assertIsNotNone(self.cart.verified_save_at);self.assertEqual(self.cart.save_attempt_id,'in-flight')

    def test_mirror_copies_source_once_and_keeps_original_bytes(self):
        with patch('lgent.client.photo',return_value=self.raw) as lg:
            raw,error=mirror.copy(self.cart,'token');self.assertIsNone(error);self.assertEqual(raw,self.raw)
            self.assertTrue(mirror.current(self.cart));self.assertEqual(media.read_mirror(self.cart.mirror_key),self.raw)
            self.assertFalse(mirror.pending().exists())
            mirror.copy(self.cart,'token');lg.assert_called_once()
            self.cart=service.remember(dict(ROW,pic_url='/files/new-source.jpg'))
            self.assertFalse(mirror.current(self.cart));self.assertTrue(mirror.pending().exists())
            mirror.copy(self.cart,'token');self.assertEqual(lg.call_count,2)

    def test_mirror_failure_preserves_metadata_and_next_cursor_continues(self):
        from django.core import signing
        second=service.remember(dict(ROW,trolley_id='TT0940307'))
        cursor=signing.dumps({'user':self.user.pk,'start':timezone.now().isoformat(),'offset':30,'phase':'photos','after':''},salt='lgent-sync')
        with patch('lgent.client.photo',return_value=self.raw),patch('lgent.media.put_mirror',side_effect=client.LgError('private failure')):
            first=service.sync(self.user,cursor)
        self.assertEqual(first['mirrorErrors'],1);self.assertEqual(first['remaining'],1)
        self.cart.refresh_from_db();self.assertTrue(self.cart.mirror_error);self.assertEqual(self.cart.baseline,ROW)
        with patch('lgent.client.photo',return_value=self.raw):last=service.sync(self.user,first['cursor'])
        self.assertIsNone(last['cursor']);second.refresh_from_db();self.assertTrue(mirror.current(second))

    def test_mirror_cannot_attach_old_source_or_overwrite_write_lease(self):
        def changed(*args):
            LgentCart.objects.filter(pk=self.cart.pk).update(baseline=dict(ROW,pic_url='/changed.jpg'))
            return f'lgent/lg-mirror/TT094/TT0940306/{self.digest}.jpg'
        with patch('lgent.client.photo',return_value=self.raw),patch('lgent.media.put_mirror',side_effect=changed):
            _,error=mirror.copy(self.cart,'token')
        self.assertEqual(error.code,'mirror_source_changed');self.cart.refresh_from_db();self.assertFalse(self.cart.mirror_key)
        self.cart.save_attempt_id='business-write';self.cart.save()
        with patch('lgent.client.photo') as lg:_,error=mirror.copy(self.cart,'token')
        self.assertEqual(error.code,'mirror_pending');lg.assert_not_called()

    def test_cloud_mirror_is_authenticated_and_time_limited_with_fixed_thumbnail(self):
        from urllib.parse import urlsplit,parse_qs
        with override_settings(LGENT_FORCE_LOCAL_MEDIA=False,CLOUDINARY_STORAGE={'CLOUD_NAME':'synthetic','API_KEY':'synthetic-key','API_SECRET':'never-output-this-secret'}):
            public_id=f'lgent/lg-mirror/TT094/TT0940306/{self.digest}'
            with patch('cloudinary.uploader.upload',return_value={'public_id':public_id}) as put:
                key=media.put_mirror(self.raw,'TT0940306',self.digest)
            self.assertEqual(put.call_args.kwargs['type'],'authenticated');self.assertFalse(put.call_args.kwargs['overwrite'])
            self.assertEqual(put.call_args.args[0].getvalue(),self.raw)
            urls=media.mirror_urls(key);query=parse_qs(urlsplit(urls['thumbnailUrl']).query)
            self.assertEqual(query['type'],['authenticated']);self.assertEqual(query['transformation'],[media.THUMB_TRANSFORMATION])
            self.assertLessEqual(urls['imageExpiresAt']-int(time.time()),3600);self.assertGreaterEqual(urls['imageExpiresAt']-int(time.time()),2695)
            self.assertNotIn('never-output-this-secret',urls['thumbnailUrl'])
            self.assertNotIn('transformation',parse_qs(urlsplit(urls['imageUrl']).query))

    def test_png_mirror_round_trip_preserves_original_format(self):
        out=io.BytesIO();Image.new('RGB',(20,30),'red').save(out,'PNG');raw=out.getvalue()
        key=media.put_mirror(raw,'TT0940306',hashlib.sha256(raw).hexdigest())
        self.assertTrue(key.endswith('.png'));self.assertEqual(media.read_mirror(key),raw)

    def test_verified_save_and_reconcile_reuse_uploaded_asset_without_mirror_write(self):
        value=self.photo()
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',side_effect=[b'',self.raw]),patch('lgent.client.request',return_value={'typeCode':True}),patch('lgent.media.put_mirror') as put:
            result=service.save_one(self.user,value.pk)
        self.assertEqual(result['status'],'saved');put.assert_not_called();self.cart.refresh_from_db()
        self.assertEqual(self.cart.mirror_key,value.storage_key);self.assertEqual(self.cart.mirror_sha256,value.sha256)
        value.status='uncertain';value.save()
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=self.raw),patch('lgent.media.put_mirror') as put:
            self.assertTrue(service.reconcile(self.user,value.pk)['verified'])
        put.assert_not_called()

    def test_live_preflight_never_trusts_mirror_bytes(self):
        value=self.photo()
        with patch('lgent.client.photo',return_value=self.raw):mirror.copy(self.cart,'token')
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=b'upstream changed'),patch('lgent.media.read_mirror') as cached,patch('lgent.client.request') as write:
            with self.assertRaises(client.LgError) as error:service.save_one(self.user,value.pk)
        self.assertEqual(error.exception.code,'lg_conflict');cached.assert_not_called();write.assert_not_called()

    def test_mirror_download_uses_bounded_timeout(self):
        response=Mock(status_code=200);response.iter_content.return_value=[self.raw]
        with patch('lgent.client.requests.get',return_value=response) as get,patch('lgent.client.time.monotonic',side_effect=[0,15]):
            with self.assertRaises(client.LgError) as error:client.photo('token',ROW,timeout=(3,8),max_seconds=14)
        self.assertEqual(error.exception.code,'mirror_timeout');self.assertEqual(get.call_args.kwargs['timeout'],(3,8));response.close.assert_called_once()

    def test_foreign_cached_metadata_is_revalidated_before_read(self):
        self.cart.baseline=dict(ROW,supplier_id='OTHER');self.cart.save()
        with patch('lgent.client.info',side_effect=client.LgError('foreign','foreign_supplier',403)),patch('lgent.client.photo') as photo:
            response=self.api.get('/api/lgent/carts/TT0940306/photo/?size=thumbnail')
        self.assertEqual(response.status_code,403);photo.assert_not_called()

    def test_photo_normalizer_rejects_invalid_bytes(self):
        for raw in (b'not an image',b'\xff\xd8\xffbad\xff\xd9',b'x'*(media.MAX_BYTES+1)):
            with self.assertRaises(client.LgError):media.normalize(raw)

    def test_upload_is_idempotent_and_never_writes_lg(self):
        with patch('lgent.client.request') as lg:
            one=self.api.post('/api/lgent/photos/',{'file':SimpleUploadedFile('photo.jpg',jpeg(),'image/jpeg')})
            two=self.api.post('/api/lgent/photos/',{'file':SimpleUploadedFile('photo.jpg',jpeg(),'image/jpeg')})
        self.assertEqual(one.status_code,201);self.assertEqual(one.data['id'],two.data['id']);lg.assert_not_called()

    def test_cloud_storage_is_authenticated(self):
        with override_settings(LGENT_FORCE_LOCAL_MEDIA=False),patch('cloudinary.uploader.upload',return_value={'public_id':'key'}) as upload:
            media.put(self.raw,self.user.pk,self.digest)
        self.assertEqual(upload.call_args.kwargs['type'],'authenticated');self.assertFalse(upload.call_args.kwargs['overwrite'])

    def test_ai_jobs_contain_no_lg_credentials_and_offline_is_pending(self):
        value=self.photo('pending')
        response=self.api.post('/api/lgent/photos/analyze/',{'ids':[value.pk]},format='json')
        self.assertEqual(response.status_code,200);value.refresh_from_db();self.assertEqual(value.status,'queued')
        self.assertEqual(value.job.status,'pending')
        data=str(value.job.input_payload)+str(value.job.scope)
        self.assertNotIn('private-token',data);self.assertNotIn('password',data);self.assertIn('image_endpoint',value.job.input_payload)

    def test_double_analyze_does_not_duplicate_job(self):
        value=self.photo('pending')
        service.analyze(self.user,[value.pk]);service.analyze(self.user,[value.pk])
        self.assertEqual(AiJob.objects.filter(job_type=service.PHOTO_JOB).count(),1)

    def test_ai_disagreement_is_review(self):
        value=self.photo('pending');service.analyze(self.user,[value.pk]);value.refresh_from_db()
        with transaction_for_test():
            service.accept_result(value.job,{'primary_id':'TT0940306','uncertain':False,'local_evidence':[{'id':'TT0940223','confidence':1}]},service.PROMPT)
        value.refresh_from_db();self.assertEqual(value.status,'review')

    def test_ai_agreement_requires_lg_verification(self):
        value=self.photo('pending');service.analyze(self.user,[value.pk]);value.refresh_from_db()
        service.accept_result(value.job,{'primary_id':'TT0940306','uncertain':False,'local_evidence':[{'id':'TT0940306','confidence':1}]},service.PROMPT)
        value.refresh_from_db();self.assertEqual(value.status,'recognized')
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=b''):
            self.assertEqual(service.verify(self.user,[value.pk])['verified'],1)
        value.refresh_from_db();self.assertEqual(value.status,'ready')

    def test_foreign_supplier_lookup_rejected_before_photo_read(self):
        with patch('lgent.client.request',return_value=[dict(ROW,supplier_id='OTHER')]):
            with self.assertRaises(client.LgError):client.info('token','TT0940306')

    def test_save_needs_confirmation_and_unique_trolleys(self):
        value=self.photo()
        self.assertEqual(self.api.post('/api/lgent/photos/save/',{'ids':[value.pk]},format='json').status_code,400)
        other=self.photo(suffix='other')
        response=self.api.post('/api/lgent/photos/save/',{'ids':[value.pk,other.pk],'confirmed':True},format='json')
        self.assertEqual(response.status_code,409)

    def test_stale_baseline_prevents_external_post(self):
        value=self.photo()
        with patch('lgent.client.info',return_value=dict(ROW,memo='changed')),patch('lgent.client.photo',return_value=b''),patch('lgent.client.request') as write:
            with self.assertRaises(client.LgError):service.save_one(self.user,value.pk)
        write.assert_not_called();value.refresh_from_db();self.assertEqual(value.status,'ready')

    def test_save_preserves_fields_and_verifies_readback(self):
        value=self.photo()
        with patch('lgent.client.info',side_effect=[copy.deepcopy(ROW),copy.deepcopy(ROW)]),patch('lgent.client.photo',side_effect=[b'',self.raw]),patch('lgent.client.request',return_value={'typeCode':True}) as write:
            result=service.save_one(self.user,value.pk)
        self.assertEqual(result['status'],'saved');payload=write.call_args.args[2]
        self.assertEqual(payload['com_code'],'LGETA');self.assertEqual(payload['org_code'],'ENT');self.assertEqual(payload['last_grade'],'B')
        self.assertEqual(payload['update_user_id'],'lg-user');self.assertEqual(base64.b64decode(payload['file_stream_bytes']),self.raw)
        self.assertTrue(LgentSaveEvent.objects.get(photo=value).photo_verified)
        self.cart.refresh_from_db();self.assertEqual(self.cart.save_attempt_id,'')

    def test_timeout_is_durable_uncertain_and_not_retried(self):
        value=self.photo()
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=b''),patch('lgent.client.request',side_effect=client.LgError('timeout')) as write:
            result=service.save_one(self.user,value.pk)
            with self.assertRaises(client.LgError):service.save_one(self.user,value.pk)
        self.assertEqual(result['status'],'uncertain');write.assert_called_once()
        self.cart.refresh_from_db();self.assertTrue(self.cart.save_attempt_id)

    def test_uncertain_write_can_be_read_back_without_second_post(self):
        value=self.photo()
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=b''),patch('lgent.client.request',side_effect=client.LgError('timeout')):
            service.save_one(self.user,value.pk)
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=self.raw),patch('lgent.client.request') as write:
            result=service.reconcile(self.user,value.pk)
        write.assert_not_called();self.assertTrue(result['verified'])
        value.refresh_from_db();self.assertEqual(value.status,'saved')
        self.cart.refresh_from_db();self.assertEqual(self.cart.save_attempt_id,'')

    def test_unmatched_readback_keeps_uncertain_lease(self):
        value=self.photo('uncertain');value.save_attempt_id='attempt';value.save()
        self.cart.save_attempt_id='attempt';self.cart.save()
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=b'other'),patch('lgent.client.request') as write:
            result=service.reconcile(self.user,value.pk)
        write.assert_not_called();self.assertFalse(result['verified'])
        self.cart.refresh_from_db();self.assertEqual(self.cart.save_attempt_id,'attempt')

    def test_cache_reader_cannot_erase_a_concurrent_write_lease(self):
        stale=LgentCart.objects.get(pk=self.cart.pk)
        LgentCart.objects.filter(pk=self.cart.pk).update(save_attempt_id='durable-current-attempt',save_started_at=timezone.now())
        with patch.object(LgentCart.objects,'get_or_create',return_value=(stale,False)):
            service.remember(copy.deepcopy(ROW))
        self.cart.refresh_from_db();self.assertEqual(self.cart.save_attempt_id,'durable-current-attempt')
        self.assertIsNotNone(self.cart.save_started_at)

    def test_cart_level_durable_lease_blocks_another_photo(self):
        value=self.photo();self.cart.save_attempt_id='another-attempt';self.cart.save()
        with patch('lgent.client.request') as write:
            with self.assertRaises(client.LgError):service.save_one(self.user,value.pk)
        write.assert_not_called()

    def test_remove_archives_own_photo_without_deleting_original(self):
        value=self.photo('pending');key=value.storage_key
        response=self.api.post(f'/api/lgent/photos/{value.pk}/remove/',{},format='json')
        self.assertEqual(response.status_code,200);value.refresh_from_db();self.assertIsNotNone(value.archived_at)
        self.assertEqual(media.read(key),self.raw)

    def test_login_reuses_issued_device_identifier(self):
        responses=[{'token':'new','user_info':{'userId':'canonical-id'}},'LGENT',[{'orgCode':'ENT'}],[{'supplier_code':'TT094'}],'RX']
        device=str(self.profile.device_id)
        with patch('lgent.client.request',side_effect=responses) as upstream:
            service.login(self.user,'typed-id','password')
        self.assertEqual(upstream.call_args_list[0].kwargs['payload']['DeviceId'],device)
        self.assertIn('/canonical-id/',upstream.call_args_list[2].args[0])

    def test_sync_pages_history_and_user_bound_cursor(self):
        with patch('lgent.client.request',return_value=[{'trolley_id':'TT0940306','supplier_id':'TT094','hms':'12:00'}]) as lg:
            result=service.sync(self.user)
            self.assertEqual(lg.call_count,3)
            for _ in range(9):result=service.sync(self.user,result['cursor'])
            self.assertEqual(lg.call_count,30)
        self.assertIsNotNone(result['cursor'])
        LgentProfile.objects.create(user=self.other,encrypted_token=encrypt_token('token'),expires_at=timezone.now()+dt.timedelta(hours=1))
        with self.assertRaises(client.LgError):service.sync(self.other,result['cursor'])
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)):
            final=service.sync(self.user,result['cursor'])
        self.assertEqual(final['remaining'],0);self.assertIsNotNone(final['cursor'])
        with patch('lgent.client.photo',return_value=self.raw):final=service.sync(self.user,final['cursor'])
        self.assertEqual(final['phase'],'photos');self.assertIsNone(final['cursor'])

    def test_foreign_supplier_recognition_is_review_and_removed_from_fleet(self):
        value=self.photo('recognized')
        with patch('lgent.client.info',side_effect=client.LgError('foreign','foreign_supplier',403)):
            self.assertEqual(service.verify(self.user,[value.pk]),{'verified':0})
        value.refresh_from_db();self.assertEqual(value.status,'review')
        self.assertEqual(service.workspace(self.user)['fleet'],[])

    def test_setting_validated(self):
        self.assertEqual(self.api.post('/api/lgent/settings/',{'staleDays':0},format='json').status_code,400)
        self.assertEqual(self.api.post('/api/lgent/settings/',{'staleDays':45},format='json').status_code,200)
        self.profile.refresh_from_db();self.assertEqual(self.profile.stale_days,45)

    def test_worker_image_requires_worker_token_and_current_lease(self):
        value=self.photo('pending');service.analyze(self.user,[value.pk]);value.refresh_from_db()
        job=value.job;job.status='running';job.claimed_by='worker';job.claimed_at=timezone.now();job.save()
        api=APIClient();url=f'/api/lgent/worker/photos/{value.pk}/?job_id={job.pk}'
        self.assertEqual(api.get(url).status_code,403)
        headers={'HTTP_X_AI_WORKER_TOKEN':'isolated-worker-token','HTTP_X_AI_WORKER_NAME':'wrong','HTTP_X_AI_CLAIM_TIMESTAMP':job.claimed_at.isoformat()}
        self.assertEqual(api.get(url,**headers).status_code,403)
        headers['HTTP_X_AI_WORKER_NAME']='worker'
        response=api.get(url,**headers);self.assertEqual(response.status_code,200);self.assertTrue(response.data['photoData'].startswith('data:image/jpeg;'))

    def test_worker_claim_complete_returns_recognized_without_lg_write(self):
        value=self.photo('pending');service.analyze(self.user,[value.pk])
        worker=APIClient();headers={'HTTP_X_AI_WORKER_TOKEN':'isolated-worker-token'}
        claim=worker.post('/api/ai/jobs/claim/',{'worker_name':'test-lgent','worker_version':'production-ai-worker-v2','available_model_ids':['qwen38'],'job_types':['lgent_trolley_photo'],'limit':1},format='json',**headers)
        self.assertEqual(claim.status_code,200);job=claim.data['jobs'][0]
        payload={'worker_name':'test-lgent','claim_timestamp':job['claimed_at']}
        started=worker.post(f'/api/ai/jobs/{job["id"]}/start/',payload,format='json',**headers);self.assertEqual(started.status_code,200)
        with patch('lgent.client.request') as write:
            completed=worker.post(f'/api/ai/jobs/{job["id"]}/complete/',{**payload,'prompt_version':service.PROMPT,'model_name':'Qwen3.8-27B-4bit','result_payload':{'primary_id':'TT0940306','uncertain':False,'local_evidence':[{'id':'TT0940306','confidence':1}]}},format='json',**headers)
        self.assertEqual(completed.status_code,200);value.refresh_from_db();self.assertEqual(value.status,'recognized');write.assert_not_called()

    def test_generic_worker_cannot_accidentally_claim_trolley_jobs(self):
        value=self.photo('pending');service.analyze(self.user,[value.pk])
        worker=APIClient()
        claim=worker.post('/api/ai/jobs/claim/',{'worker_name':'generic','worker_version':'production-ai-worker-v2','available_model_ids':['qwen38'],'limit':1},format='json',HTTP_X_AI_WORKER_TOKEN='isolated-worker-token')
        self.assertEqual(claim.status_code,200);self.assertEqual(claim.data['jobs'],[])

    def test_worker_fail_records_retryable_photo_error(self):
        value=self.photo('pending');service.analyze(self.user,[value.pk]);value.refresh_from_db();job=value.job
        job.status='running';job.claimed_by='test-lgent';job.claimed_at=timezone.now();job.save()
        worker=APIClient();response=worker.post(f'/api/ai/jobs/{job.pk}/fail/',{'worker_name':'test-lgent','claim_timestamp':job.claimed_at.isoformat(),'error_message':'TimeoutError'},format='json',HTTP_X_AI_WORKER_TOKEN='isolated-worker-token')
        self.assertEqual(response.status_code,200);value.refresh_from_db();self.assertEqual(value.status,'error')

    def test_correct_saved_number_preserves_original_write_history(self):
        for status in ('saved','accepted'):
            with self.subTest(status=status):
                value=self.photo(status,suffix=status);value.save_attempt_id='attempt-'+status;value.saved_at=timezone.now();value.save()
                event=LgentSaveEvent.objects.create(user=self.user,photo=value,trolley_id=value.trolley_id,
                    attempt_id=value.save_attempt_id,outcome=status)
                target=dict(ROW,trolley_id='TT0940223')
                with patch('lgent.client.info',return_value=target),patch('lgent.client.photo',return_value=b''),patch('lgent.client.request') as write:
                    response=self.api.post(f'/api/lgent/photos/{value.pk}/match/',{'trolleyId':'TT0940223','confirmed':True},format='json')
                self.assertEqual(response.status_code,200);write.assert_not_called()
                value.refresh_from_db();event.refresh_from_db()
                self.assertEqual(value.trolley_id,'TT0940223');self.assertEqual(value.status,'ready')
                self.assertEqual(value.save_attempt_id,'');self.assertIsNone(value.saved_at)
                self.assertEqual(event.trolley_id,ROW['trolley_id']);self.assertEqual(event.outcome,status)

    def test_submitted_number_correction_cannot_clear_unresolved_write(self):
        value=self.photo('uncertain');value.save_attempt_id='pending-attempt';value.save()
        self.cart.save_attempt_id=value.save_attempt_id;self.cart.save()
        for status in ('saving','uncertain','accepted','saved'):
            value.status=status;value.save()
            with patch('lgent.client.info',return_value=dict(ROW,trolley_id='TT0940223')),patch('lgent.client.photo',return_value=b''),patch('lgent.client.request') as write:
                response=self.api.post(f'/api/lgent/photos/{value.pk}/match/',{'trolleyId':'TT0940223','confirmed':True},format='json')
            self.assertEqual(response.status_code,409);write.assert_not_called()
            value.refresh_from_db();self.cart.refresh_from_db()
            self.assertEqual(value.trolley_id,ROW['trolley_id']);self.assertEqual(value.save_attempt_id,'pending-attempt')
            self.assertEqual(self.cart.save_attempt_id,'pending-attempt')

    def test_saved_number_correction_requires_new_number_and_confirmation(self):
        value=self.photo('saved')
        for number,confirmed in ((ROW['trolley_id'],True),('TT0940223',False)):
            with patch('lgent.client.info') as info:
                response=self.api.post(f'/api/lgent/photos/{value.pk}/match/',{'trolleyId':number,'confirmed':confirmed},format='json')
            self.assertIn(response.status_code,(400,409));info.assert_not_called()

    def test_manual_match_cancels_outstanding_ai_job(self):
        value=self.photo('pending');service.analyze(self.user,[value.pk]);value.refresh_from_db();job=value.job
        with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=b''):
            matched=service.match(self.user,value,'TT0940306',True)
        self.assertEqual(matched.status,'ready');job.refresh_from_db();self.assertEqual(job.status,'cancelled')

from django.db import transaction
transaction_for_test=transaction.atomic

from unittest import skipUnless
from django.db import connection,connections
from django.test import TransactionTestCase
import threading,time


@skipUnless(connection.vendor=='postgresql','PostgreSQL row-lock acceptance only')
class LgentPostgresLockTests(TransactionTestCase):
    def test_mirror_claim_is_nonblocking_across_connections_and_released(self):
        started=threading.Event();release=threading.Event();state={}
        def collector():
            try:
                with mirror.claim('TT0940306') as acquired:
                    state['acquired']=acquired;started.set();release.wait(5)
            except BaseException as error:state['error']=error;started.set()
            finally:connections.close_all()
        thread=threading.Thread(target=collector,daemon=True);thread.start()
        try:
            self.assertTrue(started.wait(3));self.assertTrue(state.get('acquired'))
            with mirror.claim('TT0940306') as acquired:self.assertFalse(acquired)
        finally:release.set();thread.join(5)
        self.assertFalse(thread.is_alive())
        if 'error' in state:raise state['error']
        with mirror.claim('TT0940306') as acquired:self.assertTrue(acquired)

    def test_manual_match_and_archive_follow_worker_lock_order(self):
        user=get_user_model().objects.create_user(username='pg-operator',is_staff=True)
        LgentProfile.objects.create(user=user,encrypted_token=encrypt_token('synthetic-token'),lg_user_id='pg',current_company='LGENT',expires_at=timezone.now()+dt.timedelta(hours=1))
        service.remember(copy.deepcopy(ROW))
        for action in ('match','archive'):
            with self.subTest(action=action):
                job=AiJob.objects.create(job_type=service.PHOTO_JOB,created_by=user,status='running')
                value=LgentPhoto.objects.create(user=user,job=job,filename=action+'.jpg',sha256=action,storage_key='synthetic',byte_size=1,status='queued',trolley_id=ROW['trolley_id'])
                started=threading.Event();state={}
                def operator():
                    try:
                        with connections['default'].cursor() as cursor:
                            cursor.execute('SELECT pg_backend_pid()');state['pid']=cursor.fetchone()[0]
                        started.set()
                        actor=get_user_model().objects.get(pk=user.pk)
                        if action=='match':
                            photo=LgentPhoto.objects.get(pk=value.pk)
                            service.match(actor,photo,ROW['trolley_id'],True)
                        else:
                            api=APIClient();api.force_authenticate(actor)
                            response=api.post(f'/api/lgent/photos/{value.pk}/remove/',{},format='json')
                            if response.status_code!=200:raise AssertionError(response.status_code)
                    except BaseException as error:state['error']=error
                    finally:connections.close_all()
                thread=threading.Thread(target=operator,daemon=True)
                with patch('lgent.client.info',return_value=copy.deepcopy(ROW)),patch('lgent.client.photo',return_value=b''):
                    try:
                        with transaction.atomic():
                            AiJob.objects.select_for_update().get(pk=job.pk)
                            thread.start();self.assertTrue(started.wait(3))
                            deadline=time.monotonic()+5;waiting=False
                            while time.monotonic()<deadline:
                                with connection.cursor() as cursor:
                                    cursor.execute('SELECT pg_stat_clear_snapshot()')
                                    cursor.execute('SELECT wait_event_type FROM pg_stat_activity WHERE pid=%s',[state['pid']])
                                    row=cursor.fetchone()
                                if row and row[0]=='Lock':waiting=True;break
                                if 'error' in state:raise state['error']
                                time.sleep(.01)
                            self.assertTrue(waiting,'Operator should wait on the worker-owned job lock')
                            # A Photo-first path would already hold this row and
                            # deadlock once the worker tries to finish its job.
                            LgentPhoto.objects.select_for_update(nowait=True).get(pk=value.pk)
                    finally:
                        thread.join(5)
                    self.assertFalse(thread.is_alive())
                    if 'error' in state:raise state['error']
