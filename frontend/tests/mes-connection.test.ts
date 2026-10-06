import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MES_SESSION_SUBMIT_URL,
  isMesLaunchUsable,
  parseMesConnectionStatus,
  parseMesLoginHint,
  parseMesLaunch,
} from '../src/domains/auth/mes-connection.ts'

const SESSION = 'SYNTHETIC-WJ-SESSION'
const TICKET = 'SYNTHETIC-ONE-USE-TICKET'
const PRIVATE_INPUT = 'SYNTHETIC-PRIVATE-PROVIDER-VALUE'
const STARTED_AT = Date.UTC(2026, 9, 4, 12)
const SUBMIT_URL = 'https://wj-reporting-backend.onrender.com/integrations/blacklake/session/'

const statusPayload = {
  enabled: true,
  status: 'disconnected',
  reason: 'connection_missing',
  expires_at: null,
  can_connect: true,
  can_disconnect: false,
  mode: 'stored_identity',
  live_ready: false,
  login_hint: null,
}

function launchPayload(changes: Record<string, unknown> = {}) {
  return { ticket: TICKET, submit_url: SUBMIT_URL, expires_in: 60, ...changes }
}

function fixedError(run: () => unknown): string {
  let caught: unknown
  try {
    run()
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error, 'Malformed input must throw an Error')
  assert.equal(caught.name, 'Error', 'Do not leak a native parser exception')
  assert.ok(caught.message.length > 0)
  assert.equal(caught.message.includes(PRIVATE_INPUT), false)
  assert.equal(caught.message.includes(TICKET), false)
  return caught.message
}

test('status parser accepts the documented states without implying live readiness', () => {
  const cases = [
    { ...statusPayload, enabled: false, status: 'disabled', reason: 'continuity_disabled',
      can_connect: false, mode: 'identity_only' },
    statusPayload,
    { ...statusPayload, status: 'connected', reason: 'metadata_valid',
      expires_at: '2026-10-04T12:10:00Z', can_connect: false, can_disconnect: true },
    { ...statusPayload, status: 'reconnect_required', reason: 'provider_token_expired',
      can_disconnect: true },
    { ...statusPayload, status: 'blocked', reason: 'actor_ineligible', can_connect: false },
  ]
  for (const input of cases) {
    const parsed = parseMesConnectionStatus(Object.freeze(input))
    assert.deepEqual(parsed, input)
    assert.equal(parsed.live_ready, false)
  }
})

test('status parser rejects nonobjects and arrays with a fixed error', () => {
  const expected = fixedError(() => parseMesConnectionStatus(null))
  for (const input of [undefined, false, 1, PRIVATE_INPUT, [], [statusPayload]]) {
    assert.equal(fixedError(() => parseMesConnectionStatus(input)), expected)
  }
})

test('status parser requires every contract field', () => {
  const expected = fixedError(() => parseMesConnectionStatus(null))
  for (const key of Object.keys(statusPayload).filter(key => key !== 'login_hint')) {
    const input: Record<string, unknown> = { ...statusPayload }
    delete input[key]
    assert.equal(fixedError(() => parseMesConnectionStatus(input)), expected, key)
  }
})

test('login hints are optional display metadata with no credential or actor authority', () => {
  const hint = { factory_number: '12345678', account_name: 'fixture-account-a', prefill_supported: false }
  assert.deepEqual(parseMesLoginHint({ ...hint, password: PRIVATE_INPUT, user_id: 999 }), hint)
  assert.deepEqual(parseMesConnectionStatus({ ...statusPayload, login_hint: hint }).login_hint, hint)
  const withoutHint: Record<string, unknown> = { ...statusPayload }
  delete withoutHint.login_hint
  assert.equal(parseMesConnectionStatus(withoutHint).login_hint, null)
  for (const value of [undefined, null, [], PRIVATE_INPUT,
    { ...hint, factory_number: '1234?account=other' }, { ...hint, factory_number: 12345678 },
    { ...hint, factory_number: '1'.repeat(21) }, { ...hint, factory_number: '' },
    { ...hint, account_name: 'fixture account' }, { ...hint, account_name: 'id\n' },
    { ...hint, account_name: 'x'.repeat(81) }, { ...hint, account_name: '' },
    { ...hint, account_name: 'https://provider.invalid' },
    { ...hint, prefill_supported: true }, { ...hint, prefill_supported: undefined }]) {
    assert.equal(parseMesLoginHint(value), null)
    assert.equal(parseMesConnectionStatus({ ...statusPayload, login_hint: value }).login_hint, null)
  }
})

