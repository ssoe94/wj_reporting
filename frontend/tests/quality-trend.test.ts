import assert from 'node:assert/strict';
import test from 'node:test';
import type { QualityActivityCalendar, QualityAnalysis } from '../src/domains/quality/model.ts';
import { getQualityTrendOmittedDates, getQualityTrendSeries } from '../src/domains/quality/trend.ts';

// Synthetic daily evidence only; no API, database or production records.
function row(date: string, reports: number, quantity: number | null): QualityAnalysis['trend'][number] {
  return { date, report_count: reports, reported_defect_qty: quantity, defect_quantity_record_count: quantity === null ? 0 : 1 };
}

function activityCalendar(dates: string[], status: QualityActivityCalendar['status'] = 'ready'): QualityActivityCalendar {
  return {
    schema_version: 'quality-activity.v1', status, source: 'InjectionMonitoringRecord',
    timezone: 'Asia/Shanghai', date_basis: 'calendar_day', policy: 'continuous_constant_capacity_v1',
    max_gap_minutes: 10, expected_machine_count: 1,
    days: dates.map(date => ({ date, status: 'no_change', reason: 'continuous_constant_capacity', can_collapse: true, observed_machine_count: 1 })),
  };
}

test('empty and one-day periods add neither averages nor forecast dates', () => {
  assert.deepEqual(getQualityTrendSeries([], 'reports'), []);
  const input = [row('2026-09-07', 3, null)];
  assert.deepEqual(getQualityTrendSeries(input, 'reports'), [{ date: '2026-09-07', value: 3, moving_average: null }]);
  assert.deepEqual(getQualityTrendSeries(input, 'quantity'), [{ date: '2026-09-07', value: null, moving_average: null }]);
});

test('seven known days start the average and the following day drops the oldest value without rounding', () => {
  const input = [1, 2, 3, 4, 5, 6, 7, 14].map((value, index) => row(`2026-09-0${index + 1}`, value, value * 2));
  const original = structuredClone(input);
  const reports = getQualityTrendSeries(input, 'reports');
  assert.deepEqual(reports.slice(0, 6).map(point => point.moving_average), [null, null, null, null, null, null]);
  assert.equal(reports[6].moving_average, 4);
  assert.equal(reports[7].moving_average, 41 / 7);
  assert.equal(getQualityTrendSeries(input, 'quantity')[7].moving_average, 82 / 7);
  assert.deepEqual(reports.map(point => point.date), input.map(point => point.date));
  assert.deepEqual(input, original);
});

test('a missing quantity breaks every affected window and recovers after seven known days', () => {
  const input = Array.from({ length: 14 }, (_, index) => row(`2026-09-${String(index + 1).padStart(2, '0')}`, 1, index === 6 ? null : 2));
  const quantity = getQualityTrendSeries(input, 'quantity');
  assert.equal(quantity[6].value, null);
  assert.ok(quantity.slice(0, 13).every(point => point.moving_average === null));
  assert.equal(quantity[13].moving_average, 2);
  assert.equal(getQualityTrendSeries(input, 'reports')[6].moving_average, 1);
});

test('recorded zero quantities are known and participate in the seven-day mean', () => {
  const input = Array.from({ length: 7 }, (_, index) => row(`2026-09-0${index + 1}`, 1, 0));
  const result = getQualityTrendSeries(input, 'quantity');
  assert.ok(result.every(point => point.value === 0));
  assert.equal(result[6].moving_average, 0);
});

test('zero reports form a valid count average without inventing a zero defect quantity', () => {
  const input = Array.from({ length: 7 }, (_, index) => row(`2026-09-0${index + 1}`, 0, null));
  assert.equal(getQualityTrendSeries(input, 'reports')[6].moving_average, 0);
  assert.ok(getQualityTrendSeries(input, 'quantity').every(point => point.value === null && point.moving_average === null));
});

test('a missing calendar date is not filled or bridged by seven available records', () => {
  const input = [1, 2, 3, 5, 6, 7, 8, 9, 10, 11].map(day => row(`2026-09-${String(day).padStart(2, '0')}`, 2, 4));
  for (const metric of ['reports', 'quantity'] as const) {
    const result = getQualityTrendSeries(input, metric);
    assert.equal(result.length, input.length);
    assert.ok(result.slice(0, 9).every(point => point.moving_average === null));
    assert.equal(result[9].moving_average, metric === 'reports' ? 2 : 4);
  }
});

test('seven consecutive calendar days remain consecutive across leap-day and month boundaries', () => {
  const dates = ['2024-02-26', '2024-02-27', '2024-02-28', '2024-02-29', '2024-03-01', '2024-03-02', '2024-03-03'];
  assert.equal(getQualityTrendSeries(dates.map(date => row(date, 1, 7)), 'quantity')[6].moving_average, 7);
});

test('seven consecutive calendar days remain consecutive across the year boundary', () => {
  const dates = ['2025-12-29', '2025-12-30', '2025-12-31', '2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'];
  const result = getQualityTrendSeries(dates.map(date => row(date, 3, 2)), 'reports');
  assert.equal(result[6].moving_average, 3);
  assert.deepEqual(result.map(point => point.date), dates);
});

