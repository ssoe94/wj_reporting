import { expect, test, type Page } from '@playwright/test';

const qualityPhotoOne = 'https://assets.example.test/quality-1.png';
const qualityPhotoTwo = 'https://assets.example.test/quality-2.png';

function fieldDocument(id: string, kind: 'work_instruction' | 'drawing') {
  return {
    id,
    kind,
    part_no: 'ACQ30776309',
    model_name: '24U411B-BA.AEUYJVN',
    original_name: `${id}.pdf`,
    source_url: `https://res.cloudinary.com/demo/image/upload/v1/${id}.pdf`,
    preview_url: `https://res.cloudinary.com/demo/image/upload/v1/${id}.pdf`,
    preview_format: 'pdf',
    preview_resource_type: 'image',
    page_count: 2,
    ready: true,
  };
}

function fieldSnapshot(includeQuality: boolean) {
  const activePlan = {
    plan_id: 101,
    plan_date: '2026-08-31',
    sequence: 3,
    part_no: 'ACQ30776309',
    model_name: '24U411B-BA.AEUYJVN',
    lot_no: 'LOT-01',
    planned_piece_qty: 1930,
    actual_piece_qty: 210,
    allocated_shots: 210,
    cavity: 1,
    progress_rate: 10.88,
    status: 'current',
  };
  return {
    schema_version: 'field-kanban-v1',
    business_date: '2026-08-31',
    server_time: '2026-08-31T11:00:00+08:00',
    machine: {
      number: 1,
      key: '1',
      label: '注塑 01号机',
      monitoring_name: '850T-1',
      device_counter: 210,
      shot_count: 396,
      recent_60m_shots: 30,
      latest_mes_time: '2026-08-31T11:00:00+08:00',
      is_stale: false,
      is_running: true,
    },
    active_plan: activePlan,
    next_plan: null,
    queue: [activePlan],
    counters: {
      business_day_shots: 396,
      shift_shots: 396,
      shift_code: 'day',
      shift_start: '2026-08-31T08:00:00+08:00',
      shift_end: '2026-08-31T20:00:00+08:00',
      current_plan_shots: 210,
      theoretical_piece_qty: 210,
    },
    documents: {
      work_instruction: fieldDocument('instruction', 'work_instruction'),
      drawing: fieldDocument('drawing', 'drawing'),
    },
    quality: {
      matching_report_count: includeQuality ? 1 : 0,
      issues: includeQuality ? [{
        key: 'label-exception',
        label: { zh: '标签异常', ko: '라벨 이상' },
        summary_points: [{ zh: '检查标签位置', ko: '라벨 위치 확인' }],
        evidence_count: 2,
        latest_report_dt: '2026-08-30T08:00:00+08:00',
        section: 'OQC',
        section_counts: [{ section: 'OQC', evidence_count: 2 }],
        image_url: qualityPhotoOne,
        image_urls: [qualityPhotoOne, qualityPhotoTwo],
        action_result: '位置复核',
        disposition: '历史参考',
        verification_status: 'matched',
        verification_label: { zh: '资料匹配完成', ko: '자료 일치 확인 완료' },
      }] : [],
      disclaimer: {
        zh: '以下内容来自历史质量记录。',
        ko: '아래 내용은 과거 품질 이력입니다.',
      },
      unavailable_reason: null,
    },
    pending_prompt: null,
  };
}

