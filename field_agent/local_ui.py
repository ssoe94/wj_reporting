"""Loopback operator screen, status stream and local app controls."""

import json
import shutil
import sqlite3
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

from .config import LANGUAGES


_DEFAULT_PORT = 8769
_STATIC_ROOT = Path(__file__).resolve().parent / 'static'
_ASSETS = {
    '/': ('index.html', 'text/html; charset=utf-8'),
    '/agent.css': ('agent.css', 'text/css; charset=utf-8'),
    '/compact.css': ('compact.css', 'text/css; charset=utf-8'),
    '/agent.js': ('agent.js', 'text/javascript; charset=utf-8'),
    '/barcode.js': ('barcode.js', 'text/javascript; charset=utf-8'),
    '/weigh.js': ('weigh.js', 'text/javascript; charset=utf-8'),
}
_SESSION_HEADER = 'X-WJ-Local'
_LANGUAGE = '/api/language/'
_NO_SCRIPT = {
    'ko': '상태 화면을 사용하려면 JavaScript를 켜세요.',
    'zh': '请启用 JavaScript 查看状态。',
}
_SSE_CLIENTS = 4
_BARCODE_ACTIONS = {
    '/api/barcode/reset/': 'reset',
    '/api/barcode/mode/': 'mode',
    '/api/barcode/config/': 'config',
}
_BARCODE_CSV = '/api/barcode/export.csv'
_WEIGH_ACTIONS = {
    '/api/weigh/product/': 'product',
    '/api/weigh/template/': 'template',
    '/api/weigh/pause/': 'pause',
    '/api/weigh/cancel_waiting/': 'cancel_waiting',
    '/api/weigh/reread/': 'reread',
    '/api/weigh/resume/': 'resume',
    '/api/weigh/acknowledge/': 'acknowledge',
    '/api/weigh/flush/': 'flush',
    '/api/weigh/peel/': 'peel',
}
_MAX_ACTION_BYTES = 2048
_CSV_COPY_BYTES = 65536
_LANES = ('A', 'B')


def _fields(source, names):
    """Copy only the scalar fields declared in the local status contract."""
    return {
        name: source[name] for name in names
        if isinstance(source, dict) and name in source
        and type(source[name]) in (str, int, bool, float, type(None))
    }


def _barcode_status(source):
    public = _fields(source, ('mode', 'production_group', 'reset_id', 'storage_error'))
    public['groups'] = [group for group in source.get('groups', []) if type(group) is str]
    public['assignments'] = _fields(source.get('assignments'), _LANES)
    public['ports'] = [_fields(port, ('id', 'label')) for port in source.get('ports', [])]
    public['lanes'] = {}
    for name in _LANES:
        lane = (source.get('lanes') or {}).get(name) or {}
        item = _fields(lane, ('connected', 'last_input_at', 'port'))
        item['counts'] = _fields(lane.get('counts'), ('ok', 'duplicate', 'error'))
        item['frame_errors'] = _fields(lane.get('frame_errors'), ('decode', 'partial', 'oversize'))
        item['recent'] = [
            _fields(record, ('seq', 'time', 'barcode', 'status')) for record in lane.get('recent', [])
        ]
        public['lanes'][name] = item
    public['alert'] = _fields(source.get('alert'), ('seq', 'status')) or None
    return public


