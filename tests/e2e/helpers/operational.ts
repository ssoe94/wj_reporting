import { expect, type Page } from '@playwright/test';

type PageIssueGuard = {
  assertClean: () => void;
};

function base64UrlEncode(value: string) {
  return Buffer.from(value).toString('base64url');
}

function createDevJwt(kind: 'access' | 'refresh') {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(JSON.stringify({
    sub: 'dev-admin',
    name: 'superuser',
    env: 'wj-next-local',
    token_kind: kind,
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
  }));
  return `${header}.${payload}.local-preview`;
}

export async function installDevSession(page: Page, language: 'ko' | 'zh' = 'ko') {
  const accessToken = createDevJwt('access');
  const refreshToken = createDevJwt('refresh');

  await page.addInitScript(({ accessToken, refreshToken, language }) => {
    window.localStorage.setItem('wj_next_access_token', accessToken);
    window.localStorage.setItem('wj_next_refresh_token', refreshToken);
    window.localStorage.setItem('wj_next_language', language);
    window.localStorage.setItem('wj_next_login_language', language);
  }, { accessToken, refreshToken, language });
}

export function installPageIssueGuard(page: Page): PageIssueGuard {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failedResponses: string[] = [];

  page.on('console', (message) => {
    if (message.type() === 'error') {
      consoleErrors.push(message.text());
    }
  });
  page.on('pageerror', (error) => {
    pageErrors.push(error.message);
  });
  page.on('response', (response) => {
    const status = response.status();
    const url = response.url();
    if (status >= 400 && !url.includes('/favicon')) {
      failedResponses.push(`${status} ${url}`);
    }
  });

  return {
    assertClean() {
      expect(consoleErrors, 'console errors').toEqual([]);
      expect(pageErrors, 'page errors').toEqual([]);
      expect(failedResponses, 'failed network responses').toEqual([]);
    },
  };
}

export async function expectNoUndefinedOrNaN(page: Page) {
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/\bundefined\b/i);
  expect(bodyText).not.toMatch(/\bNaN\b/i);
}

