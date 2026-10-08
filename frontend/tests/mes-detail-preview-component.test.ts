import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
import * as model from '../src/pages/quality/inspection-requests/mesDetailPreviewModel.ts';
import { previewFixture } from './fixtures/mes-detail-preview.ts';

// Run the actual component with deterministic hooks and an explicit API stub.
// Browser globals are function arguments: no DOM, HTTP, auth storage or timers run.
const compiled = ts.transpileModule(readFileSync(new URL('../src/pages/quality/inspection-requests/MesDetailPreview.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const SESSION = 'SYNTHETIC-MES-PREVIEW-SESSION';
const PRIVATE = 'SYNTHETIC-NOT-FOR-DISPLAY-OR-EXPORT';
type Element = { type: unknown; props: Record<string, any> };
type Hook = { value?: any; deps?: unknown[]; cleanup?: () => void };
type Props = { actorId: number; sessionId: string | null; lang: 'ko' | 'zh'; disabled: boolean };

function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<unknown>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}
function elements(node: any): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  return !node || typeof node !== 'object' || !('props' in node) ? [] : [node, ...elements(node.props.children)];
}
function content(node: any): string {
  if (Array.isArray(node)) return node.map(content).join('');
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  return typeof node === 'object' ? content(node.props?.children) : String(node);
}
function harness(options: Partial<Props> = {}) {
  let props: Props = { actorId: 18, sessionId: SESSION, lang: 'ko', disabled: false, ...options };
  const reply = deferred();
  const hooks: Hook[] = [];
  const effects: (() => void)[] = [];
  const calls: { sessionId: string | null; signal: AbortSignal }[] = [];
  const blobs: { parts: unknown[]; options: unknown }[] = [];
  const anchors: { href: string; download: string; clicks: number; click: () => void }[] = [];
  const urls: unknown[] = [];
  const revoked: string[] = [];
  const timers: { callback: () => void; delay: number }[] = [];
  let cursor = 0;
  let dirty = true;
  let active = true;
  let sessionCurrent = true;
  let stateWrites = 0;
  let tree: Element | null = null;
  const same = (a?: unknown[], b?: unknown[]) => Boolean(a && b && a.length === b.length && a.every((value, i) => Object.is(value, b[i])));
  const dependencies: Record<string, unknown> = {
    react: {
      useState(initial: any) {
        const index = cursor++;
        const hook = hooks[index] ?? (hooks[index] = { value: typeof initial === 'function' ? initial() : initial });
        return [hook.value, (next: any) => {
          stateWrites += 1;
          const value = typeof next === 'function' ? next(hook.value) : next;
          if (!Object.is(value, hook.value)) { hook.value = value; dirty = true; }
        }];
      },
      useRef(initial: any) { const index = cursor++; return (hooks[index] ?? (hooks[index] = { value: { current: initial } })).value; },
      useEffect(effect: () => (() => void) | void, deps: unknown[]) {
        const index = cursor++;
        const hook = hooks[index] ?? (hooks[index] = {});
        if (!same(hook.deps, deps)) {
          hook.deps = deps;
          effects.push(() => { hook.cleanup?.(); hook.cleanup = effect() || undefined; });
        }
      },
    },
    'react/jsx-runtime': { jsx: (type: unknown, props: any) => ({ type, props }), jsxs: (type: unknown, props: any) => ({ type, props }), Fragment: 'Fragment' },
    '@/domains/auth/auth-transition': { isAuthSessionCurrent: (id: string | null) => sessionCurrent && id === SESSION },
    './api': { getMesDetailPreview: (sessionId: string | null, signal: AbortSignal) => { calls.push({ sessionId, signal }); return reply.promise; } },
    './mesDetailPreviewModel': model,
    './copy': { inspectionTime: () => 'SYNTHETIC observation time' },
  };
  class SyntheticBlob {
    constructor(parts: unknown[], options: unknown) { blobs.push({ parts, options }); }
  }
  const exports: Record<string, any> = {};
  new Function('require', 'exports', 'Blob', 'URL', 'document', 'window', compiled)(
    (name: string) => { assert.ok(name in dependencies, `Unexpected module: ${name}`); return dependencies[name]; },
    exports, SyntheticBlob,
    { createObjectURL: (blob: unknown) => { urls.push(blob); return 'blob:synthetic-preview'; }, revokeObjectURL: (url: string) => revoked.push(url) },
    { createElement: (tag: string) => {
      assert.equal(tag, 'a');
      const anchor = { href: '', download: '', clicks: 0, click() { this.clicks += 1; } };
      anchors.push(anchor); return anchor;
    } },
    { setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; } },
  );
  function render() { dirty = false; cursor = 0; tree = exports.default(props); for (const effect of effects.splice(0)) effect(); }
  async function settle() {
    for (let i = 0; i < 12; i += 1) { if (active && dirty) render(); await Promise.resolve(); }
    if (active) assert.equal(dirty, false, 'Preview must settle without polling or a rendering loop');
  }
  function unmount() {
    if (!active) return;
    active = false; hooks.forEach((hook) => hook.cleanup?.()); tree = null;
  }
  return {
    reply, calls, blobs, anchors, urls, revoked, timers, settle, unmount,
    nodes: () => elements(tree), text: () => content(tree), writes: () => stateWrites,
    button: (label: string) => elements(tree).find((node) => node.type === 'button' && content(node) === label),
    expireSession: () => { sessionCurrent = false; dirty = true; },
    setProps: (patch: Partial<Props>) => { props = { ...props, ...patch }; dirty = true; },
  };
}

