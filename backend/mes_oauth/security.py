"""Application log protection; ingress query redaction is a deployment gate."""
import logging
import re


PREFIX = '/integrations/blacklake/'


class OAuthQueryRedactionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(PREFIX):
            # Cover errors raised by middleware before view decorators execute.
            request.sensitive_post_parameters = '__ALL__'
            # The callback page handles code in browser memory. Django never
            # needs its query, including on authentication/CSRF error paths.
            request.META['QUERY_STRING'] = ''
            for field in ('RAW_URI', 'REQUEST_URI'):
                if field in request.META:
                    request.META[field] = request.META[field].split('?', 1)[0]
            request.__dict__.pop('GET', None)
        response = self.get_response(request)
        if request.path.startswith(PREFIX):
            # Cover CSRF/method/auth failures emitted before the actual view.
            response['Cache-Control'] = 'no-store, max-age=0'
            response['Referrer-Policy'] = 'no-referrer'
            response['X-Content-Type-Options'] = 'nosniff'
            response['X-Frame-Options'] = 'DENY'
        return response


class OAuthQueryLogFilter(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        record.msg = re.sub(r'(/integrations/blacklake/[^\s?"\'<>]*)\?[^\s"\'<>]*',
                            r'\1?[redacted]', message)
        record.args = ()
        return True
