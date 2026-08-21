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
    evidence_count: 3,
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
      plan_group_count: 2,
      planned_quantity: 3840,
      machine_names: ['850T-1', '850T-9'],
      model_names: ['24G411B-BB.AEUYJVN'],
      part_nos: ['ACQ30776301'],
      part_prefixes: ['ACQ307763'],
      plan_targets: [
        {
          machine_name: '850T-1',
          sequence: 1,
          model_name: '24G411B-BB.AEUYJVN',
          part_no: 'ACQ30776301',
          lot_no: 'LOT-1',
          planned_quantity: 1920,
          display_model_code: '24G411A',
          display_description: 'B/C',
          display_model_valid_from: '2026-01-01',
        },
        {
          machine_name: '850T-9',
          sequence: 1,
          model_name: '24G411B-BB.AEUYJVN',
          part_no: 'ACQ30776301',
          lot_no: 'LOT-9',
          planned_quantity: 1920,
          display_model_code: '24G411A',
          display_description: 'B/C',
          display_model_valid_from: '2026-01-01',
        },
      ],
      historical_model_names: ['24G411', '24G411A(1#)'],
      historical_part_nos: ['ACQ30776301', 'ACQ30776319(1#)'],
    },
  };
  const extraLabelTargets = [
    {
      machine_name: '850T-16',
      sequence: 1,
      model_name: '27G523B-BB.AEUKMKN',
      part_no: 'ACQ30841001',
      lot_no: 'LOT-16',
      planned_quantity: 1800,
      display_model_code: '27G523',
      display_description: 'B',
      display_model_valid_from: '2026-01-01',
    },
    {
      machine_name: '850T-17',
      sequence: 1,
      model_name: '34BA75QE-BT.ATRMFKN',
      part_no: 'ACQ30999901',
      lot_no: 'LOT-17',
      planned_quantity: 1600,
      display_model_code: '34BA75QE',
      display_description: 'B',
      display_model_valid_from: '2026-01-01',
    },
    {
      machine_name: '850T-18',
      sequence: 1,
      model_name: '65UQ79-BB.ABCDEFG',
      part_no: 'ACQ30000001',
      lot_no: 'LOT-18',
      planned_quantity: 1500,
      display_model_code: '65UQ79',
      display_description: '',
      display_model_valid_from: '2026-01-01',
    },
    {
      machine_name: '850T-16',
      sequence: 2,
      model_name: '65UQ80-BB.ABCDEFG',
      part_no: 'ACQ31111101',
      lot_no: 'LOT-16-B',
      planned_quantity: 1400,
      display_model_code: '65UQ80',
      display_description: 'X',
      display_model_valid_from: '2026-01-01',
    },
  ];
  const additionalMetrics = [
    ['label_abnormality', '라벨 불량', '标签异常'],
    ['burr_flash', '버·플래시', '毛刺未去除'],
    ['air_mark', '가스 마크', '气印'],
    ['whitening', '백화·백색 자국', '发白·白印'],
    ['silver_streak', '은선', '料花'],
    ['scratch_damage', '스크래치·찍힘', '擦伤·碰伤'],
    ['packaging_abnormality', '포장 이상', '包装异常'],
  ].map(([canonicalKey, ko, zh]) => {
    const isLabelMetric = canonicalKey === 'label_abnormality';
    return {
      ...metric,
      metric_key: `problem:${canonicalKey}`,
      canonical_key: canonicalKey,
      label: localized(ko, zh),
      evidence_count: isLabelMetric ? 13 : 2,
      all_history_denominator: isLabelMetric ? 16 : metric.all_history_denominator,
      all_history_share_pct: isLabelMetric ? 81.3 : metric.all_history_share_pct,
      trend: isLabelMetric ? {
        ...metric.trend,
        status: 'increase',
        reason: 'count_and_share_increase',
        recent_count: 13,
        previous_count: 1,
        recent_denominator: 16,
        previous_denominator: 8,
        recent_share_pct: 81.3,
        previous_share_pct: 12.5,
        share_change_pp: 68.8,
        count_change: 12,
      } : metric.trend,
      impact_scope: isLabelMetric ? {
        ...metric.impact_scope,
        plan_group_count: 6,
        machine_names: ['850T-1', '850T-9', '850T-16', '850T-17', '850T-18'],
        model_names: [
          ...metric.impact_scope.model_names,
          ...extraLabelTargets.map((target) => target.model_name),
        ],
        part_nos: [
          ...metric.impact_scope.part_nos,
          ...extraLabelTargets.map((target) => target.part_no),
        ],
        part_prefixes: [
          ...metric.impact_scope.part_prefixes,
          'ACQ308410',
          'ACQ309999',
          'ACQ300000',
          'ACQ311111',
        ],
        plan_targets: [...metric.impact_scope.plan_targets, ...extraLabelTargets],
      } : metric.impact_scope,
    };
  });
  const labelMetric = additionalMetrics.find((candidate) => candidate.canonical_key === 'label_abnormality');
  if (!labelMetric) throw new Error('label metric fixture is required');
  const labelSurfacePair = {
    ...labelMetric,
    metric_key: 'pair:label_abnormality:surface',
    dimension: 'problem_location_pair',
    canonical_key: 'label_abnormality:surface',
    problem_canonical_key: 'label_abnormality',
    location_canonical_key: 'surface',
    label: localized('라벨 불량 · 표면', '标签异常 · 表面'),
    problem_label: localized('라벨 불량', '标签异常'),
    location_label: localized('표면', '表面'),
    classification_basis: 'canonical_problem_explicit_location_pair_v1',
    pair_basis: 'same_quality_report_id',
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
      problem_types: [
        { key: 'color_difference', label: localized('색차', '色差') },
        { key: 'label_abnormality', label: localized('라벨 불량', '标签异常') },
      ],
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
  const labelReport = (id: number, reportDt: string, partNo: string) => ({
    id,
    report_dt: reportDt,
    section: 'LQC_INJ',
    model: 'LABEL-MODEL',
    part_no: partNo,
    judgement: 'NG',
    defect_rate: '',
    phenomenon: '标签用错',
    problem_types: [{ key: 'label_abnormality', label: localized('라벨 불량', '标签异常') }],
    occurrence_locations: [{ key: 'surface', label: localized('표면', '表面') }],
    disposition: '',
    action_result: '',
    images: [],
  });
  const labelReports16 = [
    labelReport(1601, '2026-08-20T07:00:00Z', 'ACQ30841001'),
    labelReport(1602, '2026-08-10T09:00:00+08:00', 'ACQ30841001'),
    labelReport(1603, '2026-07-22T00:30:00+08:00', 'ACQ30841001'),
  ];
  const labelReports17 = [
    labelReport(1701, '2026-08-20T09:00:00+08:00', 'ACQ30999901'),
    labelReport(1702, '2026-07-23T09:00:00+08:00', 'ACQ30999901'),
    labelReport(1703, '2026-07-22T09:00:00+08:00', 'ACQ30999901'),
  ];
  const labelReports18 = [
    labelReport(1801, '2026-06-10T09:00:00+08:00', 'ACQ30000001'),
  ];
  const labelReports16OtherPrefix = [
    labelReport(1651, '2026-08-20T10:00:00+08:00', 'ACQ31111101'),
    labelReport(1652, '2026-08-18T09:00:00+08:00', 'ACQ31111101'),
    labelReport(1653, '2026-08-16T09:00:00+08:00', 'ACQ31111101'),
    labelReport(1654, '2026-08-14T09:00:00+08:00', 'ACQ31111101'),
    labelReport(1655, '2026-08-12T09:00:00+08:00', 'ACQ31111101'),
    labelReport(1656, '2026-08-10T09:00:00+08:00', 'ACQ31111101'),
  ];

  await page.route('**/api/quality/daily-attention/**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        date: '2026-08-20',
        total_plan_count: 6,
        total_matching_reports: 3,
        without_history_count: 0,
        items: [{
          source_key: '850T-1:1:ACQ307763',
          match_basis: 'part_prefix_9',
          machine_name: '850T-1',
          machine_number: 1,
          sequence: 1,
          part_prefix: 'ACQ307763',
          part_nos: ['ACQ30776301'],
          model_names: ['24G411B-BB.AEUYJVN'],
          lot_nos: ['LOT-1'],
          planned_quantity: 1920,
          plan_row_count: 1,
          matching_report_count: 3,
          latest_report_dt: '2026-08-09T09:00:00+08:00',
          top_phenomena: [],
          reports,
        }, {
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
        }, {
          source_key: '850T-16:1:ACQ308410',
          match_basis: 'part_prefix_9',
          machine_name: '850T-16',
          machine_number: 16,
          sequence: 1,
          part_prefix: 'ACQ308410',
          part_nos: ['ACQ30841001'],
          model_names: ['27G523B-BB.AEUKMKN'],
          lot_nos: ['LOT-16'],
          planned_quantity: 1800,
          plan_row_count: 1,
          matching_report_count: labelReports16.length,
          latest_report_dt: labelReports16[0].report_dt,
          top_phenomena: [],
          reports: labelReports16,
        }, {
          source_key: '850T-17:1:ACQ309999',
          match_basis: 'part_prefix_9',
          machine_name: '850T-17',
          machine_number: 17,
          sequence: 1,
          part_prefix: 'ACQ309999',
          part_nos: ['ACQ30999901'],
          model_names: ['34BA75QE-BT.ATRMFKN'],
          lot_nos: ['LOT-17'],
          planned_quantity: 1600,
          plan_row_count: 1,
          matching_report_count: labelReports17.length,
          latest_report_dt: labelReports17[0].report_dt,
          top_phenomena: [],
          reports: labelReports17,
        }, {
          source_key: '850T-18:1:ACQ300000',
          match_basis: 'part_prefix_9',
          machine_name: '850T-18',
          machine_number: 18,
          sequence: 1,
          part_prefix: 'ACQ300000',
          part_nos: ['ACQ30000001'],
          model_names: ['65UQ79-BB.ABCDEFG'],
          lot_nos: ['LOT-18'],
          planned_quantity: 1500,
          plan_row_count: 1,
          matching_report_count: labelReports18.length,
          latest_report_dt: labelReports18[0].report_dt,
          top_phenomena: [],
          reports: labelReports18,
        }, {
          source_key: '850T-16:2:ACQ311111',
          match_basis: 'part_prefix_9',
          machine_name: '850T-16',
          machine_number: 16,
          sequence: 2,
          part_prefix: 'ACQ311111',
          part_nos: ['ACQ31111101'],
          model_names: ['65UQ80-BB.ABCDEFG'],
          lot_nos: ['LOT-16-B'],
          planned_quantity: 1400,
          plan_row_count: 1,
          matching_report_count: labelReports16OtherPrefix.length,
          latest_report_dt: labelReports16OtherPrefix[0].report_dt,
          top_phenomena: [],
          reports: labelReports16OtherPrefix,
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
            repeated_issues: [
              {
                metric_key: 'problem:burr_flash',
                narrative: localized('버·플래시 반복 이력', '毛刺未去除重复履历'),
              },
              {
                metric_key: 'problem:air_mark',
                narrative: localized('가스 마크 반복 이력', '气印重复履历'),
              },
              {
                metric_key: 'problem:whitening',
                narrative: localized('백화 반복 이력', '发白重复履历'),
              },
            ],
            accelerating_issues: [{
              metric_key: 'pair:label_abnormality:surface',
              narrative: localized('라벨 불량 최근 증가', '标签异常近期增加'),
            }],
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
              plan_group_count: 2,
              distinct_prefix_count: 1,
              matched_report_count: 3,
              without_history_count: 0,
              latest_report_dt: '2026-08-09T09:00:00+08:00',
              model_names: ['24G411B-BB.AEUYJVN'],
              part_nos: ['ACQ30776301'],
              problem_type_count: 6,
              occurrence_location_count: 2,
            },
            problem_types: [metric, ...additionalMetrics],
            problem_location_pairs: [labelSurfacePair],
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
  await expect(page.getByText('Executive Summary', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '오늘 우선확인 4' })).toBeVisible();
  await expect(page.getByText('관련 계획 대상', { exact: true })).toHaveCount(4);
  await expect(page.getByRole('heading', { name: '반복 문제 및 최근 변화' })).toHaveCount(0);
  const prioritySection = page
    .getByRole('heading', { name: '오늘 우선확인 4' })
    .locator('xpath=ancestor::section[1]');
  await expect(prioritySection.locator('article h4').nth(0)).toHaveText('라벨 불량');
  await expect(prioritySection.locator('article h4').nth(1)).toHaveText('버·플래시');
  await expect(prioritySection.locator('article h4').nth(2)).toHaveText('가스 마크');
  await expect(prioritySection.locator('article h4').nth(3)).toHaveText('백화·백색 자국');
  await expect(prioritySection.locator('article h4')).toHaveCount(4);
  const labelPriorityCard = prioritySection.locator('article').first();
  await expect(labelPriorityCard.getByText('문제유형 1', { exact: true })).toBeVisible();
  await expect(labelPriorityCard.getByText('문제유형', { exact: true })).toHaveCount(0);
  await expect(labelPriorityCard).toContainText('건수·비중 동시 증가');
  await expect(labelPriorityCard).toContainText('+12건 · +68.8%p');
  await expect(labelPriorityCard).toContainText('상위 3 / 6');
  const rankedLabelTargets = labelPriorityCard.getByRole('button', { name: /근거 사례·사진 보기:/ });
  await expect(rankedLabelTargets).toHaveCount(3);
  await expect(rankedLabelTargets.nth(0)).toHaveAccessibleName(/16호기 — 65UQ80 X, 최근 30일 관련 이력 6건/);
  await expect(rankedLabelTargets.nth(1)).toHaveAccessibleName(/16호기 — 27G523 B, 최근 30일 관련 이력 3건/);
  await expect(rankedLabelTargets.nth(2)).toHaveAccessibleName(/17호기 — 34BA75QE B, 최근 30일 관련 이력 3건/);
  await expect(labelPriorityCard.getByRole('button', { name: /1호기/ })).toHaveCount(0);
  await expect(labelPriorityCard.getByRole('button', { name: /9호기/ })).toHaveCount(0);
  await expect(labelPriorityCard.getByRole('button', { name: /18호기/ })).toHaveCount(0);
  await expect(prioritySection.locator('article').nth(1)).toContainText('반복 주의');
  await expect(prioritySection.locator('article').first().getByRole('progressbar', { name: /이전 30일/ })).toBeVisible();
  await expect(prioritySection.locator('article').first().getByRole('progressbar', { name: /최근 30일/ })).toBeVisible();
  await expect(prioritySection.locator('article').first()).toContainText('최근 변화');
  await expect(prioritySection.locator('article').first()).toContainText('전체 이력');
  await expect(prioritySection.getByRole('heading', { name: /가스 마크·백화/ })).toHaveCount(0);
  const titleToTrendGap = await labelPriorityCard.evaluate((card) => {
    const title = card.querySelector('h4');
    const changeLabel = [...card.querySelectorAll('span')]
      .find((element) => element.textContent?.trim() === '최근 변화');
    const comparison = changeLabel?.closest('.rounded-xl');
    if (!title || !comparison) return Number.POSITIVE_INFINITY;
    return comparison.getBoundingClientRect().top - title.getBoundingClientRect().bottom;
  });
  expect(titleToTrendGap).toBeLessThanOrEqual(24);
  const initialViewport = page.viewportSize();
  if (initialViewport && initialViewport.width >= 1000) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const wideCardBoxes = await prioritySection.locator('article').evaluateAll((cards) => cards.map((card) => {
      const box = card.getBoundingClientRect();
      return { x: box.x, y: box.y };
    }));
    expect(wideCardBoxes).toHaveLength(4);
    expect(Math.max(...wideCardBoxes.map((box) => box.y)) - Math.min(...wideCardBoxes.map((box) => box.y))).toBeLessThan(2);
    expect(wideCardBoxes.map((box) => box.x)).toEqual([...wideCardBoxes.map((box) => box.x)].sort((a, b) => a - b));

    await page.setViewportSize({ width: 900, height: 800 });
    const secondCardTarget = prioritySection
      .locator('article')
      .nth(1)
      .getByRole('button', { name: '근거 사례·사진 보기: 1호기 — 24G411A B/C' });
    await expect(secondCardTarget.locator('span.block.truncate').first()).toHaveText('1호기 — 24G411A B/C');
    await expect(secondCardTarget).toHaveAttribute('aria-describedby', /priority-target-1-0-details/);
    expect(await secondCardTarget.evaluate((element) => getComputedStyle(element).backgroundColor))
      .not.toBe('rgb(2, 6, 23)');
    await secondCardTarget.focus();
    const tooltip = secondCardTarget.getByRole('tooltip');
    await expect(tooltip).toBeVisible();
    await expect(tooltip).toContainText('24G411B-BB.AEUYJVN');
    await expect(tooltip).toContainText('ACQ30776301');
    const tooltipBox = await tooltip.boundingBox();
    expect(tooltipBox?.x ?? -1).toBeGreaterThanOrEqual(0);
    expect((tooltipBox?.x ?? 0) + (tooltipBox?.width ?? 901)).toBeLessThanOrEqual(900);
    await secondCardTarget.press('Escape');
    await expect(tooltip).toBeHidden();
    await page.setViewportSize(initialViewport);
  }
  const colorDifferenceCard = page.getByRole('article').filter({
    has: page.getByRole('heading', { name: '색차', exact: true }),
  });
  await expect(colorDifferenceCard.getByRole('button', { name: '근거 사례·사진 보기: 1호기 — 24G411A B/C' })).toBeVisible();
  await colorDifferenceCard.getByRole('button', { name: '근거 사례·사진 보기: 9호기 — 24G411A B/C' }).click();

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
