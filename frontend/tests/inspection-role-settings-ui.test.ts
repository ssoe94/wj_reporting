import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as workflow from '../src/pages/quality/inspection-requests/workflow.ts';
import { inspectionCopy } from '../src/pages/quality/inspection-requests/copy.ts';
import { inspectionRoleCopy } from '../src/pages/quality/inspection-requests/roleCopy.ts';
import type { InspectionRoleSetting, InspectionRoleSettings } from '../src/pages/quality/inspection-requests/roleModel.ts';

function compile(file: string) {
  return ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
}
const helperExports: Record<string, unknown> = {};
new Function('require', 'exports', compile('../src/pages/quality/inspection-requests/roleShiftSettingsModel.ts'))((name: string) => {
  assert.equal(name, './workflow'); return workflow;
}, helperExports);
const helper = helperExports as typeof import('../src/pages/quality/inspection-requests/roleShiftSettingsModel.ts');
const compiled = compile('../src/pages/quality/inspection-requests/RoleSettings.tsx');
const text = inspectionRoleCopy.ko;
type Element = { type: unknown; props: Record<string, unknown>; key?: unknown };
type Entry = { node: Element; path: (string | number)[] };
function entries(value: unknown, path: (string | number)[] = []): Entry[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => entries(child, [...path, index]));
  if (!value || typeof value !== 'object' || !('props' in value)) return [];
  const node = value as Element;
  return [{ node, path }, ...entries(node.props.children, [...path, 'children'])];
}
function content(value: unknown): string {
  if (Array.isArray(value)) return value.map(content).join('');
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value === 'object') return content((value as Element).props?.children);
  return String(value);
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const candidates = [
  { id: 101, name: 'SYNTHETIC-SAME', username: 'synthetic-appearance', mes_user_id: 'SYNTHETIC-MES-A' },
  { id: 102, name: 'SYNTHETIC-SAME', username: 'synthetic-dimension', mes_user_id: null },
];
function setting(): InspectionRoleSetting {
  return { id: 501, version: 7, code: 'SYNTHETIC-IMMUTABLE-CODE', label: 'SYNTHETIC-EXISTING', timezone: 'Asia/Shanghai',
    start_time: '08:00:00', end_time: '20:00:00', appearance_assignee: 101, dimension_assignee: 102, active: true,
    effective_from_local: '2026-10-31T08:00', effective_until_local: '2026-11-01T08:00',
    effective_from: '2026-10-31T00:00:00Z', effective_until: '2026-11-01T00:00:00Z' };
}
const settings = (rows: InspectionRoleSetting[] = []): InspectionRoleSettings => ({ settings: rows, candidates, can_configure: true });
type SaveCall = [number | null, Record<string, unknown>, string, string | null, number];
function harness(options: { initial?: InspectionRoleSettings; get?: Promise<InspectionRoleSettings>; save?: (call: SaveCall) => Promise<InspectionRoleSetting>; stale?: boolean } = {}) {
  const hooks: unknown[] = []; let cursor = 0; let tree: Element; let currentSession = options.stale ? 'SYNTHETIC-SESSION-B' : 'SYNTHETIC-SESSION-A';
  const reads: (string | null)[] = []; const saves: SaveCall[] = []; const dirty: boolean[] = []; const locks: unknown[] = [];
  const effects: (() => void)[] = [];
  type Hook = { deps?: unknown[]; value?: unknown; cleanup?: () => void };
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, index) => Object.is(value, b[index])));
  const dependencies: Record<string, unknown> = {
    react: {
      useState: (initial: unknown) => { const index = cursor++; if (!(index in hooks)) hooks[index] = typeof initial === 'function' ? initial() : initial; return [hooks[index], (next: unknown) => { hooks[index] = typeof next === 'function' ? next(hooks[index]) : next; }]; },
      useRef: (initial: unknown) => { const index = cursor++; return hooks[index] ??= { current: initial }; },
      useCallback: (fn: unknown, deps: unknown[]) => { const index = cursor++; const hook = (hooks[index] ??= {}) as Hook; if (!same(hook.deps, deps)) { hook.value = fn; hook.deps = deps; } return hook.value; },
      useEffect: (fn: () => void | (() => void), deps?: unknown[]) => { const index = cursor++; const hook = (hooks[index] ??= {}) as Hook; if (!same(hook.deps, deps)) { hook.deps = deps; effects.push(() => { hook.cleanup?.(); hook.cleanup = fn() || undefined; }); } },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: Record<string, unknown>, key?: unknown) => ({ type, props, key }), jsxs: (type: unknown, props: Record<string, unknown>, key?: unknown) => ({ type, props, key }) },
    '@/domains/auth/auth-transition': { assertAuthSessionCurrent: (session: string) => { if (session !== currentSession) throw new Error('Synthetic stale session'); } },
    './copy': { inspectionCopy }, './roleCopy': { inspectionRoleCopy }, './workflow': workflow, './roleShiftSettingsModel': helper,
    './api': {
      getInspectionRoleSettings: (session: string | null) => { reads.push(session); return options.get || Promise.resolve(options.initial || settings()); },
      saveInspectionRoleSetting: async (...call: SaveCall) => {
        saves.push(call); if (options.save) return options.save(call);
        const [id, payload] = call;
        return { ...setting(), ...payload, id: id || 502, code: String(payload.code || setting().code), version: 8 } as InspectionRoleSetting;
      },
    },
  };
  const exports: Record<string, unknown> = {};
  new Function('require', 'exports', 'window', compiled)((name: string) => { assert.ok(name in dependencies, name); return dependencies[name]; }, exports, { confirm: () => true });
  const props = { userId: 101, sessionId: 'SYNTHETIC-SESSION-A', lang: 'ko', onDirty: (value: boolean) => dirty.push(value), onLocked: (...value: unknown[]) => locks.push(value), onClose: () => {} };
  const Component = exports.default as (props: Record<string, unknown>) => Element;
  const render = () => { cursor = 0; tree = Component(props); for (const effect of effects.splice(0)) effect(); return tree; };
  const all = () => entries(tree);
  const field = (id: string) => { const entry = all().find(({ node }) => node.props.id === id); assert.ok(entry, id); return entry.node; };
  const change = (id: string, value: string | boolean) => { const node = field(id); const fn = node.props.onChange as (event: unknown) => void; fn({ target: typeof value === 'boolean' ? { checked: value } : { value } }); render(); };
  const button = (label: string) => { const node = all().find(({ node }) => node.type === 'button' && content(node) === label)?.node; assert.ok(node, label); return node; };
  const click = (label: string) => { (button(label).props.onClick as () => void)(); render(); };
  const submit = () => { const form = all().find(({ node }) => node.type === 'form')!.node; (form.props.onSubmit as (event: unknown) => void)({ preventDefault: () => {} }); render(); };
  const settle = async () => { for (let i = 0; i < 8; i++) { await Promise.resolve(); render(); } };
  render();
  return { render, all, field, change, click, button, submit, settle, reads, saves, dirty, locks, text: () => content(tree), stale: () => { currentSession = 'SYNTHETIC-SESSION-B'; },
    signature: (id: string) => { const entry = all().find(({ node }) => node.props.id === id)!; return { type: entry.node.type, inputType: entry.node.props.type, id: entry.node.props.id, key: entry.node.key, path: entry.path }; } };
}
function fillNight(view: ReturnType<typeof harness>) {
  view.change('inspection-shift-preset', 'night');
  view.change('inspection-shift-effective-from', '2026-10-31T20:00');
  view.change('inspection-shift-effective-until', '2026-11-01T08:00');
  view.change('inspection-shift-appearance-assignee', '101'); view.change('inspection-shift-dimension-assignee', '102');
  view.change('inspection-shift-active', true);
}

