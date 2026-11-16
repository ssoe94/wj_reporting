"""Read-only loopback status and SSE for the portable operator screen."""

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


_DEFAULT_PORT = 8769
_STATIC_ROOT = Path(__file__).resolve().parent / 'static'
_ASSETS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/agent.css': ('agent.css', 'text/css; charset=utf-8'),
    '/agent.js': ('agent.js', 'text/javascript; charset=utf-8'),
}
_SESSION_HEADER = 'X-WJ-Local'
_SSE_CLIENTS = 4


def _fields(source, names):
    """Copy only the scalar fields declared in the local status contract."""
    return {
        name: source[name] for name in names
        if isinstance(source, dict) and name in source
        and type(source[name]) in (str, int, bool, float, type(None))
    }


def _status_bytes(snapshot):
    # A caller's extra state can contain install details. Never serve it wholesale.
    public = _fields(snapshot, (
        'station_id', 'agent_version', 'clock_offset_seconds', 'heartbeat_error',
    ))
    public['apps'] = [
        _fields(app, ('app', 'version', 'state', 'mode', 'last_work_at'))
        for app in (snapshot.get('apps') or [])
    ]
    public['devices'] = [
        _fields(device, ('app', 'device', 'state', 'last_input_at'))
        for device in (snapshot.get('devices') or [])
    ]
    public['outbox'] = _fields(snapshot.get('outbox'), (
        'pending_count', 'oldest_occurred_at', 'last_ack_at', 'state', 'last_error_code', 'coverage',
    ))
    public['backup'] = _fields(snapshot.get('backup'), ('state', 'finished_at', 'reason'))
    return json.dumps(public, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


class _Server(ThreadingHTTPServer):
    request_queue_size = 12

    def __init__(self, port, snapshot):
        self.snapshot = snapshot
        self.stopping = threading.Event()
        # Leave room for assets/JSON even when the SSE slots are occupied.
        self.request_slots = threading.BoundedSemaphore(16)
        self.stream_slots = threading.BoundedSemaphore(_SSE_CLIENTS)
        self.assets = {
            route: ((_STATIC_ROOT / name).read_bytes(), media_type)
            for route, (name, media_type) in _ASSETS.items()
        }
        super().__init__(('127.0.0.1', port), _Handler)
        bound_port = self.server_address[1]
        self.hosts = ('127.0.0.1', '127.0.0.1:80') if bound_port == 80 else ('127.0.0.1:{}'.format(bound_port),)
        self.origin = 'http://{}'.format(self.hosts[0])

    def get_request(self):
        client, address = super().get_request()
        client.settimeout(5)
        return client, address

    def process_request(self, request, client_address):
        if not self.request_slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self.request_slots.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.request_slots.release()

    def handle_error(self, request, client_address):
        # The public state and the kiosk output must not include request or exception details.
        pass


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        # The browser never needs request logs, and the kiosk can stay quiet.
        pass

    def _headers(self, status, media_type, length=None):
        self.send_response(status)
        self.send_header('Content-Type', media_type)
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        if status == 405:
            self.send_header('Allow', 'GET, HEAD')
        self.end_headers()

    def _send(self, status, body, media_type='text/plain; charset=utf-8'):
        self._headers(status, media_type, len(body))
        if self.command != 'HEAD':
            self.wfile.write(body)

    def _allowed(self, mutation=False):
        hosts = self.headers.get_all('Host') or []
        origins = self.headers.get_all('Origin') or []
        sites = self.headers.get_all('Sec-Fetch-Site') or []
        if len(hosts) != 1 or hosts[0] not in self.server.hosts:
            self._send(403, b'Invalid Host')
            return False
        if ((origins and origins != [self.server.origin])
                or (sites and sites not in (['same-origin'], ['none']))):
            self._send(403, b'Invalid Origin')
            return False
        if mutation and (
            origins != [self.server.origin] or self.headers.get_all(_SESSION_HEADER) != ['1']
        ):
            self._send(403, b'Local request header and Origin required')
            return False
        return True

    def parse_request(self):
        if not super().parse_request():
            return False
        return self._allowed(mutation=self.command not in ('GET', 'HEAD'))

    def do_GET(self):
        route = self.path.partition('?')[0]
        if route in self.server.assets:
            data, media_type = self.server.assets[route]
            self._send(200, data, media_type)
        elif route == '/api/status':
            try:
                data = _status_bytes(self.server.snapshot())
            except (AttributeError, TypeError, ValueError):
                self._send(503, b'Local status unavailable')
                return
            self._send(200, data, 'application/json; charset=utf-8')
        elif route == '/api/events':
            if self.command == 'HEAD':
                self._send(405, b'GET required')
            else:
                self._stream()
        else:
            self._send(404, b'Not found')

    do_HEAD = do_GET

    def _mutation(self):
        # Future app routes pass the same parse-time guard before processing their body.
        self._send(405, b'Local status is read only')

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_TRACE = do_CONNECT = _mutation

    def _stream(self):
        if not self.server.stream_slots.acquire(blocking=False):
            self._send(503, b'Too many local streams')
            return
        try:
            self._headers(200, 'text/event-stream; charset=utf-8')
            previous = None
            keepalive = time.monotonic()
            while not self.server.stopping.is_set():
                state = _status_bytes(self.server.snapshot())
                now = time.monotonic()
                if state != previous:
                    self.wfile.write(b'data: ' + state + b'\n\n')
                    self.wfile.flush()
                    previous = state
                    keepalive = now + 15
                elif now >= keepalive:
                    self.wfile.write(b': keepalive\n\n')
                    self.wfile.flush()
                    keepalive = now + 15
                self.server.stopping.wait(1)
        except (OSError, AttributeError, TypeError, ValueError):
            # The browser reconnects when the stream closes.
            pass
        finally:
            self.server.stream_slots.release()


class LocalUI:
    """Run the static status shell using a fast, cached snapshot callback."""

    def __init__(self, snapshot, host='127.0.0.1', port=_DEFAULT_PORT):
        if host != '127.0.0.1':
            raise ValueError('Local UI requires 127.0.0.1')
        if type(port) is not int or not 0 <= port <= 65535:
            raise ValueError('Invalid loopback UI port')
        self._snapshot = snapshot
        self._requested_port = port
        self._server = None
        self._thread = None

    @property
    def port(self):
        if self._server is not None:
            return self._server.server_address[1]
        return self._requested_port

    def start(self):
        if self._server is None:
            server = _Server(self._requested_port, self._snapshot)
            thread = threading.Thread(
                target=server.serve_forever, kwargs={'poll_interval': 0.5},
                name='field-agent-ui', daemon=True,
            )
            try:
                thread.start()
            except BaseException:
                server.server_close()
                raise
            self._server, self._thread = server, thread
        return self

    def stop(self):
        if self._server is None:
            return
        self._server.stopping.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join()
        self._server, self._thread = None, None
