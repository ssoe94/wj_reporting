import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { presentationEquivalent, classifyChanges, determineScope, loadDeploymentEvidence } from './ci-change-scope.mjs';

const page = 'frontend/src/domains/production/pages/InjectionBoardPage.tsx';
const css = 'frontend/src/styles/operations.css';
const source = body => `export function Board({value, label, show, onClick, props}) { return (${body}); }`;
const classify = (changes, before = source('<span>Before</span>'), after = source('<span>After</span>')) =>
  classifyChanges(changes, () => ({ before, after })).mode;

test('native JSX text and passive presentation attributes qualify', async t => {
  const cases = [
    ['text', '<span>Old label</span>', '<span>새 이름 新标签</span>'],
    ['string expression', '<span>{"Old"}</span>', '<span>{"New"}</span>'],
    ['title template identifiers', '<small>{value}</small>', '<small title={`${label} · ${value}`}>{value}</small>'],
    ['class', '<div className="large">Label</div>', '<div className="compact">Label</div>'],
    ['style literals', '<div style={{ fontSize: 20, marginTop: -2 }}>Label</div>', '<div style={{ fontSize: 16, marginTop: 0, color: "navy" }}>Label</div>'],
    ['aria label', '<span aria-label="Before">Label</span>', '<span aria-label="After">Label</span>'],
  ];
  for (const [name, before, after] of cases) await t.test(name, () => {
    assert.equal(presentationEquivalent(source(before), source(after), page), true);
    assert.equal(classify([{ status: 'M', path: page, mode: '100644' }], source(before), source(after)), 'ui');
  });
});

test('JSX code, routing and behavior changes cannot hide in a UI path', async t => {
  const cases = [
    ['API call attribute', '<span title={label}>X</span>', '<span title={fetch("/api/production/status/")}>X</span>'],
    ['calculation', '<span>{value}</span>', '<span>{value * 2}</span>'],
    ['conditional', '<span>{show && label}</span>', '<span>{!show && label}</span>'],
    ['event handler', '<button onClick={onClick}>X</button>', '<button onClick={() => fetch("/api/write/", { method: "POST" })}>X</button>'],
    ['href', '<a href="/boards/injection">X</a>', '<a href="/admin">X</a>'],
    ['spread', '<span>X</span>', '<span {...props}>X</span>'],
    ['custom component prop', '<Card title="Before" />', '<Card title="After" />'],
    ['style call', '<span style={{fontSize: 16}}>X</span>', '<span style={{fontSize: calculate()}}>X</span>'],
    ['style spread', '<span style={{fontSize: 16}}>X</span>', '<span style={{...props}}>X</span>'],
    ['property expression', '<span title={label}>X</span>', '<span title={props.secret}>X</span>'],
    ['template calculation', '<span title={`${value}`}>X</span>', '<span title={`${value + 1}`}>X</span>'],
    ['boolean attribute', '<button disabled>X</button>', '<button>X</button>'],
  ];
  for (const [name, before, after] of cases) await t.test(name, () => {
    assert.equal(presentationEquivalent(source(before), source(after), page), false);
    assert.equal(classify([{ status: 'M', path: page, mode: '100644' }], source(before), source(after)), 'full');
  });
  assert.equal(presentationEquivalent('export const A = <div>', 'export const A = <span>'), false);
  assert.equal(presentationEquivalent('fetch("/api/old");' + source('<span>X</span>'), 'fetch("/api/new");' + source('<span>X</span>')), false);
});

