"""Session/CSRF administrator issuance and anonymous, CSRF-bound self activation."""
from urllib.parse import urlsplit
from pathlib import Path

from django.conf import settings
from django.http import HttpResponse, JsonResponse
from django.shortcuts import render
from django.views.decorators.csrf import csrf_protect, ensure_csrf_cookie
from django.views.decorators.debug import sensitive_post_parameters, sensitive_variables
from django.views.decorators.http import require_http_methods

from mes_oauth.connection_views import BRIDGE_ONLY, secure_request
from . import services


def boundary_ready(request):
    origin = getattr(settings, 'ACCOUNT_ACTIVATION_ORIGIN', '')
    parsed = urlsplit(origin)
    return (services.enabled() and secure_request(request)
        and parsed.scheme == 'https' and parsed.netloc and not parsed.username
        and not parsed.password and not parsed.path and not parsed.query and not parsed.fragment
        and request.build_absolute_uri('/').rstrip('/') == origin
        and not getattr(request, 'activation_query_present', False)
        and not request.META.get('HTTP_AUTHORIZATION')
        and (request.method == 'GET' or request.headers.get('Origin') == origin))


def deny(status=403):
    return HttpResponse('요청을 처리할 수 없습니다.', status=status)


@require_http_methods(['GET'])
def asset(request, name):
    # Fixed same-origin backend routes: no reliance on a separate static service.
    if not boundary_ready(request) or name not in {'activate.js', 'issue.js', 'activation.css'}:
        return deny()
    source = Path(__file__).parent / 'static' / 'account_activation' / name
    return HttpResponse(source.read_bytes(), content_type=(
        'text/css; charset=utf-8' if name.endswith('.css') else 'text/javascript; charset=utf-8'))


@sensitive_variables()
@sensitive_post_parameters()
@csrf_protect
@ensure_csrf_cookie
@require_http_methods(['GET', 'POST'])
def activate(request):
    if not boundary_ready(request):
        return deny()
    if request.method == 'GET':
        return render(request, 'account_activation/activate.html')
    # Only bounded form bodies; no JSON decoder whose errors could quote input.
    if request.content_type != 'application/x-www-form-urlencoded':
        return deny(400)
    try:
        if int(request.META.get('CONTENT_LENGTH') or 0) > 4096:
            return deny(400)
        services.rate_action('consume', source=request.META.get('REMOTE_ADDR'))
        token = request.POST.get('token', '')
        match = services.TOKEN_PATTERN.fullmatch(token)
        if match and not services.take_rate('consume-selector', match[1], 8):
            raise services.ActivationBlocked('rate_limited')
        if set(request.POST) != {'token', 'password', 'confirmation'} or any(
                len(request.POST.getlist(name)) != 1 for name in request.POST):
            return deny(400)
        services.activate(token, request.POST['password'], request.POST['confirmation'])
        return JsonResponse({'status': 'activated'})
    except services.ActivationBlocked as error:
        reason = str(error)
        if reason == 'password_invalid':
            return JsonResponse({'status': 'password_invalid'})
        return deny(429 if reason == 'rate_limited' else 400)
    except Exception:
        # Never render or log arbitrary exception text with credential locals.
        return deny(503)


@sensitive_variables()
@sensitive_post_parameters()
@csrf_protect
@ensure_csrf_cookie
@require_http_methods(['GET', 'POST'])
def issue(request):
    if (not boundary_ready(request) or not services.administrator(request.user)
            or request.session.get(BRIDGE_ONLY)):
        return deny()
    context = {'title': '최초 비밀번호 설정 링크', 'result': '', 'activation_link': ''}
    try:
        context['targets'] = services.approved_targets()
        if request.method == 'POST':
            if request.content_type != 'application/x-www-form-urlencoded' or int(
                    request.META.get('CONTENT_LENGTH') or 0) > 4096:
                return deny(400)
            if set(request.POST) != {'csrfmiddlewaretoken', 'target', 'action', 'confirmed'} or any(
                    len(request.POST.getlist(name)) != 1 for name in request.POST):
                return deny(400)
            target = request.POST.get('target', '')
            if target not in context['targets'] or request.POST.get('confirmed') != 'yes':
                return deny(400)
            services.rate_action('issue', source=request.META.get('REMOTE_ADDR'),
                                 actor=request.user.pk, target=target)
            if request.POST.get('action') == 'revoke':
                services.revoke(request.user.pk, int(target))
                context['result'] = '기존 미사용 링크를 취소했습니다. 새 발급은 별도로 실행하세요.'
            elif request.POST.get('action') == 'issue':
                grant = services.issue(request.user.pk, int(target))
                context['activation_link'] = settings.ACCOUNT_ACTIVATION_ORIGIN + '/accounts/activate/#' + grant.token
                context['expires_at'] = grant.expires_at
                context['result'] = '본인 확인 후 승인된 비공개 경로로 전달하세요. 링크는 이 응답에서 한 번만 표시됩니다.'
            else:
                return deny(400)
        return render(request, 'account_activation/issue.html', context)
    except services.ActivationBlocked as error:
        if str(error) == 'pending_grant_exists':
            context['result'] = '사용하지 않은 링크가 있습니다. 분실했다면 먼저 취소한 뒤 새로 발급하세요.'
            return render(request, 'account_activation/issue.html', context)
        return deny(429 if str(error) == 'rate_limited' else 400)
    except Exception:
        return deny(503)
