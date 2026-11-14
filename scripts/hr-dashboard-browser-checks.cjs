'use strict';

const assert = require('node:assert/strict');

const month = '2026-11';
const legacyMonth = '2026-10';
const endpoint = value => `/api/analytics/hr/dashboard/${value}/`;
const route = value => `/hr/dashboard?month=${value}`;
const pageRoot = '.hr-dashboard';
const organization = '.hr-dashboard-organization';
const card = '.hr-dashboard-person-card';
const privacy = '.hr-dashboard-privacy';
const row = id => `button[data-dashboard-node="${id}"]`;
const expand = id => `button[data-dashboard-expand="${id}"]`;
const people = 'button[data-dashboard-person]';
const personNamed = (page, name) => page.locator(people).filter({ has: page.getByText(name, { exact: true }) });
const actual = amount => Number(amount.value);

async function checkDashboard({ origin, fixture, capture, backendRequest, startBackend, stopBackend, checks, scrollForCapture }) {
  const open = (page, value = month) => page.goto(origin + route(value));
  const load = async (page, value) => {
    await open(page, value);
    await page.locator(pageRoot).waitFor();
  };
  const read = async (value = month, role = 'hr') => {
    const result = await backendRequest(endpoint(value), { role });
    assert.equal(result.status, role === 'hr' ? 200 : 403, JSON.stringify(result.data));
    assert.match(result.headers.get('Cache-Control'), /private/);
    assert.match(result.headers.get('Cache-Control'), /no-store/);
    return result.data;
  };

  // Verify the legacy condition in its own fresh database, before seeding any roster.
  await startBackend('legacy');
  await read(month, 'denied');
  const legacy = await read();
  assert.deepEqual(await read(), legacy, 'Identical stored inputs give identical responses');
  assert.equal(legacy.source.month, legacyMonth);
  assert.equal(legacy.source.filename, 'synthetic-dashboard-10.xlsx');
  assert.equal(legacy.source.row_count, 5);
  assert.equal(actual(legacy.headcount.total), 5);
  assert.equal(actual(legacy.headcount.unknown), 5);
  assert.equal(legacy.movements.transfers.total.value, null);
  assert.equal(actual(legacy.cost.actual.gross), 24292.27);
  assert.equal(legacy.cost.actual.overtime.value, null);
  assert.equal(legacy.cost.forecast.status, 'missing');
  assert.equal(legacy.load.contract_average.value, null);
  for (const code of ['roster_empty', 'reupload_components', 'employment_unknown']) {
    assert.ok(legacy.needs.some(need => need.code === code), `Legacy API must report ${code}`);
  }
  const legacyView = await fixture();
  await load(legacyView.page);
  await legacyView.page.locator(row('synthetic-root')).waitFor();
  const degraded = await legacyView.page.locator(pageRoot).innerText();
  const legacyNotice = await legacyView.page.locator('.hr-dashboard-source-notice').innerText();
  assert.match(legacyNotice, /명부가 비어 있습니다/);
  assert.match(legacyNotice, /급여 구성 항목이 없는/);
  const upload = new URL(await legacyView.page.locator('.hr-dashboard-source-notice a').getAttribute('href'), origin);
  assert.equal(upload.pathname, '/hr/personnel');
  assert.equal(upload.searchParams.get('step'), 'upload');
  assert.equal(upload.searchParams.get('month'), legacyMonth);
  assert.match(degraded, /재업로드|다시 가져오/);
  assert.match(degraded, /명부/);
  assert.match(degraded, /고용형태 미확인/);
  assert.match(degraded, /24,292\.27/);
  assert.ok(legacyView.calls.length && legacyView.calls.every(call => call.method === 'GET'));
  await capture(legacyView.page, 'production-first-day');
  await legacyView.context.close();
  await stopBackend();
  checks.push('Fresh migrated DB with six-key legacy payroll only: private read-only API, historical payroll totals and organization survive, with unknown employment and missing breakdown/roster clearly reported');

  await startBackend('rich');
  const rich = await read();
  assert.equal(rich.source.month, legacyMonth);
  assert.equal(rich.source.version, 3);
  assert.equal(actual(rich.headcount.contract), 3);
  assert.equal(actual(rich.headcount.hourly), 2);
  assert.equal(actual(rich.movements.hires.total), 1);
  assert.equal(actual(rich.movements.exits.total), 1);
  assert.equal(actual(rich.movements.transfers.total), 1);
  assert.equal(actual(rich.load.entered.weekday), 2.5);
  assert.equal(rich.trends.length, 6);

  const ko = await fixture();
  await load(ko.page);
  assert.equal(await ko.page.locator('.hr-tabs a').first().getAttribute('href'), route(month));
  assert.equal(await ko.page.locator('.hr-tabs a').count(), 3);
  assert.equal(await ko.page.locator('.main-sidebar--desktop a[href^="/hr/"]').first().getAttribute('href'), '/hr/dashboard');
  const top = await ko.page.locator(pageRoot).innerText();
  assert.match(top, /2026-10/);
  assert.match(top, /2026-11-12/);
  assert.match(top, /인사 대시보드/);
  await ko.page.locator('.hr-dash-charts .recharts-surface').nth(3).waitFor();
  const reference = ko.page.locator('.hr-dash-reference');
  assert.match(await reference.innerText(), /36시간 참고선/);
  assert.equal(await reference.getAttribute('data-above'), 'true');
  assert.match(await ko.page.locator('.hr-dash-entered').innerText(), /2\.5시간/);
  const daily = new URL(await ko.page.locator('.hr-dash-entered a').getAttribute('href'), origin);
  assert.equal(daily.pathname, '/hr/work');
  assert.equal(daily.searchParams.get('step'), 'daily');
  const ranking = ko.page.getByRole('region', { name: '개인별 부담 순위 표', exact: true });
  assert.match(await ranking.innerText(), /测试甲[\s\S]*43시간/);
  assert.ok(await ranking.evaluate(el => el.scrollWidth <= el.clientWidth), 'Desktop ranking should show its numeric column');
  const employment = ko.page.locator('.hr-dash-burden').getByRole('group', { name: '고용형태', exact: true });
  await employment.getByRole('button', { name: '시급직', exact: true }).click();
  assert.match(await ranking.innerText(), /测试乙[\s\S]*41\.43시간/);
  assert.doesNotMatch(await ranking.innerText(), /27\.35/);
  await employment.getByRole('button', { name: '계약직', exact: true }).click();
  assert.equal(await ko.page.locator(privacy).getAttribute('aria-pressed'), 'false');
  await ko.page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await capture(ko.page, 'desktop-ko');
  await scrollForCapture(ko.page.getByRole('heading', { name: '최근 6개월 추이', exact: true }));
  await capture(ko.page, 'trends');
  checks.push('Korean dashboard is the first HR tab and menu entry, shows October source and six-month charts, separates direct inputs, and switches burden rankings without revealing rates');

  const zh = await fixture({ lang: 'zh' });
  await load(zh.page);
  const zhText = await zh.page.locator(pageRoot).innerText();
  assert.match(zhText, /人事总览/);
  assert.match(zhText, /合同工/);
  assert.match(zhText, /小时工/);
  assert.doesNotMatch(zhText, /[가-힣]/u);
  await capture(zh.page, 'desktop-zh');
  await zh.context.close();
  checks.push('Chinese dashboard translates its UI, with the same source month and organizations');

  const root = 'synthetic-root', alpha = 'synthetic-alpha', part = 'synthetic-alpha-part';
  assert.equal(await ko.page.locator(row(part)).count(), 0, 'Descendants start collapsed');
  await ko.page.locator(expand(root)).click();
  await ko.page.locator(row(alpha)).waitFor();
  await ko.page.locator(expand(alpha)).click();
  await ko.page.locator(row(part)).click();
  assert.equal(await ko.page.locator(people).count(), 2, 'Part selection shows the two assigned employees');
  await personNamed(ko.page, '测试甲').click();
  const selected = ko.page.locator(card);
  await selected.waitFor();
  const selectedText = await selected.innerText();
  assert.match(selectedText, /测试工厂[\s\S]*测试甲组[\s\S]*测试甲小组/);
  assert.match(selectedText, /개월 이상/);
  assert.doesNotMatch(selectedText, /4,751\.23/);
  assert.equal(await ko.page.locator('[data-private-money]').count(), 0);
  await selected.locator('.recharts-surface').waitFor();
  await scrollForCapture(ko.page.locator(organization));
  await capture(ko.page, 'expanded-person');
  checks.push('Expanding the hierarchy and selecting a part/person displays the correct path, tenure, and workload without private payroll amounts');

  await ko.page.locator(expand(root)).click();
  await ko.page.getByLabel('사번·이름 검색', { exact: true }).fill('90001');
  const highlight = '[data-dashboard-path-match="true"]';
  await ko.page.locator(highlight).first().waitFor();
  assert.equal(await ko.page.locator(`${highlight}:has(${row(root)})`).count(), 1);
  assert.equal(await ko.page.locator(`${highlight}:has(${row(alpha)})`).count(), 1);
  assert.equal(await ko.page.locator(`${highlight}:has(${row(part)})`).count(), 1);
  assert.equal(await personNamed(ko.page, '测试甲').count(), 1);
  await capture(ko.page, 'search-highlight');
  await ko.page.getByLabel('사번·이름 검색', { exact: true }).fill('测试甲');
  assert.equal(await ko.page.locator(people).count(), 1);
  checks.push('Searching by code or name reopens and highlights every ancestor of the matching employee');

  await personNamed(ko.page, '测试甲').click();
  await ko.page.locator(privacy).click();
  assert.equal(await ko.page.locator(privacy).getAttribute('aria-pressed'), 'true');
  assert.match(await selected.innerText(), /4,751\.23/);
  assert.ok(await selected.locator('[data-private-money]').count() > 0);
  await scrollForCapture(ko.page.locator(organization));
  await capture(ko.page, 'money-revealed');
  await ko.page.getByLabel('사번·이름 검색', { exact: true }).fill('90002');
  await personNamed(ko.page, '测试乙').click();
  assert.match(await selected.innerText(), /27\.35/);
  await ko.page.locator(privacy).click();
  assert.doesNotMatch(await selected.innerText(), /27\.35/);
  await ko.page.locator(privacy).click();
  await ko.page.reload();
  await ko.page.locator(privacy).waitFor();
  assert.equal(await ko.page.locator(privacy).getAttribute('aria-pressed'), 'true', 'Reveal persists when this tab reloads');
  const separateTab = await ko.context.newPage();
  await load(separateTab);
  assert.equal(await separateTab.locator(privacy).getAttribute('aria-pressed'), 'false', 'The setting does not reveal amounts in a separate tab');
  await separateTab.close();
  await ko.page.getByLabel('월', { exact: true }).selectOption('09');
  await ko.page.locator('[data-dashboard-source]').getByText('2026-09', { exact: true }).waitFor();
  assert.ok(ko.calls.some(call => call.pathname === endpoint('2026-09') && call.status === 200));
  assert.ok(ko.calls.length && ko.calls.every(call => call.method === 'GET'));
  await ko.context.close();
  checks.push('Amounts only render after reveal; preference persists across this tab’s reload, with fresh tabs masked');

  const mobile = await fixture({ mobile: true });
  await load(mobile.page);
  const map = mobile.page.locator('.hr-dashboard-map');
  const dimensions = await map.evaluate(el => {
    const children = Array.from(el.children, child => child.getBoundingClientRect());
    return { viewport: innerWidth, document: document.documentElement.scrollWidth, stacked: children.length >= 2 && children[0].bottom <= children[1].top };
  });
  if (dimensions.document > dimensions.viewport) {
    console.error(await mobile.page.locator(pageRoot).evaluate(el => Array.from(el.querySelectorAll('*'))
      .filter(node => node.getBoundingClientRect().right > innerWidth && !node.closest('.hr-dash-table-scroll'))
      .slice(0, 18).map(node => [node.tagName, node.getAttribute('class'), node.getBoundingClientRect().width, getComputedStyle(node).overflowX])));
  }
  assert.deepEqual(dimensions, { viewport: 390, document: 390, stacked: true });
  const wordLines = await mobile.page.locator('.hr-dashboard-org-heading p').evaluate(element => {
    const node = element.firstChild;
    const word = '계산되는';
    const start = node.textContent.indexOf(word);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + word.length);
    return new Set([...range.getClientRects()].map(rect => rect.top)).size;
  });
  assert.equal(wordLines, 1, 'Korean prose wraps between words at 390px');
  for (const target of [mobile.page.locator(privacy), mobile.page.locator(row(root)), mobile.page.locator(expand(root)), mobile.page.locator(people).first()]) {
    const box = await target.boundingBox();
    assert.ok(box?.height >= 43.9 && box?.width >= 43.9, 'Mobile actions have at least 44px touch dimensions');
  }
  await scrollForCapture(mobile.page.locator(organization));
  await capture(mobile.page, 'mobile-390');
  await mobile.context.close();
  const dark = await fixture({ dark: true });
  await load(dark.page);
  assert.equal(await dark.page.locator('html').getAttribute('data-app-theme'), 'dark');
  await capture(dark.page, 'dark');
  await dark.context.close();
  checks.push('390px mobile keeps the document within viewport and stacks tree over person list, with 44px touch actions; dark mode renders');

  const empty = await fixture();
  await open(empty.page, '2026-02');
  await empty.page.locator('.hr-dashboard-empty').waitFor();
  assert.equal(await empty.page.locator(organization).count(), 0);
  await empty.context.close();
  const failed = await fixture({ failOnce: true });
  await open(failed.page);
  const retry = failed.page.getByRole('button', { name: '다시 불러오기', exact: true });
  await retry.waitFor();
  assert.equal(await failed.page.locator(organization).count(), 0);
  await retry.click();
  await failed.page.locator(organization).waitFor();
  assert.deepEqual(failed.calls.filter(call => call.pathname === endpoint(month)).map(call => call.status), [503, 200]);
  await failed.context.close();
  const denied = await fixture({ denied: true });
  await open(denied.page);
  await denied.page.waitForURL(url => !url.pathname.startsWith('/hr'));
  assert.equal(await denied.page.locator('a[href^="/hr/"]').count(), 0);
  assert.equal(denied.calls.length, 0);
  await denied.context.close();
  checks.push('Empty payroll, transient failure and retry, and unauthorized navigation have distinct behavior');
}

module.exports = { checkDashboard };