def _weigh_status(source):
    public = _fields(source, ('mode', 'part_no', 'weight_g', 'stable', 'empty', 'storage_error'))
    public['products'] = [
        _fields(product, ('part_no', 'name')) for product in (source.get('products') or [])
    ]
    public['last_result'] = _fields(source.get('last_result'), (
        'seq', 'result', 'quantity', 'weight_g', 'delta_g', 'reason', 'time', 'reservation_blocked', 'part_no',
    )) or None
    public['last_reread'] = _fields(source.get('last_reread'), ('seq', 'status', 'barcode', 'device', 'time', 'label_origin')) or None
    public['jobs'] = [
        _fields(job, ('id', 'part_no', 'time', 'reserved', 'submitted', 'confirmed', 'unconfirmed', 'state'))
        for job in (source.get('jobs') or [])[:12]
    ]
    public['serial'] = _fields(source.get('serial'), ('part_no', 'day', 'date_code', 'status'))
    labels = source.get('labels')
    if isinstance(labels, dict):
        result = _fields(labels, ('template_id',))
        result['templates'] = []
        keys = set()
        for entry in labels.get('templates', [])[:11]:
            projected = _fields(entry, ('id', 'name', 'name_ko', 'name_zh', 'columns', 'language'))
            projected['fields'] = [_fields(field, ('key', 'label_ko', 'label_zh', 'max_length', 'default'))
                                   for field in entry.get('fields', [])[:5]]
            keys.update(field['key'] for field in projected['fields'] if 'key' in field)
            result['templates'].append(projected)
        result['values'] = _fields(labels.get('values'), keys)
        preview = labels.get('preview') or {}
        result['preview'] = _fields(preview, ('columns',))
        result['preview']['cells'] = [
            dict(_fields(cell, ('barcode',)), text=[line for line in cell.get('text', [])[:6] if _field_value(line)])
            for cell in preview.get('cells', [])[:3]
        ]
        public['labels'] = result
    queue = source.get('queue') or {}
    public['queue'] = _fields(queue, (
        'waiting', 'dispatching', 'submitted', 'uncertain', 'peel_wait', 'partial', 'paused',
        'pause_reason', 'uncertain_quantity',
    ))
    public['queue']['uncertain_ids'] = [
        value for value in (queue.get('uncertain_ids') or []) if _field_value(value)
    ]
    return public


