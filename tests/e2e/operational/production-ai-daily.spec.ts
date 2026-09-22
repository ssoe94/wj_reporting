import { expect, test } from '@playwright/test';
import { expectNoUndefinedOrNaN, installDevSession, installOperationalApiMocks, installPageIssueGuard } from '../helpers/operational';

test('separates worker readiness from real AI results and preserves Claude history through daily ChatGPT requests', async ({ page, baseURL }, testInfo) => {
  const language = testInfo.project.name === 'zh-mobile' ? 'zh' : 'ko';
  const labels = language === 'ko' ? {
    region: 'AI 심층 분석', title: 'AI 심층 분석 · ChatGPT', request: '심층 분석 요청', queued: '심층 분석 대기 중',
    ready: 'AI 워커 온라인 · Qwen 3.8 27B · 선택 설명 사용 가능',
    offline: 'AI 워커 오프라인 · Qwen 3.8 27B · 선택 설명 일시 중지',
    fallback: '최근 자동 브리핑: 계산 결과로 대체 · 설명 근거·형식 검증 실패',
    success: '최근 자동 브리핑: AI 설명 성공', lastSuccess: '마지막 AI 설명 성공',
    summary: '주간 사출 완료율은 95%로 계획 대비 안정적이었습니다.',
    period: '분석 기간: 2026-05-11 ~ 2026-05-17', model: '모델: Claude', schedule: '일일 분석 기준: 09:00',
  } : {
    region: 'AI 深度分析', title: 'AI 深度分析 · ChatGPT', request: '请求深度分析', queued: '深度分析排队中',
    ready: 'AI 处理端在线 · Qwen 3.8 27B · 可选说明可用',
    offline: 'AI 处理端离线 · Qwen 3.8 27B · 可选说明暂时停用',
    fallback: '最近自动简报：使用计算结果替代 · 说明依据·格式校验失败',
    success: '最近自动简报：AI 说明成功', lastSuccess: '最近 AI 说明成功',
    summary: '每周注塑完成率为 95%，与计划相比保持稳定。',
    period: '分析期间: 2026-05-11 ~ 2026-05-17', model: '模型: Claude', schedule: '每日分析规则：09:00',
  };
  const guard = installPageIssueGuard(page);
  const blockedRequests: string[] = [];
  const deepQueries: URL[] = [];
  const localOrigin = new URL(baseURL!).origin;
  // Installed first, so every specific fixture gets a chance to fulfill before this final barrier.
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== localOrigin || url.pathname.startsWith('/api/')) {
      blockedRequests.push(route.request().url());
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  // The app's web-font stylesheet is also fulfilled locally; system fonts are sufficient for this behavior test.
  await page.route('https://fonts.googleapis.com/**', async (route) => route.fulfill({ contentType: 'text/css', body: '' }));
  await installOperationalApiMocks(page);
  await installDevSession(page, language);
  let successful = false;
  await page.route('**/api/ai/worker/status/**', async (route) => route.fulfill({ json: {
    state: successful ? 'offline' : 'online', online: !successful, tier: 'local', worker_name: 'fixture-local-worker',
    last_heartbeat_at: '2026-05-18T10:00:00+08:00', heartbeat_age_seconds: successful ? 3600 : 0,
    stale_after_seconds: 180, llm_ready: !successful, worker_version: 'production-ai-worker-v2',
    model_name: 'Qwen3.8-27B-4bit', model_display_name: 'Qwen 3.8 27B', available_model_ids: successful ? [] : ['qwen38'],
    last_analysis_completed_at: '2026-05-18T10:00:00+08:00', last_analysis_model_name: 'Qwen3.8-27B-4bit',
    last_analysis_model_display_name: 'Qwen 3.8 27B', last_analysis_llm_fallback: !successful,
    last_analysis_source: successful ? 'local_llm_rewrite' : 'deterministic',
    last_analysis_fallback_code: successful ? '' : 'grounding_rejected',
    last_successful_analysis_at: successful ? '2026-05-18T10:00:00+08:00' : '2026-05-17T09:00:00+08:00',
  } }));
  page.on('request', (request) => {
    if (request.url().includes('/api/ai/jobs/latest/') && request.url().includes('job_type=deep_analysis')) deepQueries.push(new URL(request.url()));
  });
  const requests: Array<Record<string, unknown>> = [];
  const pendingJob = {
    id: 1401, job_type: 'deep_analysis', status: 'pending', scope: { kind: 'production_weekly', language, model_id: 'chatgpt' },
    result_payload: {}, error_message: '', claimed_by: '', claimed_at: null, started_at: null, completed_at: null,
    model_name: '', model_display_name: 'ChatGPT', prompt_version: '', created_at: '2026-05-19T09:00:00+08:00', updated_at: '2026-05-19T09:00:00+08:00',
  };
  await page.route('**/api/ai/jobs/', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: pendingJob });
  });
  await page.route('**/api/ai/jobs/1401/', async (route) => route.fulfill({ json: pendingJob }));

  await page.goto('/production');
  await page.locator('input[type="date"]').fill('2026-05-18');
  await expect(page.getByText(labels.ready, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.fallback, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.success, { exact: true })).toHaveCount(0);
  const lastSuccess = page.locator('.production-ai-worker-status__meta div').filter({ hasText: labels.lastSuccess });
  await expect(lastSuccess).toContainText('2026');
  await expect(lastSuccess).toContainText('17');

  const deepPanel = page.getByRole('region', { name: labels.region });
  await expect(deepPanel.getByRole('heading', { name: labels.title, exact: true })).toBeVisible();
  await expect(deepPanel).toContainText(labels.schedule);
  await expect(deepPanel).toContainText('Asia/Shanghai');
  await expect(deepPanel).toContainText(labels.period);
  await expect(deepPanel).toContainText(labels.model);
  await expect(deepPanel).toContainText(labels.summary);
  if (language === 'zh') await expect(deepPanel).not.toContainText(/[가-힣]/);
  await deepPanel.getByRole('button', { name: labels.request, exact: true }).click();
  await expect(deepPanel.getByText(labels.queued, { exact: true })).toBeVisible();
  expect(requests).toEqual([{ job_type: 'deep_analysis', scope: { kind: 'production_weekly', language, model_id: 'chatgpt' } }]);
  await expect(deepPanel).toContainText(labels.model);
  expect(deepQueries.length).toBeGreaterThan(0);
  expect(deepQueries.every((url) => !url.searchParams.has('model_id'))).toBe(true);
  // Position the section below the existing sticky shell without modifying application layout.
  await deepPanel.evaluate((panel, offset) => window.scrollBy(0, panel.getBoundingClientRect().top - offset), language === 'zh' ? 170 : 100);
  await page.screenshot({ path: testInfo.outputPath('chatgpt-with-claude-history.png') });

  // Last real success stays visible even after the worker goes offline.
  successful = true;
  await page.reload();
  await expect(page.getByText(labels.offline, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.success, { exact: true })).toBeVisible();
  await expect(page.getByText(labels.fallback, { exact: true })).toHaveCount(0);
  await expectNoUndefinedOrNaN(page);
  expect(blockedRequests, 'all API requests must have fixtures and all network must stay local').toEqual([]);
  guard.assertClean();
});
