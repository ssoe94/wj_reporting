"""Application log protection; ingress query redaction is a deployment gate."""
import logging
import re


PREFIX = '/integrations/blacklake/'
# Native HTML form POSTs use Origin:null under no-referrer. Keep their exact
# HTTPS Origin for CSRF checks while never sending a path/query as Referer.
REFERRER_POLICY = 'strict-origin'
QUERY_URL = re.compile(r'(/integrations/blacklake/[^\s?"\'<>]*)\?[^\s"\'<>]*')


def _redact_query(value):
    return QUERY_URL.sub(r'\1?[redacted]', value)


class OAuthQueryRedactionMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if request.path.startswith(PREFIX):
            # Cover errors raised by middleware before view decorators execute.
            request.sensitive_post_parameters = '__ALL__'
            # The callback page handles code in browser memory. Django never
            # needs its query, including on authentication/CSRF error paths.
            request.mes_oauth_query_present = bool(request.META.get('QUERY_STRING'))
            request.META['QUERY_STRING'] = ''
            for field in ('RAW_URI', 'REQUEST_URI', 'HTTP_REFERER'):
                if field in request.META:
                    request.META[field] = request.META[field].split('?', 1)[0].split('#', 1)[0]
            request.__dict__.pop('GET', None)
        response = self.get_response(request)
        if request.path.startswith(PREFIX):
            # Cover CSRF/method/auth failures emitted before the actual view.
            response['Cache-Control'] = 'no-store, max-age=0'
            response['Referrer-Policy'] = REFERRER_POLICY
            response['X-Content-Type-Options'] = 'nosniff'
            response['X-Frame-Options'] = 'DENY'
        return response


class OAuthQueryLogFilter(logging.Filter):
    def filter(self, record):
        record.msg = _redact_query(record.getMessage())
        record.args = ()
        # Formatters append exception and stack text after formatting msg.
        # Materialize and redact it here, including chained exceptions, before
        # any handler can append the original exception tuple again.
        if record.exc_info:
            record.exc_text = _redact_query(logging.Formatter().formatException(record.exc_info))
            record.exc_info = None
        elif record.exc_text:
            record.exc_text = _redact_query(record.exc_text)
        if record.stack_info:
            record.stack_info = _redact_query(record.stack_info)
        return True
