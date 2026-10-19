import assert from "node:assert/strict";
import test from "node:test";
import { buildMachiningProgressPreview, getPlanDisplayName } from "../src/domains/production/machining-progress.ts";
import type {
  MachiningProvisionResponse,
  MachiningProvisionRow,
  ProductionMesReportStatsResponse,
  ProductionPlanRecord,
  ProductionPlanSummaryResponse,
} from "../src/domains/production/api.ts";

const businessDate = "2026-10-08";

function provisionRow(overrides: Partial<MachiningProvisionRow> = {}): MachiningProvisionRow {
  return {
    business_date: businessDate,
    plan_date: businessDate,
    day_offset: 0,
    plan_id: 1,
    plan_identity_hash: "current-a",
    machine_name: "A LINE",
    equipment_key: "A",
    equipment_label: "A라인",
    part_no: "ABJ76756112",
    model_name: "22U403A",
    lot_no: "6K1M0567",
    sequence: 1,
    planned_qty: 535,
    mes_qty: 556,
    direct_mes_qty: 556,
    matched_manual_qty: 0,
    manual_qty: 0,
    manual_open_qty: 0,
    effective_actual_qty: 556,
    gap_qty: 21,
    achievement_rate: 556 / 535 * 100,
    status: "mes_reported",
    defect_qty: 0,
    manual_reports: [],
    ...overrides,
  };
}

function provision(rows: MachiningProvisionRow[], actualQty = rows.reduce((sum, row) => sum + row.effective_actual_qty, 0)): MachiningProvisionResponse {
  const plannedQty = rows.reduce((sum, row) => sum + row.planned_qty, 0);
  return {
    business_date: businessDate,
    range: {
      plan_date_from: businessDate, plan_date_to: "2026-10-15",
      range_start: "2026-10-08T08:00:00+08:00", range_end: "2026-10-09T08:00:00+08:00",
    },
    summary: {
      total_planned: plannedQty, mes_qty: actualQty, manual_open_qty: 0, manual_matched_qty: 0,
      effective_actual_qty: actualQty, gap_qty: actualQty - plannedQty,
      achievement_rate: actualQty / plannedQty * 100, open_manual_count: 0, mismatch_count: 0,
      advance_qty: rows.filter((row) => row.plan_date && row.plan_date > businessDate)
        .reduce((sum, row) => sum + row.effective_actual_qty, 0),
    },
    rows,
  };
}

function noActual(overrides: Partial<MachiningProvisionRow>): MachiningProvisionRow {
  return provisionRow({
    mes_qty: 0, direct_mes_qty: 0, effective_actual_qty: 0, achievement_rate: 0,
    gap_qty: -Number(overrides.planned_qty ?? 535), status: "needs_review", ...overrides,
  });
}

function plans(records: Array<ProductionPlanRecord & { plan_date?: string }>): ProductionPlanSummaryResponse {
  return {
    plan_date: businessDate,
    injection: { records: [], machine_summary: [], model_summary: [], daily_totals: [] },
    machining: { records, machine_summary: [], model_summary: [], daily_totals: [] },
  };
}

function stats(mesQty = 556): ProductionMesReportStatsResponse {
  return {
    date: businessDate,
    plan_type: "machining",
    range_mode: "business_day",
    range_start: "2026-10-08T08:00:00+08:00",
    range_end: "2026-10-09T08:00:00+08:00",
    latest_synced_at: null,
    summary: {
      total_planned: 535, total_mes: mesQty, gap_qty: mesQty - 535, achievement_rate: mesQty / 535 * 100,
      matched_rows: 1, plan_only_rows: 0, mes_only_rows: 0, raw_mes_count: 1, grouped_mes_count: 1,
    },
    rows: [{
      equipment_key: "A", equipment_name: "A LINE", equipment_label: "A라인", part_no: "ABJ76756112",
      model_name: "22U403A", planned_qty: 535, mes_qty: mesQty, gap_qty: mesQty - 535,
      achievement_rate: mesQty / 535 * 100, mes_report_count: 1, latest_report_time: null,
      compare_status: "matched", process_code: "ASSEMBLY", plan_row_count: 1,
    }],
  };
}

