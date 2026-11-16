import http.client
import json
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

    def request(self, method='GET', path='/api/status', headers=None):
        client = self.connect()
        client.request(method, path, headers=headers or {})
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
        ):
            with self.subTest(path=path):
                response, body = self.request(path=path)
                self.assertEqual(response.status, 200)
                self.assertIn(media, response.getheader('Content-Type'))
                self.assertIn(marker, body)
        self.assertEqual(self.request(path='/api/config')[0].status, 404)
        self.assertEqual(self.request(path='/../config.json')[0].status, 404)

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