test('path and file-operation allowlist fails closed', async t => {
  const cases = [
    ['modify CSS', 'M', css, '100644', 'ui'],
    ['add CSS', 'A', 'frontend/src/components/compact.css', '100644', 'ui'],
    ['new image', 'A', 'frontend/public/board.png', '100644', 'ui'],
    ['font asset', 'M', 'frontend/src/assets/board.woff2', '100644', 'ui'],
    ['new TSX', 'A', page, '100644', 'full'],
    ['delete CSS', 'D', css, '', 'full'],
    ['rename', 'R100', css, '100644', 'full'],
    ['symlink', 'M', css, '120000', 'full'],
    ['executable mode', 'M', css, '100755', 'full'],
    ['auth page', 'M', 'frontend/src/domains/auth/pages/LoginPage.tsx', '100644', 'full'],
    ['permission component', 'M', 'frontend/src/components/PermissionGate.tsx', '100644', 'full'],
    ['entry point', 'M', 'frontend/src/App.tsx', '100644', 'full'],
    ['domain logic', 'M', 'frontend/src/domains/production/realtime-progress.ts', '100644', 'full'],
    ['API client', 'M', 'frontend/src/domains/production/api.ts', '100644', 'full'],
    ['dependency', 'M', 'frontend/package-lock.json', '100644', 'full'],
    ['configuration', 'M', 'frontend/vite.config.ts', '100644', 'full'],
    ['workflow', 'M', '.github/workflows/test-and-deploy.yml', '100644', 'full'],
    ['classifier', 'M', 'scripts/ci-change-scope.mjs', '100644', 'full'],
    ['backend', 'M', 'backend/production/views.py', '100644', 'full'],
    ['SVG script surface', 'M', 'frontend/public/board.svg', '100644', 'full'],
    ['path traversal', 'M', 'frontend/src/../backend.css', '100644', 'full'],
    ['control character', 'M', 'frontend/src/bad\n.css', '100644', 'full'],
  ];
  for (const [name, status, path, mode, expected] of cases) await t.test(name, () => {
    assert.equal(classify([{ status, path, mode }]), expected);
  });
  assert.equal(classify([]), 'full');
  assert.equal(classify([{ status: 'M', path: css, mode: '100644' }, { status: 'M', path: 'backend/models.py', mode: '100644' }]), 'full');
  assert.equal(classifyChanges([{ status: 'M', path: page, mode: '100644' }], () => { throw new Error('Missing blob'); }).mode, 'full');
});

