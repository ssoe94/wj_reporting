import { expect, test } from '@playwright/test';

import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installPageIssueGuard,
} from '../helpers/operational';

const localized = (ko: string, zh: string) => ({ ko, zh });
const image = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#f4f4f1"/><rect x="120" y="100" width="400" height="280" rx="36" fill="#fff" stroke="#64748b" stroke-width="8"/></svg>',
);

test('Qwen review keeps exact Part No and separates visual white from the defect category', async ({ page }) => {
  const guard = installPageIssueGuard(page);
  await installDevSession(page, 'ko');
  let reviewedPayload: Record<string, unknown> | null = null;

  await page.route('**/api/quality/classification-audit/**', async (route) => {
    if (route.request().method() === 'POST' && route.request().url().includes('/review/')) {
      reviewedPayload = route.request().postDataJSON() as Record<string, unknown>;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job_id: 41, review: reviewedPayload }) });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        page: 1,
        page_size: 20,
        next_page: null,
        previous_page: null,
        stats: { total: 1, with_images: 1, needs_review: 1 },
        taxonomy_version: 'injection_industry_terms_v6',
        color_match_policy: 'normalized_full_part_no_only',
        results: [{
          report: {
            id: 901,
            report_dt: '2026-08-09T09:00:00+08:00',
            updated_at: '2026-08-09T09:10:00+08:00',
            section: 'LQC_INJ',
            model: '32G810',
            part_no: 'ACQ30726701',
            phenomenon: '表面色差需要调整',
            disposition: '条件调整',
            action_result: '',
            image_refs: [{ slot: 'image1', url: image }],
          },
          source_revision: 'fixture-revision',
          deterministic_classification: [{ key: 'color_difference', label: localized('색차', '色差') }],
          taxonomy_candidates: [
            { key: 'color_difference', parent_key: null, label: localized('색차', '色差') },
            { key: 'mixed_color', parent_key: 'color_black_material', label: localized('색상 혼입', '夹色') },
            { key: 'black_dot', parent_key: 'color_black_material', label: localized('흑점', '黑点') },
            { key: 'silver_streak', parent_key: null, label: localized('은선', '料花') },
          ],
          part_spec: { id: 7, color_raw: 'WHITE', color_key: 'white', valid_from: '2026-01-01', model_code: '32G810', match_basis: 'exact_part_no_effective_on_report_date' },
          queue_status: 'needs_review',
          job: { id: 41, status: 'completed', model_name: 'Qwen3.8-27B-4bit', prompt_version: 'quality-report-taxonomy-audit-qwen38-v1', error_message: '', completed_at: '2026-08-20T09:00:00+08:00' },
          result: {
            available: true,
            qwen_classification: { candidate_selections: [{ candidate_index: 0, key: 'color_difference', parent_key: null, label: localized('색차', '色差') }], confidence: 'high', needs_new_category: false },
            product_color_suggestion: { exact_part_no: 'ACQ30726701', suggested_color_key: 'white', suggested_color_label: localized('백색', '白色'), confidence: 'high', evidence_image_slots: ['image1'], status: 'review_required', match_basis: 'exact_quality_report_part_no' },
            master_color_comparison: { status: 'match', master_color_key: 'white', master_color_raw: 'WHITE', part_spec_valid_from: '2026-01-01' },
            review_required: true,
            review_reason_codes: ['classification_disagreement'],
            review: null,
          },
          exact_part_consensus: { report_count: 3, assessable_photo_report_count: 3, reviewed_report_count: 3, qwen_high_confidence_report_count: 0, dominant_color_key: 'white', dominant_color_label: localized('백색', '白色'), agreement_pct: 100, color_counts: { white: 3 }, match_basis: 'normalized_full_part_no_only', confidence_basis: 'human_reviewed_only' },
        }],
      }),
    });
  });

  await page.goto('/quality#review');
  await expect(page.getByRole('heading', { name: 'AI 분류 검토' })).toBeVisible();
  await expect(page.getByText('ACQ30726701').first()).toBeVisible();
  await expect(page.getByText('사진상 제품 본체색').first()).toBeVisible();
  await expect(page.getByText('백색 · 100%')).toBeVisible();
  await expect(page.getByText('앞 9자리만 같은 다른 품번은 일치도에 포함하지 않습니다.')).toBeVisible();
  await expect(page.getByRole('article').getByText('表面色差需要调整')).toBeVisible();

  await page.getByRole('button', { name: '색차', exact: true }).click();
  await page.getByRole('button', { name: '흑점', exact: true }).click();
  await page.getByLabel('사진을 직접 보고 제품 본체색을 확인했습니다').check();
  await page.getByRole('button', { name: '검토 저장' }).click();
  await expect.poll(() => reviewedPayload).not.toBeNull();
  expect(reviewedPayload).toMatchObject({
    action: 'overridden',
    category_keys: ['black_dot'],
    product_color_key: 'white',
  });

  await expectNoUndefinedOrNaN(page);
  guard.assertClean();
});
