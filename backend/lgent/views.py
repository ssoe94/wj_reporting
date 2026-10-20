import hashlib
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.http import HttpResponse
from django.utils import timezone
from django.utils.dateparse import parse_datetime
from rest_framework.response import Response
from rest_framework.views import APIView
from ai_core.views import HasWorkerToken,AiWorkerJobTransitionView
from ai_core.models import AiJob
from . import service,client,media
from .models import LgentProfile,LgentPhoto,LgentCart
from .security import LgentAccess


class LgentView(APIView):
    permission_classes=[LgentAccess]
    edit_action=False

    def handle_exception(self,error):
        if isinstance(error,client.LgError):
            if error.code=='lg_connection_required' and self.request.user.is_authenticated:
                LgentProfile.objects.filter(user=self.request.user).update(encrypted_token='',expires_at=None)
            return Response({'detail':str(error),'code':error.code},status=error.status)
        return super().handle_exception(error)


class WorkspaceView(LgentView):
    def get(self,request):return Response(service.workspace(request.user))


class ShipmentsView(LgentView):
    def get(self,request):
        from .shipments import overview
        return Response(overview(request.user,request.query_params))


class LoginView(LgentView):
    def post(self,request):return Response(service.login(request.user,request.data.get('userId'),request.data.get('password')))


class LogoutView(LgentView):
    def post(self,request):
        LgentProfile.objects.filter(user=request.user).update(encrypted_token='',expires_at=None,lg_user_id='',lg_user_name='')
        return Response({'connected':False})


class SettingsView(LgentView):
    def post(self,request):
        days=request.data.get('staleDays')
        if type(days) is not int or not 1<=days<=365:raise client.LgError('알림 기준은 1~365일로 입력하세요.','invalid_setting',400)
        value=service.profile(request.user,True);value.stale_days=days;value.save(update_fields=['stale_days','updated_at'])
        return Response({'staleDays':days})


class SyncView(LgentView):
    def post(self,request):return Response(service.sync(request.user,request.data.get('cursor')))


class LookupView(LgentView):
    def post(self,request):return Response(service.lookup(request.user,request.data.get('trolleyId')))


class CartPhotoView(LgentView):
    def get(self,request,trolley_id):
        version=service.cached_cart_version(request.user,trolley_id)
        if version and request.query_params.get('v')==version and etag_matches(request,version):
            return image_response(request,b'cached',version,not_modified=True)
        raw,version=service.cart_image(request.user,trolley_id,thumbnail=request.query_params.get('size')=='thumbnail')
        return image_response(request,raw,version)


class PhotoUploadView(LgentView):
    edit_action=True
    def post(self,request):
        file=request.FILES.get('file')
        if not file:raise client.LgError('사진 파일을 선택하세요.','invalid_photo',400)
        return Response(service.public_photo(service.upload(request.user,file)),status=201)


class PhotoImageView(LgentView):
    def get(self,request,pk):
        value=get_object_or_404(LgentPhoto,user=request.user,pk=pk,archived_at__isnull=True)
        raw=media.read(value.storage_key)
        if request.query_params.get('size')=='thumbnail':raw=media.thumbnail(raw)
        return image_response(request,raw,value.sha256)


def image_etag(request,version):
    rendition='thumbnail-v2' if request.query_params.get('size')=='thumbnail' else 'original'
    return '"'+hashlib.sha256((version+':'+rendition).encode()).hexdigest()+'"'


def etag_matches(request,version):
    matches=[part.strip().removeprefix('W/') for part in request.headers.get('If-None-Match','').split(',')]
    return image_etag(request,version) in matches or '*' in matches


def image_response(request,raw,version,not_modified=False):
    if not raw:
        response=HttpResponse(status=204);response['Cache-Control']='private, no-store';response.lgent_private_image=True;return response
    etag=image_etag(request,version)
    response=HttpResponse(status=304) if not_modified or etag_matches(request,version) else HttpResponse(raw,content_type='image/png' if raw.startswith(b'\x89PNG') else 'image/jpeg')
    response.lgent_private_image=True
    response['ETag']=etag
    response['Cache-Control']='private, max-age=86400' if request.query_params.get('v')==version else 'private, no-cache'
    response['Vary']='Authorization, Cookie'
    response['X-Content-Type-Options']='nosniff'
    return response


