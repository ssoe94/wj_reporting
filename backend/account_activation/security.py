"""Protect early CSRF/error paths too. Ingress body logging stays a release gate."""
from django.http import HttpResponse


PUBLIC_PREFIX = '/accounts/activate/'
ADMIN_PREFIX = '/admin/account_activation/'


class ActivationBoundaryMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        protected = request.path.startswith((PUBLIC_PREFIX, ADMIN_PREFIX))
        if protected:
            request.sensitive_post_parameters = '__ALL__'
            request.activation_query_present = bool(request.META.get('QUERY_STRING'))
            request.META['QUERY_STRING'] = ''
            for name in ('RAW_URI', 'REQUEST_URI', 'HTTP_REFERER'):
                if name in request.META:
                    request.META[name] = request.META[name].split('?', 1)[0].split('#', 1)[0]
            request.__dict__.pop('GET', None)
        response = self.get_response(request)
        if protected:
            if response.status_code >= 400:
                # A generic response also covers rejected CSRF and parser errors.
                response = HttpResponse('요청을 처리할 수 없습니다.', status=response.status_code,
                                        content_type='text/plain; charset=utf-8')
            response['Cache-Control'] = 'no-store, max-age=0'
            response['Referrer-Policy'] = 'strict-origin'
            response['X-Content-Type-Options'] = 'nosniff'
            response['X-Frame-Options'] = 'DENY'
            response['Content-Security-Policy'] = (
                "default-src 'none'; script-src 'self'; style-src 'self'; "
                "connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'")
        return response