test('mount reads settings once without writing or selecting any operational period or inspector', async () => {
  const view = harness(); await view.settle();
  assert.deepEqual(view.reads, ['SYNTHETIC-SESSION-A']); assert.equal(view.saves.length, 0);
  assert.equal(view.field('inspection-shift-start').props.value, '08:00'); assert.equal(view.field('inspection-shift-end').props.value, '20:00');
  for (const id of ['inspection-shift-effective-from', 'inspection-shift-effective-until', 'inspection-shift-appearance-assignee', 'inspection-shift-dimension-assignee']) assert.equal(view.field(id).props.value, '', id);
  assert.equal(view.field('inspection-shift-active').props.checked, false); assert.match(view.text(), /Asia\/Shanghai/);
  assert.equal(view.button(text.saveSetting).props.disabled, true);
});

test('night preset changes offered clocks and label while retaining explicit blank period and owners', async () => {
  const view = harness(); await view.settle(); view.change('inspection-shift-preset', 'night');
  assert.equal(view.field('inspection-shift-start').props.value, '20:00'); assert.equal(view.field('inspection-shift-end').props.value, '08:00');
  assert.equal(view.field('inspection-shift-label').props.value, text.night);
  for (const id of ['inspection-shift-effective-from', 'inspection-shift-effective-until', 'inspection-shift-appearance-assignee', 'inspection-shift-dimension-assignee']) assert.equal(view.field(id).props.value, '', id);
  assert.equal(view.field('inspection-shift-active').props.checked, false); assert.equal(view.saves.length, 0);
});

