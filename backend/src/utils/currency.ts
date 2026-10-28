/**
 * Decimal-safe rounding to 2 decimal places.
 * Avoids JavaScript floating-point imprecision when performing monetary calculations.
 */
export function roundCurrency(value: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || !Number.isFinite(value)) {
    return 0;
  }
  return Math.round((value + Number.EPSILON) * 100) / 100;
}