test("selected-day A line is 535 + 400; later 480 targets retain their actual dates", () => {
  const rows = [
    provisionRow(),
    noActual({ plan_id: 2, sequence: 2, part_no: "", model_name: "汽车外部行李箱", planned_qty: 400 }),
    ...["2026-10-09", "2026-10-10", "2026-10-12"].map((date, index) => noActual({
      plan_id: index + 3, plan_date: date, day_offset: [1, 2, 4][index], sequence: index + 3,
      part_no: "", model_name: "汽车外部行李箱", planned_qty: 480,
    })),
  ];
  const result = buildMachiningProgressPreview(undefined, undefined, provision(rows), businessDate);
  assert.equal(result.plannedQty, 935);
  assert.equal(result.rows[0].plannedQty, 935);
  assert.equal(result.partCount, 2);
  assert.equal(result.pendingCount, 1);
  assert.deepEqual(result.futureDates.map((date) => [date.date, date.plannedQty, date.partCount]), [
    ["2026-10-09", 480, 1], ["2026-10-10", 480, 1], ["2026-10-12", 480, 1],
  ]);
  assert.equal(result.rows[0].segments[1].partNo, "-");
  assert.equal(result.rows[0].segments[1].modelName, "汽车外部行李箱");
});

test("556 overrun stays on the 535 current plan while next-day B line stays at zero", () => {
  const result = buildMachiningProgressPreview(undefined, undefined, provision([
    provisionRow(),
    noActual({
      plan_id: 3, plan_date: "2026-10-09", day_offset: 1, equipment_key: "B",
      equipment_label: "B라인", machine_name: "B LINE", planned_qty: 107,
    }),
  ]), businessDate);
  assert.equal(result.rows.length, 1);
  assert.equal(result.plannedQty, 535);
  assert.equal(result.rows[0].actualQty, 556);
  assert.equal(result.rows[0].segments[0].estimatedQty, 556);
  assert.equal(result.rows[0].segments[0].progressRate, 556 / 535 * 100);
  assert.equal(result.completedCount, 1);
  assert.equal(result.pendingCount, 0);
  assert.equal(result.futureDates[0].rows[0].label, "B라인");
  assert.equal(result.futureDates[0].actualQty, 0);
});

test("all business-day actual remains 2338 with 216 advance output shown in its future group", () => {
  const result = buildMachiningProgressPreview(undefined, undefined, provision([
    provisionRow({ planned_qty: 3000, mes_qty: 2122, direct_mes_qty: 2122, effective_actual_qty: 2122 }),
    provisionRow({
      plan_id: 4, plan_date: "2026-10-09", day_offset: 1, equipment_key: "D", equipment_label: "D라인",
      machine_name: "D LINE", part_no: "ACQ30748205", planned_qty: 1632, mes_qty: 216,
      direct_mes_qty: 216, effective_actual_qty: 216,
    }),
  ], 2338), businessDate);
  assert.equal(result.plannedQty, 3000);
  assert.equal(result.actualQty, 2338);
  assert.equal(result.dailyActualQty, 2122);
  assert.equal(result.advanceQty, 216);
  assert.equal(result.progressRate, 2338 / 3000 * 100);
  assert.equal(result.futureDates[0].actualQty, 216);
  assert.equal(result.futureDates[0].progressRate, 216 / 1632 * 100);
  assert.equal(result.rows.length, 1);
});

