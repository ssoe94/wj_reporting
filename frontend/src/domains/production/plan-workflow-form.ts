import Decimal from "decimal.js-light";
const ExactDecimal = Decimal.clone({ precision: 70 });
/** Display a finite quantity; repeating ratios require a reviewed conversion. */
export function materialRequirement(quantity: string, numerator: string, denominator: string): string | null {
  const unsigned = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
  if (![quantity, numerator, denominator].every(value => unsigned.test(value))) return null;
  try {
    const q = new ExactDecimal(quantity), n = new ExactDecimal(numerator), d = new ExactDecimal(denominator);
    if (q.lte(0) || n.lte(0) || d.lte(0)) return null;
    const result = q.times(n).div(d);
    if (result.decimalPlaces() > 10 || result.gt("1000000000000000")) return null;
    return result.toFixed();
  } catch { return null; }
}
