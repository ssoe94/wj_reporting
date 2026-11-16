import http.client
import json
import sqlite3
import unittest

from field_agent.local_ui import LocalUI


class LocalUITests(unittest.TestCase):
    def setUp(self):
        self.snapshot = {
            'station_id': 'SYNTH-STATION-01',
            'agent_version': '1.0.0',
            'apps': [{'app': 'barcode', 'mode': 'test', 'token': 'SENSITIVE-SENTINEL'}],
            'devices': [{'app': 'barcode', 'device': 'A', 'state': 'connected', 'private': 'SENSITIVE-SENTINEL'}],
            'outbox': {'pending_count': 1, 'state': 'backoff', 'token': 'SENSITIVE-SENTINEL'},
            'backup': {'state': 'failed', 'path': 'SENSITIVE-SENTINEL'},
            'clock_offset_seconds': 360,
            'heartbeat_error': 'network_error',
            'token': 'SENSITIVE-SENTINEL',
        }
        self.ui = LocalUI(lambda: self.snapshot, port=0).start()
        self.addCleanup(self.ui.stop)
        self.origin = 'http://127.0.0.1:{}'.format(self.ui.port)

    def connect(self):
        client = http.client.HTTPConnection('127.0.0.1', self.ui.port, timeout=3)
        self.addCleanup(client.close)
        return client

    def request(self, method='GET', path='/api/status', headers=None, body=None):
        client = self.connect()
        client.request(method, path, body=body, headers=headers or {})
        response = client.getresponse()
        return response, response.read()

    def open_stream(self):
        client = self.connect()
        client.request('GET', '/api/events')
        response = client.getresponse()
        self.assertEqual(response.status, 200)
        self.assertIn('text/event-stream', response.getheader('Content-Type'))
        self.addCleanup(response.close)
        return response

    def event(self, stream):
        line = stream.readline()
        self.assertTrue(line.startswith(b'data: '), line)
        self.assertEqual(stream.readline(), b'\n')
        return json.loads(line[6:])

    def test_refuses_non_loopback_or_other_interface_aliases(self):
        for host in ('0.0.0.0', '::', 'localhost', '127.0.0.2'):
            with self.subTest(host=host), self.assertRaisesRegex(ValueError, '127.0.0.1'):
                LocalUI(lambda: self.snapshot, host=host, port=0)

    def test_status_allowlists_fields_and_static_assets_are_same_origin(self):
        status, raw = self.request(headers={'Origin': self.origin, 'Sec-Fetch-Site': 'same-origin'})
        self.assertEqual(status.status, 200)
        self.assertIsNone(status.getheader('Access-Control-Allow-Origin'))
        self.assertEqual(status.getheader('Cache-Control'), 'no-store')
        self.assertIn("frame-ancestors 'none'", status.getheader('Content-Security-Policy'))
        self.assertNotIn(b'SENSITIVE-SENTINEL', raw)
        data = json.loads(raw)
        self.assertEqual(data['station_id'], 'SYNTH-STATION-01')
        self.assertEqual(data['apps'][0]['mode'], 'test')
        self.assertEqual(data['devices'][0]['device'], 'A')
        self.assertEqual(data['outbox']['pending_count'], 1)
        self.assertEqual(data['backup']['state'], 'failed')
        self.assertEqual(data['clock_offset_seconds'], 360)
        self.assertEqual(data['heartbeat_error'], 'network_error')
        for path, media, marker in (
            ('/', 'text/html', b'/agent.js'),
            ('/agent.css', 'text/css', b'.device-row'),
            ('/agent.js', 'text/javascript', b"new EventSource('/api/events')"),
            ('/barcode.js', 'text/javascript', b'createBarcodeView'),
        ):
            with self.subTest(path=path):
                response, body = self.request(path=path)
                self.assertEqual(response.status, 200)
                self.assertIn(media, response.getheader('Content-Type'))
                self.assertIn(marker, body)
        self.assertEqual(self.request(path='/api/config')[0].status, 404)
        self.assertEqual(self.request(path='/../config.json')[0].status, 404)
        self.assertEqual(self.request(path='/api/barcode/export.csv?lang=ko')[0].status, 404)

    def test_wrong_host_and_cross_origin_requests(self):
        for headers in (
            {'Host': 'bad.example.test'},
            {'Host': '127.0.0.1'},
            {'Origin': 'null'},
            {'Origin': 'http://127.0.0.1:39999'},
            {'Sec-Fetch-Site': 'same-site'},
            {'Sec-Fetch-Site': 'cross-site'},
        ):
            with self.subTest(headers=headers):
                response, _ = self.request(headers=headers)
                self.assertEqual(response.status, 403)
        client = self.connect()
        client.putrequest('GET', '/api/status')
        client.putheader('Host', 'bad.example.test')
        client.endheaders()
        self.assertEqual(client.getresponse().status, 403)

    def test_mutation_requires_exact_origin_and_dedicated_header(self):
        for headers in (
            {}, {'Origin': self.origin}, {'X-WJ-Local': '1'},
            {'Origin': 'http://127.0.0.1:39999', 'X-WJ-Local': '1'},
            {'Origin': self.origin, 'X-WJ-Local': 'yes'},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.request('POST', headers=headers)[0].status, 403)
        for method in ('POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TRACE'):
            with self.subTest(method=method):
                response, body = self.request(method, headers={'Origin': self.origin, 'X-WJ-Local': '1'})
                self.assertEqual(response.status, 405)
                self.assertIn(b'read only', body)

    def test_sse_shows_current_state_updates_and_releases_on_stop(self):
        stream = self.open_stream()
        self.assertEqual(self.event(stream)['outbox']['pending_count'], 1)
        self.snapshot = dict(self.snapshot, outbox={'pending_count': 0, 'state': 'ready'})
        self.assertEqual(self.event(stream)['outbox']['pending_count'], 0)
        self.ui.stop()
        self.assertEqual(stream.readline(), b'')

    def test_streams_capped_without_blocking_normal_status(self):
        for _ in range(4):
            self.event(self.open_stream())
        response, body = self.request(path='/api/events')
        self.assertEqual(response.status, 503)
        self.assertIn(b'Too many local streams', body)
        self.assertEqual(self.request()[0].status, 200)

    def enable_barcode(self, action=None, csv=None):
        self.ui.stop()
        self.ui = LocalUI(lambda: self.snapshot, port=0, barcode_action=action, barcode_csv=csv).start()
        self.addCleanup(self.ui.stop)
        self.origin = 'http://127.0.0.1:{}'.format(self.ui.port)

    def post(self, name, body=b'{}', headers=None):
        return self.request('POST', '/api/barcode/{}/'.format(name), body=body, headers=(
            headers if headers is not None else {
                'Origin': self.origin, 'X-WJ-Local': '1', 'Content-Type': 'application/json',
            }
        ))

    def test_barcode_routes_validate_origin_method_and_schema_before_callback(self):
        calls = []
        self.enable_barcode(action=lambda name, body: calls.append((name, body)))
        for headers in (
            {},
            {'Origin': self.origin, 'Content-Type': 'application/json'},
            {'Origin': self.origin, 'X-WJ-Local': '1', 'Sec-Fetch-Site': 'same-site'},
            {'Origin': 'http://foo.example', 'X-WJ-Local': '1', 'Content-Type': 'application/json'},
        ):
            with self.subTest(headers=headers):
                self.assertEqual(self.post('reset', headers=headers)[0].status, 403)
        self.assertEqual(self.post('reset', headers={
            'Origin': self.origin, 'X-WJ-Local': '1', 'Content-Type': 'text/plain',
        })[0].status, 415)
        self.assertEqual(self.post('reset', body=b' ' * 2049)[0].status, 413)
        wrong_method, _ = self.request(path='/api/barcode/reset/')
        self.assertEqual(wrong_method.status, 405)
        self.assertEqual(wrong_method.getheader('Allow'), 'POST')
        for name, body in (
            ('reset', b'{"extra":1}'),
            ('reset', b'{"x":NaN}'),
            ('reset', b'[]'),
            ('mode', b'{"mode":"test","mode":"production"}'),
            ('mode', b'{"mode":"preview"}'),
            ('mode', b'{"mode":true}'),
            ('config', b'{}'),
            ('config', b'{"assignments":{}}'),
            ('config', b'{"assignments":{"W":"PORT-1"}}'),
            ('config', b'{"assignments":{"A":42}}'),
            ('config', b'{"production_group":""}'),
            ('config', b'{"production_group":"SYNTH","token":"bad"}'),
            ('config', rb'{"production_group":"bad\u0000value"}'),
        ):
            with self.subTest(name=name, body=body):
                self.assertEqual(self.post(name, body)[0].status, 400)
        self.assertEqual(calls, [])

        response, body = self.post('reset')
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body), {'ok': True})
        self.assertEqual(self.post('mode', b'{"mode":"test"}')[0].status, 200)
        self.assertEqual(self.post('config', b'{"production_group":"SYNTH","assignments":{"A":null}}')[0].status, 200)
        self.assertEqual(calls, [
            ('reset', {}), ('mode', {'mode': 'test'}),
            ('config', {'production_group': 'SYNTH', 'assignments': {'A': None}}),
        ])

    def test_rejected_callback_and_csv_stream_failure_have_no_private_output(self):
        def action(name, _body):
            if name == 'mode':
                raise ValueError('SENSITIVE-SENTINEL')
            raise RuntimeError('SENSITIVE-SENTINEL')

        def csv(lang):
            yield b'\xef\xbb\xbfTime,Scanner,Barcode,Size,ProductGroup,Status,StatusText\r\n'
            if lang == 'ko':
                raise sqlite3.OperationalError('SENSITIVE-SENTINEL')
            yield '09:00,A,SYNTH,,,ok,正常\r\n'.encode('utf-8')

        self.enable_barcode(action=action, csv=csv)
        for name, raw, status in (('mode', b'{"mode":"test"}', 400), ('reset', b'{}', 503)):
            response, body = self.post(name, raw)
            self.assertEqual(response.status, status)
            self.assertNotIn(b'SENSITIVE-SENTINEL', body)

        path = '/api/barcode/export.csv?lang=zh'
        local = {'X-WJ-Local': '1', 'Sec-Fetch-Site': 'same-origin'}
        for headers in (
            {},
            dict(local, Origin='https://foreign.example'),
            dict(local, **{'Sec-Fetch-Site': 'cross-site'}),
        ):
            self.assertEqual(self.request(path=path, headers=headers)[0].status, 403)
        self.assertEqual(self.request(path=path + '&lang=ko', headers=local)[0].status, 400)
        response, body = self.request(path=path, headers=local)
        self.assertEqual(response.status, 200)
        self.assertEqual(response.getheader('Content-Disposition'), 'attachment; filename="barcode-records.csv"')
        self.assertEqual(response.getheader('Content-Type'), 'text/csv; charset=utf-8')
        self.assertEqual(int(response.getheader('Content-Length')), len(body))
        self.assertTrue(body.startswith(b'\xef\xbb\xbfTime,Scanner,Barcode,Size,ProductGroup,Status,StatusText'))
        self.assertIn('正常'.encode('utf-8'), body)
        response, body = self.request(path='/api/barcode/export.csv?lang=ko', headers=local)
        self.assertEqual(response.status, 503)
        self.assertNotIn(b'Time,Scanner', body)
        self.assertNotIn(b'SENSITIVE-SENTINEL', body)

    def test_barcode_snapshot_recursively_allows_only_display_fields(self):
        self.snapshot['barcode'] = {
            'mode': 'test', 'production_group': 'SYNTH', 'storage_error': True,
            'groups': ['SYNTH', {'token': 'SENSITIVE-SENTINEL'}],
            'assignments': {'A': 'PORT-1', 'B': None, 'W': 'SENSITIVE-SENTINEL'},
            'ports': [{'id': 'PORT-1', 'label': 'COM3', 'private': 'SENSITIVE-SENTINEL'}],
            'lanes': {
                'A': {
                    'connected': True, 'last_input_at': None, 'port': 'COM3',
                    'counts': {'ok': 0, 'duplicate': 0, 'error': 0, 'token': 'SENSITIVE-SENTINEL'},
                    'frame_errors': {'decode': 0, 'secret': 'SENSITIVE-SENTINEL'},
                    'recent': [{'seq': 1, 'barcode': 'SYNTH-1', 'status': 'duplicate', 'secret': 'SENSITIVE-SENTINEL'}],
                    'secret': 'SENSITIVE-SENTINEL',
                },
                'W': {'secret': 'SENSITIVE-SENTINEL'},
            },
            'alert': {'seq': 1, 'status': 'duplicate', 'extra': 'SENSITIVE-SENTINEL'},
            'secret': 'SENSITIVE-SENTINEL',
        }
        response, body = self.request()
        self.assertEqual(response.status, 200)
        self.assertNotIn(b'SENSITIVE-SENTINEL', body)
        barcode = json.loads(body)['barcode']
        self.assertEqual(barcode['lanes']['A']['last_input_at'], None)
        self.assertEqual(barcode['lanes']['A']['recent'][0]['status'], 'duplicate')
        self.assertEqual(set(barcode['lanes']), {'A', 'B'})
        self.assertEqual(barcode['alert'], {'seq': 1, 'status': 'duplicate'})
