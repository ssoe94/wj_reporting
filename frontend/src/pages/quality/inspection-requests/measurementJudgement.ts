import Decimal from 'decimal.js-light';
import type { InspectionItem, InspectionMeasurement } from './model';
import type { InspectionArea } from './roleModel';

const ExactDecimal = Decimal.clone({ precision: 600 });
type Verdict = { automatic: boolean; state: 'manual' | 'empty' | 'invalid' | 'unconfigured' | 'pass' | 'fail'; judgement: InspectionMeasurement['judgement']; side?: 'below' | 'above'; difference?: string; exactDifference?: string; approximate?: boolean };
const choiceVerdict = (value: string): InspectionMeasurement['judgement'] => ({ '合格': 'pass', '합격': 'pass', 'ok': 'pass', 'pass': 'pass', '不合格': 'fail', '불합격': 'fail', 'ng': 'fail', 'fail': 'fail' }[value.trim().toLowerCase()] || '') as InspectionMeasurement['judgement'];
function number(value: string): Decimal {
  if (!value.trim() || value.length > 500 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim())) throw new Error('invalid_numeric_measurement');
  const parsed = new ExactDecimal(value.trim());
  if (parsed.abs().gt('1e12')) throw new Error('numeric_measurement_too_large');
  return parsed;
}
/** Inclusive specification bounds, independent of overall concession decisions. */
export function inspectionMeasurementJudgement(item: InspectionItem, area: InspectionArea, value: string): Verdict {
  if (item.kind === 'choice' && item.options?.length && item.options.every((option) => choiceVerdict(option))) {
    const judgement = item.options.includes(value) ? choiceVerdict(value) : '';
    return { automatic: true, state: judgement || (value.trim() ? 'invalid' : 'empty'), judgement };
  }
  if (area !== 'dimension') return { automatic: false, state: 'manual', judgement: '' };
  if (item.kind !== 'number' || (item.minimum === undefined && item.maximum === undefined)) return { automatic: false, state: 'manual', judgement: '' };
  let minimum: Decimal | undefined, maximum: Decimal | undefined;
  try {
    minimum = item.minimum !== undefined ? number(item.minimum) : undefined;
    maximum = item.maximum !== undefined ? number(item.maximum) : undefined;
    if (minimum && maximum && minimum.gt(maximum)) throw new Error('invalid_bounds');
  } catch { return { automatic: true, state: 'unconfigured', judgement: '' }; }
  if (!value.trim()) return { automatic: true, state: 'empty', judgement: '' };
  try {
    const measured = number(value);
    const side = minimum && measured.lt(minimum) ? 'below' : maximum && measured.gt(maximum) ? 'above' : undefined;
    if (!side) return { automatic: true, state: 'pass', judgement: 'pass' };
    const delta = side === 'below' ? minimum!.minus(measured) : measured.minus(maximum!);
    const exactDifference = delta.toString();
    const difference = exactDifference.length > 24 ? delta.toPrecision(12) : exactDifference;
    return { automatic: true, state: 'fail', judgement: 'fail', side, difference, exactDifference, approximate: difference !== exactDifference };
  } catch { return { automatic: true, state: 'invalid', judgement: '' }; }
}
export function inspectionMeasurementPatch(item: InspectionItem, area: InspectionArea, patch: Partial<InspectionMeasurement>): Partial<InspectionMeasurement> {
  if (patch.value === undefined) return patch;
  const verdict = inspectionMeasurementJudgement(item, area, patch.value);
  return verdict.automatic ? { ...patch, judgement: verdict.judgement } : patch;
}

/** Translate only known judgement labels; keep the configured MES option value intact. */
export function inspectionChoiceLabel(value: string, lang: 'ko' | 'zh'): string {
  const verdict = choiceVerdict(value);
  return verdict ? (lang === 'ko' ? verdict === 'pass' ? '합격' : '불합격' : verdict === 'pass' ? '合格' : '不合格') : value;
}