test('preview GET requires one explicit enabled current-actor click and deduplicates pending clicks', async () => {
  const fixture = harness();
  try {
    await fixture.settle();
    assert.equal(fixture.calls.length, 0, 'Mount must not read MES');
    assert.equal(fixture.timers.length, 0, 'Mount must not schedule polling');
    const click = fixture.button('지정 MES 검사 조회')!.props.onClick;
    click(); click();
    await fixture.settle();
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].sessionId, SESSION);
    assert.equal(fixture.calls[0].signal.aborted, false);
    assert.equal(fixture.button('조회 중…')!.props.disabled, true);
    const data = previewFixture(); const before = JSON.stringify(data);
    fixture.reply.resolve(model.parseMesDetailPreview(data));
    await fixture.settle();
    assert.match(fixture.text(), /QC-26100300323/);
    assert.equal(fixture.nodes().filter((node) => node.type === 'tr').length, 17);
    assert.equal(fixture.nodes().some((node) => node.type === 'details' && node.props.open), false);
    assert.equal(fixture.text().includes(data.qc_id), false);
    assert.equal(fixture.text().includes(data.snapshot_id!), false);
    assert.match(fixture.text(), /사출기 선택과 별개로 조회/);
    assert.equal(fixture.calls.length, 1, 'A successful read must not dispatch follow-up requests');
    assert.equal(JSON.stringify(data), before, 'Displaying metadata must not alter source data');
    assert.equal(fixture.nodes().some((node) => ['input', 'textarea', 'select', 'form'].includes(String(node.type))), false);
  } finally { fixture.unmount(); }
  for (const options of [{ actorId: 12 }, { actorId: 19 }, { sessionId: null }, { disabled: true }]) {
    const blocked = harness(options);
    try {
      await blocked.settle();
      const button = blocked.button('지정 MES 검사 조회');
      if ('disabled' in options) { assert.equal(button!.props.disabled, true); button!.props.onClick(); }
      else assert.equal(blocked.nodes().length, 0);
      await blocked.settle();
      assert.equal(blocked.calls.length, 0);
    } finally { blocked.unmount(); }
  }
});

test('late success and failure cannot update an expired session or unmounted preview; unmount aborts the read', async () => {
  for (const boundary of ['session', 'unmount'] as const) for (const outcome of ['success', 'failure'] as const) {
    const fixture = harness();
    try {
      await fixture.settle();
      fixture.button('지정 MES 검사 조회')!.props.onClick();
      await fixture.settle();
      if (boundary === 'session') fixture.expireSession();
      else { fixture.unmount(); assert.equal(fixture.calls[0].signal.aborted, true); }
      const writesBefore = fixture.writes();
      if (outcome === 'success') fixture.reply.resolve(model.parseMesDetailPreview(previewFixture()));
      else fixture.reply.reject(new Error(PRIVATE));
      await fixture.settle();
      assert.equal(fixture.writes(), writesBefore, 'Late replies must not adopt data, errors or busy state');
      assert.equal(fixture.nodes().length, 0);
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.blobs.length, 0);
    } finally { fixture.unmount(); }
  }
});