test("unplanned MES output stays in today while past plans stay out of daily target and counts", () => {
  const result = buildMachiningProgressPreview(undefined, undefined, provision([
    noActual({ plan_date: "2026-10-07", day_offset: -1, planned_qty: 500 }),
    provisionRow({ plan_id: null, plan_date: null, day_offset: null, planned_qty: 0, effective_actual_qty: 42, mes_qty: 42, status: "unplanned_mes" }),
    noActual({ plan_id: 3, plan_date: "2026-10-09", day_offset: 1, planned_qty: 100 }),
  ], 42), businessDate);
  assert.equal(result.plannedQty, 0);
  assert.equal(result.actualQty, 42);
  assert.equal(result.dailyActualQty, 42);
  assert.equal(result.partCount, 1);
  assert.equal(result.rows[0].segments[0].plannedQty, 0);
  assert.equal(result.futureDates.length, 1);
});

test("different model-only rows remain distinct without creating Part Nos", () => {
  const result = buildMachiningProgressPreview(undefined, undefined, provision([
    noActual({ plan_id: 1, part_no: "", model_name: "汽车外部行李箱", planned_qty: 400 }),
    noActual({ plan_id: 2, part_no: "-", model_name: "另一种外部行李箱", planned_qty: 200 }),
  ]), businessDate);
  const segments = result.rows[0].segments;
  assert.equal(segments.length, 2);
  assert.equal(new Set(segments.map((segment) => segment.key)).size, 2);
  assert.deepEqual(segments.map((segment) => segment.partNo), ["-", "-"]);
  assert.deepEqual(segments.map((segment) => getPlanDisplayName(segment.partNo, segment.modelName)), [
    "汽车外部行李箱", "另一种外部行李箱",
  ]);
});

test("legacy mixed-date records use only today's plan and preserve the overrun segment", () => {
  const summary = plans([
    { id: 1, machine_name: "A LINE", part_no: "ABJ76756112", model_name: "22U403A", planned_quantity: 535, sequence: 1 },
    { id: 2, plan_date: businessDate, machine_name: "A LINE", part_no: null, model_name: "汽车外部行李箱", planned_quantity: 400, sequence: 2 },
    { id: 3, plan_date: "2026-10-09", machine_name: "A LINE", part_no: null, model_name: "汽车外部行李箱", planned_quantity: 480, sequence: 3 },
    { id: 4, date: "2026-10-10", machine_name: "A LINE", part_no: null, model_name: "汽车外部行李箱", planned_quantity: 480, sequence: 4 },
    { id: 5, plan_date: "2026-10-12", machine_name: "A LINE", part_no: null, model_name: "汽车外部行李箱", planned_quantity: 480, sequence: 5 },
    { id: 6, plan_date: "2026-10-09", machine_name: "B LINE", part_no: "ABJ76756112", planned_quantity: 107 },
  ]);
  const result = buildMachiningProgressPreview(summary, stats(), undefined, businessDate);
  assert.equal(result.plannedQty, 935);
  assert.equal(result.actualQty, 556);
  assert.equal(result.rows.length, 1);
  assert.equal(result.rows[0].actualQty, 556);
  assert.deepEqual(result.rows[0].segments.map((segment) => [segment.plannedQty, segment.estimatedQty]), [[535, 556], [400, 0]]);
  assert.equal(result.rows[0].segments[1].partNo, "-");
  assert.deepEqual(result.futureDates.map((date) => [date.date, date.plannedQty, date.actualQty]), [
    ["2026-10-09", 587, 0], ["2026-10-10", 480, 0], ["2026-10-12", 480, 0],
  ]);
  assert.equal(result.partCount, 2);
});

test("legacy MES for a future-only part remains unplanned today instead of populating future plan", () => {
  const result = buildMachiningProgressPreview(plans([
    { id: 1, plan_date: "2026-10-09", machine_name: "B LINE", part_no: "ABJ76756112", planned_quantity: 107 },
  ]), stats(), undefined, businessDate);
  assert.equal(result.plannedQty, 0);
  assert.equal(result.rows[0].plannedQty, 0);
  assert.equal(result.rows[0].actualQty, 556);
  assert.equal(result.futureDates[0].actualQty, 0);
  assert.equal(result.futureDates[0].plannedQty, 107);
});

