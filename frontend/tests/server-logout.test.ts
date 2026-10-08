import assert from 'node:assert/strict'
import test from 'node:test'

import { finishServerLogout } from '../src/domains/auth/server-logout.ts'

const SESSION_A = 'SYNTHETIC-WJ-SESSION-A'
const SESSION_B = 'SYNTHETIC-WJ-SESSION-B'
type LogoutActions = Parameters<typeof finishServerLogout>[1]

function deferred() {
  let resolve!: (value: unknown) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<unknown>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}

function scenario(
  initialSessionId: string | null,
  revoke: () => Promise<unknown> = async () => ({ disconnected: true }),
) {
  const state = { sessionId: initialSessionId, revokeCalls: 0, clearCalls: 0 }
  const actions: LogoutActions = {
    revoke: async () => {
      state.revokeCalls += 1
      return revoke()
    },
    currentSessionId: () => state.sessionId,
    invalidateLocal: (expectedSessionId) => {
      if (state.sessionId !== expectedSessionId) return false
      state.clearCalls += 1
      state.sessionId = null
      return true
    },
  }
  return { state, actions }
}

test('confirmed server logout clears the exact local session once, after acknowledgement', async () => {
  const response = deferred()
  const { state, actions } = scenario(SESSION_A, () => response.promise)
  const completion = finishServerLogout(SESSION_A, actions)
  assert.equal(state.revokeCalls, 1)
  assert.equal(state.clearCalls, 0)
  assert.equal(state.sessionId, SESSION_A)

  response.resolve({ disconnected: true })
  assert.equal(await completion, true)
  assert.equal(state.revokeCalls, 1)
  assert.equal(state.clearCalls, 1)
  assert.equal(state.sessionId, null)
})

test('missing and stale session bindings never call server revoke or clear local state', async () => {
  const cases: [string | null, string | null][] = [
    [null, SESSION_A], ['', SESSION_A], [SESSION_A, null],
    [SESSION_A, SESSION_B], [null, null], [SESSION_A, ''],
  ]
  for (const [requested, current] of cases) {
    const { state, actions } = scenario(current)
    assert.equal(await finishServerLogout(requested, actions), false)
    assert.equal(state.revokeCalls, 0)
    assert.equal(state.clearCalls, 0)
    assert.equal(state.sessionId, current)
  }
})

test('malformed and negative acknowledgements retain the current local session', async () => {
  const responses = [
    undefined, null, false, true, 1, 'true', '{"disconnected":true}',
    [], [{ disconnected: true }], {}, { disconnected: false },
    { disconnected: null }, { disconnected: 1 }, { disconnected: 'true' },
    { data: { disconnected: true } },
  ]
  for (const response of responses) {
    const { state, actions } = scenario(SESSION_A, async () => response)
    assert.equal(await finishServerLogout(SESSION_A, actions), false)
    assert.equal(state.revokeCalls, 1)
    assert.equal(state.clearCalls, 0)
    assert.equal(state.sessionId, SESSION_A)
  }
})

test('an asynchronous server failure returns false without clearing local state', async () => {
  const response = deferred()
  const { state, actions } = scenario(SESSION_A, () => response.promise)
  const completion = finishServerLogout(SESSION_A, actions)
  response.reject(new Error('SYNTHETIC server failure'))
  assert.equal(await completion, false)
  assert.equal(state.revokeCalls, 1)
  assert.equal(state.clearCalls, 0)
  assert.equal(state.sessionId, SESSION_A)
})

test('a synchronously throwing revoke dependency returns false without clearing local state', async () => {
  const { state, actions } = scenario(SESSION_A)
  actions.revoke = () => {
    state.revokeCalls += 1
    throw new Error('SYNTHETIC synchronous failure')
  }
  assert.equal(await finishServerLogout(SESSION_A, actions), false)
  assert.equal(state.revokeCalls, 1)
  assert.equal(state.clearCalls, 0)
  assert.equal(state.sessionId, SESSION_A)
})

test('a late success for session A cannot clear a newly logged-in session B', async () => {
  const response = deferred()
  const { state, actions } = scenario(SESSION_A, () => response.promise)
  const completion = finishServerLogout(SESSION_A, actions)
  assert.equal(state.revokeCalls, 1)

  state.sessionId = SESSION_B
  response.resolve({ disconnected: true })
  assert.equal(await completion, false)
  assert.equal(state.revokeCalls, 1)
  assert.equal(state.clearCalls, 0)
  assert.equal(state.sessionId, SESSION_B)
})

test('a late acknowledgement does not clear again after the local session disappears', async () => {
  const response = deferred()
  const { state, actions } = scenario(SESSION_A, () => response.promise)
  const completion = finishServerLogout(SESSION_A, actions)
  state.sessionId = null
  response.resolve({ disconnected: true })
  assert.equal(await completion, false)
  assert.equal(state.revokeCalls, 1)
  assert.equal(state.clearCalls, 0)
  assert.equal(state.sessionId, null)
})

test('two outstanding acknowledgements for the same session clear local state only once', async () => {
  const first = deferred()
  const second = deferred()
  const replies = [first.promise, second.promise]
  const { state, actions } = scenario(SESSION_A, () => replies.shift()!)
  const firstCompletion = finishServerLogout(SESSION_A, actions)
  const secondCompletion = finishServerLogout(SESSION_A, actions)
  assert.equal(state.revokeCalls, 2)

  first.resolve({ disconnected: true })
  assert.equal(await firstCompletion, true)
  second.resolve({ disconnected: true })
  assert.equal(await secondCompletion, false)
  assert.equal(state.clearCalls, 1)
  assert.equal(state.sessionId, null)
})

test('a new account can start its own logout while the prior account acknowledgement is pending', async () => {
  const first = deferred()
  const second = deferred()
  const replies = [first.promise, second.promise]
  const { state, actions } = scenario(SESSION_A, () => replies.shift()!)
  const firstCompletion = finishServerLogout(SESSION_A, actions)
  state.sessionId = SESSION_B
  const secondCompletion = finishServerLogout(SESSION_B, actions)
  assert.equal(state.revokeCalls, 2)

  first.resolve({ disconnected: true })
  assert.equal(await firstCompletion, false)
  assert.equal(state.sessionId, SESSION_B)
  assert.equal(state.clearCalls, 0)
  second.resolve({ disconnected: true })
  assert.equal(await secondCompletion, true)
  assert.equal(state.clearCalls, 1)
  assert.equal(state.sessionId, null)
})

test('a login between the last ownership check and local invalidation is never cleared', async () => {
  const { state, actions } = scenario(SESSION_A)
  actions.invalidateLocal = (expectedSessionId) => {
    state.sessionId = SESSION_B
    assert.equal(expectedSessionId, SESSION_A)
    return false
  }
  assert.equal(await finishServerLogout(SESSION_A, actions), false)
  assert.equal(state.sessionId, SESSION_B)
  assert.equal(state.clearCalls, 0)
})

test('a login during invalidation notification cannot be reported as logged out', async () => {
  const { state, actions } = scenario(SESSION_A)
  actions.invalidateLocal = (expectedSessionId) => {
    assert.equal(expectedSessionId, SESSION_A)
    state.sessionId = SESSION_B
    return true
  }
  assert.equal(await finishServerLogout(SESSION_A, actions), false)
  assert.equal(state.sessionId, SESSION_B)
})
