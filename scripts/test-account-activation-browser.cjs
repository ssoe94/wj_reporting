/* Synthetic DOM contract tests; no browser, network, or real activation links. */
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const directory = path.join(__dirname, '../backend/account_activation/static/account_activation');
const script = readFileSync(path.join(directory, 'activate.js'), 'utf8');
const TOKEN = 'a'.repeat(24) + '.' + 'b'.repeat(43);
const PASSWORD = 'SYNTHETIC-browser-self-set-549!';

function fixture({hash = '#' + TOKEN, protocol = 'https:', embedded = false,
                  response = async () => ({ok: true, json: async () => ({status: 'activated'})})} = {}) {
  const events = {};
  const calls = [];
  const fields = {
    password: {value: PASSWORD}, confirmation: {value: PASSWORD},
    status: {textContent: ''}, done: {hidden: true},
  };
  const button = {disabled: false};
  const form = {hidden: true,
    querySelector: key => key === 'button' ? button : {value: 'SYNTHETIC-CSRF'},
    addEventListener: (key, action) => { events['form:' + key] = action; }};
  fields['activation-form'] = form;
  const window = {
    location: {hash, protocol, pathname: '/accounts/activate/'},
    history: {replaceState: (...args) => { calls.push({kind: 'strip', args}); window.location.hash = ''; }},
    addEventListener: (key, action) => { events[key] = action; },
    setTimeout: () => 1, clearTimeout: () => {},
  };
  window.self = window;
  window.top = embedded ? {} : window;
  const context = {window, document: {getElementById: id => fields[id]},
    URLSearchParams, AbortController,
    fetch: async (url, options) => {
      calls.push({kind: 'post', url, options: {...options, body: options.body.toString()}});
      return response();
    }};
  vm.runInNewContext(script, context);
  return {fields, form, calls, window, button,
    submit: () => events['form:submit']?.({preventDefault() {}}),
    event: (key, data = {}) => events[key]?.(data)};
}

test('fragment is removed immediately without GET requests or browser storage', () => {
  const f = fixture();
  assert.equal(f.window.location.hash, '');
  assert.deepEqual(f.calls.map(call => call.kind), ['strip']);
  assert.equal(f.form.hidden, false);
  assert.equal(f.calls[0].args[2], '/accounts/activate/');
});

test('self-set POST clears password inputs and cannot automatically log in or retry', async () => {
  const f = fixture();
  await f.submit();
  const requests = f.calls.filter(call => call.kind === 'post');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/accounts/activate/');
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.credentials, 'same-origin');
  const body = new URLSearchParams(requests[0].options.body);
  assert.equal(body.get('token'), TOKEN);
  assert.equal(body.get('password'), PASSWORD);
  assert.equal(f.fields.password.value, '');
  assert.equal(f.fields.confirmation.value, '');
  assert.equal(f.form.hidden, true);
  assert.equal(f.fields.done.hidden, false);
  await f.submit();
  assert.equal(f.calls.filter(call => call.kind === 'post').length, 1);
});

test('uncertain delivery clears token and refuses repeated submission', async () => {
  const f = fixture({response: async () => { throw new Error('SYNTHETIC-NETWORK-FAILURE'); }});
  await f.submit();
  await f.submit();
  assert.equal(f.calls.filter(call => call.kind === 'post').length, 1);
  assert.equal(f.form.hidden, true);
  assert.equal(f.fields.done.hidden, true);
  assert.ok(!f.fields.status.textContent.includes('SYNTHETIC-NETWORK-FAILURE'));
});

test('validation allows a deliberate corrected password without retaining the old input', async () => {
  const f = fixture({response: async () => ({ok: true, json: async () => ({status: 'password_invalid'})})});
  await f.submit();
  assert.equal(f.fields.password.value, '');
  assert.equal(f.fields.confirmation.value, '');
  assert.equal(f.button.disabled, false);
  assert.equal(f.form.hidden, false);
  f.event('pagehide');
  f.event('pageshow', {persisted: true});
  await f.submit();
  assert.equal(f.form.hidden, true);
  assert.equal(f.calls.filter(call => call.kind === 'post').length, 1);
});

test('invalid fragment, HTTP and embedded pages never reveal the form or call a server', () => {
  for (const options of [{hash: '#wrong'}, {protocol: 'http:'}, {embedded: true}]) {
    const f = fixture(options);
    assert.equal(f.form.hidden, true);
    assert.equal(f.window.location.hash, '');
    assert.equal(f.calls.filter(call => call.kind === 'post').length, 0);
  }
});

test('in-flight duplicate click sends only one request', async () => {
  let finish;
  const f = fixture({response: () => new Promise(resolve => { finish = resolve; })});
  const first = f.submit();
  await f.submit();
  assert.equal(f.calls.filter(call => call.kind === 'post').length, 1);
  finish({ok: true, json: async () => ({status: 'activated'})});
  await first;
});

test('administrator page clears both live and initial textarea value before restoration', () => {
  const field = {value: TOKEN, textContent: TOKEN, hidden: false};
  const events = {};
  vm.runInNewContext(readFileSync(path.join(directory, 'issue.js'), 'utf8'), {
    window: {addEventListener: (name, action) => { events[name] = action; }},
    document: {getElementById: () => field},
  });
  events.pagehide();
  assert.equal(field.value, '');
  assert.equal(field.textContent, '');
  assert.equal(field.hidden, true);
  field.value = TOKEN;
  events.pageshow({persisted: true});
  assert.equal(field.value, '');
});
