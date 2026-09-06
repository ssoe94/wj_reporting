import type { QualityActivityCalendar, QualityAnalysis } from './model.ts';

export interface QualityTrendPoint {
  date: string;
  value: number | null;
  moving_average: number | null;
}

export function getQualityTrendOmittedDates(
  trend: Readonly<QualityAnalysis['trend']>,
  calendar?: QualityActivityCalendar,
  collapseInactiveDays = false,
): string[] {
  if (!collapseInactiveDays || calendar?.status !== 'ready') return [];
  const eligibleDates = new Set(calendar.days.filter(day => day.can_collapse && day.status === 'no_change').map(day => day.date));
  return trend.filter(row => eligibleDates.has(row.date) && row.report_count === 0 && row.reported_defect_qty === null).map(row => row.date);
}

/** Seven displayed observations may bridge only explicitly omitted days, never absent input dates. */
export function getQualityTrendSeries(
  trend: Readonly<QualityAnalysis['trend']>,
  metric: 'reports' | 'quantity',
  calendar?: QualityActivityCalendar,
  collapseInactiveDays = false,
): QualityTrendPoint[] {
  const omittedDates = new Set(getQualityTrendOmittedDates(trend, calendar, collapseInactiveDays));
  // These are calendar labels already attributed by the API, not timestamps to convert.
  const displayed: Array<{ date: string; value: number | null; segment: number }> = [];
  let previousDay: number | null = null;
  let segment = 0;
  for (const row of trend) {
    const day = Date.parse(`${row.date}T00:00:00Z`) / 86400000;
    if (previousDay !== null && day !== previousDay + 1) segment += 1;
    previousDay = day;
    if (!omittedDates.has(row.date)) {
      displayed.push({ date: row.date, value: metric === 'reports' ? row.report_count : row.reported_defect_qty, segment });
    }
  }

  return displayed.map((row, index) => {
    let movingAverage: number | null = null;
    if (index >= 6) {
      let sum = 0;
      let complete = true;
      for (let offset = 0; offset < 7; offset += 1) {
        const { value, segment } = displayed[index - offset];
        if (value === null || segment !== row.segment) {
          complete = false;
          break;
        }
        sum += value;
      }
      if (complete) movingAverage = sum / 7;
    }
    return { date: row.date, value: row.value, moving_average: movingAverage };
  });
}