test('datetime inputs keep structural type, id, key and path through asynchronous data adoption and edits', async () => {
  const response = deferred<InspectionRoleSettings>(); const view = harness({ get: response.promise });
  const ids = ['inspection-shift-effective-from', 'inspection-shift-effective-until'];
  const before = ids.map(view.signature);
  response.resolve(settings()); await view.settle();
  assert.deepEqual(ids.map(view.signature), before);
  fillNight(view); assert.deepEqual(ids.map(view.signature), before);
  view.change('inspection-shift-effective-until', '2026-11-02T08:00');
  assert.deepEqual(ids.map(view.signature), before); assert.equal(view.field(ids[0]).props.type, 'datetime-local');
  assert.equal(view.saves.length, 0);
});

test('explicit valid nighttime activation dispatches one local-period payload with original session and actor', async () => {
  const view = harness(); await view.settle(); fillNight(view); view.submit(); await view.settle();
  assert.equal(view.saves.length, 1);
  const [id, payload, key, session, actor] = view.saves[0];
  assert.equal(id, null); assert.equal(session, 'SYNTHETIC-SESSION-A'); assert.equal(actor, 101); assert.match(key, /^[a-f0-9-]{36}$/);
  assert.equal(payload.timezone, 'Asia/Shanghai'); assert.equal(payload.start_time, '20:00'); assert.equal(payload.end_time, '08:00');
  assert.equal(payload.effective_from_local, '2026-10-31T20:00'); assert.equal(payload.effective_until_local, '2026-11-01T08:00');
  assert.equal(payload.appearance_assignee, 101); assert.equal(payload.dimension_assignee, 102); assert.equal(payload.active, true);
  for (const field of ['effective_from', 'effective_until', 'actor', 'actor_id', 'user_id', 'version']) assert.equal(field in payload, false, field);
  assert.match(view.text(), /저장했습니다/);
});

test('activation with missing period or duplicate owners stays local and reports validation', async () => {
  const view = harness(); await view.settle(); view.change('inspection-shift-active', true); view.submit(); await view.settle();
  assert.equal(view.saves.length, 0); assert.ok(view.all().some(({ node }) => node.props.role === 'alert'));
  fillNight(view); view.change('inspection-shift-dimension-assignee', '101'); view.submit(); await view.settle();
  assert.equal(view.saves.length, 0); assert.equal(view.field('inspection-shift-appearance-assignee').props.value, '101');
});

test('existing row update retains immutable code and original version with explicit change reason', async () => {
  const row = setting(); const view = harness({ initial: settings([row]) }); await view.settle();
  const choose = view.all().find(({ node }) => node.type === 'button' && content(node).startsWith(row.label))!.node;
  (choose.props.onClick as () => void)(); view.render();
  view.change('inspection-shift-effective-until', '2026-11-02T08:00'); view.change('inspection-shift-change-reason', '  SYNTHETIC later period  '); view.submit(); await view.settle();
  assert.equal(view.saves.length, 1); assert.equal(view.saves[0][0], row.id);
  assert.equal(view.saves[0][1].version, 7); assert.equal(view.saves[0][1].reason, 'SYNTHETIC later period'); assert.equal('code' in view.saves[0][1], false);
  assert.equal(row.code, 'SYNTHETIC-IMMUTABLE-CODE'); assert.equal(row.version, 7); assert.equal(row.effective_until_local, '2026-11-01T08:00');
});

