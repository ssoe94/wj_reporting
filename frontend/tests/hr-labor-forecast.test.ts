import assert from 'node:assert/strict';
import test from 'node:test';
import {
  comparisonForecastMetric,
  forecastChartPoints,
  forecastComponents,
  forecastMetricLabel,
  forecastReasonLabel,
} from '../src/domains/hr/labor-forecast.ts';
import type {
  ForecastComparison, ForecastComponents, ForecastDay, ForecastMetric,
} from '../src/domains/hr/labor-forecast.ts';

const metric = (amount: string | null, known = amount ?? '0.00'): ForecastMetric => ({
  amount, known_amount: known, status: amount === null ? 'partial_missing' : 'ready', percentage: null, basis: {},
});

test('forecast displays confirmed zero separately from partial and missing amounts in both languages', () => {
  const zero = metric('0.00');
  const partial = metric(null, '120.00');
  const missing = { ...metric(null), status: 'missing' } as const;
  assert.equal(forecastMetricLabel(zero, true), null);
  assert.equal(forecastMetricLabel(zero, false), null);
  assert.equal(forecastMetricLabel(partial, true), '일부 미입력');
  assert.equal(forecastMetricLabel(partial, false), '部分未填写');
  assert.equal(forecastMetricLabel(missing, true), '미입력');
  assert.equal(forecastMetricLabel(missing, false), '未填写');
  assert.match(forecastReasonLabel('fixed_pay_not_acquired', true) ?? '', /재업로드 필요/);
  assert.match(forecastReasonLabel('fixed_pay_not_acquired', false) ?? '', /需重新上传/);
});

test('chart preserves the two cumulative server series across alternating data sources', () => {
  const days: ForecastDay[] = [
    { date: '2026-11-01', source: 'entered', known_amount: '100.25', cumulative_known_amount: '100.25', entered_cumulative_known_amount: '100.25', default_cumulative_known_amount: '0.00', status: 'ready' },
    { date: '2026-11-02', source: 'default', known_amount: '12.25', cumulative_known_amount: '112.50', entered_cumulative_known_amount: '100.25', default_cumulative_known_amount: '12.25', status: 'partial_missing' },
    { date: '2026-11-03', source: 'entered', known_amount: '25.50', cumulative_known_amount: '138.00', entered_cumulative_known_amount: '125.75', default_cumulative_known_amount: '12.25', status: 'ready' },
  ];
  assert.deepEqual(forecastChartPoints(days).map(({ entered, default: projected, source, status }) => [entered, projected, source, status]), [
    [100.25, 0, 'entered', 'ready'],
    [100.25, 12.25, 'default', 'partial_missing'],
    [125.75, 12.25, 'entered', 'ready'],
  ]);
});

test('current fund delta uses the estimate even though forecast adopts actual payment', () => {
  const estimate = metric('85.00');
  const actual = metric('90.00');
  const costs = Object.fromEntries(forecastComponents.map(key => [key, metric('0.00')])) as ForecastComponents;
  costs.social_insurance = { ...actual, actual, estimate };
  const comparison: ForecastComparison = {
    month: '2026-11', actual: { total: actual, components: costs, basis: {} },
    total_difference: '0.00', components: { fixed_pay: '0.00', overtime: '0.00', hourly_work: '0.00', social_insurance: '-5.00', housing_fund: '0.00' },
    employees: [], reasons: [], basis: { fund_component_basis: 'estimate_minus_actual' },
  };
  assert.equal(comparisonForecastMetric(costs, 'social_insurance', comparison).amount, '85.00');
  assert.equal(comparisonForecastMetric(costs, 'fixed_pay', comparison).amount, '0.00');
  assert.equal(comparisonForecastMetric(costs, 'social_insurance', { ...comparison, basis: { fund_component_basis: 'effective_forecast_minus_actual' } }).amount, '90.00');
});