test('status parser rejects unknown states, modes, and nonboolean flags', () => {
  const expected = fixedError(() => parseMesConnectionStatus(null))
  const invalid: Record<string, unknown>[] = [
    { status: PRIVATE_INPUT }, { status: 'CONNECTED' }, { status: null },
    { mode: PRIVATE_INPUT }, { mode: 'live' }, { mode: null },
    { live_ready: true }, { live_ready: 'false' }, { live_ready: 0 },
  ]
  for (const key of ['enabled', 'can_connect', 'can_disconnect']) {
    for (const value of ['false', 0, 1, null, undefined]) invalid.push({ [key]: value })
  }
  for (const changes of invalid) {
    assert.equal(fixedError(() => parseMesConnectionStatus({ ...statusPayload, ...changes })), expected)
  }
})

test('status parser rejects malformed reason and expiry fields without echoing input', () => {
  const expected = fixedError(() => parseMesConnectionStatus(null))
  for (const reason of [null, undefined, 1, false, {}, [], 'x'.repeat(129)]) {
    assert.equal(fixedError(() => parseMesConnectionStatus({ ...statusPayload, reason })), expected)
  }
  for (const expires_at of [undefined, 0, false, {}, [], PRIVATE_INPUT]) {
    assert.equal(fixedError(() => parseMesConnectionStatus({ ...statusPayload, expires_at })), expected)
  }
})

test('status parser returns only reviewed metadata and drops extra credential fields', () => {
  const parsed = parseMesConnectionStatus({
    ...statusPayload,
    userAccessToken: PRIVATE_INPUT,
    appAccessToken: PRIVATE_INPUT,
    provider_response: { code: PRIVATE_INPUT },
  })
  assert.deepEqual(parsed, statusPayload)
  assert.equal(JSON.stringify(parsed).includes(PRIVATE_INPUT), false)
})

test('launch destination is the exact reviewed HTTPS session endpoint', () => {
  assert.equal(MES_SESSION_SUBMIT_URL, SUBMIT_URL)
  const launch = parseMesLaunch(launchPayload(), SESSION, STARTED_AT)
  assert.deepEqual(launch, {
    ticket: TICKET, submitUrl: SUBMIT_URL, sessionId: SESSION, expiresAt: STARTED_AT + 60_000,
  })
})

test('launch expiry starts at request start and does not gain response latency', () => {
  const launch = parseMesLaunch(Object.freeze(launchPayload()), SESSION, STARTED_AT)
  const responseReceivedAt = STARTED_AT + 59_000
  assert.equal(launch.expiresAt, STARTED_AT + 60_000)
  assert.equal(isMesLaunchUsable(launch, SESSION, responseReceivedAt), true)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT + 60_000), false)
  const lateResponse = parseMesLaunch(launchPayload(), SESSION, STARTED_AT)
  assert.equal(isMesLaunchUsable(lateResponse, SESSION, STARTED_AT + 61_000), false)
})

test('launch parser accepts one through sixty seconds and visible ASCII ticket boundaries', () => {
  for (const ticket of ['!', '~', "SYNTHETIC-'\"<>&=", 'x'.repeat(4096)]) {
    for (const seconds of [1, 60]) {
      const launch = parseMesLaunch(launchPayload({ ticket, expires_in: seconds }), SESSION, STARTED_AT)
      assert.equal(launch.ticket, ticket)
      assert.equal(launch.expiresAt, STARTED_AT + seconds * 1000)
    }
  }
})

test('launch parser rejects alternate and normalized URL spellings instead of repairing them', () => {
  const expected = fixedError(() => parseMesLaunch(null, SESSION, STARTED_AT))
  const urls = [
    'http://wj-reporting-backend.onrender.com/integrations/blacklake/session/',
    '//wj-reporting-backend.onrender.com/integrations/blacklake/session/',
    'https://wj-reporting.onrender.com/integrations/blacklake/session/',
    'https://wj-reporting-backend.onrender.com.evil.invalid/integrations/blacklake/session/',
    'https://synthetic@wj-reporting-backend.onrender.com/integrations/blacklake/session/',
    'https://wj-reporting-backend.onrender.com:443/integrations/blacklake/session/',
    'https://WJ-REPORTING-BACKEND.onrender.com/integrations/blacklake/session/',
    SUBMIT_URL.slice(0, -1), SUBMIT_URL + '?code=' + PRIVATE_INPUT, SUBMIT_URL + '#fragment',
    SUBMIT_URL + '?', SUBMIT_URL + '#', ' ' + SUBMIT_URL, SUBMIT_URL + '\n',
    SUBMIT_URL.replace('/session/', '/callback/'),
    SUBMIT_URL.replace('/session/', '/%73ession/'),
    SUBMIT_URL.replace('/session/', '/other/../session/'),
    '/integrations/blacklake/session/', 'javascript:alert(1)',
    null, undefined, {},
  ]
  for (const submit_url of urls) {
    assert.equal(fixedError(() => parseMesLaunch(launchPayload({ submit_url }), SESSION, STARTED_AT)), expected)
  }
})