def _status_bytes(snapshot, language):
    # A caller's extra state can contain install details. Never serve it wholesale.
    public = _fields(snapshot, (
        'station_id', 'agent_version', 'clock_offset_seconds', 'heartbeat_error',
    ))
    public['language'] = language
    if isinstance(snapshot.get('layout_status'), dict):
        public['layout_status'] = _fields(snapshot['layout_status'], ('profile', 'status', 'code'))
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
    if isinstance(snapshot.get('barcode'), dict):
        public['barcode'] = _barcode_status(snapshot['barcode'])
    if isinstance(snapshot.get('weigh'), dict):
        public['weigh'] = _weigh_status(snapshot['weigh'])
    if isinstance(snapshot.get('vision'), list):
        public['vision'] = [
            _fields(source, ('app', 'coverage', 'mode', 'state', 'last_work_at', 'process'))
            for source in snapshot['vision'][:3]
        ]
    return json.dumps(public, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')


def _unique_keys(pairs):
    data = {}
    for key, value in pairs:
        if key in data:
            raise ValueError('Duplicate JSON key')
        data[key] = value
    return data


def _non_json_constant(_value):
    raise ValueError('Invalid JSON constant')


def _field_value(value):
    return type(value) is str and 0 < len(value) <= 512 and value.isprintable()


def _valid_barcode_action(action, data):
    if type(data) is not dict:
        return False
    if action == 'reset':
        return not data
    if action == 'mode':
        return set(data) == {'mode'} and data['mode'] in ('production', 'test')
    if not data or set(data) - {'production_group', 'assignments'}:
        return False
    if 'production_group' in data and not _field_value(data['production_group']):
        return False
    if 'assignments' not in data:
        return True
    assignments = data['assignments']
    return (
        type(assignments) is dict and bool(assignments) and not (set(assignments) - set(_LANES))
        and all(value is None or _field_value(value) for value in assignments.values())
    )


def _valid_weigh_action(action, data):
    if type(data) is not dict:
        return False
    if action == 'product':
        return set(data) == {'part_no'} and _field_value(data['part_no'])
    if action == 'acknowledge':
        return (
            set(data) == {'job_id', 'confirmed_quantity'} and _field_value(data['job_id'])
            and type(data['confirmed_quantity']) is int and 0 <= data['confirmed_quantity'] <= 1000
        )
    if action == 'template':
        return (set(data) == {'template_id', 'values'} and _field_value(data['template_id'])
                and isinstance(data['values'], dict) and len(data['values']) <= 5
                and all(_field_value(key) and isinstance(value, str) and len(value) <= 96
                        for key, value in data['values'].items()))
    if action == 'reread':
        return (set(data) == {'barcode', 'request_id', 'source'} and _field_value(data['barcode'])
                and _field_value(data['request_id']) and data['source'] in ('keyboard', 'manual'))
    return action in ('resume', 'pause', 'cancel_waiting', 'flush', 'peel') and not data


def _valid_language_action(_action, data):
    return type(data) is dict and set(data) == {'language'} and data['language'] in LANGUAGES


class _Server(ThreadingHTTPServer):
    request_queue_size = 12

    def __init__(self, port, snapshot, barcode_action, barcode_csv, weigh_action, language):
        self.snapshot = snapshot
        self.barcode_action = barcode_action
        self.barcode_csv = barcode_csv
        self.weigh_action = weigh_action
        self.language = language
        self.stopping = threading.Event()
        # Leave room for assets/JSON even when the SSE slots are occupied.
        self.request_slots = threading.BoundedSemaphore(16)
        self.stream_slots = threading.BoundedSemaphore(_SSE_CLIENTS)
        self.export_slot = threading.BoundedSemaphore(1)
        self.assets = {
            route: ((_STATIC_ROOT / name).read_bytes(), media_type)
            for route, (name, media_type) in _ASSETS.items()
        }
        super().__init__(('127.0.0.1', port), _Handler)
        bound_port = self.server_address[1]
        self.hosts = ('127.0.0.1', '127.0.0.1:80') if bound_port == 80 else ('127.0.0.1:{}'.format(bound_port),)
        self.origin = 'http://{}'.format(self.hosts[0])

    def language_code(self):
        return self.language.get() if self.language is not None else 'ko'

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

    def _headers(self, status, media_type, length=None, *, disposition=None, allow=None):
        self.send_response(status)
        self.send_header('Content-Type', media_type)
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('X-Frame-Options', 'DENY')
        self.send_header('Referrer-Policy', 'no-referrer')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('Permissions-Policy', 'autoplay=(self)')
        self.send_header(
            'Content-Security-Policy',
            "default-src 'none'; script-src 'self'; style-src 'self'; "
            "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        )
        if disposition is not None:
            self.send_header('Content-Disposition', disposition)
        if status == 405:
            self.send_header('Allow', allow or 'GET, HEAD')
        self.end_headers()

    def _send(self, status, body, media_type='text/plain; charset=utf-8', **headers):
        self._headers(status, media_type, len(body), **headers)
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
        route, _, query = self.path.partition('?')
        if route in self.server.assets:
            data, media_type = self.server.assets[route]
            if route == '/':
                language = self.server.language_code()
                if language == 'zh':
                    data = data.replace(b'<html lang="ko">', b'<html lang="zh-Hans">', 1)
                data = data.replace(b'<!-- native-script-notice -->', _NO_SCRIPT[language].encode('utf-8'), 1)
            self._send(200, data, media_type)
        elif route == '/api/status':
            try:
                data = _status_bytes(self.server.snapshot(), self.server.language_code())
            except (AttributeError, TypeError, ValueError):
                self._send(503, b'Local status unavailable')
                return
            self._send(200, data, 'application/json; charset=utf-8')
        elif route == '/api/events':
            if self.command == 'HEAD':
                self._send(405, b'GET required')
            else:
                self._stream()
        elif route == _BARCODE_CSV and self.server.barcode_csv is not None:
            self._export_csv(query)
        elif self._action_route(route) is not None:
            self._send(405, b'POST required', allow='POST')
        else:
            self._send(404, b'Not found')

    do_HEAD = do_GET

    def _mutation(self):
        self._send(405, b'Local status is read only')

    do_PUT = do_PATCH = do_DELETE = do_OPTIONS = do_TRACE = do_CONNECT = _mutation

    def _change_language(self, _action, data):
        self.server.language.set(data['language'])

    def _action_route(self, path):
        if path == _LANGUAGE and self.server.language is not None:
            return 'language', _valid_language_action, self._change_language
        if path in _BARCODE_ACTIONS and self.server.barcode_action is not None:
            return _BARCODE_ACTIONS[path], _valid_barcode_action, self.server.barcode_action
        if path in _WEIGH_ACTIONS and self.server.weigh_action is not None:
            return _WEIGH_ACTIONS[path], _valid_weigh_action, self.server.weigh_action
        return None

    def do_POST(self):
        route = self._action_route(self.path)
        if route is None:
            self._mutation()
            return
        action, validator, handler = route
        if self.headers.get_all('Transfer-Encoding'):
            self._send(400, b'Transfer encoding unsupported')
            return
        content_type = self.headers.get_all('Content-Type') or []
        if len(content_type) != 1 or content_type[0].lower() not in (
            'application/json', 'application/json; charset=utf-8',
        ):
            self._send(415, b'JSON required')
            return
        lengths = self.headers.get_all('Content-Length') or []
        if len(lengths) != 1 or not lengths[0].isascii() or not lengths[0].isdecimal():
            self._send(400, b'Invalid content length')
            return
        if len(lengths[0]) > 4 or int(lengths[0]) > _MAX_ACTION_BYTES:
            self._send(413, b'Request too large')
            return
        length = int(lengths[0])
        try:
            raw = self.rfile.read(length)
            if len(raw) != length:
                raise ValueError('Incomplete body')
            payload = json.loads(
                raw.decode('utf-8'), object_pairs_hook=_unique_keys, parse_constant=_non_json_constant,
            )
            if not validator(action, payload):
                raise ValueError('Invalid payload')
            handler(action, payload)
        except (ValueError, RecursionError):
            self._send(400, b'Invalid local action')
        except (OSError, RuntimeError, sqlite3.Error):
            self._send(503, b'Local action could not be saved')
        else:
            self._send(200, b'{"ok":true}', 'application/json; charset=utf-8')

    def _export_csv(self, query):
        # The browser sends a custom header via a same-origin fetch, not a navigation.
        # A foreign page cannot set it through a form/link or the CORS preflight.
        if self.headers.get_all(_SESSION_HEADER) != ['1']:
            self._send(403, b'Local request header required')
            return
        if self.command != 'GET':
            self._send(405, b'GET required', allow='GET')
            return
        try:
            params = parse_qs(query, strict_parsing=True, max_num_fields=1)
            if params not in ({'lang': ['ko']}, {'lang': ['zh']}):
                raise ValueError('Invalid selection')
        except ValueError:
            self._send(400, b'Invalid export language')
            return
        if not self.server.export_slot.acquire(blocking=False):
            self._send(503, b'Barcode export unavailable')
            return
        try:
            try:
                output = tempfile.TemporaryFile(mode='w+b')
            except OSError:
                self._send(503, b'Barcode export unavailable')
                return
            with output:
                try:
                    source = self.server.barcode_csv(params['lang'][0])
                    chunks = iter((source,)) if isinstance(source, bytes) else iter(source)
                    try:
                        for chunk in chunks:
                            if not isinstance(chunk, bytes):
                                raise ValueError('CSV must yield bytes')
                            output.write(chunk)
                    finally:
                        if hasattr(chunks, 'close'):
                            chunks.close()
                    size = output.tell()
                    output.seek(0)
                except (OSError, RuntimeError, TypeError, ValueError, sqlite3.Error):
                    self._send(503, b'Barcode export unavailable')
                    return
                self._headers(
                    200, 'text/csv; charset=utf-8', size,
                    disposition='attachment; filename="barcode-records.csv"',
                )
                shutil.copyfileobj(output, self.wfile, length=_CSV_COPY_BYTES)
        finally:
            self.server.export_slot.release()

    def _stream(self):
        if not self.server.stream_slots.acquire(blocking=False):
            self._send(503, b'Too many local streams')
            return
        try:
            self._headers(200, 'text/event-stream; charset=utf-8')
            previous = None
            keepalive = time.monotonic()
            while not self.server.stopping.is_set():
                state = _status_bytes(self.server.snapshot(), self.server.language_code())
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
    """Serve the static shell, a cached snapshot, and optional local controls."""

    def __init__(self, snapshot, host='127.0.0.1', port=_DEFAULT_PORT, *,
                 barcode_action=None, barcode_csv=None, weigh_action=None, language=None):
        if host != '127.0.0.1':
            raise ValueError('Local UI requires 127.0.0.1')
        if type(port) is not int or not 0 <= port <= 65535:
            raise ValueError('Invalid loopback UI port')
        self._snapshot = snapshot
        self._barcode_action = barcode_action
        self._barcode_csv = barcode_csv
        self._weigh_action = weigh_action
        self._language = language
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
            server = _Server(
                self._requested_port, self._snapshot, self._barcode_action, self._barcode_csv, self._weigh_action,
                self._language,
            )
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