test("legacy fallback keeps all 556 on A535 rather than transferring 21 into same-day B107", () => {
  const result = buildMachiningProgressPreview(plans([
    { id: 1, machine_name: "A LINE", part_no: "ABJ76756112", planned_quantity: 535, sequence: 1 },
    { id: 2, machine_name: "B LINE", part_no: "ABJ76756112", planned_quantity: 107, sequence: 1 },
  ]), stats(), undefined, businessDate);
  assert.equal(result.plannedQty, 642);
  assert.equal(result.actualQty, 556);
  assert.equal(result.dailyActualQty, 556);
  assert.deepEqual(result.rows.map((row) => [row.label, row.actualQty]), [["A LINE", 556], ["B LINE", 0]]);
  assert.equal(result.rows[0].segments[0].estimatedQty, 556);
  assert.equal(result.rows[0].segments[0].progressRate, 556 / 535 * 100);
  assert.equal(result.rows[1].segments[0].estimatedQty, 0);
  assert.equal(result.completedCount, 1);
  assert.equal(result.pendingCount, 1);
});

test("blank-PartNo MES17 remains unplanned and does not match the model-only400 plan", () => {
  const response = stats(17);
  response.rows[0] = {
    ...response.rows[0], part_no: "", model_name: "汽车外部行李箱", planned_qty: 0, compare_status: "mes_only",
  };
  const result = buildMachiningProgressPreview(plans([
    { id: 1, machine_name: "A LINE", part_no: "", model_name: "汽车外部行李箱", planned_quantity: 400 },
  ]), response, undefined, businessDate);
  const plannedRow = result.rows.find((row) => row.plannedQty === 400);
  const unplannedRow = result.rows.find((row) => row.plannedQty === 0);
  assert.equal(result.plannedQty, 400);
  assert.equal(result.actualQty, 17);
  assert.equal(result.dailyActualQty, 17);
  assert.equal(plannedRow?.actualQty, 0);
  assert.equal(plannedRow?.segments[0].status, "pending");
  assert.equal(unplannedRow?.actualQty, 17);
  assert.equal(unplannedRow?.segments[0].partNo, "-");
  assert.equal(unplannedRow?.segments[0].modelName, "汽车外部行李箱");
});

test("separate unnamed MES reports preserve their quantities and model labels", () => {
  const response = stats(25);
  response.rows = [
    { ...response.rows[0], part_no: " ", model_name: "汽车外部行李箱", mes_qty: 17 },
    { ...response.rows[0], part_no: "-", model_name: "另一种外部行李箱", mes_qty: 8 },
  ];
  const result = buildMachiningProgressPreview(plans([]), response, undefined, businessDate);
  assert.equal(result.plannedQty, 0);
  assert.equal(result.actualQty, 25);
  assert.equal(result.dailyActualQty, 25);
  assert.equal(result.rows.length, 2);
  assert.equal(new Set(result.rows.map((row) => row.key)).size, 2);
  assert.deepEqual(result.rows.flatMap((row) => row.segments).map((segment) => [segment.modelName, segment.estimatedQty]), [
    ["汽车外部行李箱", 17], ["另一种外部行李箱", 8],
  ]);
});

test("display label prefers a genuine Part No then model, specification, and placeholder", () => {
  assert.equal(getPlanDisplayName(" ABJ76756112 ", "汽车外部行李箱"), "ABJ76756112");
  assert.equal(getPlanDisplayName("", "汽车外部行李箱"), "汽车外部行李箱");
  assert.equal(getPlanDisplayName("-", " ", "C/A完"), "C/A完");
  assert.equal(getPlanDisplayName(undefined, undefined, undefined), "-");
});

test("advance output without a current-day target does not fabricate a completion rate", () => {
  const response = provision([provisionRow({ plan_date: "2026-10-09", day_offset: 1 })]);
  const result = buildMachiningProgressPreview(undefined, undefined, response, businessDate);
  assert.equal(result.plannedQty, 0);
  assert.equal(result.actualQty, 556);
  assert.equal(result.advanceQty, 556);
  assert.equal(result.progressRate, 0);
});
