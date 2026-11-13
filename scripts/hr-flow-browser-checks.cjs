'use strict';

const assert = require('node:assert/strict');
const XLSX = require('../frontend/node_modules/xlsx');

const closeMonth = '2026-10';
const workMonth = '2026-11';
const day = '2026-11-12';
const payrollPath = '/api/analytics/hr/workbook-preview/';
const workPaths = ['dashboard', 'personnel', 'work'].map(name => '/hr/' + name);
const personnelLabels = ['급여 파일 올리기', '사번 확인', '부서·파트 배치', '인건비 집계'];
const dailyLabels = ['每日出勤', '本月预测', '标准设置'];
const upload = '[data-hr-file-drop="payroll"]';
const reference = '[data-hr-file-drop="reference"]';
const generic = '[data-hr-file-drop="single"]';
const stepLinks = '.hr-flow-steps a';
const activeStep = '.hr-flow-steps [aria-current="step"]';

function workbook(name, rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Synthetic');
  return { name, content: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }).toString('base64') };
}

const classificationRows = [
  { code: 'SYN-A', name: '合成测试员', employment_type: 'contract', source_department: '注塑', source_function: '操作工', source_row: 2 },
  { name: '测试甲', employment_type: 'contract', source_department: '注塑', source_function: '操作工', source_row: 3 },
];
const classification = workbook('synthetic-reference.xlsx', [
  ['序号', '分类', '姓名', '部门', '雇用性质', '工号'],
  [1, '操作工', '合成测试员', '注塑', '合同工', 'SYN-A'],
  [2, '操作工', '测试甲', '注塑', '合同工', ''],
]);
const payroll = workbook('synthetic-合同工.xlsx', [
  ['2026年', '工号', '姓名', '职务', '部门', '应发工资', '实发工资'],
  ['11月', 'SYN-A', '合成测试员', '测试操作员', '注塑', 1037.35, 997.35],
]);
const requiresReview = workbook('synthetic-review-合同工.xlsx', [
  ['2026年', '工号', '姓名', '职务', '部门', '应发工资', '实发工资'],
  ['11月', '90991', '测试甲', '测试操作员', '注塑', 1200.35, 997.35],
]);
const other = workbook('synthetic-single.xlsx', [
  ['月份', '工号', '姓名', '职务', '部门', '应发工资'],
  ['2026-02', 'SYN-B', '合成测试员乙', '测试操作员', '注塑', 400.51],
]);

async function transfer(page, target, type, files, { text = '' } = {}) {
  return page.locator(target).evaluate((element, { type, files, text }) => {
    const dataTransfer = new DataTransfer();
    if (text) dataTransfer.setData('text/plain', text);
    for (const file of files) {
      const bytes = Uint8Array.from(atob(file.content ?? ''), value => value.charCodeAt(0));
      dataTransfer.items.add(new File([bytes], file.name, {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      }));
    }
    const event = new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true });
    element.dispatchEvent(event);
    return event.defaultPrevented;
  }, { type, files, text });
}

async function expectCurrent(page, path, step, month, extras = {}) {
  await page.waitForURL(url => url.pathname === path &&
    (!step || url.searchParams.get('step') === step) &&
    url.searchParams.get('month') === month &&
    Object.entries(extras).every(([key, value]) => url.searchParams.get(key) === value));
  if (step) {
    const active = page.locator(activeStep);
    await active.waitFor();
    assert.equal(new URL(await active.getAttribute('href'), page.url()).searchParams.get('step'), step);
  }
  const nav = page.locator('.hr-tabs [aria-current="page"]');
  assert.equal(new URL(await nav.getAttribute('href'), page.url()).pathname, path);
  const side = page.locator('.main-sidebar--desktop a[aria-current="page"][href^="/hr/"]');
  assert.equal(new URL(await side.getAttribute('href'), page.url()).pathname, path);
}

async function assertNavigation(page, lang) {
  const sidebar = page.locator('.main-sidebar--desktop a[href^="/hr/"]');
  assert.deepEqual((await sidebar.allTextContents()).map(value => value.trim()), lang === 'ko'
    ? ['인사 대시보드', '급여·인원', '근무·인건비 예상'] : ['人事总览', '工资·人员', '出勤·人工成本预测']);
  assert.deepEqual((await sidebar.evaluateAll(links => links.map(link => new URL(link.href).pathname))), workPaths);
  assert.deepEqual((await page.locator('.hr-tabs a').evaluateAll(links => links.map(link => new URL(link.href).pathname))), workPaths);
  await sidebar.last().scrollIntoViewIfNeeded();
}