test('failed reads show fixed Korean and Chinese guidance without raw errors or automatic retry', async () => {
  for (const lang of ['ko', 'zh'] as const) {
    const fixture = harness({ lang });
    try {
      await fixture.settle();
      fixture.button(lang === 'ko' ? '지정 MES 검사 조회' : '查询指定 MES 检验')!.props.onClick();
      fixture.reply.reject({ message: PRIVATE, response: { data: { detail: PRIVATE, access_token: PRIVATE } } });
      await fixture.settle();
      const alerts = fixture.nodes().filter((node) => node.props.role === 'alert');
      assert.equal(alerts.length, 1);
      assert.equal(content(alerts[0]), lang === 'ko'
        ? '지정 MES 검사를 조회하지 못했습니다. MES 연결 상태와 조회 권한을 확인한 뒤 다시 시도해 주세요.'
        : '无法查询指定 MES 检验。请确认 MES 连接状态和查询权限后重试。');
      assert.equal(fixture.text().includes(PRIVATE), false);
      assert.equal(fixture.calls.length, 1);
      assert.equal(fixture.timers.length, 0);
      assert.equal(fixture.blobs.length, 0);
      assert.equal(fixture.nodes().some((node) => node.type === 'button' && /내려받기|下载/.test(content(node))), false);
    } finally { fixture.unmount(); }
  }
});

test('metadata download revalidates the allowlisted projection and cannot run after session loss', async () => {
  const fixture = harness();
  try {
    await fixture.settle();
    assert.equal(fixture.button('조회 메타데이터 내려받기'), undefined);
    fixture.button('지정 MES 검사 조회')!.props.onClick();
    // Even unexpected fields on an otherwise valid API result cannot enter export.
    const data = previewFixture();
    const result = { ...data, access_token: PRIVATE, measurements: [PRIVATE], raw_error: PRIVATE,
      items: data.items.map((item) => ({ ...item, value: PRIVATE, measured_value: PRIVATE })) };
    const before = JSON.stringify(result);
    fixture.reply.resolve(result);
    await fixture.settle();
    assert.equal(fixture.text().includes(PRIVATE), false);
    assert.equal(fixture.blobs.length, 0, 'Successful reads must not download automatically');
    const download = fixture.button('조회 메타데이터 내려받기')!.props.onClick;
    download();
    assert.equal(fixture.blobs.length, 1);
    assert.deepEqual(fixture.blobs[0].options, { type: 'application/json;charset=utf-8' });
    const contents = fixture.blobs[0].parts.join('');
    assert.deepEqual(JSON.parse(contents), model.parseMesDetailPreview(result));
    assert.equal(contents.includes(PRIVATE), false);
    assert.equal(JSON.stringify(result), before);
    assert.equal(fixture.anchors[0].href, 'blob:synthetic-preview');
    assert.equal(fixture.anchors[0].download, model.mesDetailPreviewDownload(data).filename);
    assert.equal(fixture.anchors[0].clicks, 1);
    assert.equal(fixture.urls.length, 1);
    assert.deepEqual(fixture.revoked, []);
    assert.equal(fixture.timers.length, 1);
    assert.equal(fixture.timers[0].delay, 1000);
    fixture.timers[0].callback();
    assert.deepEqual(fixture.revoked, ['blob:synthetic-preview']);
    fixture.setProps({ disabled: true }); await fixture.settle();
    const disabledDownload = fixture.button('조회 메타데이터 내려받기')!;
    assert.equal(disabledDownload.props.disabled, true); disabledDownload.props.onClick();
    fixture.expireSession(); download(); await fixture.settle();
    assert.equal(fixture.blobs.length, 1, 'Disabled and stale handlers must not export');
    assert.equal(fixture.calls.length, 1, 'Downloading metadata must not call MES');
  } finally { fixture.unmount(); }
});