test('confirmed quiet weekend days can be omitted from a seven-display-day mean without changing the default calendar view', () => {
  const input = Array.from({ length: 9 }, (_, index) => {
    const day = index + 1;
    return row(`2026-09-0${day}`, day === 5 || day === 6 ? 0 : 1, day === 5 || day === 6 ? null : day);
  });
  const calendar = activityCalendar(['2026-09-05', '2026-09-06']);
  const result = getQualityTrendSeries(input, 'quantity', calendar, true);
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), ['2026-09-05', '2026-09-06']);
  assert.deepEqual(result.map(point => point.date), ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-07', '2026-09-08', '2026-09-09']);
  assert.ok(result.slice(0, 6).every(point => point.moving_average === null));
  assert.equal(result[6].moving_average, 34 / 7);
  assert.equal(getQualityTrendSeries(input, 'reports', calendar, true)[6].moving_average, 1);
  assert.equal(getQualityTrendSeries(input, 'quantity', calendar)[8].moving_average, null);
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, false), []);
  assert.deepEqual(getQualityTrendSeries(input, 'quantity', calendar, false), getQualityTrendSeries(input, 'quantity'));
});

test('unknown logging days stay visible and continue to break quantity averages', () => {
  const input = Array.from({ length: 9 }, (_, index) => row(`2026-09-0${index + 1}`, index === 4 || index === 5 ? 0 : 1, index === 4 || index === 5 ? null : 2));
  const calendar = activityCalendar(['2026-09-05', '2026-09-06']);
  calendar.days[0] = { ...calendar.days[0], status: 'unknown', can_collapse: false, reason: 'insufficient_coverage' };
  const result = getQualityTrendSeries(input, 'quantity', calendar, true);
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), ['2026-09-06']);
  assert.equal(result.find(point => point.date === '2026-09-05')?.value, null);
  assert.equal(result[result.length - 1].moving_average, null);
});

test('an incomplete current day cannot be hidden', () => {
  const input = [row('2026-09-07', 0, null)];
  const calendar = activityCalendar(['2026-09-07']);
  calendar.days[0] = { ...calendar.days[0], status: 'unknown', can_collapse: false, reason: 'current_day_incomplete' };
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), []);
  assert.deepEqual(getQualityTrendSeries(input, 'reports', calendar, true), [{ date: '2026-09-07', value: 0, moving_average: null }]);
});

test('missing, unavailable and inapplicable source metadata never hide observations', () => {
  const input = [row('2026-09-01', 0, null)];
  // Even a contradictory per-day flag cannot override an unavailable source.
  for (const calendar of [undefined, activityCalendar(['2026-09-01'], 'unavailable'), activityCalendar(['2026-09-01'], 'not_applicable')]) {
    assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), []);
    assert.deepEqual(getQualityTrendSeries(input, 'quantity', calendar, true), getQualityTrendSeries(input, 'quantity'));
  }
});

test('an entirely omitted period returns no chart points and retains an exact omission list', () => {
  const input = Array.from({ length: 7 }, (_, index) => row(`2026-09-0${index + 1}`, 0, null));
  const dates = input.map(point => point.date);
  const calendar = activityCalendar(dates);
  assert.deepEqual(getQualityTrendSeries(input, 'quantity', calendar, true), []);
  assert.deepEqual(getQualityTrendSeries(input, 'reports', calendar, true), []);
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), dates);
});

test('quality reports and explicit zero quantities are protected even if source metadata marks a day collapsible', () => {
  const input = [row('2026-09-01', 1, null), row('2026-09-02', 1, 0), row('2026-09-03', 0, 0)];
  const calendar = activityCalendar(input.map(point => point.date));
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), []);
  assert.deepEqual(getQualityTrendSeries(input, 'quantity', calendar, true).map(point => point.value), [null, 0, 0]);
});

test('a genuinely absent input date cannot be justified by quiet metadata and the mean recovers after seven intact displayed days', () => {
  const input = [1, 2, 3, 4, 6, 7, 8, 9, 10, 11, 12, 13].map(day => row(`2026-09-${String(day).padStart(2, '0')}`, day === 6 ? 0 : 1, day === 6 ? null : 2));
  const calendar = activityCalendar(['2026-09-05', '2026-09-06']);
  const result = getQualityTrendSeries(input, 'quantity', calendar, true);
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), ['2026-09-06']);
  assert.equal(result.find(point => point.date === '2026-09-09')?.moving_average, null);
  assert.equal(result.find(point => point.date === '2026-09-12')?.moving_average, null);
  assert.equal(result.find(point => point.date === '2026-09-13')?.moving_average, 2);
});

test('a missing calendar entry and observed activity are retained', () => {
  const input = [row('2026-09-01', 0, null), row('2026-09-02', 0, null)];
  const calendar = activityCalendar(['2026-09-02']);
  calendar.days[0] = { ...calendar.days[0], status: 'activity', can_collapse: false, reason: 'counter_changed' };
  assert.deepEqual(getQualityTrendOmittedDates(input, calendar, true), []);
  assert.deepEqual(getQualityTrendSeries(input, 'quantity', calendar, true), getQualityTrendSeries(input, 'quantity'));
});