function stepLink(page, step) {
  return page.locator(`${stepLinks}[href*="step=${step}"]`);
}

async function waitForStep(page, step, label) {
  const active = page.locator(`${activeStep}[href*="step=${step}"]`);
  await active.waitFor();
  assert.equal(new URL(await active.getAttribute('href'), page.url()).searchParams.get('step'), step);
  if (label) assert.ok((await active.innerText()).includes(label), `Active step should show ${label}`);
}

async function cancelDraftNavigation(page, action) {
  const rejected = page.waitForEvent('dialog').then(async dialog => {
    assert.equal(dialog.type(), 'confirm');
    await dialog.dismiss();
  });
  await Promise.all([rejected, action()]);
}

async function changeStepWithDraft(page, step) {
  let dialog = null;
  const dismiss = async next => { dialog = next.message(); await next.dismiss(); };
  page.on('dialog', dismiss);
  try {
    await stepLink(page, step).click();
    await waitForStep(page, step);
  } finally {
    page.off('dialog', dismiss);
  }
  assert.equal(dialog, null, 'Assignment and cost share the same draft without prompting');
}

async function checkHrFlow({ origin, fixture, capture, backendRequest, checks }) {
  const close = (step, month = closeMonth) => `${origin}/hr/personnel?${step ? `step=${step}&` : ''}month=${month}`;
  const work = (step, month = workMonth, date = day) => `${origin}/hr/work?${step ? `step=${step}&` : ''}month=${month}&date=${date}`;
  const seed = await backendRequest('/api/analytics/hr/classification-reference/', {
    method: 'PUT', body: { version: 0, reference: { filename: 'synthetic-reference-registered.xlsx', rows: classificationRows } },
  });
  assert.equal(seed.status, 200, JSON.stringify(seed.data));

  const ko = await fixture();
  const page = ko.page;
  page.on('pageerror', error => console.error(error.stack));
  const workspace = await backendRequest(`/api/analytics/hr/workspaces/${closeMonth}/`);
  assert.equal(workspace.status, 200, JSON.stringify(workspace.data));
  await page.goto(close(null));
  try {
    await waitForStep(page, 'assign', personnelLabels[2]);
  } catch (error) {
    console.error('Initial personnel step failed:', page.url(), await page.locator('body').innerText(), ko.calls.map(({ method, pathname, status }) => ({ method, pathname, status })));
    throw error;
  }
  await assertNavigation(page, 'ko');
  await capture(page, 'sidebar-ko');
  await page.goto(close(null, '2026-02'));
  await waitForStep(page, 'upload', personnelLabels[0]);
  await page.goto(work(null));
  await waitForStep(page, 'daily');
  assert.equal(await page.getByLabel('근무 날짜', { exact: true }).inputValue(), day);
  checks.push('Existing payroll defaults to assignment, a month without payroll defaults to upload, and work defaults to the requested date');

  await page.goto(close('upload'));
  await waitForStep(page, 'upload', personnelLabels[0]);
  const payrollZone = page.locator(upload);
  await payrollZone.getByRole('button').waitFor();
  assert.equal(await page.locator(stepLinks).count(), 4);
  assert.match(await payrollZone.innerText(), /파일을 여기에 끌어 놓거나 눌러서 선택/);
  assert.equal(await page.locator('.hr-import-body:visible').count(), 0, 'Single-month import starts closed');
  await capture(page, 'personnel-01-upload');
  await stepLink(page, 'roster').click();
  await waitForStep(page, 'roster', personnelLabels[1]);
  await page.locator('.hr-roster-page-panel').waitFor();
  await capture(page, 'personnel-02-roster');
  await stepLink(page, 'assign').click();
  await waitForStep(page, 'assign', personnelLabels[2]);
  await page.getByRole('button', { name: '변경 저장', exact: true }).waitFor();
  await capture(page, 'personnel-03-assign');
  await stepLink(page, 'cost').click();
  await waitForStep(page, 'cost', personnelLabels[3]);
  await page.locator('.hr-cost-ribbon').waitFor();
  assert.equal(await page.getByRole('button', { name: '변경 저장', exact: true }).count(), 0);
  assert.equal(await page.locator('[data-hr-drop]').count(), 0);
  await capture(page, 'personnel-04-cost');
  await page.reload();
  await waitForStep(page, 'cost', personnelLabels[3]);
  checks.push('All four payroll steps navigate at the same month, reload stays on cost, and only assignment offers person movement and layout save');

  const zh = await fixture({ lang: 'zh' });
  await zh.page.goto(work('daily'));
  await waitForStep(zh.page, 'daily', dailyLabels[0]);
  await zh.page.locator('.hr-daily-editor').waitFor();
  await assertNavigation(zh.page, 'zh');
  await capture(zh.page, 'sidebar-zh');
  await capture(zh.page, 'work-01-daily-zh');
  await stepLink(zh.page, 'forecast').click();
  await waitForStep(zh.page, 'forecast', dailyLabels[1]);
  await zh.page.locator('.hr-forecast-summary').waitFor();
  await capture(zh.page, 'work-02-forecast-zh');
  await stepLink(zh.page, 'standards').click();
  await waitForStep(zh.page, 'standards', dailyLabels[2]);
  await zh.page.locator('.hr-labor-actual-form').waitFor();
  await capture(zh.page, 'work-03-standards-zh');
  await zh.context.close();
  checks.push('Both languages show exactly three top-level links in order, and the three Chinese work steps render their original screens');

  await page.goto(close('assign'));
  await page.locator('details summary').filter({ hasText: /^분류 편집$/ }).click();
  await page.getByRole('button', { name: '추가 분류', exact: true }).click();
  const departmentEditor = page.locator('.hr-department-editor');
  const departmentName = departmentEditor.getByLabel('이름', { exact: true });
  await departmentName.fill('합성 임시 분류');
  await changeStepWithDraft(page, 'cost');
  await changeStepWithDraft(page, 'assign');
  assert.equal(await departmentName.inputValue(), '합성 임시 분류');
  await departmentEditor.getByRole('button', { name: '반영', exact: true }).click();
  await page.locator('.hr-people-dock [data-person-code="90001"] .hr-person-open').click();
  const person = page.locator('.hr-person-dialog');
  await person.getByLabel('이동할 분류').selectOption({ label: '합성 임시 분류' });
  await person.getByRole('button', { name: '이동 적용' }).click();
  await changeStepWithDraft(page, 'cost');
  assert.match(await page.locator('.hr-draft-indicator').innerText(), /현재 초안 기준/);
  await page.getByText('상세 집계표', { exact: true }).click();
  const draftCost = page.getByRole('row').filter({ has: page.getByRole('cell', { name: '합성 임시 분류', exact: true }) });
  await draftCost.waitFor();
  assert.match(await draftCost.innerText(), /4,751\.23/);
  await changeStepWithDraft(page, 'assign');
  assert.equal(await page.getByRole('button', { name: '변경 저장', exact: true }).isEnabled(), true);
  await changeStepWithDraft(page, 'upload');
  assert.equal(await payrollZone.getByRole('button').isDisabled(), true);
  assert.match(await payrollZone.locator('.hr-file-drop-help').innerText(), /배치.*저장/);
  await transfer(page, upload, 'drop', [payroll]);
  assert.equal(await page.locator('.hr-workbook-file-table tbody tr').count(), 0);
  await changeStepWithDraft(page, 'assign');
  await waitForStep(page, 'assign');
  assert.equal(await page.getByRole('button', { name: '변경 저장', exact: true }).isEnabled(), true);
  await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.accept()), page.getByRole('button', { name: '되돌리기', exact: true }).click()]);
  checks.push('Unsaved assignment structure feeds the read-only cost view, remains editable on return, and disables file intake on the upload step');

  await page.goto(close('upload', workMonth));
  await payrollZone.getByRole('button').waitFor();
  await payrollZone.scrollIntoViewIfNeeded();
  await capture(page, 'drop-idle');
  await transfer(page, upload, 'dragenter', [payroll]);
  assert.equal(await payrollZone.getAttribute('data-drag-active'), 'true');
  await capture(page, 'drop-active');
  await transfer(page, upload, 'dragleave', [payroll]);
  assert.notEqual(await payrollZone.getAttribute('data-drag-active'), 'true');
  assert.equal(await transfer(page, upload, 'drop', [], { text: 'synthetic person or text' }), false);
  assert.equal(await transfer(page, 'body', 'drop', [payroll]), true, 'Outside file drops cannot navigate from upload');
  assert.equal(await transfer(page, 'body', 'dragover', [payroll]), true, 'Outside dragover accepts file drop so navigation can be prevented');
  assert.equal(await transfer(page, upload, 'drop', [{ name: 'synthetic-wrong.exe' }]), true);
  await payrollZone.getByRole('alert').waitFor();
  assert.match(await payrollZone.getByRole('alert').innerText(), /xlsx/i);
  await capture(page, 'drop-invalid');
  await transfer(page, upload, 'drop', Array.from({ length: 11 }, (_, index) => ({ name: `synthetic-${index}.xlsx` })));
  assert.match(await payrollZone.getByRole('alert').innerText(), /10/);
  assert.equal(await page.locator('.hr-workbook-file-table tbody tr').count(), 0);
  for (const key of ['Enter', 'Space']) {
    const trigger = payrollZone.getByRole('button');
    await trigger.focus();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), trigger.press(key)]);
    assert.equal(chooser.isMultiple(), true);
    await chooser.setFiles([]);
  }

  const referenceManagement = page.locator('.hr-workbook-reference-management');
  if (!await referenceManagement.evaluate(element => element.open)) await referenceManagement.locator('summary').click();
  await transfer(page, reference, 'drop', [classification]);
  await referenceManagement.getByText(/synthetic-reference\.xlsx/).waitFor();
  await cancelDraftNavigation(page, () => stepLink(page, 'roster').click());
  await referenceManagement.getByText(/synthetic-reference\.xlsx/).waitFor();
  assert.equal(await page.getByLabel('월', { exact: true }).isDisabled(), true);
  await transfer(page, upload, 'drop', [payroll]);
  assert.match(await payrollZone.innerText(), /분류|저장/);
  assert.equal(await page.locator('.hr-workbook-file-table tbody tr').count(), 0);
  await referenceManagement.getByRole('button', { name: '분류 변경 취소', exact: true }).click();
  await transfer(page, upload, 'drop', [payroll]);
  await page.locator('.hr-workbook-file-table').getByText(payroll.name, { exact: true }).waitFor();
  await page.getByRole('button', { name: '선택 월 미리보기', exact: true }).click();
  await page.locator('.hr-workbook-preview').waitFor();
  assert.ok(ko.calls.some(call => call.pathname === payrollPath && call.status === 200 && call.body.files[0].filename === payroll.name));
  await cancelDraftNavigation(page, () => stepLink(page, 'roster').click());
  await page.locator('.hr-workbook-preview').waitFor();
  await page.getByRole('button', { name: /선택 1개월 저장/ }).click();
  const assignNext = page.locator('.hr-upload-next').getByRole('link', { name: '부서·파트 배치로 이동' });
  await assignNext.waitFor();
  assert.equal(new URL(await assignNext.getAttribute('href'), page.url()).searchParams.get('step'), 'assign');
  await waitForStep(page, 'upload');

  await transfer(page, upload, 'drop', [requiresReview]);
  await page.locator('.hr-workbook-file-table').getByText(requiresReview.name, { exact: true }).waitFor();
  await page.getByRole('button', { name: '선택 월 미리보기', exact: true }).click();
  await page.locator('.hr-workbook-preview').waitFor();
  await page.getByRole('button', { name: /선택 1개월 저장/ }).click();
  const rosterNext = page.locator('.hr-upload-next').getByRole('link', { name: '사번 확인으로 이동' });
  await rosterNext.waitFor();
  await waitForStep(page, 'upload');
  await rosterNext.click();
  await waitForStep(page, 'roster');
  assert.equal(await transfer(page, 'body', 'drop', [payroll]), false, 'Outside-file prevention leaves with upload');
  checks.push('Workbook and classification drops use their real parser and API, block invalid/disabled drops, preserve drafts, and offer the correct next step without navigating automatically');

  await page.goto(close('upload', '2026-02'));
  await page.getByText('기타 형식 · 단일 월 가져오기', { exact: true }).click();
  const singleZone = page.locator(generic);
  await singleZone.getByRole('button').waitFor();
  await transfer(page, generic, 'drop', [other, other]);
  await singleZone.getByRole('alert').waitFor();
  await transfer(page, generic, 'drop', [other]);
  await page.getByRole('button', { name: '월 자료 검증', exact: true }).click();
  await page.locator('.hr-import-preview').waitFor();
  assert.ok(ko.calls.some(call => call.pathname === '/api/analytics/hr/import-preview/' && call.status === 200));
  await cancelDraftNavigation(page, () => stepLink(page, 'assign').click());
  await page.locator('.hr-import-preview').waitFor();
  await page.getByRole('button', { name: '확인 후 가져오기', exact: true }).click();
  await page.locator('.hr-upload-next').getByRole('link', { name: '부서·파트 배치로 이동' }).waitFor();
  checks.push('The single-month XLSX drop accepts one file and reaches real preview and save, and its preview survives a canceled step change');

  await page.goto(work('daily'));
  const overtime = page.getByLabel('90002 평일 야근', { exact: true });
  await overtime.fill('2.75');
  await cancelDraftNavigation(page, () => stepLink(page, 'forecast').click());
  assert.equal(await overtime.inputValue(), '2.75');
  await cancelDraftNavigation(page, () => page.locator('.hr-tabs a[href^="/hr/dashboard"]').click());
  assert.equal(await overtime.inputValue(), '2.75');
  await Promise.all([page.waitForEvent('dialog').then(dialog => dialog.accept()), stepLink(page, 'forecast').click()]);
  await waitForStep(page, 'forecast');
  assert.equal(new URL(page.url()).searchParams.get('date'), day);
  await page.getByLabel('월', { exact: true }).selectOption('10');
  await page.waitForURL(url => url.searchParams.get('month') === '2026-10');
  await stepLink(page, 'daily').click();
  await waitForStep(page, 'daily');
  assert.equal(await page.getByLabel('근무 날짜', { exact: true }).inputValue(), '2026-10-01');
  await page.goto(work('forecast'));
  await waitForStep(page, 'forecast');
  await stepLink(page, 'standards').click();
  await waitForStep(page, 'standards');
  const rate = page.getByLabel('근무일 배수', { exact: true });
  await rate.fill('1.7');
  await cancelDraftNavigation(page, () => stepLink(page, 'daily').click());
  assert.equal(await rate.inputValue(), '1.7');
  await page.locator('.hr-labor-calendar-form [data-date="2026-11-12"]').click();
  const dateType = page.locator('.hr-labor-calendar-form').getByLabel('선택 날짜 유형', { exact: true });
  await dateType.selectOption('public_holiday');
  const insurance = page.locator('.hr-labor-actual-form input[type="number"]').first();
  await insurance.fill('55.14');
  await cancelDraftNavigation(page, () => page.evaluate(() => history.back()));
  assert.equal(await dateType.inputValue(), 'public_holiday');
  assert.equal(await insurance.inputValue(), '55.14');
  assert.equal(await rate.inputValue(), '1.7');
  checks.push('Daily and labor-standard drafts survive declined same-page, top-tab, and browser Back navigation');

  const legacy = await fixture();
  await legacy.page.goto(`${origin}/hr/dashboard?month=${closeMonth}`);
  await legacy.page.locator('.hr-dashboard').waitFor();
  let historyLength = await legacy.page.evaluate(() => history.length);
  for (const [old, path, step] of [
    ['roster', '/hr/personnel', 'roster'], ['labor-cost', '/hr/personnel', 'cost'],
    ['daily-work', '/hr/work', 'daily'], ['labor-forecast', '/hr/work', 'forecast'], ['labor-standards', '/hr/work', 'standards'],
  ]) {
    await legacy.page.goto(`${origin}/hr/${old}?month=${closeMonth}&date=2026-10-07&demo=synthetic#check`);
    await expectCurrent(legacy.page, path, step, closeMonth, { date: '2026-10-07', demo: 'synthetic' });
    assert.equal(new URL(legacy.page.url()).hash, '#check');
    if (old === 'labor-cost') {
      await legacy.page.locator('.hr-cost-ribbon').waitFor();
      await capture(legacy.page, 'legacy-cost');
    }
    assert.equal(await legacy.page.evaluate(() => history.length), ++historyLength, 'Redirect replaces its legacy history entry');
  }
  await legacy.context.close();
  checks.push('All five legacy bookmarks preserve month, date, extra query, hash, active tab and active sidebar selection');

  const mobile = await fixture({ mobile: true });
  await mobile.page.goto(close('upload'));
  await waitForStep(mobile.page, 'upload');
  const targets = await mobile.page.locator(stepLinks).evaluateAll(links => links.map(link => {
    const { width, height, top } = link.getBoundingClientRect();
    return { width, height, top };
  }));
  assert.equal(targets.length, 4);
  assert.ok(targets.every(({ width, height }) => width >= 43.9 && height >= 43.9));
  assert.ok(new Set(targets.map(({ top }) => top)).size <= 2, 'Flow is a scrolling row or at most two rows');
  assert.equal(await mobile.page.evaluate(() => document.documentElement.scrollWidth), 390);
  await mobile.page.locator('.hr-flow-steps').scrollIntoViewIfNeeded();
  await capture(mobile.page, 'mobile-390');
  await mobile.context.close();
  const dark = await fixture({ dark: true });
  await dark.page.goto(work('forecast'));
  await dark.page.locator('.hr-forecast-summary').waitFor();
  assert.equal(await dark.page.locator('html').getAttribute('data-app-theme'), 'dark');
  await capture(dark.page, 'dark');
  await dark.context.close();
  await ko.context.close();
  checks.push('390px has no document overflow and every step has a 44px touch target, and the work flow renders in dark mode');
}

module.exports = { checkHrFlow };