test('launch parser rejects missing, nonstring, oversized, whitespace and non-ASCII tickets', () => {
  const expected = fixedError(() => parseMesLaunch(null, SESSION, STARTED_AT))
  const tickets = [
    null, undefined, false, 123, {}, [], '', ' ', 'x'.repeat(4097),
    ' ' + PRIVATE_INPUT, PRIVATE_INPUT + ' ', PRIVATE_INPUT + '\t',
    PRIVATE_INPUT + '\n', PRIVATE_INPUT + '\r', PRIVATE_INPUT + '\0',
    PRIVATE_INPUT + '\x7f', PRIVATE_INPUT + '\u00a0', PRIVATE_INPUT + '한',
  ]
  for (const ticket of tickets) {
    assert.equal(fixedError(() => parseMesLaunch(launchPayload({ ticket }), SESSION, STARTED_AT)), expected)
  }
})

test('launch parser rejects invalid durations without coercion or fallback', () => {
  const expected = fixedError(() => parseMesLaunch(null, SESSION, STARTED_AT))
  for (const expires_in of [undefined, null, false, true, '60', 0, -1, 0.5, 60.1, 61, NaN, Infinity, -Infinity]) {
    assert.equal(fixedError(() => parseMesLaunch(launchPayload({ expires_in }), SESSION, STARTED_AT)), expected)
  }
})

test('launch parser rejects missing payload fields and nonobject payloads', () => {
  const expected = fixedError(() => parseMesLaunch(null, SESSION, STARTED_AT))
  for (const input of [undefined, false, 1, PRIVATE_INPUT, [], [launchPayload()],
    { submit_url: SUBMIT_URL, expires_in: 60 }, { ticket: TICKET, expires_in: 60 },
    { ticket: TICKET, submit_url: SUBMIT_URL }]) {
    assert.equal(fixedError(() => parseMesLaunch(input, SESSION, STARTED_AT)), expected)
  }
})

test('launch parser rejects an empty session binding or invalid request-start time', () => {
  const expected = fixedError(() => parseMesLaunch(null, SESSION, STARTED_AT))
  assert.equal(fixedError(() => parseMesLaunch(launchPayload(), '', STARTED_AT)), expected)
  for (const startedAt of [NaN, Infinity, -Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
    assert.equal(fixedError(() => parseMesLaunch(launchPayload(), SESSION, startedAt)), expected)
  }
})

test('launch usability rejects the exact expiry boundary and later times', () => {
  const launch = parseMesLaunch(launchPayload({ expires_in: 1 }), SESSION, STARTED_AT)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT), true)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT + 999), true)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT + 1000), false)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT + 1001), false)
})

test('launch usability rejects absent launches, logout and another local session', () => {
  const launch = parseMesLaunch(launchPayload(), SESSION, STARTED_AT)
  assert.equal(isMesLaunchUsable(null, SESSION, STARTED_AT), false)
  assert.equal(isMesLaunchUsable(launch, null, STARTED_AT), false)
  assert.equal(isMesLaunchUsable(launch, '', STARTED_AT), false)
  assert.equal(isMesLaunchUsable(launch, 'SYNTHETIC-OTHER-SESSION', STARTED_AT), false)
})

test('launch usability rejects clocks outside the maximum sixty-second ticket window', () => {
  const launch = parseMesLaunch(launchPayload(), SESSION, STARTED_AT)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT - 1), false)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT - 60_000), false)
  assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT), true)
})

test('launch usability rejects nonfinite clocks and never extends the ticket lifetime', () => {
  const launch = Object.freeze(parseMesLaunch(launchPayload(), SESSION, STARTED_AT))
  const original = { ...launch }
  for (const now of [NaN, Infinity, -Infinity]) {
    assert.equal(isMesLaunchUsable(launch, SESSION, now), false)
  }
  for (const elapsed of [0, 1000, 30_000, 59_999, 60_000, 61_000]) {
    assert.equal(isMesLaunchUsable(launch, SESSION, STARTED_AT + elapsed), elapsed < 60_000)
  }
  assert.deepEqual(launch, original)
})