async function installFieldMocks(
  page: Page,
  options: { failDrawing3000?: boolean; failInstruction3200?: boolean } = {},
) {
  await page.addInitScript(() => {
    window.localStorage.setItem('wj-field-language', 'ko');
  });
  await page.route('**/*', async (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/api/')) {
      await route.fulfill({ json: {} });
      return;
    }
    await route.fallback();
  });
  await page.route('**/api/production/field-kanban/**', async (route) => {
    const includeQuality = new URL(route.request().url()).searchParams.get('include_quality') === 'true';
    await route.fulfill({ json: fieldSnapshot(includeQuality) });
  });
  await page.route(/\/api\/production\/plan-summary\//, async (route) => {
    await route.fulfill({ json: { injection: { records: [] }, machining: { records: [] } } });
  });
  await page.route(/\/api\/injection\/production-matrix\//, async (route) => {
    await route.fulfill({
      json: {
        time_slots: [],
        machines: [],
        cumulative_production_matrix: {},
        actual_production_matrix: {},
      },
    });
  });
  await page.route(/\/api\/production\/injection-downtime-confirmations\//, async (route) => {
    await route.fulfill({ json: { confirmations: [] } });
  });
  await page.route(/\/api\/production\/field-kanban\/confirmations\//, async (route) => {
    await route.fulfill({ json: { confirmations: [] } });
  });
  await page.route('https://res.cloudinary.com/**', async (route) => {
    const requestUrl = route.request().url();
    const isDrawing = requestUrl.includes('drawing');
    if (options.failDrawing3000 && isDrawing && requestUrl.includes('w_3000')) {
      await route.fulfill({ status: 503, body: 'drawing derivative unavailable' });
      return;
    }
    if (options.failInstruction3200 && !isDrawing && requestUrl.includes('w_3200')) {
      await route.fulfill({ status: 503, body: 'instruction derivative unavailable' });
      return;
    }
    const label = isDrawing ? 'DRAWING' : 'INSTRUCTION';
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="2000" height="1500"><rect width="100%" height="100%" fill="white"/><text x="80" y="160" font-size="84">${label}</text></svg>`,
    });
  });
  await page.route('https://assets.example.test/**', async (route) => {
    const second = route.request().url().includes('quality-2');
    await route.fulfill({
      contentType: 'image/svg+xml',
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="100%" height="100%" fill="${second ? '#dbeafe' : '#dcfce7'}"/><text x="60" y="140" font-size="72">PHOTO ${second ? '2' : '1'}</text></svg>`,
    });
  });
}