test('new period row after existing selection creates a unique blank draft without copying owners or dates', async () => {
  const row = setting(); const view = harness({ initial: settings([row]) }); await view.settle();
  const choose = view.all().find(({ node }) => node.type === 'button' && content(node).startsWith(row.label))!.node;
  (choose.props.onClick as () => void)(); view.render(); assert.ok(view.text().includes(row.code));
  view.click(text.newSetting);
  const draftCode = view.all().find(({ node }) => node.type === 'dd' && /^SHIFT-/.test(content(node)))!.node;
  const code = content(draftCode); assert.notEqual(code, row.code);
  for (const id of ['inspection-shift-effective-from', 'inspection-shift-effective-until', 'inspection-shift-appearance-assignee', 'inspection-shift-dimension-assignee']) assert.equal(view.field(id).props.value, '', id);
  assert.equal(view.field('inspection-shift-active').props.checked, false);
  view.click(text.newSetting); const nextCode = content(view.all().find(({ node }) => node.type === 'dd' && /^SHIFT-/.test(content(node)))!.node);
  assert.notEqual(nextCode, code); assert.equal(view.saves.length, 0);
});

test('overlapping period 409 preserves editable draft for explicit correction without version reconciliation', async () => {
  const view = harness({ save: async () => { throw { response: { status: 409, data: { code: 'shift_overlap', detail: 'SYNTHETIC overlap' } } }; } });
  await view.settle(); fillNight(view); view.submit(); await view.settle();
  assert.equal(view.saves.length, 1); assert.match(view.text(), /시간이 겹칩니다/);
  assert.equal(view.field('inspection-shift-effective-from').props.value, '2026-10-31T20:00');
  assert.equal(view.all().find(({ node }) => node.type === 'fieldset')!.node.props.disabled, false);
  assert.equal(view.all().some(({ node }) => node.type === 'button' && content(node) === text.compare), false);
  view.change('inspection-shift-effective-from', '2026-11-01T20:00');
  assert.equal(view.field('inspection-shift-effective-from').props.value, '2026-11-01T20:00'); assert.equal(view.saves.length, 1);
});

test('candidate options distinguish same-name WJ actors and disclose absent MES linkage without executor claims', async () => {
  const view = harness(); await view.settle(); const options = view.all().filter(({ node }) => node.type === 'option').map(({ node }) => content(node));
  assert.ok(options.some(label => label.includes('synthetic-appearance') && label.includes('#101') && label.includes('SYNTHETIC-MES-A')));
  assert.ok(options.some(label => label.includes('synthetic-dimension') && label.includes('#102') && label.includes('연결 미확인')));
  assert.match(view.text(), /식별자만으로 MES 권한이나 검사 실행자가 확인되지는 않습니다/);
});

test('changed session blocks draft mutation and save before transport', async () => {
  const view = harness(); await view.settle(); fillNight(view); view.stale();
  view.change('inspection-shift-effective-from', '2026-11-01T20:00'); view.submit(); await view.settle();
  assert.equal(view.field('inspection-shift-effective-from').props.value, '2026-10-31T20:00'); assert.equal(view.saves.length, 0);
});

test('late initial GET cannot adopt account data after a session change', async () => {
  const response = deferred<InspectionRoleSettings>(); const view = harness({ get: response.promise }); view.stale();
  response.resolve(settings([setting()])); await view.settle();
  assert.deepEqual(view.reads, ['SYNTHETIC-SESSION-A']); assert.equal(view.text().includes('SYNTHETIC-EXISTING'), false);
  assert.equal(view.text().includes('synthetic-appearance'), false);
  assert.equal(view.all().find(({ node }) => node.type === 'fieldset')!.node.props.disabled, true); assert.equal(view.saves.length, 0);
});

test('initial stale session never starts the settings read', async () => {
  const view = harness({ stale: true }); await view.settle(); assert.deepEqual(view.reads, []); assert.deepEqual(view.saves, []);
});