export async function installOperationalApiMocks(page: Page) {
  const date = '2026-05-18';
  const planRecord = {
    id: 1,
    machine_name: '850T-1',
    lot_no: 'A01',
    model_name: 'MODEL-A',
    part_spec: 'B/C 完',
    product_family_code: 'BC',
    product_family_name: 'Back Cover',
    is_finished_product: true,
    part_no: 'PART-A',
    planned_quantity: 100,
    cavity: 2,
    sequence: 1,
    created_at: '2026-05-18T08:00:00+08:00',
    updated_at: '2026-05-18T08:00:00+08:00',
  };
  const secondPlanRecord = {
    ...planRecord,
    id: 2,
    lot_no: 'A02',
    model_name: 'MODEL-B',
    part_no: 'PART-B',
    sequence: 2,
  };
  const futurePlanRecord = {
    ...planRecord,
    id: 3,
    machine_name: '850T-2',
    lot_no: 'F01',
    model_name: 'MODEL-FUTURE',
    part_no: 'PART-FUTURE',
    planned_quantity: 80,
    sequence: 1,
  };
  const compensatedMesPlanRecord = {
    ...planRecord,
    id: 4,
    machine_name: '1300T-3',
    lot_no: 'M01',
    model_name: 'MODEL-MES-COMPENSATED',
    part_no: 'MESCOMP0001',
    planned_quantity: 500,
    cavity: 1,
    sequence: 1,
  };
  const corePlanRecord = {
    ...planRecord,
    id: 5,
    machine_name: '1400T-4',
    lot_no: 'C01',
    model_name: 'MODEL-CORE',
    part_no: 'ABJ76763510',
    planned_quantity: 40,
    cavity: 1,
    sequence: 1,
  };
  const coreSecondPlanRecord = {
    ...corePlanRecord,
    id: 6,
    lot_no: 'C02',
    part_no: 'ABJ76763511',
    planned_quantity: 400,
    sequence: 2,
  };
  const delayedGeneralStopPlanRecord = {
    ...planRecord,
    id: 7,
    machine_name: '1400T-5',
    lot_no: 'G01',
    model_name: 'MODEL-GENERAL-A',
    part_no: 'GENSTOP0001',
    planned_quantity: 40,
    cavity: 1,
    sequence: 1,
  };
  const delayedGeneralStopSecondPlanRecord = {
    ...delayedGeneralStopPlanRecord,
    id: 8,
    lot_no: 'G02',
    model_name: 'MODEL-GENERAL-B',
    part_no: 'GENSTOP0002',
    planned_quantity: 400,
    sequence: 2,
  };
  const injectionPlanRecords = [
    planRecord,
    secondPlanRecord,
    compensatedMesPlanRecord,
    corePlanRecord,
    coreSecondPlanRecord,
    delayedGeneralStopPlanRecord,
    delayedGeneralStopSecondPlanRecord,
  ];
  const tonnageMap: Record<number, string> = {
    1: '850T',
    2: '850T',
    3: '1300T',
    4: '1400T',
    5: '1400T',
    6: '2500T',
    7: '1800T',
    8: '850T',
    9: '850T',
    10: '650T',
    11: '550T',
    12: '550T',
    13: '450T',
    14: '850T',
    15: '650T',
    16: '1050T',
    17: '1200T',
  };
  const machines = Array.from({ length: 17 }, (_, index) => {
    const machineNumber = index + 1;
    const tonnage = tonnageMap[machineNumber] ?? '850T';
    return {
      machine_number: machineNumber,
      machine_name: `${machineNumber}호기`,
      tonnage,
      display_name: `${tonnage}-${machineNumber}`,
    };
  });
  const slotCount = 80;
  const timeSlots = Array.from({ length: slotCount }, (_, index) => {
    const totalMinutes = index * 2;
    const hour = 8 + Math.floor(totalMinutes / 60);
    const minute = totalMinutes % 60;
    const label = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
    return {
      hour_offset: index,
      time: `2026-05-18T${label}:00+08:00`,
      label,
      interval_minutes: 2,
    };
  });
  const padSeries = (values: number[], fillValue = 0) => [
    ...values,
    ...Array.from({ length: Math.max(0, slotCount - values.length) }, () => fillValue),
  ].slice(0, slotCount);
  const toCumulative = (values: number[]) => values.reduce<number[]>((totals, value, index) => {
    totals.push((totals[index - 1] ?? 0) + value);
    return totals;
  }, []);
  const machineOneActual = padSeries([
    10, 10, 10, 10,
    0, 0, 0, 0, 0, 0, 0,
    5, 5, 5, 5,
    0, 0, 0, 0, 0, 0,
    1, 3, 7, 7, 7,
  ], 7);
  const machineOneCumulative = toCumulative(machineOneActual);
  const machineTwoActual = padSeries([
    0, 2, 2, 2,
    0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0,
    0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ]);
  const machineTwoCumulative = toCumulative(machineTwoActual);
  const machineThreeActual = Array.from({ length: slotCount }, (_, index) => {
    if (index < 4) return 5;
    if (index < 10) return 0;
    if (index === 10) return 30;
    return 5;
  });
  const machineThreeCumulative = toCumulative(machineThreeActual);
  const machineFourActual = Array.from({ length: slotCount }, (_, index) => {
    if (index < 4) return 10;
    if (index < 10) return 0;
    return 5;
  });
  const machineFourCumulative = toCumulative(machineFourActual);
  const machineFiveActual = Array.from({ length: slotCount }, (_, index) => {
    if (index < 4) return 10;
    if (index < 55) return 0;
    return 5;
  });
  const machineFiveCumulative = toCumulative(machineFiveActual);
  const zeroSeries = Array.from({ length: timeSlots.length }, () => 0);
  const matrixKeys = machines.map((machine) => machine.machine_name);
  const cumulativeProductionMatrix = Object.fromEntries(
    matrixKeys.map((machineName) => [
      machineName,
      machineName === '1호기'
        ? machineOneCumulative
        : machineName === '2호기'
          ? machineTwoCumulative
          : machineName === '3호기'
            ? machineThreeCumulative
            : machineName === '4호기'
              ? machineFourCumulative
              : machineName === '5호기'
                ? machineFiveCumulative
                : zeroSeries,
    ]),
  );
  const actualProductionMatrix = Object.fromEntries(
    matrixKeys.map((machineName) => [
      machineName,
      machineName === '1호기'
        ? machineOneActual
        : machineName === '2호기'
          ? machineTwoActual
          : machineName === '3호기'
            ? machineThreeActual
            : machineName === '4호기'
              ? machineFourActual
              : machineName === '5호기'
                ? machineFiveActual
                : zeroSeries,
    ]),
  );
  const oilTemperatureMatrix = Object.fromEntries(
    matrixKeys.map((machineName) => [machineName, machineName === '1호기' ? timeSlots.map((_, index) => 35 + Math.min(index, 3)) : zeroSeries]),
  );
  const powerKwhMatrix = Object.fromEntries(
    matrixKeys.map((machineName) => [machineName, machineName === '1호기' ? timeSlots.map((_, index) => index + 1) : zeroSeries]),
  );
  const powerUsageMatrix = Object.fromEntries(
    matrixKeys.map((machineName) => [machineName, machineName === '1호기' ? timeSlots.map((_, index) => (index === 0 ? 0 : 1)) : zeroSeries]),
  );

  await page.route('**/api/injection/user/me/**', async (route) => {
    await route.fulfill({
      json: {
        id: 1,
        username: 'superuser',
        email: 'superuser@local.preview',
        is_staff: true,
        groups: ['local-preview'],
        department: 'Production',
        permissions: {
          can_view_injection: true,
          can_view_assembly: true,
          can_view_quality: true,
          can_view_sales: true,
          can_view_development: true,
          can_edit_injection: true,
          can_edit_assembly: true,
          can_edit_quality: true,
          can_edit_sales: true,
          can_edit_development: true,
          is_admin: true,
          can_edit_machining: true,
          can_edit_eco: true,
          can_edit_inventory: true,
        },
      },
    });
  });

  await page.route('**/api/production/plan-dates/**', async (route) => {
    await route.fulfill({ json: { injection: [date], machining: [date] } });
  });

  await page.route('**/api/production/plans/**', async (route) => {
    if (route.request().method() === 'PATCH') {
      const updates = route.request().postDataJSON() as Partial<typeof planRecord>;
      await route.fulfill({
        json: {
          ...planRecord,
          ...updates,
          planned_quantity: Number(updates.planned_quantity ?? planRecord.planned_quantity),
          updated_at: '2026-05-18T09:00:00+08:00',
        },
      });
      return;
    }

    await route.fulfill({ json: injectionPlanRecords });
  });

  await page.route('**/api/production/part-cavity/**', async (route) => {
    const payload = route.request().postDataJSON() as { part_no?: string; cavity?: number };
    await route.fulfill({
      json: {
        part_no: (payload.part_no || planRecord.part_no).toUpperCase(),
        cavity: Math.max(1, Number(payload.cavity ?? 1)),
      },
    });
  });

  await page.route('**/api/production/plan-change-logs/**', async (route) => {
    await route.fulfill({
      json: {
        date,
        latest_updated_at: '2026-05-18T08:00:00+08:00',
        logs: [],
      },
    });
  });

  await page.route('**/api/production/plan-summary/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const requestedDate = requestUrl.searchParams.get('date') ?? date;
    const isFutureDate = requestedDate !== date;
    const records = isFutureDate ? [futurePlanRecord] : injectionPlanRecords;
    await route.fulfill({
      json: {
        plan_date: requestedDate,
        latest_updated_at: '2026-05-18T08:00:00+08:00',
        injection: {
          records,
          machine_summary: isFutureDate
            ? [{ machine_name: '850T-2', plan_qty: 80, plan_date: requestedDate }]
            : [
              { machine_name: '850T-1', plan_qty: 200, plan_date: requestedDate },
              { machine_name: '1300T-3', plan_qty: 500, plan_date: requestedDate },
              { machine_name: '1400T-4', plan_qty: 440, plan_date: requestedDate },
              { machine_name: '1400T-5', plan_qty: 440, plan_date: requestedDate },
            ],
          model_summary: isFutureDate ? [
            { model_name: 'MODEL-FUTURE', plan_qty: 80, plan_date: requestedDate },
          ] : [
            { model_name: 'MODEL-A', plan_qty: 100, plan_date: date },
            { model_name: 'MODEL-B', plan_qty: 100, plan_date: date },
            { model_name: 'MODEL-MES-COMPENSATED', plan_qty: 500, plan_date: date },
            { model_name: 'MODEL-CORE', plan_qty: 440, plan_date: date },
            { model_name: 'MODEL-GENERAL-A', plan_qty: 40, plan_date: date },
            { model_name: 'MODEL-GENERAL-B', plan_qty: 400, plan_date: date },
          ],
          daily_totals: [{ date: requestedDate, plan_qty: isFutureDate ? 80 : 1580 }],
        },
        machining: {
          records: [],
          machine_summary: [],
          model_summary: [],
          daily_totals: [{ date, plan_qty: 0 }],
        },
      },
    });
  });

  await page.route('**/api/production/status/**', async (route) => {
    await route.fulfill({
      json: {
        injection: [{
          machine_name: '850T-1',
          total_planned: 200,
          total_actual: 180,
          progress: 90,
          parts: [{
            part_no: 'PART-A',
            model_name: 'MODEL-A',
            planned_quantity: 100,
            actual_quantity: 180,
            progress: 180,
          }],
        }],
        machining: [],
      },
    });
  });

  await page.route('**/api/production/mes-report-stats/**', async (route) => {
    const requestUrl = new URL(route.request().url());
    const requestedPlanType = requestUrl.searchParams.get('plan_type') ?? 'injection';

    if (requestedPlanType === 'injection') {
      await route.fulfill({
        json: {
          date,
          plan_type: 'injection',
          range_mode: 'day',
          range_start: '2026-05-18T08:00:00+08:00',
          range_end: '2026-05-19T08:00:00+08:00',
          latest_synced_at: '2026-05-18T10:30:00+08:00',
          summary: {
            total_planned: 200,
            total_mes: 165,
            gap_qty: -35,
            achievement_rate: 82.5,
            matched_rows: 2,
            plan_only_rows: 0,
            mes_only_rows: 0,
            raw_mes_count: 2,
            grouped_mes_count: 2,
          },
          rows: [
            {
              equipment_key: '1',
              equipment_name: '850T-1',
              equipment_label: '1호기 850T',
              part_no: 'PART-A',
              model_name: 'MODEL-A',
              planned_qty: 100,
              mes_qty: 110,
              gap_qty: 10,
              achievement_rate: 110,
              mes_report_count: 1,
              latest_report_time: '2026-05-18T10:20:00+08:00',
              compare_status: 'matched',
              process_code: 'ZS',
              plan_row_count: 1,
            },
            {
              equipment_key: '1',
              equipment_name: '850T-1',
              equipment_label: '1호기 850T',
              part_no: 'PART-B',
              model_name: 'MODEL-B',
              planned_qty: 100,
              mes_qty: 55,
              gap_qty: -45,
              achievement_rate: 55,
              mes_report_count: 1,
              latest_report_time: '2026-05-18T10:30:00+08:00',
              compare_status: 'matched',
              process_code: 'ZS',
              plan_row_count: 1,
            },
          ],
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        date,
        plan_type: 'machining',
        range_mode: 'day',
        range_start: '2026-05-18T08:00:00+08:00',
        range_end: '2026-05-19T08:00:00+08:00',
        latest_synced_at: null,
        summary: {
          total_planned: 180,
          total_mes: 120,
          gap_qty: -60,
          achievement_rate: 66.7,
          matched_rows: 1,
          plan_only_rows: 1,
          mes_only_rows: 1,
          raw_mes_count: 0,
          grouped_mes_count: 2,
        },
        rows: [
          {
            equipment_key: 'A',
            equipment_name: 'A LINE',
            equipment_label: 'A라인',
            part_no: 'PART-MATCHED',
            model_name: 'MACH-A',
            planned_qty: 100,
            mes_qty: 80,
            gap_qty: -20,
            achievement_rate: 80,
            mes_report_count: 1,
            latest_report_time: '2026-05-18T10:00:00+08:00',
            compare_status: 'matched',
            process_code: 'JG',
            plan_row_count: 1,
          },
          {
            equipment_key: 'B',
            equipment_name: 'B LINE',
            equipment_label: 'B라인',
            part_no: 'PART-PLAN-ONLY',
            model_name: 'MACH-B',
            planned_qty: 80,
            mes_qty: 0,
            gap_qty: -80,
            achievement_rate: 0,
            mes_report_count: 0,
            latest_report_time: null,
            compare_status: 'plan_only',
            process_code: 'JG',
            plan_row_count: 1,
          },
          {
            equipment_key: 'C',
            equipment_name: 'C LINE',
            equipment_label: 'C라인',
            part_no: 'PART-MES-ONLY',
            model_name: 'MACH-C',
            planned_qty: 0,
            mes_qty: 40,
            gap_qty: 40,
            achievement_rate: null,
            mes_report_count: 1,
            latest_report_time: '2026-05-18T11:00:00+08:00',
            compare_status: 'mes_only',
            process_code: 'JG',
            plan_row_count: 0,
          },
        ],
      },
    });
  });

  await page.route('**/api/production/machining/provision/**', async (route) => {
    await route.fulfill({
      json: {
        business_date: date,
        range: {
          plan_date_from: date,
          plan_date_to: '2026-05-20',
          range_start: '2026-05-18T08:00:00+08:00',
          range_end: '2026-05-19T08:00:00+08:00',
        },
        summary: {
          total_planned: 180,
          mes_qty: 80,
          manual_open_qty: 40,
          manual_matched_qty: 0,
          effective_actual_qty: 120,
          gap_qty: -60,
          achievement_rate: 66.7,
          open_manual_count: 1,
          mismatch_count: 0,
          advance_qty: 0,
        },
        rows: [
          {
            business_date: date,
            plan_date: date,
            day_offset: 0,
            plan_id: 21,
            plan_identity_hash: 'machining-a',
            machine_name: 'A LINE',
            equipment_key: 'A',
            equipment_label: 'A라인',
            part_no: 'PART-MATCHED',
            model_name: 'MACH-A',
            lot_no: 'M01',
            sequence: 1,
            planned_qty: 100,
            mes_qty: 80,
            direct_mes_qty: 80,
            matched_manual_qty: 0,
            manual_qty: 0,
            manual_open_qty: 0,
            effective_actual_qty: 80,
            gap_qty: -20,
            achievement_rate: 80,
            status: 'mes_reported',
            defect_qty: 0,
            manual_reports: [],
          },
          {
            business_date: date,
            plan_date: date,
            day_offset: 0,
            plan_id: 22,
            plan_identity_hash: 'machining-b',
            machine_name: 'B LINE',
            equipment_key: 'B',
            equipment_label: 'B라인',
            part_no: 'PART-PLAN-ONLY',
            model_name: 'MACH-B',
            lot_no: 'M02',
            sequence: 1,
            planned_qty: 80,
            mes_qty: 0,
            direct_mes_qty: 0,
            matched_manual_qty: 0,
            manual_qty: 40,
            manual_open_qty: 40,
            effective_actual_qty: 40,
            gap_qty: -40,
            achievement_rate: 50,
            status: 'manual_open',
            defect_qty: 1,
            manual_reports: [],
          },
        ],
      },
    });
  });

  await page.route('**/api/production/machining/manual-reports/**', async (route) => {
    await route.fulfill({
      status: 201,
      json: {
        id: 1,
        business_date: date,
        plan_date: date,
        plan_id: 21,
        machine_name: 'A LINE',
        equipment_key: 'A',
        part_no: 'PART-MATCHED',
        model_name: 'MACH-A',
        lot_no: 'M01',
        sequence: 1,
        planned_qty_at_report: 100,
        good_qty: 20,
        defect_qty: 0,
        total_reported_qty: 20,
        matched_qty: 0,
        open_qty: 20,
        reason_code: 'mes_work_order_missing',
        note: '',
        status: 'open',
        credit_business_date: date,
        reported_by_name: 'dev-admin',
        reported_at: '2026-05-18T10:30:00+08:00',
        updated_at: '2026-05-18T10:30:00+08:00',
        defect_items: [],
      },
    });
  });

  await page.route('**/api/injection/update-recent-snapshots/status/**', async (route) => {
    await route.fulfill({
      json: {
        status: 'completed',
        job_id: 'qa-backfill',
        percent: 100,
        completed_steps: 12,
        total_steps: 12,
        last_slot: '2026-05-18T10:00:00+08:00',
        error: '',
      },
    });
  });

  await page.route('**/api/injection/update-recent-snapshots/**', async (route) => {
    if (route.request().url().includes('/status/')) {
      await route.fulfill({
        json: {
          status: 'completed',
          job_id: 'qa-backfill',
          percent: 100,
          completed_steps: 12,
          total_steps: 12,
          last_slot: '2026-05-18T10:00:00+08:00',
          error: '',
        },
      });
      return;
    }

    await route.fulfill({
      json: {
        status: 'running',
        job_id: 'qa-backfill',
        percent: 20,
        completed_steps: 2,
        total_steps: 12,
        last_slot: '2026-05-18T08:20:00+08:00',
        error: '',
      },
    });
  });

  await page.route('**/api/injection/production-matrix/**', async (route) => {
    await route.fulfill({
      json: {
        timestamp: '2026-05-18T10:00:00+08:00',
        interval_type: '2min',
        columns: timeSlots.length,
        time_slots: timeSlots,
        machines,
        cumulative_production_matrix: cumulativeProductionMatrix,
        actual_production_matrix: actualProductionMatrix,
        oil_temperature_matrix: oilTemperatureMatrix,
        power_kwh_matrix: powerKwhMatrix,
        power_usage_matrix: powerUsageMatrix,
        mes_source: true,
      },
    });
  });

  await page.route('**/api/production/ai/briefing/**', async (route) => {
    await route.fulfill({
      json: {
        answer: '기준일 2026-05-18 사출 완료율은 90%입니다.',
        severity: 'normal',
        facts: {
          injection: {
            actual_qty: 180,
            planned_qty: 200,
            progress_rate: 90,
            time_progress_rate: 10,
            gap_qty: -20,
            status: 'ahead',
            active_equipment_count: 1,
            running_equipment_count: 1,
            total_equipment_count: 17,
          },
          machining: {
            actual_qty: 0,
            planned_qty: 0,
            progress_rate: 0,
            time_progress_rate: null,
            gap_qty: 0,
            status: 'no_plan',
            active_equipment_count: 0,
            running_equipment_count: 0,
            total_equipment_count: 0,
          },
        },
        top_risks: [],
        used_data: [{ name: 'ProductionPlan', row_count: 1, filters: { plan_date: date } }],
        calculation_basis: ['기준일은 08:00 ~ 익일 08:00 기준입니다.'],
        context_pack: {
          question: 'daily_production_briefing',
          language: 'ko',
          scope: { business_date: date, processes: ['injection', 'machining'] },
          facts: {},
          tables: [],
          calculation_basis: [],
          retrieval_trace: ['production.plan:date=2026-05-18'],
        },
        cache: { hit: false, generated_at: '2026-05-18T10:00:00+08:00', expires_at: null },
      },
    });
  });
}