test.describe('field injection kanban', () => {
  test('cycles instruction and each quality photo while keeping drawings manual-only', async ({ page }) => {
    await installFieldMocks(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/field/imm01');

    const workTab = page.locator('.field-document-tabs .is-work');
    const qualityTab = page.locator('.field-document-tabs .is-quality');
    const drawingTab = page.locator('.field-document-tabs .is-drawing');
    await expect(workTab).toHaveClass(/is-active/);
    await expect(page.locator('.field-document-image-preview img')).toBeVisible();
    // Confirm the deferred quality payload is ready, then start a fresh
    // instruction interval from the operator-visible work tab.
    await qualityTab.click();
    await expect(page.locator('.field-quality-canvas__active-photo img')).toBeVisible();
    const clockTime = await page.evaluate(() => Date.now());
    await page.clock.install({ time: clockTime });
    await page.clock.pauseAt(clockTime);
    await workTab.click();
    await expect(workTab).toHaveClass(/is-active/);

    await page.clock.fastForward(60_000);
    await expect(qualityTab).toHaveClass(/is-active/);

    const qualityPhoto = page.locator('.field-quality-canvas__active-photo img');
    const qualityGallery = page.locator('.field-quality-canvas__gallery');
    await expect(qualityPhoto).toHaveAttribute('src', qualityPhotoOne);
    await expect(qualityGallery).toHaveAttribute('aria-busy', 'false');
    await page.clock.fastForward(9_000);
    await expect(qualityPhoto).toHaveAttribute('src', qualityPhotoOne);
    await page.clock.fastForward(1_000);
    await expect(qualityPhoto).toHaveAttribute('src', qualityPhotoTwo);
    await expect(qualityGallery).toHaveAttribute('aria-busy', 'false');
    await page.clock.fastForward(10_000);
    await expect(workTab).toHaveClass(/is-active/);

    await drawingTab.click();
    await expect(drawingTab).toHaveClass(/is-active/);
    await page.clock.fastForward(120_000);
    await expect(drawingTab).toHaveClass(/is-active/);
  });

  test('zooms only the document viewport, requests a high-detail page, and right-aligns quantities', async ({ page }) => {
    const requestedCloudinaryUrls: string[] = [];
    page.on('request', (request) => {
      if (request.url().startsWith('https://res.cloudinary.com/')) requestedCloudinaryUrls.push(request.url());
    });
    await installFieldMocks(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/field/imm01');
    await page.locator('.field-document-tabs').waitFor({ state: 'visible' });
    await page.locator('.field-queue-list article').first().waitFor({ state: 'visible' });
    await page.locator('.field-document-image-preview img').waitFor({ state: 'visible' });

    const kioskLayout = await page.evaluate(() => {
      const root = document.querySelector<HTMLElement>('.field-kanban');
      const queueList = document.querySelector<HTMLElement>('.field-queue-list');
      const queueItems = Array.from(document.querySelectorAll<HTMLElement>('.field-queue-list article'));
      const finalQueueItem = queueItems[queueItems.length - 1];
      const listBounds = queueList?.getBoundingClientRect();
      const finalBounds = finalQueueItem?.getBoundingClientRect();
      return {
        noHorizontalOverflow: Boolean(root && root.scrollWidth <= root.clientWidth + 1),
        noVerticalOverflow: Boolean(root && root.scrollHeight <= root.clientHeight + 1),
        queueCount: queueItems.length,
        finalQueueItemVisible: Boolean(
          listBounds
          && finalBounds
          && finalBounds.top >= listBounds.top - 1
          && finalBounds.bottom <= listBounds.bottom + 1
        ),
      };
    });
    expect(kioskLayout).toEqual({
      noHorizontalOverflow: true,
      noVerticalOverflow: true,
      queueCount: 1,
      finalQueueItemVisible: true,
    });
    await expect(page.locator('.field-document-tabs button')).toHaveText(['작업지도서', '품질', '도면']);

    await page.locator('.field-document-interaction-gate').click();
    const viewport = page.locator('.field-document-pan-zoom');
    const surface = page.locator('.field-document-pan-zoom__surface');
    const zoomOutput = page.locator('.field-document-zoom-controls output');
    await expect(zoomOutput).toHaveText('100%');
    await page.getByRole('button', { name: '확대' }).click();
    await expect(zoomOutput).toHaveText('125%');
    await expect(surface).toHaveCSS('transform', /matrix/);

    const pageScaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
    const bounds = await viewport.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.move(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await page.mouse.wheel(0, -120);
    await expect(zoomOutput).toHaveText('150%');
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(pageScaleBefore);

    const quantityAlignment = await page.locator('.field-queue-value strong').first().evaluate(
      (element) => window.getComputedStyle(element).textAlign,
    );
    expect(quantityAlignment).toBe('right');
    expect(requestedCloudinaryUrls.some((url) => (
      url.includes('dn_200')
      && url.includes('w_2000')
      && url.includes('q_auto:best')
      && url.includes('f_jpg')
    ))).toBe(true);
    await expect.poll(() => requestedCloudinaryUrls.some((url) => (
      url.includes('dn_300')
      && url.includes('w_3200')
      && url.includes('q_auto:best')
      && url.includes('f_jpg')
    ))).toBe(true);
  });

  test('keeps drawings on one lossless 3000px derivative at every zoom level', async ({ page }) => {
    const requestedCloudinaryUrls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/drawing.')) requestedCloudinaryUrls.push(request.url());
    });
    await installFieldMocks(page);
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/field/imm01');
    await page.locator('.field-document-tabs .is-drawing').click();

    const drawingImage = page.locator('.field-document-image-preview img');
    await expect(drawingImage).toBeVisible();
    const initialUrl = await drawingImage.getAttribute('src');
    expect(initialUrl).toContain('dn_300');
    expect(initialUrl).toContain('w_3000');
    expect(initialUrl).toContain('h_3000');
    expect(initialUrl).toContain('f_png');
    expect(initialUrl).toContain('/drawing.png');

    const interactionGate = page.locator('.field-document-interaction-gate');
    if (await interactionGate.isVisible()) await interactionGate.click();
    const zoomIn = page.getByRole('button', { name: '확대' });
    for (let step = 0; step < 5; step += 1) await zoomIn.click();
    await expect(page.locator('.field-document-zoom-controls output')).toHaveText('225%');
    await expect(zoomIn).toBeDisabled();
    await expect(drawingImage).toHaveAttribute('src', initialUrl!);

    expect(requestedCloudinaryUrls.some((url) => url.includes('w_4096'))).toBe(false);
    expect(requestedCloudinaryUrls.some((url) => url.includes('w_3200'))).toBe(false);
  });

  test('falls back safely when an older device cannot load the 3000px drawing', async ({ page }) => {
    const requestedCloudinaryUrls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/drawing.')) requestedCloudinaryUrls.push(request.url());
    });
    await installFieldMocks(page, { failDrawing3000: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/field/imm01');
    await page.locator('.field-document-tabs .is-drawing').click();

    const drawingImage = page.locator('.field-document-image-preview img');
    await expect(drawingImage).toBeVisible();
    await expect(drawingImage).toHaveAttribute('src', /dn_200.*w_2000.*h_2000.*f_jpg.*drawing\.jpg/);
    const failedPrimaryRequestCount = requestedCloudinaryUrls.filter((url) => (
      url.includes('w_3000') && url.includes('h_3000') && url.includes('f_png')
    )).length;
    expect(failedPrimaryRequestCount).toBe(1);
    expect(requestedCloudinaryUrls.some((url) => url.includes('w_2000') && url.includes('f_jpg'))).toBe(true);
    await expect(page.locator('.field-document-load-state--error')).toHaveCount(0);

    await page.getByRole('button', { name: '다음 페이지' }).click();
    await expect(drawingImage).toHaveAttribute('src', /pg_2.*w_2000.*h_2000.*f_jpg.*drawing\.jpg/);
    expect(requestedCloudinaryUrls.filter((url) => (
      url.includes('w_3000') && url.includes('h_3000') && url.includes('f_png')
    ))).toHaveLength(failedPrimaryRequestCount);
  });

  test('keeps work-instruction fallback valid when moving to the next page', async ({ page }) => {
    const requestedCloudinaryUrls: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/instruction.')) requestedCloudinaryUrls.push(request.url());
    });
    await installFieldMocks(page, { failInstruction3200: true });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/field/imm01');

    const instructionImage = page.locator('.field-document-image-preview img');
    await expect(instructionImage).toBeVisible();
    await page.locator('.field-document-interaction-gate').click();
    await page.getByRole('button', { name: '확대' }).click();
    await page.getByRole('button', { name: '확대' }).click();
    await expect(instructionImage).toHaveAttribute('src', /pg_1.*w_2000.*h_2000.*f_jpg.*instruction\.jpg/);
    expect(requestedCloudinaryUrls.filter((url) => url.includes('w_3200'))).toHaveLength(1);

    await page.getByRole('button', { name: '다음 페이지' }).click();
    await expect(instructionImage).toHaveAttribute('src', /pg_2.*w_2000.*h_2000.*f_jpg.*instruction\.jpg/);
    await expect(page.locator('.field-pdf-preview')).toHaveCount(0);
    await expect(page.locator('.field-document-load-state--error')).toHaveCount(0);
  });

  test('supports the pre-PointerEvent Android touch fallback inside the document only', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Legacy Android fallback is exercised with Chromium touch events.');
    await page.addInitScript(() => {
      Object.defineProperty(window, 'PointerEvent', { configurable: true, value: undefined });
    });
    await installFieldMocks(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.goto('/field/imm01');
    await page.locator('.field-document-interaction-gate').click();

    const pageScaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
    await page.locator('.field-document-pan-zoom').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const centerX = bounds.left + bounds.width / 2;
      const centerY = bounds.top + bounds.height / 2;
      const dispatchTouch = (type: string, points: Array<{ clientX: number; clientY: number }>) => {
        const event = new Event(type, { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'touches', { value: points });
        element.dispatchEvent(event);
      };
      dispatchTouch('touchstart', [
        { clientX: centerX - 50, clientY: centerY },
        { clientX: centerX + 50, clientY: centerY },
      ]);
      dispatchTouch('touchmove', [
        { clientX: centerX - 100, clientY: centerY },
        { clientX: centerX + 100, clientY: centerY },
      ]);
      dispatchTouch('touchend', []);
    });

    await expect(page.locator('.field-document-zoom-controls output')).toHaveText('200%');
    expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(pageScaleBefore);
  });
});