function repository(t) {
  const root = mkdtempSync(join(tmpdir(), 'wj-ci-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-b', 'main');
  git('config', 'user.email', 'synthetic-ci@example.invalid');
  git('config', 'user.name', 'Synthetic CI Tests');
  const commit = (files, message = 'fixture commit') => {
    for (const [name, text] of Object.entries(files)) {
      const file = join(root, name);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
    }
    git('add', '--all'); git('commit', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  const base = commit({ [css]: '.board { font-size: 20px; }', [page]: source('<span>Before</span>'), 'backend/model.py': 'VALUE = 1\n' });
  return { root, git, commit, base };
}
const pushEvent = (before, after) => ({ ref: 'refs/heads/main', before, after });
const pushScope = (repo, head, before, evidence) => determineScope({ repository: repo.root, eventName: 'push',
  event: pushEvent(before, head), head, loadDeploymentEvidence: typeof evidence === 'function' ? evidence : async () => evidence });

test('PR uses merge-base, excluding unrelated base-branch backend work', async t => {
  const repo = repository(t);
  repo.git('checkout', '-b', 'feature');
  const head = repo.commit({ [css]: '.board { font-size: 16px; }' });
  repo.git('checkout', 'main');
  const base = repo.commit({ 'backend/model.py': 'VALUE = 2\n' });
  repo.git('checkout', 'feature');
  const result = await determineScope({ repository: repo.root, head, eventName: 'pull_request',
    event: { pull_request: { head: { sha: head }, base: { sha: base, ref: 'main' } } },
    loadDeploymentEvidence: () => { throw new Error('PR must not load deployment credentials/evidence'); } });
  assert.equal(result.mode, 'ui');
});

test('push evaluates every commit, not only the last CSS commit', async t => {
  const repo = repository(t);
  repo.commit({ 'backend/model.py': 'VALUE = 2\n' });
  const head = repo.commit({ [css]: '.board { font-size: 16px; }' });
  let loaded = false;
  const result = await pushScope(repo, head, repo.base, () => { loaded = true; throw new Error('unnecessary'); });
  assert.equal(result.mode, 'full');
  assert.equal(loaded, false);
});

test('missed backend push forces full despite current push being only CSS', async t => {
  const repo = repository(t);
  const missed = repo.commit({ 'backend/model.py': 'VALUE = 2\n' });
  const head = repo.commit({ [css]: '.board { font-size: 16px; }' });
  const result = await pushScope(repo, head, missed, { validatedBackend: repo.base, deployedFrontend: repo.base });
  assert.equal(result.mode, 'full');
  assert.match(result.reason, /Pending deployment/);
});

test('stale frontend baseline forces catch-up even when backend deployment is current', async t => {
  const repo = repository(t);
  const backendDeployed = repo.commit({ 'backend/model.py': 'VALUE = 2\n' });
  const head = repo.commit({ [css]: '.board { font-size: 16px; }' });
  assert.equal((await pushScope(repo, head, backendDeployed,
    { validatedBackend: backendDeployed, deployedFrontend: repo.base })).mode, 'full');
});

test('UI-only push requires both backend and live frontend baselines', async t => {
  const repo = repository(t);
  const head = repo.commit({ [css]: '.board { font-size: 16px; }' });
  assert.equal((await pushScope(repo, head, repo.base, { validatedBackend: repo.base, deployedFrontend: repo.base })).mode, 'ui');
  assert.equal((await pushScope(repo, head, repo.base, { validatedBackend: head, deployedFrontend: head })).mode, 'ui');
  for (const evidence of [undefined, {}, { validatedBackend: repo.base }, { validatedBackend: 'invalid', deployedFrontend: repo.base },
    { validatedBackend: repo.base, deployedFrontend: 'f'.repeat(40) }]) {
    assert.equal((await pushScope(repo, head, repo.base, evidence)).mode, 'full');
  }
  assert.equal((await pushScope(repo, head, repo.base, async () => { throw new Error('API unavailable'); })).mode, 'full');
  assert.equal((await pushScope(repo, head, '0'.repeat(40), { validatedBackend: repo.base, deployedFrontend: repo.base })).mode, 'full');
});

test('force-push ancestry, event identity, checkout mismatch and manual fail closed', async t => {
  const repo = repository(t);
  const oldHead = repo.commit({ 'backend/model.py': 'VALUE = 2\n' });
  repo.git('checkout', '-b', 'replacement', repo.base);
  const head = repo.commit({ [css]: '.board { font-size: 16px; }' });
  const evidence = { validatedBackend: repo.base, deployedFrontend: repo.base };
  assert.equal((await pushScope(repo, head, oldHead, evidence)).mode, 'full');
  assert.equal((await pushScope(repo, head, repo.base, { ...evidence, validatedBackend: oldHead })).mode, 'full');
  const args = { repository: repo.root, head, eventName: 'push', event: pushEvent(repo.base, head), loadDeploymentEvidence: async () => evidence };
  for (const override of [{ eventName: 'workflow_dispatch' }, { eventName: 'schedule' }, { head: oldHead },
    { event: { ...args.event, ref: 'refs/heads/feature' } }, { event: { ...args.event, after: oldHead } },
    { event: { ...args.event, forced: true } },
    { eventName: 'pull_request', event: { pull_request: { head: { sha: head }, base: { sha: repo.base, ref: 'develop' } } } }]) {
    assert.equal((await determineScope({ ...args, ...override })).mode, 'full');
  }
});

const fixtureRepository = 'example/wj_reporting';
const fixtureSha = digit => digit.repeat(40);
const run = (id, extra = {}) => ({ id, head_branch: 'main', conclusion: 'success', event: 'push',
  path: '.github/workflows/test-and-deploy.yml', repository: { full_name: fixtureRepository }, head_sha: fixtureSha(String(id)), ...extra });
const fullJobs = () => ({ total_count: 2, jobs: [
  { name: 'Deploy production from main', conclusion: 'success', steps: [{ name: 'Deploy production backend', conclusion: 'success' }] },
  { name: 'Verify production deployment', conclusion: 'success' },
] });
function mockEvidence({ runs = [run(1)], jobs = { 1: fullJobs() }, build = { branch: 'main', commit: fixtureSha('a') }, fail = false } = {}) {
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const parsed = new URL(url);
    if (fail) return { ok: false };
    if (parsed.hostname === 'wj-reporting.onrender.com') return { ok: true, json: async () => build };
    if (parsed.pathname.endsWith('/runs')) return { ok: true, json: async () => ({ workflow_runs: runs }) };
    const id = parsed.pathname.match(/\/runs\/(\d+)\/jobs$/)?.[1];
    if (!id || !jobs[id]) throw new Error(`Unexpected fixture request ${url}`);
    return { ok: true, json: async () => jobs[id] };
  };
  return { calls, request };
}
const load = fixture => loadDeploymentEvidence({ repository: fixtureRepository, token: 'synthetic-test-token', request: fixture.request });

test('deployment evidence skips successful test-only and UI-only runs', async () => {
  const uiOnly = fullJobs(); uiOnly.jobs[0].steps[0].conclusion = 'skipped';
  const fixture = mockEvidence({ runs: [run(3, { event: 'workflow_dispatch' }), run(2), run(1)], jobs: {
    3: { total_count: 1, jobs: [{ name: 'Validate application', conclusion: 'success' }] }, 2: uiOnly, 1: fullJobs(),
  } });
  assert.deepEqual(await load(fixture), { validatedBackend: fixtureSha('1'), deployedFrontend: fixtureSha('a') });
  assert.equal(fixture.calls.filter(call => new URL(call.url).pathname.endsWith('/jobs')).length, 3);
  assert.equal(fixture.calls.find(call => call.url.startsWith('https://wj-reporting.onrender.com')).options.headers.Authorization, undefined);
  for (const call of fixture.calls.filter(call => call.url.startsWith('https://api.github.com'))) {
    assert.equal(call.options.headers.Authorization, 'Bearer synthetic-test-token');
    assert.equal(new URL(call.url).hostname, 'api.github.com');
  }
});

test('deployment evidence excludes foreign, PR, failed and unrelated workflow runs', async () => {
  const fixture = mockEvidence({ runs: [run(2, { event: 'pull_request' }), run(3, { head_branch: 'feature' }),
    run(4, { repository: { full_name: 'foreign/repo' } }), run(5, { path: '.github/workflows/other.yml' }),
    run(6, { conclusion: 'failure' }), run(1)] });
  assert.equal((await load(fixture)).validatedBackend, fixtureSha('1'));
  assert.equal(fixture.calls.filter(call => new URL(call.url).pathname.endsWith('/jobs')).length, 1);
});

test('manual deployment qualifies only with successful backend and verification jobs', async () => {
  const fixture = mockEvidence({ runs: [run(1, { event: 'workflow_dispatch' })] });
  assert.equal((await load(fixture)).validatedBackend, fixtureSha('1'));
});

test('baseline discovery remains bounded and fails closed after twenty UI releases', async () => {
  const uiOnly = fullJobs(); uiOnly.jobs[0].steps[0].conclusion = 'skipped';
  const runs = Array.from({ length: 21 }, (_, index) => run(index + 1, { head_sha: fixtureSha('b') }));
  const jobs = Object.fromEntries(runs.map(item => [item.id, item.id === 21 ? fullJobs() : uiOnly]));
  const fixture = mockEvidence({ runs, jobs });
  await assert.rejects(load(fixture), /No successful full/);
  assert.equal(fixture.calls.filter(call => new URL(call.url).pathname.endsWith('/jobs')).length, 20);
});

test('incomplete, unverified, unavailable and invalid deployment evidence rejects', async t => {
  const unverified = fullJobs(); unverified.jobs[1].conclusion = 'failure';
  const cases = [
    ['API failure', { fail: true }], ['wrong live branch', { build: { branch: 'feature', commit: fixtureSha('a') } }],
    ['invalid live commit', { build: { branch: 'main', commit: 'bad' } }], ['no baseline', { runs: [] }],
    ['unverified deployment', { jobs: { 1: unverified } }],
    ['paginated jobs missing', { jobs: { 1: { ...fullJobs(), total_count: 101 } } }],
    ['missing total count', { jobs: { 1: { jobs: fullJobs().jobs } } }],
    ['negative total count', { jobs: { 1: { ...fullJobs(), total_count: -1 } } }],
    ['fractional total count', { jobs: { 1: { ...fullJobs(), total_count: 2.5 } } }],
    ['string total count', { jobs: { 1: { ...fullJobs(), total_count: '2' } } }],
    ['unsafe integer total count', { jobs: { 1: { ...fullJobs(), total_count: Number.MAX_SAFE_INTEGER + 1 } } }],
    ['understated total count', { jobs: { 1: { ...fullJobs(), total_count: 1 } } }],
    ['malformed jobs', { jobs: { 1: { total_count: 2, jobs: null } } }],
  ];
  for (const [name, options] of cases) await t.test(name, async () => assert.rejects(load(mockEvidence(options))));
  await assert.rejects(loadDeploymentEvidence({ repository: fixtureRepository, token: '', request: () => { throw new Error('Must not request'); } }));
});