class AnalyzeView(LgentView):
    edit_action=True
    def post(self,request):return Response(service.analyze(request.user,request.data.get('ids')))


class VerifyView(LgentView):
    edit_action=True
    def post(self,request):return Response(service.verify(request.user,request.data.get('ids')))


class MatchView(LgentView):
    edit_action=True
    def post(self,request,pk):
        value=get_object_or_404(LgentPhoto,user=request.user,pk=pk,archived_at__isnull=True)
        return Response(service.public_photo(service.match(request.user,value,request.data.get('trolleyId'),request.data.get('confirmed'))))


class SaveView(LgentView):
    edit_action=True
    def post(self,request):
        if request.data.get('confirmed') is not True:raise client.LgError('사진과 번호를 확인한 뒤 저장하세요.','confirmation_required',400)
        photos=service.owned_photos(request.user,request.data.get('ids'),limit=5)
        if len({photo.trolley_id for photo in photos})!=len(photos):raise client.LgError('같은 대차의 사진은 1장씩 선택하세요.','duplicate_trolley',409)
        if any(photo.status!='ready' for photo in photos):raise client.LgError('번호 대조가 완료된 사진만 저장하세요.','not_ready',409)
        results=[]
        for photo in photos:
            try:results.append(service.save_one(request.user,photo.pk))
            except client.LgError as error:results.append({'id':photo.pk,'status':'review','message':str(error),'code':error.code})
        return Response({'results':results})


class ReconcileView(LgentView):
    edit_action=True
    def post(self,request,pk):
        get_object_or_404(LgentPhoto,user=request.user,pk=pk,archived_at__isnull=True)
        return Response(service.reconcile(request.user,pk))


class RemoveView(LgentView):
    edit_action=True
    def post(self,request,pk):
        snapshot=get_object_or_404(LgentPhoto,user=request.user,pk=pk,archived_at__isnull=True)
        with transaction.atomic():
            if snapshot.job_id:AiJob.objects.select_for_update().filter(pk=snapshot.job_id).first()
            value=get_object_or_404(LgentPhoto.objects.select_for_update(),user=request.user,pk=pk,archived_at__isnull=True)
            if value.job_id!=snapshot.job_id:raise client.LgError('분석 작업이 변경됐습니다. 다시 조회하세요.','photo_conflict',409)
            if value.status=='saving':raise client.LgError('저장 중인 사진은 처리 후 제외하세요.','busy',409)
            if value.job_id:AiJob.objects.filter(pk=value.job_id,status__in=('pending','claimed','running')).update(status='cancelled')
            value.archived_at=timezone.now();value.save(update_fields=['archived_at','updated_at'])
        return Response({'removed':True})


class WorkerPhotoView(APIView):
    authentication_classes=[]
    permission_classes=[HasWorkerToken]
    def get(self,request,pk):
        value=get_object_or_404(LgentPhoto,pk=pk,archived_at__isnull=True)
        job=get_object_or_404(AiJob,pk=request.query_params.get('job_id'),job_type=service.PHOTO_JOB,created_by_id=value.user_id)
        if value.job_id!=job.pk or job.scope.get('photo_id')!=value.pk or job.status not in ('claimed','running'):
            return Response({'detail':'The photo is not bound to this active lease.'},status=409)
        stamp=parse_datetime(request.headers.get('X-AI-CLAIM-TIMESTAMP',''))
        AiWorkerJobTransitionView().assert_claim_lease(job,{'worker_name':request.headers.get('X-AI-WORKER-NAME',''),'claim_timestamp':stamp})
        raw=media.read(value.storage_key)
        if hashlib.sha256(raw).hexdigest()!=value.sha256:return Response({'detail':'Photo digest mismatch.'},status=409)
        return Response(service.data_image(raw))
