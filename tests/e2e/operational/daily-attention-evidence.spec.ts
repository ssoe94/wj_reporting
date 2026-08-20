import { expect, test } from '@playwright/test';

import {
  expectNoUndefinedOrNaN,
  installDevSession,
  installPageIssueGuard,
} from '../helpers/operational';

const imageOne = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#d6d8dc"/><circle cx="360" cy="240" r="70" fill="none" stroke="#ef4444" stroke-width="12"/></svg>',
);
const imageTwo = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><rect width="640" height="480" fill="#252933"/><path d="M80 350L560 90" stroke="#ef4444" stroke-width="12"/></svg>',
);

const localized = (ko: string, zh: string) => ({ ko, zh });

test('priority evidence separates exact and related parts and shows every photo', async ({ page }) => {
  const guard = installPageIssueGuard(page);
  await installDevSession(page, 'ko');

  const metric = {
    metric_key: 'problem:color_difference',
    dimension: 'problem_type',
    canonical_key: 'color_difference',
    label: localized('색차', '色差'),
    classification_basis: 'canonical_alias_v1',
    evidence_count: 2,
    repeat_status: 'repeated',
    latest_report_dt: '2026-08-09T09:00:00+08:00',
    all_history_denominator: 3,
    all_history_denominator_basis: 'unique_matching_reports_in_current_plan_prefixes',
    all_history_share_pct: 66.7,
    trend: {
      status: 'stable_or_decrease',
      reason: 'increase_rule_not_met',
      recent_count: 1,
      previous_count: 1,
      recent_denominator: 2,
      previous_denominator: 1,
      recent_share_pct: 50,
      previous_share_pct: 100,
      share_change_pp: -50,
      count_change: 0,
      denominator_basis: 'unique_matching_reports_in_current_plan_prefixes',
    },
    impact_scope: {
      plan_group_count: 1,
      planned_quantity: 1920,
      machine_names: ['850T-9'],
      model_names: ['24G411B-BB.AEUYJVN'],
      part_nos: ['ACQ30776301'],
      part_prefixes: ['ACQ307763'],
      plan_targets: [{
        machine_name: '850T-9',
        sequence: 1,
        model_name: '24G411B-BB.AEUYJVN',
        part_no: 'ACQ30776301',
        lot_no: 'LOT-9',
        planned_quantity: 1920,
      }],
      historical_model_names: ['24G411', '24G411A(1#)'],
      historical_part_nos: ['ACQ30776301', 'ACQ30776319(1#)'],
    },
  };

  const reports = [
    {
      id: 901,
      report_dt: '2026-08-09T09:00:00+08:00',
      section: 'LQC_INJ',
      model: '24G411',
      part_no: 'ACQ30776301',
      judgement: 'NG',
      defect_rate: '',
      phenomenon: '1.侧面白印擦不掉 2.9号机表面色差需要调整',
      problem_types: [{ key: 'color_difference', label: localized('색차', '色差') }],
      occurrence_locations: [{ key: 'side', label: localized('측면', '侧面') }],
      disposition: '조건 조정',
      action_result: '',
      images: [imageOne, imageTwo],
    },
    {
      id: 719,
      report_dt: '2026-07-07T09:00:00+08:00',
      section: 'OQC',
      model: '24G411A(1#)',
      part_no: 'ACQ30776319(1#)',
      judgement: 'NG',
      defect_rate: '9.52%',
      phenomenon: '脏污 表面色差',
      problem_types: [
        { key: 'contamination', label: localized('오염·이물', '脏污') },
        { key: 'color_difference', label: localized('색차', '色差') },
      ],
      occurrence_locations: [{ key: 'unknown', label: localized('위치 미확인', '位置未确认') }],
      disposition: '',
      action_result: '',
      images: [imageOne],
    },
    {
      id: 609,
      report_dt: '2026-06-01T09:00:00+08:00',
      section: 'LQC_INJ',
      model: '24G411A(1#)',
      part_no: 'ACQ30776309(1#)',
      judgement: 'NG',
      defect_rate: '25%',
      phenomenon: '表面料花',
      problem_types: [{ key: 'silver_streak', label: localized('은선', '料花') }],
      occurrence_locations: [{ key: 'surface', label: localized('표면', '表面') }],
      disposition: '',
      action_result: '',
      images: [imageOne],
    },
  ];

  await page.route('**/api/quality/daily-attention/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        date: '2026-08-20',
        total_plan_count: 1,
        total_matching_reports: 3,
        without_history_count: 0,
        items: [{
          source_key: '850T-9:1:ACQ307763',
          match_basis: 'part_prefix_9',
          machine_name: '850T-9',
          machine_number: 9,
          sequence: 1,
          part_prefix: 'ACQ307763',
          part_nos: ['ACQ30776301'],
          model_names: ['24G411B-BB.AEUYJVN'],
          lot_nos: ['LOT-9'],
          planned_quantity: 1920,
          plan_row_count: 1,
          matching_report_count: 3,
          latest_report_dt: '2026-08-09T09:00:00+08:00',
          top_phenomena: [],
          reports,
        }],
        report: {
          schema_version: 'quality-daily-page-report.v1',
          contract_version: 'quality-daily-public-report.v2',
          status: 'ready',
          reason: null,
          business_date: '2026-08-20',
          source_revision: 'fixture',
          source_plan_last_changed_at: null,
          source_evidence_last_changed_at: null,
          generated_at: '2026-08-20T08:00:00+08:00',
          completed_at: '2026-08-20T08:00:10+08:00',
          model_id: 'qwen38',
          ai_schema_version: 'quality-daily-attention-ai.v1',
          deterministic_schema_version: 'quality-daily-report.v1',
          disclaimer: localized('과거 이력', '历史记录'),
          narrative: {
            schema_version: 'quality-daily-report-narrative.v1',
            summary: localized('색차 이력을 우선 확인합니다.', '优先确认色差履历。'),
            executive_summary: localized('색차 2건을 우선 확인하고 연관 사례를 구분합니다.', '优先确认2件色差，并区分关联案例。'),
            executive_summary_segments: [
              {
                key: 'focus',
                label: localized('오늘 초점', '今日重点'),
                parts: [
                  { text: localized('현재 품번의 ', '当前料号的'), strong: false },
                  { text: localized('색차', '色差'), strong: true },
                  { text: localized(' 이력을 먼저 확인합니다.', '履历需优先确认。'), strong: false },
                ],
              },
              {
                key: 'basis',
                label: localized('판단 근거', '判断依据'),
                parts: [
                  { text: localized('전체 이력 ', '全部履历'), strong: false },
                  { text: localized('2건 / 3건', '2件 / 3件'), strong: true },
                  { text: localized('입니다.', '。'), strong: false },
                ],
              },
              {
                key: 'next_priority',
                label: localized('다음 확인', '后续确认'),
                parts: [
                  { text: localized('정확 품번과 앞 9자리 연관 사례를 나눠 봅니다.', '区分完整料号与前9位关联案例。'), strong: false },
                ],
              },
            ],
            priorities: [],
            repeated_issues: [],
            accelerating_issues: [],
            affected_targets: [],
            shift_checks: { ko: [], zh: [] },
            caveats: { ko: [], zh: [] },
          },
          generation_source: 'local_llm_rewrite',
          llm_fallback: false,
          llm_fallback_code: '',
          data_policy: {},
          deterministic: {
            schema_version: 'quality-daily-report.v1',
            calculated_at: '2026-08-20T08:00:00+08:00',
            as_of_date: '2026-08-20',
            history_coverage: 'all_history',
            match_basis: 'part_prefix_9',
            trend_policy: {
              window_days: 30,
              recent_start: '2026-07-22',
              recent_end: '2026-08-20',
              previous_start: '2026-06-22',
              previous_end: '2026-07-21',
              min_window_denominator: 5,
              min_combined_issue_count: 2,
              increase_rule: 'count_and_share_must_both_increase',
              zero_denominator_policy: 'insufficient_data',
              small_sample_policy: 'insufficient_data',
              window_anchor: 'selected_plan_date',
            },
            coverage: {
              plan_group_count: 1,
              distinct_prefix_count: 1,
              matched_report_count: 3,
              without_history_count: 0,
              latest_report_dt: '2026-08-09T09:00:00+08:00',
              model_names: ['24G411B-BB.AEUYJVN'],
              part_nos: ['ACQ30776301'],
              problem_type_count: 2,
              occurrence_location_count: 2,
            },
            problem_types: [metric],
            problem_location_pairs: [],
            occurrence_locations: [],
            calculation_basis: {},
          },
        },
      }),
    });
  });

  await page.route('**/api/injection/parts/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        count: 1,
        next: null,
        previous: null,
        results: [
          {
            id: 1,
            part_no: 'ACQ30776301',
            model_code: '24G411',
            description: 'B/C',
            color: 'GRAY',
            valid_from: '2026-01-01',
          },
        ],
      }),
    });
  });

  await page.goto('/quality/daily-attention');
  const executiveDetails = page.getByLabel('Executive Summary 상세');
  await expect(executiveDetails).toBeVisible();
  await expect(executiveDetails.locator(':scope > div')).toHaveCount(3);
  await expect(executiveDetails.getByText('오늘 초점', { exact: true })).toBeVisible();
  await expect(executiveDetails.locator('strong')).toHaveText(['색차', '2건 / 3건']);
  await expect(executiveDetails.locator('strong').first()).toHaveCSS('display', 'inline');
  await page.getByRole('button', { name: '근거 사례·사진 보기', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: /색차 근거 사례·사진/ });
  await expect(dialog.getByRole('heading', { name: '색차 근거 사례·사진' })).toBeVisible();
  await expect(dialog.getByText('현재 품번 정확 일치').first()).toBeVisible();
  await expect(dialog.getByText('앞 9자리 연관').first()).toBeVisible();
  await expect(dialog.getByText('품목 마스터 색상: GRAY · 24G411')).toBeVisible();
  await expect(dialog.getByText('보고일 기준 품목 색상')).toHaveCount(2);
  await expect(dialog.getByText('정확 품번 색상 미등록')).toBeVisible();
  await expect(dialog.getByText('表面料花')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: '24G411 1/2' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: '24G411 2/2' })).toBeVisible();

  const evidenceSearch = dialog.getByPlaceholder('원문·모델·품번 검색 (예: 黑点, 色差)');
  await evidenceSearch.fill('흑점');
  await expect(dialog.getByText('현재 조건에 맞는 과거 사례가 없습니다.')).toBeVisible();
  await dialog.getByRole('button', { name: '현재 품번 정확 일치 1' }).click();
  await evidenceSearch.fill('色差');
  await expect(dialog.getByText('1.侧面白印擦不掉 2.9号机表面色差需要调整')).toBeVisible();
  await expect(dialog.getByText('脏污 表面色差')).toHaveCount(0);

  await dialog.getByRole('button', { name: '24G411 1/2' }).click();
  const lightbox = page.getByRole('dialog', { name: /24G411 · 1\/2/ });
  await expect(lightbox.getByRole('heading', { name: '24G411 · 1/2' })).toBeVisible();
  await lightbox.getByRole('button', { name: '다음 사진' }).click();
  await expect(page.getByRole('heading', { name: '24G411 · 2/2' })).toBeVisible();

  await expectNoUndefinedOrNaN(page);
  guard.assertClean();
});
